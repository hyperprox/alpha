'use client'

// The Monitoring page's Websites panel: each site's state, check latency, today's visitors with a sparkline,
// error rate, p95 and certificate days, each linking to its Metrics tab. Also the site alerts, shaped like the
// Prometheus alerts so the page's feed shows both.

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { apiJson } from '@/lib/api'
import { Panel, styles } from '@/components/visual/kit'
import { SparkLine, UpState } from './charts'
import { ALERT_WORD, fmtCount, fmtMs, fmtPct, type SiteSummary } from './types'
import s from './metrics.module.css'

export interface SiteAlertRow { siteId: string; site: string; kind: string; since: number; detail: string }

/** A site alert in the shape app/monitoring's feed uses for Prometheus alerts. */
export function siteAlertAsMonitoringAlert(a: SiteAlertRow) {
  const severity = a.kind === 'down' ? 'critical' : a.kind === 'spike' ? 'info' : 'warning'
  return { name: `Website: ${ALERT_WORD[a.kind] ?? a.kind}`, severity: severity as 'critical' | 'warning' | 'info', state: 'firing', node: a.site,
    summary: a.detail, description: '', firedAt: new Date(a.since).toISOString() }
}

export async function fetchSiteAlerts(): Promise<SiteAlertRow[]> {
  const r = await apiJson<{ data: { alerts: SiteAlertRow[] } }>('/api/site-metrics/alerts')
  return r.ok && r.body ? r.body.data.alerts : []
}

export function WebsitesPanel() {
  const [sites, setSites] = useState<SiteSummary[] | null>(null)
  useEffect(() => {
    const load = () => void apiJson<{ data: { sites: SiteSummary[] } }>('/api/site-metrics/sites').then(r => setSites(r.ok && r.body ? r.body.data.sites : []))
    load()
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [])
  if (!sites || !sites.length) return null
  return (
    <Panel title="Websites" sub="public check · visitors today · errors · p95 · certificate" href="/sites" linkLabel="Sites">
      <div className={s.sites}>
        {sites.map(x => (
          <Link key={x.id} href={`/sites/${encodeURIComponent(x.id)}`} className={s.site}>
            <div className={s.siteHead}><b>{x.domain ?? x.name}</b><UpState up={x.up} /></div>
            <div className={s.siteRow}>
              <div><strong>{fmtCount(x.visitorsToday)}</strong><br /><small>visitors today</small></div>
              <SparkLine data={x.spark} label={`${x.name}: people per hour, last 24 hours`} />
            </div>
            <dl className={s.facts} style={{ marginTop: 4, gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
              <div className={s.fact}><dd>{x.up ? fmtMs(x.latencyMs) : '—'}</dd><dt>check</dt></div>
              <div className={s.fact}><dd>{fmtPct(x.errorRatePct)}</dd><dt>5xx</dt></div>
              <div className={s.fact}><dd>{fmtMs(x.p95Ms)}</dd><dt>p95</dt></div>
              <div className={s.fact}><dd>{x.certDays === null ? '—' : `${x.certDays} d`}</dd><dt>cert</dt></div>
            </dl>
            {x.alerts.length > 0 && <span className={styles.tag}>{x.alerts.map(a => ALERT_WORD[a.kind] ?? a.kind).join(' · ')}</span>}
          </Link>
        ))}
      </div>
    </Panel>
  )
}
