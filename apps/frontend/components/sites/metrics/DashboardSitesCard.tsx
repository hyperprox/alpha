'use client'

// The dashboard's Websites card: a glance. How many sites, how many are up, people today across all of them
// (bots and unconfirmed kept apart and smaller), then a pill for anything that needs a look: certificates running
// out and site alerts. Each site, its sparkline and the scanner-probe detail stay on the Sites page.
// Reads the one summary endpoint the Sites and Monitoring pages read; a viewer gets the same counts.

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { apiJson } from '@/lib/api'
import { Panel, Pill, Tiles, styles } from '@/components/visual/kit'
import { ALERT_WORD, fmtCount, type SiteSummary } from './types'
import { overviewTotals } from './overview'

const CERT_WARN_DAYS = 14

export function DashboardSitesCard() {
  const [sites, setSites] = useState<SiteSummary[] | null>(null)
  useEffect(() => {
    const load = () => void apiJson<{ data: { sites: SiteSummary[] } }>('/api/site-metrics/sites').then(r => setSites(r.ok && r.body ? r.body.data.sites : []))
    load()
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [])

  if (sites === null) return null
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
  const certs = sites.filter(x => x.certDays !== null && x.certDays < CERT_WARN_DAYS).length
  const alerts = sites.flatMap(x => x.alerts.map(a => ({ site: x.domain ?? x.name, kind: a.kind, detail: a.detail })))

  return (
    <Panel title="Websites" sub="today" href="/sites" linkLabel="Sites">
      <Tiles label="Websites today" items={[
        { label: 'sites', value: sites.length },
        { label: 'up', value: t.up, tone: t.up ? 'good' : undefined },
        { label: 'down', value: t.down, tone: t.down ? 'crit' : undefined },
        { label: 'people today', value: fmtCount(t.visitorsToday) },
      ]} />
      <p className={styles.empty} style={{ margin: '6px 0 0', fontSize: 11 }}>{fmtCount(bots)} bots · {fmtCount(unconfirmed)} unconfirmed, counted apart</p>
      {(certs > 0 || alerts.length > 0) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {certs > 0 && <Link href="/sites?tab=metrics"><Pill tone="warn">{certs} certificate{certs === 1 ? '' : 's'} under {CERT_WARN_DAYS} days</Pill></Link>}
          {alerts.map((a, i) => <Link key={i} href="/sites?tab=metrics"><Pill tone={a.kind === 'down' ? 'bad' : 'warn'} title={a.detail}>{a.site}: {ALERT_WORD[a.kind] ?? a.kind}</Pill></Link>)}
        </div>
      )}
    </Panel>
  )
}
