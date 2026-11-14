import { FastifyPluginAsync } from 'fastify'
import { APP_VERSION }        from '../lib/version'

export const healthRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (request, reply) => {
    return {
      status:  'ok',
      version: APP_VERSION.version,
      commit:  APP_VERSION.sha || undefined,
      describe: APP_VERSION.describe || undefined,
      uptime:  process.uptime(),
      ts:      new Date().toISOString(),
    }
  })
}

/**
 * GET /api/health: the unauthenticated liveness probe (answers while the vault is locked). Status only: no
 * version, no host names, no uptime. The detailed answer stays on /health, which nginx does not publish.
 */
export const publicHealthRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async () => ({ status: 'ok' }))
}
