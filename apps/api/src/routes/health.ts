import { FastifyPluginAsync } from 'fastify'
import { APP_VERSION }        from '../lib/version'

export const healthRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (request, reply) => {
    return {
      status:  'ok',
      version: APP_VERSION.version,
      commit:  APP_VERSION.sha || undefined,
      uptime:  process.uptime(),
      ts:      new Date().toISOString(),
    }
  })
}
