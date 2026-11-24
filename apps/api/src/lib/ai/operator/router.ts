// =============================================================================
//  The tier router: one question in, one answer out, from the cheapest tier that can give it.
//
//  askOperator() is a plain function. HTTP is one caller (routes/ai-operator.ts); a chat connector can be another.
//  Nothing here reads a secret: a tier is called through `deps.call`, which fetches its own key from the vault.
// =============================================================================

import { FIXES_SCHEMA, FIX_NOTE, proposalsFor, type AskItem, type FixProposal } from './fixes'
import { createHash } from 'node:crypto'
import { mintConfirm, takeConfirm } from '../../confirm'
import {
  CLOUD_TIERS, TIERS, isCloud, isTier, type AnswerPayload, type ChainStep, type Confidence, type OperatorSettings,
  type ProblemClass, type Tier, type UsageRow,
} from './types'
import { classify, type ClassifiedBy, type PlaybookMatcher, type PlaybookMatch } from './classify'
import { parseForce } from './force'
import { redactForCloud, unredact } from './redact'
import { estimateCostUsd, monthStart, roughTokens, wouldExceedCap } from './pricing'
import type { OperatorStore } from './store'
import type { OperatorContext } from './context'
import type { PlaybookStore } from './playbook-store'
import { normalizePlaybook, type Playbook } from './playbook'

// ── What the router needs from outside ──────────────────────────────────────

export interface TierCallArgs {
  tier: Tier
  model: string
  system: string
  user: string
  schema: Record<string, unknown>
  name: string
  timeoutMs?: number
}
export interface TierCallResult { value: unknown; usage: { inputTokens: number; outputTokens: number } | null }
export type TierCall = (a: TierCallArgs) => Promise<TierCallResult>

export interface OperatorDeps {
  store: OperatorStore
  /** Send one structured request to a tier. For a cloud tier this is the only place text leaves the machine. */
  call: TierCall
  vaultUnlocked: () => boolean
  /** Is this tier set up enough to call? `missing` is a plain-words reason when it is not. */
  tierReady: (tier: Tier, s: OperatorSettings) => Promise<{ ready: boolean; missing?: string }>
  /** Host names to hide before a cloud call, in addition to the addresses and domain names found in the text. */
  knownHosts?: () => Promise<string[]>
  matcher?: PlaybookMatcher
  /**
   * The handbook and live readings for a question (lib/ai/operator/context.ts): house rules, the best playbooks and the
   * read-only readings it is about. Without it the question goes alone, as in phase 1.
   */
  context?: (question: string, who: { role?: string }) => Promise<OperatorContext>
  /** Where a cloud tier's drafted playbook is saved, unapproved. Without it nothing is drafted. */
  playbooks?: PlaybookStore
  now?: () => Date
  /** One audit row per question. It is given names, counts and outcomes, never the question or the answer. */
  audit?: (action: string, resource: string, details: Record<string, unknown>) => Promise<void>
}

export interface AskInput {
  text: string
  /** Where the question came from: 'ui', or a connector's name. Recorded in usage and audit. */
  source: string
  /** Who is asking. For the web page this is the session id, which an approval is bound to. */
  userRef: string
  force?: Tier | null
  /** The single-use token from an earlier `needs_approval` answer. */
  approval?: string
  /** Report that a fix the operator suggested was tried: `verified: false` sends the question up a tier. */
  attempt?: { verified: boolean; tier?: Tier }
  /** A caller's own id for "the same problem", instead of one worked out from the text. */
  fingerprint?: string
  /** For the audit row: who, in words. */
  actor?: string
  /** The one item the person pointed at ("Ask about this"). The answer may then carry proposed fixes for it. */
  item?: AskItem
  /** The asker's role. The live readings are taken with it, so a question never shows more than the page would. */
  role?: string
}

export interface SpendInfo { monthUsd: number; capUsd: number; month: string }

interface Common { chain: ChainStep[]; problemClass: ProblemClass; classifiedBy: ClassifiedBy; playbook?: PlaybookMatch; notes: string[] }

/** What the handbook and live readings contributed to an answer, so the page can say so. */
export interface Used { playbooks: Array<{ id: string; title: string }>; live: string[]; rules: number }

export type OperatorResult =
  | (Common & {
      status: 'answered'; answer: string; tier: Tier; model: string; confidence: Confidence; verified: boolean | null
      costUsd: number; redacted: boolean; localOnly: boolean; spend: SpendInfo
      /** The playbooks the answer used, the areas read live, and how many house rules were given. */
      used: Used
      /** Fixes the panel may offer as cards: only for `item`, only the known safe actions. Nothing here has run. */
      proposals?: FixProposal[]
      /** A playbook a cloud tier drafted from this answer, waiting for approval in the handbook. */
      drafted?: { id: string; title: string }
    })
  | (Common & {
      status: 'needs_approval'; tier: 'opus'; model: string; reason: string; promptPreview: string
      approvalToken: string; expiresAt: string; redacted: boolean
      /** What a lower tier already said, when this came about by escalation. */
      partial?: { answer: string; tier: Tier; confidence: Confidence }
    })
  | { status: 'refused'; code: RefusalCode; message: string; chain: ChainStep[]; notes: string[]; retryWith?: Tier }

export type RefusalCode = 'vault_locked' | 'empty' | 'tier_unavailable' | 'no_tier' | 'approval_invalid' | 'cap' | 'no_answer' | 'tier_error'

// ── Prompts and schemas ─────────────────────────────────────────────────────

export const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string', description: 'The answer, in plain language.' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    verified: { type: ['boolean', 'null'], description: 'true or false only if you checked an outcome; otherwise null.' },
    used: { type: 'array', items: { type: 'integer' }, description: 'The [P] numbers of the playbooks you used, or an empty list.' },
  },
  required: ['answer', 'confidence', 'verified'],
  additionalProperties: false,
} as const

const DRAFT_SCHEMA = {
  type: ['object', 'null'],
  description: 'When the answer is a fix for a fault that no playbook covered, a playbook for it; otherwise null.',
  properties: {
    title: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, symptoms: { type: 'array', items: { type: 'string' } },
    severity: { type: 'string', enum: ['low', 'medium', 'high'] }, area: { type: 'string' },
    checks: { type: 'string', description: 'Read-only checks to run first.' }, cause: { type: 'string' }, fix: { type: 'string' },
    safety: { type: 'string', description: 'What not to do, and what needs a person to approve first.' },
    testScenario: { type: 'string', description: 'A situation and the conclusion a correct answer reaches.' },
  },
  required: ['title', 'symptoms', 'cause', 'fix', 'safety'],
} as const

/** The answer shape; cloud tiers asked about a fault may also draft a playbook. */
export const answerSchema = (draft: boolean, fixes = false) =>
  draft || fixes
    ? { ...ANSWER_SCHEMA, properties: { ...ANSWER_SCHEMA.properties, ...(draft ? { draft: DRAFT_SCHEMA } : {}), ...(fixes ? { fixes: FIXES_SCHEMA } : {}) } }
    : ANSWER_SCHEMA

const CLASS_SCHEMA = {
  type: 'object',
  properties: { class: { type: 'string', enum: ['known', 'new_fault', 'build'] } },
  required: ['class'], additionalProperties: false,
} as const

const SYSTEM =
  'You are the operator assistant inside HyperProx, a Proxmox control plane. Answer the question for a homelab or small-business ' +
  'administrator in plain language, concisely, with concrete steps when steps are needed. Hosts and addresses may appear as ' +
  'placeholders such as host-1 or addr-2: use them exactly as written. Set confidence to low when you are guessing or the ' +
  'question lacks what you need; a low answer is passed to a stronger model, which is better than a wrong one. ' +
  'When PLAYBOOKS, HOUSE RULES or LIVE READINGS are given, they come from this system: follow the rules, use a matching playbook and ' +
  'name it by its [P] number in used, and point to the real item in the live readings instead of speaking in general terms. ' +
  'Never claim to have run or changed anything: you only read, and you only advise.'

const CLASS_SYSTEM =
  'Classify a request to a server-operations assistant. known: a routine task with a standard procedure (restart a service, check ' +
  'a status). new_fault: something is broken or behaving unexpectedly. build: asks to create a script, service, config or plan.'

// ── Helpers ─────────────────────────────────────────────────────────────────

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

/** The same problem worded slightly differently should hash alike: lower case, numbers and addresses flattened. */
export function fingerprintOf(text: string): string {
  const norm = String(text ?? '').toLowerCase().replace(/[0-9a-f:.]*\d[0-9a-f:.]*/g, '#').replace(/[^a-z#]+/g, ' ').trim()
  return sha(norm).slice(0, 16)
}

export function normalizeAnswer(v: unknown): AnswerPayload {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  if (typeof o.answer !== 'string' || !o.answer.trim()) throw new Error('The model gave no answer.')
  let confidence: Confidence = 'medium'
  const c = o.confidence
  if (typeof c === 'number' && Number.isFinite(c)) confidence = c < 0.4 ? 'low' : c < 0.75 ? 'medium' : 'high'
  else if (c === 'low' || c === 'medium' || c === 'high') confidence = c
  const used = Array.isArray(o.used) ? o.used.filter((n): n is number => Number.isInteger(n) && n > 0).slice(0, 10) : undefined
  return { answer: o.answer, confidence, verified: typeof o.verified === 'boolean' ? o.verified : null, ...(used ? { used } : {}), ...(o.draft && typeof o.draft === 'object' ? { draft: o.draft } : {}), ...(Array.isArray(o.fixes) ? { fixes: o.fixes } : {}) }
}

export function approvalBinding(question: string): string { return sha(JSON.stringify(['ai.operator.opus', question])) }

const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`

const NAMES: Record<Tier, string> = { local: 'the local model', haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' }
export const tierName = (t: Tier): string => NAMES[t]

export async function monthSpend(store: OperatorStore, now: Date): Promise<number> {
  const rows = await store.usageSince(monthStart(now))
  return Math.round(rows.reduce((n, r) => n + r.costUsd, 0) * 1e6) / 1e6
}

// ── The router ──────────────────────────────────────────────────────────────

let defaults: OperatorDeps | null = null
/** index.ts gives the router its production dependencies once; a chat connector then just calls askOperator(). */
export function setOperatorDeps(d: OperatorDeps | null): void { defaults = d }

export async function askOperator(input: AskInput, deps: OperatorDeps | null = defaults): Promise<OperatorResult> {
  if (!deps) return refuse('no_tier', 'The AI operator is not ready yet. Try again in a minute.', [], [])
  const now = deps.now?.() ?? new Date()
  const notes: string[] = []
  const chain: ChainStep[] = []

  if (!deps.vaultUnlocked()) {
    return refuse('vault_locked', 'HyperProx is locked, so the operator cannot read its keys. Sign in to unlock it, then ask again. Nothing was sent anywhere.', chain, notes)
  }
  const settings = await deps.store.getSettings()

  const parsed = parseForce(input.text)
  const question = parsed.text.trim()
  if (!question) return refuse('empty', 'Type a question first.', chain, notes)
  let force: Tier | null = isTier(input.force) ? input.force : parsed.tier

  // The handbook and the live readings. A failure here never stops the question: it goes without them, and says so.
  let handbook: OperatorContext | null = null
  if (deps.context) {
    try { handbook = await deps.context(question, { role: input.role }); notes.push(...handbook.notes) }
    catch { notes.push('The handbook and live readings could not be read, so this answer is from the question alone.') }
  }

  // Which tiers can be used at all, in ladder order. A keep-it-local topic in the question, or in what is attached to it, keeps it here.
  const searched = `${question}\n${handbook?.block ?? ''}`.toLowerCase()
  const localOnlyTopic = settings.localOnlyTopics.find(t => searched.includes(t.toLowerCase()))
  const ready = new Map<Tier, { ready: boolean; missing?: string }>()
  for (const t of TIERS) ready.set(t, settings.tiers[t].enabled ? await deps.tierReady(t, settings) : { ready: false, missing: 'turned off' })
  const spent = await monthSpend(deps.store, now)
  const capReached = settings.monthlyCapUsd > 0 && spent >= settings.monthlyCapUsd
  const usable = (t: Tier) => ready.get(t)!.ready && !(isCloud(t) && (localOnlyTopic !== undefined || capReached))
  if (localOnlyTopic !== undefined) notes.push(`This question, or the handbook and readings that go with it, mentions "${localOnlyTopic}", which is on your keep-it-local list, so only the local model was used.`)
  if (capReached) notes.push(`The monthly cap of $${settings.monthlyCapUsd.toFixed(2)} is used up, so only the local model was used.`)

  if (force && isCloud(force) && localOnlyTopic !== undefined) {
    notes.push(`You asked for ${tierName(force)}, but this topic is kept local, so that was not done.`)
    force = 'local'
  }
  if (force && !usable(force)) {
    const why = capReached && isCloud(force) ? 'the monthly cap is used up' : ready.get(force)!.missing ?? 'not set up'
    return refuse(capReached && isCloud(force) ? 'cap' : 'tier_unavailable', `${tierName(force)} cannot be used: ${why}.`, chain, notes)
  }

  // An approval token takes the question straight to Opus.
  let approved = false
  if (input.approval) {
    if (!takeConfirm(input.userRef, approvalBinding(question), input.approval, now.getTime())) {
      return refuse('approval_invalid', 'That approval has expired or was for a different question. Ask again to get a new one.', chain, notes)
    }
    approved = true
    force = 'opus'
    if (!usable('opus')) return refuse('tier_unavailable', `Opus cannot be used: ${capReached ? 'the monthly cap is used up' : ready.get('opus')!.missing ?? 'not set up'}.`, chain, notes)
  }

  // Classify (rules, then the local model if it is usable and the rules are unsure).
  const cls = await classify(question, input.source, {
    matcher: deps.matcher,
    // A forced or approved question does not need the model's opinion on its class: the start is already decided.
    askModel: usable('local') && !force ? async text => {
      const r = await deps.call({ tier: 'local', model: settings.tiers.local.model, system: CLASS_SYSTEM, user: text.slice(0, 2000), schema: CLASS_SCHEMA as any, name: 'operator_class', timeoutMs: 8000 })
      if (r.usage) await recordUsage(deps, settings, 'local', settings.tiers.local.model, r.usage, now, `${input.source}:classify`)
      const c = (r.value as any)?.class
      return c === 'known' || c === 'new_fault' || c === 'build' ? c : null
    } : undefined,
  })

  // Where to start.
  const fp = input.fingerprint?.trim() || fingerprintOf(question)
  const order = TIERS.filter(usable)
  if (!order.length) {
    return refuse('no_tier', 'No tier is ready. Turn one on and finish its setup under AI, Operator, Tiers.', chain, notes)
  }
  const rank = (t: Tier) => TIERS.indexOf(t)
  const nextUsableAfter = (t: Tier): Tier | null => order.find(o => rank(o) > rank(t)) ?? null
  const atOrAbove = (t: Tier): Tier | null => order.find(o => rank(o) >= rank(t)) ?? order[order.length - 1] ?? null

  let start: Tier = force ?? settings.classStart[cls.problemClass]
  if (!force) {
    const prior = await deps.store.fingerprintsSince(fp, new Date(now.getTime() - settings.repeatWindowMin * 60_000))
    if (prior.length) {
      const top = prior.reduce<Tier>((m, p) => (rank(p.tier) > rank(m) ? p.tier : m), prior[0].tier)
      const up = nextUsableAfter(top)
      if (up && rank(up) > rank(start)) { start = up; notes.push(`This looks like a problem you asked about ${prior.length === 1 ? 'before' : prior.length + ' times'} recently, so it started at ${tierName(up)}.`) }
    }
    if (input.attempt && input.attempt.verified === false) {
      const up = nextUsableAfter(input.attempt.tier ?? start)
      if (up && rank(up) >= rank(start)) { start = up; notes.push(`The last fix did not work, so it started at ${tierName(up)}.`) }
    }
  }
  if (approved) start = 'opus'
  const first = usable(start) ? start : atOrAbove(start)!
  if (first !== start && !force) notes.push(`${tierName(start)} is not available, so it started at ${tierName(first)}.`)

  // Run up the ladder.
  const hosts = settings.redactBeforeCloud && deps.knownHosts ? await deps.knownHosts().catch(() => []) : []
  const prompt = (input.attempt?.verified === false ? `Note: a fix suggested earlier was tried and did not work.\n\n` : '') + question
  // What a tier is sent: the question, then the handbook and readings. The cloud copy has all of it hidden together.
  const withContext = handbook?.block ? `${handbook.block}\n\nQUESTION:\n${prompt}` : prompt
  const red = settings.redactBeforeCloud ? redactForCloud(withContext, hosts) : { text: withContext, map: {} as Record<string, string> }
  const redactedAny = Object.keys(red.map).length > 0

  let best: { payload: AnswerPayload; tier: Tier; model: string } | null = null
  let idx = order.indexOf(first)
  let capStopped = false
  let totalCost = 0
  // A tier that failed (bad key, offline, 5xx, no usable reply). Never a reason to try another tier: only a quality signal moves up.
  let failed: Tier | null = null

  const finishApproval = async (): Promise<OperatorResult> => {
    const { token, expiresAt } = mintConfirm(input.userRef, approvalBinding(question), now.getTime())
    const model = settings.tiers.opus.model
    const why = best
      ? `${tierName(best.tier)} was not confident enough, so the next step is Opus, the most capable and most expensive model.`
      : 'Opus is the most capable and most expensive model, so it asks first.'
    return {
      status: 'needs_approval', tier: 'opus', model, chain, problemClass: cls.problemClass, classifiedBy: cls.by, playbook: cls.playbook, notes,
      reason: `${why} Approving sends the text below to Anthropic${settings.redactBeforeCloud ? ' with addresses and host names hidden' : ''} and uses your Anthropic key.`,
      promptPreview: red.text.slice(0, 24_000), approvalToken: token, expiresAt, redacted: redactedAny,
      ...(best ? { partial: { answer: best.payload.answer, tier: best.tier, confidence: best.payload.confidence } } : {}),
    }
  }

  while (idx < order.length && chain.length < settings.maxChain) {
    const tier = order[idx]
    const model = settings.tiers[tier].model
    if (tier === 'opus' && settings.opusNeedsApproval && !approved) return finishApproval()
    const sendText = isCloud(tier) ? red.text : withContext
    if (isCloud(tier)) {
      const est = estimateCostUsd(tier, settings, roughTokens(sendText + SYSTEM), 1000)
      if (wouldExceedCap(spent + totalCost, est, settings.monthlyCapUsd)) {
        chain.push({ tier, model, outcome: 'skipped', note: 'would go over the monthly cap' })
        notes.push(`${tierName(tier)} was skipped: it could take the month over the $${settings.monthlyCapUsd.toFixed(2)} cap.`)
        capStopped = true
        break
      }
    }
    try {
      const drafting = isCloud(tier) && !!deps.playbooks && cls.problemClass !== 'build'
      const r = await deps.call({ tier, model, system: SYSTEM + (drafting ? DRAFT_NOTE : '') + (input.item ? FIX_NOTE : ''), user: sendText, schema: answerSchema(drafting, !!input.item) as any, name: 'operator_answer' })
      const payload = normalizeAnswer(r.value)
      const u = r.usage ?? { inputTokens: roughTokens(sendText + SYSTEM), outputTokens: roughTokens(payload.answer) }
      const cost = await recordUsage(deps, settings, tier, model, u, now, input.source)
      totalCost += cost
      chain.push({ tier, model, outcome: 'answered', confidence: payload.confidence, inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUsd: cost })
      best = { payload, tier, model }
      if (payload.confidence !== 'low') break
    } catch (e) {
      chain.push({ tier, model, outcome: 'error', note: plainError(e) })
      failed = tier
      break
    }
    idx++
  }

  // A cap stop with nothing yet: the local model is the fallback, if it was not already tried.
  if (!best && capStopped && usable('local') && !chain.some(c => c.tier === 'local')) {
    const model = settings.tiers.local.model
    try {
      const r = await deps.call({ tier: 'local', model, system: SYSTEM + (input.item ? FIX_NOTE : ''), user: withContext, schema: answerSchema(false, !!input.item) as any, name: 'operator_answer' })
      const payload = normalizeAnswer(r.value)
      const u = r.usage ?? { inputTokens: roughTokens(prompt + SYSTEM), outputTokens: roughTokens(payload.answer) }
      await recordUsage(deps, settings, 'local', model, u, now, input.source)
      chain.push({ tier: 'local', model, outcome: 'answered', confidence: payload.confidence, inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUsd: 0 })
      best = { payload, tier: 'local', model }
    } catch (e) { chain.push({ tier: 'local', model, outcome: 'error', note: plainError(e) }) }
  }

  if (failed && !best) {
    const alt = nextUsableAfter(failed)
    const retryWith = alt === 'haiku' || alt === 'sonnet' ? alt : undefined
    await auditRow(deps, input, 'refused', chain, cls.problemClass, redactedAny, totalCost)
    return { ...refuse('tier_error', `${tierName(failed).replace(/^the/, 'The')} is unreachable (bad key or offline) — nothing was sent elsewhere.`, chain, notes), ...(retryWith ? { retryWith } : {}) }
  }
  if (failed && best) notes.push(`${tierName(failed)} could not be reached, so this is the answer from ${tierName(best.tier)}. Nothing further was tried.`)

  if (!best) {
    const msg = capStopped ? 'The monthly cap stopped the cloud tiers and the local model could not answer.' : 'No tier could answer. ' + (chain.find(c => c.outcome === 'error')?.note ?? '')
    await auditRow(deps, input, 'refused', chain, cls.problemClass, redactedAny, 0)
    return refuse(capStopped ? 'cap' : 'no_answer', msg.trim(), chain, notes)
  }

  await deps.store.addFingerprint({ fingerprint: fp, tier: best.tier, problemClass: cls.problemClass, at: now })
  await auditRow(deps, input, 'answered', chain, cls.problemClass, redactedAny, totalCost)
  const sentRedacted = isCloud(best.tier) && redactedAny
  const finalSpend = spent + totalCost
  const back = (t: string) => (sentRedacted ? unredact(t, red.map) : t)
  const given = handbook?.playbooks ?? []
  const picked = [...new Set((best.payload.used ?? []).filter(n => n >= 1 && n <= given.length))].map(n => given[n - 1])
  const usedPb = picked.length ? picked : given
  const label = usedPb.length ? `\n\nPlaybooks used: ${usedPb.map(p => p.title).join('; ')}.` : ''
  const drafted = isCloud(best.tier) && !usedPb.length && best.payload.confidence !== 'low' && cls.problemClass !== 'build'
    ? await saveDraft(deps, input, best.payload.draft, back)
    : undefined
  return {
    status: 'answered', answer: back(best.payload.answer) + label,
    used: { playbooks: usedPb, live: handbook?.live ?? [], rules: handbook?.rulesUsed ?? 0 },
    ...(drafted ? { drafted } : {}),
    ...(input.item ? { proposals: proposalsFor(input.item, best.payload.fixes) } : {}),
    tier: best.tier, model: best.model, confidence: best.payload.confidence, verified: best.payload.verified ?? null,
    chain, problemClass: cls.problemClass, classifiedBy: cls.by, playbook: cls.playbook, notes,
    costUsd: totalCost, redacted: sentRedacted, localOnly: localOnlyTopic !== undefined,
    spend: { monthUsd: Math.round(finalSpend * 1e6) / 1e6, capUsd: settings.monthlyCapUsd, month: monthKey(now) },
  }
}

// ── Internals ───────────────────────────────────────────────────────────────

function refuse(code: RefusalCode, message: string, chain: ChainStep[], notes: string[]): OperatorResult {
  return { status: 'refused', code, message, chain, notes }
}

/** A tier's failure in words a person can read. Never the provider's body, which can echo the prompt. */
function plainError(e: unknown): string {
  const m = e instanceof Error ? e.message : ''
  return (m && m.length < 200 && !/[{<]/.test(m) ? m : 'The model did not give a usable answer.').replace(/\s+/g, ' ')
}

async function recordUsage(deps: OperatorDeps, s: OperatorSettings, tier: Tier, model: string, u: { inputTokens: number; outputTokens: number }, at: Date, source: string): Promise<number> {
  const costUsd = estimateCostUsd(tier, s, u.inputTokens, u.outputTokens)
  const row: UsageRow = { tier, model, inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUsd, at, source: source.slice(0, 60) }
  await deps.store.addUsage(row)
  return costUsd
}

const DRAFT_NOTE =
  ' If your answer is a fix for a fault and no playbook given matches it, also fill in draft: a playbook another operator could follow ' +
  '(read-only checks first, the cause, the fix, what not to do). Otherwise leave draft null. A person reviews it before it is ever used.'

/** A cloud answer's draft, saved unapproved in the handbook. Never throws: the answer is already good. */
async function saveDraft(deps: OperatorDeps, input: AskInput, raw: unknown, back: (t: string) => string): Promise<{ id: string; title: string } | undefined> {
  if (!deps.playbooks || !raw || typeof raw !== 'object') return undefined
  try {
    const d = raw as Record<string, unknown>
    const fix = (v: unknown) => (typeof v === 'string' ? back(v) : Array.isArray(v) ? v.map(x => (typeof x === 'string' ? back(x) : x)) : v)
    const n = normalizePlaybook({ ...Object.fromEntries(Object.entries(d).map(([k, v]) => [k, fix(v)])), source: 'cloud-draft', approved: false, key: undefined })
    if (!n.ok || !n.value.fix || !n.value.cause) return undefined
    const have = await deps.playbooks.list()
    if (have.some((p: Playbook) => p.title.toLowerCase() === n.value.title.toLowerCase())) return undefined
    const row = await deps.playbooks.create(n.value)
    try { await deps.audit?.('ai.playbook.draft', 'ai:playbook', { by: input.actor ?? input.source, id: row.id, source: input.source.slice(0, 60) }) } catch { /* the draft is saved either way */ }
    return { id: row.id, title: row.title }
  } catch { return undefined }
}

async function auditRow(deps: OperatorDeps, input: AskInput, status: string, chain: ChainStep[], cls: ProblemClass, redacted: boolean, cost: number): Promise<void> {
  if (!deps.audit) return
  try {
    await deps.audit('ai.operator.ask', 'ai:operator', {
      by: input.actor ?? input.source, source: input.source.slice(0, 60), status, class: cls,
      tiers: chain.map(c => `${c.tier}:${c.outcome}`), redacted, costUsd: Math.round(cost * 1e4) / 1e4,
    })
  } catch { /* an audit row that cannot be written does not hide an answer already given */ }
}

export { CLOUD_TIERS }
