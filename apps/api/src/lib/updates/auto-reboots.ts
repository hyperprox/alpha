// =============================================================================
//  HyperProx — Updates: automatic reboots, the service
//
//  Once a minute (well, every 30 s) at home: is it the reboot window, is anything waiting for a reboot, and are
//  automatic reboots on for it (or did a person tick "Reboot automatically in the next window" when starting an
//  update run)? Then one rolling reboot job starts (UpdatesRunner.startRebootRun), at most once per window. A run
//  that was carrying on through HyperProx's own node's reboot is picked up again here once HyperProx is unlocked.
//
//  Also the page's view (status) and the person's actions (settings, Reboot now, Make safe), each audited by the
//  route or here before anything changes. Remote clusters: HyperProx does not reboot their nodes on its own, so
//  the card says so and nothing here runs for them.
// =============================================================================

import type { UpdatesRebootHistoryRow, UpdatesRebootSettings, UpdatesRebootStatus } from './types'
import type { ClusterUpdates } from './service'
import { HOME_ID } from '../clusters/registry'
import { orderNodes } from './planner'
import { jobView, type StepRecord } from './store'
import { JobStateError } from './runner'
import {
  mergeRebootSettings, rebootTargets, settingsOf, windowKey, windowState, type RebootStateStore, type RebootTargets,
} from './reboots'
import { selfVmidOf } from './inventory'
import type { UpdatesInventory } from './types'
import type { Policy } from './policy'

export interface AutoRebootsDeps {
  /** The service for a cluster (lib/updates/service.ts). */
  service:    (clusterId: string) => ClusterUpdates
  state:      RebootStateStore
  isUnlocked: () => boolean
  /** True while the daily check reads machines: a window waits a tick. */
  busy?:      () => boolean
  now?:       () => number
  log?:       (msg: string, level?: 'warn' | 'error') => void
  /** This host's name, to find HyperProx's own guest (never a reboot target). */
  hostname?:  string
  /** How long a run may wait for HyperProx to be unlocked after its restart before it is stopped. Default 60 min. */
  strandedMs?: number
}

export type TickResult = 'off' | 'outside' | 'done' | 'locked' | 'busy' | 'nothing' | 'started' | 'continued' | 'stopped' | 'error'

const REMOTE_WHY = 'HyperProx does not reboot the nodes of a remote cluster on its own. Reboot them from this page, one at a time, after moving their guests.'

export class AutoReboots {
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false

  constructor(private deps: AutoRebootsDeps) {}

  private now(): number { return this.deps.now ? this.deps.now() : Date.now() }

  start(intervalMs = 30_000): void {
    if (this.timer) return
    this.timer = setInterval(() => { this.tick().catch(e => this.deps.log?.(`[updates] automatic reboots: ${e?.message ?? e}`, 'error')) }, intervalMs)
    this.timer.unref?.()
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null }

  settings(clusterId: string): UpdatesRebootSettings { return settingsOf(this.deps.state.get(clusterId)) }

  /** The settings a change would give, checked but not saved. Throws RebootSettingsError with a sentence. */
  checkSettings(clusterId: string, patch: unknown): UpdatesRebootSettings {
    return mergeRebootSettings(settingsOf(this.deps.state.get(clusterId)), patch)
  }

  /** Save settings checkSettings returned (the route confirms and audits first). */
  saveSettings(clusterId: string, next: UpdatesRebootSettings): void {
    const st = this.deps.state.get(clusterId)
    this.deps.state.set(clusterId, { ...st, settings: next })
  }

  /**
   * "Reboot automatically in the next window", from an update run: the next window reboots this run's own targets
   * (`only`: its nodes and guests; null: a run of the whole plan), even with the switches off, once. Your policy
   * still decides (reboot: auto per node and guest, auto_reboot: false, leave-alone, HyperProx's own guest).
   */
  queueNext(clusterId: string, by: string, jobId?: string, only: { nodes: string[]; guests: number[] } | null = null): void {
    const st = this.deps.state.get(clusterId)
    this.deps.state.set(clusterId, { ...st, queued: { at: new Date(this.now()).toISOString(), by, ...(jobId ? { jobId } : {}), only } })
  }

  /** What a window would reboot: what the switches cover, plus what a queued request names. */
  private targetsFor(inv: UpdatesInventory, policy: Policy, s: { nodes: boolean; guests: boolean }, queued: { only?: { nodes: string[]; guests: number[] } | null } | null | undefined): RebootTargets {
    const order = (nodes: UpdatesInventory['nodes']) => orderNodes(nodes, policy)
    const selfVmid = selfVmidOf(inv, policy, this.deps.hostname)
    const base = rebootTargets(inv, policy, s, order, { selfVmid })
    if (!queued) return base
    const q = rebootTargets(inv, policy, { nodes: true, guests: true }, order, { selfVmid, only: queued.only ?? null })
    const nodes = order(inv.nodes).map(n => n.node).filter(n => base.nodes.includes(n) || q.nodes.includes(n))
    const guests = [...new Set([...base.guests, ...q.guests])].sort((a, b) => a - b)
    const skipped = [...base.skipped, ...q.skipped.filter(x => !base.skipped.some(y => y.target === x.target))]
    return { nodes, guests, skipped, never: base.never }
  }

  /** One look at home: carry on a run cut off by a restart, or start the window's run. */
  async tick(): Promise<TickResult> {
    if (this.ticking) return 'busy'
    this.ticking = true
    try { return await this.tickOnce() } finally { this.ticking = false }
  }

  private async tickOnce(): Promise<TickResult> {
    const svc = this.deps.service(HOME_ID)
    if (this.deps.isUnlocked()) {
      try { if (await svc.runner.continueRebootRun()) return 'continued' } catch (e: any) { this.deps.log?.(`[updates] could not continue the reboot run: ${e?.message ?? e}`, 'error') }
    } else {
      // Locked: a run waiting to finish its checks does not hold the lock for ever.
      try { if (await svc.runner.expireStrandedRebootRun(this.deps.strandedMs ?? 60 * 60_000)) return 'stopped' } catch (e: any) { this.deps.log?.(`[updates] could not stop the waiting reboot run: ${e?.message ?? e}`, 'error') }
    }
    const st = this.deps.state.get(HOME_ID)
    const s = settingsOf(st)
    if (!s.nodes && !s.guests && !st.queued) return 'off'
    const now = this.now()
    const w = windowState(now, s.window, s.timezone)
    if (!w.current) return 'outside'
    const key = windowKey(w.current.start, s.window, s.timezone)
    if (st.lastWindow === key) return 'done'
    if (!this.deps.isUnlocked()) return 'locked'
    if (this.deps.busy?.()) return 'busy'
    if (await svc.store.activeJob()) return 'busy'
    const load = svc.loadPolicy()
    let targets
    try {
      const inv = await svc.inventory(true)
      targets = this.targetsFor(inv, load.policy, s, st.queued)
    } catch (e: any) {
      this.deps.log?.(`[updates] automatic reboots: could not read what needs a reboot: ${e?.message ?? e}`, 'warn')
      return 'error'
    }
    // One run per window, and a queued request is used up by the window that looked at it.
    this.deps.state.set(HOME_ID, { ...st, lastWindow: key, queued: null })
    if (!targets.nodes.length && !targets.guests.length) return 'nothing'
    try {
      await svc.runner.startRebootRun({ kind: 'window', windowEnd: w.current.end, quiet: s.quiet, nodes: targets.nodes, guests: targets.guests, skipped: targets.skipped })
      return 'started'
    } catch (e: any) {
      this.deps.log?.(`[updates] automatic reboots did not start: ${e?.message ?? e}`, 'error')
      return 'error'
    }
  }

  /** "Reboot now (rolling)": the same engine, now, waiting for viewers at most the window's length. */
  async rebootNow(clusterId: string, opts: { all?: boolean; actor?: string }) {
    const svc = this.deps.service(clusterId)
    if (svc.remote) throw new JobStateError(REMOTE_WHY)
    const s = settingsOf(this.deps.state.get(clusterId))
    const load = svc.loadPolicy()
    const inv = await svc.inventory(true)
    const t = rebootTargets(inv, load.policy, { nodes: true, guests: true, allNodes: !!opts.all }, nodes => orderNodes(nodes, load.policy), { selfVmid: selfVmidOf(inv, load.policy, this.deps.hostname) })
    if (!t.nodes.length && !t.guests.length) {
      throw new JobStateError(t.skipped.length ? `Nothing can be rebooted: ${t.skipped.map(x => `${x.target} (${x.reason})`).join('; ')}` : 'Nothing needs a reboot.')
    }
    return svc.runner.startRebootRun({
      kind: 'now', windowEnd: this.now() + s.window.hours * 3_600_000, quiet: s.quiet,
      nodes: t.nodes, guests: t.guests, skipped: t.skipped, forceNodes: !!opts.all, actor: opts.actor,
    })
  }

  /** What the Automatic reboots card shows. Reads only what is cached and stored; never a machine. */
  async status(clusterId: string): Promise<UpdatesRebootStatus> {
    const svc = this.deps.service(clusterId)
    const st = this.deps.state.get(clusterId)
    const s = settingsOf(st)
    const now = this.now()
    const w = windowState(now, s.window, s.timezone)
    const load = svc.loadPolicy()
    const inv = svc.cached()
    // Everything that needs a reboot and may get one on its own; the rest (policy says by hand, HyperProx itself) listed.
    const t = inv ? rebootTargets(inv, load.policy, { nodes: true, guests: true }, nodes => orderNodes(nodes, load.policy), { selfVmid: selfVmidOf(inv, load.policy, this.deps.hostname) }) : null
    // The window that will take them: this one if it has not run yet, else the next.
    const thisOne = w.current && st.lastWindow !== windowKey(w.current.start, s.window, s.timezone) ? w.current : null
    const when = (thisOne ?? w.next)
    const iso = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString())
    const jobs = (await svc.store.listJobs(60)).filter(j => j.plan?.reboots)
    const active = jobs.find(j => ['running', 'paused', 'awaiting-confirm'].includes(j.status)) ?? null
    const history: UpdatesRebootHistoryRow[] = []
    for (const j of jobs.filter(x => x !== active).slice(0, 10)) history.push(historyRow(j, await svc.store.getSteps(j.id)))
    const last = jobs.find(j => j.status === 'failed' && j.plan.reboots?.leftOn)
    const lastAny = jobs.find(j => j !== active)
    const leftOn = last && last === lastAny && last.plan.reboots?.leftOn ? { jobId: last.id, ...last.plan.reboots.leftOn } : null
    const remote = svc.remote
    return {
      cluster: { ...svc.ref },
      available: !remote, ...(remote ? { unavailable: REMOTE_WHY } : {}),
      settings: s,
      inWindow: w.inWindow,
      nextWindow: when ? { start: new Date(when.start).toISOString(), end: new Date(when.end).toISOString() } : null,
      queued: st.queued ? { at: st.queued.at, by: st.queued.by } : null,
      waiting: {
        nodes: (t?.nodes ?? []).map(n => ({ node: n, why: whyNode(inv!, n) })),
        guests: (t?.guests ?? []).map(v => { const g = inv!.guests.find(x => x.vmid === v)!; return { vmid: v, name: g.name, node: g.node } }),
        at: !remote && (s.nodes || (st.queued && (!st.queued.only || st.queued.only.nodes.length))) ? iso(when?.start) : null,
        guestsAt: !remote && (s.guests || (st.queued && (!st.queued.only || st.queued.only.guests.length))) ? iso(when?.start) : null,
      },
      never: t ? t.never : [],
      byHand: t ? t.skipped.filter(x => !/^(offline|left alone)/.test(x.reason)) : [],
      active: active ? jobView(active, await svc.store.getSteps(active.id)) : null,
      leftOn,
      history,
    }
  }
}

function whyNode(inv: NonNullable<ReturnType<ClusterUpdates['cached']>>, node: string): string {
  const n = inv.nodes.find(x => x.node === node)
  if (!n) return 'needs a reboot'
  if (n.rebootPending) return 'a reboot an update run left pending'
  return 'a new kernel or a package asks for a reboot'
}

function historyRow(j: { id: string; status: any; startedAt: Date; finishedAt: Date | null; plan: any; report: any; pauseReason: string | null }, steps: StepRecord[]): UpdatesRebootHistoryRow {
  const rr = j.plan.reboots
  const machines = steps.filter(s => s.action === 'node-reboot' || s.action === 'self' || s.action === 'guest-reboot').map(s => ({
    target: s.target, kind: (s.action === 'guest-reboot' ? 'guest' : 'node') as 'guest' | 'node', status: s.status, reason: s.reason,
    ...(rr?.results?.[s.target] ? { result: { ...rr.results[s.target], before: undefined } } : {}),
  }))
  const ok = machines.filter(m => m.status === 'ok').length
  const summary = j.status === 'failed' ? `Stopped: ${j.pauseReason ?? 'see the steps'}`
    : `${ok} of ${machines.length} rebooted`
  return {
    id: j.id, kind: rr?.kind ?? 'window', status: j.status, startedAt: j.startedAt.toISOString(), finishedAt: j.finishedAt ? j.finishedAt.toISOString() : null,
    summary, machines,
  }
}
