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
  DEFAULT_SETTINGS, candidates, filmReleased, nextSearchAt, scheduledThisWeek, tryWeek, parseKey, searchDue, storedSettings, weekKey, classify, historyEvents, lidarrItems, observe, parseSettings, radarrItems, rows, sonarrItems, summarise, wholeSeasons,
  giveUpMessage, type GiveUpSettings, type Track,
} from '../src/lib/arr-giveup/logic'
import { hardRule, isProgramFile, plainRejection, profileInfo, releaseView } from '../src/lib/arr-giveup/releases'
import { GiveUpRefusal, GiveUpService, MAX_PER_RUN, RECHECK_MS, SEARCH_COOLDOWN_MS, parseTarget, type GiveUpDeps } from '../src/lib/arr-giveup/service'
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
  assert.equal(films[0].releasedAt, '2020-02-20T00:00:00.000Z', 'minimum availability "released": the digital release first')
  const albums = lidarrItems(fx('lidarr-missing.json').records, NOW)
  assert.deepEqual(albums.map(a => a.detail), ['Low Songs'], 'part-complete and future albums are left alone')
})

// ── counting tries ───────────────────────────────────────────────────────────

test('a try is a search in a new calendar week while it still has no file; the search before watching is not one; a search while downloading is not one', () => {
  const items = sonarrItems(fx('sonarr-missing.json').records)
  const first = observe([], items, [], 0, NOW_ISO)
  assert.ok(first.tracks.every(t => t.tries === 0), 'searches from before HyperProx was watching are remembered, not counted')
  assert.equal(first.tracks.find(t => t.key === 'sonarr:101')!.lastSearchSeen, '2026-11-01T10:00:00.000Z')
  // The same reading again: nothing moved.
  const same = observe(first.tracks, items, [], 0, NOW_ISO)
  assert.equal(same.newTries, 0)
  // Searched again for 101 and 102; 102 is downloading, so it does not count.
  const later = items.map(i => (i.arrId === 101 || i.arrId === 102 ? { ...i, lastSearchTime: '2026-11-16T10:00:00.000Z' } : i))
  const next = observe(same.tracks, later, [], 0, NOW_ISO, new Set([102]))
  assert.equal(next.tracks.find(t => t.key === 'sonarr:101')!.tries, 1)
  assert.equal(next.tracks.find(t => t.key === 'sonarr:102')!.tries, 0)
  assert.equal(next.tracks.find(t => t.key === 'sonarr:102')!.lastSearchSeen, '2026-11-16T10:00:00.000Z', 'remembered, so it is not counted later')
  // Searched again the same week (a backfill job every two hours): still one try for that week.
  const again = observe(next.tracks, later.map(i => (i.arrId === 101 ? { ...i, lastSearchTime: '2026-11-19T02:00:00.000Z' } : i)), [], 0, NOW_ISO)
  assert.equal(again.tracks.find(t => t.key === 'sonarr:101')!.tries, 1)
  const nextWeek = observe(again.tracks, later.map(i => (i.arrId === 101 ? { ...i, lastSearchTime: '2026-11-23T02:00:00.000Z' } : i)), [], 0, NOW_ISO)
  assert.equal(nextWeek.tracks.find(t => t.key === 'sonarr:101')!.tries, 2, 'a new week, a new try')
  // 103 got a file: it is not in the missing list any more, so it is dropped.
  const filed = observe(next.tracks, later.filter(i => i.arrId !== 103), [], 0, NOW_ISO)
  assert.deepEqual(filed.dropped, ['sonarr:103'])
})

test('a film counts as out by its own minimum availability', () => {
  const m = { digitalRelease: '2020-02-20T00:00:00Z', physicalRelease: '2019-07-01T00:00:00Z', inCinemas: '2019-03-01T00:00:00Z', releaseDate: '2019-07-01T00:00:00Z' }
  assert.equal(filmReleased({ ...m, minimumAvailability: 'released' }, NOW), '2020-02-20T00:00:00.000Z', 'released: digital first')
  assert.equal(filmReleased({ ...m, minimumAvailability: 'released', digitalRelease: null }, NOW), '2019-07-01T00:00:00.000Z', 'then physical')
  assert.equal(filmReleased({ ...m, minimumAvailability: 'released', digitalRelease: '2027-01-01T00:00:00Z', physicalRelease: null }, NOW), '2019-03-01T00:00:00.000Z', 'a future date does not count; then the cinema')
  assert.equal(filmReleased({ ...m, minimumAvailability: 'inCinemas' }, NOW), '2019-03-01T00:00:00.000Z', 'inCinemas: the cinema date')
  assert.equal(filmReleased({ ...m, minimumAvailability: 'announced' }, NOW), '2019-03-01T00:00:00.000Z', 'announced: the cinema date')
  assert.equal(filmReleased({ ...m }, NOW), '2020-02-20T00:00:00.000Z', 'no minimum availability: as released')
  assert.equal(filmReleased({ releaseDate: '2018-01-01T00:00:00Z', minimumAvailability: 'released' }, NOW), '2018-01-01T00:00:00.000Z', 'no dates: Radarr\'s own')
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

test('the weeks rule: missing N weeks (from the later of release and first seen missing) AND searched in N weeks; the preview sentence counts series', () => {
  const s = { weeks: 3 }
  const t = (key: string, tries: number, releasedAt: string | null, extra: Partial<Track> = {}): Track => ({
    key, app: 'sonarr', arrId: Number(key.split(':')[1]), title: 'Quiet Harbour', detail: 'S01E01', seriesId: 11, season: 1, episode: 1,
    releasedAt, firstMissingAt: '2026-09-01T00:00:00.000Z', lastSearchSeen: null, tries, grabs: 0, failures: 0, importFailures: 0, state: 'tracking', ...extra,
  })
  const list = [
    t('sonarr:1', 3, '2003-01-01T00:00:00.000Z'),
    t('sonarr:2', 2, '2003-01-01T00:00:00.000Z'),                  // old, but searched in only two weeks so far
    t('sonarr:3', 9, '2026-11-01T00:00:00.000Z'),                  // searched a lot, but aired two weeks ago
    t('sonarr:4', 5, '2003-01-01T00:00:00.000Z', { seriesId: 12, title: 'Night Ferry' }),
    t('sonarr:5', 5, '2003-01-01T00:00:00.000Z', { state: 'given-up' }),
    t('sonarr:6', 30, '1975-01-01T00:00:00.000Z', { firstMissingAt: '2026-11-10T00:00:00.000Z' }), // very old, just added: six days
  ]
  const c = candidates(list, s, NOW)
  assert.deepEqual(c.map(x => x.key), ['sonarr:1', 'sonarr:4'])
  assert.deepEqual(candidates(list, s, NOW, new Set([4])).map(x => x.key), ['sonarr:1'], 'never one that is downloading')
  assert.deepEqual(candidates(list, { weeks: 12 }, NOW).map(x => x.key), [], 'twelve weeks needs twelve weeks of searches')
  assert.equal(summarise({ sonarr: c }), 'This would give up on 2 TV episodes (2 series).')
  assert.equal(summarise({}), 'Nothing would be given up today.')
})

test('weeks = 1 cannot fire on the search made when it was added', () => {
  const items = sonarrItems(fx('sonarr-missing.json').records)
  const addedTwoWeeksAgo = observe([], items, [], 0, '2026-11-01T00:00:00.000Z').tracks
  assert.deepEqual(candidates(addedTwoWeeksAgo, { weeks: 1 }, NOW), [], 'old enough, but no search since it was first seen')
})

test('settings: off by default, 8 weeks, stop searching, weekly search off on Monday 08:00; TV can never be removed', () => {
  assert.deepEqual(DEFAULT_SETTINGS, { enabled: false, weeks: 8, action: 'unmonitor', search: { enabled: false, day: 1, hour: 8 } })
  assert.match(String(parseSettings('sonarr', { ...DEFAULT_SETTINGS, action: 'remove' })), /TV episodes can only stop being searched for/)
  assert.equal(typeof parseSettings('radarr', { ...DEFAULT_SETTINGS, action: 'remove' }), 'object')
  assert.match(String(parseSettings('radarr', { ...DEFAULT_SETTINGS, weeks: 0 })), /Weeks must be/)
  assert.match(String(parseSettings('radarr', { ...DEFAULT_SETTINGS, weeks: 105 })), /Weeks must be/)
  assert.equal((parseSettings('radarr', { ...DEFAULT_SETTINGS, weeks: 104 }) as GiveUpSettings).weeks, 104)
  assert.match(String(parseSettings('radarr', { ...DEFAULT_SETTINGS, action: 'delete-files' })), /Pick stop searching or remove/)
  assert.match(String(parseSettings('radarr', { ...DEFAULT_SETTINGS, search: { enabled: true, day: 7, hour: 8 } })), /day of the week/)
  assert.match(String(parseSettings('radarr', { ...DEFAULT_SETTINGS, search: { enabled: true, day: 0, hour: 24 } })), /hour/)
  assert.equal((parseSettings('radarr', { enabled: false, weeks: 3, action: 'unmonitor' }) as any).search, undefined, 'no search given: the saved one is kept')
  // Rows saved before the rule was in weeks come back switched off, with the default weeks, to be previewed again.
  assert.deepEqual(storedSettings({ enabled: true, tries: 14, minAgeDays: 30, ageFrom: 'released', action: 'remove' }), { enabled: false, weeks: 8, action: 'remove', search: DEFAULT_SETTINGS.search })
  assert.deepEqual(storedSettings(null), DEFAULT_SETTINGS)
  assert.deepEqual(storedSettings({ enabled: true, weeks: 12, action: 'unmonitor', search: { enabled: true, day: 0, hour: 3 } }), { enabled: true, weeks: 12, action: 'unmonitor', search: { enabled: true, day: 0, hour: 3 } })
})

test('the weekly search calendar: due once its moment has passed in a week not yet claimed', () => {
  // Fixed local dates: Wednesday 18 Nov 2026 at 10:00 local.
  const wed10 = new Date(2026, 10, 18, 10, 0).getTime()
  const mon = { enabled: true, day: 1, hour: 8 }
  assert.equal(weekKey(wed10), '2026-11-16')
  assert.equal(weekKey(new Date(2026, 10, 22, 23, 0).getTime()), '2026-11-16', 'Sunday belongs to the week that started on Monday')
  assert.equal(searchDue(wed10, mon, undefined), true, 'missed Monday (HyperProx was down): it runs now, once')
  assert.equal(searchDue(wed10, mon, '2026-11-16'), false, 'claimed this week')
  assert.equal(searchDue(wed10, { ...mon, day: 5 }, undefined), false, 'Friday has not come yet')
  assert.equal(searchDue(wed10, { ...mon, enabled: false }, undefined), false)
  assert.equal(nextSearchAt(wed10, mon, '2026-11-16'), new Date(2026, 10, 23, 8, 0).getTime())
  assert.equal(nextSearchAt(wed10, { ...mon, day: 5 }, undefined), new Date(2026, 10, 20, 8, 0).getTime())
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
  const { svc, store } = rig({ sonarr: fa.client })
  // Watched since October, and searched in two weeks since.
  await store.save(observe([], sonarrItems(sonarrRecs), [], 0, '2026-10-01T00:00:00.000Z').tracks.map(t => ({ ...t, tries: 2 })))
  const s: GiveUpSettings = { ...DEFAULT_SETTINGS, enabled: true, weeks: 1 }
  await assert.rejects(svc.saveSettings('sonarr', s, undefined, 'admin@example.com'), (e: any) => e instanceof GiveUpRefusal && e.code === 'preview_required')
  const p = await svc.preview('sonarr', s)
  assert.equal(p.summary, 'This would give up on 4 TV episodes (2 series).')
  assert.deepEqual(p.rows.map(r => r.detail), ['S01E04 Fog Bank', 'Season 2 (3 episodes)'], 'a whole old season is one row')
  assert.equal(p.rows[0].reason.code, 'nothing-usable')
  assert.ok(fa.calls.every(c => c.method === 'GET'), 'a preview only reads')
  await assert.rejects(svc.saveSettings('sonarr', { ...s, weeks: 2 }, p.previewId, 'admin@example.com'), /preview/, 'a different rule from the one previewed')
  const saved = await svc.saveSettings('sonarr', s, p.previewId, 'admin@example.com')
  assert.equal(saved.enabled, true)
  // The weekly search alone never needs a preview, and does not turn the rule off.
  const withSearch = await svc.saveSettings('sonarr', { ...s, search: { enabled: true, day: 0, hour: 6 } }, undefined, 'admin@example.com')
  assert.equal(withSearch.enabled, true); assert.equal(withSearch.search.day, 0)
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
    if (m === 'GET' && p === '/api/v3/movie/7') return { id: 7, title: 'Harbour Lights', year: 1996, qualityProfileId: 7, hasFile: false, monitored: true }
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
  assert.equal(g.filesChecked, false)
  assert.ok(g.notes.some(n => /not checked for program files: HyperProx has no qBittorrent connection/.test(n)), g.notes.join(' | '))
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
    if (m === 'GET' && p === '/api/v3/movie/7') return { id: 7, title: 'Harbour Lights', year: 1996, qualityProfileId: 7, hasFile: false, monitored: true }
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
    if (m === 'GET' && p === '/api/v3/movie/7') return { id: 7, title: 'Harbour Lights', year: 1996, qualityProfileId: 7, hasFile: false, monitored: true }
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


// ── review follow-ups ────────────────────────────────────────────────────────

test('hard rules match tokens between dots, spaces, dashes and underscores, not inside words', () => {
  for (const t of ['Film_2012_3D_1080p', 'Film.2012.FSBS.1080p', 'Film.2012.Full-SBS', 'Film 2012 H-OU', 'Film.2012.TAB.1080p', 'Film.2012.Half-SBS'])
    assert.equal(hardRule(t), 'threeD', t)
  for (const t of ['Film_2012_HFR_1080p', 'Film.2012.48fps', 'Film.2012.48.fps', 'Film_2012_48_fps']) assert.equal(hardRule(t), 'hfr', t)
  for (const t of ['Film_2012_AV1_1080p', 'Film.2012.AV01.1080p', 'Film.2012.1080p.WEB.AV1']) assert.equal(hardRule(t), 'av1', t)
  for (const t of ['Film.2012.1080p.x264-3DFX', 'Tabletop.Tales.2012.1080p', 'Film.2012.1080p.SAV1OR', 'Film.2012.480p.x264']) assert.equal(hardRule(t), null, t)
})

test('a program file is judged by the final extension of the file name only', () => {
  assert.equal(isProgramFile('Film (2012)/setup.exe'), true)
  assert.equal(isProgramFile('Film (2012)\\Codec.MSI'), true)
  assert.equal(isProgramFile('Film.exe.mkv'), false)
  assert.equal(isProgramFile('installer.exe/Film.mkv'), false)
  assert.equal(isProgramFile('Film (2012)/notes.txt'), false)
})

test('item keys and targets have one spelling: no leading zeros', () => {
  assert.equal(parseKey('radarr:07'), null); assert.equal(parseKey('radarr:0'), null); assert.deepEqual(parseKey('radarr:7'), { app: 'radarr', arrId: 7 })
  assert.equal(parseTarget('sonarr-season:011:2'), null); assert.equal(parseTarget('sonarr-season:11:02'), null)
  assert.equal(parseTarget('sonarr-season:11:0')?.target, 'sonarr-season:11:0')
})

test('a given-up item that is monitored and missing again (someone searched by hand) is counted again from zero', () => {
  const items = sonarrItems(fx('sonarr-missing.json').records)
  const given = tracked({ key: 'sonarr:101', arrId: 101, app: 'sonarr', state: 'given-up', action: 'unmonitor', gaveUpAt: NOW_ISO, reason: 'x', tries: 30 })
  const r = observe([given], items, [], 0, NOW_ISO)
  const t = r.tracks.find(x => x.key === 'sonarr:101')!
  assert.equal(t.state, 'tracking'); assert.equal(t.tries, 0); assert.equal(t.gaveUpAt, undefined); assert.equal(t.reason, undefined)
})

/** A Sonarr that unmonitors in chunks; `failChunk` makes that chunk's change fail. */
function chunkySonarr(ids: number[], o: { failChunk?: number } = {}) {
  const mon = new Map(ids.map(i => [i, true]))
  let puts = 0
  const fa = fakeArr((m, p, b) => {
    if (m === 'GET' && p.startsWith('/api/v3/queue')) return page([])
    if (m === 'GET' && p.startsWith('/api/v3/wanted/missing')) return page([])
    if (m === 'GET' && p.startsWith('/api/v3/history')) return page([])
    if (m === 'GET' && p === '/api/v3/series') return []
    if (m === 'GET' && p.startsWith('/api/v3/episode?')) return [...p.matchAll(/episodeIds=(\d+)/g)].map(x => ({ id: Number(x[1]), monitored: mon.get(Number(x[1])), hasFile: false }))
    if (m === 'PUT' && p === '/api/v3/episode/monitor') {
      puts += 1
      if (puts === o.failChunk) return new Error('Sonarr answered 500')
      for (const id of b.episodeIds) mon.set(id, b.monitored)
      return []
    }
    return new Error(`unexpected ${m} ${p}`)
  })
  return { fa, mon, puts: () => puts }
}
const many = (n: number, from = 1000) => Array.from({ length: n }, (_, i) => tracked({ key: `sonarr:${from + i}`, arrId: from + i, app: 'sonarr', title: 'Quiet Harbour', detail: `S01E${i + 1}` }))

test('a run that fails part-way keeps what it already did, is claimed for the day, and logs (not throws) a failed after-audit', async () => {
  const sa = chunkySonarr(many(150).map(t => t.arrId), { failChunk: 2 })
  const logs: string[] = []
  const { svc, store } = rig({ sonarr: sa.fa.client }, {
    audit: async (action) => { if (action === 'arrstack.giveup.run.done') throw new Error('audit store down') },
    log: m => logs.push(m),
  })
  await store.save(many(150))
  await store.setSetting('settings:sonarr', { ...DEFAULT_SETTINGS, enabled: true }, 'test')
  const r = await svc.run('sonarr', { ...DEFAULT_SETTINGS, enabled: true }, 'test')
  assert.equal(r.given, 100); assert.equal(r.failed.length, 50)
  assert.equal((await store.tracks('sonarr')).filter(t => t.state === 'given-up').length, 100, 'the first chunk is saved')
  assert.ok(logs.some(l => /after-run audit entry could not be written/.test(l)))
  const state: any = await store.getSetting('state:sonarr')
  assert.equal(state.lastActDay, '2026-11-16')
  // The same calendar day: the tick does not run it again.
  const puts = sa.puts()
  await svc.tick()
  assert.equal(sa.puts(), puts)
})

test('the daily tick: nothing while locked; off by default only reads; once per calendar day; at most 250 a run', async () => {
  const locked = fakeArr(() => new Error('must not be called'))
  const l = rig({ sonarr: locked.client }, { unlocked: () => false })
  assert.deepEqual(await l.svc.tick(), []); assert.equal(locked.calls.length, 0)

  const sa = chunkySonarr(many(260).map(t => t.arrId))
  const r = rig({ sonarr: sa.fa.client })
  await r.store.save(many(260))
  await r.svc.tick()
  assert.equal(sa.puts(), 0, 'off by default: read, never changed')
  assert.ok(sa.fa.calls.every(c => c.method === 'GET'))
  // The test arr lists nothing missing, so the read dropped the tracks: put them back and turn the rule on.
  await r.store.save(many(260))
  await r.store.setSetting('settings:sonarr', { ...DEFAULT_SETTINGS, enabled: true }, 'test')
  await r.store.setSetting('state:sonarr', { historyId: 0, observedAt: NOW_ISO }, 'test')
  const out = await r.svc.tick()
  assert.equal(out[0].given, MAX_PER_RUN)
  await r.svc.tick()
  assert.equal((await r.store.tracks('sonarr')).filter(t => t.state === 'given-up').length, 250, 'not again the same day')
  r.setNow(Date.parse('2026-11-17T00:05:00Z'))
  await r.store.setSetting('state:sonarr', { ...(await r.store.getSetting<any>('state:sonarr')), observedAt: new Date(Date.parse('2026-11-17T00:05:00Z')).toISOString() }, 'test')
  const next = await r.svc.tick()
  assert.equal(next[0].given, 10, 'the next calendar day takes the rest')
})

test('remove (albums): deleteFiles=false with a list exclusion, never with tracks on disk; try again adds it back under its artist', async () => {
  const artist = { id: 4, artistName: 'The Paper Boats', foreignArtistId: 'aaaa-1111', qualityProfileId: 1, metadataProfileId: 1, rootFolderPath: '/media/Music', path: '/media/Music/The Paper Boats', monitored: true }
  const albums: Record<number, any> = {
    31: { id: 31, title: 'Low Songs', artistId: 4, artist, foreignAlbumId: 'bbbb-2222', monitored: true, statistics: { trackFileCount: 0, sizeOnDisk: 0 } },
    32: { id: 32, title: 'Half There', artistId: 4, artist, foreignAlbumId: 'cccc-3333', monitored: true, statistics: { trackFileCount: 2, sizeOnDisk: 9 } },
  }
  let excl = [{ id: 1, foreignId: 'zzzz' }]
  const fa = fakeArr((m, p, b) => {
    if (m === 'GET' && p.startsWith('/api/v1/queue')) return page([])
    if (m === 'GET' && p.startsWith('/api/v1/album?')) return [...p.matchAll(/albumIds=(\d+)/g)].map(x => albums[Number(x[1])]).filter(Boolean)
    let g = /^\/api\/v1\/album\/(\d+)$/.exec(p)
    if (m === 'GET' && g) return albums[Number(g[1])] ?? new Error('404 Not Found')
    g = /^\/api\/v1\/album\/(\d+)\?/.exec(p)
    if (m === 'DELETE' && g) { excl.push({ id: 2, foreignId: albums[Number(g[1])].foreignAlbumId }); delete albums[Number(g[1])]; return null }
    if (m === 'GET' && p === '/api/v1/importlistexclusion') return excl
    if (m === 'DELETE' && p.startsWith('/api/v1/importlistexclusion/')) { excl = excl.filter(e => e.id !== Number(p.split('/').pop())); return null }
    if (m === 'POST' && p === '/api/v1/album') { albums[90] = { ...b, id: 90 }; return albums[90] }
    return new Error(`unexpected ${m} ${p}`)
  })
  const { svc, store } = rig({ lidarr: fa.client })
  await store.save([tracked({ key: 'lidarr:31', arrId: 31, app: 'lidarr', title: 'The Paper Boats', detail: 'Low Songs' }), tracked({ key: 'lidarr:32', arrId: 32, app: 'lidarr', title: 'The Paper Boats', detail: 'Half There' })])
  const r = await svc.run('lidarr', { ...DEFAULT_SETTINGS, enabled: true, action: 'remove' }, 'test')
  assert.equal(r.given, 0 + 1)
  assert.deepEqual(fa.calls.filter(c => c.method === 'DELETE').map(c => c.path), ['/api/v1/album/31?deleteFiles=false&addImportListExclusion=true'])
  assert.deepEqual(r.skipped.map(x => x.why), ['It has a file now.'], 'the album with tracks on disk is left alone')
  const out = await svc.tryAgain(['lidarr:31'], 'admin@example.com')
  assert.match(out.summary, /Trying again: 1 album/)
  const add = fa.calls.find(c => c.method === 'POST')!
  assert.equal(add.body.foreignAlbumId, 'bbbb-2222'); assert.equal(add.body.artist.foreignArtistId, 'aaaa-1111'); assert.equal(add.body.addOptions.searchForNewAlbum, true)
  assert.ok(!excl.some(e => e.foreignId === 'bbbb-2222'), 'its exclusion was lifted first')
})

test('downloads: a forged release id is refused; usenet says its files were not checked; a torrent with no file list yet is looked at again and removed if a program file turns up', async () => {
  const releases = fx('radarr-release.json')
  let queue: any[] = []
  const fa = fakeArr((m, p) => {
    if (m === 'GET' && p === '/api/v3/movie/7') return { id: 7, title: 'Harbour Lights', year: 1996, qualityProfileId: 7, hasFile: false, monitored: true }
    if (m === 'GET' && p === '/api/v3/qualityprofile/7') return fx('radarr-profile.json')
    if (m === 'GET' && p === '/api/v3/release?movieId=7') return releases.map((r: any, i: number) => (i === 1 ? { ...r, protocol: 'usenet', seeders: undefined, grabs: 12 } : r))
    if (m === 'GET' && p.startsWith('/api/v3/queue')) return page(queue)
    if (m === 'POST' && p === '/api/v3/release') { queue = [{ id: 4, movieId: 7, title: 'x', downloadId: 'c'.repeat(40) }]; return {} }
    if (m === 'DELETE' && p.startsWith('/api/v3/queue/4')) return null
    return new Error(`unexpected ${m} ${p}`)
  })
  let files: any[] = []
  const qb = fakeArr(() => files)
  const pending: Array<{ fn: () => void; ms: number }> = []
  const { svc, setNow, audits } = rig({ radarr: fa.client }, { qbit: async () => qb.client, later: (fn, ms) => { pending.push({ fn, ms }) } })
  const a = await svc.releases('radarr:7', 'admin@example.com')
  await assert.rejects(svc.grab('radarr:7', 'f'.repeat(24), 'admin@example.com'), (e: any) => e.status === 404 && e.code === 'no_release')
  await assert.rejects(svc.grab('radarr:07', a.rows[0].id, 'admin@example.com'), (e: any) => e.code === 'bad_request')

  const usenet = a.rows.find(r => r.protocol === 'usenet')!
  const u = await svc.grab('radarr:7', usenet.id, 'admin@example.com')
  assert.equal(u.filesChecked, false); assert.ok(u.notes.some(n => /usenet download/.test(n)))

  setNow(NOW + SEARCH_COOLDOWN_MS + 1)
  queue = []
  const b = await svc.releases('radarr:7', 'admin@example.com')
  const t = await svc.grab('radarr:7', b.rows.find(r => r.protocol === 'torrent')!.id, 'admin@example.com')
  assert.equal(t.result, 'queued'); assert.equal(t.filesChecked, false)
  assert.ok(t.notes.some(n => /Files not checked yet/.test(n)))
  assert.deepEqual(pending.map(p => p.ms), RECHECK_MS)
  pending[0].fn(); await new Promise(r => setImmediate(r))
  assert.equal(fa.calls.filter(c => c.method === 'DELETE').length, 0, 'still no list: nothing removed')
  files = [{ name: 'Harbour Lights/Harbour.Lights.mkv' }, { name: 'Harbour Lights/Setup.exe' }]
  pending[1].fn(); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r))
  assert.deepEqual(fa.calls.filter(c => c.method === 'DELETE').map(c => c.path), ['/api/v3/queue/4?removeFromClient=true&blocklist=true'])
  assert.ok(audits.some(x => x.action === 'arrstack.giveup.grab.program-file'))
  pending[2].fn(); await new Promise(r => setImmediate(r))
  assert.equal(fa.calls.filter(c => c.method === 'DELETE').length, 1, 'settled: not checked again')
})

test('downloads: a failed POST gives the search back; something not missing cannot be searched; a season with every file cannot either', async () => {
  let fail = true
  const fa = fakeArr((m, p) => {
    if (m === 'GET' && p === '/api/v3/movie/7') return { id: 7, title: 'Harbour Lights', year: 1996, qualityProfileId: 7, hasFile: false, monitored: true }
    if (m === 'GET' && p === '/api/v3/movie/8') return { id: 8, title: 'The Lantern Keeper', year: 2006, qualityProfileId: 7, hasFile: false, monitored: false }
    if (m === 'GET' && p === '/api/v3/qualityprofile/7') return fx('radarr-profile.json')
    if (m === 'GET' && p === '/api/v3/release?movieId=7') return fx('radarr-release.json')
    if (m === 'GET' && p.startsWith('/api/v3/queue')) return page([])
    if (m === 'POST' && p === '/api/v3/release') return fail ? new Error('Radarr answered 404: release not in cache') : {}
    return new Error(`unexpected ${m} ${p}`)
  })
  const { svc } = rig({ radarr: fa.client })
  const a = await svc.releases('radarr:7', 'admin@example.com')
  await assert.rejects(svc.grab('radarr:7', a.rows[0].id, 'admin@example.com'), /not in cache/)
  fail = false
  const ok = await svc.grab('radarr:7', a.rows[0].id, 'admin@example.com')
  assert.equal(ok.result, 'not-seen', 'the search was given back after the failed POST, so this one went through')
  await assert.rejects(svc.releases('radarr:8', 'admin@example.com'), (e: any) => e.code === 'not_missing')

  const fs2 = fakeArr((m, p) => {
    if (p === '/api/v3/series/11') return { id: 11, title: 'Quiet Harbour', qualityProfileId: 8 }
    if (p.startsWith('/api/v3/episode?seriesId=11')) return [{ id: 1, seriesId: 11, seasonNumber: 1, hasFile: true, monitored: true }, { id: 2, seriesId: 11, seasonNumber: 1, episodeFileId: 9, monitored: true }]
    return new Error(`unexpected ${m} ${p}`)
  })
  const s2 = rig({ sonarr: fs2.client })
  await assert.rejects(s2.svc.releases('sonarr-season:11:1', 'admin@example.com'), (e: any) => e.code === 'has_file')
})


test('the weekly search: the arr\'s own missing-search command, claimed for the week first, read back, never while locked', async () => {
  const cmds: any[] = []
  let fail = false
  const fa = fakeArr((m, p, b) => {
    if (m === 'GET' && p.startsWith('/api/v3/wanted/missing')) return page(fx('radarr-missing.json').records)
    if (m === 'GET' && p.startsWith('/api/v3/queue')) return page([])
    if (m === 'GET' && p.startsWith('/api/v3/history')) return page([])
    if (m === 'POST' && p === '/api/v3/command') { if (fail) return new Error('Radarr answered 500'); cmds.push(b); return { id: 41, status: 'queued' } }
    if (m === 'GET' && p === '/api/v3/command/41') return { id: 41, status: 'started' }
    return new Error(`unexpected ${m} ${p}`)
  })
  // Wednesday 18 Nov 2026 10:00 local; the search is set for Monday 08:00, so this week's is due (it was missed).
  const wed10 = new Date(2026, 10, 18, 10, 0).getTime()
  const r = rig({ radarr: fa.client })
  r.setNow(wed10)
  await r.store.setSetting('settings:radarr', { ...DEFAULT_SETTINGS, search: { enabled: true, day: 1, hour: 8 } }, 'test')
  await r.svc.tick()
  assert.deepEqual(cmds, [{ name: 'MissingMoviesSearch' }])
  const st: any = await r.store.getSetting('state:radarr')
  assert.equal(st.searchWeek, '2026-11-16')
  assert.deepEqual({ ...st.lastSearch, at: undefined }, { at: undefined, app: 'radarr', count: 2, commandId: 41, status: 'started' })
  assert.ok(r.audits.some(a => a.action === 'arrstack.giveup.weekly-search' && a.details.missing === 2))
  assert.ok(!fa.calls.some(c => c.method === 'PUT' || c.method === 'DELETE'), 'the give-up rule is off: nothing else changes')
  // Later the same week: not again. A failed search is not retried that week either, and says why.
  r.setNow(wed10 + 3600_000)
  await r.svc.tick()
  assert.equal(cmds.length, 1)
  r.setNow(new Date(2026, 10, 23, 9, 0).getTime())
  fail = true
  await r.svc.tick()
  const st2: any = await r.store.getSetting('state:radarr')
  assert.equal(st2.searchWeek, '2026-11-23'); assert.equal(st2.lastSearch.status, 'failed'); assert.match(st2.lastSearch.error, /500/)
  const status = await r.svc.status()
  assert.equal(status.apps.find(a => a.app === 'radarr')!.nextSearch, new Date(2026, 10, 30, 8, 0).toISOString())

  const locked = fakeArr(() => new Error('must not be called'))
  const l = rig({ sonarr: locked.client }, { unlocked: () => false })
  await l.store.setSetting('settings:sonarr', { ...DEFAULT_SETTINGS, search: { enabled: true, day: 1, hour: 8 } }, 'test')
  l.setNow(wed10)
  await l.svc.tick()
  assert.equal(locked.calls.length, 0)

  const son = fakeArr((m, p, b) => {
    if (m === 'GET' && (p.startsWith('/api/v3/wanted') || p.startsWith('/api/v3/queue') || p.startsWith('/api/v3/history'))) return page([])
    if (m === 'GET' && p === '/api/v3/series') return []
    if (m === 'POST') { cmds.push(b); return { id: 7, status: 'queued' } }
    if (m === 'GET' && p === '/api/v3/command/7') return { id: 7, status: 'completed' }
    return new Error(`unexpected ${m} ${p}`)
  })
  const sr = rig({ sonarr: son.client })
  assert.equal(await sr.svc.weeklySearch('sonarr', 'test'), null, 'not switched on: not due')
  await sr.store.setSetting('settings:sonarr', { ...DEFAULT_SETTINGS, search: { enabled: true, day: 1, hour: 8 } }, 'test')
  sr.setNow(wed10)
  assert.equal((await sr.svc.weeklySearch('sonarr', 'test'))!.status, 'completed')
  assert.deepEqual(cmds.at(-1), { name: 'MissingEpisodeSearch', monitored: true })
})


test('weeks across a daylight-saving change and a year boundary', () => {
  // Whatever the zone (run under TZ=America/Toronto too): the week holding a clock change is still one week.
  const sun1Nov = new Date(2026, 10, 1, 23, 0).getTime()   // DST ends in North America this day
  assert.equal(weekKey(sun1Nov), '2026-10-26')
  assert.equal(weekKey(new Date(2026, 9, 26, 0, 30).getTime()), '2026-10-26')
  assert.equal(weekKey(new Date(2026, 10, 2, 0, 30).getTime()), '2026-11-02')
  const sunSlot = { enabled: true, day: 0, hour: 8 }
  assert.equal(new Date(scheduledThisWeek(sun1Nov, sunSlot)).getHours(), 8, 'the slot is 08:00 local on the change day')
  assert.equal(new Date(scheduledThisWeek(sun1Nov, sunSlot)).getDate(), 1)
  // The spring change (8 March 2026): the slot keeps its local hour.
  const sun8Mar = new Date(2026, 2, 8, 12, 0).getTime()
  assert.equal(new Date(scheduledThisWeek(sun8Mar, sunSlot)).getHours(), 8)
  // Year boundary: Thursday 31 Dec 2026 and Sunday 3 Jan 2027 are the same week.
  assert.equal(weekKey(new Date(2026, 11, 31, 12).getTime()), '2026-12-28')
  assert.equal(weekKey(new Date(2027, 0, 3, 23).getTime()), '2026-12-28')
  assert.equal(weekKey(new Date(2027, 0, 4, 0, 1).getTime()), '2027-01-04')
  const monSlot = { enabled: true, day: 1, hour: 8 }
  assert.equal(nextSearchAt(new Date(2026, 11, 31, 12).getTime(), monSlot, '2026-12-28'), new Date(2027, 0, 4, 8).getTime())
  // The try weeks are UTC and cross a year the same way.
  assert.equal(tryWeek('2026-12-31T12:00:00Z'), '2026-12-28'); assert.equal(tryWeek('2027-01-03T23:00:00Z'), '2026-12-28')
})

test('two ticks, or two processes sharing the database, start one weekly search and one daily run', async () => {
  const cmds: any[] = []
  const handler = (m: string, p: string, b?: any) => {
    if (m === 'GET' && (p.startsWith('/api/v3/wanted') || p.startsWith('/api/v3/queue') || p.startsWith('/api/v3/history'))) return page([])
    if (m === 'POST') { cmds.push(b); return { id: 5, status: 'queued' } }
    if (m === 'GET' && p === '/api/v3/command/5') return { id: 5, status: 'started' }
    return new Error(`unexpected ${m} ${p}`)
  }
  const a = fakeArr(handler), b2 = fakeArr(handler)
  const one = rig({ radarr: a.client })
  const wed10 = new Date(2026, 10, 18, 10, 0).getTime()
  one.setNow(wed10)
  // A second process: its own service, the same store (the database).
  const two = new GiveUpService({
    clients: { sonarr: async () => null, radarr: async () => b2.client, lidarr: async () => null }, qbit: async () => null, store: one.store,
    audit: async () => {}, publish: async () => {}, now: () => wed10, sleep: async () => {}, unlocked: () => true,
  })
  await one.store.setSetting('settings:radarr', { ...DEFAULT_SETTINGS, enabled: true, search: { enabled: true, day: 1, hour: 8 } }, 'test')
  await Promise.all([one.svc.tick(), two.tick(), one.svc.weeklySearch('radarr', 'x'), two.weeklySearch('radarr', 'y')])
  assert.equal(cmds.length, 1, 'one search for the week')
  const st: any = await one.store.getSetting('state:radarr')
  assert.equal(st.searchWeek, '2026-11-16'); assert.equal(st.lastActDay, '2026-11-18')
})

test('saving settings without the weekly search keeps the saved one; the search slot needs no preview', async () => {
  const { svc } = rig({})
  await svc.saveSettings('radarr', { enabled: false, weeks: 4, action: 'unmonitor', search: { enabled: true, day: 3, hour: 22 } }, undefined, 'admin@example.com')
  const kept = await svc.saveSettings('radarr', { enabled: false, weeks: 6, action: 'unmonitor' }, undefined, 'admin@example.com')
  assert.deepEqual(kept.search, { enabled: true, day: 3, hour: 22 })
  assert.equal((await svc.settings('radarr')).weeks, 6)
})

test('the weekly search does not start if HyperProx locks while it reads the missing list', async () => {
  let unlocked = true
  const fa = fakeArr((m, p) => {
    if (m === 'GET' && p.startsWith('/api/v3/wanted')) { unlocked = false; return page([]) }
    if (m === 'POST') return new Error('must not post')
    return new Error(`unexpected ${m} ${p}`)
  })
  const r = rig({ radarr: fa.client }, { unlocked: () => unlocked })
  r.setNow(new Date(2026, 10, 18, 10, 0).getTime())
  await r.store.setSetting('settings:radarr', { ...DEFAULT_SETTINGS, search: { enabled: true, day: 1, hour: 8 } }, 'test')
  const run = await r.svc.weeklySearch('radarr', 'test')
  assert.equal(run!.status, 'failed'); assert.match(run!.error!, /locked/)
  assert.ok(!fa.calls.some(c => c.method === 'POST'))
})
