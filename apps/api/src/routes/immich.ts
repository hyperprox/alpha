// =============================================================================
//  HyperProx — Immich plug-in routes (/api/plugins/immich)
//
//  Roles (lib/roles.ts): everything here is admin, reads included (the overview names Immich's users and how much each
//  stores). The plug-in's gallery card (/api/plugins/immich/data) stays a viewer read and carries totals only.
//
//    GET  /overview   photos, videos, storage by user, the version and update, every job queue and what is wrong with
//                     each, with its fix. Read through the plug-in's own connection (HyperProx's key); none is in the answer.
//    POST /actions    one fix on one queue: resume, restart, clear failed. A signed-in admin's act: an API token is
//                     refused by name here and in the gate, the page confirms it first (the gate enforces the
//                     confirmation), and the action is audited before it runs; when the audit cannot be written, nothing
//                     is done. The body names an action and a queue from fixed lists and nothing else.
// =============================================================================

import type { FastifyPluginAsync } from 'fastify'
import { findPlugin } from '../plugins'
import { pluginEndpointClient } from '../lib/plugin-host'
import { auditOrThrow } from '../lib/audit'
import { hasRole } from '../lib/roles'
import { sendFailure, sendRefusal } from '../lib/failure'
import { ImmichRefusal, readOverview, runAction, type ImmichClient } from '../lib/immich/service'

type Reach = ImmichClient

const realClient = async (): Promise<Reach | null> => {
  const p = findPlugin('immich')
  const c = p ? await pluginEndpointClient(p).catch(() => null) : null
  return c ? { get: (path, t) => c.get(path, t), put: (path, body, t) => c.put(path, body, t) } : null
}

export function buildImmichRoutes(deps: {
  client?: () => Promise<Reach | null>
  audit?: (action: string, details: Record<string, unknown>) => Promise<void>
  wait?: (ms: number) => Promise<unknown>
} = {}): FastifyPluginAsync {
  const client = deps.client ?? realClient
  const audit = deps.audit ?? ((a: string, d: Record<string, unknown>) => auditOrThrow(a, 'plugin:immich', d))
  const fail = (reply: any, e: unknown) => {
    if (e instanceof ImmichRefusal) return sendRefusal(reply, e.status, e.code, e.message)
    if ((e as any)?.name === 'VaultLockedError') throw e
    return sendFailure(reply.request, reply, e, 'Immich did not answer. The details are in the log.', { status: 502 })
  }
  return async (fastify) => {
    fastify.get('/overview', async (req, reply) => {
      if (req.apiToken) return sendRefusal(reply, 403, 'token_forbidden', 'API tokens cannot read this page.')
      if (!req.session || !hasRole(req.session.role, 'admin')) return sendRefusal(reply, 403, 'forbidden', 'This needs the admin role.')
      const c = await client()
      if (!c) return sendRefusal(reply, 409, 'not_connected', 'Immich is not connected yet. Install it from the Catalogue and HyperProx connects it, or add its address and an API key in the plug-in\'s settings.')
      try { return { success: true, data: await readOverview(c) } } catch (e) { return fail(reply, e) }
    })

    fastify.post('/actions', async (req, reply) => {
      // The gate already refuses a token and anyone below admin; checked again so this route is safe on its own.
      if (req.apiToken) return sendRefusal(reply, 403, 'token_forbidden', 'API tokens cannot use this route.')
      const s = req.session
      if (!s || !hasRole(s.role, 'admin')) return sendRefusal(reply, 403, 'forbidden', 'This needs the admin role.')
      const c = await client()
      if (!c) return sendRefusal(reply, 409, 'not_connected', 'Immich is not connected yet.')
      try { return { success: true, data: await runAction(req.body as any, s.email, { client: c, audit, wait: deps.wait }) } }
      catch (e) { return fail(reply, e) }
    })
  }
}

export const immichRoutes: FastifyPluginAsync = buildImmichRoutes()
