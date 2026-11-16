// =============================================================================
//  HyperProx — Arr Stack "Give up after X tries": the pure part
//
//  Sonarr, Radarr and Lidarr keep no count of how often they have looked for something. Each item only carries
//  `lastSearchTime`, the last time a search ran for it. So HyperProx counts for them: every time that time moves
//  on while the item still has no file is one try (observe()). Between two readings the arr may have searched
//  more than once, so the count is "at least".
//
//  Why it keeps failing comes from the arr's history (grabbed, download failed, import failed) and, when someone
//  asks, from one interactive release search ("See what's available"): no release found at all, or releases
//  found but every one rejected, with the arr's own reasons in plain English (plainRejection()).
//
//  Nothing here talks to an arr: service.ts reads them and acts. Everything here is tested with recorded
//  fixtures (test/arr-giveup.test.ts).
// =============================================================================

export const APPS = ['sonarr', 'radarr', 'lidarr'] as const
export type App = typeof APPS[number]
export const isApp = (v: unknown): v is App => typeof v === 'string' && (APPS as readonly string[]).includes(v)
export const APP_NAME: Record<App, string> = { sonarr: 'Sonarr', radarr: 'Radarr', lidarr: 'Lidarr' }
export const APP_WHAT: Record<App, { one: string; many: string }> = {
  sonarr: { one: 'TV episode', many: 'TV episodes' }, radarr: { one: 'film', many: 'films' }, lidarr: { one: 'album', many: 'albums' },
}

const DAY_MS = 86_400_000

// ── settings ─────────────────────────────────────────────────────────────────

export type GiveUpAction = 'unmonitor' | 'remove'
export type AgeFrom = 'released' | 'first-missing'
export interface GiveUpSettings {
  enabled: boolean
  /** Give up after this many tries. */
  tries: number
  /** ...and only when it is at least this old. */
  minAgeDays: number
  /** Old since it aired or was released, or since HyperProx first saw it missing. */
  ageFrom: AgeFrom
  /** 'unmonitor' keeps everything; 'remove' (films and albums only) takes it out of the library, files untouched (there are none). */
  action: GiveUpAction
}

export const DEFAULT_SETTINGS: GiveUpSettings = { enabled: false, tries: 14, minAgeDays: 30, ageFrom: 'released', action: 'unmonitor' }
export const TRIES_RANGE = [1, 200] as const
export const AGE_RANGE = [0, 3650] as const

/** A settings body checked field by field. A string is why it was refused. */
export function parseSettings(app: App, v: unknown): GiveUpSettings | string {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'Send the settings.'
  const o = v as Record<string, unknown>
  const tries = Number(o.tries), age = Number(o.minAgeDays)
  if (typeof o.enabled !== 'boolean') return 'Say whether it is on or off.'
  if (!Number.isInteger(tries) || tries < TRIES_RANGE[0] || tries > TRIES_RANGE[1]) return `Tries must be a whole number from ${TRIES_RANGE[0]} to ${TRIES_RANGE[1]}.`
  if (!Number.isInteger(age) || age < AGE_RANGE[0] || age > AGE_RANGE[1]) return `The minimum age must be from ${AGE_RANGE[0]} to ${AGE_RANGE[1]} days.`
  if (o.ageFrom !== 'released' && o.ageFrom !== 'first-missing') return 'Say what the age counts from.'
  if (o.action !== 'unmonitor' && o.action !== 'remove') return 'Pick stop searching or remove.'
  if (o.action === 'remove' && app === 'sonarr') return 'TV episodes can only stop being searched for: removing a whole show is not what this is for.'
  return { enabled: o.enabled, tries, minAgeDays: age, ageFrom: o.ageFrom, action: o.action }
}

export const sameRule = (a: GiveUpSettings, b: GiveUpSettings) =>
  a.tries === b.tries && a.minAgeDays === b.minAgeDays && a.ageFrom === b.ageFrom && a.action === b.action

// ── what is missing, read from an arr ────────────────────────────────────────

export interface MissingItem {
  key: string
  app: App
  /** The episode, movie or album id in that arr. */
  arrId: number
  title: string
  detail: string
  seriesId?: number; season?: number; episode?: number
  artistId?: number
  /** Aired or released, ISO; null when the arr does not know. */
  releasedAt: string | null
  lastSearchTime: string | null
}

export const itemKey = (app: App, id: number) => `${app}:${id}`
export function parseKey(key: unknown): { app: App; arrId: number } | null {
  if (typeof key !== 'string' || key.length > 40) return null
  // No leading zeros: "radarr:07" and "radarr:7" must not be two keys for one film.
  const m = /^(sonarr|radarr|lidarr):([1-9]\d{0,9})$/.exec(key)
  return m ? { app: m[1] as App, arrId: Number(m[2]) } : null
}

const pad = (n: number) => String(n).padStart(2, '0')
const iso = (v: unknown): string | null => {
  if (typeof v !== 'string' || !v) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}
const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max) : '')
const pos = (v: unknown): number | null => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null }

/** Sonarr's wanted/missing records (monitored, aired, no file). */
export function sonarrItems(records: any[]): MissingItem[] {
  const out: MissingItem[] = []
  for (const e of Array.isArray(records) ? records : []) {
    const id = pos(e?.id)
    if (!id || e.hasFile || e.monitored === false) continue
    const s = Number(e.seasonNumber) || 0, n = Number(e.episodeNumber) || 0
    out.push({
      key: itemKey('sonarr', id), app: 'sonarr', arrId: id,
      title: str(e.series?.title) || 'Unknown series',
      detail: `S${pad(s)}E${pad(n)}${str(e.title) ? ` ${str(e.title)}` : ''}`,
      seriesId: pos(e.seriesId) ?? undefined, season: s, episode: n,
      releasedAt: iso(e.airDateUtc), lastSearchTime: iso(e.lastSearchTime),
    })
  }
  return out
}

/** The first of a film's release dates that has passed (digital, physical, then cinema); else Radarr's own releaseDate. */
function filmReleased(m: any, nowMs: number): string | null {
  const dates = [m?.digitalRelease, m?.physicalRelease, m?.inCinemas].map(iso).filter((d): d is string => !!d && Date.parse(d) <= nowMs).sort()
  return dates[0] ?? iso(m?.releaseDate)
}

/** Radarr's wanted/missing records. Radarr lists unreleased films there too: only the ones it calls available count. */
export function radarrItems(records: any[], nowMs: number): MissingItem[] {
  const out: MissingItem[] = []
  for (const m of Array.isArray(records) ? records : []) {
    const id = pos(m?.id)
    if (!id || m.hasFile || m.monitored === false || m.isAvailable !== true) continue
    out.push({
      key: itemKey('radarr', id), app: 'radarr', arrId: id, title: str(m.title) || 'Unknown film',
      detail: Number(m.year) > 0 ? String(m.year) : '', releasedAt: filmReleased(m, nowMs), lastSearchTime: iso(m.lastSearchTime),
    })
  }
  return out
}

/** Lidarr's wanted/missing records: albums already out, with no track on disk at all (a part-complete album is left alone). */
export function lidarrItems(records: any[], nowMs: number): MissingItem[] {
  const out: MissingItem[] = []
  for (const a of Array.isArray(records) ? records : []) {
    const id = pos(a?.id)
    if (!id || a.monitored === false) continue
    const rel = iso(a.releaseDate)
    if (rel && Date.parse(rel) > nowMs) continue
    if (Number(a.statistics?.trackFileCount) > 0) continue
    out.push({
      key: itemKey('lidarr', id), app: 'lidarr', arrId: id, title: str(a.artist?.artistName) || 'Unknown artist',
      detail: str(a.title) || 'Unknown album', artistId: pos(a.artistId) ?? undefined, releasedAt: rel, lastSearchTime: iso(a.lastSearchTime),
    })
  }
  return out
}

// ── tracking ─────────────────────────────────────────────────────────────────

/** What one interactive release search found, kept so the reason can say it. */
export interface ReleaseCheck { at: string; found: number; approved: number; top: string[] }

export interface Restore {
  /** Radarr: how to add the film back exactly as it was. */
  tmdbId?: number; year?: number; qualityProfileId?: number; rootFolderPath?: string; path?: string; minimumAvailability?: string; tags?: number[]
  /** Lidarr: the album and its artist. */
  foreignAlbumId?: string; artist?: Record<string, unknown>
}

export interface Track {
  key: string
  app: App
  arrId: number
  title: string
  detail: string
  seriesId?: number; season?: number; episode?: number; artistId?: number
  releasedAt: string | null
  /** When HyperProx first saw it missing. */
  firstMissingAt: string
  /** The last `lastSearchTime` counted. */
  lastSearchSeen: string | null
  tries: number
  grabs: number
  failures: number
  importFailures: number
  lastFailure?: string
  check?: ReleaseCheck
  /** TV: every episode of its season is missing. */
  wholeSeason?: boolean
  state: 'tracking' | 'given-up'
  gaveUpAt?: string
  action?: GiveUpAction
  /** Why, frozen when it was given up. */
  reason?: string
  reasonCode?: ReasonCode
  restore?: Restore
}

/** A new track. One try is counted at once when the arr has already searched since it aired. */
export function newTrack(i: MissingItem, nowIso: string): Track {
  const searched = !!i.lastSearchTime && (!i.releasedAt || i.lastSearchTime >= i.releasedAt)
  return {
    key: i.key, app: i.app, arrId: i.arrId, title: i.title, detail: i.detail,
    ...(i.seriesId ? { seriesId: i.seriesId } : {}), ...(i.season !== undefined ? { season: i.season, episode: i.episode } : {}),
    ...(i.artistId ? { artistId: i.artistId } : {}),
    releasedAt: i.releasedAt, firstMissingAt: nowIso, lastSearchSeen: i.lastSearchTime,
    tries: searched ? 1 : 0, grabs: 0, failures: 0, importFailures: 0, state: 'tracking',
  }
}

/** One history row, reduced to what counts. */
export interface HistoryEvent { id: number; arrId: number; type: 'grabbed' | 'failed' | 'import-failed'; at: string; message?: string }

/** Sonarr, Radarr and Lidarr history rows: grabs, failed downloads and failed imports; everything else is dropped. */
export function historyEvents(app: App, records: any[]): HistoryEvent[] {
  const field = app === 'sonarr' ? 'episodeId' : app === 'radarr' ? 'movieId' : 'albumId'
  const out: HistoryEvent[] = []
  for (const r of Array.isArray(records) ? records : []) {
    const id = pos(r?.id), arrId = pos(r?.[field]), at = iso(r?.date)
    if (!id || !arrId || !at) continue
    const t = String(r.eventType ?? '')
    const type = t === 'grabbed' ? 'grabbed' : /import/i.test(t) && /fail|incomplete/i.test(t) ? 'import-failed' : t === 'downloadFailed' ? 'failed' : null
    if (!type) continue
    out.push({ id, arrId, type, at, ...(str(r.data?.message) ? { message: str(r.data.message, 160) } : {}) })
  }
  return out
}

export interface ObserveResult {
  tracks: Track[]
  /** Keys no longer missing (a file arrived, someone else unmonitored it, or it left the library): stop tracking. */
  dropped: string[]
  /** The newest history id applied. */
  historyId: number
  newTries: number
}

/**
 * One reading folded into the tracks. Pure. `items` must be the arr's WHOLE missing list: anything tracked that is
 * not in it is dropped (unless given up, which is kept until it has a file or someone tries again). History events
 * at or below `historyId` were counted before and are skipped.
 */
export function observe(prev: Track[], items: MissingItem[], events: HistoryEvent[], historyId: number, nowIso: string, inQueue: Set<number> = new Set()): ObserveResult {
  const byKey = new Map(prev.map(t => [t.key, { ...t }]))
  const seen = new Set<string>()
  let newTries = 0
  for (const i of items) {
    seen.add(i.key)
    const t = byKey.get(i.key)
    if (!t) { const n = newTrack(i, nowIso); byKey.set(i.key, n); newTries += n.tries; continue }
    if (t.state === 'given-up') {
      // Someone searched for it again by hand (monitored it): it is ours to count again, from zero.
      const { gaveUpAt: _g, action: _a, reason: _r, reasonCode: _c, restore: _x, ...rest } = t
      byKey.set(i.key, { ...rest, title: i.title, detail: i.detail, releasedAt: i.releasedAt, state: 'tracking', tries: 0, grabs: 0, failures: 0, importFailures: 0, firstMissingAt: nowIso, lastSearchSeen: i.lastSearchTime })
      continue
    }
    t.title = i.title; t.detail = i.detail; t.releasedAt = i.releasedAt
    // A search that ran while it was already downloading is not a failed try.
    if (i.lastSearchTime && (!t.lastSearchSeen || i.lastSearchTime > t.lastSearchSeen)) {
      if (!inQueue.has(i.arrId)) { t.tries += 1; newTries += 1 }
      t.lastSearchSeen = i.lastSearchTime
    }
  }
  const dropped: string[] = []
  for (const [k, t] of byKey) if (t.state === 'tracking' && !seen.has(k)) { dropped.push(k); byKey.delete(k) }
  const byArrId = new Map<number, Track>()
  for (const t of byKey.values()) byArrId.set(t.arrId, t)
  let top = historyId
  for (const e of [...events].sort((a, b) => a.id - b.id)) {
    if (e.id <= historyId) continue
    top = Math.max(top, e.id)
    const t = byArrId.get(e.arrId)
    if (!t || t.state !== 'tracking') continue
    if (e.type === 'grabbed') t.grabs += 1
    else if (e.type === 'failed') { t.failures += 1; if (e.message) t.lastFailure = e.message }
    else { t.importFailures += 1; if (e.message) t.lastFailure = e.message }
  }
  return { tracks: [...byKey.values()], dropped, historyId: top, newTries }
}

/** TV: which (series, season) pairs have every episode missing, from Sonarr's series list. */
export function wholeSeasons(series: any[], tracks: Track[]): Set<string> {
  const missing = new Map<string, number>()
  for (const t of tracks) if (t.app === 'sonarr' && t.seriesId && t.season !== undefined) {
    const k = `${t.seriesId}:${t.season}`; missing.set(k, (missing.get(k) ?? 0) + 1)
  }
  const out = new Set<string>()
  for (const s of Array.isArray(series) ? series : []) for (const se of Array.isArray(s?.seasons) ? s.seasons : []) {
    const k = `${s.id}:${se.seasonNumber}`
    const st = se?.statistics ?? {}
    const n = missing.get(k) ?? 0
    if (n >= 2 && Number(st.episodeFileCount) === 0 && n >= Number(st.episodeCount || 0)) out.add(k)
  }
  return out
}

// ── why it keeps failing ─────────────────────────────────────────────────────

export type ReasonCode = 'not-searched' | 'import-failed' | 'download-failed' | 'never-finished' | 'none-found' | 'all-rejected' | 'acceptable' | 'nothing-usable'
export interface Reason { code: ReasonCode; text: string }

const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`)

/** The most useful thing that can be said about why it is still missing. */
export function classify(t: Pick<Track, 'tries' | 'grabs' | 'failures' | 'importFailures' | 'check' | 'lastFailure'>): Reason {
  if (t.importFailures > 0) return { code: 'import-failed', text: `Downloaded, but it could not be imported${t.lastFailure ? ` (${t.lastFailure})` : ''}.` }
  if (t.failures > 0) return { code: 'download-failed', text: `Grabbed ${times(t.grabs || t.failures)}; the download failed ${times(t.failures)}${t.lastFailure ? ` (${t.lastFailure})` : ''}.` }
  if (t.grabs > 0) return { code: 'never-finished', text: `Grabbed ${times(t.grabs)}, but the download never finished (it was taken out of the queue).` }
  if (t.check) {
    if (t.check.found === 0) return { code: 'none-found', text: 'No release found at all on your indexers.' }
    if (t.check.approved === 0) return { code: 'all-rejected', text: `${t.check.found} release${t.check.found === 1 ? '' : 's'} found, every one rejected${t.check.top.length ? `: ${t.check.top.join('; ')}` : ''}.` }
    return { code: 'acceptable', text: `${t.check.approved} acceptable release${t.check.approved === 1 ? '' : 's'} found when last checked: the next search should grab one.` }
  }
  if (t.tries === 0) return { code: 'not-searched', text: 'Not searched for yet.' }
  return { code: 'nothing-usable', text: `Searched ${times(t.tries)} and nothing was grabbed: either nothing was found or everything found was rejected. "See what's available" tells which.` }
}

// ── the plan ─────────────────────────────────────────────────────────────────

/** The date its age counts from. */
export const ageStart = (t: Track, s: GiveUpSettings) => (s.ageFrom === 'first-missing' ? t.firstMissingAt : (t.releasedAt ?? t.firstMissingAt))
export const ageDays = (t: Track, s: GiveUpSettings, nowMs: number) => Math.floor((nowMs - Date.parse(ageStart(t, s))) / DAY_MS)

/** Tracks the rule would give up on now: enough tries, old enough, not downloading. */
export function candidates(tracks: Track[], s: GiveUpSettings, nowMs: number, inQueue: Set<number> = new Set()): Track[] {
  return tracks.filter(t => t.state === 'tracking' && t.tries >= s.tries && ageDays(t, s, nowMs) >= s.minAgeDays && !inQueue.has(t.arrId))
}

/** One row for the page: an episode, a film, an album, or a whole season of episodes. */
export interface Row {
  key: string
  app: App
  /** Every item key this row stands for (a season has several). */
  keys: string[]
  title: string
  detail: string
  tries: number
  since: string
  reason: Reason
  gaveUpAt?: string
  action?: GiveUpAction
  /** TV: a whole old season, shown as one row. */
  season?: { number: number; episodes: number }
}

/**
 * Rows for a list of tracks. TV is per episode, except a season with every episode missing becomes one row
 * "Season N (k episodes)" (the fewest tries of its episodes, the earliest since). Newest-aired shows first.
 */
export function rows(tracks: Track[], whole: Set<string> = new Set()): Row[] {
  const out: Row[] = []
  const seasons = new Map<string, Track[]>()
  for (const t of tracks) {
    const sk = t.app === 'sonarr' && t.seriesId && t.season !== undefined ? `${t.seriesId}:${t.season}` : null
    if (sk && (whole.has(sk) || t.wholeSeason)) { const l = seasons.get(sk) ?? []; l.push(t); seasons.set(sk, l); continue }
    out.push(rowOf(t))
  }
  for (const [sk, list] of seasons) {
    if (list.length < 2) { out.push(...list.map(rowOf)); continue }
    const first = list[0]
    const tries = Math.min(...list.map(t => t.tries))
    const since = list.map(t => t.firstMissingAt).sort()[0]
    // The season's reason is its most common one.
    const reasons = new Map<string, { r: Reason; n: number }>()
    for (const t of list) { const r = reasonOf(t); const e = reasons.get(r.code) ?? { r, n: 0 }; e.n++; reasons.set(r.code, e) }
    const reason = [...reasons.values()].sort((a, b) => b.n - a.n)[0].r
    out.push({
      key: `sonarr-season:${sk}`, app: 'sonarr', keys: list.map(t => t.key).sort(), title: first.title,
      detail: `Season ${first.season} (${list.length} episodes)`, tries, since, reason,
      ...(first.gaveUpAt ? { gaveUpAt: list.map(t => t.gaveUpAt ?? '').sort()[0], action: first.action } : {}),
      season: { number: first.season!, episodes: list.length },
    })
  }
  return out.sort((a, b) => a.app.localeCompare(b.app) || a.title.localeCompare(b.title) || a.detail.localeCompare(b.detail, undefined, { numeric: true }))
}

/** A given-up item keeps the reason it was given up for; a tracked one says the current one. */
export const reasonOf = (t: Track): Reason => (t.state === 'given-up' && t.reason ? { code: t.reasonCode ?? classify(t).code, text: t.reason } : classify(t))

function rowOf(t: Track): Row {
  const reason = reasonOf(t)
  return {
    key: t.key, app: t.app, keys: [t.key], title: t.title, detail: t.detail, tries: t.tries, since: t.firstMissingAt, reason,
    ...(t.gaveUpAt ? { gaveUpAt: t.gaveUpAt, action: t.action } : {}),
  }
}

/** "This would give up on 12 TV episodes (3 series), 4 films." */
export function summarise(byApp: Partial<Record<App, Track[]>>): string {
  const parts: string[] = []
  for (const app of APPS) {
    const l = byApp[app]
    if (!l?.length) continue
    const w = l.length === 1 ? APP_WHAT[app].one : APP_WHAT[app].many
    if (app === 'sonarr') {
      const series = new Set(l.map(t => t.seriesId ?? t.title)).size
      parts.push(`${l.length} ${w} (${series} series)`)
    } else if (app === 'lidarr') {
      const artists = new Set(l.map(t => t.artistId ?? t.title)).size
      parts.push(`${l.length} ${w} (${artists} artist${artists === 1 ? '' : 's'})`)
    } else parts.push(`${l.length} ${w}`)
  }
  return parts.length ? `This would give up on ${parts.join(', ')}.` : 'Nothing would be given up today.'
}

/** Counts of each reason, most common first. */
export function reasonCounts(tracks: Track[]): Array<{ code: ReasonCode; text: string; count: number }> {
  const m = new Map<ReasonCode, number>()
  for (const t of tracks) { const c = classify(t).code; m.set(c, (m.get(c) ?? 0) + 1) }
  return [...m].map(([code, count]) => ({ code, count, text: REASON_LABEL[code] })).sort((a, b) => b.count - a.count)
}

export const REASON_LABEL: Record<ReasonCode, string> = {
  'not-searched': 'Not searched for yet',
  'import-failed': 'Downloaded, could not be imported',
  'download-failed': 'Download failed',
  'never-finished': 'Grabbed, download never finished',
  'none-found': 'No release found at all',
  'all-rejected': 'Releases found, all rejected',
  acceptable: 'An acceptable release exists',
  'nothing-usable': 'Nothing usable found',
}

/** The given-up notification, or null when nothing was given up. */
export function giveUpMessage(given: Track[]): { title: string; lines: string[]; plain: string[] } | null {
  if (!given.length) return null
  const byApp: Partial<Record<App, Track[]>> = {}
  for (const t of given) (byApp[t.app] ??= []).push(t)
  const parts = APPS.filter(a => byApp[a]?.length).map(a => `${byApp[a]!.length} ${byApp[a]!.length === 1 ? APP_WHAT[a].one : APP_WHAT[a].many}`)
  const shown = rows(given).slice(0, 10).map(r => `${r.title}${r.detail ? ` ${r.detail}` : ''}`)
  const more = rows(given).length - shown.length
  return {
    title: `Arr Stack gave up on ${parts.join(', ')}`,
    lines: [...shown, ...(more > 0 ? [`and ${more} more`] : []), 'Nothing was deleted. "Try again" on the Arr Stack page undoes it.'],
    plain: shown,
  }
}
