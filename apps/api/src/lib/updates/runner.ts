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

import type { UpdatesClusterRef, UpdatesItemOutcome, UpdatesPlan, UpdatesPlanItem, UpdatesRebootPreview, UpdatesRebootResult, UpdatesRebootRun, UpdatesReport, UpdatesStepAction, UpdatesWsPayload } from './types'
import type { UpdatesExecutor, GuestListing, LineSink } from './executor'
import { parseOsdOkToStop, parseCephState, parseOsdFlags, judgeRestoredState, type CephState } from './ceph-safety'
import { prepareAptCache, type AptCacheHook } from './apt-cache'
import { SAFETY_SKIP, osdVerdict, osdNames, monVerdict, annotatePlanSafety, withoutSafetyNote } from './ceph-checks'
import { type PolicyLoad, type Policy, guestPolicy, nodePolicy, effectiveUpgrade } from './policy'
import { shortReason } from '../redact-addresses'
import { readInventory, findSelfGuest, selfVmidOf, type InventoryResult } from './inventory'
import { buildPlan, detailKey, DETAIL, orderNodes } from './planner'
import { guestPolicyRefusal, nodePolicyRefusal, immovableReason, inPlaceAllowed, newestKernel, nodeRebootNeeded, parseQuorumTool, QUORUM_VOTES_COMMAND, rebootQuorumGate, SELF_GUEST_WORDS, type HaRule, type QuorumVotes } from './reboots'
import {
  preflight, quorumGate, cephGate, haGate, holdsPinGate, freeSpaceGate, streamGate, judgeCeph, judgeCephSettled,
  unknownPolicyNodes, quorumHaGates, type GateResult,
} from './gates'
import {
  GUEST_REFRESH_SCRIPT, GUEST_UPGRADE_SCRIPT, NODE_FACTS_COMMAND, NODE_SERVICES_COMMAND, NODE_REBOOT_COMMAND,
  CEPH_NOOUT_SET, CEPH_NOOUT_UNSET, cephInstallCommand, cephRestartCommand, cephOsdRestartCommand,
  CEPH_STATE_COMMAND, CEPH_OSD_DUMP_COMMAND, cephOsdOkToStopCommand, guestCheckScript, guestDockerScript,
  guestRebootCommand, haMaintenance, haSetState, isCephPackage, kernelPurgeCommand, kernelsToRemove, nodeUpgradeCommand,
  nodeSimulateCommand, parseAptSimulation, REMOTE_NODE_SERVICES_COMMAND, GUEST_PENDING_SCRIPT, parseGuestPending,
  installedVersionsCommand, parseInstalledVersions, readBackProblems,
  parseNodeFacts, tail, type NodeFacts,
  nodePackagesCommand, nodePackagesSimulateCommand, guestPackagesScript, isGuardedKernelPackage, PKG_NAME,
  COMPOSE_LS_SCRIPT, parseComposeLs, composeProjectScript, GUEST_REBOOT_REQUIRED_SCRIPT,
} from './commands'
import { hasIgnoreTag } from '../guest-guard'
import { homeGuards } from './guards'
import { LOOK_INSIDE_WORDS, lookInsideList, lookInsideReason } from './look-inside'
import {
  buildSelectedPlan, parseTargetId, packagesOf, composeKeyOf, DEPENDS_ON, MAX_SELECTION, nodeGuarded, type GuardContext,
} from './targets'
import { handoffNodeOf, handoffTag, readHandoff, selfGuestScript, selfNodeRebootScript, startHandoff } from './handoff'
import { type AppEnv, APPROVAL_ID, runAppStep } from './apps'
import { ActiveJobError, TERMINAL, jobView, stepView, type JobRecord, type StepRecord, type UpdatesStore } from './store'
import type { UpdatesJobStatus } from './types'
import type { NotifyEventInput, Severity } from '../notify/types'
import { auditBy } from '../http/request-actor'

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
  /** Automatic reboots: how often viewers are asked again while a reboot waits for them. */
  rebootStreamRecheckMs?: number
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
  rebootStreamRecheckMs: 10 * 60_000,
}

/** What a manual run of chosen targets may carry: the plan hash it was confirmed against, and what to do once it runs. */
export interface StartOptions {
  planHash?: string
  /** Called once, when the run actually starts running (confirmed, or its plan matched): never for a plan that is cancelled or expires. */
  onRunning?: (jobId: string) => Promise<void> | void
}

export interface RunnerDeps {
  store:      UpdatesStore
  exec:       UpdatesExecutor
  loadPolicy: () => PolicyLoad
  emit?:      (payload: UpdatesWsPayload) => void
  /** Called with every inventory the runner reads, so the API's cache stays current. */
  onInventory?: (r: InventoryResult) => void
  /** Called once after a job reaches done, failed or cancelled and its lock is released. */
  onJobFinished?: () => void
  /** The notification bus (lib/notify). Without it, nothing is announced. */
  publish?:   (e: NotifyEventInput) => Promise<void>
  log?:       (msg: string, level?: 'warn' | 'error') => void
  hostname?:  string
  timing?:    Partial<RunnerTiming>
  /** App-update providers. Without it, no app is looked for or planned. */
  apps?:      AppEnv
  /** The cluster this runner works on. Default: the home cluster. */
  cluster?:   UpdatesClusterRef
  /**
   * A remote cluster: previews come from apt's simulation, no HyperProx self-detection, no Ceph phase, every
   * upgrade is read back, nodes are never rebooted automatically, and a one-node server skips quorum and HA
   * (saying so). Home leaves this unset and behaves exactly as before.
   */
  remote?:    boolean
  /**
   * Throws when a stored job may not be acted on any more: it was planned for another connection to this
   * cluster (the address, certificate or token changed since). lib/updates/cluster-store.ts provides it.
   */
  checkJob?:  (job: JobRecord) => void
  /**
   * Read compose projects as projects (name and files) where the policy turns docker on, so each can be chosen on its
   * own (production, home and remote). Every other guest is looked at only when a person asks for it (inventory `discover`).
   */
  discoverCompose?: boolean
  /**
   * What the plug-ins say about guests (lib/updates/guards.ts): compose projects a plug-in's page manages, guests a
   * plug-in's long job is busy in. Home only. Default: read live (homeGuards).
   */
  guards?: () => Promise<GuardContext>
  /**
   * The package cache (lib/updates/apt-cache.ts): asked just before apt runs on a guest, or on a node when the
   * cluster's setting turns nodes on. Never fails a step. Without it, apt runs exactly as before.
   */
  aptCache?: AptCacheHook
}

type Outcome =
  | { status: 'ok' | 'skipped'; reason?: string; output?: string }
  | { status: 'failed'; reason: string; output?: string; fatal?: boolean }

/** Steps that belong to the guest phase. */
const GUEST_ACTIONS: UpdatesStepAction[] = ['snapshot', 'apt', 'apt-packages', 'docker', 'app-config', 'app', 'check']
const isGuestStep = (s: StepRecord) => GUEST_ACTIONS.includes(s.action)
const PRE_STEPS = 2   // preflight, refresh

const AFTER_GUEST_FAILURE = 'an earlier step for this guest failed'
/** A chosen item stopped at a failed step: the rest of that item is not run. */
const AFTER_ITEM_FAILURE = 'an earlier step of this item failed'
/** A vzdump was running where the item would act: the item is left alone, and Resume tries it again. */
const BACKUP_RUNNING = 'not run: a backup is running'
/** Node steps whose failure, in a run of chosen targets, stops only their own item and the items that wait for it. */
const ISOLATED_NODE_ACTIONS: UpdatesStepAction[] = ['node-upgrade', 'node-packages', 'kernel-cleanup']
const retryable = (r: string | null | undefined) => !!r && (r === AFTER_GUEST_FAILURE || r === AFTER_ITEM_FAILURE || r.startsWith(DEPENDS_ON) || r.startsWith(BACKUP_RUNNING))
const STALE_NOOUT = 'Ceph noout is set — left by an earlier run that stopped (a failed OSD restart, a node that did not return, a HyperProx restart mid-step) or set by hand. Nothing restarts or reboots while it is set: bring every OSD back up, then clear it with `ceph osd unset noout`'
const INTERRUPTED = 'interrupted by a HyperProx restart'
/** An automatic reboot run reached the end of its window: what is left waits for the next one. */
const WINDOW_CLOSED = 'the reboot window closed; it waits for the next window'
import { planHash, PLAN_CHANGED } from './plan-hash'

/** A plan nobody confirmed within this long is cancelled; nothing was changed. */
export const PLAN_EXPIRY_MS = 24 * 60 * 60_000
export const PLAN_EXPIRED_REASON = 'Not confirmed within a day; nothing was changed'
const NOT_FINISHED: UpdatesJobStatus[] = ['planned', 'awaiting-confirm', 'running', 'paused']
const SNAPSHOT_PREFIX = 'hp-upd-'
const BOOT_ID = 'cat /proc/sys/kernel/random/boot_id'
export { SAFETY_SKIP }

// Reasons a step is skipped in an ordinary, healthy run: not worth more than an "info" message.
const ROUTINE_SKIP = /^(no reboot needed|no Ceph packages pending|cancelled|the run stopped before|reboot: manual|no snapshot possible|rolled back to)/

/** info if all went well, warning if anything failed or was held back by a gate, critical if a node update failed. */
export function reportSeverity(status: string, steps: StepRecord[]): Severity {
  if (steps.some(s => s.status === 'failed' && (s.action === 'node-upgrade' || s.action === 'node-reboot'))) return 'critical'
  if (status === 'failed' || status === 'paused' || steps.some(s => s.status === 'failed')) return 'warning'
  if (steps.some(s => s.status === 'skipped' && s.reason && !ROUTINE_SKIP.test(s.reason))) return 'warning'
  return 'info'
}

/** Steps a safety check turned into a dry run. Never a success, whatever the job status. */
export function safetySkips(steps: StepRecord[]): StepRecord[] {
  return steps.filter(s => s.status === 'skipped' && (s.reason ?? '').startsWith(SAFETY_SKIP))
}

export class UpdatesRunner {
  private store: UpdatesStore
  private exec: UpdatesExecutor
  private timing: RunnerTiming
  private driving: Promise<void> = Promise.resolve()
  private cancelRequested = new Set<string>()
  /** Plan hashes a manual run was confirmed against, and what to do once it runs, by job id (see plan-hash.ts). */
  private expectedHash = new Map<string, { hash: string; actor?: string }>()
  private onRunning = new Map<string, (jobId: string) => Promise<void> | void>()
  private runStartedAt = new Map<string, number>()
  /** Whether the cluster has Ceph, asked once per job (see executor.cephPresent). */
  private cephKnown = new Map<string, boolean>()
  /** Nodes whose reboot a run deferred. Seeded from the last finished job at start-up. */
  readonly rebootPending = new Set<string>()
  /** Jobs this process is driving now (an automatic reboot run found after a restart is not, until it is continued). */
  private live = new Set<string>()

  constructor(private deps: RunnerDeps) {
    this.store = deps.store
    this.exec = deps.exec
    this.timing = { ...DEFAULT_TIMING, ...(deps.timing ?? {}) }
  }

  /** Resolves when the job currently being driven stops (for tests and shutdown). */
  idle(): Promise<void> { return this.driving }

  private get remote(): boolean { return !!this.deps.remote }
  /** Read fresh every time it is asked: a plug-in's job may have started, or a project been added, since the plan. */
  private async guardContext(): Promise<GuardContext> {
    if (this.remote) return {}
    return (this.deps.guards ?? homeGuards)()
  }
  get cluster(): UpdatesClusterRef { return this.deps.cluster ?? { id: 'home', name: 'Home cluster', kind: 'home' } }

  /** The plan context every buildPlan here uses. */
  planContext(inv: InventoryResult, policy: Policy, extra: { scope?: 'all' | 'guests'; approvals?: string[]; appProviders?: string[]; policyNote?: string }) {
    return { selfVmid: this.selfVmid(inv, policy), remote: this.remote || undefined, ...extra }
  }

  // ===========================================================================
  //  Public operations
  // ===========================================================================

  async start(mode: 'run' | 'dry-run', trigger: 'manual' | 'schedule' = 'manual', actor?: string, scope: 'all' | 'guests' = 'all',
              approvals: string[] = [], selection?: string[], opts: StartOptions = {}): Promise<JobRecord> {
    // A scheduled run has nobody to approve anything: only `auto` apps go in. Nor does it choose targets.
    if (trigger === 'schedule') { approvals = []; selection = undefined }
    if (selection) {
      const bad = selection.filter(id => !parseTargetId(id))
      if (!selection.length || selection.length > MAX_SELECTION || bad.length) {
        throw new JobStateError(selection.length ? `Not a target id: ${bad.slice(0, 3).join(', ') || 'too many'}` : 'Choose at least one target')
      }
    }
    const bad = approvals.filter(a => !APPROVAL_ID.test(a))
    if (bad.length || approvals.length > 200) throw new JobStateError(`Not an app approval id: ${bad.slice(0, 3).join(', ') || 'too many'}`)
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
    await this.store.audit(`updates.job.${mode === 'dry-run' ? 'dry-run' : 'start'}`, job.id, {
      trigger, scope, ...auditBy(actor ?? 'scheduler'), ...(approvals.length ? { approvals } : {}), ...(selection ? { selection } : {}),
    })
    if (mode === 'run' && trigger === 'manual') {
      if (opts.planHash) this.expectedHash.set(job.id, { hash: opts.planHash, actor })
      if (opts.onRunning) this.onRunning.set(job.id, opts.onRunning)
    }
    await this.emitJob(job)
    this.drive(job.id, () => this.prepare(job.id, mode, trigger, scope, approvals, selection))
    return job
  }

  async confirm(id: string, actor?: string): Promise<JobRecord> {
    this.deps.checkJob?.(await this.mustGet(id))
    const load = this.deps.loadPolicy()
    if (!load.loaded) throw new PolicyRequiredError(load.error)
    const next = await this.transition(id, ['awaiting-confirm'], { status: 'running', pauseReason: null })
    if (!next) throw new JobStateError(`Job ${id} is ${(await this.mustGet(id)).status}, not awaiting confirmation`)
    this.cancelRequested.delete(id)
    await this.store.audit('updates.job.confirm', id, { ...auditBy(actor) })
    await this.startedRunning(id)
    this.drive(id, () => this.execute(id))
    return next
  }

  async resume(id: string, actor?: string): Promise<JobRecord> {
    this.deps.checkJob?.(await this.mustGet(id))
    const load = this.deps.loadPolicy()
    if (!load.loaded) throw new PolicyRequiredError(load.error)
    // Claim the job first: of two Resumes racing, exactly one gets past this line.
    const next = await this.transition(id, ['paused'], { status: 'running', pauseReason: null })
    if (!next) throw new JobStateError(`Job ${id} is ${(await this.mustGet(id)).status}, not paused`)
    this.cancelRequested.delete(id)
    // Resume retries what failed. Every step is written to be safe to run twice.
    for (const s of await this.store.getSteps(id)) {
      const retry = s.status === 'failed' || (s.status === 'skipped' && retryable(s.reason))
      if (retry) await this.setStep(s, { status: 'pending', reason: null })
    }
    await this.store.audit('updates.job.resume', id, { ...auditBy(actor) })
    if ((await this.nooutGate(id)).reason === STALE_NOOUT) await this.announceStaleNoout(id, 'when the run was resumed')
    this.drive(id, () => this.execute(id))
    return next
  }

  async cancel(id: string, actor?: string): Promise<JobRecord> {
    const job = await this.mustGet(id)
    if (TERMINAL.includes(job.status)) throw new JobStateError(`Job ${id} has already finished (${job.status})`)
    await this.store.audit('updates.job.cancel', id, { ...auditBy(actor) })
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

  /**
   * A plan that has waited for a person's confirmation past `maxMs` (default a day) is cancelled: nothing ran, the
   * lock is released, and it is audited first. Returns the job id it cancelled, or null.
   */
  async expireUnconfirmed(maxMs: number = PLAN_EXPIRY_MS): Promise<string | null> {
    const job = await this.store.activeJob()
    if (!job || job.status !== 'awaiting-confirm') return null
    if (this.exec.now() - job.startedAt.getTime() < maxMs) return null
    await this.store.audit('updates.job.expired', job.id, { reason: PLAN_EXPIRED_REASON, ...auditBy('HyperProx') })
    const done = await this.finish(job.id, 'cancelled', PLAN_EXPIRED_REASON, undefined, ['awaiting-confirm'])
    // Confirmed or cancelled at the very moment it expired: the audit row above is then not what happened.
    if (!done) await this.store.audit('updates.job.expire-lost', job.id, { reason: 'It was confirmed or cancelled at the same moment, so it was not expired', ...auditBy('HyperProx') })
    return done ? job.id : null
  }

  /** A one-node reboot job with the same gates as a run. */
  async rebootNode(node: string, actor?: string): Promise<JobRecord> {
    const load = this.deps.loadPolicy()
    const status = await this.exec.clusterStatus()
    if (!status.nodes.some(n => n.name === node)) throw new JobStateError(`No node named ${node}`)
    if (this.remote) return this.rebootStandaloneNode(node, status.standalone === true, actor)
    const isSelf = await this.isSelfNode(node, load.policy)
    const step = isSelf
      ? { seq: 1, target: node, action: 'self' as const, detail: `${DETAIL.selfReboot} — requested by hand, through a handoff` }
      : { seq: 1, target: node, action: 'node-reboot' as const, detail: `${DETAIL.rebootAuto} — requested by hand` }
    // Asked for by name: it reboots whether or not the node says it needs to (the plan's `forced`, never its words).
    const plan: UpdatesPlan = { steps: [step], warnings: [], forced: [1], stepOffset: 1 }
    const job = await this.store.createJob({ trigger: 'manual', status: 'running', plan })
    await this.store.audit('updates.node.reboot', job.id, { node, ...auditBy(actor) })
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
   * What rebooting a remote one-node server takes down, for the confirmation dialog. Read-only. The reboot itself
   * (rebootNode) is its own job, started only by a person, and checks all of this again when it runs.
   */
  async rebootPreview(node: string): Promise<UpdatesRebootPreview> {
    const status = await this.exec.clusterStatus()
    if (!status.nodes.some(n => n.name === node)) throw new JobStateError(`No node named ${node}`)
    const standalone = status.standalone === true
    const goingDown = await this.runningGuestsOn(node)
    let facts: NodeFacts | null = null
    try { facts = await this.nodeFacts(node) } catch { /* reported below */ }
    const warnings: string[] = []
    if (!facts) warnings.push(`${node}'s kernels could not be read`)
    if (this.remote && !standalone) warnings.push(`${node} is part of a cluster: on a remote cluster HyperProx reboots only one-node servers. Reboot it by hand, after moving its guests.`)
    if (goingDown.length) warnings.push(`${goingDown.length} running guest${goingDown.length === 1 ? '' : 's'} will stop while ${node} restarts${standalone ? ' — there is no other node to move them to' : ''}.`)
    const notBack = goingDown.filter(g => !g.onboot)
    if (notBack.length) warnings.push(`Not set to start at boot, so they stay stopped afterwards: ${notBack.map(g => `${g.vmid} (${g.name})`).join(', ')}.`)
    const boots = facts ? (facts.pinned ?? newestKernel(facts)) : null
    return {
      node, cluster: this.cluster, standalone, goingDown,
      runningKernel: facts?.runningKernel ?? null, bootsKernel: boots,
      rebootNeeded: facts ? this.rebootNeeded(facts) : false, warnings,
    }
  }

  private async runningGuestsOn(node: string): Promise<UpdatesRebootPreview['goingDown']> {
    const out: UpdatesRebootPreview['goingDown'] = []
    for (const g of (await this.exec.listGuests()).filter(x => x.node === node && x.running && !x.template).sort((a, b) => a.vmid - b.vmid)) {
      let onboot = false
      try { onboot = String((await this.exec.guestConfig(g)).onboot ?? '0') === '1' } catch { /* unknown: treated as not starting */ }
      out.push({ vmid: g.vmid, type: g.type, name: g.name, onboot })
    }
    return out
  }

  /** A remote reboot: only a one-node server, only by hand, as its own job. */
  private async rebootStandaloneNode(node: string, standalone: boolean, actor?: string): Promise<JobRecord> {
    if (!standalone) throw new JobStateError(`${node} is part of a cluster. On a remote cluster HyperProx reboots only one-node servers; reboot ${node} by hand after moving its guests.`)
    const step = { seq: 1, target: node, action: 'node-reboot' as const, detail: `${DETAIL.rebootStandalone} — requested by hand; its running guests stop until it is back` }
    const job = await this.store.createJob({ trigger: 'manual', status: 'running', plan: { steps: [step], warnings: [] } })
    await this.store.audit('updates.node.reboot', job.id, { node, ...auditBy(actor), cluster: this.cluster.id })
    await this.store.addSteps(job.id, [
      { seq: 1, target: 'cluster', action: 'preflight', detail: 'one-node server: no quorum or HA to check; the node answers' },
      { ...step, seq: 2 },
    ])
    await this.emitJob(job)
    this.drive(job.id, async () => {
      const pre = await this.runStep(job.id, (await this.store.getSteps(job.id))[0], async () => {
        const g = await this.combine((await quorumHaGates(this.exec, true)).map(x => Promise.resolve(x)))
        return g.ok ? { status: 'ok', output: g.reason } : { status: 'failed', reason: g.reason }
      })
      if (pre.status !== 'ok') return void await this.finish(job.id, 'failed', `Preflight stopped the reboot: ${pre.reason}`)
      if (this.cancelRequested.has(job.id)) return this.cancelNow(job.id)
      await this.execute(job.id)
    })
    return job
  }

  // ===========================================================================
  //  Automatic reboots: a rolling reboot as its own job
  // ===========================================================================

  /**
   * A rolling reboot: the nodes one at a time (HyperProx's own node last, through the handoff), then the guests that
   * still ask for one. The same gates and steps as the Reboot button, plus: every node online and quorum kept with
   * the node gone; a node whose guests cannot move is rebooted without HA maintenance (HA restarts them in place);
   * the guests that were running are checked back afterwards (non-HA ones started again); viewers are waited for
   * until the window ends; the first problem stops the run (never a pause), with one message saying what to do.
   * The job is persisted like any other, and a restart in the middle of HyperProx's own node's reboot carries on by
   * itself once HyperProx is unlocked (continueRebootRun).
   */
  async startRebootRun(opts: {
    kind: 'window' | 'now'; windowEnd: number; quiet: boolean; nodes: string[]; guests: number[]
    skipped?: { target: string; reason: string }[]; forceNodes?: boolean; actor?: string
  }): Promise<JobRecord> {
    if (this.remote) throw new JobStateError('HyperProx does not reboot the nodes of a remote cluster on its own.')
    const load = this.deps.loadPolicy()
    // A policy file that exists but did not load may be the one that requires a kernel pin: nothing reboots then.
    if (!load.loaded && !load.missing) throw new PolicyRequiredError(load.error)
    if (!opts.nodes.length && !opts.guests.length) throw new JobStateError('Nothing needs a reboot.')
    const status = await this.exec.clusterStatus()
    const unknown = opts.nodes.filter(n => !status.nodes.some(x => x.name === n))
    if (unknown.length) throw new JobStateError(`No node named ${unknown.join(', ')}`)
    const guests = await this.exec.listGuests()
    const self = this.remote ? null : findSelfGuest(guests, load.policy, this.deps.hostname)
    // Policy order, HyperProx's own node at the very end.
    const ordered = orderNodes(status.nodes.filter(n => opts.nodes.includes(n.name)).map(n => ({ node: n.name, isSelf: self?.node === n.name } as any)), load.policy).map(n => n.node as string)
    const planSteps: UpdatesPlan['steps'] = []
    for (const n of ordered) {
      planSteps.push(self?.node === n
        ? { seq: planSteps.length + 1, target: n, action: 'self', detail: `${DETAIL.selfReboot} — automatic reboot of HyperProx's own node, through a handoff from another node` }
        : { seq: planSteps.length + 1, target: n, action: 'node-reboot', detail: `${DETAIL.rebootAuto} — automatic reboot, one node at a time` })
    }
    for (const vmid of [...opts.guests].sort((a, b) => a - b)) {
      planSteps.push({ seq: planSteps.length + 1, target: String(vmid), action: 'guest-reboot', detail: 'the guest asks for a reboot (/run/reboot-required)' })
    }
    const reboots: UpdatesRebootRun = {
      kind: opts.kind, windowEnd: new Date(opts.windowEnd).toISOString(), quiet: opts.quiet,
      nodes: ordered, guests: [...opts.guests].sort((a, b) => a - b), skipped: opts.skipped ?? [], results: {}, leftOn: null,
    }
    const plan: UpdatesPlan = {
      steps: planSteps, warnings: [], stepOffset: 1, reboots,
      ...(opts.forceNodes ? { forced: planSteps.filter(x => x.action !== 'guest-reboot').map(x => x.seq) } : {}),
    }
    // Written before anything exists: who or what asks, and exactly what it will touch. A failed audit starts nothing.
    await this.store.audit('updates.reboots.start', 'reboots', {
      kind: opts.kind, nodes: ordered, guests: reboots.guests, windowEnd: reboots.windowEnd, quiet: opts.quiet,
      ...(opts.forceNodes ? { everyNode: true } : {}), ...auditBy(opts.actor ?? 'reboot window'),
    })
    // Created as planned and only then claimed as running by this process, so the reboot timer can never take up a
    // run that is just starting (continueRebootRun takes running jobs no one drives).
    const created = await this.store.createJob({ trigger: opts.kind === 'window' ? 'schedule' : 'manual', status: 'planned', plan })
    this.live.add(created.id)
    try {
      await this.store.addSteps(created.id, [
        { seq: 1, target: 'cluster', action: 'preflight', detail: 'every node online, quorum, Ceph health, HA settled, noout not set' },
        ...planSteps.map(x => ({ ...x, seq: x.seq + 1 })),
      ])
    } catch (e) {
      await this.finish(created.id, 'failed', `Could not write the run's steps: ${(e as any)?.message ?? e}`).catch(() => {})
      this.live.delete(created.id)
      throw e
    }
    const job = (await this.transition(created.id, ['planned'], { status: 'running' })) ?? created
    this.drive(job.id, async () => {
      const pre = await this.runStep(job.id, (await this.store.getSteps(job.id))[0], async () => {
        const g = await this.clusterGates(job.id, load.policy)
        return g.ok ? { status: 'ok', output: g.reason } : { status: 'failed', reason: g.reason }
      })
      if (pre.status !== 'ok') return void await this.finish(job.id, 'failed', `Nothing was rebooted: ${pre.reason}`)
      if (this.cancelRequested.has(job.id)) return this.cancelNow(job.id)
      await this.announce({
        type: 'updates.reboots.started', severity: 'info',
        title: opts.kind === 'window' ? 'Automatic reboots started' : 'Rolling reboot started',
        lines: [
          ...(ordered.length ? [`Nodes, one at a time: ${ordered.join(', ')}.`] : []),
          ...(reboots.guests.length ? [`Guests: ${reboots.guests.join(', ')}.`] : []),
          ...(reboots.skipped.length ? [`Left out: ${reboots.skipped.map(x => `${x.target} (${x.reason})`).join('; ')}.`] : []),
          `No reboot starts after ${reboots.windowEnd.slice(11, 16)} UTC.`,
        ],
      }, `${job.id}:start`)
      await this.execute(job.id)
    })
    return job
  }

  /** The automatic reboot run in a job's plan, if it is one. */
  private async rebootRunOf(jobId: string): Promise<UpdatesRebootRun | null> {
    return (await this.store.getJob(jobId))?.plan?.reboots ?? null
  }

  /** Record what one machine's reboot did, in the job's plan (it survives a restart with the job). */
  private async noteReboot(jobId: string, target: string, patch: UpdatesRebootResult): Promise<void> {
    const job = await this.store.getJob(jobId)
    const rr = job?.plan?.reboots
    if (!job || !rr) return
    const results = { ...rr.results, [target]: { ...(rr.results[target] ?? {}), ...patch } }
    await this.store.updateJob(jobId, { plan: { ...job.plan, reboots: { ...rr, results } } })
  }

  /**
   * Carry on an automatic reboot run that is still running but not driven here: HyperProx restarted while its own
   * node rebooted. Called by the reboot timer once HyperProx is unlocked (the node logins are in the vault).
   * Returns the job id it took up, or null.
   */
  async continueRebootRun(): Promise<string | null> {
    if (this.remote) return null
    const job = await this.store.activeJob()
    if (!job || job.status !== 'running' || !job.plan?.reboots || this.live.has(job.id)) return null
    this.log(`continuing automatic reboot run ${job.id} after a restart`)
    await this.store.audit('updates.reboots.continue', job.id, { ...auditBy('HyperProx, after its restart') })
    this.drive(job.id, () => this.execute(job.id))
    return job.id
  }

  /**
   * A run waiting for HyperProx to be unlocked must not hold the one-job lock for ever: past `maxMs` since its last
   * step moved, it is stopped (what it set is reported, Make safe offered). Returns the job id it stopped, or null.
   */
  async expireStrandedRebootRun(maxMs: number): Promise<string | null> {
    if (this.remote) return null
    const job = await this.store.activeJob()
    if (!job || job.status !== 'running' || !job.plan?.reboots || this.live.has(job.id)) return null
    const steps = await this.store.getSteps(job.id)
    const last = Math.max(job.startedAt.getTime(), ...steps.flatMap(x => [x.startedAt, x.endedAt]).filter((d): d is Date => !!d).map(d => new Date(d).getTime()))
    if (this.exec.now() - last < maxMs) return null
    for (const s of steps.filter(x => x.status === 'running')) {
      await this.setStep(s, { status: 'failed', reason: 'HyperProx stayed locked after its restart, so the run could not finish its checks', endedAt: new Date(this.exec.now()) })
    }
    await this.finish(job.id, 'failed', `HyperProx stayed locked for ${Math.round(maxMs / 60_000)} minutes after its restart, so the rolling reboot could not finish its checks. Sign in, check the nodes, and use Make safe if it shows anything left on`)
    return job.id
  }

  /**
   * The one-tap fix after a rolling reboot stopped with something left on: HA maintenance off for the node the run
   * left in it, and Ceph noout off — but noout only when every OSD is up and in, since clearing it with an OSD down
   * lets Ceph start moving data. Never while an Updates job runs. Audited before anything changes.
   */
  async makeSafe(actor?: string): Promise<{ cleared: string[]; left: string[] }> {
    if (this.remote) throw new JobStateError('Make safe is for the home cluster.')
    const active = await this.store.activeJob()
    if (active) throw new JobStateError(`An Updates job is running (${active.id}); wait for it to finish.`)
    const last = (await this.store.listJobs(20)).find(j => j.plan?.reboots)
    const left = last?.plan?.reboots?.leftOn
    if (!last || !left) throw new JobStateError('No rolling reboot left anything on.')
    const status = await this.exec.clusterStatus()
    // Only once the node is back and the cluster quorate: clearing either earlier lets guests or data move toward a sick node.
    if (!status.quorate) throw new JobStateError('The cluster is not quorate. Make safe waits until it is.')
    if (!status.nodes.find(n => n.name === left.node)?.online) throw new JobStateError(`${left.node} is not online. Make safe waits until it is back; until then HA maintenance and noout keep guests and data where they are.`)
    await this.store.audit('updates.reboots.make-safe', last.id, { node: left.node, maintenance: left.maintenance, noout: left.noout, ...auditBy(actor) })
    const peer = status.nodes.filter(n => n.online).map(n => n.name).sort((a, b) => (a === left.node ? 1 : b === left.node ? -1 : a.localeCompare(b)))[0]
    if (!peer) throw new JobStateError('No node is online to run the commands from.')
    const cleared: string[] = [], still: string[] = []
    const ha = await this.exec.haStatus().catch(() => null)
    if (ha?.maintenanceNodes.includes(left.node)) {
      const r = await this.exec.nodeExec(peer, haMaintenance(left.node, false), undefined, 120_000).catch((e: any) => ({ code: -1, output: String(e?.message ?? e), timedOut: false }))
      if (r.code === 0) cleared.push(`HA maintenance on ${left.node}`); else still.push(`HA maintenance on ${left.node} (the command failed)`)
    }
    if (await this.exec.cephPresent().catch(() => false)) {
      let noout = false
      try { noout = await this.nooutSet() } catch { still.push('Ceph noout (its state could not be read)') }
      if (noout) {
        const h = await this.exec.cephHealth().catch(() => null)
        if (!h || h.numUpOsds < h.numOsds || h.numInOsds < h.numOsds) still.push(`Ceph noout: ${h ? `${h.numOsds - h.numUpOsds} OSD(s) still down` : 'Ceph health could not be read'}, so it stays on until every OSD is back`)
        else {
          const r = await this.exec.nodeExec(peer, CEPH_NOOUT_UNSET, undefined, 120_000).catch(() => ({ code: -1, output: '', timedOut: false }))
          if (r.code === 0) cleared.push('Ceph noout'); else still.push('Ceph noout (the command failed)')
        }
      }
    }
    if (!still.length) {
      const job = await this.store.getJob(last.id)
      if (job?.plan?.reboots) await this.store.updateJob(last.id, { plan: { ...job.plan, reboots: { ...job.plan.reboots, leftOn: null } } })
    }
    await this.store.audit('updates.reboots.made-safe', last.id, { cleared, left: still, ...auditBy(actor) })
    return { cleared, left: still }
  }

  /** The guests running on a node now, with whether HA manages them, for the check after it is back. */
  private async snapshotRunning(node: string): Promise<{ vmid: number; type: 'lxc' | 'qemu'; name: string; onboot: boolean; ha: boolean }[]> {
    const ha = new Set(await this.exec.haResources().catch(() => [] as string[]))
    return (await this.runningGuestsOn(node)).map(g => ({ ...g, ha: ha.has(`${g.type === 'lxc' ? 'ct' : 'vm'}:${g.vmid}`) }))
  }

  /** Guests on `node` that cannot move to another node, in words; empty when HA maintenance can empty it. */
  private async immovableOn(node: string): Promise<string[]> {
    const ha = new Set(await this.exec.haResources())
    let rules: HaRule[] = []
    try { rules = this.exec.haRules ? await this.exec.haRules() : [] } catch { rules = [] }
    // Disks on storage only this node reaches: judged when the storage list can be read, else left to the drain.
    let storages: Map<string, boolean> | null = null
    try { storages = this.exec.sharedStorages ? await this.exec.sharedStorages() : null } catch { storages = null }
    const out: string[] = []
    for (const g of (await this.exec.listGuests()).filter(x => x.node === node && x.running && !x.template)) {
      if (!ha.has(`${g.type === 'lxc' ? 'ct' : 'vm'}:${g.vmid}`)) continue   // not HA: it stops with the node either way
      const why = immovableReason(g, await this.exec.guestConfig(g), rules, storages)
      if (why) out.push(`${g.vmid} (${g.name || g.type}): ${why}`)
    }
    return out
  }

  /** Corosync's votes, read on a peer; null when they cannot be read (then one vote per node is counted). */
  private async votesNow(peer: string): Promise<QuorumVotes | null> {
    try { const r = await this.exec.nodeExec(peer, QUORUM_VOTES_COMMAND, undefined, 30_000); return parseQuorumTool(r.output) } catch { return null }
  }

  /** Quorum now, and still with `node` gone: every node online. Asked again right before the reboot command. */
  private async quorumNow(node: string, peer: string, rr: boolean): Promise<GateResult> {
    const q = await quorumGate(this.exec)
    if (!q.ok || !rr) return q
    try { return rebootQuorumGate(await this.exec.clusterStatus(), node, await this.votesNow(peer)) }
    catch (e: any) { return { ok: false, reason: `could not read cluster status: ${e?.message ?? e}` } }
  }

  /**
   * Restarting guests in place relies on HA freezing them while the node reboots (shutdown_policy freeze, or
   * conditional, Proxmox's default). With failover or migrate HA would try to start them elsewhere, which they
   * cannot do: refused, with nothing changed. Unreadable is refused too.
   */
  private async inPlaceGate(): Promise<GateResult> {
    if (!this.exec.haShutdownPolicy) return { ok: false, reason: "HA's shutdown policy could not be read" }
    try {
      const p = await this.exec.haShutdownPolicy()
      return inPlaceAllowed(p) ? { ok: true, reason: `HA shutdown policy ${p}` }
        : { ok: false, reason: `HA's shutdown policy is ${p}, so HA would not restart these guests on this node; set it to freeze or conditional (Datacenter, Options, HA settings), or reboot this node by hand` }
    } catch (e: any) { return { ok: false, reason: `HA's shutdown policy could not be read (${e?.message ?? e})` } }
  }

  /**
   * After a node is back: every guest that was running on it is running again somewhere. HA guests come back by
   * themselves (moved back after maintenance, or restarted in place); a non-HA guest set to start at boot is started
   * by Proxmox; any other non-HA guest that was running is started here. Leave-alone guests are never started by
   * HyperProx; they are reported.
   */
  private async guestsBack(jobId: string, node: string, before: { vmid: number; type: 'lxc' | 'qemu'; name: string; onboot: boolean; ha: boolean }[], policy: Policy, log: LineSink): Promise<GateResult> {
    if (!before.length) return { ok: true, reason: 'no guests were running on it' }
    const name = (g: { vmid: number; name: string }) => `${g.vmid} (${g.name})`
    const running = async () => new Set((await this.exec.listGuests()).filter(g => g.running).map(g => g.vmid))
    await this.waitFor(async () => { const r = await running(); return before.filter(g => g.ha || g.onboot).every(g => r.has(g.vmid)) }, this.timing.guestBootMs)
    let now = await running().catch(() => new Set<number>())
    const started: string[] = []
    const leftAlone: string[] = []
    const listing = await this.guestMap().catch(() => new Map<number, GuestListing>())
    const inside = await lookInsideList(this.exec)
    for (const g of before.filter(x => !x.ha && !now.has(x.vmid))) {
      const cur = listing.get(g.vmid)
      if (!cur) continue
      const off = hasIgnoreTag(cur.tags) || guestPolicy(policy, g.vmid).excluded || lookInsideReason(inside, cur) !== null
      if (off) { leftAlone.push(name(g)); continue }
      const cmd = `${g.type === 'qemu' ? 'qm' : 'pct'} start ${g.vmid}`
      log(`${cur.node}$ ${cmd}`)
      const r = await this.exec.nodeExec(cur.node, cmd, log, 120_000).catch((e: any) => ({ code: -1, output: String(e?.message ?? e), timedOut: false }))
      if (r.code === 0) started.push(name(g))
    }
    if (started.length) await this.waitFor(async () => { const r = await running(); return before.filter(g => !g.ha && !leftAlone.includes(name(g))).every(g => r.has(g.vmid)) }, this.timing.guestBootMs)
    now = await running().catch(() => new Set<number>())
    const back = before.filter(g => now.has(g.vmid)).map(name)
    const missing = before.filter(g => !now.has(g.vmid) && !leftAlone.includes(name(g))).map(name)
    await this.noteReboot(jobId, node, { back, started })
    const words = [
      back.length ? `running again: ${back.join(', ')}` : '',
      started.length ? `started by HyperProx (not in HA, were running before): ${started.join(', ')}` : '',
      leftAlone.length ? `left alone, not started by HyperProx: ${leftAlone.join(', ')}` : '',
    ].filter(Boolean).join('; ')
    return missing.length ? { ok: false, reason: `NOT running again after ${node}'s reboot: ${missing.join(', ')}${words ? `; ${words}` : ''}` } : { ok: true, reason: words || 'every guest is back' }
  }

  /** Automatic reboots: one guest that asks for a reboot. HA guests through ha-manager, never pct/qm. */
  private async guestRebootStep(jobId: string, step: StepRecord, policy: Policy, log: LineSink): Promise<Outcome> {
    const guest = (await this.guestMap()).get(Number(step.target))
    if (!guest) return { status: 'skipped', reason: `guest ${step.target} is no longer in the cluster` }
    if (!guest.running) return { status: 'skipped', reason: 'not running' }
    // Leave-alone, read now: tagged, excluded in the policy, or on Remote access's "never look inside" list.
    if (hasIgnoreTag(guest.tags)) return { status: 'skipped', reason: 'tagged hyperprox-ignore: left alone' }
    if (guestPolicy(policy, guest.vmid).excluded) return { status: 'skipped', reason: 'excluded in the Updates policy: left alone' }
    // HyperProx's own guest: rebooting it would stop this run. Its policy, read now, must still opt in.
    if (findSelfGuest(await this.exec.listGuests(), policy, this.deps.hostname)?.vmid === guest.vmid) return { status: 'skipped', reason: SELF_GUEST_WORDS }
    const refusal = guestPolicyRefusal(policy, guest.vmid)
    if (refusal) return { status: 'skipped', reason: refusal }
    const notInside = lookInsideReason(await lookInsideList(this.exec), guest)
    if (notInside) return { status: 'skipped', reason: `${LOOK_INSIDE_WORDS[notInside]}: left alone` }
    // Asked again now: a node reboot earlier in this run may already have restarted it.
    const r = await this.exec.guestExec(guest, GUEST_REBOOT_REQUIRED_SCRIPT, undefined, 30_000)
    if (r.code !== 0) return { status: 'failed', reason: `could not ask ${guest.vmid} whether it still needs a reboot` }
    if (!/HP_REBOOT_REQUIRED/.test(r.output)) return { status: 'skipped', reason: 'no reboot needed any more' }
    const quiet = await this.waitForQuiet(jobId, policy, log)
    if (!quiet.ok) return { status: 'skipped', reason: `${quiet.reason} — it waits for the next window` }
    const t0 = this.exec.now()
    const back = await this.rebootGuest(guest, log)
    if (!back.ok) return { status: 'failed', reason: back.reason }
    await this.noteReboot(jobId, step.target, { downSeconds: Math.round((this.exec.now() - t0) / 1000) })
    return { status: 'ok', output: `rebooted ${back.reason}` }
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
    if (job.plan?.reboots) {
      // An automatic reboot run: HyperProx's own node rebooting is the expected restart, and the run carries on by
      // itself (continueRebootRun, once unlocked). Anything else cut off mid-step stops it, safe and said.
      const stray = steps.filter(x => x.status === 'running' && !(x.action === 'self' && handoffNodeOf(x.detail)))
      for (const s of stray) await this.setStep(s, { status: 'failed', reason: INTERRUPTED, endedAt: new Date(this.exec.now()) })
      if (stray.length) {
        await this.finish(job.id, 'failed', `HyperProx restarted in the middle of ${stray[0].action} on ${stray[0].target}`)
        return
      }
      this.log(`automatic reboot run ${job.id} carries on once HyperProx is unlocked`)
      return
    }
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
          if (r) {
            const skipped = !r.ok && r.message.startsWith(SAFETY_SKIP)
            if (skipped) this.rebootPending.add(s.target)
            await this.setStep(s, { status: r.ok ? 'ok' : skipped ? 'skipped' : 'failed', reason: r.ok ? null : r.message, output: r.message, endedAt: new Date(this.exec.now()) })
          }
        } catch { /* collected on Resume */ }
        continue
      }
      // Anything else died with the API. Marked failed, so Resume retries it and a guest's failure still holds the node phase.
      await this.setStep(s, { status: 'failed', reason: INTERRUPTED, endedAt: new Date(this.exec.now()) })
    }
    let reason = 'HyperProx restarted mid-job — check the last step, then press Resume'
    let noout = false
    try { noout = await this.ceph(job.id) && await this.nooutSet() } catch { reason += '. Whether Ceph noout is set could not be read: check `ceph osd dump | grep flags` before resuming' }
    if (noout) reason = `HyperProx restarted mid-job, and ${STALE_NOOUT}; then check the last step and press Resume`
    await this.transition(job.id, ['running'], { status: 'paused', pauseReason: reason })
    if (noout) await this.announceStaleNoout(job.id, 'after HyperProx restarted in the middle of a run')
    this.log(`job ${job.id} paused after restart`)
  }

  // ===========================================================================
  //  Preparation: preflight, refresh, plan
  // ===========================================================================

  // The scope only shapes the plan: a run executes the steps stored with it, so a guests-only run stays
  // guests-only through a pause, a resume or a restart.
  private async prepare(jobId: string, mode: 'run' | 'dry-run', trigger: 'manual' | 'schedule', scope: 'all' | 'guests' = 'all', approvals: string[] = [],
                        selection?: string[]): Promise<void> {
    const appPlan = { approvals, appProviders: this.deps.apps?.providers.map(r => r.provider.id) }
    const guards = await this.guardContext()
    // A run of chosen targets: only the nodes it names are checked node by node, refreshed and planned.
    const chosen = selection ? selection.map(parseTargetId).filter((t): t is NonNullable<typeof t> => !!t) : null
    const allNodes = chosen?.some(t => t.kind === 'ceph') ?? true
    const chosenNodes = new Set(chosen ? chosen.flatMap(t => ('node' in t ? [t.node] : [])) : [])
    const chosenGuests = new Set(chosen ? chosen.flatMap(t => ('vmid' in t ? [t.vmid] : [])) : [])
    // Guests whose compose projects were chosen are read as projects again, wherever the policy stands on docker.
    const composeFor = new Set(chosen ? chosen.flatMap(t => (t.kind === 'compose' ? [t.vmid] : [])) : [])
    const readInv = () => this.inventory(policy, composeFor.size ? composeFor : undefined)
    const makePlan = (inv: InventoryResult, extra: { policyNote?: string }) => selection
      ? buildSelectedPlan(inv.inventory, policy, { ...this.planContext(inv, policy, { ...extra, ...appPlan }), ...guards, selection })
      : buildPlan(inv.inventory, policy, this.planContext(inv, policy, { ...extra, scope, ...appPlan }))
    const load = this.deps.loadPolicy()
    const policy = load.policy
    const policyNote = load.loaded ? undefined : `${load.error ?? 'No policy file'} — this plan uses the built-in safe defaults.`
    const [preStep] = await this.store.addSteps(jobId, [{ seq: 1, target: 'cluster', action: 'preflight', detail: 'quorum, Ceph health, HA, nodes reachable, free space, holds and pin' }])

    const box: { inv: InventoryResult | null } = { inv: null }
    const pre = await this.runStep(jobId, preStep, async () => {
      box.inv = await readInv()
      // Chosen targets: the per-node gates cover the nodes it will act on and can (a node it cannot act on is refused
      // in the plan, with the reason, instead of stopping the run for every other target).
      const facts = box.inv.facts
      // A node whose reboot was chosen is always checked: one whose holds or pin are missing or unknown stops the run.
      const rebootOf = new Set(chosen ? chosen.flatMap(t => (t.kind === 'node-reboot' ? [t.node] : [])) : [])
      const only = allNodes ? undefined : new Set([...chosenNodes].filter(n => rebootOf.has(n) || (facts[n] && holdsPinGate(n, facts[n], nodePolicy(policy, n)).ok)))
      const pf0 = await preflight(this.exec, policy, facts, await this.ceph(jobId), this.remote, only)
      const noout = await this.nooutGate(jobId)
      if (!noout.ok && noout.reason === STALE_NOOUT) await this.announceStaleNoout(jobId, 'at the start of an Updates run')
      const pf1 = noout.ok ? pf0 : { ok: false, reason: [pf0.ok ? '' : pf0.reason, noout.reason].filter(Boolean).join('; ') }
      // A Ceph start fence left by a killed run: reported, and replaced by the next guarded install on that node.
      const fences = Object.entries(box.inv.facts).filter(([, f]) => f?.fence).map(([n, f]) => f!.fence === 'ours'
        ? `${n}: a Ceph start fence (policy-rc.d) left by an interrupted run is still in place; the next package install on ${n} replaces it`
        : `${n}: a saved policy-rc.d from an interrupted run (/usr/sbin/policy-rc.d.hyperprox-saved) is still there; package installs on ${n} refuse until a person restores or removes it`)
      if (fences.length) {
        await this.announce({ type: 'updates.fence_left', severity: 'warning', title: 'Updates found a package-script fence left by an interrupted run', lines: fences }, `${jobId}:fence`)
      }
      const pf = fences.length ? { ...pf1, reason: [pf1.reason, ...fences].join('; ') } : pf1
      // A node whose pending list or shell could not be read is not "reachable", whatever the gates say.
      const unread = box.inv.inventory.nodes.filter(n => n.error && (!only || only.has(n.node))).map(n => `${n.node}: ${n.error}`)
      const g = unread.length ? { ok: false, reason: [pf.ok ? '' : pf.reason, ...unread].filter(Boolean).join('; ') } : pf
      return g.ok ? { status: 'ok', output: g.reason } : { status: 'failed', reason: g.reason }
    })

    if (mode === 'dry-run') {
      // A dry run reads what is already known and executes nothing — not even `apt update`.
      const inv = box.inv ?? await readInv().catch(() => null)
      const plan = inv ? await this.withSafety(jobId, makePlan(inv, { policyNote })) : { steps: [], warnings: ['Inventory could not be read'] }
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
      if (scope === 'all') {
        for (const n of box.inv!.inventory.nodes.filter(x => x.online && (allNodes || chosenNodes.has(x.node)))) {
          await this.exec.nodeAptRefresh(n.node)
          log(`${n.node}: apt update done`)
        }
      }
      const listing = await this.guestMap()
      const managed = box.inv!.inventory.guests.filter(g => g.managed && guestPolicy(policy, g.vmid).apt && (!chosen || chosenGuests.has(g.vmid)))
      for (let i = 0; i < managed.length; i += policy.batchSize) {
        await Promise.all(managed.slice(i, i + policy.batchSize).map(async g => {
          const ref = listing.get(g.vmid)
          if (!ref) return
          const r = await this.exec.guestExec(ref, GUEST_REFRESH_SCRIPT, undefined, 10 * 60_000).catch(e => ({ code: -1, output: String(e.message), timedOut: false }))
          // A guest whose lists did not refresh is planned from the old ones, and says so.
          if (r.code !== 0) lines.push(`${g.vmid}: apt update failed (${tail(r.output, 200).trim()})`)
        }))
      }
      box.inv = await readInv()
      return { status: 'ok', output: lines.join('\n') || 'all lists refreshed' }
    })
    if (ref.status !== 'ok') return void await this.finish(jobId, 'failed', `Refreshing package lists failed: ${ref.reason}`)
    if (this.cancelRequested.has(jobId)) return this.cancelNow(jobId)

    const built = await this.withSafety(jobId, makePlan(box.inv!, {}))
    const plan: UpdatesPlan = selection ? { ...built, stepOffset: PRE_STEPS } : built
    await this.store.addSteps(jobId, plan.steps.map(s => ({ ...s, seq: s.seq + PRE_STEPS })))
    if (trigger === 'manual') {
      const want = this.expectedHash.get(jobId)
      this.expectedHash.delete(jobId)
      // The plan the person confirmed is the plan that came out: go ahead on that one confirmation, audited.
      if (want && want.hash === planHash(plan)) {
        await this.setJob(jobId, { plan })
        await this.store.audit('updates.job.confirm', jobId, { ...auditBy(want.actor), via: 'the plan shown in the confirmation, unchanged' })
        await this.startedRunning(jobId)
        await this.execute(jobId)
        return
      }
      await this.transition(jobId, ['running'], { plan, status: 'awaiting-confirm', pauseReason: want ? PLAN_CHANGED : null })
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
    // A run of chosen targets: each item stands on its own (see `items` below).
    const items = new Items((await this.mustGet(jobId)).plan)
    // An automatic reboot run: no reboot starts once its window has closed.
    const rr = (await this.mustGet(jobId)).plan.reboots ?? null

    // --- Guest phase, batch_size at a time -----------------------------------------
    const all = await this.store.getSteps(jobId)
    const guestSteps = all.filter(s => isGuestStep(s) && s.status === 'pending')
    const targets = [...new Set(guestSteps.map(s => s.target))]
    for (let i = 0; i < targets.length; i += policy.batchSize) {
      if (!await this.stillRunning(jobId)) return
      if (this.cancelRequested.has(jobId)) return this.cancelNow(jobId)
      const gate = this.remote
        ? await this.combine([...(await quorumHaGates(this.exec, true)).map(g => Promise.resolve(g)), this.cephGateFor(jobId, policy)])
        : await this.combine([quorumGate(this.exec), this.cephGateFor(jobId, policy)])
      if (!gate.ok) return this.pause(jobId, `Gate failed before the next guests: ${gate.reason}`)
      await Promise.all(targets.slice(i, i + policy.batchSize).map(async t => {
        const mine = guestSteps.filter(s => s.target === t)
        const guest = guests.get(Number(t))
        // Checked again now, whatever the plan said: a guest excluded or tagged hyperprox-ignore since is not touched.
        const off = guest && (hasIgnoreTag(guest.tags) ? 'tagged hyperprox-ignore' : guestPolicy(policy, guest.vmid).excluded ? 'excluded in the Updates policy' : null)
        if (off) { for (const s of mine) await this.setStep(s, { status: 'skipped', reason: `not run: ${t} is ${off}` }); return }
        // Remote access's "never look inside" list, read now (home); unreadable: no guest is touched.
        const notInside = guest ? lookInsideReason(await lookInsideList(this.exec), guest) : null
        if (notInside) { for (const s of mine) await this.setStep(s, { status: 'skipped', reason: `not run: ${t}: ${LOOK_INSIDE_WORDS[notInside]}` }); return }
        // A plug-in's long job in this guest (a Nextcloud update, a database repair): left alone, and Resume tries again.
        const busyWhy = guest ? (await this.guardContext()).guestBusy?.(guest.vmid) : null
        if (busyWhy) { for (const s of mine) await this.setStep(s, { status: 'skipped', reason: `not run: ${busyWhy}` }); return }
        if (items.active && guest) {
          // Backups first: a guest being backed up right now is left alone (and Resume tries it again).
          const busy = await this.backupBusy(guest.node, guest.vmid)
          if (busy) { for (const s of mine) await this.setStep(s, { status: 'skipped', reason: `${BACKUP_RUNNING} (${busy})` }); return }
        }
        return this.runGuest(jobId, t, mine, guest, policy)
      }))
    }

    const failedGuests = [...new Set((await this.store.getSteps(jobId)).filter(s => isGuestStep(s) && s.status === 'failed').map(s => s.target))]
    if (failedGuests.length && !items.active) {
      return this.pause(jobId, `Guest${failedGuests.length > 1 ? 's' : ''} ${failedGuests.join(', ')} failed. The Ceph and node phases do not start while a guest has failed: fix it (its snapshot is named in the step) and press Resume, or Cancel.`)
    }

    // --- Ceph, nodes, self: strictly one step at a time -------------------------------
    for (const listed of (await this.store.getSteps(jobId)).filter(s => !isGuestStep(s))) {
      if (listed.action === 'preflight' || listed.action === 'refresh') continue
      if (!await this.stillRunning(jobId)) return
      // Re-read: a failure earlier in this loop may have skipped it since the list was read.
      const step = (await this.store.getSteps(jobId)).find(x => x.id === listed.id) ?? listed
      // A failed step is never stepped over: only Resume (which resets it) gets past one.
      if (step.status === 'failed' && step.action !== 'kernel-cleanup') {
        if (!(items.active && ISOLATED_NODE_ACTIONS.includes(step.action))) {
          return this.pause(jobId, `${step.action} on ${step.target} has failed (${step.reason ?? 'no reason recorded'}); press Resume to retry it`)
        }
      }
      if (step.status !== 'pending' && step.status !== 'running') continue
      if (this.cancelRequested.has(jobId)) return this.cancelNow(jobId)
      if (rr && step.status === 'pending' && this.exec.now() >= Date.parse(rr.windowEnd)) {
        for (const s of (await this.store.getSteps(jobId)).filter(x => x.status === 'pending')) await this.setStep(s, { status: 'skipped', reason: WINDOW_CLOSED })
        break
      }

      // A self step that was mid-handoff when the API went away: collect, do not restart it.
      if (step.status === 'running' && step.action === 'self' && handoffNodeOf(step.detail)) {
        const out = await this.collectHandoff(jobId, step)
        if (out.status === 'failed') return this.stopOnFailure(jobId, step, out)
        continue
      }

      if (items.active) {
        // An item whose prerequisite failed or was skipped does not run: a node is not rebooted after its guests failed.
        const now = await this.store.getSteps(jobId)
        // An item is one unit: a step whose own earlier step failed (HyperProx's snapshot, say) does not run.
        if (items.brokenBefore(step, now)) { await this.skipItem(jobId, items, step, AFTER_ITEM_FAILURE); continue }
        const waits = await items.unmet(step, now)
        if (waits) { await this.skipItem(jobId, items, step, `${DEPENDS_ON} ${waits}, which did not finish`); continue }
        // HyperProx's own upgrade acts on its guest: a backup of that guest, or on its node, holds it.
        const selfGuest = step.action === 'self' && detailKey(step) === DETAIL.selfGuest ? guests.get(Number(step.target)) : undefined
        const busy = step.action === 'kernel-cleanup' ? null
          : selfGuest ? await this.backupBusy(selfGuest.node, selfGuest.vmid)
          : await this.backupBusy(step.target, null)
        if (busy) {
          // Ceph moves on every node together: half an install waits for a person rather than being skipped.
          if (step.action === 'ceph') return this.pause(jobId, `A backup is running (${busy}); the Ceph item waits. Press Resume when it has finished.`)
          await this.skipItem(jobId, items, step, `${BACKUP_RUNNING} (${busy})`)
          continue
        }
      }

      if (step.action !== 'kernel-cleanup' && !(step.action === 'node-reboot' && detailKey(step) === DETAIL.rebootManual)) {
        // A rolling reboot gives HA and Ceph time to settle after the node before (guests moving back, PGs peering).
        const gate = rr ? await this.settledGates(jobId, policy) : await this.clusterGates(jobId, policy)
        if (!gate.ok) return this.pause(jobId, `Gate failed before ${step.action} on ${step.target}: ${gate.reason}`)
      }

      const out = await this.runStep(jobId, step, log => this.dispatch(jobId, step, policy, log, items.active))
      if (out.status === 'failed') {
        if (step.action === 'kernel-cleanup') continue   // old kernels left behind are untidy, not unsafe
        // Chosen targets: a node update that failed changed nothing it could not report; its own item stops, and
        // everything that waits for it with it, while unrelated items carry on (the gates still run before each).
        if (items.active && ISOLATED_NODE_ACTIONS.includes(step.action)) { await this.skipItem(jobId, items, step, AFTER_ITEM_FAILURE, true); continue }
        return this.stopOnFailure(jobId, step, out)
      }
    }

    if (!await this.stillRunning(jobId)) return
    await this.finish(jobId, 'done', undefined, undefined, ['running'])
  }

  /**
   * The rest of `step`'s item, and every item that waits for it, marked skipped. `after`: the step itself already
   * failed (it keeps its own status); otherwise it is skipped too.
   */
  private async skipItem(jobId: string, items: Items, step: StepRecord, reason: string, after = false): Promise<void> {
    const steps = await this.store.getSteps(jobId)
    const it = items.of(step)
    const mine = it ? steps.filter(s => items.of(s)?.id === it.id) : [step]
    for (const s of mine) {
      if (s.status !== 'pending') continue
      await this.setStep(s, { status: 'skipped', reason: after ? AFTER_ITEM_FAILURE : reason })
    }
    if (!it) return
    for (const d of items.dependents(it.id)) {
      for (const s of steps.filter(x => items.of(x)?.id === d.id && x.status === 'pending')) {
        await this.setStep(s, { status: 'skipped', reason: `${DEPENDS_ON} ${it.label}, which did not finish` })
      }
    }
  }

  /** A vzdump running on `node`, or of guest `vmid`: in words, or null. A read that fails counts as running. */
  private async backupBusy(node: string, vmid: number | null): Promise<string | null> {
    if (!this.exec.backupTasks) return null
    try {
      const t = (await this.exec.backupTasks()).find(x => x.ok === null && (x.node === node || (vmid !== null && x.vmid === vmid)))
      return t ? `on ${t.node}${t.vmid !== null ? `, guest ${t.vmid}` : ''}` : null
    } catch (e: any) { return `whether one is could not be read: ${e?.message ?? e}` }
  }

  private async stopOnFailure(jobId: string, step: StepRecord, out: Outcome & { status: 'failed' }): Promise<void> {
    if (out.fatal) {
      await this.finish(jobId, 'failed', `${step.action} on ${step.target}: ${out.reason}`)
      return
    }
    await this.pause(jobId, `${step.action} on ${step.target} failed: ${out.reason}`)
  }

  private async runGuest(jobId: string, target: string, steps: StepRecord[], guest: GuestListing | undefined, policy: Policy): Promise<void> {
    // On a Resume the snapshot step already ran; its name is what a failed app step offers to roll back to.
    let snapshot: string | null = await this.snapshotOf(jobId, target)
    for (const step of steps.sort((a, b) => a.seq - b.seq)) {
      if (this.cancelRequested.has(jobId)) return
      if (!guest) { await this.setStep(step, { status: 'failed', reason: `guest ${target} is no longer in the cluster` }); return this.skipRest(steps, step) }
      const out = await this.runStep(jobId, step, async log => {
        switch (step.action) {
          case 'snapshot': {
            // A prefix test, not detailKey(): that takes the first word, and this marker is two words, so the
            // guard never matched and every bind-mounted guest asked Proxmox for a snapshot it refuses.
            if ((step.detail ?? '').startsWith(DETAIL.snapshotNone)) return { status: 'skipped', reason: 'no snapshot possible: bind-mounted storage' }
            const name = `${SNAPSHOT_PREFIX}${new Date(this.exec.now()).toISOString().replace(/[-:T]/g, '').slice(0, 12)}`
            await this.exec.snapshot(guest, name)
            snapshot = name
            return { status: 'ok', output: `snapshot ${name}` }
          }
          case 'apt':    return this.guestApt(guest, policy, log, snapshot)
          case 'apt-packages': return this.guestPackages(guest, policy, packagesOf(step.detail), log, snapshot)
          case 'docker': {
            // A chosen compose project: only that one, by its name and every config file Docker lists for it now
            // (never what the stored step says), or a policy directory by that directory.
            const key = /^compose-(dir|project) /.test(step.detail ?? '') ? composeKeyOf(step.detail) : undefined
            if (key === null) return { status: 'failed', reason: 'unreadable compose step' }
            if (key !== undefined) {
              const proj = await this.composeProjectNow(guest, policy, key)
              if (typeof proj === 'string') return { status: 'failed', reason: proj }
              // A project a plug-in's page manages has its own guarded update: refused here too, whatever the plan said.
              const owned = (await this.guardContext()).composeOwner?.(guest.vmid, proj)
              if (owned) return { status: 'skipped', reason: `${owned}; nothing was pulled` }
              const r = await this.exec.guestExec(guest, composeProjectScript(proj), log, 30 * 60_000)
              return r.code === 0 ? { status: 'ok', output: tail(r.output) } : { status: 'failed', reason: `containers not healthy${snapshot ? ` (snapshot ${snapshot})` : ''}`, output: tail(r.output) }
            }
            const g = await this.guardContext()
            const all = guestPolicy(policy, guest.vmid).composeDirs
            const left = all.filter(dir => !g.composeOwner?.(guest.vmid, { dir }))
            const kept = all.filter(dir => !left.includes(dir)).map(dir => `${dir}: ${g.composeOwner!(guest.vmid, { dir })}`)
            if (kept.length && !left.length) return { status: 'skipped', reason: `${kept.join('; ')}; nothing was pulled` }
            const dirs = left
            const r = await this.exec.guestExec(guest, guestDockerScript(dirs), log, 30 * 60_000)
            if (r.code === 0 && kept.length) return { status: 'ok', output: `${tail(r.output)}\nleft alone: ${kept.join('; ')}` }
            return r.code === 0 ? { status: 'ok', output: tail(r.output) } : { status: 'failed', reason: `containers not healthy${snapshot ? ` (snapshot ${snapshot})` : ''}`, output: tail(r.output) }
          }
          case 'app':
          case 'app-config': {
            if (!this.deps.apps) return { status: 'failed', reason: 'app updates are not available in this HyperProx' }
            return runAppStep(this.deps.apps, this.exec, guest, step.action, step.detail, snapshot, log)
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

  /** The hp-upd-* snapshot this job took of `target`, if it took one. */
  private async snapshotOf(jobId: string, target: string): Promise<string | null> {
    const s = (await this.store.getSteps(jobId)).find(x => x.target === target && x.action === 'snapshot' && x.status === 'ok')
    const m = /snapshot (hp-upd-[0-9]{12})/.exec(s?.output ?? '')
    return m ? m[1] : null
  }

  /**
   * Roll a guest back to the snapshot this job took, after one of its app steps failed. Only on a
   * person's request, only while the job is paused, and never for an HA-managed guest (HA owns its
   * state; the step's reason says how to do it by hand). The failed step is then marked skipped,
   * so Resume carries on with the rest of the run instead of updating the guest again.
   */
  async rollbackGuest(id: string, target: string, actor?: string): Promise<JobRecord> {
    const job = await this.mustGet(id)
    this.deps.checkJob?.(job)
    if (job.status !== 'paused') throw new JobStateError(`Job ${id} is ${job.status}; a rollback is offered only while it is paused`)
    const steps = await this.store.getSteps(id)
    const failed = steps.find(s => s.target === target && (s.action === 'app' || s.action === 'app-config') && s.status === 'failed')
    if (!failed) throw new JobStateError(`No failed app step for ${target} in job ${id}`)
    const snap = await this.snapshotOf(id, target)
    if (!snap) throw new JobStateError(`Job ${id} took no snapshot of ${target}; roll it back by hand as the step describes`)
    const guest = (await this.guestMap()).get(Number(target))
    if (!guest) throw new JobStateError(`No guest ${target}`)
    const sid = `${guest.type === 'lxc' ? 'ct' : 'vm'}:${guest.vmid}`
    if ((await this.exec.haResources()).includes(sid)) {
      throw new JobStateError(`${target} is HA-managed, so HyperProx will not roll it back: run \`ha-manager set ${sid} --state stopped\`, roll back to ${snap} in Proxmox, then \`ha-manager set ${sid} --state started\``)
    }
    const claimed = await this.transition(id, ['paused'], { status: 'running', pauseReason: `rolling ${target} back to ${snap}` })
    if (!claimed) throw new JobStateError(`Job ${id} is no longer paused`)
    await this.store.audit('updates.app.rollback', id, { target, snapshot: snap, ...auditBy(actor) })
    this.drive(id, async () => {
      try {
        await this.exec.rollbackSnapshot(guest, snap)
        await this.setStep(failed, { status: 'skipped', reason: `rolled back to ${snap} by ${actor ?? 'an admin'}: everything this run did to ${target} is undone` })
        for (const s of steps.filter(x => x.target === target && x.status === 'skipped' && x.reason === AFTER_GUEST_FAILURE)) {
          await this.setStep(s, { reason: `not run: ${target} was rolled back to ${snap}` })
        }
        await this.transition(id, ['running'], { status: 'paused', pauseReason: `${target} was rolled back to ${snap}. Press Resume to continue the run, or Cancel.` })
      } catch (e: any) {
        await this.transition(id, ['running'], { status: 'paused', pauseReason: `Rolling ${target} back to ${snap} failed: ${e.message}. Check the guest in Proxmox.` })
      }
    })
    return claimed
  }

  /** After a guest updated cleanly, keep only its newest hp-upd-* snapshot. Other snapshots are never touched. */
  private async pruneSnapshots(guest: GuestListing): Promise<void> {
    try {
      const ours = (await this.exec.listSnapshots(guest))
        .filter(s => s.name.startsWith(SNAPSHOT_PREFIX))
        .sort((a, b) => (b.snaptime ?? 0) - (a.snaptime ?? 0) || b.name.localeCompare(a.name))
      for (const old of ours.slice(1)) await this.exec.deleteSnapshot(guest, old.name)
    } catch (e: any) {
      this.log(`could not prune old snapshots of ${guest.vmid}: ${e.message}`, 'warn')
    }
  }

  private async skipRest(steps: StepRecord[], failed: StepRecord): Promise<void> {
    for (const s of steps.filter(x => x.seq > failed.seq)) await this.setStep(s, { status: 'skipped', reason: AFTER_GUEST_FAILURE })
  }

  /** Chosen packages in a guest: held ones are refused inside the guest, and nothing is installed new or removed. */
  private async guestPackages(guest: GuestListing, policy: Policy, pkgs: string[], log: LineSink, snapshot: string | null): Promise<Outcome> {
    if (!pkgs.length || pkgs.some(p => !PKG_NAME.test(p))) return { status: 'failed', reason: 'unreadable package list' }
    if (!guestPolicy(policy, guest.vmid).apt) return { status: 'failed', reason: `apt is off for ${guest.vmid} in the policy` }
    await this.cacheForGuest(guest, log)
    const r = await this.exec.guestExec(guest, guestPackagesScript(pkgs), log, 60 * 60_000)
    if (r.code !== 0) return { status: 'failed', reason: /refusing: /.test(r.output) ? (/refusing: [^\n]*/.exec(r.output)![0]) : `apt failed${snapshot ? ` (snapshot ${snapshot})` : ''}`, output: tail(r.output) }
    const wantsReboot = /HP_REBOOT_REQUIRED/.test(r.output)
    return { status: 'ok', output: tail(r.output) + (wantsReboot ? '\n(the guest asks for a reboot; a chosen package update does not reboot it)' : '') }
  }

  /** The chosen compose project as Docker lists it now (or a policy directory); a reason in words when it is not one. */
  private async composeProjectNow(guest: GuestListing, policy: Policy, key: string): Promise<{ name?: string; dir: string; files?: string[] } | string> {
    if (policy.guests[String(guest.vmid)]?.docker === 'none') return `docker is off for ${guest.vmid} in the policy`
    const r = await this.exec.guestExec(guest, COMPOSE_LS_SCRIPT, undefined, 60_000).catch((e: any) => ({ code: -1, output: String(e?.message ?? e), timedOut: false }))
    const ls = parseComposeLs(r.output)
    if (!key.startsWith('/')) {
      const p = ls.projects.find(x => x.name === key)
      return p ?? `${key} is no longer a compose project in ${guest.vmid}${ls.error ? ` (${ls.error})` : ''}; nothing was pulled`
    }
    const pol = guestPolicy(policy, guest.vmid)
    if (pol.docker !== 'none' && pol.composeDirs.includes(key)) return { dir: key }
    return `${key} is not a compose directory in the policy for ${guest.vmid}; nothing was pulled`
  }

  /** Was this step asked for by name (a ticked reboot row, the Reboot button)? From the plan, never the step's words. */
  private async forced(jobId: string, step: StepRecord): Promise<boolean> {
    const plan = (await this.store.getJob(jobId))?.plan
    return Boolean(plan?.forced?.includes(step.seq - (plan.stepOffset ?? 0)))
  }

  /**
   * Before any reboot sets a flag: the node's holds and kernel pin, read now, must be what its policy requires. A node
   * whose facts cannot be read, or whose pin or holds are gone, is not rebooted (it could come up on another kernel).
   */
  private async rebootGate(node: string, policy: Policy): Promise<{ facts: NodeFacts } | { stop: Outcome }> {
    let facts: NodeFacts
    try { facts = await this.nodeFacts(node) }
    catch (e: any) { return { stop: { status: 'failed', reason: `refusing to reboot ${node}: ${e?.message ?? e}. Nothing was changed.` } } }
    const g = holdsPinGate(node, facts, nodePolicy(policy, node))
    if (!g.ok) return { stop: { status: 'failed', reason: `refusing to reboot: ${g.reason}. Nothing was changed.` } }
    return { facts }
  }

  /**
   * What a node that keeps its kernel held or pinned must never get from an apt run: held packages, packages its
   * policy requires held, and any kernel, header or kernel metapackage. Ceph packages too, where Ceph runs. Null: fine.
   */
  private guardRefusal(policy: Policy, node: string, facts: NodeFacts, cephRuns: boolean): (name: string) => string | null {
    const pol = nodePolicy(policy, node)
    const guarded = nodeGuarded(policy, { node, held: facts.holds, pinned: facts.pinned })
    return (name: string) =>
      facts.holds.includes(name) ? `${name} is held`
        : pol.requireHolds.includes(name) ? `${name} must stay held (policy)`
        : guarded && isGuardedKernelPackage(name) ? `${name} moves the kernel, which ${node} keeps held or pinned`
        : isCephPackage(name) && cephRuns ? `${name} is a Ceph package (Ceph moves only through the Ceph item)` : null
  }

  /**
   * Chosen packages on a node: `apt-get install --only-upgrade`, after apt's own simulation shows exactly what moves.
   * Refused, with nothing installed, when the node's holds or pin cannot be read, when a required hold or the pin is
   * missing, or when anything that would move is held, required held, a Ceph package, or — on a node that keeps its
   * kernel held or pinned — a kernel, header or kernel metapackage. Never upgrade, dist-upgrade or full-upgrade.
   */
  private async nodePackages(jobId: string, node: string, pkgs: string[], policy: Policy, log: LineSink): Promise<Outcome> {
    if (!pkgs.length || pkgs.some(p => !PKG_NAME.test(p))) return { status: 'failed', reason: 'unreadable package list; nothing was installed' }
    const pol = nodePolicy(policy, node)
    let before: NodeFacts
    try { before = await this.nodeFacts(node) }
    catch (e: any) { return { status: 'failed', reason: `refusing to update packages on ${node}: ${e?.message ?? e}. Nothing was installed.` } }
    const pre = await this.combine([Promise.resolve(holdsPinGate(node, before, pol)), Promise.resolve(freeSpaceGate(node, before, policy))])
    if (!pre.ok) return { status: 'failed', reason: `stopped before installing: ${pre.reason}` }
    await this.cacheForNode(node, log)
    // A remote has no Ceph phase: its Ceph client libraries move like any package only where Ceph does not run.
    const cephRuns = this.remote ? await this.ceph(jobId) : true
    const refuse = this.guardRefusal(policy, node, before, cephRuns)
    const asked = pkgs.map(refuse).filter(Boolean)
    if (asked.length) return { status: 'failed', reason: `refusing: ${asked.join('; ')}. Nothing was installed.` }

    const sim = await this.exec.nodeExec(node, nodePackagesSimulateCommand(pkgs), undefined, 10 * 60_000)
    const parsed = sim.code === 0 ? parseAptSimulation(sim.output) : { changes: null, error: `the command exited ${sim.code}` }
    if (!parsed.changes) return { status: 'failed', reason: `could not simulate the update on ${node}, so nothing was installed: ${this.remote ? shortReason(parsed.error) : parsed.error}`, output: tail(sim.output) }
    const changes = parsed.changes
    const removed = changes.filter(c => c.action === 'remove').map(c => c.name)
    const pulled = changes.filter(c => c.action !== 'remove').map(c => refuse(c.name)).filter(Boolean)
    const fresh = changes.filter(c => c.action === 'install').map(c => c.name)
    if (removed.length || pulled.length || fresh.length) {
      const why = [removed.length ? `it would remove ${removed.join(', ')}` : '', fresh.length ? `it would install new packages (${fresh.join(', ')})` : '', ...pulled.map(p => `it would also move ${p}`)].filter(Boolean)
      return { status: 'failed', reason: `refusing: ${why.join('; ')}. Nothing was installed.`, output: tail(sim.output) }
    }
    log(`apt's simulation: ${changes.length} package${changes.length === 1 ? '' : 's'} move (${changes.map(c => `${c.name} ${c.from ?? ''} → ${c.to}`).join(', ')})`)

    // Exactly what the simulation showed, pinned: each chosen package at the version apt said it would install.
    const specs = pkgs.map(name => ({ name, version: changes.find(c => c.name === name)?.to ?? '' }))
    const missing = specs.filter(p => !p.version).map(p => p.name)
    if (missing.length) return { status: 'failed', reason: `refusing: apt's simulation does not upgrade ${missing.join(', ')}. Nothing was installed.`, output: tail(sim.output) }
    const r = await this.exec.nodeExec(node, nodePackagesCommand(specs as { name: string; version: string }[]), log, 60 * 60_000)
    if (r.code !== 0) return { status: 'failed', reason: 'apt-get install --only-upgrade failed', output: tail(r.output) }
    const svc = await this.exec.nodeExec(node, this.remote ? REMOTE_NODE_SERVICES_COMMAND : NODE_SERVICES_COMMAND, log, 60_000)
    if (svc.code !== 0) return { status: 'failed', reason: 'Proxmox services not all active after the update', output: tail(r.output + '\n' + svc.output) }
    let after: NodeFacts
    try { after = await this.nodeFacts(node) }
    catch (e: any) { return { status: 'failed', reason: `after the update: ${e?.message ?? e} — a person must look`, output: tail(r.output) } }
    const lost = before.holds.filter(h => !after.holds.includes(h))
    const problems = [
      holdsPinGate(node, after, pol).ok ? '' : holdsPinGate(node, after, pol).reason,
      lost.length ? `no longer on hold: ${lost.join(', ')}` : '',
      before.pinned && after.pinned !== before.pinned ? `the kernel pin changed from ${before.pinned} to ${after.pinned ?? 'none'}` : '',
      // On a node that keeps its kernel held or pinned, no kernel may appear or go.
      nodeGuarded(policy, { node, held: before.holds, pinned: before.pinned }) ? kernelsChanged(before, after) : '',
    ].filter(Boolean)
    if (problems.length) return { status: 'failed', reason: `after the update: ${problems.join('; ')} — not repaired; a person must look`, output: tail(r.output) }
    const v = await this.exec.nodeExec(node, installedVersionsCommand(changes.map(c => c.name)), undefined, 60_000)
    const off = readBackProblems(changes, parseInstalledVersions(v.output))
    if (off.length) return { status: 'failed', reason: `read-back: ${off.map(p => p.words).join('; ')}`, output: tail(r.output + '\nread-back:\n' + off.map(p => p.detail).join('\n')) }
    return { status: 'ok', output: tail(r.output) + `\nread-back: ${changes.length} package${changes.length === 1 ? '' : 's'} at the expected versions; holds and pin unchanged.` }
  }

  /** The package cache, just before apt in a guest (lib/updates/apt-cache.ts). Never fails the step. */
  private async cacheForGuest(guest: GuestListing, log: LineSink): Promise<void> {
    await prepareAptCache(this.deps.aptCache, this.cluster.id, { key: `${guest.type}-${guest.vmid}`, kind: 'guest', name: guest.name || String(guest.vmid) },
      script => this.exec.guestExec(guest, script, undefined, 60_000), log, () => this.exec.now())
  }

  /** The same on a node, only when the cluster's setting turns nodes on (or to take it out again). */
  private async cacheForNode(node: string, log: LineSink): Promise<void> {
    await prepareAptCache(this.deps.aptCache, this.cluster.id, { key: `node:${node}`, kind: 'node', name: node },
      script => this.exec.nodeExec(node, script, undefined, 60_000), log, () => this.exec.now())
  }

  private async guestApt(guest: GuestListing, policy: Policy, log: LineSink, snapshot: string | null): Promise<Outcome> {
    await this.cacheForGuest(guest, log)
    const r = await this.exec.guestExec(guest, GUEST_UPGRADE_SCRIPT, log, 60 * 60_000)
    if (r.code !== 0) return { status: 'failed', reason: `apt failed${snapshot ? ` (snapshot ${snapshot})` : ''}`, output: tail(r.output) }
    if (this.remote) {
      // Read-back: what apt would still upgrade now. Held and kept-back packages are expected to stay.
      const again = await this.exec.guestExec(guest, GUEST_PENDING_SCRIPT, undefined, 120_000).catch((e: any) => ({ code: -1, output: String(e?.message ?? e), timedOut: false }))
      if (again.code !== 0) return { status: 'failed', reason: 'upgraded, but the read-back could not run (see the output)', output: tail(r.output + '\nread-back:\n' + again.output) }
      const left = parseGuestPending(again.output).pending
      if (left.length) return { status: 'failed', reason: `upgraded, but apt still offers ${left.length} package${left.length === 1 ? '' : 's'}: ${left.map(p => p.name).join(', ')}${snapshot ? ` (snapshot ${snapshot})` : ''}`, output: tail(r.output + '\nstill offered:\n' + left.map(p => `${p.name} ${p.from ?? ''} -> ${p.to}`).join('\n')) }
      log('read-back: nothing left to upgrade (held and kept-back packages untouched)')
    }
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
    const sid = `${guest.type === 'lxc' ? 'ct' : 'vm'}:${guest.vmid}`
    const ha = (await this.exec.haResources()).includes(sid)
    if (ha) {
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

  private async dispatch(jobId: string, step: StepRecord, policy: Policy, log: LineSink, chosen = false): Promise<Outcome> {
    switch (step.action) {
      case 'ceph':           return this.cephStep(jobId, step, policy, log)
      case 'node-upgrade':   return this.nodeUpgrade(jobId, step.target, policy, log, chosen)
      case 'node-packages':  return this.nodePackages(jobId, step.target, packagesOf(step.detail), policy, log)
      case 'node-reboot':    return this.nodeReboot(jobId, step, policy, log)
      case 'kernel-cleanup': return this.kernelCleanup(step.target, log)
      case 'self':           return this.selfStep(jobId, step, policy, log)
      case 'guest-reboot':   return this.guestRebootStep(jobId, step, policy, log)
      default:               return { status: 'failed', reason: `unexpected action ${step.action}` }
    }
  }

  // --- Ceph ---------------------------------------------------------------------------

  private async cephStep(jobId: string, step: StepRecord, policy: Policy, log: LineSink): Promise<Outcome> {
    const [verb, arg] = (step.detail ?? '').split(/\s+/)
    if (verb === DETAIL.cephInstall) {
      const pending = (await this.exec.nodeAptPending(step.target)).filter(p => isCephPackage(p.name))
      if (!pending.length) return { status: 'skipped', reason: 'no Ceph packages pending any more' }
      const odd = pending.filter(p => p.to !== arg)
      if (odd.length) return { status: 'failed', reason: `${step.target} would install ${odd.map(p => `${p.name} ${p.to}`).join(', ')}, not ${arg}` }
      const r = await this.exec.nodeExec(step.target, cephInstallCommand(pending), log, 30 * 60_000)
      return r.code === 0 ? { status: 'ok', output: tail(r.output) } : { status: 'failed', reason: 'Ceph package install failed', output: tail(r.output) }
    }
    if (verb === DETAIL.cephRestart && arg === 'osd') return this.cephOsdRestart(jobId, step, policy, log)
    if (verb === DETAIL.cephRestart && (arg === 'mon' || arg === 'mgr')) {
      const daemon = arg
      // Ceph offers ok-to-stop for mons (and mds), not for mgrs. A no turns the step into a dry run.
      const peer = await this.peerOf(step.target)
      if (daemon === 'mon') {
        const m = await monVerdict(this.exec, step.target, peer)
        if (!m.ok && !m.ids.length) return { status: 'failed', reason: `${m.reason}; nothing was restarted` }
        if (!m.ok) {
          return {
            status: 'skipped',
            reason: `${SAFETY_SKIP} ${m.reason}. Restarting mon ${m.ids.join(', ')} on ${step.target} could cost the cluster its quorum, so it was not restarted.`,
            output: `would run: ${cephRestartCommand('mon')}`,
          }
        }
        log(`ok-to-stop: ${m.reason}`)
      }
      const baseline = await this.readState(peer)
      const r = await this.exec.nodeExec(step.target, cephRestartCommand(daemon), log, 10 * 60_000)
      if (r.code !== 0) return { status: 'failed', reason: `restarting ceph-${daemon} failed`, output: tail(r.output) }
      const settled = await this.cephSettle(policy, peer, baseline)
      if (!settled.ok) return { status: 'failed', reason: `Ceph did not settle after restarting ceph-${daemon} on ${step.target}: ${settled.last}` }
      return { status: 'ok', output: tail(r.output) + `\nCeph settled: ${settled.last}` }
    }
    return { status: 'failed', reason: `unknown Ceph step "${step.detail}"` }
  }

  /**
   * A node's OSDs, one at a time. First, read-only (ceph-checks.osdVerdict): every pool's size and min_size,
   * which PGs live on this node's OSDs, and `ceph osd ok-to-stop` for all of them together. If a pool with
   * no second copy (size=1) has data here, or any PG would drop below min_size, or Ceph says no, nothing is
   * restarted: the step is a dry run that says what would go offline. Otherwise noout is set, each OSD is
   * asked about again, restarted alone and waited for. noout is cleared only when every OSD came back; on any
   * failure it stays set, so a failed restart never starts data moving, and a critical notification says so.
   */
  private async cephOsdRestart(jobId: string, step: StepRecord, policy: Policy, log: LineSink): Promise<Outcome> {
    const node = step.target
    const peer = await this.peerOf(node)
    const v = await osdVerdict(this.exec, node, peer, 'restarting')
    if (v.kind === 'unreadable') return { status: 'failed', reason: `${v.reason}; nothing was restarted` }
    if (v.kind === 'none') return { status: 'ok', output: v.reason }
    const osds = v.osds
    const names = osdNames(osds)
    if (v.kind === 'unsafe') {
      return {
        status: 'skipped',
        reason: `${SAFETY_SKIP} ${v.reason}. Nothing on ${node} was restarted; its OSDs keep running the previous Ceph until they are restarted by hand at a time when that is acceptable.`,
        output: ['Dry run only. With it safe, this step would set noout and then, one at a time with a health check between:',
          ...osds.map(o => `would run: ${cephOsdRestartCommand(o)}`)].join('\n'),
      }
    }
    log(`ok-to-stop for ${names}: ${v.reason}`)

    const baseline = await this.readState(peer)
    await this.mustExec(peer, CEPH_NOOUT_SET, log)
    const done: string[] = []
    let out: Outcome
    try {
      out = await (async (): Promise<Outcome> => {
        for (const [i, id] of osds.entries()) {
          const rest = osds.slice(i + 1).map(o => `osd.${o}`)
          const left = rest.length ? `; ${rest.join(', ')} not restarted` : ''
          const each = parseOsdOkToStop((await this.exec.nodeExec(peer, cephOsdOkToStopCommand([id]), undefined, 60_000)).output)
          if (!each.ok) return { status: 'failed', reason: `stopped before osd.${id} on ${node}: ${each.reason}${left}` }
          const cmd = cephOsdRestartCommand(id)
          log(`${node}$ ${cmd}`)
          const r = await this.exec.nodeExec(node, cmd, log, 10 * 60_000)
          if (r.code !== 0) return { status: 'failed', reason: `restarting osd.${id} failed${left}`, output: tail(r.output) }
          const settled = await this.cephSettle(policy, peer, baseline, id)
          if (!settled.ok) return { status: 'failed', reason: `Ceph did not recover after restarting osd.${id} on ${node}: ${settled.last}${left}` }
          done.push(`osd.${id} back: ${settled.last}`)
          log(done[done.length - 1])
        }
        return { status: 'ok', output: done.join('\n') }
      })()
    } catch (e: any) {
      out = { status: 'failed', reason: e?.message ?? String(e) }
    }
    if (out.status === 'failed') {
      // Clearing noout now would let Ceph mark a down OSD out and start moving data. A person decides.
      const reason = `${out.reason}; noout is LEFT SET so no data moves — clear it by hand (ceph osd unset noout) once the OSDs are back`
      await this.announce({
        type: 'updates.ceph.noout_left_set', severity: 'critical',
        title: `Ceph noout is still set after a failed OSD restart on ${node}`,
        lines: [`${out.reason.replace(/\.$/, '')}.`, 'noout was left set on purpose so that no data starts moving.',
          'Bring the OSD back, then clear it with: ceph osd unset noout. Then resume or cancel the run on the Updates page.'],
      }, `${jobId}:noout`)
      return { ...out, reason }
    }
    const cleared = await this.exec.nodeExec(peer, CEPH_NOOUT_UNSET, log, 120_000).then(r => r.code === 0, () => false)
    if (!cleared) return { status: 'failed', reason: `${names} restarted, but noout could not be cleared — it is LEFT SET; clear it by hand (ceph osd unset noout)`, output: out.output }
    return { ...out, output: `${out.output ?? ''}\nnoout cleared` }
  }

  /**
   * Before a node reboot: the same strict check as an OSD restart, over every OSD on the node. `stop` is null
   * when the reboot may go ahead; otherwise the outcome to return. An unsafe reboot is skipped and left
   * pending. `osds` is the node's OSD set, for the own-node handoff to check again right before it reboots.
   */
  private async rebootSafety(jobId: string, node: string, log: LineSink): Promise<{ stop: Outcome | null; osds: number[] }> {
    if (!await this.ceph(jobId)) return { stop: null, osds: [] }
    const v = await osdVerdict(this.exec, node, await this.peerOf(node), 'rebooting')
    if (v.kind === 'unreadable') return { stop: { status: 'failed', reason: `${v.reason}; ${node} was not rebooted` }, osds: [] }
    if (v.kind === 'unsafe') {
      this.rebootPending.add(node)
      return {
        stop: { status: 'skipped', reason: `${SAFETY_SKIP} ${v.reason}. ${node} was not rebooted; its packages are installed and the reboot is pending — reboot it by hand in a maintenance window.` },
        osds: v.osds,
      }
    }
    log(`reboot safety: ${v.reason}`)
    return { stop: null, osds: v.kind === 'safe' ? v.osds : [] }
  }

  private async readState(peer: string): Promise<CephState> {
    return parseCephState((await this.exec.nodeExec(peer, CEPH_STATE_COMMAND, undefined, 120_000)).output)
  }

  /**
   * After a daemon restart: health back to accepted warnings, and the cluster back to the state before the
   * step by identity (ceph-safety.judgeRestoredState). After an OSD restart that OSD must itself be up and
   * in with none of its PGs degraded or undersized. The only OSD map flag that may appear during the step is
   * the noout this step set; any other (pause, nodown…) fails the gate, whatever accepted_warnings says.
   */
  private async cephSettle(policy: Policy, peer: string, before: CephState, restarted?: number): Promise<{ ok: boolean; last: string }> {
    let last = ''
    // Give the daemon a moment to drop out and rejoin, so the first read is not taken before it went down.
    await this.exec.sleep(this.timing.pollMs)
    const allowed = new Set([...before.flags, ...(restarted !== undefined ? ['noout'] : [])])
    const ok = await this.waitFor(async () => {
      const h = await this.exec.cephHealth()
      const now = await this.readState(peer)
      const extra = [...now.flags].filter(f => !allowed.has(f))
      const accepted = policy.acceptedWarnings.filter(c => c !== 'OSDMAP_FLAGS')
      if (!extra.length) accepted.push('OSDMAP_FLAGS')
      const a = judgeCeph(h, accepted)
      const b = extra.length ? { ok: false, reason: `OSD map flag${extra.length > 1 ? 's' : ''} set during the step: ${extra.join(', ')}` }
        : judgeRestoredState(before, now, restarted)
      last = !b.ok ? b.reason : !a.ok ? a.reason : b.reason
      return a.ok && b.ok
    }, this.timing.cephSettleMs)
    return { ok, last }
  }

  /** Whether noout is set right now. Throws when the OSD map cannot be read. */
  private async nooutSet(): Promise<boolean> {
    const s = await this.exec.clusterStatus()
    const node = s.nodes.filter(n => n.online).map(n => n.name).sort()[0]
    if (!node) throw new Error('no online node to read the Ceph OSD map from')
    const flags = parseOsdFlags((await this.exec.nodeExec(node, CEPH_OSD_DUMP_COMMAND, undefined, 60_000)).output)
    if (!flags) throw new Error('could not read the Ceph OSD map flags')
    return flags.has('noout')
  }

  /**
   * Between steps noout is never ours: a run sets it only inside a step and clears it before the step ends,
   * unless an OSD failed to come back. So noout here was left by an earlier run, a crash, or a person, and
   * nothing restarts or reboots while it is set. Checked by name, so accepted_warnings cannot hide it.
   */
  private async nooutGate(jobId: string): Promise<GateResult> {
    if (!await this.ceph(jobId)) return { ok: true, reason: 'no Ceph on this cluster' }
    try {
      return await this.nooutSet()
        ? { ok: false, reason: STALE_NOOUT }
        : { ok: true, reason: 'noout not set' }
    } catch (e: any) { return { ok: false, reason: `could not tell whether Ceph noout is set: ${e.message}` } }
  }

  private async announceStaleNoout(jobId: string, when: string): Promise<void> {
    await this.announce({
      type: 'updates.ceph.noout_set', severity: 'critical',
      title: 'Ceph noout is set — Updates will not restart or reboot anything',
      lines: [`Found ${when}.`, `${STALE_NOOUT}.`],
    }, `${jobId}:noout-stale`)
  }

  // --- Nodes ---------------------------------------------------------------------------

  /** The node's holds, pin and kernels. Throws when they cannot be read whole: unknown is never "none". */
  private async nodeFacts(node: string): Promise<NodeFacts> {
    const r = await this.exec.nodeExec(node, NODE_FACTS_COMMAND, undefined, 60_000)
    const f = r.code === 0 ? parseNodeFacts(r.output) : null
    if (!f) throw new Error(`${node}'s package holds and kernel pin could not be read (${r.code === 0 ? 'incomplete answer' : `the command exited ${r.code}`})`)
    return f
  }

  private async nodeUpgrade(jobId: string, node: string, policy: Policy, log: LineSink, chosen = false): Promise<Outcome> {
    // The node's policy, read now, decides upgrade vs dist-upgrade — never the stored plan — and so does what is
    // on the node: held packages or a pinned kernel mean `upgrade` unless the policy names this node for more.
    const pol = nodePolicy(policy, node)
    // Unknown holds or pin refuse the upgrade, whatever the policy says (a pinned kernel must never be moved by a
    // dist-upgrade nobody could check).
    let before: NodeFacts
    try { before = await this.nodeFacts(node) }
    catch (e: any) { return { status: 'failed', reason: `refusing to upgrade ${node}: ${e?.message ?? e}. Nothing was installed.` } }
    const pre = await this.combine([Promise.resolve(holdsPinGate(node, before, pol)), Promise.resolve(freeSpaceGate(node, before, policy))])
    if (!pre.ok) return { status: 'failed', reason: `stopped before installing: ${pre.reason}` }
    await this.cacheForNode(node, log)
    const picked = effectiveUpgrade(policy, node, before)
    // A chosen node that keeps its kernel held or pinned gets apt-get upgrade, never dist-upgrade, whatever the policy.
    // A chosen node with any hold at all (a DKMS module, a driver, a kernel), or a pinned kernel, gets apt-get upgrade,
    // never dist-upgrade, whatever the policy: dist-upgrade may remove or replace what the hold protects.
    const strict = chosen && (before.holds.length > 0 || nodeGuarded(policy, { node, held: before.holds, pinned: before.pinned })) && picked.verb !== 'upgrade'
    const choice = strict ? { verb: 'upgrade' as const, note: `${node} holds packages or keeps its kernel pinned, so a chosen update gives it apt-get upgrade, never dist-upgrade.` } : picked
    const verb = choice.verb
    if (choice.note) log(choice.note)
    const said = choice.note ? `${choice.note}\n` : ''

    // Ceph moves only in the Ceph phase (one exact version, daemons in order). If the upgrade would touch a
    // Ceph package — one that arrived after the plan, say — the step refuses. No apt-mark hold: a hold
    // HyperProx placed and failed to lift would block the Ceph phase itself later.
    const sim = await this.exec.nodeExec(node, nodeSimulateCommand(verb), undefined, 10 * 60_000)
    const parsed = sim.code === 0 ? parseAptSimulation(sim.output) : { changes: null, error: `the command exited ${sim.code}` }
    if (!parsed.changes) return { status: 'failed', reason: `could not simulate apt-get ${verb} on ${node}, so nothing was installed: ${this.remote ? shortReason(parsed.error) : parsed.error}`, output: tail(sim.output) }
    const changes = parsed.changes
    // A node that keeps its kernel held or pinned: nothing in the simulation may be held, required held, or move a
    // kernel (proxmox-kernel-helper, a headers metapackage...). Then nothing is installed at all.
    const guardedNode = nodeGuarded(policy, { node, held: before.holds, pinned: before.pinned })
    if (guardedNode) {
      const refuseOne = this.guardRefusal(policy, node, before, false)
      const bad = changes.map(c => refuseOne(c.name)).filter(Boolean)
      if (bad.length) return { status: 'failed', reason: `refusing: apt-get ${verb} on ${node} would also move ${bad.join('; ')}. Nothing was installed; choose single packages instead.`, output: tail(sim.output) }
    }
    const ceph = changes.filter(c => isCephPackage(c.name))
    // On a remote cluster there is no Ceph phase. Ceph client libraries on a server that runs no Ceph move with
    // the node like any other package; with Ceph running, the upgrade refuses as it does at home.
    const cephHere = ceph.length > 0 && (!this.remote || await this.ceph(jobId))
    if (cephHere && this.remote) {
      return { status: 'failed', reason: `refusing: apt-get ${verb} on ${node} would also change Ceph packages, and this cluster runs Ceph. HyperProx restarts Ceph daemons in order only on the home cluster; upgrade this node by hand` }
    }
    if (cephHere) {
      const what = ceph.map(c => c.action === 'remove' ? `${c.name} removed` : `${c.name} ${c.from ?? 'new'} → ${c.to}`).join(', ')
      return {
        status: 'failed',
        reason: `refusing: apt-get ${verb} on ${node} would also change Ceph packages (${what}). Ceph is upgraded only in the Ceph phase, to one exact version on every node with its daemons restarted in order — start a new run so the plan includes it`,
      }
    }

    const r = await this.exec.nodeExec(node, nodeUpgradeCommand(verb), log, 60 * 60_000)
    if (r.code !== 0) return { status: 'failed', reason: `apt-get ${verb} failed`, output: tail(said + r.output) }

    const svc = await this.exec.nodeExec(node, this.remote ? REMOTE_NODE_SERVICES_COMMAND : NODE_SERVICES_COMMAND, log, 60_000)
    if (svc.code !== 0) return { status: 'failed', reason: 'Proxmox services not all active after the upgrade', output: tail(r.output + '\n' + svc.output) }

    let afterFacts: NodeFacts
    try { afterFacts = await this.nodeFacts(node) }
    catch (e: any) { return { status: 'failed', reason: `after the upgrade: ${e?.message ?? e} — a person must look`, output: tail(said + r.output) } }
    const after = holdsPinGate(node, afterFacts, pol)
    if (!after.ok) return { status: 'failed', reason: `after the upgrade: ${after.reason} — not repaired; a person must look`, output: tail(said + r.output) }
    const kern = guardedNode ? kernelsChanged(before, afterFacts) : ''
    if (kern) return { status: 'failed', reason: `after the upgrade: ${kern} — not repaired; a person must look`, output: tail(said + r.output) }
    if (!this.remote) return { status: 'ok', output: tail(said + r.output) }

    // Read-back (remote): every package where apt said it would land, held packages still held, the API answering.
    // The reason (which reaches the pause, the audit log and notifications) names packages only; versions and
    // anything an error said go in the step's output.
    const words: string[] = []
    const details: string[] = []
    const held = before.holds.filter(h => !afterFacts.holds.includes(h))
    if (held.length) { const w = `no longer on hold: ${held.join(', ')} (HyperProx never removes a hold; a person must look)`; words.push(w); details.push(w) }
    if (before.pinned && afterFacts.pinned !== before.pinned) {
      words.push('the kernel pin changed (HyperProx never moves a pin; a person must look)')
      details.push(`the kernel pin changed from ${before.pinned} to ${afterFacts.pinned ?? 'none'}`)
    }
    const v = await this.exec.nodeExec(node, installedVersionsCommand(changes.map(c => c.name)), undefined, 60_000)
    for (const p of readBackProblems(changes, parseInstalledVersions(v.output))) { words.push(p.words); details.push(p.detail) }
    try { await this.exec.clusterStatus() } catch (e: any) { words.push('the Proxmox API did not answer after the upgrade'); details.push(`Proxmox API: ${e.message}`) }
    const reboot = this.rebootNeeded(afterFacts) ? ` A reboot is needed (${afterFacts.runningKernel ?? 'unknown'} is running); HyperProx does not reboot this node on its own.` : ''
    if (reboot) this.rebootPending.add(node)
    if (words.length) return { status: 'failed', reason: shortReason(`read-back after apt-get ${verb}: ${words.join('; ')}`, 400), output: tail(said + r.output + '\nread-back:\n' + details.join('\n')) }
    return { status: 'ok', output: tail(said + r.output) + `\nread-back: ${changes.length} package${changes.length === 1 ? '' : 's'} at the expected versions; holds and pin unchanged.${reboot}` }
  }

  private rebootNeeded(f: NodeFacts): boolean { return nodeRebootNeeded(f) }

  /**
   * Wait out viewers. Re-checks every streamRecheckMs until window_hours from the
   * run's start; then the reboot is skipped and left pending — never forced.
   */
  private async waitForQuiet(jobId: string, policy: Policy, log: LineSink): Promise<GateResult> {
    // An automatic reboot run waits within its own window, as its settings say ("only when nobody is watching").
    const rr = await this.rebootRunOf(jobId)
    const windowEnd = rr ? Date.parse(rr.windowEnd) : (this.runStartedAt.get(jobId) ?? this.exec.now()) + policy.schedule.windowHours * 3_600_000
    const pol = rr ? { ...policy, plexBlocksReboots: rr.quiet || policy.plexBlocksReboots } : policy
    const every = rr ? (this.timing.rebootStreamRecheckMs ?? DEFAULT_TIMING.rebootStreamRecheckMs!) : this.timing.streamRecheckMs
    for (;;) {
      const g = await streamGate(this.exec, pol)
      if (g.ok) return g
      if (this.exec.now() + every > windowEnd) return { ok: false, reason: rr ? `${g.reason} until the reboot window closed` : `${g.reason} until the ${policy.schedule.windowHours} h window closed` }
      log(`${g.reason} — re-checking in ${Math.round(every / 60_000)} min`)
      await this.exec.sleep(every)
      if (this.cancelRequested.has(jobId)) return { ok: false, reason: 'cancelled while waiting for streams to end' }
    }
  }

  private async nodeReboot(jobId: string, step: StepRecord, policy: Policy, log: LineSink): Promise<Outcome> {
    const node = step.target
    const forced = await this.forced(jobId, step)
    if (detailKey(step) === DETAIL.rebootManual) {
      this.rebootPending.add(node)
      return { status: 'skipped', reason: 'reboot: manual — reboot pending' }
    }
    if (detailKey(step) === DETAIL.rebootStandalone) return this.standaloneReboot(step, policy, log)
    // A remote node is never rebooted as part of a run, whatever a stored plan says.
    if (this.remote) { this.rebootPending.add(node); return { status: 'skipped', reason: 'reboot: manual — reboot pending' } }
    // Automatic reboots: the node's policy, read now, must still opt in (reboot: auto, and not auto_reboot: false).
    if (await this.rebootRunOf(jobId)) { const refusal = nodePolicyRefusal(policy, node); if (refusal) return { status: 'skipped', reason: refusal } }
    const resumed = Boolean(step.startedAt)   // a previous attempt began; flags may be set
    const gate = await this.rebootGate(node, policy)
    if ('stop' in gate) return resumed ? { ...gate.stop, reason: `${(gate.stop as { reason: string }).reason} An earlier attempt may have left HA maintenance or noout on; check before clearing them.` } as Outcome : gate.stop
    const ceph = await this.ceph(jobId)
    const peer = await this.peerOf(node)

    if (!forced && !this.rebootNeeded(gate.facts)) {
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
    const first = await this.rebootSafety(jobId, node, log)
    if (first.stop) return first.stop

    // The wait for viewers can be hours: the holds and pin read before it are read again right before any flag.
    const fresh = await this.rebootGate(node, policy)
    if ('stop' in fresh) return fresh.stop
    // Automatic reboots: never a reboot that costs quorum; a node whose guests cannot move gets no HA maintenance
    // (HA restarts them in place); what runs on it now is checked back afterwards.
    const rr = await this.rebootRunOf(jobId)
    let maintenance = true
    let before: Awaited<ReturnType<UpdatesRunner['snapshotRunning']>> = []
    if (rr) {
      const q = rebootQuorumGate(await this.exec.clusterStatus(), node)
      if (!q.ok) return { status: 'failed', reason: `${q.reason}; ${node} was not rebooted` }
      log(q.reason)
      const stuck = await this.immovableOn(node)
      if (stuck.length) {
        const sp = await this.inPlaceGate()
        if (!sp.ok) return { status: 'failed', reason: `guests on ${node} cannot move (${stuck.join('; ')}) and ${sp.reason}; nothing was changed` }
        maintenance = false; log(`guests that cannot move: ${stuck.join('; ')} — no HA maintenance; HA restarts them on ${node} when it is back (${sp.reason})`)
      }
      before = await this.snapshotRunning(node)
      await this.noteReboot(jobId, node, { kernelBefore: fresh.facts.runningKernel, inPlace: !maintenance, flags: { maintenance, noout: ceph } })
    }
    const flagWords = [maintenance ? 'maintenance' : '', ceph ? 'noout' : ''].filter(Boolean).join(' and ') || 'nothing to clear'
    const bootBefore = await this.bootId(node)
    await this.setFlags(peer, node, ceph, log, maintenance)
    const drained = !maintenance || await this.waitFor(async () =>
      !(await this.exec.haStatus()).services.some(s => s.node === node && !['stopped', 'disabled', 'ignored'].includes(s.state)),
      this.timing.haDrainMs)
    if (!drained) {
      // The node never went down, so nothing is at risk from undoing the flags.
      await this.clearFlags(peer, node, ceph, log, maintenance)
      return { status: 'failed', reason: `HA could not move every guest off ${node}; ${flagWords} cleared, node not rebooted` }
    }
    // The drain can take minutes: check again right before the reboot. The node never went down, so the flags come off.
    const late = await this.rebootSafety(jobId, node, log)
    if (late.stop) {
      await this.clearFlags(peer, node, ceph, log, maintenance)
      return { ...late.stop, reason: `${late.stop.reason} (checked again after HA moved the guests; ${flagWords} cleared)` } as Outcome
    }

    // And once more right before the reboot: the drain can take minutes. The node never went down, so the flags come off.
    const atReboot = await this.rebootGate(node, policy)
    if ('stop' in atReboot) {
      await this.clearFlags(peer, node, ceph, log, maintenance)
      return { ...atReboot.stop, reason: `${(atReboot.stop as { reason: string }).reason} (checked again after HA moved the guests; ${flagWords} cleared)` } as Outcome
    }
    // Right before the command: quorum, every node online, and (automatic reboots) still quorate with it gone.
    const lastQ = await this.quorumNow(node, peer, !!rr)
    if (!lastQ.ok) {
      await this.clearFlags(peer, node, ceph, log, maintenance)
      return { status: 'failed', reason: `${lastQ.reason}; ${flagWords} cleared, ${node} not rebooted` }
    }
    log(`rebooting ${node}`)
    const sentAt = this.exec.now()
    let sent: { code: number; output: string; timedOut: boolean } | null = null
    try { sent = await this.exec.nodeExec(node, NODE_REBOOT_COMMAND, log, 30_000) }
    catch { /* the connection drops as the node goes down; that is the point */ }
    if (sent && sent.code > 0 && !sent.timedOut) {
      await this.clearFlags(peer, node, ceph, log, maintenance)
      return { status: 'failed', reason: `${node} refused the reboot (${tail(sent.output, 200).trim()}); ${flagWords} cleared`, output: sent.output }
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
      const downSeconds = Math.round((this.exec.now() - sentAt) / 1000)
      // Outside the poll loop: a flag that will not clear is its own failure, not "still waiting".
      this.rebootPending.delete(node)
      await this.clearFlags(peer, node, ceph, log, maintenance)
      const said = `${node} rebooted (new boot id) and back; ${last}; ${maintenance ? 'maintenance off' : 'no HA maintenance (guests restarted in place)'}${ceph ? ', noout cleared' : ''}`
      if (!rr) return { status: 'ok', output: said }
      const after = await this.nodeFacts(node).catch(() => null)
      await this.noteReboot(jobId, node, { kernelAfter: after?.runningKernel ?? null, downSeconds })
      const g = await this.guestsBack(jobId, node, before, policy, log)
      return g.ok ? { status: 'ok', output: `${said}\nkernel ${after?.runningKernel ?? 'unknown'}; ${g.reason}` } : { status: 'failed', reason: g.reason, output: said }
    }
    this.rebootPending.add(node)
    if (upButSameBoot) {
      // Up the whole time: nothing is at risk, so the flags come off, but the step did not do its job.
      await this.clearFlags(peer, node, ceph, log, maintenance)
      return { status: 'failed', reason: `${node} never rebooted (its boot id did not change); ${flagWords} cleared` }
    }
    return {
      status: 'failed', fatal: true,
      reason: maintenance
        ? `${node} did not come back within ${Math.round(this.timing.nodeReturnMs / 60_000)} min (${last}). ${ceph ? 'noout and ' : ''}HA maintenance ${ceph ? 'are' : 'is'} LEFT ON so data does not move; clear them by hand once the node is healthy.`
        : `${node} did not come back within ${Math.round(this.timing.nodeReturnMs / 60_000)} min (${last}).${ceph ? ' noout is LEFT ON so data does not move; clear it once every OSD is back.' : ''}`,
    }
  }

  /**
   * A one-node server, rebooted on a person's request. Nothing to drain and no flags to set: its running guests
   * stop with it. Waits for a new boot id, then reads back the running kernel and which guests came back.
   */
  private async standaloneReboot(step: StepRecord, policy: Policy, log: LineSink): Promise<Outcome> {
    const node = step.target
    const status = await this.exec.clusterStatus()
    if (!status.standalone) return { status: 'failed', reason: `${node} is no longer a one-node server; nothing was rebooted` }
    const gate = await this.rebootGate(node, policy)
    if ('stop' in gate) return gate.stop
    const before = await this.runningGuestsOn(node)
    log(before.length ? `running now, will stop: ${before.map(g => `${g.vmid} (${g.name})`).join(', ')}` : 'no guests running')
    const bootBefore = await this.bootId(node)
    // Read again right before the reboot (reading the guests and the boot id took time).
    const fresh = await this.rebootGate(node, policy)
    if ('stop' in fresh) return fresh.stop
    log(`rebooting ${node}`)
    let sent: { code: number; output: string; timedOut: boolean } | null = null
    try { sent = await this.exec.nodeExec(node, NODE_REBOOT_COMMAND, log, 30_000) }
    catch { /* the connection drops as the node goes down */ }
    if (sent && sent.code > 0 && !sent.timedOut) return { status: 'failed', reason: `${node} refused the reboot (see the output)`, output: sent.output }

    const deadline = this.exec.now() + this.timing.nodeReturnMs
    await this.exec.sleep(this.timing.rebootSettleMs)
    let last = 'not back yet'
    let back = false
    while (this.exec.now() < deadline) {
      try {
        const s = await this.exec.clusterStatus()
        if (!s.nodes.find(x => x.name === node)?.online) last = `${node} not online`
        else if ((await this.bootId(node)) === bootBefore) last = `${node} has the same boot id: it has not rebooted`
        else { back = true; break }
      } catch (e: any) { last = e.message }
      await this.exec.sleep(this.timing.pollMs)
    }
    if (!back) {
      this.rebootPending.add(node)
      return { status: 'failed', fatal: true, reason: `${node} did not come back within ${Math.round(this.timing.nodeReturnMs / 60_000)} min (${shortReason(last)}). Nothing else was changed; check the server's console.`, output: last }
    }
    this.rebootPending.delete(node)
    const facts = await this.nodeFacts(node).catch(() => null)
    const wanted = before.filter(g => g.onboot)
    await this.waitFor(async () => {
      const running = new Set((await this.exec.listGuests()).filter(g => g.running).map(g => g.vmid))
      return wanted.every(g => running.has(g.vmid))
    }, this.timing.guestBootMs)
    const running = new Set((await this.exec.listGuests().catch(() => [])).filter(g => g.running).map(g => g.vmid))
    const up = before.filter(g => running.has(g.vmid)).map(g => `${g.vmid} (${g.name})`)
    const missing = wanted.filter(g => !running.has(g.vmid)).map(g => `${g.vmid} (${g.name})`)
    const stopped = before.filter(g => !g.onboot && !running.has(g.vmid)).map(g => `${g.vmid} (${g.name})`)
    const words = [
      `${node} rebooted (new boot id); running kernel ${facts?.runningKernel ?? 'unknown'}.`,
      up.length ? `Running again: ${up.join(', ')}.` : '',
      stopped.length ? `Still stopped (not set to start at boot): ${stopped.join(', ')}.` : '',
    ].filter(Boolean).join(' ')
    if (missing.length) return { status: 'failed', reason: `${words} Set to start at boot but NOT running: ${missing.join(', ')}.`, output: words }
    return { status: 'ok', output: words }
  }

  private async bootId(node: string): Promise<string> {
    const r = await this.exec.nodeExec(node, BOOT_ID, undefined, 20_000)
    const id = r.output.trim()
    if (r.code !== 0 || !/^[0-9a-f-]{36}$/.test(id)) throw new Error(`could not read ${node}'s boot id`)
    return id
  }

  /** noout, then HA maintenance. If maintenance cannot be turned on, noout comes back off before failing. */
  private async setFlags(peer: string, node: string, ceph: boolean, log: LineSink, maintenance = true): Promise<void> {
    if (ceph) await this.mustExec(peer, CEPH_NOOUT_SET, log)
    if (!maintenance) return
    try { await this.mustExec(peer, haMaintenance(node, true), log) }
    catch (e: any) {
      if (!ceph) throw e
      const undo = await this.exec.nodeExec(peer, CEPH_NOOUT_UNSET, log, 120_000).catch(() => ({ code: -1 }))
      throw new Error(`${e.message}; ${undo.code === 0 ? 'noout cleared again' : 'noout is LEFT ON — clear it by hand'}`)
    }
  }

  /** Both flags off, each tried even if the other fails; any left on is named in the error. */
  private async clearFlags(peer: string, node: string, ceph: boolean, log: LineSink, maintenance = true): Promise<void> {
    const left: string[] = []
    if (maintenance) { try { await this.mustExec(peer, haMaintenance(node, false), log) } catch { left.push(`HA maintenance on ${node}`) } }
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
      if (await this.rebootRunOf(jobId)) { const refusal = nodePolicyRefusal(policy, node); if (refusal) return { status: 'skipped', reason: refusal } }
      const forced = await this.forced(jobId, step)
      const gate = await this.rebootGate(node, policy)
      if ('stop' in gate) return gate.stop
      if (!forced && !this.rebootNeeded(gate.facts)) return { status: 'skipped', reason: 'no reboot needed' }
      const quiet = await this.waitForQuiet(jobId, policy, log)
      if (!quiet.ok) { this.rebootPending.add(node); return { status: 'skipped', reason: `${quiet.reason} — reboot pending` } }
      const again = await this.clusterGates(jobId, policy)
      if (!again.ok) return { status: 'failed', reason: `after waiting for viewers: ${again.reason}` }
      const first = await this.rebootSafety(jobId, node, log)
      if (first.stop) return first.stop
      const peer = await this.peerOf(node)
      const ceph = await this.ceph(jobId)
      // Read again right before the handoff sets anything: the wait for viewers can be hours.
      const fresh = await this.rebootGate(node, policy)
      if ('stop' in fresh) return fresh.stop
      // Automatic reboots: quorum kept, no maintenance where guests cannot move, and what runs here now is written
      // into the job first, so the check after the reboot can run in a HyperProx that restarted meanwhile.
      const rr = await this.rebootRunOf(jobId)
      let maintenance = true
      if (rr) {
        const q = rebootQuorumGate(await this.exec.clusterStatus(), node)
        if (!q.ok) return { status: 'failed', reason: `${q.reason}; ${node} was not rebooted` }
        log(q.reason)
        const stuck = await this.immovableOn(node)
        if (stuck.length) {
          const sp = await this.inPlaceGate()
          if (!sp.ok) return { status: 'failed', reason: `guests on ${node} cannot move (${stuck.join('; ')}) and ${sp.reason}; nothing was changed` }
          maintenance = false; log(`guests that cannot move: ${stuck.join('; ')} — no HA maintenance; HA restarts them on ${node} when it is back (${sp.reason})`)
        }
        await this.noteReboot(jobId, node, { kernelBefore: fresh.facts.runningKernel, inPlace: !maintenance, before: await this.snapshotRunning(node), flags: { maintenance, noout: ceph } })
      }
      await this.setStep(step, { detail: `${step.detail} · ${handoffTag(peer)}` })
      await startHandoff(this.exec, peer, jobId, step.id, selfNodeRebootScript(jobId, step.id, node, { ceph, osds: first.osds, waitMinutes: Math.round(this.timing.nodeReturnMs / 60_000), maintenance, quorum: rr ? 'votes' : 'plain' }))
      log(`handoff started on ${peer}; HyperProx may go away while ${node} reboots`)
      const out = await this.pollHandoff(jobId, step, peer)
      if (out.status === 'ok') this.rebootPending.delete(node)
      if (out.status === 'ok' && rr) return this.afterSelfReboot(jobId, step, policy, log, out)
      return out.status === 'failed' ? { ...out, fatal: true } : out
    }
    return { status: 'failed', reason: `unknown self step "${step.detail}"` }
  }

  private async pollHandoff(jobId: string, step: StepRecord, node: string): Promise<Outcome> {
    const deadline = this.exec.now() + this.timing.handoffMaxMs
    while (this.exec.now() < deadline) {
      try {
        const r = await readHandoff(this.exec, node, jobId, step.id)
        if (r && !r.ok && r.message.startsWith(SAFETY_SKIP)) {
          // The script's own check right before the reboot said no: nothing rebooted, flags cleared.
          this.rebootPending.add(step.target)
          return { status: 'skipped', reason: r.message }
        }
        if (r) return r.ok ? { status: 'ok', output: r.message } : { status: 'failed', reason: r.message }
      } catch (e: any) {
        if (/stopped without writing/.test(e.message)) return { status: 'failed', reason: e.message }
      }
      await this.exec.sleep(this.timing.handoffPollMs)
    }
    return { status: 'failed', reason: `no handoff result from ${node} within ${Math.round(this.timing.handoffMaxMs / 60_000)} min` }
  }

  /**
   * Automatic reboots, after HyperProx's own node is back: its kernel, roughly how long it was away (from the step's
   * start to the handoff's result), and the guests that were running on it, checked back.
   */
  private async afterSelfReboot(jobId: string, step: StepRecord, policy: Policy, log: LineSink, out: Outcome): Promise<Outcome> {
    const node = step.target
    const rr = await this.rebootRunOf(jobId)
    const after = await this.nodeFacts(node).catch(() => null)
    const t0 = step.startedAt ? new Date(step.startedAt).getTime() : null
    await this.noteReboot(jobId, node, { kernelAfter: after?.runningKernel ?? null, downSeconds: t0 ? Math.round((this.exec.now() - t0) / 1000) : null })
    const g = await this.guestsBack(jobId, node, rr?.results[node]?.before ?? [], policy, log)
    const said = `${out.output ?? ''}\nkernel ${after?.runningKernel ?? 'unknown'}; ${g.reason}`.trim()
    return g.ok ? { status: 'ok', output: said } : { status: 'failed', reason: g.reason, output: out.output }
  }

  private async collectHandoff(jobId: string, step: StepRecord): Promise<Outcome> {
    const node = handoffNodeOf(step.detail)!
    const polled = await this.pollHandoff(jobId, step, node)
    const load = this.deps.loadPolicy()
    const out = polled.status === 'ok' && detailKey(step) === DETAIL.selfReboot && await this.rebootRunOf(jobId)
      ? await this.afterSelfReboot(jobId, step, load.policy, () => {}, polled)
      : polled
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
    this.live.add(jobId)
    this.driving = this.driving.then(async () => {
      try { await fn() }
      catch (e: any) {
        this.log(`job ${jobId}: ${e?.stack ?? e}`, 'error')
        const job = await this.store.getJob(jobId).catch(() => null)
        if (job && job.status === 'running') await this.pause(jobId, `Internal error: ${e?.message ?? e}`).catch(() => {})
      } finally { this.live.delete(jobId) }
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
    // An automatic reboot run never waits half-done for a person: it stops, safe, and says what to do.
    if (await this.rebootRunOf(jobId).catch(() => null)) { await this.finish(jobId, 'failed', reason, undefined, ['running']); return }
    if (!await this.transition(jobId, ['running'], { status: 'paused', pauseReason: reason })) return
    await this.store.audit('updates.job.paused', jobId, { reason })
    const steps = await this.store.getSteps(jobId)
    await this.announce({
      type: 'updates.job.paused', severity: reportSeverity('paused', steps), title: 'Updates paused',
      lines: [`${reason.replace(/\.$/, '')}.`, 'Resume or cancel it on the Updates page.'],
    }, jobId)
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
    this.expectedHash.delete(jobId); this.onRunning.delete(jobId)
    for (const s of await this.store.getSteps(jobId)) {
      if (s.status === 'pending') await this.setStep(s, { status: 'skipped', reason: status === 'cancelled' ? 'cancelled' : 'the run stopped before this step' })
    }
    const rep = report ?? await this.buildReport(jobId, status, reason)
    const job = await this.setJob(jobId, { report: rep })
    await this.store.releaseLock(jobId)
    try { this.deps.onJobFinished?.() } catch (e: any) { this.deps.log?.(`[updates] after-job hook: ${e?.message ?? e}`, 'warn') }
    this.runStartedAt.delete(jobId)
    this.cephKnown.delete(jobId)
    const steps = await this.store.getSteps(jobId)
    if (job.plan?.reboots) { await this.announceRebootRun(jobId, status, reason, steps); return (await this.store.getJob(jobId)) ?? job }
    const count = (st: string) => steps.filter(x => x.status === st).length
    const severity = reportSeverity(status, steps)
    const safety = safetySkips(steps)
    const title = status === 'cancelled' ? 'Updates cancelled' : status === 'failed' ? 'Updates failed'
      : severity === 'info' ? 'Updates finished'
      : safety.length && !steps.some(x => x.status === 'failed') ? 'Updates finished with steps skipped for safety'
      : 'Updates finished with problems'
    await this.announce({
      type: 'updates.job.finished', severity, title,
      lines: [
        `${count('ok')} steps ok, ${count('skipped')} skipped, ${count('failed')} failed.`,
        ...safety.map(x => `${x.target}: ${withoutSafetyNote(x.detail) || x.action} ${x.reason}`),
        ...(reason && status !== 'done' ? [`${reason.replace(/\.$/, '')}.`] : []),
        ...(rep.rebootsPending.length ? [`Reboot pending: ${rep.rebootsPending.join(', ')}.`] : []),
      ],
    }, jobId)
    return job
  }

  private async buildReport(jobId: string, status: string, reason?: string): Promise<UpdatesReport> {
    const steps = await this.store.getSteps(jobId)
    const changed = new Map<string, number>()
    for (const s of steps.filter(x => x.status === 'ok' && ['apt', 'apt-packages', 'node-upgrade', 'node-packages', 'self', 'ceph', 'app'].includes(x.action))) {
      const n = s.action === 'app' ? 1 : Number(/\((\d+) package/.exec(s.detail ?? '')?.[1] ?? 0)
      if (s.action === 'self' && detailKey(s) !== DETAIL.selfGuest) continue
      changed.set(s.target, (changed.get(s.target) ?? 0) + n)
    }
    const skipped = steps.filter(s => s.status === 'skipped' && s.reason).map(s => ({ target: s.target, reason: `${s.action}: ${s.reason}` }))
    const count = (st: string) => steps.filter(s => s.status === st).length
    const pending = [...this.rebootPending].sort()
    const safety = safetySkips(steps)
    const job = await this.store.getJob(jobId)
    const items = job ? new Items(job.plan) : null
    const outcomes = items?.active ? items.outcomes(steps) : null
    const bad = outcomes?.filter(o => o.status !== 'ok') ?? []
    const head = status === 'done' ? (bad.length ? `Updates finished; ${bad.length} of ${outcomes!.length} chosen item${outcomes!.length === 1 ? '' : 's'} did not` : safety.length ? 'Updates finished with steps skipped for safety' : 'Updates finished')
      : status === 'cancelled' ? 'Updates cancelled' : 'Updates failed'
    return {
      ...(outcomes ? { items: outcomes } : {}),
      summary: `${head}: ${count('ok')} ok, ${count('skipped')} skipped, ${count('failed')} failed.` +
        (reason && status !== 'done' ? ` ${reason}.` : '') +
        (safety.length ? ` Skipped for safety, nothing restarted: ${safety.map(s => `${withoutSafetyNote(s.detail) || s.action} on ${s.target}`).join(', ')}.` : '') +
        (pending.length ? ` Reboot pending: ${pending.join(', ')}.` : ''),
      changed: [...changed].map(([target, packages]) => ({ target, packages })),
      skipped,
      rebootsPending: pending,
    }
  }

  /**
   * The summary of a rolling reboot: which nodes and guests rebooted, kernel before → after, how long each was away;
   * or, when it stopped, what happened, what was left on for safety, and the one fix. Also records what was left on
   * (read from the cluster, never assumed) for the Make safe action.
   */
  private async announceRebootRun(jobId: string, status: 'done' | 'failed' | 'cancelled', reason: string | undefined, steps: StepRecord[]): Promise<void> {
    const job = await this.store.getJob(jobId)
    const rr = job?.plan?.reboots
    if (!job || !rr) return
    let leftOn: UpdatesRebootRun['leftOn'] = null
    if (status === 'failed') {
      // Only what this run itself set: the node whose step failed if it set flags, else the last node it set them on.
      const failed = steps.find(x => x.status === 'failed' && (x.action === 'node-reboot' || x.action === 'self'))
      const withFlags = steps.filter(x => rr.results[x.target]?.flags && (x.action === 'node-reboot' || x.action === 'self') && x.status !== 'pending')
      const mine = (failed && rr.results[failed.target]?.flags ? failed : withFlags.at(-1)) ?? null
      const set = mine ? rr.results[mine.target].flags! : null
      if (mine && set && (set.maintenance || set.noout)) {
        try {
          const maint = set.maintenance && (await this.exec.haStatus()).maintenanceNodes.includes(mine.target)
          const noout = set.noout && await this.nooutSet()
          if (maint || noout) leftOn = { node: mine.target, maintenance: maint, noout }
        } catch {
          // Could not read: name what it set; Make safe reads the real state before clearing anything.
          leftOn = { node: mine.target, ...set }
        }
      }
      await this.store.updateJob(jobId, { plan: { ...job.plan, reboots: { ...rr, leftOn } } })
    }
    const mins = (s?: number | null) => (s == null ? '' : `, away about ${Math.max(1, Math.round(s / 60))} min`)
    const lines: string[] = []
    for (const x of steps.filter(s => s.action === 'node-reboot' || s.action === 'self' || s.action === 'guest-reboot')) {
      const r = rr.results[x.target] ?? {}
      const kernel = r.kernelBefore || r.kernelAfter ? `, kernel ${r.kernelBefore ?? '?'} → ${r.kernelAfter ?? '?'}` : ''
      const what = x.action === 'guest-reboot' ? `guest ${x.target}` : x.target
      lines.push(x.status === 'ok' ? `${what}: rebooted${kernel}${mins(r.downSeconds)}${r.inPlace ? ' (guests restarted in place)' : ''}.`
        : x.status === 'failed' ? `${what}: FAILED — ${x.reason ?? 'no reason recorded'}.`
        : `${what}: not rebooted — ${x.reason ?? x.status}.`)
    }
    if (rr.skipped.length) lines.push(`Left out: ${rr.skipped.map(x => `${x.target} (${x.reason})`).join('; ')}.`)
    const auto = rr.kind === 'window'
    if (status === 'failed') {
      lines.unshift(`${(reason ?? 'it stopped').replace(/\.$/, '')}.`)
      if (leftOn) {
        const on = [leftOn.maintenance ? `HA maintenance on ${leftOn.node}` : '', leftOn.noout ? 'Ceph noout' : ''].filter(Boolean).join(' and ')
        lines.push(`Left on for safety: ${on}. Fix: open Updates, Automatic reboots, and press Make safe once ${leftOn.node} is healthy (noout comes off only when every OSD is up).`)
      } else lines.push(auto ? 'Nothing was left on. The rest waits for the next window.' : 'Nothing was left on. Press Reboot now to try again.')
    }
    const title = status === 'failed' ? (auto ? 'Automatic reboots stopped' : 'Rolling reboot stopped')
      : status === 'cancelled' ? 'Rolling reboot cancelled' : (auto ? 'Automatic reboots finished' : 'Rolling reboot finished')
    await this.announce({
      type: status === 'failed' ? 'updates.reboots.stopped' : 'updates.reboots.finished',
      severity: status === 'failed' ? (leftOn ? 'critical' : 'warning') : steps.some(x => x.status === 'failed') ? 'warning' : 'info',
      title, lines,
    }, jobId)
  }

  /** One message per run outcome, through the notification bus. Never fails the job. */
  private async announce(e: Omit<NotifyEventInput, 'link' | 'where'>, jobId: string): Promise<void> {
    if (!this.deps.publish) return
    // A remote cluster's messages name it and link to its own Updates page.
    const c = this.cluster
    const ev = c.kind === 'remote'
      ? { ...e, title: `${c.name} (remote): ${e.title}`, plain: [...(e.plain ?? []), c.name], link: `/clusters/${c.id}/updates` }
      : { ...e, link: '/updates' }
    try { await this.deps.publish({ ...ev, where: 'Updates page', fingerprint: `updates.job:${jobId}` }) }
    catch (err: any) { this.log(`could not announce the job: ${err?.name ?? 'error'}`, 'warn') }
  }

  /** The plan-time safety note on every Ceph restart and node reboot. A check that cannot run says so. */
  private async startedRunning(jobId: string): Promise<void> {
    const f = this.onRunning.get(jobId)
    this.onRunning.delete(jobId)
    if (!f) return
    try { await f(jobId) } catch (e: any) { this.log(`[updates] after-start hook failed: ${e?.message ?? e}`, 'warn') }
  }

  private async withSafety(jobId: string, plan: UpdatesPlan): Promise<UpdatesPlan> {
    try { return await annotatePlanSafety(this.exec, plan, await this.ceph(jobId)) }
    catch (e: any) { return { ...plan, warnings: [...plan.warnings, `Ceph safety not checked at plan time: ${e?.message ?? e}`] } }
  }

  private async ceph(jobId: string): Promise<boolean> {
    const known = this.cephKnown.get(jobId)
    if (known !== undefined) return known
    const present = await this.exec.cephPresent()
    this.cephKnown.set(jobId, present)
    return present
  }

  private async cephGateFor(jobId: string, policy: Policy): Promise<GateResult> {
    try { return await this.combine([cephGate(this.exec, policy, await this.ceph(jobId)), this.nooutGate(jobId)]) }
    catch (e: any) { return { ok: false, reason: `could not tell whether Ceph is configured: ${e.message}` } }
  }

  /** Quorum, Ceph and HA: what must hold before anything that can take a machine down. */
  private async clusterGates(jobId: string, policy: Policy): Promise<GateResult> {
    if (this.remote) return this.combine([...await quorumHaGates(this.exec, true), this.cephGateFor(jobId, policy)].map(g => Promise.resolve(g)))
    return this.combine([quorumGate(this.exec), this.cephGateFor(jobId, policy), haGate(this.exec)])
  }

  /** The cluster gates, waited for up to cephSettleMs (never skipped): the last answer when they never pass. */
  private async settledGates(jobId: string, policy: Policy): Promise<GateResult> {
    let last: GateResult = { ok: false, reason: 'not checked' }
    await this.waitFor(async () => { last = await this.clusterGates(jobId, policy); return last.ok }, this.timing.cephSettleMs)
    return last
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

  private async inventory(policy: Policy, composeFor?: Set<number>): Promise<InventoryResult> {
    const opts = this.inventoryOptions()
    if (composeFor) opts.discoverCompose = composeFor
    const r = await readInventory(this.exec, policy, { rebootPending: this.rebootPending, hostname: this.deps.hostname, apps: this.deps.apps, ...opts })
    this.deps.onInventory?.(r)
    return r
  }

  /** How this cluster's inventory is read: home as always; a remote through apt's simulation, with backups. */
  inventoryOptions(): { noSelf?: boolean; nodePreview?: 'apt-simulation'; backups?: boolean; noSnapshotAck?: boolean; apps?: undefined; discoverCompose?: 'policy' | 'all' | Set<number> } {
    const compose = this.deps.discoverCompose ? { discoverCompose: 'policy' as const } : {}
    return this.remote ? { noSelf: true, nodePreview: 'apt-simulation', backups: true, noSnapshotAck: true, apps: undefined, ...compose } : compose
  }

  private selfVmid(inv: InventoryResult, policy: Policy): number | null {
    if (this.remote) return null
    return selfVmidOf(inv.inventory, policy, this.deps.hostname)
  }

  private async isSelfNode(node: string, policy: Policy): Promise<boolean> {
    if (this.remote) return false
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

  private log(msg: string, level?: 'warn' | 'error') { this.deps.log?.(`[updates] ${msg}`, level) }
}

/**
 * The items of a run of chosen targets, mapped onto the job's steps. Empty (inactive) for a run of the whole plan,
 * which keeps its own rules: a failed guest holds the node phase, a failed node step pauses the run.
 */
class Items {
  readonly active: boolean
  private bySeq = new Map<number, UpdatesPlanItem>()
  constructor(private plan: UpdatesPlan) {
    this.active = Array.isArray(plan.items)
    const off = plan.stepOffset ?? 0
    for (const it of plan.items ?? []) for (const q of it.seqs) this.bySeq.set(q + off, it)
  }
  of(step: { seq: number }): UpdatesPlanItem | undefined { return this.bySeq.get(step.seq) }
  dependents(id: string): UpdatesPlanItem[] { return (this.plan.items ?? []).filter(i => i.dependsOn.includes(id)) }
  /** Did this item finish without a failure? A step skipped for a routine reason (nothing left to do) counts as done. */
  private finished(it: UpdatesPlanItem, steps: StepRecord[]): boolean {
    const off = this.plan.stepOffset ?? 0
    const mine = steps.filter(s => it.seqs.includes(s.seq - off))
    // Old kernels left behind are untidy, not unsafe: a failed cleanup does not hold back what waits for the item.
    return mine.every(s => s.status === 'ok' || (s.action === 'kernel-cleanup' && s.status === 'failed')
      || (s.status === 'skipped' && !retryable(s.reason) && s.reason !== 'cancelled'))
  }
  /** True when an earlier step of `step`'s own item failed or was skipped for a reason that is not routine. */
  brokenBefore(step: StepRecord, steps: StepRecord[]): boolean {
    const it = this.of(step)
    if (!it) return false
    const off = this.plan.stepOffset ?? 0
    return steps.some(s => s.seq < step.seq && it.seqs.includes(s.seq - off) && s.action !== 'kernel-cleanup'
      && (s.status === 'failed' || (s.status === 'skipped' && retryable(s.reason))))
  }
  /** The label of the first prerequisite of `step`'s item that did not finish, or null. */
  async unmet(step: StepRecord, steps: StepRecord[]): Promise<string | null> {
    const it = this.of(step)
    if (!it) return null
    for (const d of it.dependsOn) {
      const dep = (this.plan.items ?? []).find(i => i.id === d)
      if (dep && !this.finished(dep, steps)) return dep.label
    }
    return null
  }
  /** Each item's outcome, for the report and the history. */
  outcomes(steps: StepRecord[]): UpdatesItemOutcome[] {
    const off = this.plan.stepOffset ?? 0
    return (this.plan.items ?? []).map(it => {
      const mine = steps.filter(s => it.seqs.includes(s.seq - off))
      const failed = mine.find(s => s.status === 'failed' && s.action !== 'kernel-cleanup')
      const skipped = mine.find(s => s.status === 'skipped' && (retryable(s.reason) || s.reason === 'cancelled' || /^the run stopped/.test(s.reason ?? '')))
      const status: UpdatesItemOutcome['status'] = failed ? 'failed' : skipped ? 'skipped'
        : mine.some(s => s.status === 'running') ? 'running' : mine.some(s => s.status === 'pending') ? 'pending'
        : mine.every(s => s.status === 'skipped') ? 'skipped' : 'ok'
      const why = failed?.reason ?? skipped?.reason ?? (status === 'skipped' ? mine.find(s => s.reason)?.reason : null) ?? null
      return { id: it.id, label: it.label, status, ...(why ? { reason: why } : {}) }
    })
  }
}

/** Installed kernels that appeared or went, in words, or '' when the set is the same. */
function kernelsChanged(before: NodeFacts, after: NodeFacts): string {
  const a = new Set(before.kernelPackages), b = new Set(after.kernelPackages)
  const added = [...b].filter(k => !a.has(k)), gone = [...a].filter(k => !b.has(k))
  if (!added.length && !gone.length) return ''
  return `installed kernels changed (${[added.length ? `added ${added.join(', ')}` : '', gone.length ? `removed ${gone.join(', ')}` : ''].filter(Boolean).join('; ')})`
}
