// Regression tests for the review of Home Assistant control, findings 2 to 8 (finding 1 is in
// ha-control-plugin-settings.test.ts). Pretend houses on loopback; nothing real is contacted.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { tierOf, DEFAULT_POLICY, confirmTemplate } from '../src/lib/ha-control/catalog'
import { InstanceStore, DEFAULT_ID } from '../src/lib/ha-control/instances'
import { HAControlService, type Actor } from '../src/lib/ha-control/service'
import { HttpHAClient } from '../src/lib/ha-control/client'
import { checkHAAddresses, resolveHATarget } from '../src/lib/ha-control/target'
import { needsReconfirm } from '../src/lib/roles'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { haControlRoutes, setHAControlService } from '../src/routes/ha-control'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { setApiTokenStore, MemoryApiTokenStore } from '../src/lib/api-tokens'
import { setAuditSink } from '../src/lib/audit'
import { FakeBroker } from './fakes/fake-broker'
import { signIn } from './fakes/app'
import { TOKEN_A, TOKEN_B, st, fakeHA, memIO, HOUSE_A, openResolver, testClient, type FakeHA } from './ha-control-fake'

const owner: Actor = { sid: 's-owner', email: 'owner@example.com', role: 'owner', token: null }
const operator: Actor = { sid: 's-op', email: 'op@example.com', role: 'operator', token: null }
let A: FakeHA
// The production audit (instance changes) goes here, never to a database.
const prodAudit: any[] = []
before(async () => { A = await fakeHA(TOKEN_A, HOUSE_A()); setAuditSink({ write: async r => { prodAudit.push(r) } }) })
after(() => { A.server.close(); setAuditSink(null) })

function house(over: Partial<ConstructorParameters<typeof HAControlService>[0]> = {}) {
  for (const s of HOUSE_A()) A.states.set(s.entity_id, s)
  A.calls.length = 0
  const io = memIO({ 'plugin/home-assistant/url': A.url, 'plugin/home-assistant/token': TOKEN_A })
  const store = new InstanceStore(io, id => id === 'c0123456789', openResolver)
  const audits: any[] = []
  const published: any[] = []
  const svc = new HAControlService({
    store, clientFor: testClient, audit: async (action, resource, details) => { audits.push({ action, resource, details }) },
    publish: async e => { published.push(e) }, sleep: async () => {}, readBack: { tries: 2, everyMs: 0 }, ...over,
  })
  return { io, store, svc, audits, published }
}

// ── Finding 2: deny by default ───────────────────────────────────────────────

test('finding 2: covers are everyday only for blinds and the like; missing or other classes are security', () => {
  const p = DEFAULT_POLICY
  for (const dc of ['blind', 'curtain', 'shade', 'shutter', 'awning', 'damper']) assert.equal(tierOf(st('cover.x', 'open', { device_class: dc }), p), 'normal', dc)
  for (const dc of [undefined, '', 'window', 'garage', 'gate', 'door', 'something_new']) assert.equal(tierOf(st('cover.x', 'open', dc === undefined ? {} : { device_class: dc }), p), 'security', String(dc))
})

test('finding 2: scripts, scenes and buttons are security unless the owner marks them everyday', () => {
  const p = DEFAULT_POLICY
  for (const id of ['script.open_everything', 'scene.goodnight', 'button.gate_open']) {
    assert.equal(tierOf(st(id, 'off'), p), 'security', id)
    assert.equal(tierOf(st(id, 'off'), { ...p, everyday: [id] }), 'normal', `${id} demoted`)
  }
  // Protected wins over everyday; the always-security kinds cannot be demoted at all.
  assert.equal(tierOf(st('scene.x', 'off'), { ...p, everyday: ['scene.x'], protected: ['scene.x'] }), 'security')
  for (const s of [st('lock.f', 'locked'), st('cover.g', 'closed', { device_class: 'garage' }), st('siren.s', 'off'), st('alarm_control_panel.a', 'disarmed')]) {
    assert.equal(tierOf(s, { ...p, everyday: [s.entity_id] }), 'security', s.entity_id)
  }
})

test('finding 2: a switch that sounds like a door, lock or alarm is security; a siren-class switch always', () => {
  const p = DEFAULT_POLICY
  for (const [id, name] of [['switch.garage_opener', 'Relay'], ['switch.relay_1', 'Front door'], ['input_boolean.alarm_armed', 'x'],
    ['switch.r2', 'Gate'], ['switch.r3', 'Entry buzzer'], ['switch.r4', 'Unlock side'], ['switch.r5', 'Siren']]) {
    assert.equal(tierOf(st(id, 'off', { friendly_name: name }), p), 'security', `${id} ${name}`)
  }
  assert.equal(tierOf(st('switch.kettle', 'off', { friendly_name: 'Kettle' }), p), 'normal')
  assert.equal(tierOf(st('switch.bell', 'off', { friendly_name: 'Bell', device_class: 'siren' }), { ...p, everyday: ['switch.bell'] }), 'security')
  assert.equal(tierOf(st('switch.relay_1', 'off', { friendly_name: 'Door lamp' }), { ...p, everyday: ['switch.relay_1'] }), 'normal', 'owner may demote a false match')
})

test('finding 2: the tier is decided from the state read at action time, not from the list on screen', async () => {
  const { svc } = house()
  A.states.set('cover.side', st('cover.side', 'closed', { friendly_name: 'Side', device_class: 'blind' }))
  const listed = (await svc.devices(DEFAULT_ID)).areas.flatMap(a => a.devices).find(d => d.entityId === 'cover.side')!
  assert.equal(listed.tier, 'normal')
  // Home Assistant reclassifies it a moment later; the cached list would still say blind.
  A.states.get('cover.side')!.attributes.device_class = 'garage'
  await assert.rejects(svc.act(DEFAULT_ID, { entityId: 'cover.side', action: 'open' }, owner, false), (e: any) => e.code === 'security_action')
  assert.equal(A.calls.length, 0)
})

test('finding 2: devices() warns when a protected or everyday id no longer exists (renamed)', async () => {
  const { svc, store } = house()
  await store.update(DEFAULT_ID, { policy: { protected: ['switch.old_heater'], everyday: ['scene.gone'] } })
  const d = await svc.devices(DEFAULT_ID)
  assert.equal(d.warnings.length, 2)
  assert.match(d.warnings[0], /switch\.old_heater.*renamed/)
  assert.equal((await svc.devices(DEFAULT_ID, null, { viewer: true })).warnings.length, 0, 'viewers do not see the lists')
})

test('finding 2: demoting to everyday is admin, re-confirmed and audited on its own', () => {
  assert.equal(needsReconfirm('PUT', '/api/plugins/home-assistant/instances/default'), true)
})

// ── Finding 3: where an address may point ────────────────────────────────────

test('finding 3: loopback, link-local, metadata, own ports refused; http only to private addresses', () => {
  const env = { own: new Set(['10.0.0.5']), ports: new Set([3002, 8222]), bridges: new net.BlockList() }
  const no = (proto: string, port: number, ips: string[]) => assert.equal(checkHAAddresses(proto, port, ips, env).ok, false, `${proto} ${ips} ${port}`)
  const yes = (proto: string, port: number, ips: string[]) => assert.equal(checkHAAddresses(proto, port, ips, env).ok, true, `${proto} ${ips} ${port}`)
  no('http:', 8123, ['127.0.0.1']); no('https:', 8123, ['::1']); no('http:', 8123, ['::ffff:127.0.0.1'])
  no('http:', 80, ['169.254.169.254']); no('https:', 443, ['fe80::1']); no('http:', 80, ['0.0.0.0'])
  no('http:', 80, ['fd00:ec2::254'])
  no('http:', 8222, ['10.0.0.5']); no('https:', 3002, ['10.0.0.5'])
  no('http:', 8123, ['8.8.8.8']); no('http:', 8123, ['172.16.5.20', '8.8.8.8'])
  yes('http:', 8123, ['172.16.5.20']); yes('http:', 8123, ['10.0.0.5']); yes('http:', 8123, ['100.101.102.103']); yes('http:', 8123, ['fd7a:115c:a1e0::1'])
  yes('https:', 8123, ['8.8.8.8'])
})

test('finding 3: the real guard refuses the loopback house before sending it anything, on save and on use', async () => {
  await assert.rejects(resolveHATarget(new URL(A.url)), /loopback/)
  const store = new InstanceStore(memIO())
  await assert.rejects(store.create({ name: 'Home', url: A.url, token: TOKEN_A }), /loopback/)
  await assert.rejects(store.create({ name: 'Home', url: 'http://169.254.169.254', token: TOKEN_A }), /metadata/)
  // A stored address that is now refused (stored before this check, or rebinding): the token never leaves.
  const before = A.seenAuth.size
  A.seenAuth.clear()
  await assert.rejects(new HttpHAClient({ url: A.url, token: TOKEN_A, insecureTLS: false }).states(), /address refused/)
  assert.equal(A.seenAuth.size, 0, 'no request reached the house')
  assert.ok(before >= 0)
})

test('finding 3: every house, the first one included, verifies certificates by default', async () => {
  const io = memIO({ 'plugin/home-assistant/url': 'https://ha.lan:8123', 'plugin/home-assistant/token': TOKEN_A })
  const s = new InstanceStore(io, undefined, openResolver)
  assert.equal((await s.get(DEFAULT_ID))!.insecureTLS, false)
  assert.equal((await s.update(DEFAULT_ID, { insecureTLS: true })).insecureTLS, true, 'the first house can be set like any other')
})

const haveOpenssl = spawnSync('openssl', ['version']).status === 0
test('finding 3: a pinned certificate is accepted, any other is refused before the token is sent', { skip: !haveOpenssl && 'openssl not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hpx-ha-pin-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '30', '-subj', '/CN=ha-test', '-keyout', join(dir, 'k'), '-out', join(dir, 'c')], { stdio: 'ignore' })
  const tls = { key: readFileSync(join(dir, 'k')), cert: readFileSync(join(dir, 'c')) }
  const H = await fakeHA(TOKEN_A, [st('light.a', 'off')], [], { tls })
  try {
    const fp = new X509Certificate(tls.cert).fingerprint256
    const verified = new HttpHAClient({ url: H.url, token: TOKEN_A, insecureTLS: false }, 5000, openResolver)
    await assert.rejects(verified.states(), /certificate/, 'self-signed and not pinned: refused')
    const pinned = new HttpHAClient({ url: H.url, token: TOKEN_A, insecureTLS: false, fingerprint: fp }, 5000, openResolver)
    assert.equal((await pinned.states()).length, 1)
    assert.equal((await pinned.currentUser()).name, 'hyperprox', 'the WebSocket uses the pin too')
    H.seenAuth.clear()
    const wrong = new HttpHAClient({ url: H.url, token: TOKEN_A, insecureTLS: false, fingerprint: 'AB'.repeat(32) }, 5000, openResolver)
    await assert.rejects(wrong.states(), /different certificate/)
    assert.equal(H.seenAuth.size, 0, 'the token was never sent to the wrong certificate')
  } finally { H.server.close() }
})

// ── Finding 4: a moved address needs the token again ─────────────────────────

test('finding 4: changing host or port needs a new token in the same request, and drops the pin', async () => {
  const io = memIO()
  const s = new InstanceStore(io, undefined, openResolver)
  const h = await s.create({ name: 'Home', url: 'https://ha.lan:8123', token: TOKEN_A, fingerprint: 'AB'.repeat(32) })
  await assert.rejects(s.update(h.id, { url: 'https://other.lan:8123' }), /token again/)
  await assert.rejects(s.update(h.id, { url: 'https://ha.lan:9443', token: '' }), /token again/)
  assert.equal(io.data.get('plugin/home-assistant/url'), 'https://ha.lan:8123', 'nothing changed')
  assert.equal((await s.update(h.id, { url: 'https://ha.lan:8123/' })).fingerprint, 'AB:'.repeat(31) + 'AB', 'same host and port: pin kept')
  const moved = await s.update(h.id, { url: 'https://other.lan:8123', token: TOKEN_B })
  assert.equal(moved.fingerprint, null)
  assert.equal(io.data.get('plugin/home-assistant/token'), TOKEN_B)
})

// ── Finding 5: typed check, no phrase in the answer, rounded value ───────────

test('finding 5: security actions need the device name typed, the answer never gives the phrase, the phrase uses the checked value', async () => {
  const { svc } = house()
  A.states.set('cover.garage', st('cover.garage', 'closed', { friendly_name: 'Garage', device_class: 'garage', current_position: 0 }))
  const base = { entityId: 'cover.garage', action: 'position', value: 33.4 }
  const err = await svc.act(DEFAULT_ID, { ...base, confirm: 'Set position to 33.4% Garage at Home', typed: 'Garage' }, owner, true).catch(e => e)
  assert.equal(err.code, 'confirm_required')
  assert.equal(JSON.stringify(err.extra).includes('Set position'), false)
  assert.equal(err.message.includes('Set position'), false)
  assert.equal((await svc.act(DEFAULT_ID, { ...base, confirm: 'Set position to 33% Garage at Home' }, owner, true).catch(e => e)).code, 'confirm_required', 'no typed name')
  assert.equal((await svc.act(DEFAULT_ID, { ...base, confirm: 'Set position to 33% Garage at Home', typed: 'Garag' }, owner, true).catch(e => e)).code, 'confirm_required')
  assert.equal(A.calls.length, 0)
  const ok = await svc.act(DEFAULT_ID, { ...base, confirm: 'Set position to 33% Garage at Home', typed: '  garage ' }, owner, true)
  assert.equal(ok.changed, true)
  assert.deepEqual(A.calls, ['cover.set_cover_position {"entity_id":"cover.garage","position":33}'])
  assert.equal(confirmTemplate(A.states.get('cover.garage')!, 'position', 'Home'), 'Set position to {value}% Garage at Home')
})

// ── Finding 6: bounded reads ─────────────────────────────────────────────────

test('finding 6: a REST answer that trickles forever is cut at the wall-clock deadline', async () => {
  const S = await fakeHA(TOKEN_A, [], [], { slow: true })
  try {
    const t0 = Date.now()
    await assert.rejects(new HttpHAClient({ url: S.url, token: TOKEN_A, insecureTLS: false }, 600, openResolver).config(), /did not answer in time/)
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`)
  } finally { S.server.close() }
})

test('finding 6: a WebSocket frame claiming more than 16 MB is refused at once', async () => {
  const S = await fakeHA(TOKEN_A, [], [], { hugeFrame: true })
  try {
    await assert.rejects(new HttpHAClient({ url: S.url, token: TOKEN_A, insecureTLS: false }, 5000, openResolver).currentUser(), /too much/)
  } finally { S.server.close() }
})

// ── Finding 7: viewers, caching, polling ─────────────────────────────────────

test('finding 7: viewers see no live state or controls on security devices; one read serves many pages; polling is limited', async () => {
  const { svc } = house({ limits: { normalPerMinute: 30, securityPerMinute: 5, devicesPerMinute: 3 } })
  const v = await svc.devices(DEFAULT_ID, null, { viewer: true })
  const lockRow = v.areas.flatMap(a => a.devices).find(d => d.entityId === 'lock.front_door')!
  assert.equal(lockRow.state, 'hidden')
  assert.deepEqual(lockRow.controls, [])
  assert.equal(v.areas.flatMap(a => a.devices).find(d => d.entityId === 'light.kitchen')!.state, 'off', 'everyday devices still show')

  const reads = A.statesReads
  await svc.devices(DEFAULT_ID); await svc.devices(DEFAULT_ID)
  assert.equal(A.statesReads - reads, 0, 'served from the short per-house cache')

  for (let i = 0; i < 3; i++) await svc.devices(DEFAULT_ID, null, { actor: operator })
  await assert.rejects(svc.devices(DEFAULT_ID, null, { actor: operator }), (e: any) => e.code === 'rate_limited' && e.status === 429)
})

// ── Finding 8: audit every refusal; rate limit before phrases; serial writes ─

test('finding 8: refusals before the house is known are audited; the rate limit comes before the phrase check', async () => {
  const { svc, audits, published } = house({ limits: { normalPerMinute: 30, securityPerMinute: 2, devicesPerMinute: 40 } })
  await assert.rejects(svc.act('h00000000', { entityId: 'lock.front_door', action: 'unlock' }, owner, true), (e: any) => e.code === 'no_instance')
  await assert.rejects(svc.act(DEFAULT_ID, { entityId: 'light.kitchen', action: 'turn_on' }, operator, false, 'c0123456789'), (e: any) => e.code === 'wrong_cluster')
  assert.deepEqual(audits.map(a => a.details.result), ['refused:no_instance', 'refused:wrong_cluster'])

  const guess = (typed: string) => svc.act(DEFAULT_ID, { entityId: 'lock.front_door', action: 'unlock', confirm: 'Unlock Front door at Home', typed }, owner, true).catch(e => e.code)
  assert.equal(await guess('a'), 'confirm_required')
  assert.equal(await guess('b'), 'confirm_required')
  assert.equal(await guess('Front door'), 'rate_limited', 'even the right answer waits once the limit is used up on guesses')
  assert.equal(A.calls.length, 0)
  assert.equal(published.filter(e => e.type === 'ha.security.refused').length, 1, 'refusals notify once per house per 10 minutes')
})

test('finding 8: two saves at once both land (instance list writes are serialised)', async () => {
  const io = memIO()
  const slow = { ...io, async set(c: string, p: string, k: string, v: string, m: boolean) { await new Promise(r => setTimeout(r, 5)); return io.set(c, p, k, v, m) } }
  const s = new InstanceStore(slow, undefined, openResolver)
  await s.create({ name: 'Home', url: 'http://10.0.0.2:8123', token: TOKEN_A })
  await Promise.all([s.create({ name: 'Second home', url: 'http://10.0.0.3:8123', token: TOKEN_B }), s.create({ name: 'Cabin', url: 'http://10.0.0.4:8123', token: TOKEN_B })])
  assert.deepEqual((await s.list()).map(i => i.name).sort(), ['Cabin', 'Home', 'Second home'])
})

test('findings 7 and 8 through the gate: viewer redaction, gate refusals audited, demotions audited', async () => {
  const broker = new FakeBroker()
  broker.addUser('owner@example.com', 'owner master password', 'owner')
  broker.addUser('viewer@example.com', 'viewer master password', 'viewer')
  setBroker(broker)
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  setApiTokenStore(new MemoryApiTokenStore())
  const { svc, audits, store } = house()
  A.isAdmin = true
  setHAControlService(svc)
  const app: FastifyInstance = Fastify({ logger: false })
  await registerGate(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(haControlRoutes, { prefix: '/api/plugins/home-assistant' })
  await app.ready()
  try {
    const oc = (await signIn(app, 'owner@example.com', 'owner master password')).cookie
    const vc = (await signIn(app, 'viewer@example.com', 'viewer master password')).cookie
    const get = (url: string, cookie: string) => app.inject({ method: 'GET', url: `/api/plugins/home-assistant${url}`, headers: { cookie } })

    const list = (await get('/instances', vc)).json().data[0]
    assert.equal(list.url, undefined)
    assert.equal(list.fingerprint, undefined)
    assert.deepEqual(list.policy.protected, [])
    assert.equal((await get('/instances/default/status', vc)).json().data.user, null)
    assert.equal((await get('/instances/default/status', oc)).json().data.user.isAdmin, true)
    assert.equal((await get('/instances', oc)).json().data[0].url, A.url)

    audits.length = 0
    const denied = await app.inject({ method: 'POST', url: '/api/plugins/home-assistant/instances/default/actions', headers: { cookie: vc }, payload: { entityId: 'light.kitchen', action: 'turn_on' } })
    assert.equal(denied.statusCode, 403)
    assert.equal(audits.length, 1)
    // The gate answers before the body is read, so the row names the house, the person and the refusal.
    assert.deepEqual({ r: audits[0].details.result, by: audits[0].details.by, res: audits[0].resource }, { r: 'refused:gate_403', by: 'viewer@example.com', res: 'home-assistant:default' })

    await app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie: oc }, payload: { password: 'owner master password' } })
    const put = await app.inject({ method: 'PUT', url: '/api/plugins/home-assistant/instances/default', headers: { cookie: oc }, payload: { policy: { everyday: ['scene.goodnight'] } } })
    assert.equal(put.statusCode, 200, put.body)
    const demote = audits.find(a => a.action === 'ha.instance.demote')
    assert.ok(!demote, 'demotions go to the production audit (auditCredentialUse), checked below')
    assert.deepEqual((await store.get(DEFAULT_ID))!.policy.everyday, ['scene.goodnight'])
  } finally {
    setHAControlService(null); setApiTokenStore(null); A.isAdmin = false
    if (isUnlocked()) await lock('manual')
    await app.close()
  }
})

test('finding 2: the demotion audit row names each entity moved to everyday', async () => {
  const rows = prodAudit
  rows.length = 0
  {
    const broker = new FakeBroker()
    broker.addUser('owner@example.com', 'owner master password', 'owner')
    setBroker(broker)
    setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
    setApiTokenStore(new MemoryApiTokenStore())
    const { svc } = house()
    setHAControlService(svc)
    const app = Fastify({ logger: false })
    await registerGate(app)
    await app.register(authRoutes, { prefix: '/api/auth' })
    await app.register(haControlRoutes, { prefix: '/api/plugins/home-assistant' })
    await app.ready()
    try {
      const oc = (await signIn(app, 'owner@example.com', 'owner master password')).cookie
      await app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie: oc }, payload: { password: 'owner master password' } })
      await app.inject({ method: 'PUT', url: '/api/plugins/home-assistant/instances/default', headers: { cookie: oc }, payload: { policy: { everyday: ['scene.goodnight', 'button.doorbell_test'] } } })
      const row = rows.find(r => r.action === 'ha.instance.demote')
      assert.ok(row, 'a demotion row')
      assert.deepEqual(row.details.everydayAdded, ['scene.goodnight', 'button.doorbell_test'])
      assert.equal(row.details.by, 'owner@example.com')
    } finally {
      setHAControlService(null); setApiTokenStore(null)
      if (isUnlocked()) await lock('manual')
      await app.close()
    }
  }
})

void http
