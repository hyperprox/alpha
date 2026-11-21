// =============================================================================
//  HyperProx — package cache routes (/api/plugins/apt-cacher-ng)
//
//  Roles (lib/roles.ts): everything here is admin, reads included (a reading
//  names the guests that use the cache). Changing who may use it, the Updates
//  setting, and writing or removing the setting on every guest also need an
//  in-page confirmation. API tokens are refused every change outright
//  (lib/api-tokens.ts) and again in the service. Every change is audited
//  first; when the audit cannot be written, nothing is done.
//
//  No route takes a command, a path or an address: a cache is picked by its
//  id, an action by its name, a cluster by its id.
// =============================================================================

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { sendFailure, sendRefusal } from '../lib/failure'
import { actorOf } from '../lib/http/request-actor'
import { AptCacheRefusal, aptCacheService, type CacheInstance } from '../lib/aptcache'
import { cacheUrl } from '../lib/aptcache/setup'
import { clusterRow } from '../lib/clusters/registry'

const svc = () => aptCacheService()

function fail(reply: FastifyReply, e: any) {
  if (e instanceof AptCacheRefusal) return sendRefusal(reply, e.status, e.code, e.message)
  if (e?.name === 'GuestExcludedRefusal' || e?.name === 'ExclusionsUnknownRefusal') return sendRefusal(reply, e.status ?? 409, e.code ?? 'excluded', e.message)
  if (e?.name === 'TransportError') return sendRefusal(reply, 502, 'unreachable', e.message)
  if (e?.name === 'VaultLockedError') throw e
  return sendFailure(reply.request, reply, e, 'That did not work. The details are in the log.')
}

/** A cache as the page sees it. Its vault item is named (for the reveal flow), never read. */
export function instanceView(i: CacheInstance) {
  return {
    id: i.id, vmid: i.vmid, node: i.node, name: i.name, listen: i.listen,
    url: i.listen ? cacheUrl(i.listen) : null,
    vaultItem: `hyperprox:${i.vault.category}/${i.vault.provider}`,
    addedAt: i.addedAt, addedBy: i.addedBy, autoConnected: i.autoConnected ?? null,
  }
}

const clusterOf = (raw: unknown): string => {
  const id = String(raw ?? 'home')
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !clusterRow(id)) throw new AptCacheRefusal('no_cluster', 'There is no such cluster.', 404)
  return id
}

type P = { Params: { iid: string } }

export const aptCacheRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/caches', async (_req, reply) => {
    try { return { success: true, data: (await svc().instances()).map(instanceView) } }
    catch (e) { return fail(reply, e) }
  })

  fastify.get<P & { Querystring: { hours?: string; fresh?: string } }>('/caches/:iid/reading', async (req, reply) => {
    try { return { success: true, data: await svc().reading(req.params.iid, { hours: Number(req.query.hours) || 24, fresh: req.query.fresh === '1' }) } }
    catch (e) { return fail(reply, e) }
  })

  fastify.get<P>('/caches/:iid/problems', async (req, reply) => {
    try { return { success: true, data: await svc().problems(req.params.iid) } }
    catch (e) { return fail(reply, e) }
  })

  fastify.post<P & { Body: { action?: unknown } }>('/caches/:iid/actions', async (req, reply) => {
    try { return { success: true, data: await svc().action(req.params.iid, req.body?.action, actorOf(req)) } }
    catch (e) { return fail(reply, e) }
  })

  // Re-confirmed: who may use the cache, and whether its admin page is on the network.
  fastify.put<P & { Body: Record<string, unknown> }>('/caches/:iid/settings', async (req, reply) => {
    try { return { success: true, data: await svc().saveSettings(req.params.iid, req.body ?? {}, actorOf(req)) } }
    catch (e) { return fail(reply, e) }
  })

  fastify.delete<P>('/caches/:iid', async (req, reply) => {
    try { return { success: true, data: await svc().disconnect(req.params.iid, actorOf(req)) } }
    catch (e) { return fail(reply, e) }
  })

  // Updates' "Use the package cache", per cluster.
  fastify.get<{ Querystring: { cluster?: string } }>('/use', async (req, reply) => {
    try { return { success: true, data: await svc().useView(clusterOf(req.query.cluster)) } }
    catch (e) { return fail(reply, e) }
  })

  // Re-confirmed: it decides what is written into every guest's apt config on the next run.
  fastify.put<{ Querystring: { cluster?: string }; Body: Record<string, unknown> }>('/use', async (req, reply) => {
    try {
      const id = clusterOf(req.query.cluster)
      await svc().setUse(id, req.body ?? {}, actorOf(req))
      return { success: true, data: await svc().useView(id) }
    } catch (e) { return fail(reply, e) }
  })

  // Re-confirmed: written into (or taken out of) every guest Updates looks after, now.
  fastify.post('/guests/repair', async (req, reply) => {
    try { return { success: true, data: await svc().fleetAction('repair', actorOf(req)) } }
    catch (e) { return fail(reply, e) }
  })
  fastify.post('/guests/remove', async (req, reply) => {
    try { return { success: true, data: await svc().fleetAction('remove', actorOf(req)) } }
    catch (e) { return fail(reply, e) }
  })
}
