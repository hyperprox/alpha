// =============================================================================
//  HyperProx — AI Deployment Wizard Routes
//  Natural language → template fields → questions → a server-held run → execute
//
//  The model only reads the template's extractable fields out of the request;
//  derive and validate in the template fill and check everything else against
//  the cluster. What the browser holds is a plan id: the run that executes is
//  the server's copy, derived and validated again against fresh facts first.
// =============================================================================

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { randomUUID }         from 'crypto'
import { setCredential }      from '../lib/credentials'
import { executeDeployJob, getJob, type DeployRun, type JobState } from '../lib/wizard-executor'
import { gatherTemplateFacts } from '../lib/ai/facts'
import { PreparedStore }      from '../lib/ai/prepared'
import { currentContext, type RequestContext } from '../lib/auth'
import { startLoop, type Extraction, type IntentResult, type LoopDeps } from '../lib/ai/loop'
import { matchIntent, NO_TASK_ANSWER } from '../lib/ai/intent'
import { answerQuestion, type AskSource } from '../lib/ai/ask'
import { coreSources, pluginSources, type CertLite } from '../lib/ai/ask-sources'
import { PLUGINS }            from '../plugins'
import { ProxmoxClient }      from '../lib/proxmox-client'
import type { ModelCall }     from '../lib/ai/extract'
import { runPluginSummary }   from '../lib/plugin-host'
import { isUnlocked }         from '../lib/vault/state'
import { productionCertsService } from '../lib/certs/service'
import { extractFields }      from '../lib/ai/extract'
import { getTemplate }        from '../lib/ai/templates'
import { deployService, toDeployFields, type DeployFields } from '../lib/ai/templates/deploy-service'
import type { Fields, TaskTemplate, TemplateFacts, TemplateSettings } from '../lib/ai/templates/types'
import { wizardRecipes }      from '../lib/catalogue'
import { zoneFor }            from '../lib/dns-zones'
import {
  callStructured, listProviders, activeProvider, setActiveProvider,
  type ProviderId, type ProviderInfo,
} from '../lib/ai/providers'

const PROVIDER_IDS: ProviderId[] = ['anthropic', 'openai', 'ollama']

function isProvider(v: unknown): v is ProviderId {
  return typeof v === 'string' && (PROVIDER_IDS as string[]).includes(v)
}

/**
 * What the routes reach outside themselves for. Tests pass fakes; production
 * takes the defaults below.
 */
export interface AiRouteDeps {
  facts(): Promise<TemplateFacts>
  settings(): Promise<TemplateSettings>
  /** Which template a request is for; the provider is the one this request chose. */
  intent(prompt: string, provider?: ProviderId, model?: string): Promise<IntentResult>
  /** The template's extractable fields, read from the user's words. */
  extract(t: TaskTemplate, text: string, facts: TemplateFacts,
          opts?: { asking?: { field: string; question: string }; provider?: ProviderId; model?: string }): Promise<Extraction>
  execute(jobId: string, run: DeployRun): Promise<void>
  /** Runs the server derived and validated, waiting to be executed by id. */
  prepared: PreparedStore<DeployRun>
  /** A job by id, for the progress endpoint. */
  job(jobId: string): JobState | undefined
  /** Who is asking; a run can only be executed, and its job read, by the user it was made for. */
  whoami(req: FastifyRequest): string
  /** Keeps the model picked on the AI page as the stored Ollama model. */
  saveModel(model: string): Promise<void>
  activeProvider(): Promise<ProviderId>
  listProviders(): Promise<ProviderInfo[]>
  /** The read-only knowledge sources a question can be answered from; built per request from its facts. */
  sources(facts: TemplateFacts, prisma?: unknown): AskSource[]
  /** The model call for a question. */
  askCall(provider?: ProviderId, model?: string): ModelCall
}

/** Built on the first certificate question and kept: its inventory cache is per instance. */
let certsService: ReturnType<typeof productionCertsService> | undefined

function defaultDeps(): AiRouteDeps {
  return {
    facts: () => gatherTemplateFacts(),
    settings: async () => ({ bridge: 'vmbr0' }),
    intent: (prompt, provider, model) =>
      matchIntent(prompt, { call: r => callStructured(r, provider, undefined, model ? { model } : {}) }),
    extract: (t, text, facts, opts = {}) =>
      extractFields(t, text, facts, {
        asking: opts.asking,
        call: r => callStructured(r, opts.provider, undefined, opts.model ? { model: opts.model } : {}),
      }),
    execute: executeDeployJob,
    prepared: new PreparedStore<DeployRun>(),
    job: getJob,
    whoami: () => ownerOf(currentContext()),
    saveModel: model => setCredential('ai', 'ollama', 'model', model, false),
    activeProvider,
    listProviders,
    sources: (facts, prisma) => {
      const client = new ProxmoxClient(
        process.env.PROXMOX_HOST!, Number(process.env.PROXMOX_PORT ?? 8006),
        `${process.env.PROXMOX_USER}!${process.env.PROXMOX_TOKEN_ID}`, process.env.PROXMOX_TOKEN_SECRET!)
      const fetchStrict = <T,>(p: string) => client.fetchStrict<T>(p)
      return [
        ...coreSources({
          fetchStrict, facts, unlocked: isUnlocked,
          certs: async (): Promise<CertLite[]> => {
            const svc = (certsService ??= productionCertsService(prisma as any, () => {}))
            return (await svc.overview(false)).inventory.map(e => ({ names: e.names, daysLeft: e.daysLeft, notAfter: e.notAfter, verdict: e.verdict, source: e.source }))
          },
        }),
        ...pluginSources({ plugins: PLUGINS, unlocked: isUnlocked, run: runPluginSummary }),
      ]
    },
    askCall: (provider, model) => r => callStructured(r, provider, undefined, model ? { model } : {}),
  }
}

/**
 * Who owns a plan and its job. A signed-in user is their email; an API token is its id, never its name, so
 * a token revoked and re-issued under the same name cannot use the old one's plans.
 */
export function ownerOf(ctx: Pick<RequestContext, 'sid' | 'email'> | undefined): string {
  if (!ctx) return ''
  return ctx.sid?.startsWith('token:') ? ctx.sid : (ctx.email ?? '')
}

// ── Checking a run again before it runs ─────────────────────────────────────

/**
 * The partial sources these fields' validation reads. A source that failed reads as empty (no guests, no
 * zones, no templates), and an empty list passes checks it should fail, so any of these refuses execute.
 */
export function unreadFor(f: DeployFields, facts: TemplateFacts): string[] {
  const n = f.node
  const exact = new Set(['nodes', 'resources', `status:${n}`, `login:${n}`, `network:${n}`, `storage:${n}`])
  // A template already on the node does not need the download list; one still to download does.
  if (!facts.templates.some(t => t.node === n && t.volid === f.template)) exact.add(`aplinfo:${n}`)
  const prefixes = [`templates:${n}/`]
  if (f.ip !== 'dhcp') prefixes.push('config:')
  if (f.exposure === 'public') {
    exact.add('zones'); exact.add('proxy')
    const z = f.domain ? zoneFor(f.domain, facts.zones) : null
    if (z) exact.add(`records:${z.zone}`)
    else prefixes.push('records:')
  }
  return facts.partial.filter(p => exact.has(p) || prefixes.some(x => p.startsWith(x)))
}

/** The stored fields as a person's values again, so derive keeps them and recomputes every fact. */
function asUserFields(t: TaskTemplate, f: DeployFields): Fields {
  const out: Fields = {}
  for (const spec of t.fields) {
    const v = (f as unknown as Record<string, unknown>)[spec.name]
    if (v !== undefined && (spec.source === 'user' || spec.source === 'derived')) out[spec.name] = { value: v, source: 'user' }
  }
  return out
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Re-derive and re-validate against fresh facts: every issue, and every fact that moved, by field. */
function revalidate(t: TaskTemplate, run: DeployRun, facts: TemplateFacts, settings: TemplateSettings): string[] {
  const derived = t.derive(asUserFields(t, run.fields), facts, settings)
  const problems = t.validate(derived, facts).map(i => i.message)
  const stored = run.fields as unknown as Record<string, unknown>
  for (const spec of t.fields) {
    const was = stored[spec.name], now = derived[spec.name]?.value
    if (same(was, now)) continue
    const show = (v: unknown) => (v === undefined || v === null || v === '' ? 'unset' : Array.isArray(v) ? v.join(' ') : String(v))
    problems.push(spec.name === 'gateway'
      ? `The gateway of ${run.fields.bridge} on ${run.fields.node} is now ${show(now)}, not the ${show(was)} this was planned with.`
      : `${spec.name} is now ${show(now)}, not the ${show(was)} this was planned with.`)
  }
  if (!same(t.steps(derived).map(s => s.id), run.steps.map(s => s.id))) problems.push('The steps for this request have changed since it was planned.')
  return [...new Set(problems)]
}

/** What a run in flight holds, so a second run planned against the same facts cannot take it too. */
function claimsOf(f: DeployFields): Array<{ key: string; message: string }> {
  const out = [{ key: `vmid:${f.vmid}`, message: `Container ID ${f.vmid} is being used by a deployment that is running now.` },
               { key: `hostname:${f.hostname}`, message: `${f.hostname} is the hostname of a deployment that is running now.` }]
  if (f.ip !== 'dhcp') {
    const ip = f.ip.split('/')[0]
    out.push({ key: `ip:${ip}`, message: `${ip} is being given to a deployment that is running now.` })
  }
  return out
}

/** A plain account of the fields, written here from the fields, never by the model. */
function understood(f: Fields): string {
  const v = (k: string) => f[k]?.value
  const name = wizardRecipes().find(r => r.id === v('service'))?.name ?? String(v('service') ?? 'a service')
  const where = v('node') ? ` on ${v('node')}` : ''
  const id = v('vmid') ? `CT ${v('vmid')}` : 'a new container'
  const addr = v('ip') === 'dhcp' ? 'DHCP' : v('ip') ? String(v('ip')) : 'no address yet'
  const reach = v('exposure') === 'public' && v('domain') ? `published at ${v('domain')}` : v('exposure') === 'lan' ? 'LAN only' : ''
  return `${name} in ${id}${where} (${addr})${reach ? `, ${reach}` : ''}.`
}

function firstRunNotice(f: Fields): string | null {
  if (f.exposure?.value !== 'public') return null
  const r = wizardRecipes().find(x => x.id === f.service?.value)
  if (!r || r.firstRun.kind === 'none') return null
  return `${r.name} shows a first-run setup page to whoever visits first, so HyperProx will not publish it yet. ` +
         `It installs it on your network and stops before the proxy, DNS and certificate steps; finish setup at its LAN address, then publish it.`
}

export function buildAiRoutes(overrides: Partial<AiRouteDeps> = {}): FastifyPluginAsync {
  const deps: AiRouteDeps = { ...defaultDeps(), ...overrides }
  // Claims of runs in flight, by key; released when the run settles. Checked and taken with no await in
  // between, so two executes racing for one ID or address cannot both pass.
  const claims = new Map<string, string>()
  return async (fastify) => {
    // ── Providers ──────────────────────────────────────────────────────────────

    // GET /api/ai/providers — what can plan, and what each still needs
    fastify.get('/providers', async (_req, reply) => {
      const [providers, active] = await Promise.all([deps.listProviders(), deps.activeProvider()])
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
        const facts = await deps.facts()
        const x = await deps.extract(deployService, 'Deploy Uptime Kuma. No domain yet.', facts, { provider: id })
        return reply.send({
          ok: true,
          ms: Date.now() - started,
          provider: id ?? await deps.activeProvider(),
          sample: { service: x.values.service ?? null, fields: Object.keys(x.values).length },
        })
      } catch (err: any) {
        return reply.status(502).send({ ok: false, ms: Date.now() - started, error: err.message })
      }
    })

    // ── The wizard ─────────────────────────────────────────────────────────────

    // POST /api/ai/wizard/plan — natural language → the template's fields, its questions and its steps
    fastify.post<{ Body: { prompt: string; provider?: string; model?: string } }>(
      '/wizard/plan', async (req, reply) => {
        const { prompt, provider } = req.body ?? {}
        if (!prompt || typeof prompt !== 'string') return reply.status(400).send({ ok: false, error: 'prompt is required' })
        if (provider !== undefined && !isProvider(provider)) {
          return reply.status(400).send({ ok: false, error: 'unknown provider' })
        }

        const chosen = provider ?? await deps.activeProvider()

        // A per-request model is only meaningful for Ollama, where the UI lists the models that are
        // installed. It is used for this request's calls directly (not read back from the store), and
        // persisted so the dropdown and the next request agree.
        const model = chosen === 'ollama' && typeof req.body.model === 'string' && req.body.model.trim()
          ? req.body.model.trim() : undefined
        if (model) await deps.saveModel(model)

        let facts: TemplateFacts, settings: TemplateSettings
        try {
          [facts, settings] = await Promise.all([deps.facts(), deps.settings()])
        } catch (err: any) {
          return reply.status(502).send({ ok: false, error: `Cannot read the cluster, so there is nothing to plan against: ${err.message}` })
        }

        const loopDeps: LoopDeps = {
          facts, settings, now: () => new Date(),
          intent: p => deps.intent(p, chosen, model),
          ask: p => answerQuestion(p, { sources: deps.sources(facts, (fastify as any).prisma), call: deps.askCall(chosen, model), fallback: NO_TASK_ANSWER,
            services: wizardRecipes().flatMap(r => [r.id, r.name.toLowerCase()]) }),
          extract: (t, text, f, opts) => deps.extract(t, text, f, { ...opts, provider: chosen, model }),
        }
        let s
        try {
          s = await startLoop(prompt, loopDeps)
        } catch (err: any) {
          return reply.status(502).send({ ok: false, provider: chosen, error: err.message })
        }

        // Not a task: the answer is shown, and nothing is planned.
        const t = s.template ? getTemplate(s.template) : undefined
        if (s.state === 'answer' || !t) {
          return reply.send({ ok: true, conversational: true, provider: chosen, message: s.answer || NO_TASK_ANSWER })
        }

        const fields = s.fields
        const steps = s.steps ?? t.steps(fields)
        const notice = firstRunNotice(fields)
        let run: DeployRun | undefined
        let unread: string[] = []
        if (s.state === 'ready') {
          const typed = toDeployFields(fields, t)
          unread = unreadFor(typed, facts)
          run = { template: 'deploy-service', version: t.version, owner: '', fields: typed, steps }
        }
        const warnings = [...new Set([
          ...s.issues.map(i => i.message),
          ...(s.pending ? [s.pending.question] : []),
          ...unread.map(src => `HyperProx could not read ${src} from the cluster, so this could not be fully checked. Try again in a moment.`),
          ...(notice ? [notice] : []),
        ])]
        // Interim until the first-run lock: a public app with a first-run page is not planned at all.
        const blocked = !run || unread.length > 0 || !!notice

        // Only a ready, fully checked run is kept, and only for the user who asked. Execute takes this id;
        // nothing the browser shows or sends is run.
        const owner  = deps.whoami(req)
        const planId = !blocked && owner && run ? deps.prepared.put(owner, structuredClone({ ...run, owner })) : undefined

        const name = wizardRecipes().find(r => r.id === fields.service?.value)?.name ?? String(fields.service?.value ?? '')
        return reply.send({
          ok: true,
          provider: chosen,
          model: model ?? (await deps.listProviders()).find(p => p.id === chosen)?.model,
          plan: {
            service: name,
            domain: typeof fields.domain?.value === 'string' ? fields.domain.value : '',
            understood: understood(fields),
            steps: steps.map(x => ({ id: x.id, type: x.id, label: x.label })),
            warnings,
          },
          fields,
          // `blocked` is the run not being ready, or not fully checked: the UI offers Execute only without it.
          blocked,
          ...(planId ? { planId } : {}),
        })
      })

    // POST /api/ai/wizard/execute — run what /wizard/plan prepared, by its id
    fastify.post<{ Body: Record<string, unknown> }>('/wizard/execute', async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>

      // A plan, fields or steps in the body are refused outright, even next to a valid id: what runs is the
      // server's, and accepting them invites the mistake of running them.
      if (body.plan !== undefined || body.fields !== undefined || body.steps !== undefined) {
        return reply.status(400).send({
          ok: false,
          error: 'Execution takes a planId from /wizard/plan; a plan or fields sent by the browser are never run.',
        })
      }
      if (typeof body.planId !== 'string' || !body.planId) {
        return reply.status(400).send({ ok: false, error: 'planId is required' })
      }

      const stored = deps.prepared.take(body.planId, deps.whoami(req))
      if (!stored) {
        return reply.status(404).send({ ok: false, error: 'That plan has expired or was already run. Plan it again.' })
      }
      const run = stored.payload
      const t = getTemplate(run.template)
      if (!t || t.version !== run.version) {
        return reply.status(409).send({ ok: false, blocked: true, error: 'HyperProx has changed how it does this since it was planned. Start again.' })
      }

      // The cluster may have moved since planning: another guest took the ID or the address, a node went
      // away, a gateway changed. Everything is derived and validated again against fresh facts.
      let facts: TemplateFacts, settings: TemplateSettings
      try {
        [facts, settings] = await Promise.all([deps.facts(), deps.settings()])
      } catch (err: any) {
        return reply.status(502).send({
          ok: false, blocked: true,
          error: `Cannot read the cluster, so the plan cannot be checked again before it runs: ${err.message}`,
        })
      }
      const unavailable = unreadFor(run.fields, facts)
      if (unavailable.length) {
        return reply.status(502).send({
          ok: false, blocked: true, unavailable,
          error: `Cannot read ${unavailable.join(', ')} from the cluster, so the plan cannot be checked again before it runs. Plan it again.`,
        })
      }
      const problems = revalidate(t, run, facts, settings)
      if (problems.length) return reply.status(409).send({ ok: false, blocked: true, warnings: problems })

      // Runs already in flight are not in the facts yet. No await from here to the claim.
      const mine = claimsOf(run.fields)
      const clash = mine.filter(c => claims.has(c.key)).map(c => c.message)
      if (clash.length) return reply.status(409).send({ ok: false, blocked: true, warnings: clash })

      const jobId = randomUUID()
      for (const c of mine) claims.set(c.key, jobId)
      const release = () => { for (const c of mine) if (claims.get(c.key) === jobId) claims.delete(c.key) }

      // Fire-and-forget — execution runs in background, progress via WebSocket
      deps.execute(jobId, run)
        .catch(err => fastify.log.error(`[wizard] Job ${jobId} failed: ${err.message}`))
        .finally(release)

      return reply.send({
        ok:      true,
        jobId,
        message: `Executing ${run.steps.length} steps. Track progress via WebSocket.`,
        steps:   run.steps.length,
      })
    })

    // GET /api/ai/wizard/jobs/:jobId — get execution status (REST fallback for WS)
    fastify.get<{ Params: { jobId: string } }>('/wizard/jobs/:jobId', async (req, reply) => {
      // Another user's job reads as no job at all.
      const job = deps.job(req.params.jobId)
      const who = deps.whoami(req)
      if (!job || !who || job.run.owner !== who) return reply.status(404).send({ ok: false, error: 'Job not found' })

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
}

export const aiRoutes: FastifyPluginAsync = buildAiRoutes()
