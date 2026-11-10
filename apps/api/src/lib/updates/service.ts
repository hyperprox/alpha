// =============================================================================
//  HyperProx — Updates: one service per cluster
//
//  Each cluster (home, and every remote) gets its own executor, policy, runner and inventory cache, created on
//  first use and kept by cluster id — never by node name, since a remote node may share a name with a home node.
//  The routes pick the service for the cluster the request is about (lib/clusters/context.ts), so a plan read for
//  one cluster is never applied to another: its jobs live in that cluster's view of the store (cluster-store.ts).
//
//  Home is built exactly as before: the same executor, the policy file's top level, the scheduler. A remote's
//  executor is bound to that cluster (lib/updates/executor.ts remoteExecutor: its pinned API client, its saved
//  node addresses, node logins only with a confirmed host key, every script through the script guard) and its
//  policy is its own section of the file, or the built-in remote defaults.
// =============================================================================

import type { UpdatesClusterRef, UpdatesInventory, UpdatesWsPayload } from './types'
import { clusterBound, productionExecutor, remoteExecutor, type UpdatesExecutor } from './executor'
import { policyForCluster, type PolicyLoad } from './policy'
import { readInventory } from './inventory'
import { UpdatesRunner, type RunnerTiming } from './runner'
import { ScopedStore } from './cluster-store'
import type { UpdatesStore } from './store'
import type { AppEnv } from './apps'
import type { NotifyEventInput } from '../notify/types'
import { HOME_ID, clusterRow } from '../clusters/registry'
import { connectionKey } from '../pve-env'

export interface ClusterUpdates {
  ref:        UpdatesClusterRef
  remote:     boolean
  exec:       UpdatesExecutor
  store:      ScopedStore
  runner:     UpdatesRunner
  loadPolicy: () => PolicyLoad
  /** The inventory, read once and shared by the page's inventory and plan requests; per cluster. */
  inventory(refresh: boolean): Promise<UpdatesInventory>
}

export interface UpdatesServicesDeps {
  /** The shared job store (one lock for all clusters). */
  store:       UpdatesStore
  /** Home's executor. Default: the production one, bound to the home cluster. */
  exec?:       UpdatesExecutor
  /** A remote's executor. Default: remoteExecutor(id). */
  remoteExec?: (id: string) => UpdatesExecutor
  /** The policy file (its top level is home's). */
  loadPolicy:  () => PolicyLoad
  hostname?:   string
  timing?:     Partial<RunnerTiming>
  apps?:       AppEnv
  publish?:    (e: NotifyEventInput) => Promise<void>
  emit?:       (payload: UpdatesWsPayload) => void
  log?:        (msg: string) => void
  /** How HyperProx reaches a remote now (lib/pve-env.ts connectionKey). */
  connection?: (id: string) => string
}

/** The cluster as the registry names it now (a rename shows up without a restart). */
function liveRef(id: string): UpdatesClusterRef {
  const fallback = { id, name: id === HOME_ID ? 'Home cluster' : id, kind: (id === HOME_ID ? 'home' : 'remote') as 'home' | 'remote' }
  return {
    id,
    get name() { return clusterRow(id)?.name ?? fallback.name },
    get kind() { return (clusterRow(id)?.kind ?? fallback.kind) as 'home' | 'remote' },
  } as UpdatesClusterRef
}

export class UpdatesServices {
  private byId = new Map<string, ClusterUpdates>()

  constructor(private deps: UpdatesServicesDeps) {}

  /** The service for a cluster, made on first use. Throws for a cluster the registry does not know. */
  get(id: string): ClusterUpdates {
    const hit = this.byId.get(id)
    if (hit) return hit
    const row = clusterRow(id)
    if (!row) throw new Error(`No such cluster: ${id}`)
    const svc = this.make(id, row.kind === 'remote')
    this.byId.set(id, svc)
    return svc
  }

  /** Services already made, home first. */
  made(): ClusterUpdates[] {
    return [...this.byId.values()].sort((a, b) => (a.ref.id === HOME_ID ? -1 : b.ref.id === HOME_ID ? 1 : 0))
  }

  /** Drop a removed cluster's service. */
  forget(id: string): void { if (id !== HOME_ID) this.byId.delete(id) }

  private make(id: string, remote: boolean): ClusterUpdates {
    const d = this.deps
    const ref = liveRef(id)
    const exec = remote
      ? (d.remoteExec ?? remoteExecutor)(id)
      : (d.exec ?? clusterBound(HOME_ID, productionExecutor()))
    const loadPolicy = remote ? () => policyForCluster(d.loadPolicy(), ref) : d.loadPolicy
    const connection = remote ? () => (d.connection ?? connectionKey)(id) : undefined
    const store = new ScopedStore(d.store, { cluster: ref, connection, nameOf: x => clusterRow(x)?.name ?? null })
    let cached: UpdatesInventory | null = null
    let reading: Promise<UpdatesInventory> | null = null
    const runner = new UpdatesRunner({
      store, exec, loadPolicy,
      emit: d.emit,
      onInventory: r => { cached = { ...r.inventory, cluster: { ...ref } } },
      log: d.log,
      hostname: remote ? undefined : d.hostname,
      timing: d.timing,
      apps: remote ? undefined : d.apps,
      publish: d.publish,
      cluster: ref,
      remote,
      checkJob: store.checkJob,
    })
    const svc: ClusterUpdates = {
      ref, remote, exec, store, runner, loadPolicy,
      async inventory(refresh: boolean) {
        if (cached && !refresh) return cached
        // While a job is active the runner keeps the cache current; a page refresh must not send a second round
        // of reads into guests mid-upgrade.
        if (cached && await store.activeJob()) return cached
        if (!reading) {
          reading = readInventory(exec, loadPolicy().policy, {
            rebootPending: runner.rebootPending, hostname: remote ? undefined : d.hostname,
            apps: remote ? undefined : d.apps, ...runner.inventoryOptions(),
          })
            .then(r => { cached = { ...r.inventory, cluster: { ...ref } }; return cached })
            .finally(() => { reading = null })
        }
        return reading
      },
    }
    return svc
  }
}
