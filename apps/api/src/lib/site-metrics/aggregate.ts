// =============================================================================
//  HyperProx — site metrics: turning log lines into hourly counts
//
//  An Agg is one hour (or one day) of one site: plain counters, a histogram of
//  request times and a few small top lists. Two Aggs for the same hour merge
//  by adding, so a pull that ends halfway through an hour and the next one
//  that finishes it give the same row as one pull would have.
//
//  What an Agg never holds: an address, a full User-Agent, a query string, or
//  a referrer beyond its host name.
// =============================================================================

import type { LogLine } from './log-parser'
import { classifyUa, isProbePath, type Device } from './user-agent'

/** Request-time histogram upper bounds, in seconds; the last bucket is everything slower. */
export const RT_BOUNDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
/** Entries kept in each top list of an hour; a day keeps more. */
export const TOP_HOUR = 50
export const TOP_DAY = 200

export type Counts = Record<string, number>

export interface Agg {
  requests: number
  /** Requests from people. */
  human: number
  bots: number
  /** Page views by people: a successful GET of a page, not an asset. */
  pageViews: number
  botPageViews: number
  /** Distinct people in the hour (or day), from the day's visitor hashes. */
  visitors: number
  s2xx: number; s3xx: number; s4xx: number; s5xx: number
  bytes: number
  /** Lines that carried $request_time. */
  timed: number
  rtHist: number[]
  pages: Counts
  referrers: Counts
  /** 404s requested by people (scanners' probes are not "broken links"). */
  notFound: Counts
  browsers: Counts
  os: Counts
  devices: Counts
  /** Public health checks made, how many passed, and their summed latency. */
  checks: number
  checksOk: number
  latencyMs: number
}

export const emptyAgg = (): Agg => ({
  requests: 0, human: 0, bots: 0, pageViews: 0, botPageViews: 0, visitors: 0,
  s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, bytes: 0, timed: 0, rtHist: RT_BOUNDS.map(() => 0).concat(0),
  pages: {}, referrers: {}, notFound: {}, browsers: {}, os: {}, devices: {},
  checks: 0, checksOk: 0, latencyMs: 0,
})

const ASSET = /\.(css|js|mjs|map|json|xml|txt|woff2?|ttf|otf|eot|svg|png|jpe?g|gif|webp|avif|ico|bmp|mp4|webm|mp3|ogg|wav|pdf|zip|gz|tar|wasm|webmanifest)$/i
const NOT_PAGES = /^\/(wp-json|wp-admin\/admin-ajax\.php|wp-cron\.php|xmlrpc\.php|feed\/?$|robots\.txt|sitemap|favicon)/i

/** A request a person would call "opening a page". */
export function isPageView(l: Pick<LogLine, 'method' | 'status' | 'path'>): boolean {
  if (l.method !== 'GET' || l.status < 200 || l.status > 299 || !l.path) return false
  if (ASSET.test(l.path) || NOT_PAGES.test(l.path)) return false
  return true
}

/** The host a referrer names, without "www.", or null for none, a bad one, or the site itself. */
export function referrerHost(ref: string, ownHosts: string[] = []): string | null {
  if (!ref || ref === '-') return null
  let h: string
  try { h = new URL(ref).hostname.toLowerCase() } catch { return null }
  if (!h || h.length > 100) return null
  h = h.replace(/^www\./, '')
  if (ownHosts.some(o => o.toLowerCase().replace(/^www\./, '') === h)) return null
  return h
}

/** Paths as they are shown: at most 120 characters, control characters dropped. */
export function shownPath(p: string): string {
  // eslint-disable-next-line no-control-regex
  const s = p.replace(/[\u0000-\u001f\u007f]/g, '')
  return s.length > 120 ? `${s.slice(0, 119)}…` : s
}

export function bump(c: Counts, k: string, n = 1): void { c[k] = (c[k] ?? 0) + n }

/** Keep the `n` biggest entries. Ties keep the earlier key, so the result does not depend on the run. */
export function trimTop(c: Counts, n: number): Counts {
  const e = Object.entries(c).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  return Object.fromEntries(e.slice(0, n))
}

function mergeCounts(a: Counts, b: Counts, n: number): Counts {
  const out: Counts = { ...a }
  for (const [k, v] of Object.entries(b ?? {})) bump(out, k, v)
  return trimTop(out, n)
}

/** a + b, top lists trimmed to `top`. `visitors` is not added: it is recounted from the hashes. */
export function mergeAgg(a: Agg, b: Agg, top = TOP_HOUR): Agg {
  const hist = a.rtHist.map((v, i) => v + (b.rtHist[i] ?? 0))
  return {
    requests: a.requests + b.requests, human: a.human + b.human, bots: a.bots + b.bots,
    pageViews: a.pageViews + b.pageViews, botPageViews: a.botPageViews + b.botPageViews,
    visitors: Math.max(a.visitors, b.visitors),
    s2xx: a.s2xx + b.s2xx, s3xx: a.s3xx + b.s3xx, s4xx: a.s4xx + b.s4xx, s5xx: a.s5xx + b.s5xx,
    bytes: a.bytes + b.bytes, timed: a.timed + b.timed, rtHist: hist,
    pages: mergeCounts(a.pages, b.pages, top), referrers: mergeCounts(a.referrers, b.referrers, top),
    notFound: mergeCounts(a.notFound, b.notFound, top), browsers: mergeCounts(a.browsers, b.browsers, top),
    os: mergeCounts(a.os, b.os, top), devices: mergeCounts(a.devices, b.devices, top),
    checks: a.checks + b.checks, checksOk: a.checksOk + b.checksOk, latencyMs: a.latencyMs + b.latencyMs,
  }
}

export function rtBucket(seconds: number): number {
  const i = RT_BOUNDS.findIndex(b => seconds <= b)
  return i === -1 ? RT_BOUNDS.length : i
}

/** The p-th percentile (0..1) of a histogram, in milliseconds, interpolated inside its bucket; null when empty. */
export function percentileMs(hist: number[], p: number): number | null {
  const total = hist.reduce((s, v) => s + v, 0)
  if (!total) return null
  const want = p * total
  let seen = 0
  for (let i = 0; i < hist.length; i++) {
    if (hist[i] === 0) continue
    if (seen + hist[i] >= want) {
      const lo = i === 0 ? 0 : RT_BOUNDS[i - 1]
      const hi = i < RT_BOUNDS.length ? RT_BOUNDS[i] : RT_BOUNDS[RT_BOUNDS.length - 1] * 2
      const f = (want - seen) / hist[i]
      return Math.round((lo + (hi - lo) * f) * 1000)
    }
    seen += hist[i]
  }
  return Math.round(RT_BOUNDS[RT_BOUNDS.length - 1] * 1000)
}

export const hourStart = (d: Date): Date => new Date(Math.floor(d.getTime() / 3_600_000) * 3_600_000)
export const dayStart = (d: Date): Date => new Date(Math.floor(d.getTime() / 86_400_000) * 86_400_000)
/** "2026-11-11", the UTC day the salt belongs to. */
export const dayKey = (d: Date): string => dayStart(d).toISOString().slice(0, 10)

export interface BatchOptions {
  /** The site's own names, so a click from one of its pages is not a "referrer". */
  ownHosts?: string[]
  /** A WordPress site asks for wp-login.php and .php pages; anything else asking for them is a scanner. */
  kind?: 'static' | 'wordpress' | 'other'
  /** The day's visitor hash for a line's client and UA, or null when that day's salt is gone. */
  visitorHash: (day: string, client: string, ua: string) => string | null
}

export interface HourBatch {
  agg: Agg
  /** Visitor hash → its class, for people only. */
  visitors: Map<string, { browser: string; os: string; device: Device }>
}

export interface BatchResult {
  hours: Map<number, HourBatch>
  malformed: number
  parsed: number
  formats: Record<string, number>
}

/**
 * Aggregate parsed lines by hour. Bots are known by User-Agent, by asking for a scanner's path, or by
 * asking for robots.txt; once a visitor is known as a bot in this batch, all its requests count as a bot's.
 */
export function aggregateLines(lines: LogLine[], o: BatchOptions): BatchResult {
  const hours = new Map<number, HourBatch>()
  const formats: Record<string, number> = {}
  const botBy = new Set<string>()
  const keyed = lines.map(l => {
    const day = dayKey(l.time)
    const ua = classifyUa(l.ua)
    const id = `${day}|${l.client}|${l.ua}`
    const wpProbe = o.kind === 'static' && /\.php$/i.test(l.path)
    if (ua.bot || isProbePath(l.path) || wpProbe || l.path === '/robots.txt' || !l.method) botBy.add(id)
    return { l, day, ua, id }
  })
  for (const { l, day, ua, id } of keyed) {
    bump(formats, l.format)
    const h = hourStart(l.time).getTime()
    let hb = hours.get(h)
    if (!hb) { hb = { agg: emptyAgg(), visitors: new Map() }; hours.set(h, hb) }
    const a = hb.agg
    const bot = botBy.has(id)
    a.requests++
    if (bot) a.bots++; else a.human++
    const cls = Math.floor(l.status / 100)
    if (cls === 2) a.s2xx++; else if (cls === 3) a.s3xx++; else if (cls === 4) a.s4xx++; else if (cls === 5) a.s5xx++
    a.bytes += l.bytes
    if (l.requestTime !== null && Number.isFinite(l.requestTime)) { a.timed++; a.rtHist[rtBucket(l.requestTime)]++ }
    if (bot) { if (isPageView(l)) a.botPageViews++; continue }
    if (l.status === 404 && l.path) bump(a.notFound, shownPath(l.path))
    if (isPageView(l)) {
      a.pageViews++
      bump(a.pages, shownPath(l.path))
      const ref = referrerHost(l.referer, o.ownHosts)
      if (ref) bump(a.referrers, ref)
    }
    const hash = o.visitorHash(day, l.client, l.ua)
    if (hash && !hb.visitors.has(hash)) hb.visitors.set(hash, { browser: ua.browser, os: ua.os, device: ua.device })
  }
  for (const hb of hours.values()) {
    for (const k of ['pages', 'referrers', 'notFound'] as const) hb.agg[k] = trimTop(hb.agg[k], TOP_HOUR)
  }
  return { hours, malformed: 0, parsed: lines.length, formats }
}

/** Sums over rows, for a range: counters added, top lists merged and trimmed to `top`. */
export function sumAggs(rows: Agg[], top = TOP_DAY): Agg {
  return rows.reduce((acc, r) => mergeAgg(acc, r, top), emptyAgg())
}
