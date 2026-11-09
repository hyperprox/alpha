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
const REMOTE_OK: Array<[string, RegExp]> = [
  ['GET',    /^\/api\/proxmox\/(ping|nodes|resources|storage|vms|summary|ha|ha\/resources|templates|isos|nextid|ceph\/(status|osds|pools))$/],
  ['GET',    /^\/api\/proxmox\/nodes\/[^/]+(\/tasks)?$/],
  ['POST',   /^\/api\/proxmox\/vms\/[^/]+\/\d+\/(lxc|qemu)\/(start|stop|shutdown|reboot)$/],
  ['POST',   /^\/api\/infra\/vms\/[^/]+\/\d+\/(lxc|qemu)\/(start|stop|shutdown|reboot)$/],
  ['GET',    /^\/api\/infra\/vms\/[^/]+\/\d+\/(lxc|qemu)\/(config|snapshots)$/],
  ['POST',   /^\/api\/infra\/vms\/[^/]+\/\d+\/(lxc|qemu)\/snapshots\/[^/]+\/rollback$/],
  ['DELETE', /^\/api\/infra\/vms\/[^/]+\/\d+\/(lxc|qemu)\/snapshots\/[^/]+$/],
  ['PUT',    /^\/api\/infra\/ha\/[^/]+$/],
  ['GET',    /^\/api\/infra\/(tasks|nodes\/[^/]+\/tasks)$/],
  // The guest config editor keeps one service (previews, caches, history) per cluster: routes/guest-config.ts.
  ['GET',    /^\/api\/infra\/guest-config\/(overview|nodes\/[^/]+\/devices|guests\/[^/]+\/(lxc|qemu)\/\d+(\/(gpu|history))?)$/],
  ['POST',   /^\/api\/infra\/guest-config\/(preview|apply|paths\/check|guests\/[^/]+\/(lxc|qemu)\/\d+\/reveal)$/],
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
