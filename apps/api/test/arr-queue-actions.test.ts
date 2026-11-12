// Arr Stack queue actions: download id resolution, a pack removing exactly its own rows (also when the upstream filter
// is ignored), search targets per case, retry, prioritise, swap for a season pack, fix all stalled, role and token
// refusals, confirm, rate limit and audit. All titles are made up.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { requiredRole, needsReconfirm } from '../src/lib/roles'
import { buildArrQueueRoutes } from '../src/routes/arr-queue'
import { ActionRefusal, planAction, resolveDownload, runAction, searchCommands, type ActionDeps, type ActionRequest } from '../src/lib/arr-queue/actions'
import type { CoreEndpointClient } from '../src/lib/plugin-host'
import { signIn } from './fakes/app'
import { FakeBroker } from './fakes/fake-broker'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { setAuditSink } from '../src/lib/audit'
import { MemoryApiTokenStore, setApiTokenStore, createApiToken, tokenForbidden } from '../src/lib/api-tokens'
import { MissLimiter } from '../src/lib/plex-art'

const broker = new FakeBroker()
broker.addUser('viewer@example.com', 'viewer master password', 'viewer')
broker.addUser('operator@example.com', 'operator master password', 'operator')
broker.addUser('admin@example.com', 'admin master password', 'admin')
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

const GB = 1e9
let rid = 1000
const row = (over: any = {}) => {
  const id = ++rid
  return {
    id, seriesId: 1, seasonNumber: 1, episodeId: id, series: { title: 'Example Show' }, episode: { id, seasonNumber: 1, episodeNumber: 1 },
    title: 'Example.Show.S01E01.1080p.WEB', size: 4 * GB, sizeleft: 1 * GB, status: 'downloading',
    trackedDownloadStatus: 'ok', trackedDownloadState: 'downloading', statusMessages: [], downloadId: `SINGLE${id}`, protocol: 'torrent',
    ...over,
  }
}
const pack = (n: number, over: any = {}) => Array.from({ length: n }, (_, i) => {
  const id = ++rid
  return row({ title: 'Example.Show.S01.1080p.WEB', ...over, id, episodeId: id, episode: { id, seasonNumber: over.seasonNumber ?? 1, episodeNumber: i + 1 } })
})
const stalled = (over: any = {}) => row({ statusMessages: [{ title: 'x', messages: ['The download is stalled with no connections'] }], trackedDownloadStatus: 'warning', ...over })
const HASH = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01'

/** A fake Sonarr/Radarr. Its queue read ignores every query parameter (as Sonarr ignores `seriesId=`) and returns it all. */
function fakeArr(rows: any[]) {
  const log = { gets: [] as string[], deletes: [] as Array<{ p: string; ids: number[] }>, posts: [] as any[] }
  const client: CoreEndpointClient = {
    async get(p: string) { log.gets.push(p); return { totalRecords: rows.length, records: rows.slice() } },
    async deleteBody(p: string, body: any) {
      log.deletes.push({ p, ids: body.ids })
      for (const id of body.ids) { const i = rows.findIndex(r => r.id === id); if (i >= 0) rows.splice(i, 1) }
      return null
    },
    async post(_p: string, body: any) { log.posts.push(body); return { id: log.posts.length } },
  } as any
  return { client, log, rows }
}
function fakeQbit(known: string[]) {
  const log = { gets: [] as string[], forms: [] as any[] }
  const client = {
    async get(p: string) { log.gets.push(p); return known.length ? [{ hash: known[0] }] : [] },
    async postForm(p: string, f: any) { log.forms.push({ p, f }); return null },
  } as any
  return { client, log }
}
const mkDeps = (s: any, r: any = null, q: any = null, audits: any[] = []): ActionDeps => ({
  sonarr: async () => s, radarr: async () => r, qbit: async () => q,
  audit: async (action, details) => { audits.push({ action, details }) },
})
const req = (o: Partial<ActionRequest> & { action: ActionRequest['action'] }): ActionRequest => ({ instance: 'sonarr', ...o })
const refusal = async (p: Promise<unknown>, code: string) => {
  await assert.rejects(p, (e: any) => e instanceof ActionRefusal && e.code === code, `expected ${code}`)
}

// ── resolution ───────────────────────────────────────────────────────────────

test('resolve: a download id picks exactly its rows from a full queue; unknown is null; garbage is refused', () => {
  const p = pack(23, { downloadId: 'PACK1' }), other = pack(5, { downloadId: 'PACK2', seriesId: 2 }), one = row()
  const all = [...other, ...p, one]
  const got = resolveDownload(all, 'd:PACK1')!
  assert.equal(got.length, 23)
  assert.ok(got.every(r => r.downloadId === 'PACK1'))
  assert.equal(resolveDownload(all, 'd:NOPE'), null)
  assert.equal(resolveDownload(all, `d:${one.downloadId}`)!.length, 1)
  assert.throws(() => resolveDownload(all, '../etc'), (e: any) => e.code === 'bad_request')
  const anon = row({ downloadId: undefined })
  assert.equal(resolveDownload([anon, ...p], `i:${anon.id}`)!.length, 1)
})

// ── a pack removes all its rows and nothing else ─────────────────────────────

test('remove: a 23-row pack deletes those 23 row ids only, even though the upstream queue filter is ignored', async () => {
  const p = pack(23, { downloadId: 'PACK1' })
  const others = [...pack(4, { downloadId: 'PACK2' }), row(), row({ seriesId: 2, series: { title: 'Other Show' } })]
  const fa = fakeArr([...others, ...p])
  const out = await runAction(mkDeps(fa.client), req({ action: 'remove', downloadId: 'd:PACK1', blocklist: false }), 'a@example.com')
  assert.equal(fa.log.deletes.length, 1)
  assert.deepEqual([...fa.log.deletes[0].ids].sort(), p.map(r => r.id).sort())
  assert.equal(fa.log.deletes[0].p, '/api/v3/queue/bulk?removeFromClient=true&blocklist=false&skipRedownload=true')
  assert.equal(fa.rows.length, others.length, 'every other row is still there')
  assert.ok(fa.log.gets.every(g => g.startsWith('/api/v3/queue?') && !/[?&]seriesId=/.test(g)), 'no seriesId filter is ever sent')
  assert.equal(fa.log.posts.length, 0, 'remove never searches')
  assert.match(out.result!.summary, /Removed "Example.Show.S01.1080p.WEB" \(23 episodes\)/)
})

test('remove: the blocklist box decides blocklist=true', async () => {
  const fa = fakeArr([row({ downloadId: 'X1' })])
  await runAction(mkDeps(fa.client), req({ action: 'remove', downloadId: 'd:X1', blocklist: true }), 'a@example.com')
  assert.equal(fa.log.deletes[0].p, '/api/v3/queue/bulk?removeFromClient=true&blocklist=true&skipRedownload=true', 'the Arr must not start its own search')
})

test('a download that left the queue meanwhile is 404 and nothing is deleted', async () => {
  const fa = fakeArr([row()])
  await refusal(runAction(mkDeps(fa.client), req({ action: 'remove', downloadId: 'd:GONE' }), 'a@example.com'), 'gone')
  assert.equal(fa.log.deletes.length, 0)
})

// ── search targets ───────────────────────────────────────────────────────────

test('search targets: one episode, a multi-episode release, a season pack, a multi-season pack, a movie, nothing', () => {
  const single = row()
  assert.deepEqual(searchCommands('sonarr', [single]).map(c => c.body), [{ name: 'EpisodeSearch', episodeIds: [single.episodeId] }])
  const two = [row({ title: 'Example.Show.S01E01E02.1080p', downloadId: 'T' }), row({ title: 'Example.Show.S01E01E02.1080p', downloadId: 'T' })]
  assert.deepEqual(searchCommands('sonarr', two).map(c => c.name), ['EpisodeSearch'])
  assert.deepEqual((searchCommands('sonarr', two)[0].body.episodeIds as number[]).length, 2)
  assert.deepEqual(searchCommands('sonarr', pack(10)).map(c => c.body), [{ name: 'SeasonSearch', seriesId: 1, seasonNumber: 1 }])
  const multi = [...pack(3, { title: 'Example.Show.S01-S02.Complete' }), ...pack(3, { title: 'Example.Show.S01-S02.Complete', seasonNumber: 2 })]
  assert.deepEqual(searchCommands('sonarr', multi).map(c => c.body), [{ name: 'SeasonSearch', seriesId: 1, seasonNumber: 1 }, { name: 'SeasonSearch', seriesId: 1, seasonNumber: 2 }])
  const film = [{ id: 1, movieId: 77, movie: { id: 77, title: 'Paper Moons' }, title: 'Paper.Moons.2026' }]
  assert.deepEqual(searchCommands('radarr', film).map(c => c.body), [{ name: 'MoviesSearch', movieIds: [77] }])
  assert.deepEqual(searchCommands('sonarr', [{ id: 5, title: 'x', downloadId: 'Q' }]), [])
})

test('find another: removes with blocklist, then searches exactly what it covered; an unmatched download is refused before any delete', async () => {
  const s = row({ downloadId: 'S1' })
  const fa = fakeArr([s, ...pack(10, { downloadId: 'P' }), row({ downloadId: 'NOMATCH', episodeId: undefined, episode: undefined })])
  const a = await runAction(mkDeps(fa.client), req({ action: 'find-another', downloadId: 'd:S1' }), 'a@example.com')
  assert.match(fa.log.deletes[0].p, /blocklist=true&skipRedownload=true$/)
  assert.deepEqual(fa.log.deletes[0].ids, [s.id])
  assert.deepEqual(fa.log.posts, [{ name: 'EpisodeSearch', episodeIds: [s.episodeId] }])
  assert.match(a.result!.summary, /Searching for another copy of the episode/)
  await runAction(mkDeps(fa.client), req({ action: 'find-another', downloadId: 'd:P' }), 'a@example.com')
  assert.deepEqual(fa.log.posts[1], { name: 'SeasonSearch', seriesId: 1, seasonNumber: 1 })
  const before = fa.log.deletes.length
  await refusal(runAction(mkDeps(fa.client), req({ action: 'find-another', downloadId: 'd:NOMATCH' }), 'a@example.com'), 'nothing_to_search')
  assert.equal(fa.log.deletes.length, before)
})

test('find another on a film: MoviesSearch', async () => {
  const m = { id: 9, movieId: 55, movie: { id: 55, title: 'Paper Moons', year: 2026 }, title: 'Paper.Moons.2026', size: GB, sizeleft: GB, downloadId: 'M1', protocol: 'torrent', status: 'downloading', trackedDownloadState: 'downloading', trackedDownloadStatus: 'ok', statusMessages: [] }
  const fr = fakeArr([m])
  await runAction(mkDeps(null, fr.client), req({ action: 'find-another', instance: 'radarr', downloadId: 'd:M1' }), 'a@example.com')
  assert.deepEqual(fr.log.posts, [{ name: 'MoviesSearch', movieIds: [55] }])
})

test('a search that Sonarr does not confirm is reported, with what was already removed', async () => {
  const fa = fakeArr([row({ downloadId: 'S1' })])
  ;(fa.client as any).post = async () => ({})
  await assert.rejects(runAction(mkDeps(fa.client), req({ action: 'find-another', downloadId: 'd:S1' }), 'a@example.com'), (e: any) => e.code === 'command_unconfirmed' && /Removed 1 download/.test(e.message))
})

// ── retry import ─────────────────────────────────────────────────────────────

test('retry import: only a blocked import; sends RefreshMonitoredDownloads; shows messages; permissions get a hint only', async () => {
  const ok = row({ downloadId: 'OK1' })
  const blocked = row({ downloadId: 'B1', trackedDownloadState: 'importBlocked', trackedDownloadStatus: 'warning', statusMessages: [{ title: 't', messages: ['Episode file is not writable: Access to the path "/data/tv/x" is denied'] }] })
  const wrong = row({ downloadId: 'B2', trackedDownloadState: 'importBlocked', trackedDownloadStatus: 'warning', statusMessages: [{ title: 't', messages: ['Found matching series via grab history, but release was matched to series by ID'] }] })
  const fa = fakeArr([ok, blocked, wrong])
  await refusal(runAction(mkDeps(fa.client), req({ action: 'retry-import', downloadId: 'd:OK1' }), 'a@example.com'), 'not_blocked')
  const r = await runAction(mkDeps(fa.client), req({ action: 'retry-import', downloadId: 'd:B1' }), 'a@example.com')
  assert.deepEqual(fa.log.posts, [{ name: 'RefreshMonitoredDownloads' }])
  assert.equal(fa.log.deletes.length, 0)
  assert.ok(r.result!.hint && /permissions/.test(r.result!.hint) && /does not change permissions/.test(r.result!.hint))
  assert.ok(!r.result!.messages!.join(' ').includes('/data/tv'), 'the path is not sent')
  const w = await runAction(mkDeps(fa.client), req({ action: 'retry-import', downloadId: 'd:B2' }), 'a@example.com')
  assert.equal(w.result!.hint, null)
  assert.match(w.result!.messages![0], /matched to series by ID/)
})

// ── prioritise ───────────────────────────────────────────────────────────────

test('prioritise: topPrio with the download id as the hash, only for a torrent qBittorrent knows', async () => {
  const t = row({ downloadId: HASH })
  const nz = row({ downloadId: 'nzb123', protocol: 'usenet' })
  const fa = fakeArr([t, nz])
  const q = fakeQbit([HASH.toLowerCase()])
  const r = await runAction(mkDeps(fa.client, null, q.client), req({ action: 'prioritise', downloadId: `d:${HASH}` }), 'a@example.com')
  assert.deepEqual(q.log.forms, [{ p: '/api/v2/torrents/topPrio', f: { hashes: HASH.toLowerCase() } }])
  assert.equal(fa.log.deletes.length + fa.log.posts.length, 0)
  assert.match(r.result!.summary, /top of qBittorrent's queue/)
  await refusal(runAction(mkDeps(fa.client, null, q.client), req({ action: 'prioritise', downloadId: 'd:nzb123' }), 'a@example.com'), 'not_a_torrent')
  await refusal(runAction(mkDeps(fa.client, null, null), req({ action: 'prioritise', downloadId: `d:${HASH}` }), 'a@example.com'), 'no_qbit')
  await refusal(runAction(mkDeps(fa.client, null, fakeQbit([]).client), req({ action: 'prioritise', downloadId: `d:${HASH}` }), 'a@example.com'), 'not_in_qbit')
})

// ── swap for a season pack ───────────────────────────────────────────────────

test('swap: selects only unfinished single-episode downloads of that season; not blocklisted; then SeasonSearch', async () => {
  const a = row({ downloadId: 'A' }), b = row({ downloadId: 'B' })
  const done = row({ downloadId: 'DONE', sizeleft: 0 })
  const existingPack = pack(8, { downloadId: 'OLDPACK' })
  const s2 = row({ downloadId: 'S2', seasonNumber: 2 })
  const otherShow = row({ downloadId: 'OS', seriesId: 2 })
  const fa = fakeArr([a, b, done, ...existingPack, s2, otherShow])
  const plan = planAction(fa.rows, req({ action: 'swap-pack', showKey: 's:1', seasonKey: '1' }))
  assert.deepEqual(plan.items.map(i => i.downloadId).sort(), ['d:A', 'd:B'])
  assert.deepEqual(plan.rowIds.sort(), [a.id, b.id].sort())
  assert.deepEqual(plan.packsBefore, ['d:OLDPACK'])
  await refusal(runAction(mkDeps(fa.client), req({ action: 'swap-pack', showKey: 's:1', seasonKey: '1' }), 'a@example.com'), 'bad_request')
  // A single grabbed after the preview: the confirm names only A and B, so nothing is removed.
  const late = row({ downloadId: 'LATE' })
  fa.rows.push(late)
  await refusal(runAction(mkDeps(fa.client), req({ action: 'swap-pack', showKey: 's:1', seasonKey: '1', downloadIds: ['d:A', 'd:B'] }), 'a@example.com'), 'changed')
  assert.equal(fa.log.deletes.length, 0)
  fa.rows.splice(fa.rows.indexOf(late), 1)
  const r = await runAction(mkDeps(fa.client), req({ action: 'swap-pack', showKey: 's:1', seasonKey: '1', downloadIds: ['d:B', 'd:A'] }), 'a@example.com')
  assert.match(fa.log.deletes[0].p, /blocklist=false&skipRedownload=true$/)
  assert.deepEqual(fa.log.posts, [{ name: 'SeasonSearch', seriesId: 1, seasonNumber: 1 }])
  assert.match(r.result!.summary, /20 seconds/)
  await refusal(runAction(mkDeps(fa.client), req({ action: 'swap-pack', showKey: 's:2', seasonKey: '1', downloadIds: ['d:A'] }), 'a@example.com'), 'not_enough_singles')
  await refusal(runAction(mkDeps(fa.client), req({ action: 'swap-pack', showKey: 'x', seasonKey: '1' }), 'a@example.com'), 'bad_request')
  // Two singles are needed: one left is not enough.
  await refusal(runAction(mkDeps(fakeArr([row({ downloadId: 'ONLY' })]).client), req({ action: 'swap-pack', showKey: 's:1', seasonKey: '1', downloadIds: ['d:ONLY'] }), 'a@example.com'), 'not_enough_singles')
})

test('swap check: reports a newly grabbed pack, or says none was found', async () => {
  const fa = fakeArr([row({ downloadId: 'A' }), row({ downloadId: 'B' })])
  const none = await runAction(mkDeps(fa.client), req({ action: 'swap-check', showKey: 's:1', seasonKey: '1', known: [] }), 'a@example.com')
  assert.equal(none.result!.packGrabbed, false)
  assert.equal(none.result!.summary, 'no season pack found; singles will be re-grabbed')
  fa.rows.push(...pack(8, { downloadId: 'NEWPACK' }))
  const got = await runAction(mkDeps(fa.client), req({ action: 'swap-check', showKey: 's:1', seasonKey: '1', known: [] }), 'a@example.com')
  assert.equal(got.result!.packGrabbed, true)
  assert.match(got.result!.summary, /A season pack was grabbed: Example.Show.S01/)
  const old = await runAction(mkDeps(fa.client), req({ action: 'swap-check', showKey: 's:1', seasonKey: '1', known: ['d:NEWPACK'] }), 'a@example.com')
  assert.equal(old.result!.packGrabbed, false, 'a pack that was already there does not count')
  assert.equal(fa.log.deletes.length + fa.log.posts.length, 0, 'the check changes nothing')
})

// ── fix all stalled ──────────────────────────────────────────────────────────

test('fix stalled: only downloads still stalled, merged into one search, others skipped by name', async () => {
  const s1 = stalled({ downloadId: 'S1' }), s2 = stalled({ downloadId: 'S2' }), fine = row({ downloadId: 'FINE' })
  const sp = pack(6, { downloadId: 'SP', statusMessages: [{ title: 'x', messages: ['stalled'] }], trackedDownloadStatus: 'warning', seasonNumber: 2 })
  const fa = fakeArr([s1, s2, fine, ...sp])
  const r = await runAction(mkDeps(fa.client), req({ action: 'fix-stalled', downloadIds: ['d:S1', 'd:S2', 'd:SP', 'd:FINE', 'd:GONE'] }), 'a@example.com')
  assert.deepEqual([...fa.log.deletes[0].ids].sort(), [s1.id, s2.id, ...sp.map(x => x.id)].sort())
  assert.ok(!fa.log.deletes[0].ids.includes(fine.id))
  assert.match(fa.log.deletes[0].p, /blocklist=true&skipRedownload=true$/)
  assert.equal(fa.log.posts.length, 2)
  assert.deepEqual(fa.log.posts[0], { name: 'EpisodeSearch', episodeIds: [s1.episodeId, s2.episodeId] })
  assert.deepEqual(fa.log.posts[1], { name: 'SeasonSearch', seriesId: 1, seasonNumber: 2 })
  assert.match(r.result!.summary, /Skipped 2 downloads/)
  await refusal(runAction(mkDeps(fa.client), req({ action: 'fix-stalled', downloadIds: ['d:FINE'] }), 'a@example.com'), 'nothing_to_do')
})

// ── audit ────────────────────────────────────────────────────────────────────

test('audit: written before the run; if it cannot be written nothing is changed; a preview changes and records nothing', async () => {
  const audits: any[] = []
  const fa = fakeArr([row({ downloadId: 'S1' })])
  await runAction(mkDeps(fa.client, null, null, audits), req({ action: 'remove', downloadId: 'd:S1' }), 'a@example.com', { preview: true })
  assert.equal(audits.length, 0); assert.equal(fa.log.deletes.length, 0)
  await runAction(mkDeps(fa.client, null, null, audits), req({ action: 'remove', downloadId: 'd:S1' }), 'a@example.com')
  assert.equal(audits[0].action, 'arr.queue.action')
  assert.equal(audits[0].details.by, 'a@example.com')
  assert.deepEqual(audits[0].details.names, ['Example.Show.S01E01.1080p.WEB'])
  assert.equal(audits.at(-1).action, 'arr.queue.action.result')
  const fb = fakeArr([row({ downloadId: 'S2' })])
  const deps = { ...mkDeps(fb.client), audit: async () => { throw new Error('db down') } }
  await refusal(runAction(deps, req({ action: 'remove', downloadId: 'd:S2' }), 'a@example.com'), 'audit_unavailable')
  assert.equal(fb.log.deletes.length, 0)
})

// ── role, token, confirm, rate limit through the real gate ───────────────────

test('roles: POST actions are admin; tokens are forbidden by name; no master password is asked', () => {
  assert.equal(requiredRole('POST', '/api/plugins/arrstack/queue/actions'), 'admin')
  assert.equal(requiredRole('GET', '/api/plugins/arrstack/queue'), 'viewer')
  assert.equal(tokenForbidden('POST', '/api/plugins/arrstack/queue/actions'), true)
  assert.equal(needsReconfirm('POST', '/api/plugins/arrstack/queue/actions'), false)
})

test('route: viewer and operator refused, an admin API token refused, an admin signed in may act; confirm and rate limit', async () => {
  const fa = fakeArr([row({ downloadId: 'S1' }), row({ downloadId: 'S2' }), row({ downloadId: 'S3' })])
  const audits: any[] = []
  const a = Fastify({ logger: false })
  await registerGate(a)
  await a.register(authRoutes, { prefix: '/api/auth' })
  await a.register(buildArrQueueRoutes({
    sonarr: async () => fa.client, radarr: async () => null, qbit: async () => null,
    audit: async (action, details) => { audits.push({ action, details }) }, limiter: new MissLimiter(5),
  }), { prefix: '/api/plugins/arrstack' })
  await a.ready()
  try {
    const url = '/api/plugins/arrstack/queue/actions'
    const post = (headers: any, payload: any) => a.inject({ method: 'POST', url, headers, payload })
    const body = { action: 'remove', instance: 'sonarr', downloadId: 'd:S1', confirmed: true }

    const anon = await post({}, body)
    assert.ok([401, 423].includes(anon.statusCode))
    const viewer = await signIn(a, 'viewer@example.com', 'viewer master password')
    assert.equal((await post({ cookie: viewer.cookie }, body)).statusCode, 403)
    const oper = await signIn(a, 'operator@example.com', 'operator master password')
    const o = await post({ cookie: oper.cookie }, body)
    assert.equal(o.statusCode, 403); assert.equal(JSON.parse(o.body).code, 'forbidden')

    const tok = (await createApiToken({ name: 'bot', role: 'admin' }, 'test', store)).token
    const t = await post({ authorization: `Bearer ${tok}` }, body)
    assert.equal(t.statusCode, 403); assert.equal(JSON.parse(t.body).code, 'token_forbidden')
    assert.equal(fa.log.deletes.length, 0, 'none of those changed anything')

    const adm = await signIn(a, 'admin@example.com', 'admin master password')
    const cookie = adm.cookie
    const noConfirm = await post({ cookie }, { ...body, confirmed: undefined })
    assert.equal(noConfirm.statusCode, 400); assert.equal(JSON.parse(noConfirm.body).code, 'confirm_required')
    const bad = await post({ cookie }, { action: 'remove', instance: 'sonarr', downloadId: 'd:S1; DROP', confirmed: true })
    assert.equal(bad.statusCode, 400)
    const prev = await post({ cookie }, { ...body, preview: true, confirmed: undefined })
    assert.equal(prev.statusCode, 200, prev.body)
    const pj = JSON.parse(prev.body).data
    assert.equal(pj.preview, true); assert.equal(pj.plan.items[0].name, 'Example.Show.S01E01.1080p.WEB')
    assert.ok(!('rowIds' in pj.plan) && !/"id":/.test(prev.body), 'no queue row id reaches the browser')
    assert.equal(fa.log.deletes.length, 0, 'a preview changes nothing')

    const go = await post({ cookie }, body)
    assert.equal(go.statusCode, 200, go.body)
    assert.equal(fa.log.deletes.length, 1)
    assert.equal(audits[0].details.by, 'admin@example.com')
    // five allowed in a minute (limiter 5): this was the 5th request counted from the admin; the 6th is refused.
    const again = await post({ cookie }, { ...body, downloadId: 'd:S2' })
    assert.equal(again.statusCode, 200)
    const limited = await post({ cookie }, { ...body, downloadId: 'd:S3' })
    assert.equal(limited.statusCode, 429)
  } finally { await a.close() }
})

test('route: the queue answer says whether Prioritise can be offered', async () => {
  const fa = fakeArr([row()])
  const mk = async (qbit: any) => {
    const a = Fastify({ logger: false })
    await registerGate(a)
    await a.register(authRoutes, { prefix: '/api/auth' })
    await a.register(buildArrQueueRoutes({ sonarr: async () => fa.client, radarr: async () => null, qbit: async () => qbit }), { prefix: '/api/plugins/arrstack' })
    await a.ready()
    const { cookie } = await signIn(a, 'viewer@example.com', 'viewer master password')
    const r = await a.inject({ method: 'GET', url: '/api/plugins/arrstack/queue', headers: { cookie } })
    await a.close()
    return JSON.parse(r.body).data.capabilities
  }
  assert.deepEqual(await mk(null), { prioritise: false })
  assert.deepEqual(await mk(fakeQbit([HASH]).client), { prioritise: true })
})
