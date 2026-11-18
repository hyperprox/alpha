// =============================================================================
//  HyperProx — Arr Stack "Sort requests into the right folder": the service
//
//  Reads Radarr and Sonarr through the Arr Stack plug-in's own connections (the keys stay in the vault-backed
//  settings) and keeps its rules and bookmarks in the database (store.ts). The rules themselves are rules.ts.
//
//   tick      every minute (lib/services/bootstrap.ts), and never while HyperProx is locked. Cheap: it asks only for the
//             few ids after the highest one it has seen (a 404 means nothing new), and reads the whole library at most
//             every 15 minutes to catch anything those look-ups missed. A new item is moved only when it landed in the
//             request app's folder, was added after sorting was switched on and within the last day, carries no
//             "hpx-routed" tag and was never moved back by a person. Each move is audited BEFORE it is made (no audit
//             row, no move), made through the arr's editor (rootFolderPath with moveFiles, plus the tag) and read
//             back: the folder from the item, and the files from the arr's own move command, so a move whose files
//             are still on their way is "files moving" until a later minute sees the command finish (or fail). An
//             item the arr is importing right now waits for the next minute. At most 20 moves a minute per app.
//   test      "Test on my library": the rules over the whole library, read-only, compared with where everything is.
//   save      the rules for one app. Switching sorting on (or changing the rules while it is on) needs the id of a
//             library test of exactly those rules from the last 15 minutes.
//   move      "Undo / move to…": one item from the Recently sorted list to the folder a person picks. The router
//             never touches that item again.
//   graduate  "Graduate finished shows": the preview (ended, every aired episode on disk, still in the running-shows
//             folder of the enabled rules), then the move of exactly those, 20 a minute, which also switches graduating
//             on for shows that finish later (looked at every six hours). Its own record keeps only that it is on and
//             the two folders the preview showed. A show graduated once is never graduated again, so one a person moved
//             back stays where they put it.
//   library   "Sort my library": the saved rules over everything already there, as groups (from → to, the rule that
//             picked it), read-only, never out of or into a hand-picked folder. The preview is single-use, lasts 15
//             minutes and belongs to the person who asked for it. Applying it moves exactly the ticked items through
//             the same move as above (each checked again first: still where it was, the rules still pick the same
//             folder), sharing the minute's 20 moves per app, at most 60 items looked at a minute. The queue is kept in
//             the database, so it carries on after a restart. Stop takes effect before the next move (it does not wait
//             for the batch). An item that errors three times is marked failed and the sort goes on. "Undo this sort"
//             moves back every item it moved that is still where it put it, the same way. When a sort ends, and no file
//             move of it is still running (or after 30 minutes), a connected Plex server is asked to rescan once.
//
//  The routes are routes/arr-router.ts.
// =============================================================================

import crypto from 'node:crypto'
import type { CoreEndpointClient } from '../plugin-host'
import {
  APPS, CONDITION_LABEL, ROUTED_TAG, conditionsFor, curatedFolders, filledFolders, groupWord, leftAloneFolders, libraryPlan, defaultSettings, filmOf, folderName, graduateFolders, graduates, guessDefaultRoot, normRoot, parseSettings,
  pickFolder, routable, ruleFingerprint, showOf, testLibrary, whyWord,
  type App, type AppSettings, type Condition, type Item, type LibraryTest, type PlanGroup, type Show,
} from './rules'
import type { RouterStore } from './store'

export class RouterRefusal extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); this.name = 'RouterRefusal' }
}

export interface RouterDeps {
  clients: Record<App, () => Promise<CoreEndpointClient | null>>
  /** Seerr (or Overseerr, Jellyseerr), when connected: its settings say which folder requests arrive in. Optional. */
  seerr?: () => Promise<CoreEndpointClient | null>
  store: RouterStore
  /** Must throw when the row cannot be written: then nothing is moved. */
  audit(action: string, details: Record<string, unknown>): Promise<void>
  now(): number
  unlocked(): boolean
  log?(m: string): void
  /** The media server (the Plex plug-in's), when connected: asked to rescan once a library sort ends. Optional. */
  mediaServer?: () => Promise<CoreEndpointClient | null>
  /** Waits before the file move is first checked. Default: a real timer. */
  sleep?(ms: number): Promise<void>
}

export const APP_NAME: Record<App, string> = { radarr: 'Radarr', sonarr: 'Sonarr' }
export const APP_LABEL: Record<App, string> = { radarr: 'Films', sonarr: 'Shows' }
const API: Record<App, { list: string; one: (id: number) => string; editor: string; ids: string }> = {
  radarr: { list: '/api/v3/movie', one: id => `/api/v3/movie/${id}`, editor: '/api/v3/movie/editor', ids: 'movieIds' },
  sonarr: { list: '/api/v3/series', one: id => `/api/v3/series/${id}`, editor: '/api/v3/series/editor', ids: 'seriesIds' },
}

/** Only items added within this window are ever sorted (and only after sorting was switched on). */
export const LOOKBACK_MS = 24 * 3600_000
/** The whole library is read at most this often; in between only the next few ids are looked up. */
export const FULL_READ_MS = 15 * 60_000
export const TEST_TTL_MS = 15 * 60_000
export const MAX_MOVES_PER_TICK = 20
export const RECENT_MAX = 100
export const GRADUATE_EVERY_MS = 6 * 3600_000
/** How many missing ids in a row end a look-up (an id can be skipped when something is added and removed). */
const PROBE_MISSES = 3
const SUGGEST_TTL_MS = 10 * 60_000
const ROOTS_TTL_MS = 5 * 60_000
const MAX_LEAVE_ALONE = 2000
const MAX_GRADUATED = 5000
/** A file move the arr no longer lists after this long is reported as not confirmed. */
const FILES_CONFIRM_MS = 30 * 60_000
const MOVE_COMMAND = /move/i
const DONE = new Set(['completed'])
const BROKEN = new Set(['failed', 'aborted', 'cancelled', 'orphaned'])
const IMPORTING = new Set(['importpending', 'importing'])

const msg = (e: any) => String(e?.message ?? e).slice(0, 200)
const toItem = (app: App, raw: any): Item => (app === 'radarr' ? filmOf(raw) : showOf(raw))

export type MoveKind = 'sorted' | 'graduated' | 'moved' | 'library'
export interface Move {
  key: string; at: string; app: App; id: number; title: string; year: number
  from: string; to: string; kind: MoveKind; condition: Condition | null
  /** "Horror → Scary Films". */
  why: string
  /** What in the arr's data matched: "genre Horror". */
  detail: string
  /**
   * True only when the item is in the new folder AND its files are there (or it had none). A move whose files are still
   * on their way is not ok yet: `files` says "pending" until the arr's move command finishes.
   */
  by: string; ok: boolean; error?: string
  /** The files: moved, none to move, still moving, failed, or no longer listed by the arr. */
  files?: 'moved' | 'none' | 'pending' | 'failed' | 'unconfirmed'
  /** The arr's move command, while its files are pending. */
  commandId?: number
}

interface AppState {
  maxId: number; lastFullAt: number
  /** Items already looked at: id → when it was added (ms), forgotten once older than the look-back window. */
  seen: Record<string, number>
  /** Items a person moved by hand from the Recently sorted list: never sorted again. */
  leaveAlone: number[]
  tagId: number | null
  lastGraduateAt: number
  /** New items the arr was importing: looked at again next minute. */
  retry: number[]
  /** Shows graduated once: never graduated again (one back in the running folder was moved back by a person). */
  graduated: number[]
  /** Shows confirmed for graduating, still to move (20 a minute). */
  graduateQueue: { from: string; to: string; ids: number[] } | null
  lastTick?: { at: string; looked: number; moved: number; failed: number; waiting?: number; error?: string }
}
const freshState = (): AppState => ({ maxId: 0, lastFullAt: 0, seen: {}, leaveAlone: [], tagId: null, lastGraduateAt: 0, retry: [], graduated: [], graduateQueue: null })

/** Graduating's own record: on or off, and the two folders the confirmed preview showed. Never the rules. */
interface GraduateRecord { on: boolean; from: string; to: string }

export interface AppStatus {
  app: App; label: string; name: string; configured: boolean
  roots: string[]
  conditions: Array<{ id: Condition; label: string }>
  settings: AppSettings | null
  /** False when these are the suggested rules, not yet saved. */
  saved: boolean
  /** For suggested rules: whether the request folder came from Seerr's settings or from where most new items went. */
  suggestedFrom?: 'seerr' | 'guess'
  lastTick: AppState['lastTick'] | null
  /** The latest "Sort my library" run, if any. */
  library?: LibraryJobView | null
  error?: string
}
export interface RouterStatus {
  apps: AppStatus[]
  /** New requests, graduations and hand moves (the last 100). */
  recent: Move[]
  /** Library sorts and their undos (their own last 100, so they never push the others out). */
  recentLibrary: Move[]
  everySeconds: number; lookbackHours: number
}

/** One library sort: what was confirmed, how far it got, and what is still to move (kept in the database). */
export interface LibraryJob {
  id: string; app: App; by: string; startedAt: string; finishedAt?: string
  /** A sort, or the undo of one. */
  kind?: 'sort' | 'undo'
  state: 'running' | 'stopped' | 'done'
  total: number; moved: number; failed: number; skipped: number
  /** The groups confirmed, by name ("Horror in Movies → Frights (12)"). */
  groups: string[]
  /** `tries`: waits for an import; `errors`: moves that went wrong (three and it is marked failed). `undo`: a move back. */
  queue: Array<{ id: number; from: string; to: string; condition?: Condition; tries?: number; errors?: number; undo?: true }>
  /** Every item this job moved, so it can be undone. */
  movedItems?: Array<{ id: number; from: string; to: string }>
  stoppedBy?: string
  /** Waiting for the file moves to finish before Plex is asked to rescan. */
  rescanPending?: boolean
  /** What happened with the media server's rescan once it ended. */
  rescan?: string
}
export type LibraryJobView = Omit<LibraryJob, 'queue' | 'movedItems'> & { remaining: number; canUndo: number }
export interface LibraryPreview {
  previewId: string; app: App; total: number; groups: Array<PlanGroup & { word: string }>
  /** Folders no enabled rule fills: nothing is taken out of them. */
  leftAlone: Array<{ folder: string; count: number }>
}
/** Moves the arr is importing are tried again later, at most this many times. */
const MAX_LIBRARY_TRIES = 30
/** A library item whose move goes wrong this many times is marked failed. */
const MAX_LIBRARY_ERRORS = 3
/** Items looked at per minute by a library sort, skips and waits included. */
export const MAX_EXAMINED_PER_TICK = 60
/** How long Plex's rescan waits for the sort's file moves to finish. */
const RESCAN_WAIT_MS = 30 * 60_000
const jobView = (j: LibraryJob): LibraryJobView => {
  const { queue, movedItems, ...rest } = j
  return { ...rest, remaining: queue.length, canUndo: j.kind !== 'undo' && j.state !== 'running' ? (movedItems ?? []).length : 0 }
}
/** The audit row before a move could not be written: nothing was moved, and nothing more should be tried now. */
class AuditFailed extends Error {}
/** Viewers see "an admin" in place of a person's email. */
const maskBy = (v: string | undefined) => (v && v.includes('@') ? 'an admin' : v)
export interface TestAnswer extends LibraryTest { testId: string; at: string }
export interface GraduatePreview { previewId: string; from: string; to: string; shows: Array<{ id: number; title: string; year: number; files: number; aired: number }> }

export class RouterService {
  private tests = new Map<string, { app: App; fp: string; at: number }>()
  private previews = new Map<string, { ids: Set<number>; at: number; from: string; to: string }>()
  private libPreviews = new Map<string, { app: App; by: string; at: number; items: Map<number, { from: string; to: string; condition: Condition }>; groups: Array<{ word: string; ids: number[] }> }>()
  private suggested = new Map<App, { at: number; s: AppSettings; from: 'seerr' | 'guess' }>()
  private rootCache = new Map<App, { at: number; roots: string[] }>()
  private recentCache: Move[] = []
  private recentLibCache: Move[] = []
  private jobCache = new Map<App, LibraryJob | null>()
  /** Stop asked for: the running batch stops before its next move. Kept until a new sort starts. */
  private stopFlags = new Map<App, string>()
  /** Apps with a library batch running right now. */
  private active = new Set<App>()
  /** Moves made this minute, per app: the 20 a minute every kind of move shares. */
  private spent = new Map<App, { minute: number; n: number }>()
  private busy = false
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private d: RouterDeps) {}

  /** One writer at a time: the timer and a person's change never interleave their reads and writes of the store. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => {})
    return run
  }
  private iso() { return new Date(this.d.now()).toISOString() }
  private async client(app: App, need = true): Promise<CoreEndpointClient | null> {
    const c = await this.d.clients[app]().catch(() => null)
    if (!c && need) throw new RouterRefusal(409, 'not_set_up', `${APP_NAME[app]} is not set up in the Arr Stack plug-in.`)
    return c
  }

  // ── reading ────────────────────────────────────────────────────────────────

  async storedSettings(app: App): Promise<AppSettings | null> { return this.d.store.get<AppSettings>(`settings:${app}`) }
  private async state(app: App): Promise<AppState> { return { ...freshState(), ...((await this.d.store.get<AppState>(`state:${app}`)) ?? {}) } }
  private async gradRecord(): Promise<GraduateRecord | null> { return this.d.store.get<GraduateRecord>('graduate:sonarr') }
  private saveState(app: App, s: AppState) { return this.d.store.set(`state:${app}`, s, 'hyperprox') }
  async recent(): Promise<Move[]> {
    const list = (await this.d.store.get<Move[]>('recent')) ?? []
    this.recentCache = list
    return list
  }
  async recentLibrary(): Promise<Move[]> {
    const list = (await this.d.store.get<Move[]>('recent:library')) ?? []
    this.recentLibCache = list
    return list
  }

  /** For the confirmation's sentence (lib/confirm-text.ts): the title and folder name, only for a real entry and folder. */
  moveNames(app: unknown, id: unknown, folder: unknown): { title: string; folder: string } | null {
    if (app !== 'radarr' && app !== 'sonarr' || typeof folder !== 'string') return null
    const m = [...this.recentCache, ...this.recentLibCache].find(x => x.app === app && x.id === id)
    const roots = this.rootCache.get(app)?.roots ?? []
    const to = normRoot(folder)
    return m && roots.includes(to) ? { title: m.year ? `${m.title} (${m.year})` : m.title, folder: folderName(to) } : null
  }
  /** For the confirmation's sentence: how many shows a preview moves, and where. */
  graduateNames(previewId: unknown): { count: number; folder: string } | null {
    const p = typeof previewId === 'string' ? this.previews.get(previewId) : undefined
    return p ? { count: p.ids.size, folder: folderName(p.to) } : null
  }

  private async library(c: CoreEndpointClient, app: App): Promise<Item[]> {
    const raw = await c.get(API[app].list, 60_000)
    if (!Array.isArray(raw)) throw new Error(`${APP_NAME[app]} did not return its library.`)
    return raw.map(r => toItem(app, r)).filter(i => i.id > 0)
  }
  private async roots(c: CoreEndpointClient, app: App, fresh = false): Promise<string[]> {
    const hit = this.rootCache.get(app)
    if (!fresh && hit && this.d.now() - hit.at < ROOTS_TTL_MS) return hit.roots
    const raw = await c.get('/api/v3/rootfolder')
    const roots = (Array.isArray(raw) ? raw : []).map((r: any) => (typeof r?.path === 'string' ? normRoot(r.path) : '')).filter(Boolean)
    this.rootCache.set(app, { at: this.d.now(), roots })
    return roots
  }
  /** The folder Seerr sends this app's requests to (its default, non-4K server), or null when it cannot say. */
  private async seerrFolder(app: App): Promise<string | null> {
    const c = this.d.seerr ? await this.d.seerr().catch(() => null) : null
    if (!c) return null
    try {
      const servers = await c.get(`/api/v1/settings/${app}`)
      const list = Array.isArray(servers) ? servers.filter((x: any) => !x?.is4k) : []
      const main = list.find((x: any) => x?.isDefault) ?? (list.length === 1 ? list[0] : null)
      return typeof main?.activeDirectory === 'string' && main.activeDirectory ? normRoot(main.activeDirectory) : null
    } catch (e) {
      this.d.log?.(`[arr-router] Seerr's ${app} settings could not be read: ${msg(e)}`)
      return null
    }
  }

  /** The suggested rules: the default ones matched to this library's folders by name; requests arrive in Seerr's folder. */
  private async suggest(c: CoreEndpointClient, app: App): Promise<{ s: AppSettings; from: 'seerr' | 'guess' }> {
    const hit = this.suggested.get(app)
    if (hit && this.d.now() - hit.at < SUGGEST_TTL_MS) return { s: hit.s, from: hit.from }
    const [roots, items, seerr] = await Promise.all([this.roots(c, app), this.library(c, app), this.seerrFolder(app)])
    const from = seerr && roots.includes(seerr) ? 'seerr' as const : 'guess' as const
    const s = defaultSettings(app, roots, from === 'seerr' ? seerr : guessDefaultRoot(items))
    this.suggested.set(app, { at: this.d.now(), s, from })
    return { s, from }
  }

  /** `admin`: false for a viewer, who sees "an admin" in place of people's emails. */
  async status(admin = true): Promise<RouterStatus> {
    const apps: AppStatus[] = []
    for (const app of APPS) {
      const base: AppStatus = {
        app, label: APP_LABEL[app], name: APP_NAME[app], configured: false, roots: [],
        conditions: conditionsFor(app).map(id => ({ id, label: CONDITION_LABEL[id] })), settings: null, saved: false, lastTick: null,
      }
      const c = await this.client(app, false)
      if (!c) { apps.push(base); continue }
      base.configured = true
      try {
        const [stored, st] = await Promise.all([this.storedSettings(app), this.state(app)])
        base.roots = await this.roots(c, app)
        if (stored) base.settings = { ...stored }
        else { const sg = await this.suggest(c, app); base.settings = { ...sg.s }; base.suggestedFrom = sg.from }
        if (app === 'sonarr') base.settings.graduate = (await this.gradRecord())?.on === true
        base.saved = !!stored
        base.lastTick = st.lastTick ?? null
        const job = await this.libraryJob(app)
        base.library = job ? jobView(job) : null
      } catch (e) {
        this.d.log?.(`[arr-router] ${app} could not be read: ${msg(e)}`)
        base.error = `${APP_NAME[app]} could not be read just now.`
      }
      apps.push(base)
    }
    const mask = (l: Move[]) => (admin ? l : l.map(m => ({ ...m, by: maskBy(m.by)! })))
    if (!admin) for (const a of apps) if (a.library) a.library = { ...a.library, by: maskBy(a.library.by)!, stoppedBy: maskBy(a.library.stoppedBy) }
    return { apps, recent: mask(await this.recent()), recentLibrary: mask(await this.recentLibrary()), everySeconds: 60, lookbackHours: LOOKBACK_MS / 3600_000 }
  }

  // ── "Test on my library" ───────────────────────────────────────────────────

  /** The rules over the whole library, read-only. Its id is what switching sorting on needs. */
  async test(app: App, raw: unknown): Promise<TestAnswer> {
    const c = (await this.client(app))!
    const roots = await this.roots(c, app, true)
    const s = parseSettings(app, { ...(raw as object ?? {}), enabled: false }, roots)
    if (typeof s === 'string') throw new RouterRefusal(400, 'bad_request', s)
    const items = await this.library(c, app)
    const t = testLibrary(app, s, items)
    const testId = crypto.randomBytes(12).toString('hex')
    const now = this.d.now()
    for (const [k, v] of this.tests) if (now - v.at > TEST_TTL_MS) this.tests.delete(k)
    this.tests.set(testId, { app, fp: ruleFingerprint(app, s), at: now })
    return { ...t, testId, at: new Date(now).toISOString() }
  }

  // ── saving the rules ───────────────────────────────────────────────────────

  async saveSettings(app: App, raw: unknown, testId: unknown, by: string): Promise<AppSettings> {
    const c = (await this.client(app))!
    const roots = await this.roots(c, app, true)
    const s = parseSettings(app, raw, roots)
    if (typeof s === 'string') throw new RouterRefusal(400, 'bad_request', s)
    return this.locked(async () => {
      const cur = await this.storedSettings(app)
      const fp = ruleFingerprint(app, s)
      const turningOn = s.enabled && (!cur?.enabled || ruleFingerprint(app, cur) !== fp)
      if (turningOn) {
        const t = typeof testId === 'string' ? this.tests.get(testId) : undefined
        if (!t || t.app !== app || t.fp !== fp || this.d.now() - t.at > TEST_TTL_MS) {
          throw new RouterRefusal(409, 'test_required', 'Run "Test on my library" with these rules first, then switch sorting on from its result.')
        }
      }
      s.enabledAt = s.enabled ? (cur?.enabled && cur.enabledAt ? cur.enabledAt : this.iso()) : null
      // Graduating is switched on only by confirming its preview (graduateApply) and lives in its own record; here it
      // can only be switched off.
      const grad = app === 'sonarr' ? await this.gradRecord() : null
      const gradOff = !!grad?.on && !s.graduate
      s.graduate = false
      await this.d.audit('arrstack.router.settings', {
        app, by, enabled: s.enabled, graduateOff: gradOff, defaultRoot: s.defaultRoot,
        rules: s.rules.filter(r => r.enabled).map(r => `${r.condition}:${r.folder ? folderName(r.folder) : '-'}`).join(', '),
      })
      await this.d.store.set(`settings:${app}`, s, by)
      if (gradOff) await this.d.store.set('graduate:sonarr', { ...grad!, on: false }, by)
      if (turningOn && !cur?.enabled) {
        // Start counting from now: everything already in the library is the owner's, not the router's.
        const st = await this.state(app)
        st.maxId = 0; st.lastFullAt = 0; st.seen = {}; st.retry = []
        await this.saveState(app, st)
      }
      return { ...s, graduate: !!grad?.on && !gradOff }
    })
  }

  // ── the timer ──────────────────────────────────────────────────────────────

  async tick(): Promise<void> {
    if (!this.d.unlocked() || this.busy) return
    this.busy = true
    try {
      for (const app of APPS) {
        await this.locked(() => this.tickApp(app)).catch(e => this.d.log?.(`[arr-router] ${app} tick failed: ${msg(e)}`))
      }
    } finally { this.busy = false }
  }

  /** The ids after the highest seen, until a few in a row are missing. */
  private async probe(c: CoreEndpointClient, app: App, st: AppState): Promise<Item[]> {
    const out: Item[] = []
    let id = st.maxId + 1, misses = 0
    while (misses < PROBE_MISSES && out.length < 50) {
      const it = await this.one(c, app, id)
      if (it) { out.push(it); st.maxId = id; misses = 0 } else misses++
      id++
    }
    return out
  }

  /** One item, or null when the arr says it does not exist. */
  private async one(c: CoreEndpointClient, app: App, id: number): Promise<Item | null> {
    try {
      const it = toItem(app, await c.get(API[app].one(id)))
      return it.id === id ? it : null
    } catch (e) {
      if (/HTTP 404\b/.test(msg(e))) return null
      throw e
    }
  }

  /** Is the arr importing this item right now? Then it waits a minute. The queue is filtered here, never by the query. */
  private async importing(c: CoreEndpointClient, app: App, id: number): Promise<boolean> {
    const field = app === 'radarr' ? 'movieId' : 'seriesId'
    try {
      const rows = await c.get(`/api/v3/queue/details?${field}=${id}`)
      return (Array.isArray(rows) ? rows : []).some((r: any) => r?.[field] === id && IMPORTING.has(String(r?.trackedDownloadState ?? '').toLowerCase()))
    } catch (e) {
      // Cannot tell: wait rather than move something mid-import.
      this.d.log?.(`[arr-router] ${app} ${id}: the queue could not be read (${msg(e)}); trying again next minute`)
      return true
    }
  }

  private async tickApp(app: App): Promise<void> {
    const s = await this.storedSettings(app)
    const grad = app === 'sonarr' ? await this.gradRecord() : null
    const pendingFiles = [...await this.recent(), ...await this.recentLibrary()].some(m => m.app === app && m.files === 'pending')
    const job = await this.libraryJob(app)
    const sorting = job?.state === 'running'
    const rescanDue = !!job?.rescanPending
    if (!s?.enabled && !grad?.on && !pendingFiles && !sorting && !rescanDue) return
    const c = await this.client(app, false)
    if (!c) return
    const st = await this.state(app)
    const now = this.d.now()
    const gradDue = !!grad?.on && (!!st.graduateQueue?.ids.length || now - st.lastGraduateAt >= GRADUATE_EVERY_MS)
    if (!s?.enabled && !gradDue && !pendingFiles && !sorting && !rescanDue) return
    const tick = { at: new Date(now).toISOString(), looked: 0, moved: 0, failed: 0, waiting: 0 } as NonNullable<AppState['lastTick']>
    try {
      if (pendingFiles) await this.checkFiles(c, app)
      if (s?.enabled) await this.sortNew(c, app, s, st, now, tick)
      if (gradDue && grad) await this.graduateTick(c, st, grad, now, tick)
      // A library sort shares the minute's 20 with everything above (this.budget).
      if (sorting && job) await this.libraryBatch(c, app, st, job, tick)
      const after = await this.libraryJob(app)
      if (after?.rescanPending) await this.maybeRescan(after)
    } catch (e) {
      tick.error = msg(e)
      this.d.log?.(`[arr-router] ${app}: ${tick.error}`)
    }
    st.lastTick = tick
    await this.saveState(app, st)
  }

  private async sortNew(c: CoreEndpointClient, app: App, s: AppSettings, st: AppState, now: number, tick: NonNullable<AppState['lastTick']>): Promise<void> {
    let found: Item[]
    if (!st.maxId || now - st.lastFullAt >= FULL_READ_MS) {
      found = await this.library(c, app)
      for (const i of found) if (i.id > st.maxId) st.maxId = i.id
      st.lastFullAt = now
    } else {
      found = await this.probe(c, app, st)
    }
    // The ones the arr was importing last minute, looked at again.
    const have = new Set(found.map(i => i.id))
    for (const id of st.retry) {
      if (have.has(id)) continue
      const it = await this.one(c, app, id)
      if (it) found.push(it)
    }
    const leave = new Set(st.leaveAlone)
    const pending = found.filter(i => st.seen[String(i.id)] === undefined && routable(i, s, { routedTag: st.tagId, now, lookbackMs: LOOKBACK_MS, leaveAlone: leave }))
      .sort((a, b) => a.id - b.id)
    const cands = pending.slice(0, MAX_MOVES_PER_TICK)
    // More than one minute's share: the next minute reads the whole library again to pick up the rest.
    if (pending.length > cands.length) st.lastFullAt = 0
    const retry: number[] = []
    for (const it of cands) {
      // The minute's moves are used up (a library sort may share them): the rest wait for the next full read.
      if (this.budget(app) <= 0) { st.lastFullAt = 0; break }
      tick.looked++
      const p = pickFolder(app, s, it)
      if (!p || p.folder === it.root) { st.seen[String(it.id)] = Date.parse(it.added); continue }
      const roots = await this.roots(c, app)
      if (!roots.includes(p.folder)) {
        st.seen[String(it.id)] = Date.parse(it.added); tick.failed++
        this.d.log?.(`[arr-router] ${app}: the folder for ${p.condition} is no longer a root folder`)
        continue
      }
      // Read it again: a person (or another tool) may have moved or tagged it since the list was read.
      const live = await this.one(c, app, it.id)
      if (!live || live.root !== it.root || (st.tagId !== null && live.tags.includes(st.tagId))) { st.seen[String(it.id)] = Date.parse(it.added); continue }
      if (await this.importing(c, app, it.id)) { retry.push(it.id); tick.waiting = (tick.waiting ?? 0) + 1; continue }
      st.seen[String(it.id)] = Date.parse(it.added)
      const m = await this.moveOne(c, app, st, live, p.folder, { kind: 'sorted', condition: p.condition, why: whyWord(p.condition, p.folder), detail: p.why, by: 'hyperprox' })
      if (m.ok || m.files === 'pending') tick.moved++; else tick.failed++
    }
    st.retry = retry
    const forget = now - LOOKBACK_MS - 3600_000
    for (const [k, added] of Object.entries(st.seen)) if (!(added >= forget)) delete st.seen[k]
  }

  // ── moving one item ────────────────────────────────────────────────────────

  private async tag(c: CoreEndpointClient, app: App, st: AppState): Promise<number | null> {
    if (st.tagId !== null) return st.tagId
    const tags = await c.get('/api/v3/tag')
    const hit = (Array.isArray(tags) ? tags : []).find((t: any) => String(t?.label).toLowerCase() === ROUTED_TAG)
    if (hit && Number.isInteger(hit.id)) { st.tagId = hit.id; return hit.id }
    if (!c.post) return null
    const made = await c.post('/api/v3/tag', { label: ROUTED_TAG })
    if (made && Number.isInteger(made.id)) { st.tagId = made.id; return made.id }
    this.d.log?.(`[arr-router] ${APP_NAME[app]} did not create the ${ROUTED_TAG} tag`)
    return null
  }

  /** The editor call, with the tag. When it fails with a tag that may be stale (deleted in the arr), the tag is looked up again and the call made once more. */
  private async editorPut(c: CoreEndpointClient, app: App, st: AppState, id: number, to: string): Promise<void> {
    const send = (tagId: number | null) => {
      const body: Record<string, unknown> = { [API[app].ids]: [id], rootFolderPath: to, moveFiles: true }
      if (tagId !== null) { body.tags = [tagId]; body.applyTags = 'add' }
      return c.put(API[app].editor, body, 60_000)
    }
    const tagId = await this.tag(c, app, st)
    try { await send(tagId) } catch (e) {
      if (tagId === null) throw e
      st.tagId = null
      const again = await this.tag(c, app, st)
      this.d.log?.(`[arr-router] ${app} ${id}: the move failed with tag ${tagId} (${msg(e)}); trying once more with tag ${again ?? 'none'}`)
      await send(again)
    }
  }

  /** The arr's move command for this item: its id and status, or null when it lists none. */
  private async moveCommand(c: CoreEndpointClient, app: App, id: number, commandId?: number): Promise<{ id: number; status: string; message: string } | null> {
    const pick = (x: any) => ({ id: Number(x?.id), status: String(x?.status ?? '').toLowerCase(), message: String(x?.message ?? x?.exception ?? '').slice(0, 160) })
    if (commandId) {
      try { return pick(await c.get(`/api/v3/command/${commandId}`)) } catch (e) { if (/HTTP 404\b/.test(msg(e))) return null; throw e }
    }
    const list = await c.get('/api/v3/command')
    const mine = (Array.isArray(list) ? list : []).filter((x: any) => {
      if (!MOVE_COMMAND.test(String(x?.name ?? x?.commandName ?? ''))) return false
      const b = x?.body ?? {}
      const ids: unknown[] = app === 'radarr'
        ? [b.movieId, ...(Array.isArray(b.movieIds) ? b.movieIds : []), ...(Array.isArray(b.movies) ? b.movies.map((m: any) => m?.movieId) : [])]
        : [b.seriesId, ...(Array.isArray(b.seriesIds) ? b.seriesIds : []), ...(Array.isArray(b.series) ? b.series.map((m: any) => m?.seriesId) : [])]
      return ids.includes(id)
    }).sort((a: any, b: any) => Number(b?.id) - Number(a?.id))
    return mine.length ? pick(mine[0]) : null
  }

  /** What the files' move says: done, broken, still running (or not listed yet). */
  private filesFrom(m: Move, cmd: { id: number; status: string; message: string } | null): void {
    if (cmd && DONE.has(cmd.status)) { m.files = 'moved'; m.ok = true; delete m.error; delete m.commandId; return }
    if (cmd && BROKEN.has(cmd.status)) {
      m.files = 'failed'; m.ok = false; delete m.commandId
      m.error = `${APP_NAME[m.app]} could not move the files (${cmd.status}${cmd.message ? `: ${cmd.message}` : ''}). The item points at ${folderName(m.to)}; check both folders.`
      return
    }
    m.files = 'pending'; m.ok = false
    if (cmd && Number.isInteger(cmd.id) && cmd.id > 0) m.commandId = cmd.id
    m.error = `${APP_NAME[m.app]} is still moving the files.`
  }

  /** Audit, move through the arr's editor (files too), read back, and remember it in Recently sorted. */
  private async moveOne(c: CoreEndpointClient, app: App, st: AppState, item: Item, to: string,
    meta: { kind: MoveKind; condition: Condition | null; why: string; detail: string; by: string }): Promise<Move> {
    const m: Move = {
      key: crypto.randomBytes(8).toString('hex'), at: this.iso(), app, id: item.id, title: item.title, year: item.year,
      from: item.root, to, kind: meta.kind, condition: meta.condition, why: meta.why, detail: meta.detail, by: meta.by, ok: false,
    }
    // No audit row, no move: this throws and nothing below runs.
    try {
      await this.d.audit('arrstack.router.move', { app, id: item.id, title: item.title, from: item.root, to, kind: meta.kind, why: meta.why, by: meta.by })
    } catch (e) { throw new AuditFailed(msg(e)) }
    this.spend(app)
    const hadFiles = app === 'radarr' ? (item as { hasFile: boolean }).hasFile : (item as Show).files > 0
    try {
      await this.editorPut(c, app, st, item.id, to)
      const back = toItem(app, await c.get(API[app].one(item.id)))
      if (!(back.root === to || back.path.startsWith(`${to}/`))) {
        m.error = `${APP_NAME[app]} still shows it in ${folderName(back.root || item.root)}.`
      } else if (!hadFiles) {
        m.ok = true; m.files = 'none'
      } else {
        await (this.d.sleep ? this.d.sleep(1000) : new Promise<void>(r => setTimeout(r, 1000)))
        this.filesFrom(m, await this.moveCommand(c, app, item.id).catch(() => null))
      }
    } catch (e) {
      m.error = `${APP_NAME[app]} did not move it: ${msg(e)}`
    }
    if (!m.ok && m.files !== 'pending') this.d.log?.(`[arr-router] ${app} ${item.id}: ${m.error}`)
    await this.d.audit('arrstack.router.moved', { app, id: item.id, to, ok: m.ok, files: m.files ?? null, error: m.error ?? null }).catch(() => {})
    if (meta.kind === 'library') {
      const list = [m, ...await this.recentLibrary()].slice(0, RECENT_MAX)
      await this.d.store.set('recent:library', list, meta.by)
      this.recentLibCache = list
    } else {
      const list = [m, ...await this.recent()].slice(0, RECENT_MAX)
      await this.d.store.set('recent', list, meta.by)
      this.recentCache = list
    }
    return m
  }

  /** Moves whose files were still on their way: ask the arr how its move command ended. */
  private async checkFiles(c: CoreEndpointClient, app: App): Promise<void> {
    await this.checkFilesIn(c, app, 'recent', await this.recent())
    await this.checkFilesIn(c, app, 'recent:library', await this.recentLibrary())
  }
  private async checkFilesIn(c: CoreEndpointClient, app: App, key: 'recent' | 'recent:library', list: Move[]): Promise<void> {
    let changed = false
    for (const m of list) {
      if (m.app !== app || m.files !== 'pending') continue
      const cmd = await this.moveCommand(c, app, m.id, m.commandId).catch(() => undefined)
      if (cmd === undefined) continue
      if (!cmd && this.d.now() - Date.parse(m.at) > FILES_CONFIRM_MS) {
        m.files = 'unconfirmed'; m.ok = false; delete m.commandId
        m.error = `${APP_NAME[app]} no longer lists the file move, so it could not be confirmed. Check ${folderName(m.to)}.`
      } else if (cmd) this.filesFrom(m, cmd)
      if (m.files === 'pending') continue
      changed = true
      await this.d.audit('arrstack.router.files', { app, id: m.id, to: m.to, files: m.files, ok: m.ok }).catch(() => {})
    }
    if (!changed) return
    await this.d.store.set(key, list, 'hyperprox')
    if (key === 'recent') this.recentCache = list; else this.recentLibCache = list
  }

  /** "Undo / move to…": one item from the Recently sorted list to a folder a person picked. */
  async move(app: App, id: number, folder: string, by: string): Promise<Move> {
    const c = (await this.client(app))!
    return this.locked(async () => {
      if (![...await this.recent(), ...await this.recentLibrary()].some(m => m.app === app && m.id === id)) {
        throw new RouterRefusal(404, 'not_found', 'Only something in the Recently sorted list can be moved from here.')
      }
      const to = normRoot(folder)
      if (!(await this.roots(c, app, true)).includes(to)) throw new RouterRefusal(400, 'bad_request', `That is not one of ${APP_NAME[app]}'s root folders.`)
      const s = (await this.storedSettings(app)) ?? (await this.suggest(c, app)).s
      if (curatedFolders(s.rules).has(to)) throw new RouterRefusal(400, 'hand_picked', `${folderName(to)} is hand-picked: HyperProx never moves anything into it. Do that in ${APP_NAME[app]} if you mean to.`)
      const live = await this.one(c, app, id)
      if (!live) throw new RouterRefusal(404, 'not_found', `${APP_NAME[app]} no longer has it.`)
      if (live.root === to) throw new RouterRefusal(409, 'already_there', `${live.title} is already in ${folderName(to)}.`)
      const st = await this.state(app)
      if (!st.leaveAlone.includes(id)) st.leaveAlone = [...st.leaveAlone, id].slice(-MAX_LEAVE_ALONE)
      const m = await this.moveOne(c, app, st, live, to, { kind: 'moved', condition: null, why: `Moved by hand → ${folderName(to)}`, detail: 'moved from the Recently sorted list', by })
      await this.saveState(app, st)
      if (!m.ok && m.files !== 'pending') throw new RouterRefusal(502, 'not_moved', m.error ?? 'It was not moved.')
      return m
    })
  }

  // ── "Sort my library" ──────────────────────────────────────────────────────

  async libraryJob(app: App): Promise<LibraryJob | null> {
    const j = await this.d.store.get<LibraryJob>(`library:${app}`)
    this.jobCache.set(app, j)
    return j
  }
  private async saveJob(j: LibraryJob) { await this.d.store.set(`library:${j.app}`, j, j.by); this.jobCache.set(j.app, j) }

  /** What is left of this minute's 20 moves for this app (new requests, graduations and library sorts share them). */
  private budget(app: App): number {
    const m = Math.floor(this.d.now() / 60_000), x = this.spent.get(app)
    return MAX_MOVES_PER_TICK - (x && x.minute === m ? x.n : 0)
  }
  private spend(app: App): void {
    const m = Math.floor(this.d.now() / 60_000), x = this.spent.get(app)
    this.spent.set(app, { minute: m, n: x && x.minute === m ? x.n + 1 : 1 })
  }

  /** The saved rules over the whole library, read-only: what would move, grouped. Single-use, 15 minutes, this person only. */
  async libraryPreview(app: App, by: string): Promise<LibraryPreview> {
    const c = (await this.client(app))!
    const s = await this.storedSettings(app)
    if (!s) throw new RouterRefusal(409, 'no_rules', 'Save your rules first: sorting the library uses the rules you saved.')
    const st = await this.state(app)
    const lib = await this.library(c, app)
    const groups = libraryPlan(app, s, lib, this.never(st)).map(g => ({ ...g, word: groupWord(g) }))
    const leftAlone = leftAloneFolders(s, lib)
    const previewId = crypto.randomBytes(12).toString('hex')
    const now = this.d.now()
    for (const [k, v] of this.libPreviews) if (now - v.at > TEST_TTL_MS) this.libPreviews.delete(k)
    const items = new Map<number, { from: string; to: string; condition: Condition }>()
    for (const g of groups) for (const it of g.items) items.set(it.id, { from: g.from, to: g.to, condition: g.condition })
    this.libPreviews.set(previewId, { app, by, at: now, items, groups: groups.map(g => ({ word: g.word, ids: g.items.map(i => i.id) })) })
    return { previewId, app, total: items.size, groups, leftAlone }
  }

  /** For the confirmation's sentence: how many ticked items, in which groups. Only a live preview of this person's. */
  libraryNames(previewId: unknown, ids: unknown, by?: string): { count: number; groups: string[] } | null {
    const p = typeof previewId === 'string' ? this.libPreviews.get(previewId) : undefined
    if (!p || this.d.now() - p.at > TEST_TTL_MS || (by !== undefined && p.by !== by) || !Array.isArray(ids)) return null
    const ticked = new Set(ids.filter(x => typeof x === 'number' && p.items.has(x)) as number[])
    const groups = p.groups.map(g => ({ word: g.word, n: g.ids.filter(x => ticked.has(x)).length })).filter(g => g.n > 0).map(g => `${g.word} (${g.n})`)
    return { count: ticked.size, groups }
  }
  /** For the undo's confirmation: how many items the last sort moved. */
  libraryUndoNames(app: unknown): { count: number } | null {
    const j = app === 'radarr' || app === 'sonarr' ? this.jobCache.get(app) : null
    return j ? { count: jobView(j).canUndo } : null
  }

  /** Move exactly the ticked items of a preview, sharing the minute's moves; the rest follow each minute. Audited first. */
  async libraryApply(previewId: unknown, ids: unknown, by: string): Promise<LibraryJobView> {
    const p = typeof previewId === 'string' ? this.libPreviews.get(previewId) : undefined
    if (!p || this.d.now() - p.at > TEST_TTL_MS || p.by !== by) throw new RouterRefusal(409, 'preview_required', 'Look at the preview first (it lasts 15 minutes and is yours only).')
    if (!Array.isArray(ids) || !ids.length || ids.length > 20_000 || !ids.every(x => Number.isInteger(x) && p.items.has(x as number))) {
      throw new RouterRefusal(400, 'bad_request', 'Tick the items to move, from this preview only.')
    }
    const names = this.libraryNames(previewId, ids, by)!
    const c = (await this.client(p.app))!
    return this.locked(async () => {
      const cur = await this.libraryJob(p.app)
      if (cur?.state === 'running') throw new RouterRefusal(409, 'busy', 'A library sort is already running for this app. Stop it first, or let it finish.')
      this.libPreviews.delete(previewId as string)
      const ticked = [...new Set(ids as number[])]
      // No audit row, nothing queued and nothing moved.
      await this.d.audit('arrstack.router.library', { app: p.app, by, count: ticked.length, groups: names.groups.join('; ').slice(0, 500) })
      this.stopFlags.delete(p.app)
      const job: LibraryJob = {
        id: crypto.randomBytes(8).toString('hex'), app: p.app, by, startedAt: this.iso(), kind: 'sort', state: 'running',
        total: ticked.length, moved: 0, failed: 0, skipped: 0, groups: names.groups, movedItems: [],
        queue: ticked.map(id => ({ id, ...p.items.get(id)! })),
      }
      await this.saveJob(job)
      return this.startNow(c, job)
    })
  }

  /** "Undo this sort": every item the last sort moved goes back, if it is still where the sort put it. Audited first. */
  async libraryUndo(app: App, by: string): Promise<LibraryJobView> {
    const c = (await this.client(app))!
    return this.locked(async () => {
      const last = await this.libraryJob(app)
      if (!last) throw new RouterRefusal(404, 'not_found', 'There is no library sort to undo.')
      if (last.state === 'running') throw new RouterRefusal(409, 'busy', 'Stop the library sort first, or let it finish.')
      const items = last.kind === 'undo' ? [] : last.movedItems ?? []
      if (!items.length) throw new RouterRefusal(409, 'nothing_to_undo', last.kind === 'undo' ? 'This was already undone.' : 'That sort moved nothing.')
      await this.d.audit('arrstack.router.library.undo', { app, by, count: items.length, of: last.id })
      this.stopFlags.delete(app)
      const job: LibraryJob = {
        id: crypto.randomBytes(8).toString('hex'), app, by, startedAt: this.iso(), kind: 'undo', state: 'running',
        total: items.length, moved: 0, failed: 0, skipped: 0, groups: [`Undo of the sort started ${last.startedAt.slice(0, 16).replace('T', ' ')}`],
        movedItems: [], queue: items.map(x => ({ id: x.id, from: x.to, to: x.from, undo: true as const })),
      }
      await this.saveJob(job)
      return this.startNow(c, job)
    })
  }

  /** The first batch, right away, with whatever is left of this minute's moves. */
  private async startNow(c: CoreEndpointClient, job: LibraryJob): Promise<LibraryJobView> {
    const st = await this.state(job.app)
    await this.libraryBatch(c, job.app, st, job)
    await this.saveState(job.app, st)
    const now = await this.libraryJob(job.app)
    if (now?.rescanPending) await this.maybeRescan(now)
    return jobView((await this.libraryJob(job.app)) ?? job)
  }

  /**
   * Stop a running library sort. It does not wait for the batch: the batch looks at this before each move and stops
   * there. What has moved stays moved; the rest stays where it is.
   */
  async libraryStop(app: App, by: string): Promise<LibraryJobView> {
    const job = await this.libraryJob(app)
    if (!job || job.state !== 'running') throw new RouterRefusal(409, 'not_running', 'No library sort is running.')
    await this.d.audit('arrstack.router.library.stop', { app, by, moved: job.moved, remaining: job.queue.length })
    this.stopFlags.set(app, by)
    const stopped = { ...job, state: 'stopped' as const, stoppedBy: by, finishedAt: this.iso() }
    // No batch running: nobody else will write the job, so stop it here. Otherwise the batch does, before its next move.
    if (!this.active.has(app)) await this.saveJob(stopped)
    return jobView(stopped)
  }

  /** Items from the queue, each checked again, then moved through the usual move, within this minute's budget. */
  private async libraryBatch(c: CoreEndpointClient, app: App, st: AppState, job: LibraryJob, tick?: NonNullable<AppState['lastTick']>): Promise<void> {
    this.active.add(app)
    try {
      const s = await this.storedSettings(app)
      if (!s) { job.state = 'stopped'; job.stoppedBy = 'hyperprox'; job.finishedAt = this.iso(); await this.saveJob(job); return }
      const hand = curatedFolders(s.rules)
      const filled = filledFolders(s.rules)
      const never = this.never(st)
      const later: LibraryJob['queue'] = []
      let examined = 0
      job.movedItems ??= []
      while (job.queue.length && examined < MAX_EXAMINED_PER_TICK && this.budget(app) > 0) {
        const by = this.stopFlags.get(app)
        if (by) { job.state = 'stopped'; job.stoppedBy = by; job.finishedAt = this.iso(); break }
        const q = job.queue.shift()!
        examined++
        try {
          const live = await this.one(c, app, q.id)
          let pick: { condition: Condition | null; why: string; detail: string } | null = null
          if (q.undo) {
            // Undo: only while it is still where the sort put it, and back to where it was.
            if (live && live.root === q.from && !hand.has(q.to)) pick = { condition: null, why: `Undo → ${folderName(q.to)}`, detail: 'undoing the library sort' }
          } else {
            // Checked again now: still where it was, nobody moved it back, the rules still pick the same folder, never hand-picked.
            const p = live ? pickFolder(app, s, live) : null
            if (live && live.root === q.from && !never.has(q.id) && !hand.has(q.from) && !hand.has(q.to) && filled.has(q.from) && p && p.folder === q.to) {
              pick = { condition: p.condition, why: whyWord(p.condition, q.to), detail: p.why }
            }
          }
          if (!live || !pick || !(await this.roots(c, app)).includes(q.to)) { job.skipped++; continue }
          if (await this.importing(c, app, q.id)) {
            if ((q.tries ?? 0) + 1 >= MAX_LIBRARY_TRIES) job.skipped++
            else later.push({ ...q, tries: (q.tries ?? 0) + 1 })
            continue
          }
          const m = await this.moveOne(c, app, st, live, q.to, { kind: 'library', condition: pick.condition, why: pick.why, detail: pick.detail, by: job.by })
          if (m.ok || m.files === 'pending') {
            job.moved++; if (tick) tick.moved++
            job.movedItems.push({ id: q.id, from: q.from, to: q.to })
            if (q.undo && !st.leaveAlone.includes(q.id)) st.leaveAlone = [...st.leaveAlone, q.id].slice(-MAX_LEAVE_ALONE)
          } else this.itemError(job, q, later, tick)
        } catch (e) {
          if (e instanceof AuditFailed) { job.queue.unshift(q); this.d.log?.(`[arr-router] ${app}: the audit log could not be written; the library sort waits`); break }
          this.d.log?.(`[arr-router] ${app} ${q.id}: ${msg(e)}`)
          this.itemError(job, q, later, tick)
        }
      }
      job.queue.push(...later)
      if (job.state === 'running' && !job.queue.length) {
        job.state = 'done'; job.finishedAt = this.iso()
        if (job.moved > 0) job.rescanPending = true
      }
      await this.saveJob(job)
    } finally { this.active.delete(app) }
  }

  /** A move that went wrong: tried again later, and marked failed the third time. */
  private itemError(job: LibraryJob, q: LibraryJob['queue'][number], later: LibraryJob['queue'], tick?: NonNullable<AppState['lastTick']>): void {
    const errors = (q.errors ?? 0) + 1
    if (errors >= MAX_LIBRARY_ERRORS) { job.failed++; if (tick) tick.failed++ }
    else later.push({ ...q, errors })
  }

  /** Once no file move of the sort is still running (or after 30 minutes), ask Plex to rescan once. */
  private async maybeRescan(job: LibraryJob): Promise<void> {
    const since = Date.parse(job.startedAt)
    const moving = (await this.recentLibrary()).filter(m => m.app === job.app && m.files === 'pending' && Date.parse(m.at) >= since).length
    const waited = this.d.now() - Date.parse(job.finishedAt ?? job.startedAt)
    if (moving && waited < RESCAN_WAIT_MS) return
    const r = await this.rescan(job.app)
    job.rescan = moving ? `${r} (${moving} file ${moving === 1 ? 'move was' : 'moves were'} still running after 30 minutes.)` : r
    job.rescanPending = false
    await this.saveJob(job)
  }

  /** Ask the connected media server (Plex) to rescan its film or TV libraries once. Never required. */
  private async rescan(app: App): Promise<string> {
    const plex = this.d.mediaServer ? await this.d.mediaServer().catch(() => null) : null
    if (!plex) return 'No Plex server is connected, so no rescan was asked for.'
    try {
      const body = await plex.get('/library/sections', 15_000)
      const dirs = Array.isArray(body?.MediaContainer?.Directory) ? body.MediaContainer.Directory : []
      const want = app === 'radarr' ? 'movie' : 'show'
      const keys = dirs.filter((d: any) => d?.type === want && /^\d+$/.test(String(d?.key))).map((d: any) => String(d.key))
      let n = 0
      for (const k of keys) await plex.trigger(`/library/sections/${k}/refresh`, 15_000).then(() => { n++ }).catch(() => {})
      await this.d.audit('arrstack.router.library.rescan', { app, sections: n }).catch(() => {})
      return n ? `Plex was asked to rescan ${n} ${n === 1 ? 'library' : 'libraries'}.` : 'Plex has no matching library to rescan.'
    } catch (e) {
      this.d.log?.(`[arr-router] the Plex rescan did not work: ${msg(e)}`)
      return 'Plex did not answer, so it was not asked to rescan.'
    }
  }

  // ── "Graduate finished shows" ──────────────────────────────────────────────

  private async showSettings(c: CoreEndpointClient): Promise<AppSettings> {
    return (await this.storedSettings('sonarr')) ?? (await this.suggest(c, 'sonarr')).s
  }
  private never(st: AppState): Set<number> { return new Set([...st.leaveAlone, ...st.graduated]) }

  async graduatePreview(): Promise<GraduatePreview> {
    const c = (await this.client('sonarr'))!
    const s = await this.showSettings(c)
    const st = await this.state('sonarr')
    if (!graduateFolders(s)) throw new RouterRefusal(409, 'no_folders', 'Switch on the "Ended" and "Still running" rules, each with its own folder, first.')
    const g = graduates(s, await this.library(c, 'sonarr') as Show[], this.never(st))!
    const previewId = crypto.randomBytes(12).toString('hex')
    const now = this.d.now()
    for (const [k, v] of this.previews) if (now - v.at > TEST_TTL_MS) this.previews.delete(k)
    this.previews.set(previewId, { ids: new Set(g.shows.map(x => x.id)), at: now, from: g.from, to: g.to })
    return { previewId, from: g.from, to: g.to, shows: g.shows.map(x => ({ id: x.id, title: x.title, year: x.year, files: x.files, aired: x.aired })) }
  }

  /** Does this show (read live) still qualify to graduate from `from`? */
  private stillGraduates(x: Item | null, from: string, never: Set<number>): x is Show {
    const sh = x as Show | null
    return !!sh && sh.root === from && sh.status === 'ended' && sh.aired > 0 && sh.files >= sh.aired && !never.has(sh.id)
  }

  /** Up to 20 shows from the confirmed list: each read live, moved if it still qualifies, and never graduated again. */
  private async graduateBatch(c: CoreEndpointClient, st: AppState, by: string, tick?: NonNullable<AppState['lastTick']>): Promise<{ moved: number; failed: number }> {
    const q = st.graduateQueue
    let moved = 0, failed = 0
    if (!q) return { moved, failed }
    const take = q.ids.splice(0, Math.max(0, Math.min(MAX_MOVES_PER_TICK, this.budget('sonarr'))))
    const never = this.never(st)
    for (const id of take) {
      const live = await this.one(c, 'sonarr', id)
      if (!this.stillGraduates(live, q.from, never)) continue
      const m = await this.moveOne(c, 'sonarr', st, live, q.to, { kind: 'graduated', condition: 'ended', why: whyWord('ended', q.to), detail: 'it has ended and every aired episode is on disk', by })
      if (m.ok || m.files === 'pending') { moved++; st.graduated = [...st.graduated, id].slice(-MAX_GRADUATED) } else failed++
    }
    if (!q.ids.length) st.graduateQueue = null
    if (tick) { tick.moved += moved; tick.failed += failed }
    return { moved, failed }
  }

  /** The timer's part: the rest of a confirmed list, or (every six hours) the shows that finished since. */
  private async graduateTick(c: CoreEndpointClient, st: AppState, grad: GraduateRecord, now: number, tick: NonNullable<AppState['lastTick']>): Promise<void> {
    // Only while the enabled rules still name the same two folders the owner confirmed.
    const f = graduateFolders(await this.showSettings(c))
    if (!f || f.from !== grad.from || f.to !== grad.to) {
      this.d.log?.('[arr-router] graduating is on, but the running and ended rules no longer name the confirmed folders; nothing moved')
      return
    }
    if (!st.graduateQueue?.ids.length) {
      st.lastGraduateAt = now
      const g = graduates({ rules: [{ condition: 'running', folder: grad.from, enabled: true }, { condition: 'ended', folder: grad.to, enabled: true }] },
        await this.library(c, 'sonarr') as Show[], this.never(st))
      if (!g?.shows.length) return
      st.graduateQueue = { from: grad.from, to: grad.to, ids: g.shows.map(x => x.id) }
    }
    await this.graduateBatch(c, st, 'hyperprox', tick)
  }

  /**
   * Confirming the preview: the shows it listed that still qualify are queued, the first 20 move now and the rest 20 a
   * minute, and graduating is switched on with exactly the two folders the preview showed. The rules are not touched.
   */
  async graduateApply(previewId: unknown, by: string): Promise<{ moved: number; failed: number; queued: number; skipped: number; summary: string }> {
    const p = typeof previewId === 'string' ? this.previews.get(previewId) : undefined
    if (!p || this.d.now() - p.at > TEST_TTL_MS) throw new RouterRefusal(409, 'preview_required', 'Look at the preview first (it lasts 15 minutes).')
    const c = (await this.client('sonarr'))!
    return this.locked(async () => {
      this.previews.delete(previewId as string)
      const f = graduateFolders(await this.showSettings(c))
      if (!f || f.from !== p.from || f.to !== p.to) throw new RouterRefusal(409, 'changed', 'The show folders changed since the preview. Look at it again.')
      const st = await this.state('sonarr')
      const never = this.never(st)
      const ids = (await this.library(c, 'sonarr')).filter(x => p.ids.has(x.id) && this.stillGraduates(x, p.from, never)).map(x => x.id)
      await this.d.audit('arrstack.router.graduate', { by, count: ids.length, from: p.from, to: p.to })
      await this.d.store.set('graduate:sonarr', { on: true, from: p.from, to: p.to } satisfies GraduateRecord, by)
      st.graduateQueue = { from: p.from, to: p.to, ids: [...(st.graduateQueue?.ids ?? []).filter(x => !ids.includes(x)), ...ids] }
      st.lastGraduateAt = this.d.now()
      const { moved, failed } = await this.graduateBatch(c, st, by)
      const queued = st.graduateQueue?.ids.length ?? 0
      await this.saveState('sonarr', st)
      const skipped = p.ids.size - ids.length
      const summary = `Moved ${moved} finished ${moved === 1 ? 'show' : 'shows'} to ${folderName(p.to)}${queued ? `; ${queued} more follow, 20 a minute` : ''}${failed ? `; ${failed} did not move` : ''}${skipped ? `; ${skipped} no longer qualified` : ''}. Shows that finish from now on move on their own.`
      return { moved, failed, queued, skipped, summary }
    })
  }
}
