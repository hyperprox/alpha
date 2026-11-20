// =============================================================================
//  HyperProx — Arr Stack "Find a better copy"
//
//  For any film, episode, season or album in the library, or for a download in the queue that is crawling:
//
//   find      the library, by title (Radarr's films, Sonarr's shows and then a season's episodes, Lidarr's albums),
//             with what is on disk now. Read-only.
//   search    ONE interactive release search for that item (the same call as "See what's available"), at most once
//             per item every ten minutes (the answer is reused in between). For a queue download, the download is
//             resolved from a FRESH read of the whole queue and its rows' own episode, film or album ids decide what
//             is searched for: never a filter in the query (Sonarr and Radarr ignore the ones they do not know).
//   grab      downloads the picked release (guid and indexer only; the quality profile is never changed), waits for
//             it in the queue, checks its files for program files (lib/arr-release/grab.ts) and moves it to the top
//             of qBittorrent's queue. For a swap, the slow download is then removed from the client with
//             blocklist=true and skipRedownload=true, picked by its own rows (each row checked against the item's
//             exact ids), never by a bulk filter, and only once the new one is in the queue: if the new one does not
//             show up, the old one is left alone. The file already in the library stays until the arr imports the new
//             one (its normal upgrade); no library file is ever deleted.
//
//  What the profile refuses is shown with its reasons in plain words. When the arr's only objection is that something
//  for the item is already downloading, and the person is swapping that download out, an explicit "grab anyway" is
//  allowed (the swap is what resolves it). Anything else the arr refuses can still be downloaded on purpose with
//  "Download anyway" (an override): the confirmation names the arr's reasons, and it is audited as
//  arrstack.better.override, with the reasons, before the arr is asked. A swap works the same way with an override.
//  What is never offered (lib/arr-release/releases.ts NEVER_OFFERED) is never downloaded, whatever the request says.
//
//  Every search and grab is audited before it runs (no entry, nothing done). The routes are routes/arr-better.ts.
// =============================================================================

import type { CoreEndpointClient } from '../plugin-host'
import { NEVER_OFFERED, QUEUED_TEXT, profileInfo } from '../arr-release/releases'
import { API, ARR_NAME, ID_FIELD, READ_MS, ReleaseGrabber, type ArrApp, type GrabSubject } from '../arr-release/grab'
import { readAllQueue } from '../arr-queue/logic'
import { ActionRefusal, resolveDownload } from '../arr-queue/actions'
import { stripPaths } from '../arr-queue/logic'
import { parseTarget } from '../arr-giveup/service'
import { APP_WORD, betterView, hardStop, type BetterView, type Verdict } from './rank'

export class BetterRefusal extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); this.name = 'BetterRefusal' }
}

export interface BetterDeps {
  clients: Record<ArrApp, () => Promise<CoreEndpointClient | null>>
  qbit: () => Promise<CoreEndpointClient | null>
  /** Throws when the entry cannot be written: the search or grab then does not run. */
  audit(action: string, details: Record<string, unknown>): Promise<void>
  now(): number
  sleep?(ms: number): Promise<void>
  log?(m: string): void
  later?(fn: () => void, ms: number): void
  /** How long a grab waits for the queue to show it. */
  grabWaitMs?: number
}

/** One item is searched at most this often; in between, the last answer is shown. */
export const SEARCH_COOLDOWN_MS = 10 * 60_000
/** The arrs keep a search's releases this long; a grab needs a search newer than this. */
const GRAB_WINDOW_MS = 25 * 60_000
const LIBRARY_TTL_MS = 60_000
const MAX_FOUND = 25

const msg = (e: any) => String(e?.message ?? e).slice(0, 200)
const pad = (n: number) => String(n).padStart(2, '0')
const int = (v: unknown): number | null => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null }
const distinct = <T,>(xs: T[]): T[] => [...new Set(xs)]
const qualityName = (f: any): string | null => (typeof f?.quality?.quality?.name === 'string' ? f.quality.quality.name.slice(0, 40) : null)
const norm = (s: unknown) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()

/** What a search is for: one library item, or one download in the queue (its item is read from its rows). */
export type BetterTarget =
  | { kind: 'item'; key: string; app: ArrApp; arrId?: number; seriesId?: number; season?: number }
  | { kind: 'download'; key: string; app: ArrApp; downloadId: string }

const DOWNLOAD_ID = /^d:[\x21-\x7e]{1,200}$/

/** "radarr:7", "sonarr:101", "sonarr-season:11:2", "lidarr:6", or "queue:<sonarr|radarr|lidarr>:d:<download id>". */
export function parseBetterTarget(v: unknown): BetterTarget | null {
  if (typeof v !== 'string' || v.length > 240) return null
  const q = /^queue:(sonarr|radarr|lidarr):(.+)$/.exec(v)
  if (q) return DOWNLOAD_ID.test(q[2]) ? { kind: 'download', key: v, app: q[1] as ArrApp, downloadId: q[2] } : null
  const t = parseTarget(v)
  if (!t) return null
  return { kind: 'item', key: t.target, app: t.app, ...(t.arrId !== undefined ? { arrId: t.arrId } : {}), ...(t.seriesId !== undefined ? { seriesId: t.seriesId, season: t.season } : {}) }
}

interface Item { app: ArrApp; arrId?: number; seriesId?: number; season?: number }
interface Swap { downloadId: string; name: string }
interface Search {
  key: string; app: ArrApp; at: number; used?: boolean; raw: any[]; profile: ReturnType<typeof profileInfo>
  label: string; have: string | null; wanted: Set<number>; seriesId?: number; season?: number; swap?: Swap
}

export interface FoundItem { target: string; title: string; detail: string; have: string }
export interface FoundShow { seriesId: number; title: string; detail: string; seasons: Array<{ season: number; episodes: number; files: number }> }
export type SearchAnswer = BetterView & { target: string; label: string; have: string | null; swap: { name: string } | null; searchedAt: string; reused: boolean; nextSearchAt: string }
export interface GrabAnswer { result: 'queued' | 'not-seen' | 'removed-executable'; summary: string; notes: string[]; swapped: boolean; top: boolean }

export class BetterCopyService {
  private searches = new Map<string, Search>()
  /** Searches running now, by item: a second click for the same item joins the first instead of asking again. */
  private pending = new Map<string, Promise<Search>>()
  private library = new Map<string, { at: number; rows: any[] }>()
  private grabber: ReleaseGrabber

  constructor(private d: BetterDeps) {
    this.grabber = new ReleaseGrabber({
      qbit: d.qbit, audit: (a, x) => d.audit(a, x), sleep: ms => this.sleep(ms), log: d.log ? m => d.log!(m) : undefined,
      later: d.later ? (fn, ms) => d.later!(fn, ms) : undefined, waitMs: d.grabWaitMs, auditPrefix: 'arrstack.better.grab', logPrefix: '[arr-better]',
    })
  }

  private sleep(ms: number) { return this.d.sleep ? this.d.sleep(ms) : new Promise<void>(r => setTimeout(r, ms)) }
  private async client(app: ArrApp): Promise<CoreEndpointClient> {
    const c = await this.d.clients[app]().catch(() => null)
    if (!c) throw new BetterRefusal(409, 'not_set_up', `${ARR_NAME[app]} is not set up in the Arr Stack plug-in.`)
    return c
  }
  /** Audited before it runs: no entry, nothing done. */
  private async audit(action: string, details: Record<string, unknown>) {
    try { await this.d.audit(action, details) } catch { throw new BetterRefusal(503, 'audit_unavailable', 'The audit log could not be written, so nothing was done.') }
  }

  // ── the library ────────────────────────────────────────────────────────────

  private async libraryOf(app: ArrApp, path: string): Promise<any[]> {
    const now = this.d.now()
    const hit = this.library.get(path)
    if (hit && now - hit.at < LIBRARY_TTL_MS) return hit.rows
    const rows = await (await this.client(app)).get(path, READ_MS)
    const list = Array.isArray(rows) ? rows : []
    this.library.set(path, { at: now, rows: list })
    return list
  }

  /** Films or albums whose title (or artist) holds the words typed, best match first. Read-only. */
  async find(app: 'radarr' | 'lidarr', q: string): Promise<FoundItem[]> {
    const want = norm(q)
    if (want.length < 2) return []
    const score = (t: string) => (t === want ? 0 : t.startsWith(want) ? 1 : t.includes(want) ? 2 : 9)
    if (app === 'radarr') {
      return (await this.libraryOf('radarr', '/api/v3/movie'))
        .map(m => ({ m, s: score(norm(m?.title)) })).filter(x => x.s < 9 && int(x.m?.id))
        .sort((a, b) => a.s - b.s || String(a.m.title).localeCompare(String(b.m.title))).slice(0, MAX_FOUND)
        .map(({ m }) => ({
          target: `radarr:${int(m.id)}`, title: String(m.title).slice(0, 120), detail: Number(m.year) > 0 ? String(m.year) : '',
          have: m.hasFile ? (qualityName(m.movieFile) ?? 'a file') : 'no file yet',
        }))
    }
    return (await this.libraryOf('lidarr', '/api/v1/album'))
      .map(a => ({ a, s: Math.min(score(norm(a?.title)), score(norm(a?.artist?.artistName))) })).filter(x => x.s < 9 && int(x.a?.id))
      .sort((x, y) => x.s - y.s || String(x.a.title).localeCompare(String(y.a.title))).slice(0, MAX_FOUND)
      .map(({ a }) => ({
        target: `lidarr:${int(a.id)}`, title: `${String(a.artist?.artistName ?? 'Unknown artist').slice(0, 60)}: ${String(a.title).slice(0, 80)}`,
        detail: typeof a.releaseDate === 'string' ? a.releaseDate.slice(0, 4) : '',
        have: `${Number(a.statistics?.trackFileCount) || 0} of ${Number(a.statistics?.trackCount ?? a.statistics?.totalTrackCount) || 0} tracks`,
      }))
  }

  /** Shows whose title holds the words typed, with each season's episode and file counts. Read-only. */
  async findShows(q: string): Promise<FoundShow[]> {
    const want = norm(q)
    if (want.length < 2) return []
    const score = (t: string) => (t === want ? 0 : t.startsWith(want) ? 1 : t.includes(want) ? 2 : 9)
    return (await this.libraryOf('sonarr', '/api/v3/series'))
      .map(s => ({ s, k: score(norm(s?.title)) })).filter(x => x.k < 9 && int(x.s?.id))
      .sort((a, b) => a.k - b.k || String(a.s.title).localeCompare(String(b.s.title))).slice(0, MAX_FOUND)
      .map(({ s }) => ({
        seriesId: int(s.id)!, title: String(s.title).slice(0, 120), detail: Number(s.year) > 0 ? String(s.year) : '',
        seasons: (Array.isArray(s.seasons) ? s.seasons : []).filter((x: any) => Number.isInteger(Number(x?.seasonNumber)))
          .map((x: any) => ({ season: Number(x.seasonNumber), episodes: Number(x.statistics?.episodeCount ?? x.statistics?.totalEpisodeCount) || 0, files: Number(x.statistics?.episodeFileCount) || 0 }))
          .sort((a: any, b: any) => a.season - b.season),
      }))
  }

  /** One season's episodes, with what is on disk. The rows are matched to the season here, not by the query. */
  async episodes(seriesId: number, season: number): Promise<{ season: FoundItem; episodes: FoundItem[] }> {
    const c = await this.client('sonarr')
    const series = await c.get(`/api/v3/series/${seriesId}`, READ_MS)
    const eps = await c.get(`/api/v3/episode?seriesId=${seriesId}&seasonNumber=${season}&includeEpisodeFile=true`, READ_MS)
    const mine = (Array.isArray(eps) ? eps : []).filter((e: any) => Number(e?.seriesId) === seriesId && Number(e?.seasonNumber) === season && int(e?.id))
      .sort((a: any, b: any) => Number(a.episodeNumber) - Number(b.episodeNumber))
    const title = String(series?.title ?? 'A show').slice(0, 120)
    const files = mine.filter((e: any) => e.hasFile || Number(e.episodeFileId) > 0).length
    return {
      season: { target: `sonarr-season:${seriesId}:${season}`, title, detail: season === 0 ? 'Specials' : `Season ${season}`, have: `${files} of ${mine.length} episodes` },
      episodes: mine.map((e: any) => ({
        target: `sonarr:${int(e.id)}`, title: String(e.title ?? '').slice(0, 120), detail: `S${pad(season)}E${pad(Number(e.episodeNumber) || 0)}`,
        have: e.hasFile || Number(e.episodeFileId) > 0 ? (qualityName(e.episodeFile) ?? 'a file') : 'no file yet',
      })),
    }
  }

  // ── search ─────────────────────────────────────────────────────────────────

  async search(target: string, by: string): Promise<SearchAnswer> {
    const t = parseBetterTarget(target)
    if (!t) throw new BetterRefusal(400, 'bad_request', 'Name one item or one download.')
    const now = this.d.now()
    let s = this.searches.get(t.key)
    let reused = true
    if (!s || now - s.at >= SEARCH_COOLDOWN_MS) {
      const running = this.pending.get(t.key)
      if (running) s = await running
      else {
        reused = false
        const p = this.fresh(t, by, now)
        this.pending.set(t.key, p)
        try { s = await p } finally { this.pending.delete(t.key) }
      }
    }
    const v = betterView(s.raw, { app: s.app, profile: s.profile, swap: !!s.swap })
    return {
      rows: v.rows, found: v.found, accepted: v.accepted, groups: v.groups, hidden: v.hidden,
      target: s.key, label: s.label, have: s.have, swap: s.swap ? { name: s.swap.name } : null,
      searchedAt: new Date(s.at).toISOString(), reused, nextSearchAt: new Date(s.at + SEARCH_COOLDOWN_MS).toISOString(),
    }
  }

  /** One new search for the item: resolved, described, audited first, then asked of the arr. */
  private async fresh(t: BetterTarget, by: string, now: number): Promise<Search> {
    const c = await this.client(t.app)
    let item: Item, swap: Swap | undefined
    if (t.kind === 'download') {
      const rows = await this.downloadRows(c, t.app, t.downloadId)
      if (!rows) throw new BetterRefusal(404, 'gone', 'That download is no longer in the queue.')
      item = itemOfDownload(t.app, rows)
      swap = { downloadId: t.downloadId, name: stripPaths(String(rows[0]?.title ?? 'the download')).slice(0, 160) }
    } else item = t
    const info = await this.describe(c, item)
    await this.audit('arrstack.better.search', { app: t.app, by, item: info.label, ...(swap ? { replacing: swap.name } : {}) })
    const q = item.season !== undefined ? `seriesId=${item.seriesId}&seasonNumber=${item.season}` : `${ID_FIELD[t.app]}=${item.arrId}`
    const raw = await c.get(`${API[t.app]}/release?${q}`, 180_000)
    const s: Search = {
      key: t.key, app: t.app, at: now, raw: Array.isArray(raw) ? raw : [], profile: info.profile, label: info.label, have: info.have,
      wanted: new Set(info.ids), ...(item.season !== undefined ? { seriesId: item.seriesId, season: item.season } : {}), ...(swap ? { swap } : {}),
    }
    this.searches.set(t.key, s)
    for (const [k, v] of this.searches) if (now - v.at > GRAB_WINDOW_MS) this.searches.delete(k)
    return s
  }

  /** A download's rows from a fresh read of the whole queue (lib/arr-queue/actions.ts resolveDownload checks them). */
  private async downloadRows(c: CoreEndpointClient, app: ArrApp, downloadId: string): Promise<any[] | null> {
    const all = await readAllQueue((p, ms) => c.get(p, ms), app).catch(e => { throw new BetterRefusal(502, 'queue_failed', `${ARR_NAME[app]}'s queue could not be read: ${msg(e)}`) })
    try { return resolveDownload(all, downloadId) } catch (e) {
      if (e instanceof ActionRefusal) throw new BetterRefusal(e.status, e.code, e.message)
      throw e
    }
  }

  /** The item's name, the ids it covers, its quality profile and what is on disk now. */
  private async describe(c: CoreEndpointClient, t: Item): Promise<{ label: string; ids: number[]; profile: ReturnType<typeof profileInfo>; have: string | null }> {
    const prof = async (id: unknown) => {
      const n = int(id)
      return n ? profileInfo(await c.get(`${API[t.app]}/qualityprofile/${n}`, READ_MS).catch(() => null)) : null
    }
    if (t.app === 'sonarr') {
      if (t.season !== undefined) {
        const series = await c.get(`/api/v3/series/${t.seriesId}`, READ_MS)
        const eps = await c.get(`/api/v3/episode?seriesId=${t.seriesId}&seasonNumber=${t.season}`, READ_MS).catch(() => [])
        const season = (Array.isArray(eps) ? eps : []).filter((e: any) => Number(e?.seasonNumber) === t.season && Number(e?.seriesId) === t.seriesId && int(e?.id))
        if (!season.length) throw new BetterRefusal(404, 'not_found', 'Sonarr has no episodes in that season.')
        const files = season.filter((e: any) => e.hasFile === true || Number(e.episodeFileId) > 0).length
        return {
          label: `${String(series?.title ?? 'A show')} ${t.season === 0 ? 'Specials' : `Season ${t.season}`}`, ids: season.map((e: any) => int(e.id)!),
          profile: await prof(series?.qualityProfileId), have: files ? `${files} of ${season.length} episodes` : null,
        }
      }
      const e = await c.get(`/api/v3/episode/${t.arrId}`, READ_MS)
      if (!e || int(e.id) !== t.arrId) throw new BetterRefusal(404, 'not_found', 'Sonarr does not have that episode.')
      const series = await c.get(`/api/v3/series/${e.seriesId}`, READ_MS)
      const fileId = int(e.episodeFileId)
      const file = e.episodeFile ?? (fileId ? await c.get(`/api/v3/episodefile/${fileId}`, READ_MS).catch(() => null) : null)
      const code = `S${pad(Number(e.seasonNumber) || 0)}E${pad(Number(e.episodeNumber) || 0)}`
      return { label: `${String(series?.title ?? 'A show')} ${code}`, ids: [t.arrId!], profile: await prof(series?.qualityProfileId), have: fileId || e.hasFile ? (qualityName(file) ?? 'a file') : null }
    }
    if (t.app === 'radarr') {
      const m = await c.get(`/api/v3/movie/${t.arrId}`, READ_MS)
      if (!m || int(m.id) !== t.arrId) throw new BetterRefusal(404, 'not_found', 'Radarr does not have that film.')
      return {
        label: `${String(m.title ?? 'A film')}${Number(m.year) > 0 ? ` (${m.year})` : ''}`, ids: [t.arrId!], profile: await prof(m.qualityProfileId),
        have: m.hasFile || int(m.movieFileId) ? (qualityName(m.movieFile) ?? 'a file') : null,
      }
    }
    const a = await c.get(`/api/v1/album/${t.arrId}`, READ_MS)
    if (!a || int(a.id) !== t.arrId) throw new BetterRefusal(404, 'not_found', 'Lidarr does not have that album.')
    const artist = a.artist ?? await c.get(`/api/v1/artist/${a.artistId}`, READ_MS).catch(() => null)
    const files = Number(a.statistics?.trackFileCount) || 0
    return {
      label: `${String(artist?.artistName ?? 'An artist')}: ${String(a.title ?? 'an album')}`, ids: [t.arrId!], profile: await prof(artist?.qualityProfileId),
      have: files ? `${files} of ${Number(a.statistics?.trackCount ?? a.statistics?.totalTrackCount) || files} tracks` : null,
    }
  }

  // ── grab ───────────────────────────────────────────────────────────────────

  /** What a download from the last search would be, for its confirmation (lib/confirm-text.ts). Never searches. */
  namesFor(target: string, releaseId: string): { item: string; release: string; swap: string | null; app: string; verdict: Verdict; reasons: string[] } | null {
    const t = parseBetterTarget(target)
    const s = t ? this.searches.get(t.key) : undefined
    if (!s || this.d.now() - s.at > GRAB_WINDOW_MS) return null
    const row = betterView(s.raw, { app: s.app, profile: s.profile, swap: !!s.swap }).all.find(r => r.id === releaseId)
    return row ? { item: s.label, release: row.title, swap: s.swap?.name ?? null, app: APP_WORD[s.app], verdict: row.verdict, reasons: this.overridden(row, !!s.swap) } : null
  }

  /** The arr's objections an override goes past, in plain words (the one a swap resolves is left out). */
  private overridden(row: { reasons: string[] }, swap: boolean): string[] {
    return row.reasons.filter(r => !(swap && r === QUEUED_TEXT))
  }

  /**
   * Download one release from the last search, by HyperProx's row id, and move it to the top of qBittorrent's queue.
   * For a swap, the slow download is removed (blocklisted, no re-search) once the new one is in the queue.
   */
  async grab(target: string, releaseId: string, by: string, o: { anyway?: boolean; override?: boolean } = {}): Promise<GrabAnswer> {
    const t = parseBetterTarget(target)
    if (!t) throw new BetterRefusal(400, 'bad_request', 'Name one item or one download.')
    const s = this.searches.get(t.key)
    if (!s || this.d.now() - s.at > GRAB_WINDOW_MS) throw new BetterRefusal(409, 'search_expired', 'That search is too old to download from. Search again.')
    if (s.used) throw new BetterRefusal(409, 'search_used', 'Something was already downloaded from this search. Search again once the next search is allowed.')
    const row = betterView(s.raw, { app: s.app, profile: s.profile, swap: !!s.swap }).all.find(r => r.id === releaseId)
    if (!row) throw new BetterRefusal(404, 'no_release', 'That release is not one HyperProx can offer.')
    // Never offered: checked again from the arr's own record, not only from the row's verdict.
    const raw = s.raw.find(r => typeof r?.guid === 'string' && r.guid === row.guid && Number(r?.indexerId) === row.indexerId)
    const stop = hardStop(row, raw) ?? (row.verdict === 'never' ? 'disc' : null)
    if (stop) throw new BetterRefusal(409, 'never_offered', `HyperProx never downloads this: ${NEVER_OFFERED[stop].charAt(0).toLowerCase()}${NEVER_OFFERED[stop].slice(1)}.`)
    if (row.verdict === 'refused' && o.override !== true) throw new BetterRefusal(409, 'profile_refuses', `${row.why ?? 'Your quality profile refuses it.'} Choose "Download anyway" to download it on purpose.`)
    if (row.verdict === 'anyway' && o.anyway !== true && o.override !== true) throw new BetterRefusal(409, 'confirm_anyway', `${ARR_NAME[s.app]} only refuses it because the slow download is still queued. Confirm "grab anyway" to swap it.`)
    const override = row.verdict === 'refused'
    // Taken at once, so two clicks cannot both grab; given back only if nothing was sent to the arr.
    s.used = true
    let grabbed = false
    try {
      const c = await this.client(s.app)
      if (!c.post) throw new BetterRefusal(409, 'cannot_grab', 'Downloads cannot be started from here.')
      // The slow download, from a fresh queue, and checked: every row must be for this item's own ids.
      let oldRows: any[] | null = null
      if (s.swap) {
        oldRows = await this.downloadRows(c, s.app, s.swap.downloadId)
        if (oldRows && !oldRows.every(r => rowIsFor(r, s))) throw new BetterRefusal(409, 'selection_mismatch', 'That download now covers something else, so nothing was changed. Open it again from the queue.')
      }
      await this.audit(override ? 'arrstack.better.override' : 'arrstack.better.grab', {
        app: s.app, by, item: s.label, release: row.title, quality: row.quality, approved: row.approved, anyway: row.verdict === 'anyway', indexer: row.indexer,
        ...(override ? { reasons: this.overridden(row, !!s.swap), arrReasons: row.rawReasons } : {}),
        ...(s.swap ? { replacing: s.swap.name, replacingInQueue: !!oldRows } : {}),
      })
      const subject: GrabSubject = { app: s.app, wanted: s.wanted, seriesId: s.seriesId, season: s.season }
      const before = await this.grabber.before(c, s.app)
      await c.post(`${API[s.app]}/release`, { guid: row.guid, indexerId: row.indexerId }, 60_000)
      grabbed = true
      const notes: string[] = []
      const out = await this.grabber.verify(c, subject, row, before, notes, by)
      const answer: GrabAnswer = { result: out.result, summary: out.summary, notes: out.notes, swapped: false, top: false }
      if (out.result === 'queued' && out.hash) answer.top = await this.toTop(out.hash, answer.notes)
      if (s.swap) {
        if (!oldRows) answer.notes.push('The slow download had already left the queue, so there was nothing to remove.')
        else if (out.result !== 'queued') answer.notes.push(`The slow download was left in place: ${out.result === 'removed-executable' ? 'the new one held a program file and was removed' : 'the new one is not in the queue yet'}. Remove it from the queue once the new one is downloading.`)
        else answer.swapped = await this.removeOld(c, s, oldRows, answer.notes)
      }
      if (out.result === 'queued') {
        answer.summary = `Downloading ${row.title}${answer.top ? ', at the top of qBittorrent\'s queue' : ''}.${answer.swapped ? ' The slow download is removed and blocklisted.' : ''}`
        if (s.have) answer.notes.push(`What you have now (${s.have}) stays until ${ARR_NAME[s.app]} imports the new copy.`)
      }
      await this.d.audit('arrstack.better.grab.done', { app: s.app, by, item: s.label, result: out.result, override, swapped: answer.swapped, top: answer.top, filesChecked: out.filesChecked })
        .catch(e => this.d.log?.(`[arr-better] the after-grab audit entry could not be written: ${msg(e)}`))
      return answer
    } catch (e) {
      if (!grabbed) s.used = false
      throw e
    }
  }

  /** Move a torrent to the top of qBittorrent's queue. False (with a note) when it cannot. */
  private async toTop(hash: string, notes: string[]): Promise<boolean> {
    const qb = await this.d.qbit().catch(() => null)
    if (!qb?.postForm) { notes.push('Not moved to the top: HyperProx has no qBittorrent connection in the Arr Stack settings.'); return false }
    try {
      const known = await qb.get(`/api/v2/torrents/info?hashes=${hash}`, 10_000)
      if (!Array.isArray(known) || !known.length) { notes.push('Not moved to the top: qBittorrent does not list it yet.'); return false }
      await qb.postForm('/api/v2/torrents/topPrio', { hashes: hash }, 10_000)
      return true
    } catch (e) {
      // topPrio answers 409 when queueing is off in qBittorrent: then every torrent already runs.
      notes.push(/\b409\b/.test(msg(e)) ? 'Not moved to the top: queueing is off in qBittorrent, so every download already runs at once.' : `Not moved to the top: ${msg(e)}`)
      return false
    }
  }

  /** Remove the slow download's own rows from the client, blocklisted and without a new search; read back. */
  private async removeOld(c: CoreEndpointClient, s: Search, rows: any[], notes: string[]): Promise<boolean> {
    const ids = distinct(rows.map(r => Number(r?.id)))
    if (!ids.length || !ids.every(n => Number.isInteger(n) && n > 0)) { notes.push('The slow download could not be removed: the queue gave one of its rows no id. Remove it from the Queue tab.'); return false }
    if (!c.deleteBody) { notes.push('The slow download could not be removed from here. Remove it from the Queue tab.'); return false }
    try {
      await c.deleteBody(`${API[s.app]}/queue/bulk?removeFromClient=true&blocklist=true&skipRedownload=true`, { ids }, 30_000)
    } catch (e) { notes.push(`The slow download could not be removed: ${msg(e)}. Remove it from the Queue tab.`); return false }
    const after = await readAllQueue((p, ms) => c.get(p, ms), s.app).catch(() => null)
    if (!after) notes.push('The queue could not be read back to confirm the slow download is gone.')
    else if (after.some(r => ids.includes(Number(r?.id)))) notes.push(`${ARR_NAME[s.app]} still lists the slow download; it may be waiting on the download client.`)
    return true
  }
}

/** What a queue download is for, from its rows: one film, one album, one episode, or one season. */
export function itemOfDownload(app: ArrApp, rows: any[]): Item {
  const ids = (k: 'movieId' | 'albumId' | 'episodeId', nested: 'movie' | 'album' | 'episode') =>
    distinct(rows.map(r => int(r?.[k] ?? r?.[nested]?.id)).filter((n): n is number => n !== null))
  const none = () => new BetterRefusal(409, 'not_matched', `${ARR_NAME[app]} has not matched this download to anything, so there is nothing to search for.`)
  if (app === 'radarr') {
    const m = ids('movieId', 'movie')
    if (!m.length) throw none()
    if (m.length > 1) throw new BetterRefusal(409, 'mixed', 'This download covers several films. Search for each film on its own.')
    return { app, arrId: m[0] }
  }
  if (app === 'lidarr') {
    const a = ids('albumId', 'album')
    if (!a.length) throw none()
    if (a.length > 1) throw new BetterRefusal(409, 'mixed', 'This download covers several albums. Search for each album on its own.')
    return { app, arrId: a[0] }
  }
  const eps = ids('episodeId', 'episode')
  if (!eps.length) throw none()
  if (eps.length === 1) return { app, arrId: eps[0] }
  const pairs = distinct(rows.map(r => `${int(r?.seriesId ?? r?.series?.id)}:${Number(r?.seasonNumber ?? r?.episode?.seasonNumber)}`))
  const [series, season] = pairs[0].split(':')
  if (pairs.length !== 1 || !int(series) || !Number.isInteger(Number(season)) || Number(season) < 0) throw new BetterRefusal(409, 'mixed', 'This download covers more than one season. Search for each season on its own.')
  return { app, seriesId: Number(series), season: Number(season) }
}

/** A queue row belongs to the search's item: its own episode, film or album id is one of the item's. */
function rowIsFor(r: any, s: Search): boolean {
  const id = int(r?.[ID_FIELD[s.app]] ?? r?.[s.app === 'sonarr' ? 'episode' : s.app === 'radarr' ? 'movie' : 'album']?.id)
  return id !== null && s.wanted.has(id)
}
