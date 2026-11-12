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
  buildQueueData, collapseByDownload, episodeRange, groupRadarr, groupSonarr, isDone, parseTimeLeft, readAllQueue, summarize,
} from '../src/lib/arr-queue/logic'
import { compareQuality, parseQuality, rangeText, whyRadarr, whySonarr, type FileInfo } from '../src/lib/arr-queue/why'
import { FileCache, readEpisodeInfo, readMovieInfo } from '../src/lib/arr-queue/lookup'
import { badgeOf, problemsOnly } from '../../frontend/components/plugins/arr/queue-view'
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
    assert.ok([...askedS, ...askedR].every(p => /^\/api\/v3\/(queue|episode|episodefile|moviefile)\?/.test(p)), 'only reads: the queue, and the episodes and files it covers')
    assert.equal(askedS.filter(p => p.startsWith('/api/v3/episode?')).length, 1, '23 queue rows = one batched episode request, not 23')

    const n = askedS.length
    await a.inject({ method: 'GET', url: '/api/plugins/arrstack/queue', headers: { cookie } })
    await a.inject({ method: 'GET', url: '/api/plugins/arrstack/queue', headers: { cookie } })
    assert.equal(askedS.length, n, 'tabs inside the window share one upstream reading')
    clock += 4000
    await a.inject({ method: 'GET', url: '/api/plugins/arrstack/queue', headers: { cookie } })
    assert.ok(askedS.length > n, 'a fresh one after it')
  } finally { await a.close() }
})

// ── review fixes: shared in-flight read, paths, anonymous rows ───────────────

test('route: a read slower than the TTL is shared by every request that arrives meanwhile (one upstream call)', async () => {
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const sonarr = { async get() { calls++; await gate; return { totalRecords: 0, records: [] } } } as any
  let clock = NOW
  const a = Fastify({ logger: false })
  await registerGate(a)
  await a.register(authRoutes, { prefix: '/api/auth' })
  await a.register(buildArrQueueRoutes({ sonarr: async () => sonarr, radarr: async () => null, now: () => clock, ttlMs: 3000 }), { prefix: '/api/plugins/arrstack' })
  await a.ready()
  try {
    const { cookie } = await signIn(a, 'viewer@example.com', 'viewer master password')
    const ask = () => a.inject({ method: 'GET', url: '/api/plugins/arrstack/queue', headers: { cookie } })
    const first = ask()
    await new Promise(r => setTimeout(r, 30))
    clock += 10_000 // far past the TTL while the first read is still running
    const second = ask(), third = ask()
    await new Promise(r => setTimeout(r, 30))
    release()
    const all = await Promise.all([first, second, third])
    assert.ok(all.every(r => r.statusCode === 200))
    assert.equal(calls, 1, 'one upstream read served all three')
  } finally { release(); await a.close() }
})

test('logic: paths in messages are replaced; a row with no id never collides with a real one', () => {
  const rows = [
    row({ downloadId: undefined, id: undefined, episodeId: 1 }),
    row({ downloadId: undefined, id: 0, episodeId: 2 }),
    row({ downloadId: undefined, id: undefined, episodeId: 3 }),
  ] as any[]
  assert.equal(collapseByDownload(rows).length, 3)
  const m = groupSonarr([row({ downloadId: 'Z', statusMessages: [{ title: 't', messages: ['No files found in /downloads/tv/Example.Show.S01 to import', 'Access to the path "/data/tv/x" is denied', 'C:\\Users\\x\\dl is full', 'and/or 1/2 ok'] }] })], NOW)[0].seasons[0].downloads[0].messages
  assert.ok(m.every(x => !/\/downloads|\/data|C:\\/.test(x)), m.join(' | '))
  assert.ok(m[0].includes('the download folder') && m[3] === 'and/or 1/2 ok')
})

/** What Sonarr would say about the episodes of `rows` when every one of them has a file. */
const haveAll = (rows: any[]) => new Map<number, FileInfo>(rows.filter(r => r.episodeId).map(r => [r.episodeId, { hasFile: true, quality: 'WEBDL-1080p', season: r.seasonNumber ?? 1, number: r.episode?.episodeNumber ?? null }]))
const G = (rows: any[]) => groupSonarr(rows, NOW, haveAll(rows))
const isDoneH = (rows: any[]) => isDone(rows, haveAll(rows))

// ── done: finished, and everything it covers is already in the library ──────────────────────────────────────────

const SUMMARY = 'One or more episodes expected in this release were not imported or missing from the release'
const ALREADY = 'Episode file already imported at 2026-05-01 10:00:00'
const NOT_UPGRADE = 'Not an upgrade for existing episode file(s). Existing quality: WEBDL-1080p. New Quality HDTV-1080p.'
/** A finished, import-blocked pack with the messages Sonarr gave for a complete pack that was already in the library. */
const donePack = (n: number, msgs: string[], over: any = {}) => pack(n, {
  downloadId: 'DONE1', title: 'Example.Show.S05.COMPLETE.1080p.HDTV', sizeleft: 0, timeleft: undefined,
  status: 'completed', trackedDownloadStatus: 'warning', trackedDownloadState: 'importBlocked',
  statusMessages: [
    { title: 'Example.Show.S05.COMPLETE.1080p.HDTV', messages: [SUMMARY] },
    { title: 'Example.Show.S05E01.1080p.HDTV', messages: [ALREADY, ALREADY] },
    { title: 'Example.Show.S05E02.1080p.HDTV', messages: [NOT_UPGRADE] },
    ...msgs.map(m => ({ title: 'Example.Show.S05E03.1080p.HDTV', messages: [m] })),
  ],
  ...over,
})

test('done: the exact already-imported / not-an-upgrade messages at 100% are done, not a problem, and counted apart', () => {
  const [show] = G(donePack(13, []))
  const d = show.seasons[0].downloads[0]
  assert.equal(d.done, true)
  assert.equal(d.problem, null)
  assert.equal(d.progress, 100)
  assert.ok(d.messages.length >= 2, 'the raw messages are kept for the Details section')
  assert.equal(show.done, true)
  assert.equal(show.problem, null)
  const sm = summarize([show], [], 13)
  assert.deepEqual([sm.done, sm.attention, sm.stalled, sm.warnings], [1, 0, 0, 0])
})

test('done: importPending counts the same as importBlocked', () => {
  assert.equal(isDoneH(donePack(3, [], { trackedDownloadState: 'importPending' })), true)
})

test('done: one other message ("No files found are eligible") keeps it a real problem', () => {
  const rows = donePack(13, ['No files found are eligible for import in /downloads/example'])
  assert.equal(isDoneH(rows), false)
  const d = groupSonarr(rows, NOW)[0].seasons[0].downloads[0]
  assert.equal(d.done, false)
  assert.equal(d.problem, 'blocked')
  const sm = summarize(groupSonarr(rows, NOW), [], 13)
  assert.deepEqual([sm.done, sm.attention], [0, 1])
})

test('done: other kinds of message (wrong match, permissions, sample, missing file) are never done', () => {
  for (const m of ['Found matching series via grab history, but release was matched to series by ID. Automatic import is not possible.',
    'Access to the path is denied', 'Sample', 'Episode file is missing', 'Unable to parse file']) {
    assert.equal(isDoneH(donePack(2, [m])), false, m)
  }
})

test('done: not at 100% is not done, even with the same messages', () => {
  assert.equal(isDoneH(donePack(5, [], { sizeleft: 1 * GB })), false)
  const d = groupSonarr(donePack(5, [], { sizeleft: 1 * GB }), NOW)[0].seasons[0].downloads[0]
  assert.equal(d.done, false)
  assert.equal(d.problem, 'blocked')
})

test('done: needs a blocked or pending import, a download that did not fail, no error text, and at least one per-file message', () => {
  assert.equal(isDoneH(donePack(2, [], { trackedDownloadState: 'downloading' })), false)
  assert.equal(isDoneH(donePack(2, [], { status: 'failed' })), false)
  assert.equal(isDoneH(donePack(2, [], { errorMessage: 'Disk full' })), false)
  assert.equal(isDoneH(donePack(2, [], { statusMessages: [{ title: 'x', messages: [SUMMARY] }] })), false, 'a summary line alone says nothing was handled')
  assert.equal(isDoneH(donePack(2, [], { statusMessages: [] })), false)
  assert.equal(isDoneH([]), false)
})

test('done: a Radarr movie with the same two kinds of message is done', () => {
  const m = { id: 9, movieId: 5, movie: { id: 5, title: 'Example Movie', year: 2020 }, title: 'Example.Movie.2020.1080p', size: 8 * GB, sizeleft: 0, status: 'completed',
    trackedDownloadStatus: 'warning', trackedDownloadState: 'importBlocked', downloadId: 'M1', protocol: 'torrent',
    statusMessages: [{ title: 'Example.Movie.2020.1080p', messages: ['Movie file already imported at 2026-05-01', 'Not an upgrade for existing movie file(s). Existing quality: Bluray-1080p.'] }] }
  const [mv] = groupRadarr([m], NOW, new Map([[5, { hasFile: true, quality: 'Bluray-1080p', season: null, number: null }]]))
  assert.equal(mv.done, true)
  assert.equal(mv.problem, null)
})

test('done: sorts after every real problem and before ordinary downloads', () => {
  const fine = row({ seriesId: 1, series: { title: 'Aaa Show' }, downloadId: 'FINE' })
  const dn = donePack(2, [], { seriesId: 2, series: { title: 'Bbb Show' } })
  const warn = row({ seriesId: 3, series: { title: 'Ccc Show' }, downloadId: 'W', trackedDownloadStatus: 'warning' })
  const bad = row({ seriesId: 4, series: { title: 'Ddd Show' }, downloadId: 'B', trackedDownloadState: 'importBlocked', trackedDownloadStatus: 'warning', statusMessages: [{ title: 'x', messages: ['No files found are eligible for import'] }] })
  assert.deepEqual(G([fine, ...dn, warn, bad]).map(x => x.title), ['Ddd Show', 'Ccc Show', 'Bbb Show', 'Aaa Show'])
})

// ── done never colours its season or show; the Problems filter shows only real problems ────────────────────────────

const mixedShow = () => [
  ...donePack(3, [], { seriesId: 7, series: { title: 'Example Show' }, seasonNumber: 5, downloadId: 'LEFTOVER' }),
  ...pack(4, { seriesId: 7, series: { title: 'Example Show' }, seasonNumber: 3, downloadId: 'LIVE', sizeleft: 31 * GB }),
]

test('roll-up: a show whose only leftover is done has no problem; its done season says so and the show counts it ready', () => {
  const [show] = G(mixedShow())
  assert.equal(show.problem, null, 'no red show badge')
  const s5 = show.seasons.find(x => x.label === 'S05')!, s3 = show.seasons.find(x => x.label === 'S03')!
  assert.equal(s5.problem, null)
  assert.equal(s5.done, true)
  assert.equal(s3.done, false)
  assert.equal(show.done, false)
  assert.deepEqual(badgeOf(s5.problem, s5.downloads), { kind: 'done', ready: 1 })
  assert.equal(badgeOf(s3.problem, s3.downloads), null)
  assert.deepEqual(badgeOf(show.problem, show.seasons.flatMap(x => x.downloads)), { kind: 'ready', ready: 1 }, 'neutral: a ready count, never a problem')
})

test('roll-up: a real problem still colours the show, and a done sibling only adds its ready count', () => {
  const bad = pack(2, { seriesId: 7, series: { title: 'Example Show' }, seasonNumber: 3, downloadId: 'BAD', trackedDownloadState: 'importBlocked', trackedDownloadStatus: 'warning', statusMessages: [{ title: 'x', messages: ['No files found are eligible for import'] }] })
  const [show] = G([...donePack(3, [], { seriesId: 7, series: { title: 'Example Show' }, seasonNumber: 5 }), ...bad])
  assert.equal(show.problem, 'blocked')
  assert.deepEqual(badgeOf(show.problem, show.seasons.flatMap(x => x.downloads)), { kind: 'problem', problem: 'blocked', ready: 1 })
  assert.equal(show.seasons.find(x => x.label === 'S05')!.problem, null, 'the done season is not red')
})

test('Problems filter: shows only shows with a real problem, and under them only the problem seasons and downloads', () => {
  const bad = pack(2, { seriesId: 8, series: { title: 'Other Show' }, seasonNumber: 1, downloadId: 'BAD', trackedDownloadState: 'importBlocked', trackedDownloadStatus: 'warning', statusMessages: [{ title: 'x', messages: ['No files found are eligible for import'] }] })
  const healthy = pack(2, { seriesId: 9, series: { title: 'Third Show' }, downloadId: 'OK3' })
  const shows = G([...mixedShow(), ...bad, ...pack(3, { seriesId: 8, series: { title: 'Other Show' }, seasonNumber: 2, downloadId: 'OK2' }), ...healthy])
  const only = problemsOnly(shows)
  assert.deepEqual(only.map(x => x.title), ['Other Show'], 'the done-only show and the healthy show are gone')
  const [o] = only
  assert.equal(o.seasons.length, 1)
  assert.equal(o.seasons[0].label, 'S01')
  assert.ok(o.seasons[0].downloads.every(d => d.problem !== null))
  assert.deepEqual(o.scope, { seasons: 1, totalSeasons: 2, downloads: 1, totalDownloads: 2 })
  assert.equal(o.downloads, 2, 'the show totals still count the whole show')
  assert.equal(o.problem, 'blocked')
  assert.equal(shows.find(x => x.title === 'Other Show')!.seasons.length, 2, 'the input is not changed')
})

// ── why this download ────────────────────────────────────────────────────────────────────────────────────────────

const F = (q: string | null, n: number, over: Partial<FileInfo> = {}): FileInfo => ({ hasFile: q !== null, quality: q, season: 1, number: n, ...over })

test('quality rank: resolution first, then Bluray > WEB-DL > WEBRip > HDTV; Remux above Bluray', () => {
  const r = (n: string) => parseQuality(n)!
  assert.ok(compareQuality(r('Bluray-1080p'), r('WEBDL-1080p')) > 0)
  assert.ok(compareQuality(r('WEBDL-1080p'), r('WEBRip-1080p')) > 0)
  assert.ok(compareQuality(r('WEBRip-1080p'), r('HDTV-1080p')) > 0)
  assert.ok(compareQuality(r('Bluray-1080p Remux'), r('Bluray-1080p')) > 0)
  assert.ok(compareQuality(r('WEBDL-1080p'), r('Bluray-720p')) > 0, 'resolution beats source')
  assert.equal(compareQuality(r('WEBDL-1080p'), r('WEBDL-1080p')), 0)
  assert.equal(parseQuality('Unknown'), null)
  assert.equal(parseQuality(null), null)
})

test('range grouping: consecutive runs join, gaps split, seasons only when more than one', () => {
  const e = (n: number, season = 1) => ({ season, number: n })
  assert.equal(rangeText([e(3), e(1), e(2), e(5)], false), 'E01–E03, E05')
  assert.equal(rangeText([e(10), e(9)], false), 'E09–E10')
  assert.equal(rangeText([e(1, 1), e(2, 1), e(1, 2)], true), 'S01E01–E02, S02E01')
  assert.equal(rangeText([e(1), e(3), e(5), e(7), e(9), e(11)], false), 'E01, E03, E05, E07 +2 more')
})

test('why: fills, upgrades (resolution), may replace (source only), already have, with ranges', () => {
  const info = new Map<number, FileInfo>([
    [1, F(null, 1)], [2, F('WEBDL-720p', 2)],
    ...[3, 4, 5].map(n => [n, F('WEBDL-1080p', n)] as [number, FileInfo]),
    [6, F('Bluray-1080p', 6)], [7, F('Bluray-1080p', 7)],
  ])
  const t = whySonarr([1, 2, 3, 4, 5, 6, 7], info, 'Bluray-1080p', false)!
  assert.equal(t, 'Fills E01 · upgrades E02 (720p → 1080p) · may replace E03–E05 (WEB-DL → Bluray) · already have E06–E07 (will be skipped)')
})

test('why: Bluray on disk beats a WEB-DL release (already have); a WEB-DL on disk loses to Bluray', () => {
  assert.equal(whySonarr([1], new Map([[1, F('Bluray-1080p', 1)]]), 'WEBDL-1080p', false), 'Already have E01 (will be skipped)')
  assert.equal(whySonarr([1], new Map([[1, F('WEBDL-1080p', 1)]]), 'Bluray-1080p', false), 'May replace E01 (WEB-DL → Bluray)')
})

test('why: nothing known gives no line; unknown qualities are left out rather than guessed', () => {
  assert.equal(whySonarr([1, 2], new Map(), 'Bluray-1080p', false), null)
  assert.equal(whySonarr([1], new Map([[1, F('Unknown', 1)]]), 'Bluray-1080p', false), null)
})

test('why: a done download tells the outcome from the current files', () => {
  const info = new Map<number, FileInfo>([
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => [n, F('HDTV-1080p', n)] as [number, FileInfo]),
    ...[10, 11, 12, 13].map(n => [n, F('WEBDL-1080p', n)] as [number, FileInfo]),
  ])
  assert.equal(whySonarr([...info.keys()], info, 'HDTV-1080p', true), 'Imported 9 · kept 4 better copies; nothing left to import.')
  assert.equal(whySonarr([10], info, 'HDTV-1080p', true), 'Kept 1 better copy; nothing left to import.')
})

test('why: Radarr gives one line: missing film, upgrade, already have, and the done outcome', () => {
  const m = (q: string | null) => ({ hasFile: q !== null, quality: q, season: null, number: null })
  assert.equal(whyRadarr(m(null), 'Bluray-1080p', false), 'Missing film: this will fill it.')
  assert.equal(whyRadarr(m('WEBDL-1080p'), 'Bluray-2160p', false), 'Upgrades 1080p WEB-DL → 2160p Bluray.')
  assert.equal(whyRadarr(m('Bluray-1080p'), 'WEBDL-1080p', false), 'Already have 1080p Bluray: this will be skipped.')
  assert.equal(whyRadarr(m('Bluray-1080p'), 'WEBDL-1080p', true), 'Kept your better copy (1080p Bluray); nothing left to import.')
  assert.equal(whyRadarr(undefined, 'WEBDL-1080p', false), null)
})

test('why: it lands on every download in the grouped queue, and done ones get the outcome', () => {
  const rows = [...mixedShow().map(r => ({ ...r, quality: { quality: { name: 'HDTV-1080p' } } }))]
  const info = new Map<number, FileInfo>()
  for (const r of rows) info.set(r.episodeId, F(r.seasonNumber === 5 ? 'WEBDL-1080p' : null, r.episode.episodeNumber, { season: r.seasonNumber }))
  const [show] = groupSonarr(rows, NOW, info)
  const live = show.seasons.find(x => x.label === 'S03')!.downloads[0], dn = show.seasons.find(x => x.label === 'S05')!.downloads[0]
  assert.match(live.why!, /^Fills S03E01–E04$|^Fills E01–E04$/)
  assert.equal(dn.why, 'Kept 3 better copies; nothing left to import.')
  assert.equal(groupSonarr(rows, NOW)[0].seasons[0].downloads[0].why, null, 'no lookup, no line')
})

test('lookup: episodes batched by 100, files batched and cached by id for a minute, never one request per row', async () => {
  const eps = Array.from({ length: 230 }, (_, i) => ({ id: i + 1, seasonNumber: 1, episodeNumber: i + 1, hasFile: i % 2 === 0, episodeFileId: i % 2 === 0 ? 5000 + i : 0 }))
  const rows = eps.map(e => ({ episodeId: e.id }))
  const calls: string[] = []
  const get = async (p: string) => {
    calls.push(p)
    const ids = [...p.matchAll(/=(\d+)/g)].map(m => Number(m[1]))
    if (p.startsWith('/api/v3/episode?')) return eps.filter(e => ids.includes(e.id))
    return ids.map(id => ({ id, quality: { quality: { name: 'WEBDL-1080p' } } }))
  }
  const cache = new FileCache(60_000)
  const info = await readEpisodeInfo(get, rows, 1000, cache)
  assert.equal(info.size, 230)
  assert.equal(info.get(1)!.quality, 'WEBDL-1080p')
  assert.equal(info.get(2)!.hasFile, false)
  assert.equal(calls.filter(c => c.startsWith('/api/v3/episode?')).length, 3, '230 episodes = 3 requests')
  assert.equal(calls.filter(c => c.startsWith('/api/v3/episodefile?')).length, 2, '115 files = 2 requests')
  calls.length = 0
  await readEpisodeInfo(get, rows, 1000 + 30_000, cache)
  assert.equal(calls.filter(c => c.startsWith('/api/v3/episodefile?')).length, 0, 'files come from the cache within a minute')
  await readEpisodeInfo(get, rows, 1000 + 61_000, cache)
  assert.equal(calls.filter(c => c.startsWith('/api/v3/episodefile?')).length, 2, 'and are read again after it')
})

test('lookup: a failing lookup yields nothing and never throws; Radarr reads only film files', async () => {
  const boom = async () => { throw new Error('HTTP 500') }
  assert.equal((await readEpisodeInfo(boom, [{ episodeId: 1 }], 0, new FileCache())).size, 0)
  const calls: string[] = []
  const get = async (p: string) => { calls.push(p); return [{ id: 77, quality: { quality: { name: 'Bluray-1080p' } } }] }
  const info = await readMovieInfo(get, [{ movieId: 5, movie: { id: 5, hasFile: true, movieFileId: 77 } }, { movieId: 6, movie: { id: 6, hasFile: false } }], 0, new FileCache())
  assert.deepEqual(calls, ['/api/v3/moviefile?movieFileIds=77'])
  assert.equal(info.get(5)!.quality, 'Bluray-1080p')
  assert.equal(info.get(6)!.hasFile, false)
})

// ── an incomplete pack is not done ───────────────────────────────────────────────────────────────────────────────

/** A release named as a whole season that covers E01–E58 in the queue but held only five two-episode files (E01–E10). */
const incompletePack = () => {
  const rows = pack(58, {
    downloadId: 'BIG1', seriesId: 3, series: { title: 'Example Show' }, seasonNumber: 2, title: 'Example.Show.S02.1080p.WEB', sizeleft: 0,
    status: 'completed', trackedDownloadStatus: 'warning', trackedDownloadState: 'importBlocked',
    statusMessages: [
      { title: 'Example.Show.S02.1080p.WEB', messages: [SUMMARY] },
      ...['S02E01E02', 'S02E03E04', 'S02E05E06', 'S02E07E08', 'S02E09E10'].map(e => ({ title: `Example.Show.${e}.1080p.WEB`, messages: [ALREADY] })),
    ],
  })
  // E01–E10 are in the library, and so are E11–E18 from elsewhere; the other 40 have no file.
  const info = new Map<number, FileInfo>(rows.map((r, i) => [r.episodeId, { hasFile: i < 18, quality: i < 18 ? 'WEBDL-1080p' : null, season: 2, number: i + 1 }]))
  return { rows, info }
}

test('incomplete pack: every message says "already imported" but 40 of 58 episodes have no file: a real problem with its explanation', () => {
  const { rows, info } = incompletePack()
  assert.equal(isDone(rows, info), false)
  const [show] = groupSonarr(rows, NOW, info)
  const d = show.seasons[0].downloads[0]
  assert.equal(d.done, false)
  assert.equal(d.problem, 'incomplete')
  assert.equal(d.why, "This release claims S02 (E01–E58) but only contained E01–E10; 40 episodes are still missing and won't be searched while it sits here.")
  assert.equal(show.problem, 'incomplete', 'it colours its season and show')
  const sm = summarize([show], [], 58)
  assert.deepEqual([sm.done, sm.attention], [0, 1])
})

test('done needs the files: the same messages with every episode filed are done; with no lookup nothing is vouched for', () => {
  const { rows } = incompletePack()
  assert.equal(isDone(rows, haveAll(rows)), true)
  assert.equal(isDone(rows), false, 'no lookup, no claim')
  assert.equal(isDone(rows, new Map()), false, 'episodes that could not be looked up are not vouched for')
  const partial = haveAll(rows); partial.delete(rows[0].episodeId)
  assert.equal(isDone(rows, partial), false)
  const [show] = groupSonarr(rows, NOW)
  assert.equal(show.seasons[0].downloads[0].problem, 'blocked', 'without a lookup it stays an ordinary blocked import')
})
