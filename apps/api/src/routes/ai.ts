// =============================================================================
//  HyperProx — AI Deployment Wizard Routes
//  Natural language → structured action plan → execute
//
//  The plan itself is produced in lib/ai: the schema, the prompt and the three
//  providers live there so that adding a fourth does not mean touching routing.
//  What stays here is everything that is about *this* cluster — gathering the
//  facts the model plans against, and auditing what it returns before a user is
//  shown a plan the cluster cannot run.
// =============================================================================

import { FastifyPluginAsync } from 'fastify'
import { setCredential }      from '../lib/credentials'
import { executeWizardJob, getJob } from '../lib/wizard-executor'
import { gatherFacts }        from '../lib/ai/facts'
import { userPrompt }         from '../lib/ai/prompt'
import { auditPlan }          from '../lib/ai/plan-schema'
import {
  generatePlan, listProviders, activeProvider, setActiveProvider, type ProviderId,
} from '../lib/ai/providers'

const PROVIDER_IDS: ProviderId[] = ['anthropic', 'openai', 'ollama']

function isProvider(v: unknown): v is ProviderId {
  return typeof v === 'string' && (PROVIDER_IDS as string[]).includes(v)
}

export const aiRoutes: FastifyPluginAsync = async (fastify) => {

  // ── Providers ──────────────────────────────────────────────────────────────

  // GET /api/ai/providers — what can plan, and what each still needs
  fastify.get('/providers', async (_req, reply) => {
    const [providers, active] = await Promise.all([listProviders(), activeProvider()])
    return reply.send({ ok: true, active, providers })
  })

  // POST /api/ai/provider/select — choose which one the wizard uses
  fastify.post<{ Body: { provider: string } }>('/provider/select', async (req, reply) => {
    const { provider } = req.body ?? {}
    if (!isProvider(provider)) {
      return reply.status(400).send({ ok: false, error: `provider must be one of ${PROVIDER_IDS.join(', ')}` })
    }
    await setActiveProvider(provider)
    return reply.send({ ok: true, active: provider })
  })

  // PUT /api/ai/provider/:id — store this provider's key, model or base URL
  fastify.put<{
    Params: { id: string }
    Body:   { api_key?: string; model?: string; base_url?: string; url?: string }
  }>('/provider/:id', async (req, reply) => {
    const id = req.params.id
    if (!isProvider(id)) return reply.status(400).send({ ok: false, error: 'unknown provider' })

    const body = req.body ?? {}
    const saved: string[] = []

    // An empty string clears a setting; undefined leaves it alone. That
    // distinction is what lets the UI send only the field the user edited.
    for (const [key, masked] of [
      ['api_key', true], ['model', false], ['base_url', false], ['url', false],
    ] as Array<[keyof typeof body, boolean]>) {
      const value = body[key]
      if (value === undefined) continue
      await setCredential('ai', id, String(key), value, masked)
      saved.push(String(key))
    }

    if (!saved.length) return reply.status(400).send({ ok: false, error: 'nothing to save' })
    return reply.send({ ok: true, provider: id, saved })
  })

  // POST /api/ai/provider/test — a real round trip, not a reachability check
  fastify.post<{ Body: { provider?: string } }>('/provider/test', async (req, reply) => {
    const id = req.body?.provider
    if (id !== undefined && !isProvider(id)) {
      return reply.status(400).send({ ok: false, error: 'unknown provider' })
    }
    const started = Date.now()
    try {
      // The smallest request that still exercises structured output end to end.
      const facts = await gatherFacts()
      const plan  = await generatePlan(
        userPrompt('Deploy Uptime Kuma. No domain yet.', facts), id)
      return reply.send({
        ok: true,
        ms: Date.now() - started,
        provider: id ?? await activeProvider(),
        sample: { service: plan.service, steps: plan.steps.length, warnings: plan.warnings },
      })
    } catch (err: any) {
      return reply.status(502).send({ ok: false, ms: Date.now() - started, error: err.message })
    }
  })

  // ── The wizard ─────────────────────────────────────────────────────────────

  // POST /api/ai/wizard/plan — natural language → action plan
  fastify.post<{ Body: { prompt: string; provider?: string; model?: string } }>(
    '/wizard/plan', async (req, reply) => {
      const { prompt, provider } = req.body ?? {}
      if (!prompt) return reply.status(400).send({ ok: false, error: 'prompt is required' })
      if (provider !== undefined && !isProvider(provider)) {
        return reply.status(400).send({ ok: false, error: 'unknown provider' })
      }

      const chosen = provider ?? await activeProvider()

      // A per-request model override is only meaningful for Ollama, where the
      // UI lists the models that are actually installed. Persist it so the
      // dropdown and the next request agree.
      if (req.body.model && chosen === 'ollama') {
        await setCredential('ai', 'ollama', 'model', req.body.model, false)
      }

      let facts
      try {
        facts = await gatherFacts()
      } catch (err: any) {
        return reply.status(502).send({
          ok: false,
          error: `Cannot read the cluster, so there is nothing to plan against: ${err.message}`,
        })
      }

      let plan
      try {
        plan = await generatePlan(userPrompt(prompt, facts), chosen)
      } catch (err: any) {
        return reply.status(502).send({ ok: false, provider: chosen, error: err.message })
      }

      // No service named means this was a question, not a deployment request.
      if (!plan.service) {
        return reply.send({
          ok: true,
          conversational: true,
          provider: chosen,
          message: plan.understood ||
            'Describe a service to deploy, e.g. "Deploy Nextcloud at cloud.mydomain.com".',
        })
      }

      // The model's own warnings are what it noticed; the audit's are what the
      // cluster says. Both go in front of the user before anything is created.
      const problems = auditPlan(plan, facts)
      const warnings = [...new Set([...plan.warnings, ...problems])]

      return reply.send({
        ok: true,
        provider: chosen,
        model: (await listProviders()).find(p => p.id === chosen)?.model,
        plan: { ...plan, warnings },
        // `blocked` is the plan being unrunnable as written, not merely
        // imperfect — the UI uses it to decide whether Execute is offered.
        blocked: problems.length > 0,
        facts: {
          nodes:    facts.nodes.map(n => n.node),
          storages: facts.storages.map(s => s.storage),
          domains:  facts.domains,
          nextVmid: facts.nextVmid,
        },
      })
    })

  // POST /api/ai/wizard/execute — execute a confirmed action plan
  fastify.post<{ Body: { plan: any } }>('/wizard/execute', async (req, reply) => {
    const { plan } = req.body
    if (!plan?.steps) return reply.status(400).send({ error: 'Invalid plan' })

    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(-4)}`

    // Fire-and-forget — execution runs in background, progress via WebSocket
    setImmediate(() => {
      executeWizardJob(jobId, plan).catch(err =>
        fastify.log.error(`[wizard] Job ${jobId} failed: ${err.message}`)
      )
    })

    return reply.send({
      ok:      true,
      jobId,
      message: `Executing ${plan.steps.length} steps. Track progress via WebSocket.`,
      steps:   plan.steps.length,
    })
  })

  // GET /api/ai/wizard/jobs/:jobId — get execution status (REST fallback for WS)
  fastify.get<{ Params: { jobId: string } }>('/wizard/jobs/:jobId', async (req, reply) => {
    const job = getJob(req.params.jobId)
    if (!job) return reply.status(404).send({ ok: false, error: 'Job not found' })

    return reply.send({
      ok:          true,
      jobId:       job.jobId,
      status:      job.status,
      currentStep: job.currentStep,
      totalSteps:  job.steps.length,
      steps:       job.steps,
      lxcVmid:    job.lxcVmid,
      lxcNode:    job.lxcNode,
      lxcIp:      job.lxcIp,
      startedAt:   job.startedAt,
      completedAt: job.completedAt,
      error:       job.error,
    })
  })

  // POST /api/ai/model/select — set the active Ollama model
  fastify.post<{ Body: { model: string } }>('/model/select', async (req, reply) => {
    const { model } = req.body
    if (!model) return reply.status(400).send({ error: 'model is required' })
    await setCredential('ai', 'ollama', 'model', model, false)
    return reply.send({ ok: true, model })
  })
}
