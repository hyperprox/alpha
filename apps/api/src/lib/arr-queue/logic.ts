// =============================================================================
//  HyperProx — Arr Stack queue, grouped (pure)
//
//  Sonarr returns ONE queue row per episode, so a 23-episode season pack is 23
//  rows that share a downloadId (and each reports the whole pack's size). This
//  collapses rows into downloads by downloadId, then groups Show → Season →
//  download, so 200+ rows become a handful of things a person can read.
//
//  Pure: no network, no clock unless one is passed. Only reads queue rows; it
//  never sends the downloader's output path, a host or a key to the browser.
// =============================================================================

export type Problem = 'failed' | 'blocked' | 'stalled' | 'warning'
/** Lower is worse. Used to float problems to the top. */
const SEVERITY: Record<Problem, number> = { failed: 0, blocked: 1, stalled: 2, warning: 3 }
const OK_RANK = 4

export interface QueueDownload {
  id: string
  /** The release name as the indexer published it. */
  name: string
  size: number
  sizeLeft: number
  /** 0–100, one decimal. */
  progress: number
  etaSec: number | null
  status: string
  state: string
  quality: string | null
  protocol: string | null
  client: string | null
  indexer: string | null
  episodes: number
  /** "E01–E23", "E01–E05, E08", or null for a movie. */
  episodeRange: string | null
  problem: Problem | null
  messages: string[]
}

export interface QueueSeason {
  key: string
  /** "S02", "S01–S03" for a pack spanning seasons, "Specials" for season 0, "Unknown season". */
  label: string
  downloads: QueueDownload[]
  episodes: number
  size: number
  sizeLeft: number
  progress: number
  etaSec: number | null
  problem: Problem | null
}

export interface QueueShow {
  key: string
  title: string
  seasons: QueueSeason[]
  downloads: number
  episodes: number
  size: number
  sizeLeft: number
  progress: number
  etaSec: number | null
  problem: Problem | null
}

export interface QueueMovie extends QueueDownload { title: string; year: number | null }

export interface QueueSummary {
  /** Collapsed downloads (not rows). */
  downloads: number
  shows: number
  movies: number
  /** Raw queue rows before collapsing, to show how much was folded. */
  rows: number
  sizeLeft: number
  /** Failed or import-blocked: needs a person. */
  attention: number
  stalled: number
  warnings: number
}

export interface QueueData {
  at: number
  services: { sonarr: { ok: boolean; error?: string; configured: boolean }; radarr: { ok: boolean; error?: string; configured: boolean } }
  summary: QueueSummary
  shows: QueueShow[]
  movies: QueueMovie[]
}

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const str = (v: unknown, max: number): string | null => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null }

/** "00:12:34", "1.02:03:04" or "12:34" read as seconds. Null when absent or unreadable. */
export function parseTimeLeft(v: unknown): number | null {
  const s = String(v ?? '').trim()
  const m = /^(?:(\d+)\.)?(\d{1,3}):(\d{2})(?::(\d{2}))?$/.exec(s)
  if (!m) return null
  const sec = m[4] === undefined
    ? Number(m[2]) * 60 + Number(m[3])
    : (Number(m[1] ?? 0) * 24 + Number(m[2])) * 3600 + Number(m[3]) * 60 + Number(m[4])
  return sec > 0 && sec < 8_640_000 ? sec : null
}

const pct = (size: number, left: number): number =>
  size > 0 ? Math.max(0, Math.min(100, Math.round(((size - left) / size) * 1000) / 10)) : 0

const pad = (n: number) => String(n).padStart(2, '0')

/** [1,2,3,5] → "E01–E03, E05". More than three runs is cut with a count. */
export function episodeRange(eps: number[]): string | null {
  const u = [...new Set(eps.filter(n => Number.isFinite(n) && n >= 0))].sort((a, b) => a - b)
  if (!u.length) return null
  const runs: string[] = []
  let a = u[0], b = u[0]
  const flush = () => runs.push(a === b ? `E${pad(a)}` : `E${pad(a)}–E${pad(b)}`)
  for (const n of u.slice(1)) { if (n === b + 1) b = n; else { flush(); a = b = n } }
  flush()
  return runs.length > 3 ? `${runs.slice(0, 3).join(', ')} +${runs.length - 3} more` : runs.join(', ')
}

function problemOf(rows: any[]): Problem | null {
  let worst: Problem | null = null
  const bump = (p: Problem) => { if (worst === null || SEVERITY[p] < SEVERITY[worst]) worst = p }
  for (const r of rows) {
    const state = String(r.trackedDownloadState ?? ''), tracked = String(r.trackedDownloadStatus ?? ''), status = String(r.status ?? '')
    const text = [r.errorMessage, ...(r.statusMessages ?? []).flatMap((m: any) => [m?.title, ...(m?.messages ?? [])])].join(' ')
    if (status === 'failed' || state === 'failed' || state === 'failedPending') bump('failed')
    else if (tracked === 'error') bump(state === 'importBlocked' || state === 'importPending' ? 'blocked' : 'failed')
    else if (state === 'importBlocked' || state === 'importFailed') bump('blocked')
    else if (/stalled/i.test(text)) bump('stalled')
    else if (tracked === 'warning' || status === 'warning' || status === 'downloadClientUnavailable') bump('warning')
  }
  return worst
}

function messagesOf(rows: any[]): string[] {
  const out = new Set<string>()
  for (const r of rows) {
    if (r.errorMessage) out.add(String(r.errorMessage).slice(0, 240))
    for (const m of r.statusMessages ?? []) for (const t of (m?.messages?.length ? m.messages : [m?.title])) if (t) out.add(String(t).slice(0, 240))
  }
  return [...out].slice(0, 6)
}

/** Rows that share a downloadId are one download. Rows with none stand alone. */
export function collapseByDownload(rows: any[]): Array<{ id: string; rows: any[] }> {
  const by = new Map<string, any[]>()
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const k = r.downloadId ? `d:${r.downloadId}` : `i:${r.id ?? by.size}`
    const l = by.get(k); if (l) l.push(r); else by.set(k, [r])
  }
  return [...by.entries()].map(([id, rs]) => ({ id, rows: rs }))
}

function downloadOf(id: string, rows: any[], now: number, episodic: boolean): QueueDownload {
  const first = rows[0]
  // Every row of a pack reports the pack's size, so take it once. Never sum it.
  const size = Math.max(...rows.map(r => num(r.size)))
  const sizeLeft = Math.min(size, Math.max(...rows.map(r => num(r.sizeleft))))
  let etaSec: number | null = null
  for (const r of rows) {
    const t = parseTimeLeft(r.timeleft) ?? (r.estimatedCompletionTime ? Math.round((Date.parse(r.estimatedCompletionTime) - now) / 1000) : null)
    if (t !== null && t > 0 && t < 8_640_000 && (etaSec === null || t > etaSec)) etaSec = t
  }
  const epIds = new Set(rows.map(r => r.episodeId ?? r.episode?.id ?? r.id))
  const bySeason = rows.map(r => num(r.episode?.episodeNumber ?? r.episodeNumber)).filter(n => n > 0)
  return {
    id,
    name: str(first.title, 240) ?? 'unknown release',
    size, sizeLeft, progress: pct(size, sizeLeft), etaSec,
    status: String(first.status ?? ''),
    state: String(first.trackedDownloadState ?? ''),
    quality: str(first.quality?.quality?.name, 40),
    protocol: str(first.protocol, 20),
    client: str(first.downloadClient, 60),
    indexer: str(first.indexer, 60),
    episodes: episodic ? epIds.size : 0,
    episodeRange: episodic ? episodeRange(bySeason) : null,
    problem: problemOf(rows),
    messages: messagesOf(rows),
  }
}

const seasonLabel = (seasons: number[]): string => {
  const u = [...new Set(seasons)].sort((a, b) => a - b)
  if (!u.length) return 'Unknown season'
  const one = (n: number) => (n === 0 ? 'Specials' : `S${pad(n)}`)
  if (u.length === 1) return one(u[0])
  const contiguous = u.every((n, i) => i === 0 || n === u[i - 1] + 1)
  return contiguous ? `${one(u[0])}–${one(u[u.length - 1])}` : u.map(one).join(', ')
}

const worse = (a: Problem | null, b: Problem | null): Problem | null =>
  a === null ? b : b === null ? a : SEVERITY[a] <= SEVERITY[b] ? a : b
const rank = (p: Problem | null) => (p === null ? OK_RANK : SEVERITY[p])

/** Problems first; then soonest finished; unknown ETA after known; then furthest along; then name. */
function cmp(a: { problem: Problem | null; etaSec: number | null; progress: number }, b: typeof a, an: string, bn: string): number {
  return rank(a.problem) - rank(b.problem)
    || (a.etaSec ?? Infinity) - (b.etaSec ?? Infinity) || 0
    || b.progress - a.progress
    || an.localeCompare(bn)
}

function etaMax(ds: Array<{ etaSec: number | null }>): number | null {
  const v = ds.map(d => d.etaSec).filter((x): x is number => x !== null)
  return v.length ? Math.max(...v) : null
}

export function groupSonarr(rows: any[], now = Date.now()): QueueShow[] {
  const shows = new Map<string, { title: string; seasonMap: Map<string, QueueSeason> }>()
  for (const { id, rows: rs } of collapseByDownload(rows)) {
    const first = rs[0]
    const seriesKey = first.seriesId != null ? `s:${first.seriesId}` : `t:${first.series?.title ?? first.title ?? id}`
    const title = str(first.series?.title, 120) ?? (first.seriesId == null ? 'Unknown series' : `Series ${first.seriesId}`)
    const seasons = rs.map(r => num(r.seasonNumber ?? r.episode?.seasonNumber ?? -1)).filter(n => n >= 0)
    const dl = downloadOf(id, rs, now, true)
    let s = shows.get(seriesKey)
    if (!s) shows.set(seriesKey, s = { title, seasonMap: new Map() })
    const label = seasonLabel(seasons), key = [...new Set(seasons)].sort((a, b) => a - b).join(',') || 'unknown'
    let season = s.seasonMap.get(key)
    if (!season) s.seasonMap.set(key, season = { key, label, downloads: [], episodes: 0, size: 0, sizeLeft: 0, progress: 0, etaSec: null, problem: null })
    season.downloads.push(dl)
  }

  const out: QueueShow[] = []
  for (const [key, s] of shows) {
    const seasons = [...s.seasonMap.values()]
    for (const se of seasons) {
      se.downloads.sort((a, b) => cmp(a, b, a.name, b.name))
      se.episodes = se.downloads.reduce((t, d) => t + d.episodes, 0)
      se.size = se.downloads.reduce((t, d) => t + d.size, 0)
      se.sizeLeft = se.downloads.reduce((t, d) => t + d.sizeLeft, 0)
      se.progress = pct(se.size, se.sizeLeft)
      se.etaSec = etaMax(se.downloads)
      se.problem = se.downloads.reduce<Problem | null>((p, d) => worse(p, d.problem), null)
    }
    seasons.sort((a, b) => cmp(a, b, a.label, b.label))
    const size = seasons.reduce((t, x) => t + x.size, 0), left = seasons.reduce((t, x) => t + x.sizeLeft, 0)
    out.push({
      key, title: s.title, seasons,
      downloads: seasons.reduce((t, x) => t + x.downloads.length, 0),
      episodes: seasons.reduce((t, x) => t + x.episodes, 0),
      size, sizeLeft: left, progress: pct(size, left), etaSec: etaMax(seasons),
      problem: seasons.reduce<Problem | null>((p, x) => worse(p, x.problem), null),
    })
  }
  return out.sort((a, b) => cmp(a, b, a.title, b.title))
}

export function groupRadarr(rows: any[], now = Date.now()): QueueMovie[] {
  return collapseByDownload(rows).map(({ id, rows: rs }) => {
    const first = rs[0]
    return {
      ...downloadOf(id, rs, now, false),
      title: str(first.movie?.title, 120) ?? str(first.title, 120) ?? 'Unknown movie',
      year: first.movie?.year ? num(first.movie.year) : null,
    }
  }).sort((a, b) => cmp(a, b, a.title, b.title))
}

export function summarize(shows: QueueShow[], movies: QueueMovie[], rows: number): QueueSummary {
  const all: QueueDownload[] = [...shows.flatMap(s => s.seasons.flatMap(x => x.downloads)), ...movies]
  return {
    downloads: all.length, shows: shows.length, movies: movies.length, rows,
    sizeLeft: all.reduce((t, d) => t + d.sizeLeft, 0),
    attention: all.filter(d => d.problem === 'failed' || d.problem === 'blocked').length,
    stalled: all.filter(d => d.problem === 'stalled').length,
    warnings: all.filter(d => d.problem === 'warning').length,
  }
}

export function buildQueueData(input: {
  sonarr: { rows: any[] | null; error?: string; configured: boolean }
  radarr: { rows: any[] | null; error?: string; configured: boolean }
  now?: number
}): QueueData {
  const now = input.now ?? Date.now()
  const shows = input.sonarr.rows ? groupSonarr(input.sonarr.rows, now) : []
  const movies = input.radarr.rows ? groupRadarr(input.radarr.rows, now) : []
  const state = (x: typeof input.sonarr) => ({ ok: x.rows !== null, configured: x.configured, ...(x.error ? { error: x.error.slice(0, 160) } : {}) })
  return {
    at: now,
    services: { sonarr: state(input.sonarr), radarr: state(input.radarr) },
    summary: summarize(shows, movies, (input.sonarr.rows?.length ?? 0) + (input.radarr.rows?.length ?? 0)),
    shows, movies,
  }
}

/** Every page of a queue. `get` is a read-only client call; a missing total or an empty page ends the loop. */
export async function readAllQueue(get: (path: string, timeoutMs?: number) => Promise<any>, kind: 'sonarr' | 'radarr', maxPages = 50): Promise<any[]> {
  const extra = kind === 'sonarr'
    ? 'includeUnknownSeriesItems=true&includeSeries=true&includeEpisode=true'
    : 'includeUnknownMovieItems=true&includeMovie=true'
  const out: any[] = []
  for (let page = 1; page <= maxPages; page++) {
    const r = await get(`/api/v3/queue?page=${page}&pageSize=200&${extra}`, 20_000)
    const recs: any[] = Array.isArray(r?.records) ? r.records : []
    out.push(...recs)
    if (!recs.length || out.length >= num(r?.totalRecords)) break
  }
  return out
}
