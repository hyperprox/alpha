// =============================================================================
//  HyperProx — site metrics: what the browser is sent
//
//  Built from the stored counts only, so nothing here can carry a log line or
//  an address. Below operator the answer is totals: no paths, referrers,
//  404s, probe paths, WordPress details, node or container id. Days are UTC
//  days. "People" are visitors confirmed as browsers (people.ts); the
//  unconfirmed and the bots are counted apart, and HyperProx's own requests
//  are only ever a count of their own.
// =============================================================================

import type { SiteRecord } from '../sites'
import { dayStart, hourStart, percentileMs, sumAggs, emptyAgg, RULES, type Agg, type Counts } from './aggregate'
import { PROBE_KINDS, type ProbeKind } from './user-agent'
import { certDaysLeft } from './health'
import type { MetricsStore, SiteState } from './store'
import { ALERT_KINDS } from './alerts'

const HOUR = 3_600_000, DAY = 86_400_000
export type Range = '24h' | '7d' | '30d'
export const isRange = (v: unknown): v is Range => v === '24h' || v === '7d' || v === '30d'

export interface Summary {
  id: string; name: string; kind: string; adopted: boolean; domain: string | null; url: string | null
  up: boolean | null; latencyMs: number | null; checkedAt: number | null
  /** People today: visitors confirmed as browsers (people.ts). */
  visitorsToday: number; trendPct: number | null; pageViewsToday: number
  /** Visitors today who opened a page but never behaved like a browser, and distinct bots. */
  unconfirmedToday: number; botsToday: number
  /** HyperProx's own requests to the site today, left out of every other figure. */
  ownToday: number
  /** Today's row was partly counted before the accuracy fix, when anyone not a known bot was a person. */
  countedBeforeFix: boolean
  /** Bots and scanners bursting in the last hour (shown, never announced). */
  scannerBurst: { since: number; detail: string } | null
  /** People per hour, the last 24 hours, oldest first. */
  spark: number[]
  errorRatePct: number | null; p95Ms: number | null; certDays: number | null
  alerts: Array<{ kind: string; since: number; detail: string }>
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null)

function alertsOf(st: SiteState | null) {
  if (!st) return []
  return ALERT_KINDS.filter(k => st.alertState[k]).map(k => ({ kind: k, since: st.alertState[k].since, detail: st.alertState[k].detail }))
}

export async function summary(site: SiteRecord, st: SiteState | null, store: MetricsStore, now: Date): Promise<Summary> {
  const cur = hourStart(now).getTime()
  const today = dayStart(now).getTime()
  const rows = await store.hours(site.id, new Date(today - DAY), new Date(cur + HOUR))
  const byHour = new Map(rows.map(r => [r.at.getTime(), r.agg]))
  const spark: number[] = []
  for (let t = cur - 23 * HOUR; t <= cur; t += HOUR) spark.push(byHour.get(t)?.visitors ?? 0)
  const dayRow = (await store.days(site.id, new Date(today), new Date(today + DAY)))[0]?.agg ?? emptyAgg()
  // Trend: people per hour so far today against the same hours yesterday, only when both were counted the same way.
  const elapsed = Math.floor((cur - today) / HOUR) + 1
  let a = 0, b = 0, mixed = false
  for (let i = 0; i < elapsed; i++) {
    const x = byHour.get(today + i * HOUR), y = byHour.get(today - DAY + i * HOUR)
    a += x?.visitors ?? 0; b += y?.visitors ?? 0
    if ((x && (x.rules ?? 1) < RULES) || (y && (y.rules ?? 1) < RULES)) mixed = true
  }
  const h = st?.health
  return {
    id: site.id, name: site.name, kind: st?.kind ?? 'other', adopted: Boolean(st?.adopted), domain: site.domain ?? null, url: site.url ?? site.localUrl ?? null,
    up: h?.lastOk ?? null, latencyMs: h?.lastLatencyMs ?? null, checkedAt: h?.lastCheckAt ?? null,
    visitorsToday: dayRow.visitors, trendPct: b && !mixed ? Math.round(((a - b) / b) * 100) : null, pageViewsToday: dayRow.pageViews,
    unconfirmedToday: dayRow.unconfirmed ?? 0, botsToday: dayRow.botVisitors ?? 0, ownToday: dayRow.own ?? 0,
    countedBeforeFix: (dayRow.rules ?? 1) < RULES && dayRow.requests > 0, scannerBurst: st?.scannerBurst ?? null,
    spark, errorRatePct: pct(dayRow.s5xx, dayRow.requests), p95Ms: percentileMs(dayRow.rtHist, 0.95),
    certDays: h ? certDaysLeft(h, now.getTime()) : null, alerts: alertsOf(st),
  }
}

export interface Security {
  total: number
  kinds: Array<{ kind: ProbeKind; requests: number; refused: number; answered: number; moved: number; errors: number }>
  /** Probe paths answered 2xx with something other than the home page: a possible exposure. */
  exposedCount: number
  exposed?: Array<{ key: string; value: number }>
  /** Probe paths answered 2xx with the home page (a catch-all): nothing given away. */
  catchAllCount: number
  catchAll?: Array<{ key: string; value: number }>
}

function security(sum: Agg, full: boolean): Security {
  const p = sum.probes ?? {}
  const kinds = PROBE_KINDS.map(kind => ({ kind, requests: p[kind] ?? 0, refused: p[`${kind}:refused`] ?? 0, answered: p[`${kind}:ok`] ?? 0,
    moved: p[`${kind}:moved`] ?? 0, errors: p[`${kind}:error`] ?? 0 })).filter(k => k.requests > 0)
  const count = (c: Counts) => Object.values(c ?? {}).reduce((x, v) => x + v, 0)
  const out: Security = { total: kinds.reduce((x, k) => x + k.requests, 0), kinds, exposedCount: count(sum.exposed), catchAllCount: count(sum.catchAll) }
  if (full) { out.exposed = top(sum.exposed ?? {}, 20); out.catchAll = top(sum.catchAll ?? {}, 10) }
  return out
}

const top = (c: Counts, n = 10) => Object.entries(c).sort((x, y) => y[1] - x[1]).slice(0, n).map(([key, value]) => ({ key, value }))
const share = (c: Counts) => {
  const total = Object.values(c).reduce((s, v) => s + v, 0)
  return top(c, 8).map(r => ({ ...r, pct: total ? Math.round((r.value / total) * 1000) / 10 : 0 }))
}

export interface Detail {
  summary: Summary
  range: Range
  hud: {
    /** People (confirmed), unconfirmed visitors and bots, each hour's (24 h) or day's distinct count added up. */
    visitors: number; unconfirmed: number; botVisitors: number
    pageViews: number; unconfirmedPageViews: number; requests: number; errorRatePct: number | null; p95Ms: number | null; p50Ms: number | null
    bytes: number; uptimePct: number | null; hasRequestTime: boolean
    /** HyperProx's own requests in the range, counted nowhere else. */
    own: number
    /** Rows in the range counted before the accuracy fix: their people include scripts that were not browsers. */
    beforeFix: number
  }
  /** Requests per hour or day: people, bots, the rest (unconfirmed); `before` marks a row counted before the accuracy fix. */
  series: Array<{ at: number; people: number; bots: number; unconfirmed: number; visitors: number; before: boolean }>
  /** Scanner probes in the range, by kind, and whether any was answered. Paths only for operator and up. */
  security: Security
  status: { s2xx: number; s3xx: number; s4xx: number; s5xx: number }
  devices: Array<{ key: string; value: number; pct: number }>
  browsers: Array<{ key: string; value: number; pct: number }>
  os: Array<{ key: string; value: number; pct: number }>
  /** operator+ only from here on. */
  pages?: Array<{ key: string; value: number }>
  referrers?: Array<{ key: string; value: number }>
  notFound?: Array<{ key: string; value: number }>
  where?: { vmid: number; node: string }
  collector?: { logPath: string; format: string | null; lastReadAt: number | null; lastError: string | null; gaps: number; malformed: number }
  wordpress?: SiteState['wordpress']
  alertSettings?: SiteState['alerts']
  health: { up: boolean | null; status: number | null; latencyMs: number | null; problem: string | null; certDays: number | null; certIssuer: string | null; certError: string | null }
}

const point = (at: number, a: Agg | undefined) => ({
  at, people: a?.human ?? 0, bots: a?.bots ?? 0, unconfirmed: a?.unconfirmedReq ?? 0, visitors: a?.visitors ?? 0,
  before: Boolean(a && (a.rules ?? 1) < RULES && a.requests > 0),
})

export async function detail(site: SiteRecord, st: SiteState | null, store: MetricsStore, now: Date, range: Range, full: boolean): Promise<Detail> {
  const s = await summary(site, st, store, now)
  const cur = hourStart(now).getTime(), today = dayStart(now).getTime()
  let rows: Array<{ at: Date; agg: Agg }>
  const series: Detail['series'] = []
  if (range === '24h') {
    rows = await store.hours(site.id, new Date(cur - 23 * HOUR), new Date(cur + HOUR))
    const m = new Map(rows.map(r => [r.at.getTime(), r.agg]))
    for (let t = cur - 23 * HOUR; t <= cur; t += HOUR) series.push(point(t, m.get(t)))
  } else {
    const n = range === '7d' ? 7 : 30
    rows = await store.days(site.id, new Date(today - (n - 1) * DAY), new Date(today + DAY))
    const m = new Map(rows.map(r => [r.at.getTime(), r.agg]))
    for (let t = today - (n - 1) * DAY; t <= today; t += DAY) series.push(point(t, m.get(t)))
  }
  const sum = sumAggs(rows.map(r => r.agg))
  // People in a range: each hour's (24 h) or each day's distinct count added up.
  const add = (k: 'visitors' | 'unconfirmed' | 'botVisitors') => rows.reduce((x, r) => x + (r.agg[k] ?? 0), 0)
  const h = st?.health
  const d: Detail = {
    summary: s, range,
    hud: {
      visitors: add('visitors'), unconfirmed: add('unconfirmed'), botVisitors: add('botVisitors'),
      pageViews: sum.pageViews, unconfirmedPageViews: sum.unconfirmedPageViews ?? 0, requests: sum.requests, errorRatePct: pct(sum.s5xx, sum.requests),
      p95Ms: percentileMs(sum.rtHist, 0.95), p50Ms: percentileMs(sum.rtHist, 0.5), bytes: sum.bytes,
      uptimePct: pct(sum.checksOk, sum.checks), hasRequestTime: sum.timed > 0,
      own: sum.own ?? 0, beforeFix: rows.filter(r => (r.agg.rules ?? 1) < RULES && r.agg.requests > 0).length,
    },
    series, status: { s2xx: sum.s2xx, s3xx: sum.s3xx, s4xx: sum.s4xx, s5xx: sum.s5xx }, security: security(sum, full),
    devices: share(sum.devices), browsers: share(sum.browsers), os: share(sum.os),
    health: { up: h?.lastOk ?? null, status: h?.lastStatus ?? null, latencyMs: h?.lastLatencyMs ?? null, problem: h?.lastProblem ?? null,
      certDays: h ? certDaysLeft(h, now.getTime()) : null, certIssuer: h?.cert?.issuer ?? null, certError: h?.cert?.error ?? null },
  }
  if (full) {
    d.pages = top(sum.pages); d.referrers = top(sum.referrers); d.notFound = top(sum.notFound)
    d.where = { vmid: site.vmid, node: site.node }
    if (st) {
      d.collector = { logPath: st.logPath, format: st.format, lastReadAt: st.lastReadAt, lastError: st.lastError, gaps: st.gaps, malformed: st.malformed }
      d.wordpress = st.kind === 'wordpress' ? st.wordpress : undefined
      d.alertSettings = st.alerts
    }
  }
  return d
}

// ── Prometheus ─────────────────────────────────────────────────────────────

const label = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')

/** Gauges for the bundled Prometheus, labelled by site name only. Appended to /api/plugins/metrics. */
export function exposition(rows: Array<{ name: string; s: Summary; today: Agg }>): string {
  const out: string[] = []
  const g = (name: string, help: string) => out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`)
  g('hyperprox_site_up', 'The site answered its last public check (1) or not (0).')
  for (const r of rows) if (r.s.up !== null) out.push(`hyperprox_site_up{site="${label(r.name)}"} ${r.s.up ? 1 : 0}`)
  g('hyperprox_site_check_latency_seconds', 'How long the last public check took.')
  for (const r of rows) if (r.s.latencyMs !== null) out.push(`hyperprox_site_check_latency_seconds{site="${label(r.name)}"} ${(r.s.latencyMs / 1000).toFixed(3)}`)
  g('hyperprox_site_visitors_total', 'People today (UTC day): visitors that behaved like a browser, counted once each from the day\'s salted hashes.')
  for (const r of rows) out.push(`hyperprox_site_visitors_total{site="${label(r.name)}"} ${r.today.visitors}`)
  g('hyperprox_site_unconfirmed_visitors_total', 'Visitors today (UTC day) that opened a page but never behaved like a browser.')
  for (const r of rows) out.push(`hyperprox_site_unconfirmed_visitors_total{site="${label(r.name)}"} ${r.today.unconfirmed ?? 0}`)
  g('hyperprox_site_probe_requests_total', 'Scanner probes today (UTC day): requests for secrets, admin panels, PHP or APIs the site does not have.')
  for (const r of rows) out.push(`hyperprox_site_probe_requests_total{site="${label(r.name)}"} ${Object.entries(r.today.probes ?? {}).filter(([k]) => !k.includes(':')).reduce((x, [, v]) => x + v, 0)}`)
  g('hyperprox_site_probe_answered_total', 'Scanner probes today (UTC day) the site answered 2xx with something other than its home page.')
  for (const r of rows) out.push(`hyperprox_site_probe_answered_total{site="${label(r.name)}"} ${Object.values(r.today.exposed ?? {}).reduce((x, v) => x + v, 0)}`)
  g('hyperprox_site_page_views_total', 'Page views by people today (UTC day).')
  for (const r of rows) out.push(`hyperprox_site_page_views_total{site="${label(r.name)}"} ${r.today.pageViews}`)
  g('hyperprox_site_requests_total', 'Requests today (UTC day) by status class.')
  for (const r of rows) for (const c of ['2xx', '3xx', '4xx', '5xx'] as const) out.push(`hyperprox_site_requests_total{site="${label(r.name)}",class="${c}"} ${r.today[`s${c}` as 's2xx']}`)
  g('hyperprox_site_bot_requests_total', 'Requests from bots today (UTC day).')
  for (const r of rows) out.push(`hyperprox_site_bot_requests_total{site="${label(r.name)}"} ${r.today.bots}`)
  g('hyperprox_site_p95_seconds', '95th percentile request time today, from $request_time.')
  for (const r of rows) if (r.s.p95Ms !== null) out.push(`hyperprox_site_p95_seconds{site="${label(r.name)}"} ${(r.s.p95Ms / 1000).toFixed(3)}`)
  g('hyperprox_site_cert_days_left', 'Days until the public certificate expires.')
  for (const r of rows) if (r.s.certDays !== null) out.push(`hyperprox_site_cert_days_left{site="${label(r.name)}"} ${r.s.certDays}`)
  return out.join('\n') + '\n'
}
