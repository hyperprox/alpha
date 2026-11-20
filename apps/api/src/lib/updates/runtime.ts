// =============================================================================
//  HyperProx — Updates: the running parts, built once
//
//  Every cluster's service (lib/updates/service.ts), the daily check, the
//  home scheduler, and the read-only sources other code reads from them (the
//  assistant's "what updates does X have", the check summary, the guard on a
//  cluster rename). lib/services/bootstrap.ts builds the production one and
//  starts it; routes/updates.ts only answers requests with it.
//
//  Building one starts nothing. recover() and start() are the start-up steps,
//  each called once by the composition root.
// =============================================================================

import { isUnlocked } from '../vault/state'
import { publish as publishEvent, type NotifyEventInput } from '../notify'
import { HOME_ID, clusterRow, listClusters, setRenameGuard } from '../clusters/registry'
import { loadPolicy as loadPolicyFile, renameRefusal, type PolicyLoad } from './policy'
import type { UpdatesExecutor } from './executor'
import type { RunnerTiming, UpdatesRunner } from './runner'
import { UpdatesScheduler } from './scheduler'
import type { UpdatesStore } from './store'
import { productionAppEnv, type AppEnv } from './apps'
import { UpdatesServices, type ClusterUpdates } from './service'
import { jobCluster } from './cluster-store'
import { UpdatesChecker, FileCheckState, type CheckStateStore } from './check'
import { setCheckSummarySource } from './check-summary'
import { setTargetsSource } from './targets-summary'
import { selfVmidOf } from './inventory'
import { buildTargets, type GuardContext } from './targets'
import { guardsFrom, homeGuards } from './guards'
import { lastComposeOwnership } from '../compose-owners'
import { busyJobs } from '../long-jobs'
import { productionAptCacheHook, type AptCacheHook } from './apt-cache'
import type { UpdatesInventory, UpdatesWsPayload } from './types'
import { AutoReboots } from './auto-reboots'
import { FileRebootState, type RebootStateStore } from './reboots'

export interface UpdatesRuntimeDeps {
  store:       UpdatesStore
  /** Home's executor. */
  exec?:       UpdatesExecutor
  /** A remote cluster's executor (tests); default the production one bound to that cluster. */
  remoteExec?: (clusterId: string) => UpdatesExecutor
  /** The policy file; its top level is home's, `clusters:` holds the remotes'. Default: the file on disk. */
  loadPolicy?: () => PolicyLoad
  /** Where the daily check keeps its result. Default data/updates-check.json. */
  checkState?: CheckStateStore
  /** The daily check's pauses between machines. */
  checkGapMs?: number
  /** Quiet time after a job ends before the check looks again (tests). */
  checkAfterJobMs?: number
  /** How HyperProx reaches a remote now (tests); default lib/pve-env.ts connectionKey. */
  connection?: (clusterId: string) => string
  hostname?:   string
  timing?:     Partial<RunnerTiming>
  /** App-update providers. Default: the bundled plug-ins' — but only with the production executor. */
  apps?:       AppEnv
  /** The notification bus; default the installed one (a no-op until it is installed). */
  publish?:    (e: NotifyEventInput) => Promise<void>
  /** Where job progress goes (the admin sockets: lib/updates/broadcast.ts). */
  emit?:       (payload: UpdatesWsPayload) => void
  /** What the plug-ins say about home guests (lib/updates/guards.ts); default read live. Tests set it. */
  guards?:     () => Promise<GuardContext>
  /** The package cache step before apt. Default: the package cache's service, but only with the production executor. */
  aptCache?:   AptCacheHook
  log:         (msg: string, level?: 'warn' | 'error') => void
  /** Automatic reboot settings, per cluster. Default data/updates-reboots.json. */
  rebootState?: RebootStateStore
  /** Whether HyperProx is unlocked (tests). Default the vault's state. */
  isUnlocked?: () => boolean
  /** The clock automatic reboots read their window with (tests). */
  now?:        () => number
}

export class UpdatesRuntime {
  readonly store: UpdatesStore
  readonly loadPolicy: () => PolicyLoad
  readonly apps: AppEnv | undefined
  /** The app-update providers a home plan may name. */
  readonly appProviders: string[] | undefined
  readonly services: UpdatesServices
  readonly checker: UpdatesChecker
  /** Home's runner (scheduled runs are home-only). */
  readonly runner: UpdatesRunner
  readonly hostname: string | undefined
  private readonly scheduler: UpdatesScheduler
  /** Automatic reboots: the window timer, the card's status and its actions. */
  readonly reboots: AutoReboots
  private readonly guardsDep: (() => Promise<GuardContext>) | undefined
  private readonly log: UpdatesRuntimeDeps['log']

  constructor(d: UpdatesRuntimeDeps) {
    this.store = d.store
    this.loadPolicy = d.loadPolicy ?? (() => loadPolicyFile())
    this.apps = d.apps ?? (d.exec ? undefined : productionAppEnv())
    this.appProviders = this.apps?.providers.map(r => r.provider.id)
    this.hostname = d.hostname
    this.guardsDep = d.guards
    this.log = d.log
    const publish = d.publish ?? publishEvent
    this.services = new UpdatesServices({
      store: d.store, exec: d.exec, remoteExec: d.remoteExec, loadPolicy: this.loadPolicy,
      hostname: d.hostname, timing: d.timing, apps: this.apps,
      publish, emit: d.emit, onJobFinished: () => this.checker?.jobEnded(),
      log: d.log, connection: d.connection, guards: d.guards,
      aptCache: d.aptCache ?? (d.exec ? undefined : productionAptCacheHook()),
    })
    this.runner = this.services.get(HOME_ID).runner
    this.checker = new UpdatesChecker({
      clusters: () => listClusters().map(c => {
        const s = this.services.get(c.id)
        return { ref: { id: c.id, name: c.name, kind: c.kind }, exec: s.exec, loadPolicy: s.loadPolicy, remote: s.remote }
      }),
      loadPolicy: this.loadPolicy, isUnlocked,
      activeJob: () => d.store.activeJob(),
      state: d.checkState ?? new FileCheckState(),
      publish,
      log: d.log,
      gapMs: d.checkGapMs, clusterGapMs: d.checkGapMs, afterJobMs: d.checkAfterJobMs,
    })
    // Scheduled runs are home-only. The daily check covers every cluster, read-only.
    this.scheduler = new UpdatesScheduler({ runner: this.runner, loadPolicy: this.loadPolicy, isUnlocked, busy: () => this.checker.running, log: d.log })
    this.reboots = new AutoReboots({
      service: id => this.services.get(id), state: d.rebootState ?? new FileRebootState(),
      isUnlocked: d.isUnlocked ?? isUnlocked, busy: () => this.checker.running, now: d.now, log: d.log, hostname: d.hostname,
    })
  }

  /** The service for one cluster. */
  get(clusterId: string): ClusterUpdates { return this.services.get(clusterId) }

  /** What the plug-ins say about home guests now: the compose projects their pages manage, their long jobs. */
  async guardsFor(s: ClusterUpdates): Promise<GuardContext> { return s.remote ? {} : (this.guardsDep ?? homeGuards)() }

  /** The same, from what was read last, for callers that cannot wait (the assistant's summary). */
  lastGuards(s: ClusterUpdates): GuardContext { return s.remote ? {} : guardsFrom(lastComposeOwnership(), busyJobs()) }

  /** What the tree is built from, for one cluster: the cached inventory, its policy and HyperProx's own guest. */
  treeFor(s: ClusterUpdates, inv: UpdatesInventory, guards: GuardContext = this.lastGuards(s)) {
    const load = s.loadPolicy()
    const selfVmid = s.remote ? null : selfVmidOf(inv, load.policy, this.hostname)
    return { load, selfVmid, guards, targets: buildTargets(inv, load.policy, { selfVmid, remote: s.remote, ...guards }) }
  }

  /**
   * The read-only sources other code asks: the check summary, the guard on a cluster rename, and the assistant's
   * "what updates does X have" (answered from what was last read, never by reading). Sets module-wide hooks, so the
   * composition root calls it once (tests that build routes without a runtime get one that calls it too).
   */
  installSources(): void {
    setCheckSummarySource(id => this.checker.summary(id))
    // A rename must not quietly attach a name-keyed policy section written for another server.
    setRenameGuard((c, newName) => { const l = this.loadPolicy(); return renameRefusal(l.loaded ? l.policy : null, c, newName) })
    setTargetsSource(id => {
      if (!clusterRow(id)) return null
      const s = this.services.get(id)
      const inv = s.cached()
      return inv ? { refreshedAt: inv.refreshedAt, cluster: { ...s.ref }, targets: this.treeFor(s, inv).targets } : null
    })
  }

  /** The database needs no vault, so a job interrupted by a restart is paused before anyone can press anything. */
  async recover(): Promise<void> {
    const failed = (e: any) => this.log(`[updates] restart recovery failed: ${e.message}`, 'error')
    await this.runner.recoverAfterRestart().catch(failed)
    const active = await this.store.activeJob().catch(() => null)
    const id = active ? jobCluster(active) : HOME_ID
    if (active && id !== HOME_ID) {
      if (clusterRow(id)) await this.services.get(id).runner.recoverAfterRestart().catch(failed)
      else {
        await this.store.transitionJob(active.id, ['planned', 'awaiting-confirm', 'running', 'paused'], { status: 'failed', pauseReason: 'Its cluster was removed from HyperProx; nothing more was done', finishedAt: new Date() })
        await this.store.releaseLock(active.id)
      }
    }
  }

  /** The home scheduler and the daily check's timer. Each waits for an unlocked HyperProx itself. Returns the stop. */
  start(): () => void {
    this.scheduler.start()
    this.checker.start()
    this.reboots.start()
    return () => { this.scheduler.stop(); this.checker.stop(); this.reboots.stop() }
  }
}

let production: UpdatesRuntime | null = null

/** The runtime lib/services/bootstrap.ts built. Throws before then: the routes are registered after it. */
export function updatesRuntime(): UpdatesRuntime {
  if (!production) throw new Error('Updates has not been started (lib/services/bootstrap.ts runs before the routes are registered).')
  return production
}
export function setUpdatesRuntime(r: UpdatesRuntime | null): void { production = r }
