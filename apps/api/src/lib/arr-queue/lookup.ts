// =============================================================================
//  HyperProx — Arr Stack queue, what is on disk for the queued episodes and films (read-only)
//
//  Feeds "Why this download". Runs inside the shared queue reading, so it costs a few batched requests per reading,
//  never one per queue row: the episodes of every queued download in batches of 100 (Sonarr), then the files those
//  episodes point at. A file's quality never changes under its id, so files are cached for 60 seconds by id; the
//  episodes themselves are read every time, so "has a file" is as fresh as the queue. Radarr's queue rows already carry
//  the film and its file id, so only the files are asked for. Any failure leaves the answer out; it never fails the queue.
// =============================================================================

import type { FileInfo } from './why'

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

/** Radarr: movie id → what is on disk. The queue rows (read with includeMovie) say whether the film has a file and which. */
export async function readMovieInfo(get: Get, rows: any[], now: number, cache: FileCache = sharedFileCache): Promise<Map<number, FileInfo>> {
  const out = new Map<number, FileInfo>()
  try {
    const movies = new Map<number, { has: boolean; fid: number | null; emb: string | null }>()
    for (const r of rows) {
      const id = posInt(r?.movieId ?? r?.movie?.id); if (id === null || movies.has(id)) continue
      movies.set(id, { has: !!r?.movie?.hasFile, fid: posInt(r?.movie?.movieFileId ?? r?.movie?.movieFile?.id), emb: qname(r?.movie?.movieFile) })
    }
    const fileIds = [...new Set([...movies.values()].map(m => (m.has ? m.fid : null)).filter((n): n is number => n !== null))].slice(0, MAX_IDS)
    const q = fileIds.length ? await fileQualities(get, '/api/v3/moviefile', 'movieFileIds', fileIds, 'mf', cache, now) : new Map<number, string | null>()
    for (const [id, m] of movies) out.set(id, { hasFile: m.has, quality: m.has ? ((m.fid !== null ? q.get(m.fid) : null) ?? m.emb) : null, season: null, number: null })
  } catch { out.clear() }
  return out
}
