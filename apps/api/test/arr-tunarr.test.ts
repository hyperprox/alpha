// Arr Stack, Live TV (Tunarr): the channel list with what is on now and next, the hours of guide published (a warning
// under 24), who is streaming (addresses for admins only), Tunarr's version against the newest release, its media
// sources and health, the two fixes (audited first, read back, refused to API tokens, confirmed on the page), and the
// app-update provider that tells the Updates page when Tunarr is behind. A fake Tunarr answers from memory; every
// name and address is invented (documentation ranges only).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { requiredRole, needsConfirm, needsPassword } from '../src/lib/roles'
import { injectConfirmed } from './fakes/confirm'
import { buildArrTunarrRoutes } from '../src/routes/arr-tunarr'
import { GUIDE_MIN_HOURS, buildLiveTv, forViewer, guideHoursOf, nowAndNext, splitVersion, versionState } from '../src/lib/arr-tunarr/logic'
import { TunarrRefusal, TunarrService, type TunarrDeps } from '../src/lib/arr-tunarr/service'
import { latestTunarr } from '../src/lib/arr-tunarr/production'
import { DETECT_SCRIPT, imageTag, parseDetect, tunarrProvider } from '../src/lib/arr-tunarr/provider'
import { arrstackPlugin } from '../src/plugins/arrstack'
import { appUpdateProviders, type AppContext, type CoreEndpointClient } from '../src/lib/plugin-host'
import { signIn } from './fakes/app'
import { FakeBroker } from './fakes/fake-broker'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { setAuditSink } from '../src/lib/audit'
import { MemoryApiTokenStore, setApiTokenStore, createApiToken, tokenForbidden } from '../src/lib/api-tokens'
import { MissLimiter } from '../src/lib/plex-art'

const NOW = Date.parse('2026-11-20T12:00:00Z')
const H = 3_600_000
const CH1 = 'aaaaaaaa-1111-4111-8111-111111111111'
const CH2 = 'bbbbbbbb-2222-4222-8222-222222222222'
const CH3 = 'cccccccc-3333-4333-8333-333333333333'

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

// ── a fake Tunarr ─────────────────────────────────────────────────────────────────────────────

interface Fake {
  channels: any[]; guideEnd: Record<string, number>; programs: Record<string, any[]>; sessions: Record<string, any[]>
  version: string; health: Record<string, any>; sources: Array<{ id: string; name: string; type: string; healthy: boolean | null }>
  tasks: any[]; down: Set<string>; calls: string[]; keepSessions: boolean
}
const prog = (title: string, from: number, to: number, type = 'content') => ({ type, title, start: from, stop: to })

function fake(o: Partial<Fake> = {}): { f: Fake; client: CoreEndpointClient } {
  const f: Fake = {
    channels: [
      { id: CH1, number: 1, name: 'Channel One', icon: { path: '/images/one.png' }, programCount: 40, duration: 1 },
      { id: CH2, number: 2, name: 'Channel Two', icon: { path: 'https://elsewhere.example/two.png' }, programCount: 12, duration: 1 },
    ],
    guideEnd: { [CH1]: NOW + 30 * H, [CH2]: NOW + 10 * H },
    programs: {
      [CH1]: [prog('Morning Show', NOW - H, NOW + H), prog('Late Film', NOW + H, NOW + 3 * H)],
      [CH2]: [prog('Cartoon Hour', NOW - 2 * H, NOW + 30 * 60_000), prog('Quiz Night', NOW + 30 * 60_000, NOW + 2 * H)],
    },
    sessions: { [CH1]: [{ type: 'hls', state: 'started', numConnections: 2, connections: [{ ip: '198.51.100.7', userAgent: 'Example Player/1.0' }, { ip: '198.51.100.8' }] }] },
    version: '2026.11.1', health: {}, sources: [{ id: 'src1', name: 'Library Server', type: 'plex', healthy: true }],
    tasks: [{ id: 'UpdateXmlTvTask', name: 'UpdateXmlTvTask' }], down: new Set(), calls: [], keepSessions: false, ...o,
  }
  const get = async (path: string): Promise<any> => {
    const u = new URL(path, 'http://tunarr.invalid')
    f.calls.push(`GET ${u.pathname}`)
    if (f.down.has(u.pathname)) throw new Error('Arr Stack returned HTTP 500')
    if (u.pathname === '/api/channels') return f.channels
    if (u.pathname === '/api/version') return { tunarr: f.version, ffmpeg: '7.1' }
    if (u.pathname === '/api/guide/status') return { guideTimes: Object.fromEntries(Object.entries(f.guideEnd).map(([k, v]) => [k, { start: new Date(NOW).toISOString(), end: new Date(v).toISOString() }])) }
    if (u.pathname === '/api/guide/channels') return Object.fromEntries(Object.entries(f.programs).map(([k, v]) => [k, { id: k, programs: v }]))
    if (u.pathname === '/api/sessions') return f.sessions
    if (u.pathname === '/api/system/health') return f.health
    if (u.pathname === '/api/media-sources') return f.sources.map(s => ({ id: s.id, name: s.name, type: s.type, uri: 'http://198.51.100.50:32400' }))
    const m = /^\/api\/media-sources\/([^/]+)\/status$/.exec(u.pathname)
    if (m) { const s = f.sources.find(x => x.id === m[1]); if (!s || s.healthy === null) throw new Error('timeout'); return s.healthy ? { healthy: true } : { healthy: false, status: 'unreachable' } }
    if (u.pathname === '/api/tasks') return f.tasks
    throw new Error(`no such route ${u.pathname}`)
  }
  const client = {
    get,
    delete: async (path: string) => {
      f.calls.push(`DELETE ${path}`)
      const m = /^\/api\/channels\/([^/]+)\/sessions$/.exec(path)
      if (m && !f.keepSessions) delete f.sessions[m[1]]
      return null
    },
    post: async (path: string) => { f.calls.push(`POST ${path}`); return null },
    image: async (path: string) => { f.calls.push(`IMAGE ${path}`); return { contentType: 'image/png', body: Buffer.from('png') } },
  } as unknown as CoreEndpointClient
  return { f, client }
}

function rig(o: Partial<Fake> = {}, over: Partial<TunarrDeps> = {}) {
  const { f, client } = fake(o)
  const audits: Array<{ action: string; details: any }> = []
  let now = NOW
  const svc = new TunarrService({
    client: async () => client, latest: async () => 'v2026.11.2',
    audit: async (action, details) => { audits.push({ action, details }) },
    now: () => now, ...over,
  })
  return { f, svc, audits, setNow: (t: number) => { now = t } }
}

// ── the reading ───────────────────────────────────────────────────────────────────────────────

test('channels with what is on now and next, programme counts and viewers, in channel order', async () => {
  const { svc } = rig()
  const tv = await svc.read(true)
  assert.equal(tv.configured, true)
  assert.deepEqual(tv.channels.map(c => [c.number, c.name, c.programCount, c.viewers]), [[1, 'Channel One', 40, 2], [2, 'Channel Two', 12, 0]])
  assert.equal(tv.channels[0].now?.title, 'Morning Show'); assert.equal(tv.channels[0].next?.title, 'Late Film')
  assert.equal(tv.channels[1].now?.title, 'Cartoon Hour'); assert.equal(tv.channels[1].next?.title, 'Quiz Night')
  assert.equal(tv.summary.channels, 2); assert.equal(tv.summary.viewers, 2); assert.equal(tv.summary.streaming, 1)
  // only a path on Tunarr itself is an icon HyperProx will fetch; an outside address is never followed
  assert.deepEqual(tv.channels.map(c => c.hasIcon), [true, false])
  assert.ok(!JSON.stringify(tv).includes('198.51.100.50'), 'a media source address never leaves')
})

test('hours of guide published are counted from now; under 24 is a warning with a Refresh guide fix, and the count is in the page', async () => {
  const { svc } = rig()
  const tv = await svc.read(true)
  assert.deepEqual(tv.channels.map(c => [c.guideHours, c.guideShort]), [[30, false], [10, true]])
  const w = tv.warnings.find(x => x.fix === 'refresh-guide')!
  assert.equal(w.level, 'warning'); assert.match(w.text, /Channel 2 Channel Two has less than 24 hours of guide published \(the shortest has 10 h\)/)
  assert.equal(tv.summary.guideShort, 1); assert.equal(tv.summary.shortestGuideHours, 10)
  assert.equal(guideHoursOf({ guideTimes: { x: { end: new Date(NOW + 24 * H).toISOString() } } }, 'x', NOW), GUIDE_MIN_HOURS)
  assert.equal(guideHoursOf({ guideTimes: { x: { end: 'Invalid Date' } } }, 'x', NOW), null)
  assert.equal(guideHoursOf({ guideTimes: { x: { end: new Date(NOW - H).toISOString() } } }, 'x', NOW), 0)
  const full = await rig({ guideEnd: { [CH1]: NOW + 48 * H, [CH2]: NOW + 24 * H } }).svc.read(true)
  assert.ok(!full.warnings.some(x => x.fix === 'refresh-guide'), 'exactly 24 hours is enough')
})

test('a channel that cannot stream says why: no programming, nothing on now, a failed session', async () => {
  const { svc } = rig({
    channels: [
      { id: CH1, number: 1, name: 'Empty', icon: {}, programCount: 0 },
      { id: CH2, number: 2, name: 'Gap', icon: {}, programCount: 5 },
      { id: CH3, number: 3, name: 'Broken', icon: {}, programCount: 5 },
    ],
    programs: { [CH1]: [], [CH2]: [prog('Later', NOW + H, NOW + 2 * H)], [CH3]: [prog('Now', NOW - H, NOW + H)] },
    sessions: { [CH3]: [{ type: 'hls', state: 'error', numConnections: 0, connections: [] }] },
    guideEnd: { [CH1]: NOW + 30 * H, [CH2]: NOW + 30 * H, [CH3]: NOW + 30 * H },
  })
  const tv = await svc.read(true)
  assert.deepEqual(tv.channels.map(c => c.canStream), [false, false, false])
  assert.match(tv.channels[0].problems[0], /no programming/); assert.match(tv.channels[1].problems[0], /Nothing is scheduled on it right now/); assert.match(tv.channels[2].problems[0], /stream session has failed/)
  assert.equal(tv.summary.cannotStream, 3)
  const stop = tv.warnings.filter(w => w.fix === 'stop-session')
  assert.equal(stop.length, 1); assert.equal(stop[0].channelId, CH3)
  assert.equal(tv.channels[1].next?.title, 'Later')
})

test('health: version behind the newest release, a media source that does not answer, Tunarr\'s own warnings', async () => {
  const { svc } = rig({ sources: [{ id: 's1', name: 'Library Server', type: 'plex', healthy: false }, { id: 's2', name: 'Slow Server', type: 'jellyfin', healthy: null }], health: { FfmpegVersion: { type: 'warning', context: 'ffmpeg is older than 7' }, Fine: { type: 'healthy' } } })
  const tv = await svc.read(true)
  assert.equal(tv.version.installed, '2026.11.1'); assert.equal(tv.version.latest, '2026.11.2'); assert.equal(tv.version.behind, true); assert.equal(tv.version.ffmpeg, '7.1')
  assert.deepEqual(tv.sources.map(s => [s.name, s.state]), [['Library Server', 'down'], ['Slow Server', 'unknown']])
  assert.ok(tv.warnings.some(w => w.level === 'error' && /Library Server is not answering \(unreachable\)/.test(w.text)))
  assert.ok(tv.warnings.some(w => /Tunarr reports: FfmpegVersion — ffmpeg is older than 7/.test(w.text)))
  assert.ok(tv.warnings.some(w => w.level === 'notice' && /behind the newest release, 2026\.11\.2/.test(w.text)))
  assert.ok(!tv.warnings.some(w => /Fine/.test(w.text)))
})

test('version comparison: current, edge build, unreadable and unknown latest never claim "behind" wrongly', () => {
  assert.equal(versionState('2026.11.2', 'v2026.11.2').behind, false)
  assert.equal(versionState('2026.11.2-ab12cd', 'v2026.11.2').behind, false); assert.equal(versionState('2026.11.2-ab12cd', 'v2026.11.2').edge, true)
  assert.equal(versionState('2026.10.9', 'v2026.11.2').behind, true)
  assert.equal(versionState('0.12.3', 'v2026.11.2').behind, true)
  assert.equal(versionState('unknown', 'v2026.11.2').behind, null); assert.equal(versionState('2026.11.2', null).behind, null)
  assert.deepEqual(splitVersion('v1.2.3-dev'), { base: '1.2.3', edge: true })
})

test('a part Tunarr does not answer is left out; the channel list failing is the tab\'s error', async () => {
  const { svc } = rig({ down: new Set(['/api/guide/status', '/api/sessions', '/api/version', '/api/media-sources', '/api/tasks']) })
  const tv = await svc.read(true)
  assert.equal(tv.channels.length, 2); assert.equal(tv.channels[0].guideHours, null); assert.equal(tv.version.installed, null)
  assert.ok(tv.warnings.some(w => /did not report how much guide is published/.test(w.text)))
  assert.equal(tv.actions.refreshGuide, false, 'with no task list the refresh button is not offered')
  await assert.rejects(rig({ down: new Set(['/api/channels']) }).svc.read(true), /HTTP 500/)
})

test('not set up: an empty, unconfigured reading', async () => {
  const svc = new TunarrService({ client: async () => null, latest: async () => null, audit: async () => {}, now: () => NOW })
  const tv = await svc.read(true)
  assert.equal(tv.configured, false); assert.deepEqual(tv.channels, [])
  await assert.rejects(svc.act({ action: 'refresh-guide' }, 'a@example.com'), (e: any) => e instanceof TunarrRefusal && e.code === 'tunarr_not_set')
})

test('who is connected (address and player) is for admins; everyone else sees counts', async () => {
  const { svc } = rig()
  const admin = await svc.read(true)
  assert.equal(admin.channels[0].sessions[0].who[0].ip, '198.51.100.7'); assert.equal(admin.channels[0].sessions[0].who[0].agent, 'Example Player/1.0')
  const viewer = await svc.read(false)
  assert.equal(viewer.channels[0].viewers, 2); assert.doesNotMatch(JSON.stringify(viewer), /198\.51\.100|Example Player/)
  assert.equal(forViewer(admin).detail, false)
  // the memo holds the admin reading; a viewer's copy never mutates it
  assert.equal((await svc.read(true)).channels[0].sessions[0].who.length, 2)
})

test('now and next: the one on now, then the one after; between programmes only the next', () => {
  const p = [prog('A', 0, 10), prog('B', 10, 20), prog('C', 30, 40)]
  assert.deepEqual([nowAndNext(p, 5).now?.title, nowAndNext(p, 5).next?.title], ['A', 'B'])
  assert.deepEqual([nowAndNext(p, 25).now, nowAndNext(p, 25).next?.title], [null, 'C'])
  assert.deepEqual(nowAndNext(p, 50), { now: null, next: null })
  assert.deepEqual(nowAndNext('nope', 1), { now: null, next: null })
  assert.equal(nowAndNext([{ type: 'flex', start: 0, stop: 10 }], 5).now?.title, 'Off air')
})

test('the icon is fetched from the path Tunarr gave for that channel, never from the request', async () => {
  const { svc, f } = rig()
  assert.equal((await svc.icon(CH1))?.contentType, 'image/png')
  assert.ok(f.calls.includes('IMAGE /images/one.png'))
  assert.equal(await svc.icon(CH2), null, 'an outside address is not fetched')
  assert.equal(await svc.icon('../etc/passwd'), null)
  assert.equal(await svc.icon('dddddddd-4444-4444-8444-444444444444'), null)
})

// ── the fixes ─────────────────────────────────────────────────────────────────────────────────

test('refresh the guide: audited first, Tunarr\'s own task started, and the answer says it runs in the background', async () => {
  const { svc, f, audits } = rig()
  const r = await svc.act({ action: 'refresh-guide' }, 'admin@example.com')
  assert.equal(r.done, true); assert.match(r.summary, /accepted/); assert.match(r.notes.join(' '), /in the background/); assert.match(r.notes.join(' '), /shortest guide holds 10 hours/)
  assert.deepEqual(audits.map(a => a.action), ['arr.tunarr.refresh-guide']); assert.equal(audits[0].details.by, 'admin@example.com')
  assert.ok(f.calls.includes('POST /api/tasks/UpdateXmlTvTask/run'))
  assert.ok(f.calls.indexOf('GET /api/tasks') < f.calls.indexOf('POST /api/tasks/UpdateXmlTvTask/run'))
})

test('refresh the guide fails closed: no audit entry, nothing sent; an old Tunarr with no task is refused in words', async () => {
  const a = rig({}, { audit: async () => { throw new Error('log down') } })
  await assert.rejects(a.svc.act({ action: 'refresh-guide' }, 'admin@example.com'), /log down/)
  assert.ok(!a.f.calls.some(c => c.startsWith('POST')))
  const old = rig({ tasks: [] })
  await assert.rejects(old.svc.act({ action: 'refresh-guide' }, 'admin@example.com'), (e: any) => e.code === 'no_task' && /no guide task/.test(e.message))
  assert.equal(old.audits.length, 0)
})

test('stop a stuck stream: only where a session exists; audited first; read back', async () => {
  const { svc, f, audits } = rig()
  await svc.read(true)
  const r = await svc.act({ action: 'stop-session', channelId: CH1 }, 'admin@example.com')
  assert.equal(r.done, true); assert.match(r.summary, /stream on 1 Channel One was stopped/)
  assert.deepEqual(audits.map(a => a.action), ['arr.tunarr.stop-session'])
  assert.deepEqual([audits[0].details.channel, audits[0].details.viewers], [CH1, 2])
  assert.ok(f.calls.includes(`DELETE /api/channels/${CH1}/sessions`))
  await assert.rejects(svc.act({ action: 'stop-session', channelId: CH1 }, 'admin@example.com'), (e: any) => e.code === 'no_session')
  await assert.rejects(svc.act({ action: 'stop-session', channelId: 'x' }, 'admin@example.com'), (e: any) => e.code === 'bad_request')
  assert.equal(audits.length, 1)
})

test('stop a stuck stream: a session that is still listed afterwards is reported as not done; no audit, no delete', async () => {
  const { svc } = rig({ keepSessions: true })
  const r = await svc.act({ action: 'stop-session', channelId: CH1 }, 'admin@example.com')
  assert.equal(r.done, false); assert.match(r.summary, /still listed/)
  const closed = rig({}, { audit: async () => { throw new Error('log down') } })
  await assert.rejects(closed.svc.act({ action: 'stop-session', channelId: CH1 }, 'admin@example.com'), /log down/)
  assert.ok(!closed.f.calls.some(c => c.startsWith('DELETE')))
})

// ── roles and the routes through the real gate ────────────────────────────────────────────────

test('roles: the tab is a read; the fixes are admin, refused to API tokens and confirmed on the page; no master password', () => {
  assert.equal(requiredRole('GET', '/api/plugins/arrstack/tunarr'), 'viewer')
  assert.equal(requiredRole('GET', `/api/plugins/arrstack/tunarr/icon/${CH1}`), 'viewer')
  assert.equal(requiredRole('POST', '/api/plugins/arrstack/tunarr/actions'), 'admin')
  assert.equal(tokenForbidden('POST', '/api/plugins/arrstack/tunarr/actions'), true)
  assert.equal(tokenForbidden('GET', '/api/plugins/arrstack/tunarr'), false)
  assert.equal(needsPassword('POST', '/api/plugins/arrstack/tunarr/actions'), false)
  assert.equal(needsConfirm('POST', '/api/plugins/arrstack/tunarr/actions'), true)
  assert.equal(needsConfirm('GET', '/api/plugins/arrstack/tunarr'), false)
})

test('routes: a viewer sees counts only; fixes need an admin, a server-issued confirmation, never a token', async () => {
  const { svc, f, audits } = rig()
  const a = Fastify({ logger: false })
  await registerGate(a)
  await a.register(authRoutes, { prefix: '/api/auth' })
  await a.register(buildArrTunarrRoutes({ service: () => svc, limiter: new MissLimiter(50) }), { prefix: '/api/plugins/arrstack' })
  await a.ready()
  const url = '/api/plugins/arrstack/tunarr/actions'
  try {
    const viewer = await signIn(a, 'viewer@example.com', 'viewer master password')
    const v = await a.inject({ method: 'GET', url: '/api/plugins/arrstack/tunarr', headers: { cookie: viewer.cookie } })
    assert.equal(v.statusCode, 200, v.body); assert.doesNotMatch(v.body, /198\.51\.100|Example Player/); assert.equal(JSON.parse(v.body).data.channels.length, 2)
    const icon = await a.inject({ method: 'GET', url: `/api/plugins/arrstack/tunarr/icon/${CH1}`, headers: { cookie: viewer.cookie } })
    assert.equal(icon.statusCode, 200); assert.equal(icon.headers['content-type'], 'image/png')
    assert.equal((await a.inject({ method: 'GET', url: '/api/plugins/arrstack/tunarr/icon/..%2f..%2fx', headers: { cookie: viewer.cookie } })).statusCode, 400)
    assert.equal((await a.inject({ method: 'POST', url, headers: { cookie: viewer.cookie }, payload: { action: 'refresh-guide', confirmed: true } })).statusCode, 403)

    const tok = (await createApiToken({ name: 'bot', role: 'admin' }, 'test', tokens)).token
    const tp = await a.inject({ method: 'POST', url, headers: { authorization: `Bearer ${tok}` }, payload: { action: 'refresh-guide', confirmed: true } })
    assert.equal(tp.statusCode, 403); assert.equal(JSON.parse(tp.body).code, 'token_forbidden')
    const tg = await a.inject({ method: 'GET', url: '/api/plugins/arrstack/tunarr', headers: { authorization: `Bearer ${tok}` } })
    assert.doesNotMatch(tg.body, /198\.51\.100/, 'a token never sees who is connected')

    const adm = await signIn(a, 'admin@example.com', 'admin master password')
    const s = await a.inject({ method: 'GET', url: '/api/plugins/arrstack/tunarr', headers: { cookie: adm.cookie } })
    assert.match(s.body, /198\.51\.100\.7/)
    const post = (payload: any) => a.inject({ method: 'POST', url, headers: { cookie: adm.cookie }, payload })
    const ask = await post({ action: 'refresh-guide' })
    assert.equal(JSON.parse(ask.body).code, 'confirm_required')
    assert.match(JSON.parse(ask.body).confirm.summary, /^Rebuild Tunarr's TV guide now\?/)
    // the page's own flag is not a confirmation: only the server's single-use token is
    const flag = await post({ action: 'refresh-guide', confirmed: true })
    assert.equal(flag.statusCode, 403); assert.equal(JSON.parse(flag.body).code, 'confirm_required')
    assert.equal(JSON.parse((await post({ action: 'stop-session', channelId: CH1 })).body).confirm.summary, 'Stop the stream on channel 1 Channel One? Tunarr ends its ffmpeg, so anyone watching it is cut off until their player reconnects. Nothing is deleted.')
    assert.equal((await injectConfirmed(a, { method: 'POST', url, headers: { cookie: adm.cookie }, payload: { action: 'switch-channel' } })).statusCode, 400)
    assert.equal((await injectConfirmed(a, { method: 'POST', url, headers: { cookie: adm.cookie }, payload: { action: 'stop-session' } })).statusCode, 400)
    assert.equal((await injectConfirmed(a, { method: 'POST', url, headers: { cookie: adm.cookie }, payload: { action: 'refresh-guide', channelId: CH1 } })).statusCode, 400)
    assert.ok(!f.calls.some(c => c.startsWith('POST') || c.startsWith('DELETE')), 'nothing reached Tunarr before a confirmed, valid request')
    const done = await injectConfirmed(a, { method: 'POST', url, headers: { cookie: adm.cookie }, payload: { action: 'refresh-guide' } })
    assert.equal(done.statusCode, 200, done.body); assert.equal(JSON.parse(done.body).data.action, 'refresh-guide')
    assert.deepEqual(audits.map(x => x.action), ['arr.tunarr.refresh-guide'])
    const gone = await injectConfirmed(a, { method: 'POST', url, headers: { cookie: adm.cookie }, payload: { action: 'stop-session', channelId: CH1 } })
    assert.equal(gone.statusCode, 200, gone.body); assert.equal(JSON.parse(gone.body).data.done, true)
    const again = await injectConfirmed(a, { method: 'POST', url, headers: { cookie: adm.cookie }, payload: { action: 'stop-session', channelId: CH1 } })
    assert.equal(again.statusCode, 409); assert.equal(JSON.parse(again.body).code, 'no_session')
  } finally { await a.close() }
})

test('routes: no service yet answers 503 in words', async () => {
  const a = Fastify({ logger: false })
  await registerGate(a)
  await a.register(authRoutes, { prefix: '/api/auth' })
  await a.register(buildArrTunarrRoutes({ service: () => null }), { prefix: '/api/plugins/arrstack' })
  await a.ready()
  try {
    const viewer = await signIn(a, 'viewer@example.com', 'viewer master password')
    assert.equal((await a.inject({ method: 'GET', url: '/api/plugins/arrstack/tunarr', headers: { cookie: viewer.cookie } })).statusCode, 503)
  } finally { await a.close() }
})

// ── the plug-in's settings and the Updates provider ───────────────────────────────────────────

test('the plug-in declares an optional Tunarr address with no credential, and registers its update provider once', () => {
  const m = arrstackPlugin.manifest
  const s = m.settings.find(x => x.key === 'tunarr_url')!
  assert.equal(s.required, false); assert.equal(s.type, 'url')
  assert.ok(!m.settings.some(x => /^tunarr_(key|user|pass)/.test(x.key)), 'Tunarr has no key')
  const e = m.endpoints!.find(x => x.key === 'tunarr')!
  assert.equal(e.baseUrlSetting, 'tunarr_url'); assert.deepEqual(e.auth, { kind: 'none' })
  assert.ok(appUpdateProviders([arrstackPlugin]).some(p => p.pluginId === 'arrstack' && p.provider.id === 'tunarr'))
})

function guestCtx(o: { output?: string; releases?: any; fail?: boolean } = {}): AppContext {
  return {
    guest: { vmid: 100, name: 'media-guest', node: 'node-a', type: 'lxc' },
    run: async () => ({ code: 0, output: o.output ?? '', timedOut: false }),
    option: () => undefined,
    fetchJson: async () => { if (o.fail) throw new Error('rate limited'); return o.releases },
    http: async () => ({ status: 200, headers: {}, body: '' }), wsProbe: async () => ({ upgraded: false, status: 0, firstMessage: null }),
    proxiedUrls: async () => [], log: () => {}, now: () => NOW, sleep: async () => {},
  }
}
const RELEASES = [
  { tag_name: 'v2026.12.0-rc1', prerelease: true, body: 'rc' },
  { tag_name: 'v2026.11.2', body: 'Fixes the guide.', html_url: 'https://github.com/example/example/releases/tag/v2026.11.2' },
  { tag_name: 'v2026.11.1', body: 'older' },
  { tag_name: 'v2026.10.0', draft: true, body: 'draft' },
]

test('provider: finds Tunarr in a guest\'s Docker (one install per container), reading only', async () => {
  assert.match(DETECT_SCRIPT, /docker ps/); assert.doesNotMatch(DETECT_SCRIPT, /docker (pull|restart|stop|rm|run|exec|compose)/)
  const out = [
    '@@tunarr tunarr|chrisbenincasa/tunarr:latest|media|2026.11.1',
    '@@tunarr ../evil|chrisbenincasa/tunarr:latest||2026.11.1',
    '@@tunarr other|example/other:latest||1.0.0',
    '@@tunarr ok2|chrisbenincasa/tunarr:2026.11.1|stack b|2026.11.1',
    'noise',
  ].join('\n')
  assert.deepEqual(parseDetect(out).map(f => f.name), ['tunarr', 'ok2'])
  const installs = await tunarrProvider.detect(guestCtx({ output: out }))
  assert.equal(installs.length, 2)
  assert.notEqual(installs[0].key, installs[1].key)
  assert.equal(installs[0].installed, '2026.11.1'); assert.equal(installs[0].service, null); assert.match(installs[0].key, /^[a-f0-9]{12}$/)
  assert.equal(imageTag('chrisbenincasa/tunarr'), 'latest'); assert.equal(imageTag('chrisbenincasa/tunarr:2026.11.1'), '2026.11.1')
})

test('provider: newest stable release and the notes since the installed one (drafts and pre-releases ignored)', async () => {
  const install = (await tunarrProvider.detect(guestCtx({ output: '@@tunarr tunarr|chrisbenincasa/tunarr:latest||2026.11.1' })))[0]
  const rel = await tunarrProvider.latest(install, guestCtx({ releases: RELEASES }))
  assert.equal(rel.latest, '2026.11.2'); assert.deepEqual(rel.notes.map(n => n.version), ['2026.11.2']); assert.equal(rel.isSecurity, false)
  await assert.rejects(tunarrProvider.latest(install, guestCtx({ fail: true })), /rate limited/)
})

test('provider: behind means a blocking issue that sends the update through the guest\'s Docker path; nothing is applied here', async () => {
  const [latestInstall] = await tunarrProvider.detect(guestCtx({ output: '@@tunarr tunarr|chrisbenincasa/tunarr:latest||2026.11.1' }))
  const ctx = guestCtx()
  const behind = await tunarrProvider.preflight(latestInstall, '2026.11.2', ctx)
  assert.equal(behind.length, 1); assert.equal(behind[0].blocking, true); assert.match(behind[0].message, /does not update Tunarr itself.*Docker update/)
  assert.equal((await tunarrProvider.preflight(latestInstall, null, ctx)).length, 0, 'current: no issue')
  const [pinned] = await tunarrProvider.detect(guestCtx({ output: '@@tunarr tunarr|chrisbenincasa/tunarr:2026.11.1||2026.11.1' }))
  assert.match((await tunarrProvider.preflight(pinned, '2026.11.2', ctx))[0].message, /pins the image tag "2026\.11\.1".*edit the tag/)
  const [noVersion] = await tunarrProvider.detect(guestCtx({ output: '@@tunarr tunarr|chrisbenincasa/tunarr:latest||' }))
  assert.ok((await tunarrProvider.preflight(noVersion, null, ctx)).some(i => /did not report its version/.test(i.message)))
  assert.equal((await tunarrProvider.apply(latestInstall, '2026.11.2', ctx)).ok, false)
  assert.equal((await tunarrProvider.verify(latestInstall, '2026.11.2', ctx, null)).ok, false)
  assert.match(tunarrProvider.rollback(latestInstall, null), /Nothing here changes Tunarr/)
})

test('the newest release is the GitHub tag, and a failure is "unknown", never an error', async () => {
  assert.equal(await latestTunarr(async () => ({ tag_name: 'v2026.11.2' })), 'v2026.11.2')
  assert.equal(await latestTunarr(async () => { throw new Error('offline') }), null)
  assert.equal(await latestTunarr(async () => ({})), null)
  assert.equal(buildLiveTv({ now: NOW, latest: 'v2026.11.2' }, true).version.behind, null)
})
