// =============================================================================
//  HyperProx — Sign in with Plex (/api/plugins/plex/signin)
//
//  Roles (lib/roles.ts): admin for every method, reads included (the status names the account's servers and
//  their addresses). Starting a sign-in and saving the chosen server both save plug-in settings, so both need
//  an in-page confirmation within five minutes, which keeps API tokens out; refused here by name for a
//  token as well.
//
//    POST   /signin               a new sign-in: the 4-character code, plex.tv/link, and the new-tab link
//    GET    /signin/:id           where it is: waiting, signed in (with the servers to choose from), expired
//    POST   /signin/:id/connect   test the chosen server and address, then save them as the Plex endpoint
//    DELETE /signin/:id           cancel
//
//  A sign-in belongs to the session that started it. No Plex token ever goes to the browser (lib/plex-signin.ts).
// =============================================================================

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { onLock } from '../lib/vault/state'
import { isAdmin } from '../lib/http/request-actor'
import { sendRefusal } from '../lib/failure'
import { getSettings } from '../lib/plugin-host'
import { currentContext } from '../lib/auth'
import { ownerOf } from './ai'
import { PlexSigninError, type PlexSignin } from '../lib/plex-signin'
import { sharedPlexSignin } from '../lib/plex-signin-shared'

export { CLIENT_ID_KEY, plexHttp, plexClientId, savePlexEndpoint } from '../lib/plex-signin-shared'

export function buildPlexSigninRoutes(deps: {
  signin?: PlexSignin
  /** The address already known for Plex (the current setting), used when the page sends none. */
  known?: () => Promise<string | null>
} = {}): FastifyPluginAsync {
  return async (fastify) => {
    const svc = deps.signin ?? sharedPlexSignin((msg, fields) => fastify.log.info(fields ?? {}, msg))
    // No server token is held past a lock.
    onLock(() => svc.dropAll())
    const known = deps.known ?? (async () => (await getSettings('plex').catch(() => ({} as Record<string, string>))).plex_url ?? null)

    const guard = (req: FastifyRequest, reply: FastifyReply): boolean => {
      if (req.apiToken) { sendRefusal(reply, 403, 'token_forbidden', 'An API token cannot sign in to Plex.'); return false }
      if (!isAdmin(req)) { sendRefusal(reply, 403, 'forbidden', 'This needs the admin role.'); return false }
      return true
    }
    const fail = (reply: FastifyReply, e: any) => {
      if (e instanceof PlexSigninError) return sendRefusal(reply, e.status, e.code, e.message, { ...(e.tried ? { tried: e.tried } : {}), ...(e.skipped?.length ? { skipped: e.skipped } : {}) })
      // A lock or an ended vault session mid-save: the gate's own answers (423, 401), as for any other route.
      if (e?.name === 'VaultLockedError' || e?.name === 'VaultSessionError') throw e
      if (e?.name === 'PluginSettingsError') return sendRefusal(reply, 400, 'credential_required', e.message)
      // Never echo an unknown error: it could carry a request's details.
      fastify.log.warn({ err: String(e?.name ?? 'Error') }, '[plex] sign-in failed')
      return sendRefusal(reply, 500, 'failed', 'The Plex sign-in failed. Try again.')
    }

    // `claim: true` is a sign-in to claim a new server the Catalogue is about to install: it keeps no server list, and
    // the install (made by the same person) asks for the claim code (lib/plex-signin.ts claimToken).
    fastify.post<{ Body: { known?: unknown; claim?: unknown } }>('/', async (req, reply) => {
      if (!guard(req, reply)) return
      try {
        const hint = typeof req.body?.known === 'string' && req.body.known.trim() ? req.body.known : await known()
        return { success: true, data: await svc.start(req.session!.sid, hint, req.body?.claim === true ? ownerOf(currentContext()) || undefined : undefined) }
      } catch (e) { return fail(reply, e) }
    })

    fastify.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
      if (!guard(req, reply)) return
      try { return { success: true, data: svc.status(req.params.id, req.session!.sid) } } catch (e) { return fail(reply, e) }
    })

    fastify.post<{ Params: { id: string }; Body: { server?: unknown; uri?: unknown } }>('/:id/connect', async (req, reply) => {
      if (!guard(req, reply)) return
      try {
        const out = await svc.connect(req.params.id, req.session!.sid, req.session!.email, req.body?.server, req.body?.uri)
        return { success: true, data: out }
      } catch (e) { return fail(reply, e) }
    })

    fastify.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
      if (!guard(req, reply)) return
      svc.cancel(req.params.id, req.session!.sid)
      return { success: true }
    })
  }
}

export const plexSigninRoutes = buildPlexSigninRoutes()
