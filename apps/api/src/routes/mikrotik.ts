// =============================================================================
//  HyperProx — MikroTik LAN guard routes (/api/plugins/mikrotik/lan-guard)
//
//  Roles (lib/roles.ts): both are admin (the default for a POST) and re-confirmed in the page (lib/confirm.ts), which
//  keeps API tokens out; a token is refused here again by name. The page reads the guard's state from the plug-in's
//  normal GET /api/plugins/mikrotik/detail, so a read token can see it too.
//
//    POST /lan-guard/apply  { interface, subnets }  adds the list "hyperprox-lan" and one forward rule at the top
//    POST /lan-guard/undo   {}                      removes exactly those two things, found by HyperProx's comment
//
//  The plan is sent back by the page and checked against the router now; if it differs, nothing is changed. Every
//  change is audited before it is made. Nothing else on the router is touched.
// =============================================================================

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { auditOrThrow } from '../lib/audit'
import { sendFailure, sendRefusal } from '../lib/failure'
import { auditBy } from '../lib/http/request-actor'
import { GuardRefusal, applyGuard, undoGuard, type GuardDeps, type GuardRouter } from '../lib/mikrotik-lan'
import { getSettings, pluginEndpointClient, pluginOptions, type PluginContext } from '../lib/plugin-host'
import { findPlugin } from '../plugins'
import { findLan, findWans } from '../plugins/mikrotik'

export interface MikrotikRouteDeps {
  /** The router, through the plug-in's own login. Null when the plug-in is not set up. */
  router?: () => Promise<GuardRouter | null>
  /** The settings the plug-in reads (wan, lan, username). */
  options?: () => Promise<Record<string, string>>
  audit?: (action: string, details: Record<string, unknown>) => Promise<void>
}

const TOKEN_TEXT = 'An API token cannot change the router. Sign in and do it on the MikroTik page.'

export function buildMikrotikRoutes(deps: MikrotikRouteDeps = {}): FastifyPluginAsync {
  const router = deps.router ?? (async () => {
    const p = findPlugin('mikrotik')
    return p ? pluginEndpointClient(p, 'default', { strict: true }) : null
  })
  const options = deps.options ?? (async () => {
    const p = findPlugin('mikrotik')
    return p ? pluginOptions(p.manifest, await getSettings('mikrotik')) : {}
  })

  function fail(reply: FastifyReply, e: any) {
    if (e instanceof GuardRefusal) return sendRefusal(reply, e.status, e.code, e.message)
    return sendFailure(reply.request, reply, e, 'The router did not answer as expected. Nothing was left half-done; the details are in the log.', { status: 502 })
  }

  /** The router, the internet-facing links and the LAN link, read the way the page reads them. */
  async function prepare(): Promise<Omit<GuardDeps, 'audit'>> {
    const r = await router()
    if (!r) throw new GuardRefusal(409, 'not_set_up', 'The MikroTik plug-in is not set up yet.')
    const opt = await options()
    // The plug-in's own read helpers want a context; they only ever call get and option.
    const ctx = { get: (p: string, o?: { timeoutMs?: number }) => r.get(p, o?.timeoutMs), post: async () => null, option: (k: string) => opt[k] || undefined, from() { return ctx }, has: () => true } as unknown as PluginContext
    const wan = await findWans(ctx, opt.wan || undefined)
    const lan = opt.lan || await findLan(ctx, wan[0] ?? null)
    return { router: r, wan, lan, username: opt.username }
  }

  return async (fastify) => {
    const guarded = (action: 'apply' | 'undo') => async (req: any, reply: FastifyReply) => {
      if (req.apiToken) return reply.status(403).send({ success: false, code: 'token_forbidden', error: TOKEN_TEXT })
      const by = req.session?.email ?? 'unknown'
      try {
        const base = await prepare()
        const d: GuardDeps = {
          ...base,
          audit: (a, details) => (deps.audit ?? ((x, y) => auditOrThrow(x, 'plugin:mikrotik', y)))(a, { ...auditBy(by), ...details }),
        }
        const out = action === 'apply' ? await applyGuard(d, req.body ?? {}) : await undoGuard(d)
        return { success: true, data: out }
      } catch (e) { return fail(reply, e) }
    }
    fastify.post('/lan-guard/apply', guarded('apply'))
    fastify.post('/lan-guard/undo', guarded('undo'))
  }
}

export const mikrotikRoutes = buildMikrotikRoutes()
