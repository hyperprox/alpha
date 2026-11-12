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

import { coverage, whyIncomplete, whyIncompleteLidarr, whyLidarr, whyRadarr, whySonarr, type AlbumInfo, type FileInfo } from './why'
export type { AlbumInfo, FileInfo }

export type Problem = 'failed' | 'blocked' | 'incomplete' | 'stalled' | 'warning'
/** Lower is worse. Used to float problems to the top. */
const SEVERITY: Record<Problem, number> = { failed: 0, blocked: 1, incomplete: 1, stalled: 2, warning: 3 }
const OK_RANK = 4
/** A download that is finished and only waiting to be cleared sorts after every real problem, before the rest. */
const DONE_RANK = 3.5

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
  /** Lidarr only (absent for TV and films): how many albums the download covers, and their tracks when known. */
  albums?: number
  tracks?: number
  problem: Problem | null
  /**
   * Finished and nothing left to import: everything it covers is already in the library. Not a problem; the person
   * can clear it from the queue. Always false when `problem` is set.
   */
  done: boolean
  /** "Why this download": what it fills, upgrades or skips (or, when done, what was imported and kept). Null when unknown. */
  why: string | null
  messages: string[]
  /** For a blocked or failed import that looks like a permissions problem: plain advice. Otherwise null. */
  hint: string | null
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
  /** Every download in it is done (and there is at least one). */
  done: boolean
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
  done: boolean
}

export interface QueueMovie extends QueueDownload { title: string; year: number | null }

/** Lidarr: one album (or a few, for a discography release) under an artist. */
export interface QueueAlbum {
  key: string
  /** The album's title; "A, B" for two albums in one release, "A +2 more" beyond that. */
  title: string
  downloads: QueueDownload[]
  /** Tracks the album(s) should have, when Lidarr says. */
  tracks: number
  size: number
  sizeLeft: number
  progress: number
  etaSec: number | null
  problem: Problem | null
  done: boolean
}

export interface QueueArtist {
  key: string
  title: string
  albums: QueueAlbum[]
  downloads: number
  /** Albums covered by the artist's downloads. */
  albumCount: number
  tracks: number
  size: number
  sizeLeft: number
  progress: number
  etaSec: number | null
  problem: Problem | null
  done: boolean
}

export interface QueueSummary {
  /** Collapsed downloads (not rows). */
  downloads: number
  shows: number
  movies: number
  /** Lidarr: artists with something in the queue, and the albums those downloads cover. 0 without Lidarr. */
  artists: number
  albums: number
  /** Raw queue rows before collapsing, to show how much was folded. */
  rows: number
  sizeLeft: number
  /** Failed, import-blocked or an incomplete pack: needs a person. */
  attention: number
  stalled: number
  warnings: number
  /** Finished downloads that only need clearing from the queue. Not counted in attention, stalled or warnings. */
  done: number
}

export interface QueueData {
  at: number
  services: { sonarr: { ok: boolean; error?: string; configured: boolean }; radarr: { ok: boolean; error?: string; configured: boolean }; lidarr: { ok: boolean; error?: string; configured: boolean } }
  summary: QueueSummary
  shows: QueueShow[]
  movies: QueueMovie[]
  /** Lidarr: Artist → Album → download. Empty without Lidarr. */
  artists: QueueArtist[]
  /** Added by the route: what the page may offer (moving a torrent up needs qBittorrent set). */
  capabilities?: { prioritise: boolean }
}

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const str = (v: unknown, max: number): string | null => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null }

/** Absolute paths (Unix or Windows) in an Arr message name the server's folders: the browser gets a plain phrase instead. */
export function stripPaths(text: string): string {
  return text
    .replace(/\b[A-Za-z]:\\[^\s"'<>|]*/g, 'the download folder')
    .replace(/(^|[\s"'(\[:=])\/(?:[^\s"'<>|\/]+\/)*[^\s"'<>|\/]*(?=$|[\s"')\],;])/g, (m, pre) => (m.length - pre.length > 1 ? `${pre}the download folder` : m))
}

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

export function problemOf(rows: any[]): Problem | null {
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

/** Sonarr's, Radarr's and Lidarr's top-line summary of an import that skipped something. Says nothing a per-file message does not. */
const SUMMARY_LINE = /^one or more (?:episodes?|movies?|files?|albums?|tracks?) expected in this release (?:were|was) not imported or missing/i
/**
 * The two per-file messages that mean "nothing is left to import for this one". Lidarr says "Track file already
 * imported" and "Not an upgrade for existing track file(s)": both are caught by the same two patterns.
 */
const ALREADY_HANDLED = /\balready imported\b|^not an upgrade for existing\b/i

/** Every message text on the rows, untouched (no path stripping, no cap): for classification, not display. */
function rawMessages(rows: any[]): { texts: string[]; error: boolean } {
  const texts: string[] = []
  let error = false
  for (const r of rows) {
    if (String(r.errorMessage ?? '').trim()) error = true
    for (const m of r.statusMessages ?? []) {
      const list: unknown[] = Array.isArray(m?.messages) && m.messages.length ? m.messages : [m?.title]
      for (const t of list) { const x = String(t ?? '').trim(); if (x) texts.push(x) }
    }
  }
  return { texts, error }
}

/**
 * The queue rows say a finished download has nothing left to import. All of: every row is importBlocked or importPending; every row is at 100%
 * (nothing left to fetch); the download did not fail; at least one per-file message exists; and EVERY message is either
 * "already imported", "Not an upgrade for existing ..." or the top-line summary. Any other message (no files eligible,
 * wrong match, permissions, a sample, a missing file) means a person still has something to look at, so it is not done.
 */
export function messagesSayDone(rows: any[]): boolean {
  if (!rows.length) return false
  for (const r of rows) {
    const state = String(r.trackedDownloadState ?? '')
    if (state !== 'importBlocked' && state !== 'importPending') return false
    if (String(r.status ?? '') === 'failed' || String(r.trackedDownloadStatus ?? '') === 'error') return false
    if (!(num(r.size) > 0) || num(r.sizeleft) !== 0) return false
  }
  const { texts, error } = rawMessages(rows)
  if (error || !texts.length) return false
  let handled = 0
  for (const t of texts) {
    if (SUMMARY_LINE.test(t)) continue
    if (ALREADY_HANDLED.test(t)) { handled++; continue }
    return false
  }
  return handled > 0
}

/** The per-file names in the messages ("Example.Show.S02E01E02.1080p"): which files the release really held. */
function messageTitles(rows: any[]): string[] {
  return rows.flatMap(r => (r.statusMessages ?? []).map((m: any) => String(m?.title ?? ''))).filter(Boolean)
}

/** Every episode (or the film) the download covers has a file now. Without a lookup nothing can be vouched for: false. */
function filesAllThere(rows: any[], info?: Map<number, FileInfo>): boolean {
  if (!info) return false
  const eps = rows.map(r => Number(r.episodeId ?? r.episode?.id)).filter(n => Number.isInteger(n) && n > 0)
  if (eps.length) return coverage(eps, info).unknown === 0 && coverage(eps, info).missing.length === 0
  const movie = Number(rows[0]?.movieId ?? rows[0]?.movie?.id)
  return Number.isInteger(movie) && movie > 0 && info.get(movie)?.hasFile === true
}

/**
 * Done: the messages say nothing is left to import AND every episode (or the film) it covers has a file now. A pack that
 * claims more episodes than it held is not done, however its messages read: see `incompleteOf`.
 */
export function isDone(rows: any[], info?: Map<number, FileInfo>): boolean {
  return messagesSayDone(rows) && filesAllThere(rows, info)
}

/** Messages say "already imported" but some episodes it covers have no file, so Sonarr will never search for them. */
export function isIncomplete(rows: any[], info?: Map<number, FileInfo>): boolean {
  if (!info || !messagesSayDone(rows)) return false
  const eps = rows.map(r => Number(r.episodeId ?? r.episode?.id)).filter(n => Number.isInteger(n) && n > 0)
  if (!eps.length) return false
  const cov = coverage(eps, info)
  return cov.unknown === 0 && cov.missing.length > 0
}

/** For a permission problem, a hint. Text only: HyperProx changes no permissions. */
export function importHint(messages: string[]): string | null {
  return messages.some(m => /permission|access (to the path )?.*denied|not writable|read-only file system|operation not permitted/i.test(m))
    ? 'This looks like a permissions problem: the Arr cannot read or write the download folder. HyperProx does not change permissions. Check that the folder belongs to the user the Arr runs as, then retry.'
    : null
}

function messagesOf(rows: any[]): string[] {
  const out = new Set<string>()
  for (const r of rows) {
    if (r.errorMessage) out.add(stripPaths(String(r.errorMessage)).slice(0, 240))
    for (const m of r.statusMessages ?? []) for (const t of (m?.messages?.length ? m.messages : [m?.title])) if (t) out.add(stripPaths(String(t)).slice(0, 240))
  }
  return [...out].slice(0, 6)
}

/** Rows that share a downloadId are one download. Rows with none stand alone. */
export function collapseByDownload(rows: any[]): Array<{ id: string; rows: any[] }> {
  const by = new Map<string, any[]>()
  let anon = 0
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const k = r.downloadId ? `d:${r.downloadId}` : r.id != null ? `i:${r.id}` : `n:${anon++}`
    const l = by.get(k); if (l) l.push(r); else by.set(k, [r])
  }
  return [...by.entries()].map(([id, rs]) => ({ id, rows: rs }))
}

function downloadOf(id: string, rows: any[], now: number, episodic: boolean, info?: Map<number, FileInfo>): QueueDownload {
  const first = rows[0]
  // Every row of a pack reports the pack's size, so take it once. Never sum it.
  const size = Math.max(...rows.map(r => num(r.size)))
  const sizeLeft = Math.min(size, Math.max(...rows.map(r => num(r.sizeleft))))
  let etaSec: number | null = null
  for (const r of rows) {
    const t = parseTimeLeft(r.timeleft) ?? (r.estimatedCompletionTime ? Math.round((Date.parse(r.estimatedCompletionTime) - now) / 1000) : null)
    if (t !== null && t > 0 && t < 8_640_000 && (etaSec === null || t > etaSec)) etaSec = t
  }
  const done = isDone(rows, info)
  const incomplete = !done && isIncomplete(rows, info)
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
    problem: done ? null : incomplete ? 'incomplete' : problemOf(rows),
    done,
    why: info ? (incomplete ? whyIncomplete(rows.map(r => Number(r.episodeId ?? r.episode?.id)), info, messageTitles(rows)) : whyOf(rows, info, episodic, done)) : null,
    messages: messagesOf(rows),
    hint: (() => { const p = done || incomplete ? null : problemOf(rows); return p === 'blocked' || p === 'failed' ? importHint(messagesOf(rows)) : null })(),
  }
}

function whyOf(rows: any[], info: Map<number, FileInfo>, episodic: boolean, done: boolean): string | null {
  const release = str(rows[0]?.quality?.quality?.name, 40)
  if (!episodic) {
    const id = Number(rows[0]?.movieId ?? rows[0]?.movie?.id)
    return whyRadarr(info.get(id), release, done)
  }
  const ids = rows.map(r => Number(r.episodeId ?? r.episode?.id)).filter(n => Number.isInteger(n) && n > 0)
  return whySonarr(ids, info, release, done)
}


// ── Lidarr (music) ───────────────────────────────────────────────────────────

const albumIdOfRow = (r: any): number | null => { const n = Number(r?.albumId ?? r?.album?.id); return Number.isInteger(n) && n > 0 ? n : null }

/** The albums a download covers, from the lookup. Null when any of them could not be looked up. */
function albumsOf(rows: any[], info?: Map<number, AlbumInfo>): AlbumInfo[] | null {
  if (!info) return null
  const ids = [...new Set(rows.map(albumIdOfRow).filter((n): n is number => n !== null))]
  if (!ids.length) return null
  const out: AlbumInfo[] = []
  for (const id of ids) { const a = info.get(id); if (!a) return null; out.push(a) }
  return out
}

/** Every album the download covers has all its tracks on disk now. Without a lookup nothing can be vouched for: false. */
function tracksAllThere(rows: any[], info?: Map<number, AlbumInfo>): boolean {
  const albums = albumsOf(rows, info)
  return !!albums && albums.every(a => a.total !== null && a.have >= a.total)
}

/** Done: the messages say nothing is left to import AND every album it covers has all its tracks. */
export function isDoneMusic(rows: any[], info?: Map<number, AlbumInfo>): boolean {
  return messagesSayDone(rows) && tracksAllThere(rows, info)
}

/** The messages say "already imported" but some tracks it covers have no file, so Lidarr will never search for them. */
export function isIncompleteMusic(rows: any[], info?: Map<number, AlbumInfo>): boolean {
  if (!messagesSayDone(rows)) return false
  const albums = albumsOf(rows, info)
  return !!albums && albums.every(a => a.total !== null) && albums.some(a => a.have < (a.total as number))
}

function musicDownloadOf(id: string, rows: any[], now: number, info?: Map<number, AlbumInfo>): QueueDownload {
  // Sizes, ETA, client and messages are read the same way for every Arr; only what "done" and "why" mean differs.
  const base = downloadOf(id, rows, now, false, undefined)
  const done = isDoneMusic(rows, info)
  const incomplete = !done && isIncompleteMusic(rows, info)
  const problem: Problem | null = done ? null : incomplete ? 'incomplete' : base.problem
  const albums = albumsOf(rows, info)
  const albumIds = new Set(rows.map(albumIdOfRow).filter((n): n is number => n !== null))
  const tracks = albums && albums.every(a => a.total !== null) ? albums.reduce((t, a) => t + (a.total as number), 0) : 0
  const release = str(rows[0]?.quality?.quality?.name, 40)
  return {
    ...base,
    albums: albumIds.size, ...(tracks ? { tracks } : {}),
    problem, done,
    why: albums ? (incomplete ? whyIncompleteLidarr(albums) : whyLidarr(albums, release, done)) : null,
    hint: problem === 'blocked' || problem === 'failed' ? importHint(messagesOf(rows)) : null,
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
const rank = (x: { problem: Problem | null; done?: boolean }) => (x.problem !== null ? SEVERITY[x.problem] : x.done ? DONE_RANK : OK_RANK)

/** Problems first, then finished-and-waiting-to-clear; then soonest finished; unknown ETA after known; then furthest along; then name. */
function cmp(a: { problem: Problem | null; done?: boolean; etaSec: number | null; progress: number }, b: typeof a, an: string, bn: string): number {
  return rank(a) - rank(b)
    || (a.etaSec ?? Infinity) - (b.etaSec ?? Infinity) || 0
    || b.progress - a.progress
    || an.localeCompare(bn)
}

function etaMax(ds: Array<{ etaSec: number | null }>): number | null {
  const v = ds.map(d => d.etaSec).filter((x): x is number => x !== null)
  return v.length ? Math.max(...v) : null
}

export function groupSonarr(rows: any[], now = Date.now(), info?: Map<number, FileInfo>): QueueShow[] {
  const shows = new Map<string, { title: string; seasonMap: Map<string, QueueSeason> }>()
  for (const { id, rows: rs } of collapseByDownload(rows)) {
    const first = rs[0]
    const seriesKey = first.seriesId != null ? `s:${first.seriesId}` : `t:${first.series?.title ?? first.title ?? id}`
    const title = str(first.series?.title, 120) ?? (first.seriesId == null ? 'Unknown series' : `Series ${first.seriesId}`)
    const seasons = rs.map(r => num(r.seasonNumber ?? r.episode?.seasonNumber ?? -1)).filter(n => n >= 0)
    const dl = downloadOf(id, rs, now, true, info)
    let s = shows.get(seriesKey)
    if (!s) shows.set(seriesKey, s = { title, seasonMap: new Map() })
    const label = seasonLabel(seasons), key = [...new Set(seasons)].sort((a, b) => a - b).join(',') || 'unknown'
    let season = s.seasonMap.get(key)
    if (!season) s.seasonMap.set(key, season = { key, label, downloads: [], episodes: 0, size: 0, sizeLeft: 0, progress: 0, etaSec: null, problem: null, done: false })
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
      se.done = se.downloads.length > 0 && se.downloads.every(d => d.done)
    }
    seasons.sort((a, b) => cmp(a, b, a.label, b.label))
    const size = seasons.reduce((t, x) => t + x.size, 0), left = seasons.reduce((t, x) => t + x.sizeLeft, 0)
    out.push({
      key, title: s.title, seasons,
      downloads: seasons.reduce((t, x) => t + x.downloads.length, 0),
      episodes: seasons.reduce((t, x) => t + x.episodes, 0),
      size, sizeLeft: left, progress: pct(size, left), etaSec: etaMax(seasons),
      problem: seasons.reduce<Problem | null>((p, x) => worse(p, x.problem), null),
      done: seasons.length > 0 && seasons.every(x => x.done),
    })
  }
  return out.sort((a, b) => cmp(a, b, a.title, b.title))
}

export function groupRadarr(rows: any[], now = Date.now(), info?: Map<number, FileInfo>): QueueMovie[] {
  return collapseByDownload(rows).map(({ id, rows: rs }) => {
    const first = rs[0]
    return {
      ...downloadOf(id, rs, now, false, info),
      title: str(first.movie?.title, 120) ?? str(first.title, 120) ?? 'Unknown movie',
      year: first.movie?.year ? num(first.movie.year) : null,
    }
  }).sort((a, b) => cmp(a, b, a.title, b.title))
}


const albumTitle = (titles: string[]): string => {
  const u = [...new Set(titles.filter(Boolean))]
  if (!u.length) return 'Unknown album'
  return u.length <= 2 ? u.join(', ') : `${u[0]} +${u.length - 1} more`
}

/** Lidarr's queue, collapsed by downloadId and grouped Artist → Album → download. */
export function groupLidarr(rows: any[], now = Date.now(), info?: Map<number, AlbumInfo>): QueueArtist[] {
  const artists = new Map<string, { title: string; albumMap: Map<string, QueueAlbum> }>()
  for (const { id, rows: rs } of collapseByDownload(rows)) {
    const first = rs[0]
    const artistId = Number(first.artistId ?? first.artist?.id)
    const artistKey = Number.isInteger(artistId) && artistId > 0 ? `a:${artistId}` : `t:${first.artist?.artistName ?? first.title ?? id}`
    const title = str(first.artist?.artistName, 120) ?? (artistKey.startsWith('a:') ? `Artist ${artistId}` : 'Unknown artist')
    const dl = musicDownloadOf(id, rs, now, info)
    const ids = [...new Set(rs.map(albumIdOfRow).filter((n): n is number => n !== null))].sort((a, b) => a - b)
    const key = ids.join(',') || 'unknown'
    const albumNames = [...new Map(rs.map(r => [albumIdOfRow(r) ?? -1, str(r.album?.title, 120) ?? ''])).values()]
    let a = artists.get(artistKey)
    if (!a) artists.set(artistKey, a = { title, albumMap: new Map() })
    let album = a.albumMap.get(key)
    if (!album) a.albumMap.set(key, album = { key, title: albumTitle(albumNames), downloads: [], tracks: 0, size: 0, sizeLeft: 0, progress: 0, etaSec: null, problem: null, done: false })
    album.downloads.push(dl)
  }

  const out: QueueArtist[] = []
  for (const [key, a] of artists) {
    const albums = [...a.albumMap.values()]
    for (const al of albums) {
      al.downloads.sort((x, y) => cmp(x, y, x.name, y.name))
      al.tracks = al.downloads.reduce((t, d) => Math.max(t, d.tracks ?? 0), 0)
      al.size = al.downloads.reduce((t, d) => t + d.size, 0)
      al.sizeLeft = al.downloads.reduce((t, d) => t + d.sizeLeft, 0)
      al.progress = pct(al.size, al.sizeLeft)
      al.etaSec = etaMax(al.downloads)
      al.problem = al.downloads.reduce<Problem | null>((p, d) => worse(p, d.problem), null)
      al.done = al.downloads.length > 0 && al.downloads.every(d => d.done)
    }
    albums.sort((x, y) => cmp(x, y, x.title, y.title))
    const size = albums.reduce((t, x) => t + x.size, 0), left = albums.reduce((t, x) => t + x.sizeLeft, 0)
    out.push({
      key, title: a.title, albums,
      downloads: albums.reduce((t, x) => t + x.downloads.length, 0),
      albumCount: new Set(albums.flatMap(x => x.key.split(',')).filter(k => k !== 'unknown')).size,
      tracks: albums.reduce((t, x) => t + x.tracks, 0),
      size, sizeLeft: left, progress: pct(size, left), etaSec: etaMax(albums),
      problem: albums.reduce<Problem | null>((p, x) => worse(p, x.problem), null),
      done: albums.length > 0 && albums.every(x => x.done),
    })
  }
  return out.sort((x, y) => cmp(x, y, x.title, y.title))
}

export function summarize(shows: QueueShow[], movies: QueueMovie[], rows: number, artists: QueueArtist[] = []): QueueSummary {
  const all: QueueDownload[] = [...shows.flatMap(s => s.seasons.flatMap(x => x.downloads)), ...movies, ...artists.flatMap(a => a.albums.flatMap(x => x.downloads))]
  return {
    downloads: all.length, shows: shows.length, movies: movies.length,
    artists: artists.length, albums: artists.reduce((t, a) => t + a.albumCount, 0), rows,
    sizeLeft: all.reduce((t, d) => t + d.sizeLeft, 0),
    attention: all.filter(d => d.problem === 'failed' || d.problem === 'blocked' || d.problem === 'incomplete').length,
    stalled: all.filter(d => d.problem === 'stalled').length,
    warnings: all.filter(d => d.problem === 'warning').length,
    done: all.filter(d => d.done).length,
  }
}

export function buildQueueData(input: {
  sonarr: { rows: any[] | null; error?: string; configured: boolean; info?: Map<number, FileInfo> }
  radarr: { rows: any[] | null; error?: string; configured: boolean; info?: Map<number, FileInfo> }
  /** Optional: absent when Lidarr is not set up, which reads as "not configured". */
  lidarr?: { rows: any[] | null; error?: string; configured: boolean; info?: Map<number, AlbumInfo> }
  now?: number
}): QueueData {
  const now = input.now ?? Date.now()
  const shows = input.sonarr.rows ? groupSonarr(input.sonarr.rows, now, input.sonarr.info) : []
  const movies = input.radarr.rows ? groupRadarr(input.radarr.rows, now, input.radarr.info) : []
  const lid = input.lidarr ?? { rows: null, configured: false }
  const artists = lid.rows ? groupLidarr(lid.rows, now, lid.info) : []
  const state = (x: { rows: any[] | null; error?: string; configured: boolean }) => ({ ok: x.rows !== null, configured: x.configured, ...(x.error ? { error: x.error.slice(0, 160) } : {}) })
  return {
    at: now,
    services: { sonarr: state(input.sonarr), radarr: state(input.radarr), lidarr: input.lidarr ? state(input.lidarr) : { ok: true, configured: false } },
    summary: summarize(shows, movies, (input.sonarr.rows?.length ?? 0) + (input.radarr.rows?.length ?? 0) + (lid.rows?.length ?? 0), artists),
    shows, movies, artists,
  }
}

/** Every page of a queue. `get` is a read-only client call; a missing total or an empty page ends the loop. */
export async function readAllQueue(get: (path: string, timeoutMs?: number) => Promise<any>, kind: 'sonarr' | 'radarr' | 'lidarr', maxPages = 50): Promise<any[]> {
  // Lidarr's API is v1; Sonarr's and Radarr's is v3.
  const extra = kind === 'sonarr'
    ? 'includeUnknownSeriesItems=true&includeSeries=true&includeEpisode=true'
    : kind === 'lidarr' ? 'includeUnknownArtistItems=true&includeArtist=true&includeAlbum=true'
    : 'includeUnknownMovieItems=true&includeMovie=true'
  const out: any[] = []
  for (let page = 1; page <= maxPages; page++) {
    const r = await get(`/api/${kind === 'lidarr' ? 'v1' : 'v3'}/queue?page=${page}&pageSize=200&${extra}`, 20_000)
    const recs: any[] = Array.isArray(r?.records) ? r.records : []
    out.push(...recs)
    if (!recs.length || out.length >= num(r?.totalRecords)) break
  }
  return out
}
