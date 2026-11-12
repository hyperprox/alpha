// Plex Library view: episodes mapped to Sonarr files by tvdb id plus season and episode (never by title), the
// unmonitor step, "keep monitored", the next-up warning, refusal while streaming, the Plex path (deletion setting
// off, one version), the guards on the routes, and the read-back.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { buildPlexClearoutRoutes } from '../src/routes/plex-clearout'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { setAuditSink } from '../src/lib/audit'
import { MemoryApiTokenStore, setApiTokenStore, createApiToken } from '../src/lib/api-tokens'
import { requiredRole, needsReconfirm } from '../src/lib/roles'
import { ClearoutService } from '../src/lib/plex-clearout/service'
import { LibraryService } from '../src/lib/plex-library/service'
import { mapEpisodes, nextUpFor, plexEpisodes, seriesByTvdb } from '../src/lib/plex-library/logic'
import { PLEX_DELETION_OFF, STREAMING } from '../src/lib/plex-remove/engine'
import type { CoreEndpointClient } from '../src/lib/plugin-host'
import { FakeBroker } from './fakes/fake-broker'
import { signIn } from './fakes/app'

const NOW = Date.UTC(2026, 5, 15)
const DAY = 86_400_000
const s = (ms: number) => Math.floor(ms / 1000)

const leaf = (rk: string, season: number, ep: number, over: any = {}) => ({
  type: 'episode', ratingKey: rk, parentRatingKey: `${7000 + season}`, parentIndex: season, index: ep, title: `Episode ${ep}`,
  Media: [{ id: Number(rk) * 10, videoResolution: '1080', videoCodec: 'hevc', Part: [{ size: 1e9, file: `/tv/Harbour Lights/S0${season}E0${ep}.mkv` }] }], ...over,
})

// ── pure parts ───────────────────────────────────────────────────────────────

test('episodes map to Sonarr by tvdb id plus season and episode, never by title', () => {
  const series = [{ id: 9, title: 'Harbour Lights', tvdbId: 500 }, { id: 10, title: 'Harbour Lights', tvdbId: 600 }]
  assert.equal(seriesByTvdb(series, 600)?.id, 10, 'the tvdb id decides, not the title')
  assert.equal(seriesByTvdb(series, null), null, 'no tvdb id: not Sonarr’s')
  assert.equal(seriesByTvdb(series, 777), null)
  assert.equal(seriesByTvdb([...series, { id: 11, title: 'Other', tvdbId: 500 }], 500), null, 'two series with one tvdb id: neither')

  const eps = plexEpisodes({ MediaContainer: { Metadata: [leaf('702', 1, 2, { title: 'Renamed in Plex' }), leaf('701', 1, 1), leaf('703', 1, 3), { type: 'season', ratingKey: '1' }] } })
  assert.deepEqual(eps.map(e => [e.ratingKey, e.season, e.episode]), [['701', 1, 1], ['702', 1, 2], ['703', 1, 3]])
  assert.equal(eps[0].quality, '1080p · HEVC')
  const links = mapEpisodes(eps,
    [{ id: 91, seasonNumber: 1, episodeNumber: 1, episodeFileId: 501, monitored: true, title: 'Totally different' },
     { id: 92, seasonNumber: 1, episodeNumber: 2, episodeFileId: 502, monitored: true },
     { id: 93, seasonNumber: 1, episodeNumber: 3, episodeFileId: 0, monitored: true },
     { id: 94, seasonNumber: 1, episodeNumber: 3, episodeFileId: 504, monitored: true }],
    [{ id: 501, path: '/tv/a.mkv', size: 2e9, quality: { quality: { name: 'WEBDL-1080p' } } }, { id: 502, path: '/tv/b.mkv', size: 3e9 }])
  assert.deepEqual(links.get('701'), { episodeId: 91, fileId: 501, monitored: true, filePath: '/tv/a.mkv', fileSize: 2e9, quality: 'WEBDL-1080p' })
  assert.equal(links.get('702')?.fileId, 502, 'a renamed episode still maps: by number, not title')
  assert.equal(links.has('703'), false, 'two Sonarr episodes claim S1E3: neither is used')
})

test('next up: watched the episode before it in the last 14 days, and not this one', () => {
  const eps = plexEpisodes({ MediaContainer: { Metadata: [leaf('701', 1, 1), leaf('702', 1, 2), leaf('703', 1, 3), leaf('801', 2, 1)] } })
  const names = new Map([[1, 'alex'], [2, 'sam'], [3, 'kai']])
  const row = (acct: number, rk: string, season: number, ep: number, daysAgo: number) =>
    ({ ratingKey: rk, type: 'episode', title: 'x', grandparentTitle: 'Harbour Lights', grandparentKey: '/library/metadata/77', viewedAt: s(NOW - daysAgo * DAY), accountID: acct, season, episode: ep })
  const next = nextUpFor(eps, [
    row(1, '701', 1, 1, 3),                         // alex: E1 three days ago → E2 is next
    row(2, '701', 1, 1, 20),                        // sam: too long ago
    row(3, '701', 1, 1, 5), row(3, '702', 1, 2, 4), // kai: E1 and E2 → E3 is next
    row(1, '999', 1, 3, 1),                         // alex: E3 under an old ratingKey (a re-download) still counts
    row(2, '703', 1, 3, 2),                         // sam: finished season 1 → S2E1 is next, across the season break
  ], names, NOW)
  assert.deepEqual(next.get('702'), ['alex'])
  assert.deepEqual(next.get('703'), ['kai'])
  assert.deepEqual(next.get('801'), ['alex', 'sam'])
  assert.equal(next.has('701'), false)
})

// ── the service, against a fake Plex and Sonarr ─────────────────────────────

function world() {
  const state = { allow: true, streaming: [] as any[], plexGone: new Set<string>(), mediaGone: new Set<string>() }
  const calls: string[] = []
  const files = new Map<number, any>([[501, { id: 501, seriesId: 9, path: '/tv/Harbour Lights/S01E01.mkv', size: 1e9 }], [502, { id: 502, seriesId: 9, path: '/tv/Harbour Lights/S01E02.mkv', size: 1e9 }], [503, { id: 503, seriesId: 9, path: '/tv/Harbour Lights/S01E03.mkv', size: 1e9 }]])
  const episodes = [1, 2, 3].map(n => ({ id: 90 + n, seriesId: 9, seasonNumber: 1, episodeNumber: n, episodeFileId: 500 + n, monitored: true }))
  const series = { id: 9, title: 'Harbour Lights', tvdbId: 500, path: '/tv/Harbour Lights', statistics: { sizeOnDisk: 3e9 }, seasons: [{ seasonNumber: 1, monitored: true }] }
  const owl = [
    { type: 'episode', ratingKey: '801', parentRatingKey: '8001', parentIndex: 1, index: 1, title: 'Owls',
      Media: [{ id: 11, videoResolution: '720', Part: [{ size: 5e8, file: '/tv/Owl Fen/S01E01 720p.mkv' }] }, { id: 12, videoResolution: '1080', Part: [{ size: 9e8, file: '/tv/Owl Fen/S01E01 1080p.mkv' }] }] },
    { type: 'episode', ratingKey: '802', parentRatingKey: '8001', parentIndex: 1, index: 2, title: 'More owls', Media: [{ id: 13, Part: [{ size: 4e8, file: '/tv/Owl Fen/S01E02.mkv' }] }] },
  ]
  const plex: CoreEndpointClient = {
    async get(p) {
      calls.push(`plex GET ${p}`)
      if (p === '/status/sessions') return { MediaContainer: { Metadata: state.streaming } }
      if (p === '/:/prefs') return { MediaContainer: { Setting: [{ id: 'allowMediaDeletion', value: state.allow }] } }
      if (p === '/accounts') return { MediaContainer: { Account: [{ id: 1, name: 'alex' }] } }
      if (p.startsWith('/library/sections/2/all')) return { MediaContainer: { totalSize: 2, Metadata: [
        { ratingKey: '77', title: 'Harbour Lights', year: 1990, addedAt: s(NOW - 900 * DAY), Guid: [{ id: 'tvdb://500' }], Location: [{ path: '/tv/Harbour Lights' }] },
        { ratingKey: '88', title: 'Owl Fen', year: 2019, addedAt: s(NOW - 900 * DAY), Location: [{ path: '/tv/Owl Fen' }] },
      ] } }
      if (p.startsWith('/library/sections/2/all?type=4')) return { MediaContainer: { Metadata: [] } }
      if (p.startsWith('/library/sections')) return { MediaContainer: { Directory: [{ key: '2', type: 'show', title: 'TV' }] } }
      if (p.startsWith('/status/sessions/history/all')) return { MediaContainer: { totalSize: 1, Metadata: [
        { ratingKey: '701', type: 'episode', title: 'Episode 1', grandparentTitle: 'Harbour Lights', grandparentKey: '/library/metadata/77', parentIndex: 1, index: 1, viewedAt: s(NOW - 2 * DAY), accountID: 1 },
      ] } }
      if (p === '/library/metadata/77/allLeaves') return { MediaContainer: { Metadata: [leaf('701', 1, 1), leaf('702', 1, 2), leaf('703', 1, 3, { viewOffset: 60_000 })] } }
      if (p === '/library/metadata/88/allLeaves') return { MediaContainer: { Metadata: owl.filter(e => !state.plexGone.has(e.ratingKey)) } }
      const md = /^\/library\/metadata\/(\d+)$/.exec(p)
      if (md) {
        if (state.plexGone.has(md[1])) throw new Error('Plex returned HTTP 404')
        const e = owl.find(x => x.ratingKey === md[1])
        return { MediaContainer: { Metadata: [{ ratingKey: md[1], Media: (e?.Media ?? []).filter(m => !state.mediaGone.has(String(m.id))) }] } }
      }
      throw new Error(`unexpected ${p}`)
    },
    async delete(p) {
      calls.push(`plex DELETE ${p}`)
      const v = /^\/library\/metadata\/(\d+)\/media\/(\d+)$/.exec(p)
      if (v) { state.mediaGone.add(v[2]); return null }
      const m = /^\/library\/metadata\/(\d+)$/.exec(p)
      if (m) state.plexGone.add(m[1])
      return null
    },
    async image() { throw new Error('no') }, async put() { throw new Error('no') },
    async trigger(p) { calls.push(`plex SCAN ${p}`) },
  }
  const sonarr: CoreEndpointClient = {
    async get(p) {
      calls.push(`sonarr GET ${p}`)
      if (p === '/api/v3/series') return [series, { id: 10, title: 'Owl Fen', tvdbId: 999, path: '/tv/Owl Fen' }]
      if (p === '/api/v3/series/9') return series
      if (p === '/api/v3/episode?seriesId=9') return episodes
      if (p === '/api/v3/episodefile?seriesId=9') return [...files.values()]
      const f = /^\/api\/v3\/episodefile\/(\d+)$/.exec(p)
      if (f) { const x = files.get(Number(f[1])); if (!x) throw new Error('Arr Stack returned HTTP 404'); return x }
      throw new Error(`unexpected ${p}`)
    },
    async delete(p) {
      calls.push(`sonarr DELETE ${p}`)
      const f = /^\/api\/v3\/episodefile\/(\d+)$/.exec(p)
      if (f) { files.delete(Number(f[1])); for (const e of episodes) if (e.episodeFileId === Number(f[1])) e.episodeFileId = 0 }
      return null
    },
    async put(p, body: any) {
      calls.push(`sonarr PUT ${p} ${JSON.stringify(body?.episodeIds ?? body?.seasons?.map((x: any) => [x.seasonNumber, x.monitored]))}`)
      if (p === '/api/v3/episode/monitor') for (const e of episodes) if (body.episodeIds.includes(e.id)) e.monitored = body.monitored
      if (p === '/api/v3/series/9') series.seasons = body.seasons
      return null
    },
    async image() { throw new Error('no') }, async trigger() {},
  }
  const audits: string[] = []
  const clearout = new ClearoutService({ plex: async () => plex, sonarr: async () => sonarr, radarr: async () => null, option: async () => undefined, now: () => NOW,
    audit: async a => { audits.push(a) } })
  return { state, calls, files, episodes, series, plex, sonarr, clearout, lib: new LibraryService(clearout), audits }
}

test('show view: seasons, episodes with size, quality, plays, watched, next up, and which way each goes', async () => {
  const w = world()
  const v = await w.lib.show('77')
  assert.equal(v.show.via, 'sonarr')
  assert.equal(v.show.keptBy, 'Released before the cut-off year', 'kept by a rule: shown, not blocking')
  const eps = v.seasons[0].episodes
  assert.deepEqual(eps.map(e => [e.ratingKey, e.plays, e.watched, e.via]), [['701', 1, true, 'sonarr'], ['702', 0, false, 'sonarr'], ['703', 0, false, 'sonarr']])
  assert.deepEqual(eps[1].nextUpFor, ['alex'])
  assert.equal(eps[2].inProgress, true)
  const owl = await w.lib.show('88')
  assert.equal(owl.show.via, 'plex', 'Sonarr has an "Owl Fen", but Plex has no tvdb id for it: never matched by title')
  assert.equal(owl.seasons[0].episodes[0].versions.length, 2)
})

test('episodes through Sonarr: files deleted, episodes unmonitored, read back, Plex rescanned', async () => {
  const w = world()
  const p = await w.lib.preview({ kind: 'episodes', ratingKey: '77', episodes: ['701', '702'] }, 'sid')
  assert.equal(p.items.length, 1)
  const it = p.items[0]
  assert.equal(it.via, 'sonarr')
  assert.deepEqual(it.step, { kind: 'arr-files', seriesId: 9, fileIds: [501, 502], episodeIds: [91, 92], unmonitor: true, season: null })
  assert.deepEqual(it.files.map(f => f.path), ['/tv/Harbour Lights/S01E01.mkv', '/tv/Harbour Lights/S01E02.mkv'])
  assert.equal(p.totalBytes, 2e9)
  assert.match(it.note, /set to unmonitored so they are not downloaded again/)
  assert.ok(it.warnings.some(x => /S1E2 is next up for alex/.test(x)))
  assert.equal(it.keptBy, 'Released before the cut-off year')
  assert.equal(it.blocked, null)
  const r = await w.lib.remove(p.id, 'sid', 'op@example.com')
  assert.equal(r.results[0].removed, true, r.results[0].message)
  assert.ok(w.calls.includes('sonarr DELETE /api/v3/episodefile/501') && w.calls.includes('sonarr DELETE /api/v3/episodefile/502'))
  assert.ok(w.calls.includes('sonarr PUT /api/v3/episode/monitor [91,92]'), 'the unmonitor step')
  assert.equal(w.episodes.find(e => e.id === 93)!.monitored, true, 'only the chosen episodes')
  assert.ok(w.calls.some(c => c.startsWith('plex SCAN /library/sections/2/refresh?path=%2Ftv%2FHarbour%20Lights')), 'just that show’s folder')
  assert.deepEqual(w.audits, ['plex.media.remove.start', 'plex.media.remove.result'])
})

test('"keep monitored so a better copy downloads": the file goes, the episode stays monitored', async () => {
  const w = world()
  const p = await w.lib.preview({ kind: 'episodes', ratingKey: '77', episodes: ['702'], keepMonitored: true }, 'sid')
  assert.match(p.items[0].note, /stay monitored, so Sonarr may download a better copy/)
  await w.lib.remove(p.id, 'sid')
  assert.equal(w.calls.some(c => c.includes('episode/monitor')), false)
  assert.equal(w.episodes.find(e => e.id === 92)!.monitored, true)
  assert.equal(w.files.has(502), false)
})

test('a season through Sonarr: every file, every episode and the season unmonitored', async () => {
  const w = world()
  const p = await w.lib.preview({ kind: 'season', ratingKey: '77', season: 1 }, 'sid')
  assert.deepEqual((p.items[0].step as any).fileIds, [501, 502, 503])
  assert.equal((p.items[0].step as any).season, 1)
  const r = await w.lib.remove(p.id, 'sid')
  assert.equal(r.results[0].removed, true, r.results[0].message)
  assert.ok(w.calls.includes('sonarr PUT /api/v3/series/9 [[1,false]]'), 'the season itself is unmonitored')
  assert.ok(w.episodes.every(e => !e.monitored))
})

test('never while someone is watching: blocked in the preview, and re-checked when removing', async () => {
  const w = world()
  w.state.streaming = [{ ratingKey: '702', parentRatingKey: '7001', grandparentRatingKey: '77' }]
  const p = await w.lib.preview({ kind: 'episodes', ratingKey: '77', episodes: ['701'] }, 'sid')
  assert.equal(p.items[0].blocked, STREAMING, 'the show is playing: nothing of it goes')
  w.state.streaming = []
  const ok = await w.lib.preview({ kind: 'episodes', ratingKey: '77', episodes: ['701'] }, 'sid')
  assert.equal(ok.items[0].blocked, null)
  w.state.streaming = [{ ratingKey: '701', parentRatingKey: '7001', grandparentRatingKey: '77' }]
  const r = await w.lib.remove(ok.id, 'sid')
  assert.equal(r.results[0].removed, false)
  assert.equal(r.results[0].message, STREAMING)
  assert.equal(w.calls.some(c => c.includes('DELETE')), false, 'nothing was deleted')
})

test('the Plex path: chosen when Sonarr does not manage the show; off in Plex, it says how to turn it on', async () => {
  const w = world()
  w.state.allow = false
  const off = await w.lib.preview({ kind: 'episodes', ratingKey: '88', episodes: ['802'] }, 'sid')
  assert.equal(off.items[0].via, 'plex')
  assert.equal(off.items[0].blocked, PLEX_DELETION_OFF)
  assert.match(PLEX_DELETION_OFF, /Settings → Server → Library → Allow media deletion/)
  assert.equal(off.id && off.totalBytes, 0)

  w.state.allow = true
  const p = await w.lib.preview({ kind: 'episodes', ratingKey: '88', episodes: ['802'] }, 'sid')
  assert.match(p.items[0].note, /Removed from disk by Plex\. If something else downloads your media, it may come back\./)
  const r = await w.lib.remove(p.id, 'sid')
  assert.equal(r.results[0].removed, true, 'read back: Plex answers 404 for it now')
  assert.ok(w.calls.includes('plex DELETE /library/metadata/802'))
  assert.ok(w.calls.some(c => c.startsWith('plex SCAN /library/sections/2/refresh')))
})

test('one version of an episode with two: only that media item goes, read back by its id', async () => {
  const w = world()
  const v = await w.lib.show('88')
  assert.deepEqual(v.seasons[0].episodes[0].versions.map(x => [x.mediaId, x.label, x.sizeBytes]), [['11', '720p', 5e8], ['12', '1080p', 9e8]])
  const p = await w.lib.preview({ kind: 'episodes', ratingKey: '88', episodes: ['801'], mediaIds: { 801: '11' } }, 'sid')
  assert.deepEqual(p.items[0].step, { kind: 'plex-media', ratingKey: '801', mediaId: '11' })
  assert.deepEqual(p.items[0].files.map(f => f.path), ['/tv/Owl Fen/S01E01 720p.mkv'])
  const r = await w.lib.remove(p.id, 'sid')
  assert.equal(r.results[0].removed, true)
  assert.ok(w.calls.includes('plex DELETE /library/metadata/801/media/11'))
  await assert.rejects(w.lib.preview({ kind: 'episodes', ratingKey: '88', episodes: ['802'], mediaIds: { 802: '13' } }, 'sid'), /only one/)
})

test('read-back: a Sonarr that keeps the file is reported as not removed', async () => {
  const w = world()
  const stubborn: CoreEndpointClient = { ...w.sonarr, async delete(p) { w.calls.push(`sonarr DELETE ${p}`); return null } }
  const clearout = new ClearoutService({ plex: async () => w.plex, sonarr: async () => stubborn, radarr: async () => null, option: async () => undefined, now: () => NOW })
  const lib = new LibraryService(clearout)
  const p = await lib.preview({ kind: 'episodes', ratingKey: '77', episodes: ['703'] }, 'sid')
  const r = await lib.remove(p.id, 'sid')
  assert.equal(r.results[0].removed, false)
  assert.match(r.results[0].message, /still has a file/)
})

// ── the routes behind the real gate ─────────────────────────────────────────

const broker = new FakeBroker()
broker.addUser('op@example.com', 'operator master password', 'operator')
broker.addUser('viewer@example.com', 'viewer master password', 'viewer')
const tokens = new MemoryApiTokenStore()
let app: FastifyInstance
const w0 = world()

before(async () => {
  setBroker(broker)
  setApiTokenStore(tokens)
  setAuditSink({ async write() {} })
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  app = Fastify({ logger: false })
  await registerGate(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(buildPlexClearoutRoutes({ service: () => w0.clearout, library: () => w0.lib }), { prefix: '/api/plugins/plex' })
  await app.ready()
})
after(async () => { setApiTokenStore(null); setAuditSink(null); if (isUnlocked()) await lock('manual'); await app.close() })

const L = '/api/plugins/plex/library'

test('library routes: viewers browse; operators preview; removing needs the master password; tokens never remove', async () => {
  assert.equal(requiredRole('GET', L), 'viewer')
  assert.equal(requiredRole('GET', `${L}/show/77`), 'viewer')
  assert.equal(requiredRole('POST', `${L}/preview`), 'operator')
  assert.equal(requiredRole('POST', `${L}/remove`), 'operator')
  assert.equal(needsReconfirm('POST', `${L}/remove`), true)
  assert.equal(needsReconfirm('POST', `${L}/preview`), false)

  const viewer = (await signIn(app, 'viewer@example.com', 'viewer master password')).cookie
  const list = await app.inject({ method: 'GET', url: L, headers: { cookie: viewer } })
  assert.equal(list.statusCode, 200, list.body)
  assert.deepEqual(list.json().data.rows.map((r: any) => [r.title, r.via]), [['Harbour Lights', 'sonarr'], ['Owl Fen', 'plex']])
  assert.equal(list.json().data.plexDeletes, true)
  assert.equal((await app.inject({ method: 'GET', url: `${L}/show/77`, headers: { cookie: viewer } })).statusCode, 200)
  assert.equal((await app.inject({ method: 'GET', url: `${L}/show/..%2F1`, headers: { cookie: viewer } })).statusCode, 404)
  assert.equal((await app.inject({ method: 'POST', url: `${L}/preview`, headers: { cookie: viewer }, payload: { kind: 'episodes', ratingKey: '77', episodes: ['701'] } })).statusCode, 403)

  const t = (await createApiToken({ name: 'auto', role: 'admin' }, 'test', tokens)).token
  const pv = await app.inject({ method: 'POST', url: `${L}/preview`, headers: { authorization: `Bearer ${t}` }, payload: { kind: 'episodes', ratingKey: '77', episodes: ['701'] } })
  assert.equal(pv.statusCode, 200, pv.body)
  const byToken = await app.inject({ method: 'POST', url: `${L}/remove`, headers: { authorization: `Bearer ${t}` }, payload: { previewId: pv.json().data.id } })
  assert.equal(byToken.statusCode, 403)

  const op = (await signIn(app, 'op@example.com', 'operator master password')).cookie
  const p = (await app.inject({ method: 'POST', url: `${L}/preview`, headers: { cookie: op }, payload: { kind: 'episodes', ratingKey: '77', episodes: ['701'] } })).json().data
  const first = await app.inject({ method: 'POST', url: `${L}/remove`, headers: { cookie: op }, payload: { previewId: p.id } })
  assert.equal(first.json().code, 'reconfirm_required')
  assert.equal(w0.calls.some(c => c.includes('DELETE')), false)
  await app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie: op }, payload: { password: 'operator master password' } })
  const notMine = await app.inject({ method: 'POST', url: `${L}/remove`, headers: { cookie: op }, payload: { previewId: pv.json().data.id } })
  assert.equal(notMine.statusCode, 403, 'someone else’s preview')
  const done = await app.inject({ method: 'POST', url: `${L}/remove`, headers: { cookie: op }, payload: { previewId: p.id } })
  assert.equal(done.statusCode, 200, done.body)
  assert.equal(done.json().data.results[0].removed, true)
  assert.equal((await app.inject({ method: 'POST', url: `${L}/remove`, headers: { cookie: op }, payload: { previewId: p.id } })).statusCode, 409, 'single use')
})
