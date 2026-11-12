// =============================================================================
//  HyperProx — site metrics: where the numbers live
//
//  Postgres in production (SiteMetricHour, SiteMetricDay, SiteVisitor,
//  SiteMetricSalt, SiteMetricState), memory in tests. Retention:
//    hourly rows   30 days
//    daily rows    13 months (400 days)
//    visitor hashes, with each one's hour of counts (people.ts),
//    and day salts                    2 days (today and yesterday), then deleted
// =============================================================================

import type { PrismaClient } from '@prisma/client'
import { emptyAgg, mergeAgg, withDerived, TOP_DAY, TOP_HOUR, type Agg } from './aggregate'
import { asVisit, deriveDayVisitors, deriveHour, DERIVED_KEYS, type VisitorHour } from './people'
import type { WpInfo } from './wordpress'
import { SALT_KEEP_DAYS } from './visitors'

export const HOUR_KEEP_DAYS = 30
export const DAY_KEEP_DAYS = 400

export type SiteKind = 'static' | 'wordpress' | 'other'

export interface AlertConfig {
  enabled: boolean
  /** Fire when 5xx responses are above this share of requests in the last hour (percent). */
  errorRatePct: number
  /** Fire when the public address failed this many checks in a row (0: never). */
  downChecks: number
  /** Fire when the certificate has fewer days left than this. */
  certDays: number
  /** Fire when the last hour had this many times the usual hourly traffic (0: never). */
  spikeFactor: number
}

export const DEFAULT_ALERTS: AlertConfig = { enabled: true, errorRatePct: 5, downChecks: 2, certDays: 14, spikeFactor: 10 }

export interface HealthState {
  lastCheckAt: number | null
  lastOk: boolean | null
  lastStatus: number | null
  lastLatencyMs: number | null
  lastProblem: string | null
  failsInRow: number
  url: string | null
  cert: { checkedAt: number; notAfter: number | null; issuer: string | null; trusted: boolean | null; error: string | null } | null
}

export const emptyHealth = (): HealthState => ({ lastCheckAt: null, lastOk: null, lastStatus: null, lastLatencyMs: null, lastProblem: null, failsInRow: 0, url: null, cert: null })

export interface SiteState {
  siteId: string
  logPath: string
  errorLog: string
  wpPath: string | null
  /** LiteSpeed's lsphp for WP-CLI, when the container has no php on the PATH. */
  phpBin?: string | null
  kind: SiteKind
  adopted: boolean
  enabled: boolean
  inode: string
  offset: number
  format: string | null
  lastReadAt: number | null
  lastError: string | null
  /** How many times a rotation lost lines HyperProx had not read. */
  gaps: number
  malformed: number
  /** The last lines read all came from a private proxy with no visitor address: unique visitors are approximate. */
  visitorsApproximate?: boolean
  health: HealthState
  alerts: AlertConfig
  alertState: Record<string, { since: number; detail: string }>
  /** Bots and scanners bursting in the last hour: shown on the Metrics tab, never announced. */
  scannerBurst: { since: number; detail: string } | null
  /** Sizes the home page was sent with lately: a scanner's path answered with the same is a catch-all, not a leak. */
  homeSizes: number[]
  wordpress: WpInfo | null
}

export interface MetricsStore {
  getState(siteId: string): Promise<SiteState | null>
  putState(s: SiteState): Promise<void>
  listStates(): Promise<SiteState[]>
  /** Add to an hour and its day. */
  merge(siteId: string, hour: Date, agg: Agg): Promise<void>
  /** Visitor rows kept for hours in [from, to), only for `hashes` when given. A row from before the browser check has data null. */
  visitorRows(siteId: string, from: Date, to: Date, hashes?: string[]): Promise<Array<{ hour: Date; hash: string; data: VisitorHour | null }>>
  /** Write visitor rows (insert or replace). */
  putVisitorRows(siteId: string, rows: Array<{ hour: Date; hash: string; data: VisitorHour }>): Promise<void>
  /** Recount an hour's people, unconfirmed visitors and bots from its visitor rows, then its day's. */
  recountVisitors(siteId: string, hour: Date): Promise<void>
  hours(siteId: string, from: Date, to: Date): Promise<Array<{ at: Date; agg: Agg }>>
  days(siteId: string, from: Date, to: Date): Promise<Array<{ at: Date; agg: Agg }>>
  /** The salt for a UTC day ("YYYY-MM-DD"), made when `create` and none exists. */
  salt(day: string, create: () => string | null): Promise<string | null>
  prune(now: Date): Promise<{ hours: number; days: number; visitors: number; salts: number }>
  deleteSite(siteId: string): Promise<void>
}

const DAY = 86_400_000
const dayOf = (d: Date) => new Date(Math.floor(d.getTime() / DAY) * DAY)

// ── memory ─────────────────────────────────────────────────────────────────

export class MemoryMetricsStore implements MetricsStore {
  states = new Map<string, SiteState>()
  hourRows = new Map<string, Agg>()
  dayRows = new Map<string, Agg>()
  visitorMap = new Map<string, Map<string, VisitorHour | null>>()   // site|hourMs -> hash -> data
  salts = new Map<string, string>()
  private k = (s: string, d: Date) => `${s}|${d.getTime()}`

  async getState(id: string) { const s = this.states.get(id); return s ? structuredClone(s) : null }
  async putState(s: SiteState) { this.states.set(s.siteId, structuredClone(s)) }
  async listStates() { return [...this.states.values()].map(s => structuredClone(s)) }
  async merge(siteId: string, hour: Date, agg: Agg) {
    const hk = this.k(siteId, hour), dk = this.k(siteId, dayOf(hour))
    this.hourRows.set(hk, mergeAgg(this.hourRows.get(hk) ?? emptyAgg(), agg, TOP_HOUR))
    this.dayRows.set(dk, mergeAgg(this.dayRows.get(dk) ?? emptyAgg(), agg, TOP_DAY))
  }
  async visitorRows(siteId: string, from: Date, to: Date, hashes?: string[]) {
    const want = hashes ? new Set(hashes) : null
    const out: Array<{ hour: Date; hash: string; data: VisitorHour | null }> = []
    for (const [k, m] of this.visitorMap) {
      const [s, t] = k.split('|')
      if (s !== siteId || Number(t) < from.getTime() || Number(t) >= to.getTime()) continue
      for (const [hash, data] of m) if (!want || want.has(hash)) out.push({ hour: new Date(Number(t)), hash, data: data ? structuredClone(data) : null })
    }
    return out
  }
  async putVisitorRows(siteId: string, rows: Array<{ hour: Date; hash: string; data: VisitorHour }>) {
    for (const r of rows) {
      const k = this.k(siteId, r.hour)
      const m = this.visitorMap.get(k) ?? new Map<string, VisitorHour | null>()
      m.set(r.hash, structuredClone(r.data))
      this.visitorMap.set(k, m)
    }
  }
  async recountVisitors(siteId: string, hour: Date) {
    const hk = this.k(siteId, hour)
    const h = this.hourRows.get(hk)
    const rows = [...(this.visitorMap.get(hk)?.values() ?? [])].filter((r): r is VisitorHour => Boolean(r))
    if (h) this.hourRows.set(hk, withDerived(h, deriveHour(rows)))
    const day = dayOf(hour)
    const d = this.dayRows.get(this.k(siteId, day))
    if (!d) return
    const sums: Record<string, number> = {}
    for (const r of await this.hours(siteId, day, new Date(day.getTime() + DAY))) for (const k of DERIVED_KEYS) sums[k] = (sums[k] ?? 0) + r.agg[k]
    const byHash = new Map<string, VisitorHour[]>()
    for (const r of await this.visitorRows(siteId, day, new Date(day.getTime() + DAY))) if (r.data) byHash.set(r.hash, [...(byHash.get(r.hash) ?? []), r.data])
    this.dayRows.set(this.k(siteId, day), withDerived(d, { ...sums, ...deriveDayVisitors(byHash.values()) }))
  }
  private range(rows: Map<string, Agg>, siteId: string, from: Date, to: Date) {
    const out: Array<{ at: Date; agg: Agg }> = []
    for (const [k, v] of rows) {
      const [s, t] = k.split('|')
      if (s === siteId && Number(t) >= from.getTime() && Number(t) < to.getTime()) out.push({ at: new Date(Number(t)), agg: structuredClone(v) })
    }
    return out.sort((a, b) => a.at.getTime() - b.at.getTime())
  }
  async hours(siteId: string, from: Date, to: Date) { return this.range(this.hourRows, siteId, from, to) }
  async days(siteId: string, from: Date, to: Date) { return this.range(this.dayRows, siteId, from, to) }
  async salt(day: string, create: () => string | null) {
    const s = this.salts.get(day)
    if (s) return s
    const n = create()
    if (n) this.salts.set(day, n)
    return n
  }
  async prune(now: Date) {
    const r = { hours: 0, days: 0, visitors: 0, salts: 0 }
    const hCut = now.getTime() - HOUR_KEEP_DAYS * DAY, dCut = now.getTime() - DAY_KEEP_DAYS * DAY
    const vCut = dayOf(now).getTime() - (SALT_KEEP_DAYS - 1) * DAY
    for (const k of [...this.hourRows.keys()]) if (Number(k.split('|')[1]) < hCut) { this.hourRows.delete(k); r.hours++ }
    for (const k of [...this.dayRows.keys()]) if (Number(k.split('|')[1]) < dCut) { this.dayRows.delete(k); r.days++ }
    for (const k of [...this.visitorMap.keys()]) if (Number(k.split('|')[1]) < vCut) { r.visitors += this.visitorMap.get(k)!.size; this.visitorMap.delete(k) }
    for (const k of [...this.salts.keys()]) if (Date.parse(`${k}T00:00:00Z`) < vCut) { this.salts.delete(k); r.salts++ }
    return r
  }
  async deleteSite(siteId: string) {
    this.states.delete(siteId)
    for (const m of [this.hourRows, this.dayRows, this.visitorMap] as Array<Map<string, unknown>>) for (const k of [...m.keys()]) if (k.startsWith(`${siteId}|`)) m.delete(k)
  }
}

// ── Postgres ───────────────────────────────────────────────────────────────

const COUNTERS = ['requests', 'human', 'unconfirmedReq', 'bots', 'pageViews', 'unconfirmedPageViews', 'botPageViews', 'visitors', 'unconfirmed',
  'botVisitors', 'own', 's2xx', 's3xx', 's4xx', 's5xx', 'timed', 'checks', 'checksOk', 'latencyMs'] as const
const MAPS = ['pages', 'referrers', 'notFound', 'browsers', 'os', 'devices', 'probes', 'exposed', 'catchAll'] as const

function rowToAgg(r: any): Agg {
  const a = emptyAgg()
  for (const k of COUNTERS) a[k] = Number(r[k] ?? 0)
  // A row written before the column existed is 1: counted under the old rules.
  a.rules = Number(r.rules ?? 1)
  a.bytes = Number(r.bytes ?? 0)
  a.rtHist = Array.isArray(r.rtHist) && r.rtHist.length === a.rtHist.length ? r.rtHist.map(Number) : a.rtHist
  for (const k of MAPS) a[k] = r[k] && typeof r[k] === 'object' ? r[k] : {}
  return a
}
function aggToRow(a: Agg): Record<string, unknown> {
  const r: Record<string, unknown> = {}
  for (const k of COUNTERS) r[k] = Math.round(a[k])
  r.rules = a.rules
  r.bytes = BigInt(Math.round(a.bytes))
  r.rtHist = a.rtHist
  for (const k of MAPS) r[k] = a[k]
  return r
}

function stateFromRow(r: any): SiteState {
  const d = (r.data ?? {}) as Partial<SiteState>
  return {
    siteId: r.siteId, logPath: r.logPath, kind: r.kind, adopted: r.adopted, enabled: r.enabled,
    inode: r.inode, offset: Number(r.offset),
    errorLog: d.errorLog ?? '/var/log/nginx/error.log', wpPath: d.wpPath ?? null, phpBin: d.phpBin ?? null, format: d.format ?? null,
    lastReadAt: d.lastReadAt ?? null, lastError: d.lastError ?? null, gaps: d.gaps ?? 0, malformed: d.malformed ?? 0, visitorsApproximate: d.visitorsApproximate ?? false,
    health: { ...emptyHealthFallback(), ...(d.health ?? {}) }, alerts: { ...DEFAULT_ALERTS, ...(d.alerts ?? {}) },
    alertState: d.alertState ?? {}, scannerBurst: d.scannerBurst ?? null, homeSizes: Array.isArray(d.homeSizes) ? d.homeSizes : [], wordpress: d.wordpress ?? null,
  }
}
const emptyHealthFallback = emptyHealth

export class PrismaMetricsStore implements MetricsStore {
  constructor(private db: PrismaClient) {}
  private get p(): any { return this.db as any }

  async getState(siteId: string) {
    const r = await this.p.siteMetricState.findUnique({ where: { siteId } })
    return r ? stateFromRow(r) : null
  }
  async putState(s: SiteState) {
    const { siteId, logPath, kind, adopted, enabled, inode, offset, ...rest } = s
    const v = { logPath, kind, adopted, enabled, inode, offset: BigInt(offset), data: rest as any }
    await this.p.siteMetricState.upsert({ where: { siteId }, create: { siteId, ...v }, update: v })
  }
  async listStates() { return (await this.p.siteMetricState.findMany()).map(stateFromRow) }
  async merge(siteId: string, hour: Date, agg: Agg) {
    await this.db.$transaction(async (tx: any) => {
      const h = await tx.siteMetricHour.findUnique({ where: { siteId_hour: { siteId, hour } } })
      const nh = aggToRow(mergeAgg(h ? rowToAgg(h) : emptyAgg(), agg, TOP_HOUR))
      await tx.siteMetricHour.upsert({ where: { siteId_hour: { siteId, hour } }, create: { siteId, hour, ...nh }, update: nh })
      const day = dayOf(hour)
      const d = await tx.siteMetricDay.findUnique({ where: { siteId_day: { siteId, day } } })
      const nd = aggToRow(mergeAgg(d ? rowToAgg(d) : emptyAgg(), agg, TOP_DAY))
      await tx.siteMetricDay.upsert({ where: { siteId_day: { siteId, day } }, create: { siteId, day, ...nd }, update: nd })
    })
  }
  async visitorRows(siteId: string, from: Date, to: Date, hashes?: string[]) {
    const out: Array<{ hour: Date; hash: string; data: VisitorHour | null }> = []
    const chunks = hashes ? Array.from({ length: Math.ceil(hashes.length / 1000) }, (_, i) => hashes.slice(i * 1000, i * 1000 + 1000)) : [null]
    for (const c of chunks) {
      if (c && !c.length) continue
      const rows = await this.p.siteVisitor.findMany({ where: { siteId, hour: { gte: from, lt: to }, ...(c ? { hash: { in: c } } : {}) }, select: { hour: true, hash: true, data: true } })
      for (const r of rows) out.push({ hour: r.hour as Date, hash: r.hash as string, data: asVisit(r.data) })
    }
    return out
  }
  async putVisitorRows(siteId: string, rows: Array<{ hour: Date; hash: string; data: VisitorHour }>) {
    for (let i = 0; i < rows.length; i += 200) {
      await this.db.$transaction(rows.slice(i, i + 200).map(r => this.p.siteVisitor.upsert({
        where: { siteId_hour_hash: { siteId, hour: r.hour, hash: r.hash } },
        create: { siteId, hour: r.hour, hash: r.hash, data: r.data as any }, update: { data: r.data as any },
      })))
    }
  }
  async recountVisitors(siteId: string, hour: Date) {
    const rows = await this.p.siteVisitor.findMany({ where: { siteId, hour }, select: { data: true } })
    const d = deriveHour(rows.map((r: any) => asVisit(r.data)).filter((r: VisitorHour | null): r is VisitorHour => Boolean(r)))
    await this.p.siteMetricHour.updateMany({ where: { siteId, hour }, data: d })
    const day = dayOf(hour), next = new Date(day.getTime() + DAY)
    const sums: Array<Record<string, bigint | number | null>> = await this.db.$queryRaw`
      SELECT SUM("human") AS "human", SUM("unconfirmedReq") AS "unconfirmedReq", SUM("bots") AS "bots", SUM("pageViews") AS "pageViews",
             SUM("unconfirmedPageViews") AS "unconfirmedPageViews", SUM("botPageViews") AS "botPageViews"
      FROM "SiteMetricHour" WHERE "siteId" = ${siteId} AND "hour" >= ${day} AND "hour" < ${next}`
    // Distinct over the day: a person in any hour is a person; else unconfirmed if they opened a page; else a bot.
    const distinct: Array<Record<string, bigint | number | null>> = await this.db.$queryRaw`
      SELECT COUNT(*) FILTER (WHERE p) AS "visitors", COUNT(*) FILTER (WHERE NOT p AND u) AS "unconfirmed",
             COUNT(*) FILTER (WHERE NOT p AND NOT u AND b) AS "botVisitors"
      FROM (SELECT "hash",
              bool_or(COALESCE(("data"->>'person')::boolean, false)) AS p,
              bool_or(NOT COALESCE(("data"->>'bot')::boolean, false) AND COALESCE(("data"->>'pv')::int, 0) + COALESCE(("data"->>'rv')::int, 0) > 0) AS u,
              bool_or(COALESCE(("data"->>'bot')::boolean, false)) AS b
            FROM "SiteVisitor" WHERE "siteId" = ${siteId} AND "hour" >= ${day} AND "hour" < ${next} AND ("data"->>'v') IS NOT NULL
            GROUP BY "hash") t`
    const num = (v: unknown) => Number(v ?? 0)
    const s = sums[0] ?? {}, x = distinct[0] ?? {}
    const data: Record<string, number> = {}
    for (const k of ['human', 'unconfirmedReq', 'bots', 'pageViews', 'unconfirmedPageViews', 'botPageViews']) data[k] = num(s[k])
    for (const k of ['visitors', 'unconfirmed', 'botVisitors']) data[k] = num(x[k])
    await this.p.siteMetricDay.updateMany({ where: { siteId, day }, data })
  }
  async hours(siteId: string, from: Date, to: Date) {
    return (await this.p.siteMetricHour.findMany({ where: { siteId, hour: { gte: from, lt: to } }, orderBy: { hour: 'asc' } }))
      .map((r: any) => ({ at: r.hour as Date, agg: rowToAgg(r) }))
  }
  async days(siteId: string, from: Date, to: Date) {
    return (await this.p.siteMetricDay.findMany({ where: { siteId, day: { gte: from, lt: to } }, orderBy: { day: 'asc' } }))
      .map((r: any) => ({ at: r.day as Date, agg: rowToAgg(r) }))
  }
  async salt(day: string, create: () => string | null) {
    const r = await this.p.siteMetricSalt.findUnique({ where: { day } })
    if (r) return r.salt as string
    const n = create()
    if (!n) return null
    await this.p.siteMetricSalt.createMany({ data: [{ day, salt: n }], skipDuplicates: true })
    return ((await this.p.siteMetricSalt.findUnique({ where: { day } }))?.salt as string) ?? null
  }
  async prune(now: Date) {
    const vCut = new Date(dayOf(now).getTime() - (SALT_KEEP_DAYS - 1) * DAY)
    const hours = (await this.p.siteMetricHour.deleteMany({ where: { hour: { lt: new Date(now.getTime() - HOUR_KEEP_DAYS * DAY) } } })).count
    const days = (await this.p.siteMetricDay.deleteMany({ where: { day: { lt: new Date(now.getTime() - DAY_KEEP_DAYS * DAY) } } })).count
    const visitors = (await this.p.siteVisitor.deleteMany({ where: { hour: { lt: vCut } } })).count
    const salts = (await this.p.siteMetricSalt.deleteMany({ where: { day: { lt: vCut.toISOString().slice(0, 10) } } })).count
    return { hours, days, visitors, salts }
  }
  async deleteSite(siteId: string) {
    await this.p.siteMetricHour.deleteMany({ where: { siteId } })
    await this.p.siteMetricDay.deleteMany({ where: { siteId } })
    await this.p.siteVisitor.deleteMany({ where: { siteId } })
    await this.p.siteMetricState.deleteMany({ where: { siteId } })
  }
}

let store: MetricsStore = new MemoryMetricsStore()
export function setMetricsStore(s: MetricsStore): void { store = s }
export function metricsStore(): MetricsStore { return store }
