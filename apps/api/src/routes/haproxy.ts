// =============================================================================
//  HyperProx — HAProxy routes (/api/plugins/haproxy)
//
//  Roles (lib/roles.ts): admin for every method, reads included (a reading maps
//  backend addresses, and the guest picker maps the cluster). Every action is
//  audited by the service before it runs. No route takes a command, a path or
//  a socket: actions are named, their values checked against HAProxy's own
//  name and number rules (lib/haproxy/runtime.ts).
//
//  "Load-balance this app" with a public name plans the name first (lib/sites
//  planPublish: the zone, a free record, the proxy, the certificate), so a
//  refusal there changes nothing; the HAProxy change comes next, then the
//  proxy host, DNS record and certificate run in the background.
// =============================================================================

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { actorOf } from '../lib/http/request-actor'
import { sendRefusal } from '../lib/failure'
import { haproxyService, syncHaproxyTargets, PUBLISH_JOBS } from '../lib/haproxy'
import { HaproxyRefusal } from '../lib/haproxy/service'
import { RuntimeRefusal } from '../lib/haproxy/runtime'
import { ALGORITHMS } from '../lib/haproxy/dataplane'
import { planLoadBalancePublish } from '../lib/haproxy/publish'

function fail(reply: FastifyReply, e: any) {
  if (e instanceof HaproxyRefusal) return sendRefusal(reply, e.status, e.code, e.message)
  if (e instanceof RuntimeRefusal) return sendRefusal(reply, 400, 'bad_input', e.message)
  if (e?.name === 'ProxyRefusal') return sendRefusal(reply, e.status ?? 422, 'refused', e.message)
  if (e?.name === 'GuestExcludedRefusal' || e?.name === 'ExclusionsUnknownRefusal') return sendRefusal(reply, e.status ?? 409, e.code ?? 'excluded', e.message)
  if (e?.name === 'TransportError') return sendRefusal(reply, 502, 'unreachable', e.message)
  throw e
}

type P = { Params: { iid: string } }

export const haproxyRoutes: FastifyPluginAsync = async (fastify) => {
  const svc = () => haproxyService()

  fastify.get('/instances', async (_req, reply) => {
    try { return { success: true, data: { instances: await svc().list(), algorithms: ALGORITHMS } } } catch (e) { return fail(reply, e) }
  })

  // The whole reading. One that cannot be read is a normal state: 200 with ok:false and the reason.
  fastify.get<P>('/instances/:iid/reading', async (req, reply) => {
    try { return { success: true, data: { ok: true, reading: await svc().reading(req.params.iid) } } } catch (e: any) {
      if (e instanceof HaproxyRefusal && e.code === 'no_instance') return fail(reply, e)
      return { success: true, data: { ok: false, code: e?.code ?? null, error: e instanceof HaproxyRefusal || e?.name === 'TransportError' || e?.name === 'GuestExcludedRefusal' ? e.message : 'HAProxy could not be read.' } }
    }
  })

  // The guests the picker offers (running, not left alone, with an address).
  fastify.get('/guests', async (_req, reply) => {
    try { return { success: true, data: await svc().pickable() } } catch (e) { return fail(reply, e) }
  })

  fastify.post<P & { Params: { action: string }; Body: Record<string, unknown> }>('/instances/:iid/actions/:action', async (req, reply) => {
    try { return { success: true, data: await svc().act(req.params.iid, req.params.action, req.body ?? {}, actorOf(req)) } } catch (e) { return fail(reply, e) }
  })

  fastify.post<P & { Body: Record<string, unknown> }>('/instances/:iid/load-balance', async (req, reply) => {
    try {
      const body = req.body ?? {}
      const actor = actorOf(req)
      let publish: ((ip: string) => Promise<{ jobId: string }>) | undefined
      if (body.publish === true) publish = await planLoadBalancePublish(body, actor)
      return { success: true, data: await svc().loadBalance(req.params.iid, body, actor, publish) }
    } catch (e) { return fail(reply, e) }
  })

  fastify.get<{ Params: { jobId: string } }>('/publish-jobs/:jobId', async (req, reply) => {
    const job = PUBLISH_JOBS.get(req.params.jobId)
    if (!job) return sendRefusal(reply, 404, 'no_job', 'That publish is not known (HyperProx may have restarted since).')
    return { success: true, data: job }
  })

  // Disconnect: HAProxy is not touched; auto-connect remembers, so it is not added back by itself.
  fastify.delete<P>('/instances/:iid', async (req, reply) => {
    try {
      const r = await svc().remove(req.params.iid, actorOf(req))
      await syncHaproxyTargets().catch(() => false)
      return { success: true, data: r }
    } catch (e) { return fail(reply, e) }
  })
}
