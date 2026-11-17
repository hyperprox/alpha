// Arr Stack "Find a better copy": the ranked list (accepted first, then quality tier, then seeders; AV1, 3D, program
// files and dead torrents never offered; slow torrents flagged), what the profile refuses said plainly and refused,
// "grab anyway" only when the one objection is the slow download a swap removes, the grab moved to the top of
// qBittorrent, and a swap that removes exactly the slow download's own rows (the queue answers with everything, so it
// is filtered here) blocklisted with no re-search, only once the new one is in the queue. Never a library file.
// The fixtures are recorded arr answers with made-up titles and ids.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import Fastify from 'fastify'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { requiredRole, needsReconfirm } from '../src/lib/roles'
import { buildArrBetterRoutes } from '../src/routes/arr-better'
import { betterView, rejectionKind, SLOW_SEEDS } from '../src/lib/arr-better/rank'
import { BetterCopyService, itemOfDownload, parseBetterTarget, type BetterDeps } from '../src/lib/arr-better/service'
import { QUEUED_TEXT, plainRejection, profileInfo } from '../src/lib/arr-release/releases'
import { findGrab } from '../src/lib/arr-release/grab'
import type { CoreEndpointClient } from '../src/lib/plugin-host'
import { signIn } from './fakes/app'
import { FakeBroker } from './fakes/fake-broker'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { setAuditSink } from '../src/lib/audit'
import { MemoryApiTokenStore, setApiTokenStore, createApiToken, tokenForbidden } from '../src/lib/api-tokens'
import { MissLimiter } from '../src/lib/plex-art'

const FIX = path.join(__dirname, 'fixtures', 'arr-better')
const fx = (n: string) => JSON.parse(fs.readFileSync(path.join(FIX, n), 'utf8'))
const NOW = Date.parse('2026-11-16T12:00:00Z')
const SLOW = 'a'.repeat(40), OTHER = 'b'.repeat(40), NEW = 'e'.repeat(40), PACK = 'c'.repeat(40)

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
    postForm: (p, f) => go('POSTFORM', p, f), deleteBody: (p, b) => go('DELETEBODY', p, b),
    image: async () => { throw new Error('no') }, trigger: async () => {},
  }
  return { client, calls }
}
const page = (records: any[]) => ({ page: 1, pageSize: 500, totalRecords: records.length, records })

function rig(arrs: Partial<Record<'sonarr' | 'radarr' | 'lidarr', CoreEndpointClient>>, extra: Partial<BetterDeps> = {}) {
  const audits: Array<{ action: string; details: any }> = []
  let now = NOW
  const svc = new BetterCopyService({
    clients: { sonarr: async () => arrs.sonarr ?? null, radarr: async () => arrs.radarr ?? null, lidarr: async () => arrs.lidarr ?? null },
    qbit: async () => null,
    audit: async (action, details) => { audits.push({ action, details }) },
    now: () => now, sleep: async () => {}, grabWaitMs: 8, later: () => {}, ...extra,
  })
  return { svc, audits, setNow: (t: number) => { now = t } }
}

/** A Radarr with film 7 (a WEBDL-1080p on disk), its profile, the recorded release list, and a queue that changes. */
function radarr(o: { queue?: any[]; onGrab?: (q: any[]) => any[] } = {}) {
  let queue: any[] = o.queue ?? []
  let searches = 0
  const fa = fakeArr((m, p, b) => {
    if (m === 'GET' && p === '/api/v3/movie/7') return { id: 7, title: 'Paper Lanterns', year: 2011, qualityProfileId: 4, hasFile: true, movieFileId: 70, movieFile: { id: 70, quality: { quality: { id: 3, name: 'WEBDL-1080p' } } } }
    if (m === 'GET' && p === '/api/v3/movie') return fx('radarr-movies.json')
    if (m === 'GET' && p === '/api/v3/qualityprofile/4') return fx('radarr-profile.json')
    if (m === 'GET' && p === '/api/v3/release?movieId=7') { searches++; return fx('radarr-release.json') }
    if (m === 'GET' && p.startsWith('/api/v3/queue')) return page(queue)
    if (m === 'POST' && p === '/api/v3/release') { queue = o.onGrab ? o.onGrab(queue) : [...queue, { id: 350, movieId: 7, title: 'new', downloadId: NEW.toUpperCase(), protocol: 'torrent' }]; return {} }
    if (m === 'DELETEBODY' && p.startsWith('/api/v3/queue/bulk')) { queue = queue.filter(r => !b.ids.includes(r.id)); return null }
    return new Error(`unexpected ${m} ${p}`)
  })
  return { ...fa, searches: () => searches, queue: () => queue }
}

function qbit(files: any[] = [{ name: 'Paper Lanterns/film.mkv' }]) {
  return fakeArr((m, p) => {
    if (m === 'GET' && p.startsWith('/api/v2/torrents/files')) return files
    if (m === 'GET' && p.startsWith('/api/v2/torrents/info')) return [{ hash: NEW }]
    if (m === 'POSTFORM' && p === '/api/v2/torrents/topPrio') return null
    return new Error(`unexpected ${m} ${p}`)
  })
}

// ── the ranked list ─────────────────────────────────────────────────────────

test('ranked: accepted first, then quality tier, then seeders; AV1, 3D, program files and dead torrents never offered; slow flagged', () => {
  const v = betterView(fx('radarr-release.json'), { app: 'radarr', profile: profileInfo(fx('radarr-profile.json')), swap: false })
  assert.deepEqual(v.rows.map(r => r.title.split(' ').slice(-1)[0]), ['HEVC-GRPB', 'x265-GRPA', 'x264-TINY', 'H264-GRPC', '264-USE', 'x264-GRPD'])
  assert.deepEqual(v.hidden, { av1: 1, threeD: 1, hfr: 0, zeroSeed: 1, executable: 1 })
  assert.equal(v.found, 10); assert.equal(v.accepted, 2)
  const [uhd, bd] = v.rows
  assert.equal(uhd.slow, true, `${SLOW_SEEDS} seeds or fewer is slow`); assert.equal(bd.slow, false)
  assert.equal(uhd.verdict, 'ok'); assert.equal(bd.verdict, 'ok')
  assert.ok(v.rows.every(r => !('guid' in r) && !('indexerId' in r)), 'the page never sees a guid')
  // Not swapping: the queue objection is refused with where to go instead; the rest say what the profile says.
  const by = (end: string) => v.rows.find(r => r.title.endsWith(end))!
  assert.equal(by('GRPC').verdict, 'refused'); assert.match(by('GRPC').why!, /already downloading\. Use "Find a faster copy"/)
  assert.equal(by('GRPD').verdict, 'refused'); assert.match(by('GRPD').why!, /Radarr refuses it: Not better than what you already have/)
  assert.equal(by('TINY').verdict, 'refused'); assert.match(by('TINY').why!, /Too small for its quality/)
})

test('swapping: an objection that is only "something is queued" can be grabbed anyway; any other objection still refuses', () => {
  const v = betterView(fx('radarr-release.json'), { app: 'radarr', profile: profileInfo(fx('radarr-profile.json')), swap: true })
  const by = (end: string) => v.rows.find(r => r.title.endsWith(end))!
  assert.equal(by('GRPC').verdict, 'anyway')
  assert.equal(by('USE').verdict, 'anyway', 'the "equal or higher preference" wording too')
  assert.equal(by('TINY').verdict, 'refused', 'too small AND queued: the swap does not fix "too small"')
  assert.doesNotMatch(by('TINY').why!, /already downloading/, 'the objection the swap resolves is left out of the reason')
  assert.equal(by('GRPD').verdict, 'refused', '"already meets cutoff" for the file on disk is never overridden')
})

test('the queue wordings read as plain English', () => {
  for (const s of ['Release in queue already meets cutoff: WEBDL-1080p', 'Release in queue is of equal or higher preference: Bluray-1080p', 'Another release is queued and the Quality profile does not allow upgrades']) {
    assert.equal(rejectionKind(s), 'queue', s); assert.equal(plainRejection(s), QUEUED_TEXT, s)
  }
  assert.equal(rejectionKind('Existing file on disk meets cutoff: Bluray-1080p'), 'other')
  assert.equal(plainRejection('Existing file on disk meets cutoff: Bluray-1080p'), 'Not better than what you already have')
})

test('targets: items, seasons and queue downloads have one spelling each', () => {
  assert.deepEqual(parseBetterTarget('radarr:7'), { kind: 'item', key: 'radarr:7', app: 'radarr', arrId: 7 })
  assert.deepEqual(parseBetterTarget('sonarr-season:11:2'), { kind: 'item', key: 'sonarr-season:11:2', app: 'sonarr', seriesId: 11, season: 2 })
  assert.deepEqual(parseBetterTarget(`queue:radarr:d:${SLOW}`), { kind: 'download', key: `queue:radarr:d:${SLOW}`, app: 'radarr', downloadId: `d:${SLOW}` })
  for (const bad of ['radarr:07', 'queue:radarr:i:5', 'queue:plex:d:abc', 'queue:radarr:d:a b', 7, null]) assert.equal(parseBetterTarget(bad), null, String(bad))
})

test('what a download is for comes from its own rows: one film, one album, one episode, or one season; mixed is refused', () => {
  assert.deepEqual(itemOfDownload('radarr', [{ movieId: 7 }]), { app: 'radarr', arrId: 7 })
  assert.deepEqual(itemOfDownload('sonarr', [{ episodeId: 5, seriesId: 1, seasonNumber: 1 }]), { app: 'sonarr', arrId: 5 })
  assert.deepEqual(itemOfDownload('sonarr', [{ episodeId: 5, seriesId: 1, seasonNumber: 2 }, { episodeId: 6, seriesId: 1, seasonNumber: 2 }]), { app: 'sonarr', seriesId: 1, season: 2 })
  assert.throws(() => itemOfDownload('sonarr', [{ episodeId: 5, seriesId: 1, seasonNumber: 1 }, { episodeId: 6, seriesId: 1, seasonNumber: 2 }]), (e: any) => e.code === 'mixed')
  assert.throws(() => itemOfDownload('radarr', [{ movieId: 7 }, { movieId: 8 }]), (e: any) => e.code === 'mixed')
  assert.throws(() => itemOfDownload('lidarr', [{ title: 'x' }]), (e: any) => e.code === 'not_matched')
})

test('the grab is found in the queue by its own ids, never a row that was there before', () => {
  const rows = [{ id: 1, movieId: 7, title: 'old' }, { id: 2, movieId: 9, title: 'other' }, { id: 3, movieId: 7, title: 'new' }]
  assert.equal(findGrab(rows, { app: 'radarr', wanted: new Set([7]) }, { title: 'x' }, new Set([1, 2])).id, 3)
  assert.equal(findGrab(rows.slice(0, 2), { app: 'radarr', wanted: new Set([7]) }, { title: 'x' }, new Set([1, 2])), undefined)
})

// ── the service ─────────────────────────────────────────────────────────────

test('library search: films by title with what is on disk; read-only', async () => {
  const fa = radarr()
  const { svc } = rig({ radarr: fa.client })
  const found = await svc.find('radarr', 'paper')
  assert.deepEqual(found.map(f => [f.target, f.title, f.have]), [['radarr:7', 'Paper Lanterns', 'WEBDL-1080p'], ['radarr:9', 'The Paper Boat', 'Bluray-1080p']])
  assert.deepEqual(await svc.find('radarr', 'p'), [], 'two letters at least')
  assert.ok(fa.calls.every(c => c.method === 'GET'))
})

test('a film: searched once per ten minutes, audited first; the pick is grabbed by guid and indexer only and moved to the top', async () => {
  const fa = radarr()
  const qb = qbit()
  const { svc, audits } = rig({ radarr: fa.client }, { qbit: async () => qb.client })
  const a = await svc.search('radarr:7', 'admin@example.com')
  assert.equal(a.label, 'Paper Lanterns (2011)'); assert.equal(a.have, 'WEBDL-1080p'); assert.equal(a.swap, null)
  assert.equal(audits[0].action, 'arrstack.better.search')
  assert.ok(fa.calls.findIndex(c => c.path.startsWith('/api/v3/release')) > 0)
  assert.equal((await svc.search('radarr:7', 'admin@example.com')).reused, true); assert.equal(fa.searches(), 1)

  const refused = a.rows.find(r => r.verdict === 'refused')!
  await assert.rejects(svc.grab('radarr:7', refused.id, 'admin@example.com'), (e: any) => e.code === 'profile_refuses' && /refuses it|already downloading/.test(e.message))
  await assert.rejects(svc.grab('radarr:7', 'f'.repeat(24), 'admin@example.com'), (e: any) => e.code === 'no_release')

  const g = await svc.grab('radarr:7', a.rows[1].id, 'admin@example.com')
  assert.equal(g.result, 'queued'); assert.equal(g.top, true); assert.equal(g.swapped, false)
  assert.match(g.summary, /at the top of qBittorrent's queue/)
  assert.ok(g.notes.some(n => /What you have now \(WEBDL-1080p\) stays until Radarr imports the new copy/.test(n)), g.notes.join(' | '))
  assert.deepEqual(Object.keys(fa.calls.find(c => c.method === 'POST')!.body).sort(), ['guid', 'indexerId'])
  assert.deepEqual(qb.calls.find(c => c.method === 'POSTFORM')!.body, { hashes: NEW })
  assert.ok(!fa.calls.some(c => c.method !== 'GET' && c.method !== 'POST'), 'nothing removed: no swap, no library file')
  assert.deepEqual(audits.map(x => x.action), ['arrstack.better.search', 'arrstack.better.grab', 'arrstack.better.grab.done'])
  await assert.rejects(svc.grab('radarr:7', a.rows[0].id, 'admin@example.com'), (e: any) => e.code === 'search_used')
})

test('swap a slow download: only its own rows are removed (blocklisted, no re-search), after the new one is queued', async () => {
  const fa = radarr({ queue: fx('radarr-queue.json').records })
  const qb = qbit()
  const { svc, audits } = rig({ radarr: fa.client }, { qbit: async () => qb.client })
  const target = `queue:radarr:d:${SLOW.toUpperCase()}`
  const a = await svc.search(target, 'admin@example.com')
  assert.equal(a.label, 'Paper Lanterns (2011)'); assert.match(a.swap!.name, /SLOW/)
  assert.equal(audits[0].details.replacing, a.swap!.name)
  const queued = a.rows.find(r => r.verdict === 'anyway')!
  await assert.rejects(svc.grab(target, queued.id, 'admin@example.com'), (e: any) => e.code === 'confirm_anyway')
  const g = await svc.grab(target, queued.id, 'admin@example.com', { anyway: true })
  assert.equal(g.result, 'queued'); assert.equal(g.swapped, true); assert.equal(g.top, true)
  const del = fa.calls.filter(c => c.method === 'DELETEBODY')
  assert.equal(del.length, 1)
  assert.equal(del[0].path, '/api/v3/queue/bulk?removeFromClient=true&blocklist=true&skipRedownload=true')
  assert.deepEqual(del[0].body, { ids: [301] }, 'the other film in the same queue answer is left alone')
  const post = fa.calls.findIndex(c => c.method === 'POST'), rm = fa.calls.findIndex(c => c.method === 'DELETEBODY')
  assert.ok(post < rm, 'the new one is grabbed before the slow one goes')
  assert.ok(fa.queue().some(r => r.id === 302))
  assert.ok(!fa.calls.some(c => /moviefile|deleteFiles/.test(c.path)), 'never a library file')
  assert.equal(audits.find(x => x.action === 'arrstack.better.grab')!.details.anyway, true)
})

test('swap: when the new download does not show up, the slow one is left alone', async () => {
  const fa = radarr({ queue: fx('radarr-queue.json').records, onGrab: q => q })
  const { svc } = rig({ radarr: fa.client })
  const target = `queue:radarr:d:${SLOW.toUpperCase()}`
  const a = await svc.search(target, 'admin@example.com')
  const g = await svc.grab(target, a.rows[0].id, 'admin@example.com')
  assert.equal(g.result, 'not-seen'); assert.equal(g.swapped, false)
  assert.ok(g.notes.some(n => /slow download was left in place/.test(n)))
  assert.ok(!fa.calls.some(c => c.method === 'DELETEBODY'))
})

test('swap a season pack: the season is searched, and only the pack\'s rows are removed', async () => {
  let queue: any[] = fx('sonarr-queue.json').records
  const fa = fakeArr((m, p, b) => {
    if (m === 'GET' && p.startsWith('/api/v3/queue')) return page(queue)
    if (m === 'GET' && p === '/api/v3/series/11') return { id: 11, title: 'Quiet Harbour', qualityProfileId: 4 }
    if (m === 'GET' && p.startsWith('/api/v3/episode?seriesId=11&seasonNumber=2')) return [201, 202, 203, 204].map(id => ({ id, seriesId: 11, seasonNumber: 2, episodeFileId: id === 204 ? 5 : 0 })).concat([{ id: 900, seriesId: 12, seasonNumber: 1, episodeFileId: 0 }])
    if (m === 'GET' && p === '/api/v3/qualityprofile/4') return fx('radarr-profile.json')
    if (m === 'GET' && p === '/api/v3/release?seriesId=11&seasonNumber=2') return [{ ...fx('radarr-release.json')[0], title: 'Quiet Harbour S02 1080p BluRay x265-GRPS', mappedMovieId: undefined }]
    if (m === 'POST' && p === '/api/v3/release') { queue = [...queue, { id: 450, seriesId: 11, seasonNumber: 2, episodeId: 202, title: 'new pack', downloadId: NEW, protocol: 'torrent' }]; return {} }
    if (m === 'DELETEBODY') { queue = queue.filter(r => !b.ids.includes(r.id)); return null }
    return new Error(`unexpected ${m} ${p}`)
  })
  const { svc } = rig({ sonarr: fa.client })
  const target = `queue:sonarr:d:${PACK.toUpperCase()}`
  const a = await svc.search(target, 'admin@example.com')
  assert.equal(a.label, 'Quiet Harbour Season 2'); assert.equal(a.have, '1 of 4 episodes')
  const g = await svc.grab(target, a.rows[0].id, 'admin@example.com')
  assert.equal(g.swapped, true)
  assert.deepEqual(fa.calls.find(c => c.method === 'DELETEBODY')!.body, { ids: [400, 401, 402] })
  assert.ok(queue.some(r => r.id === 410), "another show's download is untouched")
  assert.ok(g.notes.some(n => /not moved to the top: HyperProx has no qBittorrent connection/i.test(n)))
})

test('fails closed: no audit entry, no search and no grab', async () => {
  const fa = radarr()
  const { svc } = rig({ radarr: fa.client }, { audit: async () => { throw new Error('database down') } })
  await assert.rejects(svc.search('radarr:7', 'admin@example.com'), (e: any) => e.code === 'audit_unavailable')
  assert.ok(!fa.calls.some(c => c.path.startsWith('/api/v3/release')))
  // A search made while auditing worked, then auditing fails: the grab is refused and the search stays usable.
  let ok = true
  const two = rig({ radarr: fa.client }, { audit: async () => { if (!ok) throw new Error('down') } })
  const a = await two.svc.search('radarr:7', 'admin@example.com')
  ok = false
  await assert.rejects(two.svc.grab('radarr:7', a.rows[0].id, 'admin@example.com'), (e: any) => e.code === 'audit_unavailable')
  assert.ok(!fa.calls.some(c => c.method === 'POST'))
  ok = true
  assert.equal((await two.svc.grab('radarr:7', a.rows[0].id, 'admin@example.com')).result, 'queued')
})

test('a download that left the queue cannot be searched from', async () => {
  const fa = radarr({ queue: [] })
  const { svc } = rig({ radarr: fa.client })
  await assert.rejects(svc.search(`queue:radarr:d:${SLOW}`, 'admin@example.com'), (e: any) => e.code === 'gone')
  assert.equal(fa.searches(), 0)
  void OTHER
})

// ── roles and the routes through the real gate ───────────────────────────────

test('roles: finding is a read; searches and grabs are admin, refused to API tokens; no master password', () => {
  assert.equal(requiredRole('GET', '/api/plugins/arrstack/better/find'), 'viewer')
  assert.equal(requiredRole('GET', '/api/plugins/arrstack/better/episodes'), 'viewer')
  for (const p of ['search', 'grab']) {
    assert.equal(requiredRole('POST', `/api/plugins/arrstack/better/${p}`), 'admin', p)
    assert.equal(tokenForbidden('POST', `/api/plugins/arrstack/better/${p}`), true, p)
    assert.equal(needsReconfirm('POST', `/api/plugins/arrstack/better/${p}`), false, p)
  }
  assert.equal(tokenForbidden('GET', '/api/plugins/arrstack/better/find'), false)
})

test('routes: a viewer can look things up but not search or grab; a token is refused; a grab needs confirming', async () => {
  const fa = radarr()
  const { svc } = rig({ radarr: fa.client })
  const a = Fastify({ logger: false })
  await registerGate(a)
  await a.register(authRoutes, { prefix: '/api/auth' })
  await a.register(buildArrBetterRoutes({ service: () => svc, limiter: new MissLimiter(50) }), { prefix: '/api/plugins/arrstack' })
  await a.ready()
  try {
    const viewer = await signIn(a, 'viewer@example.com', 'viewer master password')
    const f = await a.inject({ method: 'GET', url: '/api/plugins/arrstack/better/find?app=radarr&q=lantern', headers: { cookie: viewer.cookie } })
    assert.equal(f.statusCode, 200, f.body); assert.equal(JSON.parse(f.body).data.items[0].target, 'radarr:7')
    const vs = await a.inject({ method: 'POST', url: '/api/plugins/arrstack/better/search', headers: { cookie: viewer.cookie }, payload: { target: 'radarr:7' } })
    assert.equal(vs.statusCode, 403)
    const tok = (await createApiToken({ name: 'bot', role: 'admin' }, 'test', tokens)).token
    const tp = await a.inject({ method: 'POST', url: '/api/plugins/arrstack/better/search', headers: { authorization: `Bearer ${tok}` }, payload: { target: 'radarr:7' } })
    assert.equal(tp.statusCode, 403); assert.equal(JSON.parse(tp.body).code, 'token_forbidden')
    const adm = await signIn(a, 'admin@example.com', 'admin master password')
    const post = (url: string, payload: any) => a.inject({ method: 'POST', url: `/api/plugins/arrstack/better/${url}`, headers: { cookie: adm.cookie }, payload })
    assert.equal(JSON.parse((await post('grab', { target: 'radarr:7', releaseId: 'a'.repeat(24) })).body).code, 'confirm_required')
    assert.equal((await post('search', { target: 'radarr:7; rm' })).statusCode, 400)
    assert.equal((await post('grab', { target: 'radarr:7', releaseId: 'a'.repeat(24), confirmed: true, anyway: 'yes' })).statusCode, 400)
    const s = await post('search', { target: 'radarr:7' })
    assert.equal(s.statusCode, 200, s.body)
    const g = await post('grab', { target: 'radarr:7', releaseId: JSON.parse(s.body).data.rows[0].id, confirmed: true })
    assert.equal(g.statusCode, 200, g.body); assert.equal(JSON.parse(g.body).data.result, 'queued')
  } finally { await a.close() }
})
