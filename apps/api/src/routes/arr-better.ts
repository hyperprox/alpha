// =============================================================================
//  HyperProx — Arr Stack "Find a better copy" routes (/api/plugins/arrstack/better)
//
//  Roles (lib/roles.ts):
//    GET  /better/find       viewer, like the Arr Stack page: films, shows or albums whose title holds the words
//                            typed, with what is on disk. Read-only.
//    GET  /better/episodes   viewer: one season's episodes, with what is on disk. Read-only.
//    POST /better/search     admin: ONE interactive release search for one item, or for the item a queue download is
//                            for. At most once per item every ten minutes (the last answer in between), and at most
//                            six new searches a minute per person. A POST because it makes the arr search. Audited.
//    POST /better/grab       admin, confirmed on the page (lib/roles.ts needsConfirm, lib/confirm.ts: the gate takes the
//                            single-use token and audits it before this runs): download the picked release and move it
//                            to the top of qBittorrent's queue; for a queue download, then remove the slow one
//                            (blocklisted). Audited. The confirmation names the release (setConfirmNames below).
//                            With override: true, a release the arr refuses is downloaded anyway: the confirmation
//                            names the arr's reasons, and it is audited as arrstack.better.override. Never a release
//                            on the never-offered list (lib/arr-release/releases.ts NEVER_OFFERED), whatever the body says.
//  Every POST is a signed-in admin's act: API tokens are refused by name (lib/api-tokens.ts tokenForbidden).
//  No master password: no library file is ever deleted, and nothing a person cannot undo is changed.
// =============================================================================

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { sendFailure, sendRefusal } from '../lib/failure'
import { requireConfirm } from '../lib/confirm'
import { setConfirmNames } from '../lib/confirm-text'
import { hasRole } from '../lib/roles'
import { MissLimiter } from '../lib/plex-art'
import { BetterRefusal, parseBetterTarget, type BetterCopyService } from '../lib/arr-better/service'
import { betterCopyService } from '../lib/arr-better/production'

function fail(reply: FastifyReply, e: unknown) {
  if (e instanceof BetterRefusal) return sendRefusal(reply, e.status, e.code, e.message)
  return sendFailure(reply.request, reply, e, 'Sonarr, Radarr or Lidarr did not answer as expected. The details are in the log.', { status: 502 })
}

export function buildArrBetterRoutes(deps: { service?: () => BetterCopyService | null; limiter?: MissLimiter; searchLimiter?: MissLimiter } = {}): FastifyPluginAsync {
  const svc = deps.service ?? betterCopyService
  const limiter = deps.limiter ?? new MissLimiter(30)
  const searchLimiter = deps.searchLimiter ?? new MissLimiter(6)

  return async (fastify) => {
    setConfirmNames({ betterGrab: (target, releaseId) => svc()?.namesFor(target, releaseId) ?? null })
    const need = (reply: FastifyReply): BetterCopyService | null => {
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

    fastify.get('/better/find', async (req, reply) => {
      const s = need(reply); if (!s) return
      const q = req.query as Record<string, unknown>
      const text = typeof q.q === 'string' ? q.q.slice(0, 80) : ''
      if (q.app !== 'sonarr' && q.app !== 'radarr' && q.app !== 'lidarr') return sendRefusal(reply, 400, 'bad_request', 'Name sonarr, radarr or lidarr.')
      try {
        if (q.app === 'sonarr') return { success: true, data: { shows: await s.findShows(text) } }
        return { success: true, data: { items: await s.find(q.app, text) } }
      } catch (e) { return fail(reply, e) }
    })

    fastify.get('/better/episodes', async (req, reply) => {
      const s = need(reply); if (!s) return
      const q = req.query as Record<string, unknown>
      const series = /^[1-9]\d{0,9}$/.test(String(q.seriesId ?? '')) ? Number(q.seriesId) : null
      const season = /^(0|[1-9]\d{0,3})$/.test(String(q.season ?? '')) ? Number(q.season) : null
      if (series === null || season === null) return sendRefusal(reply, 400, 'bad_request', 'Name the show and the season.')
      try { return { success: true, data: await s.episodes(series, season) } } catch (e) { return fail(reply, e) }
    })

    fastify.post('/better/search', async (req, reply) => {
      const by = admin(req, reply); if (!by) return
      const s = need(reply); if (!s) return
      const b = body(req)
      if (!parseBetterTarget(b.target)) return sendRefusal(reply, 400, 'bad_request', 'Name one item or one download.')
      if (!searchLimiter.allow(by)) return sendRefusal(reply, 429, 'rate_limited', 'Too many searches in a minute. Each one asks every indexer: wait a moment.')
      try { return { success: true, data: await s.search(b.target as string, by) } } catch (e) { return fail(reply, e) }
    })

    fastify.post('/better/grab', async (req, reply) => {
      const by = admin(req, reply); if (!by) return
      // The gate has already taken and audited the confirmation; this only makes sure it did.
      if (!(await requireConfirm(req, reply))) return
      const s = need(reply); if (!s) return
      const b = body(req)
      if (!parseBetterTarget(b.target) || typeof b.releaseId !== 'string' || !/^[0-9a-f]{24}$/.test(b.releaseId)) return sendRefusal(reply, 400, 'bad_request', 'Name the release.')
      if (b.anyway !== undefined && typeof b.anyway !== 'boolean') return sendRefusal(reply, 400, 'bad_request', 'Bad "grab anyway" value.')
      if (b.override !== undefined && typeof b.override !== 'boolean') return sendRefusal(reply, 400, 'bad_request', 'Bad "download anyway" value.')
      try { return { success: true, data: await s.grab(b.target as string, b.releaseId, by, { anyway: b.anyway === true, override: b.override === true }) } } catch (e) { return fail(reply, e) }
    })
  }
}

export const arrBetterRoutes: FastifyPluginAsync = buildArrBetterRoutes()
