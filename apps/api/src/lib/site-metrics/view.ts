// =============================================================================
//  HyperProx — site metrics: what the browser is sent
//
//  Built from the stored counts only, so nothing here can carry a log line or
//  an address. Below operator the answer is totals: no paths, referrers,
//  404s, WordPress details, node or container id. Days are UTC days.
// =============================================================================

import type { SiteRecord } from '../sites'
import { dayStart, hourStart, percentileMs, sumAggs, emptyAgg, type Agg, type Counts } from './aggregate'
import { certDaysLeft } from './health'
import type { MetricsStore, SiteState } from './store'
import { ALERT_KINDS } from './alerts'

const HOUR = 3_600_000, DAY = 86_400_000
export type Range = '24h' | '7d' | '30d'
export const isRange = (v: unknown): v is Range => v === '24h' || v === '7d' || v === '30d'

export interface Summary {
  id: string; name: string; kind: string; adopted: boolean; domain: string | null; url: string | null
  up: boolean | null; latencyMs: number | null; checkedAt: number | null
  visitorsToday: number; trendPct: number | null; pageViewsToday: number
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
  // Trend: people per hour so far today against the same hours yesterday.
  const elapsed = Math.floor((cur - today) / HOUR) + 1
  let a = 0, b = 0
  for (let i = 0; i < elapsed; i++) { a += byHour.get(today + i * HOUR)?.visitors ?? 0; b += byHour.get(today - DAY + i * HOUR)?.visitors ?? 0 }
  const h = st?.health
  return {
    id: site.id, name: site.name, kind: st?.kind ?? 'other', adopted: Boolean(st?.adopted), domain: site.domain ?? null, url: site.url ?? site.localUrl ?? null,
    up: h?.lastOk ?? null, latencyMs: h?.lastLatencyMs ?? null, checkedAt: h?.lastCheckAt ?? null,
    visitorsToday: dayRow.visitors, trendPct: b ? Math.round(((a - b) / b) * 100) : null, pageViewsToday: dayRow.pageViews,
    spark, errorRatePct: pct(dayRow.s5xx, dayRow.requests), p95Ms: percentileMs(dayRow.rtHist, 0.95),
    certDays: h ? certDaysLeft(h, now.getTime()) : null, alerts: alertsOf(st),
  }
}

const top = (c: Counts, n = 10) => Object.entries(c).sort((x, y) => y[1] - x[1]).slice(0, n).map(([key, value]) => ({ key, value }))
const share = (c: Counts) => {
  const total = Object.values(c).reduce((s, v) => s + v, 0)
  return top(c, 8).map(r => ({ ...r, pct: total ? Math.round((r.value / total) * 1000) / 10 : 0 }))
}

export interface Detail {
  summary: Summary
  range: Range
  hud: { visitors: number; pageViews: number; requests: number; errorRatePct: number | null; p95Ms: number | null; p50Ms: number | null; bytes: number; uptimePct: number | null; hasRequestTime: boolean }
  series: Array<{ at: number; people: number; bots: number; visitors: number }>
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

export async function detail(site: SiteRecord, st: SiteState | null, store: MetricsStore, now: Date, range: Range, full: boolean): Promise<Detail> {
  const s = await summary(site, st, store, now)
  const cur = hourStart(now).getTime(), today = dayStart(now).getTime()
  let rows: Array<{ at: Date; agg: Agg }>
  const series: Detail['series'] = []
  if (range === '24h') {
    rows = await store.hours(site.id, new Date(cur - 23 * HOUR), new Date(cur + HOUR))
    const m = new Map(rows.map(r => [r.at.getTime(), r.agg]))
    for (let t = cur - 23 * HOUR; t <= cur; t += HOUR) { const a = m.get(t); series.push({ at: t, people: a?.human ?? 0, bots: a?.bots ?? 0, visitors: a?.visitors ?? 0 }) }
  } else {
    const n = range === '7d' ? 7 : 30
    rows = await store.days(site.id, new Date(today - (n - 1) * DAY), new Date(today + DAY))
    const m = new Map(rows.map(r => [r.at.getTime(), r.agg]))
    for (let t = today - (n - 1) * DAY; t <= today; t += DAY) { const a = m.get(t); series.push({ at: t, people: a?.human ?? 0, bots: a?.bots ?? 0, visitors: a?.visitors ?? 0 }) }
  }
  const sum = sumAggs(rows.map(r => r.agg))
  // People in a range: each hour's (24 h) or each day's distinct count added up.
  const visitors = rows.reduce((x, r) => x + r.agg.visitors, 0)
  const h = st?.health
  const d: Detail = {
    summary: s, range,
    hud: {
      visitors, pageViews: sum.pageViews, requests: sum.requests, errorRatePct: pct(sum.s5xx, sum.requests),
      p95Ms: percentileMs(sum.rtHist, 0.95), p50Ms: percentileMs(sum.rtHist, 0.5), bytes: sum.bytes,
      uptimePct: pct(sum.checksOk, sum.checks), hasRequestTime: sum.timed > 0,
    },
    series, status: { s2xx: sum.s2xx, s3xx: sum.s3xx, s4xx: sum.s4xx, s5xx: sum.s5xx },
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
  g('hyperprox_site_visitors_total', 'People today (UTC day), counted once each from the day\'s salted hashes.')
  for (const r of rows) out.push(`hyperprox_site_visitors_total{site="${label(r.name)}"} ${r.today.visitors}`)
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
