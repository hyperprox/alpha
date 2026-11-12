// =============================================================================
//  HyperProx — Proxmox Backup Server routes (/api/plugins/pbs)
//
//  Roles (lib/roles.ts): reads are viewer, like every plug-in page; below
//  operator a server's address, token id and pin are left out. Adding,
//  changing or removing a server stores a token: admin, master password
//  re-entered. "Verify now" and "GC now" (POST .../actions/verify|gc) are admin
//  with the master password re-entered, which also keeps API tokens out; the
//  service refuses a token again by name.
//
//  No route returns a token secret, and no route takes a path: an action is one
//  of two names and a datastore the server itself reports.
// =============================================================================

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { auditCredentialUse } from '../lib/audit'
import { hasRole } from '../lib/roles'
import { coverageOf, detailOf, pbsService } from '../lib/pbs'
import { PbsInputError, type PbsMeta, type PbsView } from '../lib/pbs/instances'
import { PbsRefusal, type Actor } from '../lib/pbs/service'

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
  throw e
}

function view(m: PbsMeta & Partial<Pick<PbsView, 'url' | 'tokenId' | 'hasSecret'>>, viewer: boolean) {
  if (!viewer) return m
  const { url: _u, tokenId: _t, pin: _p, ...rest } = m
  return rest
}

type P = { Params: { iid: string } }

export const pbsRoutes: FastifyPluginAsync = async (fastify) => {
  // Refusals the gate makes (role, re-confirmation, token) never reach a handler: record those too.
  fastify.addHook('onResponse', async (req, reply) => {
    if (req.method !== 'POST' || req.pbsHandled || reply.statusCode < 400) return
    const m = /\/instances\/([^/]+)\/actions\/([a-z]+)$/.exec(req.url.split('?')[0])
    if (!m || !req.session || reply.statusCode === 401 || reply.statusCode === 423) return
    await svc().auditRefusal(m[1], actor(req), m[2], `gate_${reply.statusCode}`).catch(() => {})
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

  fastify.post<P & { Params: { action: string }; Body: Record<string, unknown> }>('/instances/:iid/actions/:action', async (req, reply) => {
    req.pbsHandled = true
    try { return { success: true, data: await svc().act(req.params.iid, req.params.action, req.body ?? {}, actor(req)) } }
    catch (e) { return fail(reply, e) }
  })
}
