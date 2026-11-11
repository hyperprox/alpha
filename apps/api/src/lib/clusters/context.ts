// =============================================================================
//  HyperProx — which cluster a request is about
//
//  A page for a remote cluster sends `X-HyperProx-Cluster: <id>` (or `?cluster=<id>`). It is resolved once,
//  here, and the rest of the request runs inside that cluster's context: pveFromEnv() (lib/pve-env.ts) builds
//  that cluster's pinned client and nodeCredential() (lib/node-exec.ts) reads that cluster's node logins, so the
//  routes themselves do not change. No header means the home cluster, exactly as before.
//
//  Only routes known to be correct for a remote cluster accept one. Everything else answers 409 with a plain
//  reason, because a route that was written for one cluster (caches keyed by node name, home-only services)
//  would otherwise act on the wrong machine without saying so.
// =============================================================================

import { AsyncLocalStorage } from 'node:async_hooks'
import type { FastifyInstance } from 'fastify'
import { HOME_ID, clusterRow, validClusterId } from './registry'
import type { ClusterRow } from './store'
import { normalisePath } from '../roles'

export interface ClusterCtx { id: string; kind: 'home' | 'remote' }

export const clusterContext = new AsyncLocalStorage<ClusterCtx>()

/** The cluster this code runs for: the request's, or home when nothing set one. */
export function currentClusterId(): string { return clusterContext.getStore()?.id ?? HOME_ID }

/** The remote cluster this code runs for, or null for home. */
export function currentRemote(): ClusterRow | null {
  const c = clusterContext.getStore()
  if (!c || c.kind !== 'remote') return null
  const r = clusterRow(c.id)
  if (!r || r.kind !== 'remote') throw new Error('That cluster was removed while this request was running.')
  return r
}

export function isRemoteContext(): boolean { return clusterContext.getStore()?.kind === 'remote' }

/** Run fn as if a request for cluster `id` had arrived (background jobs, cluster routes with :id). */
export function runInCluster<T>(id: string, fn: () => T): T {
  const r = clusterRow(id)
  if (!r) throw new Error(`No such cluster: ${id}`)
  return clusterContext.run({ id: r.id, kind: r.kind }, fn)
}

export const CLUSTER_HEADER = 'x-hyperprox-cluster'

// Routes that are correct for a remote cluster: they read and act through pveFromEnv() and nodeCredential() at
// call time, and keep nothing keyed by node name across clusters. Method and path, after normalisePath.
const N = '[A-Za-z0-9][A-Za-z0-9.-]*'   // a node name, never "." or ".."
const T = '(lxc|qemu)'
const REMOTE_OK: Array<[string, RegExp]> = [
  ['GET',    /^\/api\/proxmox\/(ping|nodes|resources|storage|vms|summary|templates|isos|nextid|ceph\/(status|osds|pools))$/],
  ['GET',    new RegExp(`^/api/proxmox/nodes/${N}(/tasks)?$`)],
  ['POST',   new RegExp(`^/api/proxmox/vms/${N}/\\d+/${T}/(start|stop|shutdown|reboot)$`)],
  ['POST',   new RegExp(`^/api/infra/vms/${N}/\\d+/${T}/(start|stop|shutdown|reboot)$`)],
  ['GET',    new RegExp(`^/api/infra/vms/${N}/\\d+/${T}/(config|snapshots)$`)],
  ['POST',   new RegExp(`^/api/infra/vms/${N}/\\d+/${T}/snapshots/[A-Za-z][A-Za-z0-9_-]*/rollback$`)],
  ['DELETE', new RegExp(`^/api/infra/vms/${N}/\\d+/${T}/snapshots/[A-Za-z][A-Za-z0-9_-]*$`)],
  // No HA routes: high availability is home-only for now, so on a remote they answer 409.
  ['GET',    new RegExp(`^/api/infra/(tasks|nodes/${N}/tasks)$`)],
  // The guest config editor keeps one service (previews, caches, history) per cluster: routes/guest-config.ts.
  ['GET',    new RegExp(`^/api/infra/guest-config/(overview|nodes/${N}/devices|guests/${N}/${T}/\\d+(/(gpu|history))?)$`)],
  ['POST',   new RegExp(`^/api/infra/guest-config/(preview|apply|paths/check|guests/${N}/${T}/\\d+/reveal)$`)],
  // The assistant (routes/ai.ts): questions read each cluster through runInCluster, actions are prepared in the
  // target cluster's context and applied only when the request is for the plan's own cluster. Deploying a
  // service (/wizard/execute) and the provider settings stay home-only.
  ['POST',   /^\/api\/ai\/(wizard\/plan|actions\/apply)$/],
  // Updates (routes/updates.ts): one service per cluster (lib/updates/service.ts) with its own runner, policy section,
  // inventory cache and view of the jobs, so a job planned for one cluster is "No job" to every other. Changes on a
  // remote also need a fresh re-confirmation. The daily check's status covers every cluster.
  ['GET',    new RegExp(`^/api/updates/(policy|inventory|plan|jobs|jobs/[A-Za-z0-9]{1,64}|check|nodes/${N}/reboot-preview)$`)],
  ['POST',   new RegExp(`^/api/updates/(jobs|jobs/[A-Za-z0-9]{1,64}/(confirm|resume|cancel|rollback)|nodes/${N}/reboot|check)$`)],
  // Home Assistant control (routes/ha-control.ts) names its instance in the path and, on a remote cluster's page,
  // reaches only the instances linked to that cluster.
  ['GET',    /^\/api\/plugins\/home-assistant\/instances(\/h[0-9a-f]{8}\/(status|health|devices)|\/default\/(status|health|devices))?$/],
  ['POST',   /^\/api\/plugins\/home-assistant\/instances\/(h[0-9a-f]{8}|default)\/(actions|secure-actions)$/],
]

export function remoteRouteAllowed(method: string, path: string): boolean {
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase()
  const p = normalisePath(path)
  return REMOTE_OK.some(([rm, re]) => rm === m && re.test(p))
}

/** The id the request names, or null. Header first, then ?cluster=. */
export function requestedClusterId(headers: Record<string, any>, url: string): string | null {
  const h = headers[CLUSTER_HEADER]
  const fromHeader = Array.isArray(h) ? h[0] : h
  if (typeof fromHeader === 'string' && fromHeader.trim()) return fromHeader.trim()
  const q = url.split('?')[1]
  if (!q) return null
  const v = new URLSearchParams(q).get('cluster')
  return v && v.trim() ? v.trim() : null
}

/**
 * The hook. Registered after the vault gate (lib/gate.ts), so a locked or signed-out request has already been
 * answered. Callback style, like the gate's own context hook: the context must wrap the handler.
 */
export function installClusterContext(server: FastifyInstance): void {
  server.addHook('onRequest', (req, reply, done) => {
    const path = normalisePath(req.url)
    // The cluster routes name their cluster in the path (/api/clusters/:id/...) and set it themselves.
    if (path === '/api/clusters' || path.startsWith('/api/clusters/')) return done()
    const id = requestedClusterId(req.headers as Record<string, any>, req.url)
    if (!id || id === HOME_ID) return done()
    if (!validClusterId(id)) { reply.status(400).send({ success: false, code: 'bad_cluster', error: 'That is not a cluster id.' }); return }
    const row = clusterRow(id)
    if (!row) { reply.status(404).send({ success: false, code: 'unknown_cluster', error: 'No such cluster. It may have been removed.' }); return }
    if (row.kind === 'remote' && !remoteRouteAllowed(req.method, path)) {
      reply.status(409).send({ success: false, code: 'home_only', error: `This part of HyperProx works on the home cluster only for now, so nothing was done on ${row.name}.` })
      return
    }
    clusterContext.run({ id: row.id, kind: row.kind }, done)
  })
}
