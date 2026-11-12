// Arr Stack, Lidarr (music): queue collapse and Artist → Album → download grouping, the done and incomplete
// classification with Lidarr's wording, "why this download", actions (API v1, AlbumSearch, role and token refusals),
// Upcoming albums, settings and the Overview numbers, and that no key or address reaches the browser.
// Fixtures follow the Lidarr v1 shapes (/api/v1/queue with includeArtist and includeAlbum, /api/v1/album,
// /api/v1/trackfile, /api/v1/calendar). All names are made up.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { requiredRole, needsReconfirm } from '../src/lib/roles'
import { buildArrQueueRoutes } from '../src/routes/arr-queue'
import { buildArrUpcomingRoutes, readUpcoming } from '../src/routes/arr-upcoming'
import {
  buildQueueData, collapseByDownload, groupLidarr, isDoneMusic, isIncompleteMusic, messagesSayDone, readAllQueue, summarize,
} from '../src/lib/arr-queue/logic'
import { compareAudio, parseAudioQuality, whyIncompleteLidarr, whyLidarr, type AlbumInfo } from '../src/lib/arr-queue/why'
import { FileCache, readAlbumInfo } from '../src/lib/arr-queue/lookup'
import { ActionRefusal, planAction, runAction, searchCommands, mergeCommands, type ActionDeps, type ActionRequest } from '../src/lib/arr-queue/actions'
import { arrArtKey, arrArtUpstream, artRef } from '../src/lib/arr-upcoming/art'
import { lidarrMissing, musicItems, queueIndex, groupItems } from '../src/lib/arr-upcoming/logic'
import { arrstackPlugin, buildArrVisual, musicCounts } from '../src/plugins/arrstack'
import { describeSettings, missingSettings, settingsChangeProblem, type PluginContext } from '../src/lib/plugin-host'
import { PROBES } from '../src/lib/discovery'
import { badgeOf, problemsOnlyMusic } from '../../frontend/components/plugins/arr/queue-view'
import type { CoreEndpointClient } from '../src/lib/plugin-host'
import { signIn } from './fakes/app'
import { FakeBroker } from './fakes/fake-broker'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { setAuditSink } from '../src/lib/audit'
import { MemoryApiTokenStore, setApiTokenStore, createApiToken, tokenForbidden } from '../src/lib/api-tokens'
import { MissLimiter } from '../src/lib/plex-art'

const KEY = 'lidarr-secret-key-0123456789abcdef'
const ADDR = 'http://music.example.test:8686'
const broker = new FakeBroker()
broker.addUser('viewer@example.com', 'viewer master password', 'viewer')
broker.addUser('operator@example.com', 'operator master password', 'operator')
broker.addUser('admin@example.com', 'admin master password', 'admin')
broker.items.set('hyperprox:plugin/arrstack', { id: 'p1', name: 'hyperprox:plugin/arrstack', fields: { sonarr_url: 'http://tv.example.test:8989', sonarr_key: 'sonarr-secret', lidarr_url: ADDR, lidarr_key: KEY } })
let store: MemoryApiTokenStore
before(() => {
  setBroker(broker)
  store = new MemoryApiTokenStore()
  setApiTokenStore(store)
  setAuditSink({ async write() {} })
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
})
after(async () => { setApiTokenStore(null); setAuditSink(null); if (isUnlocked()) await lock('manual') })

const NOW = Date.parse('2026-06-15T12:00:00Z')
const MB = 1e6

// ── fixtures: the Lidarr v1 shapes ───────────────────────────────────────────

let rid = 7000
/** One /api/v1/queue record, with includeArtist and includeAlbum. One record per album. */
const lrow = (over: any = {}) => {
  const id = over.id ?? ++rid
  const albumId = over.albumId ?? id
  const artistId = over.artistId ?? 7
  return {
    id, artistId, albumId,
    artist: { id: artistId, artistName: 'Example Artist', foreignArtistId: '00000000-0000-0000-0000-000000000001', monitored: true },
    album: { id: albumId, title: `Example Album ${albumId}`, artistId, albumType: 'Album', releaseDate: '2026-01-01T00:00:00Z', monitored: true },
    quality: { quality: { id: 6, name: 'FLAC' }, revision: { version: 1, real: 0, isRepack: false } },
    size: 400 * MB, title: 'Example Artist - Example Album (2026) FLAC', sizeleft: 100 * MB, timeleft: '00:10:00',
    estimatedCompletionTime: '2026-06-15T12:10:00Z', status: 'downloading',
    trackedDownloadStatus: 'ok', trackedDownloadState: 'downloading', statusMessages: [],
    downloadId: `LID${id}`, protocol: 'torrent', downloadClient: 'Example Client', indexer: 'Example Indexer',
    outputPath: '/downloads/example', downloadClientHasPostImportCategory: false, trackFileCount: 0, trackHasFileCount: 0,
    ...over,
  }
}
/** A discography release: one record per album, all sharing a downloadId and all reporting the whole release's size. */
const discography = (albumIds: number[], over: any = {}) => albumIds.map(a => lrow({ ...over, albumId: a, id: ++rid }))

/** The three messages Lidarr gives a finished download whose tracks are already in the library. */
const DONE_MESSAGES = [
  { title: 'Example Artist - Track 01.flac', messages: ['Track file already imported at 2026-05-01'] },
  { title: 'Example Artist - Track 02.flac', messages: ['Not an upgrade for existing track file(s). Existing quality: FLAC. New Quality FLAC.'] },
]
const doneRow = (over: any = {}) => lrow({ sizeleft: 0, timeleft: '00:00:00', status: 'completed', trackedDownloadStatus: 'warning', trackedDownloadState: 'importBlocked', statusMessages: DONE_MESSAGES, ...over })

const albumInfo = (total: number | null, have: number, files: Array<[string | null, number]> = [], title: string | null = 'Example Album'): AlbumInfo =>
  ({ title, total, have, files: files.map(([quality, count]) => ({ quality, count })) })

/** A fake Lidarr: v1 only, its queue read ignores every query parameter, and any v3 path is an error. */
function fakeLidarr(rows: any[], albums: Record<number, { total: number; have: number; files?: Array<[string, number]>; title?: string }> = {}) {
  const log = { gets: [] as string[], deletes: [] as Array<{ p: string; ids: number[] }>, posts: [] as Array<{ p: string; body: any }> }
  const ids = (p: string, name: string) => [...p.matchAll(new RegExp(`${name}=(\\d+)`, 'g'))].map(m => Number(m[1]))
  const client: CoreEndpointClient = {
    async get(p: string) {
      log.gets.push(p)
      if (!p.startsWith('/api/v1/')) throw new Error(`Lidarr has no ${p}`)
      if (p.startsWith('/api/v1/album?')) {
        return ids(p, 'albumIds').filter(i => albums[i]).map(i => ({ id: i, title: albums[i].title ?? `Example Album ${i}`, statistics: { trackCount: albums[i].total, totalTrackCount: albums[i].total, trackFileCount: albums[i].have, sizeOnDisk: albums[i].have * 30 * MB } }))
      }
      if (p.startsWith('/api/v1/trackfile?')) {
        return ids(p, 'albumId').flatMap(i => (albums[i]?.files ?? []).flatMap(([q, n]) => Array.from({ length: n }, (_, k) => ({ id: i * 100 + k, albumId: i, quality: { quality: { name: q } } }))))
      }
      return { totalRecords: rows.length, records: rows.slice() }
    },
    async deleteBody(p: string, body: any) {
      log.deletes.push({ p, ids: body.ids })
      for (const id of body.ids) { const i = rows.findIndex(r => r.id === id); if (i >= 0) rows.splice(i, 1) }
      return null
    },
    async post(p: string, body: any) { log.posts.push({ p, body }); return { id: log.posts.length } },
  } as any
  return { client, log, rows }
}
const mkDeps = (l: any, audits: any[] = [], q: any = null): ActionDeps => ({
  sonarr: async () => null, radarr: async () => null, lidarr: async () => l, qbit: async () => q,
  audit: async (action, details) => { audits.push({ action, details }) },
})
const lreq = (o: Partial<ActionRequest> & { action: ActionRequest['action'] }): ActionRequest => ({ instance: 'lidarr', ...o })
const refusal = async (p: Promise<unknown>, code: string) => {
  await assert.rejects(p, (e: any) => e instanceof ActionRefusal && e.code === code, `expected ${code}`)
}

// ── queue: collapse and grouping ─────────────────────────────────────────────

test('a discography release is several rows but one download, sized once, under one artist', () => {
  const rows = discography([11, 12, 13], { downloadId: 'DISCO1', title: 'Example Artist - Discography FLAC', size: 3000 * MB, sizeleft: 750 * MB })
  assert.equal(collapseByDownload(rows).length, 1)
  const [artist] = groupLidarr(rows, NOW)
  assert.equal(artist.title, 'Example Artist')
  assert.equal(artist.downloads, 1)
  assert.equal(artist.albumCount, 3)
  const [album] = artist.albums
  assert.equal(album.downloads.length, 1)
  const d = album.downloads[0]
  assert.equal(d.albums, 3)
  assert.equal(d.size, 3000 * MB, 'the release size is read once, not three times')
  assert.equal(d.sizeLeft, 750 * MB)
  assert.equal(d.progress, 75)
  assert.equal(d.etaSec, 600)
  assert.equal(d.episodes, 0); assert.equal(d.episodeRange, null)
  assert.equal(d.quality, 'FLAC'); assert.equal(d.protocol, 'torrent'); assert.equal(d.client, 'Example Client')
  assert.match(album.title, /Example Album 11, Example Album 12|\+2 more|Example Album 11/)
})

test('Artist → Album → download: two artists, two downloads of one album, a single of another', () => {
  const rows = [
    lrow({ albumId: 21, downloadId: 'A1' }), lrow({ albumId: 21, downloadId: 'A2', title: 'Example Artist - Example Album 21 MP3 320' }),
    lrow({ albumId: 22, downloadId: 'A3' }),
    lrow({ artistId: 8, artist: { id: 8, artistName: 'Another Artist' }, albumId: 31, album: { id: 31, title: 'Other Record' }, downloadId: 'B1' }),
  ]
  const artists = groupLidarr(rows, NOW)
  assert.deepEqual(artists.map(a => a.title).sort(), ['Another Artist', 'Example Artist'])
  const ex = artists.find(a => a.title === 'Example Artist')!
  assert.equal(ex.albums.length, 2)
  assert.equal(ex.albums.find(a => a.key === '21')!.downloads.length, 2, 'two downloads of the same album sit together')
  assert.equal(ex.downloads, 3)
  const s = summarize([], [], rows.length, artists)
  assert.deepEqual({ d: s.downloads, a: s.artists, al: s.albums, rows: s.rows, shows: s.shows, movies: s.movies }, { d: 4, a: 2, al: 3, rows: 4, shows: 0, movies: 0 })
})

test('rows without a downloadId stay separate; bad rows and an unknown artist do not break grouping', () => {
  assert.equal(collapseByDownload([lrow({ downloadId: null }), lrow({ downloadId: '' })]).length, 2)
  const artists = groupLidarr([lrow({ artistId: null, artist: undefined, albumId: null, album: undefined, downloadId: 'X' }), null as any, 3 as any], NOW)
  assert.equal(artists.length, 1)
  assert.equal(artists[0].title, 'Unknown artist')
  assert.equal(artists[0].albums[0].title, 'Unknown album')
})

test('problems sort first and colour the artist and album; a done download never does', () => {
  const rows = [
    lrow({ artistId: 1, artist: { id: 1, artistName: 'Zed Fine' }, albumId: 41, downloadId: 'OK' }),
    lrow({ artistId: 2, artist: { id: 2, artistName: 'Yan Stalled' }, albumId: 42, downloadId: 'ST', trackedDownloadStatus: 'warning', status: 'warning', statusMessages: [{ title: 'x', messages: ['The download is stalled with no connections'] }] }),
    lrow({ artistId: 3, artist: { id: 3, artistName: 'Xan Failed' }, albumId: 43, downloadId: 'FA', status: 'failed', trackedDownloadStatus: 'error', trackedDownloadState: 'failedPending', errorMessage: 'Disk full' }),
    lrow({ artistId: 4, artist: { id: 4, artistName: 'Wen Blocked' }, albumId: 44, downloadId: 'BL', trackedDownloadStatus: 'warning', trackedDownloadState: 'importBlocked', statusMessages: [{ title: 'a.flac', messages: ['No audio files were found that are eligible for import'] }] }),
  ]
  const artists = groupLidarr(rows, NOW)
  assert.deepEqual(artists.map(a => a.title), ['Xan Failed', 'Wen Blocked', 'Yan Stalled', 'Zed Fine'])
  assert.deepEqual(artists.map(a => a.problem), ['failed', 'blocked', 'stalled', null])
  const only = problemsOnlyMusic(artists)
  assert.deepEqual(only.map(a => a.title), ['Xan Failed', 'Wen Blocked', 'Yan Stalled'])
  assert.deepEqual(only[0].scope, { albums: 1, totalAlbums: 1, downloads: 1, totalDownloads: 1 })
  const info = new Map<number, AlbumInfo>([[51, albumInfo(10, 10, [['FLAC', 10]])]])
  const d = groupLidarr([doneRow({ albumId: 51, downloadId: 'D' })], NOW, info)[0]
  assert.equal(d.done, true)
  assert.equal(badgeOf(d.problem, d.albums.flatMap(a => a.downloads)) && (badgeOf(d.problem, d.albums.flatMap(a => a.downloads)) as any).kind, 'done')
})

test('paging: v1 path, artist and album included, every page read', async () => {
  const asked: string[] = []
  const get = async (p: string) => {
    asked.push(p)
    const page = Number(/page=(\d+)/.exec(p)![1])
    return { totalRecords: 250, records: Array.from({ length: page === 1 ? 200 : 50 }, (_, i) => ({ id: page * 1000 + i })) }
  }
  assert.equal((await readAllQueue(get, 'lidarr')).length, 250)
  assert.equal(asked.length, 2)
  assert.ok(asked.every(p => p.startsWith('/api/v1/queue?') && p.includes('pageSize=200') && p.includes('includeArtist=true') && p.includes('includeAlbum=true')))
  assert.ok(!asked.some(p => p.includes('/api/v3/')))
})

test('one service down greys its own half; without Lidarr nothing music appears', () => {
  const d = buildQueueData({ sonarr: { rows: [], configured: false }, radarr: { rows: [], configured: false }, lidarr: { rows: null, configured: true, error: 'HTTP 502' }, now: NOW })
  assert.deepEqual(d.services.lidarr, { ok: false, configured: true, error: 'HTTP 502' })
  assert.deepEqual(d.artists, [])
  const none = buildQueueData({ sonarr: { rows: [], configured: true }, radarr: { rows: [], configured: true }, now: NOW })
  assert.deepEqual(none.services.lidarr, { ok: true, configured: false })
  assert.deepEqual([none.artists.length, none.summary.artists, none.summary.albums], [0, 0, 0])
})

// ── done and incomplete, in Lidarr's words ───────────────────────────────────

test('done: "Track file already imported" and "Not an upgrade for existing track file" with every track on disk', () => {
  const r = [doneRow({ albumId: 61 })]
  assert.equal(messagesSayDone(r), true)
  assert.equal(isDoneMusic(r, new Map([[61, albumInfo(12, 12, [['FLAC', 12]])]])), true)
  assert.equal(isDoneMusic(r), false, 'without a lookup nothing is vouched for')
  assert.equal(isDoneMusic(r, new Map([[61, albumInfo(null, 12)]])), false, 'an unknown track count is not vouched for')
  assert.equal(isDoneMusic(r, new Map()), false, 'an album the lookup did not return is not vouched for')
  const s = groupLidarr(r, NOW, new Map([[61, albumInfo(12, 12, [['FLAC', 12]])]]))
  assert.equal(summarize([], [], 1, s).done, 1)
  assert.equal(summarize([], [], 1, s).attention, 0)
})

test('done also reads Lidarr\'s "one or more albums expected in this release" summary line', () => {
  const r = [doneRow({ albumId: 62, statusMessages: [...DONE_MESSAGES, { title: 'Example', messages: ['One or more albums expected in this release were not imported or missing from the release'] }] })]
  assert.equal(messagesSayDone(r), true)
})

test('not done: any other message, a failed download, one still fetching, or an unfinished state', () => {
  const info = new Map([[63, albumInfo(10, 10, [['FLAC', 10]])]])
  const other = doneRow({ albumId: 63, statusMessages: [...DONE_MESSAGES, { title: 'a.flac', messages: ['No audio files were found that are eligible for import'] }] })
  assert.equal(isDoneMusic([other], info), false)
  assert.equal(isDoneMusic([doneRow({ albumId: 63, sizeleft: 1 })], info), false)
  assert.equal(isDoneMusic([doneRow({ albumId: 63, trackedDownloadState: 'downloading' })], info), false)
  assert.equal(isDoneMusic([doneRow({ albumId: 63, status: 'failed' })], info), false)
  assert.equal(isDoneMusic([doneRow({ albumId: 63, errorMessage: 'permission denied' })], info), false)
})

test('incomplete: the messages say imported, but tracks of the album have no file', () => {
  const r = [doneRow({ albumId: 64 })]
  const info = new Map([[64, albumInfo(12, 8, [['MP3-320', 8]])]])
  assert.equal(isDoneMusic(r, info), false)
  assert.equal(isIncompleteMusic(r, info), true)
  assert.equal(isIncompleteMusic(r), false)
  assert.equal(isIncompleteMusic([doneRow({ albumId: 64 })], new Map([[64, albumInfo(12, 12, [['MP3-320', 12]])]])), false)
  const d = groupLidarr(r, NOW, info)[0].albums[0].downloads[0]
  assert.equal(d.problem, 'incomplete'); assert.equal(d.done, false)
  assert.equal(summarize([], [], 1, groupLidarr(r, NOW, info)).attention, 1)
  assert.match(d.why!, /claims "Example Album" \(12 tracks\) but only 8 have files; 4 tracks are still missing and won't be searched while it sits here/)
})

test('Sonarr and Radarr wording is unchanged by the Lidarr matchers', () => {
  const sonarr = { size: 1e9, sizeleft: 0, trackedDownloadState: 'importBlocked', status: 'completed', trackedDownloadStatus: 'warning', statusMessages: [{ title: 'x', messages: ['Episode file already imported at 2026-05-01', 'No files found are eligible for import'] }] }
  assert.equal(messagesSayDone([sonarr]), false, 'an extra message still means someone should look')
  const ok = { ...sonarr, statusMessages: [{ title: 'x', messages: ['Episode file already imported at 2026-05-01', 'Not an upgrade for existing episode file(s)'] }] }
  assert.equal(messagesSayDone([ok]), true)
})

// ── why this download ────────────────────────────────────────────────────────

test('audio quality names: lossless beats lossy, then bitrate', () => {
  assert.equal(parseAudioQuality('FLAC')!.label, 'FLAC')
  assert.equal(parseAudioQuality('FLAC 24bit')!.label, 'FLAC 24-bit')
  assert.equal(parseAudioQuality('MP3-320')!.label, 'MP3 320')
  assert.equal(parseAudioQuality('MP3-VBR-V0')!.label, 'MP3 VBR V0')
  assert.equal(parseAudioQuality('Unknown'), null); assert.equal(parseAudioQuality(null), null); assert.equal(parseAudioQuality('Weird'), null)
  const c = (a: string, b: string) => compareAudio(parseAudioQuality(a)!, parseAudioQuality(b)!)
  assert.ok(c('FLAC', 'MP3-320') > 0); assert.ok(c('MP3-320', 'MP3-VBR-V0') > 0); assert.ok(c('MP3-VBR-V0', 'MP3-256') < 0)
  assert.ok(c('FLAC 24bit', 'FLAC') > 0); assert.ok(c('AAC-256', 'MP3-256') === 0)
})

test('why: "fills N of M tracks · upgrades MP3 320 → FLAC"', () => {
  assert.equal(whyLidarr([albumInfo(12, 8, [['MP3-320', 8]])], 'FLAC', false), 'Fills 4 of 12 tracks · upgrades MP3 320 → FLAC')
  assert.equal(whyLidarr([albumInfo(12, 0)], 'FLAC', false), 'Fills 12 of 12 tracks')
  assert.equal(whyLidarr([albumInfo(1, 0)], 'MP3-320', false), 'Fills 1 of 1 track')
  assert.equal(whyLidarr([albumInfo(10, 10, [['MP3-320', 10]])], 'FLAC', false), 'Upgrades MP3 320 → FLAC')
  assert.equal(whyLidarr([albumInfo(10, 10, [['FLAC', 10]])], 'MP3-320', false), 'Already have FLAC (will be skipped)')
  assert.equal(whyLidarr([albumInfo(10, 10, [['FLAC', 10]])], 'FLAC', false), 'Already have FLAC (will be skipped)')
  // A discography: the tracks of every album add up, and the worst copy is what an upgrade replaces.
  assert.equal(whyLidarr([albumInfo(10, 10, [['FLAC', 10]]), albumInfo(8, 4, [['MP3-128', 4]])], 'FLAC', false), 'Fills 4 of 18 tracks · upgrades MP3 128 → FLAC')
  assert.equal(whyLidarr([albumInfo(null, 0)], 'FLAC', false), 'Fills a missing album')
  assert.equal(whyLidarr([], 'FLAC', false), null)
})

test('why, done: what was imported or kept', () => {
  assert.equal(whyLidarr([albumInfo(10, 10, [['FLAC', 10]])], 'MP3-320', true), 'Kept your better copy (FLAC); nothing left to import.')
  assert.equal(whyLidarr([albumInfo(10, 10, [['FLAC', 10]])], 'FLAC', true), 'Imported this release; nothing left to import.')
  assert.equal(whyIncompleteLidarr([albumInfo(10, 10)]), null)
})

test('the line travels with the download in the grouped queue', () => {
  const d = groupLidarr([lrow({ albumId: 71 })], NOW, new Map([[71, albumInfo(12, 8, [['MP3-320', 8]])]]))[0].albums[0].downloads[0]
  assert.equal(d.why, 'Fills 4 of 12 tracks · upgrades MP3 320 → FLAC')
  assert.equal(d.tracks, 12)
  assert.equal(groupLidarr([lrow({ albumId: 71 })], NOW)[0].albums[0].downloads[0].why, null, 'no lookup, no line')
})

// ── the lookup: batched, cached, tolerant ────────────────────────────────────

test('lookup: albums and track files in batches of 100, qualities cached, v1 only', async () => {
  const ids = Array.from({ length: 150 }, (_, i) => 1000 + i)
  const albums = Object.fromEntries(ids.map(i => [i, { total: 10, have: 10, files: [['FLAC', 10]] as Array<[string, number]> }]))
  const fl = fakeLidarr([], albums)
  const rows = ids.map(i => lrow({ albumId: i }))
  const cache = new FileCache()
  const info = await readAlbumInfo((p, t) => fl.client.get(p, t), rows, NOW, cache)
  assert.equal(info.size, 150)
  assert.deepEqual(info.get(1000), { title: 'Example Album 1000', total: 10, have: 10, files: [{ quality: 'FLAC', count: 10 }] })
  assert.equal(fl.log.gets.filter(g => g.startsWith('/api/v1/album?')).length, 2, '150 ids are two batches')
  assert.equal(fl.log.gets.filter(g => g.startsWith('/api/v1/trackfile?')).length, 2)
  assert.ok(fl.log.gets.every(g => g.startsWith('/api/v1/')))
  assert.ok(fl.log.gets[0].split('albumIds=').length - 1 === 100)
  const before = fl.log.gets.length
  await readAlbumInfo((p, t) => fl.client.get(p, t), rows, NOW + 5_000, cache)
  assert.equal(fl.log.gets.slice(before).filter(g => g.startsWith('/api/v1/trackfile?')).length, 0, 'track files are cached; albums are read fresh')
  assert.equal(fl.log.gets.slice(before).filter(g => g.startsWith('/api/v1/album?')).length, 2)
})

test('lookup: a replaced file reads fresh (the cache key carries the file count and size)', async () => {
  const albums: Record<number, { total: number; have: number; files: Array<[string, number]> }> = { 5: { total: 4, have: 4, files: [['MP3-320', 4]] } }
  const fl = fakeLidarr([], albums)
  const cache = new FileCache()
  const rows = [lrow({ albumId: 5 })]
  assert.equal((await readAlbumInfo((p, t) => fl.client.get(p, t), rows, NOW, cache)).get(5)!.files[0].quality, 'MP3-320')
  albums[5] = { total: 4, have: 3, files: [['FLAC', 3]] }
  assert.equal((await readAlbumInfo((p, t) => fl.client.get(p, t), rows, NOW + 1000, cache)).get(5)!.files[0].quality, 'FLAC')
})

test('lookup: an album Lidarr no longer knows does not sink the batch; a dead Lidarr leaves the answer out', async () => {
  const calls: string[] = []
  const get = async (p: string) => {
    calls.push(p)
    if (p.startsWith('/api/v1/album?') && p.includes('albumIds=2') && p.split('albumIds=').length > 2) throw new Error('HTTP 500')
    if (p === '/api/v1/album?albumIds=2') throw new Error('HTTP 500')
    if (p.startsWith('/api/v1/album?')) return [{ id: 1, title: 'Kept', statistics: { trackCount: 3, trackFileCount: 0 } }]
    return []
  }
  const info = await readAlbumInfo(get, [lrow({ albumId: 1 }), lrow({ albumId: 2 })], NOW, new FileCache())
  assert.deepEqual([...info.keys()], [1], 'the gone album is left out, the rest answered')
  assert.deepEqual(await readAlbumInfo(async () => { throw new Error('down') }, [lrow({ albumId: 1 })], NOW, new FileCache()), new Map())
})

// ── actions ──────────────────────────────────────────────────────────────────

test('find another: bulk delete on v1 with blocklist and skipRedownload, then AlbumSearch for the album ids', async () => {
  const rows = discography([81, 82], { downloadId: 'FA1' })
  const others = [lrow({ albumId: 90, downloadId: 'KEEP' })]
  const fl = fakeLidarr([...others, ...rows])
  const out = await runAction(mkDeps(fl.client), lreq({ action: 'find-another', downloadId: 'd:FA1' }), 'a@example.com')
  assert.equal(fl.log.deletes.length, 1)
  assert.equal(fl.log.deletes[0].p, '/api/v1/queue/bulk?removeFromClient=true&blocklist=true&skipRedownload=true')
  assert.deepEqual([...fl.log.deletes[0].ids].sort(), rows.map(r => r.id).sort())
  assert.equal(fl.rows.length, 1, 'the other download is untouched')
  assert.deepEqual(fl.log.posts, [{ p: '/api/v1/command', body: { name: 'AlbumSearch', albumIds: [81, 82] } }])
  assert.match(out.result!.summary, /\(2 albums\)/)
  assert.match(out.result!.summary, /Searching for another copy of 2 albums/)
  assert.ok(fl.log.gets.every(g => g.startsWith('/api/v1/queue?') && !/[?&]artistId=/.test(g)), 'no upstream filter is ever trusted')
  assert.ok([...fl.log.gets, ...fl.log.deletes.map(d => d.p), ...fl.log.posts.map(p => p.p)].every(p => !p.includes('/api/v3/')), 'never v3')
})

test('search targets: one album, several, nothing', () => {
  assert.deepEqual(searchCommands('lidarr', [lrow({ albumId: 3 })]), [{ name: 'AlbumSearch', body: { name: 'AlbumSearch', albumIds: [3] }, label: 'the album' }])
  assert.equal(searchCommands('lidarr', [lrow({ albumId: 3 }), lrow({ albumId: 3 }), lrow({ albumId: 4 })])[0].label, '2 albums')
  assert.deepEqual(searchCommands('lidarr', [lrow({ albumId: null, album: undefined })]), [])
  const merged = mergeCommands([...searchCommands('lidarr', [lrow({ albumId: 3 })]), ...searchCommands('lidarr', [lrow({ albumId: 3 }), lrow({ albumId: 5 })])])
  assert.deepEqual(merged.map(c => [c.name, c.body.albumIds]), [['AlbumSearch', [3, 5]]])
})

test('find another with nothing matched to an album is refused with a plain reason', async () => {
  const fl = fakeLidarr([lrow({ albumId: null, album: undefined, downloadId: 'NM' })])
  await assert.rejects(runAction(mkDeps(fl.client), lreq({ action: 'find-another', downloadId: 'd:NM' }), 'a@example.com'),
    (e: any) => e.code === 'nothing_to_search' && /Lidarr has not matched this download to an album/.test(e.message))
  assert.equal(fl.log.deletes.length, 0)
})

test('remove: the blocklist box decides, no search, v1 path', async () => {
  const fl = fakeLidarr([lrow({ downloadId: 'R1' })])
  await runAction(mkDeps(fl.client), lreq({ action: 'remove', downloadId: 'd:R1', blocklist: true }), 'a@example.com')
  assert.equal(fl.log.deletes[0].p, '/api/v1/queue/bulk?removeFromClient=true&blocklist=true&skipRedownload=true')
  assert.equal(fl.log.posts.length, 0)
  const fb = fakeLidarr([lrow({ downloadId: 'R2' })])
  await runAction(mkDeps(fb.client), lreq({ action: 'remove', downloadId: 'd:R2' }), 'a@example.com')
  assert.equal(fb.log.deletes[0].p, '/api/v1/queue/bulk?removeFromClient=true&blocklist=false&skipRedownload=true')
})

test('retry import: RefreshMonitoredDownloads on v1, only for a blocked import', async () => {
  const blocked = lrow({ downloadId: 'B1', trackedDownloadStatus: 'warning', trackedDownloadState: 'importBlocked', statusMessages: [{ title: 'a.flac', messages: ['Access to the path "/music/Example" is denied'] }] })
  const fl = fakeLidarr([blocked, lrow({ downloadId: 'FINE' })])
  const out = await runAction(mkDeps(fl.client), lreq({ action: 'retry-import', downloadId: 'd:B1' }), 'a@example.com')
  assert.deepEqual(fl.log.posts, [{ p: '/api/v1/command', body: { name: 'RefreshMonitoredDownloads' } }])
  assert.equal(fl.log.deletes.length, 0)
  assert.match(out.result!.summary, /Asked Lidarr to check its downloads again/)
  assert.match(out.result!.hint ?? '', /permissions problem/)
  assert.ok(!(out.result!.messages ?? []).join(' ').includes('/music/Example'), 'no server path reaches the browser')
  await refusal(runAction(mkDeps(fl.client), lreq({ action: 'retry-import', downloadId: 'd:FINE' }), 'a@example.com'), 'not_blocked')
})

test('move to top: qBittorrent, for a torrent only', async () => {
  const HASH = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01'
  const fl = fakeLidarr([lrow({ downloadId: HASH }), lrow({ downloadId: 'nzb1', protocol: 'usenet' })])
  const forms: any[] = []
  const q = { async get() { return [{ hash: HASH.toLowerCase() }] }, async postForm(p: string, f: any) { forms.push({ p, f }); return null } } as any
  await runAction(mkDeps(fl.client, [], q), lreq({ action: 'prioritise', downloadId: `d:${HASH}` }), 'a@example.com')
  assert.deepEqual(forms, [{ p: '/api/v2/torrents/topPrio', f: { hashes: HASH.toLowerCase() } }])
  assert.equal(fl.log.deletes.length + fl.log.posts.length, 0)
  await refusal(runAction(mkDeps(fl.client, [], q), lreq({ action: 'prioritise', downloadId: 'd:nzb1' }), 'a@example.com'), 'not_a_torrent')
})

test('clear from queue: done items only, re-read fresh; never blocklisted, never searched', async () => {
  const done = doneRow({ albumId: 91, downloadId: 'DN' })
  const notDone = doneRow({ albumId: 92, downloadId: 'ND' })
  const fl = fakeLidarr([done, notDone], { 91: { total: 10, have: 10, files: [['FLAC', 10]] }, 92: { total: 10, have: 7, files: [['FLAC', 7]] } })
  const out = await runAction(mkDeps(fl.client), lreq({ action: 'clear-done', downloadIds: ['d:DN', 'd:ND'] }), 'a@example.com')
  assert.deepEqual(fl.log.deletes[0].ids, [done.id])
  assert.equal(fl.log.deletes[0].p, '/api/v1/queue/bulk?removeFromClient=true&blocklist=false&skipRedownload=true')
  assert.equal(fl.log.posts.length, 0)
  assert.deepEqual(out.plan.skipped.map(s => s.reason), ['no longer done'])
  assert.match(out.result!.summary, /Skipped 1 download that changed meanwhile/)
  // The page was stale: nothing is done any more, so nothing is removed.
  const fb = fakeLidarr([notDone], { 92: { total: 10, have: 7, files: [['FLAC', 7]] } })
  await refusal(runAction(mkDeps(fb.client), lreq({ action: 'clear-done', downloadIds: ['d:ND'] }), 'a@example.com'), 'nothing_to_do')
  assert.equal(fb.log.deletes.length, 0)
  // No lookup answer (Lidarr's album read fails): nothing is vouched for.
  const fc = fakeLidarr([doneRow({ albumId: 93, downloadId: 'NA' })], {})
  await refusal(runAction(mkDeps(fc.client), lreq({ action: 'clear-done', downloadIds: ['d:NA'] }), 'a@example.com'), 'nothing_to_do')
})

test('fix all stalled: find another over the stalled ones only, one AlbumSearch with every album', async () => {
  const st = (a: number, id: string) => lrow({ albumId: a, downloadId: id, trackedDownloadStatus: 'warning', status: 'warning', statusMessages: [{ title: 'x', messages: ['The download is stalled with no connections'] }] })
  const fl = fakeLidarr([st(101, 'S1'), st(102, 'S2'), lrow({ albumId: 103, downloadId: 'OK' })])
  const out = await runAction(mkDeps(fl.client), lreq({ action: 'fix-stalled', downloadIds: ['d:S1', 'd:S2', 'd:OK'] }), 'a@example.com')
  assert.equal(fl.log.deletes.length, 1)
  assert.equal(fl.log.deletes[0].ids.length, 2)
  assert.deepEqual(fl.log.posts.map(p => p.body), [{ name: 'AlbumSearch', albumIds: [101, 102] }])
  assert.deepEqual(out.plan.skipped.map(s => s.reason), ['no longer stalled'])
})

test('swap for a season pack does not apply to music', async () => {
  const fl = fakeLidarr([lrow({ downloadId: 'A' }), lrow({ downloadId: 'B' })])
  for (const action of ['swap-pack', 'swap-check'] as const) {
    assert.throws(() => planAction(fl.rows, lreq({ action, showKey: 's:7', seasonKey: '1', downloadIds: ['d:A'] })), (e: any) => e instanceof ActionRefusal && e.code === 'bad_request' && /do not apply to music/.test(e.message))
    await assert.rejects(runAction(mkDeps(fl.client), lreq({ action, showKey: 's:7', seasonKey: '1', downloadIds: ['d:A'] }), 'a@example.com'), (e: any) => e instanceof ActionRefusal)
  }
  assert.equal(fl.log.deletes.length + fl.log.posts.length, 0)
})

test('Lidarr not set up: refused before anything is read', async () => {
  await refusal(runAction({ sonarr: async () => null, radarr: async () => null, qbit: async () => null, audit: async () => {} }, lreq({ action: 'remove', downloadId: 'd:X' }), 'a@example.com'), 'not_configured')
})

test('audit: written before the run, with the instance; no entry, no action', async () => {
  const audits: any[] = []
  const fl = fakeLidarr([lrow({ downloadId: 'AU1' })])
  await runAction(mkDeps(fl.client, audits), lreq({ action: 'remove', downloadId: 'd:AU1' }), 'a@example.com', { preview: true })
  assert.equal(audits.length, 0); assert.equal(fl.log.deletes.length, 0)
  await runAction(mkDeps(fl.client, audits), lreq({ action: 'remove', downloadId: 'd:AU1' }), 'a@example.com')
  assert.equal(audits[0].action, 'arr.queue.action'); assert.equal(audits[0].details.instance, 'lidarr'); assert.equal(audits[0].details.by, 'a@example.com')
  const fb = fakeLidarr([lrow({ downloadId: 'AU2' })])
  await refusal(runAction({ ...mkDeps(fb.client), audit: async () => { throw new Error('db down') } }, lreq({ action: 'remove', downloadId: 'd:AU2' }), 'a@example.com'), 'audit_unavailable')
  assert.equal(fb.log.deletes.length, 0)
})

test('roles: music actions go through the same admin-only, token-refused, no-master-password route', () => {
  assert.equal(requiredRole('POST', '/api/plugins/arrstack/queue/actions'), 'admin')
  assert.equal(requiredRole('GET', '/api/plugins/arrstack/queue'), 'viewer')
  assert.equal(tokenForbidden('POST', '/api/plugins/arrstack/queue/actions'), true)
  assert.equal(needsReconfirm('POST', '/api/plugins/arrstack/queue/actions'), false)
})

async function app(deps: Parameters<typeof buildArrQueueRoutes>[0]) {
  const a = Fastify({ logger: false })
  await registerGate(a)
  await a.register(authRoutes, { prefix: '/api/auth' })
  await a.register(buildArrQueueRoutes(deps), { prefix: '/api/plugins/arrstack' })
  await a.ready()
  return a
}

test('route: viewer, operator and an admin API token are refused; an admin signed in may act, with confirm and a rate limit', async () => {
  const fl = fakeLidarr([lrow({ downloadId: 'S1' }), lrow({ downloadId: 'S2' }), lrow({ downloadId: 'S3' })])
  const audits: any[] = []
  const a = await app({ sonarr: async () => null, radarr: async () => null, lidarr: async () => fl.client, qbit: async () => null, audit: async (action, details) => { audits.push({ action, details }) }, limiter: new MissLimiter(3) })
  try {
    const url = '/api/plugins/arrstack/queue/actions'
    const post = (headers: any, payload: any) => a.inject({ method: 'POST', url, headers, payload })
    const body = { action: 'remove', instance: 'lidarr', downloadId: 'd:S1', confirmed: true }
    assert.ok([401, 423].includes((await post({}, body)).statusCode))
    const viewer = await signIn(a, 'viewer@example.com', 'viewer master password')
    assert.equal((await post({ cookie: viewer.cookie }, body)).statusCode, 403)
    const oper = await signIn(a, 'operator@example.com', 'operator master password')
    const o = await post({ cookie: oper.cookie }, body)
    assert.equal(o.statusCode, 403); assert.equal(JSON.parse(o.body).code, 'forbidden')
    const tok = (await createApiToken({ name: 'bot', role: 'admin' }, 'test', store)).token
    const t = await post({ authorization: `Bearer ${tok}` }, body)
    assert.equal(t.statusCode, 403); assert.equal(JSON.parse(t.body).code, 'token_forbidden')
    assert.equal(fl.log.deletes.length, 0, 'none of those changed anything')

    const { cookie } = await signIn(a, 'admin@example.com', 'admin master password')
    assert.equal(JSON.parse((await post({ cookie }, { ...body, instance: 'tidal' })).body).code, 'bad_request')
    const noConfirm = await post({ cookie }, { ...body, confirmed: undefined })
    assert.equal(noConfirm.statusCode, 400); assert.equal(JSON.parse(noConfirm.body).code, 'confirm_required')
    assert.equal(fl.log.deletes.length, 0)
    const prev = await post({ cookie }, { action: 'find-another', instance: 'lidarr', downloadId: 'd:S1', preview: true })
    assert.equal(prev.statusCode, 200, prev.body)
    const plan = JSON.parse(prev.body).data.plan
    assert.deepEqual(plan.search, ['the album']); assert.equal(plan.items[0].albums, 1)
    assert.ok(!prev.body.includes(KEY) && !/"rowIds"|"ids"/.test(prev.body), 'names and counts, never a row id')
    assert.equal(fl.log.deletes.length, 0, 'a preview changes nothing')
    const go = await post({ cookie }, body)
    assert.equal(go.statusCode, 200, go.body)
    assert.equal(audits[0].action, 'arr.queue.action')
    assert.equal(fl.log.deletes.length, 1)
    const limited = await post({ cookie }, { ...body, downloadId: 'd:S2' })
    assert.equal(limited.statusCode, 429)
  } finally { await a.close() }
})

// ── the queue route: shared reading, nothing secret ──────────────────────────

test('route: the queue includes music grouped, read once for everyone, with no key, address or path in the answer', async () => {
  const fl = fakeLidarr(
    [...discography([201, 202], { downloadId: 'D1', outputPath: '/data/secret/path', downloadClientHost: 'http://10.0.0.9:8080' }), lrow({ albumId: 203, downloadId: 'D2' })],
    { 201: { total: 10, have: 0 }, 202: { total: 8, have: 8, files: [['MP3-320', 8]] }, 203: { total: 12, have: 8, files: [['MP3-320', 8]] } })
  let clock = NOW
  const a = await app({ sonarr: async () => null, radarr: async () => null, lidarr: async () => fl.client, now: () => clock, ttlMs: 3000 })
  try {
    const { cookie } = await signIn(a, 'viewer@example.com', 'viewer master password')
    const r = await a.inject({ method: 'GET', url: '/api/plugins/arrstack/queue', headers: { cookie } })
    assert.equal(r.statusCode, 200, r.body)
    const data = JSON.parse(r.body).data
    assert.equal(data.services.lidarr.configured, true); assert.equal(data.services.sonarr.configured, false)
    assert.equal(data.summary.downloads, 2); assert.equal(data.summary.rows, 3); assert.equal(data.summary.artists, 1); assert.equal(data.summary.albums, 3)
    const dls = data.artists[0].albums.flatMap((al: any) => al.downloads)
    assert.ok(dls.some((d: any) => d.why === 'Fills 4 of 12 tracks · upgrades MP3 320 → FLAC'), JSON.stringify(dls.map((d: any) => d.why)))
    assert.ok(!r.body.includes(KEY) && !r.body.includes(ADDR) && !/X-Api-Key|apikey/i.test(r.body))
    assert.ok(!r.body.includes('/data/secret') && !/https?:\/\//.test(r.body), 'no path, host or address is sent to the browser')
    const reads = fl.log.gets.filter(g => g.startsWith('/api/v1/queue?')).length
    await a.inject({ method: 'GET', url: '/api/plugins/arrstack/queue', headers: { cookie } })
    assert.equal(fl.log.gets.filter(g => g.startsWith('/api/v1/queue?')).length, reads, 'a second page inside the window costs Lidarr nothing')
    clock += 4000
    await a.inject({ method: 'GET', url: '/api/plugins/arrstack/queue', headers: { cookie } })
    assert.equal(fl.log.gets.filter(g => g.startsWith('/api/v1/queue?')).length, reads + 1)
  } finally { await a.close() }
})

test('route: without Lidarr the queue shows nothing about music', async () => {
  const a = await app({ sonarr: async () => null, radarr: async () => null, lidarr: async () => null })
  try {
    const { cookie } = await signIn(a, 'viewer@example.com', 'viewer master password')
    const data = JSON.parse((await a.inject({ method: 'GET', url: '/api/plugins/arrstack/queue', headers: { cookie } })).body).data
    assert.deepEqual([data.services.lidarr.configured, data.artists, data.summary.artists, data.summary.albums], [false, [], 0, 0])
  } finally { await a.close() }
})

// ── settings and the Test button ─────────────────────────────────────────────

test('settings: Lidarr address and key are optional, the key is a secret, the endpoint sends it in X-Api-Key', () => {
  const m = arrstackPlugin.manifest
  const url = m.settings.find(s => s.key === 'lidarr_url')!, key = m.settings.find(s => s.key === 'lidarr_key')!
  assert.equal(url.type, 'url'); assert.equal(url.required, false)
  assert.equal(key.type, 'secret'); assert.equal(key.required, false)
  assert.match(url.hint ?? '', /Leave blank if you do not run Lidarr/)
  const ep = m.endpoints!.find(e => e.key === 'lidarr')!
  assert.deepEqual([ep.baseUrlSetting, ep.auth], ['lidarr_url', { kind: 'header', header: 'X-Api-Key', fromSetting: 'lidarr_key' }])
  assert.deepEqual(missingSettings(m, { sonarr_url: 'http://tv.example.test:8989', sonarr_key: 'k' }), [], 'Lidarr never makes the plug-in "not configured"')
})

test('settings: moving Lidarr to another address needs its key again in the same save', () => {
  const m = arrstackPlugin.manifest
  const stored = { sonarr_url: 'http://tv.example.test:8989', sonarr_key: 'k', lidarr_url: ADDR, lidarr_key: KEY }
  assert.match(settingsChangeProblem(m, stored, { lidarr_url: 'http://elsewhere.example.test:8686' })!, /Lidarr's address now points somewhere else.*Lidarr API key/)
  assert.equal(settingsChangeProblem(m, stored, { lidarr_url: 'http://elsewhere.example.test:8686', lidarr_key: 'new' }), null)
  assert.equal(settingsChangeProblem(m, stored, { lidarr_url: `${ADDR}/` }), null)
  assert.equal(settingsChangeProblem(m, { sonarr_url: stored.sonarr_url, sonarr_key: 'k' }, { lidarr_url: ADDR }), null, 'the first address needs nothing')
})

test('settings: what the browser is sent about Lidarr never carries the key', async () => {
  const a = Fastify({ logger: false })
  await registerGate(a); await a.register(authRoutes, { prefix: '/api/auth' }); await a.ready()
  try {
    await signIn(a, 'admin@example.com', 'admin master password')
    const shown = await describeSettings(arrstackPlugin.manifest)
    const k = shown.find(s => s.key === 'lidarr_key')!
    assert.deepEqual([k.value, k.isSet, k.type], ['', true, 'secret'])
    assert.equal(shown.find(s => s.key === 'lidarr_url')!.value, ADDR, 'the address is not secret')
    assert.ok(!JSON.stringify(shown).includes(KEY) && !JSON.stringify(shown).includes('sonarr-secret'))
  } finally { await a.close() }
})

test('Test button: reads /api/v1/system/status with the saved key, answers with a version and nothing else', async () => {
  const seen: string[] = []
  const ok = { async get(p: string) { seen.push(p); return { appName: 'Lidarr', version: '3.1.6.5079', startupPath: '/app/lidarr/bin', appData: '/config' } } } as any
  const a = await app({ sonarr: async () => null, radarr: async () => null, lidarr: async () => ok })
  try {
    const anon = await a.inject({ method: 'GET', url: '/api/plugins/arrstack/lidarr/test' })
    assert.ok([401, 423].includes(anon.statusCode)); assert.equal(seen.length, 0)
    const { cookie } = await signIn(a, 'viewer@example.com', 'viewer master password')
    const r = await a.inject({ method: 'GET', url: '/api/plugins/arrstack/lidarr/test', headers: { cookie } })
    assert.deepEqual(JSON.parse(r.body).data, { ok: true, configured: true, version: '3.1.6.5079', name: 'Lidarr' })
    assert.deepEqual(seen, ['/api/v1/system/status'])
    assert.ok(!r.body.includes('/app/lidarr') && !r.body.includes(KEY) && !r.body.includes(ADDR))
  } finally { await a.close() }
  const say = async (get: (p: string) => Promise<any> | any, c: any = { get }) => {
    const b = await app({ sonarr: async () => null, radarr: async () => null, lidarr: async () => c })
    try {
      const { cookie } = await signIn(b, 'viewer@example.com', 'viewer master password')
      return JSON.parse((await b.inject({ method: 'GET', url: '/api/plugins/arrstack/lidarr/test', headers: { cookie } })).body).data
    } finally { await b.close() }
  }
  assert.deepEqual(await say(() => { throw new Error(`HTTP 401 from ${ADDR}`) }), { ok: false, configured: true, error: 'Lidarr refused the API key.' })
  assert.deepEqual(await say(() => { throw new Error(`connect ECONNREFUSED ${ADDR}`) }), { ok: false, configured: true, error: 'Lidarr could not be reached at the saved address.' })
  assert.deepEqual(await say(() => { throw new Error('The operation was aborted: timeout') }), { ok: false, configured: true, error: 'Lidarr did not answer in time.' })
  assert.equal((await say(() => ({ hello: 'world' }))).error, 'That address answered, but not like Lidarr.')
  assert.equal((await say(() => null, null)).configured, false)
})

test('discovery knows Lidarr by its port and still needs its key', () => {
  const p = PROBES.find(x => x.setting === 'lidarr_url')!
  assert.deepEqual([p.pluginId, p.port, p.needs], ['arrstack', 8686, ['lidarr_key']])
})

// ── the plug-in: tile, detail, Overview numbers ──────────────────────────────

/** A plug-in context over fake services, so load() and detail() run end to end without a network. */
function ctxOf(endpoints: Record<string, (p: string) => any>): PluginContext & { asked: string[] } {
  const asked: string[] = []
  const make = (key: string): PluginContext => ({
    async get(p: string) { asked.push(`${key}:${p}`); const h = endpoints[key]; if (!h) throw new Error('no endpoint'); return h(p) },
    async post() { throw new Error('read-only') },
    option: () => undefined,
    from: (k: string) => make(k),
    has: (k: string) => k === 'default' || k in endpoints,
  } as any)
  return Object.assign(make('default'), { asked })
}
const lidarrAnswers = (rows: any[], extra: Record<string, any> = {}) => (p: string) => {
  if (p.startsWith('/api/v1/queue?')) return { totalRecords: rows.length, records: rows }
  if (p === '/api/v1/health') return [{ source: 'IndexerRssCheck', type: 'error', message: 'No indexers available with RSS sync enabled' }]
  if (p === '/api/v1/artist') return extra.artists ?? []
  if (p.startsWith('/api/v1/wanted/missing')) return extra.missing ?? { totalRecords: 0, records: [] }
  throw new Error(`unexpected ${p}`)
}
const sonarrQuiet = (p: string) => (p.includes('queue') ? { totalRecords: 0, records: [] } : [])

test('tile: Lidarr is read on v1, counted in the queue, and named in the tile row', async () => {
  const rows = [lrow({ albumId: 301, downloadId: 'T1' }), lrow({ albumId: 302, downloadId: 'T2', trackedDownloadStatus: 'warning', trackedDownloadState: 'importBlocked', statusMessages: [{ title: 'a.flac', messages: ['No audio files were found that are eligible for import'] }] })]
  const ctx = ctxOf({ default: sonarrQuiet, lidarr: lidarrAnswers(rows) })
  const tile = await arrstackPlugin.load(ctx)
  assert.equal(tile.headline, '2 in queue')
  assert.equal(tile.tone, 'bad', 'a blocked import in Lidarr needs a person, like in Sonarr')
  const q = tile.rows.find(r => r.label === 'Queue')!
  assert.match(q.value, /2 downloads · 0 shows · 1 artist/)
  assert.ok(tile.rows.some(r => r.label === 'Needs you' && /1 blocked import/.test(r.value)))
  assert.ok(ctx.asked.filter(a => a.startsWith('lidarr:')).every(a => a.startsWith('lidarr:/api/v1/')), 'Lidarr is only ever asked on v1')
  assert.ok(ctx.asked.some(a => a.startsWith('lidarr:/api/v1/queue?') && a.includes('includeArtist=true') && a.includes('includeAlbum=true')))
})

test('without Lidarr the plug-in asks nothing of it and says nothing about music', async () => {
  const ctx = ctxOf({ default: sonarrQuiet })
  const tile = await arrstackPlugin.load(ctx)
  assert.ok(!ctx.asked.some(a => a.startsWith('lidarr:')))
  assert.ok(!JSON.stringify(tile).toLowerCase().includes('artist'))
  const detail = await arrstackPlugin.detail!(ctx)
  assert.equal((detail.visual as any).music, undefined)
  assert.ok(!(detail.visual as any).services.some((s: any) => s.name === 'Lidarr'))
})

test('Overview: Lidarr health, artist and album counts, missing albums; an unreachable Lidarr shows as down', async () => {
  const artists = [
    { id: 1, artistName: 'Example Artist', statistics: { albumCount: 3, trackFileCount: 30, trackCount: 36, totalTrackCount: 36, sizeOnDisk: 900 * MB, percentOfTracks: 83 } },
    { id: 2, artistName: 'Another Artist', statistics: { albumCount: 1, trackFileCount: 10, trackCount: 10, totalTrackCount: 10, sizeOnDisk: 100 * MB, percentOfTracks: 100 } },
  ]
  const ctx = ctxOf({ default: sonarrQuiet, lidarr: lidarrAnswers([lrow({ albumId: 401 })], { artists, missing: { totalRecords: 5, records: [{ id: 9 }] } }) })
  const d = await arrstackPlugin.detail!(ctx)
  const v = d.visual as any
  assert.deepEqual(v.music, { artists: 2, albums: 4, tracks: 40, sizeBytes: 1000 * MB, missingAlbums: 5 })
  assert.ok(v.services.some((s: any) => s.name === 'Lidarr' && s.up))
  assert.ok(v.health.some((h: any) => h.service === 'Lidarr' && h.level === 'error' && /RSS sync/.test(h.message)), 'Lidarr health sits with the others')
  assert.ok(d.tables!.find(t => t.title === 'Queue')!.rows.some((r: any) => r.service === 'Lidarr' && r.kind === 'album'))
  // A second reading inside two minutes does not read the artist list again.
  const before = ctx.asked.filter(a => a === 'lidarr:/api/v1/artist').length
  await arrstackPlugin.detail!(ctx)
  assert.equal(ctx.asked.filter(a => a === 'lidarr:/api/v1/artist').length, before)

  const down = ctxOf({ default: sonarrQuiet, lidarr: () => { throw new Error('connect ECONNREFUSED') } })
  const dv = (await arrstackPlugin.detail!(down)).visual as any
  assert.ok(dv.services.some((s: any) => s.name === 'Lidarr' && !s.up))
  assert.equal(dv.music, undefined)
})

test('musicCounts and the visual: absent without Lidarr, zero-safe, no key', () => {
  assert.deepEqual(musicCounts([], null), { artists: 0, albums: 0, tracks: 0, sizeBytes: 0, missingAlbums: null })
  assert.deepEqual(musicCounts([{ statistics: {} }, {}], { totalRecords: 0 }), { artists: 2, albums: 0, tracks: 0, sizeBytes: 0, missingAlbums: 0 })
  const base = { arrs: [], indexers: null, transfer: null, torrents: null }
  assert.equal('music' in buildArrVisual(base), false)
  assert.deepEqual(buildArrVisual({ ...base, music: musicCounts([], null) }).music, { artists: 0, albums: 0, tracks: 0, sizeBytes: 0, missingAlbums: null })
  assert.ok(!JSON.stringify(buildArrVisual({ ...base, music: musicCounts([{ statistics: { albumCount: 1 } }], null) })).includes(KEY))
})

// ── upcoming ─────────────────────────────────────────────────────────────────

/** One /api/v1/calendar album, with includeArtist. releaseDate is a calendar date at midnight UTC. */
const calAlbum = (id: number, over: any = {}) => ({
  id, title: `Example Album ${id}`, artistId: 7, albumType: 'Album', releaseDate: '2026-06-20T00:00:00Z', monitored: true,
  artist: { id: 7, artistName: 'Example Artist' }, images: [{ coverType: 'cover', url: `/MediaCover/Albums/${id}/cover.jpg` }],
  statistics: { trackFileCount: 0, trackCount: 10, totalTrackCount: 10, sizeOnDisk: 0, percentOfTracks: 0 }, ...over,
})

test('upcoming albums: status, label, cover reference, window', () => {
  const end = '2026-07-15'
  const items = musicItems([
    calAlbum(1),
    calAlbum(2, { releaseDate: '2026-06-15T00:00:00Z' }),
    calAlbum(3, { releaseDate: '2026-06-16T00:00:00Z', statistics: { trackFileCount: 10, trackCount: 10 } }),
    calAlbum(4, { releaseDate: '2026-06-17T00:00:00Z' }),
    calAlbum(5, { images: [], albumType: 'EP' }),
    calAlbum(6, { releaseDate: '2026-09-01T00:00:00Z' }),
    calAlbum(7, { releaseDate: '2026-06-01T00:00:00Z' }),
    calAlbum(8, { releaseDate: null }),
    { id: 9 },
  ], queueIndex([{ albumId: 4, size: 100, sizeleft: 25 }], 'albumId'), NOW, 'UTC', end)
  const by = Object.fromEntries(items.map(i => [i.id, i]))
  assert.deepEqual(items.map(i => i.id).sort(), ['music-1', 'music-2', 'music-3', 'music-4', 'music-5'], 'inside the window only; no date, no row')
  assert.deepEqual([by['music-1'].kind, by['music-1'].status, by['music-1'].statusText], ['music', 'upcoming', 'release in 5 days; Lidarr searches once it is out'])
  assert.deepEqual([by['music-1'].title, by['music-1'].artist, by['music-1'].albumType, by['music-1'].when], ['Example Album 1', 'Example Artist', 'Album', 'Sat'])
  assert.deepEqual([by['music-2'].status, by['music-2'].statusText, by['music-2'].when], ['waiting', 'out today, waiting for a release', 'today'])
  assert.deepEqual([by['music-3'].status, by['music-3'].statusText], ['have', 'already have it'])
  assert.deepEqual([by['music-4'].status, by['music-4'].progress], ['downloading', 75])
  assert.equal(by['music-1'].art, '/api/plugins/arrstack/art/lidarr/1'); assert.equal(by['music-5'].art, null)
  assert.equal(by['music-5'].albumType, 'EP')
  // The date is read as written: midnight UTC is never shifted a day early west of Greenwich.
  const west = musicItems([calAlbum(1)], new Map(), NOW, 'America/Toronto', end)
  assert.equal(west[0].day, '2026-06-20')
  const groups = groupItems(items, NOW, 'UTC')
  assert.ok(groups.flatMap(g => g.items).every(i => i.kind === 'music'))
})

test('upcoming: TV, films and music sort in that order within a day', () => {
  const g = groupItems([
    { id: 'm', kind: 'music', title: 'A', day: '2026-06-16', when: '', status: 'upcoming', statusText: '', art: null },
    { id: 'f', kind: 'film', title: 'A', day: '2026-06-16', when: '', status: 'upcoming', statusText: '', art: null },
    { id: 't', kind: 'tv', title: 'A', day: '2026-06-16', when: '', status: 'upcoming', statusText: '', art: null, airUtc: '2026-06-16T20:00:00Z' },
  ], NOW, 'UTC')
  assert.deepEqual(g[0].items.map(i => i.id), ['t', 'f', 'm'])
})

test('upcoming: missing albums strip counts only albums already out', () => {
  const m = lidarrMissing({ totalRecords: 3, records: [
    { id: 1, title: 'Old Record', releaseDate: '2026-06-10T00:00:00Z', artist: { artistName: 'Example Artist' } },
    { id: 2, title: 'Today Record', releaseDate: '2026-06-15T00:00:00Z', artist: { artistName: 'Example Artist' } },
    { id: 3, title: 'Future Record', releaseDate: '2026-07-01T00:00:00Z', artist: { artistName: 'Example Artist' } },
  ] }, NOW, 'UTC')
  assert.equal(m.total, 2)
  assert.deepEqual(m.items[0], { id: 'music-1', title: 'Example Artist', detail: 'Old Record', date: 'released 5 days ago' })
  assert.equal(m.items[1].date, 'released today')
  assert.equal(lidarrMissing({ totalRecords: 80, records: [{ id: 1, releaseDate: '2026-01-01T00:00:00Z' }] }, NOW, 'UTC').approximate, true)
})

test('upcoming: Lidarr read on v1; absent without Lidarr; down greys only its own part', async () => {
  const seen: string[] = []
  const lid = { async get(p: string) { seen.push(p); if (p.startsWith('/api/v1/calendar')) return [calAlbum(1)]; if (p.startsWith('/api/v1/queue')) return { records: [] }; return { totalRecords: 1, records: [{ id: 5, title: 'Gone Record', releaseDate: '2026-06-01T00:00:00Z', artist: { artistName: 'Example Artist' } }] } } } as any
  const none = { async get() { return [] } } as any
  const d = await readUpcoming({ sonarr: none, radarr: none, lidarr: lid, now: NOW, tz: 'UTC', days: 14 })
  assert.ok(seen.every(p => p.startsWith('/api/v1/')))
  assert.ok(seen.some(p => p.startsWith('/api/v1/calendar?start=2026-06-15&end=2026-06-29') && p.includes('includeArtist=true')))
  assert.deepEqual([d.services.lidarr, d.counts.music, d.groups.flatMap(g => g.items).map(i => i.id), d.missing.lidarr!.total], [{ ok: true }, 1, ['music-1'], 1])
  const without = await readUpcoming({ sonarr: none, radarr: none, now: NOW, tz: 'UTC', days: 14 })
  assert.deepEqual([without.services.lidarr, without.counts.music, without.missing.lidarr], [undefined, undefined, undefined], 'nothing music-related')
  assert.deepEqual(Object.keys(without.counts), ['tv', 'film', 'tonight', 'downloading'])
  const dead = await readUpcoming({ sonarr: none, radarr: none, lidarr: { async get() { throw new Error('HTTP 502') } } as any, now: NOW, tz: 'UTC', days: 14 })
  assert.deepEqual([dead.services.sonarr.ok, dead.services.lidarr!.ok, dead.services.lidarr!.error], [true, false, 'HTTP 502'])
})

test('covers: a Lidarr cover is rebuilt server-side from two checked parts; nothing else gets through', async () => {
  assert.deepEqual(arrArtKey('lidarr', '12'), { app: 'lidarr', id: '12' })
  assert.equal(arrArtKey('lidarr', '../1'), null); assert.equal(arrArtKey('tidal', '1'), null)
  assert.equal(artRef('lidarr', 5), '/api/plugins/arrstack/art/lidarr/5')
  assert.deepEqual(arrArtUpstream({ app: 'lidarr', id: '3' }), ['/api/v1/mediacover/album/3/cover-250.jpg', '/api/v1/mediacover/album/3/cover.jpg'])
  assert.deepEqual(arrArtUpstream({ app: 'sonarr', id: '3' }), ['/api/v3/mediacover/3/poster-250.jpg', '/api/v3/mediacover/3/poster.jpg'])
  const images: string[] = []
  const lid = { async image(p: string) { images.push(p); return { contentType: 'image/jpeg', body: Buffer.from('x') } } } as any
  const a = Fastify({ logger: false })
  await registerGate(a); await a.register(authRoutes, { prefix: '/api/auth' })
  await a.register(buildArrUpcomingRoutes({ sonarr: async () => null, radarr: async () => null, lidarr: async () => lid }), { prefix: '/api/plugins/arrstack' })
  await a.ready()
  try {
    const { cookie } = await signIn(a, 'viewer@example.com', 'viewer master password')
    const r = await a.inject({ method: 'GET', url: '/api/plugins/arrstack/art/lidarr/44?path=/api/v1/system/status&host=evil', headers: { cookie } })
    assert.equal(r.statusCode, 200)
    assert.deepEqual(images, ['/api/v1/mediacover/album/44/cover-250.jpg'], 'the query string is ignored; the path is rebuilt')
    const up = await a.inject({ method: 'GET', url: '/api/plugins/arrstack/upcoming?days=14', headers: { cookie } })
    const body = up.body
    assert.equal(up.statusCode, 200)
    assert.ok(!body.includes(KEY) && !body.includes(ADDR))
  } finally { await a.close() }
})

test('the all-arr read paths in the API never use v3 for Lidarr', () => {
  // A guard for the easy mistake: copying a Sonarr call. The fake refuses anything that is not /api/v1/.
  const fl = fakeLidarr([])
  return assert.rejects(fl.client.get('/api/v3/queue'), /no \/api\/v3\/queue/)
})
