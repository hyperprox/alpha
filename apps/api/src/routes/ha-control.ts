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

function view(m: InstanceMeta & { url?: string; hasToken?: boolean }) {
  const c = svc().clusterOf(m)
  return { ...m, cluster: c, remote: c?.kind === 'remote' }
}

type P = { Params: { iid: string } }

export const haControlRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/instances', async (_req, reply) => {
    try {
      const sc = scope()
      const rows = (await store().views()).filter(v => !sc || v.clusterId === sc)
      return { success: true, data: rows.map(view) }
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
      const m = await store().update(req.params.iid, b)
      await auditCredentialUse('ha.instance.update', `home-assistant:${m.id}`, {
        by: req.session!.email, name: m.name, cluster: m.clusterId,
        changed: Object.keys(b).filter(k => b[k] !== undefined && !(k === 'token' && b[k] === '')).map(k => k === 'token' ? 'credential' : k),
      })
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

  fastify.get<P>('/instances/:iid/status', async (req, reply) => {
    try { return { success: true, data: await svc().status(req.params.iid, scope()) } } catch (e) { return fail(reply, e) }
  })

  fastify.get<P>('/instances/:iid/health', async (req, reply) => {
    try { return { success: true, data: { ok: true, ...(await svc().health(req.params.iid, 20, scope())) } } }
    catch (e: any) {
      if (e instanceof ActionRefusal && e.status === 404) return fail(reply, e)
      return { success: true, data: { ok: false, error: e?.message ?? 'Home Assistant could not be read.' } }
    }
  })

  fastify.get<P>('/instances/:iid/devices', async (req, reply) => {
    try { return { success: true, data: await svc().devices(req.params.iid, scope()) } }
    catch (e: any) {
      if (e instanceof ActionRefusal) return fail(reply, e)
      // Unreachable is a normal state for a house on the far side of a VPN: say so, do not fail the page.
      return { success: true, data: { unreachable: true, error: e?.name === 'HAUnreachableError' ? e.message : 'Home Assistant could not be read.', areas: [] } }
    }
  })

  fastify.post<P & { Body: Record<string, unknown> }>('/instances/:iid/actions', async (req, reply) => {
    try { return { success: true, data: await svc().act(req.params.iid, req.body ?? {}, actor(req), false, scope()) } }
    catch (e) { return fail(reply, e) }
  })

  fastify.post<P & { Body: Record<string, unknown> }>('/instances/:iid/secure-actions', async (req, reply) => {
    try { return { success: true, data: await svc().act(req.params.iid, req.body ?? {}, actor(req), true, scope()) } }
    catch (e) { return fail(reply, e) }
  })
}
