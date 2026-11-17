// =============================================================================
//  HyperProx — Arr Stack VPN (Gluetun) panel routes (/api/plugins/arrstack/vpn)
//
//  Roles (lib/roles.ts):
//    GET  /vpn           viewer, like the Arr Stack page: tunnel up or down, where it comes out, the forwarded port
//                        against qBittorrent's listening port, speeds, uptime and any problem. The tunnel's public
//                        address only for an admin; everyone else sees that it is hidden. Never a VPN login.
//    POST /vpn/actions   admin, confirmed: one fix (set-port, reconnect, restart-qbit). Audited before it runs.
//  The POST is a signed-in admin's act: API tokens are refused by name (lib/api-tokens.ts tokenForbidden).
// =============================================================================

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { sendFailure, sendRefusal } from '../lib/failure'
import { hasRole } from '../lib/roles'
import { MissLimiter } from '../lib/plex-art'
import { VpnRefusal, type VpnService } from '../lib/arr-vpn/service'
import { arrVpnService } from '../lib/arr-vpn/production'
import { forViewer, type FixName } from '../lib/arr-vpn/parse'

const FIXES: FixName[] = ['set-port', 'reconnect', 'restart-qbit']

export function buildArrVpnRoutes(deps: { service?: () => VpnService | null; limiter?: MissLimiter } = {}): FastifyPluginAsync {
  const svc = deps.service ?? (() => arrVpnService())
  const limiter = deps.limiter ?? new MissLimiter(10)
  return async (fastify) => {
    const need = (reply: FastifyReply): VpnService | null => {
      const s = svc()
      if (!s) { sendRefusal(reply, 503, 'not_ready', 'This is not available yet. Try again in a minute.'); return null }
      return s
    }

    fastify.get('/vpn', async (req, reply) => {
      const s = need(reply); if (!s) return
      try {
        const st = await s.status()
        const admin = !req.apiToken && !!req.session && hasRole(req.session.role, 'admin')
        return { success: true, data: admin ? st : forViewer(st) }
      } catch (e) {
        return sendFailure(req, reply, e, 'The VPN could not be read. The details are in the log.', { status: 502 })
      }
    })

    fastify.post('/vpn/actions', async (req, reply) => {
      if (req.apiToken) return sendRefusal(reply, 403, 'token_forbidden', 'API tokens cannot use this route.')
      const session = req.session
      if (!session || !hasRole(session.role, 'admin')) return sendRefusal(reply, 403, 'forbidden', 'This needs the admin role.')
      const b = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>
      if (!FIXES.includes(b.action as FixName)) return sendRefusal(reply, 400, 'bad_request', 'Name the fix.')
      if (b.confirmed !== true) return sendRefusal(reply, 400, 'confirm_required', 'Confirm the fix first.')
      if (!limiter.allow(session.email)) return sendRefusal(reply, 429, 'rate_limited', 'Too many fixes in a minute. Wait a moment and try again.')
      const s = need(reply); if (!s) return
      try { return { success: true, data: await s.act(b.action as FixName, session.email) } } catch (e) {
        if (e instanceof VpnRefusal) return sendRefusal(reply, e.status, e.code, e.message)
        return sendFailure(req, reply, e, 'The fix did not run as expected. The details are in the log.', { status: 502 })
      }
    })
  }
}

export const arrVpnRoutes: FastifyPluginAsync = buildArrVpnRoutes()
