// =============================================================================
//  HyperProx — Monitoring setup routes
//    GET  /api/monitoring/pve-exporter   which token the PVE exporter uses, and whether Proxmox says it is
//                                        read-only (viewer, like every GET)
//    POST /api/monitoring/pve-exporter   make or repair its read-only token (admin, like every write);
//                                        body { fresh: true } replaces a token that is not read-only
//  No re-confirmation: the token it makes can only read. `hyperprox pve-exporter` calls the POST.
//    POST /api/monitoring/grafana-admin/reset   new Grafana admin password, set in Grafana and kept only in
//                                               the vault (admin, master password re-entered). Reveal it
//                                               under Settings → Secrets (hyperprox:system/grafana).
// =============================================================================

import type { FastifyPluginAsync } from 'fastify'
import { grafanaCliReset, resetGrafanaAdmin, productionGrafanaDeps } from '../lib/grafana-admin'
import {
  exporterStatus, provisionPveExporter, pveAccessFromEnv, type ExporterStatus, type ProvisionResult,
} from '../lib/pve-exporter'

export interface MonitoringRouteOptions {
  status?:    () => Promise<ExporterStatus>
  provision?: (o: { fresh: boolean }) => Promise<ProvisionResult>
  /** Sets Grafana's admin password; the value goes on stdin, never on a command line. */
  grafanaReset?: (password: string) => Promise<void>
}

export { grafanaCliReset }

export const monitoringRoutes: FastifyPluginAsync<MonitoringRouteOptions> = async (fastify, opts) => {
  const status = opts.status ?? (() => exporterStatus())
  const provision = opts.provision ?? ((o: { fresh: boolean }) => provisionPveExporter({ access: pveAccessFromEnv(), fresh: o.fresh }))

  fastify.get('/pve-exporter', async () => ({ success: true, data: await status() }))

  // Grafana's login form and basic auth are off, so this password is only for `grafana cli` work. It is
  // made here, written to the vault and read back, then set in Grafana; if Grafana refuses it, the vault
  // is put back. It is never written to .env and never returned.
  fastify.post('/grafana-admin/reset', async (req, reply) => {
    try {
      const d = productionGrafanaDeps()
      if (opts.grafanaReset) d.apply = opts.grafanaReset
      await resetGrafanaAdmin(d, req.session?.email)
      return { success: true, data: { savedInVault: 'hyperprox:system/grafana' } }
    } catch (e: any) {
      return reply.status(502).send({ success: false, error: e?.message ?? String(e) })
    }
  })

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
