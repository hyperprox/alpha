import { FastifyPluginAsync } from 'fastify'

export const healthRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (request, reply) => {
    return {
      status:  'ok',
      version: '0.1.0',
      uptime:  process.uptime(),
      ts:      new Date().toISOString(),
    }
  })
}
