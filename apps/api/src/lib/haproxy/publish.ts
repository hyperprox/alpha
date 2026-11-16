// =============================================================================
//  HyperProx — HAProxy: publishing a load-balanced app's public name
//
//  The one place "Load-balance this app" turns a host name into a DNS record,
//  a proxy host and a certificate, shared by the plug-in's button (routes/
//  haproxy.ts) and the Catalogue install's optional step (lib/haproxy/
//  install-balance.ts). The name is planned first, so a refusal there changes
//  nothing; the run itself goes on in the background as a PublishJob.
// =============================================================================

import { findRecipe } from '../catalogue'
import { HAPROXY_RECIPE_ID } from './recipe'
import { HaproxyRefusal } from './service'
import { PUBLISH_JOBS, newJobId, prunePublishJobs, type PublishJob } from './index'
import type { PublishDeps } from '../sites'

/**
 * Plans the public name in `body` (hostname, zone, proxyInstanceId) and returns what starts the publish once HAProxy
 * has saved the backend. Throws a HaproxyRefusal when the name is not in the domain or cannot be planned.
 */
export async function planLoadBalancePublish(body: Record<string, unknown>, actor: { email: string }, deps?: PublishDeps): Promise<(ip: string) => Promise<{ jobId: string }>> {
  const { planPublish, realPublishDeps, runPublish, cleanupPublish, PUBLISH_STEPS } = await import('../sites')
  const host = String(body.hostname ?? '').trim().toLowerCase()
  const zone = String(body.zone ?? '').trim().toLowerCase()
  if (!host || !zone || !(host === zone || host.endsWith(`.${zone}`))) throw new HaproxyRefusal('bad_input', 'The public name must be in the domain you picked, such as app.example.com in example.com.')
  const d = deps ?? realPublishDeps()
  const planned = await planPublish({ zone, name: host === zone ? '@' : host.slice(0, -(zone.length + 1)), instanceId: String(body.proxyInstanceId ?? '') }, d)
  if (!planned.plan || planned.errors.length) throw new HaproxyRefusal('publish_plan', planned.errors.join(' ') || 'The public name could not be planned.')
  const plan = planned.plan
  const recipe = findRecipe(HAPROXY_RECIPE_ID)!
  // The public check asks for the app's own page through HAProxy, not HAProxy's "no server" page.
  const lbRecipe = { ...recipe, port: 80, healthPath: '/', expectStatus: [200, 301, 302, 401, 403], healthBody: undefined }
  return async ip => {
    prunePublishJobs()
    const job: PublishJob = { id: newJobId(), domain: plan.domain, status: 'running', owner: actor.email, startedAt: Date.now(), ledger: {},
      steps: PUBLISH_STEPS.map(s => ({ id: s.id, label: s.label, status: 'pending' })) }
    PUBLISH_JOBS.set(job.id, job)
    const step = (id: string) => { const s = job.steps.find(x => x.id === id)!; for (const x of job.steps) if (x.status === 'running') x.status = 'done'; s.status = 'running'; return s }
    void runPublish(plan, lbRecipe, ip, actor.email, job.ledger, { step, save: () => {} }, d)
      .then(url => { job.status = 'done'; job.url = url; job.finishedAt = Date.now(); for (const x of job.steps) if (x.status === 'running') x.status = 'done' })
      .catch(async (e: any) => {
        job.error = String(e?.message ?? e).slice(0, 400)
        for (const x of job.steps) if (x.status === 'running') { x.status = 'failed'; x.detail = job.error }
        // What this run made (proxy host, DNS record) is removed again, so a failed publish leaves nothing half-made.
        // HAProxy's backend and rule stay: they were saved and work on their own.
        job.cleanup = await cleanupPublish(job.ledger, actor.email, d).catch((c: any) => [`Clean-up failed: ${String(c?.message ?? c).slice(0, 200)}`])
        job.status = 'failed'; job.finishedAt = Date.now()
      })
    return { jobId: job.id }
  }
}
