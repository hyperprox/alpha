// =============================================================================
//  HyperProx — read-only questions about the cluster and everything attached
//
//  A question that is not a task is answered from compact summaries, never from
//  the model's memory. Every area of HyperProx (the cluster, DNS, proxy hosts,
//  certificates, backups, each plug-in) is a "source": a name, words that
//  mention it, and a function that reads a short summary. Only the one to three
//  sources the question is about are read, so the prompt stays small enough for
//  a CPU model. Common questions are answered by code with no model call.
//  Summaries carry no secrets, tokens, webhook URLs or logs. Nothing here
//  changes anything.
// =============================================================================

import * as z from 'zod/v4'
import { ModelCallError, StructuredOutputError } from './providers'
import type { ModelCall } from './extract'

export interface SourceSummary {
  /** One line of top-level health, for overviews. */
  headline: string
  lines: string[]
  /** Needs the vault and it is locked: reported as locked, never as a failure. */
  locked?: boolean
  /** Parts that could not be read, in words. */
  unread?: string[]
  /** Whatever the source's own `answer` needs. */
  data?: unknown
}

export interface AskSource {
  id: string
  title: string
  /** One short phrase for the "what's attached" index. */
  blurb: string
  /** Words in a question that mean this source. */
  aliases: RegExp
  /** Plug-ins: answer by matching the question's words against `lines`. */
  matchLines?: boolean
  load(): Promise<SourceSummary>
  /** An exact answer from the loaded summary, or null to leave it to the model. */
  answer?(prompt: string, s: SourceSummary): string | null
}

const MAX_ANSWER = 2000
const BUDGET_CHARS = 2000          // about 500 tokens
const LOAD_TIMEOUT_MS = 8000
export const LOCKED_NOTE = 'HyperProx is locked, so this cannot be read. Unlock it and ask again.'

const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timed out')), ms)
    p.then(v => { clearTimeout(t); res(v) }, e => { clearTimeout(t); rej(e) })
  })

async function loadSafe(s: AskSource): Promise<SourceSummary> {
  try {
    return await withTimeout(s.load(), LOAD_TIMEOUT_MS)
  } catch (e) {
    // The source and the kind of error only: a raw message can carry an address or a fragment of a reply.
    const kind = e instanceof Error && e.message === 'timed out' ? 'timed out' : e instanceof Error ? e.name : 'error'
    return { headline: `${s.title}: could not be read`, lines: [], unread: [`${s.title} (${kind})`] }
  }
}

const OVERVIEW = /\b(what can you see|status overview|overview|everything|what'?s (on|attached|connected|running on)|what is (on|attached|connected)|on my network|attached|connected to hyperprox|how is everything|how'?s everything|summary of)\b/

// A question-shaped request to have something set up: "Can I get a Gitea instance?", "Is there a way to host
// Gitea?", "Put Gitea on my cluster?". These are for the planner, not for a read-only answer.
const REQUEST_SHAPE = /\b(can|could|may|might|would)\s+(i|we)\s+(please\s+)?(get|have|host|put|set\s*up|install|run)\b|\bis\s+there\s+a\s+way\s+to\b|\b(i|we)\s+(want|need|would\s+like)\b|^\s*(please\s+)?(put|host|get|set\s*up|give)\b/i
const WANT_VERB = /\b(get|have|host|put|want|need|set\s*up)\b/i

/** True when the question is really a request to put a service on the cluster. `services`: recipe names and ids. */
export function looksLikeRequest(prompt: string, services: string[] = []): boolean {
  if (REQUEST_SHAPE.test(prompt)) return true
  const p = prompt.toLowerCase()
  if (/\b(how\s+(do|to|can|does)|explain|tell\s+me|why|what\s+(is|does|are))\b/.test(p)) return false   // asking for information
  return WANT_VERB.test(p) && services.some(s => s && new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(p))
}

export function selectSources(prompt: string, sources: AskSource[]): AskSource[] {
  const p = prompt.toLowerCase()
  return sources
    .map(s => ({ s, n: (p.match(new RegExp(s.aliases.source, 'gi')) ?? []).length }))
    .filter(x => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 3).map(x => x.s)
}

export function indexText(sources: AskSource[]): string {
  return 'Attached: ' + sources.map(s => `${s.title} (${s.blurb})`).join('; ')
}

// ---------------------------------------------------------------------------
//  Exact answers from a plug-in's lines: "Is the outside light on?"
// ---------------------------------------------------------------------------

const STOP = new Set(['is', 'the', 'a', 'an', 'my', 'are', 'on', 'off', 'open', 'closed', 'locked', 'unlocked', 'now', 'currently',
  'right', 'there', 'any', 'it', 'its', 'of', 'in', 'at', 'still', 'turned', 'switched', 'state', 'status', 'what', 'whats', 'does', 'do',
  'tell', 'me', 'about', 'please', 'home', 'assistant'])

export function lineAnswer(prompt: string, lines: string[]): string | null {
  const words = prompt.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w))
  if (!words.length) return null
  const hits = lines.filter(l => { const t = l.toLowerCase(); return words.every(w => t.includes(w)) })
  return hits.length >= 1 && hits.length <= 3 ? hits.join(' ') : null
}

// ---------------------------------------------------------------------------
//  The model
// ---------------------------------------------------------------------------

const SYSTEM = [
  'You answer questions about a Proxmox cluster and the services attached to HyperProx, read-only.',
  'Answer only from the SUMMARY. If the summary does not contain the answer, say plainly that you do not have that information.',
  'Never guess, and never use outside knowledge about this cluster.',
  'Reply in 2 or 3 short sentences of plain language.',
  'You cannot change anything. If the user asks you to change, start, stop or delete something, say you cannot do that here and point to the Guests page, or suggest describing a service to deploy.',
  'If the summary says something could not be read or is locked, say so.',
].join('\n')

function modelRequest(prompt: string, summary: string) {
  const shape = z.object({ answer: z.string() })
  return {
    name: 'cluster-answer',
    system: SYSTEM,
    user: `SUMMARY\n${summary}\n\nQUESTION\n${prompt}`,
    schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false },
    parse: (raw: unknown) => shape.parse(raw),
  }
}

function causeOf(e: unknown): string {
  if (e instanceof ModelCallError || e instanceof StructuredOutputError) return e.message
  const msg = e instanceof Error ? e.message : String(e)
  return `The AI provider failed: ${msg.replace(/[.\s]+$/, '')}.`
}

/** The summaries as model text, each source trimmed so the total stays within the budget. */
export function promptText(index: string, loaded: Array<{ s: AskSource; sum: SourceSummary }>): string {
  const each = Math.max(300, Math.floor((BUDGET_CHARS - index.length) / Math.max(1, loaded.length)))
  const parts = loaded.map(({ s, sum }) => {
    const body = sum.locked ? [LOCKED_NOTE] : sum.lines
    let text = `${s.title}:\n` + body.join('\n')
    if (text.length > each) text = text.slice(0, each).replace(/\n[^\n]*$/, '') + '\n(more not shown)'
    if (sum.unread?.length) text += `\nCould not read: ${sum.unread.join(', ')}`
    return text
  })
  return [index, ...parts].join('\n\n')
}

const noteOf = (loaded: Array<{ sum: SourceSummary }>) => {
  const un = loaded.flatMap(l => l.sum.unread ?? [])
  return un.length ? ` (I could not read ${un.join(' or ')}, so this may be incomplete.)` : ''
}

/**
 * Answers a question, or null when it is not one for this path (a request to deploy, or no source is about
 * it), and the caller carries on as before. Overviews and common questions from code; the model otherwise, told to use only
 * the selected summaries. When no provider responds, the typed reason and the canned text (`fallback`).
 */
export async function answerQuestion(
  prompt: string,
  ctx: { sources: AskSource[]; call: ModelCall; fallback: string; services?: string[] },
): Promise<string | null> {
  const { sources } = ctx
  const index = indexText(sources)
  // Not ours: a request to have something deployed goes to the planner.
  if (looksLikeRequest(prompt, ctx.services)) return null

  if (OVERVIEW.test(prompt.toLowerCase())) {
    const all = await Promise.all(sources.map(async s => ({ s, sum: await loadSafe(s) })))
    return `${index}.\n` + all.map(({ s, sum }) => sum.locked ? `${s.title}: locked.` : sum.headline).join('\n') + noteOf(all)
  }

  const chosen = selectSources(prompt, sources)
  // Nothing here knows what this is about: leave it to the intent call, as before.
  if (!chosen.length) return null
  const loaded = await Promise.all(chosen.map(async s => ({ s, sum: await loadSafe(s) })))

  for (const { s, sum } of loaded) {
    if (sum.locked) return `${s.title}: ${LOCKED_NOTE}`
    const exact = s.answer?.(prompt, sum) ?? (s.matchLines ? lineAnswer(prompt, sum.lines) : null)
    if (exact) return exact + noteOf(loaded)
  }
  if (loaded.length && loaded.every(l => l.sum.unread?.length && !l.sum.lines.length))
    return `I could not read ${loaded.flatMap(l => l.sum.unread!).join(' or ')} just now, so I cannot answer that.`

  try {
    const got = await ctx.call(modelRequest(prompt, promptText(index, loaded)))
    return got.answer.trim().slice(0, MAX_ANSWER) || ctx.fallback
  } catch (e) {
    if (e instanceof StructuredOutputError && e.kind === 'refusal') return e.message
    return `${causeOf(e)} ${ctx.fallback}`
  }
}
