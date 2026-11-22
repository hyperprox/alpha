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
import { GUIDE_MIN_HOURS, buildLiveTv, ffmpegShort, forViewer, guideHoursOf, nowAndNext, programOf, readinessOf, offLibraries, splitVersion, versionState } from '../src/lib/arr-tunarr/logic'
import { TunarrRefusal, TunarrService, type TunarrDeps } from '../src/lib/arr-tunarr/service'
import { makeLatestTunarr } from '../src/lib/arr-tunarr/production'
import { DETECT_SCRIPT, imageTag, parseDetect, tunarrProvider } from '../src/lib/arr-tunarr/provider'
import { arrstackPlugin } from '../src/plugins/arrstack'
import { appUpdateProviders, saveSettings, webAddressProblem, PluginSettingsError, type AppContext, type CoreEndpointClient } from '../src/lib/plugin-host'
import fs from 'node:fs'
import path from 'node:path'
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
  /** Paths whose request never resolves (a hung Tunarr). */
  hang: Set<string>; delayMs: Record<string, number>
  /** 0.12's task list, answered at /api/jobs. */
  jobs?: any[]
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
    tasks: [{ id: 'UpdateXmlTvTask', name: 'UpdateXmlTvTask' }], down: new Set(), calls: [], keepSessions: false, hang: new Set(), delayMs: {}, ...o,
  }
  const get = async (path: string): Promise<any> => {
    const u = new URL(path, 'http://tunarr.invalid')
    f.calls.push(`GET ${u.pathname}`)
    if (f.down.has(u.pathname)) throw new Error('Arr Stack returned HTTP 500')
    if (f.hang.has(u.pathname)) return new Promise(() => {})
    if (f.delayMs[u.pathname]) await new Promise(r => setTimeout(r, f.delayMs[u.pathname]))
    if (u.pathname === '/api/channels') return f.channels
    if (u.pathname === '/api/version') return { tunarr: f.version, ffmpeg: "7.1" }
    if (u.pathname === '/api/guide/status') return { guideTimes: Object.fromEntries(Object.entries(f.guideEnd).map(([k, v]) => [k, { start: new Date(NOW).toISOString(), end: new Date(v).toISOString() }])) }
    if (u.pathname === '/api/guide/channels') return Object.fromEntries(Object.entries(f.programs).map(([k, v]) => [k, { id: k, programs: v }]))
    if (u.pathname === '/api/sessions') return f.sessions
    if (u.pathname === '/api/system/health') return f.health
    if (u.pathname === '/api/media-sources') return f.sources.map(s => ({ id: s.id, name: s.name, type: s.type, uri: 'http://198.51.100.50:32400' }))
    const m = /^\/api\/media-sources\/([^/]+)\/status$/.exec(u.pathname)
    if (m) { const s = f.sources.find(x => x.id === m[1]); if (!s || s.healthy === null) throw new Error('timeout'); return s.healthy ? { healthy: true } : { healthy: false, status: 'unreachable' } }
    if (u.pathname === '/api/tasks') return f.tasks
    if (u.pathname === '/api/jobs' && f.jobs) return f.jobs
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
  const { svc } = rig({ down: new Set(['/api/guide/status', '/api/guide/channels', '/api/sessions', '/api/version', '/api/media-sources', '/api/tasks', '/api/jobs']) })
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
  assert.equal(nowAndNext([{ type: 'flex', start: 0, stop: 10 }], 5).now?.title, 'Break')
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

test('the newest release is the GitHub tag; a failure is "unknown" and is not asked again for ten minutes', async () => {
  assert.equal(await makeLatestTunarr(async () => ({ tag_name: 'v2026.11.2' }))(), 'v2026.11.2')
  assert.equal(await makeLatestTunarr(async () => ({}))(), null)
  let t = NOW, calls = 0
  const latest = makeLatestTunarr(async () => { calls++; throw new Error('offline') }, () => t)
  assert.equal(await latest(), null); assert.equal(await latest(), null); assert.equal(calls, 1)
  t += 9 * 60_000; await latest(); assert.equal(calls, 1)
  t += 2 * 60_000; await latest(); assert.equal(calls, 2)
  assert.equal(buildLiveTv({ now: NOW, latest: 'v2026.11.2' }, true).version.behind, null)
})

// ── a hung or slow Tunarr, shared and cached readings ─────────────────────────────────────────

const count = (f: Fake, p: string) => f.calls.filter(c => c === `GET ${p}`).length

test('a Tunarr that never answers: the reading gives up at its deadline with a plain error, and the failure is cached for 15 s', async () => {
  const { svc, f, setNow } = rig({ hang: new Set(['/api/channels']) }, { deadlineMs: 150 })
  const t0 = Date.now()
  await assert.rejects(svc.read(true), (e: any) => e.code === 'tunarr_slow' && /did not answer in time/.test(e.message))
  assert.ok(Date.now() - t0 < 1500, 'returned within the deadline')
  assert.equal(count(f, '/api/channels'), 1)
  await assert.rejects(svc.read(true), (e: any) => e.code === 'tunarr_slow'); assert.equal(count(f, '/api/channels'), 1, 'cached failure: no second call')
  setNow(NOW + 16_000)
  f.hang.clear()
  assert.equal((await svc.read(true)).channels.length, 2); assert.equal(count(f, '/api/channels'), 2, 'after 15 s it looks again')
})

test('parts that hang are "unknown" under ONE overall deadline: three slow media sources do not add up', async () => {
  const sources = [1, 2, 3].map(i => ({ id: `s${i}`, name: `Source ${i}`, type: 'plex', healthy: true }))
  const { svc } = rig({ sources, hang: new Set(['/api/media-sources/s1/status', '/api/media-sources/s2/status', '/api/media-sources/s3/status', '/api/system/health', '/api/guide/status']) }, { deadlineMs: 300 })
  const t0 = Date.now()
  const tv = await svc.read(true)
  const took = Date.now() - t0
  assert.ok(took < 1500, `one deadline, not three in a row (took ${took} ms)`)
  assert.deepEqual(tv.sources.map(x => x.state), ['unknown', 'unknown', 'unknown'])
  assert.equal(tv.channels.length, 2)
})

test('everything but the channel list hanging still gives the channels', async () => {
  const hang = new Set(['/api/version', '/api/guide/status', '/api/guide/channels', '/api/sessions', '/api/system/health', '/api/media-sources', '/api/jobs', '/api/tasks'])
  const { svc } = rig({ hang }, { deadlineMs: 200, latest: () => new Promise(() => {}) })
  const tv = await svc.read(true)
  assert.equal(tv.channels.length, 2); assert.equal(tv.version.installed, null); assert.equal(tv.channels[0].now, null)
})

test('many callers at once make one upstream reading', async () => {
  const { svc, f } = rig({ delayMs: { '/api/channels': 60 } })
  const all = await Promise.all(Array.from({ length: 12 }, (_, i) => svc.read(i % 2 === 0)))
  assert.equal(all.length, 12); assert.equal(count(f, '/api/channels'), 1); assert.equal(count(f, '/api/sessions'), 1); assert.equal(count(f, '/api/version'), 1)
  await svc.read(true); assert.equal(count(f, '/api/channels'), 1, 'the 20 s memo still holds')
  const bad = rig({ down: new Set(['/api/channels']), delayMs: { '/api/channels': 30 } })
  const settled = await Promise.allSettled(Array.from({ length: 8 }, () => bad.svc.read(true)))
  assert.ok(settled.every(x => x.status === 'rejected')); assert.equal(count(bad.f, '/api/channels'), 1, 'one failing call serves every waiter')
})

test('icons for an unknown id never start another reading; with nothing read yet they share the one in flight', async () => {
  const { svc, f } = rig({ delayMs: { '/api/channels': 40 } })
  const [a, b, c] = await Promise.all([svc.icon(CH1), svc.icon('eeeeeeee-5555-4555-8555-555555555555'), svc.read(true)])
  assert.equal(a?.contentType, 'image/png'); assert.equal(b, null); assert.ok(c)
  assert.equal(count(f, '/api/channels'), 1)
  for (let i = 0; i < 20; i++) assert.equal(await svc.icon(`ffffffff-0000-4000-8000-${String(i).padStart(12, '0')}`), null)
  assert.equal(count(f, '/api/channels'), 1, 'unknown ids cost nothing')
  const dead = rig({ down: new Set(['/api/channels']) })
  assert.equal(await dead.svc.icon(CH1), null); assert.equal(await dead.svc.icon(CH1), null); assert.equal(count(dead.f, '/api/channels'), 1)
})

// ── Tunarr 0.12.2's real shapes (sanitized fixtures, recorded read-only) ──────────────────────

const fx = (n: string) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'arr-tunarr', n), 'utf8'))

test('Tunarr 0.12.2: no guideTimes in the status, so guide hours come from the guide itself; tasks are /api/jobs (update-xmltv)', async () => {
  const channels = fx('channels-0.12.2.json'), guide = fx('guide-channels-0.12.2.json'), status = fx('guide-status-0.12.2.json'), jobs = fx('jobs-0.12.2.json')
  assert.deepEqual(Object.keys(status).sort(), ['channelIds', 'lastUpdate'])
  const now = 1795342974790
  const tv = buildLiveTv({ now, channels, guideStatus: status, guide, version: fx('version-0.12.2.json'), tasks: jobs, latest: 'v2026.11.2', sessions: {} }, true)
  assert.deepEqual(tv.channels.map(c => [c.number, c.programCount, c.guideHours, c.guideShort]), [[1, 7, 40, false], [2, 250, 10, true]])
  assert.equal(tv.channels[0].now?.title, 'Example Film A'); assert.equal(tv.channels[0].next?.title, 'Example Film B')
  assert.equal(tv.channels[1].hasIcon, true); assert.equal(tv.channels[0].hasIcon, false)
  assert.equal(tv.actions.refreshGuide, true); assert.equal(tv.version.installed, '0.12.2'); assert.equal(tv.version.behind, true)
  assert.ok(!tv.warnings.some(w => /did not report how much guide/.test(w.text)))
  // a guide that reaches past the window reads as the window, not more
  const far = buildLiveTv({ now: now - 100 * 3_600_000, channels, guide, guideStatus: status, sessions: {} }, true)
  assert.equal(far.channels[0].guideHours, 48)
  // nothing to derive from: said plainly
  assert.ok(buildLiveTv({ now, channels, guideStatus: status, sessions: {} }, true).warnings.some(w => /did not report how much guide/.test(w.text)))
})

test('Tunarr 0.12.2: Refresh guide runs /api/jobs/update-xmltv/run; one with neither list is refused in words', async () => {
  const old = rig({ down: new Set(['/api/tasks']), jobs: fx('jobs-0.12.2.json') })
  const tv = await old.svc.read(true)
  assert.equal(tv.actions.refreshGuide, true)
  const r = await old.svc.act({ action: 'refresh-guide' }, 'admin@example.com')
  assert.equal(r.done, true); assert.ok(old.f.calls.includes('POST /api/jobs/update-xmltv/run')); assert.deepEqual(old.audits.map(a => a.action), ['arr.tunarr.refresh-guide'])
  const none = rig({ tasks: [], down: new Set(['/api/jobs']) })
  await assert.rejects(none.svc.act({ action: 'refresh-guide' }, 'a@example.com'), (e: any) => e.code === 'no_task')
})

// ── the address setting ───────────────────────────────────────────────────────────────────────

test('the Tunarr address must be http(s) with no login in it; empty clears it', async () => {
  assert.equal(webAddressProblem('Tunarr address', ''), null)
  assert.equal(webAddressProblem('Tunarr address', 'http://example-host:8000'), null)
  assert.equal(webAddressProblem('Tunarr address', 'https://tv.example.org/'), null)
  assert.match(webAddressProblem('Tunarr address', 'ftp://example-host')!, /must start with http:\/\/ or https:\/\//)
  assert.match(webAddressProblem('Tunarr address', 'http://user:pw@example-host:8000')!, /must not have a user name or password/)
  assert.match(webAddressProblem('Tunarr address', 'example-host:8000')!, /http|full web address/)
  assert.match(webAddressProblem('Tunarr address', 'not a url')!, /full web address/)
  for (const bad of ['javascript:alert(1)', 'http://u@example-host', 'file:///etc/passwd']) {
    await assert.rejects(saveSettings(arrstackPlugin.manifest, { tunarr_url: bad }), (e: any) => e instanceof PluginSettingsError && /Tunarr address/.test(e.message), bad)
  }
})

// ── Tunarr 2026.11: titles live under `program` ───────────────────────────────────────────────

test('Tunarr 2026.11: the show and the episode name come from the nested program; a film is its title; a break is a break', () => {
  const guide = fx('guide-channels-2026.11.2.json'), channels = fx('channels-2026.11.2.json')
  const now = 1795342974790
  const tv = buildLiveTv({ now, channels, guide, version: { tunarr: '2026.11.2', ffmpeg: 'n7.1-214-g71889a8437-20250228' }, sources: [{ source: fx('media-sources-2026.11.2.json')[0], status: { healthy: true } }], sessions: {} }, true)
  const [a, b] = tv.channels
  assert.deepEqual([a.now?.title, a.now?.episode, a.now?.code, a.now?.kind], ['Example Heroes: The Animated Series', 'Frozen Heart', 'S2E20', 'episode'])
  // the 20 s break between episodes is not "next"
  assert.deepEqual([a.next?.title, a.next?.episode, a.next?.code], ['Example Heroes: The Animated Series', 'Night Watch', 'S2E21'])
  assert.deepEqual([b.now?.title, b.now?.episode, b.now?.code, b.now?.kind], ['Moon Garden', null, null, 'movie'])
  assert.ok(!JSON.stringify(tv.channels.map(c => [c.now, c.next])).includes('Untitled'))
  assert.equal(a.group, 'Kids')
  // the break itself, when it is what is on
  assert.deepEqual([programOf({ type: 'flex', start: 0, stop: 5, program: {} })?.title, programOf({ type: 'flex', start: 0, stop: 5, program: {} })?.kind], ['Break', 'break'])
})

test('old shape still reads: title and subtitle on the row itself', () => {
  assert.deepEqual(programOf({ type: 'content', title: 'Evening News', subtitle: 'Monday', start: 0, stop: 3_600_000 }), { title: 'Evening News', episode: 'Monday', code: null, kind: 'episode', at: new Date(0).toISOString(), until: new Date(3_600_000).toISOString() })
  assert.equal(programOf({ type: 'content', start: 0, stop: 1 })?.title, 'Untitled')
  assert.equal(programOf({ type: 'content', title: 'x' }), null)
})

test('readiness: programmes from a library Tunarr has switched off, or marked missing, are not in step; the share is per channel', () => {
  const guide = fx('guide-channels-2026.11.2.json'), channels = fx('channels-2026.11.2.json')
  const src = [{ source: fx('media-sources-2026.11.2.json')[0], status: { healthy: true } }]
  assert.deepEqual([...offLibraries(src)], ['33333333-cccc-4ccc-8ccc-333333333333'])
  const tv = buildLiveTv({ now: 1795342974790, channels, guide, sources: src, sessions: {} }, true)
  assert.deepEqual(tv.channels[0].ready, { programmes: 2, synced: 2, pct: 100 })
  assert.deepEqual(tv.channels[1].ready, { programmes: 3, synced: 1, pct: 33 })
  assert.deepEqual([tv.summary.synced, tv.summary.unsynced, tv.summary.unsyncedProgrammes], [1, 1, 2])
  const w = tv.warnings.find(x => /not keeping in step/.test(x.text))!
  assert.equal(w.level, 'warning'); assert.match(w.text, /Channel 2 Sample Movies has programmes/); assert.match(w.text, /\(2 in the next 48 h of guide\)/)
  // with no media-source list nothing is called off; a missing state alone still counts
  assert.equal(buildLiveTv({ now: 1795342974790, channels, guide, sessions: {} }, true).channels[1].ready?.synced, 2)
  // the old shape has no details to judge: no claim either way
  assert.equal(readinessOf([{ type: 'content', title: 'x', start: 0, stop: 1 }], new Set()), null)
  assert.equal(readinessOf([{ type: 'flex', start: 0, stop: 1, program: {} }], new Set()), null)
  assert.equal(readinessOf('nope', new Set()), null)
})

test('ffmpeg is shown short: the number, never the build string', () => {
  assert.equal(ffmpegShort('n7.1-214-g71889a8437-20250228'), '7.1')
  assert.equal(ffmpegShort('7.1'), '7.1'); assert.equal(ffmpegShort('6.0.1-static'), '6.0.1'); assert.equal(ffmpegShort('ffmpeg version 5.1.2-3'), '5.1.2')
  assert.equal(ffmpegShort('git-2025-02-28-abcdef'), 'custom build'); assert.equal(ffmpegShort(''), null); assert.equal(ffmpegShort(undefined), null)
  assert.equal(versionState('2026.11.2', '2026.11.2', 'n7.1-214-g71889a8437-20250228').ffmpeg, '7.1')
})

test('health is read live: a warning goes when Tunarr stops reporting it', async () => {
  const bad = { FfmpegVersion: { type: 'warning', context: 'ffprobe is missing' } }
  const { f, svc, setNow } = rig({ health: bad })
  assert.ok((await svc.read(true)).warnings.some(w => /Tunarr reports: FfmpegVersion/.test(w.text)))
  f.health = { FfmpegVersion: { type: 'healthy' } }
  setNow(NOW + 60_000)
  assert.ok(!(await svc.read(true)).warnings.some(w => /Tunarr reports/.test(w.text)))
})
