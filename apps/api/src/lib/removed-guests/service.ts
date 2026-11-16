// =============================================================================
//  HyperProx — removed guests: the watch, the notice and the clean-up
//
//  Every five minutes while HyperProx is unlocked: one read of the cluster's
//  resource list (nodes and guests together), and the task log only when a
//  watched guest is missing from it (to tell a migration or restore from a
//  removal, and to date a removal). lib/removed-guests/detector.ts decides.
//
//  For each removed guest the page shows what HyperProx still holds for it
//  (lib/removed-guests/holdings.ts) with one Clean up. A backup job that still
//  names a guest that no longer exists is also announced on the notification
//  channels, once, for any guest (HyperProx's own or not), and resolved when the
//  job no longer names it.
// =============================================================================

import {
  EMPTY_STATE, FORGET_AFTER_MS, absentCandidates, forgetRemoved, markDestroyed, step,
  type Candidate, type ClusterRead, type DetectorState, type Kind, type RemovedGuest,
} from './detector'
import { cleanUp, holdingsFor, jobVmids, noticeWords, type CleanChoice, type CleanResult, type Holding, type HoldingDeps } from './holdings'
import type { NotifyEventInput } from '../notify/types'

export const TICK_MS = 5 * 60_000
/** A migration or restore that ended this recently still counts as moving the guest. */
export const BUSY_WINDOW_MS = 15 * 60_000
const BUSY_TYPES = new Set(['qmigrate', 'vzmigrate', 'hamigrate', 'harelocate', 'qmrestore', 'vzrestore', 'qmclone', 'vzclone'])
const DESTROY_TYPES = new Set(['qmdestroy', 'vzdestroy'])

export interface ServiceState extends DetectorState {
  /** Backup-job alerts sent, by vmid (when). */
  alerted: Record<string, number>
}

export interface TaskRow { type: string; id: string; status?: string; starttime: number; endtime?: number }

export interface RemovedGuestsDeps {
  store: { get(): Promise<ServiceState>; put(s: ServiceState): Promise<void> }
  /** /cluster/resources, nodes and guests. A failed read resolves { ok: false }. */
  readCluster(): Promise<ClusterRead>
  /** /cluster/tasks (recent and running). Throws when unreadable: absences then do not advance. */
  tasks(): Promise<TaskRow[]>
  /** Guests HyperProx's records and the backup jobs name. */
  candidates(): Promise<Candidate[]>
  /** What the last service scan saw, by vmid. Never starts a scan. */
  scanAddresses(): Map<number, string[]>
  holdings: HoldingDeps
  unlocked(): boolean
  publish(e: NotifyEventInput): Promise<void>
  now?(): number
  log?(m: string): void
}

export interface RemovedGuestView {
  vmid: number
  type: Kind | null
  name: string | null
  removedAt: number | null
  dateFrom: RemovedGuest['dateFrom']
  noticedAt: number
  reused: RemovedGuest['reused']
  words: string
  holdings: Holding[]
  unread: string[]
}

export class RemovedGuestsRefusal extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); this.name = 'RemovedGuestsRefusal' }
}

export const EMPTY_SERVICE_STATE: ServiceState = { ...structuredClone(EMPTY_STATE), alerted: {} }

export class RemovedGuestsService {
  private queue: Promise<unknown> = Promise.resolve()
  private running: Promise<void> | null = null
  private now: () => number
  constructor(private d: RemovedGuestsDeps) { this.now = d.now ?? Date.now }

  /** One change to the state, serialised with every other, on a fresh read. */
  private mutate<T>(fn: (s: ServiceState) => Promise<T> | T): Promise<T> {
    const run = this.queue.then(async () => {
      const s = { ...structuredClone(EMPTY_SERVICE_STATE), ...(await this.d.store.get()) }
      const out = await fn(s)
      await this.d.store.put(s)
      return out
    })
    this.queue = run.catch(() => {})
    return run
  }

  async state(): Promise<ServiceState> { return { ...structuredClone(EMPTY_SERVICE_STATE), ...(await this.d.store.get()) } }

  /** One look. One at a time; nothing while locked (every source needs the vault). */
  tick(): Promise<void> {
    if (this.running) return this.running
    this.running = this.pass().finally(() => { this.running = null })
    return this.running
  }

  private async pass(): Promise<void> {
    if (!this.d.unlocked()) return
    const read = await this.d.readCluster().catch((e: any): ClusterRead => ({ ok: false, at: this.now(), why: String(e?.message ?? e) }))
    // A record that cannot be read is no candidate this time; the guests already watched still are.
    const candidates = await this.d.candidates().catch(() => [] as Candidate[])
    const cur = await this.state()
    const missing = absentCandidates(cur, read, candidates)
    let busy = new Set<number>()
    let destroyedAt: ((v: number) => number | null) | undefined
    if (missing.length) {
      try {
        const tasks = await this.d.tasks()
        const t = this.now()
        busy = new Set(tasks.filter(x => BUSY_TYPES.has(x.type) && (!x.endtime || t - x.endtime * 1000 < BUSY_WINDOW_MS)).map(x => Number(x.id)).filter(Number.isInteger))
        destroyedAt = v => {
          const hit = tasks.filter(x => DESTROY_TYPES.has(x.type) && Number(x.id) === v && (!x.status || x.status === 'OK')).sort((a, b) => b.starttime - a.starttime)[0]
          return hit ? hit.starttime * 1000 : null
        }
      } catch {
        // Without the task log a migration cannot be ruled out: no absence advances this time.
        busy = new Set(missing)
      }
    }
    await this.mutate(s => Object.assign(s, step(s, { read, candidates, addresses: this.d.scanAddresses(), busy, destroyedAt })))
    await this.alertBackupJobs().catch(e => this.d.log?.(`[removed-guests] backup-job alert check failed: ${e?.message ?? e}`))
    await this.prune().catch(() => undefined)
  }

  /** Announce once each removed guest a backup job still names; resolve it when no job names it. */
  private async alertBackupJobs(): Promise<void> {
    const s = await this.state()
    const removed = Object.values(s.removed).filter(g => !g.reused)
    if (!removed.length && !Object.keys(s.alerted).length) return
    const jobs = await this.d.holdings.pve.backupJobs()
    const named = new Map<number, string[]>()
    for (const j of jobs) for (const v of jobVmids(j.vmid)) named.set(v, [...(named.get(v) ?? []), j.id])
    const send: Array<{ g: RemovedGuest; jobs: string[] }> = []
    const resolve: number[] = []
    for (const g of removed) if (named.has(g.vmid) && !s.alerted[String(g.vmid)]) send.push({ g, jobs: named.get(g.vmid)! })
    for (const k of Object.keys(s.alerted)) {
      const g = s.removed[k]
      if (!g || g.reused || !named.has(Number(k))) resolve.push(Number(k))
    }
    for (const { g, jobs: ids } of send) {
      await this.d.publish(alertFor(g, ids))
      await this.mutate(x => { x.alerted[String(g.vmid)] = this.now() })
    }
    for (const v of resolve) {
      await this.d.publish({ ...alertFor({ vmid: v, name: s.removed[String(v)]?.name ?? null } as RemovedGuest, []), resolved: true })
      await this.mutate(x => { delete x.alerted[String(v)] })
    }
  }

  /** A removed guest HyperProx has held nothing for, for a month, is forgotten. */
  private async prune(): Promise<void> {
    const s = await this.state()
    for (const g of Object.values(s.removed)) {
      if (this.now() - g.noticedAt < FORGET_AFTER_MS) continue
      const { holdings } = await holdingsFor(g, this.d.holdings)
      if (!holdings.length) await this.mutate(x => Object.assign(x, forgetRemoved(x, g.vmid)))
    }
  }

  /** The removed guests HyperProx still holds something for, each with the notice sentence. */
  async view(): Promise<{ guests: RemovedGuestView[]; lastRead: DetectorState['lastRead'] }> {
    const s = await this.state()
    const guests: RemovedGuestView[] = []
    for (const g of Object.values(s.removed).sort((a, b) => (b.removedAt ?? b.noticedAt) - (a.removedAt ?? a.noticedAt))) {
      const { holdings, unread } = await holdingsFor(g, this.d.holdings)
      if (!holdings.length) continue
      guests.push({ vmid: g.vmid, type: g.type, name: g.name, removedAt: g.removedAt, dateFrom: g.dateFrom, noticedAt: g.noticedAt, reused: g.reused ?? null, words: noticeWords(g, holdings), holdings, unread })
    }
    return { guests, lastRead: s.lastRead }
  }

  /** "Clean up": only for a guest the detector (or HyperProx's own delete) decided is removed. */
  async cleanUp(vmid: number, choice: CleanChoice, by: string): Promise<{ results: CleanResult[]; unread: string[]; left: number }> {
    if (!this.d.unlocked()) throw new RemovedGuestsRefusal('locked', 'HyperProx is locked. Sign in, then clean up again.', 423)
    const g = (await this.state()).removed[String(vmid)]
    if (!g) throw new RemovedGuestsRefusal('not_removed', `HyperProx has not found guest ${vmid} removed, so it cleans nothing up for it.`, 404)
    const r = await cleanUp(g, choice, by, this.d.holdings)
    const left = (await holdingsFor(g, this.d.holdings)).holdings.length
    if (!left) await this.alertBackupJobs().catch(() => undefined)
    return { ...r, left }
  }

  /**
   * HyperProx deleted this guest itself and read it back gone: the same clean-up runs now, as part of the delete
   * (what it published only when chosen). Returns a sentence for the delete's answer; never fails the delete.
   */
  async afterDestroy(g: { vmid: number; type: Kind; name: string; node: string }, choice: CleanChoice, by: string): Promise<string> {
    try {
      await this.mutate(s => Object.assign(s, markDestroyed(s, g, this.now())))
      const { results } = await this.cleanUp(g.vmid, choice, by)
      if (!results.length) return ''
      const failed = results.filter(r => r.outcome !== 'removed')
      return ` HyperProx also cleaned up what it held for it (${results.length - failed.length} of ${results.length})${failed.length ? `: ${failed.map(f => f.words).join(' ')}` : '.'}`
    } catch (e: any) {
      return ` HyperProx could not clean up what it held for it (${String(e?.message ?? e).slice(0, 200)}); the Removed guests notice offers it again.`
    }
  }

  /** The timer, and a pass after every unlock. Returns the stop. */
  start(onUnlock: (cb: () => void) => void): () => void {
    const timer = setInterval(() => { void this.tick().catch(e => this.d.log?.(`[removed-guests] ${e?.message ?? e}`)) }, TICK_MS)
    timer.unref?.()
    onUnlock(() => { void this.tick().catch(() => undefined) })
    return () => clearInterval(timer)
  }
}

export function alertFor(g: Pick<RemovedGuest, 'vmid' | 'name'>, jobs: string[]): NotifyEventInput {
  return {
    type: 'backup.job.dead_guest', severity: 'warning',
    title: 'A backup job names a guest that no longer exists',
    lines: [
      `${g.name ? `${g.name} (${g.vmid})` : `Guest ${g.vmid}`} is no longer on the cluster, but backup job${jobs.length === 1 ? '' : 's'} ${jobs.join(', ')} still list${jobs.length === 1 ? 's' : ''} it.`,
      'Proxmox then reports the whole job as failed on every node, although every other guest backs up.',
      'Clean up on the dashboard takes only that ID out of the job.',
    ],
    link: '/dashboard', linkLabel: 'Clean up', where: 'dashboard',
    subject: { kind: 'guest', name: g.name ?? String(g.vmid) },
    fingerprint: `backup.job.dead_guest:${g.vmid}`,
    ...(g.name ? { plain: [g.name] } : {}),
  }
}
