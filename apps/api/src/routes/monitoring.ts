// =============================================================================
//  HyperProx — Monitoring setup routes
//    GET  /api/monitoring/pve-exporter   which token the PVE exporter uses (viewer, like every GET)
//    POST /api/monitoring/pve-exporter   make or repair its read-only token (admin, like every write)
//  No re-confirmation: the token it makes can only read. `hyperprox pve-exporter` calls the POST.
// =============================================================================

import type { FastifyPluginAsync } from 'fastify'
import {
  exporterStatus, provisionPveExporter, pveAccessFromEnv, type ExporterStatus, type ProvisionResult,
} from '../lib/pve-exporter'

export interface MonitoringRouteOptions {
  status?:    () => ExporterStatus
  provision?: () => Promise<ProvisionResult>
}

export const monitoringRoutes: FastifyPluginAsync<MonitoringRouteOptions> = async (fastify, opts) => {
  const status = opts.status ?? (() => exporterStatus())
  const provision = opts.provision ?? (() => provisionPveExporter({ access: pveAccessFromEnv() }))

  fastify.get('/pve-exporter', async () => ({ success: true, data: status() }))

  fastify.post('/pve-exporter', async (req, reply) => {
    try {
      const data = await provision()
      req.log.info({ action: data.action, tokenId: data.tokenId, restarted: data.restarted, by: req.session?.email },
        '[monitoring] pve-exporter token')
      return { success: true, data }
    } catch (e: any) {
      req.log.warn({ err: e?.message }, '[monitoring] pve-exporter token failed')
      return reply.status(502).send({ success: false, error: e?.message ?? String(e) })
    }
  })
}
