// =============================================================================
//  HyperProx — Arr Stack "Upcoming": what Sonarr and Radarr expect to grab soon
//
//  Pure functions over the shapes Sonarr and Radarr return, so the parsing, the
//  day grouping (in the viewer's time zone) and the status cross-reference with
//  the download queue are tested without either service. routes/arr-upcoming.ts
//  reads the services and hands their answers to buildUpcoming().
//
//  Two kinds of date, handled differently on purpose:
//   - a TV episode has an air INSTANT (airDateUtc), shown in the viewer's zone, so
//     one that airs at 02:00 UTC is "tonight" in Toronto and "tomorrow" in Paris;
//   - a film's cinema / digital / physical release is a CALENDAR DATE that Radarr
//     stores as midnight UTC. Shifting it into a zone would move it a day early
//     west of Greenwich, so its date is read as written.
// =============================================================================

import { artRef } from './art'

export type UpcomingStatus = 'have' | 'downloading' | 'waiting' | 'upcoming'
export type GroupKey = 'today' | 'tomorrow' | 'week' | 'later'
export type ReleaseKind = 'cinema' | 'digital' | 'physical'

export interface UpcomingItem {
  id: string
  kind: 'tv' | 'film' | 'music'
  title: string
  /** TV only. */
  season?: number; episode?: number; code?: string; episodeTitle?: string; network?: string | null
  /** TV only: the air instant, ISO UTC. */
  airUtc?: string
  /** Film only. */
  year?: number | null; releaseKind?: ReleaseKind; releaseDate?: string
  /** Music only (Lidarr): the artist, and "Album", "EP", "Single". The album's date is `releaseDate`, a calendar date. */
  artist?: string; albumType?: string
  /** The viewer's calendar day this sits under, YYYY-MM-DD. */
  day: string
  /** "tonight 9 pm", "tomorrow 8:30 pm", "Thu 9 pm", "17 Nov". */
  when: string
  status: UpcomingStatus
  statusText: string
  /** 0-100 while downloading. */
  progress?: number
  art: string | null
}

export interface UpcomingGroup { key: GroupKey; label: string; items: UpcomingItem[] }

export interface MissingRow { id: string; title: string; detail: string; date: string | null }
export interface MissingStrip { total: number; items: MissingRow[]; approximate?: boolean }

const KIND_ORDER: Record<UpcomingItem['kind'], number> = { tv: 0, film: 1, music: 2 }
const GROUP_LABEL: Record<GroupKey, string> = { today: 'Today', tomorrow: 'Tomorrow', week: 'This week', later: 'Later' }
const DAY_MS = 86_400_000

// ── time zones ───────────────────────────────────────────────────────────────

/** `tz` when it is a real IANA zone, else UTC. */
export function validZone(tz: unknown): string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return 'UTC'
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz } catch { return 'UTC' }
}

interface Parts { y: number; m: number; d: number; hour: number; minute: number; weekday: string }
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function partsIn(ms: number, tz: string): Parts {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
  const o: Record<string, number> = {}
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value)
  const weekday = WEEKDAYS[new Date(Date.UTC(o.year, o.month - 1, o.day)).getUTCDay()]
  return { y: o.year, m: o.month, d: o.day, hour: o.hour % 24, minute: o.minute, weekday }
}

const pad = (n: number) => String(n).padStart(2, '0')
/** The calendar day an instant falls on in `tz`, YYYY-MM-DD. */
export function dayKey(ms: number, tz: string): string { const p = partsIn(ms, tz); return `${p.y}-${pad(p.m)}-${pad(p.d)}` }
/** Whole days from key `a` to key `b` (b later is positive). Keys are plain dates, so no zone is involved. */
export function dayDiff(a: string, b: string): number { return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS) }
export function addDays(key: string, n: number): string { return new Date(Date.parse(`${key}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10) }

export function groupOf(diff: number): GroupKey { return diff <= 0 ? 'today' : diff === 1 ? 'tomorrow' : diff <= 7 ? 'week' : 'later' }

function clock(p: Parts): string {
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12
  return `${h12}${p.minute ? ':' + pad(p.minute) : ''} ${p.hour < 12 ? 'am' : 'pm'}`
}
const dateWord = (key: string) => `${Number(key.slice(8))} ${MONTHS[Number(key.slice(5, 7)) - 1]}`
const weekdayOfKey = (key: string) => WEEKDAYS[new Date(`${key}T00:00:00Z`).getUTCDay()]

/** "tonight 9 pm", "tomorrow 8:30 pm", "Thu 9 pm", "17 Nov, 9 pm". */
export function airLabel(ms: number, nowMs: number, tz: string): string {
  const p = partsIn(ms, tz)
  const diff = dayDiff(dayKey(nowMs, tz), dayKey(ms, tz))
  if (diff <= 0) return `${p.hour >= 17 ? 'tonight' : 'today'} ${clock(p)}`
  if (diff === 1) return `tomorrow ${clock(p)}`
  if (diff < 7) return `${p.weekday} ${clock(p)}`
  return `${dateWord(dayKey(ms, tz))}, ${clock(p)}`
}

/** "today", "tomorrow", "Thu", "17 Nov", for a calendar date. */
export function dateLabel(key: string, todayKey: string): string {
  const diff = dayDiff(todayKey, key)
  if (diff <= 0) return 'today'
  if (diff === 1) return 'tomorrow'
  if (diff < 7) return weekdayOfKey(key)
  return dateWord(key)
}

const inDays = (n: number) => (n <= 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`)

// ── queue ────────────────────────────────────────────────────────────────────

/** Which episode or movie ids are in a download queue, with how far along each is. */
export function queueIndex(records: any[] | null | undefined, idField: 'episodeId' | 'movieId' | 'albumId'): Map<number, number> {
  const out = new Map<number, number>()
  for (const r of Array.isArray(records) ? records : []) {
    const id = Number(r?.[idField])
    if (!Number.isInteger(id) || id <= 0) continue
    const size = Number(r.size) || 0, left = Number(r.sizeleft) || 0
    const pct = size > 0 ? Math.max(0, Math.min(100, Math.round(((size - left) / size) * 100))) : 0
    out.set(id, Math.max(out.get(id) ?? 0, pct))
  }
  return out
}

// ── posters ──────────────────────────────────────────────────────────────────

const hasPoster = (images: any): boolean => Array.isArray(images) && images.some(i => i?.coverType === 'poster')

// ── TV ───────────────────────────────────────────────────────────────────────

export function tvItems(calendar: any[], queue: Map<number, number>, nowMs: number, tz: string): UpcomingItem[] {
  const out: UpcomingItem[] = []
  for (const e of Array.isArray(calendar) ? calendar : []) {
    const air = Date.parse(String(e?.airDateUtc ?? ''))
    if (!Number.isFinite(air) || !e?.series?.title) continue
    const today = dayKey(nowMs, tz), day = dayKey(air, tz)
    const season = Number(e.seasonNumber) || 0, episode = Number(e.episodeNumber) || 0
    const base = {
      id: `tv-${e.id}`, kind: 'tv' as const, title: String(e.series.title),
      season, episode, code: `S${pad(season)}E${pad(episode)}`, episodeTitle: String(e.title ?? ''),
      network: e.series.network ? String(e.series.network) : null,
      airUtc: new Date(air).toISOString(), day, when: airLabel(air, nowMs, tz),
      art: Number.isInteger(Number(e.seriesId)) && hasPoster(e.series.images) ? artRef('sonarr', e.seriesId) : null,
    }
    if (e.hasFile) out.push({ ...base, status: 'have', statusText: 'already have it' })
    else if (queue.has(Number(e.id))) out.push({ ...base, status: 'downloading', statusText: 'downloading', progress: queue.get(Number(e.id)) })
    else if (air <= nowMs) out.push({ ...base, status: 'waiting', statusText: 'aired, waiting for a release' })
    else {
      const n = dayDiff(today, day)
      out.push({ ...base, status: 'upcoming', statusText: n <= 0 ? `airs later ${partOfDay(air, tz)}` : `airs ${inDays(n)}` })
    }
  }
  return out
}
const partOfDay = (ms: number, tz: string) => (partsIn(ms, tz).hour >= 17 ? 'tonight' : 'today')

// ── films ────────────────────────────────────────────────────────────────────

const RELEASE_FIELDS: Array<[ReleaseKind, string]> = [['digital', 'digitalRelease'], ['physical', 'physicalRelease'], ['cinema', 'inCinemas']]
const RELEASE_WORD: Record<ReleaseKind, string> = { cinema: 'In cinemas', digital: 'Digital release', physical: 'Physical release' }
export const releaseWord = (k: ReleaseKind) => RELEASE_WORD[k]

const dateOnly = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null)

/**
 * One row per film, under the first of its three release dates that falls in [today, end]; on a tie digital wins,
 * because that is what Radarr usually grabs on. Status: Radarr normally grabs at the digital release, so a film
 * only in cinemas is "upcoming", and one whose digital or physical date has passed with no file is "waiting".
 */
export function filmItems(calendar: any[], queue: Map<number, number>, nowMs: number, tz: string, end: string): UpcomingItem[] {
  const today = dayKey(nowMs, tz)
  const out: UpcomingItem[] = []
  for (const m of Array.isArray(calendar) ? calendar : []) {
    if (!m?.title) continue
    const dates = RELEASE_FIELDS.map(([k, f]) => ({ k, d: dateOnly(m[f]) })).filter((x): x is { k: ReleaseKind; d: string } => !!x.d)
    const inWindow = dates.filter(x => x.d >= today && x.d <= end).sort((a, b) => a.d.localeCompare(b.d))
    if (!inWindow.length) continue
    const pick = inWindow[0]
    const digital = dates.find(x => x.k === 'digital')?.d ?? null
    const physical = dates.find(x => x.k === 'physical')?.d ?? null
    const released = (digital && digital <= today) || (physical && physical <= today) || m.isAvailable === true
    const base = {
      id: `film-${m.id}`, kind: 'film' as const, title: String(m.title), year: Number.isFinite(Number(m.year)) && Number(m.year) > 0 ? Number(m.year) : null,
      releaseKind: pick.k, releaseDate: pick.d, day: pick.d, when: dateLabel(pick.d, today),
      art: Number.isInteger(Number(m.id)) && hasPoster(m.images) ? artRef('radarr', m.id) : null,
    }
    const n = dayDiff(today, pick.d)
    if (m.hasFile) out.push({ ...base, status: 'have', statusText: 'already have it' })
    else if (queue.has(Number(m.id))) out.push({ ...base, status: 'downloading', statusText: 'downloading', progress: queue.get(Number(m.id)) })
    else if (released) out.push({ ...base, status: 'waiting', statusText: 'out now, waiting for a release' })
    else if (pick.k === 'cinema') {
      out.push({ ...base, status: 'upcoming', statusText: `${n <= 0 ? 'in cinemas today' : 'in cinemas ' + inDays(n)}; Radarr usually grabs at the digital release${digital ? ` (${dateWord(digital)})` : ''}` })
    } else if (pick.k === 'digital') {
      out.push({ ...base, status: 'upcoming', statusText: `digital release ${inDays(n)}; Radarr grabs about then` })
    } else {
      out.push({ ...base, status: 'upcoming', statusText: `physical release ${inDays(n)}${digital && digital > today ? `; digital is ${dateWord(digital)}` : ''}` })
    }
  }
  return out
}

// ── music (Lidarr) ───────────────────────────────────────────────────────────

const hasCover = (images: any): boolean => Array.isArray(images) && images.some(i => i?.coverType === 'cover')

/** All the tracks a Lidarr album should have are on disk. */
const albumComplete = (a: any): boolean => {
  const st = a?.statistics ?? {}
  const total = Number(st.trackCount) || Number(st.totalTrackCount) || 0
  return total > 0 && Number(st.trackFileCount) >= total
}

/**
 * One row per album Lidarr's calendar returns. An album's release is a CALENDAR DATE (midnight UTC), read as written
 * like a film's, never shifted into a zone. Status: all tracks on disk is "have"; in the queue is "downloading"; a date
 * already passed with tracks missing is "waiting"; anything later is "upcoming" (Lidarr searches once it is out).
 */
export function musicItems(calendar: any[], queue: Map<number, number>, nowMs: number, tz: string, end: string): UpcomingItem[] {
  const today = dayKey(nowMs, tz)
  const out: UpcomingItem[] = []
  for (const a of Array.isArray(calendar) ? calendar : []) {
    const date = dateOnly(a?.releaseDate)
    if (!a?.title || !date || date < today || date > end) continue
    const id = Number(a.id)
    const n = dayDiff(today, date)
    const base = {
      id: `music-${a.id}`, kind: 'music' as const, title: String(a.title),
      artist: String(a.artist?.artistName ?? 'Unknown artist'), albumType: a.albumType ? String(a.albumType) : 'Album',
      releaseDate: date, day: date, when: dateLabel(date, today),
      art: Number.isInteger(id) && id > 0 && hasCover(a.images) ? artRef('lidarr', id) : null,
    }
    if (albumComplete(a)) out.push({ ...base, status: 'have', statusText: 'already have it' })
    else if (queue.has(id)) out.push({ ...base, status: 'downloading', statusText: 'downloading', progress: queue.get(id) })
    else if (n <= 0) out.push({ ...base, status: 'waiting', statusText: 'out today, waiting for a release' })
    else out.push({ ...base, status: 'upcoming', statusText: `release ${inDays(n)}; Lidarr searches once it is out` })
  }
  return out
}

// ── grouping ─────────────────────────────────────────────────────────────────

/** Today / Tomorrow / This week / Later, empty groups left out; within a day TV by air time, then films by title. */
export function groupItems(items: UpcomingItem[], nowMs: number, tz: string): UpcomingGroup[] {
  const today = dayKey(nowMs, tz)
  const sorted = [...items].sort((a, b) =>
    a.day.localeCompare(b.day) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    String(a.airUtc ?? '').localeCompare(String(b.airUtc ?? '')) || a.title.localeCompare(b.title))
  const groups: UpcomingGroup[] = (['today', 'tomorrow', 'week', 'later'] as GroupKey[]).map(key => ({ key, label: GROUP_LABEL[key], items: [] }))
  for (const it of sorted) groups.find(g => g.key === groupOf(dayDiff(today, it.day)))!.items.push(it)
  return groups.filter(g => g.items.length)
}

/** Episodes airing tonight (today, 17:00 on, in the viewer's zone) that are not on disk yet. */
export function tonightCount(items: UpcomingItem[], nowMs: number, tz: string): number {
  const today = dayKey(nowMs, tz)
  return items.filter(i => i.kind === 'tv' && i.day === today && i.status !== 'have' && partsIn(Date.parse(i.airUtc!), tz).hour >= 17).length
}

// ── "Missing, searching" ─────────────────────────────────────────────────────

/** Sonarr's wanted/missing page (aired and monitored, no file): newest aired first. */
export function sonarrMissing(page: any, nowMs: number, tz: string, top = 10): MissingStrip {
  const rows: any[] = Array.isArray(page?.records) ? page.records : []
  const today = dayKey(nowMs, tz)
  return {
    total: Number(page?.totalRecords) || rows.length,
    items: rows.slice(0, top).map(e => {
      const air = Date.parse(String(e?.airDateUtc ?? ''))
      const ago = Number.isFinite(air) ? dayDiff(dayKey(air, tz), today) : null
      return {
        id: `tv-${e.id}`, title: String(e?.series?.title ?? 'Unknown series'),
        detail: `S${pad(Number(e.seasonNumber) || 0)}E${pad(Number(e.episodeNumber) || 0)}${e.title ? ` ${e.title}` : ''}`,
        date: ago === null ? null : ago <= 0 ? 'aired today' : ago === 1 ? 'aired yesterday' : `aired ${ago} days ago`,
      }
    }),
  }
}

/**
 * Radarr's wanted/missing page. Radarr lists unreleased films there too, so only ones it calls available count:
 * those are the overdue ones. `approximate` means the page was not the whole list, so the count is a floor.
 */
export function radarrMissing(page: any, top = 10): MissingStrip {
  const rows: any[] = Array.isArray(page?.records) ? page.records : []
  const out = rows.filter(m => m?.isAvailable === true && !m.hasFile)
  const total = Number(page?.totalRecords) || rows.length
  return {
    total: out.length,
    approximate: total > rows.length ? true : undefined,
    items: out.slice(0, top).map(m => ({
      id: `film-${m.id}`, title: String(m.title ?? 'Unknown film'),
      detail: Number(m.year) > 0 ? String(m.year) : '',
      date: dateOnly(m.releaseDate) ? `released ${dateWord(dateOnly(m.releaseDate)!)}` : null,
    })),
  }
}

/**
 * Lidarr's wanted/missing page (monitored albums with no files), newest release first. Only albums already out count:
 * a future release is not overdue. `approximate` means the page was not the whole list.
 */
export function lidarrMissing(page: any, nowMs: number, tz: string, top = 10): MissingStrip {
  const rows: any[] = Array.isArray(page?.records) ? page.records : []
  const today = dayKey(nowMs, tz)
  const out = rows.filter(a => { const d = dateOnly(a?.releaseDate); return !d || d <= today })
  const total = Number(page?.totalRecords) || rows.length
  return {
    total: out.length,
    approximate: total > rows.length ? true : undefined,
    items: out.slice(0, top).map(a => {
      const d = dateOnly(a?.releaseDate)
      const ago = d ? dayDiff(d, today) : null
      return {
        id: `music-${a.id}`, title: String(a?.artist?.artistName ?? 'Unknown artist'), detail: String(a?.title ?? 'Unknown album'),
        date: ago === null ? null : ago <= 0 ? 'released today' : ago === 1 ? 'released yesterday' : `released ${ago} days ago`,
      }
    }),
  }
}
