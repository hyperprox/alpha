// =============================================================================
//  HyperProx — site metrics: wiring
//
//  registerSiteMetrics(server) is the one call index.ts makes: the Postgres
//  store, the /api/site-metrics routes and the five-minute collector.
//  siteMetricsExposition() is what /api/plugins/metrics appends for Prometheus.
// =============================================================================

import type { FastifyInstance } from 'fastify'
import { listSites } from '../sites'
import { buildSiteMetricsRoutes } from '../../routes/site-metrics'
import { SiteMetricsCollector, realCollectorDeps } from './collector'
import { metricsStore, setMetricsStore, PrismaMetricsStore } from './store'
import { dayStart } from './aggregate'
import { summary, exposition } from './view'
import { emptyAgg } from './aggregate'

export async function registerSiteMetrics(server: FastifyInstance): Promise<void> {
  setMetricsStore(new PrismaMetricsStore(server.prisma))
  await server.register(buildSiteMetricsRoutes(), { prefix: '/api/site-metrics' })
  if (process.env.SITE_METRICS === 'off') { server.log.info('[site-metrics] collector off (SITE_METRICS=off)'); return }
  const collector = new SiteMetricsCollector(realCollectorDeps(m => server.log.info(m)))
  collector.start()
  server.addHook('onClose', async () => collector.stop())
}

/** Prometheus text for every site, labelled by site name only. Never throws: a broken store gives nothing. */
export async function siteMetricsExposition(now = new Date()): Promise<string> {
  try {
    const store = metricsStore()
    const sites = await listSites()
    const today = dayStart(now)
    const rows = await Promise.all(sites.map(async s => {
      const st = await store.getState(s.id)
      const day = (await store.days(s.id, today, new Date(today.getTime() + 86_400_000)))[0]?.agg ?? emptyAgg()
      return { name: s.domain ?? s.name, s: await summary(s, st, store, now), today: day }
    }))
    return rows.length ? exposition(rows) : ''
  } catch { return '' }
}
