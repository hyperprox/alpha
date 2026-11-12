// =============================================================================
//  HyperProx — site metrics: who is a person
//
//  A visitor (the day's salted hash of an address and User-Agent) counts as a
//  person in an hour when, that hour, they are not a bot and, at some point
//  that day, they behaved like a browser:
//    - opened a page and fetched an image, stylesheet, script or font from the
//      site within two minutes of it (a 304 for one counts: it was cached), or
//    - came back to a page and got a 304 for it, after loading a page earlier.
//  Someone who opens pages but never fetches anything else is "unconfirmed":
//  most of those are scripts and scanners with a browser's User-Agent.
//  A visitor marked as a bot in an hour (by name, by a fake User-Agent, or by
//  asking for a scanner's path) is a bot for the whole of that hour.
//
//  One VisitorHour per visitor per hour is kept with the hash for two days, so
//  a page view in one five-minute read and its images in the next still meet.
//  It holds counts and times only, never an address or a User-Agent. The few
//  paths it holds (pages, referrer hosts and 404s, waiting for the visitor to
//  be confirmed before they reach the top lists) are deleted with it.
// =============================================================================

import type { Counts } from './aggregate'
import type { Device } from './user-agent'

/** How long after a page view an asset still confirms it, and how long before (log lines can land out of order). */
export const CONFIRM_AFTER_MS = 120_000
export const CONFIRM_BEFORE_MS = 5_000
/** Times kept per list in a VisitorHour, the latest ones. */
const KEEP_TIMES = 16
/** Paths kept per pending list in a VisitorHour. */
const KEEP_PENDING = 20

export interface VisitorHour {
  v: 2
  /** A bot this hour: by name, a fake User-Agent, a scanner's path, robots.txt, or a request that is not one. */
  bot: boolean
  /** As last settled: a person this hour. */
  person: boolean
  /** Its device and pending paths are already in the hour's lists. */
  listed: boolean
  /** Requests, page views (2xx), revisits (304 for a page). */
  req: number; pv: number; rv: number
  pageAt: number[]; assetAt: number[]; revisitAt: number[]
  firstPageAt: number | null
  pend: { pages: Counts; refs: Counts; nf: Counts }
  cls: { browser: string; os: string; device: Device }
}

export const newVisit = (cls: VisitorHour['cls']): VisitorHour => ({
  v: 2, bot: false, person: false, listed: false, req: 0, pv: 0, rv: 0, pageAt: [], assetAt: [], revisitAt: [], firstPageAt: null,
  pend: { pages: {}, refs: {}, nf: {} }, cls,
})

/** A stored value back as a VisitorHour, or null for a row written before this check existed. */
export function asVisit(x: unknown): VisitorHour | null {
  const o = x as Partial<VisitorHour> | null
  if (!o || typeof o !== 'object' || o.v !== 2) return null
  return {
    ...newVisit(o.cls ?? { browser: 'Other', os: 'Other', device: 'desktop' }), ...o,
    pageAt: Array.isArray(o.pageAt) ? o.pageAt : [], assetAt: Array.isArray(o.assetAt) ? o.assetAt : [],
    revisitAt: Array.isArray(o.revisitAt) ? o.revisitAt : [], pend: { pages: {}, refs: {}, nf: {}, ...(o.pend ?? {}) },
  } as VisitorHour
}

const latest = (a: number[], b: number[]) => [...a, ...b].sort((x, y) => x - y).slice(-KEEP_TIMES)

function addCapped(into: Counts, from: Counts): Counts {
  const out: Counts = { ...into }
  for (const [k, v] of Object.entries(from)) {
    if (out[k] !== undefined) out[k] += v
    else if (Object.keys(out).length < KEEP_PENDING) out[k] = v
  }
  return out
}

export function pushTime(list: number[], t: number): void {
  list.push(t)
  if (list.length > KEEP_TIMES) list.splice(0, list.length - KEEP_TIMES)
}

export function pend(c: Counts, k: string): void {
  if (c[k] !== undefined) c[k]++
  else if (Object.keys(c).length < KEEP_PENDING) c[k] = 1
}

/** What was kept for a visitor-hour plus a new read's part of the same hour. */
export function mergeVisit(a: VisitorHour | null, b: VisitorHour): VisitorHour {
  if (!a) return { ...b, pend: { pages: { ...b.pend.pages }, refs: { ...b.pend.refs }, nf: { ...b.pend.nf } } }
  const bot = a.bot || b.bot
  const firsts = [a.firstPageAt, b.firstPageAt].filter((t): t is number => t !== null)
  return {
    v: 2, bot, person: a.person, listed: a.listed,
    req: a.req + b.req, pv: a.pv + b.pv, rv: a.rv + b.rv,
    pageAt: latest(a.pageAt, b.pageAt), assetAt: latest(a.assetAt, b.assetAt), revisitAt: latest(a.revisitAt, b.revisitAt),
    firstPageAt: firsts.length ? Math.min(...firsts) : null,
    // A bot's paths never reach the lists, so they are not kept.
    pend: bot ? { pages: {}, refs: {}, nf: {} } : { pages: addCapped(a.pend.pages, b.pend.pages), refs: addCapped(a.pend.refs, b.pend.refs), nf: addCapped(a.pend.nf, b.pend.nf) },
    cls: a.cls,
  }
}

/** True when one visitor's day so far shows a browser: a page with an asset close to it, or a 304 revisit. */
export function behavesLikeBrowser(rows: VisitorHour[]): boolean {
  const pages = rows.flatMap(r => r.pageAt), assets = rows.flatMap(r => r.assetAt)
  if (pages.some(p => assets.some(a => a >= p - CONFIRM_BEFORE_MS && a <= p + CONFIRM_AFTER_MS))) return true
  const firsts = rows.map(r => r.firstPageAt).filter((t): t is number => t !== null)
  if (!firsts.length) return false
  const first = Math.min(...firsts)
  return rows.some(r => r.revisitAt.some(t => t > first))
}

export interface ListDelta { pages: Counts; referrers: Counts; notFound: Counts; browsers: Counts; os: Counts; devices: Counts }
export const emptyLists = (): ListDelta => ({ pages: {}, referrers: {}, notFound: {}, browsers: {}, os: {}, devices: {} })

const add = (c: Counts, from: Counts) => { for (const [k, v] of Object.entries(from)) c[k] = (c[k] ?? 0) + v }

/**
 * Settle one visitor's day (hour → VisitorHour, changed in place): who is a person in which hour, and what each
 * newly confirmed hour adds to the top lists. Returns the hours whose rows changed and the list additions.
 */
export function settle(day: Map<number, VisitorHour>): { changed: Set<number>; lists: Map<number, ListDelta> } {
  const rows = [...day.values()]
  // Confirmation is kept for the day: the time lists are trimmed, so a person opening many cached pages would
  // otherwise drift back to unconfirmed once the page their assets matched falls off the list.
  const browser = rows.some(r => r.person) || behavesLikeBrowser(rows)
  const changed = new Set<number>()
  const lists = new Map<number, ListDelta>()
  for (const [h, r] of day) {
    const person = !r.bot && browser && r.req > 0
    if (person !== r.person) { r.person = person; changed.add(h) }
    if (!person) continue
    const hasPending = Object.keys(r.pend.pages).length + Object.keys(r.pend.refs).length + Object.keys(r.pend.nf).length > 0
    if (r.listed && !hasPending) continue
    const l = emptyLists()
    add(l.pages, r.pend.pages); add(l.referrers, r.pend.refs); add(l.notFound, r.pend.nf)
    if (!r.listed) { l.browsers[r.cls.browser] = 1; l.os[r.cls.os] = 1; l.devices[r.cls.device] = 1; r.listed = true }
    r.pend = { pages: {}, refs: {}, nf: {} }
    lists.set(h, l)
    changed.add(h)
  }
  return { changed, lists }
}

export interface Derived {
  visitors: number; unconfirmed: number; botVisitors: number
  human: number; unconfirmedReq: number; bots: number
  pageViews: number; unconfirmedPageViews: number; botPageViews: number
}
export const DERIVED_KEYS: Array<keyof Derived> = ['visitors', 'unconfirmed', 'botVisitors', 'human', 'unconfirmedReq', 'bots', 'pageViews', 'unconfirmedPageViews', 'botPageViews']

/** One hour's people, unconfirmed visitors and bots, from its visitor rows. */
export function deriveHour(rows: VisitorHour[]): Derived {
  const d: Derived = { visitors: 0, unconfirmed: 0, botVisitors: 0, human: 0, unconfirmedReq: 0, bots: 0, pageViews: 0, unconfirmedPageViews: 0, botPageViews: 0 }
  for (const r of rows) {
    if (r.bot) { d.botVisitors++; d.bots += r.req; d.botPageViews += r.pv }
    else if (r.person) { d.visitors++; d.human += r.req; d.pageViews += r.pv + r.rv }
    else { d.unconfirmedReq += r.req; if (r.pv + r.rv > 0) { d.unconfirmed++; d.unconfirmedPageViews += r.pv + r.rv } }
  }
  return d
}

/** Distinct visitors over a day: a person in any hour is a person; else unconfirmed if they opened a page; else a bot. */
export function deriveDayVisitors(byHash: Iterable<VisitorHour[]>): Pick<Derived, 'visitors' | 'unconfirmed' | 'botVisitors'> {
  let visitors = 0, unconfirmed = 0, botVisitors = 0
  for (const rows of byHash) {
    if (rows.some(r => r.person)) visitors++
    else if (rows.some(r => !r.bot && r.pv + r.rv > 0)) unconfirmed++
    else if (rows.some(r => r.bot)) botVisitors++
  }
  return { visitors, unconfirmed, botVisitors }
}
