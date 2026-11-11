'use client'

// =============================================================================
//  HyperProx — a site's Metrics tab
//
//  HUD (uptime ring and five chips), traffic (people and bots), top pages and
//  referrers, devices and browsers, responses and broken links, the Security
//  card (scanner probes), the container, and for WordPress what WP-CLI
//  reports. Everything here comes from counts the API keeps: no log line or
//  address reaches this page. A viewer sees totals only; pages, referrers,
//  404s, probe paths and WordPress need operator. "People" are visitors whose
//  browser behaved like a browser; the unconfirmed and bots are shown apart.
// =============================================================================

import { bytes as fmtBytes, duration } from '@/components/visual/kit'
import { Bars, Gauge, StackBar, StatusIcon, StatusRows, TrafficChart, UptimeRing } from './charts'
import { KIND_WORD, PROBE_WORD, fmtCount, fmtMs, fmtPct, type Range, type Security, type SiteDetail } from './types'
import s from './metrics.module.css'

const RANGE_SUB: Record<Range, string> = { '24h': 'LAST 24 HOURS · PER HOUR', '7d': 'LAST 7 DAYS · PER DAY', '30d': 'LAST 30 DAYS · PER DAY' }
const RANGE_SHORT: Record<Range, string> = { '24h': '24 h', '7d': '7 d', '30d': '30 d' }

function whenFor(range: Range) {
  return (at: number) => {
    const d = new Date(at)
    if (range === '24h') return `${String(d.getHours()).padStart(2, '0')}:00`
    if (range === '7d') return d.toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' })
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
  }
}

/** Scanner probes in the range: refused is good news; anything answered is said loudly, with the path for operators. */
function SecurityCard({ sec, own, range }: { sec: Security; own: number; range: Range }) {
  const exposed = sec.exposedCount > 0
  const refusedAll = sec.kinds.every(k => k.refused + k.errors === k.requests)
  const tone = exposed ? 'crit' : refusedAll ? 'good' : 'info'
  return (
    <section className={`${s.panel} ${exposed ? s.secBad : ''}`} aria-labelledby="sm-security">
      <h3 id="sm-security">Security <small>SCANNER PROBES · {RANGE_SHORT[range]}</small></h3>
      <p className={s.secHead} role={exposed ? 'alert' : undefined}>
        <StatusIcon tone={tone} />
        <span>{sec.total === 0 ? 'No scanner probes in this range.'
          : exposed ? `${sec.exposedCount} probe${sec.exposedCount === 1 ? ' was' : 's were'} answered with a file: possibly given away. Check ${sec.exposed?.length ? 'the paths below' : 'with an operator'} now.`
          : refusedAll ? `${fmtCount(sec.total)} probe${sec.total === 1 ? '' : 's'}, all refused.` : `${fmtCount(sec.total)} probes, none answered with a file.`}</span>
      </p>
      {exposed && sec.exposed && sec.exposed.length > 0 && (
        <ul className={s.list} aria-label="Probe paths the site answered">{sec.exposed.map(n => <li key={n.key} className={s.secPath}><span title={n.key}>{n.key}</span><em>{n.value}× answered</em></li>)}</ul>
      )}
      {sec.kinds.length > 0 && (
        <ul className={s.secKinds} aria-label="Probes by kind">
          {sec.kinds.map(k => (
            <li key={k.kind}>
              <b>{fmtCount(k.requests)}</b> for {PROBE_WORD[k.kind] ?? k.kind}
              <span>{k.refused === k.requests ? `, all refused${k.kind === 'secrets' ? ' (404)' : ''}` : `: ${[
                k.refused ? `${k.refused} refused` : '', k.answered ? `${k.answered} answered` : '', k.moved ? `${k.moved} redirected` : '', k.errors ? `${k.errors} server errors` : '',
              ].filter(Boolean).join(', ')}`}</span>
            </li>
          ))}
        </ul>
      )}
      {sec.catchAllCount > 0 && <p className={s.note}>{sec.catchAllCount} answered with the home page itself (a catch-all), so nothing was given away.</p>}
      <p className={s.secFoot}>Scanners try every public address. These are counted as bots, never as visitors or broken links. Addresses are never kept.
        {own > 0 && <> HyperProx checks: {fmtCount(own)}, left out of every figure.</>}</p>
    </section>
  )
}

export function SiteMetrics({ d, range }: { d: SiteDetail; range: Range }) {
  const sum = d.summary
  const total = d.status.s2xx + d.status.s3xx + d.status.s4xx + d.status.s5xx
  const share = (n: number) => (total ? Math.round((n / total) * 1000) / 10 : 0)
  const healthy = d.health.up === null ? 'NOT CHECKED YET' : d.health.up ? 'HEALTHY' : 'DOWN'
  const where = d.where ? ` · CT ${d.where.vmid} · ${d.where.node.toUpperCase()}` : ''
  const trend = sum.trendPct
  const c = d.container
  const wp = d.wordpress
  return (
    <>
      <section className={s.hud} aria-label="Site summary">
        <UptimeRing pct={d.hud.uptimePct} caption={RANGE_SHORT[range]} />
        <div className={s.hudR}>
          <h2><small>{(KIND_WORD[sum.kind] ?? sum.kind).toUpperCase()}{where} · {healthy}</small>Visitors and health</h2>
          <dl className={s.chips}>
            <div className={s.chip} title="Visitors whose browser opened a page and loaded its images, styles or scripts">
              <dt>people today</dt><dd>{fmtCount(sum.visitorsToday)}{trend !== null && <em className={trend >= 0 ? s.up : s.down}>{trend >= 0 ? '+' : ''}{trend}%<span className="sr-only"> against the same hours yesterday</span></em>}</dd>
              <small className={s.chipSub}>{fmtCount(sum.unconfirmedToday ?? 0)} unconfirmed · {fmtCount(sum.botsToday ?? 0)} bots</small>
            </div>
            <div className={s.chip}><dt>page views · {RANGE_SHORT[range]}</dt><dd>{fmtCount(d.hud.pageViews)}</dd></div>
            <div className={s.chip}><dt>error rate</dt><dd>{fmtPct(d.hud.errorRatePct)}</dd></div>
            <div className={s.chip} title={d.hud.hasRequestTime ? undefined : 'The log has no request time yet'}><dt>p95 response</dt><dd>{fmtMs(d.hud.p95Ms)}</dd></div>
            <div className={s.chip}><dt>served · {RANGE_SHORT[range]}</dt><dd>{fmtBytes(d.hud.bytes)}</dd></div>
          </dl>
        </div>
      </section>

      {(sum.countedBeforeFix || (d.hud.beforeFix ?? 0) > 0) && (
        <p className={s.beforeFix}>
          {sum.countedBeforeFix ? 'Part of today was ' : `${d.hud.beforeFix} ${range === '24h' ? 'hour' : 'day'}${d.hud.beforeFix === 1 ? ' was' : 's were'} `}
          counted before the accuracy fix, when every visitor that was not a known bot counted as a person and HyperProx&apos;s own checks were counted too.
          Those figures are higher than they would be now and are not compared with newer ones.
        </p>
      )}
      {sum.scannerBurst && (
        <p className={s.note} role="status"><b>Scanner burst.</b> {sum.scannerBurst.detail}</p>
      )}

      <section className={s.panel} aria-labelledby="sm-traffic">
        <h3 id="sm-traffic">Traffic <small>{RANGE_SUB[range]} · REQUESTS</small>
          <span className={s.legend} aria-hidden><span><i style={{ background: 'var(--chart-1)' }} />People</span><span><i style={{ background: 'var(--chart-2)' }} />Bots</span></span>
        </h3>
        <TrafficChart points={d.series} label={`Requests over the ${RANGE_SHORT[range]} range, people and bots`} when={whenFor(range)} />
      </section>

      {d.pages && (
        <div className={s.cols}>
          <section className={s.panel}><h3>Top pages <small>PAGE VIEWS</small></h3><Bars items={d.pages} label="Top pages" empty="No page views yet." /></section>
          <section className={s.panel}><h3>Where visitors came from <small>REFERRING SITES</small></h3>
            <Bars items={d.referrers ?? []} label="Referring sites" empty="No referring sites yet: visitors typed the address or used a bookmark." /></section>
        </div>
      )}

      <div className={s.cols}>
        <section className={s.panel}>
          <h3>Devices <small>PEOPLE ONLY</small></h3>
          <StackBar items={d.devices.map(x => ({ key: x.key[0].toUpperCase() + x.key.slice(1), pct: x.pct ?? 0 }))} label="Device share" />
          <h3 style={{ marginTop: 18 }}>Browsers</h3>
          <Bars items={d.browsers.map(b => ({ key: b.key, value: b.value, text: `${b.pct}%` }))} label="Browsers" empty="No people counted yet." />
        </section>
        <section className={s.panel}>
          <h3>Responses <small>ALL REQUESTS</small></h3>
          <StatusRows label="Responses by status class" rows={[
            { key: '2xx', word: 'OK', pct: share(d.status.s2xx), tone: 'good' },
            { key: '3xx', word: 'moved', pct: share(d.status.s3xx), tone: 'info' },
            { key: '4xx', word: 'refused', pct: share(d.status.s4xx), tone: 'warn' },
            { key: '5xx', word: 'error', pct: share(d.status.s5xx), tone: 'crit' },
          ]} />
          {d.notFound && (<>
            <h3 style={{ marginTop: 18 }}>Broken links <small>MOST-HIT 404s · PEOPLE ONLY</small></h3>
            {d.notFound.length ? (
              <ul className={s.list} aria-label="Most-hit missing pages">{d.notFound.map(n => <li key={n.key}><span title={n.key}>{n.key}</span><em>{n.value}</em></li>)}</ul>
            ) : <p className={s.note}>No broken links found by people. Scanners asking for files that never existed are on the Security card instead.</p>}
          </>)}
        </section>
      </div>

      {d.security && <SecurityCard sec={d.security} own={d.hud.own ?? 0} range={range} />}

      <section className={s.panel} aria-label="Container">
        <h3>Container <small>{d.where ? `CT ${d.where.vmid} · ` : ''}NOW</small></h3>
        {c ? (
          <div className={s.gauges}>
            <Gauge label="CPU" value={c.cpuPct} text={`${Math.round(c.cpuPct)}%`} />
            <Gauge label="Memory" value={c.memPct} text={`${Math.round(c.memPct)}%`} />
            <Gauge label="Disk" value={c.diskPct} text={`${Math.round(c.diskPct)}%`} />
          </div>
        ) : <p className={s.note}>Proxmox did not answer for this container.</p>}
        <dl className={s.facts}>
          {c && <div className={s.fact}><dd>↓ {fmtBytes(c.netIn7d)} · ↑ {fmtBytes(c.netOut7d)}</dd><dt>network · 7 d</dt></div>}
          <div className={s.fact}><dd>{d.health.up === null ? '—' : d.health.up ? fmtMs(d.health.latencyMs) : 'failing'}</dd><dt>public check{d.health.problem ? ` · ${d.health.problem}` : ''}</dt></div>
          <div className={s.fact}><dd>{d.health.certDays === null ? '—' : `${d.health.certDays} days`}</dd><dt>certificate left</dt></div>
          {c && <div className={s.fact}><dd>{duration(c.uptimeS)}</dd><dt>since last restart</dt></div>}
        </dl>
      </section>

      {sum.kind === 'wordpress' && wp && (
        <section className={s.panel} aria-label="WordPress">
          <h3>WordPress <small>READ FROM WP-CLI · HOURLY</small></h3>
          {wp.problem && <p className={s.note}>{wp.problem}</p>}
          <dl className={s.facts} style={{ marginTop: 0 }}>
            <div className={s.fact}><dd>{wp.core ?? '—'}</dd><dt>WordPress</dt></div>
            <div className={s.fact}><dd>{wp.php ?? '—'}</dd><dt>PHP</dt></div>
            <div className={s.fact}><dd>{wp.fpm.length ? (wp.fpm.every(f => f.active) ? 'Running' : 'Stopped') : '—'}</dd><dt>PHP-FPM</dt></div>
            <div className={s.fact}><dd>{wp.errors.length}</dd><dt>recent PHP errors</dt></div>
            <div className={s.fact}><dd>{wp.updates.length}</dd><dt>updates waiting</dt></div>
          </dl>
          {wp.updates.length > 0 && (
            <ul className={s.upd} aria-label="Updates waiting">
              {wp.updates.map(u => <li key={`${u.kind}:${u.name}`}><span>{u.kind === 'core' ? 'WordPress core' : `${u.kind === 'plugin' ? 'Plug-in' : 'Theme'}: ${u.name}`}</span><em>{u.version} → {u.available}</em></li>)}
            </ul>
          )}
          {wp.errors.length > 0 && (
            <ul className={s.errs} aria-label="Recent PHP errors">
              {wp.errors.slice(0, 5).map((e, i) => <li key={i}>{e.at ? `${e.at} · ` : ''}{e.text}</li>)}
            </ul>
          )}
          <p className={s.note} style={{ marginTop: 10 }}>Checked {new Date(wp.checkedAt).toLocaleString()}. Read-only: HyperProx never updates WordPress from here.</p>
        </section>
      )}

      {d.collector && (d.collector.lastError || !d.hud.hasRequestTime) && (
        <p className={s.note}>
          {d.collector.lastError ? `Reading ${d.collector.logPath}: ${d.collector.lastError} ` : ''}
          {!d.hud.hasRequestTime ? `The log (${d.collector.format ?? 'not read yet'}) has no request time, so p95 is empty.` : ''}
        </p>
      )}

      <div className={s.priv}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M12 3 4 7v5c0 5 3.4 8.5 8 9 4.6-.5 8-4 8-9V7z" /></svg>
        <span>Read from the site&apos;s own web server log. No tracking code, no cookies, nothing sent to anyone else. Visitor addresses are never stored:
          each one is scrambled with a key that changes every day and is then deleted, so people are counted once a day without being identified. Days are UTC days.</span>
      </div>
    </>
  )
}
