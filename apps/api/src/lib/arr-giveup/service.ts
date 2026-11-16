// =============================================================================
//  HyperProx — Arr Stack "Give up after X tries": the service
//
//  Reads Sonarr, Radarr and Lidarr through the Arr Stack plug-in's own connections (keys stay in the vault-backed
//  settings) and keeps the try counts (logic.ts) in the database (store.ts).
//
//   observe   every few hours: the whole wanted/missing list, the queue and new history, folded into the counts.
//             Read-only against the arrs.
//   run       once a day, for each app whose rule is on: re-reads every candidate live and gives up only on one
//             that still has no file, is still monitored and is not downloading. "Stop searching" unmonitors it;
//             "remove" (films and albums) removes it from the library with deleteFiles=false and an import-list
//             exclusion, after checking there is no file. Every change is read back. Never a file, never a
//             quality profile. Audited before and after; one notification with a short summary.
//   tryAgain  undoes one: monitors it again and asks for a search, or adds a removed film or album back with the
//             profile and folder it had. Read back, audited.
//   releases  "See what's available": ONE interactive search for one item, never in bulk, never on a timer; the
//             same item is searched at most once every ten minutes (the answer is reused in between).
//   grab      downloads one release from that search by its guid and indexer, even one the arr rejected, without
//             touching the profile. Then the queue is read for about 20 s (filtered here: Sonarr's /queue ignores
//             seriesId and answers with everything) to say whether it landed, and qBittorrent's file list is
//             checked for program files.
//
//  The routes are routes/arr-giveup.ts; the timer starts in lib/services/bootstrap.ts.
// =============================================================================

import crypto from 'node:crypto'
import type { CoreEndpointClient } from '../plugin-host'
import type { NotifyEventInput } from '../notify/types'
import {
  APPS, APP_NAME, APP_WHAT, candidates, localWhen, nextSearchAt, searchDue, serverClock, storedSettings, weekKey, classify, giveUpMessage, historyEvents, isApp, lidarrItems, observe as fold,
  parseKey, radarrItems, reasonCounts, rows, sameRule, sonarrItems, summarise, wholeSeasons,
  type App, type GiveUpSettings, type Restore, type Row, type Track,
} from './logic'
import { isProgramFile, profileInfo, releaseView, type ReleaseRow, type ReleaseView } from './releases'
import type { GiveUpStore } from './store'
import type { ParsedSettings } from './logic'

export class GiveUpRefusal extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); this.name = 'GiveUpRefusal' }
}

export interface GiveUpDeps {
  clients: Record<App, () => Promise<CoreEndpointClient | null>>
  qbit: () => Promise<CoreEndpointClient | null>
  store: GiveUpStore
  audit(action: string, details: Record<string, unknown>): Promise<void>
  publish(e: NotifyEventInput): Promise<void>
  now(): number
  sleep?(ms: number): Promise<void>
  unlocked(): boolean
  log?(m: string): void
  /** How long a grab waits for the queue to show it. */
  grabWaitMs?: number
  /** Runs `fn` after `ms` (the later program-file checks). Default: an unref'd setTimeout. */
  later?(fn: () => void, ms: number): void
}

interface AppState {
  historyId: number; observedAt?: string; lastActAt?: string; /** The calendar day (UTC) a run was claimed for. */ lastActDay?: string; lastRun?: RunResult
  /** The week (its Monday, local) the weekly search was claimed for, and how the last one went. */
  searchWeek?: string; lastSearch?: SearchRun
}
export interface SearchRun { at: string; app: App; count: number; commandId: number | null; status: string; error?: string }
const MISSING_COMMAND: Record<App, Record<string, unknown>> = {
  sonarr: { name: 'MissingEpisodeSearch', monitored: true }, radarr: { name: 'MissingMoviesSearch' }, lidarr: { name: 'MissingAlbumSearch' },
}
export interface RunResult { at: string; app: App; given: number; skipped: Array<{ title: string; why: string }>; failed: Array<{ title: string; why: string }>; error?: string }

const API: Record<App, string> = { sonarr: '/api/v3', radarr: '/api/v3', lidarr: '/api/v1' }
const ID_FIELD: Record<App, 'episodeId' | 'movieId' | 'albumId'> = { sonarr: 'episodeId', radarr: 'movieId', lidarr: 'albumId' }
export const MAX_PER_RUN = 250
const OBSERVE_EVERY_MS = 3 * 3600_000
/** When a download's files are checked again for program files, after the first look. */
export const RECHECK_MS = [60_000, 3 * 60_000, 10 * 60_000]
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const PREVIEW_TTL_MS = 15 * 60_000
/** One item is searched at most this often; in between, the last answer is shown. */
export const SEARCH_COOLDOWN_MS = 10 * 60_000
/** The arrs keep a search's releases this long; a grab needs a search newer than this. */
const GRAB_WINDOW_MS = 25 * 60_000
const READ_MS = 120_000

const msg = (e: any) => String(e?.message ?? e).slice(0, 200)
const chunk = <T,>(l: T[], n: number): T[][] => { const o: T[][] = []; for (let i = 0; i < l.length; i += n) o.push(l.slice(i, i + n)); return o }

interface Preview { id: string; app: App; settings: ParsedSettings; at: number; count: number }
interface Search { target: string; app: App; at: number; used?: boolean; raw: any[]; profile: ReturnType<typeof profileInfo>; label: string; wanted: Set<number>; seriesId?: number; season?: number; givenUpKeys: string[] }

export class GiveUpService {
  private previews = new Map<string, Preview>()
  private searches = new Map<string, Search>()
  private busy = false
  private chain: Promise<unknown> = Promise.resolve()

  /** One writer at a time: every read-change-write of the store runs inside this. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => {})
    return run
  }

  constructor(private d: GiveUpDeps) {}

  private sleep(ms: number) { return this.d.sleep ? this.d.sleep(ms) : new Promise<void>(r => setTimeout(r, ms)) }
  private iso() { return new Date(this.d.now()).toISOString() }
  private async client(app: App, need = true): Promise<CoreEndpointClient | null> {
    const c = await this.d.clients[app]().catch(() => null)
    if (!c && need) throw new GiveUpRefusal(409, 'not_set_up', `${APP_NAME[app]} is not set up in the Arr Stack plug-in.`)
    return c
  }

  async settings(app: App): Promise<GiveUpSettings> {
    return storedSettings(await this.d.store.getSetting<unknown>(`settings:${app}`))
  }
  private async appState(app: App): Promise<AppState> { return (await this.d.store.getSetting<AppState>(`state:${app}`)) ?? { historyId: 0 } }
  /** Merged into the stored state field by field (compare-and-set), so two writers never undo each other's claim. */
  private async patchAppState(app: App, p: Partial<AppState>) { await this.d.store.patchSetting(`state:${app}`, p as Record<string, unknown>) }

  // ── reading ────────────────────────────────────────────────────────────────

  private async allPages(c: CoreEndpointClient, path: string, size = 1000, maxPages = 50): Promise<any[]> {
    const out: any[] = []
    for (let p = 1; p <= maxPages; p++) {
      const page = await c.get(`${path}${path.includes('?') ? '&' : '?'}page=${p}&pageSize=${size}`, READ_MS)
      const recs: any[] = Array.isArray(page?.records) ? page.records : []
      out.push(...recs)
      if (!recs.length || out.length >= (Number(page?.totalRecords) || 0)) return out
    }
    throw new Error('The list was longer than HyperProx reads at once.')
  }

  private async missing(c: CoreEndpointClient, app: App) {
    const now = this.d.now()
    if (app === 'sonarr') return sonarrItems(await this.allPages(c, '/api/v3/wanted/missing?monitored=true&includeSeries=true&sortKey=airDateUtc&sortDirection=descending'))
    if (app === 'radarr') return radarrItems(await this.allPages(c, '/api/v3/wanted/missing?monitored=true&sortKey=movieMetadata.digitalRelease&sortDirection=descending'), now)
    return lidarrItems(await this.allPages(c, '/api/v1/wanted/missing?monitored=true&includeArtist=true&sortKey=releaseDate&sortDirection=descending'), now)
  }

  /** The queue, every page. Its rows are matched to items HERE: never trust a filter in the query. */
  private async queue(c: CoreEndpointClient, app: App): Promise<any[]> {
    const extra = app === 'sonarr' ? 'includeUnknownSeriesItems=true' : app === 'radarr' ? 'includeUnknownMovieItems=true' : 'includeUnknownArtistItems=true'
    return this.allPages(c, `${API[app]}/queue?${extra}`, 500, 20)
  }
  private queueIds(app: App, recs: any[]): Set<number> {
    const out = new Set<number>()
    for (const r of recs) { const id = Number(r?.[ID_FIELD[app]]); if (Number.isInteger(id) && id > 0) out.add(id) }
    return out
  }

  /** History newer than `afterId`, newest first, at most 10 pages (the first reading looks back that far). */
  private async history(c: CoreEndpointClient, app: App, afterId: number): Promise<any[]> {
    const out: any[] = []
    for (let p = 1; p <= 10; p++) {
      const page = await c.get(`${API[app]}/history?page=${p}&pageSize=500&sortKey=date&sortDirection=descending`, READ_MS)
      const recs: any[] = Array.isArray(page?.records) ? page.records : []
      out.push(...recs)
      if (!recs.length || recs.some(r => Number(r?.id) <= afterId) || out.length >= (Number(page?.totalRecords) || 0)) break
    }
    return out
  }

  // ── observe ────────────────────────────────────────────────────────────────

  /** One reading of one app folded into the counts. Read-only against the arr. */
  async observe(app: App): Promise<{ app: App; tracking: number; newTries: number; dropped: number } | null> {
    return this.locked(() => this.observeNow(app))
  }
  private async observeNow(app: App): Promise<{ app: App; tracking: number; newTries: number; dropped: number } | null> {
    const c = await this.client(app, false)
    if (!c) return null
    const [items, q] = await Promise.all([this.missing(c, app), this.queue(c, app)])
    const inQueue = this.queueIds(app, q)
    const st = await this.appState(app)
    const events = historyEvents(app, await this.history(c, app, st.historyId))
    const prev = await this.d.store.tracks(app)
    const res = fold(prev, items, events, st.historyId, this.iso(), inQueue)
    if (app === 'sonarr') {
      const series = await c.get('/api/v3/series', READ_MS).catch(() => null)
      if (Array.isArray(series)) {
        const whole = wholeSeasons(series, res.tracks.filter(t => t.state === 'tracking'))
        for (const t of res.tracks) if (t.state === 'tracking' && t.seriesId) {
          const w = whole.has(`${t.seriesId}:${t.season}`)
          if (w) t.wholeSeason = true; else delete t.wholeSeason
        }
      }
    }
    // A given-up item that has since got a file (someone fetched it by hand) or left the library is no longer ours.
    const done = await this.settled(c, app, res.tracks.filter(t => t.state === 'given-up' && t.action === 'unmonitor'))
    await this.d.store.save(res.tracks.filter(t => !done.has(t.key)))
    await this.d.store.drop([...res.dropped, ...done])
    await this.patchAppState(app, { historyId: res.historyId, observedAt: this.iso() })
    return { app, tracking: res.tracks.filter(t => t.state === 'tracking').length, newTries: res.newTries, dropped: res.dropped.length + done.size }
  }

  /** Keys of given-up items that now have a file, or are gone from the arr. */
  private async settled(c: CoreEndpointClient, app: App, tracks: Track[]): Promise<Set<string>> {
    const out = new Set<string>()
    if (!tracks.length) return out
    const live = await this.live(c, app, tracks.map(t => t.arrId)).catch(() => null)
    if (!live) return out
    for (const t of tracks) { const l = live.get(t.arrId); if (!l || l.hasFile) out.add(t.key) }
    return out
  }

  /** The live state of items, by id: whether each still exists, has a file and is monitored. */
  private async live(c: CoreEndpointClient, app: App, ids: number[]): Promise<Map<number, { hasFile: boolean; monitored: boolean; raw: any }>> {
    const out = new Map<number, { hasFile: boolean; monitored: boolean; raw: any }>()
    if (app === 'sonarr' || app === 'lidarr') {
      const field = app === 'sonarr' ? 'episodeIds' : 'albumIds'
      for (const part of chunk(ids, 100)) {
        const list = await c.get(`${API[app]}/${app === 'sonarr' ? 'episode' : 'album'}?${part.map(i => `${field}=${i}`).join('&')}`, READ_MS)
        for (const r of Array.isArray(list) ? list : []) {
          const id = Number(r?.id)
          if (!part.includes(id)) continue
          const hasFile = app === 'sonarr' ? r.hasFile === true || Number(r.episodeFileId) > 0 : Number(r.statistics?.trackFileCount) > 0 || Number(r.statistics?.sizeOnDisk) > 0
          out.set(id, { hasFile, monitored: r.monitored === true, raw: r })
        }
      }
      return out
    }
    for (const id of ids) {
      const m = await c.get(`/api/v3/movie/${id}`, READ_MS).catch((e: any) => { if (/\b404\b|not found/i.test(msg(e))) return null; throw e })
      if (m && Number(m.id) === id) out.set(id, { hasFile: m.hasFile === true || Number(m.movieFileId) > 0 || Number(m.sizeOnDisk) > 0, monitored: m.monitored === true, raw: m })
    }
    return out
  }

  // ── status and preview ─────────────────────────────────────────────────────

  async status(): Promise<{ apps: Array<{ app: App; configured: boolean; settings: GiveUpSettings; tracking: number; givenUp: number; soon: number; observedAt: string | null; lastRun: RunResult | null; lastSearch: (SearchRun & { when: string }) | null; nextSearch: string | null
      /** Server-time wording ("Monday 08:00") and the server's clock, so the panel words every time the same way. */
      nextSearchWhen: string | null; clock: ReturnType<typeof serverClock> }>; givenUp: Row[] }> {
    const apps = []
    const given: Track[] = []
    for (const app of APPS) {
      const configured = !!(await this.d.clients[app]().catch(() => null))
      const all = await this.d.store.tracks(app)
      const s = await this.settings(app)
      const st = await this.appState(app)
      const tracking = all.filter(t => t.state === 'tracking')
      given.push(...all.filter(t => t.state === 'given-up'))
      // Close: one more week (and one more weekly search) would do it.
      const soon = s.weeks > 1 ? candidates(tracking, { weeks: s.weeks - 1 }, this.d.now()).length - candidates(tracking, s, this.d.now()).length : 0
      apps.push({
        app, configured, settings: s, tracking: tracking.length, givenUp: all.length - tracking.length, soon, observedAt: st.observedAt ?? null,
        lastRun: st.lastRun ?? null, lastSearch: st.lastSearch ? { ...st.lastSearch, when: localWhen(Date.parse(st.lastSearch.at)) } : null,
        nextSearch: s.search.enabled ? new Date(nextSearchAt(this.d.now(), s.search, st.searchWeek)).toISOString() : null,
        nextSearchWhen: s.search.enabled ? localWhen(nextSearchAt(this.d.now(), s.search, st.searchWeek)) : null,
        clock: serverClock(this.d.now(), st.searchWeek),
      })
    }
    return { apps, givenUp: rows(given).sort((a, b) => String(b.gaveUpAt).localeCompare(String(a.gaveUpAt))).slice(0, 500) }
  }

  /** Given-up counts per app, for the Missing panel. */
  async givenUpCounts(): Promise<Record<App, number>> {
    const out = { sonarr: 0, radarr: 0, lidarr: 0 }
    for (const t of await this.d.store.tracks()) if (t.state === 'given-up') out[t.app] += 1
    return out
  }

  /** Exactly what the rule would give up on today, from fresh counts. Changes nothing in the arr. */
  async preview(app: App, s: ParsedSettings): Promise<{ previewId: string; app: App; summary: string; count: number; series?: number; rows: Row[]; reasons: ReturnType<typeof reasonCounts>; tracking: number; capped: boolean; observedAt: string | null }> {
    const c = await this.client(app)
    const st = await this.appState(app)
    if (!st.observedAt || this.d.now() - Date.parse(st.observedAt) > 3600_000) await this.observe(app)
    const tracks = await this.d.store.tracks(app)
    const inQueue = this.queueIds(app, await this.queue(c!, app))
    const list = candidates(tracks, s, this.d.now(), inQueue)
    const id = crypto.randomBytes(12).toString('hex')
    this.previews.set(id, { id, app, settings: s, at: this.d.now(), count: list.length })
    for (const [k, p] of this.previews) if (this.d.now() - p.at > PREVIEW_TTL_MS) this.previews.delete(k)
    return {
      previewId: id, app, summary: summarise({ [app]: list }), count: list.length,
      ...(app === 'sonarr' ? { series: new Set(list.map(t => t.seriesId ?? t.title)).size } : {}),
      rows: rows(list).slice(0, 400), reasons: reasonCounts(list), tracking: tracks.filter(t => t.state === 'tracking').length,
      capped: list.length > MAX_PER_RUN, observedAt: (await this.appState(app)).observedAt ?? null,
    }
  }

  /** Save one app's rule. Turning it on (or changing the rule while on) needs a preview of that exact rule. */
  async saveSettings(app: App, given: ParsedSettings, previewId: unknown, by: string): Promise<GiveUpSettings> {
    const cur = await this.settings(app)
    // A body without the weekly search keeps the one already saved.
    const s: GiveUpSettings = { ...given, search: given.search ?? cur.search }
    if (s.enabled && !(cur.enabled && sameRule(cur, s))) {
      const p = typeof previewId === 'string' ? this.previews.get(previewId) : undefined
      if (!p || p.app !== app || !sameRule(p.settings, s) || this.d.now() - p.at > PREVIEW_TTL_MS) {
        throw new GiveUpRefusal(409, 'preview_required', 'Look at the preview of this rule first, then confirm it. A preview is good for 15 minutes.')
      }
      this.previews.delete(p.id)
    }
    await this.d.audit('arrstack.giveup.settings', { app, by, enabled: s.enabled, weeks: s.weeks, action: s.action, weeklySearch: s.search })
    await this.locked(() => this.d.store.setSetting(`settings:${app}`, s, by))
    return s
  }

  // ── the daily run ──────────────────────────────────────────────────────────

  /** One timer tick: observe every app; once a week its search, once a day its give-up run. Skips while locked. */
  async tick(): Promise<RunResult[]> {
    if (!this.d.unlocked() || this.busy) return []
    this.busy = true
    const out: RunResult[] = []
    try {
      for (const app of APPS) {
        const st = await this.appState(app)
        if (!st.observedAt || this.d.now() - Date.parse(st.observedAt) >= OBSERVE_EVERY_MS - 60_000) {
          await this.observe(app).catch(e => this.d.log?.(`[arr-giveup] ${app}: reading failed: ${msg(e)}`))
        }
        await this.weeklySearch(app, 'the weekly search').catch(e => this.d.log?.(`[arr-giveup] ${app}: weekly search failed: ${msg(e)}`))
        const s = await this.settings(app)
        if (!s.enabled || !this.d.unlocked()) continue
        // Once per calendar day (UTC), claimed in the database first, so two processes (or a restart) never run it twice.
        if (!(await this.d.store.claimSetting(`state:${app}`, 'lastActDay', dayOf(this.d.now())))) continue
        const r = await this.run(app, s, 'the daily run').catch(e => ({ at: this.iso(), app, given: 0, skipped: [], failed: [], error: msg(e) } as RunResult))
        out.push(r)
      }
    } finally { this.busy = false }
    return out
  }

  /**
   * The weekly search, when it is due: the arr's own "search for everything missing" command. The week is claimed in
   * the database before anything is sent (compare-and-set: of two processes or ticks, one wins; a failed search is not
   * retried that week). The claim is short; the missing count and the command run outside the shared lock. Audited,
   * and the command read back: "queued" is not "done". Null when it was not due (or another caller took the week).
   *
   * Weeks and the slot are in the server's local time. If the server's time zone changes, the week key and the slot
   * move with it: at worst one week's search runs twice (the new zone's week has no claim yet) or once a day early or
   * late. Nothing else depends on it.
   */
  async weeklySearch(app: App, by: string): Promise<SearchRun | null> {
    const claimed = await this.locked(async () => {
      const s = await this.settings(app)
      const st = await this.appState(app)
      if (!searchDue(this.d.now(), s.search, st.searchWeek)) return false
      return this.d.store.claimSetting(`state:${app}`, 'searchWeek', weekKey(this.d.now()))
    })
    if (!claimed) return null
    const run: SearchRun = { at: this.iso(), app, count: 0, commandId: null, status: 'not started' }
    try {
      const c = (await this.client(app))!
      if (!c.post) throw new Error('Searches cannot be started from here.')
      run.count = (await this.missing(c, app)).length
      // Locked while it read the list (an idle sign-out): the keys may be gone, so it does not start.
      if (!this.d.unlocked()) throw new Error('HyperProx locked before the search could start.')
      await this.d.audit('arrstack.giveup.weekly-search', { app, by, command: MISSING_COMMAND[app].name, missing: run.count })
      const cmd = await c.post(`${API[app]}/command`, MISSING_COMMAND[app], READ_MS)
      run.commandId = Number.isInteger(Number(cmd?.id)) ? Number(cmd.id) : null
      run.status = String(cmd?.status ?? 'unknown')
      if (run.commandId !== null) {
        await this.sleep(5000)
        const back = await c.get(`${API[app]}/command/${run.commandId}`, 15_000).catch(() => null)
        if (back?.status) run.status = String(back.status)
        if (back?.status === 'failed' && back?.message) run.error = String(back.message).slice(0, 160)
      }
    } catch (e) { run.error = msg(e); run.status = 'failed' }
    await this.patchAppState(app, { lastSearch: run })
    return run
  }

  /** Give up on what the rule says, now. Every candidate is re-read live first. */
  async run(app: App, s: GiveUpSettings, by: string): Promise<RunResult> {
    return this.locked(() => this.runNow(app, s, by))
  }
  private async runNow(app: App, s: GiveUpSettings, by: string): Promise<RunResult> {
    const c = (await this.client(app))!
    const res: RunResult = { at: this.iso(), app, given: 0, skipped: [], failed: [] }
    // Claimed before anything changes (the tick claims the day first): a run that fails part-way is not run again that day.
    await this.patchAppState(app, { lastActAt: res.at, lastActDay: dayOf(this.d.now()) })
    const tracks = await this.d.store.tracks(app)
    const inQueue = this.queueIds(app, await this.queue(c, app))
    const list = candidates(tracks, s, this.d.now(), inQueue).slice(0, MAX_PER_RUN)
    const live = list.length ? await this.live(c, app, list.map(t => t.arrId)) : new Map()
    const ok: Track[] = []
    for (const t of list) {
      const l = live.get(t.arrId)
      if (!l) { res.skipped.push({ title: label(t), why: `It is no longer in ${APP_NAME[app]}.` }); continue }
      if (l.hasFile) { res.skipped.push({ title: label(t), why: 'It has a file now.' }); continue }
      if (!l.monitored) { res.skipped.push({ title: label(t), why: 'It is already not being searched for.' }); continue }
      ok.push(t)
    }
    await this.d.audit('arrstack.giveup.run', { app, by, action: s.action, weeks: s.weeks, count: ok.length, items: ok.slice(0, 50).map(label) })
    const given: Track[] = []
    if (ok.length && (s.action === 'unmonitor' || app === 'sonarr')) {
      for (const part of chunk(ok, 100)) {
        try {
          await this.setMonitored(c, app, part.map(t => t.arrId), false)
          const back = await this.live(c, app, part.map(t => t.arrId))
          const done: Track[] = []
          for (const t of part) {
            if (back.get(t.arrId)?.monitored === false) done.push(this.markGiven(t, 'unmonitor'))
            else res.failed.push({ title: label(t), why: `${APP_NAME[app]} still has it as searched for after the change.` })
          }
          // Saved as soon as it is read back, so a later failure cannot lose what already changed.
          await this.d.store.save(done)
          given.push(...done)
        } catch (e) { for (const t of part) res.failed.push({ title: label(t), why: msg(e) }) }
      }
    } else if (ok.length) {
      for (const t of ok) {
        try { const g = await this.removeOne(c, app, t, live.get(t.arrId)!.raw); await this.d.store.save([g]); given.push(g) }
        catch (e) { res.failed.push({ title: label(t), why: msg(e) }) }
      }
    }
    res.given = given.length
    // The change is made and saved: an audit failure now is logged, never thrown (that would hide what was done).
    await this.d.audit('arrstack.giveup.run.done', { app, by, given: given.length, skipped: res.skipped.length, failed: res.failed.length, failures: res.failed.slice(0, 10) })
      .catch(e => this.d.log?.(`[arr-giveup] ${app}: the after-run audit entry could not be written: ${msg(e)}`))
    await this.patchAppState(app, { lastRun: { ...res, skipped: res.skipped.slice(0, 20), failed: res.failed.slice(0, 20) } })
    const m = giveUpMessage(given)
    if (m) {
      await this.d.publish({
        type: 'arr.gaveup', severity: 'info', title: m.title, lines: m.lines, plain: m.plain,
        link: '/plugins/arrstack', linkLabel: 'Open the Arr Stack in HyperProx', where: 'Arr Stack page',
        fingerprint: `arr.gaveup:${app}:${res.at}`,
      }).catch(e => this.d.log?.(`[arr-giveup] notification failed: ${msg(e)}`))
    }
    return res
  }

  private markGiven(t: Track, action: 'unmonitor' | 'remove', restore?: Restore): Track {
    const r = classify(t)
    return { ...t, state: 'given-up', gaveUpAt: this.iso(), action, reason: r.text, reasonCode: r.code, ...(restore ? { restore } : {}) }
  }

  private async setMonitored(c: CoreEndpointClient, app: App, ids: number[], monitored: boolean) {
    if (app === 'sonarr') return c.put('/api/v3/episode/monitor', { episodeIds: ids, monitored }, READ_MS)
    if (app === 'radarr') return c.put('/api/v3/movie/editor', { movieIds: ids, monitored }, READ_MS)
    return c.put('/api/v1/album/monitor', { albumIds: ids, monitored }, READ_MS)
  }

  /** Remove one film or album from the library: never its files (there are none: checked again here). */
  private async removeOne(c: CoreEndpointClient, app: App, t: Track, raw: any): Promise<Track> {
    if (app === 'radarr') {
      if (raw.hasFile || Number(raw.movieFileId) > 0 || Number(raw.sizeOnDisk) > 0) throw new Error('It has a file: left alone.')
      const path = typeof raw.path === 'string' ? raw.path : undefined
      const restore: Restore = {
        tmdbId: Number(raw.tmdbId) || undefined, year: Number(raw.year) || undefined, qualityProfileId: Number(raw.qualityProfileId) || undefined,
        rootFolderPath: typeof raw.rootFolderPath === 'string' && raw.rootFolderPath ? raw.rootFolderPath : path ? path.replace(/\/[^/]+\/?$/, '') : undefined,
        path, minimumAvailability: typeof raw.minimumAvailability === 'string' ? raw.minimumAvailability : undefined,
        tags: Array.isArray(raw.tags) ? raw.tags.filter((x: unknown) => Number.isInteger(x)) : [],
      }
      if (!restore.tmdbId || !restore.qualityProfileId || !restore.rootFolderPath) throw new Error('Radarr did not say enough about it to add it back later, so it was left in.')
      await c.delete(`/api/v3/movie/${t.arrId}?deleteFiles=false&addImportExclusion=true`, READ_MS)
      const still = await c.get(`/api/v3/movie/${t.arrId}`, READ_MS).then(() => true, (e: any) => (/\b404\b|not found/i.test(msg(e)) ? false : true))
      if (still) throw new Error('Radarr still lists it after the removal.')
      return this.markGiven(t, 'remove', restore)
    }
    // Lidarr
    if (Number(raw.statistics?.trackFileCount) > 0 || Number(raw.statistics?.sizeOnDisk) > 0) throw new Error('It has files: left alone.')
    const artist = raw.artist && typeof raw.artist === 'object' ? raw.artist : await c.get(`/api/v1/artist/${raw.artistId}`, READ_MS)
    const restore: Restore = {
      foreignAlbumId: typeof raw.foreignAlbumId === 'string' ? raw.foreignAlbumId : undefined,
      artist: artist ? {
        id: artist.id, foreignArtistId: artist.foreignArtistId, artistName: artist.artistName, qualityProfileId: artist.qualityProfileId,
        metadataProfileId: artist.metadataProfileId, rootFolderPath: artist.rootFolderPath, path: artist.path, monitored: artist.monitored,
      } : undefined,
    }
    if (!restore.foreignAlbumId || !restore.artist?.foreignArtistId) throw new Error('Lidarr did not say enough about it to add it back later, so it was left in.')
    await c.delete(`/api/v1/album/${t.arrId}?deleteFiles=false&addImportListExclusion=true`, READ_MS)
    const still = await c.get(`/api/v1/album/${t.arrId}`, READ_MS).then(() => true, (e: any) => (/\b404\b|not found/i.test(msg(e)) ? false : true))
    if (still) throw new Error('Lidarr still lists it after the removal.')
    return this.markGiven(t, 'remove', restore)
  }

  // ── try again ──────────────────────────────────────────────────────────────

  async tryAgain(keys: string[], by: string): Promise<{ summary: string; notes: string[] }> {
    return this.locked(() => this.tryAgainNow(keys, by))
  }
  private async tryAgainNow(keys: string[], by: string): Promise<{ summary: string; notes: string[] }> {
    const parsed = keys.map(parseKey)
    if (!parsed.length || parsed.some(p => !p) || new Set(parsed.map(p => p!.app)).size !== 1) throw new GiveUpRefusal(400, 'bad_request', 'Name the items to try again.')
    const app = parsed[0]!.app
    const all = new Map((await this.d.store.tracks(app)).map(t => [t.key, t]))
    const list = keys.map(k => all.get(k)).filter((t): t is Track => !!t && t.state === 'given-up')
    if (list.length !== keys.length) throw new GiveUpRefusal(404, 'not_given_up', 'That is not on the given-up list any more. Refresh the page.')
    const c = (await this.client(app))!
    await this.d.audit('arrstack.giveup.tryagain', { app, by, items: list.slice(0, 50).map(label) })
    const notes: string[] = []
    const monitorable = list.filter(t => t.action !== 'remove')
    const removed = list.filter(t => t.action === 'remove')
    const fresh: Track[] = []
    if (monitorable.length) {
      await this.setMonitored(c, app, monitorable.map(t => t.arrId), true)
      const back = await this.live(c, app, monitorable.map(t => t.arrId))
      const on = monitorable.filter(t => back.get(t.arrId)?.monitored === true)
      for (const t of monitorable) if (!on.includes(t)) notes.push(`${label(t)}: ${APP_NAME[app]} did not take the change.`)
      if (on.length) notes.push(await this.search(c, app, on.map(t => t.arrId)))
      fresh.push(...on.map(t => this.retracked(t)))
    }
    let addedBack = 0
    for (const t of removed) {
      try { notes.push(await this.addBack(c, app, t)); await this.d.store.drop([t.key]); addedBack += 1 }
      catch (e) { notes.push(`${label(t)}: ${msg(e)}`) }
    }
    await this.d.store.save(fresh)
    const done = fresh.length + addedBack
    await this.d.audit('arrstack.giveup.tryagain.done', { app, by, done, notes: notes.slice(0, 10) })
    return { summary: done === list.length ? `Trying again: ${done} ${done === 1 ? APP_WHAT[app].one : APP_WHAT[app].many}.` : `Tried again on ${done} of ${list.length}.`, notes }
  }

  /** Back to being counted, from zero. */
  private retracked(t: Track): Track {
    const { gaveUpAt: _g, action: _a, reason: _r, reasonCode: _c, restore: _x, lastTryWeek: _w, ...rest } = t
    return { ...rest, state: 'tracking', tries: 0, grabs: 0, failures: 0, importFailures: 0, firstMissingAt: this.iso(), lastSearchSeen: this.iso() }
  }

  /** Ask the arr to search, and read the command back: "queued" is not "done". */
  private async search(c: CoreEndpointClient, app: App, ids: number[]): Promise<string> {
    if (!c.post) return 'A search could not be started from here.'
    const body = app === 'sonarr' ? { name: 'EpisodeSearch', episodeIds: ids } : app === 'radarr' ? { name: 'MoviesSearch', movieIds: ids } : { name: 'AlbumSearch', albumIds: ids }
    const cmd = await c.post(`${API[app]}/command`, body, READ_MS)
    const id = Number(cmd?.id)
    if (!Number.isInteger(id)) return `Asked ${APP_NAME[app]} to search; it did not say whether it started.`
    await this.sleep(3000)
    const back = await c.get(`${API[app]}/command/${id}`, 15_000).catch(() => null)
    const status = String(back?.status ?? cmd?.status ?? 'unknown')
    return status === 'completed' ? `${APP_NAME[app]} searched; anything it grabbed is in the queue.`
      : status === 'failed' ? `${APP_NAME[app]}'s search failed${back?.message ? `: ${String(back.message).slice(0, 120)}` : ''}.`
      : `${APP_NAME[app]} is searching (${status}); anything it grabs shows in the queue.`
  }

  /** Add a removed film or album back, with the profile and folder it had, and search for it. */
  private async addBack(c: CoreEndpointClient, app: App, t: Track): Promise<string> {
    const r = t.restore ?? {}
    if (!c.post) throw new Error('It cannot be added back from here.')
    if (app === 'radarr') {
      if (!r.tmdbId || !r.qualityProfileId || !r.rootFolderPath) throw new Error('HyperProx does not know enough to add it back. Add it in Radarr.')
      const ex = await c.get('/api/v3/exclusions', READ_MS).catch(() => [])
      for (const e of Array.isArray(ex) ? ex : []) if (Number(e?.tmdbId) === r.tmdbId && Number.isInteger(Number(e.id))) await c.delete(`/api/v3/exclusions/${Number(e.id)}`, READ_MS)
      const added = await c.post('/api/v3/movie', {
        title: t.title, tmdbId: r.tmdbId, year: r.year, qualityProfileId: r.qualityProfileId, rootFolderPath: r.rootFolderPath,
        ...(r.path ? { path: r.path } : {}), minimumAvailability: r.minimumAvailability ?? 'released', tags: r.tags ?? [], monitored: true,
        addOptions: { searchForMovie: true },
      }, READ_MS)
      const id = Number(added?.id)
      const back = Number.isInteger(id) ? await c.get(`/api/v3/movie/${id}`, READ_MS).catch(() => null) : null
      if (!back || Number(back.tmdbId) !== r.tmdbId) throw new Error('Radarr did not show it after adding it back. Check Radarr.')
      return `${label(t)}: back in Radarr with the same profile and folder, and searching.`
    }
    if (!r.foreignAlbumId || !r.artist) throw new Error('HyperProx does not know enough to add it back. Add it in Lidarr.')
    const ex = await c.get('/api/v1/importlistexclusion', READ_MS).catch(() => [])
    for (const e of Array.isArray(ex) ? ex : []) if (e?.foreignId === r.foreignAlbumId && Number.isInteger(Number(e.id))) await c.delete(`/api/v1/importlistexclusion/${Number(e.id)}`, READ_MS)
    const added = await c.post('/api/v1/album', {
      foreignAlbumId: r.foreignAlbumId, title: t.detail, monitored: true, anyReleaseOk: true, artist: r.artist, artistId: r.artist.id,
      addOptions: { searchForNewAlbum: true },
    }, READ_MS)
    const id = Number(added?.id)
    const back = Number.isInteger(id) ? await c.get(`/api/v1/album/${id}`, READ_MS).catch(() => null) : null
    if (!back || back.foreignAlbumId !== r.foreignAlbumId) throw new Error('Lidarr did not show it after adding it back. Check Lidarr.')
    return `${label(t)}: back in Lidarr and searching.`
  }

  // ── see what's available, and download one ────────────────────────────────

  /**
   * One interactive search for one item ("sonarr:123", "radarr:45", "lidarr:6") or one TV season
   * ("sonarr-season:<series>:<season>"). At most once per item every ten minutes: in between, the last answer.
   */
  async releases(target: string, by: string, opts: { showZeroSeed?: boolean } = {}): Promise<ReleaseView & { target: string; label: string; searchedAt: string; reused: boolean; nextSearchAt: string }> {
    const t = parseTarget(target)
    if (!t) throw new GiveUpRefusal(400, 'bad_request', 'Name one item.')
    target = t.target
    const now = this.d.now()
    let s = this.searches.get(target)
    let reused = true
    if (!s || now - s.at >= SEARCH_COOLDOWN_MS) {
      reused = false
      const c = (await this.client(t.app))!
      const track = t.key ? (await this.d.store.tracks(t.app)).find(x => x.key === t.key) : undefined
      if (track?.action === 'remove') throw new GiveUpRefusal(409, 'removed', `It is no longer in ${APP_NAME[t.app]}. Use "Try again" to add it back first.`)
      const info = await this.describe(c, t, track)
      await this.d.audit('arrstack.giveup.releases', { app: t.app, by, item: info.label })
      const q = t.season !== undefined ? `seriesId=${t.seriesId}&seasonNumber=${t.season}` : `${ID_FIELD[t.app]}=${t.arrId}`
      const raw = await c.get(`${API[t.app]}/release?${q}`, 180_000)
      const given = t.season !== undefined
        ? (await this.d.store.tracks('sonarr')).filter(x => x.state === 'given-up' && x.seriesId === t.seriesId && x.season === t.season).map(x => x.key)
        : track?.state === 'given-up' ? [track.key] : []
      s = { target, app: t.app, at: now, raw: Array.isArray(raw) ? raw : [], profile: info.profile, label: info.label, wanted: new Set(info.ids), seriesId: t.seriesId, season: t.season, givenUpKeys: given }
      this.searches.set(target, s)
      for (const [k, v] of this.searches) if (now - v.at > GRAB_WINDOW_MS) this.searches.delete(k)
      // What it found becomes part of the item's reason.
      const view = releaseView(s.raw, { app: t.app, profile: s.profile, showZeroSeed: true })
      await this.locked(async () => {
        const tracks = (await this.d.store.tracks(t.app)).filter(x => (t.key ? x.key === t.key : x.seriesId === t.seriesId && x.season === t.season))
        for (const x of tracks) x.check = { at: new Date(now).toISOString(), found: view.found, approved: view.approved, top: view.top }
        await this.d.store.save(tracks)
      })
    }
    const v = releaseView(s.raw, { app: s.app, profile: s.profile, showZeroSeed: !!opts.showZeroSeed })
    return {
      rows: v.rows, found: v.found, approved: v.approved, hidden: v.hidden, top: v.top,
      target, label: s.label, searchedAt: new Date(s.at).toISOString(), reused, nextSearchAt: new Date(s.at + SEARCH_COOLDOWN_MS).toISOString(),
    }
  }

  /** The item's name, the ids it covers and its quality profile. */
  /**
   * Only something still missing may be searched for: an item with no file that is tracked, given up, or monitored
   * (what the Missing panel lists). A season counts only its episodes with no file, and needs at least one.
   */
  private async describe(c: CoreEndpointClient, t: Target, track?: Track): Promise<{ label: string; ids: number[]; profile: ReturnType<typeof profileInfo> }> {
    const notMissing = () => new GiveUpRefusal(409, 'not_missing', 'Only something still missing can be searched for here: it is not monitored, and HyperProx is not tracking it.')
    const prof = async (id: unknown) => {
      const n = Number(id)
      return Number.isInteger(n) && n > 0 ? profileInfo(await c.get(`${API[t.app]}/qualityprofile/${n}`, READ_MS).catch(() => null)) : null
    }
    if (t.app === 'sonarr') {
      if (t.season !== undefined) {
        const series = await c.get(`/api/v3/series/${t.seriesId}`, READ_MS)
        const eps = await c.get(`/api/v3/episode?seriesId=${t.seriesId}&seasonNumber=${t.season}`, READ_MS).catch(() => [])
        const season = (Array.isArray(eps) ? eps : []).filter((e: any) => Number(e?.seasonNumber) === t.season && Number(e?.seriesId) === t.seriesId)
        const tracked = new Set((await this.d.store.tracks('sonarr')).filter(x => x.seriesId === t.seriesId && x.season === t.season).map(x => x.arrId))
        const ids = season.filter((e: any) => !(e.hasFile === true || Number(e.episodeFileId) > 0) && (e.monitored === true || tracked.has(Number(e.id)))).map((e: any) => Number(e.id))
        if (!ids.length) throw new GiveUpRefusal(409, 'has_file', 'Every episode of that season has a file, or is not being looked for.')
        return { label: `${String(series?.title ?? 'A show')} Season ${t.season}`, ids, profile: await prof(series?.qualityProfileId) }
      }
      const e = await c.get(`/api/v3/episode/${t.arrId}`, READ_MS)
      const series = await c.get(`/api/v3/series/${e?.seriesId}`, READ_MS)
      if (e?.hasFile || Number(e?.episodeFileId) > 0) throw new GiveUpRefusal(409, 'has_file', 'It has a file now.')
      if (!track && e?.monitored !== true) throw notMissing()
      const code = `S${String(e?.seasonNumber ?? 0).padStart(2, '0')}E${String(e?.episodeNumber ?? 0).padStart(2, '0')}`
      return { label: `${String(series?.title ?? 'A show')} ${code}`, ids: [t.arrId!], profile: await prof(series?.qualityProfileId) }
    }
    if (t.app === 'radarr') {
      const m = await c.get(`/api/v3/movie/${t.arrId}`, READ_MS)
      if (m?.hasFile || Number(m?.movieFileId) > 0) throw new GiveUpRefusal(409, 'has_file', 'It has a file now.')
      if (!track && m?.monitored !== true) throw notMissing()
      return { label: `${String(m?.title ?? 'A film')}${Number(m?.year) > 0 ? ` (${m.year})` : ''}`, ids: [t.arrId!], profile: await prof(m?.qualityProfileId) }
    }
    const a = await c.get(`/api/v1/album/${t.arrId}`, READ_MS)
    if (Number(a?.statistics?.trackFileCount) > 0) throw new GiveUpRefusal(409, 'has_file', 'It has files now.')
    if (!track && a?.monitored !== true) throw notMissing()
    const artist = a?.artist ?? await c.get(`/api/v1/artist/${a?.artistId}`, READ_MS).catch(() => null)
    return { label: `${String(artist?.artistName ?? 'An artist')}: ${String(a?.title ?? 'an album')}`, ids: [t.arrId!], profile: await prof(artist?.qualityProfileId) }
  }

  /**
   * Download one release from the last search, by HyperProx's row id. Allowed even when the arr rejected it; never a
   * hidden one (AV1, 3D, 48 fps) or one with a program file in its name. The quality profile is not changed. A given-up
   * item is searched for again (so a better copy can replace a poor one), and is counted again from zero.
   */
  async grab(target: string, releaseId: string, by: string): Promise<GrabResult> {
    const t = parseTarget(target)
    if (!t) throw new GiveUpRefusal(400, 'bad_request', 'Name one item.')
    const s = this.searches.get(t.target)
    if (!s || this.d.now() - s.at > GRAB_WINDOW_MS) throw new GiveUpRefusal(409, 'search_expired', 'That search is too old to download from. Look at what is available again.')
    if (s.used) throw new GiveUpRefusal(409, 'search_used', 'Something was already downloaded from this search. Look again once the next search is allowed.')
    const all = releaseView(s.raw, { app: s.app, profile: s.profile, showZeroSeed: true }).all
    const row = all.find(r => r.id === releaseId)
    if (!row) throw new GiveUpRefusal(404, 'no_release', 'That release is not one HyperProx can offer.')
    if (row.executable) throw new GiveUpRefusal(409, 'executable', 'That release has a program file in it, so HyperProx will not download it.')
    // Taken at once, so two clicks cannot both grab; given back only if the arr refuses the download.
    s.used = true
    try {
      const c = (await this.client(s.app))!
      if (!c.post) throw new GiveUpRefusal(409, 'cannot_grab', 'Downloads cannot be started from here.')
      await this.d.audit('arrstack.giveup.grab', { app: s.app, by, item: s.label, release: row.title, quality: row.quality, approved: row.approved, belowProfile: row.belowProfile, indexer: row.indexer })
      const before = new Set((await this.queue(c, s.app)).map(r => Number(r?.id)))
      await c.post(`${API[s.app]}/release`, { guid: row.guid, indexerId: row.indexerId }, 60_000)
      return await this.afterGrab(c, s, row, before, by)
    } catch (e) {
      if (!(e as any)?.grabbed) s.used = false
      throw e
    }
  }

  private async afterGrab(c: CoreEndpointClient, s: Search, row: ReleaseRow & { guid: string }, before: Set<number>, by: string): Promise<GrabResult> {
    try {
      const notes: string[] = []
      // A given-up item comes back: searched for again, counted from zero.
      if (s.givenUpKeys.length) {
        await this.locked(async () => {
          const tracks = (await this.d.store.tracks(s.app)).filter(t => s.givenUpKeys.includes(t.key) && t.state === 'given-up' && t.action !== 'remove')
          if (!tracks.length) return
          await this.setMonitored(c, s.app, tracks.map(t => t.arrId), true).catch(e => notes.push(`It could not be set to searched-for again: ${msg(e)}`))
          await this.d.store.save(tracks.map(t => this.retracked(t)))
          notes.push(`${tracks.length === 1 ? 'It is' : `${tracks.length} items are`} off the given-up list and searched for again.`)
        })
      }
      const out = await this.verifyGrab(c, s, row, before, notes, by)
      await this.d.audit('arrstack.giveup.grab.done', { app: s.app, by, item: s.label, result: out.result, filesChecked: out.filesChecked })
        .catch(e => this.d.log?.(`[arr-giveup] the after-grab audit entry could not be written: ${msg(e)}`))
      return out
    } catch (e) {
      // The arr took the download: the search stays used whatever failed after.
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), { grabbed: true })
    }
  }

  /**
   * Read the queue for about 20 s. When it shows up, check its files in qBittorrent for program files; a torrent often
   * has no file list yet, so it is looked at again 1, 3 and 10 minutes later and removed then if one turns up.
   */
  private async verifyGrab(c: CoreEndpointClient, s: Search, row: ReleaseRow & { guid: string }, before: Set<number>, notes: string[], by: string): Promise<GrabResult> {
    const wait = this.d.grabWaitMs ?? 20_000
    const step = Math.max(1, Math.min(5000, Math.floor(wait / 4)))
    let hit: any = null
    for (let waited = 0; waited <= wait && !hit; waited += step) {
      await this.sleep(step)
      const recs = await this.queue(c, s.app).catch(() => [])
      hit = this.findGrab(recs, s, row, before)
    }
    const unchecked = (why: string) => `Its files were not checked for program files: ${why}.`
    if (!hit) {
      notes.push(unchecked('it is not in the queue yet'))
      return { result: 'not-seen', filesChecked: false, summary: `${APP_NAME[s.app]} took the request, but the download is not in the queue yet. Check the Queue tab in a minute.`, notes }
    }
    const queued = { result: 'queued' as const, summary: `Downloading: ${row.title} is in the queue.` }
    if (row.protocol !== 'torrent') return { ...queued, filesChecked: false, notes: [...notes, unchecked('it is a usenet download, and its files are only known once it has downloaded')] }
    const qb = await this.d.qbit().catch(() => null)
    if (!qb) return { ...queued, filesChecked: false, notes: [...notes, unchecked('HyperProx has no qBittorrent connection in the Arr Stack settings')] }
    const hash = typeof hit.downloadId === 'string' ? hit.downloadId.toLowerCase() : ''
    if (!/^[0-9a-f]{40}$/.test(hash)) return { ...queued, filesChecked: false, notes: [...notes, unchecked('the queue did not say which torrent it is')] }
    const first = await this.checkFiles(c, qb, s.app, hash, row.title, by)
    if (first === 'removed') return { result: 'removed-executable', filesChecked: true, summary: 'It contained a program file, so HyperProx removed it and blocklisted it.', notes }
    if (first === 'clean') return { ...queued, filesChecked: true, notes: [...notes, 'Its files were checked: no program files.'] }
    this.scheduleRechecks(c, qb, s.app, hash, row.title, by)
    return { ...queued, filesChecked: false, notes: [...notes, 'Files not checked yet: qBittorrent does not have its file list. HyperProx looks again after 1, 3 and 10 minutes and removes it if a program file shows up.'] }
  }

  /** The new queue row for a grab, matched here: Sonarr's /queue ignores seriesId and answers with everything. */
  private findGrab(recs: any[], s: Search, row: { title: string }, before: Set<number>): any {
    return recs.find(r => !before.has(Number(r?.id)) && (s.wanted.has(Number(r?.[ID_FIELD[s.app]])) || (!!s.seriesId && Number(r?.seriesId) === s.seriesId && Number(r?.seasonNumber) === s.season)))
      ?? recs.find(r => !before.has(Number(r?.id)) && String(r?.title ?? '') === row.title)
  }

  /** One look at a torrent's files: 'removed' (a program file: removed and blocklisted), 'clean', or 'unknown' (no list yet). */
  private async checkFiles(c: CoreEndpointClient, qb: CoreEndpointClient, app: App, hash: string, title: string, by: string): Promise<'removed' | 'clean' | 'unknown'> {
    const files = await qb.get(`/api/v2/torrents/files?hash=${hash}`, 15_000).catch(() => null)
    if (!Array.isArray(files) || !files.length) return 'unknown'
    const bad = files.map((f: any) => String(f?.name ?? '')).filter(isProgramFile)
    if (!bad.length) return 'clean'
    // The queue is read fresh and matched here by the torrent's hash.
    const recs = await this.queue(c, app).catch(() => [])
    const q = recs.find(r => String(r?.downloadId ?? '').toLowerCase() === hash)
    if (q) await c.delete(`${API[app]}/queue/${Number(q.id)}?removeFromClient=true&blocklist=true`, 30_000)
    await this.d.audit('arrstack.giveup.grab.program-file', { app, by, release: title, file: bad[0].split('/').pop(), removed: !!q })
      .catch(e => this.d.log?.(`[arr-giveup] audit failed: ${msg(e)}`))
    if (!q) this.d.log?.(`[arr-giveup] ${title} holds a program file but is no longer in the queue`)
    return 'removed'
  }

  private scheduleRechecks(c: CoreEndpointClient, qb: CoreEndpointClient, app: App, hash: string, title: string, by: string) {
    const later = this.d.later ?? ((fn: () => void, ms: number) => { const t = setTimeout(fn, ms); t.unref?.() })
    let settled = false
    RECHECK_MS.forEach((ms, i) => later(() => {
      if (settled) return
      void this.checkFiles(c, qb, app, hash, title, by).then(r => {
        if (r !== 'unknown') { settled = true; return }
        if (i === RECHECK_MS.length - 1) {
          settled = true
          void this.d.audit('arrstack.giveup.grab.files-unchecked', { app, by, release: title }).catch(() => {})
          this.d.log?.(`[arr-giveup] ${title}: files not checked (qBittorrent never had its file list)`)
        }
      }, e => this.d.log?.(`[arr-giveup] file check failed: ${msg(e)}`))
    }, ms))
  }
}

export interface GrabResult { result: 'queued' | 'not-seen' | 'removed-executable'; filesChecked: boolean; summary: string; notes: string[] }

interface Target { app: App; target: string; key?: string; arrId?: number; seriesId?: number; season?: number }
/** A target, and its one spelling (built from the numbers, so "radarr:7" can only be written one way). */
export function parseTarget(v: unknown): Target | null {
  const k = parseKey(v)
  if (k) { const key = `${k.app}:${k.arrId}`; return { app: k.app, target: key, key, arrId: k.arrId } }
  const m = typeof v === 'string' ? /^sonarr-season:([1-9]\d{0,9}):(0|[1-9]\d{0,3})$/.exec(v) : null
  if (!m) return null
  const seriesId = Number(m[1]), season = Number(m[2])
  return { app: 'sonarr', target: `sonarr-season:${seriesId}:${season}`, seriesId, season }
}

const label = (t: Track) => `${t.title}${t.detail ? ` ${t.detail}` : ''}`

export { isApp }
