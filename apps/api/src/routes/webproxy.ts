// =============================================================================
//  HyperProx — the web proxy plug-ins' routes (/api/plugins/{nginx|caddy|envoy})
//
//  Roles (lib/roles.ts defaults): reads are viewer, every POST and DELETE is
//  admin, and never an API token's (lib/api-tokens.ts tokenForbidden; refused
//  here again by name). A fresh read (`?fresh=1`) and the list of proxies found
//  but not connected are for admins only. An action also needs `confirm: true`
//  (the page shows the action's own words first), runs only when a reading
//  taken at that moment offers it, and is audited. No route takes a path, a command or a file: a proxy is picked by
//  its id, an action by its name, a guest by its machine id.
// =============================================================================

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { sendFailure, sendRefusal } from '../lib/failure'
import { actorOf, isAdmin } from '../lib/http/request-actor'
import { WebProxyRefusal, webProxyService, type WebProxyKind } from '../lib/webproxy'

function fail(reply: FastifyReply, e: any) {
  if (e instanceof WebProxyRefusal) return sendRefusal(reply, e.status, e.code, e.message)
  if (e?.name === 'TransportError' || e?.name === 'GuestExcludedRefusal') return sendRefusal(reply, e?.name === 'TransportError' ? 502 : 409, e?.name === 'TransportError' ? 'unreachable' : 'excluded', e.message)
  if (e?.name === 'VaultLockedError') throw e
  return sendFailure(reply.request, reply, e, 'That did not work. The details are in the log.')
}

type I = { Params: { iid: string } }

const TOKEN_WORDS = 'An API token cannot connect, act on or disconnect a proxy. Sign in to HyperProx to do it.'
/** True when the request came with an API token: refused, whatever its role. */
function tokenRefused(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!actorOf(req).token) return false
  sendRefusal(reply, 403, 'token_forbidden', TOKEN_WORDS)
  return true
}

export function webProxyRoutes(kind: WebProxyKind): FastifyPluginAsync {
  return async fastify => {
    const svc = () => webProxyService()
    const mine = async (iid: string) => {
      const i = await svc().instance(iid)
      if (i.kind !== kind) throw new WebProxyRefusal('no_instance', 'No such proxy.', 404)
      return i
    }

    /** Every connected proxy of this kind, read (within the last 15 s), and what was found but is not connected. */
    fastify.get('/instances', async (req, reply) => {
      try {
        const admin = isAdmin(req)
        const [readings, found] = await Promise.all([svc().readings(kind), admin ? svc().detected(kind).catch(() => []) : Promise.resolve([])])
        return { success: true, data: { readings, found: found.filter(f => !f.connected) } }
      } catch (e) { return fail(reply, e) }
    })

    fastify.get<I & { Querystring: { fresh?: string } }>('/instances/:iid', async (req, reply) => {
      try {
        await mine(req.params.iid)
        // A fresh read runs a script in the guest now: an admin's to ask for. Anyone else gets the last 15 s.
        return { success: true, data: await svc().reading(req.params.iid, req.query?.fresh === '1' && isAdmin(req)) }
      } catch (e) { return fail(reply, e) }
    })

    /** Connect one by hand (auto-connect does this by itself for what it finds). */
    fastify.post<{ Body: { machineId?: unknown } }>('/instances', async (req, reply) => {
      if (tokenRefused(req, reply)) return reply
      try {
        const i = await svc().connect(kind, String(req.body?.machineId ?? ''), actorOf(req))
        return { success: true, data: await svc().reading(i.id, true) }
      } catch (e) { return fail(reply, e) }
    })

    fastify.post<I & { Params: { action: string }; Body: { confirm?: unknown } }>('/instances/:iid/actions/:action', async (req, reply) => {
      if (tokenRefused(req, reply)) return reply
      try {
        await mine(req.params.iid)
        return { success: true, data: await svc().act(req.params.iid, req.params.action, req.body?.confirm, actorOf(req)) }
      } catch (e) { return fail(reply, e) }
    })

    fastify.delete<I>('/instances/:iid', async (req, reply) => {
      if (tokenRefused(req, reply)) return reply
      try { await mine(req.params.iid); await svc().disconnect(req.params.iid, actorOf(req)); return { success: true } } catch (e) { return fail(reply, e) }
    })
  }
}
