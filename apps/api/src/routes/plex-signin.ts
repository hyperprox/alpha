// =============================================================================
//  HyperProx — Sign in with Plex (/api/plugins/plex/signin)
//
//  Roles (lib/roles.ts): admin for every method, reads included (the status names the account's servers and
//  their addresses). Starting a sign-in and saving the chosen server both save plug-in settings, so both need
//  the master password re-entered within five minutes, which keeps API tokens out; refused here by name for a
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
import { randomUUID } from 'node:crypto'
import { auditCredentialUse } from '../lib/audit'
import { hasRole } from '../lib/roles'
import { PLUGIN_CATEGORY, fetchWithTimeout, getSettings, saveSettings } from '../lib/plugin-host'
import { getCredential, setCredential } from '../lib/credentials'
import { PlexSignin, PlexSigninError, type PlexHttp, type SigninDeps } from '../lib/plex-signin'
import { findPlugin } from '../plugins'

/** The setting that holds this install's Plex client identifier. Not secret: plex.tv shows it as the device. */
export const CLIENT_ID_KEY = 'plex_client_id'

export const plexHttp: PlexHttp = async (method, url, headers, timeoutMs) => {
  const r = await fetchWithTimeout(url, headers, false, method, undefined, timeoutMs, 4 * 1024 * 1024)
  return { status: r.status, ok: r.ok, json: async () => JSON.parse(await r.text()) }
}

export async function plexClientId(): Promise<string> {
  const have = await getCredential(PLUGIN_CATEGORY, 'plex', CLIENT_ID_KEY)
  if (have) return have
  const id = randomUUID()
  await setCredential(PLUGIN_CATEGORY, 'plex', CLIENT_ID_KEY, id, false)
  return id
}

export async function savePlexEndpoint(url: string, serverToken: string): Promise<void> {
  const p = findPlugin('plex')
  if (!p) throw new Error('The Plex plug-in is not installed.')
  await saveSettings(p.manifest, { plex_url: url, plex_token: serverToken })
}

let shared: PlexSignin | null = null

export function buildPlexSigninRoutes(deps: {
  signin?: PlexSignin
  /** The address already known for Plex (the current setting), used when the page sends none. */
  known?: () => Promise<string | null>
} = {}): FastifyPluginAsync {
  return async (fastify) => {
    const svc = deps.signin ?? (shared ??= new PlexSignin({
      http: plexHttp, clientId: plexClientId, save: savePlexEndpoint,
      audit: (action, details) => auditCredentialUse(action, 'plugin:plex', details),
      log: (msg, fields) => fastify.log.info(fields ?? {}, msg),
    } satisfies SigninDeps))
    const known = deps.known ?? (async () => (await getSettings('plex').catch(() => ({} as Record<string, string>))).plex_url ?? null)

    const guard = (req: FastifyRequest, reply: FastifyReply): boolean => {
      if (req.apiToken) { reply.status(403).send({ success: false, code: 'token_forbidden', error: 'An API token cannot sign in to Plex.' }); return false }
      if (!req.session || !hasRole(req.session.role, 'admin')) { reply.status(403).send({ success: false, code: 'forbidden', error: 'This needs the admin role.' }); return false }
      return true
    }
    const fail = (reply: FastifyReply, e: any) => {
      if (e instanceof PlexSigninError) return reply.status(e.status).send({ success: false, code: e.code, error: e.message, ...(e.tried ? { tried: e.tried } : {}) })
      // A lock or an ended vault session mid-save: the gate's own answers (423, 401), as for any other route.
      if (e?.name === 'VaultLockedError' || e?.name === 'VaultSessionError') throw e
      if (e?.name === 'PluginSettingsError') return reply.status(400).send({ success: false, code: 'credential_required', error: e.message })
      // Never echo an unknown error: it could carry a request's details.
      fastify.log.warn({ err: String(e?.name ?? 'Error') }, '[plex] sign-in failed')
      return reply.status(500).send({ success: false, code: 'failed', error: 'The Plex sign-in failed. Try again.' })
    }

    fastify.post<{ Body: { known?: unknown } }>('/', async (req, reply) => {
      if (!guard(req, reply)) return
      try {
        const hint = typeof req.body?.known === 'string' && req.body.known.trim() ? req.body.known : await known()
        return { success: true, data: await svc.start(req.session!.sid, hint) }
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
