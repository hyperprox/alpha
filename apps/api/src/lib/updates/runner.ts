// =============================================================================
//  HyperProx — Updates: runner
//
//  Executes a plan one step at a time, checks gates between steps, and writes
//  every state change to the store before acting on it, so a restart finds the
//  job where it stopped.
//
//  How it stops:
//    - preflight fails             → the job fails before anything changed
//    - a gate fails between steps  → the job PAUSES; a person presses Resume
//    - a guest fails               → other guests carry on; the Ceph and node
//                                    phases wait (pause) until it is resolved
//    - a node does not come back   → the job FAILS and leaves `noout` and HA
//                                    maintenance on; clearing them is a person's call
//    - HyperProx restarts mid-job  → the job is paused, never resumed on its own
//
//  Commands come from commands.ts; side effects go through the injected
//  executor, so every path here runs in tests against a fake.
// =============================================================================

import type { UpdatesPlan, UpdatesReport, UpdatesStepAction, UpdatesWsPayload } from './types'
import type { UpdatesExecutor, GuestListing, LineSink } from './executor'
import { type PolicyLoad, type Policy, guestPolicy, nodePolicy } from './policy'
import { readInventory, findSelfGuest, selfVmidOf, type InventoryResult } from './inventory'
import { buildPlan, detailKey, DETAIL } from './planner'
import {
  preflight, quorumGate, cephGate, haGate, holdsPinGate, freeSpaceGate, streamGate, judgeCeph, judgeCephSettled,
  unknownPolicyNodes, type GateResult,
} from './gates'
import {
  GUEST_REFRESH_SCRIPT, GUEST_UPGRADE_SCRIPT, NODE_FACTS_COMMAND, NODE_SERVICES_COMMAND, NODE_REBOOT_COMMAND,
  CEPH_NOOUT_SET, CEPH_NOOUT_UNSET, cephInstallCommand, cephRestartCommand, guestCheckScript, guestDockerScript,
  guestRebootCommand, haMaintenance, haSetState, isCephPackage, kernelPurgeCommand, kernelsToRemove, nodeUpgradeCommand,
  parseNodeFacts, tail, type NodeFacts,
} from './commands'
import { handoffNodeOf, handoffTag, readHandoff, selfGuestScript, selfNodeRebootScript, startHandoff } from './handoff'
import { ActiveJobError, TERMINAL, jobView, stepView, type JobRecord, type StepRecord, type UpdatesStore } from './store'
import type { UpdatesJobStatus } from './types'

export class PolicyRequiredError extends Error {
  constructor(detail?: string) {
    super(`A real run needs a valid policy file (config/updates.yaml). ${detail ?? 'See config/updates.example.yaml.'} Dry runs work without one.`)
    this.name = 'PolicyRequiredError'
  }
}
export class JobStateError extends Error {
  constructor(message: string) { super(message); this.name = 'JobStateError' }
}
export { ActiveJobError }

export interface RunnerTiming {
  nodeReturnMs:    number   // a rebooting node must be back within this
  rebootSettleMs:  number   // wait before the first "is it back" poll
  pollMs:          number
  streamRecheckMs: number
  haDrainMs:       number
  cephSettleMs:    number
  guestBootMs:     number
  handoffPollMs:   number
  handoffMaxMs:    number
}

export const DEFAULT_TIMING: RunnerTiming = {
  nodeReturnMs:    15 * 60_000,
  rebootSettleMs:  60_000,
  pollMs:          15_000,
  streamRecheckMs: 5 * 60_000,
  haDrainMs:       10 * 60_000,
  cephSettleMs:    10 * 60_000,
  guestBootMs:     5 * 60_000,
  handoffPollMs:   10_000,
  handoffMaxMs:    40 * 60_000,
}

export interface RunnerDeps {
  store:      UpdatesStore
  exec:       UpdatesExecutor
  loadPolicy: () => PolicyLoad
  emit?:      (payload: UpdatesWsPayload) => void
  /** Called with every inventory the runner reads, so the API's cache stays current. */
  onInventory?: (r: InventoryResult) => void
  notify?:    (url: string, text: string) => Promise<void>
  log?:       (msg: string) => void
  hostname?:  string
  timing?:    Partial<RunnerTiming>
}

type Outcome =
  | { status: 'ok' | 'skipped'; reason?: string; output?: string }
  | { status: 'failed'; reason: string; output?: string; fatal?: boolean }

/** Steps that belong to the guest phase. */
const GUEST_ACTIONS: UpdatesStepAction[] = ['snapshot', 'apt', 'docker', 'check']
const isGuestStep = (s: StepRecord) => GUEST_ACTIONS.includes(s.action)
const PRE_STEPS = 2   // preflight, refresh

const AFTER_GUEST_FAILURE = 'an earlier step for this guest failed'
const INTERRUPTED = 'interrupted by a HyperProx restart'
const NOT_FINISHED: UpdatesJobStatus[] = ['planned', 'awaiting-confirm', 'running', 'paused']
const SNAPSHOT_PREFIX = 'hp-upd-'
const BOOT_ID = 'cat /proc/sys/kernel/random/boot_id'

async function defaultNotify(url: string, text: string): Promise<void> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 10_000)
  try {
    // `content` is what chat webhooks (Discord, Slack-compatible) read; the full detail stays in the UI.
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text.slice(0, 1900) }), signal: ctrl.signal })
  } finally { clearTimeout(t) }
}

export class UpdatesRunner {
  private store: UpdatesStore
  private exec: UpdatesExecutor
  private timing: RunnerTiming
  private driving: Promise<void> = Promise.resolve()
  private cancelRequested = new Set<string>()
  private runStartedAt = new Map<string, number>()
  /** Whether the cluster has Ceph, asked once per job (see executor.cephPresent). */
  private cephKnown = new Map<string, boolean>()
  /** Nodes whose reboot a run deferred. Seeded from the last finished job at start-up. */
  readonly rebootPending = new Set<string>()

  constructor(private deps: RunnerDeps) {
    this.store = deps.store
    this.exec = deps.exec
    this.timing = { ...DEFAULT_TIMING, ...(deps.timing ?? {}) }
  }

  /** Resolves when the job currently being driven stops (for tests and shutdown). */
  idle(): Promise<void> { return this.driving }

  // ===========================================================================
  //  Public operations
  // ===========================================================================

  async start(mode: 'run' | 'dry-run', trigger: 'manual' | 'schedule' = 'manual', actor?: string): Promise<JobRecord> {
    const load = this.deps.loadPolicy()
    if (mode === 'run' && !load.loaded) throw new PolicyRequiredError(load.error)
    if (mode === 'run') {
      const names = (await this.exec.clusterStatus()).nodes.map(n => n.name)
      const known = unknownPolicyNodes(load.policy, names)
      if (!known.ok) throw new PolicyRequiredError(`The policy file is loaded, but ${known.reason}.`)
    }
    const job = await this.store.createJob({
      trigger: mode === 'dry-run' ? 'dry-run' : trigger,
      status: 'running',
      plan: { steps: [], warnings: [] },
    })
    await this.store.audit(`updates.job.${mode === 'dry-run' ? 'dry-run' : 'start'}`, job.id, { trigger, by: actor ?? 'scheduler' })
    await this.emitJob(job)
    this.drive(job.id, () => this.prepare(job.id, mode, trigger))
    return job
  }

  async confirm(id: string, actor?: string): Promise<JobRecord> {
    await this.mustGet(id)
    const load = this.deps.loadPolicy()
    if (!load.loaded) throw new PolicyRequiredError(load.error)
    const next = await this.transition(id, ['awaiting-confirm'], { status: 'running', pauseReason: null })
    if (!next) throw new JobStateError(`Job ${id} is ${(await this.mustGet(id)).status}, not awaiting confirmation`)
    this.cancelRequested.delete(id)
    await this.store.audit('updates.job.confirm', id, { by: actor })
    this.drive(id, () => this.execute(id))
    return next
  }

  async resume(id: string, actor?: string): Promise<JobRecord> {
    await this.mustGet(id)
    const load = this.deps.loadPolicy()
    if (!load.loaded) throw new PolicyRequiredError(load.error)
    // Claim the job first: of two Resumes racing, exactly one gets past this line.
    const next = await this.transition(id, ['paused'], { status: 'running', pauseReason: null })
    if (!next) throw new JobStateError(`Job ${id} is ${(await this.mustGet(id)).status}, not paused`)
    this.cancelRequested.delete(id)
    // Resume retries what failed. Every step is written to be safe to run twice.
    for (const s of await this.store.getSteps(id)) {
      const retry = s.status === 'failed' || (s.status === 'skipped' && s.reason === AFTER_GUEST_FAILURE)
      if (retry) await this.setStep(s, { status: 'pending', reason: null })
    }
    await this.store.audit('updates.job.resume', id, { by: actor })
    this.drive(id, () => this.execute(id))
    return next
  }

  async cancel(id: string, actor?: string): Promise<JobRecord> {
    const job = await this.mustGet(id)
    if (TERMINAL.includes(job.status)) throw new JobStateError(`Job ${id} has already finished (${job.status})`)
    await this.store.audit('updates.job.cancel', id, { by: actor })
    if (job.status !== 'running') {
      const done = await this.finish(id, 'cancelled', 'Cancelled before it ran further', undefined, ['planned', 'awaiting-confirm', 'paused'])
      if (done) return done
      // Lost a race: it was confirmed or resumed meanwhile, so it is running now.
    }
    const now = await this.mustGet(id)
    if (TERMINAL.includes(now.status)) return now
    // Stops after the step in progress; a half-run apt is worse than a finished one.
    this.cancelRequested.add(id)
    return now
  }

  /** A one-node reboot job with the same gates as a run. */
  async rebootNode(node: string, actor?: string): Promise<JobRecord> {
    const load = this.deps.loadPolicy()
    const status = await this.exec.clusterStatus()
    if (!status.nodes.some(n => n.name === node)) throw new JobStateError(`No node named ${node}`)
    const isSelf = await this.isSelfNode(node, load.policy)
    const step = isSelf
      ? { seq: 1, target: node, action: 'self' as const, detail: `${DETAIL.selfReboot} — requested by hand, through a handoff` }
      : { seq: 1, target: node, action: 'node-reboot' as const, detail: `${DETAIL.rebootAuto} — requested by hand` }
    const plan: UpdatesPlan = { steps: [step], warnings: [] }
    const job = await this.store.createJob({ trigger: 'manual', status: 'running', plan })
    await this.store.audit('updates.node.reboot', job.id, { node, by: actor })
    await this.store.addSteps(job.id, [
      { seq: 1, target: 'cluster', action: 'preflight', detail: 'quorum, Ceph, HA' },
      { ...step, seq: 2, detail: step.detail + ' (forced)' },
    ])
    await this.emitJob(job)
    this.drive(job.id, async () => {
      const pre = await this.runStep(job.id, (await this.store.getSteps(job.id))[0], async () => {
        const g = await this.clusterGates(job.id, load.policy)
        return g.ok ? { status: 'ok', output: g.reason } : { status: 'failed', reason: g.reason }
      })
      if (pre.status !== 'ok') return void await this.finish(job.id, 'failed', `Preflight stopped the reboot: ${pre.reason}`)
      if (this.cancelRequested.has(job.id)) return this.cancelNow(job.id)
      await this.execute(job.id)
    })
    return job
  }

  /**
   * On API start: a job that was running is paused, never resumed on its own. A
   * handoff result is collected first when it can be (it usually cannot while
   * HyperProx is still locked; Resume collects it then).
   */
  async recoverAfterRestart(): Promise<void> {
    await this.seedRebootPending()
    const job = await this.store.activeJob()
    if (!job || job.status !== 'running') return
    const steps = await this.store.getSteps(job.id)
    if (!steps.some(x => x.action !== 'preflight' && x.action !== 'refresh')) {
      await this.finish(job.id, 'failed', 'HyperProx restarted before the plan was ready — nothing was changed; start a new run')
      return
    }
    for (const s of steps.filter(x => x.status === 'running')) {
      const at = handoffNodeOf(s.detail)
      if (s.action === 'self' && at) {
        // The handoff outlives the API: collect its result, never restart it.
        try {
          const r = await readHandoff(this.exec, at, job.id, s.id)
          if (r) await this.setStep(s, { status: r.ok ? 'ok' : 'failed', reason: r.ok ? null : r.message, output: r.message, endedAt: new Date(this.exec.now()) })
        } catch { /* collected on Resume */ }
        continue
      }
      // Anything else died with the API. Marked failed, so Resume retries it and a guest's failure still holds the node phase.
      await this.setStep(s, { status: 'failed', reason: INTERRUPTED, endedAt: new Date(this.exec.now()) })
    }
    await this.transition(job.id, ['running'], { status: 'paused', pauseReason: 'HyperProx restarted mid-job — check the last step, then press Resume' })
    this.log(`job ${job.id} paused after restart`)
  }

  // ===========================================================================
  //  Preparation: preflight, refresh, plan
  // ===========================================================================

  private async prepare(jobId: string, mode: 'run' | 'dry-run', trigger: 'manual' | 'schedule'): Promise<void> {
    const load = this.deps.loadPolicy()
    const policy = load.policy
    const policyNote = load.loaded ? undefined : `${load.error ?? 'No policy file'} — this plan uses the built-in safe defaults.`
    const [preStep] = await this.store.addSteps(jobId, [{ seq: 1, target: 'cluster', action: 'preflight', detail: 'quorum, Ceph health, HA, nodes reachable, free space, holds and pin' }])

    const box: { inv: InventoryResult | null } = { inv: null }
    const pre = await this.runStep(jobId, preStep, async () => {
      box.inv = await this.inventory(policy)
      const pf = await preflight(this.exec, policy, box.inv.facts, await this.ceph(jobId))
      // A node whose pending list or shell could not be read is not "reachable", whatever the gates say.
      const unread = box.inv.inventory.nodes.filter(n => n.error).map(n => `${n.node}: ${n.error}`)
      const g = unread.length ? { ok: false, reason: [pf.ok ? '' : pf.reason, ...unread].filter(Boolean).join('; ') } : pf
      return g.ok ? { status: 'ok', output: g.reason } : { status: 'failed', reason: g.reason }
    })

    if (mode === 'dry-run') {
      // A dry run reads what is already known and executes nothing — not even `apt update`.
      const inv = box.inv ?? await this.inventory(policy).catch(() => null)
      const plan = inv ? buildPlan(inv.inventory, policy, { selfVmid: this.selfVmid(inv, policy), policyNote }) : { steps: [], warnings: ['Inventory could not be read'] }
      await this.setJob(jobId, { plan })
      const verdict = pre.status === 'ok' ? 'preflight passed' : `preflight would stop the run: ${pre.reason}`
      await this.finish(jobId, 'done', undefined, {
        summary: `Dry run — ${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'} would run; ${verdict}. Nothing was executed.`,
        changed: [], skipped: [], rebootsPending: [...this.rebootPending],
      })
      return
    }

    if (pre.status !== 'ok') return void await this.finish(jobId, 'failed', `Preflight stopped the run before anything changed: ${pre.reason}`)
    if (this.cancelRequested.has(jobId)) return this.cancelNow(jobId)

    const [refresh] = await this.store.addSteps(jobId, [{ seq: 2, target: 'cluster', action: 'refresh', detail: 'apt update on every node and managed guest, then re-read' }])
    const ref = await this.runStep(jobId, refresh, async (log) => {
      const lines: string[] = []
      for (const n of box.inv!.inventory.nodes.filter(x => x.online)) {
        await this.exec.nodeAptRefresh(n.node)
        log(`${n.node}: apt update done`)
      }
      const listing = await this.guestMap()
      const managed = box.inv!.inventory.guests.filter(g => g.managed && guestPolicy(policy, g.vmid).apt)
      for (let i = 0; i < managed.length; i += policy.batchSize) {
        await Promise.all(managed.slice(i, i + policy.batchSize).map(async g => {
          const ref = listing.get(g.vmid)
          if (!ref) return
          const r = await this.exec.guestExec(ref, GUEST_REFRESH_SCRIPT, undefined, 10 * 60_000).catch(e => ({ code: -1, output: String(e.message), timedOut: false }))
          // A guest whose lists did not refresh is planned from the old ones, and says so.
          if (r.code !== 0) lines.push(`${g.vmid}: apt update failed (${tail(r.output, 200).trim()})`)
        }))
      }
      box.inv = await this.inventory(policy)
      return { status: 'ok', output: lines.join('\n') || 'all lists refreshed' }
    })
    if (ref.status !== 'ok') return void await this.finish(jobId, 'failed', `Refreshing package lists failed: ${ref.reason}`)
    if (this.cancelRequested.has(jobId)) return this.cancelNow(jobId)

    const plan = buildPlan(box.inv!.inventory, policy, { selfVmid: this.selfVmid(box.inv!, policy) })
    await this.store.addSteps(jobId, plan.steps.map(s => ({ ...s, seq: s.seq + PRE_STEPS })))
    if (trigger === 'manual') {
      await this.transition(jobId, ['running'], { plan, status: 'awaiting-confirm' })
      return
    }
    await this.setJob(jobId, { plan })
    await this.execute(jobId)
  }

  // ===========================================================================
  //  Execution
  // ===========================================================================

  private async execute(jobId: string): Promise<void> {
    const load = this.deps.loadPolicy()
    if (!load.loaded) return this.pause(jobId, `The policy file no longer loads: ${load.error}`)
    const policy = load.policy
    if (!this.runStartedAt.has(jobId)) this.runStartedAt.set(jobId, this.exec.now())
    const guests = await this.guestMap()

    // --- Guest phase, batch_size at a time -----------------------------------------
    const all = await this.store.getSteps(jobId)
    const guestSteps = all.filter(s => isGuestStep(s) && s.status === 'pending')
    const targets = [...new Set(guestSteps.map(s => s.target))]
    for (let i = 0; i < targets.length; i += policy.batchSize) {
      if (!await this.stillRunning(jobId)) return
      if (this.cancelRequested.has(jobId)) return this.cancelNow(jobId)
      const gate = await this.combine([quorumGate(this.exec), this.cephGateFor(jobId, policy)])
      if (!gate.ok) return this.pause(jobId, `Gate failed before the next guests: ${gate.reason}`)
      await Promise.all(targets.slice(i, i + policy.batchSize).map(t =>
        this.runGuest(jobId, t, guestSteps.filter(s => s.target === t), guests.get(Number(t)), policy)))
    }

    const failedGuests = [...new Set((await this.store.getSteps(jobId)).filter(s => isGuestStep(s) && s.status === 'failed').map(s => s.target))]
    if (failedGuests.length) {
      return this.pause(jobId, `Guest${failedGuests.length > 1 ? 's' : ''} ${failedGuests.join(', ')} failed. The Ceph and node phases do not start while a guest has failed: fix it (its snapshot is named in the step) and press Resume, or Cancel.`)
    }

    // --- Ceph, nodes, self: strictly one step at a time -------------------------------
    for (const step of (await this.store.getSteps(jobId)).filter(s => !isGuestStep(s))) {
      if (step.action === 'preflight' || step.action === 'refresh') continue
      if (!await this.stillRunning(jobId)) return
      // A failed step is never stepped over: only Resume (which resets it) gets past one.
      if (step.status === 'failed' && step.action !== 'kernel-cleanup') {
        return this.pause(jobId, `${step.action} on ${step.target} has failed (${step.reason ?? 'no reason recorded'}); press Resume to retry it`)
      }
      if (step.status !== 'pending' && step.status !== 'running') continue
      if (this.cancelRequested.has(jobId)) return this.cancelNow(jobId)

      // A self step that was mid-handoff when the API went away: collect, do not restart it.
      if (step.status === 'running' && step.action === 'self' && handoffNodeOf(step.detail)) {
        const out = await this.collectHandoff(jobId, step)
        if (out.status === 'failed') return this.stopOnFailure(jobId, step, out)
        continue
      }

      if (step.action !== 'kernel-cleanup' && !(step.action === 'node-reboot' && detailKey(step) === DETAIL.rebootManual)) {
        const gate = await this.clusterGates(jobId, policy)
        if (!gate.ok) return this.pause(jobId, `Gate failed before ${step.action} on ${step.target}: ${gate.reason}`)
      }

      const out = await this.runStep(jobId, step, log => this.dispatch(jobId, step, policy, log))
      if (out.status === 'failed') {
        if (step.action === 'kernel-cleanup') continue   // old kernels left behind are untidy, not unsafe
        return this.stopOnFailure(jobId, step, out)
      }
    }

    if (!await this.stillRunning(jobId)) return
    await this.finish(jobId, 'done', undefined, undefined, ['running'])
  }

  private async stopOnFailure(jobId: string, step: StepRecord, out: Outcome & { status: 'failed' }): Promise<void> {
    if (out.fatal) {
      await this.finish(jobId, 'failed', `${step.action} on ${step.target}: ${out.reason}`)
      return
    }
    await this.pause(jobId, `${step.action} on ${step.target} failed: ${out.reason}`)
  }

  private async runGuest(jobId: string, target: string, steps: StepRecord[], guest: GuestListing | undefined, policy: Policy): Promise<void> {
    let snapshot: string | null = null
    for (const step of steps.sort((a, b) => a.seq - b.seq)) {
      if (this.cancelRequested.has(jobId)) return
      if (!guest) { await this.setStep(step, { status: 'failed', reason: `guest ${target} is no longer in the cluster` }); return this.skipRest(steps, step) }
      const out = await this.runStep(jobId, step, async log => {
        switch (step.action) {
          case 'snapshot': {
            if (detailKey(step) === DETAIL.snapshotNone) return { status: 'skipped', reason: 'no snapshot possible: bind-mounted storage' }
            const name = `${SNAPSHOT_PREFIX}${new Date(this.exec.now()).toISOString().replace(/[-:T]/g, '').slice(0, 12)}`
            await this.exec.snapshot(guest, name)
            snapshot = name
            return { status: 'ok', output: `snapshot ${name}` }
          }
          case 'apt':    return this.guestApt(guest, policy, log, snapshot)
          case 'docker': {
            const r = await this.exec.guestExec(guest, guestDockerScript(guestPolicy(policy, guest.vmid).composeDirs), log, 30 * 60_000)
            return r.code === 0 ? { status: 'ok', output: tail(r.output) } : { status: 'failed', reason: `containers not healthy${snapshot ? ` (snapshot ${snapshot})` : ''}`, output: tail(r.output) }
          }
          case 'check': {
            const url = guestPolicy(policy, guest.vmid).check ?? step.detail ?? ''
            const r = await this.exec.guestExec(guest, guestCheckScript(url), log, 60_000)
            return r.code === 0 ? { status: 'ok', output: tail(r.output) } : { status: 'failed', reason: `check ${url} failed${snapshot ? ` (snapshot ${snapshot})` : ''}`, output: tail(r.output) }
          }
          default: return { status: 'failed', reason: `unexpected guest action ${step.action}` }
        }
      })
      if (out.status === 'failed') return this.skipRest(steps, step)
    }
    if (guest && snapshot) await this.pruneSnapshots(guest)
  }

  /** After a guest updated cleanly, keep only its newest hp-upd-* snapshot. Other snapshots are never touched. */
  private async pruneSnapshots(guest: GuestListing): Promise<void> {
    try {
      const ours = (await this.exec.listSnapshots(guest))
        .filter(s => s.name.startsWith(SNAPSHOT_PREFIX))
        .sort((a, b) => (b.snaptime ?? 0) - (a.snaptime ?? 0) || b.name.localeCompare(a.name))
      for (const old of ours.slice(1)) await this.exec.deleteSnapshot(guest, old.name)
    } catch (e: any) {
      this.log(`could not prune old snapshots of ${guest.vmid}: ${e.message}`)
    }
  }

  private async skipRest(steps: StepRecord[], failed: StepRecord): Promise<void> {
    for (const s of steps.filter(x => x.seq > failed.seq)) await this.setStep(s, { status: 'skipped', reason: AFTER_GUEST_FAILURE })
  }

  private async guestApt(guest: GuestListing, policy: Policy, log: LineSink, snapshot: string | null): Promise<Outcome> {
    const r = await this.exec.guestExec(guest, GUEST_UPGRADE_SCRIPT, log, 60 * 60_000)
    if (r.code !== 0) return { status: 'failed', reason: `apt failed${snapshot ? ` (snapshot ${snapshot})` : ''}`, output: tail(r.output) }
    const wantsReboot = /HP_REBOOT_REQUIRED/.test(r.output)
    if (!(guest.type === 'qemu' && wantsReboot && guestPolicy(policy, guest.vmid).reboot === 'if-required')) {
      return { status: 'ok', output: tail(r.output) + (wantsReboot ? '\n(reboot requested by the guest; policy does not reboot it)' : '') }
    }
    const reboot = await this.rebootGuest(guest, log)
    if (!reboot.ok) return { status: 'failed', reason: `upgraded, but the reboot failed: ${reboot.reason}`, output: tail(r.output) }
    return { status: 'ok', output: tail(r.output) + '\nrebooted: ' + reboot.reason }
  }

  /** HA-managed guests go through ha-manager, never qm/pct: the HA stack owns their state. */
  private async rebootGuest(guest: GuestListing, log: LineSink): Promise<GateResult> {
    const ha = (await this.exec.haResources()).includes(`vm:${guest.vmid}`)
    if (ha) {
      const sid = `vm:${guest.vmid}`
      await this.mustExec(guest.node, haSetState(sid, 'stopped'), log)
      if (!await this.waitFor(async () => (await this.exec.haStatus()).services.some(s => s.sid === sid && s.state === 'stopped'), this.timing.guestBootMs)) {
        // Never leave the HA desired state at "stopped" behind us.
        const back = await this.exec.nodeExec(guest.node, haSetState(sid, 'started'), log, 120_000).catch((e: any) => ({ code: -1, output: e.message, timedOut: false }))
        return { ok: false, reason: `${sid} did not stop in time; ${back.code === 0 ? 'its HA state was set back to started' : 'setting its HA state back to started ALSO failed — set it by hand'}` }
      }
      await this.mustExec(guest.node, haSetState(sid, 'started'), log)
    } else {
      await this.mustExec(guest.node, guestRebootCommand(guest.type, guest.vmid), log)
    }
    const back = await this.waitFor(async () => (await this.exec.guestExec(guest, 'true', undefined, 30_000).catch(() => ({ code: 1 }))).code === 0, this.timing.guestBootMs)
    return back ? { ok: true, reason: ha ? 'through ha-manager' : 'guest agent answering again' } : { ok: false, reason: 'the guest agent did not answer after the reboot' }
  }

  private async dispatch(jobId: string, step: StepRecord, policy: Policy, log: LineSink): Promise<Outcome> {
    switch (step.action) {
      case 'ceph':           return this.cephStep(step, policy, log)
      case 'node-upgrade':   return this.nodeUpgrade(step.target, policy, log)
      case 'node-reboot':    return this.nodeReboot(jobId, step, policy, log)
      case 'kernel-cleanup': return this.kernelCleanup(step.target, log)
      case 'self':           return this.selfStep(jobId, step, policy, log)
      default:               return { status: 'failed', reason: `unexpected action ${step.action}` }
    }
  }

  // --- Ceph ---------------------------------------------------------------------------

  private async cephStep(step: StepRecord, policy: Policy, log: LineSink): Promise<Outcome> {
    const [verb, arg] = (step.detail ?? '').split(/\s+/)
    if (verb === DETAIL.cephInstall) {
      const pending = (await this.exec.nodeAptPending(step.target)).filter(p => isCephPackage(p.name))
      if (!pending.length) return { status: 'skipped', reason: 'no Ceph packages pending any more' }
      const odd = pending.filter(p => p.to !== arg)
      if (odd.length) return { status: 'failed', reason: `${step.target} would install ${odd.map(p => `${p.name} ${p.to}`).join(', ')}, not ${arg}` }
      const r = await this.exec.nodeExec(step.target, cephInstallCommand(pending), log, 30 * 60_000)
      return r.code === 0 ? { status: 'ok', output: tail(r.output) } : { status: 'failed', reason: 'Ceph package install failed', output: tail(r.output) }
    }
    if (verb === DETAIL.cephRestart && ['mon', 'mgr', 'osd'].includes(arg)) {
      const daemon = arg as 'mon' | 'mgr' | 'osd'
      const peer = await this.peerOf(step.target)
      if (daemon === 'osd') await this.mustExec(peer, CEPH_NOOUT_SET, log)
      const r = await this.exec.nodeExec(step.target, cephRestartCommand(daemon), log, 10 * 60_000)
      if (r.code !== 0) return { status: 'failed', reason: `restarting ceph-${daemon} failed${daemon === 'osd' ? '; noout left set' : ''}`, output: tail(r.output) }
      let last = ''
      const healthy = await this.waitFor(async () => {
        const h = await this.exec.cephHealth()
        const accepted = [...policy.acceptedWarnings, ...(daemon === 'osd' ? ['OSDMAP_FLAGS'] : [])]
        const a = judgeCeph(h, accepted), b = judgeCephSettled(h)
        last = a.ok ? b.reason : a.reason
        return a.ok && b.ok
      }, this.timing.cephSettleMs)
      if (!healthy) return { status: 'failed', reason: `Ceph did not settle after restarting ceph-${daemon} on ${step.target}: ${last}${daemon === 'osd' ? '; noout left set' : ''}` }
      if (daemon === 'osd') await this.mustExec(peer, CEPH_NOOUT_UNSET, log)
      return { status: 'ok', output: tail(r.output) + `\nCeph settled: ${last}` }
    }
    return { status: 'failed', reason: `unknown Ceph step "${step.detail}"` }
  }

  // --- Nodes ---------------------------------------------------------------------------

  private async nodeFacts(node: string): Promise<NodeFacts> {
    const r = await this.exec.nodeExec(node, NODE_FACTS_COMMAND, undefined, 60_000)
    return parseNodeFacts(r.output)
  }

  private async nodeUpgrade(node: string, policy: Policy, log: LineSink): Promise<Outcome> {
    // The node's policy, read now, decides upgrade vs dist-upgrade — never the stored plan.
    const pol = nodePolicy(policy, node)
    const before = await this.nodeFacts(node)
    const pre = await this.combine([Promise.resolve(holdsPinGate(node, before, pol)), Promise.resolve(freeSpaceGate(node, before, policy))])
    if (!pre.ok) return { status: 'failed', reason: `stopped before installing: ${pre.reason}` }

    const r = await this.exec.nodeExec(node, nodeUpgradeCommand(pol.upgrade), log, 60 * 60_000)
    if (r.code !== 0) return { status: 'failed', reason: `apt-get ${pol.upgrade} failed`, output: tail(r.output) }

    const svc = await this.exec.nodeExec(node, NODE_SERVICES_COMMAND, log, 60_000)
    if (svc.code !== 0) return { status: 'failed', reason: 'Proxmox services not all active after the upgrade', output: tail(r.output + '\n' + svc.output) }

    const after = holdsPinGate(node, await this.nodeFacts(node), pol)
    if (!after.ok) return { status: 'failed', reason: `after the upgrade: ${after.reason} — not repaired; a person must look`, output: tail(r.output) }
    return { status: 'ok', output: tail(r.output) }
  }

  private rebootNeeded(f: NodeFacts): boolean {
    if (f.rebootRequired) return true
    if (!f.runningKernel) return false
    const boots = f.pinned ?? newestKernel(f)
    return Boolean(boots && boots !== f.runningKernel)
  }

  /**
   * Wait out viewers. Re-checks every streamRecheckMs until window_hours from the
   * run's start; then the reboot is skipped and left pending — never forced.
   */
  private async waitForQuiet(jobId: string, policy: Policy, log: LineSink): Promise<GateResult> {
    const windowEnd = (this.runStartedAt.get(jobId) ?? this.exec.now()) + policy.schedule.windowHours * 3_600_000
    for (;;) {
      const g = await streamGate(this.exec, policy)
      if (g.ok) return g
      if (this.exec.now() + this.timing.streamRecheckMs > windowEnd) return { ok: false, reason: `${g.reason} until the ${policy.schedule.windowHours} h window closed` }
      log(`${g.reason} — re-checking in ${Math.round(this.timing.streamRecheckMs / 60_000)} min`)
      await this.exec.sleep(this.timing.streamRecheckMs)
      if (this.cancelRequested.has(jobId)) return { ok: false, reason: 'cancelled while waiting for streams to end' }
    }
  }

  private async nodeReboot(jobId: string, step: StepRecord, policy: Policy, log: LineSink): Promise<Outcome> {
    const node = step.target
    const forced = /\(forced\)$/.test(step.detail ?? '')
    if (detailKey(step) === DETAIL.rebootManual) {
      this.rebootPending.add(node)
      return { status: 'skipped', reason: 'reboot: manual — reboot pending' }
    }
    const resumed = Boolean(step.startedAt)   // a previous attempt began; flags may be set
    const ceph = await this.ceph(jobId)
    const peer = await this.peerOf(node)

    if (!forced && !this.rebootNeeded(await this.nodeFacts(node))) {
      if (resumed) await this.clearFlags(peer, node, ceph, log)
      this.rebootPending.delete(node)
      return { status: 'skipped', reason: 'no reboot needed' }
    }
    const quiet = await this.waitForQuiet(jobId, policy, log)
    if (!quiet.ok) {
      this.rebootPending.add(node)
      return { status: 'skipped', reason: `${quiet.reason} — reboot pending` }
    }
    // The wait can be hours; the cluster that passed the gates before it is not the cluster now.
    const again = await this.clusterGates(jobId, policy)
    if (!again.ok) return { status: 'failed', reason: `after waiting for viewers: ${again.reason}` }

    const bootBefore = await this.bootId(node)
    await this.setFlags(peer, node, ceph, log)
    const drained = await this.waitFor(async () =>
      !(await this.exec.haStatus()).services.some(s => s.node === node && !['stopped', 'disabled', 'ignored'].includes(s.state)),
      this.timing.haDrainMs)
    if (!drained) {
      // The node never went down, so nothing is at risk from undoing the flags.
      await this.clearFlags(peer, node, ceph, log)
      return { status: 'failed', reason: `HA could not move every guest off ${node}; maintenance${ceph ? ' and noout' : ''} cleared, node not rebooted` }
    }

    log(`rebooting ${node}`)
    let sent: { code: number; output: string; timedOut: boolean } | null = null
    try { sent = await this.exec.nodeExec(node, NODE_REBOOT_COMMAND, log, 30_000) }
    catch { /* the connection drops as the node goes down; that is the point */ }
    if (sent && sent.code > 0 && !sent.timedOut) {
      await this.clearFlags(peer, node, ceph, log)
      return { status: 'failed', reason: `${node} refused the reboot (${tail(sent.output, 200).trim()}); maintenance${ceph ? ' and noout' : ''} cleared`, output: sent.output }
    }

    const deadline = this.exec.now() + this.timing.nodeReturnMs
    await this.exec.sleep(this.timing.rebootSettleMs)
    let last = 'not back yet'
    let upButSameBoot = false
    let back = false
    while (this.exec.now() < deadline) {
      // Only the latest poll counts: a node seen up on its old boot (still shutting down) that then goes
      // down and stays down is "did not come back", never "up the whole time".
      upButSameBoot = false
      try {
        const s = await this.exec.clusterStatus()
        const n = s.nodes.find(x => x.name === node)
        if (!s.quorate) last = 'cluster not quorate'
        else if (!n?.online) last = `${node} not online`
        else if ((await this.bootId(node)) === bootBefore) { last = `${node} has the same boot id: it has not rebooted`; upButSameBoot = true }
        else {
          const c = ceph ? judgeCephSettled(await this.exec.cephHealth()) : { ok: true, reason: 'no Ceph' }
          last = c.reason
          if (c.ok) { back = true; break }
        }
      } catch (e: any) { last = e.message }
      await this.exec.sleep(this.timing.pollMs)
    }
    if (back) {
      // Outside the poll loop: a flag that will not clear is its own failure, not "still waiting".
      this.rebootPending.delete(node)
      await this.clearFlags(peer, node, ceph, log)
      return { status: 'ok', output: `${node} rebooted (new boot id) and back; ${last}; maintenance off${ceph ? ', noout cleared' : ''}` }
    }
    this.rebootPending.add(node)
    if (upButSameBoot) {
      // Up the whole time: nothing is at risk, so the flags come off, but the step did not do its job.
      await this.clearFlags(peer, node, ceph, log)
      return { status: 'failed', reason: `${node} never rebooted (its boot id did not change); maintenance${ceph ? ' and noout' : ''} cleared` }
    }
    return {
      status: 'failed', fatal: true,
      reason: `${node} did not come back within ${Math.round(this.timing.nodeReturnMs / 60_000)} min (${last}). ${ceph ? 'noout and ' : ''}HA maintenance ${ceph ? 'are' : 'is'} LEFT ON so data does not move; clear them by hand once the node is healthy.`,
    }
  }

  private async bootId(node: string): Promise<string> {
    const r = await this.exec.nodeExec(node, BOOT_ID, undefined, 20_000)
    const id = r.output.trim()
    if (r.code !== 0 || !/^[0-9a-f-]{36}$/.test(id)) throw new Error(`could not read ${node}'s boot id`)
    return id
  }

  /** noout, then HA maintenance. If maintenance cannot be turned on, noout comes back off before failing. */
  private async setFlags(peer: string, node: string, ceph: boolean, log: LineSink): Promise<void> {
    if (ceph) await this.mustExec(peer, CEPH_NOOUT_SET, log)
    try { await this.mustExec(peer, haMaintenance(node, true), log) }
    catch (e: any) {
      if (!ceph) throw e
      const undo = await this.exec.nodeExec(peer, CEPH_NOOUT_UNSET, log, 120_000).catch(() => ({ code: -1 }))
      throw new Error(`${e.message}; ${undo.code === 0 ? 'noout cleared again' : 'noout is LEFT ON — clear it by hand'}`)
    }
  }

  /** Both flags off, each tried even if the other fails; any left on is named in the error. */
  private async clearFlags(peer: string, node: string, ceph: boolean, log: LineSink): Promise<void> {
    const left: string[] = []
    try { await this.mustExec(peer, haMaintenance(node, false), log) } catch { left.push(`HA maintenance on ${node}`) }
    if (ceph) { try { await this.mustExec(peer, CEPH_NOOUT_UNSET, log) } catch { left.push('Ceph noout') } }
    if (left.length) throw new Error(`could not clear ${left.join(' and ')} — LEFT ON, clear by hand`)
  }

  private async kernelCleanup(node: string, log: LineSink): Promise<Outcome> {
    const facts = await this.nodeFacts(node)
    const remove = kernelsToRemove(facts)
    const r = await this.exec.nodeExec(node, kernelPurgeCommand(remove), log, 20 * 60_000)
    return r.code === 0
      ? { status: 'ok', output: remove.length ? `removed ${remove.join(', ')}` : 'no old kernels to remove' }
      : { status: 'failed', reason: 'kernel cleanup refused or failed', output: tail(r.output) }
  }

  // --- HyperProx itself -----------------------------------------------------------------

  private async selfStep(jobId: string, step: StepRecord, policy: Policy, log: LineSink): Promise<Outcome> {
    if (detailKey(step) === DETAIL.selfGuest) {
      const guest = (await this.guestMap()).get(Number(step.target))
      if (!guest) return { status: 'failed', reason: `guest ${step.target} not found` }
      // Tag first: a restart between the two finds the handoff instead of starting a second one.
      await this.setStep(step, { detail: `${step.detail} · ${handoffTag(guest.node)}` })
      await startHandoff(this.exec, guest.node, jobId, step.id, selfGuestScript(jobId, step.id, guest))
      log(`handoff started on ${guest.node}`)
      const out = await this.pollHandoff(jobId, step, guest.node)
      if (out.status === 'ok') await this.pruneSnapshots(guest)
      return out
    }
    if (detailKey(step) === DETAIL.selfReboot) {
      const node = step.target
      const forced = /\(forced\)$/.test(step.detail ?? '')
      if (!forced && !this.rebootNeeded(await this.nodeFacts(node))) return { status: 'skipped', reason: 'no reboot needed' }
      const quiet = await this.waitForQuiet(jobId, policy, log)
      if (!quiet.ok) { this.rebootPending.add(node); return { status: 'skipped', reason: `${quiet.reason} — reboot pending` } }
      const again = await this.clusterGates(jobId, policy)
      if (!again.ok) return { status: 'failed', reason: `after waiting for viewers: ${again.reason}` }
      const peer = await this.peerOf(node)
      const ceph = await this.ceph(jobId)
      await this.setStep(step, { detail: `${step.detail} · ${handoffTag(peer)}` })
      await startHandoff(this.exec, peer, jobId, step.id, selfNodeRebootScript(jobId, step.id, node, { ceph, waitMinutes: Math.round(this.timing.nodeReturnMs / 60_000) }))
      log(`handoff started on ${peer}; HyperProx may go away while ${node} reboots`)
      const out = await this.pollHandoff(jobId, step, peer)
      if (out.status === 'ok') this.rebootPending.delete(node)
      return out.status === 'failed' ? { ...out, fatal: true } : out
    }
    return { status: 'failed', reason: `unknown self step "${step.detail}"` }
  }

  private async pollHandoff(jobId: string, step: StepRecord, node: string): Promise<Outcome> {
    const deadline = this.exec.now() + this.timing.handoffMaxMs
    while (this.exec.now() < deadline) {
      try {
        const r = await readHandoff(this.exec, node, jobId, step.id)
        if (r) return r.ok ? { status: 'ok', output: r.message } : { status: 'failed', reason: r.message }
      } catch (e: any) {
        if (/stopped without writing/.test(e.message)) return { status: 'failed', reason: e.message }
      }
      await this.exec.sleep(this.timing.handoffPollMs)
    }
    return { status: 'failed', reason: `no handoff result from ${node} within ${Math.round(this.timing.handoffMaxMs / 60_000)} min` }
  }

  private async collectHandoff(jobId: string, step: StepRecord): Promise<Outcome> {
    const node = handoffNodeOf(step.detail)!
    const out = await this.pollHandoff(jobId, step, node)
    const fatal = out.status === 'failed' && detailKey(step) === DETAIL.selfReboot
    await this.setStep(step, {
      status: out.status, reason: out.status === 'ok' ? null : (out.reason ?? null), output: out.output ?? out.reason ?? null,
      endedAt: new Date(this.exec.now()),
    })
    if (out.status === 'ok' && detailKey(step) === DETAIL.selfReboot) this.rebootPending.delete(step.target)
    if (out.status === 'ok' && detailKey(step) === DETAIL.selfGuest) {
      const guest = (await this.guestMap()).get(Number(step.target))
      if (guest) await this.pruneSnapshots(guest)
    }
    return out.status === 'failed' ? { ...out, fatal } : out
  }

  // ===========================================================================
  //  Plumbing
  // ===========================================================================

  private drive(jobId: string, fn: () => Promise<void>): void {
    this.driving = this.driving.then(async () => {
      try { await fn() }
      catch (e: any) {
        this.log(`job ${jobId}: ${e?.stack ?? e}`)
        const job = await this.store.getJob(jobId).catch(() => null)
        if (job && job.status === 'running') await this.pause(jobId, `Internal error: ${e?.message ?? e}`).catch(() => {})
      }
    })
  }

  private async runStep(jobId: string, step: StepRecord, fn: (log: LineSink) => Promise<Outcome>): Promise<Outcome> {
    let buffer = ''
    const log: LineSink = (line) => {
      buffer += line + '\n'
      if (buffer.length > 20_000) buffer = buffer.slice(-8000)
      this.deps.emit?.({ kind: 'log', jobId, stepId: step.id, line })
    }
    const started = await this.setStep(step, { status: 'running', reason: null, startedAt: step.startedAt ?? new Date(this.exec.now()), endedAt: null })
    step.startedAt = started.startedAt
    let out: Outcome
    try { out = await fn(log) }
    catch (e: any) { out = { status: 'failed', reason: e?.message ?? String(e) } }
    const output = tail([buffer.trim(), out.output ?? ''].filter(Boolean).join('\n'))
    await this.setStep(step, {
      status: out.status, reason: out.status === 'ok' ? null : (out.reason ?? null),
      output: output || null, endedAt: new Date(this.exec.now()),
    })
    return out
  }

  private async setStep(step: StepRecord, patch: Partial<Omit<StepRecord, 'id' | 'jobId'>>): Promise<StepRecord> {
    const s = await this.store.updateStep(step.id, patch)
    Object.assign(step, s)
    this.deps.emit?.({ kind: 'step', jobId: s.jobId, step: stepView(s) })
    return s
  }

  private async setJob(id: string, patch: Partial<Omit<JobRecord, 'id'>>): Promise<JobRecord> {
    const j = await this.store.updateJob(id, patch)
    await this.emitJob(j)
    return j
  }

  private async emitJob(j: JobRecord): Promise<void> {
    const { steps: _omit, ...job } = jobView(j)
    this.deps.emit?.({ kind: 'job', job })
  }

  /** Conditional status change, broadcast when it happened. */
  private async transition(id: string, from: UpdatesJobStatus[], patch: Partial<Omit<JobRecord, 'id'>>): Promise<JobRecord | null> {
    const j = await this.store.transitionJob(id, from, patch)
    if (j) await this.emitJob(j)
    return j
  }

  /** Re-read before every step: a job someone cancelled, or that another path paused, stops here. */
  private async stillRunning(jobId: string): Promise<boolean> {
    return (await this.store.getJob(jobId))?.status === 'running'
  }

  private async pause(jobId: string, reason: string): Promise<void> {
    if (!await this.transition(jobId, ['running'], { status: 'paused', pauseReason: reason })) return
    await this.store.audit('updates.job.paused', jobId, { reason })
    await this.sendReport(jobId, `HyperProx updates paused: ${reason}`)
  }

  private async cancelNow(jobId: string): Promise<void> {
    await this.finish(jobId, 'cancelled', 'Cancelled')
  }

  /** Null when the job was no longer in one of `from` (someone else finished or moved it first). */
  private async finish(jobId: string, status: 'done' | 'failed' | 'cancelled', reason?: string, report?: UpdatesReport,
                       from: UpdatesJobStatus[] = NOT_FINISHED): Promise<JobRecord | null> {
    const claimed = await this.store.transitionJob(jobId, from, { status, finishedAt: new Date(this.exec.now()), pauseReason: status === 'done' ? null : (reason ?? null) })
    if (!claimed) return null
    this.cancelRequested.delete(jobId)
    for (const s of await this.store.getSteps(jobId)) {
      if (s.status === 'pending') await this.setStep(s, { status: 'skipped', reason: status === 'cancelled' ? 'cancelled' : 'the run stopped before this step' })
    }
    const rep = report ?? await this.buildReport(jobId, status, reason)
    const job = await this.setJob(jobId, { report: rep })
    await this.store.releaseLock(jobId)
    this.runStartedAt.delete(jobId)
    this.cephKnown.delete(jobId)
    await this.sendReport(jobId, rep.summary)
    return job
  }

  private async buildReport(jobId: string, status: string, reason?: string): Promise<UpdatesReport> {
    const steps = await this.store.getSteps(jobId)
    const changed = new Map<string, number>()
    for (const s of steps.filter(x => x.status === 'ok' && ['apt', 'node-upgrade', 'self', 'ceph'].includes(x.action))) {
      const n = Number(/\((\d+) package/.exec(s.detail ?? '')?.[1] ?? 0)
      if (s.action === 'self' && detailKey(s) !== DETAIL.selfGuest) continue
      changed.set(s.target, (changed.get(s.target) ?? 0) + n)
    }
    const skipped = steps.filter(s => s.status === 'skipped' && s.reason).map(s => ({ target: s.target, reason: `${s.action}: ${s.reason}` }))
    const count = (st: string) => steps.filter(s => s.status === st).length
    const pending = [...this.rebootPending].sort()
    const head = status === 'done' ? 'Updates finished' : status === 'cancelled' ? 'Updates cancelled' : 'Updates failed'
    return {
      summary: `${head}: ${count('ok')} ok, ${count('skipped')} skipped, ${count('failed')} failed.` +
        (reason && status !== 'done' ? ` ${reason}.` : '') +
        (pending.length ? ` Reboot pending: ${pending.join(', ')}.` : ''),
      changed: [...changed].map(([target, packages]) => ({ target, packages })),
      skipped,
      rebootsPending: pending,
    }
  }

  private async sendReport(jobId: string, text: string): Promise<void> {
    const url = this.deps.loadPolicy().policy.webhookUrl
    if (!url) return
    try { await (this.deps.notify ?? defaultNotify)(url, `${text}\nJob ${jobId} — details on the Updates page.`) }
    catch (e: any) { this.log(`report webhook failed: ${e.message}`) }
  }

  private async ceph(jobId: string): Promise<boolean> {
    const known = this.cephKnown.get(jobId)
    if (known !== undefined) return known
    const present = await this.exec.cephPresent()
    this.cephKnown.set(jobId, present)
    return present
  }

  private async cephGateFor(jobId: string, policy: Policy): Promise<GateResult> {
    try { return await cephGate(this.exec, policy, await this.ceph(jobId)) }
    catch (e: any) { return { ok: false, reason: `could not tell whether Ceph is configured: ${e.message}` } }
  }

  /** Quorum, Ceph and HA: what must hold before anything that can take a machine down. */
  private clusterGates(jobId: string, policy: Policy): Promise<GateResult> {
    return this.combine([quorumGate(this.exec), this.cephGateFor(jobId, policy), haGate(this.exec)])
  }

  private async combine(gates: Promise<GateResult>[]): Promise<GateResult> {
    const all = await Promise.all(gates)
    const bad = all.filter(g => !g.ok)
    return bad.length ? { ok: false, reason: bad.map(g => g.reason).join('; ') } : { ok: true, reason: all.map(g => g.reason).join('; ') }
  }

  private async waitFor(cond: () => Promise<boolean>, maxMs: number): Promise<boolean> {
    const deadline = this.exec.now() + maxMs
    for (;;) {
      try { if (await cond()) return true } catch { /* keep waiting */ }
      if (this.exec.now() >= deadline) return false
      await this.exec.sleep(this.timing.pollMs)
    }
  }

  private async mustExec(node: string, command: string, log: LineSink): Promise<void> {
    log(`${node}$ ${command}`)
    const r = await this.exec.nodeExec(node, command, log, 120_000)
    if (r.code !== 0) throw new Error(`"${command}" on ${node} failed: ${tail(r.output, 300).trim()}`)
  }

  /** Another online node, to run cluster commands from while `node` is down. */
  private async peerOf(node: string): Promise<string> {
    const s = await this.exec.clusterStatus()
    const peer = s.nodes.filter(n => n.online && n.name !== node).map(n => n.name).sort()[0]
    if (!peer) throw new Error(`no other online node to coordinate ${node}'s reboot from`)
    return peer
  }

  private async guestMap(): Promise<Map<number, GuestListing>> {
    return new Map((await this.exec.listGuests()).map(g => [g.vmid, g]))
  }

  private async inventory(policy: Policy): Promise<InventoryResult> {
    const r = await readInventory(this.exec, policy, { rebootPending: this.rebootPending, hostname: this.deps.hostname })
    this.deps.onInventory?.(r)
    return r
  }

  private selfVmid(inv: InventoryResult, policy: Policy): number | null {
    return selfVmidOf(inv.inventory, policy, this.deps.hostname)
  }

  private async isSelfNode(node: string, policy: Policy): Promise<boolean> {
    return findSelfGuest(await this.exec.listGuests(), policy, this.deps.hostname)?.node === node
  }

  private async seedRebootPending(): Promise<void> {
    const last = (await this.store.listJobs(10)).find(j => TERMINAL.includes(j.status) && j.trigger !== 'dry-run' && j.report)
    for (const n of last?.report?.rebootsPending ?? []) this.rebootPending.add(n)
  }

  private async mustGet(id: string): Promise<JobRecord> {
    const j = await this.store.getJob(id)
    if (!j) throw new JobStateError(`No job ${id}`)
    return j
  }

  private log(msg: string) { this.deps.log?.(`[updates] ${msg}`) }
}

function newestKernel(f: NodeFacts): string | null {
  const versions = f.kernelPackages.map(p => p.replace(/^(proxmox|pve)-kernel-/, '').replace(/-signed$/, ''))
  const cmp = (a: string, b: string) => {
    const pa = a.split(/[.-]/).map(Number), pb = b.split(/[.-]/).map(Number)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d }
    return 0
  }
  return versions.sort(cmp).at(-1) ?? null
}
