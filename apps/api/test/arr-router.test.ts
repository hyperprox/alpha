// Arr Stack "Sort requests into the right folder": the film and show conditions (photoreal remakes are not cartoons,
// Marvel and DC by studio, keyword or name, Christmas without the action films set at Christmas), the default rules
// matched to folders by name, the library test (read-only, hand-picked folders left out of the score), which items the
// router may touch (only new ones in the request folder), the minute tick (cheap look-ups, audited before each move,
// read back, tagged, never while locked), "Undo / move to…", graduating finished shows, and the routes through the
// real gate (admin, confirmed on the page, never an API token). The fixtures are recorded arr shapes with made-up
// titles, ids and folders.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import Fastify from 'fastify'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { requiredRole, needsConfirm, needsPassword } from '../src/lib/roles'
import { injectConfirmed } from './fakes/confirm'
import { buildArrRouterRoutes } from '../src/routes/arr-router'
import {
  defaultRules, defaultSettings, filmMatch, groupWord, leftAloneFolders, libraryPlan, filmOf, graduates, guessDefaultRoot, parseSettings, pickFolder, routable, ruleFingerprint, showMatch, showOf, testLibrary,
  whyWord, type AppSettings, type Film,
} from '../src/lib/arr-router/rules'
import { FULL_READ_MS, GRADUATE_EVERY_MS, LOOKBACK_MS, MAX_EXAMINED_PER_TICK, MAX_MOVES_PER_TICK, RouterRefusal, RouterService, type RouterDeps } from '../src/lib/arr-router/service'
import { MemoryRouterStore } from '../src/lib/arr-router/store'
import type { CoreEndpointClient } from '../src/lib/plugin-host'
import { signIn } from './fakes/app'
import { FakeBroker } from './fakes/fake-broker'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { setAuditSink } from '../src/lib/audit'
import { MemoryApiTokenStore, setApiTokenStore, createApiToken, tokenForbidden } from '../src/lib/api-tokens'
import { MissLimiter } from '../src/lib/plex-art'

const FIX = path.join(__dirname, 'fixtures', 'arr-router')
const fx = (n: string) => JSON.parse(fs.readFileSync(path.join(FIX, n), 'utf8'))
const NOW = Date.parse('2026-11-18T12:00:00Z')
const F = '/data/films/'
const T = '/data/tv/'
const FILM_ROOTS = fx('radarr-rootfolder.json').map((r: any) => r.path)
const SHOW_ROOTS = fx('sonarr-rootfolder.json').map((r: any) => r.path)

const broker = new FakeBroker()
broker.addUser('viewer@example.com', 'viewer master password', 'viewer')
broker.addUser('admin@example.com', 'admin master password', 'admin')
let tokens: MemoryApiTokenStore
before(() => {
  setBroker(broker)
  tokens = new MemoryApiTokenStore()
  setApiTokenStore(tokens)
  setAuditSink({ async write() {} })
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
})
after(async () => { setApiTokenStore(null); setAuditSink(null); if (isUnlocked()) await lock('manual') })

const film = (over: Partial<Film> = {}): Film => ({
  id: 1, tmdbId: 990001, title: 'A Made-up Film', year: 2020, genres: [], keywords: [], certification: '', studio: '', collection: '', overview: '',
  root: `${F}Main Films`, path: `${F}Main Films/A Made-up Film (2020)`, added: '2026-11-18T11:59:00Z', tags: [], hasFile: false, ...over,
})
const filmSettings = (over: Partial<AppSettings> = {}): AppSettings => ({ ...defaultSettings('radarr', FILM_ROOTS, `${F}Main Films`), ...over })

// ── the conditions ───────────────────────────────────────────────────────────

test('christmas: a keyword for a TV film, a holiday word in the title, the summary for a romance; never an action film set at Christmas', () => {
  assert.match(filmMatch('christmas', film({ genres: ['TV Movie', 'Romance'], keywords: ['christmas'] }))!, /keyword "christmas"/)
  assert.match(filmMatch('christmas', film({ genres: ['TV Movie', 'Romance'], keywords: ['christmas romance'] }))!, /christmas romance/)
  assert.ok(filmMatch('christmas', film({ title: 'Mistletoe Junction', genres: ['Romance'] })), 'a holiday word in the title')
  assert.ok(filmMatch('christmas', film({ genres: ['TV Movie', 'Romance'], overview: 'She has until Christmas Eve to save the bakery.' })), 'the summary, for a TV romance')
  assert.equal(filmMatch('christmas', film({ genres: ['Action', 'Thriller'], keywords: ['christmas', 'heist'] })), null, 'an action film set at Christmas stays put')
  assert.ok(filmMatch('christmas', film({ genres: ['Comedy', 'Crime'], keywords: ['christmas', 'prison escape'] })), 'a Christmas crime comedy is a Christmas film')
  assert.ok(filmMatch('christmas', film({ title: 'The Christmas Getaway', genres: ['Action'] })), 'Christmas in the title wins over the genres')
  assert.equal(filmMatch('christmas', film({ genres: ['Drama'], keywords: ['christmas'] })), null, 'one "christmas" keyword on a drama is a scene, not the film')
  assert.ok(filmMatch('christmas', film({ genres: ['Drama'], keywords: ['christmas', 'santa claus'] })), 'two of them are the film')
  assert.equal(filmMatch('christmas', film({ title: 'A Summer Holiday', genres: ['Comedy'] })), null, '"holiday" in a title alone is not Christmas')
})

test('superhero: Marvel and DC by studio, by keyword, or by name when TMDB calls it a comic film; a children\'s cartoon stays with the cartoons', () => {
  assert.match(filmMatch('superhero', film({ studio: 'Marvel Studios', genres: ['Action'] }))!, /studio Marvel Studios/)
  assert.match(filmMatch('superhero', film({ keywords: ['dc extended universe (dceu)'], genres: ['Action'] }))!, /dceu/)
  assert.match(filmMatch('superhero', film({ title: 'The Gotham Ledger', keywords: ['based on comic'] }))!, /gotham/i)
  assert.equal(filmMatch('superhero', film({ title: 'The Gotham Ledger' })), null, 'a name alone, without a comic keyword, is not enough')
  assert.equal(filmMatch('superhero', film({ keywords: ['superhero'], genres: ['Action'] })), null, 'any superhero is not Marvel or DC')
  assert.equal(filmMatch('superhero', film({ studio: 'Marvel Studios', genres: ['Animation', 'Family'] })), null, 'a family cartoon goes to the cartoons')
  assert.ok(filmMatch('superhero', film({ keywords: ['dc animated movie universe (dcamu)'], genres: ['Animation', 'Action'], certification: 'PG-13' })), 'a grown-up DC cartoon is DC')
})

test('animated and live-action family: a photoreal remake (keyword, built-in list or the owner\'s list) is not a cartoon', () => {
  const remake = film({ genres: ['Adventure', 'Family', 'Animation'], keywords: ['live action remake'], certification: 'PG' })
  assert.equal(filmMatch('animated-family', remake), null)
  assert.match(filmMatch('family-live-action', remake)!, /not a cartoon/)
  const cartoon = film({ genres: ['Animation', 'Family'], certification: 'G' })
  assert.ok(filmMatch('animated-family', cartoon))
  assert.equal(filmMatch('family-live-action', cartoon), null)
  assert.equal(filmMatch('animated-family', cartoon, new Set([990001])), null, 'the owner can name a photoreal remake by its TMDB number')
  assert.ok(filmMatch('animated-family', film({ genres: ['Animation'], certification: 'PG' })), 'a PG cartoon counts as a family one')
  assert.equal(filmMatch('animated-family', film({ genres: ['Animation', 'Drama'], certification: 'R' })), null, 'an adult cartoon does not')
  assert.ok(filmMatch('family-live-action', film({ genres: ['Family', 'Comedy'], certification: 'PG' })))
  assert.equal(filmMatch('family-live-action', film({ genres: ['Drama'], certification: 'G' })), null, 'G alone also covers old epics')
  assert.equal(filmMatch('family-live-action', film({ genres: ['Family', 'Horror'] })), null, 'never a horror film')
  assert.equal(filmMatch('curated', film({ genres: ['Drama'] })), null, 'nothing is ever sorted into a hand-picked folder')
})

test('shows: animated by genre or anime type, then ended, then still running', () => {
  const shows = fx('sonarr-series.json').map(showOf)
  assert.equal(showMatch('animated', shows[2]), 'series type anime')
  assert.equal(showMatch('animated', shows[3]), 'genre Animation')
  assert.equal(showMatch('ended', shows[1]), 'it has ended')
  assert.equal(showMatch('running', shows[0]), 'it is continuing')
  assert.equal(showMatch('running', shows[6]), 'it is upcoming')
  assert.equal(showMatch('running', shows[1]), null)
})

// ── defaults and settings ────────────────────────────────────────────────────

test('the default rules follow the owner\'s order and find each folder by its name; the request folder is where most new items went', () => {
  const films = fx('radarr-movies.json').map(filmOf)
  assert.equal(guessDefaultRoot(films), `${F}Main Films`)
  const r = defaultRules('radarr', FILM_ROOTS, `${F}Main Films`)
  assert.deepEqual(r.map(x => [x.condition, x.folder?.replace(F, '') ?? null]), [
    ['curated', 'Cinema Picks'], ['documentary', 'Docs'], ['christmas', 'Festive'], ['horror', 'Frights'], ['superhero', 'Comic Heroes'],
    ['animated-family', 'Kids Cartoons'], ['family-live-action', 'Kids Live Action'], ['default', 'Main Films'],
  ])
  assert.ok(r.every(x => x.enabled))
  const shows = defaultRules('sonarr', SHOW_ROOTS, `${T}On Air`)
  assert.deepEqual(shows.map(x => [x.condition, x.folder?.replace(T, '') ?? null]), [['animated', 'Cartoon Shows'], ['ended', 'Finished Runs'], ['running', 'On Air'], ['default', 'On Air']])
  // A folder that fits nothing leaves the rule off and empty.
  const few = defaultRules('radarr', [`${F}Main Films`], `${F}Main Films`)
  assert.deepEqual(few.filter(x => x.enabled).map(x => x.condition), ['default'])
  assert.equal(defaultSettings('radarr', FILM_ROOTS, null).enabled, false, 'off by default')
})

test('settings are checked: only the app\'s own folders and conditions, each once, a folder for every rule that is on', () => {
  const ok = parseSettings('radarr', { ...filmSettings(), enabled: true }, FILM_ROOTS)
  assert.equal(typeof ok, 'object')
  assert.match(parseSettings('radarr', { ...filmSettings(), defaultRoot: '/elsewhere' }, FILM_ROOTS) as string, /not one of this app's root folders/)
  assert.match(parseSettings('radarr', { ...filmSettings(), rules: [{ condition: 'horror', folder: '/elsewhere', enabled: true }] }, FILM_ROOTS) as string, /not one of this app's root folders/)
  assert.match(parseSettings('radarr', { ...filmSettings(), rules: [{ condition: 'ended', folder: null, enabled: false }] }, FILM_ROOTS) as string, /not a condition for films/)
  assert.match(parseSettings('radarr', { ...filmSettings(), rules: [{ condition: 'horror', folder: null, enabled: false }, { condition: 'horror', folder: null, enabled: false }] }, FILM_ROOTS) as string, /once/)
  assert.match(parseSettings('radarr', { ...filmSettings(), rules: [{ condition: 'horror', folder: null, enabled: true }] }, FILM_ROOTS) as string, /Pick a folder/)
  assert.match(parseSettings('radarr', { ...filmSettings(), defaultRoot: null, enabled: true }, FILM_ROOTS) as string, /folder requests arrive in/)
  assert.match(parseSettings('radarr', { ...filmSettings(), photoreal: ['x'] }, FILM_ROOTS) as string, /TMDB numbers/)
  assert.equal((parseSettings('radarr', { ...filmSettings(), graduate: true }, FILM_ROOTS) as AppSettings).graduate, false, 'graduating is for shows only')
})

// ── "Test on my library" ─────────────────────────────────────────────────────

test('library test: agreement per app, hand-picked folders left out, the disagreements grouped with examples', () => {
  const films = fx('radarr-movies.json').map(filmOf)
  const t = testLibrary('radarr', filmSettings(), films)
  assert.equal(t.curated, 1)
  assert.equal(t.scored, 16)
  assert.equal(t.agree, 13)
  assert.equal(t.agreement, 81.3)
  assert.deepEqual(t.disagreements.map(d => [d.actual.replace(F, ''), d.pick.replace(F, ''), d.condition, d.examples]), [
    ['Kids Live Action', 'Kids Cartoons', 'animated-family', ['Velvet Jungle (2026)']],
    ['Main Films', 'Frights', 'horror', ['Signal Lost (1986)']],
    ['Main Films', 'Kids Live Action', 'family-live-action', ['The Clockwork Orphan (2015)']],
  ])
  // Naming the photoreal remake fixes its group.
  const tuned = testLibrary('radarr', filmSettings({ photoreal: [900015] }), films)
  assert.equal(tuned.agree, 14)
  const shows = fx('sonarr-series.json').map(showOf)
  const st = testLibrary('sonarr', defaultSettings('sonarr', SHOW_ROOTS, guessDefaultRoot(shows)), shows)
  assert.equal(st.agreement, 71.4)
  assert.deepEqual(st.disagreements.map(d => [d.actual.replace(T, ''), d.pick.replace(T, ''), d.count]), [['On Air', 'Finished Runs', 2]])
  assert.equal(whyWord('horror', `${F}Frights`), 'Horror → Frights')
})

// ── which items may be moved ─────────────────────────────────────────────────

test('only a new item in the request folder, added after switching on and within the day, untagged and never moved back', () => {
  const s = filmSettings({ enabled: true, enabledAt: '2026-11-18T09:00:00Z' })
  const o = { routedTag: 7, now: NOW, lookbackMs: LOOKBACK_MS, leaveAlone: new Set<number>() }
  assert.equal(routable(film(), s, o), true)
  assert.equal(routable(film({ root: `${F}Frights` }), s, o), false, 'placed by hand elsewhere')
  assert.equal(routable(film({ added: '2026-11-18T08:00:00Z' }), s, o), false, 'added before sorting was on')
  assert.equal(routable(film({ added: '2026-11-18T11:00:00Z' }), { ...s, enabledAt: '2026-11-10T00:00:00Z' }, { ...o, lookbackMs: 30 * 60_000 }), false, 'older than the look-back window')
  assert.equal(routable(film({ tags: [7] }), s, o), false, 'already routed')
  assert.equal(routable(film(), s, { ...o, leaveAlone: new Set([1]) }), false, 'moved back by a person')
  assert.equal(routable(film(), { ...s, enabled: false }, o), false, 'switched off')
})

test('graduating: ended, every aired episode on disk, still in the running-shows folder', () => {
  const shows = fx('sonarr-series.json').map(showOf)
  const s = defaultSettings('sonarr', SHOW_ROOTS, `${T}On Air`)
  const g = graduates(s, shows)!
  assert.equal(g.to, `${T}Finished Runs`)
  assert.deepEqual(g.shows.map(x => x.title), ['Tidewater'], 'Half Built is missing episodes; the others are not in the running folder')
  assert.deepEqual(graduates(s, shows, new Set([5]))!.shows, [], 'a show moved back by hand is left alone')
})

// ── the service, against a fake Radarr and Sonarr ────────────────────────────

class FakeArr implements CoreEndpointClient {
  calls: string[] = []
  tags: Array<{ id: number; label: string }> = []
  failPut = false
  /** The arr's own move commands; each new one starts with this status. */
  commands: Array<{ id: number; name: string; status: string; body: any; message?: string }> = []
  commandStatus = 'completed'
  /** Queue rows (filtered by the caller, like the real queue). */
  queue: any[] = []
  constructor(public app: 'radarr' | 'sonarr', public items: any[], public roots: string[]) {}
  private kind() { return this.app === 'radarr' ? 'movie' : 'series' }
  async get(p: string): Promise<any> {
    this.calls.push(`GET ${p}`)
    if (p === `/api/v3/${this.kind()}`) return structuredClone(this.items)
    const one = new RegExp(`^/api/v3/${this.kind()}/(\\d+)$`).exec(p)
    if (one) {
      const it = this.items.find(i => i.id === Number(one[1]))
      if (!it) throw new Error(`${this.app} returned HTTP 404`)
      return structuredClone(it)
    }
    if (p === '/api/v3/rootfolder') return this.roots.map((path, i) => ({ id: i + 1, path }))
    if (p === '/api/v3/tag') return structuredClone(this.tags)
    if (p === '/api/v3/command') return structuredClone(this.commands)
    const cmd = /^\/api\/v3\/command\/(\d+)$/.exec(p)
    if (cmd) {
      const x = this.commands.find(k => k.id === Number(cmd[1]))
      if (!x) throw new Error(`${this.app} returned HTTP 404`)
      return structuredClone(x)
    }
    // The real queue ignores the filter often enough: answer with every row, the caller must filter.
    if (p.startsWith('/api/v3/queue/details?')) return structuredClone(this.queue)
    throw new Error(`unexpected GET ${p}`)
  }
  /** Called at the start of every PUT (a test can act mid-batch). */
  onPut?: () => Promise<void> | void
  async put(p: string, b: any): Promise<any> {
    this.calls.push(`PUT ${p} ${JSON.stringify(b)}`)
    await this.onPut?.()
    if (this.failPut) throw new Error(`${this.app} returned HTTP 500`)
    if (p !== `/api/v3/${this.kind()}/editor`) throw new Error(`unexpected PUT ${p}`)
    if (Array.isArray(b.tags) && b.tags.some((x: number) => !this.tags.some(t => t.id === x))) throw new Error(`${this.app} returned HTTP 400`)
    const ids = b[this.app === 'radarr' ? 'movieIds' : 'seriesIds']
    if (b.moveFiles) {
      const key = this.app === 'radarr' ? 'movies' : 'series', idKey = this.app === 'radarr' ? 'movieId' : 'seriesId'
      this.commands.push({ id: 500 + this.commands.length, name: this.app === 'radarr' ? 'BulkMoveMovie' : 'BulkMoveSeries', status: this.commandStatus,
        body: { destinationRootFolder: b.rootFolderPath, [key]: ids.map((id: number) => ({ [idKey]: id })) } })
    }
    for (const id of ids) {
      const it = this.items.find(i => i.id === id)
      const leaf = it.path.split('/').pop()
      it.rootFolderPath = b.rootFolderPath; it.path = `${b.rootFolderPath}/${leaf}`
      if (b.applyTags === 'add') it.tags = [...new Set([...it.tags, ...b.tags])]
    }
    return []
  }
  async post(p: string, b: any): Promise<any> {
    this.calls.push(`POST ${p} ${JSON.stringify(b)}`)
    if (p !== '/api/v3/tag') throw new Error(`unexpected POST ${p}`)
    const t = { id: 40 + this.tags.length, label: b.label }
    this.tags.push(t)
    return t
  }
  async delete(): Promise<any> { throw new Error('nothing is ever deleted') }
  async image(): Promise<any> { throw new Error('no images') }
  async trigger(): Promise<void> { throw new Error('no triggers') }
  writes() { return this.calls.filter(c => !c.startsWith('GET ')) }
}

function rig(over: Partial<RouterDeps> = {}) {
  const radarr = new FakeArr('radarr', fx('radarr-movies.json'), FILM_ROOTS)
  const sonarr = new FakeArr('sonarr', fx('sonarr-series.json'), SHOW_ROOTS)
  const store = new MemoryRouterStore()
  const audits: Array<{ action: string; details: Record<string, unknown> }> = []
  let now = NOW, unlocked = true
  const svc = new RouterService({
    clients: { radarr: async () => radarr, sonarr: async () => sonarr },
    store,
    audit: async (action, details) => { audits.push({ action, details }) },
    now: () => now, unlocked: () => unlocked, sleep: async () => {}, ...over,
  })
  return { svc, radarr, sonarr, store, audits, at: (ms: number) => { now = ms }, setUnlocked: (u: boolean) => { unlocked = u } }
}

const newFilm = (id: number, title: string, genres: string[], keywords: string[], added: string, root = `${F}Main Films`, hasFile = false) => ({
  id, tmdbId: 910000 + id, title, year: 2026, genres, keywords, certification: 'PG-13', studio: 'Northwind Pictures', collection: null, overview: '',
  rootFolderPath: root, path: `${root}/${title} (2026)`, added, tags: [], hasFile, monitored: true,
})

async function switchOn(r: ReturnType<typeof rig>, app: 'radarr' | 'sonarr' = 'radarr', settings?: AppSettings) {
  const s = settings ?? (await r.svc.status()).apps.find(a => a.app === app)!.settings!
  const t = await r.svc.test(app, s)
  return r.svc.saveSettings(app, { ...s, enabled: true }, t.testId, 'admin@example.com')
}

test('status: off by default, the suggested rules matched to the library\'s folders, nothing written to the arrs', async () => {
  const r = rig()
  const st = await r.svc.status()
  const films = st.apps.find(a => a.app === 'radarr')!
  assert.equal(films.configured, true); assert.equal(films.saved, false); assert.equal(films.settings!.enabled, false)
  assert.equal(films.settings!.defaultRoot, `${F}Main Films`)
  assert.equal(films.roots.length, 8)
  assert.deepEqual(r.radarr.writes(), []); assert.deepEqual(r.sonarr.writes(), [])
})

test('the request folder comes from Seerr\'s settings when it is connected (its default, non-4K server), else from the latest additions', async () => {
  const seerr: Partial<CoreEndpointClient> & { calls: string[] } = {
    calls: [],
    async get(p: string) {
      this.calls.push(p)
      if (p === '/api/v1/settings/radarr') return [{ id: 0, isDefault: true, is4k: true, activeDirectory: `${F}Frights` }, { id: 1, isDefault: true, is4k: false, activeDirectory: `${F}Docs/` }]
      if (p === '/api/v1/settings/sonarr') return [{ id: 0, isDefault: true, is4k: false, activeDirectory: '/not/a/root/folder' }]
      throw new Error('unexpected')
    },
  }
  const r = rig({ seerr: async () => seerr as CoreEndpointClient })
  const st = await r.svc.status()
  const films = st.apps.find(a => a.app === 'radarr')!, shows = st.apps.find(a => a.app === 'sonarr')!
  assert.equal(films.settings!.defaultRoot, `${F}Docs`); assert.equal(films.suggestedFrom, 'seerr')
  assert.equal(shows.settings!.defaultRoot, `${T}On Air`, 'a Seerr folder that is not a root folder is not used')
  assert.equal(shows.suggestedFrom, 'guess')
  assert.deepEqual(seerr.calls.sort(), ['/api/v1/settings/radarr', '/api/v1/settings/sonarr'], 'only its settings are read')
  const off = await rig({ seerr: async () => null }).svc.status()
  assert.equal(off.apps.find(a => a.app === 'radarr')!.suggestedFrom, 'guess')
})

test('the library test moves nothing; switching on needs a test of exactly those rules, from the last 15 minutes', async () => {
  const r = rig()
  const s = (await r.svc.status()).apps.find(a => a.app === 'radarr')!.settings!
  const t = await r.svc.test('radarr', s)
  assert.equal(t.agreement, 81.3)
  assert.deepEqual(r.radarr.writes(), [], 'read-only')
  await assert.rejects(r.svc.saveSettings('radarr', { ...s, enabled: true }, undefined, 'admin@example.com'), (e: any) => e instanceof RouterRefusal && e.code === 'test_required')
  const changed = { ...s, enabled: true, rules: s.rules.map(x => (x.condition === 'horror' ? { ...x, enabled: false } : x)) }
  await assert.rejects(r.svc.saveSettings('radarr', changed, t.testId, 'admin@example.com'), (e: any) => e.code === 'test_required', 'a test of other rules does not count')
  r.at(NOW + 16 * 60_000)
  await assert.rejects(r.svc.saveSettings('radarr', { ...s, enabled: true }, t.testId, 'admin@example.com'), (e: any) => e.code === 'test_required', 'too old')
  r.at(NOW)
  const t2 = await r.svc.test('radarr', s)
  const saved = await r.svc.saveSettings('radarr', { ...s, enabled: true }, t2.testId, 'admin@example.com')
  assert.equal(saved.enabled, true); assert.equal(saved.enabledAt, new Date(NOW).toISOString())
  assert.equal(r.audits.at(-1)!.action, 'arrstack.router.settings')
  // Saving it off needs no test.
  assert.equal((await r.svc.saveSettings('radarr', { ...s, enabled: false }, undefined, 'admin@example.com')).enabled, false)
  assert.equal(ruleFingerprint('radarr', s), ruleFingerprint('radarr', { ...s, enabled: true }), 'switching on alone is the same rules')
})

test('tick: a new film in the request folder is moved into its folder, tagged, read back, audited first; the library is left alone', async () => {
  const r = rig()
  await switchOn(r)
  r.radarr.items.push(newFilm(18, 'Harrow Lane Haunting', ['Horror'], ['ghost'], '2026-11-18T12:00:30Z'))
  r.radarr.items.push(newFilm(19, 'A Quiet Courtroom', ['Drama'], [], '2026-11-18T12:00:40Z'))
  r.radarr.items.push(newFilm(20, 'Hand-placed Fright', ['Horror'], [], '2026-11-18T12:00:50Z', `${F}Kids Live Action`))
  r.at(NOW + 60_000)
  await r.svc.tick()
  const moved = r.radarr.items.find(i => i.id === 18)
  assert.equal(moved.rootFolderPath, `${F}Frights`)
  assert.equal(moved.path, `${F}Frights/Harrow Lane Haunting (2026)`)
  assert.deepEqual(moved.tags, [40], 'tagged hpx-routed (created once)')
  assert.deepEqual(r.radarr.tags, [{ id: 40, label: 'hpx-routed' }])
  const puts = r.radarr.writes().filter(w => w.startsWith('PUT'))
  assert.equal(puts.length, 1, 'only the horror film moved; the drama stays, the hand-placed one is never touched')
  assert.match(puts[0], /"movieIds":\[18\]/); assert.match(puts[0], /"moveFiles":true/)
  assert.equal(r.radarr.items.find(i => i.id === 20).rootFolderPath, `${F}Kids Live Action`)
  const i = r.audits.findIndex(a => a.action === 'arrstack.router.move')
  assert.ok(i >= 0 && r.audits[i + 1].action === 'arrstack.router.moved' && r.audits[i + 1].details.ok === true)
  const recent = await r.svc.recent()
  assert.equal(recent.length, 1)
  assert.equal(recent[0].why, 'Horror → Frights'); assert.equal(recent[0].detail, 'genre Horror'); assert.equal(recent[0].ok, true)
  // The next minute: no full read, just a look for the next ids.
  r.radarr.calls = []
  r.at(NOW + 120_000)
  await r.svc.tick()
  assert.deepEqual(r.radarr.calls, ['GET /api/v3/movie/21', 'GET /api/v3/movie/22', 'GET /api/v3/movie/23'], 'cheap: three look-ups that find nothing')
  // A film added between two minutes is found by the look-up and moved.
  r.radarr.items.push(newFilm(21, 'Copper Comet Returns', ['Action'], ['dc extended universe (dceu)'], '2026-11-18T12:02:10Z'))
  r.at(NOW + 180_000)
  await r.svc.tick()
  assert.equal(r.radarr.items.find(i => i.id === 21).rootFolderPath, `${F}Comic Heroes`)
  // Every 15 minutes the whole library is read again, in case a look-up missed something.
  r.radarr.calls = []
  r.at(NOW + 60_000 + FULL_READ_MS)
  await r.svc.tick()
  assert.ok(r.radarr.calls.includes('GET /api/v3/movie'))
  assert.equal(r.radarr.writes().length, 0, 'nothing moves twice')
})

test('tick: no audit row, no move; a failed move is recorded, not retried by the next minute', async () => {
  let auditOk = true
  const r = rig({ audit: async (a) => { if (!auditOk && a === 'arrstack.router.move') throw new Error('audit log down') } })
  await switchOn(r)
  auditOk = false
  r.radarr.items.push(newFilm(18, 'Harrow Lane Haunting', ['Horror'], [], '2026-11-18T12:00:30Z'))
  r.at(NOW + 60_000)
  await r.svc.tick()
  assert.equal(r.radarr.writes().filter(w => w.startsWith('PUT')).length, 0, 'nothing moved without its audit row')
  const r2 = rig()
  await switchOn(r2)
  r2.radarr.failPut = true
  r2.radarr.items.push(newFilm(18, 'Harrow Lane Haunting', ['Horror'], [], '2026-11-18T12:00:30Z'))
  r2.at(NOW + 60_000)
  await r2.svc.tick()
  const rec = await r2.svc.recent()
  assert.equal(rec[0].ok, false); assert.match(rec[0].error!, /did not move it/)
  r2.at(NOW + 120_000)
  await r2.svc.tick()
  assert.equal(r2.radarr.writes().filter(w => w.startsWith('PUT')).length, 2, 'one try, plus one retry with the tag looked up again; nothing the next minute')
})

test('tick: nothing while HyperProx is locked, nothing while sorting is off, at most 20 moves a minute', async () => {
  const r = rig()
  r.radarr.items.push(newFilm(18, 'Harrow Lane Haunting', ['Horror'], [], '2026-11-18T12:00:30Z'))
  r.at(NOW + 60_000)
  await r.svc.tick()
  assert.deepEqual(r.radarr.calls, [], 'off: not even a read')
  r.at(NOW)
  await switchOn(r)
  r.radarr.calls = []
  r.setUnlocked(false)
  r.at(NOW + 60_000)
  await r.svc.tick()
  assert.deepEqual(r.radarr.calls, [], 'locked: not even a read')
  r.setUnlocked(true)
  for (let i = 0; i < 25; i++) r.radarr.items.push(newFilm(100 + i, `Fright Night Number ${i}`, ['Horror'], [], '2026-11-18T12:00:40Z'))
  await r.svc.tick()
  assert.equal(r.radarr.writes().filter(w => w.startsWith('PUT')).length, MAX_MOVES_PER_TICK, 'the first 20')
  r.at(NOW + 120_000)
  await r.svc.tick()
  assert.equal(r.radarr.writes().filter(w => w.startsWith('PUT')).length, 26, 'the rest the next minute')
})

test('"Undo / move to…": only from the Recently sorted list, into a real folder; the router never touches it again', async () => {
  const r = rig()
  await switchOn(r)
  r.radarr.items.push(newFilm(18, 'Harrow Lane Haunting', ['Horror'], [], '2026-11-18T12:00:30Z'))
  r.at(NOW + 60_000)
  await r.svc.tick()
  await assert.rejects(r.svc.move('radarr', 11, `${F}Frights`, 'admin@example.com'), (e: any) => e.code === 'not_found', 'not sorted by the router')
  await assert.rejects(r.svc.move('radarr', 18, '/somewhere/else', 'admin@example.com'), (e: any) => e.code === 'bad_request')
  await assert.rejects(r.svc.move('radarr', 18, `${F}Frights`, 'admin@example.com'), (e: any) => e.code === 'already_there')
  const m = await r.svc.move('radarr', 18, `${F}Main Films`, 'admin@example.com')
  assert.equal(m.ok, true); assert.equal(m.kind, 'moved'); assert.equal(m.by, 'admin@example.com')
  assert.equal(r.radarr.items.find(i => i.id === 18).rootFolderPath, `${F}Main Films`)
  assert.equal(r.svc.moveNames('radarr', 18, `${F}Frights`)!.title, 'Harrow Lane Haunting (2026)')
  // Back in the request folder, but moved there by a person: never sorted again, even after a full read.
  r.at(NOW + 60_000 + FULL_READ_MS)
  await r.svc.tick()
  assert.equal(r.radarr.items.find(i => i.id === 18).rootFolderPath, `${F}Main Films`)
})

test('graduating finished shows: a preview first, then exactly those move, and graduating is switched on', async () => {
  const r = rig()
  const p = await r.svc.graduatePreview()
  assert.deepEqual(p.shows.map(s => s.title), ['Tidewater'])
  assert.deepEqual(r.sonarr.writes(), [], 'the preview changes nothing')
  assert.deepEqual(r.svc.graduateNames(p.previewId), { count: 1, folder: 'Finished Runs' })
  await assert.rejects(r.svc.graduateApply('0'.repeat(24), 'admin@example.com'), (e: any) => e.code === 'preview_required')
  // Another show finishes after the preview: it is not in what was confirmed.
  r.sonarr.items.find(i => i.id === 6).statistics.episodeFileCount = 10
  const done = await r.svc.graduateApply(p.previewId, 'admin@example.com')
  assert.equal(done.moved, 1); assert.match(done.summary, /Moved 1 finished show to Finished Runs/)
  assert.equal(r.sonarr.items.find(i => i.id === 5).rootFolderPath, `${T}Finished Runs`)
  assert.equal(r.sonarr.items.find(i => i.id === 6).rootFolderPath, `${T}On Air`)
  assert.equal(await r.svc.storedSettings('sonarr'), null, 'the suggested rules are not stored as the owner\'s')
  assert.equal((await r.svc.status()).apps.find(a => a.app === 'sonarr')!.settings!.graduate, true)
  assert.equal(r.audits.find(a => a.action === 'arrstack.router.moved' && a.details.id === 5)!.details.files, 'moved', 'the files move was followed to the end')
  await assert.rejects(r.svc.graduateApply(p.previewId, 'admin@example.com'), (e: any) => e.code === 'preview_required', 'a preview is used once')
  // Graduating on: the next look (every six hours) moves the show that finished since.
  r.at(NOW + 60_000)
  await r.svc.tick()
  assert.equal(r.sonarr.items.find(i => i.id === 6).rootFolderPath, `${T}On Air`, 'not before six hours')
  r.at(NOW + GRADUATE_EVERY_MS)
  await r.svc.tick()
  assert.equal(r.sonarr.items.find(i => i.id === 6).rootFolderPath, `${T}Finished Runs`)
  // A graduated show the owner moved back by hand stays where he put it.
  const back = r.sonarr.items.find(i => i.id === 5)
  back.rootFolderPath = `${T}On Air`; back.path = `${T}On Air/Tidewater`
  r.at(NOW + 2 * GRADUATE_EVERY_MS)
  await r.svc.tick()
  assert.equal(back.rootFolderPath, `${T}On Air`, 'never graduated twice')
  // Saving the rules keeps graduating on, or switches it off; it never switches it on.
  const s = (await r.svc.status()).apps.find(a => a.app === 'sonarr')!.settings!
  assert.equal((await r.svc.saveSettings('sonarr', { ...s, graduate: true }, undefined, 'admin@example.com')).graduate, true, 'kept on')
  assert.equal((await r.svc.saveSettings('sonarr', { ...s, graduate: false }, undefined, 'admin@example.com')).graduate, false, 'switched off')
  assert.equal((await r.svc.saveSettings('sonarr', { ...s, graduate: true }, undefined, 'admin@example.com')).graduate, false, 'not back on without a preview')
})

test('graduating: only with the running and ended rules on; 20 a minute, the rest on the next ticks', async () => {
  const r = rig()
  const s = (await r.svc.status()).apps.find(a => a.app === 'sonarr')!.settings!
  await r.svc.saveSettings('sonarr', { ...s, rules: s.rules.map(x => (x.condition === 'ended' ? { ...x, enabled: false } : x)) }, undefined, 'admin@example.com')
  await assert.rejects(r.svc.graduatePreview(), (e: any) => e.code === 'no_folders')
  await r.svc.saveSettings('sonarr', s, undefined, 'admin@example.com')
  for (let i = 0; i < 25; i++) {
    r.sonarr.items.push({ ...structuredClone(r.sonarr.items[4]), id: 100 + i, tvdbId: 800100 + i, title: `Closed Book ${i}`, path: `${T}On Air/Closed Book ${i}` })
  }
  const p = await r.svc.graduatePreview()
  assert.equal(p.shows.length, 26)
  const done = await r.svc.graduateApply(p.previewId, 'admin@example.com')
  assert.equal(done.moved, 20); assert.equal(done.queued, 6); assert.match(done.summary, /6 more follow, 20 a minute/)
  r.at(NOW + 60_000)
  await r.svc.tick()
  assert.equal(r.sonarr.items.filter(i => i.rootFolderPath === `${T}Finished Runs`).length, 1 + 26, 'the rest the next minute')
  // Switching the ended rule off stops graduating at once.
  for (let i = 0; i < 2; i++) r.sonarr.items.push({ ...structuredClone(r.sonarr.items[4]), id: 200 + i, tvdbId: 800200 + i, title: `Late Finish ${i}`, rootFolderPath: `${T}On Air`, path: `${T}On Air/Late Finish ${i}` })
  await r.svc.saveSettings('sonarr', { ...s, graduate: true, rules: s.rules.map(x => (x.condition === 'ended' ? { ...x, enabled: false } : x)) }, undefined, 'admin@example.com')
  r.at(NOW + GRADUATE_EVERY_MS + 60_000)
  await r.svc.tick()
  assert.ok(r.sonarr.items.filter(i => i.id >= 200).every(i => i.rootFolderPath === `${T}On Air`))
})

test('hand-picked folders are never a target: refused when saved, skipped when picking, refused for Move to', async () => {
  const s = filmSettings()
  const intoCurated = { ...s, rules: s.rules.map(x => (x.condition === 'horror' ? { ...x, folder: `${F}Cinema Picks` } : x)) }
  assert.match(parseSettings('radarr', intoCurated, FILM_ROOTS) as string, /points at a hand-picked folder/)
  assert.match(parseSettings('radarr', { ...s, defaultRoot: `${F}Cinema Picks` }, FILM_ROOTS) as string, /marked hand-picked/)
  assert.equal(typeof parseSettings('radarr', { ...intoCurated, rules: intoCurated.rules.map(x => (x.condition === 'horror' ? { ...x, enabled: false } : x)) }, FILM_ROOTS), 'object', 'a rule that is off may keep it')
  assert.equal(pickFolder('radarr', intoCurated, film({ genres: ['Horror'] }))!.folder, `${F}Main Films`, 'the horror rule is skipped, the next fitting rule wins')
  const r = rig()
  await switchOn(r)
  r.radarr.items.push(newFilm(18, 'Harrow Lane Haunting', ['Horror'], [], '2026-11-18T12:00:30Z'))
  r.at(NOW + 60_000)
  await r.svc.tick()
  await assert.rejects(r.svc.move('radarr', 18, `${F}Cinema Picks`, 'admin@example.com'), (e: any) => e.code === 'hand_picked')
})

test('files: a move whose files are still on their way is "pending", then confirmed or failed from the arr\'s command', async () => {
  const r = rig()
  await switchOn(r)
  r.radarr.commandStatus = 'started'
  r.radarr.items.push(newFilm(18, 'Harrow Lane Haunting', ['Horror'], [], '2026-11-18T12:00:30Z', `${F}Main Films`, true))
  r.radarr.items.push(newFilm(19, 'Copper Comet Again', ['Action'], ['dc extended universe (dceu)'], '2026-11-18T12:00:40Z', `${F}Main Films`, true))
  r.at(NOW + 60_000)
  await r.svc.tick()
  let rec = await r.svc.recent()
  assert.deepEqual(rec.map(m => [m.id, m.ok, m.files]), [[19, false, 'pending'], [18, false, 'pending']], 'not ok while the files move')
  assert.ok(rec.every(m => m.commandId))
  r.radarr.commands[0].status = 'completed'
  r.radarr.commands[1].status = 'failed'; r.radarr.commands[1].message = 'Destination folder is full'
  r.at(NOW + 120_000)
  await r.svc.tick()
  rec = await r.svc.recent()
  assert.deepEqual(rec.map(m => [m.id, m.ok, m.files]), [[19, false, 'failed'], [18, true, 'moved']])
  assert.match(rec[0].error!, /could not move the files \(failed: Destination folder is full\)/)
  assert.ok(r.audits.some(a => a.action === 'arrstack.router.files' && a.details.files === 'failed'))
  // A film with no files has nothing to move: ok at once.
  r.radarr.items.push(newFilm(20, 'Quiet Frights', ['Horror'], [], '2026-11-18T12:02:30Z'))
  r.at(NOW + 180_000)
  await r.svc.tick()
  assert.deepEqual([(await r.svc.recent())[0].ok, (await r.svc.recent())[0].files], [true, 'none'])
})

test('an item the arr is importing waits for the next minute (the queue is filtered here, not trusted)', async () => {
  const r = rig()
  await switchOn(r)
  r.radarr.items.push(newFilm(18, 'Harrow Lane Haunting', ['Horror'], [], '2026-11-18T12:00:30Z'))
  r.radarr.queue = [{ movieId: 18, trackedDownloadState: 'importPending' }, { movieId: 3, trackedDownloadState: 'downloading' }]
  r.at(NOW + 60_000)
  await r.svc.tick()
  assert.equal(r.radarr.writes().filter(w => w.startsWith('PUT')).length, 0)
  assert.equal((await r.svc.status()).apps.find(a => a.app === 'radarr')!.lastTick!.waiting, 1)
  // Another item's import does not hold this one back.
  r.radarr.queue = [{ movieId: 3, trackedDownloadState: 'importing' }]
  r.at(NOW + 120_000)
  await r.svc.tick()
  assert.equal(r.radarr.items.find(i => i.id === 18).rootFolderPath, `${F}Frights`, 'looked at again, though no new id was found')
})

test('a stale hpx-routed tag (deleted in the arr) is looked up again and the move retried once', async () => {
  const r = rig()
  await switchOn(r)
  r.radarr.items.push(newFilm(18, 'Harrow Lane Haunting', ['Horror'], [], '2026-11-18T12:00:30Z'))
  r.at(NOW + 60_000)
  await r.svc.tick()
  r.radarr.tags = []   // someone deleted the tag in Radarr
  r.radarr.items.push(newFilm(19, 'Harrow Lane Haunting II', ['Horror'], [], '2026-11-18T12:01:30Z'))
  r.at(NOW + 120_000)
  await r.svc.tick()
  const moved = r.radarr.items.find(i => i.id === 19)
  assert.equal(moved.rootFolderPath, `${F}Frights`)
  assert.deepEqual(moved.tags, [40], 'tagged with the tag made again')
  assert.equal((await r.svc.recent())[0].ok, true)
})

test('films: The pick for every fixture with the default rules', () => {
  const s = filmSettings()
  const picks = fx('radarr-movies.json').map(filmOf).map((f: Film) => [f.title, pickFolder('radarr', s, f)?.folder.replace(F, '') ?? null])
  assert.deepEqual(Object.fromEntries(picks), {
    'Harbour of Ghosts': 'Frights', 'The Lantern Parade': 'Festive', 'Mistletoe Junction': 'Festive', 'Snowbound Heist': 'Main Films',
    'Paper Moon Kingdom': 'Kids Cartoons', 'The Meadow King': 'Kids Live Action', 'Copper Comet': 'Comic Heroes', 'Starling Squad': 'Comic Heroes',
    'Quiet Waters: A Life': 'Docs', 'The Clockwork Orphan': 'Kids Live Action', 'Riverside Detective': 'Main Films', 'Night Train Overture': 'Main Films',
    'Little Rocket Heroes': 'Kids Cartoons', 'Signal Lost': 'Frights', 'Velvet Jungle': 'Kids Cartoons', 'The Gotham Ledger': 'Comic Heroes', 'Holly Hollow': 'Festive',
  })
})

// ── roles and the routes through the real gate ───────────────────────────────

test('roles: the page is a read; the test and preview are admin; saving, moving and graduating are confirmed; never a token; no master password', () => {
  assert.equal(requiredRole('GET', '/api/plugins/arrstack/router'), 'viewer')
  for (const p of ['test', 'settings', 'move', 'graduate', 'graduate/preview']) {
    assert.equal(requiredRole('POST', `/api/plugins/arrstack/router/${p}`), 'admin', p)
    assert.equal(tokenForbidden('POST', `/api/plugins/arrstack/router/${p}`), true, p)
    assert.equal(needsPassword('POST', `/api/plugins/arrstack/router/${p}`), false, p)
  }
  assert.equal(tokenForbidden('GET', '/api/plugins/arrstack/router'), false)
  for (const p of ['settings', 'move', 'graduate']) assert.equal(needsConfirm('POST', `/api/plugins/arrstack/router/${p}`), true, p)
  for (const p of ['test', 'graduate/preview']) assert.equal(needsConfirm('POST', `/api/plugins/arrstack/router/${p}`), false, p)
})

test('routes: a viewer reads; changes need an admin and a confirmation, never a token; the confirmation names the item', async () => {
  const r = rig()
  const a = Fastify({ logger: false })
  await registerGate(a)
  await a.register(authRoutes, { prefix: '/api/auth' })
  await a.register(buildArrRouterRoutes({ service: () => r.svc, limiter: new MissLimiter(100), testLimiter: new MissLimiter(100) }), { prefix: '/api/plugins/arrstack' })
  await a.ready()
  try {
    const viewer = await signIn(a, 'viewer@example.com', 'viewer master password')
    const v = await a.inject({ method: 'GET', url: '/api/plugins/arrstack/router', headers: { cookie: viewer.cookie } })
    assert.equal(v.statusCode, 200, v.body)
    const settings = JSON.parse(v.body).data.apps.find((x: any) => x.app === 'radarr').settings
    assert.equal((await a.inject({ method: 'POST', url: '/api/plugins/arrstack/router/test', headers: { cookie: viewer.cookie }, payload: { app: 'radarr', settings } })).statusCode, 403)
    const tok = (await createApiToken({ name: 'bot', role: 'admin' }, 'test', tokens)).token
    const tp = await a.inject({ method: 'POST', url: '/api/plugins/arrstack/router/test', headers: { authorization: `Bearer ${tok}` }, payload: { app: 'radarr', settings } })
    assert.equal(tp.statusCode, 403); assert.equal(JSON.parse(tp.body).code, 'token_forbidden')
    const adm = await signIn(a, 'admin@example.com', 'admin master password')
    const t = await a.inject({ method: 'POST', url: '/api/plugins/arrstack/router/test', headers: { cookie: adm.cookie }, payload: { app: 'radarr', settings } })
    assert.equal(t.statusCode, 200, t.body)
    const testId = JSON.parse(t.body).data.testId
    const save = { app: 'radarr', settings: { ...settings, enabled: true }, testId }
    const ask = await a.inject({ method: 'POST', url: '/api/plugins/arrstack/router/settings', headers: { cookie: adm.cookie }, payload: save })
    assert.equal(ask.statusCode, 403); assert.equal(JSON.parse(ask.body).code, 'confirm_required')
    assert.match(JSON.parse(ask.body).confirm.summary, /^Sort new films into folders\?/)
    assert.deepEqual(r.radarr.writes(), [])
    const done = await injectConfirmed(a, { method: 'POST', url: '/api/plugins/arrstack/router/settings', headers: { cookie: adm.cookie }, payload: save })
    assert.equal(done.statusCode, 200, done.body); assert.equal(JSON.parse(done.body).data.enabled, true)
    // A move through the route: confirmed, with the title and folder in the sentence.
    r.radarr.items.push(newFilm(18, 'Harrow Lane Haunting', ['Horror'], [], '2026-11-18T12:00:30Z'))
    r.at(NOW + 60_000)
    await r.svc.tick()
    await a.inject({ method: 'GET', url: '/api/plugins/arrstack/router', headers: { cookie: adm.cookie } })
    const mv = { app: 'radarr', id: 18, folder: `${F}Main Films` }
    const askMove = await a.inject({ method: 'POST', url: '/api/plugins/arrstack/router/move', headers: { cookie: adm.cookie }, payload: mv })
    assert.equal(JSON.parse(askMove.body).confirm.summary, 'Move Harrow Lane Haunting (2026) to Main Films? Its files move with it.')
    const moved = await injectConfirmed(a, { method: 'POST', url: '/api/plugins/arrstack/router/move', headers: { cookie: adm.cookie }, payload: mv })
    assert.equal(moved.statusCode, 200, moved.body)
    assert.equal((await injectConfirmed(a, { method: 'POST', url: '/api/plugins/arrstack/router/move', headers: { cookie: adm.cookie }, payload: { app: 'radarr', id: 'x', folder: 'y' } })).statusCode, 400)
    const prev = await a.inject({ method: 'POST', url: '/api/plugins/arrstack/router/graduate/preview', headers: { cookie: adm.cookie }, payload: {} })
    assert.equal(prev.statusCode, 200, prev.body)
    const askGrad = await a.inject({ method: 'POST', url: '/api/plugins/arrstack/router/graduate', headers: { cookie: adm.cookie }, payload: { previewId: JSON.parse(prev.body).data.previewId } })
    assert.match(JSON.parse(askGrad.body).confirm.summary, /^Move 1 finished show to Finished Runs\?/)
  } finally { await a.close() }
})

// ── "Sort my library" ────────────────────────────────────────────────────────

const ADMIN = 'admin@example.com'

test('library plan: everything the saved rules would move, grouped from → to by rule; never out of or into a hand-picked folder', () => {
  const films = fx('radarr-movies.json').map(filmOf)
  const plan = libraryPlan('radarr', filmSettings(), films)
  assert.deepEqual(plan.map(g => [groupWord(g), g.count, g.items.map(i => i.title)]), [
    ['Animated, for families in Kids Live Action → Kids Cartoons', 1, ['Velvet Jungle']],
    ['Horror in Main Films → Frights', 1, ['Signal Lost']],
    ['Live-action family in Main Films → Kids Live Action', 1, ['The Clockwork Orphan']],
  ])
  assert.equal(plan[1].items[0].detail, 'genre Horror')
  assert.ok(!plan.some(g => g.items.some(i => i.title === 'Night Train Overture')), 'nothing comes out of the hand-picked folder')
  // A rule pointing INTO a hand-picked folder (only possible in stored data from before the check): never proposed.
  const into = filmSettings({ rules: filmSettings().rules.map(x => (x.condition === 'horror' ? { ...x, folder: `${F}Cinema Picks` } : x)) })
  const p2 = libraryPlan('radarr', into, films)
  assert.ok(!p2.some(g => g.to === `${F}Cinema Picks`))
  // The hand-picked folder's own films stay out even when another rule would fit them.
  const night = films.find((f: Film) => f.title === 'Night Train Overture')!
  assert.deepEqual(libraryPlan('radarr', filmSettings(), [{ ...night, genres: ['Horror'] }]), [])
  // Undone by hand: never proposed again.
  assert.ok(!libraryPlan('radarr', filmSettings(), films, new Set([14])).some(g => g.items.some(i => i.id === 14)))
  // Shows: ended ones still in the running folder are a group like any other, each with its episodes.
  const shows = fx('sonarr-series.json').map(showOf)
  const sp = libraryPlan('sonarr', defaultSettings('sonarr', SHOW_ROOTS, `${T}On Air`), shows)
  assert.deepEqual(sp.map(g => [groupWord(g), g.items.map(i => [i.title, i.episodes])]), [
    ['Ended in On Air → Finished Runs', [['Half Built', { files: 5, aired: 10 }], ['Tidewater', { files: 20, aired: 20 }]]],
  ])
})

async function libRig(over: Partial<RouterDeps> = {}) {
  const r = rig(over)
  const s = (await r.svc.status()).apps.find(a => a.app === 'radarr')!.settings!
  await r.svc.saveSettings('radarr', s, undefined, ADMIN)
  return r
}

test('library preview: needs saved rules, is read-only, single-use, 15 minutes, and belongs to the person who asked', async () => {
  const bare = rig()
  await assert.rejects(bare.svc.libraryPreview('radarr', ADMIN), (e: any) => e.code === 'no_rules')
  const r = await libRig()
  const p = await r.svc.libraryPreview('radarr', ADMIN)
  assert.equal(p.total, 3); assert.equal(p.groups.length, 3)
  assert.equal(p.groups[1].word, 'Horror in Main Films → Frights')
  assert.deepEqual(r.radarr.writes(), [], 'read-only')
  assert.deepEqual(r.svc.libraryNames(p.previewId, [14, 10]), { count: 2, groups: ['Horror in Main Films → Frights (1)', 'Live-action family in Main Films → Kids Live Action (1)'] })
  await assert.rejects(r.svc.libraryApply(p.previewId, [14], 'someone-else@example.com'), (e: any) => e.code === 'preview_required', 'another person cannot use it')
  await assert.rejects(r.svc.libraryApply(p.previewId, [14, 11], ADMIN), (e: any) => e.code === 'bad_request', 'only items from the preview')
  await assert.rejects(r.svc.libraryApply(p.previewId, [], ADMIN), (e: any) => e.code === 'bad_request')
  const old = await r.svc.libraryPreview('radarr', ADMIN)
  r.at(NOW + 16 * 60_000)
  await assert.rejects(r.svc.libraryApply(old.previewId, [14], ADMIN), (e: any) => e.code === 'preview_required', 'too old')
  r.at(NOW)
  await r.svc.libraryApply(p.previewId, [14], ADMIN)
  await assert.rejects(r.svc.libraryApply(p.previewId, [10], ADMIN), (e: any) => e.code === 'preview_required', 'used once')
})

test('library apply: audited first, moves exactly the ticked items, each checked again at move time; Recently sorted can undo', async () => {
  const r = await libRig()
  const p = await r.svc.libraryPreview('radarr', ADMIN)
  // Moved by someone else after the preview: no longer where the preview saw it.
  const orphan = r.radarr.items.find(i => i.id === 15)
  orphan.rootFolderPath = `${F}Main Films`; orphan.path = `${F}Main Films/Velvet Jungle (2026)`
  const job = await r.svc.libraryApply(p.previewId, [14, 15], ADMIN)
  assert.equal(job.state, 'done'); assert.equal(job.total, 2); assert.equal(job.moved, 1); assert.equal(job.skipped, 1)
  assert.equal(r.radarr.items.find(i => i.id === 14).rootFolderPath, `${F}Frights`)
  assert.equal(r.radarr.items.find(i => i.id === 10).rootFolderPath, `${F}Main Films`, 'not ticked, not moved')
  assert.equal(r.radarr.items.find(i => i.id === 15).rootFolderPath, `${F}Main Films`, 'checked again: skipped')
  const iLib = r.audits.findIndex(a => a.action === 'arrstack.router.library')
  const iMove = r.audits.findIndex(a => a.action === 'arrstack.router.move')
  assert.ok(iLib >= 0 && iLib < iMove, 'the library sort is audited before the first move')
  assert.equal(r.audits[iLib].details.count, 2)
  assert.deepEqual(await r.svc.recent(), [], 'library moves have their own list: they never push request moves out')
  const rec = await r.svc.recentLibrary()
  assert.equal(rec[0].kind, 'library'); assert.equal(rec[0].why, 'Horror → Frights'); assert.equal(rec[0].files, 'moved')
  const back = await r.svc.move('radarr', 14, `${F}Main Films`, ADMIN)
  assert.equal(back.ok, true)
  assert.ok(!(await r.svc.libraryPreview('radarr', ADMIN)).groups.some(g => g.items.some(i => i.id === 14)), 'undone by hand: not proposed again')
  // No audit row: nothing queued, nothing moved.
  const r2 = await libRig({ audit: async a => { if (a === 'arrstack.router.library') throw new Error('audit log down') } })
  const p2 = await r2.svc.libraryPreview('radarr', ADMIN)
  await assert.rejects(r2.svc.libraryApply(p2.previewId, [14], ADMIN))
  assert.equal(await r2.svc.libraryJob('radarr'), null)
  assert.equal(r2.radarr.writes().filter(w => w.startsWith('PUT')).length, 0)
})

test('library apply: 20 now, the rest 20 a minute, carried on after a restart; then Plex is asked to rescan once', async () => {
  const plexCalls: string[] = []
  const plex: Partial<CoreEndpointClient> = {
    async get(p: string) { plexCalls.push(`GET ${p}`); return { MediaContainer: { Directory: [{ key: '3', type: 'movie' }, { key: '4', type: 'show' }] } } },
    async trigger(p: string) { plexCalls.push(`TRIGGER ${p}`) },
  }
  const r = await libRig({ mediaServer: async () => plex as CoreEndpointClient })
  for (let i = 0; i < 25; i++) r.radarr.items.push(newFilm(300 + i, `Old Fright ${i}`, ['Horror'], [], '2026-09-01T10:00:00Z'))
  const p = await r.svc.libraryPreview('radarr', ADMIN)
  const horror = p.groups.find(g => g.word === 'Horror in Main Films → Frights')!
  assert.equal(horror.count, 26)
  const job = await r.svc.libraryApply(p.previewId, horror.items.map(i => i.id), ADMIN)
  assert.equal(job.moved, 20); assert.equal(job.remaining, 6); assert.equal(job.state, 'running')
  assert.equal((await r.svc.status()).apps.find(a => a.app === 'radarr')!.library!.remaining, 6, 'progress on the page')
  // A restart: a new service on the same database carries on.
  const again = new RouterService({ clients: { radarr: async () => r.radarr, sonarr: async () => r.sonarr }, store: r.store,
    audit: async () => {}, now: () => NOW + 60_000, unlocked: () => true, sleep: async () => {}, mediaServer: async () => plex as CoreEndpointClient })
  await again.tick()
  const end = (await again.libraryJob('radarr'))!
  assert.equal(end.state, 'done'); assert.equal(end.moved, 26); assert.equal(end.queue.length, 0)
  assert.equal(r.radarr.items.filter(i => i.rootFolderPath === `${F}Frights`).length, 27)
  assert.deepEqual(plexCalls, ['GET /library/sections', 'TRIGGER /library/sections/3/refresh'], 'only the film libraries, once')
  assert.match(end.rescan!, /rescan 1 library/)
  await again.tick()
  assert.equal(plexCalls.length, 2, 'not again')
})

test('library sort: stop leaves the rest where it is; one sort at a time per app; items being imported wait', async () => {
  const r = await libRig()
  for (let i = 0; i < 25; i++) r.radarr.items.push(newFilm(300 + i, `Old Fright ${i}`, ['Horror'], [], '2026-09-01T10:00:00Z'))
  const p = await r.svc.libraryPreview('radarr', ADMIN)
  const ids = p.groups.find(g => g.word === 'Horror in Main Films → Frights')!.items.map(i => i.id)
  r.radarr.queue = [{ movieId: ids[0], trackedDownloadState: 'importing' }]
  const job = await r.svc.libraryApply(p.previewId, ids, ADMIN)
  assert.equal(job.moved, 20); assert.equal(job.remaining, 6, 'the one being imported waits at the back')
  assert.equal(r.radarr.items.find(i => i.id === ids[0]).rootFolderPath, `${F}Main Films`)
  const p2 = await r.svc.libraryPreview('radarr', ADMIN)
  await assert.rejects(r.svc.libraryApply(p2.previewId, [p2.groups[0].items[0].id], ADMIN), (e: any) => e.code === 'busy')
  const stopped = await r.svc.libraryStop('radarr', ADMIN)
  assert.equal(stopped.state, 'stopped'); assert.equal(stopped.stoppedBy, ADMIN)
  assert.ok(r.audits.some(a => a.action === 'arrstack.router.library.stop'))
  const before = r.radarr.writes().length
  r.at(NOW + 60_000)
  await r.svc.tick()
  assert.equal(r.radarr.writes().length, before, 'nothing more moves')
  await assert.rejects(r.svc.libraryStop('radarr', ADMIN), (e: any) => e.code === 'not_running')
})

test('library routes: preview admin-only and unconfirmed; apply and stop confirmed with the count and groups; never a token', async () => {
  for (const p of ['library/apply', 'library/stop']) assert.equal(needsConfirm('POST', `/api/plugins/arrstack/router/${p}`), true, p)
  assert.equal(needsConfirm('POST', '/api/plugins/arrstack/router/library/preview'), false)
  for (const p of ['library/preview', 'library/apply', 'library/stop']) {
    assert.equal(requiredRole('POST', `/api/plugins/arrstack/router/${p}`), 'admin')
    assert.equal(tokenForbidden('POST', `/api/plugins/arrstack/router/${p}`), true)
    assert.equal(needsPassword('POST', `/api/plugins/arrstack/router/${p}`), false)
  }
  const r = await libRig()
  const a = Fastify({ logger: false })
  await registerGate(a)
  await a.register(authRoutes, { prefix: '/api/auth' })
  await a.register(buildArrRouterRoutes({ service: () => r.svc, limiter: new MissLimiter(100), testLimiter: new MissLimiter(100) }), { prefix: '/api/plugins/arrstack' })
  await a.ready()
  try {
    const viewer = await signIn(a, 'viewer@example.com', 'viewer master password')
    assert.equal((await a.inject({ method: 'POST', url: '/api/plugins/arrstack/router/library/preview', headers: { cookie: viewer.cookie }, payload: { app: 'radarr' } })).statusCode, 403)
    const tok = (await createApiToken({ name: 'bot2', role: 'admin' }, 'test', tokens)).token
    const tp = await a.inject({ method: 'POST', url: '/api/plugins/arrstack/router/library/preview', headers: { authorization: `Bearer ${tok}` }, payload: { app: 'radarr' } })
    assert.equal(JSON.parse(tp.body).code, 'token_forbidden')
    const adm = await signIn(a, ADMIN, 'admin master password')
    const pv = await a.inject({ method: 'POST', url: '/api/plugins/arrstack/router/library/preview', headers: { cookie: adm.cookie }, payload: { app: 'radarr' } })
    assert.equal(pv.statusCode, 200, pv.body)
    const previewId = JSON.parse(pv.body).data.previewId
    const payload = { previewId, ids: [14, 10] }
    const ask = await a.inject({ method: 'POST', url: '/api/plugins/arrstack/router/library/apply', headers: { cookie: adm.cookie }, payload })
    assert.equal(JSON.parse(ask.body).code, 'confirm_required')
    assert.equal(JSON.parse(ask.body).confirm.summary, 'Move 2 items in your library into the folders your rules pick? Horror in Main Films → Frights (1); Live-action family in Main Films → Kids Live Action (1). Their files move with them, 20 a minute.')
    assert.deepEqual(r.radarr.writes(), [], 'nothing before the confirmation')
    const done = await injectConfirmed(a, { method: 'POST', url: '/api/plugins/arrstack/router/library/apply', headers: { cookie: adm.cookie }, payload })
    assert.equal(done.statusCode, 200, done.body); assert.equal(JSON.parse(done.body).data.moved, 2)
    const stopAsk = await a.inject({ method: 'POST', url: '/api/plugins/arrstack/router/library/stop', headers: { cookie: adm.cookie }, payload: { app: 'radarr' } })
    assert.match(JSON.parse(stopAsk.body).confirm.summary, /^Stop sorting the films in your library\? It stops before the next move/)
    assert.equal(needsConfirm('POST', '/api/plugins/arrstack/router/library/undo'), true)
    assert.equal(tokenForbidden('POST', '/api/plugins/arrstack/router/library/undo'), true)
    const undoAsk = await a.inject({ method: 'POST', url: '/api/plugins/arrstack/router/library/undo', headers: { cookie: adm.cookie }, payload: { app: 'radarr' } })
    assert.equal(JSON.parse(undoAsk.body).confirm.summary, 'Undo the last library sort of your films? The 2 items it moved go back where they were, 20 a minute, each only if it is still where the sort put it.')
    const undone = await injectConfirmed(a, { method: 'POST', url: '/api/plugins/arrstack/router/library/undo', headers: { cookie: adm.cookie }, payload: { app: 'radarr' } })
    assert.equal(undone.statusCode, 200, undone.body); assert.equal(JSON.parse(undone.body).data.moved, 2)
    const vs = await a.inject({ method: 'GET', url: '/api/plugins/arrstack/router', headers: { cookie: viewer.cookie } })
    assert.doesNotMatch(vs.body, /admin@example\.com/, 'a viewer sees no emails')
  } finally { await a.close() }
})

test('library plan: a folder no enabled rule fills is left alone, like a hand-picked one (forgetting Hand-picked cannot empty it)', async () => {
  const films = fx('radarr-movies.json').map(filmOf)
  // No hand-picked rule at all: the picks folder is filled by no rule, so its film stays.
  const noHand = filmSettings({ rules: filmSettings().rules.map(x => (x.condition === 'curated' ? { ...x, folder: null, enabled: false } : x)) })
  const plan = libraryPlan('radarr', noHand, films)
  assert.ok(!plan.some(g => g.from === `${F}Cinema Picks`), 'nothing out of a folder no rule fills')
  assert.deepEqual(leftAloneFolders(noHand, films), [{ folder: `${F}Cinema Picks`, count: 1 }])
  // A genre rule switched off: its folder is no longer filled, so nothing leaves it either.
  const noHorror = filmSettings({ rules: filmSettings().rules.map(x => (x.condition === 'horror' ? { ...x, enabled: false } : x)) })
  assert.ok(!libraryPlan('radarr', noHorror, films).some(g => g.from === `${F}Frights`))
  assert.deepEqual(leftAloneFolders(noHorror, films), [{ folder: `${F}Frights`, count: 1 }])
  assert.deepEqual(leftAloneFolders(filmSettings(), films), [], 'hand-picked folders are not listed here')
  // The preview lists them; applying re-checks it at move time.
  const r = rig()
  await r.svc.saveSettings('radarr', noHorror, undefined, ADMIN)
  const p = await r.svc.libraryPreview('radarr', ADMIN)
  assert.deepEqual(p.leftAlone, [{ folder: `${F}Frights`, count: 1 }])
  const ids = p.groups.find(g => g.from === `${F}Main Films` && g.to === `${F}Kids Live Action`)!.items.map(i => i.id)
  const all = (await r.svc.status()).apps.find(a => a.app === 'radarr')!.settings!
  await r.svc.saveSettings('radarr', { ...all, rules: all.rules.map(x => (x.condition === 'default' ? { ...x, enabled: false } : x)) }, undefined, ADMIN)
  const job = await r.svc.libraryApply(p.previewId, ids, ADMIN)
  assert.equal(job.skipped, 1, 'its folder is no longer filled by any rule: skipped at move time')
  assert.equal(r.radarr.items.find(i => i.id === 10).rootFolderPath, `${F}Main Films`)
})

// ── "Sort my library": review notes ──────────────────────────────────────────

const oldFrights = (r: ReturnType<typeof rig>, n: number, base = 300, hasFile = false) => {
  for (let i = 0; i < n; i++) r.radarr.items.push(newFilm(base + i, `Old Fright ${base + i}`, ['Horror'], [], '2026-09-01T10:00:00Z', `${F}Main Films`, hasFile))
}
const horrorIds = async (r: ReturnType<typeof rig>) => {
  const p = await r.svc.libraryPreview('radarr', ADMIN)
  return { p, ids: p.groups.find(g => g.word === 'Horror in Main Films → Frights')!.items.map(i => i.id) }
}

test('undo this sort: audited, moves back each item still where the sort put it, never proposed again; not twice', async () => {
  const r = await libRig()
  const { p } = await horrorIds(r)
  await r.svc.libraryApply(p.previewId, [14, 10], ADMIN)
  assert.equal((await r.svc.status()).apps.find(a => a.app === 'radarr')!.library!.canUndo, 2)
  assert.deepEqual(r.svc.libraryUndoNames('radarr'), { count: 2 })
  // One of them was moved again since: it is not where the sort put it, so it stays.
  const moved = r.radarr.items.find(i => i.id === 10)
  moved.rootFolderPath = `${F}Docs`; moved.path = `${F}Docs/The Clockwork Orphan (2015)`
  const undo = await r.svc.libraryUndo('radarr', ADMIN)
  assert.equal(undo.kind, 'undo'); assert.equal(undo.state, 'done'); assert.equal(undo.moved, 1); assert.equal(undo.skipped, 1)
  assert.equal(r.radarr.items.find(i => i.id === 14).rootFolderPath, `${F}Main Films`, 'back where it was')
  assert.equal(r.radarr.items.find(i => i.id === 10).rootFolderPath, `${F}Docs`)
  const iUndo = r.audits.findIndex(a => a.action === 'arrstack.router.library.undo')
  assert.ok(iUndo >= 0 && iUndo < r.audits.map(a => a.action).lastIndexOf('arrstack.router.move'))
  assert.equal((await r.svc.recentLibrary())[0].why, 'Undo → Main Films')
  assert.ok(!(await r.svc.libraryPreview('radarr', ADMIN)).groups.some(g => g.items.some(i => i.id === 14)), 'undone: not proposed again')
  await assert.rejects(r.svc.libraryUndo('radarr', ADMIN), (e: any) => e.code === 'nothing_to_undo')
})

test('Plex rescans only once no file move of the sort is still running, or after 30 minutes anyway', async () => {
  const calls: string[] = []
  const plex: Partial<CoreEndpointClient> = {
    async get() { return { MediaContainer: { Directory: [{ key: '3', type: 'movie' }] } } },
    async trigger(p: string) { calls.push(p) },
  }
  const r = await libRig({ mediaServer: async () => plex as CoreEndpointClient })
  oldFrights(r, 2, 300, true)
  r.radarr.commandStatus = 'started'
  const { p, ids } = await horrorIds(r)
  const job = await r.svc.libraryApply(p.previewId, ids, ADMIN)
  assert.equal(job.state, 'done'); assert.equal(job.rescanPending, true); assert.deepEqual(calls, [], 'files still moving: no rescan yet')
  r.radarr.commands.forEach(c => { c.status = 'completed' })
  r.at(NOW + 60_000)
  await r.svc.tick()
  assert.deepEqual(calls, ['/library/sections/3/refresh'])
  assert.equal((await r.svc.libraryJob('radarr'))!.rescanPending, false)
  // A file move that never finishes: rescan anyway after 30 minutes, and say so.
  const r2 = await libRig({ mediaServer: async () => plex as CoreEndpointClient })
  oldFrights(r2, 1, 300, true)
  r2.radarr.commandStatus = 'started'
  const h2 = await horrorIds(r2)
  await r2.svc.libraryApply(h2.p.previewId, [h2.ids.find(x => x >= 300)!], ADMIN)
  calls.length = 0
  r2.at(NOW + 10 * 60_000); await r2.svc.tick()
  assert.deepEqual(calls, [])
  r2.at(NOW + 31 * 60_000); await r2.svc.tick()
  assert.deepEqual(calls, ['/library/sections/3/refresh'])
  assert.match((await r2.svc.libraryJob('radarr'))!.rescan!, /1 file move was still running after 30 minutes/)
})

test('Stop takes effect between moves, without waiting for the batch', async () => {
  const r = await libRig()
  oldFrights(r, 10)
  const { p, ids } = await horrorIds(r)
  let puts = 0, stopAnswer: any = null
  r.radarr.onPut = async () => {
    puts++
    if (puts === 3) stopAnswer = await r.svc.libraryStop('radarr', ADMIN)   // returns at once: the batch holds the lock
  }
  const job = await r.svc.libraryApply(p.previewId, ids, ADMIN)
  assert.equal(stopAnswer.state, 'stopped')
  assert.equal(job.state, 'stopped'); assert.equal(job.moved, 3, 'the move under way finished; nothing after it')
  assert.equal(job.stoppedBy, ADMIN); assert.equal(job.remaining, ids.length - 3)
  assert.equal((await r.svc.libraryJob('radarr'))!.state, 'stopped')
})

test('a library sort looks at no more than 60 items a minute, skips included, and shares the minute\'s 20 moves', async () => {
  const r = await libRig()
  oldFrights(r, 70)
  const { p, ids } = await horrorIds(r)
  // All of them moved elsewhere since the preview: every one is a skip.
  for (const it of r.radarr.items) if (it.id >= 300) { it.rootFolderPath = `${F}Docs`; it.path = `${F}Docs/${it.title}` }
  const job = await r.svc.libraryApply(p.previewId, ids, ADMIN)
  assert.equal(job.skipped, MAX_EXAMINED_PER_TICK); assert.equal(job.remaining, ids.length - MAX_EXAMINED_PER_TICK); assert.equal(job.state, 'running')
  // Shared budget: new requests already used 15 of this minute's moves, so a sort started now moves 5.
  const r2 = rig()
  await switchOn(r2)
  for (let i = 0; i < 15; i++) r2.radarr.items.push(newFilm(100 + i, `Fresh Fright ${i}`, ['Horror'], [], '2026-11-18T12:00:40Z'))
  oldFrights(r2, 10)
  r2.at(NOW + 60_000)
  await r2.svc.tick()
  assert.equal(r2.radarr.writes().filter(w => w.startsWith('PUT')).length, 15)
  const h = await horrorIds(r2)
  const j2 = await r2.svc.libraryApply(h.p.previewId, h.ids, ADMIN)
  assert.equal(j2.moved, 5); assert.equal(j2.remaining, h.ids.length - 5)
})

test('an item whose move errors three times is marked failed, and the sort goes on', async () => {
  const r = await libRig()
  oldFrights(r, 1)
  const { p, ids } = await horrorIds(r)
  const bad = ids.find(x => x >= 300)!
  r.radarr.onPut = () => { if (r.radarr.calls.at(-1)!.includes(`[${bad}]`)) throw new Error('radarr returned HTTP 500') }
  let job = await r.svc.libraryApply(p.previewId, ids, ADMIN)
  assert.equal(job.failed, 0); assert.equal(job.remaining, 1, 'tried again later')
  r.at(NOW + 60_000); await r.svc.tick()
  r.at(NOW + 120_000); await r.svc.tick()
  job = (await r.svc.status()).apps.find(a => a.app === 'radarr')!.library!
  assert.equal(job.failed, 1); assert.equal(job.state, 'done'); assert.equal(job.moved, ids.length - 1)
})

test('library preview leaves out graduated shows; the names need a live preview of the same person; viewers see no emails', async () => {
  const r = rig()
  const s = (await r.svc.status()).apps.find(a => a.app === 'sonarr')!.settings!
  await r.svc.saveSettings('sonarr', s, undefined, ADMIN)
  await r.store.set('state:sonarr', { graduated: [6] }, 'test')
  const p = await r.svc.libraryPreview('sonarr', ADMIN)
  assert.deepEqual(p.groups.flatMap(g => g.items.map(i => i.title)), ['Tidewater'], 'a show graduated once (then moved back) is not proposed')
  assert.ok(r.svc.libraryNames(p.previewId, [5], ADMIN))
  assert.equal(r.svc.libraryNames(p.previewId, [5], 'someone-else@example.com'), null, 'another person\'s preview names nothing')
  r.at(NOW + 16 * 60_000)
  assert.equal(r.svc.libraryNames(p.previewId, [5], ADMIN), null, 'an expired preview names nothing')
  r.at(NOW)
  const r2 = await libRig()
  const h = await horrorIds(r2)
  await r2.svc.libraryApply(h.p.previewId, [14], ADMIN)
  const asViewer = await r2.svc.status(false)
  assert.equal(asViewer.recentLibrary[0].by, 'an admin')
  assert.equal(asViewer.apps.find(a => a.app === 'radarr')!.library!.by, 'an admin')
  assert.equal((await r2.svc.status(true)).recentLibrary[0].by, ADMIN)
})
