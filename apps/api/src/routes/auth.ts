// =============================================================================
//  HyperProx — Authentication Routes
// =============================================================================

import { FastifyPluginAsync } from 'fastify'
import {
  getAdminHash,
  setAdminPassword,
  verifyPassword,
  buildAuthCookie,
} from '../lib/auth'

const SESSION_SECONDS = 12 * 60 * 60

export const authRoutes: FastifyPluginAsync = async (fastify) => {

  // POST /api/auth/login — exchange the admin password for a session cookie
  fastify.post<{ Body: { password?: string } }>(
    '/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const password = req.body?.password
      if (!password) return reply.status(400).send({ ok: false, error: 'password is required' })

      const stored = await getAdminHash()
      if (!stored) {
        return reply.status(503).send({
          ok: false,
          error: 'No admin password is configured on the server',
        })
      }

      if (!verifyPassword(password, stored)) {
        return reply.status(401).send({ ok: false, error: 'Invalid password' })
      }

      const token = fastify.jwt.sign({ sub: 'admin' }, { expiresIn: `${SESSION_SECONDS}s` })
      reply.header('Set-Cookie', buildAuthCookie(token, SESSION_SECONDS))
      return { ok: true, expiresIn: SESSION_SECONDS }
    }
  )

  // POST /api/auth/logout — clear the session cookie
  fastify.post('/logout', async (_req, reply) => {
    reply.header('Set-Cookie', buildAuthCookie('', 0))
    return { ok: true }
  })

  // GET /api/auth/me — session probe (reaches here only if the guard passed)
  fastify.get('/me', async () => ({ ok: true, user: 'admin' }))

  // POST /api/auth/password — rotate the admin password
  fastify.post<{ Body: { current?: string; next?: string } }>('/password', async (req, reply) => {
    const { current, next } = req.body ?? {}
    if (!current || !next) {
      return reply.status(400).send({ ok: false, error: 'current and next are both required' })
    }
    if (next.length < 12) {
      return reply.status(400).send({ ok: false, error: 'new password must be at least 12 characters' })
    }

    const stored = await getAdminHash()
    if (!stored || !verifyPassword(current, stored)) {
      return reply.status(401).send({ ok: false, error: 'Current password is incorrect' })
    }

    await setAdminPassword(next)
    reply.header('Set-Cookie', buildAuthCookie('', 0))
    return { ok: true, message: 'Password changed — log in again' }
  })
}
