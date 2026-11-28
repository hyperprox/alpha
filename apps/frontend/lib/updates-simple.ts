// The simple Updates view as plain functions, so every state can be tested without a browser: the one status line,
// when a check is fresh enough to update from, the per-machine progress list, plain sentences for refusals, and the
// "Update now" flow (check first when the last check is old or partial, then one confirmation, then the run).

import type { UpdatesPlan, UpdatesCheckCluster, UpdatesCheckStatus, UpdatesJob, UpdatesRebootStatus, UpdatesStep } from '@hyperprox/types'
import { looksTechnical } from '@/lib/api'
import { ago } from '@/lib/clusters'

/** A check newer than this counts as current for "Update now". */
export const FRESH_MS = 60 * 60_000

export const EMPTY_SELECTION_TEXT = 'Pick at least one machine, or run Check now first.'
export const CHECKING_NOW_TEXT = 'Nothing to update yet — checking now…'
export const UP_TO_DATE_TEXT = 'Everything is up to date'

export type Freshness = 'none' | 'partial' | 'stale' | 'fresh'

export const rowFor = (check: UpdatesCheckStatus | null | undefined, clusterId: string): UpdatesCheckCluster | null =>
  check?.clusters.find(c => c.cluster.id === clusterId) ?? null

/** none: never read. partial: skipped, stopped early or some machines unread. stale: complete but over an hour old. */
export function freshness(row: UpdatesCheckCluster | null, now = Date.now()): Freshness {
  if (!row) return 'none'
  if (row.result !== 'ok' || row.unread.length || row.notice) return row.lastOkAt || row.result === 'partial' ? 'partial' : 'none'
  const at = Date.parse(row.at)
  return Number.isFinite(at) && now - at <= FRESH_MS ? 'fresh' : 'stale'
}

/** Why the last result is partial, in plain words. Empty when it is not. */
export function partialWhy(row: UpdatesCheckCluster | null): string {
  if (!row) return ''
  const r = row.reason ?? ''
  if (row.result === 'skipped') {
    if (/locked/i.test(r)) return 'HyperProx was locked at the time, so it could not read the machines. It checks again shortly after you sign in.'
    if (/Updates job|job is running/i.test(r)) return 'An update was running, so the check waited. It checks again when the update is over.'
    if (/backup/i.test(r)) return 'A backup was running on the cluster, so the check waited.'
    return 'The check could not reach the cluster this time.'
  }
  if (row.notice) return 'HyperProx could not read the list of guests to leave alone, so it did not look inside any guest.'
  if (row.result === 'partial') {
    if (/Updates run was started|Updates job started/i.test(r)) return 'An update was started while the check was reading, so it stopped early.'
    if (/limit/i.test(r)) return 'The check took too long and stopped early.'
    if (row.unread.length) return `${row.unread.length} machine${row.unread.length === 1 ? '' : 's'} could not be read.`
    return 'The check stopped early, so some machines were not read.'
  }
  return ''
}

export type StatusLine = { text: string; sub: string; tone: 'good' | 'warn' | 'crit' | 'muted' }

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

/** The machines in a run, one row each, with a plain state. Preflight and cluster-wide steps are not machines. */
export type ProgressRow = { name: string; state: 'done' | 'working' | 'waiting' | 'failed' }
export function progressOf(job: Pick<UpdatesJob, 'steps'> | null): ProgressRow[] {
  if (!job) return []
  const by = new Map<string, UpdatesStep[]>()
  for (const s of job.steps) { if (s.target === 'cluster') continue; by.set(s.target, [...(by.get(s.target) ?? []), s]) }
  return [...by.entries()].map(([name, steps]) => {
    const state: ProgressRow['state'] = steps.some(s => s.status === 'failed') ? 'failed'
      : steps.every(s => s.status === 'ok' || s.status === 'skipped') ? 'done'
      : steps.some(s => s.status === 'running' || s.status === 'ok') ? 'working' : 'waiting'
    return { name, state }
  })
}

export function statusLine(i: { row: UpdatesCheckCluster | null; checking: boolean; phase: string | null; job: UpdatesJob | null; loaded: boolean; now?: number }): StatusLine {
  const now = i.now ?? Date.now()
  const last = i.row?.lastOkAt ? `Last full check ${ago(Date.parse(i.row.lastOkAt))}.` : 'No full check yet.'
  if (i.phase) return { text: i.phase, sub: '', tone: 'muted' }
  if (i.job && (i.job.status === 'running' || i.job.status === 'paused')) {
    const rows = progressOf(i.job)
    const done = rows.filter(r => r.state === 'done' || r.state === 'failed').length
    if (i.job.status === 'paused') return { text: 'The update paused and needs you', sub: i.job.pauseReason ? `${i.job.pauseReason.replace(/\.$/, '')}.` : '', tone: 'warn' }
    return { text: rows.length ? `Updating ${Math.min(done + 1, rows.length)} of ${rows.length}…` : 'Updating…', sub: '', tone: 'muted' }
  }
  if (i.job?.status === 'awaiting-confirm') return { text: 'An update plan is waiting for your OK', sub: `${i.job.pauseReason ? `${i.job.pauseReason} ` : ''}It is cancelled by itself after a day if you do nothing.`, tone: 'warn' }
  if (i.checking) return { text: 'Checking…', sub: last, tone: 'muted' }
  if (!i.loaded) return { text: 'Reading the last check…', sub: '', tone: 'muted' }
  const f = freshness(i.row, now)
  if (!i.row || f === 'none') return { text: 'Not checked yet', sub: 'Press Update now and it will check first.', tone: 'muted' }
  if (f === 'partial') return { text: 'The last check could not read everything', sub: `${partialWhy(i.row)} ${last}`.trim(), tone: 'warn' }
  const machines = i.row.available
  const sec = i.row.targets.filter(t => t.packages > 0 && t.security.length > 0).length
  if (!machines) return { text: UP_TO_DATE_TEXT, sub: `${last}`, tone: 'good' }
  return { text: `${plural(machines, 'machine')} ${machines === 1 ? 'has' : 'have'} updates${sec ? ` (${sec} with security fixes)` : ''}`, sub: last, tone: sec ? 'crit' : 'warn' }
}

/** One sentence for the finished run, in plain words. */
export function finishedLine(job: UpdatesJob | null): string | null {
  if (!job || ['running', 'paused', 'awaiting-confirm', 'planned'].includes(job.status)) return null
  const when = job.finishedAt ? ` ${ago(Date.parse(job.finishedAt))}` : ''
  if (job.status === 'cancelled') return `The last update was cancelled${when}. ${job.pauseReason ? `${job.pauseReason.replace(/\.$/, '')}.` : 'Nothing more was changed.'}`
  const rows = progressOf(job)
  const failed = rows.filter(r => r.state === 'failed').length
  const ok = rows.filter(r => r.state === 'done').length
  if (job.status === 'failed' || failed) return `The last update finished${when}: ${plural(ok, 'machine')} updated, ${failed || 1} need${failed === 1 || !failed ? 's' : ''} a look. Open Advanced for the details.`
  if (job.trigger === 'dry-run') return `The last dry run finished${when}. Nothing was changed.`
  return `The last update finished${when}: ${plural(ok, 'machine')} updated, nothing needs attention.`
}

/** A refusal or failure from the API, in a sentence a person can act on. Never the raw message of the server. */
export function plainRefusal(r: { status: number; code?: string; error?: string }, what: string): string {
  switch (r.code) {
    case 'check_busy': case 'check_running': return 'HyperProx is still reading the machines. Try again in a minute.'
    case 'too_soon': return 'A check was run a few minutes ago. Try again shortly.'
    case 'nothing_to_update': return 'Nothing needs updating right now.'
    case 'invalid_request': if (r.error !== EMPTY_SELECTION_TEXT) return `Could not ${what}. Try Check now, then try again.`; break
    case 'token_refused': return 'Sign in to do this; an API token cannot.'
  }
  if (r.status === 0) return r.error ?? 'Could not reach HyperProx. Check your connection, then try again.'
  if (r.status === 403) return 'Updates is limited to admins.'
  if (r.status === 404) return `The Updates API is not available on this server yet (${what}).`
  if (r.status === 409) return 'An update is already running. Showing it.'
  if (r.status === 429) return 'Please wait a few minutes before checking again.'
  if (!r.error || looksTechnical(r.error)) return `Could not ${what}. Try again in a minute.`
  return r.error
}

/** The line under the automatic-install switch: when it installs and when reboots happen. */
export function autoInstallLine(time: string, reboots: UpdatesRebootStatus | null): string {
  const s = reboots?.settings
  const w = s?.window
  const end = w ? `${String((Number(w.start.slice(0, 2)) + w.hours) % 24).padStart(2, '0')}:${w.start.slice(3)}` : ''
  const rebootPart = !reboots || !reboots.available ? 'reboots stay by hand'
    : s && (s.nodes || s.guests) && w ? `reboots ${w.start}–${end}`
    : 'reboots stay by hand until you turn Automatic reboots on in Advanced'
  return `Every morning at ${time}, ${rebootPart}.`
}

/** What the plan shown in the confirmation holds: machines, those that cannot be snapshotted, and what it will not run. */
export function planFacts(plan: Pick<UpdatesPlan, 'steps' | 'refused'>, nameOf: (target: string) => string = t => t) {
  const machines = new Set(plan.steps.filter(s => s.target !== 'cluster').map(s => s.target))
  const noSnapshot = [...new Set(plan.steps.filter(s => s.action === 'snapshot' && /not possible/i.test(s.detail ?? '')).map(s => s.target))].map(nameOf)
  return { machines: machines.size, noSnapshot, refused: (plan.refused ?? []).map(r => r.reason) }
}

/** The one sentence that covers the whole "Update now" run, from the plan itself: counts and exceptions. */
export function confirmSentence(i: { facts: ReturnType<typeof planFacts>; remote: boolean; reboots: UpdatesRebootStatus | null }): string {
  const { machines, noSnapshot, refused } = i.facts
  const snap = noSnapshot.length ? `Guests get a snapshot first where possible (${noSnapshot.length} can't: ${noSnapshot.slice(0, 6).join(', ')}${noSnapshot.length > 6 ? ' and more' : ''}, so they update without one)` : 'Each guest gets a snapshot first'
  const skip = refused.length ? ` ${plural(refused.length, 'thing')} in your choice will not run: ${refused.slice(0, 2).join('; ')}${refused.length > 2 ? '; and more' : ''}.` : ''
  const base = `Update ${plural(machines, 'machine')} now. ${snap}, and everything runs in a safe order, one step at a time.${skip}`
  if (i.remote) return `${base} HyperProx does not reboot a remote server by itself: any that needs a reboot is left for you to do by hand.`
  const hand = i.reboots?.byHand?.length
  const s = i.reboots?.settings
  const win = i.reboots?.nextWindow
  const rb = win && s ? `Reboots happen in the reboot window (${s.window.start}–${String((Number(s.window.start.slice(0, 2)) + s.window.hours) % 24).padStart(2, '0')}:${s.window.start.slice(3)}).` : 'Any reboot that is needed happens in the next reboot window.'
  return `${base} ${rb}${hand ? ` ${plural(i.reboots!.byHand.length, 'machine')} needs a reboot by hand.` : ''} If the plan changes before it starts, you will be asked again.`
}

// --- The flow ---------------------------------------------------------------------------------

export interface UpdateNowDeps {
  row: () => UpdatesCheckCluster | null
  now?: () => number
  /** Start a check and wait until it has finished (resolves false when it could not run). */
  checkAndWait: () => Promise<boolean>
  /** Re-read the machines and give back the ids "Update everything" would run (empty when nothing). */
  readSelection: () => Promise<string[]>
  /** The row after the check (reads it again). */
  rowAfter: () => Promise<UpdatesCheckCluster | null>
  /** The plan these ids would run (read-only), with the hash the run is confirmed against; null when it cannot be read. */
  preview: (ids: string[]) => Promise<{ plan: UpdatesPlan; planHash: string } | null>
  /** Ask the one question, which shows that plan; true when the person said yes. */
  confirm: (ids: string[], pv: { plan: UpdatesPlan; planHash: string }) => Promise<boolean>
  start: (ids: string[], planHash: string) => Promise<void>
  say: (text: string | null, kind?: 'info' | 'warn') => void
  phase: (text: string | null) => void
}

export type UpdateNowResult = 'started' | 'up-to-date' | 'declined' | 'not-checked' | 'nothing'

/** Update now: check first when the last check is not fresh and complete, then one confirmation, then the run. */
export async function updateNow(d: UpdateNowDeps): Promise<UpdateNowResult> {
  d.say(null)
  if (freshness(d.row(), d.now?.() ?? Date.now()) !== 'fresh') {
    d.phase('Checking first…')
    const ran = await d.checkAndWait().catch(() => false)
    d.phase(null)
    if (!ran) { d.say('Could not check the machines just now. Try again in a minute.', 'warn'); return 'not-checked' }
  }
  const row = await d.rowAfter()
  const ids = await d.readSelection()
  if (!ids.length) {
    if (freshness(row, d.now?.() ?? Date.now()) === 'fresh') { d.say(UP_TO_DATE_TEXT, 'info'); return 'up-to-date' }
    d.say('Nothing could be read to update yet. See why in Advanced, then try again.', 'warn')
    return 'nothing'
  }
  const pv = await d.preview(ids)
  if (!pv) { d.say('Could not work out what would run. Try again in a minute.', 'warn'); return 'nothing' }
  if (!(await d.confirm(ids, pv))) return 'declined'
  await d.start(ids, pv.planHash)
  return 'started'
}
