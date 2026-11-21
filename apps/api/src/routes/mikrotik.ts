// =============================================================================
//  HyperProx — MikroTik routes (/api/plugins/mikrotik)
//
//  LAN guard (older) and the router manager (fixed addresses, port forwards, device blocks):
//
//    POST /lan-guard/apply  { interface, subnets }  adds the list "hyperprox-lan" and one forward rule at the top
//    POST /lan-guard/undo   {}                      removes exactly those two things, found by HyperProx's comment
//    GET  /control                                  what the manager page shows: devices, fixed addresses, forwards, blocks, history
//    POST /change/plan      { action, params }      the plan in words and its hash; reads only
//    POST /change/apply     { action, params, planHash, riskTick? }   re-plans, checks the hash (409 plan_changed), confirms, applies
//    POST /changes/:id/undo {}                      puts one recorded change back, through the same engine
//
//  Roles (lib/roles.ts): everything here is admin. Every write is confirmed in the page (lib/confirm.ts, bound to the
//  request body, so the confirmation covers exactly the plan that was shown) and an API token is refused by name here
//  and in lib/api-tokens.ts. Every change is audited before it is made. Nothing else on the router is touched.
// =============================================================================

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { auditOrThrow } from '../lib/audit'
import { requireConfirm } from '../lib/confirm'
import { sendFailure, sendRefusal } from '../lib/failure'
import { auditBy } from '../lib/http/request-actor'
import { GuardRefusal, applyGuard, canWriteFrom, undoGuard, type GuardDeps, type GuardRouter } from '../lib/mikrotik-lan'
import {
  ChangeRefusal, HAIRPIN_NOTE, RISKY, applyPlan, blockViews, defaultChangeStore, devicesOf, forwardViews, hasHairpin, historyView, leaseViews, planBlock,
  planForward, planHash, planLease, planSummary, planView, readInputs, routerKeyOf, undoChange, undoPlan,
  type ChangePlan, type ChangeRouter, type ChangeStore, type EngineDeps, type Management, type RouterInputs,
} from '../lib/mikrotik-change'
import { getSettings, pluginAddress, pluginEndpointClient, pluginOptions, type PluginContext } from '../lib/plugin-host'
import { findPlugin } from '../plugins'
import { findLan, findWans } from '../plugins/mikrotik'

type RouterClient = GuardRouter & ChangeRouter

export interface MikrotikRouteDeps {
  /** The router, through the plug-in's own login. Null when the plug-in is not set up. */
  router?: () => Promise<RouterClient | null>
  /** The settings the plug-in reads (wan, lan, username). */
  options?: () => Promise<Record<string, string>>
  audit?: (action: string, details: Record<string, unknown>) => Promise<void>
  /** The address HyperProx reaches the router on, and how. Defaults to the plug-in's saved address. */
  management?: () => Promise<{ host: string; service: string; port: number | null } | null>
  store?: ChangeStore
  /** Tests: a steady clock and ids for the engine. */
  engine?: Partial<Pick<EngineDeps, 'now' | 'newId'>>
}

const TOKEN_TEXT = 'An API token cannot change the router. Sign in and do it on the MikroTik page.'

type Builder = (i: RouterInputs, p: any) => ChangePlan
const BUILDERS: Record<string, Builder> = {
  'lease.make-static': (i, p) => planLease(i, { ...p, action: 'make-static' }),
  'lease.add': (i, p) => planLease(i, { ...p, action: 'add' }),
  'lease.edit': (i, p) => planLease(i, { ...p, action: 'edit' }),
  'lease.remove': (i, p) => planLease(i, { ...p, action: 'remove' }),
  'forward.add': (i, p) => planForward(i, { ...p, action: 'add' }),
  'forward.edit': (i, p) => planForward(i, { ...p, action: 'edit' }),
  'forward.toggle': (i, p) => planForward(i, { ...p, action: 'toggle' }),
  'forward.remove': (i, p) => planForward(i, { ...p, action: 'remove' }),
  'block.block': (i, p) => planBlock(i, { ...p, action: 'block' }),
  'block.unblock': (i, p) => planBlock(i, { ...p, action: 'unblock' }),
  'block.schedule': (i, p) => planBlock(i, { ...p, action: 'schedule' }),
}

export function buildMikrotikRoutes(deps: MikrotikRouteDeps = {}): FastifyPluginAsync {
  const router = deps.router ?? (async () => {
    const p = findPlugin('mikrotik')
    return p ? pluginEndpointClient(p, 'default', { strict: true }) as Promise<RouterClient | null> : null
  })
  const options = deps.options ?? (async () => {
    const p = findPlugin('mikrotik')
    return p ? pluginOptions(p.manifest, await getSettings('mikrotik')) : {}
  })
  const management = deps.management ?? (async () => {
    const p = findPlugin('mikrotik')
    const a = p ? await pluginAddress(p) : null
    if (!a) return null
    try {
      const u = new URL(a.url)
      return { host: u.hostname, service: u.protocol === 'https:' ? 'www-ssl' : 'www', port: u.port ? Number(u.port) : null }
    } catch { return null }
  })
  const store = deps.store ?? defaultChangeStore()

  function fail(reply: FastifyReply, e: any) {
    if (e instanceof GuardRefusal || e instanceof ChangeRefusal) return sendRefusal(reply, e.status, e.code, e.message)
    return sendFailure(reply.request, reply, e, 'The router did not answer as expected. Nothing was left half-done; the details are in the log.', { status: 502 })
  }

  /** The router, the internet-facing links and the LAN link, read the way the page reads them. */
  async function prepare(): Promise<Omit<GuardDeps, 'audit'> & { router: RouterClient; opt: Record<string, string> }> {
    const r = await router()
    if (!r) throw new GuardRefusal(409, 'not_set_up', 'The MikroTik plug-in is not set up yet.')
    const opt = await options()
    // The plug-in's own read helpers want a context; they only ever call get and option.
    const ctx = { get: (p: string, o?: { timeoutMs?: number }) => r.get(p, o?.timeoutMs), post: async () => null, option: (k: string) => opt[k] || undefined, from() { return ctx }, has: () => true } as unknown as PluginContext
    const wan = await findWans(ctx, opt.wan || undefined)
    const lan = opt.lan || await findLan(ctx, wan, { guard: true })
    return { router: r, wan, lan, username: opt.username, opt }
  }

  async function engineDeps(by: string, audit: EngineDeps['audit']): Promise<{ d: EngineDeps; wan: string[]; router: RouterClient }> {
    const base = await prepare()
    const m = await management()
    if (!m) throw new GuardRefusal(409, 'not_set_up', 'HyperProx does not know the address it reaches the router on, so it cannot check that a change keeps it reachable.')
    const mgmt: Management = { ...m, username: base.username, wan: base.wan }
    return { d: { router: base.router, management: mgmt, store, routerKey: routerKeyOf(m.host), by, audit, ...deps.engine }, wan: base.wan, router: base.router }
  }

  const auditFor = (by: string): EngineDeps['audit'] => (a, details) =>
    (deps.audit ?? ((x, y) => auditOrThrow(x, 'plugin:mikrotik', y)))(a, { ...auditBy(by), ...details })

  async function canWriteNow(r: RouterClient, username: string | undefined): Promise<boolean | null> {
    const [users, groups] = await Promise.all([r.get('/rest/user', 15_000).catch(() => []), r.get('/rest/user/group', 15_000).catch(() => [])])
    return canWriteFrom(Array.isArray(users) ? users : [], Array.isArray(groups) ? groups : [], username)
  }

  function buildPlan(inputs: RouterInputs, canWrite: boolean | null, action: unknown, params: unknown): ChangePlan {
    const b = typeof action === 'string' && Object.prototype.hasOwnProperty.call(BUILDERS, action) ? BUILDERS[action] : undefined
    if (!b) throw new ChangeRefusal(400, 'bad_request', 'HyperProx does not know that change.')
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new ChangeRefusal(400, 'bad_request', 'The request is missing its details.')
    if (canWrite === false) throw new ChangeRefusal(409, 'read_only_login', 'The router refused the change: the login HyperProx uses for it can only read. Give that router user a group with the write policy, then try again.')
    return b(inputs, params)
  }

  return async (fastify) => {
    const guarded = (action: 'apply' | 'undo') => async (req: any, reply: FastifyReply) => {
      if (req.apiToken) return reply.status(403).send({ success: false, code: 'token_forbidden', error: TOKEN_TEXT })
      const by = req.session?.email ?? 'unknown'
      try {
        const base = await prepare()
        const d: GuardDeps = { ...base, audit: auditFor(by) }
        const out = action === 'apply' ? await applyGuard(d, req.body ?? {}) : await undoGuard(d)
        return { success: true, data: out }
      } catch (e) { return fail(reply, e) }
    }
    fastify.post('/lan-guard/apply', guarded('apply'))
    fastify.post('/lan-guard/undo', guarded('undo'))

    const noToken = (req: any, reply: FastifyReply) => {
      if (!req.apiToken) return false
      reply.status(403).send({ success: false, code: 'token_forbidden', error: TOKEN_TEXT })
      return true
    }

    fastify.get('/control', async (req: any, reply) => {
      if (noToken(req, reply)) return
      try {
        const { d, wan, router: r } = await engineDeps(req.session?.email ?? 'unknown', async () => {})
        const inputs = await readInputs(r, wan)
        const hairpin = hasHairpin(inputs)
        return {
          success: true,
          data: {
            canWrite: await canWriteNow(r, d.management.username), wans: wan, devices: devicesOf(inputs), leases: leaseViews(inputs),
            forwards: forwardViews(inputs), blocks: blockViews(inputs),
            hairpin: { present: hairpin, note: hairpin ? null : HAIRPIN_NOTE },
            risky: Object.entries(RISKY).map(([port, why]) => ({ port: Number(port), why })),
            history: historyView(await store.list(d.routerKey)),
          },
        }
      } catch (e) { return fail(reply, e) }
    })

    fastify.post('/change/plan', async (req: any, reply) => {
      if (noToken(req, reply)) return
      try {
        const { wan, router: r, d } = await engineDeps(req.session?.email ?? 'unknown', async () => {})
        const plan = buildPlan(await readInputs(r, wan), await canWriteNow(r, d.management.username), req.body?.action, req.body?.params)
        return { success: true, data: planView(plan) }
      } catch (e) { return fail(reply, e) }
    })

    fastify.post('/change/apply', async (req: any, reply) => {
      if (noToken(req, reply)) return
      const by = req.session?.email ?? 'unknown'
      try {
        const { d, wan, router: r } = await engineDeps(by, auditFor(by))
        const plan = buildPlan(await readInputs(r, wan), await canWriteNow(r, d.management.username), req.body?.action, req.body?.params)
        if (typeof req.body?.planHash !== 'string' || req.body.planHash !== planHash(plan)) {
          throw new ChangeRefusal(409, 'plan_changed', 'The router changed since this page was loaded, so the plan is different now. Look at the new plan and try again.')
        }
        if (plan.needsTick && req.body?.riskTick !== true) throw new ChangeRefusal(409, 'risk_tick_required', 'This opens a risky port. Tick the box to say you understand, then try again.')
        if (!(await requireConfirm(req, reply, planSummary(plan)))) return
        return { success: true, data: await applyPlan(d, plan) }
      } catch (e) { return fail(reply, e) }
    })

    fastify.post('/changes/:id/undo', async (req: any, reply) => {
      if (noToken(req, reply)) return
      const by = req.session?.email ?? 'unknown'
      try {
        const { d } = await engineDeps(by, auditFor(by))
        const { plan } = await undoPlan(d, String(req.params.id))
        if (!(await requireConfirm(req, reply, planSummary(plan)))) return
        return { success: true, data: await undoChange(d, String(req.params.id)) }
      } catch (e) { return fail(reply, e) }
    })
  }
}

export const mikrotikRoutes = buildMikrotikRoutes()
