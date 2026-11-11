// Regression tests for the verification review of Home Assistant control: N1 to N7, and the rest of findings
// 7 and 8. Pretend houses on loopback; nothing real is contacted.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { tierOf, DEFAULT_POLICY, markFor, fold } from '../src/lib/ha-control/catalog'
import { InstanceStore, DEFAULT_ID } from '../src/lib/ha-control/instances'
import { HAControlService, type Actor } from '../src/lib/ha-control/service'
import { HttpHAClient } from '../src/lib/ha-control/client'
import { installHAPluginTransport } from '../src/lib/ha-control/broker'
import { probeCertificate } from '../src/lib/clusters/tls-pin'
import { runPlugin, saveSettings, setPluginTransport, PluginSettingsError } from '../src/lib/plugin-host'
import { homeAssistantPlugin } from '../src/plugins/home-assistant'
import { PLUGINS } from '../src/plugins'
import { wireUp } from '../src/lib/catalogue-installer'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { pluginRoutes } from '../src/routes/plugins'
import { haControlRoutes, setHAControlService, setAnonClock, anonCounts } from '../src/routes/ha-control'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { setAuditSink } from '../src/lib/audit'
import { MemoryApiTokenStore, setApiTokenStore, createApiToken } from '../src/lib/api-tokens'
import { FakeBroker } from './fakes/fake-broker'
import { signIn } from './fakes/app'
import { TOKEN_A, st, fakeHA, memIO, HOUSE_A, openResolver, testClient, type FakeHA } from './ha-control-fake'

const owner: Actor = { sid: 's-owner', email: 'owner@example.com', role: 'owner', token: null }
const operator: Actor = { sid: 's-op', email: 'op@example.com', role: 'operator', token: null }
const prodAudit: any[] = []
let A: FakeHA
before(async () => { A = await fakeHA(TOKEN_A, HOUSE_A()); setAuditSink({ write: async r => { prodAudit.push(r) } }) })
after(() => { A.server.close(); setAuditSink(null); installHAPluginTransport() })

let clock = 5_000_000
function house(over: Partial<ConstructorParameters<typeof HAControlService>[0]> = {}) {
  for (const s of HOUSE_A()) A.states.set(s.entity_id, s)
  A.calls.length = 0
  const io = memIO({ 'plugin/home-assistant/url': A.url, 'plugin/home-assistant/token': TOKEN_A })
  const store = new InstanceStore(io, () => false, openResolver)
  const audits: any[] = []
  const svc = new HAControlService({
    store, clientFor: testClient, audit: async (action, resource, details) => { audits.push({ action, resource, details }) },
    sleep: async () => {}, readBack: { tries: 2, everyMs: 0 }, now: () => clock, ...over,
  })
  return { io, store, svc, audits }
}

async function gateApp(svc: HAControlService, users: Array<[string, string, 'owner' | 'admin' | 'operator' | 'viewer']>, items: Record<string, Record<string, string>> = {}) {
  const broker = new FakeBroker()
  for (const [e, p, r] of users) broker.addUser(e, p, r)
  for (const [name, fields] of Object.entries(items)) broker.items.set(name, { id: name, name, fields } as any)
  setBroker(broker)
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  const tokens = new MemoryApiTokenStore()
  setApiTokenStore(tokens)
  setHAControlService(svc)
  const app: FastifyInstance = Fastify({ logger: false })
  await registerGate(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(pluginRoutes, { prefix: '/api/plugins' })
  await app.register(haControlRoutes, { prefix: '/api/plugins/home-assistant' })
  await app.ready()
  const close = async () => { setHAControlService(null); setApiTokenStore(null); if (isUnlocked()) await lock('manual'); await app.close() }
  return { app, tokens, close }
}

// ── N1: house #1's token only through the checked client ─────────────────────

test('N1: the plug-in never sends the token itself: no transport, no request; the real transport refuses loopback; the checked one works', async () => {
  for (const s of HOUSE_A()) A.states.set(s.entity_id, s)
  assert.equal(homeAssistantPlugin.manifest.coreTransport, true)
  assert.equal(homeAssistantPlugin.manifest.insecureTLS, undefined)
  const { svc } = house()
  const g = await gateApp(svc, [['owner@example.com', 'owner master password', 'owner']],
    { 'hyperprox:plugin/home-assistant': { url: A.url, token: TOKEN_A } })
  try {
    await signIn(g.app, 'owner@example.com', 'owner master password')
    A.seenAuth.clear()
    setPluginTransport('home-assistant', null)
    await assert.rejects(runPlugin(homeAssistantPlugin), /not connected yet/)
    installHAPluginTransport()   // the production transport: the address guard refuses loopback
    await assert.rejects(runPlugin(homeAssistantPlugin), /address refused/)
    assert.equal(A.seenAuth.size, 0, 'no request reached the house on either path')

    installHAPluginTransport({ clientFor: testClient })
    const tile = await runPlugin(homeAssistantPlugin)
    assert.match(tile.headline, /entities|attention/)
    assert.ok(A.seenAuth.has(`Bearer ${TOKEN_A}`))

    // The checked client reads only the plug-in's paths, never a service.
    const c = testClient({ url: A.url, token: TOKEN_A, insecureTLS: false })
    await assert.rejects(c.pluginRead('/api/services/lock/unlock'), /not something the Home Assistant plug-in may read/)
    await assert.rejects(c.pluginRead('/api/template'), /not something/)

    // The address and token cannot be saved through the generic settings either, from anywhere.
    await assert.rejects(saveSettings(homeAssistantPlugin.manifest, { url: 'http://10.0.0.9:8123' }), (e: any) => e instanceof PluginSettingsError)
    await assert.rejects(saveSettings(homeAssistantPlugin.manifest, { token: 'x'.repeat(30) }), (e: any) => e instanceof PluginSettingsError)
  } finally { installHAPluginTransport(); await g.close() }
})

// ── Finding 7, rest: health for viewers ──────────────────────────────────────

test('finding 7: a viewer\'s health view has no security devices, no automation times and no error log; reads are cached and limited', async () => {
  const { svc } = house({ limits: { readsPerMinute: 3 } })
  A.states.set('automation.away', st('automation.away', 'on', { friendly_name: 'Away mode', last_triggered: '2026-01-01T00:00:00Z' }))
  A.states.set('switch.gate_relay', st('switch.gate_relay', 'unavailable', { friendly_name: 'Gate relay' }))
  A.errorLog = 'ERROR (MainThread) [x] cannot reach 172.16.9.9 camera.porch.lan\n'
  try {
    const v = await svc.health(DEFAULT_ID, 20, null, { viewer: true })
    const text = JSON.stringify(v)
    assert.equal(text.includes('Gate relay'), false, 'security switch left out')
    assert.equal(text.includes('Front door'), false, 'lock left out')
    assert.equal(text.includes('172.16.9.9') || text.includes('porch.lan'), false, 'no log')
    const autos = v.tables.find(t => t.title === 'Automations')!
    assert.deepEqual(autos.rows.map(r => r.triggered), ['—'])
    const full = JSON.stringify(await svc.health(DEFAULT_ID, 20, null, {}))
    assert.ok(full.includes('Gate relay') && full.includes('porch.lan'), 'operators still see everything')

    clock += 11_000
    const reads = A.statesReads
    await svc.health(DEFAULT_ID); await svc.health(DEFAULT_ID)
    assert.equal(A.statesReads - reads, 1, 'one read per house per 10 seconds')
    for (let i = 0; i < 3; i++) await svc.status(DEFAULT_ID, null, operator)
    await assert.rejects(svc.health(DEFAULT_ID, 20, null, { actor: operator }), (e: any) => e.code === 'rate_limited')
  } finally { A.errorLog = ''; A.states.delete('automation.away'); A.states.delete('switch.gate_relay') }
})

test('finding 7: the plug-in\'s own detail route gives a viewer the same redacted view', async () => {
  clock += 11_000
  const { svc } = house()
  A.errorLog = 'ERROR something at camera.porch.lan\n'
  const g = await gateApp(svc, [['owner@example.com', 'owner master password', 'owner'], ['viewer@example.com', 'viewer master password', 'viewer']])
  try {
    await signIn(g.app, 'owner@example.com', 'owner master password')
    const vc = (await signIn(g.app, 'viewer@example.com', 'viewer master password')).cookie
    const r = await g.app.inject({ method: 'GET', url: '/api/plugins/home-assistant/detail', headers: { cookie: vc } })
    assert.equal(r.statusCode, 200)
    assert.equal(r.json().data.ok, true)
    assert.equal(r.body.includes('porch.lan'), false)
    assert.equal(r.body.includes('Front door'), false)
  } finally { A.errorLog = ''; await g.close() }
})

// ── N2: switches deny by default; folded keywords ────────────────────────────

test('N2: a switch is security unless it is an outlet or marked everyday; keywords in several languages always are', () => {
  const p = DEFAULT_POLICY
  assert.equal(tierOf(st('switch.relay', 'off', { friendly_name: 'Relay' }), p), 'security')
  assert.equal(tierOf(st('input_boolean.flag', 'off', { friendly_name: 'Flag' }), p), 'security')
  assert.equal(tierOf(st('switch.kettle', 'off', { friendly_name: 'Kettle', device_class: 'outlet' }), p), 'normal')
  const relay = st('switch.relay', 'off', { friendly_name: 'Relay' })
  assert.equal(tierOf(relay, { ...p, everyday: [markFor(relay)] }), 'normal')
  for (const name of ['Tür vorne', 'Portail', 'Puerta garaje', 'Portón', 'Serrure', 'Cerradura', 'Schloss', 'Lucchetto', 'Cancello', 'Alarme',
    'Alarma', 'Voordeur deur', 'Poort', 'Slot', 'Tor', 'Garagentor', 'ＤＯＯＲ', 'Porte d’entrée', 'garaje']) {
    const s = st('switch.x', 'off', { friendly_name: name, device_class: 'outlet' })
    assert.equal(tierOf(s, { ...p, everyday: [markFor(s)] }), 'security', name)
  }
  for (const name of ['Motor', 'Warm water', 'Monitor', 'Tutorial lamp', 'Doorbell chime']) {
    assert.equal(tierOf(st('switch.y', 'off', { friendly_name: name, device_class: 'outlet' }), p), 'normal', name)
  }
  assert.equal(fold('Ｔür'), 'tur')
})

// ── N3: everyday marks are bound to what the entity was ──────────────────────

test('N3: an everyday mark is void once the name, class or kind changes, and the Devices view says so', async () => {
  const { svc, store } = house()
  const marks = await svc.everydayMarks(DEFAULT_ID, ['scene.goodnight'], [])
  assert.deepEqual(marks, [{ entity_id: 'scene.goodnight', domain: 'scene', device_class: null, friendly_name: 'Goodnight' }])
  await store.update(DEFAULT_ID, { policy: { everyday: marks } })
  let row = (await svc.devices(DEFAULT_ID)).areas.flatMap(a => a.devices).find(d => d.entityId === 'scene.goodnight')!
  assert.equal(row.tier, 'normal')
  A.states.get('scene.goodnight')!.attributes.friendly_name = 'Open everything'
  clock += 3_000
  const d = await svc.devices(DEFAULT_ID)
  row = d.areas.flatMap(a => a.devices).find(x => x.entityId === 'scene.goodnight')!
  assert.equal(row.tier, 'security')
  assert.ok(d.warnings.some(w => /scene\.goodnight changed/.test(w)))
  await assert.rejects(svc.act(DEFAULT_ID, { entityId: 'scene.goodnight', action: 'run' }, owner, false), (e: any) => e.code === 'security_action')
  // A later save keeps the old mark: it is not quietly renewed with the new name.
  assert.deepEqual(await svc.everydayMarks(DEFAULT_ID, ['scene.goodnight'], marks), marks)
  // Always-security entities and unknown ids cannot be marked.
  await assert.rejects(svc.everydayMarks(DEFAULT_ID, ['lock.front_door'], []), /always a security device/)
  await assert.rejects(svc.everydayMarks(DEFAULT_ID, ['switch.nope'], []), /has no entity/)
  await assert.rejects(store.update(DEFAULT_ID, { policy: { everyday: ['scene.goodnight'] } }), /recorded by HyperProx/)
})

// ── N4, N6, finding 8 through the gate ───────────────────────────────────────

test('N4: certificate probes refuse API tokens and are limited per session', async () => {
  const { svc } = house({ limits: { probesPerMinute: 2 } })
  const g = await gateApp(svc, [['owner@example.com', 'owner master password', 'owner']])
  try {
    const oc = (await signIn(g.app, 'owner@example.com', 'owner master password')).cookie
    const tok = (await createApiToken({ name: 'automation', role: 'admin' }, 'test', g.tokens)).token
    const probe = (headers: Record<string, string>) => g.app.inject({ method: 'POST', url: '/api/plugins/home-assistant/instances/probe-certificate', headers, payload: { url: 'https://127.0.0.1:9' } })
    const t = await probe({ authorization: `Bearer ${tok}` })
    assert.equal(t.statusCode, 403)
    assert.equal(t.json().code, 'token_forbidden')
    assert.equal((await probe({ cookie: oc })).statusCode, 400, 'loopback refused by the address rules')
    assert.equal((await probe({ cookie: oc })).statusCode, 400)
    assert.equal((await probe({ cookie: oc })).statusCode, 429)
  } finally { await g.close() }
})

test('N6: unauthenticated or locked refusals are counted, with one summary row per window, not a row each', async () => {
  let now = 1_000
  setAnonClock(() => now)
  const { svc, audits } = house()
  const g = await gateApp(svc, [['owner@example.com', 'owner master password', 'owner']])
  try {
    await signIn(g.app, 'owner@example.com', 'owner master password')
    prodAudit.length = 0
    for (let i = 0; i < 5; i++) {
      const r = await g.app.inject({ method: 'POST', url: '/api/plugins/home-assistant/instances/default/secure-actions', payload: { entityId: 'lock.front_door', action: 'unlock' } })
      assert.equal(r.statusCode, 401)
    }
    assert.equal(audits.length, 0, 'no per-request rows')
    assert.equal(anonCounts().unauthenticated, 5)
    now += 11 * 60_000
    await g.app.inject({ method: 'POST', url: '/api/plugins/home-assistant/instances/default/actions', payload: {} })
    const rows = prodAudit.filter(r => r.action === 'ha.action.anonymous')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].details.unauthenticated, 6)
  } finally { setAnonClock(() => Date.now()); await g.close() }
})

test('finding 8: repeated tries at a lock through the everyday route are limited, as is every attempt', async () => {
  const { svc } = house({ limits: { securityPerMinute: 2, attemptsPerMinute: 4 } })
  const tryLock = () => svc.act(DEFAULT_ID, { entityId: 'lock.front_door', action: 'unlock' }, operator, false).catch(e => e.code)
  assert.equal(await tryLock(), 'security_action')
  assert.equal(await tryLock(), 'security_action')
  assert.equal(await tryLock(), 'rate_limited', 'an operator poking a lock is limited too')
  assert.equal(await svc.act(DEFAULT_ID, { entityId: 'light.nope', action: 'turn_on' }, operator, false).catch(e => e.code), 'unknown_entity')
  assert.equal(await svc.act(DEFAULT_ID, { entityId: 'light.nope', action: 'turn_on' }, operator, false).catch(e => e.code), 'rate_limited', 'each attempt reads the house, so each counts')
})

test('finding 8: admin to operator is a demotion (re-confirmed, audited); create records everyday ids', async () => {
  const { svc, store } = house()
  await store.update(DEFAULT_ID, { policy: { normalRole: 'admin' } })
  const g = await gateApp(svc, [['owner@example.com', 'owner master password', 'owner']])
  try {
    const oc = (await signIn(g.app, 'owner@example.com', 'owner master password')).cookie
    const put = () => g.app.inject({ method: 'PUT', url: '/api/plugins/home-assistant/instances/default', headers: { cookie: oc }, payload: { policy: { normalRole: 'operator' } } })
    assert.equal((await put()).json().code, 'reconfirm_required')
    await g.app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie: oc }, payload: { password: 'owner master password' } })
    prodAudit.length = 0
    assert.equal((await put()).statusCode, 200)
    const row = prodAudit.find(r => r.action === 'ha.instance.demote')
    assert.ok(row)
    assert.equal(row.details.normalRole, 'admin->operator')

    const created = await g.app.inject({ method: 'POST', url: '/api/plugins/home-assistant/instances', headers: { cookie: oc },
      payload: { name: 'Second home', url: A.url, token: TOKEN_A, policy: { everyday: ['scene.goodnight'] } } })
    assert.equal(created.statusCode, 201, created.body)
    assert.deepEqual(created.json().data.policy.everyday.map((e: any) => e.entity_id), ['scene.goodnight'])
    const c = prodAudit.find(r => r.action === 'ha.instance.create')
    assert.deepEqual(c.details.everyday, ['scene.goodnight'])
  } finally { await g.close() }
})

// ── N5: the catalogue never passes stored secrets back ───────────────────────

test('N5: wiring a catalogue install to a plug-in at a new address does not carry its stored key there', async () => {
  const { svc } = house()
  const g = await gateApp(svc, [['owner@example.com', 'owner master password', 'owner']],
    { 'hyperprox:plugin/plex': { url: 'http://tautulli.lan:8181', apikey: 'old-key' } })
  try {
    await signIn(g.app, 'owner@example.com', 'owner master password')
    assert.ok(PLUGINS.find(p => p.manifest.id === 'plex'))
    await assert.rejects(wireUp({ satisfies: { kind: 'plugin', id: 'plex', setting: 'url' } } as any, 'http://elsewhere.lan:8181'), (e: any) => e instanceof PluginSettingsError)
  } finally { await g.close() }
})

// ── N7: the TLS name goes through ────────────────────────────────────────────

const haveOpenssl = spawnSync('openssl', ['version']).status === 0
test('N7: the pinned agent and the certificate probe send the name as SNI when connecting to an address', { skip: !haveOpenssl && 'openssl not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hpx-ha-sni-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '30', '-subj', '/CN=ha.test', '-keyout', join(dir, 'k'), '-out', join(dir, 'c')], { stdio: 'ignore' })
  const tls = { key: readFileSync(join(dir, 'k')), cert: readFileSync(join(dir, 'c')) }
  const H = await fakeHA(TOKEN_A, [st('light.a', 'off')], [], { tls })
  try {
    const port = new URL(H.url).port
    const fp = new X509Certificate(tls.cert).fingerprint256
    const toLoopback = async () => '127.0.0.1'
    const c = new HttpHAClient({ url: `https://ha.test:${port}`, token: TOKEN_A, insecureTLS: false, fingerprint: fp }, 5000, toLoopback)
    assert.equal((await c.states()).length, 1)
    assert.deepEqual(H.sni, ['ha.test'], 'pinned agent')
    await probeCertificate('127.0.0.1', Number(port), 5000, 'ha.test')
    await new Promise(r => setTimeout(r, 100))
    assert.deepEqual(H.sni, ['ha.test', 'ha.test'], 'probe')
  } finally { H.server.close() }
})
