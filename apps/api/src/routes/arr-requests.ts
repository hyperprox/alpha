// =============================================================================
//  HyperProx — Arr Stack, Seerr requests (/api/plugins/arrstack/requests)
//
//  Roles (lib/roles.ts):
//    GET  /requests          viewer, like the Arr Stack page: Seerr's requests with poster, status and where each one
//                            is now (and which folder the folder sorter put it in). Who asked is shown to a signed-in
//                            admin only; viewers and API tokens see "a family member".
//    GET  /requests/health   viewer: can Seerr reach Radarr, Sonarr and the media server? An admin also gets the
//                            Seerr settings that point at a profile or folder that no longer exists.
//    GET  /requests/poster/:file   one poster through Seerr's image proxy: a checked file name in, a fixed path out.
//    POST /requests/actions  admin, confirmed on the page (lib/confirm.ts: the gate takes the single-use token and
//                            audits it before this runs): approve, decline, retry a failed
//                            request, "Fix Seerr's settings", reconnect. Audited again before each change.
//  The POST is a signed-in admin's act: API tokens are refused by name (lib/api-tokens.ts tokenForbidden). No master
//  password: nothing is deleted. Seerr's address and key are never in an answer.
// =============================================================================

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { sendFailure, sendRefusal } from '../lib/failure'
import { requireConfirm } from '../lib/confirm'
import { setConfirmNames } from '../lib/confirm-text'
import { hasRole } from '../lib/roles'
import { ArtCache, MissLimiter } from '../lib/plex-art'
import { ACTIONS, RequestsRefusal, type ActionName, type FixChoice, type RequestsService, type Target } from '../lib/arr-requests/service'
import { requestsService } from '../lib/arr-requests/production'
import { posterFile } from '../lib/arr-requests/logic'

const TARGETS: Target[] = ['radarr', 'sonarr', 'media']

/** The admin's picks for "Fix Seerr's settings", checked field by field; null for anything else. */
export function parseChoices(v: unknown): FixChoice[] | null {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.length > 20) return null
  const out: FixChoice[] = []
  for (const x of v) {
    if (!x || typeof x !== 'object') return null
    const o = x as Record<string, unknown>
    if ((o.app !== 'radarr' && o.app !== 'sonarr') || !Number.isInteger(o.serverId) || (o.serverId as number) < 0 || (o.serverId as number) > 1e6) return null
    if (!['profile', 'folder', 'animeProfile', 'animeFolder'].includes(o.field as string)) return null
    if (typeof o.value !== 'string' || !o.value || o.value.length > 300) return null
    out.push({ app: o.app, serverId: o.serverId as number, field: o.field as FixChoice['field'], value: o.value })
  }
  return out
}

export function buildArrRequestsRoutes(deps: { service?: () => RequestsService | null; limiter?: MissLimiter; artLimiter?: MissLimiter } = {}): FastifyPluginAsync {
  const svc = deps.service ?? (() => requestsService())
  const limiter = deps.limiter ?? new MissLimiter(30)
  const artLimiter = deps.artLimiter ?? new MissLimiter(120)
  const cache = new ArtCache()
  return async (fastify) => {
    setConfirmNames({ requestTitle: id => svc()?.titleOfRequest(id) ?? null, requestsFix: choices => { const c = parseChoices(choices); return c ? svc()?.describeFix(c) ?? null : null } })
    const need = (reply: FastifyReply): RequestsService | null => {
      const s = svc()
      if (!s) { sendRefusal(reply, 503, 'not_ready', 'This is not available yet. Try again in a minute.'); return null }
      return s
    }
    const isAdmin = (req: any) => !req.apiToken && !!req.session && hasRole(req.session.role, 'admin')

    fastify.get('/requests', async (req, reply) => {
      const s = need(reply); if (!s) return
      try { return { success: true, data: await s.list(isAdmin(req)) } } catch (e) {
        return sendFailure(req, reply, e, 'Seerr could not be read. The details are in the log.', { status: 502 })
      }
    })

    fastify.get('/requests/health', async (req, reply) => {
      const s = need(reply); if (!s) return
      try {
        const h = await s.health()
        return { success: true, data: isAdmin(req) ? h : { ...h, stale: [] } }
      } catch (e) {
        return sendFailure(req, reply, e, 'Seerr could not be checked. The details are in the log.', { status: 502 })
      }
    })

    fastify.get<{ Params: { file: string } }>('/requests/poster/:file', async (req, reply) => {
      const file = posterFile(req.params.file)
      if (!file) return sendRefusal(reply, 400, 'bad_art', 'That is not a poster.')
      let hit = cache.get(file)
      if (!hit) {
        if (!artLimiter.allow(req.session?.sid ?? 'anonymous')) return sendRefusal(reply, 429, 'slow_down', 'Too many new images at once. Try again in a minute.')
        const s = need(reply); if (!s) return
        const img = await s.poster(file)
        if (!img) return sendRefusal(reply, 404, 'no_art', 'No poster for that.')
        cache.set(file, img.contentType, img.body); hit = cache.get(file)
      }
      return reply.header('Content-Type', hit!.contentType).header('Cache-Control', 'private, max-age=86400').header('X-Content-Type-Options', 'nosniff').send(hit!.body)
    })

    fastify.post('/requests/actions', async (req, reply) => {
      if (req.apiToken) return sendRefusal(reply, 403, 'token_forbidden', 'API tokens cannot use this route.')
      const session = req.session
      if (!session || !hasRole(session.role, 'admin')) return sendRefusal(reply, 403, 'forbidden', 'This needs the admin role.')
      const b = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>
      if (!ACTIONS.includes(b.action as ActionName)) return sendRefusal(reply, 400, 'bad_request', 'Name the action.')
      const action = b.action as ActionName
      const perRequest = action === 'approve' || action === 'decline' || action === 'retry'
      if (perRequest && !(Number.isInteger(b.id) && (b.id as number) > 0 && (b.id as number) < 1e9)) return sendRefusal(reply, 400, 'bad_request', 'Name the request.')
      if (b.reason !== undefined) return sendRefusal(reply, 400, 'bad_request', 'Seerr keeps no reason for a decline.')
      let choices: FixChoice[] = []
      if (action === 'fix-settings') {
        if (typeof b.baseId !== 'string' || !/^[0-9a-f]{16}$/.test(b.baseId)) return sendRefusal(reply, 400, 'bad_request', 'Say which problems you looked at.')
        const c = parseChoices(b.choices); if (!c) return sendRefusal(reply, 400, 'bad_request', 'Those choices are not valid.')
        choices = c
      } else if (b.baseId !== undefined || b.choices !== undefined) return sendRefusal(reply, 400, 'bad_request', 'Only fixing Seerr\'s settings takes choices.')
      if (action === 'reconnect' && !TARGETS.includes(b.target as Target)) return sendRefusal(reply, 400, 'bad_request', 'Name radarr, sonarr or media.')
      // Never confirm a fix without naming what it changes: with no fresh reading to name it, look again first.
      if (action === 'fix-settings' && !svc()?.describeFix(choices)) return sendRefusal(reply, 409, 'look_again', 'Look at the Requests tab again first: HyperProx cannot say what this would change.')
      // The gate has already taken and audited the confirmation; this only makes sure it did.
      if (!(await requireConfirm(req, reply))) return
      if (!limiter.allow(session.email)) return sendRefusal(reply, 429, 'rate_limited', 'Too many changes in a minute. Wait a moment and try again.')
      const s = need(reply); if (!s) return
      try {
        return { success: true, data: await s.act({ action, id: b.id as number | undefined, target: b.target as Target | undefined, baseId: b.baseId as string | undefined, choices }, session.email) }
      } catch (e) {
        if (e instanceof RequestsRefusal) return sendRefusal(reply, e.status, e.code, e.message)
        return sendFailure(req, reply, e, 'Seerr did not answer as expected. The details are in the log.', { status: 502 })
      }
    })
  }
}

export const arrRequestsRoutes: FastifyPluginAsync = buildArrRequestsRoutes()
