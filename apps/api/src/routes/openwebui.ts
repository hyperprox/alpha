// =============================================================================
//  HyperProx — Open WebUI plug-in routes (/api/plugins/openwebui)
//
//  Roles (lib/roles.ts): everything here is admin, reads included. The plug-in's gallery card (/api/plugins/openwebui/data)
//  stays a viewer read and carries counts and model names only.
//
//    GET  /overview   the version, the models, the Ollama it uses and whether that answers, whether sign-up is open, and what
//                     is wrong with a fix for each. Read through the plug-in's own connection; no key is in the answer.
//    POST /actions    one fix: reconnect the Ollama (the one HyperProx knows, checked by Open WebUI first) or close sign-up. A
//                     signed-in admin's act: an API token is refused by name here and in the gate, the page confirms it first
//                     (the gate enforces the confirmation), and the action is audited before it runs; when the audit cannot be
//                     written, nothing is done. The body names an action from a fixed list and nothing else.
// =============================================================================

import type { FastifyPluginAsync } from 'fastify'
import { findPlugin } from '../plugins'
import { pluginEndpointClient } from '../lib/plugin-host'
import { auditOrThrow } from '../lib/audit'
import { getCredential } from '../lib/credentials'
import { hasRole } from '../lib/roles'
import { sendFailure, sendRefusal } from '../lib/failure'
import { OpenWebuiRefusal, readOverview, runAction, type OpenWebuiClient } from '../lib/openwebui/service'

const realClient = async (): Promise<OpenWebuiClient | null> => {
  const p = findPlugin('openwebui')
  const c = p ? await pluginEndpointClient(p).catch(() => null) : null
  return c?.post ? { get: (path, t) => c.get(path, t), post: (path, body, t) => c.post!(path, body, t) } : null
}
/** The Ollama the AI page is connected to (the Ollama recipe writes it when it installs one). */
const realKnown = () => getCredential('ai', 'ollama', 'url').catch(() => null)

export function buildOpenWebuiRoutes(deps: {
  client?: () => Promise<OpenWebuiClient | null>
  known?: () => Promise<string | null>
  audit?: (action: string, details: Record<string, unknown>) => Promise<void>
} = {}): FastifyPluginAsync {
  const client = deps.client ?? realClient
  const known = deps.known ?? realKnown
  const audit = deps.audit ?? ((a: string, d: Record<string, unknown>) => auditOrThrow(a, 'plugin:openwebui', d))
  const fail = (reply: any, e: unknown) => {
    if (e instanceof OpenWebuiRefusal) return sendRefusal(reply, e.status, e.code, e.message)
    if ((e as any)?.name === 'VaultLockedError') throw e
    return sendFailure(reply.request, reply, e, 'Open WebUI did not answer. The details are in the log.', { status: 502 })
  }
  return async (fastify) => {
    fastify.get('/overview', async (req, reply) => {
      if (req.apiToken) return sendRefusal(reply, 403, 'token_forbidden', 'API tokens cannot read this page.')
      if (!req.session || !hasRole(req.session.role, 'admin')) return sendRefusal(reply, 403, 'forbidden', 'This needs the admin role.')
      const c = await client()
      if (!c) return sendRefusal(reply, 409, 'not_connected', 'Open WebUI is not connected yet. Install it from the Catalogue and HyperProx connects it, or add its address and an API key in the plug-in\'s settings.')
      try { return { success: true, data: await readOverview(c, await known()) } } catch (e) { return fail(reply, e) }
    })

    fastify.post('/actions', async (req, reply) => {
      if (req.apiToken) return sendRefusal(reply, 403, 'token_forbidden', 'API tokens cannot use this route.')
      const s = req.session
      if (!s || !hasRole(s.role, 'admin')) return sendRefusal(reply, 403, 'forbidden', 'This needs the admin role.')
      const c = await client()
      if (!c) return sendRefusal(reply, 409, 'not_connected', 'Open WebUI is not connected yet.')
      try { return { success: true, data: await runAction(req.body, s.email, { client: c, known, audit }) } }
      catch (e) { return fail(reply, e) }
    })
  }
}

export const openWebuiRoutes: FastifyPluginAsync = buildOpenWebuiRoutes()
