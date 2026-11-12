// Arr Stack queue, grouped: rows collapse by downloadId, group Show → Season, problems sort first, paging reads
// every page, the route shares one reading and never carries a key or an address. All titles are made up.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { requiredRole } from '../src/lib/roles'
import { buildArrQueueRoutes } from '../src/routes/arr-queue'
import {
  buildQueueData, collapseByDownload, episodeRange, groupRadarr, groupSonarr, parseTimeLeft, readAllQueue, summarize,
} from '../src/lib/arr-queue/logic'
import type { CoreEndpointClient } from '../src/lib/plugin-host'
import { signIn } from './fakes/app'
import { FakeBroker } from './fakes/fake-broker'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { setAuditSink } from '../src/lib/audit'
import { MemoryApiTokenStore, setApiTokenStore } from '../src/lib/api-tokens'

const broker = new FakeBroker()
broker.addUser('viewer@example.com', 'viewer master password', 'viewer')
before(() => {
  setBroker(broker)
  setApiTokenStore(new MemoryApiTokenStore())
  setAuditSink({ async write() {} })
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
})
after(async () => { setApiTokenStore(null); setAuditSink(null); if (isUnlocked()) await lock('manual') })

const NOW = Date.parse('2026-06-15T12:00:00Z')
const GB = 1e9

/** One Sonarr queue row, the way Sonarr returns it with includeSeries and includeEpisode. */
let rowId = 0
const row = (over: any = {}) => ({
  id: ++rowId, seriesId: 1, seasonNumber: 1, episodeId: rowId,
  series: { title: 'Example Show' }, episode: { id: rowId, seasonNumber: 1, episodeNumber: 1 },
  title: 'Example.Show.S01.1080p.WEB', size: 40 * GB, sizeleft: 10 * GB, timeleft: '00:30:00',
  status: 'downloading', trackedDownloadStatus: 'ok', trackedDownloadState: 'downloading', statusMessages: [],
  downloadId: 'AAA', protocol: 'torrent', downloadClient: 'Example Client', indexer: 'Example Indexer',
  quality: { quality: { name: 'WEBDL-1080p' } },
  ...over,
})
/** A season pack: one row per episode, all sharing a downloadId and all reporting the whole pack. */
const pack = (n: number, over: any = {}) => Array.from({ length: n }, (_, i) => {
  const id = ++rowId
  return row({ ...over, id, episodeId: id, episode: { id, seasonNumber: over.seasonNumber ?? 1, episodeNumber: i + 1 } })
})

test('a 23-episode pack is 23 rows but one download, with one size and an episode range', () => {
  const rows = pack(23, { downloadId: 'PACK1' })
  assert.equal(collapseByDownload(rows).length, 1)
  const shows = groupSonarr(rows, NOW)
  assert.equal(shows.length, 1)
  const [season] = shows[0].seasons
  assert.equal(season.label, 'S01')
  assert.equal(season.downloads.length, 1)
  const d = season.downloads[0]
  assert.equal(d.episodes, 23)
  assert.equal(d.episodeRange, 'E01–E23')
  assert.equal(d.size, 40 * GB, 'the pack size is read once, not 23 times')
  assert.equal(d.sizeLeft, 10 * GB)
  assert.equal(d.progress, 75)
  assert.equal(d.etaSec, 1800)
  assert.equal(d.quality, 'WEBDL-1080p'); assert.equal(d.protocol, 'torrent'); assert.equal(d.client, 'Example Client')
  assert.equal(shows[0].sizeLeft, 10 * GB)
})

test('rows without a downloadId stay separate downloads', () => {
  const rows = [row({ downloadId: null }), row({ downloadId: null }), row({ downloadId: '' })]
  assert.equal(collapseByDownload(rows).length, 3)
})

test('seasons: two packs of one show are two season groups; a multi-season pack gets its own range label', () => {
  const rows = [
    ...pack(10, { downloadId: 'S1', seasonNumber: 1 }),
    ...pack(8, { downloadId: 'S2', seasonNumber: 2 }),
    row({ downloadId: 'S2b', seasonNumber: 2, episode: { id: 900, seasonNumber: 2, episodeNumber: 9 } }),
    ...[...pack(3, { downloadId: 'MULTI', seasonNumber: 3 }), ...pack(3, { downloadId: 'MULTI', seasonNumber: 4 })],
    ...pack(6, { downloadId: 'OTHER', seriesId: 2, series: { title: 'Another Show' } }),
  ]
  const shows = groupSonarr(rows, NOW)
  assert.deepEqual(shows.map(s => s.title).sort(), ['Another Show', 'Example Show'])
  const ex = shows.find(s => s.title === 'Example Show')!
  assert.deepEqual(ex.seasons.map(s => s.label).sort(), ['S01', 'S02', 'S03–S04'])
  const s2 = ex.seasons.find(s => s.label === 'S02')!
  assert.equal(s2.downloads.length, 2, 'a pack and a single episode in the same season')
  assert.equal(s2.episodes, 9)
  assert.equal(ex.downloads, 4)
  assert.equal(ex.episodes, 10 + 9 + 6)
})

test('episode ranges: runs, gaps, and a cut-off list', () => {
  assert.equal(episodeRange([3, 1, 2]), 'E01–E03')
  assert.equal(episodeRange([1, 2, 3, 5]), 'E01–E03, E05')
  assert.equal(episodeRange([7]), 'E07')
  assert.equal(episodeRange([1, 3, 5, 7, 9]), 'E01, E03, E05 +2 more')
  assert.equal(episodeRange([]), null)
})

test('time left: hh:mm:ss, d.hh:mm:ss, junk', () => {
  assert.equal(parseTimeLeft('00:12:34'), 754)
  assert.equal(parseTimeLeft('1.02:03:04'), 93784)
  assert.equal(parseTimeLeft(''), null); assert.equal(parseTimeLeft('soon'), null); assert.equal(parseTimeLeft('00:00:00'), null)
})

test('sorting: failed, blocked, stalled, warning, then soonest finished; shows and seasons alike', () => {
  const rows = [
    ...pack(2, { downloadId: 'OKFAST', seriesId: 1, series: { title: 'Fast Show' }, timeleft: '00:05:00', sizeleft: 5 * GB }),
    ...pack(2, { downloadId: 'OKSLOW', seriesId: 2, series: { title: 'Slow Show' }, timeleft: '05:00:00', sizeleft: 30 * GB }),
    ...pack(2, { downloadId: 'WARN', seriesId: 3, series: { title: 'Warned Show' }, status: 'warning', trackedDownloadStatus: 'warning', statusMessages: [{ title: 't', messages: ['Something odd'] }] }),
    ...pack(2, { downloadId: 'STALL', seriesId: 4, series: { title: 'Stalled Show' }, trackedDownloadStatus: 'warning', status: 'warning', timeleft: null, statusMessages: [{ title: 'x', messages: ['The download is stalled with no connections'] }] }),
    ...pack(2, { downloadId: 'BLOCK', seriesId: 5, series: { title: 'Blocked Show' }, trackedDownloadStatus: 'warning', trackedDownloadState: 'importBlocked', statusMessages: [{ title: 'Example.mkv', messages: ['No files found are eligible for import'] }] }),
    ...pack(2, { downloadId: 'FAIL', seriesId: 6, series: { title: 'Failed Show' }, status: 'failed', trackedDownloadStatus: 'error', trackedDownloadState: 'failedPending', errorMessage: 'Disk full' }),
  ]
  const shows = groupSonarr(rows, NOW)
  assert.deepEqual(shows.map(s => s.title), ['Failed Show', 'Blocked Show', 'Stalled Show', 'Warned Show', 'Fast Show', 'Slow Show'])
  assert.deepEqual(shows.slice(0, 4).map(s => s.problem), ['failed', 'blocked', 'stalled', 'warning'])
  assert.equal(shows[4].problem, null)
  const warned = shows[3].seasons[0].downloads[0]
  assert.deepEqual(warned.messages, ['Something odd'])
  assert.deepEqual(shows[0].seasons[0].downloads[0].messages, ['Disk full'])
  assert.equal(shows[2].seasons[0].downloads[0].etaSec, null, 'a stalled download has no ETA')

  const sum = summarize(shows, [], rows.length)
  assert.deepEqual({ d: sum.downloads, s: sum.shows, rows: sum.rows, att: sum.attention, st: sum.stalled, w: sum.warnings },
    { d: 6, s: 6, rows: 12, att: 2, st: 1, w: 1 })

  // Inside one season a problem pack sorts above a healthy one, whatever the order they arrived in.
  const mixed = groupSonarr([...pack(2, { downloadId: 'GOOD', timeleft: '00:01:00' }), ...pack(2, { downloadId: 'BAD', status: 'warning', trackedDownloadStatus: 'warning' })], NOW)
  assert.deepEqual(mixed[0].seasons[0].downloads.map(d => d.problem), ['warning', null])
})

test('movies: a flat list, collapsed, problems first', () => {
  const m = (id: number, over: any = {}) => ({
    id, movieId: id, movie: { title: `Film ${id}`, year: 2024 }, title: `Film.${id}.2024.1080p`, size: 8 * GB, sizeleft: 2 * GB,
    timeleft: '00:10:00', status: 'downloading', trackedDownloadStatus: 'ok', trackedDownloadState: 'downloading', statusMessages: [],
    downloadId: `M${id}`, protocol: 'usenet', downloadClient: 'Example Client', indexer: 'Example Indexer', quality: { quality: { name: 'Bluray-1080p' } }, ...over,
  })
  const movies = groupRadarr([m(1), m(2, { trackedDownloadStatus: 'warning', status: 'warning' }), m(3, { downloadId: 'M2' })], NOW)
  assert.equal(movies.length, 2, 'two rows with one downloadId are one download')
  assert.equal(movies[0].problem, 'warning')
  assert.equal(movies[1].title, 'Film 1')
  assert.equal(movies[1].year, 2024)
  assert.equal(movies[1].episodes, 0); assert.equal(movies[1].episodeRange, null)
  assert.equal(movies[1].progress, 75)
})

test('unknown series and bad rows do not break grouping', () => {
  const shows = groupSonarr([row({ seriesId: null, series: undefined, episode: undefined, seasonNumber: undefined }), null as any, 7 as any], NOW)
  assert.equal(shows.length, 1)
  assert.equal(shows[0].title, 'Unknown series')
  assert.equal(shows[0].seasons[0].label, 'Unknown season')
})

test('paging: every page is read, and a short total stops the loop', async () => {
  const asked: string[] = []
  const get = async (p: string) => {
    asked.push(p)
    const page = Number(/page=(\d+)/.exec(p)![1])
    const n = page < 3 ? 200 : 50
    return { totalRecords: 450, records: Array.from({ length: n }, (_, i) => ({ id: page * 1000 + i })) }
  }
  const all = await readAllQueue(get, 'sonarr')
  assert.equal(all.length, 450)
  assert.equal(asked.length, 3)
  assert.ok(asked.every(p => p.includes('pageSize=200') && p.includes('includeSeries=true') && p.includes('includeEpisode=true')))
  const radar: string[] = []
  await readAllQueue(async p => { radar.push(p); return { totalRecords: 0, records: [] } }, 'radarr')
  assert.ok(radar[0].includes('includeMovie=true') && !radar[0].includes('includeSeries'))
  assert.equal((await readAllQueue(async () => ({ records: [{ id: 1 }] }), 'radarr', 5)).length, 1, 'no total: stops when a page is not full of new rows')
})

test('one service down greys its own half only', () => {
  const d = buildQueueData({ sonarr: { rows: null, configured: true, error: 'HTTP 502' }, radarr: { rows: [], configured: false }, now: NOW })
  assert.deepEqual(d.services.sonarr, { ok: false, configured: true, error: 'HTTP 502' })
  assert.deepEqual(d.services.radarr, { ok: true, configured: false })
  assert.equal(d.summary.downloads, 0)
})

test('fast with a big queue: 600 rows of five shows collapse in well under a second', () => {
  const rows = Array.from({ length: 5 }, (_, i) => pack(120, { downloadId: `BIG${i}`, seriesId: 100 + i, series: { title: `Big ${i}` } })).flat()
  const t = Date.now()
  const shows = groupSonarr(rows, NOW)
  assert.ok(Date.now() - t < 500)
  assert.equal(shows.length, 5)
  assert.equal(summarize(shows, [], rows.length).rows, 600)
})

// ── route ────────────────────────────────────────────────────────────────────

test('roles: a viewer may read /queue; a write falls to admin', () => {
  assert.equal(requiredRole('GET', '/api/plugins/arrstack/queue'), 'viewer')
  assert.equal(requiredRole('POST', '/api/plugins/arrstack/queue'), 'admin')
})

test('route: signed in only, read-only, one shared reading per few seconds, no key or address in the answer', async () => {
  const KEY = 'sekret-api-key-0123456789abcdef'
  const askedS: string[] = [], askedR: string[] = []
  const client = (asked: string[], records: any[]): CoreEndpointClient => ({
    async get(p: string) { asked.push(p); return { totalRecords: records.length, records } },
  } as any)
  const sonarr = client(askedS, pack(23, { downloadId: 'PACK1', outputPath: '/data/secret/path', downloadClientHost: 'http://10.0.0.9:8080' }))
  const radarr = client(askedR, [{ id: 1, movie: { title: 'Paper Moons', year: 2026 }, title: 'Paper.Moons', size: GB, sizeleft: 0, downloadId: 'X', status: 'downloading', trackedDownloadStatus: 'ok', trackedDownloadState: 'importPending', statusMessages: [] }])
  let clock = NOW
  const a = Fastify({ logger: false })
  await registerGate(a)
  await a.register(authRoutes, { prefix: '/api/auth' })
  await a.register(buildArrQueueRoutes({ sonarr: async () => sonarr, radarr: async () => radarr, now: () => clock, ttlMs: 3000 }), { prefix: '/api/plugins/arrstack' })
  await a.ready()
  try {
    const anon = await a.inject({ method: 'GET', url: '/api/plugins/arrstack/queue' })
    assert.ok(anon.statusCode === 401 || anon.statusCode === 423, `no session: ${anon.statusCode}`)
    assert.equal(askedS.length + askedR.length, 0)

    const { cookie } = await signIn(a, 'viewer@example.com', 'viewer master password')
    const r = await a.inject({ method: 'GET', url: '/api/plugins/arrstack/queue', headers: { cookie } })
    assert.equal(r.statusCode, 200, r.body)
    const body = JSON.parse(r.body).data
    assert.equal(body.summary.downloads, 2); assert.equal(body.summary.rows, 24); assert.equal(body.summary.shows, 1)
    assert.equal(body.shows[0].seasons[0].downloads[0].episodeRange, 'E01–E23')
    assert.equal(body.movies[0].title, 'Paper Moons')
    assert.ok(!r.body.includes(KEY) && !/X-Api-Key|apikey/i.test(r.body))
    assert.ok(!r.body.includes('/data/secret') && !/https?:\/\//.test(r.body), 'no path, host or address is sent to the browser')
    assert.ok([...askedS, ...askedR].every(p => p.startsWith('/api/v3/queue?')), 'only reads of the queue')

    const n = askedS.length
    await a.inject({ method: 'GET', url: '/api/plugins/arrstack/queue', headers: { cookie } })
    await a.inject({ method: 'GET', url: '/api/plugins/arrstack/queue', headers: { cookie } })
    assert.equal(askedS.length, n, 'tabs inside the window share one upstream reading')
    clock += 4000
    await a.inject({ method: 'GET', url: '/api/plugins/arrstack/queue', headers: { cookie } })
    assert.ok(askedS.length > n, 'a fresh one after it')
  } finally { await a.close() }
})
