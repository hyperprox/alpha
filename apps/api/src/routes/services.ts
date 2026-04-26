import { FastifyPluginAsync }                from 'fastify'
import { checkGrafana, checkPrometheus }     from '../lib/service-health'

export const serviceRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/grafana',    async (_, r) => {
    const h = await checkGrafana()
    return { success: h.connected, data: h }
  })
  fastify.get('/prometheus', async (_, r) => {
    const h = await checkPrometheus()
    return { success: h.connected, data: h }
  })
}
