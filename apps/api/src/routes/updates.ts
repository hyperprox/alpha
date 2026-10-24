// =============================================================================
//  HyperProx — Updates routes (/api/updates)
//
//  Admin only, reads included. The role matrix (lib/roles.ts) lets any viewer
//  GET, but the inventory lists every pending package and kernel pin on every
//  host, and the plan is a map of what will be taken down and in what order.
//  So the check is repeated here, per route, rather than relying on the gate.
//
//  The work itself is in lib/updates; this file translates HTTP to it. Every
//  write is audited by the runner.
// =============================================================================

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { UpdatesInventory, UpdatesWsPayload } from '../lib/updates/types'
import { hasRole } from '../lib/roles'
import { isUnlocked, onLock } from '../lib/vault/state'
import { loadPolicy as loadPolicyFile, policyStatus, type PolicyLoad } from '../lib/updates/policy'
import { productionExecutor, type UpdatesExecutor } from '../lib/updates/executor'
import { readInventory, selfVmidOf } from '../lib/updates/inventory'
import { buildPlan } from '../lib/updates/planner'
import { UpdatesRunner, PolicyRequiredError, JobStateError, type RunnerTiming } from '../lib/updates/runner'
import { UpdatesScheduler } from '../lib/updates/scheduler'
import { ActiveJobError, PrismaStore, jobView, type UpdatesStore } from '../lib/updates/store'

export interface UpdatesRouteDeps {
  store?:      UpdatesStore
  exec?:       UpdatesExecutor
  loadPolicy?: () => PolicyLoad
  hostname?:   string
  timing?:     Partial<RunnerTiming>
  /** Tests turn these off; production wants both. */
  scheduler?:  boolean
  recover?:    boolean
  /** Exposes the runner so tests can wait for a job to settle. */
  onRunner?:   (runner: UpdatesRunner) => void
}

// Sockets on /ws/updates, each opened by an admin. The general /ws channel is viewer-level, and
// these frames carry step output and log lines from hosts, so they go only here.
const subscribers = new Set<{ readyState: number; send(m: string): void; close(): void }>()
let lockHook = false

/** Same framing as lib/ws-broadcast.ts: { type: 'updates', payload, ts }. */
function broadcast(payload: UpdatesWsPayload) {
  const msg = JSON.stringify({ type: 'updates', payload, ts: Date.now() })
  for (const c of subscribers) if (c.readyState === 1) c.send(msg)
}

/** Registered under /ws/updates (nginx proxies upgrades only below /ws). */
export const updatesWsRoutes: FastifyPluginAsync = async (fastify) => {
  if (!lockHook) {
    lockHook = true
    // A lock ends every session; the sockets those sessions opened go with them.
    onLock(() => { for (const c of subscribers) { try { c.close() } catch { /* gone */ } } subscribers.clear() })
  }
  fastify.get('/', { websocket: true }, (socket: any, req: FastifyRequest) => {
    const s = req.session
    if (!s || !hasRole(s.role, 'admin')) {
      socket.send(JSON.stringify({ type: 'error', payload: { error: 'Updates need the admin role' }, ts: Date.now() }))
      socket.close()
      return
    }
    subscribers.add(socket)
    socket.on('close', () => subscribers.delete(socket))
  })
}

/** For tests: how many admin sockets are listening. */
export function updatesSubscriberCount(): number { return subscribers.size }

async function adminOnly(req: FastifyRequest, reply: FastifyReply) {
  const s = req.session
  if (!s) return reply.status(401).send({ ok: false, code: 'unauthenticated', error: 'Authentication required' })
  if (!hasRole(s.role, 'admin')) {
    return reply.status(403).send({ ok: false, code: 'forbidden', error: 'Updates need the admin role', required: 'admin', role: s.role })
  }
}

function sendError(reply: FastifyReply, e: any) {
  if (e instanceof ActiveJobError) return reply.status(409).send({ error: e.message, runningJobId: e.runningJobId })
  if (e instanceof PolicyRequiredError) return reply.status(400).send({ error: e.message })
  if (e instanceof JobStateError) return reply.status(/^No (job|node)/.test(e.message) ? 404 : 409).send({ error: e.message })
  return reply.status(503).send({ error: e?.message ?? String(e) })
}

export function buildUpdatesRoutes(deps: UpdatesRouteDeps = {}): FastifyPluginAsync {
  return async (fastify) => {
    const store  = deps.store ?? new PrismaStore((fastify as any).prisma)
    const exec   = deps.exec ?? productionExecutor()
    const loadPolicy = deps.loadPolicy ?? (() => loadPolicyFile())
    let cached: UpdatesInventory | null = null
    // The page asks for the inventory and the plan at once; both share one read of the cluster.
    let reading: Promise<UpdatesInventory> | null = null

    const runner = new UpdatesRunner({
      store, exec, loadPolicy,
      emit: broadcast,
      onInventory: r => { cached = r.inventory },
      log: msg => fastify.log.info(msg),
      hostname: deps.hostname,
      timing: deps.timing,
    })
    deps.onRunner?.(runner)

    if (deps.recover !== false) {
      // The database needs no vault, so a job interrupted by a restart is paused before anyone can press anything.
      fastify.addHook('onReady', async () => {
        await runner.recoverAfterRestart().catch(e => fastify.log.error(`[updates] restart recovery failed: ${e.message}`))
      })
    }
    if (deps.scheduler !== false) {
      const scheduler = new UpdatesScheduler({ runner, loadPolicy, isUnlocked, log: msg => fastify.log.info(msg) })
      fastify.addHook('onReady', async () => scheduler.start())
      fastify.addHook('onClose', async () => scheduler.stop())
    }

    fastify.addHook('preHandler', adminOnly)

    async function inventory(refresh: boolean): Promise<UpdatesInventory> {
      if (cached && !refresh) return cached
      // While a job is active the runner keeps the cache current; a page refresh must not
      // send a second round of reads into guests mid-upgrade.
      if (cached && await store.activeJob()) return cached
      if (!reading) {
        reading = readInventory(exec, loadPolicy().policy, { rebootPending: runner.rebootPending, hostname: deps.hostname })
          .then(r => { cached = r.inventory; return r.inventory })
          .finally(() => { reading = null })
      }
      return reading
    }

    fastify.get('/policy', async () => policyStatus(loadPolicy()))

    // Read-only, refresh included: it re-reads what nodes and guests already know and never runs `apt update`.
    fastify.get<{ Querystring: { refresh?: string } }>('/inventory', async (req, reply) => {
      try { return await inventory(req.query.refresh === '1' || req.query.refresh === 'true') }
      catch (e) { return sendError(reply, e) }
    })

    fastify.get<{ Querystring: { scope?: string } }>('/plan', async (req, reply) => {
      try {
        const load = loadPolicy()
        const inv = await inventory(false)
        return buildPlan(inv, load.policy, {
          scope: req.query.scope === 'guests' ? 'guests' : 'all',
          selfVmid: selfVmidOf(inv, load.policy, deps.hostname),
          policyNote: load.loaded ? undefined : `${load.error ?? 'No policy file'} — this plan uses the built-in safe defaults.`,
        })
      } catch (e) { return sendError(reply, e) }
    })

    fastify.post<{ Body: { mode?: string; scope?: string } }>('/jobs', async (req, reply) => {
      const mode = req.body?.mode
      if (mode !== 'run' && mode !== 'dry-run') return reply.status(400).send({ error: "mode must be 'run' or 'dry-run'" })
      const scope = req.body?.scope ?? 'all'
      if (scope !== 'all' && scope !== 'guests') return reply.status(400).send({ error: "scope must be 'all' or 'guests'" })
      try {
        const job = await runner.start(mode, 'manual', req.session?.email, scope)
        return reply.status(201).send({ job: jobView(job, await store.getSteps(job.id)) })
      } catch (e) { return sendError(reply, e) }
    })

    fastify.get<{ Querystring: { limit?: string } }>('/jobs', async (req) => {
      const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100)
      return { jobs: (await store.listJobs(limit)).map(j => jobView(j)) }
    })

    fastify.get<{ Params: { id: string } }>('/jobs/:id', async (req, reply) => {
      const job = await store.getJob(req.params.id)
      if (!job) return reply.status(404).send({ error: `No job ${req.params.id}` })
      return { job: jobView(job, await store.getSteps(job.id)) }
    })

    for (const op of ['confirm', 'resume', 'cancel'] as const) {
      fastify.post<{ Params: { id: string } }>(`/jobs/:id/${op}`, async (req, reply) => {
        try {
          const job = await runner[op](req.params.id, req.session?.email)
          return { job: jobView(job, await store.getSteps(job.id)) }
        } catch (e) { return sendError(reply, e) }
      })
    }

    fastify.post<{ Params: { node: string } }>('/nodes/:node/reboot', async (req, reply) => {
      try {
        const job = await runner.rebootNode(req.params.node, req.session?.email)
        return reply.status(202).send({ job: jobView(job, await store.getSteps(job.id)) })
      } catch (e) { return sendError(reply, e) }
    })
  }
}

export const updatesRoutes: FastifyPluginAsync = buildUpdatesRoutes()
