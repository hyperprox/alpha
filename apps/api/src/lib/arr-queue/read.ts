// =============================================================================
//  HyperProx — Arr Stack, one reading of the queue (read-only)
//
//  The queue from Sonarr, Radarr and (when set up) Lidarr, with what is on disk for it (for "Why this download"), and
//  qBittorrent's torrent list and speed. The queue route and the dashboard tile both read through here, so the two
//  cannot differ. Only GET requests are made.
// =============================================================================

import type { CoreEndpointClient } from '../plugin-host'
import { buildQueueData, readAllQueue, type QueueData } from './logic'
import { readAlbumInfo, readEpisodeInfo, readMovieInfo } from './lookup'
import type { QbitReading } from './plain'

/** The episode and file lookups for "Why this download" get this long, on top of the queue read. */
const LOOKUP_BUDGET_MS = 10_000

export const readMsg = (e: any) => {
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError' || /abort/i.test(String(e?.message ?? ''))) return 'timed out'
  return String(e?.message ?? e).slice(0, 160)
}

/** qBittorrent's torrent list and speed, in one reading; null parts when it is not set up or does not answer. */
export async function readQbit(c: CoreEndpointClient | null): Promise<QbitReading | null> {
  if (!c) return null
  const [torrents, transfer] = await Promise.all([c.get('/api/v2/torrents/info', 8_000).catch(() => null), c.get('/api/v2/transfer/info', 5_000).catch(() => null)])
  return { torrents: Array.isArray(torrents) ? torrents : null, transfer: transfer && typeof transfer === 'object' ? transfer : null }
}

export async function readQueue(deps: { sonarr: CoreEndpointClient | null; radarr: CoreEndpointClient | null; lidarr?: CoreEndpointClient | null; now: number; lookupMs?: number }): Promise<QueueData> {
  const one = async (c: CoreEndpointClient | null, kind: 'sonarr' | 'radarr' | 'lidarr') => {
    if (!c) return { rows: null, info: undefined as any, configured: false, error: undefined as string | undefined }
    try {
      const get = (p: string, t?: number) => c.get(p, t)
      const rows = await readAllQueue(get, kind)
      // What is on disk for what was queued, for "Why this download": batched, inside this one shared reading.
      // Its own budget: if the lookups run long they are dropped and the queue is still returned, without the lines.
      let timer: ReturnType<typeof setTimeout> | undefined
      const budget = new Promise<undefined>(res => { timer = setTimeout(() => res(undefined), deps.lookupMs ?? LOOKUP_BUDGET_MS) })
      const info = await Promise.race([kind === 'sonarr' ? readEpisodeInfo(get, rows, deps.now) : kind === 'lidarr' ? readAlbumInfo(get, rows, deps.now) : readMovieInfo(get, rows, deps.now), budget]).finally(() => clearTimeout(timer))
      return { rows, info: info as any, configured: true, error: undefined as string | undefined }
    }
    catch (e) { return { rows: null, info: undefined, configured: true, error: readMsg(e) } }
  }
  const [sonarr, radarr, lidarr] = await Promise.all([one(deps.sonarr, 'sonarr'), one(deps.radarr, 'radarr'), one(deps.lidarr ?? null, 'lidarr')])
  return buildQueueData({ sonarr, radarr, lidarr, now: deps.now })
}

