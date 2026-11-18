// =============================================================================
//  HyperProx — Arr Stack "Sort requests into the right folder" routes (/api/plugins/arrstack/router)
//
//  Roles (lib/roles.ts):
//    GET  /router                    viewer, like the Arr Stack page: each app's root folders, its rules (the saved
//                                    ones, or the suggested ones matched to its folders by name), the last minute's
//                                    look, and the Recently sorted list with why each item went where it went.
//    POST /router/test               admin: "Test on my library", the rules over the whole library, read-only (it
//                                    moves nothing). At most six a minute per person. Its id is what switching on needs.
//    POST /router/settings           admin, confirmed on the page (lib/roles.ts ARR_CONFIRM, lib/confirm.ts): save one
//                                    app's rules. Switching sorting on, or changing the rules while it is on, needs the
//                                    id of a library test of exactly those rules from the last 15 minutes. Audited.
//    POST /router/move               admin, confirmed: "Undo / move to…", one item from Recently sorted to the folder
//                                    picked, files and all. Audited before it moves; never sorted again after.
//    POST /router/graduate/preview   admin: the finished shows that would move from the running-shows folder.
//    POST /router/graduate           admin, confirmed: move exactly the previewed shows and switch graduating on.
//  Every POST is a signed-in admin's act: API tokens are refused by name (lib/api-tokens.ts tokenForbidden). No master
//  password: nothing is deleted, and every move can be moved back.
// =============================================================================

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { sendFailure, sendRefusal } from '../lib/failure'
import { requireConfirm } from '../lib/confirm'
import { setConfirmNames } from '../lib/confirm-text'
import { hasRole } from '../lib/roles'
import { MissLimiter } from '../lib/plex-art'
import { RouterRefusal, type RouterService } from '../lib/arr-router/service'
import { currentRouterService } from '../lib/arr-router/production'

const isApp = (v: unknown): v is 'radarr' | 'sonarr' => v === 'radarr' || v === 'sonarr'

function fail(reply: FastifyReply, e: unknown) {
  if (e instanceof RouterRefusal) return sendRefusal(reply, e.status, e.code, e.message)
  return sendFailure(reply.request, reply, e, 'Radarr or Sonarr did not answer as expected. The details are in the log.', { status: 502 })
}

export function buildArrRouterRoutes(deps: { service?: () => RouterService | null; limiter?: MissLimiter; testLimiter?: MissLimiter } = {}): FastifyPluginAsync {
  const svc = deps.service ?? currentRouterService
  const limiter = deps.limiter ?? new MissLimiter(30)
  const testLimiter = deps.testLimiter ?? new MissLimiter(6)

  return async (fastify) => {
    setConfirmNames({
      routerMove: (app, id, folder) => svc()?.moveNames(app, id, folder) ?? null,
      routerGraduate: id => svc()?.graduateNames(id) ?? null,
    })
    const need = (reply: FastifyReply): RouterService | null => {
      const s = svc()
      if (!s) { sendRefusal(reply, 503, 'not_ready', 'This is not available yet. Try again in a minute.'); return null }
      return s
    }
    /** Every POST: a signed-in admin, never a token (the gate checks too), within the per-person limit. */
    const admin = (req: any, reply: FastifyReply): string | null => {
      if (req.apiToken) { sendRefusal(reply, 403, 'token_forbidden', 'API tokens cannot use this route.'); return null }
      const s = req.session
      if (!s || !hasRole(s.role, 'admin')) { sendRefusal(reply, 403, 'forbidden', 'This needs the admin role.'); return null }
      if (!limiter.allow(s.email)) { sendRefusal(reply, 429, 'rate_limited', 'Too many changes in a minute. Wait a moment and try again.'); return null }
      return s.email
    }
    const body = (req: any): Record<string, unknown> => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {})

    fastify.get('/router', async (_req, reply) => {
      const s = need(reply); if (!s) return
      try { return { success: true, data: await s.status() } } catch (e) { return fail(reply, e) }
    })

    fastify.post('/router/test', async (req, reply) => {
      const by = admin(req, reply); if (!by) return
      const s = need(reply); if (!s) return
      const b = body(req)
      if (!isApp(b.app)) return sendRefusal(reply, 400, 'bad_request', 'Name radarr or sonarr.')
      if (!testLimiter.allow(by)) return sendRefusal(reply, 429, 'rate_limited', 'Too many library tests in a minute. Each one reads the whole library: wait a moment.')
      try { return { success: true, data: await s.test(b.app, b.settings) } } catch (e) { return fail(reply, e) }
    })

    fastify.post('/router/settings', async (req, reply) => {
      const by = admin(req, reply); if (!by) return
      const b = body(req)
      if (!isApp(b.app)) return sendRefusal(reply, 400, 'bad_request', 'Name radarr or sonarr.')
      // The gate has already taken and audited the confirmation; this only makes sure it did.
      if (!(await requireConfirm(req, reply))) return
      const s = need(reply); if (!s) return
      try { return { success: true, data: await s.saveSettings(b.app, b.settings, b.testId, by) } } catch (e) { return fail(reply, e) }
    })

    fastify.post('/router/move', async (req, reply) => {
      const by = admin(req, reply); if (!by) return
      const b = body(req)
      if (!isApp(b.app) || !Number.isInteger(b.id) || (b.id as number) <= 0 || typeof b.folder !== 'string' || !b.folder || b.folder.length > 400) {
        return sendRefusal(reply, 400, 'bad_request', 'Name the item and the folder.')
      }
      if (!(await requireConfirm(req, reply))) return
      const s = need(reply); if (!s) return
      try { return { success: true, data: await s.move(b.app, b.id as number, b.folder, by) } } catch (e) { return fail(reply, e) }
    })

    fastify.post('/router/graduate/preview', async (req, reply) => {
      const by = admin(req, reply); if (!by) return
      const s = need(reply); if (!s) return
      if (!testLimiter.allow(by)) return sendRefusal(reply, 429, 'rate_limited', 'Too many previews in a minute. Each one reads the whole library: wait a moment.')
      try { return { success: true, data: await s.graduatePreview() } } catch (e) { return fail(reply, e) }
    })

    fastify.post('/router/graduate', async (req, reply) => {
      const by = admin(req, reply); if (!by) return
      const b = body(req)
      if (typeof b.previewId !== 'string' || !/^[0-9a-f]{24}$/.test(b.previewId)) return sendRefusal(reply, 400, 'bad_request', 'Look at the preview first.')
      if (!(await requireConfirm(req, reply))) return
      const s = need(reply); if (!s) return
      try { return { success: true, data: await s.graduateApply(b.previewId, by) } } catch (e) { return fail(reply, e) }
    })
  }
}

export const arrRouterRoutes: FastifyPluginAsync = buildArrRouterRoutes()
