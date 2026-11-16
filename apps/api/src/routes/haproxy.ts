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
import { haproxyService, syncHaproxyTargets, PUBLISH_JOBS, newJobId, prunePublishJobs, type PublishJob } from '../lib/haproxy'
import { HaproxyRefusal } from '../lib/haproxy/service'
import { RuntimeRefusal } from '../lib/haproxy/runtime'
import { ALGORITHMS } from '../lib/haproxy/dataplane'
import { findRecipe } from '../lib/catalogue'
import { HAPROXY_RECIPE_ID } from '../lib/haproxy/recipe'

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
      if (body.publish === true) {
        const { planPublish, realPublishDeps, runPublish, cleanupPublish, PUBLISH_STEPS } = await import('../lib/sites')
        const host = String(body.hostname ?? '').trim().toLowerCase()
        const zone = String(body.zone ?? '').trim().toLowerCase()
        if (!host || !zone || !(host === zone || host.endsWith(`.${zone}`))) return sendRefusal(reply, 400, 'bad_input', 'The public name must be in the domain you picked, such as app.example.com in example.com.')
        const deps = realPublishDeps()
        const planned = await planPublish({ zone, name: host === zone ? '@' : host.slice(0, -(zone.length + 1)), instanceId: String(body.proxyInstanceId ?? '') }, deps)
        if (!planned.plan || planned.errors.length) return sendRefusal(reply, 400, 'publish_plan', planned.errors.join(' ') || 'The public name could not be planned.')
        const plan = planned.plan
        const recipe = findRecipe(HAPROXY_RECIPE_ID)!
        // The public check asks for the app's own page through HAProxy, not HAProxy's "no server" page.
        const lbRecipe = { ...recipe, port: 80, healthPath: '/', expectStatus: [200, 301, 302, 401, 403], healthBody: undefined }
        publish = async ip => {
          prunePublishJobs()
          const job: PublishJob = { id: newJobId(), domain: plan.domain, status: 'running', owner: actor.email, startedAt: Date.now(), ledger: {},
            steps: PUBLISH_STEPS.map(s => ({ id: s.id, label: s.label, status: 'pending' })) }
          PUBLISH_JOBS.set(job.id, job)
          const step = (id: string) => { const s = job.steps.find(x => x.id === id)!; for (const x of job.steps) if (x.status === 'running') x.status = 'done'; s.status = 'running'; return s }
          void runPublish(plan, lbRecipe, ip, actor.email, job.ledger, { step, save: () => {} }, deps)
            .then(url => { job.status = 'done'; job.url = url; job.finishedAt = Date.now(); for (const x of job.steps) if (x.status === 'running') x.status = 'done' })
            .catch(async (e: any) => {
              job.error = String(e?.message ?? e).slice(0, 400)
              for (const x of job.steps) if (x.status === 'running') { x.status = 'failed'; x.detail = job.error }
              // What this run made (proxy host, DNS record) is removed again, so a failed publish leaves nothing half-made.
              // HAProxy's backend and rule stay: they were saved and work on their own.
              job.cleanup = await cleanupPublish(job.ledger, actor.email, deps).catch((c: any) => [`Clean-up failed: ${String(c?.message ?? c).slice(0, 200)}`])
              job.status = 'failed'; job.finishedAt = Date.now()
            })
          return { jobId: job.id }
        }
      }
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
