// Arr Stack "Give up after X tries": counting tries from lastSearchTime, why it keeps failing (history and one release
// search), the whole-season rows, the preview that turning it on must confirm, the daily run (unmonitor or remove,
// never a file, never a profile, every change read back, audited and notified), try again, "See what's available"
// with its hard rules (AV1, 3D, 48 fps hidden; program files never grabbable; 0-seed torrents hidden by default), and a
// grab verified against the queue filtered client-side. The fixtures are recorded arr answers with made-up titles.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import Fastify from 'fastify'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { requiredRole, needsReconfirm } from '../src/lib/roles'
import { buildArrGiveUpRoutes } from '../src/routes/arr-giveup'
import { readUpcoming } from '../src/routes/arr-upcoming'
import {
  DEFAULT_SETTINGS, candidates, classify, historyEvents, lidarrItems, observe, parseSettings, radarrItems, rows, sonarrItems, summarise, wholeSeasons,
  giveUpMessage, type GiveUpSettings, type Track,
} from '../src/lib/arr-giveup/logic'
import { hardRule, plainRejection, profileInfo, releaseView } from '../src/lib/arr-giveup/releases'
import { GiveUpRefusal, GiveUpService, SEARCH_COOLDOWN_MS, type GiveUpDeps } from '../src/lib/arr-giveup/service'
import { MemoryGiveUpStore } from '../src/lib/arr-giveup/store'
import { familyOf } from '../src/lib/notify/types'
import type { CoreEndpointClient } from '../src/lib/plugin-host'
import { signIn } from './fakes/app'
import { FakeBroker } from './fakes/fake-broker'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { setAuditSink } from '../src/lib/audit'
import { MemoryApiTokenStore, setApiTokenStore, createApiToken, tokenForbidden } from '../src/lib/api-tokens'
import { MissLimiter } from '../src/lib/plex-art'

const FIX = path.join(__dirname, 'fixtures', 'arr-giveup')
const fx = (n: string) => JSON.parse(fs.readFileSync(path.join(FIX, n), 'utf8'))
const NOW = Date.parse('2026-11-16T12:00:00Z')
const NOW_ISO = new Date(NOW).toISOString()

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

// ── reading the missing lists ────────────────────────────────────────────────

test('missing lists: Sonarr episodes, only Radarr films it calls available, only Lidarr albums out with no track on disk', () => {
  const tv = sonarrItems(fx('sonarr-missing.json').records)
  assert.equal(tv.length, 5)
  assert.deepEqual(tv[0], {
    key: 'sonarr:101', app: 'sonarr', arrId: 101, title: 'Quiet Harbour', detail: 'S02E01 Pilot Light', seriesId: 11, season: 2, episode: 1,
    releasedAt: '2003-01-10T02:00:00.000Z', lastSearchTime: '2026-11-01T10:00:00.000Z',
  })
  const films = radarrItems(fx('radarr-missing.json').records, NOW)
  assert.deepEqual(films.map(f => f.title), ['Harbour Lights', 'The Lantern Keeper'], 'the unreleased film is not overdue')
  assert.equal(films[0].releasedAt, '1996-03-01T00:00:00.000Z', 'the first date that has passed')
  const albums = lidarrItems(fx('lidarr-missing.json').records, NOW)
  assert.deepEqual(albums.map(a => a.detail), ['Low Songs'], 'part-complete and future albums are left alone')
})

// ── counting tries ───────────────────────────────────────────────────────────

test('a try is lastSearchTime moving on while it still has no file; a search while downloading is not a try', () => {
  const items = sonarrItems(fx('sonarr-missing.json').records)
  const first = observe([], items, [], 0, NOW_ISO)
  const t101 = first.tracks.find(t => t.key === 'sonarr:101')!
  assert.equal(t101.tries, 1, 'already searched since it aired: one try at once')
  assert.equal(first.tracks.find(t => t.key === 'sonarr:201')!.tries, 0, 'never searched')
  // The same reading again: nothing moved.
  const same = observe(first.tracks, items, [], 0, NOW_ISO)
  assert.equal(same.newTries, 0)
  // Sonarr searched again for 101 and 102; 102 is downloading, so it does not count.
  const later = items.map(i => (i.arrId === 101 || i.arrId === 102 ? { ...i, lastSearchTime: '2026-11-15T10:00:00.000Z' } : i))
  const next = observe(same.tracks, later, [], 0, NOW_ISO, new Set([102]))
  assert.equal(next.tracks.find(t => t.key === 'sonarr:101')!.tries, 2)
  assert.equal(next.tracks.find(t => t.key === 'sonarr:102')!.tries, 1)
  assert.equal(next.tracks.find(t => t.key === 'sonarr:102')!.lastSearchSeen, '2026-11-15T10:00:00.000Z', 'remembered, so it is not counted later')
  // 103 got a file: it is not in the missing list any more, so it is dropped.
  const filed = observe(next.tracks, later.filter(i => i.arrId !== 103), [], 0, NOW_ISO)
  assert.deepEqual(filed.dropped, ['sonarr:103'])
})

test('history: grabs, failed downloads and failed imports are counted once each, by event id', () => {
  const evs = historyEvents('sonarr', fx('sonarr-history.json').records)
  assert.deepEqual(evs.map(e => e.type).sort(), ['failed', 'grabbed'], 'an import that worked is not a failure')
  const items = sonarrItems(fx('sonarr-missing.json').records)
  const a = observe([], items, evs, 0, NOW_ISO)
  const t = a.tracks.find(x => x.key === 'sonarr:202')!
  assert.equal(t.grabs, 1); assert.equal(t.failures, 1); assert.equal(t.lastFailure, 'Manually marked as failed')
  assert.equal(a.historyId, 5002)
  const b = observe(a.tracks, items, evs, a.historyId, NOW_ISO)
  assert.equal(b.tracks.find(x => x.key === 'sonarr:202')!.grabs, 1, 'the same events are not counted twice')
  assert.match(classify(t).text, /Grabbed once; the download failed once \(Manually marked as failed\)/)
})

test('why it keeps failing, in order of what is known', () => {
  const base = { tries: 5, grabs: 0, failures: 0, importFailures: 0 }
  assert.equal(classify({ ...base, tries: 0 }).code, 'not-searched')
  assert.equal(classify(base).code, 'nothing-usable')
  assert.equal(classify({ ...base, grabs: 2 }).code, 'never-finished')
  assert.equal(classify({ ...base, check: { at: NOW_ISO, found: 0, approved: 0, top: [] } }).text, 'No release found at all on your indexers.')
  assert.equal(classify({ ...base, check: { at: NOW_ISO, found: 20, approved: 0, top: ['Below your quality profile (12)'] } }).text,
    '20 releases found, every one rejected: Below your quality profile (12).')
  assert.equal(classify({ ...base, importFailures: 1, grabs: 1 }).code, 'import-failed')
})

// ── seasons, the plan and the preview's words ────────────────────────────────

test('a whole missing season is one row "Season N (k episodes)"; the rest stay per episode', () => {
  const items = sonarrItems(fx('sonarr-missing.json').records)
  const { tracks } = observe([], items, [], 0, NOW_ISO)
  const whole = wholeSeasons(fx('sonarr-series.json'), tracks)
  assert.deepEqual([...whole], ['11:2'])
  const r = rows(tracks, whole)
  const season = r.find(x => x.season)!
  assert.equal(season.title, 'Quiet Harbour'); assert.equal(season.detail, 'Season 2 (3 episodes)')
  assert.deepEqual(season.keys, ['sonarr:101', 'sonarr:102', 'sonarr:103'])
  assert.equal(r.filter(x => !x.season).length, 2, 'the other show is per episode: its season is not wholly missing')
})

test('candidates need enough tries AND enough age; the preview sentence counts series', () => {
  const s: GiveUpSettings = { ...DEFAULT_SETTINGS, enabled: true, tries: 3, minAgeDays: 30 }
  const t = (key: string, tries: number, releasedAt: string, extra: Partial<Track> = {}): Track => ({
    key, app: 'sonarr', arrId: Number(key.split(':')[1]), title: 'Quiet Harbour', detail: 'S01E01', seriesId: 11, season: 1, episode: 1,
    releasedAt, firstMissingAt: '2026-11-10T00:00:00.000Z', lastSearchSeen: null, tries, grabs: 0, failures: 0, importFailures: 0, state: 'tracking', ...extra,
  })
  const list = [t('sonarr:1', 3, '2003-01-01T00:00:00.000Z'), t('sonarr:2', 2, '2003-01-01T00:00:00.000Z'), t('sonarr:3', 9, '2026-11-01T00:00:00.000Z'),
    t('sonarr:4', 5, '2003-01-01T00:00:00.000Z', { seriesId: 12, title: 'Night Ferry' }), t('sonarr:5', 5, '2003-01-01T00:00:00.000Z', { state: 'given-up' })]
  const c = candidates(list, s, NOW)
  assert.deepEqual(c.map(x => x.key), ['sonarr:1', 'sonarr:4'])
  assert.deepEqual(candidates(list, s, NOW, new Set([4])).map(x => x.key), ['sonarr:1'], 'never one that is downloading')
  assert.deepEqual(candidates(list, { ...s, ageFrom: 'first-missing' }, NOW).map(x => x.key), [], 'first seen missing six days ago')
  assert.equal(summarise({ sonarr: c }), 'This would give up on 2 TV episodes (2 series).')
  assert.equal(summarise({}), 'Nothing would be given up today.')
})

test('settings: off by default, 14 tries, 30 days, stop searching; TV can never be removed', () => {
  assert.deepEqual(DEFAULT_SETTINGS, { enabled: false, tries: 14, minAgeDays: 30, ageFrom: 'released', action: 'unmonitor' })
  assert.match(String(parseSettings('sonarr', { ...DEFAULT_SETTINGS, action: 'remove' })), /TV episodes can only stop being searched for/)
  assert.equal(typeof parseSettings('radarr', { ...DEFAULT_SETTINGS, action: 'remove' }), 'object')
  assert.match(String(parseSettings('radarr', { ...DEFAULT_SETTINGS, tries: 0 })), /Tries must be/)
  assert.match(String(parseSettings('radarr', { ...DEFAULT_SETTINGS, action: 'delete-files' })), /Pick stop searching or remove/)
})

// ── releases ─────────────────────────────────────────────────────────────────

test('releases: best first, the arr top pick marked, hard rules hidden with counts, program files flagged, reasons in plain English', () => {
  const profile = profileInfo(fx('radarr-profile.json'))!
  assert.equal(profile.minResolution, 720)
  const v = releaseView(fx('radarr-release.json'), { app: 'radarr', profile })
  assert.deepEqual(v.hidden, { av1: 1, threeD: 1, hfr: 1, zeroSeed: v.hidden.zeroSeed })
  assert.ok(v.hidden.zeroSeed >= 1, 'a torrent with no seeders is hidden by default')
  assert.ok(v.rows.every(r => r.seeders !== 0))
  assert.ok(releaseView(fx('radarr-release.json'), { app: 'radarr', profile, showZeroSeed: true }).rows.some(r => r.seeders === 0))
  assert.equal(v.rows[0].approved, true); assert.equal(v.rows[0].topPick, true)
  assert.equal(v.rows.filter(r => r.topPick).length, 1)
  assert.equal(v.rows[0].quality, 'Bluray-1080p'); assert.equal(v.rows[0].source, 'BluRay'); assert.equal(v.rows[0].codec, 'HEVC')
  assert.ok(!JSON.stringify(v.rows).includes('indexer.example.invalid'), 'no guid or link reaches the page')
  const exe = v.rows.find(r => r.title.endsWith('.exe'))!
  assert.equal(exe.executable, true)
  const dvd = v.rows.find(r => r.quality === 'DVD')!
  assert.equal(dvd.belowProfile, true)
  assert.equal(dvd.belowNote, 'This is DVD; your profile wants 720p or better. Radarr will keep looking for a better copy and replace it when one appears.')
  assert.ok(dvd.reasons.includes('Below your quality profile (DVD)'), dvd.reasons.join(' | '))
  assert.ok(v.top.length > 0 && v.top.length <= 3)
})

test('rejection strings in plain English', () => {
  assert.equal(plainRejection('DVD is not wanted in profile'), 'Below your quality profile (DVD)')
  assert.equal(plainRejection("Custom Formats LQ have score -10000 below Movie's profile minimum 0"), 'Custom format score too low (LQ: -10000)')
  assert.equal(plainRejection('Not enough seeders: 1. Minimum seeders: 5'), 'Too few seeders (1; your indexer setting needs 5)')
  assert.equal(plainRejection('1.6 GB is smaller than minimum allowed 1.7 GB (for Harbour Lights)'), 'Too small for its quality (likely a poor copy)')
  assert.equal(plainRejection('25.1 GB is larger than maximum allowed 20 GB'), 'Too large')
  assert.equal(plainRejection('Original Language (English) is wanted, but found Russian'), 'Wrong language (Russian)')
  assert.equal(plainRejection('Hardcode subs found: ESUB'), 'Has burned-in subtitles')
  assert.equal(plainRejection('Something new'), 'Something new')
  assert.equal(hardRule('Film.2012.HFR.1080p'), 'hfr')
  assert.equal(hardRule('Film.2012.1080p', ['AV1']), 'av1')
  assert.equal(hardRule('Film.2012.1080p.x264'), null)
})

// ── the service against fake arrs ────────────────────────────────────────────

interface Call { method: string; path: string; body?: any }
function fakeArr(h: (method: string, path: string, body?: any) => any) {
  const calls: Call[] = []
  const go = async (method: string, p: string, body?: any) => {
    calls.push({ method, path: p, ...(body !== undefined ? { body } : {}) })
    const r = h(method, p, body)
    if (r instanceof Error) throw r
    return r
  }
  const client: CoreEndpointClient = {
    get: p => go('GET', p), delete: p => go('DELETE', p), put: (p, b) => go('PUT', p, b), post: (p, b) => go('POST', p, b),
    image: async () => { throw new Error('no') }, trigger: async () => {},
  }
  return { client, calls }
}
const page = (records: any[]) => ({ page: 1, pageSize: 1000, totalRecords: records.length, records })

function rig(arrs: Partial<Record<'sonarr' | 'radarr' | 'lidarr', CoreEndpointClient>>, extra: Partial<GiveUpDeps> = {}) {
  const store = new MemoryGiveUpStore()
  const audits: Array<{ action: string; details: any }> = []
  const sent: any[] = []
  let now = NOW
  const svc = new GiveUpService({
    clients: { sonarr: async () => arrs.sonarr ?? null, radarr: async () => arrs.radarr ?? null, lidarr: async () => arrs.lidarr ?? null },
    qbit: async () => null, store,
    audit: async (action, details) => { audits.push({ action, details }) },
    publish: async e => { sent.push(e) },
    now: () => now, sleep: async () => {}, unlocked: () => true, grabWaitMs: 8, ...extra,
  })
  return { svc, store, audits, sent, setNow: (t: number) => { now = t } }
}

const tracked = (o: Partial<Track> & Pick<Track, 'key' | 'arrId' | 'app'>): Track => ({
  title: 'Harbour Lights', detail: '1996', releasedAt: '1996-03-01T00:00:00.000Z', firstMissingAt: '2026-01-01T00:00:00.000Z',
  lastSearchSeen: null, tries: 20, grabs: 0, failures: 0, importFailures: 0, state: 'tracking', ...o,
})

test('turning the rule on needs a preview of that exact rule; the preview changes nothing', async () => {
  const sonarrRecs = fx('sonarr-missing.json').records
  const fa = fakeArr((m, p) => {
    if (m !== 'GET') return new Error(`unexpected ${m} ${p}`)
    if (p.startsWith('/api/v3/wanted/missing')) return page(sonarrRecs)
    if (p.startsWith('/api/v3/queue')) return page([])
    if (p.startsWith('/api/v3/history')) return page([])
    if (p === '/api/v3/series') return fx('sonarr-series.json')
    return new Error(`unexpected ${p}`)
  })
  const { svc } = rig({ sonarr: fa.client })
  const s: GiveUpSettings = { ...DEFAULT_SETTINGS, enabled: true, tries: 1, minAgeDays: 30 }
  await assert.rejects(svc.saveSettings('sonarr', s, undefined, 'admin@example.com'), (e: any) => e instanceof GiveUpRefusal && e.code === 'preview_required')
  const p = await svc.preview('sonarr', s)
  assert.equal(p.summary, 'This would give up on 4 TV episodes (2 series).')
  assert.deepEqual(p.rows.map(r => r.detail), ['S01E04 Fog Bank', 'Season 2 (3 episodes)'], 'a whole old season is one row')
  assert.equal(p.rows[0].reason.code, 'nothing-usable')
  assert.ok(fa.calls.every(c => c.method === 'GET'), 'a preview only reads')
  await assert.rejects(svc.saveSettings('sonarr', { ...s, tries: 2 }, p.previewId, 'admin@example.com'), /preview/, 'a different rule from the one previewed')
  const saved = await svc.saveSettings('sonarr', s, p.previewId, 'admin@example.com')
  assert.equal(saved.enabled, true)
  // Switching off never needs a preview.
  assert.equal((await svc.saveSettings('sonarr', { ...s, enabled: false }, undefined, 'admin@example.com')).enabled, false)
})

test('the daily run unmonitors what qualifies, re-checked live and read back; a file or a download is left alone', async () => {
  const monitored: Record<number, boolean> = { 101: true, 102: true, 103: true }
  const hasFile: Record<number, boolean> = { 101: false, 102: true, 103: false }
  const fa = fakeArr((m, p, b) => {
    if (m === 'GET' && p.startsWith('/api/v3/queue')) return page([{ id: 9, episodeId: 103, seriesId: 11 }, { id: 10, episodeId: 555, seriesId: 99 }])
    if (m === 'GET' && p.startsWith('/api/v3/episode?')) {
      const ids = [...p.matchAll(/episodeIds=(\d+)/g)].map(x => Number(x[1]))
      return ids.map(id => ({ id, hasFile: hasFile[id], monitored: monitored[id], episodeFileId: hasFile[id] ? 5 : 0 }))
    }
    if (m === 'PUT' && p === '/api/v3/episode/monitor') { for (const id of b.episodeIds) monitored[id] = b.monitored; return [] }
    return new Error(`unexpected ${m} ${p}`)
  })
  const { svc, store, audits, sent } = rig({ sonarr: fa.client })
  await store.save([101, 102, 103].map(id => tracked({ key: `sonarr:${id}`, arrId: id, app: 'sonarr', title: 'Quiet Harbour', detail: `S02E0${id - 100}`, seriesId: 11, season: 2, episode: id - 100 })))
  const r = await svc.run('sonarr', { ...DEFAULT_SETTINGS, enabled: true }, 'test')
  assert.equal(r.given, 1)
  assert.deepEqual(r.skipped.map(x => x.why), ['It has a file now.'])
  const put = fa.calls.filter(c => c.method === 'PUT')
  assert.deepEqual(put.map(c => c.body), [{ episodeIds: [101], monitored: false }], 'only the one with no file and not downloading')
  assert.ok(!fa.calls.some(c => c.method === 'DELETE' || /qualityprofile|series\//.test(c.path) && c.method !== 'GET'), 'no delete, no profile change')
  const t = (await store.tracks('sonarr')).find(x => x.key === 'sonarr:101')!
  assert.equal(t.state, 'given-up'); assert.equal(t.action, 'unmonitor'); assert.ok(t.reason)
  assert.deepEqual(audits.map(a => a.action), ['arrstack.giveup.run', 'arrstack.giveup.run.done'], 'audited before and after')
  assert.equal(sent.length, 1); assert.equal(sent[0].type, 'arr.gaveup'); assert.match(sent[0].title, /gave up on 1 TV episode$/)
  assert.equal(familyOf('arr.gaveup'), 'media')
})

test('remove (films): deleteFiles=false with an import exclusion, never when there is a file; try again adds it back the same way', async () => {
  const films: Record<number, any> = {
    7: { id: 7, title: 'Harbour Lights', year: 1996, tmdbId: 900007, qualityProfileId: 7, path: '/media/Movies/Harbour Lights (1996)', rootFolderPath: null, minimumAvailability: 'released', tags: [3], monitored: true, hasFile: false, movieFileId: 0, sizeOnDisk: 0 },
    8: { id: 8, title: 'The Lantern Keeper', year: 2006, tmdbId: 900008, qualityProfileId: 7, path: '/media/Movies/The Lantern Keeper (2006)', monitored: true, hasFile: true, movieFileId: 4, sizeOnDisk: 10 },
  }
  let exclusions = [{ id: 1, tmdbId: 123 }]
  const fa = fakeArr((m, p, b) => {
    if (m === 'GET' && p.startsWith('/api/v3/queue')) return page([])
    let g = /^\/api\/v3\/movie\/(\d+)$/.exec(p)
    if (m === 'GET' && g) return films[Number(g[1])] ?? new Error('404 Not Found')
    g = /^\/api\/v3\/movie\/(\d+)\?(.*)$/.exec(p)
    if (m === 'DELETE' && g) { exclusions.push({ id: 2, tmdbId: films[Number(g[1])].tmdbId }); delete films[Number(g[1])]; return null }
    if (m === 'GET' && p === '/api/v3/exclusions') return exclusions
    if (m === 'DELETE' && p.startsWith('/api/v3/exclusions/')) { exclusions = exclusions.filter(e => e.id !== Number(p.split('/').pop())); return null }
    if (m === 'POST' && p === '/api/v3/movie') { films[70] = { ...b, id: 70 }; return films[70] }
    return new Error(`unexpected ${m} ${p}`)
  })
  const { svc, store } = rig({ radarr: fa.client })
  await store.save([tracked({ key: 'radarr:7', arrId: 7, app: 'radarr' }), tracked({ key: 'radarr:8', arrId: 8, app: 'radarr', title: 'The Lantern Keeper' })])
  const r = await svc.run('radarr', { ...DEFAULT_SETTINGS, enabled: true, action: 'remove' }, 'test')
  assert.equal(r.given, 1)
  const del = fa.calls.filter(c => c.method === 'DELETE')
  assert.deepEqual(del.map(c => c.path), ['/api/v3/movie/7?deleteFiles=false&addImportExclusion=true'], 'the film with a file is not removed')
  const gone = (await store.tracks('radarr')).find(t => t.key === 'radarr:7')!
  assert.deepEqual(gone.restore, { tmdbId: 900007, year: 1996, qualityProfileId: 7, rootFolderPath: '/media/Movies', path: '/media/Movies/Harbour Lights (1996)', minimumAvailability: 'released', tags: [3] })
  // Try again: the exclusion goes, the film comes back with the same profile and folder, searched for.
  const out = await svc.tryAgain(['radarr:7'], 'admin@example.com')
  assert.match(out.summary, /Trying again: 1 film/)
  const add = fa.calls.find(c => c.method === 'POST' && c.path === '/api/v3/movie')!
  assert.equal(add.body.qualityProfileId, 7); assert.equal(add.body.rootFolderPath, '/media/Movies'); assert.equal(add.body.addOptions.searchForMovie, true)
  assert.ok(!exclusions.some(e => e.tmdbId === 900007))
  assert.equal((await store.tracks('radarr')).some(t => t.key === 'radarr:7'), false, 'its old id is forgotten; the new one is counted afresh')
})

test('try again (stop searching): monitored again, read back, and a search asked for; the command is read back too', async () => {
  const mon: Record<number, boolean> = { 101: false }
  const fa = fakeArr((m, p, b) => {
    if (m === 'PUT' && p === '/api/v3/episode/monitor') { for (const id of b.episodeIds) mon[id] = b.monitored; return [] }
    if (m === 'GET' && p.startsWith('/api/v3/episode?')) return [{ id: 101, monitored: mon[101], hasFile: false }]
    if (m === 'POST' && p === '/api/v3/command') return { id: 77, status: 'queued' }
    if (m === 'GET' && p === '/api/v3/command/77') return { id: 77, status: 'started' }
    return new Error(`unexpected ${m} ${p}`)
  })
  const { svc, store, audits } = rig({ sonarr: fa.client })
  await store.save([tracked({ key: 'sonarr:101', arrId: 101, app: 'sonarr', state: 'given-up', action: 'unmonitor', gaveUpAt: NOW_ISO, reason: 'x' })])
  const r = await svc.tryAgain(['sonarr:101'], 'admin@example.com')
  assert.deepEqual(r.notes, ['Sonarr is searching (started); anything it grabs shows in the queue.'])
  const t = (await store.tracks('sonarr'))[0]
  assert.equal(t.state, 'tracking'); assert.equal(t.tries, 0); assert.equal(t.reason, undefined)
  assert.deepEqual(fa.calls.find(c => c.method === 'POST')!.body, { name: 'EpisodeSearch', episodeIds: [101] })
  assert.equal(audits[0].action, 'arrstack.giveup.tryagain')
  await assert.rejects(svc.tryAgain(['sonarr:101'], 'admin@example.com'), (e: any) => e.code === 'not_given_up')
})

test("see what's available: one search per item per ten minutes; a grab sends guid and indexer only, checked against the queue filtered here", async () => {
  const releases = fx('radarr-release.json')
  let searches = 0
  let queue: any[] = [{ id: 1, movieId: 500, title: 'Some.Other.Film' }]
  const fa = fakeArr((m, p, b) => {
    if (m === 'GET' && p === '/api/v3/movie/7') return { id: 7, title: 'Harbour Lights', year: 1996, qualityProfileId: 7, hasFile: false }
    if (m === 'GET' && p === '/api/v3/qualityprofile/7') return fx('radarr-profile.json')
    if (m === 'GET' && p === '/api/v3/release?movieId=7') { searches++; return releases }
    if (m === 'GET' && p.startsWith('/api/v3/queue')) return page(queue)
    if (m === 'POST' && p === '/api/v3/release') { queue = [...queue, { id: 2, movieId: 7, title: 'whatever', downloadId: 'A'.repeat(40) }]; return {} }
    return new Error(`unexpected ${m} ${p}`)
  })
  const { svc, store, setNow, audits } = rig({ radarr: fa.client })
  await store.save([tracked({ key: 'radarr:7', arrId: 7, app: 'radarr' })])
  const a = await svc.releases('radarr:7', 'admin@example.com')
  assert.equal(searches, 1); assert.equal(a.reused, false); assert.equal(a.label, 'Harbour Lights (1996)')
  assert.equal(a.hidden.av1, 1)
  const again = await svc.releases('radarr:7', 'admin@example.com', { showZeroSeed: true })
  assert.equal(searches, 1, 'within ten minutes the last answer is used'); assert.equal(again.reused, true)
  assert.ok(again.rows.length > a.rows.length, 'the 0-seed toggle needs no new search')
  const t = (await store.tracks('radarr'))[0]
  assert.equal(t.check?.found, releases.length); assert.ok(t.check!.approved >= 1)

  const exe = a.rows.find(r => r.executable)!
  await assert.rejects(svc.grab('radarr:7', exe.id, 'admin@example.com'), (e: any) => e.code === 'executable')
  const dvd = a.rows.find(r => r.quality === 'DVD')!
  const g = await svc.grab('radarr:7', dvd.id, 'admin@example.com')
  assert.equal(g.result, 'queued', g.summary)
  const post = fa.calls.find(c => c.method === 'POST')!
  assert.deepEqual(Object.keys(post.body).sort(), ['guid', 'indexerId'], 'the exact release, nothing about the profile')
  assert.ok(!fa.calls.some(c => /qualityprofile/.test(c.path) && c.method !== 'GET'))
  assert.ok(audits.some(x => x.action === 'arrstack.giveup.grab' && x.details.belowProfile === true))
  // After ten minutes a new search runs.
  setNow(NOW + SEARCH_COOLDOWN_MS + 1)
  await svc.releases('radarr:7', 'admin@example.com')
  assert.equal(searches, 2)
})

test('a grab whose torrent turns out to hold a program file is removed and blocklisted; one not seen in time says so', async () => {
  const releases = fx('radarr-release.json')
  let queue: any[] = []
  const fa = fakeArr((m, p) => {
    if (m === 'GET' && p === '/api/v3/movie/7') return { id: 7, title: 'Harbour Lights', year: 1996, qualityProfileId: 7, hasFile: false }
    if (m === 'GET' && p === '/api/v3/qualityprofile/7') return fx('radarr-profile.json')
    if (m === 'GET' && p === '/api/v3/release?movieId=7') return releases
    if (m === 'GET' && p.startsWith('/api/v3/queue')) return page(queue)
    if (m === 'POST' && p === '/api/v3/release') { queue = [{ id: 3, movieId: 7, title: 'x', downloadId: 'B'.repeat(40) }]; return {} }
    if (m === 'DELETE' && p.startsWith('/api/v3/queue/3')) return null
    return new Error(`unexpected ${m} ${p}`)
  })
  const qb = fakeArr((m, p) => (p.startsWith('/api/v2/torrents/files') ? [{ name: 'Harbour Lights/setup.exe' }, { name: 'Harbour Lights/film.mkv' }] : new Error('no')))
  const { svc } = rig({ radarr: fa.client }, { qbit: async () => qb.client })
  const a = await svc.releases('radarr:7', 'admin@example.com')
  const g = await svc.grab('radarr:7', a.rows[0].id, 'admin@example.com')
  assert.equal(g.result, 'removed-executable')
  assert.equal(fa.calls.find(c => c.method === 'DELETE')!.path, '/api/v3/queue/3?removeFromClient=true&blocklist=true')

  // The queue never shows it (and an unrelated row from another film is not mistaken for it).
  const fb = fakeArr((m, p) => {
    if (m === 'GET' && p === '/api/v3/movie/7') return { id: 7, title: 'Harbour Lights', year: 1996, qualityProfileId: 7, hasFile: false }
    if (m === 'GET' && p === '/api/v3/qualityprofile/7') return fx('radarr-profile.json')
    if (m === 'GET' && p === '/api/v3/release?movieId=7') return releases
    if (m === 'GET' && p.startsWith('/api/v3/queue')) return page([{ id: 50, movieId: 99, title: 'Another.Film' }])
    if (m === 'POST') return {}
    return new Error(`unexpected ${m} ${p}`)
  })
  const two = rig({ radarr: fb.client })
  const b = await two.svc.releases('radarr:7', 'admin@example.com')
  const nb = await two.svc.grab('radarr:7', b.rows[0].id, 'admin@example.com')
  assert.equal(nb.result, 'not-seen')
  await assert.rejects(two.svc.grab('radarr:7', b.rows[0].id, 'admin@example.com'), (e: any) => e.code === 'search_used', 'a search is used once')
  assert.equal((await two.svc.releases('radarr:7', 'admin@example.com')).reused, true, 'and grabbing does not reset the ten-minute limit')
})

test('a removed film cannot be searched until it is added back', async () => {
  const fa = fakeArr(() => new Error('should not be called'))
  const { svc, store } = rig({ radarr: fa.client })
  await store.save([tracked({ key: 'radarr:7', arrId: 7, app: 'radarr', state: 'given-up', action: 'remove' })])
  await assert.rejects(svc.releases('radarr:7', 'admin@example.com'), (e: any) => e.code === 'removed')
})

test('the notification is short: up to ten lines, then a count, and says nothing was deleted', () => {
  const many = Array.from({ length: 13 }, (_, i) => tracked({ key: `radarr:${i + 1}`, arrId: i + 1, app: 'radarr', title: `Film ${String(i + 1).padStart(2, '0')}`, state: 'given-up' }))
  const m = giveUpMessage(many)!
  assert.equal(m.title, 'Arr Stack gave up on 13 films')
  assert.equal(m.lines.length, 12); assert.equal(m.lines[10], 'and 3 more'); assert.match(m.lines[11], /Nothing was deleted/)
  assert.equal(giveUpMessage([]), null)
})

test('the Missing panel carries the given-up counts', async () => {
  const empty: CoreEndpointClient = { get: async () => ({ records: [], totalRecords: 0 }), delete: async () => null, put: async () => null, image: async () => { throw new Error('x') }, trigger: async () => {} }
  const cal: CoreEndpointClient = { ...empty, get: async (p: string) => (p.includes('calendar') ? [] : { records: [], totalRecords: 0 }) }
  const d = await readUpcoming({ sonarr: cal, radarr: cal, now: NOW, tz: 'UTC', days: 7, givenUp: async () => ({ sonarr: 4, radarr: 2, lidarr: 0 }) })
  assert.equal(d.missing.sonarr?.givenUp, 4); assert.equal(d.missing.radarr?.givenUp, 2)
  const none = await readUpcoming({ sonarr: cal, radarr: cal, now: NOW, tz: 'UTC', days: 7 })
  assert.equal(none.missing.sonarr?.givenUp, undefined)
})

// ── roles and the routes through the real gate ───────────────────────────────

test('roles: the list is viewer; every POST is admin and refused to API tokens; no master password', () => {
  assert.equal(requiredRole('GET', '/api/plugins/arrstack/give-up'), 'viewer')
  for (const p of ['preview', 'settings', 'try-again', 'releases', 'grab']) {
    assert.equal(requiredRole('POST', `/api/plugins/arrstack/give-up/${p}`), 'admin', p)
    assert.equal(tokenForbidden('POST', `/api/plugins/arrstack/give-up/${p}`), true, p)
    assert.equal(needsReconfirm('POST', `/api/plugins/arrstack/give-up/${p}`), false, p)
  }
  assert.equal(tokenForbidden('GET', '/api/plugins/arrstack/give-up'), false)
})

test('routes: viewer reads, cannot act; a token is refused; grab and try again need confirming; bad input refused', async () => {
  const fa = fakeArr((m, p) => (m === 'GET' ? page([]) : new Error(`unexpected ${m} ${p}`)))
  const { svc } = rig({ sonarr: fa.client })
  const a = Fastify({ logger: false })
  await registerGate(a)
  await a.register(authRoutes, { prefix: '/api/auth' })
  await a.register(buildArrGiveUpRoutes({ service: () => svc, limiter: new MissLimiter(50) }), { prefix: '/api/plugins/arrstack' })
  await a.ready()
  try {
    const viewer = await signIn(a, 'viewer@example.com', 'viewer master password')
    const st = await a.inject({ method: 'GET', url: '/api/plugins/arrstack/give-up', headers: { cookie: viewer.cookie } })
    assert.equal(st.statusCode, 200, st.body)
    const data = JSON.parse(st.body).data
    assert.deepEqual(data.apps.map((x: any) => [x.app, x.configured, x.settings.enabled]), [['sonarr', true, false], ['radarr', false, false], ['lidarr', false, false]])
    const vp = await a.inject({ method: 'POST', url: '/api/plugins/arrstack/give-up/releases', headers: { cookie: viewer.cookie }, payload: { target: 'sonarr:1' } })
    assert.equal(vp.statusCode, 403)
    const tok = (await createApiToken({ name: 'bot', role: 'admin' }, 'test', tokens)).token
    const tp = await a.inject({ method: 'POST', url: '/api/plugins/arrstack/give-up/settings', headers: { authorization: `Bearer ${tok}` }, payload: { app: 'sonarr', settings: DEFAULT_SETTINGS } })
    assert.equal(tp.statusCode, 403); assert.equal(JSON.parse(tp.body).code, 'token_forbidden')
    const adm = await signIn(a, 'admin@example.com', 'admin master password')
    const post = (url: string, payload: any) => a.inject({ method: 'POST', url: `/api/plugins/arrstack/give-up/${url}`, headers: { cookie: adm.cookie }, payload })
    assert.equal(JSON.parse((await post('grab', { target: 'radarr:7', releaseId: 'a'.repeat(24) })).body).code, 'confirm_required')
    assert.equal(JSON.parse((await post('try-again', { keys: ['radarr:7'] })).body).code, 'confirm_required')
    assert.equal((await post('releases', { target: 'radarr:7; rm' })).statusCode, 400)
    assert.equal((await post('settings', { app: 'sonarr', settings: { ...DEFAULT_SETTINGS, action: 'remove' } })).statusCode, 400)
    const on = await post('settings', { app: 'sonarr', settings: { ...DEFAULT_SETTINGS, enabled: true } })
    assert.equal(on.statusCode, 409); assert.equal(JSON.parse(on.body).code, 'preview_required')
    assert.ok(fa.calls.every(c => c.method === 'GET'), 'nothing changed in the arr')
  } finally { await a.close() }
})
