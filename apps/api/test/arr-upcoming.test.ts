// Arr Stack "Upcoming": calendar parsing, day grouping across time zones (and an air time that crosses midnight),
// status cross-referenced with the queue and hasFile, the "Missing, searching" strip, the poster proxy allowlist
// (no key in any response), and the roles. All titles are made up.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { requiredRole } from '../src/lib/roles'
import { buildArrUpcomingRoutes, readUpcoming, rangeDays } from '../src/routes/arr-upcoming'
import { arrArtKey, arrArtUpstream, artRef } from '../src/lib/arr-upcoming/art'
import {
  airLabel, dateLabel, dayKey, filmItems, groupItems, queueIndex, radarrMissing, sonarrMissing, tonightCount, tvItems, validZone,
} from '../src/lib/arr-upcoming/logic'
import { ArtCache, MissLimiter } from '../src/lib/plex-art'
import type { CoreEndpointClient } from '../src/lib/plugin-host'
import { signIn } from './fakes/app'
import { FakeBroker } from './fakes/fake-broker'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { setAuditSink } from '../src/lib/audit'
import { MemoryApiTokenStore, setApiTokenStore } from '../src/lib/api-tokens'

const broker = new FakeBroker()
broker.addUser('admin@example.com', 'admin master password', 'admin')
broker.addUser('viewer@example.com', 'viewer master password', 'viewer')
before(() => {
  setBroker(broker)
  setApiTokenStore(new MemoryApiTokenStore())
  setAuditSink({ async write() {} })
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
})
after(async () => { setApiTokenStore(null); setAuditSink(null); if (isUnlocked()) await lock('manual') })

const NOW = Date.parse('2026-06-15T01:30:00Z') // 21:30 on 14 June in Toronto, 03:30 on 15 June in Paris, 13:30 on 15 June in Auckland
const poster = [{ coverType: 'poster', remoteUrl: 'https://img.example/p.jpg' }]
const ep = (id: number, over: any = {}) => ({
  id, seriesId: 10 + id, seasonNumber: 2, episodeNumber: id, title: `Episode ${id}`, hasFile: false, monitored: true,
  airDateUtc: '2026-06-15T02:00:00Z', series: { title: 'Harbour Lights', network: 'Northern Net', images: poster }, ...over,
})

// ── zones and labels ─────────────────────────────────────────────────────────

test('validZone: a real zone, else UTC', () => {
  assert.equal(validZone('America/Toronto'), 'America/Toronto')
  for (const bad of ['', 'Mars/Base', 'x'.repeat(80), undefined, 7, '../etc']) assert.equal(validZone(bad), 'UTC', String(bad))
})

test('an air time across midnight lands on a different day in each zone', () => {
  const air = Date.parse('2026-06-15T02:00:00Z')
  assert.equal(dayKey(air, 'America/Toronto'), '2026-06-14')
  assert.equal(dayKey(air, 'Europe/Paris'), '2026-06-15')
  assert.equal(dayKey(air, 'Pacific/Auckland'), '2026-06-15')
  assert.equal(airLabel(air, NOW, 'America/Toronto'), 'tonight 10 pm', 'same evening in Toronto')
  assert.equal(airLabel(air, NOW, 'Europe/Paris'), 'today 4 am')
  // 23:30 UTC is 19:30 the same day in Toronto, but already tomorrow in Auckland and Paris.
  const late = Date.parse('2026-06-15T23:30:00Z')
  assert.equal(airLabel(late, NOW, 'America/Toronto'), 'tomorrow 7:30 pm')
  assert.equal(airLabel(late, NOW, 'Pacific/Auckland'), 'tomorrow 11:30 am')
  assert.equal(airLabel(Date.parse('2026-06-18T13:00:00Z'), NOW, 'UTC'), 'Thu 1 pm')
  assert.equal(airLabel(Date.parse('2026-06-12T00:00:00Z') + 20 * 86400000, NOW, 'UTC'), '2 Jul, 12 am')
})

test('a film date is a calendar date: never shifted by the viewer’s zone', () => {
  assert.equal(dateLabel('2026-06-15', '2026-06-14'), 'tomorrow')
  assert.equal(dateLabel('2026-06-18', '2026-06-14'), 'Thu')
  assert.equal(dateLabel('2026-07-02', '2026-06-14'), '2 Jul')
  const cal = [{ id: 5, title: 'Paper Moons', year: 2026, digitalRelease: '2026-06-15T00:00:00Z', images: poster }]
  const west = filmItems(cal, new Map(), NOW, 'America/Los_Angeles', '2026-07-15')
  assert.equal(west[0].day, '2026-06-15', 'midnight UTC stays on the 15th even where it is still the 14th')
  assert.equal(west[0].when, 'tomorrow')
})

// ── TV status ────────────────────────────────────────────────────────────────

test('TV status: hasFile, queue, aired-no-file, and airs in N days', () => {
  const queue = queueIndex([{ episodeId: 2, size: 1000, sizeleft: 250 }, { episodeId: 99 }, { episodeId: 'x' }, null], 'episodeId')
  assert.equal(queue.get(2), 75)
  const items = tvItems([
    ep(1, { hasFile: true }),
    ep(2),
    ep(3, { airDateUtc: '2026-06-14T20:00:00Z' }),
    ep(4, { airDateUtc: '2026-06-18T02:00:00Z' }),
    ep(5, { airDateUtc: '2026-06-16T02:00:00Z' }),
    ep(6, { airDateUtc: '2026-06-15T02:00:00Z' }),
  ], queue, NOW, 'UTC')
  const by = Object.fromEntries(items.map(i => [i.id, i]))
  assert.deepEqual([by['tv-1'].status, by['tv-1'].statusText], ['have', 'already have it'])
  assert.deepEqual([by['tv-2'].status, by['tv-2'].progress], ['downloading', 75])
  assert.deepEqual([by['tv-3'].status, by['tv-3'].statusText], ['waiting', 'aired, waiting for a release'])
  assert.equal(by['tv-4'].statusText, 'airs in 3 days')
  assert.equal(by['tv-5'].statusText, 'airs tomorrow')
  assert.equal(by['tv-6'].statusText, 'airs later today')
  assert.equal(by['tv-6'].code, 'S02E06')
  assert.equal(by['tv-6'].network, 'Northern Net')
  assert.equal(by['tv-6'].art, '/api/plugins/arrstack/art/sonarr/16')
  assert.equal(by['tv-1'].status, 'have', 'a file beats a queue entry and the air time')
})

test('a downloading episode that also has a file is "have"; junk rows are skipped; no poster means no art', () => {
  const items = tvItems([ep(1, { hasFile: true }), { id: 9, title: 'no series' }, ep(2, { airDateUtc: 'nope' }), ep(3, { series: { title: 'Bare Show' } })], queueIndex([{ episodeId: 1, size: 1, sizeleft: 0 }], 'episodeId'), NOW, 'UTC')
  assert.deepEqual(items.map(i => [i.id, i.status, i.art]), [['tv-1', 'have', '/api/plugins/arrstack/art/sonarr/11'], ['tv-3', 'upcoming', null]])
})

// ── film status ──────────────────────────────────────────────────────────────

test('film: the first release date in the window, and what Radarr will do about it', () => {
  const end = '2026-08-14'
  const cal = [
    { id: 1, title: 'Glass Orchard', year: 2026, inCinemas: '2026-06-20T00:00:00Z', digitalRelease: '2026-08-01T00:00:00Z', isAvailable: false, images: poster },
    { id: 2, title: 'Night Desk', year: 2026, inCinemas: '2026-04-01T00:00:00Z', digitalRelease: '2026-06-18T00:00:00Z', isAvailable: false },
    { id: 3, title: 'Comet Kite', year: 2025, inCinemas: '2025-11-01T00:00:00Z', digitalRelease: '2026-06-10T00:00:00Z', physicalRelease: '2026-06-25T00:00:00Z', isAvailable: true },
    { id: 4, title: 'Lantern Row', year: 2026, physicalRelease: '2026-06-30T00:00:00Z', digitalRelease: '2026-08-10T00:00:00Z' },
    { id: 5, title: 'Held Breath', year: 2026, digitalRelease: '2026-06-20T00:00:00Z', hasFile: true },
    { id: 6, title: 'Far Off', year: 2027, inCinemas: '2026-12-01T00:00:00Z' },
    { id: 7, title: 'Queued One', year: 2026, digitalRelease: '2026-06-16T00:00:00Z' },
  ]
  const items = filmItems(cal, queueIndex([{ movieId: 7, size: 10, sizeleft: 9 }], 'movieId'), NOW, 'UTC', end)
  const by = Object.fromEntries(items.map(i => [i.id, i]))
  assert.equal(by['film-6'], undefined, 'outside the window')
  assert.deepEqual([by['film-1'].releaseKind, by['film-1'].releaseDate, by['film-1'].status], ['cinema', '2026-06-20', 'upcoming'])
  assert.match(by['film-1'].statusText, /^in cinemas in 5 days; Radarr usually grabs at the digital release \(1 Aug\)$/)
  assert.deepEqual([by['film-2'].releaseKind, by['film-2'].statusText], ['digital', 'digital release in 3 days; Radarr grabs about then'])
  assert.deepEqual([by['film-3'].releaseKind, by['film-3'].status, by['film-3'].statusText], ['physical', 'waiting', 'out now, waiting for a release'], 'digital already passed; the physical date is the one still coming')
  assert.match(by['film-4'].statusText, /^physical release in 15 days; digital is 10 Aug$/)
  assert.equal(by['film-5'].status, 'have')
  assert.deepEqual([by['film-7'].status, by['film-7'].progress], ['downloading', 10])
  assert.equal(by['film-1'].year, 2026)
})

test('film tie on a day: digital wins over cinema', () => {
  const [m] = filmItems([{ id: 1, title: 'Same Day', inCinemas: '2026-06-20T00:00:00Z', digitalRelease: '2026-06-20T00:00:00Z' }], new Map(), NOW, 'UTC', '2026-07-01')
  assert.equal(m.releaseKind, 'digital')
})

// ── grouping ─────────────────────────────────────────────────────────────────

test('grouping: Today, Tomorrow, This week, Later, in the viewer’s zone, TV by time then films', () => {
  const tv = tvItems([
    ep(1, { airDateUtc: '2026-06-15T23:30:00Z' }), // Toronto: tomorrow evening (the 15th)
    ep(2, { airDateUtc: '2026-06-15T02:00:00Z' }), // Toronto: tonight
    ep(3, { airDateUtc: '2026-06-18T02:00:00Z' }),
    ep(4, { airDateUtc: '2026-06-29T02:00:00Z' }),
  ], new Map(), NOW, 'America/Toronto')
  const films = filmItems([{ id: 9, title: 'Paper Moons', digitalRelease: '2026-06-14T00:00:00Z' }, { id: 8, title: 'Glass Orchard', digitalRelease: '2026-06-15T00:00:00Z' }], new Map(), NOW, 'America/Toronto', '2026-07-30')
  const g = groupItems([...films, ...tv], NOW, 'America/Toronto')
  assert.deepEqual(g.map(x => [x.key, x.label, x.items.map(i => i.id)]), [
    ['today', 'Today', ['tv-2', 'film-9']],
    ['tomorrow', 'Tomorrow', ['tv-1', 'film-8']],
    ['week', 'This week', ['tv-3']],
    ['later', 'Later', ['tv-4']],
  ])
  const utc = groupItems(tv, NOW, 'UTC')
  assert.deepEqual(utc.map(x => [x.key, x.items.map(i => i.id)]), [['today', ['tv-2', 'tv-1']], ['week', ['tv-3']], ['later', ['tv-4']]], 'the same episodes group differently in UTC; empty groups are dropped')
  assert.equal(tonightCount(tv, NOW, 'America/Toronto'), 1, 'only the 10 pm one is tonight')
})

// ── the service reads ────────────────────────────────────────────────────────

function fakeArr(answers: Record<string, any>, asked: string[] = []): CoreEndpointClient {
  return {
    async get(p: string) {
      asked.push(p)
      const k = Object.keys(answers).find(x => p.startsWith(x))
      if (!k) throw new Error('unexpected ' + p)
      if (answers[k] instanceof Error) throw answers[k]
      return answers[k]
    },
    async delete() { throw new Error('read-only') }, async put() { throw new Error('read-only') }, async trigger() {},
    async image() { throw new Error('none') },
  }
}

test('readUpcoming: asks the calendars with the right window, merges both, and one service down greys only its half', async () => {
  const askedS: string[] = [], askedR: string[] = []
  const sonarr = fakeArr({
    '/api/v3/calendar': [ep(1), ep(2, { hasFile: true })],
    '/api/v3/queue': { records: [{ episodeId: 1, size: 100, sizeleft: 50 }] },
    '/api/v3/wanted/missing': { totalRecords: 2338, records: [{ id: 50, seasonNumber: 1, episodeNumber: 3, title: 'Third', airDateUtc: '2026-06-12T02:00:00Z', series: { title: 'Dusty Shelf' } }] },
  }, askedS)
  const radarr = fakeArr({ '/api/v3/calendar': new Error('connect ECONNREFUSED') }, askedR)
  const d = await readUpcoming({ sonarr, radarr, now: NOW, tz: 'UTC', days: 14 })
  assert.equal(askedS[0], '/api/v3/calendar?start=2026-06-15&end=2026-06-29&includeSeries=true&unmonitored=false')
  assert.ok(askedR[0].startsWith('/api/v3/calendar?start=2026-06-15&end=2026-06-29&unmonitored=false'))
  assert.deepEqual(d.services.sonarr, { ok: true })
  assert.equal(d.services.radarr.ok, false)
  assert.match(String(d.services.radarr.error), /ECONNREFUSED/)
  assert.deepEqual(d.counts, { tv: 2, film: 0, tonight: 0, downloading: 1 })
  assert.equal(d.missing.sonarr?.total, 2338)
  assert.deepEqual(d.missing.sonarr?.items[0], { id: 'tv-50', title: 'Dusty Shelf', detail: 'S01E03 Third', date: 'aired 3 days ago' })
  const none = await readUpcoming({ sonarr: null, radarr: null, now: NOW, tz: 'UTC', days: 7 })
  assert.equal(none.groups.length, 0)
  assert.match(String(none.services.sonarr.error), /not set up/)
})

test('Radarr missing counts only released films, top 10, and says when the page was not the whole list', () => {
  const rows = Array.from({ length: 14 }, (_, i) => ({ id: i + 1, title: `Film ${i + 1}`, year: 2020, isAvailable: true, releaseDate: '2026-05-01T00:00:00Z' }))
  rows.push({ id: 99, title: 'Not yet', year: 2027, isAvailable: false, releaseDate: '2027-01-01T00:00:00Z' } as any)
  const m = radarrMissing({ totalRecords: 15, records: rows })
  assert.equal(m.total, 14); assert.equal(m.items.length, 10); assert.equal(m.approximate, undefined)
  assert.deepEqual(m.items[0], { id: 'film-1', title: 'Film 1', detail: '2020', date: 'released 1 May' })
  assert.equal(radarrMissing({ totalRecords: 900, records: rows }).approximate, true)
  assert.equal(sonarrMissing({ records: [] }, NOW, 'UTC').total, 0)
})

test('range: only 7, 14, 30 or 60', () => {
  assert.deepEqual(['7', '14', '30', '60', '5', 'x', undefined, '14; drop'].map(rangeDays), [7, 14, 30, 60, 14, 14, 14, 14])
})

// ── routes: gate, roles, poster proxy ────────────────────────────────────────

test('roles: a viewer may read both routes; nothing here writes', () => {
  assert.equal(requiredRole('GET', '/api/plugins/arrstack/upcoming'), 'viewer')
  assert.equal(requiredRole('GET', '/api/plugins/arrstack/art/sonarr/12'), 'viewer')
  assert.equal(requiredRole('POST', '/api/plugins/arrstack/upcoming'), 'admin', 'any write falls to admin')
})

test('art helpers: only sonarr or radarr and a plain number, rebuilt into fixed paths', () => {
  assert.deepEqual(arrArtKey('sonarr', '12'), { app: 'sonarr', id: '12' })
  for (const [a, i] of [['prowlarr', '1'], ['sonarr', '1x'], ['sonarr', '../1'], ['sonarr', ''], ['radarr', '12345678901'], ['sonarr', 'http://evil.example']] as const) assert.equal(arrArtKey(a, i), null, `${a}/${i}`)
  assert.equal(artRef('sonarr', 12), '/api/plugins/arrstack/art/sonarr/12')
  assert.equal(artRef('radarr', '3'), '/api/plugins/arrstack/art/radarr/3')
  assert.equal(artRef('radarr', '3/../../x'), null)
  assert.deepEqual(arrArtUpstream({ app: 'radarr', id: '3' }), ['/api/v3/mediacover/3/poster-250.jpg', '/api/v3/mediacover/3/poster.jpg'])
})

test('routes: signed in only; /upcoming is read-only and holds no key; /art is allowlisted, typed, cached, limited', async () => {
  const KEY = 'sekret-api-key-0123456789abcdef'
  const askedS: string[] = [], askedR: string[] = [], images: string[] = []
  const make = (asked: string[], answers: Record<string, any>): CoreEndpointClient => ({
    ...fakeArr(answers, asked),
    async image(p) { images.push(p); if (p.includes('/99/')) throw new Error('HTTP 404'); return { contentType: 'image/jpeg', body: Buffer.from([0xff, 0xd8, 0xff, 0x01]) } },
  })
  const sonarr = make(askedS, { '/api/v3/calendar': [ep(1)], '/api/v3/queue': { records: [] }, '/api/v3/wanted/missing': { totalRecords: 0, records: [] } })
  const radarr = make(askedR, { '/api/v3/calendar': [{ id: 4, title: 'Paper Moons', year: 2026, digitalRelease: '2026-06-20T00:00:00Z', images: poster }], '/api/v3/queue': { records: [] }, '/api/v3/wanted/missing': { totalRecords: 0, records: [] } })
  let clock = NOW
  const a = Fastify({ logger: false })
  await registerGate(a)
  await a.register(authRoutes, { prefix: '/api/auth' })
  await a.register(buildArrUpcomingRoutes({ sonarr: async () => sonarr, radarr: async () => radarr, cache: new ArtCache(), limiter: new MissLimiter(3), now: () => clock }), { prefix: '/api/plugins/arrstack' })
  await a.ready()
  try {
    const anon = await a.inject({ method: 'GET', url: '/api/plugins/arrstack/upcoming' })
    assert.ok(anon.statusCode === 401 || anon.statusCode === 423, `no session: ${anon.statusCode}`)
    assert.equal((await a.inject({ method: 'GET', url: '/api/plugins/arrstack/art/sonarr/11' })).statusCode === 200, false)
    assert.equal(askedS.length + images.length, 0)

    const { cookie } = await signIn(a, 'viewer@example.com', 'viewer master password')
    const up = await a.inject({ method: 'GET', url: '/api/plugins/arrstack/upcoming?days=30&tz=America/Toronto', headers: { cookie } })
    assert.equal(up.statusCode, 200, up.body)
    const body = JSON.parse(up.body).data
    assert.equal(body.days, 30); assert.equal(body.tz, 'America/Toronto')
    assert.deepEqual(body.counts, { tv: 1, film: 1, tonight: 1, downloading: 0 })
    assert.ok(!up.body.includes(KEY) && !/X-Api-Key|apikey/i.test(up.body), 'no key in the schedule')
    assert.ok(!/https?:\/\//.test(up.body), 'no upstream address or image URL in the schedule')
    assert.ok(body.groups.flatMap((g: any) => g.items).every((i: any) => i.art === null || /^\/api\/plugins\/arrstack\/art\/(sonarr|radarr)\/\d+$/.test(i.art)))
    assert.ok([...askedS, ...askedR].every(p => p.startsWith('/api/v3/')), 'only reads of /api/v3')
    const n = askedS.length
    await a.inject({ method: 'GET', url: '/api/plugins/arrstack/upcoming?days=30&tz=America/Toronto', headers: { cookie } })
    assert.equal(askedS.length, n, 'a second reading inside 45 s is the shared one')
    clock += 60_000
    await a.inject({ method: 'GET', url: '/api/plugins/arrstack/upcoming?days=30&tz=America/Toronto', headers: { cookie } })
    assert.ok(askedS.length > n, 'and a fresh one after it')
    const badTz = await a.inject({ method: 'GET', url: '/api/plugins/arrstack/upcoming?tz=../../etc', headers: { cookie } })
    assert.equal(JSON.parse(badTz.body).data.tz, 'UTC')

    const ok = await a.inject({ method: 'GET', url: '/api/plugins/arrstack/art/sonarr/11?url=http://evil.example/x', headers: { cookie } })
    assert.equal(ok.statusCode, 200, ok.body)
    assert.equal(ok.headers['content-type'], 'image/jpeg')
    assert.match(String(ok.headers['cache-control']), /private, max-age=\d+/)
    assert.equal(ok.rawPayload.length, 4)
    assert.deepEqual(images, ['/api/v3/mediacover/11/poster-250.jpg'], 'the query string is ignored; the path is rebuilt')
    assert.ok(!JSON.stringify(ok.headers).includes(KEY))
    await a.inject({ method: 'GET', url: '/api/plugins/arrstack/art/sonarr/11', headers: { cookie } })
    assert.equal(images.length, 1, 'served from the cache')

    for (const url of ['/api/plugins/arrstack/art/prowlarr/11', '/api/plugins/arrstack/art/sonarr/11x', '/api/plugins/arrstack/art/sonarr/..%2F..%2Fsystem%2Fstatus', '/api/plugins/arrstack/art/http%3A%2F%2Fevil.example/1']) {
      const r = await a.inject({ method: 'GET', url, headers: { cookie } })
      assert.ok([400, 404].includes(r.statusCode), `${url}: ${r.statusCode}`)
    }
    assert.equal(images.length, 1, 'nothing outside the allowlist reached Sonarr or Radarr')

    const none = await a.inject({ method: 'GET', url: '/api/plugins/arrstack/art/radarr/99', headers: { cookie } })
    assert.equal(none.statusCode, 404, 'no poster: the page shows its title card')
    assert.ok(!none.body.includes(KEY))
    // The limiter: three cache misses a minute (set to 3 here; one used by /art/sonarr/11, one by 99).
    assert.equal((await a.inject({ method: 'GET', url: '/api/plugins/arrstack/art/radarr/5', headers: { cookie } })).statusCode, 200)
    assert.equal((await a.inject({ method: 'GET', url: '/api/plugins/arrstack/art/radarr/6', headers: { cookie } })).statusCode, 429)
  } finally { await a.close() }
})
