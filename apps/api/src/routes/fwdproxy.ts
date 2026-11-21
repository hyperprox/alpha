// =============================================================================
//  HyperProx — 3proxy routes (/api/plugins/3proxy/proxies)
//
//  Roles (lib/roles.ts): everything here is admin, reads included (a reading
//  names users and, unless turned off, client addresses).
//  Adding, removing or resetting a user and changing the settings (who may use
//  it, whether it reaches the LAN, per-user figures) also need an in-page confirmation, which keeps API tokens out. Reload and the
//  self-check are confirmed on the page and audited.
//
//  No route takes a command, a path or a password: a proxy is picked by its id,
//  an action by its name, a user by a checked name. A new password is never in
//  an answer; the answer names the vault item it was saved in.
// =============================================================================

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { sendFailure, sendRefusal } from '../lib/failure'
import { actorOf } from '../lib/http/request-actor'
import { FwdProxyRefusal, fwdProxyService, type ProxyInstance } from '../lib/fwdproxy'
import { proxyUrl } from '../lib/fwdproxy/setup'

const svc = () => fwdProxyService()

function fail(reply: FastifyReply, e: any) {
  if (e instanceof FwdProxyRefusal) return sendRefusal(reply, e.status, e.code, e.message)
  if (e?.name === 'GuestExcludedRefusal' || e?.name === 'ExclusionsUnknownRefusal') return sendRefusal(reply, e.status ?? 409, e.code ?? 'excluded', e.message)
  if (e?.name === 'TransportError') return sendRefusal(reply, 502, 'unreachable', e.message)
  if (e?.name === 'VaultLockedError') throw e
  return sendFailure(reply.request, reply, e, 'That did not work. The details are in the log.')
}

/** A proxy as the page sees it. Its vault item is named (for the reveal flow), never read. */
export function instanceView(i: ProxyInstance) {
  return {
    id: i.id, vmid: i.vmid, node: i.node, name: i.name, listen: i.listen,
    url: i.listen ? proxyUrl(i.listen) : null,
    vaultItem: `hyperprox:${i.vault.category}/${i.vault.provider}`,
    addedAt: i.addedAt, addedBy: i.addedBy, autoConnected: i.autoConnected ?? null,
  }
}

type P = { Params: { iid: string } }

export const fwdProxyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/proxies', async (_req, reply) => {
    try { return { success: true, data: (await svc().instances()).map(instanceView) } }
    catch (e) { return fail(reply, e) }
  })

  fastify.get<P & { Querystring: { minutes?: string; fresh?: string } }>('/proxies/:iid/reading', async (req, reply) => {
    try { return { success: true, data: await svc().reading(req.params.iid, { minutes: Number(req.query.minutes) || 60, fresh: req.query.fresh === '1' }) } }
    catch (e) { return fail(reply, e) }
  })

  fastify.get<P>('/proxies/:iid/problems', async (req, reply) => {
    try { return { success: true, data: await svc().problems(req.params.iid) } }
    catch (e) { return fail(reply, e) }
  })

  fastify.post<P & { Body: { action?: unknown } }>('/proxies/:iid/actions', async (req, reply) => {
    try { return { success: true, data: await svc().action(req.params.iid, req.body?.action, actorOf(req)) } }
    catch (e) { return fail(reply, e) }
  })

  // Re-confirmed: a new credential.
  fastify.post<P & { Body: { name?: unknown } }>('/proxies/:iid/users', async (req, reply) => {
    try { return reply.status(201).send({ success: true, data: await svc().setUser(req.params.iid, req.body?.name, actorOf(req)) }) }
    catch (e) { return fail(reply, e) }
  })

  // Re-confirmed: a credential replaced.
  fastify.post<P & { Params: { name: string } }>('/proxies/:iid/users/:name/reset', async (req, reply) => {
    try { return { success: true, data: await svc().setUser(req.params.iid, req.params.name, actorOf(req), { reset: true }) } }
    catch (e) { return fail(reply, e) }
  })

  // Re-confirmed: a credential removed.
  fastify.delete<P & { Params: { name: string } }>('/proxies/:iid/users/:name', async (req, reply) => {
    try { return { success: true, data: await svc().removeUser(req.params.iid, req.params.name, actorOf(req)) } }
    catch (e) { return fail(reply, e) }
  })

  // Re-confirmed: who may use the proxy, and where it may go.
  fastify.put<P & { Body: Record<string, unknown> }>('/proxies/:iid/settings', async (req, reply) => {
    try { return { success: true, data: await svc().saveSettings(req.params.iid, req.body ?? {}, actorOf(req)) } }
    catch (e) { return fail(reply, e) }
  })

  fastify.delete<P>('/proxies/:iid', async (req, reply) => {
    try { return { success: true, data: await svc().disconnect(req.params.iid, actorOf(req)) } }
    catch (e) { return fail(reply, e) }
  })
}
