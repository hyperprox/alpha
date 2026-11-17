// Arr Stack VPN (Gluetun) panel: reading Gluetun and qBittorrent inside the stack's guest (the VPN login never read),
// what it means (tunnel up or down, forwarded port against qBittorrent's listening port, qBittorrent left on a dead
// network), the public address for admins only, the fixes (audited first, read back), and the alert that waits ten
// minutes and says the all-clear once. The answers are recorded shapes, addresses in documentation ranges.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import Fastify from 'fastify'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { requiredRole, needsConfirm, needsPassword } from '../src/lib/roles'
import { injectConfirmed } from './fakes/confirm'
import { buildArrVpnRoutes } from '../src/routes/arr-vpn'
import { ALERT_AFTER_MS, READ_SCRIPT, alertStep, emptyAlertState, forViewer, parseReading, vpnStatus } from '../src/lib/arr-vpn/parse'
import { RECONNECT_SCRIPT, VpnRefusal, VpnService, setPortScript, type VpnDeps } from '../src/lib/arr-vpn/service'
import { hostOf, lxcAddresses, matchingGuests } from '../src/lib/arr-vpn/production'
import type { CoreEndpointClient } from '../src/lib/plugin-host'
import { signIn } from './fakes/app'
import { FakeBroker } from './fakes/fake-broker'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { setAuditSink } from '../src/lib/audit'
import { MemoryApiTokenStore, setApiTokenStore, createApiToken, tokenForbidden } from '../src/lib/api-tokens'
import { MissLimiter } from '../src/lib/plex-art'

const FIX = path.join(__dirname, 'fixtures', 'arr-vpn')
const raw = (n: string) => fs.readFileSync(path.join(FIX, n), 'utf8')
const NOW = Date.parse('2026-11-16T12:00:00Z')
const GLUETUN_ID = '0f'.repeat(32)

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

const b64 = (s: string) => Buffer.from(s).toString('base64')
interface Shape { state?: string; env?: string; qbit?: string; port?: string; ipfile?: string; vpnstatus?: string; publicip?: string; pf?: string; listen?: string; transfer?: string }
/** What READ_SCRIPT prints, built the way it builds it. */
function printed(o: Shape = {}): string {
  const v: Required<Shape> = {
    state: `running|healthy|2026-11-14T17:33:21.992101111Z|0|${GLUETUN_ID}`,
    env: 'VPN_SERVICE_PROVIDER=example vpn\nVPN_TYPE=openvpn\nVPN_PORT_FORWARDING=on\nSERVER_REGIONS=Netherlands',
    qbit: `running|2026-11-14T17:34:02.000000000Z|container:${GLUETUN_ID}`,
    port: '40123', ipfile: '198.51.100.23', vpnstatus: raw('vpn-status.json'), publicip: raw('publicip.json'), pf: raw('portforward.json'),
    listen: '"listen_port":40123', transfer: raw('transfer.json'), ...o,
  }
  return Object.entries(v).map(([k, x]) => `@@${k} ${b64(x)}`).join('\n') + '\n@@end\n'
}

// ── reading ─────────────────────────────────────────────────────────────────

test('a healthy tunnel: where it comes out, the forwarded port matching qBittorrent, speeds and uptime; no problems', () => {
  const s = vpnStatus(parseReading(printed()), NOW, { guest: 'arr-stack' })
  assert.equal(s.present, true); assert.equal(s.tunnel, 'up'); assert.equal(s.health, 'healthy')
  assert.equal(s.provider, 'example vpn'); assert.equal(s.vpnType, 'OpenVPN'); assert.equal(s.chosen, 'Netherlands')
  assert.equal(s.location, 'Amsterdam, North Holland, Netherlands'); assert.equal(s.publicIp, '198.51.100.23')
  assert.equal(s.forwardedPort, 40123); assert.equal(s.listenPort, 40123); assert.equal(s.portMatch, 'ok')
  assert.equal(s.downBps, 10625762); assert.equal(s.upBps, 1722791); assert.equal(s.connection, 'connected')
  assert.equal(s.uptimeSec, Math.round((NOW - Date.parse('2026-11-14T17:33:21.992Z')) / 1000))
  assert.deepEqual(s.problems, [])
})

test('the VPN login is never read: settings are filtered in the guest and again here', () => {
  assert.match(READ_SCRIPT, /grep -E '\^\(VPN_SERVICE_PROVIDER\|VPN_TYPE\|VPN_PORT_FORWARDING\|SERVER_COUNTRIES\|SERVER_REGIONS\|SERVER_CITIES\)='/)
  assert.doesNotMatch(READ_SCRIPT, /OPENVPN_PASSWORD|WIREGUARD_PRIVATE_KEY|\.env/)
  const r = parseReading(printed({ env: 'VPN_TYPE=wireguard\nWIREGUARD_PRIVATE_KEY=c2VjcmV0LWtleQ==\nOPENVPN_PASSWORD=not-a-real-one' }))
  assert.deepEqual(Object.keys(r.env), ['VPN_TYPE'])
  assert.doesNotMatch(JSON.stringify(vpnStatus(r, NOW)), /c2VjcmV0|not-a-real-one/)
})

test('the forwarded port differs from qBittorrent\'s: a problem whose fix puts the port in; the plug-in\'s own reading wins', () => {
  const s = vpnStatus(parseReading(printed({ listen: '"listen_port":6881' })), NOW)
  assert.equal(s.portMatch, 'mismatch')
  assert.deepEqual(s.problems.map(p => [p.code, p.fix]), [['mismatch', 'set-port']])
  assert.match(s.problems[0].text, /forwards port 40123, but qBittorrent listens on 6881/)
  const viaPlugin = vpnStatus(parseReading(printed({ listen: '' })), NOW, { prefs: { listen_port: 40123 } })
  assert.equal(viaPlugin.portMatch, 'ok')
  // The status file is read first; the control server's answer only when the file is empty.
  assert.equal(vpnStatus(parseReading(printed({ port: '' })), NOW).forwardedPort, 40123)
  const none = vpnStatus(parseReading(printed({ port: '', pf: '{"port":0}' })), NOW)
  assert.deepEqual(none.problems.map(p => [p.code, p.fix]), [['no-port', 'reconnect']])
  const off = vpnStatus(parseReading(printed({ env: 'VPN_TYPE=wireguard', port: '' })), NOW)
  assert.equal(off.portMatch, 'off'); assert.deepEqual(off.problems, [])
})

test('the tunnel down: no address shown, the fix is reconnect; a stopped container says so', () => {
  const s = vpnStatus(parseReading(printed({ vpnstatus: '{"status":"stopped"}' })), NOW)
  assert.equal(s.tunnel, 'down'); assert.equal(s.publicIp, null); assert.equal(s.location, null)
  assert.deepEqual(s.problems.map(p => [p.code, p.fix]), [['down', 'reconnect']], 'a port problem is not piled on top')
  const exited = vpnStatus(parseReading(`@@state ${b64(`exited||2026-11-14T17:33:21Z|3|${GLUETUN_ID}`)}\n@@env ${b64('VPN_TYPE=openvpn')}\n@@end\n`), NOW)
  assert.equal(exited.tunnel, 'down'); assert.match(exited.problems[0].text, /VPN container is exited/)
  const unhealthy = vpnStatus(parseReading(printed({ state: `running|unhealthy|2026-11-14T17:33:21Z|0|${GLUETUN_ID}`, vpnstatus: '' })), NOW)
  assert.equal(unhealthy.tunnel, 'down')
  // The control server unreadable (a later Gluetun that wants a key): the health check decides.
  assert.equal(vpnStatus(parseReading(printed({ vpnstatus: '', publicip: '' })), NOW).tunnel, 'up')
})

test('qBittorrent left on a dead network after Gluetun restarted, or not behind the VPN at all', () => {
  const stale = vpnStatus(parseReading(printed({ qbit: `running|2026-11-13T09:00:00Z|container:${GLUETUN_ID}` })), NOW)
  assert.deepEqual(stale.problems.map(p => [p.code, p.fix]), [['qbit-stale', 'restart-qbit']])
  const open = vpnStatus(parseReading(printed({ qbit: 'running|2026-11-14T17:34:02Z|bridge' })), NOW)
  assert.equal(open.problems[0].code, 'not-behind'); assert.equal(open.problems[0].fix, undefined, 'the compose file is the person\'s to change')
})

test('no Gluetun in this stack, or no Docker: nothing offered', () => {
  assert.equal(vpnStatus(parseReading('@@nogluetun\n'), NOW).present, false)
  const nd = vpnStatus(parseReading('@@nodocker\n'), NOW)
  assert.equal(nd.present, false); assert.match(nd.unavailable!, /Docker is not installed/)
})

test('a viewer never sees the public address', () => {
  const s = vpnStatus(parseReading(printed()), NOW)
  const v = forViewer(s)
  assert.equal(v.publicIp, null); assert.equal(v.publicIpHidden, true); assert.equal(v.location, s.location)
})

test('addresses: a saved URL\'s host, a container\'s own addresses from its config', () => {
  assert.equal(hostOf('http://192.0.2.40:8080'), '192.0.2.40'); assert.equal(hostOf('not a url'), null); assert.equal(hostOf(undefined), null)
  assert.deepEqual(lxcAddresses({ net0: 'name=eth0,bridge=vmbr0,gw=192.0.2.1,hwaddr=00:00:5E:00:53:01,ip=192.0.2.40/24,type=veth', net1: 'name=eth1,ip=dhcp', hostname: 'x' }), ['192.0.2.40'])
})

// ── the alert ───────────────────────────────────────────────────────────────

test('alert: only after ten minutes, once; one all-clear; a problem that clears before ten minutes says nothing', () => {
  const down = [{ code: 'down' as const, text: 'x', fix: 'reconnect' as const }]
  let st = emptyAlertState()
  let r = alertStep(st, down, NOW); st = r.state
  assert.deepEqual([r.fire.length, r.clear.length], [0, 0])
  r = alertStep(st, down, NOW + ALERT_AFTER_MS - 1); st = r.state
  assert.equal(r.fire.length, 0)
  r = alertStep(st, down, NOW + ALERT_AFTER_MS); st = r.state
  assert.deepEqual(r.fire.map(p => p.code), ['down'])
  r = alertStep(st, down, NOW + 2 * ALERT_AFTER_MS); st = r.state
  assert.equal(r.fire.length, 0, 'said once')
  r = alertStep(st, [], NOW + 3 * ALERT_AFTER_MS); st = r.state
  assert.deepEqual(r.clear, ['down'])
  r = alertStep(st, [], NOW + 4 * ALERT_AFTER_MS)
  assert.deepEqual(r.clear, [])
  // Short blips never alert, and the clock starts again each time.
  let s2 = alertStep(emptyAlertState(), down, NOW).state
  s2 = alertStep(s2, [], NOW + 5 * 60_000).state
  assert.equal(alertStep(s2, down, NOW + 11 * 60_000).fire.length, 0)
  // Problems that do not alert: qBittorrent firewalled, stale.
  assert.equal(alertStep(emptyAlertState(), [{ code: 'qbit-stale', text: 'x' }], NOW).state.since['qbit-stale'], undefined)
})

// ── the service ─────────────────────────────────────────────────────────────

function rig(o: { reading?: () => string; qbit?: CoreEndpointClient | null } & Partial<VpnDeps> = {}) {
  let now = NOW
  const scripts: string[] = []
  const audits: Array<{ action: string; details: any }> = []
  const sent: any[] = []
  const { reading: firstReading, qbit: qbitClient, ...rest } = o
  let reading = firstReading ?? (() => printed())
  const svc = new VpnService({
    locate: async () => ({ guest: { type: 'lxc', vmid: 9101 }, name: 'arr-stack', qbitProven: true }),
    exec: async (_g, script) => { scripts.push(script); return { code: 0, output: script === READ_SCRIPT ? reading() : script === RECONNECT_SCRIPT ? '@@via restart 401 none\n@@after running|healthy\n' : '@@restarted\n', timedOut: false } },
    qbit: async () => qbitClient ?? null,
    audit: async (action, details) => { audits.push({ action, details }) },
    publish: async e => { sent.push(e) },
    now: () => now, unlocked: () => true, ...rest,
  })
  return { svc, scripts, audits, sent, setNow: (t: number) => { now = t }, setReading: (f: () => string) => { reading = f } }
}

test('put the forwarded port into qBittorrent: audited first, from inside the VPN\'s network first, then the plug-in\'s proven connection, read back', async () => {
  let listen = 6881
  const calls: any[] = []
  const qb: CoreEndpointClient = {
    get: async (p: string) => (p === '/api/v2/app/preferences' ? { listen_port: listen } : JSON.parse(raw('transfer.json'))),
    postForm: async (p: string, f: Record<string, string>) => { calls.push({ p, f }); listen = JSON.parse(f.json).listen_port; return null },
    delete: async () => null, put: async () => null, image: async () => { throw new Error('no') }, trigger: async () => {},
  }
  const { svc, audits, scripts } = rig({ qbit: qb })
  const r = await svc.act('set-port', 'admin@example.com')
  assert.equal(r.done, true, r.summary); assert.match(r.summary, /now listens on 40123/)
  assert.ok(scripts.includes(setPortScript(40123)), 'the qBittorrent behind this Gluetun is asked first')
  assert.deepEqual(calls, [{ p: '/api/v2/app/setPreferences', f: { json: '{"listen_port":40123}' } }])
  assert.deepEqual(audits.map(a => a.action), ['arrstack.vpn.fix', 'arrstack.vpn.fix.done'])
  assert.equal(audits[0].details.port, 40123); assert.equal(audits[0].details.was, 6881)
  await assert.rejects(svc.act('set-port', 'admin@example.com'), (e: any) => e.code === 'already')
})

test('without the plug-in\'s qBittorrent connection the port goes in from inside the VPN\'s network; a bad port is never sent', async () => {
  let listen = 6881
  const { svc, scripts } = rig({ reading: () => printed({ listen: `"listen_port":${listen}` }) })
  const origExec = (svc as any).d.exec
  ;(svc as any).d.exec = async (g: any, s: string, t: number) => { if (s.includes('setPreferences')) { listen = 40123; return { code: 0, output: '@@set\n', timedOut: false } } return origExec(g, s, t) }
  const r = await svc.act('set-port', 'admin@example.com')
  assert.equal(r.done, true)
  assert.equal(setPortScript(40123).includes(`'json={"listen_port":40123}'`), true)
  assert.throws(() => setPortScript(70000)); assert.throws(() => setPortScript(Number.NaN))
  void scripts
})

test('ports: only 1024 to 65535 count; a lower one is never read as forwarded, nor sent', () => {
  assert.throws(() => setPortScript(80)); assert.throws(() => setPortScript(1023)); assert.doesNotThrow(() => setPortScript(1024))
  const low = vpnStatus(parseReading(printed({ port: '80', pf: '{"port":80}' })), NOW)
  assert.equal(low.forwardedPort, null); assert.equal(low.portMatch, 'no-port')
  assert.equal(vpnStatus(parseReading(printed({ listen: '"listen_port":0' })), NOW).listenPort, null)
})

test('the plug-in\'s qBittorrent is used only when proven to be the one behind this Gluetun', async () => {
  const calls: string[] = []
  const qb: CoreEndpointClient = {
    get: async (p: string) => { calls.push(p); return p === '/api/v2/app/preferences' ? { listen_port: 40123 } : {} },
    postForm: async (p: string) => { calls.push(p); return null },
    delete: async () => null, put: async () => null, image: async () => { throw new Error('no') }, trigger: async () => {},
  }
  // Found through the Catalogue's record, not by qBittorrent's own address: the saved connection may be another one.
  const { svc } = rig({ qbit: qb, reading: () => printed({ listen: '"listen_port":6881' }), locate: async () => ({ guest: { type: 'lxc', vmid: 9101 }, name: 'arr-stack', qbitProven: false }) })
  const s = await svc.status()
  assert.equal(s.listenPort, 6881, 'the in-guest reading, not the saved connection\'s 40123'); assert.equal(s.portMatch, 'mismatch')
  const r = await svc.act('set-port', 'admin@example.com')
  assert.equal(r.done, false)
  assert.ok(r.notes.some(n => /cannot prove that the qBittorrent in the plug-in's settings is the one behind this VPN/.test(n)), r.notes.join(' | '))
  assert.deepEqual(calls, [], 'the saved connection is never touched')
})

test('two running containers with the plug-in\'s address: no guess; the panel and every fix say so', async () => {
  const rows = [{ vmid: 1, a: ['192.0.2.40'] }, { vmid: 2, a: ['192.0.2.40'] }, { vmid: 3, a: ['192.0.2.41'] }]
  assert.deepEqual(matchingGuests(rows, r => r.a, '192.0.2.40').map(r => r.vmid), [1, 2])
  const why = '2 running containers have the address the Arr Stack plug-in uses (a, b), so HyperProx will not guess which one runs it. Give one of them a different address.'
  const { svc, scripts } = rig({ locate: async () => { throw new VpnRefusal(409, 'ambiguous', why) } })
  assert.equal((await svc.status()).unavailable, why)
  await assert.rejects(svc.act('reconnect', 'admin@example.com'), (e: any) => e.code === 'ambiguous')
  assert.equal(scripts.length, 0)
  assert.match(forViewer(await svc.status()).unavailable!, /could not be checked just now\. An admin can see why\./)
})

test('watch: a slow look is never overlapped by the next tick', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>(r => { release = r })
  let reads = 0
  const { svc } = rig()
  const orig = (svc as any).d.exec
  ;(svc as any).d.exec = async (g: any, s: string, t: number) => { if (s === READ_SCRIPT) { reads++; await gate } return orig(g, s, t) }
  const one = svc.watchTick(), two = svc.watchTick()
  release(); await Promise.all([one, two])
  assert.equal(reads, 1)
})

test('watch: the alert state is kept across a restart, so it neither alerts again nor loses its all-clear', async () => {
  let saved: any = null
  const alerts = { load: async () => saved, save: async (s: any) => { saved = structuredClone(s) } }
  let down = true
  const first = rig({ reading: () => printed({ vpnstatus: down ? '{"status":"stopped"}' : '{"status":"running"}' }), alerts })
  await first.svc.watchTick()
  first.setNow(NOW + 11 * 60_000); await first.svc.watchTick()
  assert.equal(first.sent.length, 1); assert.equal(saved.announced.down, true)
  // A new process: still down, no second alert; then it recovers and the all-clear goes out.
  const second = rig({ reading: () => printed({ vpnstatus: down ? '{"status":"stopped"}' : '{"status":"running"}' }), alerts })
  second.setNow(NOW + 20 * 60_000); await second.svc.watchTick()
  assert.equal(second.sent.length, 0)
  down = false
  second.setNow(NOW + 22 * 60_000); await second.svc.watchTick()
  assert.equal(second.sent.length, 1); assert.equal(second.sent[0].resolved, true)
  assert.deepEqual(saved, { since: {}, announced: {} })
})

test('fails closed: no audit entry, no fix', async () => {
  const { svc, scripts } = rig({ reading: () => printed({ vpnstatus: '{"status":"stopped"}' }), audit: async () => { throw new Error('down') } })
  await assert.rejects(svc.act('reconnect', 'admin@example.com'), (e: any) => e.code === 'audit_unavailable')
  assert.ok(!scripts.includes(RECONNECT_SCRIPT))
})

test('reconnect: the control server first, a restart of both containers only if it refuses; read back', async () => {
  assert.match(RECONNECT_SCRIPT, /-X PUT .*\/v1\/vpn\/status/)
  assert.ok(RECONNECT_SCRIPT.indexOf('docker restart gluetun') < RECONNECT_SCRIPT.indexOf('docker restart qbittorrent'), 'qBittorrent after Gluetun: it shares its network')
  let down = true
  const { svc, scripts } = rig({ reading: () => printed({ vpnstatus: down ? '{"status":"stopped"}' : '{"status":"running"}' }) })
  const orig = (svc as any).d.exec
  ;(svc as any).d.exec = async (g: any, s: string, t: number) => { if (s === RECONNECT_SCRIPT) down = false; return orig(g, s, t) }
  const r = await svc.act('reconnect', 'admin@example.com')
  assert.equal(r.done, true); assert.match(r.summary, /tunnel is up again \(Amsterdam/)
  assert.ok(r.notes.some(n => /control server did not accept/.test(n)))
  assert.ok(scripts.includes(RECONNECT_SCRIPT))
})

test('watch: one alert after ten minutes down, then one all-clear; nothing while locked', async () => {
  let down = true
  let unlocked = true
  const { svc, sent, setNow } = rig({ reading: () => printed({ vpnstatus: down ? '{"status":"stopped"}' : '{"status":"running"}' }), unlocked: () => unlocked })
  await svc.watchTick()
  setNow(NOW + 5 * 60_000); await svc.watchTick()
  assert.equal(sent.length, 0)
  setNow(NOW + 10 * 60_000); await svc.watchTick()
  setNow(NOW + 12 * 60_000); await svc.watchTick()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, 'arr.vpn.down'); assert.equal(sent[0].severity, 'warning'); assert.equal(sent[0].fingerprint, 'arr-vpn:down')
  assert.equal(sent[0].link, '/plugins/arrstack')
  assert.doesNotMatch(JSON.stringify(sent[0]), /198\.51\.100/, 'no address in the message')
  down = false
  setNow(NOW + 14 * 60_000); await svc.watchTick()
  assert.equal(sent.length, 2); assert.equal(sent[1].resolved, true); assert.equal(sent[1].fingerprint, 'arr-vpn:down')
  unlocked = false; down = true
  setNow(NOW + 60 * 60_000); await svc.watchTick()
  assert.equal(sent.length, 2)
})

test('no guest found: the panel says so and every fix is refused', async () => {
  const { svc } = rig({ locate: async () => null })
  const s = await svc.status()
  assert.equal(s.present, false); assert.match(s.unavailable!, /could not tell which container runs your Arr Stack/)
  await assert.rejects(svc.act('reconnect', 'admin@example.com'), (e: any) => e.code === 'no_guest')
})

// ── roles and the routes through the real gate ───────────────────────────────

test('roles: the panel is a read; fixes are admin, refused to API tokens and confirmed on the page; no master password', () => {
  assert.equal(requiredRole('GET', '/api/plugins/arrstack/vpn'), 'viewer')
  assert.equal(requiredRole('POST', '/api/plugins/arrstack/vpn/actions'), 'admin')
  assert.equal(tokenForbidden('POST', '/api/plugins/arrstack/vpn/actions'), true)
  assert.equal(tokenForbidden('GET', '/api/plugins/arrstack/vpn'), false)
  assert.equal(needsPassword('POST', '/api/plugins/arrstack/vpn/actions'), false)
  assert.equal(needsConfirm('POST', '/api/plugins/arrstack/vpn/actions'), true)
  assert.equal(needsConfirm('GET', '/api/plugins/arrstack/vpn'), false)
})

test('routes: a viewer sees the panel without the address; an admin sees it; fixes need an admin, a confirm, never a token', async () => {
  const { svc } = rig()
  const a = Fastify({ logger: false })
  await registerGate(a)
  await a.register(authRoutes, { prefix: '/api/auth' })
  await a.register(buildArrVpnRoutes({ service: () => svc, limiter: new MissLimiter(50) }), { prefix: '/api/plugins/arrstack' })
  await a.ready()
  try {
    const viewer = await signIn(a, 'viewer@example.com', 'viewer master password')
    const v = await a.inject({ method: 'GET', url: '/api/plugins/arrstack/vpn', headers: { cookie: viewer.cookie } })
    assert.equal(v.statusCode, 200, v.body)
    assert.equal(JSON.parse(v.body).data.publicIpHidden, true); assert.doesNotMatch(v.body, /198\.51\.100/)
    assert.equal((await a.inject({ method: 'POST', url: '/api/plugins/arrstack/vpn/actions', headers: { cookie: viewer.cookie }, payload: { action: 'reconnect', confirmed: true } })).statusCode, 403)
    const tok = (await createApiToken({ name: 'bot', role: 'admin' }, 'test', tokens)).token
    const tp = await a.inject({ method: 'POST', url: '/api/plugins/arrstack/vpn/actions', headers: { authorization: `Bearer ${tok}` }, payload: { action: 'reconnect', confirmed: true } })
    assert.equal(tp.statusCode, 403); assert.equal(JSON.parse(tp.body).code, 'token_forbidden')
    const adm = await signIn(a, 'admin@example.com', 'admin master password')
    const s = await a.inject({ method: 'GET', url: '/api/plugins/arrstack/vpn', headers: { cookie: adm.cookie } })
    assert.equal(JSON.parse(s.body).data.publicIp, '198.51.100.23')
    const post = (payload: any) => a.inject({ method: 'POST', url: '/api/plugins/arrstack/vpn/actions', headers: { cookie: adm.cookie }, payload })
    const ask = await post({ action: 'reconnect' })
    assert.equal(JSON.parse(ask.body).code, 'confirm_required')
    assert.equal(JSON.parse(ask.body).confirm.summary, 'Reconnect the VPN? Downloads pause for about a minute.')
    // The page's own flag is not a confirmation: only the server's single-use token is.
    const flag = await post({ action: 'reconnect', confirmed: true })
    assert.equal(flag.statusCode, 403); assert.equal(JSON.parse(flag.body).code, 'confirm_required')
    const port = JSON.parse(s.body).data.forwardedPort
    assert.equal(JSON.parse((await post({ action: 'set-port' })).body).confirm.summary, `Put port ${port} into qBittorrent?`)
    assert.equal(JSON.parse((await post({ action: 'restart-qbit' })).body).confirm.summary, 'Restart qBittorrent? Downloads pause while it starts again.')
    assert.equal((await injectConfirmed(a, { method: 'POST', url: '/api/plugins/arrstack/vpn/actions', headers: { cookie: adm.cookie }, payload: { action: 'switch-region' } })).statusCode, 400)
    const done = await injectConfirmed(a, { method: 'POST', url: '/api/plugins/arrstack/vpn/actions', headers: { cookie: adm.cookie }, payload: { action: 'restart-qbit' } })
    assert.equal(done.statusCode, 200, done.body); assert.equal(JSON.parse(done.body).data.action, 'restart-qbit')
  } finally { await a.close() }
})
