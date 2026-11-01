// =============================================================================
//  HyperProx — the question loop
//
//  intent → extract → derive → validate → ask one thing → repeat. Pure: the only
//  I/O is the two model-facing functions passed in. State goes in and a new
//  state comes out, so the caller decides where it lives (phase 2 keeps it in
//  the database) and a half-finished turn can never leave a half-merged session.
// =============================================================================

import { isQuestionPrompt } from './intent'
import { coerce } from './templates/fields'
import { getTemplate } from './templates'
import type { FieldIssue, Fields, StepSpec, TaskTemplate, TemplateFacts, TemplateSettings } from './templates/types'

// The shapes of the extraction and intent calls (extract.ts, intent.ts). Declared here by what the
// loop uses of them, so the loop can be driven by a fake and does not import a model client.
export interface Extraction {
  values: Record<string, unknown>
  dropped: string[]
  invalid: Array<{ field: string; raw: unknown; message: string }>
}
export interface IntentResult { template: string | 'none'; question: boolean; answer: string }
export type IntentFn = (prompt: string) => Promise<IntentResult>
export type ExtractFn = (
  t: TaskTemplate, text: string, facts: TemplateFacts,
  opts?: { asking?: { field: string; question: string } },
) => Promise<Extraction>

export type LoopStateName = 'answer' | 'asking' | 'ready' | 'blocked' | 'executing' | 'done' | 'failed'
export interface Pending { field: string; question: string; choices?: string[] }
export interface Turn { role: 'user' | 'assistant'; text: string; at: string }
export interface LoopState {
  template: string | null
  templateVersion: number
  state: LoopStateName
  answer?: string
  fields: Fields
  pending?: Pending
  issues: FieldIssue[]
  steps?: StepSpec[]
  transcript: Turn[]
  asked: number
}
export interface LoopDeps {
  facts: TemplateFacts
  settings: TemplateSettings
  intent: IntentFn
  /** A read-only answer to a question, from the cluster's own state; null leaves it to the intent call. */
  ask?: (prompt: string) => Promise<string | null>
  extract: ExtractFn
  now(): Date
}

export const MAX_QUESTIONS = 8

export class FieldLockedError extends Error {
  constructor(readonly field: string) {
    super(`${field} cannot be edited`)
    this.name = 'FieldLockedError'
  }
}

const turn = (role: Turn['role'], text: string, deps: LoopDeps): Turn => ({ role, text, at: deps.now().toISOString() })

function answerOnly(prompt: string, answer: string, deps: LoopDeps): LoopState {
  return {
    template: null, templateVersion: 0, state: 'answer', answer, fields: {}, issues: [], asked: 0,
    transcript: [turn('user', prompt, deps), turn('assistant', answer, deps)],
  }
}

/**
 * A later value wins for the fields it names; null never overwrites. A value that did not coerce is
 * kept, so validate asks again. This is where "the model never decides" is enforced: only a key that
 * is an extractable field of this template is read at all, so a gateway, a feature flag or a
 * prototype key in a reply goes nowhere.
 */
function merge(fields: Fields, x: Extraction, t: TaskTemplate): { fields: Fields; set: Set<string> } {
  const allowed = new Set(t.fields.filter(s => s.extract).map(s => s.name))
  const out: Fields = { ...fields }
  const set = new Set<string>()
  const put = (k: string, v: unknown) => { out[k] = { value: v, source: 'user' }; set.add(k) }
  for (const k of Object.keys(x.values)) {
    const v = x.values[k]
    if (allowed.has(k) && v !== null && v !== undefined) put(k, v)
  }
  for (const bad of x.invalid) {
    if (allowed.has(bad.field) && (typeof bad.raw === 'string' || typeof bad.raw === 'number')) put(bad.field, bad.raw)
  }
  return { fields: out, set }
}

/**
 * Answering "lan" withdraws the hostname that raised the exposure question; without this the domain
 * stays, validate asks the same question, and the person is asked forever. Only when this reply itself
 * set exposure=lan, and never when it also gave a domain.
 */
function lanDropsDomain(fields: Fields, set: Set<string>): Fields {
  if (!set.has('exposure') || set.has('domain') || fields.exposure?.value !== 'lan' || !fields.domain) return fields
  const { domain: _gone, ...rest } = fields
  return rest
}

export class LoopStateError extends Error {
  constructor(readonly state: LoopStateName) {
    super(`This session is ${state} and can no longer be changed.`)
    this.name = 'LoopStateError'
  }
}
const FINAL: LoopStateName[] = ['executing', 'done', 'failed']

/** derive → validate → the first issue becomes the one question; no issues is ready. */
export function settle(s: LoopState, deps: LoopDeps): LoopState {
  const t = s.template ? getTemplate(s.template) : undefined
  if (!t) return s
  const fields = t.derive(s.fields, deps.facts, deps.settings)
  const issues = t.validate(fields, deps.facts)
  const base = { ...s, fields, issues, steps: undefined as StepSpec[] | undefined, pending: undefined as Pending | undefined }

  if (!issues.length) return { ...base, state: 'ready', steps: t.steps(fields) }

  if (s.asked >= MAX_QUESTIONS) {
    const text = `I still need ${issues.length === 1 ? 'one thing' : `${issues.length} things`} and have asked enough questions for one request:\n`
      + issues.map(i => `- ${i.message}`).join('\n')
    return { ...base, state: 'blocked', transcript: [...s.transcript, turn('assistant', text, deps)] }
  }
  const first = issues[0]
  const pending: Pending = { field: first.field, question: first.message, ...(first.choices ? { choices: first.choices } : {}) }
  // The same question again (a settle with nothing new, an answer that changed nothing) is not a new question.
  const repeat = s.state === 'asking' && s.pending?.field === pending.field && s.pending.question === pending.question
  if (repeat) return { ...base, state: 'asking', pending }
  return {
    ...base, state: 'asking', pending, asked: s.asked + 1,
    transcript: [...s.transcript, turn('assistant', first.message, deps)],
  }
}

export async function startLoop(prompt: string, deps: LoopDeps): Promise<LoopState> {
  if (deps.ask && isQuestionPrompt(prompt)) {
    const a = await deps.ask(prompt)
    if (a) return answerOnly(prompt, a, deps)
  }
  const intent = await deps.intent(prompt)
  const t = intent.template === 'none' || intent.question ? undefined : getTemplate(intent.template)
  if (!t) return answerOnly(prompt, intent.answer, deps)

  const x = await deps.extract(t, prompt, deps.facts)
  const s: LoopState = {
    template: t.id, templateVersion: t.version, state: 'asking', fields: merge({}, x, t).fields, issues: [], asked: 0,
    transcript: [turn('user', prompt, deps)],
  }
  return settle(s, deps)
}

export async function answerLoop(
  s: LoopState,
  a: { field: string; value: unknown } | { text: string },
  deps: LoopDeps,
): Promise<LoopState> {
  const t = s.template ? getTemplate(s.template) : undefined
  if (FINAL.includes(s.state)) throw new LoopStateError(s.state)
  if (!t || s.state !== 'asking') return s

  if ('text' in a) {
    const x = await deps.extract(t, a.text, deps.facts, s.pending ? { asking: { field: s.pending.field, question: s.pending.question } } : undefined)
    const m = merge(s.fields, x, t)
    return settle({ ...s, fields: lanDropsDomain(m.fields, m.set), transcript: [...s.transcript, turn('user', a.text, deps)] }, deps)
  }

  // A button: coerced against its own field, no model call.
  const spec = t.fields.find(f => f.name === a.field)
  if (!spec || !spec.extract) throw new FieldLockedError(a.field)
  const c = coerce(spec, a.value, t.enums(deps.facts)[spec.name])
  const fields = lanDropsDomain({ ...s.fields, [spec.name]: { value: c.ok ? c.value : a.value, source: 'user' } }, new Set([spec.name]))
  return settle({ ...s, fields, transcript: [...s.transcript, turn('user', String(a.value), deps)] }, deps)
}

/** The person's own edits. Facts and fixed values are the cluster's and the template's, not theirs. */
export function editFields(s: LoopState, edits: Record<string, unknown>, deps: LoopDeps): LoopState {
  if (FINAL.includes(s.state)) throw new LoopStateError(s.state)
  const t = s.template ? getTemplate(s.template) : undefined
  if (!t) return s
  const set = new Set<string>()
  const fields: Fields = { ...s.fields }
  for (const [name, raw] of Object.entries(edits)) {
    const spec = t.fields.find(f => f.name === name)
    if (!spec || spec.source === 'fact' || spec.source === 'fixed') throw new FieldLockedError(name)
    if (raw === null) { delete fields[name]; continue }
    const c = coerce(spec, raw, t.enums(deps.facts)[name])
    fields[name] = { value: c.ok ? c.value : raw, source: 'user' }
    set.add(name)
  }
  return settle({ ...s, fields: lanDropsDomain(fields, set) }, deps)
}
