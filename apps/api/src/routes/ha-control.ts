// =============================================================================
//  HyperProx — Home Assistant control routes (/api/plugins/home-assistant)
//
//  Roles (lib/roles.ts): reads are viewer, like every plug-in page. Everyday
//  controls (POST .../actions) are operator at the gate, and the instance's own
//  setting can raise that to admin. Security controls (POST .../secure-actions)
//  are admin with the master password re-entered, which also keeps API tokens
//  out; the service refuses a token there again by name. Adding, changing or
//  removing an instance is admin and re-confirmed: it stores a token or changes
//  what counts as a security device.
//
//  No route returns a token. No route calls an arbitrary service: an action is a
//  name from the allow-list (lib/ha-control/catalog.ts).
// =============================================================================

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { getCredential, setCredential, deleteProviderCredentials } from '../lib/credentials'
import { auditCredentialUse } from '../lib/audit'
import { publish } from '../lib/notify'
import { getCluster } from '../lib/clusters/registry'
import { clusterContext } from '../lib/clusters/context'
import { ActionRefusal } from '../lib/ha-control/catalog'
import { InstanceInputError, InstanceStore, type InstanceMeta } from '../lib/ha-control/instances'
import { HAControlService, type Actor } from '../lib/ha-control/service'
import { resolveHATarget, portOf } from '../lib/ha-control/target'
import { probeCertificate } from '../lib/clusters/tls-pin'
import { hasRole } from '../lib/roles'

declare module 'fastify' {
  interface FastifyRequest { haHandled?: boolean }
}

let service: HAControlService | null = null

export function productionHAControl(): HAControlService {
  return new HAControlService({
    store: new InstanceStore(
      { get: getCredential, set: setCredential, remove: deleteProviderCredentials },
      id => !!getCluster(id),
    ),
    audit: auditCredentialUse,
    publish: e => publish(e),
    cluster: id => { const c = getCluster(id); return c ? { id: c.id, name: c.name, kind: c.kind } : null },
  })
}

/** For tests: the service the routes use. */
export function setHAControlService(s: HAControlService | null): void { service = s }
function svc(): HAControlService { return service ?? (service = productionHAControl()) }
function store(): InstanceStore { return svc().instances }

/** On a remote cluster's page, the cluster whose houses this request may reach. */
function scope(): string | null {
  const c = clusterContext.getStore()
  return c && c.kind === 'remote' ? c.id : null
}

function actor(req: FastifyRequest): Actor {
  const s = req.session!
  return { sid: s.sid, email: s.email, role: s.role, token: req.apiToken?.name ?? null }
}

function fail(reply: FastifyReply, e: any) {
  if (e instanceof ActionRefusal) return reply.status(e.status).send({ success: false, code: e.code, error: e.message, ...e.extra })
  if (e instanceof InstanceInputError) return reply.status(e.status).send({ success: false, code: 'bad_input', error: e.message })
  throw e   // the gate's error handler answers vault-locked and session errors
}

/** Below operator, a house is its name, its link and its role setting: no address, no protected lists, no pin. */
const isViewer = (req: FastifyRequest) => !hasRole(req.session?.role ?? 'viewer', 'operator')

function view(m: InstanceMeta & { url?: string; hasToken?: boolean }, viewer = false) {
  const c = svc().clusterOf(m)
  const out = { ...m, cluster: c, remote: c?.kind === 'remote' }
  if (!viewer) return out
  const { url: _u, fingerprint: _f, ...rest } = out
  return { ...rest, policy: { ...m.policy, protected: [], securityDomains: [], everyday: [] } }
}

type P = { Params: { iid: string } }

export const haControlRoutes: FastifyPluginAsync = async (fastify) => {
  // Refusals the gate makes (role, re-confirmation, lock, token) never reach a handler: record those too.
  fastify.addHook('onResponse', async (req, reply) => {
    if (req.method !== 'POST' || req.haHandled || reply.statusCode < 400) return
    const m = /\/instances\/([^/]+)\/(actions|secure-actions)$/.exec(req.url.split('?')[0])
    if (!m) return
    const code = (reply.statusCode === 403 ? 'gate_403' : reply.statusCode === 401 ? 'gate_401' : reply.statusCode === 423 ? 'gate_locked' : `gate_${reply.statusCode}`)
    const s = req.session
    await svc().auditRefusal(m[1], s ? { sid: s.sid, email: s.email, role: s.role, token: req.apiToken?.name ?? null } : null,
      (req.body ?? {}) as Record<string, unknown>, code).catch(() => {})
  })

  fastify.get('/instances', async (req, reply) => {
    try {
      const sc = scope()
      const rows = (await store().views()).filter(v => !sc || v.clusterId === sc)
      return { success: true, data: rows.map(r => view(r, isViewer(req))) }
    } catch (e) { return fail(reply, e) }
  })

  fastify.post<{ Body: Record<string, unknown> }>('/instances', async (req, reply) => {
    try {
      const m = await store().create(req.body ?? {})
      await auditCredentialUse('ha.instance.create', `home-assistant:${m.id}`, { by: req.session!.email, name: m.name, cluster: m.clusterId })
      return reply.status(201).send({ success: true, data: view(m) })
    } catch (e) { return fail(reply, e) }
  })

  fastify.put<P & { Body: Record<string, unknown> }>('/instances/:iid', async (req, reply) => {
    try {
      const b = req.body ?? {}
      const prev = await store().get(req.params.iid)
      const m = await store().update(req.params.iid, b)
      await auditCredentialUse('ha.instance.update', `home-assistant:${m.id}`, {
        by: req.session!.email, name: m.name, cluster: m.clusterId,
        changed: Object.keys(b).filter(k => b[k] !== undefined && !(k === 'token' && b[k] === '')).map(k => k === 'token' ? 'credential' : k),
      })
      // Moving a device to everyday takes away its confirm step: its own audit row, entity by entity.
      const before = new Set([...(prev?.policy.everyday ?? [])])
      const demoted = m.policy.everyday.filter(e => !before.has(e))
      const protectedRemoved = (prev?.policy.protected ?? []).filter(e => !m.policy.protected.includes(e))
      const domainsRemoved = (prev?.policy.securityDomains ?? []).filter(d => !m.policy.securityDomains.includes(d))
      if (demoted.length || protectedRemoved.length || domainsRemoved.length) {
        await auditCredentialUse('ha.instance.demote', `home-assistant:${m.id}`, { by: req.session!.email, name: m.name, everydayAdded: demoted, protectedRemoved, domainsRemoved })
      }
      return { success: true, data: view(m) }
    } catch (e) { return fail(reply, e) }
  })

  fastify.delete<P>('/instances/:iid', async (req, reply) => {
    try {
      await store().remove(req.params.iid)
      await auditCredentialUse('ha.instance.remove', `home-assistant:${req.params.iid}`, { by: req.session!.email })
      return { success: true }
    } catch (e) { return fail(reply, e) }
  })

  // The certificate a house presents, for pinning (admin; checked against the same address rules first).
  fastify.post<{ Body: { url?: unknown } }>('/instances/probe-certificate', async (req, reply) => {
    try {
      const u = new URL(String(req.body?.url ?? ''))
      if (u.protocol !== 'https:') return reply.status(400).send({ success: false, code: 'bad_input', error: 'Only an https:// address has a certificate to pin.' })
      const address = await resolveHATarget(u)
      const cert = await probeCertificate(address, portOf(u))
      return { success: true, data: { fingerprint: cert.fingerprint, subject: cert.subject, issuer: cert.issuer, validTo: cert.validTo } }
    } catch (e: any) {
      return reply.status(400).send({ success: false, code: 'bad_input', error: e?.name === 'HATargetError' ? e.message : 'Could not read a certificate from that address.' })
    }
  })

  fastify.get<P>('/instances/:iid/status', async (req, reply) => {
    try {
      const st = await svc().status(req.params.iid, scope())
      // Whether the token is a Home Assistant admin is for the people who manage it.
      return { success: true, data: isViewer(req) ? { ...st, user: null } : st }
    } catch (e) { return fail(reply, e) }
  })

  fastify.get<P>('/instances/:iid/health', async (req, reply) => {
    try { return { success: true, data: { ok: true, ...(await svc().health(req.params.iid, 20, scope())) } } }
    catch (e: any) {
      if (e instanceof ActionRefusal && e.status === 404) return fail(reply, e)
      return { success: true, data: { ok: false, error: e?.message ?? 'Home Assistant could not be read.' } }
    }
  })

  fastify.get<P>('/instances/:iid/devices', async (req, reply) => {
    try { return { success: true, data: await svc().devices(req.params.iid, scope(), { viewer: isViewer(req), actor: actor(req) }) } }
    catch (e: any) {
      if (e instanceof ActionRefusal) return fail(reply, e)
      // Unreachable is a normal state for a house on the far side of a VPN: say so, do not fail the page.
      return { success: true, data: { unreachable: true, error: e?.name === 'HAUnreachableError' ? e.message : 'Home Assistant could not be read.', areas: [] } }
    }
  })

  fastify.post<P & { Body: Record<string, unknown> }>('/instances/:iid/actions', async (req, reply) => {
    req.haHandled = true
    try { return { success: true, data: await svc().act(req.params.iid, req.body ?? {}, actor(req), false, scope()) } }
    catch (e) { return fail(reply, e) }
  })

  fastify.post<P & { Body: Record<string, unknown> }>('/instances/:iid/secure-actions', async (req, reply) => {
    req.haHandled = true
    try { return { success: true, data: await svc().act(req.params.iid, req.body ?? {}, actor(req), true, scope()) } }
    catch (e) { return fail(reply, e) }
  })
}
