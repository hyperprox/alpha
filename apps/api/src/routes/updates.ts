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
//  confirming, resuming, rolling back, rebooting) also needs an in-page confirmation (lib/confirm.ts, valid
//  five minutes) — which an API token can never do.
//
//  The services, the daily check and the scheduler are built and started by
//  lib/services/bootstrap.ts (lib/updates/runtime.ts); these routes only use them.
// =============================================================================

import { sendFailure, sendRefusal } from '../lib/failure'
import { actorOf, auditBy, isAdmin } from '../lib/http/request-actor'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { hasRole } from '../lib/roles'
import { onLock } from '../lib/vault/state'
import { trackSocket } from '../lib/session-sockets'
import { requireConfirm } from '../lib/confirm'
import { policyStatus, unmatchedSections, sectionKeyFor, type PolicyLoad } from '../lib/updates/policy'
import { type UpdatesExecutor } from '../lib/updates/executor'
import { annotatePlanSafety } from '../lib/updates/ceph-checks'
import { buildPlan } from '../lib/updates/planner'
import { UpdatesRunner, PolicyRequiredError, JobStateError, type RunnerTiming } from '../lib/updates/runner'
import { type NotifyEventInput } from '../lib/notify'
import { ActiveJobError, PrismaStore, jobView, type UpdatesStore } from '../lib/updates/store'
import { APPROVAL_ID, type AppEnv } from '../lib/updates/apps'
import { UpdatesServices, type ClusterUpdates } from '../lib/updates/service'
import { UpdatesChecker, type CheckStateStore } from '../lib/updates/check'
import { currentClusterId } from '../lib/clusters/context'
import { listClusters } from '../lib/clusters/registry'
import { selfVmidOf } from '../lib/updates/inventory'
import { planHash, PLAN_HASH } from '../lib/updates/plan-hash'
import { AUTO_INSTALL_TIME, withAutoInstall, type AutoInstallStore } from '../lib/updates/auto-install'
import { buildSelectedPlan, parseTargetId, MAX_SELECTION, type GuardContext } from '../lib/updates/targets'
import { jobLog } from '../lib/log-once'
import { UpdatesRuntime, updatesRuntime } from '../lib/updates/runtime'
import { addSubscriber, broadcast, closeAllSubscribers, removeSubscriber, subscriberCount } from '../lib/updates/broadcast'
import { RebootSettingsError, type RebootStateStore } from '../lib/updates/reboots'

/**
 * What a test builds the routes from when it passes no runtime: a runtime is made from these and its read-only sources
 * installed, but nothing is started (no recovery, no scheduler, no daily check timer: lib/services/bootstrap.ts does
 * that, once, for the production runtime).
 */
export interface UpdatesRouteDeps {
  /** The runtime to answer with. Production: the one lib/services/bootstrap.ts built. */
  runtime?:    () => UpdatesRuntime
  store?:      UpdatesStore
  /** Home's executor. */
  exec?:       UpdatesExecutor
  /** A remote cluster's executor (tests); default the production one bound to that cluster. */
  remoteExec?: (clusterId: string) => UpdatesExecutor
  /** The policy file; its top level is home's, `clusters:` holds the remotes'. */
  loadPolicy?: () => PolicyLoad
  /** Where the daily check keeps its result. Default data/updates-check.json. */
  checkState?: CheckStateStore
  /** The daily check's pauses between machines. */
  checkGapMs?: number
  /** Where the automatic-install switch is kept (tests). */
  autoInstall?: AutoInstallStore
  /** How HyperProx reaches a remote now (tests); default lib/pve-env.ts connectionKey. */
  connection?: (clusterId: string) => string
  hostname?:   string
  timing?:     Partial<RunnerTiming>
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
  /** What the plug-ins say about home guests (lib/updates/guards.ts); default read live. Tests set it. */
  guards?:     () => Promise<GuardContext>
  /** Automatic reboot settings (tests); default data/updates-reboots.json. */
  rebootState?: RebootStateStore
  /** Whether HyperProx is unlocked, for the reboot timer (tests). */
  isUnlocked?: () => boolean
  /** The reboot window's clock (tests). */
  now?:        () => number
}

// Sockets on /ws/updates, each opened by an admin (lib/updates/broadcast.ts).
let lockHook = false

/** Registered under /ws/updates (nginx proxies upgrades only below /ws). */
export const updatesWsRoutes: FastifyPluginAsync = async (fastify) => {
  if (!lockHook) {
    lockHook = true
    // A lock ends every session; the sockets those sessions opened go with them.
    onLock(() => closeAllSubscribers())
  }
  fastify.get('/', { websocket: true }, (socket: any, req: FastifyRequest) => {
    const s = req.session
    if (!s || !hasRole(s.role, 'admin')) {
      socket.send(JSON.stringify({ type: 'error', payload: { error: 'Updates need the admin role' }, ts: Date.now() }))
      socket.close()
      return
    }
    addSubscriber(socket)
    socket.on('close', () => removeSubscriber(socket))
    // Sign-out or the session ending closes it too, not only a lock (lib/session-sockets.ts).
    trackSocket(s, socket, 'updates')
  })
}

/** For tests: how many admin sockets are listening. */
export function updatesSubscriberCount(): number { return subscriberCount() }

async function adminOnly(req: FastifyRequest, reply: FastifyReply) {
  const s = req.session
  if (!s) return sendRefusal(reply, 401, 'unauthenticated', 'Authentication required')
  if (!hasRole(s.role, 'admin')) {
    return sendRefusal(reply, 403, 'forbidden', 'Updates need the admin role', { required: 'admin', role: s.role })
  }
}

/**
 * On a remote cluster every change, and on any cluster a run of chosen targets and a node reboot, is confirmed on the
 * page (lib/confirm.ts): a single-use confirmation bound to this exact request, which an API token never has.
 * False when the reply was sent (the confirmation to show, or a refusal) and the handler must stop.
 */
const confirmed = (req: FastifyRequest, reply: FastifyReply, summary?: string) => requireConfirm(req, reply, summary)

/** A selection from a request body: target ids, or null when it is not a list of them. */
function selectionFrom(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_SELECTION) return null
  return raw.every(x => typeof x === 'string' && parseTargetId(x)) ? [...new Set(raw as string[])] : null
}

const EMPTY_SELECTION = 'Pick at least one machine, or run Check now first.'
const CHECK_BUSY = 'The daily updates check is reading machines right now. Try again when it has finished (its card on this page shows it); it never takes longer than a few minutes per cluster.'

/** An API token acts as a session whose id starts with "token:" (lib/gate.ts tokenSession). */
const isTokenSession = (req: FastifyRequest) => String(req.session?.sid ?? '').startsWith('token:')

function sendError(reply: FastifyReply, e: any) {
  if (e instanceof ActiveJobError) return sendRefusal(reply, 409, 'job_active', e.message, { runningJobId: e.runningJobId })
  if (e instanceof PolicyRequiredError) return sendRefusal(reply, 400, 'policy_required', e.message)
  if (e instanceof RebootSettingsError) return sendRefusal(reply, 400, 'invalid_request', e.message)
  if (e instanceof JobStateError) return /^No (job|node)/.test(e.message) ? sendRefusal(reply, 404, 'not_found', e.message) : sendRefusal(reply, 409, 'job_state', e.message)
  return sendFailure(reply.request, reply, e, undefined, { status: 503 })
}

/** Approval ids from a query string; null when any is malformed. */
function approvalsFrom(raw: string | undefined): string[] | null {
  const list = (raw ?? '').split(',').map(s => s.trim()).filter(Boolean)
  return list.length <= 200 && list.every(a => APPROVAL_ID.test(a)) ? list : null
}

/** A runtime for routes built without one (tests): made from the deps, its sources installed, nothing started. */
function runtimeFromDeps(deps: UpdatesRouteDeps, fastify: { prisma?: unknown; log: Parameters<typeof jobLog>[0] }): UpdatesRuntime {
  const rt = new UpdatesRuntime({
    store: deps.store ?? new PrismaStore(fastify.prisma as any), exec: deps.exec, remoteExec: deps.remoteExec,
    loadPolicy: deps.loadPolicy, checkState: deps.checkState, checkGapMs: deps.checkGapMs, connection: deps.connection,
    hostname: deps.hostname, timing: deps.timing, apps: deps.apps, publish: deps.publish, emit: broadcast,
    guards: deps.guards, log: jobLog(fastify.log),
    autoInstall: deps.autoInstall, rebootState: deps.rebootState, isUnlocked: deps.isUnlocked, now: deps.now,
  })
  rt.installSources()
  return rt
}

export function buildUpdatesRoutes(deps: UpdatesRouteDeps = {}): FastifyPluginAsync {
  return async (fastify) => {
    const rt = deps.runtime ? deps.runtime() : runtimeFromDeps(deps, fastify as any)
    const { store, services, checker, appProviders, loadPolicy } = rt
    deps.onRunner?.(rt.runner)
    deps.onServices?.(services, checker)
    /** The service for the cluster this request is about. */
    const svc = () => services.get(currentClusterId())
    const guardsFor = (s: ClusterUpdates): Promise<GuardContext> => rt.guardsFor(s)
    const treeFor = (s: ClusterUpdates, inv: Parameters<UpdatesRuntime['treeFor']>[1], guards?: GuardContext) => rt.treeFor(s, inv, guards)

    fastify.addHook('preHandler', adminOnly)

    fastify.get('/policy', async () => {
      const s = svc()
      const auto = !s.remote && rt.autoInstall.load().enabled
      const status = policyStatus(s.remote ? s.loadPolicy() : withAutoInstall(s.loadPolicy(), rt.autoInstall.load()), new Date(), auto ? rt.reboots.settings(s.ref.id).timezone : undefined)
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
      if (!approvals) return sendRefusal(reply, 400, 'invalid_request', 'approve must be a comma-separated list of approval ids from the inventory')
      try {
        const s = svc()
        const load = s.loadPolicy()
        const inv = await s.inventory(false)
        const built = buildPlan(inv, load.policy, {
          approvals, appProviders: s.remote ? undefined : appProviders,
          scope: req.query.scope === 'guests' ? 'guests' : 'all',
          selfVmid: s.remote ? null : selfVmidOf(inv, load.policy, rt.hostname),
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

    // Everything that can be updated, as a tree, each row with its own count, preview and whether it can be chosen.
    // Read-only, like the inventory it is built from.
    fastify.get<{ Querystring: { refresh?: string; discover?: string } }>('/targets', async (req, reply) => {
      // Looking in every guest runs commands in each of them: an admin's act, on its own route (below).
      if (req.query.discover !== undefined) return sendRefusal(reply, 400, 'invalid_request', 'Looking for compose projects in every guest is POST /api/updates/targets/discover (admin).')
      try {
        const s = svc()
        const inv = await s.inventory(req.query.refresh === '1' || req.query.refresh === 'true')
        return { refreshedAt: inv.refreshedAt, cluster: { ...s.ref }, targets: treeFor(s, inv, await guardsFor(s)).targets }
      } catch (e) { return sendError(reply, e) }
    })

    // The tree again, after looking for compose projects in every guest (`docker compose ls` and registry reads in
    // each), not only where the policy turns docker on. Admin (lib/roles.ts: a POST is admin unless listed): it runs
    // commands inside every guest, which a viewer's read must never cause.
    fastify.post('/targets/discover', async (req, reply) => {
      if (!isAdmin(req)) return sendRefusal(reply, 403, 'forbidden', 'Looking inside every guest is for admins.')
      try {
        const s = svc()
        const inv = await s.inventory(false, true)
        return { refreshedAt: inv.refreshedAt, cluster: { ...s.ref }, targets: treeFor(s, inv, await guardsFor(s)).targets }
      } catch (e) { return sendError(reply, e) }
    })

    // The ordered plan for a selection, from the inventory as last read: what would run, in what order, and what
    // would be refused and why. Read-only (a POST only because a selection can be long).
    fastify.post<{ Body: { select?: unknown; approve?: unknown } }>('/preview', async (req, reply) => {
      const select = selectionFrom(req.body?.select)
      if (Array.isArray(req.body?.select) && req.body.select.length === 0) return sendRefusal(reply, 400, 'invalid_request', EMPTY_SELECTION)
      if (!select) return sendRefusal(reply, 400, 'invalid_request', `select must be a list of 1 to ${MAX_SELECTION} target ids from /targets`)
      const approve = req.body?.approve ?? []
      if (!Array.isArray(approve) || approve.length > 200 || !approve.every(a => typeof a === 'string' && APPROVAL_ID.test(a))) {
        return sendRefusal(reply, 400, 'invalid_request', 'approve must be a list of approval ids from the inventory')
      }
      try {
        const s = svc()
        const inv = await s.inventory(false)
        const { load, selfVmid, guards } = treeFor(s, inv, await guardsFor(s))
        const plan = buildSelectedPlan(inv, load.policy, {
          ...guards, selection: select, approvals: approve as string[], selfVmid, remote: s.remote || undefined,
          policyNote: load.loaded ? undefined : `${load.error ?? 'No policy file'} — runs are refused until the policy file loads.`,
        })
        const out = { ...plan, cluster: { ...s.ref } }
        // `planHash`: what Update now binds its one confirmation to (lib/updates/plan-hash.ts).
        if (s.remote || !plan.steps.some(x => x.action === 'ceph' || x.action === 'node-reboot' || x.action === 'self')) return { ...out, planHash: planHash(out) }
        try { const a = await annotatePlanSafety(s.exec, out, await s.exec.cephPresent()); return { ...a, planHash: planHash(a) } }
        catch (e: any) { return { ...out, warnings: [...out.warnings, `Ceph safety not checked: ${e?.message ?? e}`], planHash: planHash(out) } }
      } catch (e) { return sendError(reply, e) }
    })

    fastify.post<{ Body: { mode?: string; scope?: string; approve?: unknown; select?: unknown; autoReboot?: unknown; planHash?: unknown } }>('/jobs', async (req, reply) => {
      const mode = req.body?.mode
      if (mode !== 'run' && mode !== 'dry-run') return sendRefusal(reply, 400, 'invalid_request', "mode must be 'run' or 'dry-run'")
      const scope = req.body?.scope ?? 'all'
      if (scope !== 'all' && scope !== 'guests') return sendRefusal(reply, 400, 'invalid_request', "scope must be 'all' or 'guests'")
      const approve = req.body?.approve ?? []
      if (!Array.isArray(approve) || approve.length > 200 || !approve.every(a => typeof a === 'string' && APPROVAL_ID.test(a))) {
        return sendRefusal(reply, 400, 'invalid_request', 'approve must be a list of approval ids from the inventory')
      }
      const select = req.body?.select === undefined ? undefined : selectionFrom(req.body.select)
      if (Array.isArray(req.body?.select) && req.body.select.length === 0) return sendRefusal(reply, 400, 'invalid_request', EMPTY_SELECTION)
      if (select === null) return sendRefusal(reply, 400, 'invalid_request', `select must be a list of 1 to ${MAX_SELECTION} target ids from /targets`)
      // "Reboot automatically in the next window": a run only, home only, and confirmed with the run it rides on.
      const autoReboot = req.body?.autoReboot
      if (autoReboot !== undefined && typeof autoReboot !== 'boolean') return sendRefusal(reply, 400, 'invalid_request', 'autoReboot is true or false')
      const hash = req.body?.planHash
      if (hash !== undefined && (typeof hash !== 'string' || !PLAN_HASH.test(hash) || mode !== 'run' || !select)) return sendRefusal(reply, 400, 'invalid_request', 'planHash is the hash /preview returned, for a run of chosen machines')
      const s = svc()
      if (autoReboot && (mode !== 'run' || s.remote)) return sendRefusal(reply, 400, 'invalid_request', s.remote ? 'HyperProx does not reboot the nodes of a remote cluster on its own.' : 'Only a real run can ask for a reboot in the next window.')
      if (mode === 'run' && (s.remote || select || autoReboot) && !(await confirmed(req, reply))) return reply
      if (select) {
        // Refused before anything starts when nothing chosen could run (a held kernel package, unknown holds...).
        try {
          const inv = await s.inventory(false)
          const { load, selfVmid, guards } = treeFor(s, inv, await guardsFor(s))
          const pv = buildSelectedPlan(inv, load.policy, { ...guards, selection: select, approvals: approve as string[], selfVmid, remote: s.remote || undefined })
          if (!pv.steps.length) return sendRefusal(reply, 400, 'nothing_to_update', 'Nothing chosen can be updated', { refused: pv.refused ?? [] })
        } catch (e) { return sendError(reply, e) }
      }
      if (!(await yieldCheck(reply))) return reply
      try {
        // "Reboot automatically in the next window" is queued only once the run actually starts running (confirmed, or its
        // plan matched the one confirmed): a plan that is cancelled or expires never leaves a reboot waiting.
        const onRunning = autoReboot ? async (jobId: string) => {
          // Audited before it is saved: whatever this run leaves needing a reboot goes in the next window, once.
          await s.store.audit('updates.reboots.queued', jobId, { ...auditBy(actorOf(req)), ...(select ? { select } : {}) })
          // Only this run's own targets: a chosen run's nodes and guests (Ceph moves every node), or everything.
          const picked = select ? select.map(parseTargetId).filter((t): t is NonNullable<typeof t> => !!t) : null
          const only = picked && !picked.some(t => t.kind === 'ceph')
            ? { nodes: [...new Set(picked.flatMap(t => ('node' in t ? [t.node] : [])))], guests: [...new Set(picked.flatMap(t => ('vmid' in t ? [t.vmid] : [])))] }
            : null
          rt.reboots.queueNext(s.ref.id, req.session?.email ?? 'an admin', jobId, only)
        } : undefined
        const job = await s.runner.start(mode, 'manual', req.session?.email, scope, approve as string[], select, { planHash: hash as string | undefined, onRunning })
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
      if (!job) return sendRefusal(reply, 404, 'not_found', `No job ${req.params.id}`)
      return { job: jobView(job, await s.store.getSteps(job.id)) }
    })

    for (const op of ['confirm', 'resume', 'cancel'] as const) {
      fastify.post<{ Params: { id: string } }>(`/jobs/:id/${op}`, async (req, reply) => {
        const s = svc()
        if (op !== 'cancel') {
          // A run of chosen targets is confirmed and resumed on the page, like its start; so is any run on a remote cluster.
          const chosen = s.remote ? true : Array.isArray((await s.store.getJob(req.params.id).catch(() => null))?.plan?.items)
          if (chosen && !(await confirmed(req, reply))) return reply
        }
        if (op !== 'cancel' && !(await yieldCheck(reply))) return reply
        try {
          const job = await s.runner[op](req.params.id, req.session?.email)
          return { job: jobView(job, await s.store.getSteps(job.id)) }
        } catch (e) { return sendError(reply, e) }
      })
    }

    // Roll a guest back to the snapshot this job took, after one of its app steps failed. Paused jobs only.
    fastify.post<{ Params: { id: string }; Body: { target?: unknown } }>('/jobs/:id/rollback', async (req, reply) => {
      const target = req.body?.target
      if (typeof target !== 'string' || !/^\d{1,9}$/.test(target)) return sendRefusal(reply, 400, 'invalid_request', 'target must be a guest id')
      const s = svc()
      if (s.remote && !(await confirmed(req, reply))) return reply
      if (checker.running) return sendRefusal(reply, 409, 'check_busy', CHECK_BUSY)
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
      // A reboot is always confirmed on the page: it takes the node and, for a moment, its guests down.
      const standalone = s.remote ? `Reboot ${req.params.node.slice(0, 60)}? Guests that are not in HA stop with it and start again when it is back, usually in about 5 minutes.` : undefined
      if (!(await confirmed(req, reply, standalone))) return reply
      if (checker.running) return sendRefusal(reply, 409, 'check_busy', CHECK_BUSY)
      try {
        const job = await s.runner.rebootNode(req.params.node, req.session?.email)
        return reply.status(202).send({ job: jobView(job, await s.store.getSteps(job.id)) })
      } catch (e) { return sendError(reply, e) }
    })

    // --- Automatic reboots ------------------------------------------------------------------------
    // The card: settings, the window, what waits for it, a run in progress and the last ten. Read-only.
    fastify.get('/reboots', async (_req, reply) => {
      try { return await rt.reboots.status(svc().ref.id) }
      catch (e) { return sendError(reply, e) }
    })

    // Change the settings: admin, confirmed on the page (never an API token), audited with before and after.
    fastify.put<{ Body: unknown }>('/reboots/settings', async (req, reply) => {
      const s = svc()
      if (s.remote) return sendRefusal(reply, 400, 'not_available', 'HyperProx does not reboot the nodes of a remote cluster on its own.')
      if (!(await confirmed(req, reply))) return reply
      try {
        const before = rt.reboots.settings(s.ref.id)
        const after = rt.reboots.checkSettings(s.ref.id, req.body)
        await s.store.audit('updates.reboots.settings', s.ref.id, { before, after, ...auditBy(actorOf(req)) })
        rt.reboots.saveSettings(s.ref.id, after)
        return { settings: after }
      } catch (e) { return sendError(reply, e) }
    })

    // "Install updates automatically": the home cluster's scheduled run, every morning, off by default. Admin, confirmed on
    // the page (never an API token), audited with before and after.
    fastify.get('/auto-install', async (_req, reply) => {
      const s = svc()
      if (s.remote) return sendRefusal(reply, 400, 'not_available', 'HyperProx does not install updates on its own on a remote cluster.')
      const st = rt.autoInstall.load()
      const eff = withAutoInstall(loadPolicy(), st).policy.schedule
      return { enabled: st.enabled, time: AUTO_INSTALL_TIME, scheduleOn: eff.enabled, cron: eff.cron }
    })
    fastify.put<{ Body: { enabled?: unknown } }>('/auto-install', async (req, reply) => {
      const s = svc()
      if (s.remote) return sendRefusal(reply, 400, 'not_available', 'HyperProx does not install updates on its own on a remote cluster.')
      const enabled = req.body?.enabled
      if (typeof enabled !== 'boolean') return sendRefusal(reply, 400, 'invalid_request', 'enabled is true or false')
      if (!(await confirmed(req, reply))) return reply
      try {
        const before = rt.autoInstall.load()
        const after = { enabled, by: req.session?.email ?? 'an admin', at: new Date().toISOString() }
        await s.store.audit('updates.auto-install', s.ref.id, { before: before.enabled, after: enabled, ...auditBy(actorOf(req)) })
        rt.autoInstall.save(after)
        return { enabled, time: AUTO_INSTALL_TIME }
      } catch (e) { return sendError(reply, e) }
    })

    // "Reboot now (rolling)": the same engine as the window, now. `all`: every node, not only those that need it.
    fastify.post<{ Body: { all?: unknown } }>('/reboots/now', async (req, reply) => {
      const all = req.body?.all
      if (all !== undefined && typeof all !== 'boolean') return sendRefusal(reply, 400, 'invalid_request', 'all is true or false')
      const s = svc()
      if (s.remote) return sendRefusal(reply, 400, 'not_available', 'HyperProx does not reboot the nodes of a remote cluster on its own.')
      if (!(await confirmed(req, reply))) return reply
      if (checker.running) return sendRefusal(reply, 409, 'check_busy', CHECK_BUSY)
      try {
        const job = await rt.reboots.rebootNow(s.ref.id, { all: all === true, actor: req.session?.email })
        return reply.status(202).send({ job: jobView(job, await s.store.getSteps(job.id)) })
      } catch (e) { return sendError(reply, e) }
    })

    // The one-tap fix after a stopped rolling reboot: HA maintenance off, noout off once every OSD is up.
    fastify.post('/reboots/make-safe', async (req, reply) => {
      const s = svc()
      if (s.remote) return sendRefusal(reply, 400, 'not_available', 'HyperProx does not reboot the nodes of a remote cluster on its own.')
      if (!(await confirmed(req, reply))) return reply
      try { return await s.runner.makeSafe(req.session?.email) }
      catch (e) { return sendError(reply, e) }
    })

    // A person's run, Go ahead or Resume takes precedence over a check that is reading: the check stops at the next
    // machine, keeping what it read (and is owed again afterwards). Refused only if it does not stop within a minute.
    const yieldCheck = async (reply: FastifyReply): Promise<boolean> => {
      if (!checker.running) return true
      checker.abort('an Updates run was started')
      await Promise.race([checker.idle(), new Promise(r => setTimeout(r, 60_000).unref?.())])
      if (!checker.running) return true
      sendRefusal(reply, 409, 'check_busy', 'The daily check is finishing the machine it is reading and stops after it. Try again in a minute.')
      return false
    }

    // The daily check: its last result for every cluster, and "Check now". Read-only on every machine.
    // Manual checks are at least `manualCheckGapMs` apart: each one runs apt update on every node and guest.
    const manualGap = deps.manualCheckGapMs ?? 15 * 60_000
    let lastManual = 0
    const manualAfter = () => (lastManual ? new Date(lastManual + manualGap).toISOString() : null)
    fastify.get('/check', async () => ({ ...checker.status(), manualAfter: manualAfter() }))
    fastify.post('/check', async (req, reply) => {
      if (isTokenSession(req)) return sendRefusal(reply, 403, 'token_refused', 'An API token cannot start the updates check. Sign in to start one.')
      if (checker.running) return sendRefusal(reply, 409, 'check_running', 'A check is already running.', { status: checker.status() })
      const wait = lastManual + manualGap - Date.now()
      if (lastManual && wait > 0) {
        return sendRefusal(reply, 429, 'too_soon', `A check was started less than ${Math.round(manualGap / 60_000)} minutes ago. The next one can start in ${Math.ceil(wait / 60_000)} minute${Math.ceil(wait / 60_000) === 1 ? '' : 's'}.`, { manualAfter: manualAfter() })
      }
      lastManual = Date.now()
      await store.audit('updates.check.start', 'check', { ...auditBy(actorOf(req)), clusters: 'all' })
      checker.run('manual').catch(e => fastify.log.error(`[updates] check failed: ${e.message}`))
      return reply.status(202).send({ ...checker.status(), manualAfter: manualAfter() })
    })
  }
}

export const updatesRoutes: FastifyPluginAsync = buildUpdatesRoutes({ runtime: updatesRuntime })
