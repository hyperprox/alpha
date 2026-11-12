'use client'

// =============================================================================
//  HyperProx — one site: its Metrics tab (and, for admins, its Alerts tab)
//
//  Readable by every signed-in role; the API trims what a viewer gets to
//  totals. The tools that change something are admin-only and the API
//  checks again.
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { apiJson } from '@/lib/api'
import { Page, styles } from '@/components/visual/kit'
import { SiteCards } from '@/components/sites/metrics/SiteCards'
import { SiteMetrics } from '@/components/sites/metrics/SiteMetrics'
import { AlertSettingsPanel, LogFormatDialog } from '@/components/sites/metrics/AdminTools'
import { DeleteSiteDialog } from '@/components/sites/DeleteSiteDialog'
import type { Range, SiteDetail, SiteSummary } from '@/components/sites/metrics/types'
import s from '@/components/sites/metrics/metrics.module.css'

const RANGES: Array<[Range, string]> = [['24h', '24 h'], ['7d', '7 days'], ['30d', '30 days']]

export default function SitePage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [range, setRange] = useState<Range>('7d')
  const [tab, setTab] = useState<'metrics' | 'alerts'>('metrics')
  const [d, setD] = useState<SiteDetail | null>(null)
  const [sites, setSites] = useState<SiteSummary[]>([])
  const [err, setErr] = useState('')
  const [logFormat, setLogFormat] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    const [a, b] = await Promise.all([
      apiJson<{ data: SiteDetail }>(`/api/site-metrics/sites/${encodeURIComponent(id)}?range=${range}`),
      apiJson<{ data: { sites: SiteSummary[] } }>('/api/site-metrics/sites'),
    ])
    if (a.ok && a.body) { setD(a.body.data); setErr('') } else setErr(a.error ?? 'Could not load this site.')
    if (b.ok && b.body) setSites(b.body.data.sites)
  }, [id, range])
  useEffect(() => { void load(); const t = setInterval(() => void load(), 60_000); return () => clearInterval(t) }, [load])

  const title = d ? (d.summary.domain ?? d.summary.name) : 'Site'
  return (
    <Page>
      <div className={s.top}>
        <div><Link className={s.crumb} href="/sites">← Sites · Metrics</Link><h1>{title}</h1></div>
        <div className={s.tools}>
          {d?.canAdmin && (
            <div className={s.seg} role="group" aria-label="View">
              <button type="button" aria-pressed={tab === 'metrics'} onClick={() => setTab('metrics')}>Metrics</button>
              <button type="button" aria-pressed={tab === 'alerts'} onClick={() => setTab('alerts')}>Alerts</button>
            </div>
          )}
          {d?.canAdmin && (
            <button type="button" className={styles.btn} style={{ color: 'var(--crit)' }} onClick={() => setDeleting(true)}>{d.summary.adopted ? 'Stop tracking' : 'Delete'}</button>
          )}
          {tab === 'metrics' && (
            <div className={s.seg} role="group" aria-label="Time range">
              {RANGES.map(([r, label]) => <button key={r} type="button" aria-pressed={range === r} onClick={() => setRange(r)}>{label}</button>)}
            </div>
          )}
        </div>
      </div>

      <SiteCards sites={sites} current={id} />

      {err && <p className={styles.empty}>{err}</p>}
      {!d && !err && <p className={styles.empty}>loading metrics…</p>}

      {d && tab === 'metrics' && <SiteMetrics d={d} range={range} />}

      {d && tab === 'alerts' && d.canAdmin && (
        <>
          {d.alertSettings && <AlertSettingsPanel siteId={d.summary.id} initial={d.alertSettings} />}
          <section className={s.panel} aria-label="Log format">
            <h3>Response times <small>{d.collector?.litespeed ? 'LITESPEED LOG' : 'NGINX LOG FORMAT'}</small></h3>
            <p className={s.note}>
              {d.collector?.litespeed
                ? (d.hud.hasRequestTime ? 'This site\'s LiteSpeed log already records how long each request took.'
                  : 'This site\'s LiteSpeed log does not record how long each request took, so p50 and p95 stay empty. HyperProx reads LiteSpeed\'s log as it is and does not change LiteSpeed or CyberPanel, so no logging change is offered here.')
                : d.hud.hasRequestTime ? 'This site\'s log already records how long each request took.'
                : 'This site\'s log does not record how long each request took, so p50 and p95 stay empty. HyperProx can add $request_time (and the proxy\'s X-Forwarded-For, so visitors behind the proxy are told apart) to its nginx log format: you see the exact lines first, and it asks for the master password.'}
            </p>
            {!d.hud.hasRequestTime && !d.collector?.litespeed && <button type="button" className={styles.btn} style={{ marginTop: 10 }} onClick={() => setLogFormat(true)}>Preview the change</button>}
            {d.collector && <p className={s.note} style={{ marginTop: 10 }}>Reading {d.collector.logPath} ({d.collector.format ?? 'not read yet'}){d.collector.lastReadAt ? `, last read ${new Date(d.collector.lastReadAt).toLocaleTimeString()}` : ''}.{d.collector.gaps ? ` ${d.collector.gaps} rotation gap(s) so far.` : ''}</p>}
          </section>
          {d.summary.adopted && (
            <section className={s.panel} aria-label="Adopted site">
              <h3>Adopted site</h3>
              <p className={s.note}>HyperProx only reads from this container. Stop tracking removes it from Sites and deletes its numbers; the container is never touched, and its DNS record and proxy host stay unless you tick them and type the site&apos;s name.</p>
              <div style={{ marginTop: 10 }}><button type="button" className={styles.btn} onClick={() => setDeleting(true)}>Stop tracking</button></div>
            </section>
          )}
        </>
      )}

      {deleting && d && <DeleteSiteDialog siteId={d.summary.id} onClose={() => setDeleting(false)} onDone={() => router.push('/sites')} />}
      {logFormat && d && <LogFormatDialog siteId={d.summary.id} onClose={() => { setLogFormat(false); void load() }} />}
    </Page>
  )
}
