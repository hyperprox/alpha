// =============================================================================
//  HyperProx — site metrics: turning log lines into hourly counts
//
//  An Agg is one hour (or one day) of one site: plain counters, a histogram of
//  request times and a few small top lists. Two Aggs for the same hour merge
//  by adding, so a pull that ends halfway through an hour and the next one
//  that finishes it give the same row as one pull would have.
//
//  What an Agg never holds: an address, a full User-Agent, a query string, or
//  a referrer beyond its host name. Who counts as a person is people.ts's.
// =============================================================================

import type { LogLine } from './log-parser'
import { classifyUa, isOwnUa, probeKind } from './user-agent'
import { DERIVED_KEYS, deriveHour, mergeVisit, newVisit, pend, pushTime, settle, type VisitorHour } from './people'

/**
 * Which counting rules made a row. 2: people are confirmed by behaving like a browser (people.ts), HyperProx's own
 * requests are left out, probes are counted apart. 1: a row from before that, when every request that was not a
 * known bot counted as a person's. A row with any part counted under 1 stays 1.
 */
export const RULES = 2
/** Request-time histogram upper bounds, in seconds; the last bucket is everything slower. */
export const RT_BOUNDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
/** Entries kept in each top list of an hour; a day keeps more. */
export const TOP_HOUR = 50
export const TOP_DAY = 200

export type Counts = Record<string, number>

export interface Agg {
  /** The counting rules this row was made with (see RULES). */
  rules: number
  /** Requests, HyperProx's own left out. */
  requests: number
  /** Requests from people (visitors confirmed as browsers). */
  human: number
  /** Requests from visitors who are neither a known bot nor confirmed as a person. */
  unconfirmedReq: number
  bots: number
  /** Page views by people: a successful GET of a page, not an asset, or a 304 revisit of one. */
  pageViews: number
  /** Page views by visitors who never fetched an asset. */
  unconfirmedPageViews: number
  botPageViews: number
  /** Distinct people in the hour (or day). */
  visitors: number
  /** Distinct visitors who opened a page but never behaved like a browser. */
  unconfirmed: number
  /** Distinct bots. */
  botVisitors: number
  /** HyperProx's own requests to the site (catalogue detection, site checks), counted nowhere else. */
  own: number
  s2xx: number; s3xx: number; s4xx: number; s5xx: number
  bytes: number
  /** Lines that carried $request_time. */
  timed: number
  rtHist: number[]
  pages: Counts
  referrers: Counts
  /** Broken links: 404s requested by people. Scanners' probes are counted under `probes` instead. */
  notFound: Counts
  browsers: Counts
  os: Counts
  devices: Counts
  /** Scanner probes: "<kind>" for all, "<kind>:refused" (4xx), "<kind>:ok" (2xx), "<kind>:moved" (3xx), "<kind>:error" (5xx). */
  probes: Counts
  /** Probe paths the site answered 2xx with something other than its home page: a possible exposure. */
  exposed: Counts
  /** Probe paths answered 2xx with the home page itself (a catch-all), so nothing was given away. */
  catchAll: Counts
  /** Public health checks made, how many passed, and their summed latency. */
  checks: number
  checksOk: number
  latencyMs: number
}

export const emptyAgg = (): Agg => ({
  rules: RULES, requests: 0, human: 0, unconfirmedReq: 0, bots: 0, pageViews: 0, unconfirmedPageViews: 0, botPageViews: 0,
  visitors: 0, unconfirmed: 0, botVisitors: 0, own: 0,
  s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, bytes: 0, timed: 0, rtHist: RT_BOUNDS.map(() => 0).concat(0),
  pages: {}, referrers: {}, notFound: {}, browsers: {}, os: {}, devices: {}, probes: {}, exposed: {}, catchAll: {},
  checks: 0, checksOk: 0, latencyMs: 0,
})

const ASSET = /\.(css|js|mjs|map|json|xml|txt|woff2?|ttf|otf|eot|svg|png|jpe?g|gif|webp|avif|ico|bmp|mp4|webm|mp3|ogg|wav|pdf|zip|gz|tar|wasm|webmanifest)$/i
/** What a browser fetches to draw a page. A favicon is left out: bots fetch it too. */
const BROWSER_ASSET = /\.(css|js|mjs|woff2?|ttf|otf|eot|svg|png|jpe?g|gif|webp|avif)$/i
const NOT_PAGES = /^\/(wp-json|wp-admin\/admin-ajax\.php|wp-cron\.php|xmlrpc\.php|feed\/?$|robots\.txt|sitemap|favicon)/i

/** A request a person would call "opening a page". */
export function isPageView(l: Pick<LogLine, 'method' | 'status' | 'path'>): boolean {
  if (l.method !== 'GET' || l.status < 200 || l.status > 299 || !l.path) return false
  if (ASSET.test(l.path) || NOT_PAGES.test(l.path)) return false
  return true
}

/** A page the browser already had, checked again and answered "not modified". */
export function isRevisit(l: Pick<LogLine, 'method' | 'status' | 'path'>): boolean {
  return l.method === 'GET' && l.status === 304 && Boolean(l.path) && !ASSET.test(l.path) && !NOT_PAGES.test(l.path)
}

/** An image, stylesheet, script or font fetched (or revalidated: a 304 is a cached copy being used). */
export function isAssetLoad(l: Pick<LogLine, 'method' | 'status' | 'path'>): boolean {
  return l.method === 'GET' && ((l.status >= 200 && l.status < 300) || l.status === 304) && BROWSER_ASSET.test(l.path)
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

/** a + b, top lists trimmed to `top`. Distinct-visitor counts are not added: they are recounted from the hashes. */
export function mergeAgg(a: Agg, b: Agg, top = TOP_HOUR): Agg {
  const hist = a.rtHist.map((v, i) => v + (b.rtHist[i] ?? 0))
  const n = (k: keyof Agg) => ((a[k] as number) ?? 0) + ((b[k] as number) ?? 0)
  return {
    rules: Math.min(a.rules ?? 1, b.rules ?? 1),
    requests: n('requests'), human: n('human'), unconfirmedReq: n('unconfirmedReq'), bots: n('bots'),
    pageViews: n('pageViews'), unconfirmedPageViews: n('unconfirmedPageViews'), botPageViews: n('botPageViews'),
    visitors: Math.max(a.visitors, b.visitors), unconfirmed: Math.max(a.unconfirmed ?? 0, b.unconfirmed ?? 0),
    botVisitors: Math.max(a.botVisitors ?? 0, b.botVisitors ?? 0), own: n('own'),
    s2xx: a.s2xx + b.s2xx, s3xx: a.s3xx + b.s3xx, s4xx: a.s4xx + b.s4xx, s5xx: a.s5xx + b.s5xx,
    bytes: a.bytes + b.bytes, timed: a.timed + b.timed, rtHist: hist,
    pages: mergeCounts(a.pages, b.pages, top), referrers: mergeCounts(a.referrers, b.referrers, top),
    notFound: mergeCounts(a.notFound, b.notFound, top), browsers: mergeCounts(a.browsers, b.browsers, top),
    os: mergeCounts(a.os, b.os, top), devices: mergeCounts(a.devices, b.devices, top),
    probes: mergeCounts(a.probes ?? {}, b.probes ?? {}, top), exposed: mergeCounts(a.exposed ?? {}, b.exposed ?? {}, top),
    catchAll: mergeCounts(a.catchAll ?? {}, b.catchAll ?? {}, top),
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
  /** A WordPress site asks for wp-login.php and .php pages; a static site has no .php, /api/ or /admin. */
  kind?: 'static' | 'wordpress' | 'other'
  /** The day's visitor hash for a line's client and UA, or null when that day's salt is gone. */
  visitorHash: (day: string, client: string, ua: string) => string | null
  /** Sizes the home page was sent with in earlier reads (compressed or not), to know a catch-all answer. */
  homeSizes?: number[]
}

export interface HourBatch {
  /** The hour as this batch alone shows it: people confirmed only from these lines. */
  agg: Agg
  /** The counts that do not depend on who is a person: requests, statuses, bytes, times, probes, HyperProx's own. */
  base: Agg
  /** Each visitor's part of the hour, by hash (or, when the day's salt is gone, by a key that never leaves the batch). */
  visits: Map<string, VisitorHour>
  /** Keys in `visits` that are real hashes, which may be kept with the day's other rows. */
  hashed: Set<string>
}

export interface BatchResult {
  hours: Map<number, HourBatch>
  malformed: number
  parsed: number
  formats: Record<string, number>
  /** Sizes the home page was sent with, earlier reads' and this one's, the latest last (at most HOME_SIZES). */
  homeSizes: number[]
}

export const HOME_SIZES = 8

const probeTag = (status: number) => (status >= 500 ? 'error' : status >= 400 ? 'refused' : status >= 300 ? 'moved' : 'ok')

/**
 * Aggregate parsed lines by hour. HyperProx's own requests are only counted as such. A visitor is a bot for the
 * batch when its User-Agent says so (a known name, or a fake), or when it asks for a scanner's path or robots.txt;
 * whether the others are people is decided by people.ts, here from this batch alone (`agg`) and in the collector
 * from the whole day kept so far.
 */
export function aggregateLines(lines: LogLine[], o: BatchOptions): BatchResult {
  const hours = new Map<number, HourBatch>()
  const formats: Record<string, number> = {}
  const botBy = new Set<string>()
  // What the home page weighs, so a scanner's path answered with it (a catch-all) is not taken for an exposure.
  const homeBytes = new Set<number>(o.homeSizes ?? [])
  const keyed = lines.map(l => {
    const day = dayKey(l.time)
    const ua = classifyUa(l.ua)
    const id = `${day}|${l.client}|${l.ua}`
    const probe = probeKind(l.path, o.kind ?? 'other', l.status)
    // HyperProx never asks for secrets: something that does with HyperProx's name is not HyperProx.
    const own = isOwnUa(l.ua) && probe !== 'secrets'
    if (!own && (ua.bot || probe || l.path === '/robots.txt' || !l.method)) botBy.add(id)
    if (!own && l.path === '/' && l.method === 'GET' && l.status >= 200 && l.status < 300 && l.bytes > 0) homeBytes.add(l.bytes)
    return { l, day, ua, id, probe, own }
  })
  for (const { l, day, ua, id, probe, own } of keyed) {
    bump(formats, l.format)
    const h = hourStart(l.time).getTime()
    let hb = hours.get(h)
    if (!hb) { hb = { agg: emptyAgg(), base: emptyAgg(), visits: new Map(), hashed: new Set() }; hours.set(h, hb) }
    const a = hb.base
    if (own) { a.own++; continue }
    a.requests++
    const cls = Math.floor(l.status / 100)
    if (cls === 2) a.s2xx++; else if (cls === 3) a.s3xx++; else if (cls === 4) a.s4xx++; else if (cls === 5) a.s5xx++
    a.bytes += l.bytes
    if (l.requestTime !== null && Number.isFinite(l.requestTime)) { a.timed++; a.rtHist[rtBucket(l.requestTime)]++ }
    if (probe) {
      bump(a.probes, probe); bump(a.probes, `${probe}:${probeTag(l.status)}`)
      if (cls === 2 && l.method !== 'HEAD' && l.method !== 'OPTIONS') bump(homeBytes.has(l.bytes) ? a.catchAll : a.exposed, shownPath(l.path))
    }
    const hash = o.visitorHash(day, l.client, l.ua)
    const key = hash ?? `~${id}`
    if (hash) hb.hashed.add(key)
    let v = hb.visits.get(key)
    if (!v) { v = newVisit({ browser: ua.browser, os: ua.os, device: ua.device }); hb.visits.set(key, v) }
    v.req++
    if (botBy.has(id)) { v.bot = true; if (isPageView(l)) v.pv++; continue }
    const t = l.time.getTime()
    if (isPageView(l)) {
      v.pv++; pushTime(v.pageAt, t)
      if (v.firstPageAt === null || t < v.firstPageAt) v.firstPageAt = t
      pend(v.pend.pages, shownPath(l.path))
      const ref = referrerHost(l.referer, o.ownHosts)
      if (ref) pend(v.pend.refs, ref)
    } else if (isRevisit(l)) {
      v.rv++; pushTime(v.revisitAt, t); pend(v.pend.pages, shownPath(l.path))
    } else if (isAssetLoad(l)) pushTime(v.assetAt, t)
    if (l.status === 404 && l.path) pend(v.pend.nf, shownPath(l.path))
  }
  // This batch on its own: settle each visitor over the batch's hours of its day.
  const byVisitor = new Map<string, Map<number, VisitorHour>>()
  for (const [h, hb] of hours) for (const [k, v] of hb.visits) {
    let m = byVisitor.get(k)
    if (!m) { m = new Map(); byVisitor.set(k, m) }
    m.set(h, mergeVisit(null, v))
  }
  const listed = new Map<number, Agg>()
  for (const m of byVisitor.values()) {
    for (const [h, l] of settle(m).lists) {
      const x = listed.get(h) ?? emptyAgg()
      listed.set(h, mergeAgg(x, { ...emptyAgg(), ...l }))
    }
  }
  for (const [h, hb] of hours) {
    const rows = [...byVisitor.values()].map(m => m.get(h)).filter((r): r is VisitorHour => Boolean(r))
    hb.agg = withDerived(mergeAgg(hb.base, listed.get(h) ?? emptyAgg()), deriveHour(rows))
    for (const k of ['pages', 'referrers', 'notFound'] as const) hb.agg[k] = trimTop(hb.agg[k], TOP_HOUR)
  }
  return { hours, malformed: 0, parsed: lines.length, formats, homeSizes: [...homeBytes].slice(-HOME_SIZES) }
}

/** An Agg with its person-dependent counts replaced. */
export function withDerived(a: Agg, d: Partial<Record<(typeof DERIVED_KEYS)[number], number>>): Agg {
  const out = { ...a }
  for (const k of DERIVED_KEYS) if (d[k] !== undefined) out[k] = d[k]!
  return out
}

/** Sums over rows, for a range: counters added, top lists merged and trimmed to `top`. */
export function sumAggs(rows: Agg[], top = TOP_DAY): Agg {
  return rows.reduce((acc, r) => mergeAgg(acc, r, top), emptyAgg())
}
