// =============================================================================
//  HyperProx — K3s routes (/api/plugins/k3s)
//
//  Roles (lib/roles.ts): the cluster list and a reading are viewer, like every
//  plug-in page; below admin a cluster's address and the pods' last log lines
//  are left out. Logs and the drain preview are admin (logs can hold anything
//  an app printed). Connecting, renaming or removing a cluster, and every
//  action, are admin with the master password re-entered, which also keeps API
//  tokens out; the service refuses a token again by name.
//
//  No route returns a token, a kubeconfig or a join token: those stay in the
//  vault, where the person can reveal them.
// =============================================================================

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { hasRole } from '../lib/roles'
import { k3sService } from '../lib/k3s'
import { K3sRefusal, plainK3s, type Actor } from '../lib/k3s/service'
import { K3sInputError, type K3sMeta } from '../lib/k3s/instances'
import { KubeconfigError } from '../lib/k3s/kubeconfig'
import type { FixAction, Reading } from '../lib/k3s/parse'
import { actorOf } from '../lib/http/request-actor'
import { sendRefusal } from '../lib/failure'

const svc = () => k3sService()
const isAdminReq = (req: FastifyRequest) => hasRole(req.session?.role ?? 'viewer', 'admin')
const actor = (req: FastifyRequest): Actor => { const a = actorOf(req); return { email: a.email, role: a.role, token: a.token } }

function fail(reply: FastifyReply, e: any) {
  if (e instanceof K3sRefusal) return sendRefusal(reply, e.status, e.code, e.message, e.extra)
  if (e instanceof K3sInputError) return sendRefusal(reply, e.status, 'bad_input', e.message)
  if (e instanceof KubeconfigError) return sendRefusal(reply, 400, 'bad_kubeconfig', e.message)
  throw e
}

/** What a viewer sees: no address, no log lines. */
export function viewOf<T extends Partial<K3sMeta> & { url?: string }>(m: T, admin: boolean): T {
  if (admin) return m
  const { url: _u, ...rest } = m
  return rest as T
}
export function readingFor(r: Reading, admin: boolean): Reading {
  if (admin) return r
  return { ...r, problems: r.problems.map(({ lastLines: _l, ...p }) => p) }
}

const ACTIONS: FixAction[] = ['restart', 'rollback', 'scale', 'delete-pod', 'cordon', 'uncordon', 'drain']

type P = { Params: { id: string } }

export const k3sRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/clusters', async (req, reply) => {
    try { return { success: true, data: (await svc().views()).map(v => viewOf(v, isAdminReq(req))) } }
    catch (e) { return fail(reply, e) }
  })

  // Found by the scan, but no K3s login could be read there (admin: it names guests).
  fastify.get('/waiting', async (_req, reply) => {
    try { return { success: true, data: svc().waiting() } } catch (e) { return fail(reply, e) }
  })

  // A cluster that cannot be read is a normal state: 200 with ok:false and the reason.
  fastify.get<P & { Querystring: { fresh?: string } }>('/clusters/:id/reading', async (req, reply) => {
    try {
      const r = await svc().reading(req.params.id, { fresh: req.query.fresh === '1' })
      return { success: true, data: { ok: true, reading: readingFor(r, isAdminReq(req)) } }
    } catch (e: any) {
      if (e instanceof K3sRefusal && e.status === 404) return fail(reply, e)
      return { success: true, data: { ok: false, error: plainK3s(e, 'The cluster could not be read') } }
    }
  })

  // Connect by pasting a kubeconfig: only when HyperProx could not find the cluster's login itself.
  fastify.post<{ Body: Record<string, unknown> }>('/clusters', async (req, reply) => {
    try { return reply.status(201).send({ success: true, data: viewOf(await svc().add(req.body ?? {}, actor(req)), true) }) }
    catch (e) { return fail(reply, e) }
  })

  fastify.put<P & { Body: { name?: unknown } }>('/clusters/:id', async (req, reply) => {
    try { return { success: true, data: await svc().rename(req.params.id, req.body?.name, actor(req)) } }
    catch (e) { return fail(reply, e) }
  })

  fastify.delete<P & { Querystring: { force?: string } }>('/clusters/:id', async (req, reply) => {
    try { return { success: true, data: await svc().remove(req.params.id, actor(req), req.query.force === '1') } }
    catch (e) { return fail(reply, e) }
  })

  fastify.get<P & { Querystring: { namespace?: string; pod?: string; container?: string; previous?: string } }>('/clusters/:id/logs', async (req, reply) => {
    try {
      const q = req.query
      return { success: true, data: await svc().logs(req.params.id, String(q.namespace ?? ''), String(q.pod ?? ''), q.container, q.previous === '1', actor(req)) }
    } catch (e) { return fail(reply, e) }
  })

  // What a drain will move, keep and lose, for the confirmation. Reads only.
  fastify.post<P & { Body: { node?: unknown } }>('/clusters/:id/drain-preview', async (req, reply) => {
    try { return { success: true, data: await svc().drainPreview(req.params.id, String(req.body?.node ?? ''), actor(req)) } }
    catch (e) { return fail(reply, e) }
  })

  fastify.post<P & { Params: { action: string }; Body: Record<string, unknown> }>('/clusters/:id/actions/:action', async (req, reply) => {
    const a = req.params.action as FixAction
    if (!ACTIONS.includes(a)) return sendRefusal(reply, 404, 'no_action', 'That is not an action HyperProx takes on a cluster.')
    try { return { success: true, data: await svc().act(req.params.id, a, req.body ?? {}, actor(req)) } }
    catch (e) { return fail(reply, e) }
  })
}
