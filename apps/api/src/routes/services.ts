import { FastifyPluginAsync }                from 'fastify'
import { checkGrafana, checkPrometheus }     from '../lib/service-health'

// success means "the probe finished and the body says what it found", not "the
// service is up": a down service is an answer, and the state field carries it.
export const serviceRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/grafana',    async () => ({ success: true, data: await checkGrafana() }))
  fastify.get('/prometheus', async () => ({ success: true, data: await checkPrometheus() }))
}
