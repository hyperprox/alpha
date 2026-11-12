// =============================================================================
//  HyperProx — Proxmox Backup Server routes (/api/plugins/pbs)
//
//  Roles (lib/roles.ts): reads are viewer, like every plug-in page; below
//  operator a server's address, token id and pin are left out. Adding,
//  changing or removing a server stores a token: admin, master password
//  re-entered. "Verify now" (POST .../actions/verify, the only action) is admin
//  with the master password re-entered, which also keeps API tokens out; the
//  service refuses a token again by name.
//
//  No route returns a token secret, and no route takes a path: the one action is
//  a verify of a datastore the server itself reports. There is no GC, prune,
//  forget or delete route.
// =============================================================================

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { auditCredentialUse } from '../lib/audit'
import { hasRole } from '../lib/roles'
import { coverageOf, detailOf, pbsService } from '../lib/pbs'
import { PbsInputError, type PbsMeta, type PbsView } from '../lib/pbs/instances'
import { PbsRefusal, type Actor } from '../lib/pbs/service'
import { ManageRefusal, MANAGE_CONSEQUENCE } from '../lib/pbs/manage'

declare module 'fastify' {
  interface FastifyRequest { pbsHandled?: boolean }
}

const svc = () => pbsService()

function actor(req: FastifyRequest): Actor {
  const s = req.session!
  return { sid: s.sid, email: s.email, role: s.role, token: req.apiToken?.name ?? null }
}

const isViewer = (req: FastifyRequest) => !hasRole(req.session?.role ?? 'viewer', 'operator')

function fail(reply: FastifyReply, e: any) {
  if (e instanceof PbsRefusal) return reply.status(e.status).send({ success: false, code: e.code, error: e.message })
  if (e instanceof PbsInputError) return reply.status(e.status).send({ success: false, code: 'bad_input', error: e.message })
  if (e instanceof ManageRefusal) return reply.status(e.status).send({ success: false, code: e.code, error: e.message, problems: e.problems })
  throw e
}

function view(m: PbsMeta & Partial<Pick<PbsView, 'url' | 'tokenId' | 'hasSecret'>>, viewer: boolean) {
  if (!viewer) return m
  const { url: _u, tokenId: _t, pin: _p, manage: _m, ...rest } = m
  return rest
}

type P = { Params: { iid: string } }

export const pbsRoutes: FastifyPluginAsync = async (fastify) => {
  // Refusals the gate makes (role, re-confirmation, token) never reach a handler: record those too.
  fastify.addHook('onResponse', async (req, reply) => {
    if (req.method !== 'POST' || req.pbsHandled || reply.statusCode < 400) return
    const m = /\/instances\/([^/]+)\/actions\/verify$/.exec(req.url.split('?')[0])
    if (!m || !req.session || reply.statusCode === 401 || reply.statusCode === 423) return
    await svc().auditRefusal(m[1], actor(req), 'verify', `gate_${reply.statusCode}`).catch(() => {})
  })

  fastify.get('/instances', async (req, reply) => {
    try { return { success: true, data: (await svc().instances.views()).map(v => view(v, isViewer(req))) } }
    catch (e) { return fail(reply, e) }
  })

  // Add: the address and token are checked, the certificate read and pinned, and a real read made, before saving.
  fastify.post<{ Body: Record<string, unknown> }>('/instances', async (req, reply) => {
    try {
      const m = await svc().add(req.body ?? {}, actor(req))
      await auditCredentialUse('pbs.instance.create', `pbs:${m.id}`, { by: req.session!.email, name: m.name, pin: m.pin?.source ?? null })
      return reply.status(201).send({ success: true, data: view(m, false) })
    } catch (e) { return fail(reply, e) }
  })

  // Add by signing in once with a PBS admin login (recommended): HyperProx makes its own read-only token there and
  // keeps only that. The password is used for that one sign-in and never stored, audited or logged (the service
  // audits the attempt with the user name only).
  fastify.post<{ Body: Record<string, unknown> }>('/instances/signin', async (req, reply) => {
    try {
      const m = await svc().addWithLogin(req.body ?? {}, actor(req))
      return reply.status(201).send({ success: true, data: view(m, false) })
    } catch (e) { return fail(reply, e) }
  })

  fastify.put<P & { Body: Record<string, unknown> }>('/instances/:iid', async (req, reply) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>
      const { meta } = await svc().update(req.params.iid, b, actor(req))
      await auditCredentialUse('pbs.instance.update', `pbs:${meta.id}`, {
        by: req.session!.email, name: meta.name,
        changed: Object.keys(b).filter(k => b[k] !== undefined && !(k === 'secret' && b[k] === '')).map(k => (k === 'secret' ? 'credential' : k)),
      })
      return { success: true, data: view(meta, false) }
    } catch (e) { return fail(reply, e) }
  })

  fastify.delete<P>('/instances/:iid', async (req, reply) => {
    try {
      await svc().instances.remove(req.params.iid)
      svc().forget(req.params.iid)
      await auditCredentialUse('pbs.instance.remove', `pbs:${req.params.iid}`, { by: req.session!.email })
      return { success: true }
    } catch (e) { return fail(reply, e) }
  })

  // The whole reading. A server that cannot be read is a normal state: 200 with ok:false and the reason.
  fastify.get<P & { Querystring: { fresh?: string } }>('/instances/:iid/reading', async (req, reply) => {
    try {
      const r = await svc().reading(req.params.iid, { actor: actor(req), fresh: req.query.fresh === '1' })
      return { success: true, data: { ok: true, reading: r } }
    } catch (e: any) {
      if (e instanceof PbsRefusal && (e.status === 404 || e.status === 429)) return fail(reply, e)
      return { success: true, data: { ok: false, code: e?.code ?? null, error: e instanceof PbsRefusal ? e.message : 'The backup server could not be read.' } }
    }
  })

  fastify.get<P>('/instances/:iid/detail', async (req, reply) => {
    try {
      const m = await svc().instances.get(req.params.iid)
      if (!m) return fail(reply, new PbsRefusal('no_instance', 'No such backup server.', 404))
      return { success: true, data: { ok: true, ...detailOf(m.name, await svc().reading(m.id, { actor: actor(req) })) } }
    } catch (e: any) {
      if (e instanceof PbsRefusal && (e.status === 404 || e.status === 429)) return fail(reply, e)
      return { success: true, data: { ok: false, error: e?.message ?? 'The backup server could not be read.' } }
    }
  })

  // Which guests of the clusters HyperProx manages have no backup group here (optional, read-only).
  fastify.get<P>('/instances/:iid/coverage', async (req, reply) => {
    try {
      if (!(await svc().instances.get(req.params.iid))) return fail(reply, new PbsRefusal('no_instance', 'No such backup server.', 404))
      return { success: true, data: { ok: true, clusters: await coverageOf(req.params.iid) } }
    } catch (e: any) {
      return { success: true, data: { ok: false, error: e instanceof PbsRefusal ? e.message : 'The cluster cross-check could not be made.' } }
    }
  })

  // ── backup management (opt-in; off by default) ─────────────────────────────

  // The snapshots of one group, for picking which to delete. A read: the read-only token.
  fastify.get<P & { Querystring: { store?: string; ns?: string; type?: string; id?: string } }>('/instances/:iid/snapshots', async (req, reply) => {
    try {
      const q = req.query
      if (!q.store || !q.type || !q.id) return reply.status(400).send({ success: false, error: 'Name the datastore and the group.' })
      return { success: true, data: await svc().groupSnapshots(req.params.iid, { store: q.store, ns: q.ns ?? '', type: q.type, id: q.id }, actor(req)) }
    } catch (e) { return fail(reply, e) }
  })

  // Turn management on (an admin sign-in, used once, and the datastores) or off (deletes the manage token on PBS).
  fastify.put<P & { Body: Record<string, unknown> }>('/instances/:iid/manage', async (req, reply) => {
    try {
      const b = req.body ?? {}
      const login = { username: b.username, realm: b.realm, password: b.password }
      const meta = b.enabled === true
        ? await svc().manager.enable(req.params.iid, Array.isArray(b.stores) ? b.stores.filter((x): x is string => typeof x === 'string') : [], actor(req), { login })
        : await svc().manager.disable(req.params.iid, actor(req), login)
      svc().forget(req.params.iid)
      return { success: true, data: { ...view(meta, false), consequence: MANAGE_CONSEQUENCE } }
    } catch (e) { return fail(reply, e) }
  })

  fastify.post<P & { Body: Record<string, unknown> }>('/instances/:iid/manage/preview', async (req, reply) => {
    try { return { success: true, data: await svc().manager.preview(req.params.iid, actor(req), req.body ?? {}) } }
    catch (e) { return fail(reply, e) }
  })

  fastify.post<P & { Body: { previewId?: unknown; acks?: unknown } }>('/instances/:iid/manage/apply', async (req, reply) => {
    try {
      const r = await svc().manager.apply(req.params.iid, actor(req), String(req.body?.previewId ?? ''), req.body?.acks)
      svc().forget(req.params.iid)
      return { success: true, data: r }
    } catch (e) { return fail(reply, e) }
  })

  fastify.post<P & { Body: { store?: unknown } }>('/instances/:iid/manage/gc', async (req, reply) => {
    try { return { success: true, data: await svc().manager.gc(req.params.iid, actor(req), req.body?.store) } }
    catch (e) { return fail(reply, e) }
  })

  fastify.post<P & { Body: Record<string, unknown> }>('/instances/:iid/actions/verify', async (req, reply) => {
    req.pbsHandled = true
    try { return { success: true, data: await svc().act(req.params.iid, 'verify', req.body ?? {}, actor(req)) } }
    catch (e) { return fail(reply, e) }
  })
}
