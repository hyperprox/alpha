// =============================================================================
//  HyperProx — Arr Stack queue, what is on disk for the queued episodes and films (read-only)
//
//  Feeds "Why this download". Runs inside the shared queue reading, so it costs a few batched requests per reading,
//  never one per queue row: the episodes of every queued download in batches of 100 (Sonarr), then the files those
//  episodes point at. A file's quality never changes under its id, so files are cached for 60 seconds by id; the
//  episodes themselves are read every time, so "has a file" is as fresh as the queue. Radarr's queue rows already carry
//  the film and its file id, so only the files are asked for. Any failure leaves the answer out; it never fails the queue.
// =============================================================================

import type { AlbumInfo, FileInfo } from './why'

type Get = (path: string, timeoutMs?: number) => Promise<any>

export class FileCache {
  private m = new Map<string, { at: number; v: string | null }>()
  constructor(private ttlMs = 60_000, private max = 5000) {}
  get(k: string, now: number): { v: string | null } | undefined {
    const e = this.m.get(k)
    if (!e) return undefined
    if (now - e.at > this.ttlMs) { this.m.delete(k); return undefined }
    return { v: e.v }
  }
  set(k: string, v: string | null, now: number) {
    if (this.m.size >= this.max) this.m.clear()
    this.m.set(k, { at: now, v })
  }
}

export const sharedFileCache = new FileCache()

const BATCH = 100
const MAX_IDS = 1000
const posInt = (v: unknown): number | null => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null }
const qname = (f: any): string | null => { const s = f?.quality?.quality?.name; return typeof s === 'string' && s ? s.slice(0, 40) : null }
const batches = <T,>(xs: T[]): T[][] => { const o: T[][] = []; for (let i = 0; i < xs.length; i += BATCH) o.push(xs.slice(i, i + BATCH)); return o }

/** Quality by file id, from the cache or one batched request per 100 ids. Ids Sonarr or Radarr did not return stay unknown. */
async function fileQualities(get: Get, path: string, param: string, ids: number[], prefix: string, cache: FileCache, now: number): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>()
  const need: number[] = []
  for (const id of ids) { const c = cache.get(`${prefix}:${id}`, now); if (c) out.set(id, c.v); else need.push(id) }
  for (const b of batches(need)) {
    const recs = await get(`${path}?${b.map(i => `${param}=${i}`).join('&')}`, 15_000)
    for (const f of Array.isArray(recs) ? recs : []) {
      const id = posInt(f?.id); if (id === null) continue
      const q = qname(f)
      out.set(id, q); cache.set(`${prefix}:${id}`, q, now)
    }
  }
  return out
}

/** Sonarr: episode id → what is on disk. Empty (never throws) when anything fails. */
export async function readEpisodeInfo(get: Get, rows: any[], now: number, cache: FileCache = sharedFileCache): Promise<Map<number, FileInfo>> {
  const out = new Map<number, FileInfo>()
  try {
    const ids = [...new Set(rows.map(r => posInt(r?.episodeId ?? r?.episode?.id)).filter((n): n is number => n !== null))].slice(0, MAX_IDS)
    const eps: any[] = []
    for (const b of batches(ids)) {
      const recs = await get(`/api/v3/episode?${b.map(i => `episodeIds=${i}`).join('&')}`, 15_000)
      if (Array.isArray(recs)) eps.push(...recs)
    }
    const fileIds = [...new Set(eps.map(e => (e?.hasFile ? posInt(e?.episodeFileId) : null)).filter((n): n is number => n !== null))]
    const q = fileIds.length ? await fileQualities(get, '/api/v3/episodefile', 'episodeFileIds', fileIds, 'ef', cache, now) : new Map<number, string | null>()
    for (const e of eps) {
      const id = posInt(e?.id); if (id === null) continue
      const fid = e.hasFile ? posInt(e.episodeFileId) : null
      out.set(id, {
        hasFile: !!e.hasFile, quality: fid !== null ? (q.get(fid) ?? null) : null,
        season: Number.isInteger(e.seasonNumber) ? e.seasonNumber : null, number: Number.isInteger(e.episodeNumber) ? e.episodeNumber : null,
      })
    }
  } catch { out.clear() }
  return out
}

/**
 * Radarr: movie id → what is on disk. Queue rows read with includeMovie carry `movie.movieFileId` (0 = no file) and no
 * `hasFile`. A film counts as having a file only when that id is positive AND /moviefile returned it: a failed lookup
 * vouches for nothing.
 */
export async function readMovieInfo(get: Get, rows: any[], now: number, cache: FileCache = sharedFileCache): Promise<Map<number, FileInfo>> {
  const out = new Map<number, FileInfo>()
  try {
    const movies = new Map<number, { fid: number | null; emb: string | null }>()
    for (const r of rows) {
      const id = posInt(r?.movieId ?? r?.movie?.id); if (id === null || movies.has(id)) continue
      movies.set(id, { fid: posInt(r?.movie?.movieFileId ?? r?.movie?.movieFile?.id), emb: qname(r?.movie?.movieFile) })
    }
    const fileIds = [...new Set([...movies.values()].map(m => m.fid).filter((n): n is number => n !== null))].slice(0, MAX_IDS)
    const q = fileIds.length ? await fileQualities(get, '/api/v3/moviefile', 'movieFileIds', fileIds, 'mf', cache, now) : new Map<number, string | null>()
    for (const [id, m] of movies) {
      const has = m.fid !== null && q.has(m.fid)
      out.set(id, { hasFile: has, quality: has ? (q.get(m.fid as number) ?? m.emb) : null, season: null, number: null })
    }
  } catch { out.clear() }
  return out
}

/** The album id a Lidarr queue row is for. */
export const albumIdOf = (r: any): number | null => posInt(r?.albumId ?? r?.album?.id)

const DEAD_MS_NOTE = 'dead album ids are remembered for the cache TTL (60 s)'
const deadKey = (id: number) => `dead:al:${id}`
/** Only these two mean "an id in this batch is unknown to Lidarr" (500 on /album, 404 on /trackfile). Timeouts and the rest are not. */
const UNKNOWN_ID = /HTTP (?:500|404)\b/
/** The most extra requests one reading may spend finding the unknown ids in failing batches. */
const BISECT_BUDGET = 40

/**
 * One batched read, tolerant of album ids Lidarr no longer knows. Lidarr answers a batch that names a missing album
 * with an error for the whole batch (HTTP 500 on /album, 404 on /trackfile). Only those two errors start a search for
 * the culprit: the batch is split in halves, recursively, down to single ids; an id that fails alone is remembered as
 * dead (see DEAD_MS_NOTE) so the next readings leave it out. Any other error, a timeout included, fails the batch as
 * before. The search spends at most BISECT_BUDGET extra requests; ids it never got to are left unknown.
 */
async function tolerant(get: Get, path: string, param: string, ids: number[], cache: FileCache, now: number, budget = { left: BISECT_BUDGET }): Promise<any[]> {
  if (!ids.length) return []
  try {
    const r = await get(`${path}?${ids.map(i => `${param}=${i}`).join('&')}`, 15_000)
    return Array.isArray(r) ? r : []
  } catch (e: any) {
    if (!UNKNOWN_ID.test(String(e?.message ?? e))) throw e
    if (ids.length === 1) { cache.set(deadKey(ids[0]), '1', now); return [] }
    const mid = ids.length >> 1
    const out: any[] = []
    for (const half of [ids.slice(0, mid), ids.slice(mid)]) {
      if (budget.left <= 0) break
      budget.left--
      out.push(...await tolerant(get, path, param, half, cache, now, budget))
    }
    return out
  }
}

/**
 * Lidarr: album id → what is on disk. The albums are read every time (their track counts are as fresh as the queue);
 * the quality of an album's files is cached 60 seconds under the album's file count and size on disk, so a replaced
 * file reads fresh. Any failure leaves the whole answer out: a failed lookup vouches for nothing.
 */
export async function readAlbumInfo(get: Get, rows: any[], now: number, cache: FileCache = sharedFileCache): Promise<Map<number, AlbumInfo>> {
  const out = new Map<number, AlbumInfo>()
  try {
    const ids = [...new Set(rows.map(albumIdOf).filter((n): n is number => n !== null))].filter(id => !cache.get(deadKey(id), now)).slice(0, MAX_IDS)
    const albums: any[] = []
    for (const b of batches(ids)) albums.push(...await tolerant(get, '/api/v1/album', 'albumIds', b, cache, now))
    const stats = new Map<number, { total: number | null; have: number; size: number; title: string | null }>()
    for (const a of albums) {
      const id = posInt(a?.id); if (id === null) continue
      const st = a?.statistics ?? {}
      const total = [st.trackCount, st.totalTrackCount].map(Number).find(n => Number.isInteger(n) && n > 0) ?? null
      const have = Number.isInteger(Number(st.trackFileCount)) ? Number(st.trackFileCount) : 0
      stats.set(id, { total, have, size: Number(st.sizeOnDisk) || 0, title: typeof a.title === 'string' && a.title ? a.title.slice(0, 120) : null })
    }
    const key = (id: number) => { const s = stats.get(id)!; return `tf:${id}:${s.have}:${s.size}` }
    const need: number[] = []
    const files = new Map<number, Array<{ quality: string | null; count: number }>>()
    for (const [id, s] of stats) {
      if (s.have === 0) { files.set(id, []); continue }
      const c = cache.get(key(id), now)
      if (c) { try { files.set(id, JSON.parse(c.v ?? '[]')) } catch { need.push(id) } } else need.push(id)
    }
    for (const b of batches(need)) {
      const recs = await tolerant(get, '/api/v1/trackfile', 'albumId', b.filter(id => !cache.get(deadKey(id), now)), cache, now)
      const by = new Map<number, Map<string | null, number>>()
      for (const f of recs) {
        const aid = posInt(f?.albumId); if (aid === null) continue
        const q = qname(f)
        const m = by.get(aid) ?? new Map<string | null, number>()
        m.set(q, (m.get(q) ?? 0) + 1); by.set(aid, m)
      }
      for (const id of b) {
        if (!stats.has(id)) continue
        const list = [...(by.get(id) ?? new Map()).entries()].map(([quality, count]) => ({ quality, count }))
        files.set(id, list)
        cache.set(key(id), JSON.stringify(list), now)
      }
    }
    for (const [id, s] of stats) out.set(id, { title: s.title, total: s.total, have: s.have, files: files.get(id) ?? [] })
  } catch { out.clear() }
  return out
}
