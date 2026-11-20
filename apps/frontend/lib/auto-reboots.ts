// =============================================================================
//  Automatic reboots — the words and small decisions the Updates page needs
//
//  Kept apart from the components so they can be tested without a browser: how the window reads, what a node
//  that waits for its reboot says instead of a Reboot button, whether a run will need a reboot afterwards (so the
//  confirmation ticks "Reboot automatically in the next window" for you), and how far a rolling reboot has got.
// =============================================================================

import type {
  UpdatesInventory, UpdatesJob, UpdatesPlan, UpdatesRebootSettings, UpdatesRebootStatus, UpdatesStep,
} from '@hyperprox/types'

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "every day", "weekdays", "Sat, Sun". */
export function daysText(days: number[]): string {
  const d = [...new Set(days)].sort()
  if (d.length === 7) return 'every day'
  if (d.join() === '1,2,3,4,5') return 'weekdays'
  if (d.join() === '0,6') return 'weekends'
  return d.map(x => DAY_NAMES[x]).join(', ')
}

/** "03:00–06:00" (wrapping past midnight when it must). */
export function windowText(w: UpdatesRebootSettings['window']): string {
  const [h, m] = w.start.split(':').map(Number)
  const end = (h * 60 + m + w.hours * 60) % 1440
  const hh = String(Math.floor(end / 60)).padStart(2, '0'), mm = String(end % 60).padStart(2, '0')
  return `${w.start}–${hh}:${mm}`
}

/** A time in the cluster's time zone, as people say it: "Fri 03:00". */
export function whenText(iso: string | null | undefined, tz: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  try { return d.toLocaleString('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) }
  catch { return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' }
}

/** One plain sentence for the top of the card. */
export function summaryText(s: UpdatesRebootStatus): string {
  if (!s.available) return s.unavailable ?? 'Automatic reboots are not available here.'
  const on = [s.settings.nodes ? 'nodes' : '', s.settings.guests ? 'guests' : ''].filter(Boolean)
  const win = `${windowText(s.settings.window)} ${daysText(s.settings.window.days)} (${s.settings.timezone})`
  if (!on.length && !s.queued) return `Off. Machines that need a reboot wait for you to press Reboot. Window when on: ${win}. Only nodes and guests your policy sets to reboot: auto are ever rebooted on their own.`
  const what = on.length ? `On for ${on.join(' and ')}` : 'Off, but the next window was asked for once by an update run'
  return `${what}. Window ${win}${s.settings.quiet ? ', waiting while anyone is watching' : ''}.`
}

/** What a node row says instead of a Reboot button, or null when the button stays. */
export function nodeWaitText(s: UpdatesRebootStatus | null, node: string): string | null {
  if (!s?.available || !s.waiting.at) return null
  if (!s.waiting.nodes.some(n => n.node === node)) return null
  return `Waiting for its automatic reboot at ${whenText(s.waiting.at, s.settings.timezone)}`
}

/**
 * Will this run leave something needing a reboot? A node in it with a new kernel or firmware pending, or one that
 * already needs a reboot; a guest in it that already asks for one, or that is getting packages that usually do.
 */
export function rebootLikely(plan: UpdatesPlan | null | undefined, inv: UpdatesInventory | null | undefined): boolean {
  if (!plan || !inv) return false
  const nodes = new Set(plan.steps.filter(x => x.action === 'node-upgrade' || x.action === 'node-packages' || x.action === 'node-reboot').map(x => x.target))
  if (inv.nodes.some(n => nodes.has(n.node) && (n.kernelPending || n.rebootRequired || n.rebootPending || n.preview?.rebootAfter || n.preview?.firmware))) return true
  const guests = new Set(plan.steps.filter(x => x.action === 'apt' || x.action === 'apt-packages').map(x => x.target))
  const heavy = /^(libc6|systemd|linux-image|dbus|libssl|openssl)/
  return inv.guests.some(g => guests.has(String(g.vmid)) && (g.rebootRequired || g.pending.some(p => heavy.test(p.name))))
}

export type StageState = 'ok' | 'warn' | 'bad' | 'done'

/** One stage per machine in a rolling reboot, in the order it runs. */
export function rollingStages(job: UpdatesJob): { key: string; label: string; state: StageState; status: string; kind: 'node' | 'guest' }[] {
  const mine = (job.steps ?? []).filter((s: UpdatesStep) => s.action === 'node-reboot' || s.action === 'self' || s.action === 'guest-reboot')
  return mine.map(s => {
    const status = s.status === 'running' ? 'rebooting now' : s.status === 'ok' ? 'back' : s.status === 'failed' ? `stopped: ${s.reason ?? 'see the step'}` : s.status === 'skipped' ? `not rebooted: ${s.reason ?? ''}` : 'waiting its turn'
    const state: StageState = s.status === 'ok' ? 'done' : s.status === 'failed' ? 'bad' : s.status === 'running' ? 'warn' : 'ok'
    return { key: s.id, label: s.action === 'guest-reboot' ? `guest ${s.target}` : s.target, state, status, kind: s.action === 'guest-reboot' ? 'guest' : 'node' }
  })
}

/** "about 4 min", from seconds. */
export function awayText(sec?: number | null): string {
  if (sec == null) return ''
  return `about ${Math.max(1, Math.round(sec / 60))} min`
}
