// Plex clear-out: play matching (ratingKey and title), keep rules (prefix edge cases included), the never/idle
// cut-offs, and the removal routes behind the real vault gate: operator role, master password re-entered, no API
// tokens, removal only through the Arr with deleteFiles and an exclusion, and a read-back after each delete.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { buildPlexClearoutRoutes, newWatcherDeps } from '../src/routes/plex-clearout'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { setAuditSink } from '../src/lib/audit'
import { MemoryApiTokenStore, setApiTokenStore, createApiToken } from '../src/lib/api-tokens'
import { requiredRole, needsReconfirm } from '../src/lib/roles'
import {
  DEFAULT_RULES, buildReport, classify, indexPlays, keptBy, monthsAgo, nameMatches, normTitle, parseRules, playsFor,
  type LibItem, type PlayRow,
} from '../src/lib/plex-clearout/logic'
import { ClearoutService } from '../src/lib/plex-clearout/service'
import type { CoreEndpointClient } from '../src/lib/plugin-host'
import { clearoutLines } from '../src/lib/ai/plex-clearout-source'
import { ArtCache, MissLimiter, artKey, artRef, artUpstream } from '../src/lib/plex-art'
import { liveFromPlex } from '../src/plugins/plex'
import { FakeBroker } from './fakes/fake-broker'
import { signIn } from './fakes/app'

const NOW = Date.UTC(2026, 5, 15)
const DAY = 86_400_000
const s = (ms: number) => Math.floor(ms / 1000)

function item(over: Partial<LibItem>): LibItem {
  return {
    kind: 'movie', ratingKey: '1', title: 'Untitled', year: 2015, addedAt: NOW - 400 * DAY, section: '1', sectionTitle: 'Films',
    sizeBytes: 1e9, genres: [], path: '/media/films/Untitled', seriesType: null, arr: null, ...over,
  }
}
const play = (over: Partial<PlayRow>): PlayRow => ({ ratingKey: '1', type: 'movie', title: 'Untitled', viewedAt: s(NOW - 10 * DAY), accountID: 1, ...over })

// ── play matching ────────────────────────────────────────────────────────────

test('normTitle: case, punctuation, a leading article and a trailing year do not matter', () => {
  assert.equal(normTitle('The Glass Orchard (2019)'), normTitle('glass orchard'))
  assert.equal(normTitle('Comet & Kite: Part II'), 'comet and kite part ii')
  assert.equal(normTitle('Élan Vital'), 'elan vital')
})

test('an episode counts towards its show by grandparentKey; a movie by its own ratingKey', () => {
  const idx = indexPlays([
    play({ ratingKey: '501', type: 'episode', grandparentKey: '/library/metadata/77', title: 'Pilot', grandparentTitle: 'Harbour Lights', accountID: 1 }),
    play({ ratingKey: '502', type: 'episode', grandparentKey: '/library/metadata/77', title: 'Second', grandparentTitle: 'Harbour Lights', accountID: 2 }),
    play({ ratingKey: '9', title: 'Paper Moons', accountID: 1 }),
  ])
  assert.deepEqual({ ...playsFor(idx, { ratingKey: '77', title: 'Harbour Lights' }), lastPlayed: null }, { plays: 2, viewers: 2, lastPlayed: null })
  assert.equal(playsFor(idx, { ratingKey: '9', title: 'Paper Moons' }).plays, 1)
  assert.equal(playsFor(idx, { ratingKey: '501', title: 'Pilot' }).plays, 0, 'an episode is not a show')
})

test('a re-download (new ratingKey) still finds its old plays by title, and a play is never counted twice', () => {
  const idx = indexPlays([
    play({ ratingKey: '10', title: 'Paper Moons', viewedAt: s(NOW - 300 * DAY) }),
    play({ ratingKey: '44', title: 'Paper Moons', viewedAt: s(NOW - 20 * DAY), accountID: 3 }),
  ])
  const st = playsFor(idx, { ratingKey: '44', title: 'Paper Moons' })
  assert.equal(st.plays, 2, 'the old key by title, the new one by key and title, once each')
  assert.equal(st.viewers, 2)
  assert.equal(st.lastPlayed, s(NOW - 20 * DAY) * 1000)
  // Renamed in Plex after the play: still found by ratingKey.
  assert.equal(playsFor(idx, { ratingKey: '10', title: 'Paper Moons (Director’s Cut)' }).plays, 1)
  assert.equal(indexPlays([]).since, null)
  assert.equal(idx.since, s(NOW - 300 * DAY) * 1000, 'the history goes back to the oldest play')
})

// ── keep rules ───────────────────────────────────────────────────────────────

test('keep names match by whole-word prefix; short names must match the whole title', () => {
  assert.equal(nameMatches('Night Desk', 'Night Desk: Harbour'), true)
  assert.equal(nameMatches('Night Desk', 'Night Desk'), true)
  assert.equal(nameMatches('Night Desk', 'Night Deskwork'), false, 'not mid-word')
  assert.equal(nameMatches('Night Desk', 'The Night Desk'), true, 'a leading article is ignored')
  assert.equal(nameMatches('Up', 'Up'), true)
  assert.equal(nameMatches('Up', 'Up in the Rafters'), false, 'a two-letter name does not keep every title starting with it')
  assert.equal(nameMatches('Owl', 'Owl House Rules'), false)
  assert.equal(nameMatches('Owls', 'Owls of the Fen'), true, 'four letters is a prefix')
  assert.equal(nameMatches('', 'Anything'), false)
})

test('each keep rule, in order, and only where it applies', () => {
  const r = { ...DEFAULT_RULES, folders: ['/media/curated/'], names: ['Night Desk'] }
  assert.equal(keptBy(item({ year: 1987 }), r, NOW), 'beforeYear')
  assert.equal(keptBy(item({ year: 2000 }), r, NOW), null, 'the cut-off year itself is not before it')
  assert.equal(keptBy(item({ kind: 'show', seriesType: 'anime' }), r, NOW), 'anime')
  assert.equal(keptBy(item({ kind: 'movie', seriesType: 'anime' }), r, NOW), null, 'anime is a series type')
  assert.equal(keptBy(item({ path: '/media/TV Complete Series/Some Show' }), r, NOW), 'folderPattern')
  assert.equal(keptBy(item({ path: '/media/curated/Paper Moons' }), r, NOW), 'folders')
  assert.equal(keptBy(item({ path: '/media/curated-not/Paper Moons' }), r, NOW), null, 'a folder is a path prefix, not a string prefix')
  assert.equal(keptBy(item({ genres: ['science fiction'] }), r, NOW), 'genres')
  assert.equal(keptBy(item({ title: 'Night Desk: Harbour' }), r, NOW), 'names')
  assert.equal(keptBy(item({ addedAt: NOW - 30 * DAY }), r, NOW), 'recent')
  assert.equal(keptBy(item({}), r, NOW), null)
})

test('parseRules: blank is the default, "none" turns a rule off, numbers are clamped', () => {
  const d = parseRules(() => undefined)
  assert.deepEqual(d.rules, DEFAULT_RULES)
  assert.deepEqual(d.cutoffs, { neverMinMonths: 6, idleMonths: 6 })
  const o: Record<string, string> = { keep_before_year: 'none', keep_anime: 'no', keep_folder_pattern: 'off', keep_genres: 'none',
    keep_names: 'Night Desk, Owls ,', keep_added_days: '0', never_min_months: '12', idle_months: '-4' }
  const p = parseRules(k => o[k])
  assert.equal(p.rules.beforeYear, null)
  assert.equal(p.rules.anime, false)
  assert.equal(p.rules.folderPattern, null)
  assert.deepEqual(p.rules.genres, [])
  assert.deepEqual(p.rules.names, ['Night Desk', 'Owls'])
  assert.equal(p.rules.recentDays, 0)
  assert.deepEqual(p.cutoffs, { neverMinMonths: 12, idleMonths: 1 })
})

// ── cut-offs ─────────────────────────────────────────────────────────────────

test('never watched needs the minimum age; idle needs a play older than N months', () => {
  const c = { neverMinMonths: 6, idleMonths: 6 }
  const sixMonths = monthsAgo(NOW, 6)
  assert.equal(new Date(sixMonths).toISOString().slice(0, 10), '2025-12-15')
  assert.equal(new Date(monthsAgo(Date.UTC(2026, 2, 31), 1)).toISOString().slice(0, 10), '2026-02-28', 'the 31st falls back to the month end')
  const none = { plays: 0, viewers: 0, lastPlayed: null }
  assert.equal(classify(none, sixMonths, NOW, c), 'never', 'exactly at the cut-off counts')
  assert.equal(classify(none, sixMonths + 1, NOW, c), null, 'too new to judge')
  assert.equal(classify(none, 0, NOW, c), null, 'no addedAt: not judged')
  assert.equal(classify({ plays: 3, viewers: 1, lastPlayed: sixMonths - 1 }, NOW - 900 * DAY, NOW, c), 'idle')
  assert.equal(classify({ plays: 3, viewers: 1, lastPlayed: sixMonths }, NOW - 900 * DAY, NOW, c), null, 'played at the cut-off is not idle')
})

test('buildReport: lists, kept counts, unwatched share, largest first', () => {
  const r = buildReport({
    now: NOW, rules: { ...DEFAULT_RULES, recentDays: 0 }, cutoffs: { neverMinMonths: 6, idleMonths: 6 },
    sections: [{ key: '1', title: 'Films', kind: 'movie' }], arr: { sonarr: false, radarr: true }, sizesFrom: { tv: 'plex', movies: 'arr' },
    items: [
      item({ ratingKey: '1', title: 'Paper Moons', sizeBytes: 2e9, arr: { service: 'radarr', id: 5 } }),
      item({ ratingKey: '2', title: 'Glass Orchard', sizeBytes: 9e9 }),
      item({ ratingKey: '3', title: 'Old Lantern', year: 1974 }),
      item({ ratingKey: '4', title: 'Comet Kite' }),
    ],
    plays: [play({ ratingKey: '4', title: 'Comet Kite', viewedAt: s(NOW - 10 * DAY) })],
  })
  assert.deepEqual(r.rows.map(x => x.title), ['Glass Orchard', 'Paper Moons'])
  assert.equal(r.rows[1].via, 'radarr', 'managed by Radarr (by id)')
  assert.equal(r.rows[0].via, 'plex', 'no Arr: removed through Plex itself')
  assert.deepEqual(r.kept, [{ rule: 'beforeYear', label: 'Released before the cut-off year', tv: 0, movies: 1 }])
  assert.equal(r.totals.movies.items, 4)
  assert.equal(r.totals.movies.unwatched, 3)
  assert.equal(r.totals.movies.unwatchedShare, 75)
  assert.equal(r.totals.movies.listBytes, 11e9)
  assert.ok(clearoutLines(r).some(l => /Movies: 4 in Plex, 3 \(75%\) never played/.test(l)))
})

// ── the service and its routes ──────────────────────────────────────────────

/** A Plex and a Radarr that answer from memory; the Radarr records every delete. */
function fakes() {
  const movies = new Map<number, any>([[5, { id: 5, title: 'Paper Moons', year: 2015, tmdbId: 111, path: '/media/films/Paper Moons', sizeOnDisk: 2e9, genres: [] }]])
  const deletes: string[] = []
  const plexDeletes: string[] = []
  const gonePlex = new Set<string>()
  const state = { allow: true, streaming: [] as any[] }
  const plex: CoreEndpointClient = {
    async get(p) {
      if (p === '/status/sessions') return { MediaContainer: { Metadata: state.streaming } }
      if (p === '/:/prefs') return { MediaContainer: { Setting: [{ id: 'allowMediaDeletion', value: state.allow }] } }
      if (p === '/accounts') return { MediaContainer: { Account: [{ id: 1, name: 'alex' }] } }
      const md = /^\/library\/metadata\/(\d+)$/.exec(p)
      if (md) { if (gonePlex.has(md[1])) throw new Error('Plex returned HTTP 404'); return { MediaContainer: { Metadata: [{ ratingKey: md[1], Media: [] }] } } }
      if (p.startsWith('/library/sections/1/all')) return { MediaContainer: { totalSize: 2, Metadata: [
        { ratingKey: '1', title: 'Paper Moons', year: 2015, addedAt: s(NOW - 400 * DAY), Guid: [{ id: 'tmdb://111' }], Media: [{ Part: [{ size: 1 }] }] },
        { ratingKey: '2', title: 'Glass Orchard', year: 2016, addedAt: s(NOW - 400 * DAY), Media: [{ Part: [{ size: 3e9 }] }] },
      ] } }
      if (p.startsWith('/library/sections')) return { MediaContainer: { Directory: [{ key: '1', type: 'movie', title: 'Films' }, { key: '9', type: 'artist', title: 'Music' }] } }
      if (p.startsWith('/status/sessions/history/all')) return { MediaContainer: { totalSize: 0, Metadata: [] } }
      throw new Error(`unexpected ${p}`)
    },
    async delete(p) { plexDeletes.push(p); const m = /^\/library\/metadata\/(\d+)$/.exec(p); if (m) gonePlex.add(m[1]); return null },
    async image() { throw new Error('no art in this fake') },
    async put() { throw new Error('Plex takes no edits here') },
    async trigger(p) { plexDeletes.push(`scan ${p}`) },
  }
  const radarr: CoreEndpointClient = {
    async get(p) {
      if (p === '/api/v3/movie') return [...movies.values()]
      const m = /^\/api\/v3\/movie\/(\d+)$/.exec(p)
      if (m) { const x = movies.get(Number(m[1])); if (!x) throw new Error('Arr Stack returned HTTP 404'); return x }
      throw new Error(`unexpected ${p}`)
    },
    async delete(p) { deletes.push(p); const m = /^\/api\/v3\/movie\/(\d+)\?/.exec(p); if (m) movies.delete(Number(m[1])); return null },
    async image() { throw new Error('Radarr serves no art here') },
    async put() { throw new Error('no edits') },
    async trigger() {},
  }
  return { plex, radarr, deletes, movies, plexDeletes, state }
}

const broker = new FakeBroker()
broker.addUser('admin@example.com', 'admin master password', 'admin')
broker.addUser('op@example.com', 'operator master password', 'operator')
broker.addUser('viewer@example.com', 'viewer master password', 'viewer')
const tokens = new MemoryApiTokenStore()
const audits: Array<{ action: string; details?: Record<string, unknown> }> = []
let app: FastifyInstance
let f = fakes()
let svc: ClearoutService

before(async () => {
  setBroker(broker)
  setApiTokenStore(tokens)
  setAuditSink({ async write(r) { audits.push(r) } })
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  svc = new ClearoutService({
    plex: async () => f.plex, sonarr: async () => null, radarr: async () => f.radarr,
    option: async k => (k === 'keep_added_days' ? 'none' : undefined), now: () => NOW,
    audit: async (action, details) => { audits.push({ action, details }) },
  })
  app = Fastify({ logger: false })
  await registerGate(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(buildPlexClearoutRoutes({ service: () => svc }), { prefix: '/api/plugins/plex' })
  await app.ready()
})
after(async () => { setApiTokenStore(null); setAuditSink(null); if (isUnlocked()) await lock('manual'); await app.close() })

const BASE = '/api/plugins/plex/clearout'

test('the role matrix: lists are viewer, preview and remove operator, remove re-confirmed', () => {
  assert.equal(requiredRole('GET', BASE), 'viewer')
  assert.equal(requiredRole('POST', `${BASE}/preview`), 'operator')
  assert.equal(requiredRole('POST', `${BASE}/remove`), 'operator')
  assert.equal(needsReconfirm('POST', `${BASE}/remove`), true)
  assert.equal(needsReconfirm('POST', `${BASE}/preview`), false)
  assert.equal(requiredRole('POST', `${BASE}/anything-else`), 'admin', 'a new route stays admin')
})

test('a viewer sees the lists but cannot preview or remove', async () => {
  const { cookie } = await signIn(app, 'viewer@example.com', 'viewer master password')
  const list = await app.inject({ method: 'GET', url: BASE, headers: { cookie } })
  assert.equal(list.statusCode, 200, list.body)
  assert.deepEqual(list.json().data.rows.map((r: any) => [r.title, r.via, r.sizeBytes]), [['Glass Orchard', 'plex', 3e9], ['Paper Moons', 'radarr', 2e9]])
  for (const u of [`${BASE}/preview`, `${BASE}/remove`]) {
    const r = await app.inject({ method: 'POST', url: u, headers: { cookie }, payload: { ids: ['movie:1'], previewId: 'x' } })
    assert.equal(r.statusCode, 403, u)
  }
  assert.equal(f.deletes.length, 0)
})

test('an API token, even an admin one, cannot remove', async () => {
  const t = (await createApiToken({ name: 'auto', role: 'admin' }, 'test', tokens)).token
  const h = { authorization: `Bearer ${t}` }
  const pv = await app.inject({ method: 'POST', url: `${BASE}/preview`, headers: h, payload: { ids: ['movie:1'] } })
  assert.equal(pv.statusCode, 200, pv.body)
  const r = await app.inject({ method: 'POST', url: `${BASE}/remove`, headers: h, payload: { previewId: pv.json().data.id } })
  assert.equal(r.statusCode, 403)
  assert.equal(r.json().code, 'reconfirm_required')
  assert.equal(f.deletes.length, 0)
})

test('operator: preview, then remove only after the master password, through Radarr, read back and audited', async () => {
  const { cookie } = await signIn(app, 'op@example.com', 'operator master password')
  const pv = await app.inject({ method: 'POST', url: `${BASE}/preview`, headers: { cookie }, payload: { ids: ['movie:1', 'movie:2', 'movie:404'] } })
  assert.equal(pv.statusCode, 200, pv.body)
  const p = pv.json().data
  assert.deepEqual(p.items.map((x: any) => [x.title, x.via, x.sizeBytes]), [['Paper Moons (2015)', 'radarr', 2e9], ['Glass Orchard (2016)', 'plex', 3e9]])
  assert.match(p.items[1].note, /Removed from disk by Plex/)
  assert.equal(p.totalBytes, 5e9)
  assert.equal(p.skipped.length, 1, 'not on the list')

  const noConfirm = await app.inject({ method: 'POST', url: `${BASE}/remove`, headers: { cookie }, payload: { previewId: p.id } })
  assert.equal(noConfirm.statusCode, 403)
  assert.equal(noConfirm.json().code, 'reconfirm_required')
  assert.equal(f.deletes.length, 0)

  const rc = await app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie }, payload: { password: 'operator master password' } })
  assert.equal(rc.statusCode, 200)
  const done = await app.inject({ method: 'POST', url: `${BASE}/remove`, headers: { cookie }, payload: { previewId: p.id } })
  assert.equal(done.statusCode, 200, done.body)
  assert.deepEqual(f.deletes, ['/api/v3/movie/5?deleteFiles=true&addImportExclusion=true'])
  assert.equal(f.plexDeletes[0], '/library/metadata/2', 'the one Radarr does not manage goes through Plex')
  assert.ok(f.plexDeletes.some(x => x.startsWith('scan /library/sections/1/refresh')), 'and Plex is asked to rescan')
  const res = done.json().data.results
  assert.equal(res.length, 2)
  assert.equal(res[0].removed, true, 'Radarr no longer has it')
  assert.equal(res[1].removed, true, 'Plex no longer has it (read back: 404)')
  const a = audits.find(x => x.action === 'plex.clearout.remove')!
  assert.equal(a.details?.removed, 2)
  assert.deepEqual(audits.filter(x => x.action.startsWith('plex.media.remove')).map(x => x.action),
    ['plex.media.remove.start', 'plex.media.remove.result', 'plex.media.remove.start', 'plex.media.remove.result'], 'each item, before and after')
  assert.equal(a.details?.by, 'op@example.com')

  const again = await app.inject({ method: 'POST', url: `${BASE}/remove`, headers: { cookie }, payload: { previewId: p.id } })
  assert.equal(again.statusCode, 409, 'a preview is used once')
})

test('an Arr that says yes but still lists the item is reported as not removed; a changed item is left alone', async () => {
  f = fakes()
  svc = new ClearoutService({ plex: async () => f.plex, sonarr: async () => null, radarr: async () => f.radarr, option: async () => 'none', now: () => NOW })
  const stubborn = { ...f.radarr, delete: async (p: string) => { f.deletes.push(p); return null } }
  const owner = 'sid-1'
  let p: Awaited<ReturnType<ClearoutService['preview']>>
  const s2 = new ClearoutService({ plex: async () => f.plex, sonarr: async () => null, radarr: async () => stubborn, option: async () => 'none', now: () => NOW })
  p = await s2.preview(['movie:1'], owner)
  await assert.rejects(s2.remove(p.id, 'someone-else'), /someone else/)
  p = await s2.preview(['movie:1'], owner)
  const r = await s2.remove(p.id, owner)
  assert.equal(r.results[0].removed, false)
  assert.match(r.results[0].message, /still lists it/)

  p = await s2.preview(['movie:1'], owner)
  f.movies.get(5)!.path = '/media/films/Something Else'
  const moved = await s2.remove(p.id, owner)
  assert.equal(moved.results[0].removed, false)
  assert.match(moved.results[0].message, /left alone/)
  assert.equal(f.deletes.length, 1, 'no delete for the changed item')
})

test('no Plex server set: a plain refusal, not a crash', async () => {
  const none = new ClearoutService({ plex: async () => null, sonarr: async () => null, radarr: async () => null, option: async () => undefined, now: () => NOW })
  await assert.rejects(none.report(), /Plex server address and token/)
})

// ── cover art through HyperProx ─────────────────────────────────────────────

test('art allowlist: only three plain parts, rebuilt into Plex’s own path', () => {
  assert.deepEqual(artKey('123', 'thumb', '456'), { id: '123', kind: 'thumb', version: '456' })
  assert.equal(artKey('123', 'art', '9')?.kind, 'art')
  for (const [id, kind, v] of [
    ['123', 'file', '1'], ['12a', 'thumb', '1'], ['../../etc', 'thumb', '1'], ['http://evil.example', 'thumb', '1'],
    ['123', 'thumb', '1?url=http://evil.example'], ['', 'thumb', '1'], ['12345678901', 'thumb', '1'], ['1', 'THUMB', '1'],
  ]) assert.equal(artKey(id, kind, v), null, `${id}/${kind}/${v}`)
  assert.equal(artRef('/library/metadata/77/thumb/1700000002'), '/api/plugins/plex/art/77/thumb/1700000002')
  for (const bad of ['http://198.51.100.7:32400/library/metadata/77/thumb/1', '/library/metadata/77/thumb/1?X-Plex-Token=t',
    '/library/metadata/77/file/1', '/photo/:/transcode?url=http://evil.example', '/library/metadata/77/thumb/1/../../x', null, 42]) {
    assert.equal(artRef(bad), null, String(bad))
  }
  const up = artUpstream({ id: '77', kind: 'thumb', version: '5' })
  assert.deepEqual(up, ['/photo/:/transcode?width=300&height=450&minSize=1&upscale=1&url=%2Flibrary%2Fmetadata%2F77%2Fthumb%2F5', '/library/metadata/77/thumb/5'])
})

test('art route: signed in only, fixed upstream paths, image type and cache headers, cached, fallback 404', async () => {
  const asked: string[] = []
  let answer: 'ok' | 'html' | 'fail' = 'ok'
  const plexArt: CoreEndpointClient = {
    async get() { throw new Error('not used') }, async delete() { throw new Error('not used') },
    async put() { throw new Error('not used') }, async trigger() {},
    async image(p) {
      asked.push(p)
      if (answer === 'fail') throw new Error('Plex returned HTTP 404')
      if (answer === 'html') throw new Error('Plex did not return an image')
      return { contentType: 'image/jpeg', body: Buffer.from([0xff, 0xd8, 0xff, 0x01]) }
    },
  }
  const a = Fastify({ logger: false })
  await registerGate(a)
  await a.register(authRoutes, { prefix: '/api/auth' })
  await a.register(buildPlexClearoutRoutes({ service: () => svc, plex: async () => plexArt, cache: new ArtCache() }), { prefix: '/api/plugins/plex' })
  await a.ready()
  try {
    const anon = await a.inject({ method: 'GET', url: '/api/plugins/plex/art/77/thumb/5' })
    assert.ok(anon.statusCode === 401 || anon.statusCode === 423, `no session: ${anon.statusCode}`)
    assert.equal(asked.length, 0)

    const { cookie } = await signIn(a, 'viewer@example.com', 'viewer master password')
    const ok = await a.inject({ method: 'GET', url: '/api/plugins/plex/art/77/thumb/5?url=http://evil.example/x', headers: { cookie } })
    assert.equal(ok.statusCode, 200, ok.body)
    assert.equal(ok.headers['content-type'], 'image/jpeg')
    assert.match(String(ok.headers['cache-control']), /private, max-age=\d+/)
    assert.equal(ok.rawPayload.length, 4)
    assert.deepEqual(asked, [artUpstream({ id: '77', kind: 'thumb', version: '5' })[0]], 'the query string is ignored; the path is rebuilt')
    await a.inject({ method: 'GET', url: '/api/plugins/plex/art/77/thumb/5', headers: { cookie } })
    assert.equal(asked.length, 1, 'served from the cache')

    for (const url of [
      '/api/plugins/plex/art/77/file/5', '/api/plugins/plex/art/http%3A%2F%2Fevil.example/thumb/5',
      '/api/plugins/plex/art/..%2F..%2Fetc/thumb/5', '/api/plugins/plex/art/77/thumb/5x',
    ]) {
      const r = await a.inject({ method: 'GET', url, headers: { cookie } })
      assert.ok([400, 404].includes(r.statusCode), `${url}: ${r.statusCode}`)
    }
    assert.equal(asked.length, 1, 'nothing outside the allowlist reached Plex')

    answer = 'html'
    const notImage = await a.inject({ method: 'GET', url: '/api/plugins/plex/art/78/thumb/5', headers: { cookie } })
    assert.equal(notImage.statusCode, 404, 'not an image: the page shows its title card')
    assert.equal(asked.slice(1).length, 2, 'the transcoder, then the image itself')
  } finally { await a.close() }
})

test('live route: now streaming and bandwidth from Plex, for any signed-in person; a failure is ok:false', async () => {
  let fail = false
  const sessions = { MediaContainer: { size: 1, Metadata: [
    { type: 'movie', title: 'Paper Moons', User: { title: 'alex' }, Player: { state: 'playing', local: false }, Session: { bandwidth: 4200, location: 'wan' },
      viewOffset: 40, duration: 100, thumb: '/library/metadata/9/thumb/3' },
  ] } }
  const a = Fastify({ logger: false })
  await registerGate(a)
  await a.register(authRoutes, { prefix: '/api/auth' })
  await a.register(buildPlexClearoutRoutes({
    service: () => svc,
    live: async () => {
      if (fail) throw new Error('Plex returned HTTP 500')
      return liveFromPlex({ get: async () => sessions })
    },
    liveTtlMs: -1,
  }), { prefix: '/api/plugins/plex' })
  await a.ready()
  try {
    assert.equal(requiredRole('GET', '/api/plugins/plex/live'), 'viewer')
    const anon = await a.inject({ method: 'GET', url: '/api/plugins/plex/live' })
    assert.ok(anon.statusCode === 401 || anon.statusCode === 423)
    const { cookie } = await signIn(a, 'viewer@example.com', 'viewer master password')
    const r = await a.inject({ method: 'GET', url: '/api/plugins/plex/live', headers: { cookie } })
    assert.equal(r.statusCode, 200, r.body)
    const d = r.json().data
    assert.equal(d.ok, true)
    assert.equal(d.counts.streams, 1)
    assert.equal(d.bandwidth.wanMbps, 4.2)
    assert.equal(d.sessions[0].progress, 40)
    assert.equal(d.sessions[0].art, '/api/plugins/plex/art/9/thumb/3')
    assert.equal(r.body.includes('X-Plex-Token'), false)
    fail = true
    const bad = (await a.inject({ method: 'GET', url: '/api/plugins/plex/live', headers: { cookie } })).json().data
    assert.equal(bad.ok, false)
    assert.match(bad.error, /HTTP 500/)
  } finally { await a.close() }
})

// ── review fixes ────────────────────────────────────────────────────────────

test('the new-items watcher really starts with the routes, and its switches are wait / off / on', async () => {
  let started = 0
  let unlocked = false
  let settings: Record<string, string> = {}
  let plexSet: CoreEndpointClient | null = null
  const wd = newWatcherDeps({
    unlocked: () => unlocked, settings: async () => settings, plex: async () => plexSet,
    publish: async () => {}, store: { load: () => ({ watermark: null, seen: [] }), save: () => {} },
  })
  const a = Fastify({ logger: false })
  await a.register(buildPlexClearoutRoutes({ service: () => svc, watcher: { start: () => { started++; return () => {} }, deps: wd } }), { prefix: '/api/plugins/plex' })
  await a.ready()
  try {
    assert.equal(started, 1, 'started once, when the routes are registered')
    assert.equal(await wd.enabled(), 'wait', 'locked')
    unlocked = true
    assert.equal(await wd.enabled(), 'off', 'setting not on')
    settings = { notify_new: 'yes' }
    assert.equal(await wd.enabled(), 'wait', 'Plex not set yet')
    plexSet = f.plex
    assert.equal(await wd.enabled(), 'on')
  } finally { await a.close() }
})

test('title matches never guess: two Arr entries with one title and year match neither', async () => {
  const twins: CoreEndpointClient = {
    async get(p) {
      if (p === '/api/v3/movie') return [{ id: 1, title: 'Glass Orchard', year: 2016, path: '/a' }, { id: 2, title: 'Glass Orchard', year: 2016, path: '/b' }]
      throw new Error('HTTP 404')
    },
    async delete() { throw new Error('no') }, async image() { throw new Error('no') },
    async put() { throw new Error('no') }, async trigger() {},
  }
  const s2 = new ClearoutService({ plex: async () => fakes().plex, sonarr: async () => null, radarr: async () => twins, option: async () => 'none', now: () => NOW })
  const { report } = await s2.report()
  assert.equal(report.rows.find(r => r.title === 'Glass Orchard')?.via, 'plex', 'an ambiguous title is never Radarr’s to delete')
})

test('an Arr entry shared with a Plex item that is watched or kept is refused; each delete is audited before and after', async () => {
  const ff = fakes()
  const shared: CoreEndpointClient = {
    ...ff.plex,
    async get(p) {
      if (p.startsWith('/library/sections/1/all')) return { MediaContainer: { totalSize: 2, Metadata: [
        { ratingKey: '1', title: 'Paper Moons', year: 2015, addedAt: s(NOW - 400 * DAY), Guid: [{ id: 'tmdb://111' }] },
        { ratingKey: '3', title: 'Paper Moons', year: 2015, addedAt: s(NOW - 400 * DAY), Guid: [{ id: 'tmdb://111' }] },
      ] } }
      if (p.startsWith('/status/sessions/history/all')) return { MediaContainer: { Metadata: [{ ratingKey: '3', type: 'movie', title: 'Other cut', viewedAt: s(NOW - DAY), accountID: 1 }] } }
      return ff.plex.get(p)
    },
  }
  const log: Array<[string, Record<string, unknown>]> = []
  const s3 = new ClearoutService({ plex: async () => shared, sonarr: async () => null, radarr: async () => ff.radarr, option: async () => 'none', now: () => NOW,
    audit: async (a, d) => { log.push([a, d]) } })
  const p = await s3.preview(['movie:1'], 'sid')
  assert.equal(p.items.length, 0)
  assert.match(p.skipped[0].reason, /shares its Radarr entry/)

  const s4 = new ClearoutService({ plex: async () => ff.plex, sonarr: async () => null, radarr: async () => ff.radarr, option: async () => 'none', now: () => NOW,
    audit: async (a, d) => { log.push([a, d]) } })
  const ok = await s4.preview(['movie:1'], 'sid')
  await s4.remove(ok.id, 'sid', 'op@example.com')
  assert.deepEqual(log.map(x => x[0]), ['plex.media.remove.start', 'plex.media.remove.result'])
  assert.equal(log[1][1].removed, true)
  assert.equal(log[0][1].by, 'op@example.com')
})

test('reading again is operator only and at most once a minute; /live is one shared reading; art misses are limited', async () => {
  let reads = 0
  let now = NOW
  const ff = fakes()
  const counting: CoreEndpointClient = { ...ff.plex, async get(p) { if (p === '/library/sections') reads++; return ff.plex.get(p) } }
  const s5 = new ClearoutService({ plex: async () => counting, sonarr: async () => null, radarr: async () => null, option: async () => undefined, now: () => now })
  let liveCalls = 0
  const a = Fastify({ logger: false })
  await registerGate(a)
  await a.register(authRoutes, { prefix: '/api/auth' })
  await a.register(buildPlexClearoutRoutes({
    service: () => s5, live: async () => { liveCalls++; return { sessions: [], counts: { streams: 0 }, bandwidth: {} } },
    plex: async () => ({ ...ff.plex, async image() { return { contentType: 'image/png', body: Buffer.from([1]) } } }),
    limiter: new MissLimiter(1), cache: new ArtCache(),
  }), { prefix: '/api/plugins/plex' })
  await a.ready()
  try {
    const viewer = (await signIn(a, 'viewer@example.com', 'viewer master password')).cookie
    const op = (await signIn(a, 'op@example.com', 'operator master password')).cookie
    assert.equal((await a.inject({ method: 'GET', url: `${BASE}?refresh=1`, headers: { cookie: viewer } })).statusCode, 403)
    assert.equal((await a.inject({ method: 'GET', url: BASE, headers: { cookie: viewer } })).statusCode, 200)
    assert.equal((await a.inject({ method: 'GET', url: `${BASE}?refresh=1`, headers: { cookie: op } })).statusCode, 200)
    assert.equal(reads, 1, 'a re-read within a minute of the last read is served from the cache')
    now += 61_000
    await a.inject({ method: 'GET', url: `${BASE}?refresh=1`, headers: { cookie: op } })
    assert.equal(reads, 2)

    await Promise.all([1, 2, 3].map(() => a.inject({ method: 'GET', url: '/api/plugins/plex/live', headers: { cookie: viewer } })))
    assert.equal(liveCalls, 1, 'three pages, one reading')

    assert.equal((await a.inject({ method: 'GET', url: '/api/plugins/plex/art/1/thumb/1', headers: { cookie: viewer } })).statusCode, 200)
    assert.equal((await a.inject({ method: 'GET', url: '/api/plugins/plex/art/1/thumb/1', headers: { cookie: viewer } })).statusCode, 200, 'a cache hit is not a miss')
    assert.equal((await a.inject({ method: 'GET', url: '/api/plugins/plex/art/2/thumb/1', headers: { cookie: viewer } })).statusCode, 429)
  } finally { await a.close() }
})

test('the art cache stays within its byte budget', () => {
  const c = new ArtCache(100, 60_000, () => NOW, 10)
  c.set('a', 'image/png', Buffer.alloc(4)); c.set('b', 'image/png', Buffer.alloc(4)); c.set('c', 'image/png', Buffer.alloc(4))
  assert.deepEqual(c.size, { entries: 2, bytes: 8 })
  assert.equal(c.get('a'), null, 'the oldest went first')
  c.set('huge', 'image/png', Buffer.alloc(11))
  assert.equal(c.get('huge'), null, 'larger than the whole budget: not kept')
})
