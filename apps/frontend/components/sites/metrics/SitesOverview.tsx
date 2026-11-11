'use client'

// =============================================================================
//  HyperProx — Websites: every site's numbers on one screen
//
//  The Metrics tab of the Websites section: today's visitors across all sites,
//  how many are up and down, the worst error rate, certificates running out,
//  and a row per site that opens its own Metrics tab. Built from the same
//  summaries the site cards use (/api/site-metrics/sites).
// =============================================================================

import Link from 'next/link'
import { Panel, Tiles } from '@/components/visual/kit'
import { SparkLine, UpState } from './charts'
import { KIND_WORD, fmtCount, fmtMs, fmtPct, type SiteSummary } from './types'
import { overviewTotals } from './overview'
import s from './metrics.module.css'

export function SitesOverview({ sites }: { sites: SiteSummary[] }) {
  if (!sites.length) {
    return (
      <Panel title="Metrics" sub="every site at once">
        <p className={s.note}>No site has numbers yet. Add one with New website or Add existing; its numbers start on the next five-minute read.</p>
      </Panel>
    )
  }
  const t = overviewTotals(sites)
  return (
    <>
      <Panel title="All sites" sub="today, from each site's access log and public check">
        <Tiles label="All sites today" items={[
          { label: 'visitors today', value: fmtCount(t.visitorsToday) },
          { label: 'page views', value: fmtCount(t.pageViewsToday) },
          { label: 'up', value: t.up, tone: t.up ? 'good' : undefined },
          { label: 'down', value: t.down, tone: t.down ? 'crit' : undefined },
          { label: 'worst error rate', value: fmtPct(t.worstErrorPct), tone: (t.worstErrorPct ?? 0) >= 5 ? 'warn' : undefined },
          { label: 'certs under 14 days', value: t.certsSoon, tone: t.certsSoon ? 'warn' : undefined },
          { label: 'alerts firing', value: t.alerts, tone: t.alerts ? 'warn' : undefined },
        ]} />
      </Panel>
      <Panel title="Each site" sub="open one for its Metrics tab">
        <div className={s.tw}>
          <table className={s.ovt}>
            <thead><tr><th scope="col">Site</th><th scope="col">State</th><th scope="col">Visitors today</th><th scope="col">Last 24 h</th><th scope="col">Errors</th><th scope="col">p95</th><th scope="col">Cert</th></tr></thead>
            <tbody>
              {sites.map(x => (
                <tr key={x.id}>
                  <th scope="row"><Link href={`/sites/${encodeURIComponent(x.id)}`}>{x.domain ?? x.name}</Link> <span className={s.kind}>{KIND_WORD[x.kind] ?? x.kind}</span></th>
                  <td><UpState up={x.up} /></td>
                  <td>{fmtCount(x.visitorsToday)}</td>
                  <td className={s.ovspark}><SparkLine data={x.spark} label={`${x.domain ?? x.name}: people per hour, last 24 hours`} /></td>
                  <td>{fmtPct(x.errorRatePct)}</td>
                  <td>{fmtMs(x.p95Ms)}</td>
                  <td>{x.certDays === null ? '—' : `${x.certDays} d`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  )
}
