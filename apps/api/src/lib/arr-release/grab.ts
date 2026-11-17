// =============================================================================
//  HyperProx — Arr Stack: reading the queue, and checking a release once it is grabbed
//
//  Shared by "See what's available" (lib/arr-giveup) and "Find a better copy" (lib/arr-better):
//
//   readQueue        every page of an arr's queue. Its rows are matched to items by the CALLER: Sonarr's /queue
//                    ignores seriesId (and Radarr's ignores filters it does not know) and answers with everything,
//                    so no filter in the query is ever trusted.
//   ReleaseGrabber   after `POST /release` (guid and indexer only): reads the queue for about 20 s to see the new
//                    download, then checks its files in qBittorrent for program files. A torrent often has no file
//                    list yet, so it is looked at again 1, 3 and 10 minutes later and removed (and blocklisted) if
//                    one turns up.
// =============================================================================

import type { CoreEndpointClient } from '../plugin-host'
import { isProgramFile } from './releases'

export type ArrApp = 'sonarr' | 'radarr' | 'lidarr'
export const API: Record<ArrApp, string> = { sonarr: '/api/v3', radarr: '/api/v3', lidarr: '/api/v1' }
export const ID_FIELD: Record<ArrApp, 'episodeId' | 'movieId' | 'albumId'> = { sonarr: 'episodeId', radarr: 'movieId', lidarr: 'albumId' }
export const ARR_NAME: Record<ArrApp, string> = { sonarr: 'Sonarr', radarr: 'Radarr', lidarr: 'Lidarr' }
export const READ_MS = 120_000
/** When a download's files are checked again for program files, after the first look. */
export const RECHECK_MS = [60_000, 3 * 60_000, 10 * 60_000]

const msg = (e: any) => String(e?.message ?? e).slice(0, 200)

/** Every page of a paged list (records + totalRecords). */
export async function allPages(c: CoreEndpointClient, path: string, size = 1000, maxPages = 50): Promise<any[]> {
  const out: any[] = []
  for (let p = 1; p <= maxPages; p++) {
    const page = await c.get(`${path}${path.includes('?') ? '&' : '?'}page=${p}&pageSize=${size}`, READ_MS)
    const recs: any[] = Array.isArray(page?.records) ? page.records : []
    out.push(...recs)
    if (!recs.length || out.length >= (Number(page?.totalRecords) || 0)) return out
  }
  throw new Error('The list was longer than HyperProx reads at once.')
}

/** The queue, every page. Its rows are matched to items by the caller: never trust a filter in the query. */
export async function readQueue(c: CoreEndpointClient, app: ArrApp): Promise<any[]> {
  const extra = app === 'sonarr' ? 'includeUnknownSeriesItems=true' : app === 'radarr' ? 'includeUnknownMovieItems=true' : 'includeUnknownArtistItems=true'
  return allPages(c, `${API[app]}/queue?${extra}`, 500, 20)
}

/** What a grab was for: the items it should fill (episode, film or album ids), or a whole season. */
export interface GrabSubject { app: ArrApp; wanted: Set<number>; seriesId?: number; season?: number }

export interface GrabOutcome {
  result: 'queued' | 'not-seen' | 'removed-executable'
  filesChecked: boolean
  summary: string
  notes: string[]
  /** The torrent's hash, when the queue named it. */
  hash?: string
}

export interface GrabberDeps {
  qbit: () => Promise<CoreEndpointClient | null>
  audit(action: string, details: Record<string, unknown>): Promise<void>
  sleep(ms: number): Promise<void>
  log?(m: string): void
  /** Runs `fn` after `ms` (the later program-file checks). Default: an unref'd setTimeout. */
  later?(fn: () => void, ms: number): void
  /** How long to wait for the queue to show the grab. Default 20 s. */
  waitMs?: number
  /** Audit actions are `<prefix>.program-file` and `<prefix>.files-unchecked`. */
  auditPrefix: string
  /** Log lines start with this. */
  logPrefix: string
}

export class ReleaseGrabber {
  constructor(private d: GrabberDeps) {}

  /** The queue row ids right now, taken before a grab so the new row can be told apart. */
  async before(c: CoreEndpointClient, app: ArrApp): Promise<Set<number>> {
    return new Set((await readQueue(c, app)).map(r => Number(r?.id)))
  }

  /**
   * After `POST /release`: read the queue for about 20 s. When it shows up, check its files in qBittorrent for program
   * files; a torrent often has no file list yet, so it is looked at again 1, 3 and 10 minutes later and removed then
   * if one turns up.
   */
  async verify(c: CoreEndpointClient, s: GrabSubject, row: { title: string; protocol: string }, before: Set<number>, notes: string[], by: string): Promise<GrabOutcome> {
    const wait = this.d.waitMs ?? 20_000
    const step = Math.max(1, Math.min(5000, Math.floor(wait / 4)))
    let hit: any = null
    for (let waited = 0; waited <= wait && !hit; waited += step) {
      await this.d.sleep(step)
      const recs = await readQueue(c, s.app).catch(() => [])
      hit = findGrab(recs, s, row, before)
    }
    const unchecked = (why: string) => `Its files were not checked for program files: ${why}.`
    if (!hit) {
      notes.push(unchecked('it is not in the queue yet'))
      return { result: 'not-seen', filesChecked: false, summary: `${ARR_NAME[s.app]} took the request, but the download is not in the queue yet. Check the Queue tab in a minute.`, notes }
    }
    const hash = typeof hit.downloadId === 'string' ? hit.downloadId.toLowerCase() : ''
    const named = /^[0-9a-f]{40}$/.test(hash) ? { hash } : {}
    const queued = { result: 'queued' as const, summary: `Downloading: ${row.title} is in the queue.`, ...named }
    if (row.protocol !== 'torrent') return { ...queued, filesChecked: false, notes: [...notes, unchecked('it is a usenet download, and its files are only known once it has downloaded')] }
    const qb = await this.d.qbit().catch(() => null)
    if (!qb) return { ...queued, filesChecked: false, notes: [...notes, unchecked('HyperProx has no qBittorrent connection in the Arr Stack settings')] }
    if (!named.hash) return { ...queued, filesChecked: false, notes: [...notes, unchecked('the queue did not say which torrent it is')] }
    const first = await this.checkFiles(c, qb, s.app, hash, row.title, by)
    if (first === 'removed') return { result: 'removed-executable', filesChecked: true, summary: 'It contained a program file, so HyperProx removed it and blocklisted it.', notes }
    if (first === 'clean') return { ...queued, filesChecked: true, notes: [...notes, 'Its files were checked: no program files.'] }
    this.scheduleRechecks(c, qb, s.app, hash, row.title, by)
    return { ...queued, filesChecked: false, notes: [...notes, 'Files not checked yet: qBittorrent does not have its file list. HyperProx looks again after 1, 3 and 10 minutes and removes it if a program file shows up.'] }
  }

  /** One look at a torrent's files: 'removed' (a program file: removed and blocklisted), 'clean', or 'unknown' (no list yet). */
  async checkFiles(c: CoreEndpointClient, qb: CoreEndpointClient, app: ArrApp, hash: string, title: string, by: string): Promise<'removed' | 'clean' | 'unknown'> {
    const files = await qb.get(`/api/v2/torrents/files?hash=${hash}`, 15_000).catch(() => null)
    if (!Array.isArray(files) || !files.length) return 'unknown'
    const bad = files.map((f: any) => String(f?.name ?? '')).filter(isProgramFile)
    if (!bad.length) return 'clean'
    // The queue is read fresh and matched here by the torrent's hash.
    const recs = await readQueue(c, app).catch(() => [])
    const q = recs.find(r => String(r?.downloadId ?? '').toLowerCase() === hash)
    if (q) await c.delete(`${API[app]}/queue/${Number(q.id)}?removeFromClient=true&blocklist=true`, 30_000)
    await this.d.audit(`${this.d.auditPrefix}.program-file`, { app, by, release: title, file: bad[0].split('/').pop(), removed: !!q })
      .catch(e => this.d.log?.(`${this.d.logPrefix} audit failed: ${msg(e)}`))
    if (!q) this.d.log?.(`${this.d.logPrefix} ${title} holds a program file but is no longer in the queue`)
    return 'removed'
  }

  private scheduleRechecks(c: CoreEndpointClient, qb: CoreEndpointClient, app: ArrApp, hash: string, title: string, by: string) {
    const later = this.d.later ?? ((fn: () => void, ms: number) => { const t = setTimeout(fn, ms); t.unref?.() })
    let settled = false
    RECHECK_MS.forEach((ms, i) => later(() => {
      if (settled) return
      void this.checkFiles(c, qb, app, hash, title, by).then(r => {
        if (r !== 'unknown') { settled = true; return }
        if (i === RECHECK_MS.length - 1) {
          settled = true
          void this.d.audit(`${this.d.auditPrefix}.files-unchecked`, { app, by, release: title }).catch(() => {})
          this.d.log?.(`${this.d.logPrefix} ${title}: files not checked (qBittorrent never had its file list)`)
        }
      }, e => this.d.log?.(`${this.d.logPrefix} file check failed: ${msg(e)}`))
    }, ms))
  }
}

/** The new queue row for a grab, matched here: Sonarr's /queue ignores seriesId and answers with everything. */
export function findGrab(recs: any[], s: GrabSubject, row: { title: string }, before: Set<number>): any {
  return recs.find(r => !before.has(Number(r?.id)) && (s.wanted.has(Number(r?.[ID_FIELD[s.app]])) || (!!s.seriesId && Number(r?.seriesId) === s.seriesId && Number(r?.seasonNumber) === s.season)))
    ?? recs.find(r => !before.has(Number(r?.id)) && String(r?.title ?? '') === row.title)
}
