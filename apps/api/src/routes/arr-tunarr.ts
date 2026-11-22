// =============================================================================
//  HyperProx — Arr Stack, Live TV / Tunarr (/api/plugins/arrstack/tunarr)
//
//  Roles (lib/roles.ts):
//    GET  /tunarr            viewer, like the Arr Stack page: channels with what is on now and next, the hours of guide
//                            published, who is streaming, and Tunarr's health and version. Who is connected (address and
//                            player) is shown to a signed-in admin only; viewers and API tokens see counts.
//    GET  /tunarr/icon/:id   viewer: one channel's icon through HyperProx (a checked id in, Tunarr's own path out).
//    POST /tunarr/actions    admin, confirmed on the page (lib/confirm.ts: the gate takes the single-use token and
//                            audits it before this runs): "refresh-guide" and "stop-session". Audited again before the
//                            call to Tunarr. Everything else about Tunarr is read-only: its API offers no other action
//                            this page uses.
//  The POST is a signed-in admin's act: API tokens are refused by name (lib/api-tokens.ts tokenForbidden). No master
//  password: nothing is deleted. Tunarr's address is never in an answer.
// =============================================================================

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { sendFailure, sendRefusal } from '../lib/failure'
import { requireConfirm } from '../lib/confirm'
import { setConfirmNames } from '../lib/confirm-text'
import { hasRole } from '../lib/roles'
import { ArtCache, MissLimiter } from '../lib/plex-art'
import { ACTIONS, TunarrRefusal, type ActionName, type TunarrService } from '../lib/arr-tunarr/service'
import { tunarrService } from '../lib/arr-tunarr/production'

export function buildArrTunarrRoutes(deps: { service?: () => TunarrService | null; limiter?: MissLimiter; artLimiter?: MissLimiter } = {}): FastifyPluginAsync {
  const svc = deps.service ?? (() => tunarrService())
  const limiter = deps.limiter ?? new MissLimiter(10)
  const artLimiter = deps.artLimiter ?? new MissLimiter(120)
  const cache = new ArtCache(200)
  return async (fastify) => {
    setConfirmNames({ tunarrChannel: id => svc()?.channelName(id) ?? null })
    const need = (reply: FastifyReply): TunarrService | null => {
      const s = svc()
      if (!s) { sendRefusal(reply, 503, 'not_ready', 'This is not available yet. Try again in a minute.'); return null }
      return s
    }
    const isAdmin = (req: any) => !req.apiToken && !!req.session && hasRole(req.session.role, 'admin')

    fastify.get('/tunarr', async (req, reply) => {
      const s = need(reply); if (!s) return
      try { return { success: true, data: await s.read(isAdmin(req)) } } catch (e) {
        return sendFailure(req, reply, e, 'Tunarr could not be read. The details are in the log.', { status: 502 })
      }
    })

    fastify.get<{ Params: { id: string } }>('/tunarr/icon/:id', async (req, reply) => {
      if (!/^[A-Za-z0-9-]{8,64}$/.test(req.params.id)) return sendRefusal(reply, 400, 'bad_art', 'That is not a channel.')
      const key = `tunarr-${req.params.id}`
      let hit = cache.get(key)
      if (!hit) {
        if (!artLimiter.allow(req.session?.sid ?? 'anonymous')) return sendRefusal(reply, 429, 'slow_down', 'Too many new images at once. Try again in a minute.')
        const s = need(reply); if (!s) return
        const img = await s.icon(req.params.id)
        if (!img) return sendRefusal(reply, 404, 'no_art', 'No icon for that channel.')
        cache.set(key, img.contentType, img.body); hit = cache.get(key)
      }
      return reply.header('Content-Type', hit!.contentType).header('Cache-Control', 'private, max-age=3600').header('X-Content-Type-Options', 'nosniff').send(hit!.body)
    })

    fastify.post('/tunarr/actions', async (req, reply) => {
      if (req.apiToken) return sendRefusal(reply, 403, 'token_forbidden', 'API tokens cannot use this route.')
      const session = req.session
      if (!session || !hasRole(session.role, 'admin')) return sendRefusal(reply, 403, 'forbidden', 'This needs the admin role.')
      const b = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>
      if (!ACTIONS.includes(b.action as ActionName)) return sendRefusal(reply, 400, 'bad_request', 'Name the action.')
      const action = b.action as ActionName
      if (action === 'stop-session' && !(typeof b.channelId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(b.channelId))) return sendRefusal(reply, 400, 'bad_request', 'Name the channel.')
      if (action === 'refresh-guide' && b.channelId !== undefined) return sendRefusal(reply, 400, 'bad_request', 'Rebuilding the guide takes no channel.')
      // The gate has already taken and audited the confirmation; this only makes sure it did.
      if (!(await requireConfirm(req, reply))) return
      if (!limiter.allow(session.email)) return sendRefusal(reply, 429, 'rate_limited', 'Too many changes in a minute. Wait a moment and try again.')
      const s = need(reply); if (!s) return
      try {
        return { success: true, data: await s.act({ action, channelId: b.channelId as string | undefined }, session.email) }
      } catch (e) {
        if (e instanceof TunarrRefusal) return sendRefusal(reply, e.status, e.code, e.message)
        return sendFailure(req, reply, e, 'Tunarr did not answer as expected. The details are in the log.', { status: 502 })
      }
    })
  }
}

export const arrTunarrRoutes: FastifyPluginAsync = buildArrTunarrRoutes()
