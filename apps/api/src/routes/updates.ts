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
//
//  Every route works for the cluster the request is about (lib/clusters/context.ts): home with no header, a
//  remote with X-HyperProx-Cluster. Each cluster has its own runner, policy and inventory cache
//  (lib/updates/service.ts), and its own view of the jobs, so a job planned for one cluster cannot be confirmed,
//  resumed or rolled back through another. On a remote, everything that changes something (starting a run,
//  confirming, resuming, rolling back, rebooting) also needs the master password re-entered within the last
//  five minutes — which an API token can never do.
// =============================================================================

import { sendFailure } from '../lib/failure'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { UpdatesInventory, UpdatesWsPayload } from '../lib/updates/types'
import { hasRole } from '../lib/roles'
import { isUnlocked, onLock } from '../lib/vault/state'
import { trackSocket } from '../lib/session-sockets'
import { isReconfirmed } from '../lib/auth'
import { loadPolicy as loadPolicyFile, policyStatus, unmatchedSections, sectionKeyFor, renameRefusal, type PolicyLoad } from '../lib/updates/policy'
import { type UpdatesExecutor } from '../lib/updates/executor'
import { annotatePlanSafety } from '../lib/updates/ceph-checks'
import { buildPlan } from '../lib/updates/planner'
import { UpdatesRunner, PolicyRequiredError, JobStateError, type RunnerTiming } from '../lib/updates/runner'
import { publish, type NotifyEventInput } from '../lib/notify'
import { UpdatesScheduler } from '../lib/updates/scheduler'
import { ActiveJobError, PrismaStore, jobView, type UpdatesStore } from '../lib/updates/store'
import { APPROVAL_ID, productionAppEnv, type AppEnv } from '../lib/updates/apps'
import { UpdatesServices, type ClusterUpdates } from '../lib/updates/service'
import { jobCluster } from '../lib/updates/cluster-store'
import { UpdatesChecker, FileCheckState, type CheckStateStore } from '../lib/updates/check'
import { setCheckSummarySource } from '../lib/updates/check-summary'
import { currentClusterId } from '../lib/clusters/context'
import { HOME_ID, clusterRow, listClusters, setRenameGuard } from '../lib/clusters/registry'
import { selfVmidOf } from '../lib/updates/inventory'
import { buildTargets, buildSelectedPlan, parseTargetId, MAX_SELECTION } from '../lib/updates/targets'
import { setTargetsSource } from '../lib/updates/targets-summary'
import { jobLog } from '../lib/log-once'

export interface UpdatesRouteDeps {
  store?:      UpdatesStore
  /** Home's executor. */
  exec?:       UpdatesExecutor
  /** A remote cluster's executor (tests); default the production one bound to that cluster. */
  remoteExec?: (clusterId: string) => UpdatesExecutor
  /** The policy file; its top level is home's, `clusters:` holds the remotes'. */
  loadPolicy?: () => PolicyLoad
  /** Where the daily check keeps its result. Default data/updates-check.json. */
  checkState?: CheckStateStore
  /** The daily check's timer (default on, like the scheduler) and its pauses between machines. */
  check?:      boolean
  checkGapMs?: number
  /** How HyperProx reaches a remote now (tests); default lib/pve-env.ts connectionKey. */
  connection?: (clusterId: string) => string
  hostname?:   string
  timing?:     Partial<RunnerTiming>
  /** Tests turn these off; production wants both. */
  scheduler?:  boolean
  recover?:    boolean
  /** App-update providers. Default: the bundled plug-ins' — but only with the production executor. */
  apps?:       AppEnv
  /** Exposes the home runner so tests can wait for a job to settle. */
  onRunner?:   (runner: UpdatesRunner) => void
  /** Minimum time between manual checks (default 15 min). */
  manualCheckGapMs?: number
  /** Exposes every cluster's service and the checker (tests). */
  onServices?: (services: UpdatesServices, checker: UpdatesChecker) => void
  /** The notification bus; default the installed one (a no-op until it is installed). */
  publish?:    (e: NotifyEventInput) => Promise<void>
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
    // Sign-out or the session ending closes it too, not only a lock (lib/session-sockets.ts).
    trackSocket(s, socket, 'updates')
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

const RECONFIRM = { ok: false, code: 'reconfirm_required', error: 'Re-enter your master password to change anything on a remote cluster' }

/** On a remote cluster a change needs a fresh re-confirmation; an API token never has one. */
function remoteNeedsReconfirm(svc: ClusterUpdates, req: FastifyRequest): boolean {
  return svc.remote && !(req.session?.sid && isReconfirmed(req.session.sid))
}

const RECONFIRM_CHOSEN = { ok: false, code: 'reconfirm_required', error: 'Re-enter your master password to run the chosen updates' }

/** Running chosen targets needs a fresh re-confirmation, on every cluster; an API token never has one. */
const reconfirmed = (req: FastifyRequest) => Boolean(req.session?.sid && isReconfirmed(req.session.sid))

/** A selection from a request body: target ids, or null when it is not a list of them. */
function selectionFrom(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_SELECTION) return null
  return raw.every(x => typeof x === 'string' && parseTargetId(x)) ? [...new Set(raw as string[])] : null
}

const CHECK_BUSY = 'The daily updates check is reading machines right now. Try again when it has finished (its card on this page shows it); it never takes longer than a few minutes per cluster.'

/** An API token acts as a session whose id starts with "token:" (lib/gate.ts tokenSession). */
const isTokenSession = (req: FastifyRequest) => String(req.session?.sid ?? '').startsWith('token:')

function sendError(reply: FastifyReply, e: any) {
  if (e instanceof ActiveJobError) return reply.status(409).send({ error: e.message, runningJobId: e.runningJobId })
  if (e instanceof PolicyRequiredError) return reply.status(400).send({ error: e.message })
  if (e instanceof JobStateError) return reply.status(/^No (job|node)/.test(e.message) ? 404 : 409).send({ error: e.message })
  return sendFailure(reply.request, reply, e, undefined, { status: 503 })
}

/** Approval ids from a query string; null when any is malformed. */
function approvalsFrom(raw: string | undefined): string[] | null {
  const list = (raw ?? '').split(',').map(s => s.trim()).filter(Boolean)
  return list.length <= 200 && list.every(a => APPROVAL_ID.test(a)) ? list : null
}

export function buildUpdatesRoutes(deps: UpdatesRouteDeps = {}): FastifyPluginAsync {
  return async (fastify) => {
    const store  = deps.store ?? new PrismaStore((fastify as any).prisma)
    const loadPolicy = deps.loadPolicy ?? (() => loadPolicyFile())
    const apps   = deps.apps ?? (deps.exec ? undefined : productionAppEnv())
    const appProviders = apps?.providers.map(r => r.provider.id)

    const services = new UpdatesServices({
      store, exec: deps.exec, remoteExec: deps.remoteExec, loadPolicy,
      hostname: deps.hostname, timing: deps.timing, apps,
      publish: deps.publish ?? publish, emit: broadcast,
      log: jobLog(fastify.log), connection: deps.connection,
    })
    const home = services.get(HOME_ID)
    const runner = home.runner
    deps.onRunner?.(runner)
    /** The service for the cluster this request is about. */
    const svc = () => services.get(currentClusterId())

    const checker = new UpdatesChecker({
      clusters: () => listClusters().map(c => {
        const s = services.get(c.id)
        return { ref: { id: c.id, name: c.name, kind: c.kind }, exec: s.exec, loadPolicy: s.loadPolicy, remote: s.remote }
      }),
      loadPolicy, isUnlocked,
      activeJob: () => store.activeJob(),
      state: deps.checkState ?? new FileCheckState(),
      publish: deps.publish ?? publish,
      log: jobLog(fastify.log),
      gapMs: deps.checkGapMs, clusterGapMs: deps.checkGapMs,
    })
    setCheckSummarySource(id => checker.summary(id))
    // A rename must not quietly attach a name-keyed policy section written for another server.
    setRenameGuard((c, newName) => { const l = loadPolicy(); return renameRefusal(l.loaded ? l.policy : null, c, newName) })
    deps.onServices?.(services, checker)

    if (deps.recover !== false) {
      // The database needs no vault, so a job interrupted by a restart is paused before anyone can press anything.
      fastify.addHook('onReady', async () => {
        await runner.recoverAfterRestart().catch(e => fastify.log.error(`[updates] restart recovery failed: ${e.message}`))
        const active = await store.activeJob().catch(() => null)
        const id = active ? jobCluster(active) : HOME_ID
        if (active && id !== HOME_ID) {
          if (clusterRow(id)) await services.get(id).runner.recoverAfterRestart().catch(e => fastify.log.error(`[updates] restart recovery failed: ${e.message}`))
          else {
            await store.transitionJob(active.id, ['planned', 'awaiting-confirm', 'running', 'paused'], { status: 'failed', pauseReason: 'Its cluster was removed from HyperProx; nothing more was done', finishedAt: new Date() })
            await store.releaseLock(active.id)
          }
        }
      })
    }
    if (deps.scheduler !== false) {
      // Scheduled runs are home-only. The daily check covers every cluster, read-only.
      const scheduler = new UpdatesScheduler({ runner, loadPolicy, isUnlocked, busy: () => checker.running, log: jobLog(fastify.log) })
      fastify.addHook('onReady', async () => scheduler.start())
      fastify.addHook('onClose', async () => scheduler.stop())
    }
    if (deps.check ?? deps.scheduler !== false) {
      fastify.addHook('onReady', async () => checker.start())
      fastify.addHook('onClose', async () => checker.stop())
    }

    fastify.addHook('preHandler', adminOnly)

    fastify.get('/policy', async () => {
      const s = svc()
      const status = policyStatus(s.loadPolicy())
      const check = loadPolicy().policy.check
      const st = checker.status()
      const out = { ...status, cluster: { ...s.ref }, check: { enabled: check.enabled, cron: check.cron, nextRun: st.nextRun, reminderDays: check.reminderDays } }
      const file = loadPolicy()
      if (!s.remote) {
        const loose = unmatchedSections(file.policy, listClusters())
        if (loose.length) out.notes = [...(out.notes ?? []), `The policy names cluster section${loose.length > 1 ? 's' : ''} no cluster matches: ${loose.map(k => `clusters.${k}`).join(', ')}`]
      }
      // Which section applies to each cluster, so a name-keyed section attaching to the wrong server shows.
      return { ...out, sections: listClusters().map(c => ({ cluster: { id: c.id, name: c.name, kind: c.kind }, section: sectionKeyFor(file.loaded ? file.policy : null, c) })) }
    })

    // Read-only, refresh included: it re-reads what nodes and guests already know and never runs `apt update`.
    fastify.get<{ Querystring: { refresh?: string } }>('/inventory', async (req, reply) => {
      try { return await svc().inventory(req.query.refresh === '1' || req.query.refresh === 'true') }
      catch (e) { return sendError(reply, e) }
    })

    // `approve` (comma separated approval ids) previews the plan a run with those approvals would get.
    fastify.get<{ Querystring: { scope?: string; approve?: string } }>('/plan', async (req, reply) => {
      const approvals = approvalsFrom(req.query.approve)
      if (!approvals) return reply.status(400).send({ error: 'approve must be a comma-separated list of approval ids from the inventory' })
      try {
        const s = svc()
        const load = s.loadPolicy()
        const inv = await s.inventory(false)
        const built = buildPlan(inv, load.policy, {
          approvals, appProviders: s.remote ? undefined : appProviders,
          scope: req.query.scope === 'guests' ? 'guests' : 'all',
          selfVmid: s.remote ? null : selfVmidOf(inv, load.policy, deps.hostname),
          remote: s.remote || undefined,
          policyNote: load.loaded ? undefined : `${load.error ?? 'No policy file'} — this plan uses the built-in safe defaults.`,
        })
        const plan = { ...built, cluster: { ...s.ref } }
        // Read-only: what each Ceph restart and node reboot would do, checked again when it runs. A remote plan
        // has no Ceph phase and never reboots on its own, so there is nothing to annotate.
        if (s.remote || !plan.steps.some(x => x.action === 'ceph' || x.action === 'node-reboot' || x.action === 'self')) return plan
        try { return await annotatePlanSafety(s.exec, plan, await s.exec.cephPresent()) }
        catch (e: any) { return { ...plan, warnings: [...plan.warnings, `Ceph safety not checked: ${e?.message ?? e}`] } }
      } catch (e) { return sendError(reply, e) }
    })

    /** What the tree is built from, for one cluster: the cached inventory, its policy and HyperProx's own guest. */
    const treeFor = (s: ClusterUpdates, inv: UpdatesInventory) => {
      const load = s.loadPolicy()
      const selfVmid = s.remote ? null : selfVmidOf(inv, load.policy, deps.hostname)
      return { load, selfVmid, targets: buildTargets(inv, load.policy, { selfVmid, remote: s.remote }) }
    }
    // The assistant answers "what updates does X have" from what was last read, never by reading.
    setTargetsSource(id => {
      if (!clusterRow(id)) return null
      const s = services.get(id)
      const inv = s.cached()
      return inv ? { refreshedAt: inv.refreshedAt, cluster: { ...s.ref }, targets: treeFor(s, inv).targets } : null
    })

    // Everything that can be updated, as a tree, each row with its own count, preview and whether it can be chosen.
    // Read-only, like the inventory it is built from. `discover=1`: also look for compose projects in every guest
    // (`docker compose ls` and registry reads), not only where the policy turns docker on.
    fastify.get<{ Querystring: { refresh?: string; discover?: string } }>('/targets', async (req, reply) => {
      try {
        const s = svc()
        const inv = await s.inventory(req.query.refresh === '1' || req.query.refresh === 'true', req.query.discover === '1')
        return { refreshedAt: inv.refreshedAt, cluster: { ...s.ref }, targets: treeFor(s, inv).targets }
      } catch (e) { return sendError(reply, e) }
    })

    // The ordered plan for a selection, from the inventory as last read: what would run, in what order, and what
    // would be refused and why. Read-only (a POST only because a selection can be long).
    fastify.post<{ Body: { select?: unknown; approve?: unknown } }>('/preview', async (req, reply) => {
      const select = selectionFrom(req.body?.select)
      if (!select) return reply.status(400).send({ error: `select must be a list of 1 to ${MAX_SELECTION} target ids from /targets` })
      const approve = req.body?.approve ?? []
      if (!Array.isArray(approve) || approve.length > 200 || !approve.every(a => typeof a === 'string' && APPROVAL_ID.test(a))) {
        return reply.status(400).send({ error: 'approve must be a list of approval ids from the inventory' })
      }
      try {
        const s = svc()
        const inv = await s.inventory(false)
        const { load, selfVmid } = treeFor(s, inv)
        const plan = buildSelectedPlan(inv, load.policy, {
          selection: select, approvals: approve as string[], selfVmid, remote: s.remote || undefined,
          policyNote: load.loaded ? undefined : `${load.error ?? 'No policy file'} — runs are refused until the policy file loads.`,
        })
        const out = { ...plan, cluster: { ...s.ref } }
        if (s.remote || !plan.steps.some(x => x.action === 'ceph' || x.action === 'node-reboot' || x.action === 'self')) return out
        try { return await annotatePlanSafety(s.exec, out, await s.exec.cephPresent()) }
        catch (e: any) { return { ...out, warnings: [...out.warnings, `Ceph safety not checked: ${e?.message ?? e}`] } }
      } catch (e) { return sendError(reply, e) }
    })

    fastify.post<{ Body: { mode?: string; scope?: string; approve?: unknown; select?: unknown } }>('/jobs', async (req, reply) => {
      const mode = req.body?.mode
      if (mode !== 'run' && mode !== 'dry-run') return reply.status(400).send({ error: "mode must be 'run' or 'dry-run'" })
      const scope = req.body?.scope ?? 'all'
      if (scope !== 'all' && scope !== 'guests') return reply.status(400).send({ error: "scope must be 'all' or 'guests'" })
      const approve = req.body?.approve ?? []
      if (!Array.isArray(approve) || approve.length > 200 || !approve.every(a => typeof a === 'string' && APPROVAL_ID.test(a))) {
        return reply.status(400).send({ error: 'approve must be a list of approval ids from the inventory' })
      }
      const select = req.body?.select === undefined ? undefined : selectionFrom(req.body.select)
      if (select === null) return reply.status(400).send({ error: `select must be a list of 1 to ${MAX_SELECTION} target ids from /targets` })
      const s = svc()
      if (mode === 'run' && remoteNeedsReconfirm(s, req)) return reply.status(403).send(RECONFIRM)
      if (select && mode === 'run' && !reconfirmed(req)) return reply.status(403).send(RECONFIRM_CHOSEN)
      if (select) {
        // Refused before anything starts when nothing chosen could run (a held kernel package, unknown holds...).
        try {
          const inv = await s.inventory(false)
          const { load, selfVmid } = treeFor(s, inv)
          const pv = buildSelectedPlan(inv, load.policy, { selection: select, approvals: approve as string[], selfVmid, remote: s.remote || undefined })
          if (!pv.steps.length) return reply.status(400).send({ error: 'Nothing chosen can be updated', refused: pv.refused ?? [] })
        } catch (e) { return sendError(reply, e) }
      }
      if (checker.running) {
        // A person's run takes precedence: the check stops at the next machine, keeping what it read.
        checker.abort('an Updates run was started')
        await Promise.race([checker.idle(), new Promise(r => setTimeout(r, 60_000).unref?.())])
        if (checker.running) return reply.status(409).send({ error: 'The daily check is finishing the machine it is reading and stops after it. Try again in a minute.' })
      }
      try {
        const job = await s.runner.start(mode, 'manual', req.session?.email, scope, approve as string[], select)
        return reply.status(201).send({ job: jobView(job, await s.store.getSteps(job.id)) })
      } catch (e) { return sendError(reply, e) }
    })

    fastify.get<{ Querystring: { limit?: string } }>('/jobs', async (req) => {
      const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100)
      return { jobs: (await svc().store.listJobs(limit)).map(j => jobView(j)) }
    })

    fastify.get<{ Params: { id: string } }>('/jobs/:id', async (req, reply) => {
      const s = svc()
      const job = await s.store.getJob(req.params.id)
      if (!job) return reply.status(404).send({ error: `No job ${req.params.id}` })
      return { job: jobView(job, await s.store.getSteps(job.id)) }
    })

    for (const op of ['confirm', 'resume', 'cancel'] as const) {
      fastify.post<{ Params: { id: string } }>(`/jobs/:id/${op}`, async (req, reply) => {
        const s = svc()
        if (op !== 'cancel' && remoteNeedsReconfirm(s, req)) return reply.status(403).send(RECONFIRM)
        if (op !== 'cancel' && !reconfirmed(req)) {
          // A run of chosen targets is confirmed and resumed with the master password re-entered, like its start.
          const j = await s.store.getJob(req.params.id).catch(() => null)
          if (j && Array.isArray(j.plan?.items)) return reply.status(403).send(RECONFIRM_CHOSEN)
        }
        if (op !== 'cancel' && checker.running) return reply.status(409).send({ error: CHECK_BUSY })
        try {
          const job = await s.runner[op](req.params.id, req.session?.email)
          return { job: jobView(job, await s.store.getSteps(job.id)) }
        } catch (e) { return sendError(reply, e) }
      })
    }

    // Roll a guest back to the snapshot this job took, after one of its app steps failed. Paused jobs only.
    fastify.post<{ Params: { id: string }; Body: { target?: unknown } }>('/jobs/:id/rollback', async (req, reply) => {
      const target = req.body?.target
      if (typeof target !== 'string' || !/^\d{1,9}$/.test(target)) return reply.status(400).send({ error: 'target must be a guest id' })
      const s = svc()
      if (remoteNeedsReconfirm(s, req)) return reply.status(403).send(RECONFIRM)
      if (checker.running) return reply.status(409).send({ error: CHECK_BUSY })
      try {
        const job = await s.runner.rollbackGuest(req.params.id, target, req.session?.email)
        return reply.status(202).send({ job: jobView(job, await s.store.getSteps(job.id)) })
      } catch (e) { return sendError(reply, e) }
    })

    // What a reboot would take down (a remote one-node server's guests), for the confirmation. Read-only.
    fastify.get<{ Params: { node: string } }>('/nodes/:node/reboot-preview', async (req, reply) => {
      try { return await svc().runner.rebootPreview(req.params.node) }
      catch (e) { return sendError(reply, e) }
    })

    fastify.post<{ Params: { node: string } }>('/nodes/:node/reboot', async (req, reply) => {
      const s = svc()
      if (remoteNeedsReconfirm(s, req)) return reply.status(403).send(RECONFIRM)
      if (checker.running) return reply.status(409).send({ error: CHECK_BUSY })
      try {
        const job = await s.runner.rebootNode(req.params.node, req.session?.email)
        return reply.status(202).send({ job: jobView(job, await s.store.getSteps(job.id)) })
      } catch (e) { return sendError(reply, e) }
    })

    // The daily check: its last result for every cluster, and "Check now". Read-only on every machine.
    // Manual checks are at least `manualCheckGapMs` apart: each one runs apt update on every node and guest.
    const manualGap = deps.manualCheckGapMs ?? 15 * 60_000
    let lastManual = 0
    const manualAfter = () => (lastManual ? new Date(lastManual + manualGap).toISOString() : null)
    fastify.get('/check', async () => ({ ...checker.status(), manualAfter: manualAfter() }))
    fastify.post('/check', async (req, reply) => {
      if (isTokenSession(req)) return reply.status(403).send({ ok: false, code: 'token_refused', error: 'An API token cannot start the updates check. Sign in to start one.' })
      if (checker.running) return reply.status(409).send({ error: 'A check is already running.', status: checker.status() })
      const wait = lastManual + manualGap - Date.now()
      if (lastManual && wait > 0) {
        return reply.status(429).send({ error: `A check was started less than ${Math.round(manualGap / 60_000)} minutes ago. The next one can start in ${Math.ceil(wait / 60_000)} minute${Math.ceil(wait / 60_000) === 1 ? '' : 's'}.`, manualAfter: manualAfter() })
      }
      lastManual = Date.now()
      await store.audit('updates.check.start', 'check', { by: req.session?.email, clusters: 'all' })
      checker.run('manual').catch(e => fastify.log.error(`[updates] check failed: ${e.message}`))
      return reply.status(202).send({ ...checker.status(), manualAfter: manualAfter() })
    })
  }
}

export const updatesRoutes: FastifyPluginAsync = buildUpdatesRoutes()
