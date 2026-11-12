'use client'

// The dashboard's Websites card: how many sites are up, people today across all of them (bots and unconfirmed
// kept apart and smaller), certificates running out, scanner probes that were answered with a file, and any
// site alert. Reads the same endpoints the Sites and Monitoring pages read; a viewer gets the same counts.

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { apiJson } from '@/lib/api'
import { Panel, Pill, Tiles, styles } from '@/components/visual/kit'
import { SparkLine, UpState } from './charts'
import { ALERT_WORD, fmtCount, type SiteDetail, type SiteSummary } from './types'
import { overviewTotals } from './overview'
import s from './metrics.module.css'

const CERT_WARN_DAYS = 14

export function DashboardSitesCard() {
  const [sites, setSites] = useState<SiteSummary[] | null>(null)
  // Probes answered with a file, by site id (from each site's own detail, which a viewer may read as counts).
  const [exposed, setExposed] = useState<Record<string, number>>({})
  useEffect(() => {
    let alive = true
    const load = async () => {
      const r = await apiJson<{ data: { sites: SiteSummary[] } }>('/api/site-metrics/sites')
      const list = r.ok && r.body ? r.body.data.sites : []
      if (!alive) return
      setSites(list)
      const found: Record<string, number> = {}
      await Promise.all(list.map(async x => {
        const d = await apiJson<{ data: SiteDetail }>(`/api/site-metrics/sites/${encodeURIComponent(x.id)}?range=24h`)
        const n = d.ok && d.body ? d.body.data.security?.exposedCount ?? 0 : 0
        if (n > 0) found[x.id] = n
      }))
      if (alive) setExposed(found)
    }
    void load()
    const t = setInterval(() => void load(), 60_000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  if (sites === null) return <Panel title="Websites" sub="loading"><p className={styles.empty}>Reading your sites…</p></Panel>
  if (!sites.length) {
    return (
      <Panel title="Websites" sub="none yet" href="/sites" linkLabel="Sites">
        <p className={styles.empty}>No website yet. <Link href="/sites?tab=new">New website</Link></p>
      </Panel>
    )
  }

  const t = overviewTotals(sites, CERT_WARN_DAYS)
  const bots = sites.reduce((n, x) => n + (x.botsToday ?? 0), 0)
  const unconfirmed = sites.reduce((n, x) => n + (x.unconfirmedToday ?? 0), 0)
  const exposedSites = Object.keys(exposed).length
  const certSites = sites.filter(x => x.certDays !== null && x.certDays < CERT_WARN_DAYS)
  const allAlerts = sites.flatMap(x => x.alerts.map(a => ({ site: x.domain ?? x.name, kind: a.kind, detail: a.detail })))
  const spark = sites[0] && sites.length === 1 ? sites[0].spark : sumSparks(sites)

  return (
    <Panel title="Websites" sub={`${sites.length} site${sites.length === 1 ? '' : 's'} · today`} href="/sites" linkLabel="Sites">
      <Tiles label="Websites today" items={[
        { label: 'sites', value: sites.length },
        { label: 'up', value: t.up, tone: t.up ? 'good' : undefined },
        { label: 'down', value: t.down, tone: t.down ? 'crit' : undefined },
        { label: 'people today', value: fmtCount(t.visitorsToday) },
      ]} />
      <div className={s.siteRow} style={{ marginTop: 8 }}>
        <small>{fmtCount(bots)} bots · {fmtCount(unconfirmed)} unconfirmed</small>
        <SparkLine data={spark} label="People per hour across all sites, last 24 hours" />
      </div>

      {(exposedSites > 0 || certSites.length > 0 || allAlerts.length > 0) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '8px 0' }}>
          {exposedSites > 0 && <Pill tone="bad" title="A scanner asked for a private file and was answered with one. Open the site's Metrics tab.">
            Exposure: {exposedSites} site{exposedSites === 1 ? '' : 's'}</Pill>}
          {certSites.length > 0 && <Pill tone="warn">{certSites.length} certificate{certSites.length === 1 ? '' : 's'} under {CERT_WARN_DAYS} days</Pill>}
          {allAlerts.map((a, i) => <Pill key={i} tone={a.kind === 'down' ? 'bad' : 'warn'} title={a.detail}>{a.site}: {ALERT_WORD[a.kind] ?? a.kind}</Pill>)}
        </div>
      )}

      <div className={s.sites}>
        {sites.map(x => (
          <Link key={x.id} href="/sites" className={s.site}>
            <div className={s.siteHead}><b>{x.domain ?? x.name}</b><UpState up={x.up} /></div>
            <div className={s.siteRow}>
              <div><strong>{fmtCount(x.visitorsToday)}</strong><br /><small>people today</small></div>
              <SparkLine data={x.spark} label={`${x.name}: people per hour, last 24 hours`} />
            </div>
            {x.certDays !== null && <small className={s.note}>certificate {x.certDays} d</small>}
          </Link>
        ))}
      </div>
    </Panel>
  )
}

function sumSparks(sites: SiteSummary[]): number[] {
  const len = Math.max(0, ...sites.map(x => x.spark.length))
  return Array.from({ length: len }, (_, i) => sites.reduce((n, x) => n + (x.spark[i] ?? 0), 0))
}
