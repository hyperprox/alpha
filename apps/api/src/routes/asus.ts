// =============================================================================
//  HyperProx — ASUS router routes (/api/plugins/asus)
//
//  Roles (lib/roles.ts): reads are viewer, like every plug-in page, and a
//  viewer's reading carries no MAC addresses, no client addresses and not the
//  WAN address (operator and above see them). Finding a router on the LAN
//  (POST /detect) is admin. Adding, changing or removing a router is admin and
//  re-confirmed: it stores an admin login. Rebooting (POST .../actions) is
//  admin with the master password re-entered, which keeps API tokens out; the
//  service refuses a token there again by name and checks the confirm phrase
//  and the typed router name.
//
//  No route returns a password, and no route takes a path, a hook or a
//  command: the one action is a name.
// =============================================================================

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { auditCredentialUse } from '../lib/audit'
import { hasRole } from '../lib/roles'
import { asusService, detailOf, stopAsus, viewerReading } from '../lib/asus'
import { AsusInputError, type AsusMeta, type AsusView } from '../lib/asus/instances'
import { AsusRefusal, confirmPhrase, type Actor } from '../lib/asus/service'
import { AsusLoginError } from '../lib/asus/client'
import { AsusUnreachableError } from '../lib/asus/transport'
import { findAsusRouters } from '../lib/asus/detect'

declare module 'fastify' {
  interface FastifyRequest { asusHandled?: boolean }
}

const svc = () => asusService()

function actor(req: FastifyRequest): Actor {
  const s = req.session!
  return { sid: s.sid, email: s.email, role: s.role, token: req.apiToken?.name ?? null }
}

const isViewer = (req: FastifyRequest) => !hasRole(req.session?.role ?? 'viewer', 'operator')

function fail(reply: FastifyReply, e: any) {
  if (e instanceof AsusRefusal) return reply.status(e.status).send({ success: false, code: e.code, error: e.message })
  if (e instanceof AsusInputError) return reply.status(e.status).send({ success: false, code: 'bad_input', error: e.message })
  throw e
}

/** One router as the page sees it. Below operator: its name and what it is; no address, user or pin. */
function view(m: AsusMeta & Partial<Pick<AsusView, 'url' | 'username' | 'hasPassword'>>, viewer: boolean) {
  const out = { ...m, held: svc().blockedReason(m.id), phrase: confirmPhrase(m.name), lastAction: svc().lastAction(m.id) }
  if (!viewer) return out
  const { url: _u, username: _n, fingerprint: _f, ...rest } = out
  return rest
}

type P = { Params: { iid: string } }

export const asusRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onClose', async () => { await stopAsus() })

  // Refusals the gate makes (role, re-confirmation, token) never reach a handler: record those too.
  fastify.addHook('onResponse', async (req, reply) => {
    if (req.method !== 'POST' || req.asusHandled || reply.statusCode < 400) return
    const m = /\/instances\/([^/]+)\/actions$/.exec(req.url.split('?')[0])
    if (!m || !req.session || reply.statusCode === 401 || reply.statusCode === 423) return
    await svc().auditRefusal(m[1], actor(req), (req.body ?? {}) as Record<string, unknown>, `gate_${reply.statusCode}`).catch(() => {})
  })

  fastify.get('/instances', async (req, reply) => {
    try { return { success: true, data: (await svc().instances.views()).map(v => view(v, isViewer(req))) } }
    catch (e) { return fail(reply, e) }
  })

  // The default gateway's login page, if it is an ASUS router: prefills the Add form.
  fastify.post('/detect', async (req, reply) => {
    try { svc().limit(actor(req), 'setupsPerMinute', 'Too many searches; wait a moment.') } catch (e) { return fail(reply, e) }
    return { success: true, data: await findAsusRouters().catch(() => []) }
  })

  fastify.post<{ Body: Record<string, unknown> }>('/instances', async (req, reply) => {
    try {
      const { meta, pinnedNow } = await svc().add(req.body ?? {}, actor(req))
      await auditCredentialUse('asus.instance.create', `asus:${meta.id}`, { by: req.session!.email, name: meta.name, model: meta.model, pinned: pinnedNow })
      return reply.status(201).send({ success: true, data: { ...view(meta, false), pinnedNow } })
    } catch (e) { return fail(reply, e) }
  })

  fastify.put<P & { Body: Record<string, unknown> }>('/instances/:iid', async (req, reply) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>
      const { meta, pinnedNow } = await svc().edit(req.params.iid, b, actor(req))
      await auditCredentialUse('asus.instance.update', `asus:${meta.id}`, {
        by: req.session!.email, name: meta.name, pinned: pinnedNow,
        changed: Object.keys(b).filter(k => b[k] !== undefined && !(k === 'password' && b[k] === '')).map(k => k === 'password' ? 'credential' : k),
      })
      return { success: true, data: { ...view(meta, false), pinnedNow } }
    } catch (e) { return fail(reply, e) }
  })

  fastify.delete<P>('/instances/:iid', async (req, reply) => {
    try {
      await svc().instances.remove(req.params.iid)
      svc().forget(req.params.iid)
      await auditCredentialUse('asus.instance.remove', `asus:${req.params.iid}`, { by: req.session!.email })
      return { success: true }
    } catch (e) { return fail(reply, e) }
  })

  // The whole reading. A router that cannot be read is a normal state: 200 with ok:false.
  fastify.get<P & { Querystring: { fresh?: string } }>('/instances/:iid/reading', async (req, reply) => {
    try {
      const r = await svc().reading(req.params.iid, { actor: actor(req), fresh: req.query.fresh === '1' })
      return { success: true, data: { ok: true, reading: isViewer(req) ? viewerReading(r) : r, lastAction: svc().lastAction(req.params.iid) } }
    } catch (e: any) {
      if (e instanceof AsusRefusal && (e.status === 404 || e.status === 429)) return fail(reply, e)
      const known = e instanceof AsusRefusal || e instanceof AsusUnreachableError || e instanceof AsusLoginError
      return { success: true, data: { ok: false, held: e?.code === 'login_held' || e instanceof AsusLoginError, error: known ? e.message : 'The router could not be read.', lastAction: svc().lastAction(req.params.iid) } }
    }
  })

  fastify.get<P>('/instances/:iid/detail', async (req, reply) => {
    try {
      const m = await svc().instances.get(req.params.iid)
      if (!m) return fail(reply, new AsusRefusal('no_instance', 'No such router.', 404))
      const r = await svc().reading(m.id, { actor: actor(req) })
      return { success: true, data: { ok: true, ...detailOf(m.name, isViewer(req) ? viewerReading(r) : r) } }
    } catch (e: any) {
      if (e instanceof AsusRefusal && (e.status === 404 || e.status === 429)) return fail(reply, e)
      const known = e instanceof AsusRefusal || e instanceof AsusUnreachableError || e instanceof AsusLoginError
      return { success: true, data: { ok: false, error: known ? e.message : 'The router could not be read.' } }
    }
  })

  fastify.post<P & { Body: Record<string, unknown> }>('/instances/:iid/actions', async (req, reply) => {
    req.asusHandled = true
    try { return { success: true, data: await svc().act(req.params.iid, req.body ?? {}, actor(req)) } }
    catch (e) { return fail(reply, e) }
  })
}
