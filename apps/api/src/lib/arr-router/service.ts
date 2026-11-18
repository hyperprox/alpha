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
//             back. At most 20 moves a minute per app.
//   test      "Test on my library": the rules over the whole library, read-only, compared with where everything is.
//   save      the rules for one app. Switching sorting on (or changing the rules while it is on) needs the id of a
//             library test of exactly those rules from the last 15 minutes.
//   move      "Undo / move to…": one item from the Recently sorted list to the folder a person picks. The router
//             never touches that item again.
//   graduate  "Graduate finished shows": the preview (ended, every aired episode on disk, still in the running-shows
//             folder), then the move of exactly those, which also switches graduating on for shows that finish later
//             (looked at every six hours).
//
//  The routes are routes/arr-router.ts.
// =============================================================================

import crypto from 'node:crypto'
import type { CoreEndpointClient } from '../plugin-host'
import {
  APPS, CONDITION_LABEL, ROUTED_TAG, conditionsFor, defaultSettings, filmOf, folderName, graduates, guessDefaultRoot, normRoot, parseSettings,
  pickFolder, routable, ruleFingerprint, showOf, testLibrary, whyWord,
  type App, type AppSettings, type Condition, type Item, type LibraryTest, type Show,
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

const msg = (e: any) => String(e?.message ?? e).slice(0, 200)
const toItem = (app: App, raw: any): Item => (app === 'radarr' ? filmOf(raw) : showOf(raw))

export type MoveKind = 'sorted' | 'graduated' | 'moved'
export interface Move {
  key: string; at: string; app: App; id: number; title: string; year: number
  from: string; to: string; kind: MoveKind; condition: Condition | null
  /** "Horror → Scary Films". */
  why: string
  /** What in the arr's data matched: "genre Horror". */
  detail: string
  by: string; ok: boolean; error?: string
}

interface AppState {
  maxId: number; lastFullAt: number
  /** Items already looked at: id → when it was added (ms), forgotten once older than the look-back window. */
  seen: Record<string, number>
  /** Items a person moved by hand from the Recently sorted list: never sorted again. */
  leaveAlone: number[]
  tagId: number | null
  lastGraduateAt: number
  lastTick?: { at: string; looked: number; moved: number; failed: number; error?: string }
}
const freshState = (): AppState => ({ maxId: 0, lastFullAt: 0, seen: {}, leaveAlone: [], tagId: null, lastGraduateAt: 0 })

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
  error?: string
}
export interface RouterStatus { apps: AppStatus[]; recent: Move[]; everySeconds: number; lookbackHours: number }
export interface TestAnswer extends LibraryTest { testId: string; at: string }
export interface GraduatePreview { previewId: string; from: string; to: string; shows: Array<{ id: number; title: string; year: number; files: number; aired: number }> }

export class RouterService {
  private tests = new Map<string, { app: App; fp: string; at: number }>()
  private previews = new Map<string, { ids: Set<number>; at: number; from: string; to: string }>()
  private suggested = new Map<App, { at: number; s: AppSettings; from: 'seerr' | 'guess' }>()
  private rootCache = new Map<App, { at: number; roots: string[] }>()
  private recentCache: Move[] = []
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
  private saveState(app: App, s: AppState) { return this.d.store.set(`state:${app}`, s, 'hyperprox') }
  async recent(): Promise<Move[]> {
    const list = (await this.d.store.get<Move[]>('recent')) ?? []
    this.recentCache = list
    return list
  }

  /** For the confirmation's sentence (lib/confirm-text.ts): the title and folder name, only for a real entry and folder. */
  moveNames(app: unknown, id: unknown, folder: unknown): { title: string; folder: string } | null {
    if (app !== 'radarr' && app !== 'sonarr' || typeof folder !== 'string') return null
    const m = this.recentCache.find(x => x.app === app && x.id === id)
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

  async status(): Promise<RouterStatus> {
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
        if (stored) base.settings = stored
        else { const sg = await this.suggest(c, app); base.settings = sg.s; base.suggestedFrom = sg.from }
        base.saved = !!stored
        base.lastTick = st.lastTick ?? null
      } catch (e) {
        this.d.log?.(`[arr-router] ${app} could not be read: ${msg(e)}`)
        base.error = `${APP_NAME[app]} could not be read just now.`
      }
      apps.push(base)
    }
    return { apps, recent: await this.recent(), everySeconds: 60, lookbackHours: LOOKBACK_MS / 3600_000 }
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
      // Graduating is switched on only by confirming its preview (graduateApply); here it can only stay on or go off.
      s.graduate = app === 'sonarr' && s.graduate && cur?.graduate === true
      await this.d.audit('arrstack.router.settings', {
        app, by, enabled: s.enabled, graduate: s.graduate, defaultRoot: s.defaultRoot,
        rules: s.rules.filter(r => r.enabled).map(r => `${r.condition}:${r.folder ? folderName(r.folder) : '-'}`).join(', '),
      })
      await this.d.store.set(`settings:${app}`, s, by)
      if (turningOn && !cur?.enabled) {
        // Start counting from now: everything already in the library is the owner's, not the router's.
        const st = await this.state(app)
        st.maxId = 0; st.lastFullAt = 0; st.seen = {}
        await this.saveState(app, st)
      }
      return s
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
      try {
        const it = toItem(app, await c.get(API[app].one(id)))
        if (it.id === id) { out.push(it); st.maxId = id; misses = 0 } else misses++
      } catch (e) {
        if (!/HTTP 404\b/.test(msg(e))) throw e
        misses++
      }
      id++
    }
    return out
  }

  private async tickApp(app: App): Promise<void> {
    const s = await this.storedSettings(app)
    if (!s || (!s.enabled && !s.graduate)) return
    const c = await this.client(app, false)
    if (!c) return
    const st = await this.state(app)
    const now = this.d.now()
    // Graduating alone: nothing to do until its next six-hourly look.
    if (!s.enabled && (app !== 'sonarr' || now - st.lastGraduateAt < GRADUATE_EVERY_MS)) return
    const tick = { at: new Date(now).toISOString(), looked: 0, moved: 0, failed: 0 } as NonNullable<AppState['lastTick']>
    try {
      let all: Item[] | null = null
      const leave = new Set(st.leaveAlone)
      if (s.enabled) {
        // Graduating alone needs no look for new items; sorting does.
        let found: Item[]
        if (!st.maxId || now - st.lastFullAt >= FULL_READ_MS) {
          all = await this.library(c, app)
          found = all
          st.maxId = Math.max(st.maxId, ...all.map(i => i.id), 0)
          st.lastFullAt = now
        } else {
          found = await this.probe(c, app, st)
        }
        const pending = found.filter(i => st.seen[String(i.id)] === undefined && routable(i, s, { routedTag: st.tagId, now, lookbackMs: LOOKBACK_MS, leaveAlone: leave }))
          .sort((a, b) => a.id - b.id)
        const cands = pending.slice(0, MAX_MOVES_PER_TICK)
        // More than one minute's share: the next minute reads the whole library again to pick up the rest.
        if (pending.length > cands.length) st.lastFullAt = 0
        for (const it of cands) {
          tick.looked++
          st.seen[String(it.id)] = Date.parse(it.added)
          const p = pickFolder(app, s, it)
          if (!p || p.folder === it.root) continue
          const roots = await this.roots(c, app)
          if (!roots.includes(p.folder)) { tick.failed++; this.d.log?.(`[arr-router] ${app}: the folder for ${p.condition} is no longer a root folder`); continue }
          // Read it again: a person (or another tool) may have moved or tagged it since the list was read.
          const live = toItem(app, await c.get(API[app].one(it.id)))
          if (live.root !== it.root || (st.tagId !== null && live.tags.includes(st.tagId))) continue
          const m = await this.moveOne(c, app, st, live, p.folder, { kind: 'sorted', condition: p.condition, why: whyWord(p.condition, p.folder), detail: p.why, by: 'hyperprox' })
          if (m.ok) tick.moved++; else tick.failed++
        }
        const forget = now - LOOKBACK_MS - 3600_000
        for (const [k, added] of Object.entries(st.seen)) if (!(added >= forget)) delete st.seen[k]
      }
      if (app === 'sonarr' && s.graduate && now - st.lastGraduateAt >= GRADUATE_EVERY_MS) {
        all ??= await this.library(c, app)
        st.lastGraduateAt = now
        const g = graduates(s, all as Show[], leave)
        for (const show of g?.shows.slice(0, MAX_MOVES_PER_TICK) ?? []) {
          const m = await this.moveOne(c, app, st, show, g!.to, { kind: 'graduated', condition: 'ended', why: whyWord('ended', g!.to), detail: 'it has ended and every aired episode is on disk', by: 'hyperprox' })
          if (m.ok) tick.moved++; else tick.failed++
        }
      }
    } catch (e) {
      tick.error = msg(e)
      this.d.log?.(`[arr-router] ${app}: ${tick.error}`)
    }
    st.lastTick = tick
    await this.saveState(app, st)
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

  /** Audit, move through the arr's editor (files too), read back, and remember it in Recently sorted. */
  private async moveOne(c: CoreEndpointClient, app: App, st: AppState, item: Item, to: string,
    meta: { kind: MoveKind; condition: Condition | null; why: string; detail: string; by: string }): Promise<Move> {
    const m: Move = {
      key: crypto.randomBytes(8).toString('hex'), at: this.iso(), app, id: item.id, title: item.title, year: item.year,
      from: item.root, to, kind: meta.kind, condition: meta.condition, why: meta.why, detail: meta.detail, by: meta.by, ok: false,
    }
    // No audit row, no move: this throws and nothing below runs.
    await this.d.audit('arrstack.router.move', { app, id: item.id, title: item.title, from: item.root, to, kind: meta.kind, why: meta.why, by: meta.by })
    try {
      const tagId = await this.tag(c, app, st)
      const body: Record<string, unknown> = { [API[app].ids]: [item.id], rootFolderPath: to, moveFiles: true }
      if (tagId !== null) { body.tags = [tagId]; body.applyTags = 'add' }
      await c.put(API[app].editor, body, 60_000)
      const back = toItem(app, await c.get(API[app].one(item.id)))
      m.ok = back.root === to || back.path.startsWith(`${to}/`)
      if (!m.ok) m.error = `${APP_NAME[app]} still shows it in ${folderName(back.root || item.root)}.`
    } catch (e) {
      m.error = `${APP_NAME[app]} did not move it: ${msg(e)}`
    }
    if (!m.ok) this.d.log?.(`[arr-router] ${app} ${item.id}: ${m.error}`)
    await this.d.audit('arrstack.router.moved', { app, id: item.id, to, ok: m.ok, error: m.error ?? null }).catch(() => {})
    const list = [m, ...await this.recent()].slice(0, RECENT_MAX)
    await this.d.store.set('recent', list, meta.by)
    this.recentCache = list
    return m
  }

  /** "Undo / move to…": one item from the Recently sorted list to a folder a person picked. */
  async move(app: App, id: number, folder: string, by: string): Promise<Move> {
    const c = (await this.client(app))!
    return this.locked(async () => {
      if (!(await this.recent()).some(m => m.app === app && m.id === id)) {
        throw new RouterRefusal(404, 'not_found', 'Only something in the Recently sorted list can be moved from here.')
      }
      const to = normRoot(folder)
      if (!(await this.roots(c, app, true)).includes(to)) throw new RouterRefusal(400, 'bad_request', `That is not one of ${APP_NAME[app]}'s root folders.`)
      const live = toItem(app, await c.get(API[app].one(id)))
      if (live.root === to) throw new RouterRefusal(409, 'already_there', `${live.title} is already in ${folderName(to)}.`)
      const st = await this.state(app)
      if (!st.leaveAlone.includes(id)) st.leaveAlone = [...st.leaveAlone, id].slice(-MAX_LEAVE_ALONE)
      const m = await this.moveOne(c, app, st, live, to, { kind: 'moved', condition: null, why: `Moved by hand → ${folderName(to)}`, detail: 'moved from the Recently sorted list', by })
      await this.saveState(app, st)
      if (!m.ok) throw new RouterRefusal(502, 'not_moved', m.error ?? 'It was not moved.')
      return m
    })
  }

  // ── "Graduate finished shows" ──────────────────────────────────────────────

  private async showSettings(c: CoreEndpointClient): Promise<AppSettings> {
    return (await this.storedSettings('sonarr')) ?? (await this.suggest(c, 'sonarr')).s
  }

  async graduatePreview(): Promise<GraduatePreview> {
    const c = (await this.client('sonarr'))!
    const s = await this.showSettings(c)
    const st = await this.state('sonarr')
    const g = graduates(s, await this.library(c, 'sonarr') as Show[], new Set(st.leaveAlone))
    if (!g) throw new RouterRefusal(409, 'no_folders', 'Pick a folder for running shows and a different one for ended shows first.')
    const previewId = crypto.randomBytes(12).toString('hex')
    const now = this.d.now()
    for (const [k, v] of this.previews) if (now - v.at > TEST_TTL_MS) this.previews.delete(k)
    this.previews.set(previewId, { ids: new Set(g.shows.map(x => x.id)), at: now, from: g.from, to: g.to })
    return { previewId, from: g.from, to: g.to, shows: g.shows.map(x => ({ id: x.id, title: x.title, year: x.year, files: x.files, aired: x.aired })) }
  }

  /** Move exactly the previewed shows that still qualify, and switch graduating on for shows that finish later. */
  async graduateApply(previewId: unknown, by: string): Promise<{ moved: number; failed: number; skipped: number; summary: string }> {
    const p = typeof previewId === 'string' ? this.previews.get(previewId) : undefined
    if (!p || this.d.now() - p.at > TEST_TTL_MS) throw new RouterRefusal(409, 'preview_required', 'Look at the preview first (it lasts 15 minutes).')
    const c = (await this.client('sonarr'))!
    return this.locked(async () => {
      this.previews.delete(previewId as string)
      const s = await this.showSettings(c)
      const st = await this.state('sonarr')
      const g = graduates(s, await this.library(c, 'sonarr') as Show[], new Set(st.leaveAlone))
      if (!g || g.from !== p.from || g.to !== p.to) throw new RouterRefusal(409, 'changed', 'The show folders changed since the preview. Look at it again.')
      const now = g.shows.filter(x => p.ids.has(x.id))
      await this.d.audit('arrstack.router.graduate', { by, count: now.length, from: g.from, to: g.to })
      let moved = 0, failed = 0
      for (const show of now) {
        const m = await this.moveOne(c, 'sonarr', st, show, g.to, { kind: 'graduated', condition: 'ended', why: whyWord('ended', g.to), detail: 'it has ended and every aired episode is on disk', by })
        if (m.ok) moved++; else failed++
      }
      st.lastGraduateAt = this.d.now()
      await this.saveState('sonarr', st)
      await this.d.store.set('settings:sonarr', { ...s, graduate: true }, by)
      const skipped = p.ids.size - now.length
      const summary = `Moved ${moved} finished ${moved === 1 ? 'show' : 'shows'} to ${folderName(g.to)}${failed ? `; ${failed} did not move` : ''}${skipped ? `; ${skipped} no longer qualified` : ''}. Shows that finish from now on move on their own.`
      return { moved, failed, skipped, summary }
    })
  }
}
