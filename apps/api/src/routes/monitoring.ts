// =============================================================================
//  HyperProx — Monitoring setup routes
//    GET  /api/monitoring/pve-exporter   which token the PVE exporter uses, and whether Proxmox says it is
//                                        read-only (viewer, like every GET)
//    POST /api/monitoring/pve-exporter   make or repair its read-only token (admin, like every write);
//                                        body { fresh: true } replaces a token that is not read-only
//  No re-confirmation: the token it makes can only read. `hyperprox pve-exporter` calls the POST.
// =============================================================================

import type { FastifyPluginAsync } from 'fastify'
import {
  exporterStatus, provisionPveExporter, pveAccessFromEnv, type ExporterStatus, type ProvisionResult,
} from '../lib/pve-exporter'

export interface MonitoringRouteOptions {
  status?:    () => Promise<ExporterStatus>
  provision?: (o: { fresh: boolean }) => Promise<ProvisionResult>
}

export const monitoringRoutes: FastifyPluginAsync<MonitoringRouteOptions> = async (fastify, opts) => {
  const status = opts.status ?? (() => exporterStatus())
  const provision = opts.provision ?? ((o: { fresh: boolean }) => provisionPveExporter({ access: pveAccessFromEnv(), fresh: o.fresh }))

  fastify.get('/pve-exporter', async () => ({ success: true, data: await status() }))

  fastify.post<{ Body: { fresh?: unknown } | undefined }>('/pve-exporter', async (req, reply) => {
    const fresh = req.body?.fresh === true
    try {
      const data = await provision({ fresh })
      req.log.info({ action: data.action, tokenId: data.tokenId, restarted: data.restarted, fresh, by: req.session?.email },
        '[monitoring] pve-exporter token')
      return { success: true, data }
    } catch (e: any) {
      req.log.warn({ err: e?.message }, '[monitoring] pve-exporter token failed')
      if (e?.code === 'not_read_only') {
        return reply.status(409).send({ success: false, code: 'not_read_only', error: e.message, reasons: e.reasons ?? [] })
      }
      return reply.status(502).send({ success: false, error: e?.message ?? String(e) })
    }
  })
}
