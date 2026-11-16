// =============================================================================
//  HyperProx — DNS blocker routes (/api/plugins/pihole and /api/plugins/adguard)
//
//  Roles (lib/roles.ts): reads are viewer, like every plug-in page; a viewer's reading carries no per-client numbers (the
//  names and addresses of the people on the network), and the instance list carries no address. Pausing blocking, turning
//  it back on and updating the lists (POST .../actions) are operator. Restarting, allowing a domain, switching the
//  upstream DNS servers and the guest DNS setting (POST .../secure-actions) are admin with the master password
//  re-entered, which also keeps API tokens out; the service refuses a token there again by name. Adding, changing or
//  removing a blocker stores a login: admin and re-confirmed.
//
//  No route returns a password, and no route takes a path or a command: an action is one of eight names.
// =============================================================================

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { auditOrThrow } from '../audit'
import { plainReason, sendRefusal } from '../failure'
import { hasRole } from '../roles'
import { actorOf, auditBy } from '../http/request-actor'
import { machineId } from '../guest-id'
import { dnsBlockerService, viewerReading } from './index'
import { DnsLoginError, DnsUnreachableError } from './client'
import { DnsTargetError } from './target'
import { DnsRefusal, KIND_NAME, type DnsKind, type DnsMeta, type DnsView } from './types'

declare module 'fastify' {
  interface FastifyRequest { dnsHandled?: boolean }
}

const isViewer = (req: FastifyRequest) => !hasRole(req.session?.role ?? 'viewer', 'operator')
const isAdminReq = (req: FastifyRequest) => hasRole(req.session?.role ?? 'viewer', 'admin')

function fail(reply: FastifyReply, e: any) {
  if (e instanceof DnsRefusal) return sendRefusal(reply, e.status, e.code, e.message, e.extra)
  if (e instanceof DnsTargetError) return sendRefusal(reply, 400, 'bad_input', e.message)
  if (e instanceof DnsLoginError) return sendRefusal(reply, 400, 'login_refused', e.message)
  if (e instanceof DnsUnreachableError) return sendRefusal(reply, 502, 'unreachable', e.message)
  throw e
}

/** One blocker as the page sees it. Below operator: its name and flags only. Below admin: no address. */
function view(v: DnsView, req: FastifyRequest) {
  if (isViewer(req)) return { id: v.id, kind: v.kind, name: v.name, hideClients: v.hideClients, addedAt: v.addedAt, hasPassword: v.hasPassword }
  const { url, insecureTLS, ...rest } = v
  return isAdminReq(req) ? { ...rest, url, insecureTLS } : rest
}

type P = { Params: { iid: string } }

export function dnsBlockerRoutes(kind: DnsKind): FastifyPluginAsync {
  return async (fastify) => {
    const svc = () => dnsBlockerService(kind)

    // Refusals the gate makes (role, re-confirmation, token) never reach a handler: record those too. Requests with no
    // session at all (401) or while locked (423) are not: anyone can send those.
    fastify.addHook('onResponse', async (req, reply) => {
      if (req.method !== 'POST' || req.dnsHandled || reply.statusCode < 400) return
      const m = /\/instances\/([^/]+)\/(actions|secure-actions)$/.exec(req.url.split('?')[0])
      if (!m || !req.session || reply.statusCode === 401 || reply.statusCode === 423) return
      await svc().auditRefusal(m[1], actorOf(req), (req.body ?? {}) as Record<string, unknown>, `gate_${reply.statusCode}`).catch(() => {})
    })

    fastify.get('/instances', async (req, reply) => {
      try { return { success: true, data: (await svc().instances.views()).map(v => ({ ...view(v, req), held: svc().blockedReason(v.id) })) } }
      catch (e) { return fail(reply, e) }
    })

    // The guests an instance could be tied to (the restart needs one), for the add form. Admin: it maps guests.
    fastify.get('/guests', async (_req, reply) => {
      try { return { success: true, data: await svc().guestChoices() } } catch (e) { return fail(reply, e) }
    })

    fastify.post<{ Body: Record<string, unknown> }>('/instances', async (req, reply) => {
      try {
        const m = await svc().add(req.body ?? {}, actorOf(req))
        return reply.status(201).send({ success: true, data: view(await svc().instances.view(m), req) })
      } catch (e) { return fail(reply, e) }
    })

    fastify.put<P & { Body: Record<string, unknown> }>('/instances/:iid', async (req, reply) => {
      try {
        const b = (req.body ?? {}) as Record<string, unknown>
        const before = await svc().instances.get(req.params.iid)
        if (!before) throw new DnsRefusal('no_instance', 'No such blocker.', 404)
        // Fail closed: the row is written before the store is.
        await auditOrThrow(`${kind}.instance.update`, `${kind}:${before.id}`, {
          ...auditBy(actorOf(req)), name: before.name, result: 'started', changed: Object.keys(b).filter(k => b[k] !== undefined && !(k === 'password' && b[k] === '')).map(k => k === 'password' ? 'credential' : k),
        })
        const { meta } = await svc().instances.update(req.params.iid, b)
        svc().forget(meta.id)
        return { success: true, data: view(await svc().instances.view(meta), req) }
      } catch (e) { return fail(reply, e) }
    })

    fastify.delete<P & { Querystring: { force?: string } }>('/instances/:iid', async (req, reply) => {
      try {
        const m: DnsMeta | null = await svc().instances.get(req.params.iid)
        if (!m) throw new DnsRefusal('no_instance', 'No such blocker.', 404)
        await auditOrThrow(`${kind}.instance.remove`, `${kind}:${m.id}`, { ...auditBy(actorOf(req)), name: m.name, result: 'started' })
        // Guests pointed at it get their DNS list back first (or the removal says why not).
        await svc().releaseGuestDns(m.id, actorOf(req), req.query.force === '1')
        await svc().instances.remove(m.id)
        svc().forget(m.id)
        // One auto-connect found: remembered, so it is not added back by itself (until "connect again").
        if (m.autoConnected && m.guest) await svc().dismiss(machineId({ type: m.guest.kind, vmid: m.guest.vmid }), `${KIND_NAME[kind]}: ${m.name}`, actorOf(req).email).catch(() => {})
        return { success: true }
      } catch (e) { return fail(reply, e) }
    })

    // The whole reading. A blocker that cannot be read is a normal state (it may be off): 200 with ok:false and the reason.
    fastify.get<P & { Querystring: { fresh?: string } }>('/instances/:iid/reading', async (req, reply) => {
      try {
        const r = await svc().reading(req.params.iid, { actor: actorOf(req), fresh: req.query.fresh === '1' })
        return { success: true, data: { ok: true, reading: isViewer(req) ? viewerReading(r) : r } }
      } catch (e: any) {
        if (e instanceof DnsRefusal && (e.status === 404 || e.status === 429)) return fail(reply, e)
        const known = e instanceof DnsRefusal || e instanceof DnsUnreachableError || e instanceof DnsLoginError
        return { success: true, data: { ok: false, held: e instanceof DnsLoginError, error: known ? e.message : plainReason(e, KIND_NAME[kind]) } }
      }
    })

    fastify.post<P & { Body: Record<string, unknown> }>('/instances/:iid/actions', async (req, reply) => {
      req.dnsHandled = true
      try { return { success: true, data: await svc().act(req.params.iid, req.body ?? {}, actorOf(req), false) } }
      catch (e) { return fail(reply, e) }
    })

    fastify.post<P & { Body: Record<string, unknown> }>('/instances/:iid/secure-actions', async (req, reply) => {
      req.dnsHandled = true
      try { return { success: true, data: await svc().act(req.params.iid, req.body ?? {}, actorOf(req), true) } }
      catch (e) { return fail(reply, e) }
    })
  }
}
