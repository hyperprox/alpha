// =============================================================================
//  HyperProx — QNAP routes (/api/plugins/qnap)
//
//  Roles (lib/roles.ts): reads are viewer, like every plug-in page, and a
//  viewer's reading carries no serial numbers, host name, addresses or MACs.
//  A quick SMART test (POST .../actions) is operator. Restart and shut down
//  (POST .../secure-actions) are admin with the master password re-entered,
//  which also keeps API tokens out; the service refuses a token there again by
//  name and checks the confirm phrase and the typed NAS name. Adding, changing
//  or removing a NAS is admin and re-confirmed: it stores a login.
//
//  No route returns a password, and no route takes a path or a command: an
//  action is one of four names.
// =============================================================================

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { auditCredentialUse } from '../lib/audit'
import { probeCertificate } from '../lib/clusters/tls-pin'
import { hasRole } from '../lib/roles'
import { detailOf, qnapService, startQnapAlerts, viewerReading } from '../lib/qnap'
import { QnapInputError, effectiveReach, type QnapView, type QnapMeta } from '../lib/qnap/instances'
import { QnapRefusal, confirmPhrase, type Actor } from '../lib/qnap/service'
import { QnapLoginError } from '../lib/qnap/client'
import { QnapUnreachableError } from '../lib/qnap/transport'
import { portOf, resolveQnapTarget } from '../lib/qnap/target'

declare module 'fastify' {
  interface FastifyRequest { qnapHandled?: boolean }
}

const svc = () => qnapService()

function actor(req: FastifyRequest): Actor {
  const s = req.session!
  return { sid: s.sid, email: s.email, role: s.role, token: req.apiToken?.name ?? null }
}

const isViewer = (req: FastifyRequest) => !hasRole(req.session?.role ?? 'viewer', 'operator')

function fail(reply: FastifyReply, e: any) {
  if (e instanceof QnapRefusal) return reply.status(e.status).send({ success: false, code: e.code, error: e.message })
  if (e instanceof QnapInputError) return reply.status(e.status).send({ success: false, code: 'bad_input', error: e.message })
  throw e
}

/** One NAS as the page sees it. Below operator: its name, link and how it is reached; no address, user or pin. */
function view(m: QnapMeta & Partial<Pick<QnapView, 'url' | 'username' | 'hasPassword'>>, viewer: boolean) {
  const cluster = svc().instances.cluster(m.clusterId)
  const out = {
    ...m,
    cluster: m.clusterId && cluster ? { id: m.clusterId, name: cluster.name, kind: cluster.kind } : null,
    remote: cluster?.kind === 'remote',
    via: m.url ? effectiveReach(m, m.url, cluster) : 'direct',
    held: svc().blockedReason(m.id),
    phrases: { restart: confirmPhrase('restart', m.name), shutdown: confirmPhrase('shutdown', m.name) },
  }
  if (!viewer) return out
  const { url: _u, username: _n, fingerprint: _f, node: _d, ...rest } = out
  return rest
}

type P = { Params: { iid: string } }

export const qnapRoutes: FastifyPluginAsync = async (fastify) => {
  // The alert poller lives as long as the routes do.
  const stop = startQnapAlerts(m => fastify.log.info(m))
  fastify.addHook('onClose', async () => stop())

  // Refusals the gate makes (role, re-confirmation, token) never reach a handler: record those too. Requests with
  // no session at all (401) or while locked (423) are not: anyone can send those.
  fastify.addHook('onResponse', async (req, reply) => {
    if (req.method !== 'POST' || req.qnapHandled || reply.statusCode < 400) return
    const m = /\/instances\/([^/]+)\/(actions|secure-actions)$/.exec(req.url.split('?')[0])
    if (!m || !req.session || reply.statusCode === 401 || reply.statusCode === 423) return
    await svc().auditRefusal(m[1], actor(req), (req.body ?? {}) as Record<string, unknown>, `gate_${reply.statusCode}`).catch(() => {})
  })

  fastify.get('/instances', async (req, reply) => {
    try { return { success: true, data: (await svc().instances.views()).map(v => view(v, isViewer(req))) } }
    catch (e) { return fail(reply, e) }
  })

  fastify.post<{ Body: Record<string, unknown> }>('/instances', async (req, reply) => {
    try {
      const m = await svc().instances.create(req.body ?? {})
      await auditCredentialUse('qnap.instance.create', `qnap:${m.id}`, { by: req.session!.email, name: m.name, cluster: m.clusterId, reach: m.reach })
      return reply.status(201).send({ success: true, data: view(m, false) })
    } catch (e) { return fail(reply, e) }
  })

  fastify.put<P & { Body: Record<string, unknown> }>('/instances/:iid', async (req, reply) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>
      const { meta, loginChanged } = await svc().instances.update(req.params.iid, b)
      if (loginChanged) svc().forget(meta.id)
      await auditCredentialUse('qnap.instance.update', `qnap:${meta.id}`, {
        by: req.session!.email, name: meta.name, cluster: meta.clusterId,
        changed: Object.keys(b).filter(k => b[k] !== undefined && !(k === 'password' && b[k] === '')).map(k => k === 'password' ? 'credential' : k),
      })
      return { success: true, data: view(meta, false) }
    } catch (e) { return fail(reply, e) }
  })

  fastify.delete<P>('/instances/:iid', async (req, reply) => {
    try {
      await svc().instances.remove(req.params.iid)
      svc().forget(req.params.iid)
      await auditCredentialUse('qnap.instance.remove', `qnap:${req.params.iid}`, { by: req.session!.email })
      return { success: true }
    } catch (e) { return fail(reply, e) }
  })

  // The certificate a NAS presents, for pinning (admin; checked against the same address rules first).
  fastify.post<{ Body: { url?: unknown } }>('/instances/probe-certificate', async (req, reply) => {
    // A token only with the owner-granted plug-in settings permission (lib/gate.ts), to confirm a fingerprint before adding.
    if (req.apiToken && req.tokenPluginSettings?.kind !== 'probe') return reply.status(403).send({ success: false, code: 'token_forbidden', error: 'API tokens cannot probe certificates.' })
    try { svc().limit(actor(req), 'probesPerMinute', 'Too many certificate reads; wait a moment.') } catch (e) { return fail(reply, e) }
    try {
      const u = new URL(String(req.body?.url ?? ''))
      if (u.protocol !== 'https:') return reply.status(400).send({ success: false, code: 'bad_input', error: 'Only an https:// address has a certificate to pin.' })
      const address = await resolveQnapTarget(u)
      const cert = await probeCertificate(address, portOf(u), 10_000, u.hostname)
      return { success: true, data: { fingerprint: cert.fingerprint, subject: cert.subject, issuer: cert.issuer, validTo: cert.validTo } }
    } catch (e: any) {
      return reply.status(400).send({ success: false, code: 'bad_input', error: e?.name === 'QnapTargetError' ? e.message : 'Could not read a certificate from that address.' })
    }
  })

  // The whole reading. A NAS that cannot be read is a normal state (it may be off, or beyond a VPN): 200 with ok:false.
  fastify.get<P & { Querystring: { fresh?: string } }>('/instances/:iid/reading', async (req, reply) => {
    try {
      const r = await svc().reading(req.params.iid, { actor: actor(req), fresh: req.query.fresh === '1' })
      return { success: true, data: { ok: true, reading: isViewer(req) ? viewerReading(r) : r } }
    } catch (e: any) {
      if (e instanceof QnapRefusal && (e.status === 404 || e.status === 429)) return fail(reply, e)
      const known = e instanceof QnapRefusal || e instanceof QnapUnreachableError || e instanceof QnapLoginError
      return { success: true, data: { ok: false, held: e?.code === 'login_held' || e instanceof QnapLoginError, error: known ? e.message : 'The NAS could not be read.' } }
    }
  })

  // The same reading as plain tables (the page's Details fallback).
  fastify.get<P>('/instances/:iid/detail', async (req, reply) => {
    try {
      const m = await svc().instances.get(req.params.iid)
      if (!m) return fail(reply, new QnapRefusal('no_instance', 'No such NAS.', 404))
      const r = await svc().reading(m.id, { actor: actor(req) })
      return { success: true, data: { ok: true, ...detailOf(m.name, isViewer(req) ? viewerReading(r) : r) } }
    } catch (e: any) {
      if (e instanceof QnapRefusal && (e.status === 404 || e.status === 429)) return fail(reply, e)
      return { success: true, data: { ok: false, error: e?.message ?? 'The NAS could not be read.' } }
    }
  })

  fastify.post<P & { Body: Record<string, unknown> }>('/instances/:iid/actions', async (req, reply) => {
    req.qnapHandled = true
    try { return { success: true, data: await svc().act(req.params.iid, req.body ?? {}, actor(req), false) } }
    catch (e) { return fail(reply, e) }
  })

  fastify.post<P & { Body: Record<string, unknown> }>('/instances/:iid/secure-actions', async (req, reply) => {
    req.qnapHandled = true
    try { return { success: true, data: await svc().act(req.params.iid, req.body ?? {}, actor(req), true) } }
    catch (e) { return fail(reply, e) }
  })
}
