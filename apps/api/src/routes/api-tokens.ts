// =============================================================================
//  HyperProx — API token routes (/api/auth/tokens)
//  Settings → API tokens. Browser sessions only: the gate refuses an API token
//  here (token_forbidden), requires admin for all three, and a fresh master
//  password re-confirmation for create and revoke (lib/roles.ts). The checks
//  are repeated here so the routes stay safe if the matrix changes.
//
//    GET    /api/auth/tokens        list (never the hash, never the token)
//    POST   /api/auth/tokens        { name, role?, expiresDays? } → the token, once
//    DELETE /api/auth/tokens/:id    revoke (the row stays, with revokedAt)
// =============================================================================

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { hasRole } from '../lib/roles'
import {
  ApiTokenInputError, ApiTokenNotFoundError, TOKEN_ROLES, apiTokenStore, createApiToken, revokeApiToken, tokenView,
} from '../lib/api-tokens'

async function adminSessionOnly(req: FastifyRequest, reply: FastifyReply) {
  const s = req.session
  if (!s) return reply.status(401).send({ ok: false, code: 'unauthenticated', error: 'Authentication required' })
  if (req.apiToken) return reply.status(403).send({ ok: false, code: 'token_forbidden', error: 'API tokens cannot manage API tokens' })
  if (!hasRole(s.role, 'admin')) {
    return reply.status(403).send({ ok: false, code: 'forbidden', error: 'API tokens need the admin role', required: 'admin', role: s.role })
  }
}

export const apiTokenRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', adminSessionOnly)

  fastify.get('/', async () => {
    const rows = await apiTokenStore().list()
    return { ok: true, data: rows.map(r => tokenView(r)) }
  })

  fastify.post<{ Body: { name?: unknown; role?: unknown; expiresDays?: unknown } }>('/', async (req, reply) => {
    const s = req.session!
    const b = req.body ?? {}
    // A token never outranks the person who made it.
    if (b.role === 'owner' || (TOKEN_ROLES.includes(b.role as any) && !hasRole(s.role, b.role as any))) {
      return reply.status(403).send({ ok: false, code: 'forbidden', error: `You cannot create a token with the ${b.role} role` })
    }
    try {
      const { token, record } = await createApiToken(b as any, s.email)
      req.log.info({ name: record.name, role: record.role, by: s.email }, '[api-token] created')
      return { ok: true, token, data: tokenView(record) }
    } catch (e) {
      if (e instanceof ApiTokenInputError) return reply.status(400).send({ ok: false, error: e.message })
      throw e
    }
  })

  fastify.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const s = req.session!
    try {
      // By id only from the browser; the host CLI also takes a name.
      const row = await apiTokenStore().findById(req.params.id)
      if (!row) throw new ApiTokenNotFoundError(req.params.id)
      const out = await revokeApiToken(row.id, s.email)
      req.log.info({ name: out.name, by: s.email }, '[api-token] revoked')
      return { ok: true, data: tokenView(out) }
    } catch (e) {
      if (e instanceof ApiTokenNotFoundError) return reply.status(404).send({ ok: false, error: e.message })
      throw e
    }
  })
}
