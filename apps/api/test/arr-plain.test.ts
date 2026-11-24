// Arr Stack queue in plain words: one line per show or film in the order the downloads really run, a status that never
// guesses an ETA for something that has not started, one needs-you entry per stuck item, and ONE reading behind every
// number (the queue route and the dashboard tile quote the same words). All titles and hashes are made up.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { buildArrQueueRoutes } from '../src/routes/arr-queue'
import { buildQueueData } from '../src/lib/arr-queue/logic'
import { buildPlain, etaWord, rateWord, type Torrent } from '../src/lib/arr-queue/plain'
import { ActionRefusal, planAction } from '../src/lib/arr-queue/actions'
import { arrstackPlugin } from '../src/plugins/arrstack'
import type { PluginContext } from '../src/lib/plugin-host'
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
const hash = (n: number) => String(n).padStart(40, 'a')

let rowId = 100
/** A Sonarr queue row, as Sonarr returns it with the series and episode. */
const row = (series: number, title: string, over: any = {}) => {
  const id = ++rowId
  return {
    id, seriesId: series, seasonNumber: 1, episodeId: id, series: { title }, episode: { id, seasonNumber: 1, episodeNumber: 1 },
    title: `${title.replace(/ /g, '.')}.S01.1080p.WEB`, size: 10 * GB, sizeleft: 5 * GB, timeleft: '00:30:00',
    status: 'downloading', trackedDownloadStatus: 'ok', trackedDownloadState: 'downloading', statusMessages: [],
    downloadId: hash(series).toUpperCase(), protocol: 'torrent', downloadClient: 'Example Client', indexer: 'Example Indexer',
    quality: { quality: { name: 'WEBDL-1080p' } }, ...over,
  }
}
const film = (n: number, title: string, over: any = {}) => ({
  id: ++rowId, movieId: n, movie: { id: n, title, year: 2026 }, title: title.replace(/ /g, '.'), size: 8 * GB, sizeleft: 4 * GB,
  status: 'downloading', trackedDownloadStatus: 'ok', trackedDownloadState: 'downloading', statusMessages: [],
  downloadId: hash(1000 + n).toUpperCase(), protocol: 'torrent', quality: { quality: { name: 'Bluray-1080p' } }, ...over,
})
const tor = (n: number, over: Partial<Record<string, unknown>> = {}): Torrent & Record<string, unknown> => ({ hash: hash(n), state: 'downloading', priority: 1, dlspeed: 2_000_000, eta: 14_040, ...over })
const queue = (sonarr: any[], radarr: any[] = []) => buildQueueData({ sonarr: { rows: sonarr, configured: true }, radarr: { rows: radarr, configured: true }, now: NOW })

test('rows come in qBittorrent queue order, and the status is plain: downloading with a real ETA, waiting with its place in line', () => {
  const q = queue([row(1, 'Alpha Show'), row(2, 'Beta Show'), row(3, 'Gamma Show'), row(4, 'Delta Show')], [film(5, 'Epsilon Film')])
  const torrents = [
    tor(3, { priority: 1 }),                                                         // Gamma runs first, 3.9 h to go
    tor(1, { priority: 2, state: 'queuedDL', dlspeed: 0, eta: 8_640_000 - 1 }),      // Alpha waits, and the client's multi-day guess must not show
    tor(1005, { priority: 3, state: 'queuedDL', dlspeed: 0, eta: 0 }),               // the film waits too
    tor(2, { priority: 4, state: 'queuedDL', dlspeed: 0, eta: 6_900_000 }),
  ]
  const p = buildPlain(q, { torrents, transfer: { dl_info_speed: 9_200_000, up_info_speed: 841_000 } })
  assert.deepEqual(p.items.map(i => i.title), ['Gamma Show', 'Alpha Show', 'Epsilon Film', 'Beta Show', 'Delta Show'], 'client queue order; unknown to the client last')
  assert.deepEqual(p.items.map(i => i.order), [1, 2, 3, 4, 5])
  const text = Object.fromEntries(p.items.map(i => [i.title, i.text]))
  assert.equal(text['Gamma Show'], 'downloading · 3.9 h')
  assert.equal(text['Alpha Show'], 'waiting · 1st in line')
  assert.equal(text['Epsilon Film'], 'waiting · 2nd in line')
  assert.equal(text['Beta Show'], 'waiting · 3rd in line')
  assert.ok(!/\d+(\.\d)? ?d\b/.test(JSON.stringify(p.items.map(i => i.text))), 'no "80.7d left" for something that has not started')
  assert.equal(p.items[0].line, null); assert.equal(p.items[1].line, 1)
})

test('a download that is moving but with a guess beyond two days reads just "downloading"', () => {
  const q = queue([row(1, 'Alpha Show')])
  const p = buildPlain(q, { torrents: [tor(1, { eta: 5 * 86_400 })], transfer: null })
  assert.equal(p.items[0].text, 'downloading')
  assert.equal(etaWord(2700), '45 min'); assert.equal(etaWord(14_040), '3.9 h'); assert.equal(etaWord(null), null); assert.equal(etaWord(3 * 86_400), null)
  assert.equal(rateWord(9_200_000), '9.2 MB/s'); assert.equal(rateWord(841_000), '841 KB/s'); assert.equal(rateWord(0), '0 KB/s')
})

test('the summary counts shows, films and artists, not episodes, rows or torrents, and says so', () => {
  // 3 shows: one of them is a 12-episode pack (12 rows, one download) and one is twenty singles. Plus 2 films.
  const pack = Array.from({ length: 12 }, (_, i) => { const r = row(1, 'Alpha Show', { downloadId: hash(1).toUpperCase() }); r.episode.episodeNumber = i + 1; return r })
  const singles = Array.from({ length: 20 }, (_, i) => row(2, 'Beta Show', { downloadId: hash(200 + i).toUpperCase(), size: GB, sizeleft: GB / 2 }))
  const q = queue([...pack, ...singles, row(3, 'Gamma Show')], [film(5, 'Epsilon Film'), film(6, 'Zeta Film')])
  const torrents = [tor(1), ...Array.from({ length: 20 }, (_, i) => tor(200 + i, { priority: 2 + i })), tor(3, { priority: 30 }), tor(1005, { priority: 31 }), tor(1006, { priority: 32, state: 'queuedDL', dlspeed: 0 })]
  const p = buildPlain(q, { torrents, transfer: { dl_info_speed: 9_200_000 } })
  assert.equal(p.summary.shows, 3); assert.equal(p.summary.films, 2)
  assert.equal(q.summary.rows, 12 + 20 + 1 + 2, 'the rows are what the old counts quoted')
  assert.equal(p.summary.downloading, 4, 'shows and films that are moving: Alpha, Beta, Gamma, Epsilon')
  assert.equal(p.summary.text, '3 shows · 2 films · 4 downloading now · 9.2 MB/s · nothing stuck')
  assert.match(p.summary.unit, /^Counted as shows and films\./, 'no word about music without Lidarr')
  assert.match(p.summary.unit, /season pack|single episodes/)
})

test('needs you: one entry per stuck show or film, a plain sentence, the fix that fits; nothing for a healthy or finished one', () => {
  const stalled = row(1, 'Alpha Show', { downloadId: hash(1).toUpperCase(), statusMessages: [{ title: 'x', messages: ['The download is stalled with no connections'] }] })
  const stalled2 = row(1, 'Alpha Show', { seasonNumber: 2, downloadId: hash(11).toUpperCase(), statusMessages: [{ title: 'x', messages: ['The download is stalled with no connections'] }] })
  const failed = row(2, 'Beta Show', { downloadId: hash(2).toUpperCase(), status: 'failed', trackedDownloadStatus: 'error', trackedDownloadState: 'failed', errorMessage: 'Download failed' })
  const blocked = film(5, 'Epsilon Film', { sizeleft: 0, trackedDownloadStatus: 'warning', trackedDownloadState: 'importBlocked', statusMessages: [{ title: 'x', messages: ['No files found are eligible for import'] }] })
  const fine = row(3, 'Gamma Show', { downloadId: hash(3).toUpperCase() })
  const p = buildPlain(queue([stalled, stalled2, failed, fine], [blocked]), { torrents: [tor(3)], transfer: null })
  const by = Object.fromEntries(p.needs.map(n => [n.title, n]))
  assert.deepEqual(Object.keys(by).sort(), ['Alpha Show', 'Beta Show', 'Epsilon Film'], 'the healthy show is not listed; a show with two stuck downloads is one entry')
  assert.equal(by['Alpha Show'].what, '2 downloads are stuck. Nobody is sharing them.')
  assert.equal(by['Alpha Show'].problemIds.length, 2)
  assert.equal(by['Beta Show'].what, 'The download failed.')
  assert.equal(by['Beta Show'].severity, 'bad')
  assert.equal(by['Epsilon Film'].blocked, true); assert.equal(by['Epsilon Film'].retryIds.length, 1, 'a blocked import can be tried again first')
  assert.equal(by['Alpha Show'].retryIds.length, 0)
  assert.deepEqual(p.needs.map(n => n.severity), ['bad', 'bad', 'warn'], 'failed and blocked before merely stalled')
  assert.equal(p.summary.stuck, 3)
  assert.match(p.summary.text, /3 stuck$/)
  // plain language: no client state, no release or quality jargon in anything the page prints up front
  const printed = JSON.stringify([p.needs.map(n => [n.what, n.title]), p.items.map(i => [i.text, i.detail]), p.summary.text])
  assert.ok(!/queuedDL|stalledDL|downloading_|WEBDL|Bluray|TorrentDownload|importBlocked|\.1080p/i.test(printed), printed)
})

test('requests that need a person are counted in the same "stuck", and nothing downloading still reads right', () => {
  const p = buildPlain(queue([], []), null, 2)
  assert.equal(p.summary.stuck, 2); assert.equal(p.summary.requestsStuck, 2); assert.equal(p.needs.length, 0)
  assert.equal(p.summary.text, 'Nothing downloading · 2 stuck')
  const quiet = buildPlain(queue([], []), null)
  assert.equal(quiet.summary.text, 'Nothing downloading'); assert.equal(quiet.summary.stuck, 0)
})

test('a finished download is "ready to clear", not stuck and not counted as downloading', () => {
  const done = film(7, 'Eta Film', { sizeleft: 0, trackedDownloadState: 'importPending', statusMessages: [{ title: 'x', messages: ['Movie file already imported'] }] })
  const q = buildQueueData({ sonarr: { rows: [], configured: true }, radarr: { rows: [done], configured: true, info: new Map([[7, { hasFile: true } as any]]) }, now: NOW })
  const p = buildPlain(q, null)
  assert.equal(p.items[0].state, 'done'); assert.equal(p.items[0].text, 'finished, ready to clear'); assert.equal(p.summary.stuck, 0); assert.equal(p.summary.done, 1)
})

// ── the actions the menu and the Fix button use ─────────────────────────────────────────────────────────────────

test('Fix (fix-many): a new copy for the downloads that still have a problem; a healthy or finished one is left alone and named', () => {
  const stalled = row(1, 'Alpha Show', { downloadId: hash(1).toUpperCase(), statusMessages: [{ title: 'x', messages: ['The download is stalled with no connections'] }] })
  const healthy = row(2, 'Beta Show', { downloadId: hash(2).toUpperCase() })
  const plan = planAction([stalled, healthy], { action: 'fix-many', instance: 'sonarr', downloadIds: [`d:${hash(1).toUpperCase()}`, `d:${hash(2).toUpperCase()}`, 'd:GONE'] })
  assert.equal(plan.items.length, 1); assert.equal(plan.blocklist, true); assert.equal(plan.commands[0].name, 'EpisodeSearch')
  assert.deepEqual(plan.skipped.map(s => s.reason).sort(), ['no longer has a problem', 'no longer in the queue'])
  assert.throws(() => planAction([healthy], { action: 'fix-many', instance: 'sonarr', downloadIds: [`d:${hash(2).toUpperCase()}`] }), (e: any) => e instanceof ActionRefusal && e.code === 'nothing_to_do')
})

test('Remove and Move to top take a whole show at once; each download is re-resolved from the fresh queue', () => {
  const a = row(1, 'Alpha Show', { downloadId: hash(1).toUpperCase() }), b = row(1, 'Alpha Show', { seasonNumber: 2, downloadId: hash(11).toUpperCase() })
  const ids = [`d:${hash(1).toUpperCase()}`, `d:${hash(11).toUpperCase()}`]
  const rm = planAction([a, b], { action: 'remove', instance: 'sonarr', downloadIds: ids, blocklist: false })
  assert.equal(rm.items.length, 2); assert.equal(rm.rowIds.length, 2); assert.equal(rm.blocklist, false)
  const top = planAction([a, b], { action: 'prioritise', instance: 'sonarr', downloadIds: ids })
  assert.deepEqual(top.qbitHashes, [hash(1), hash(11)])
  assert.throws(() => planAction([a], { action: 'remove', instance: 'sonarr', downloadIds: ['not an id'] }), (e: any) => e instanceof ActionRefusal)
  assert.throws(() => planAction([a], { action: 'remove', instance: 'sonarr', downloadIds: Array.from({ length: 51 }, (_, i) => `d:X${i}`) }), (e: any) => e.code === 'bad_request')
})

// ── one reading: the route and the dashboard tile quote the same words ───────────────────────────────────────────

test('the queue route and the dashboard tile use the same numbers and the same sentence (and the route carries no address or key)', async () => {
  const rowsS = [
    row(1, 'Alpha Show', { downloadId: hash(1).toUpperCase() }),
    row(2, 'Beta Show', { downloadId: hash(2).toUpperCase(), statusMessages: [{ title: 'x', messages: ['The download is stalled with no connections'] }] }),
    ...Array.from({ length: 6 }, (_, i) => { const r = row(3, 'Gamma Show', { downloadId: hash(3).toUpperCase() }); r.episode.episodeNumber = i + 1; return r }),
  ]
  const rowsR = [film(5, 'Epsilon Film', { downloadId: hash(1005).toUpperCase() })]
  const torrents = [tor(1, { priority: 1 }), tor(3, { priority: 2, state: 'queuedDL', dlspeed: 0 }), tor(1005, { priority: 3 }), tor(2, { priority: 4, state: 'stalledDL', dlspeed: 0 })]
  const endpoints: Record<string, (p: string) => any> = {
    default: p => (p.includes('queue') ? { totalRecords: rowsS.length, records: rowsS } : []),
    radarr: p => (p.includes('queue') ? { totalRecords: rowsR.length, records: rowsR } : []),
    qbit: p => (p.includes('transfer') ? { dl_info_speed: 9_200_000, up_info_speed: 841_000 } : torrents),
  }
  const client = (k: string) => ({ async get(p: string) { return endpoints[k](p) } }) as any
  const a = Fastify({ logger: false })
  await registerGate(a)
  await a.register(authRoutes, { prefix: '/api/auth' })
  await a.register(buildArrQueueRoutes({ sonarr: async () => client('default'), radarr: async () => client('radarr'), qbit: async () => client('qbit'), now: () => NOW, requestsStuck: () => 0 }), { prefix: '/api/plugins/arrstack' })
  await a.ready()
  try {
    const { cookie } = await signIn(a, 'viewer@example.com', 'viewer master password')
    const r = await a.inject({ method: 'GET', url: '/api/plugins/arrstack/queue', headers: { cookie } })
    assert.equal(r.statusCode, 200, r.body)
    const body = JSON.parse(r.body).data
    assert.equal(body.plain.summary.text, '3 shows · 1 film · 2 downloading now · 9.2 MB/s · 1 stuck')
    assert.equal(body.summary.rows, 9, 'the raw row count is still in the answer, for the Advanced tab')
    assert.ok(!/https?:\/\//.test(r.body) && !/X-Api-Key|apikey/i.test(r.body))

    const ctx = { get: async (p: string) => endpoints.default(p), post: async () => { throw new Error('read-only') }, option: () => undefined,
      from: (k: string) => ({ get: async (p: string) => endpoints[k](p), has: () => true, from: () => { throw new Error('no') } }), has: (k: string) => k in endpoints } as unknown as PluginContext
    const tile = await arrstackPlugin.load(ctx)
    assert.equal(tile.headline, body.plain.summary.text, 'the tile reads the very sentence the header shows')
    assert.ok(tile.rows.some(x => x.label === 'Needs you' && /1 item: Beta Show/.test(x.value)))
    assert.ok(tile.rows.some(x => x.label === 'Speed' && /^↓ 9\.2 MB\/s · ↑ 841 KB\/s$/.test(x.value)), 'the tile quotes the speed in the same units as the header')
    assert.ok(!tile.rows.some(x => x.label === 'Torrents'), 'no second, differently counted torrent line on the tile')
    assert.equal(tile.tone, 'warn')
  } finally { await a.close() }
})
