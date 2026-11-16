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
import { plainReason } from '../failure'
import { stripAddresses } from '../redact-addresses'
import { isInventoryQuestion, inventoryText, type AppHints } from './inventory'
import { rollCallText, type LoadedSource } from './rollcall'
import type { ClusterSummary } from './ask-sources'
import { forgetReadings, keepReading, keptReading, readInFlight, readingKey, trackRead } from './reading-cache'
import { asOfText, KEPT_MAX_AGE_MS } from './when'

export interface SourceSummary {
  /** One line of top-level health, for overviews. */
  headline: string
  lines: string[]
  /** Needs the vault and it is locked: reported as locked, never as a failure. */
  locked?: boolean
  /** Parts that could not be read, in words. */
  unread?: string[]
  /** A plug-in with no summary hook: attached, but there is nothing to read, which is not a failure to read. */
  noSummary?: boolean
  /** Whatever the source's own `answer` needs. */
  data?: unknown
  /** What needs the person's attention, in plain words; empty when nothing does. Unset: the roll-call reads the headline. */
  attention?: string[]
  /** When this reading was taken (unix ms), when it is not from just now. */
  asOf?: number
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
  /** How long a read may take before the answer goes on without it (ms). Default DEFAULT_BUDGET_MS. */
  budgetMs?: number
  /** false: not in the "how is everything" roll-call (it repeats another area, or is a list rather than health). */
  overview?: false
  /** The cluster the source is bound to, so two clusters' "cluster" sources keep apart in the reading cache. */
  scope?: string
  /** The cluster source only: what each guest is and its address, for "what's on my cluster". */
  hints?(): Promise<AppHints | null>
}

const MAX_ANSWER = 2000
const BUDGET_CHARS = 2000          // about 500 tokens
/** A slow area never holds the whole answer up for longer than this. */
export const DEFAULT_BUDGET_MS = 4000
export const LOCKED_NOTE = 'HyperProx is locked, so this cannot be read. Unlock it and ask again.'

// ---------------------------------------------------------------------------
//  Reading a source within its budget
// ---------------------------------------------------------------------------

/**
 * Kept readings (lib/ai/reading-cache.ts) are by who asked (their role: summaries differ by role), the cluster the
 * source is bound to, and the source. A source slower than its budget answers from there, labelled with its time,
 * while its read carries on in the background and refreshes it. Never a locked or failed reading. Cleared for
 * tests, and when HyperProx locks.
 */
export function clearReadingCache(): void { forgetReadings() }

/** What the person is told when an area could not be read: HyperProx's own words or a plain one, never an address. */
function reasonOf(e: unknown, title: string): string {
  let r = stripAddresses(plainReason(e, title)).replace(/[.\s]+$/, '')
  if (r.startsWith(`${title} `)) r = `it ${r.slice(title.length + 1)}`
  return r.replace(/^it could not be read\. The details are in HyperProx's log$/, "it gave an error; the details are in HyperProx's log")
}

/**
 * Reads a source, giving up waiting after its budget. `cacheKey` (who is asking) turns the reading cache on:
 * without it a slow source is simply "still being read". A real failure is said with its reason.
 */
export async function loadWithin(s: AskSource, o: { cacheKey?: string; now?: () => number } = {}): Promise<LoadedSource> {
  const now = o.now ?? Date.now
  const key = o.cacheKey !== undefined ? readingKey(o.cacheKey, s.scope ?? '', s.id) : null
  type Read = { sum: SourceSummary | null; error: unknown }
  // A read of this area already under way for the same person and cluster is joined, not started again.
  const start = (): Promise<Read> => (async () => s.load())().then(
    sum => { if (key && !sum.locked && !(sum.unread?.length && !sum.lines.length)) keepReading(key, sum, now()); return { sum, error: null } },
    error => ({ sum: null, error }),
  )
  const read: Promise<Read> = key ? (readInFlight<Read>(key) ?? trackRead(key, start())) : start()
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<'late'>(res => { timer = setTimeout(() => res('late'), s.budgetMs ?? DEFAULT_BUDGET_MS) })
  const got = await Promise.race([read, late])
  if (timer) clearTimeout(timer)
  if (got !== 'late') {
    if (got.sum) return { s, sum: got.sum, state: 'ok' }
    const why = reasonOf(got.error, s.title)
    return { s, sum: { headline: `${s.title}: could not be read (${why}).`, lines: [], unread: [`${s.title} (${why})`] }, state: 'failed' }
  }
  // Slow, not failed: an earlier reading if there is one, and the read goes on to refresh it.
  const hit = key ? keptReading<SourceSummary>(key) : undefined
  if (hit && now() - hit.at < KEPT_MAX_AGE_MS) return { s, sum: { ...hit.sum, asOf: hit.sum.asOf ?? hit.at }, state: 'cached' }
  return { s, sum: { headline: `${s.title}: still being read.`, lines: [], unread: [`${s.title} (still being read: it is slow to answer, ask again in a minute)`] }, state: 'pending' }
}

// The roll-call: "how is everything", "status", "anything wrong", what is attached.
const ROLLCALL = /\b(what can you see|status overview|overview|how is everything|how'?s everything|how are things|everything ok(ay)?|is everything (ok(ay)?|fine|alright|all right|working)|what'?s (attached|connected)|what is (attached|connected)|on my network|connected to hyperprox|summary of everything|what needs attention|anything need(s)? attention|health check)\b|^\s*(status|health|overview)\s*[?.!]*\s*$|^\s*(is\s+)?(there\s+)?anything\s+(wrong|broken|amiss|down)\s*[?.!]*\s*$|^\s*any\s+(problems|issues)\s*[?.!]*\s*$/

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

const noteOf = (loaded: Array<{ sum: SourceSummary; state?: LoadedSource['state'] }>) => {
  const slow = loaded.filter(l => l.state === 'pending').flatMap(l => l.sum.unread ?? [])
  const un = loaded.filter(l => l.state !== 'pending').flatMap(l => l.sum.unread ?? [])
  const parts: string[] = []
  if (un.length) parts.push(`I could not read ${un.join(' or ')}, so this may be incomplete.`)
  if (slow.length) parts.push(`${slow.map(x => x.replace(/ \(.*$/, '')).join(' and ')} ${slow.length === 1 ? 'is' : 'are'} still being read; ask again in a minute.`)
  return parts.length ? ` (${parts.join(' ')})` : ''
}

export interface AnswerContext {
  sources: AskSource[]
  call: ModelCall
  fallback: string
  services?: string[]
  /** Who is asking (their role): turns on the reading cache for slow areas, kept apart per role. */
  cacheKey?: string
  /** Told which areas the answer was read from, for the page's "Sources used". */
  used?(titles: string[]): void
  /** The question is "what's on <cluster>" even though the cluster's name was taken out of it. */
  inventory?: boolean
  /** The cluster's name, for the inventory's first line. */
  clusterName?: string
  /**
   * How much the inventory says, following the pages it comes from: 'full' (admins) adds what runs in each guest,
   * websites and addresses; 'basic' (default) is name, type and ID, node, state and HA only, and reads nothing else.
   */
  inventoryDetail?: 'basic' | 'full'
  now?: () => number
}

/**
 * Answers a question, or null when it is not one for this path (a request to deploy, or no source is about
 * it), and the caller carries on as before. The inventory ("what's on my cluster"), the roll-call ("how is
 * everything") and common questions from code; the model otherwise, told to use only the selected summaries. When
 * no provider responds, the typed reason and the canned text (`fallback`).
 */
export async function answerQuestion(prompt: string, ctx: AnswerContext): Promise<string | null> {
  const { sources } = ctx
  const index = indexText(sources)
  const load = (s: AskSource) => loadWithin(s, { cacheKey: ctx.cacheKey, now: ctx.now })
  const p = prompt.toLowerCase()

  // "What's on my cluster", "list my guests": every guest, from the cluster's own list. Never a slow area.
  const cluster = sources.find(s => s.id === 'cluster')
  if (cluster && (ctx.inventory || isInventoryQuestion(prompt))) {
    const hintBudget = Math.max(500, (cluster.budgetMs ?? DEFAULT_BUDGET_MS) - 1000)
    let timer: NodeJS.Timeout | undefined
    const full = ctx.inventoryDetail === 'full'
    const hints = full && cluster.hints
      ? Promise.race([cluster.hints().catch(() => null), new Promise<'late'>(r => { timer = setTimeout(() => r('late'), hintBudget) })]).finally(() => clearTimeout(timer))
      : Promise.resolve(null)
    const [l, h] = await Promise.all([load(cluster), hints])
    ctx.used?.([cluster.title])
    const data = l.sum.data as ClusterSummary | undefined
    if (!data) return l.state === 'pending' ? 'The cluster is slow to answer right now, so I cannot list what is on it yet. Ask again in a minute.'
      : `I could not read the guest list from the cluster just now${l.sum.unread?.[0] ? ` (${l.sum.unread[0].replace(/^[^(]*\(/, '').replace(/\)$/, '')})` : ''}.`
    const hint: AppHints | null = h === 'late'
      ? { apps: {}, addresses: {}, asOf: null, note: 'What each guest runs is still being looked up; ask again in a minute for the apps and addresses.' }
      : h
    const old = l.state === 'cached' ? `\n\nThe cluster was slow to answer, so this is its last reading${asOfNote(l.sum, ctx.now) || ''}.` : ''
    return inventoryText(data, hint, { prompt, name: ctx.clusterName, now: (ctx.now ?? Date.now)(), detail: full ? 'full' : 'basic' }) + old
  }

  // Not ours: a request to have something deployed goes to the planner.
  if (looksLikeRequest(prompt, ctx.services)) return null

  if (ROLLCALL.test(p.trim())) {
    // Every area at once, each within its own budget: a slow one never holds the answer up.
    const all = await Promise.all(sources.filter(s => s.overview !== false || s.id === 'status').map(load))
    ctx.used?.(all.map(l => l.s.title))
    return rollCallText(all, (ctx.now ?? Date.now)())
  }

  const chosen = selectSources(prompt, sources)
  // Nothing here knows what this is about: leave it to the intent call, as before.
  if (!chosen.length) return null
  const loaded = await Promise.all(chosen.map(load))
  ctx.used?.(loaded.map(l => l.s.title))

  for (const { s, sum } of loaded) {
    if (sum.locked) return `${s.title}: ${LOCKED_NOTE}`
    const exact = s.answer?.(prompt, sum) ?? (s.matchLines ? lineAnswer(prompt, sum.lines) : null)
    if (exact) return exact + asOfNote(sum, ctx.now) + noteOf(loaded)
  }
  if (loaded.length && loaded.every(l => l.state === 'pending'))
    return `${loaded.map(l => l.s.title).join(' and ')} ${loaded.length === 1 ? 'is' : 'are'} slow to answer and still being read. Ask again in a minute.`
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

/** " (as of 14:05)" for a reading older than a few minutes; with its date when not today. */
function asOfNote(sum: SourceSummary, now?: () => number): string {
  return asOfText(sum.asOf, (now ?? Date.now)())
}
