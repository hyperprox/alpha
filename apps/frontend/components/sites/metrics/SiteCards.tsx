'use client'

// The site cards at the top of a site's Metrics tab: each site with its state, today's visitors and a 24-hour
// sparkline of people. The card for the site being shown is marked current.

import Link from 'next/link'
import { SparkLine, UpState } from './charts'
import { KIND_WORD, fmtCount, type SiteSummary } from './types'
import s from './metrics.module.css'

export function SiteSparkRow({ site }: { site: SiteSummary }) {
  return (
    <div className={s.siteRow}>
      <div><strong>{fmtCount(site.visitorsToday)}</strong><br /><small>visitors today</small></div>
      <SparkLine data={site.spark} label={`${site.name}: people per hour, last 24 hours`} />
    </div>
  )
}

export function SiteCards({ sites, current }: { sites: SiteSummary[]; current?: string }) {
  if (sites.length < 2) return null
  return (
    <nav className={s.sites} aria-label="Sites">
      {sites.map(x => (
        <Link key={x.id} href={`/sites/${encodeURIComponent(x.id)}`} className={s.site} aria-current={x.id === current ? 'page' : undefined}>
          <div className={s.siteHead}><b>{x.domain ?? x.name}</b><span className={s.kind}>{KIND_WORD[x.kind] ?? x.kind}</span><UpState up={x.up} /></div>
          <SiteSparkRow site={x} />
        </Link>
      ))}
    </nav>
  )
}
