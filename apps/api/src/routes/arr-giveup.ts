// =============================================================================
//  HyperProx — Arr Stack "Give up after X tries" routes (/api/plugins/arrstack/give-up)
//
//  Roles (lib/roles.ts):
//    GET  /give-up              viewer, like the Arr Stack page: each app's rule, its counts, the last daily run, and
//                               the given-up list (item, tries, since, reason, what was done).
//    POST /give-up/preview      admin: exactly what a rule would give up on today, from fresh counts. Changes
//                               nothing in Sonarr, Radarr or Lidarr. Its id is what turning the rule on confirms.
//    POST /give-up/settings     admin: save one app's rule. Turning it on needs the id of a preview of that same
//                               rule from the last 15 minutes. Audited.
//    POST /give-up/try-again    admin, confirmed: monitor again and search, or add a removed film or album back.
//    POST /give-up/releases     admin: "See what's available", ONE interactive search for one item or one season,
//                               at most once per item every ten minutes (the last answer in between); and at most
//                               six new searches a minute per person. A POST because it makes the arr search.
//    POST /give-up/grab         admin, confirmed: download one release from that search. Audited.
//  Every POST is a signed-in admin's act: API tokens are refused by name (lib/api-tokens.ts tokenForbidden).
//  No master password: nothing is deleted (removing a film or album keeps its files, and there are none).
// =============================================================================

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { sendFailure, sendRefusal } from '../lib/failure'
import { hasRole } from '../lib/roles'
import { MissLimiter } from '../lib/plex-art'
import { GiveUpRefusal, parseTarget, type GiveUpService } from '../lib/arr-giveup/service'
import { currentGiveUpService } from '../lib/arr-giveup/production'
import { isApp, parseKey, parseSettings } from '../lib/arr-giveup/logic'

function fail(reply: FastifyReply, e: unknown) {
  if (e instanceof GiveUpRefusal) return sendRefusal(reply, e.status, e.code, e.message)
  return sendFailure(reply.request, reply, e, 'Sonarr, Radarr or Lidarr did not answer as expected. The details are in the log.', { status: 502 })
}

export function buildArrGiveUpRoutes(deps: { service?: () => GiveUpService | null; limiter?: MissLimiter; searchLimiter?: MissLimiter } = {}): FastifyPluginAsync {
  const svc = deps.service ?? currentGiveUpService
  const limiter = deps.limiter ?? new MissLimiter(30)
  const searchLimiter = deps.searchLimiter ?? new MissLimiter(6)

  return async (fastify) => {
    const need = (reply: FastifyReply): GiveUpService | null => {
      const s = svc()
      if (!s) { sendRefusal(reply, 503, 'not_ready', 'This is not available yet. Try again in a minute.'); return null }
      return s
    }
    /** Every write: a signed-in admin, never a token (the gate checks too), within the per-person limit. */
    const admin = (req: any, reply: FastifyReply): string | null => {
      if (req.apiToken) { sendRefusal(reply, 403, 'token_forbidden', 'API tokens cannot use this route.'); return null }
      const s = req.session
      if (!s || !hasRole(s.role, 'admin')) { sendRefusal(reply, 403, 'forbidden', 'This needs the admin role.'); return null }
      if (!limiter.allow(s.email)) { sendRefusal(reply, 429, 'rate_limited', 'Too many changes in a minute. Wait a moment and try again.'); return null }
      return s.email
    }
    const body = (req: any): Record<string, unknown> => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {})

    fastify.get('/give-up', async (_req, reply) => {
      const s = need(reply); if (!s) return
      try { return { success: true, data: await s.status() } } catch (e) { return fail(reply, e) }
    })

    fastify.post('/give-up/preview', async (req, reply) => {
      const by = admin(req, reply); if (!by) return
      const s = need(reply); if (!s) return
      const b = body(req)
      if (!isApp(b.app)) return sendRefusal(reply, 400, 'bad_request', 'Name sonarr, radarr or lidarr.')
      const settings = parseSettings(b.app, { ...(b.settings as object ?? {}), enabled: true })
      if (typeof settings === 'string') return sendRefusal(reply, 400, 'bad_request', settings)
      try { return { success: true, data: await s.preview(b.app, settings) } } catch (e) { return fail(reply, e) }
    })

    fastify.post('/give-up/settings', async (req, reply) => {
      const by = admin(req, reply); if (!by) return
      const s = need(reply); if (!s) return
      const b = body(req)
      if (!isApp(b.app)) return sendRefusal(reply, 400, 'bad_request', 'Name sonarr, radarr or lidarr.')
      const settings = parseSettings(b.app, b.settings)
      if (typeof settings === 'string') return sendRefusal(reply, 400, 'bad_request', settings)
      try { return { success: true, data: await s.saveSettings(b.app, settings, b.previewId, by) } } catch (e) { return fail(reply, e) }
    })

    fastify.post('/give-up/try-again', async (req, reply) => {
      const by = admin(req, reply); if (!by) return
      const s = need(reply); if (!s) return
      const b = body(req)
      if (b.confirmed !== true) return sendRefusal(reply, 400, 'confirm_required', 'Confirm it first.')
      const keys = Array.isArray(b.keys) && b.keys.length <= 100 && b.keys.every(k => parseKey(k)) ? b.keys as string[] : null
      if (!keys?.length) return sendRefusal(reply, 400, 'bad_request', 'Name the items to try again.')
      try { return { success: true, data: await s.tryAgain(keys, by) } } catch (e) { return fail(reply, e) }
    })

    fastify.post('/give-up/releases', async (req, reply) => {
      const by = admin(req, reply); if (!by) return
      const s = need(reply); if (!s) return
      const b = body(req)
      if (!parseTarget(b.target)) return sendRefusal(reply, 400, 'bad_request', 'Name one item.')
      if (!searchLimiter.allow(by)) return sendRefusal(reply, 429, 'rate_limited', 'Too many searches in a minute. Each one asks every indexer: wait a moment.')
      try { return { success: true, data: await s.releases(b.target as string, by, { showZeroSeed: b.showZeroSeed === true }) } } catch (e) { return fail(reply, e) }
    })

    fastify.post('/give-up/grab', async (req, reply) => {
      const by = admin(req, reply); if (!by) return
      const s = need(reply); if (!s) return
      const b = body(req)
      if (b.confirmed !== true) return sendRefusal(reply, 400, 'confirm_required', 'Confirm the download first.')
      if (!parseTarget(b.target) || typeof b.releaseId !== 'string' || !/^[0-9a-f]{24}$/.test(b.releaseId)) return sendRefusal(reply, 400, 'bad_request', 'Name the release.')
      try { return { success: true, data: await s.grab(b.target as string, b.releaseId, by) } } catch (e) { return fail(reply, e) }
    })
  }
}

export const arrGiveUpRoutes: FastifyPluginAsync = buildArrGiveUpRoutes()
