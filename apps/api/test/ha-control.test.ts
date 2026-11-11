// Home Assistant control: the allow-list, instances and their migration, the safety tiers, the read-back, the
// rate limit, the audit rows, and that an action for one house can never reach another. Two pretend Home
// Assistants on loopback (REST and WebSocket); nothing real is contacted.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import {
  buildServiceCall, controlsFor, tierOf, confirmPhrase, ActionRefusal, DEFAULT_POLICY, type HAState,
} from '../src/lib/ha-control/catalog'
import { InstanceStore, DEFAULT_ID } from '../src/lib/ha-control/instances'
import { HAControlService, type Actor } from '../src/lib/ha-control/service'
import { HttpHAClient } from '../src/lib/ha-control/client'
import { requiredRole, needsReconfirm } from '../src/lib/roles'
import { remoteRouteAllowed } from '../src/lib/clusters/context'
import { familyOf } from '../src/lib/notify/types'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { haControlRoutes, setHAControlService } from '../src/routes/ha-control'
import { pluginRoutes } from '../src/routes/plugins'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { MemoryApiTokenStore, setApiTokenStore, createApiToken } from '../src/lib/api-tokens'
import { FakeBroker } from './fakes/fake-broker'
import { signIn } from './fakes/app'

import { TOKEN_A, TOKEN_B, st, fakeHA, memIO, HOUSE_A, openResolver, testClient, type FakeHA } from './ha-control-fake'

let A: FakeHA, B: FakeHA
const audits: Array<{ action: string; resource: string; details: Record<string, unknown> }> = []
const published: any[] = []
const owner: Actor = { sid: 's-owner', email: 'owner@example.com', role: 'owner', token: null }
const operator: Actor = { sid: 's-op', email: 'op@example.com', role: 'operator', token: null }

before(async () => {
  A = await fakeHA(TOKEN_A, HOUSE_A(), [{ area: 'Kitchen', entities: ['light.kitchen'] }, { area: 'Hall', entities: ['lock.front_door'] }])
  B = await fakeHA(TOKEN_B, [st('light.kitchen', 'off', { friendly_name: 'Kitchen at B' }), st('light.only_b', 'off')])
})
after(() => { A.server.close(); B.server.close() })

let clock = 1_000_000
async function twoHouses() {
  const io = memIO({ 'plugin/home-assistant/url': A.url, 'plugin/home-assistant/token': TOKEN_A })
  const store = new InstanceStore(io, id => id === 'c0123456789', openResolver)
  const b = await store.create({ name: 'Second home', url: B.url, token: TOKEN_B, clusterId: 'c0123456789' })
  audits.length = 0; published.length = 0
  const svc = new HAControlService({
    store, clientFor: testClient, audit: async (action, resource, details) => { audits.push({ action, resource, details }) },
    publish: async e => { published.push(e) },
    cluster: id => id === 'c0123456789' ? { id, name: 'Remote server', kind: 'remote' } : null,
    sleep: async () => {}, readBack: { tries: 3, everyMs: 0 }, now: () => clock,
  })
  return { io, store, svc, b: b.id }
}

beforeEach(() => {
  for (const [id, s] of new Map(HOUSE_A().map(s => [s.entity_id, s]))) A.states.set(id, s)
  A.calls.length = 0; B.calls.length = 0; A.up = true; A.isAdmin = false
})

// ── The allow-list ───────────────────────────────────────────────────────────

test('allow-list: each action maps to exactly one service, values checked against the entity', () => {
  const light = st('light.k', 'off', { supported_color_modes: ['color_temp'], min_color_temp_kelvin: 2200, max_color_temp_kelvin: 6500 })
  assert.deepEqual(buildServiceCall(light, 'turn_on', undefined), { domain: 'light', service: 'turn_on', data: { entity_id: 'light.k' } })
  assert.deepEqual(buildServiceCall(light, 'brightness', 40).data, { entity_id: 'light.k', brightness_pct: 40 })
  assert.deepEqual(buildServiceCall(light, 'color_temp', 3000).data, { entity_id: 'light.k', color_temp_kelvin: 3000 })
  for (const [s, a, v] of [[light, 'brightness', 101], [light, 'brightness', 'x'], [light, 'color_temp', 1500], [light, 'turn_on', 5]] as const) {
    assert.throws(() => buildServiceCall(s, a, v), (e: any) => e instanceof ActionRefusal && e.code === 'bad_value', `${a} ${v}`)
  }
  // Not in the table: refused, whatever Home Assistant itself would allow.
  assert.throws(() => buildServiceCall(light, 'toggle_everything', undefined), (e: any) => e.code === 'action_not_allowed')
  assert.throws(() => buildServiceCall(light, '__proto__', undefined), (e: any) => e.code === 'action_not_allowed')
  assert.throws(() => buildServiceCall(st('shell_command.x', 'idle'), 'run', undefined), (e: any) => e.code === 'domain_not_allowed')
  assert.throws(() => buildServiceCall(st('homeassistant.x', 'idle'), 'restart', undefined), (e: any) => e.code === 'domain_not_allowed')

  const climate = st('climate.l', 'heat', { hvac_modes: ['off', 'heat'], min_temp: 7, max_temp: 30, temperature: 20 })
  assert.deepEqual(buildServiceCall(climate, 'target_temperature', 21.5).data, { entity_id: 'climate.l', temperature: 21.5 })
  assert.throws(() => buildServiceCall(climate, 'target_temperature', 31), (e: any) => e.code === 'bad_value')
  assert.deepEqual(buildServiceCall(climate, 'hvac_mode', 'off'), { domain: 'climate', service: 'set_hvac_mode', data: { entity_id: 'climate.l', hvac_mode: 'off' }, shown: 'off' })
  assert.throws(() => buildServiceCall(climate, 'hvac_mode', 'cool'), (e: any) => e.code === 'bad_value')

  const media = st('media_player.tv', 'playing', { volume_level: 0.3 })
  assert.deepEqual(buildServiceCall(media, 'volume', 55).data, { entity_id: 'media_player.tv', volume_level: 0.55 })
  assert.equal(buildServiceCall(st('cover.b', 'open', { current_position: 50 }), 'position', 20).service, 'set_cover_position')
  assert.equal(buildServiceCall(st('fan.f', 'on', { percentage: 33 }), 'speed', 66).service, 'set_percentage')
  assert.equal(buildServiceCall(st('vacuum.v', 'docked'), 'dock', undefined).service, 'return_to_base')
  assert.equal(buildServiceCall(st('button.b', 'unknown'), 'press', undefined).service, 'press')
  assert.equal(buildServiceCall(st('scene.s', 'x'), 'run', undefined).service, 'turn_on')
  assert.equal(buildServiceCall(st('lock.l', 'locked'), 'unlock', undefined).service, 'unlock')
  assert.equal(buildServiceCall(st('alarm_control_panel.a', 'disarmed'), 'arm_away', undefined).service, 'alarm_arm_away')

  // Controls come from what the entity says it supports.
  assert.deepEqual(controlsFor(st('light.plain', 'on', { supported_color_modes: ['onoff'] })).map(c => c.action), ['turn_on', 'turn_off'])
  assert.deepEqual(controlsFor(climate).map(c => c.action), ['target_temperature', 'hvac_mode'])
  assert.deepEqual(controlsFor(st('sensor.t', '1')), [])
})

test('tiers: locks, alarms, sirens, garage/gate/door covers and protected devices are security', () => {
  const p = DEFAULT_POLICY
  assert.equal(tierOf(st('lock.x', 'locked'), p), 'security')
  assert.equal(tierOf(st('alarm_control_panel.x', 'armed_away'), p), 'security')
  assert.equal(tierOf(st('siren.x', 'off'), p), 'security')
  for (const dc of ['garage', 'gate', 'door']) assert.equal(tierOf(st('cover.x', 'closed', { device_class: dc }), p), 'security')
  assert.equal(tierOf(st('cover.x', 'closed', { device_class: 'blind' }), p), 'normal')
  assert.equal(tierOf(st('switch.heater', 'off', { device_class: 'outlet' }), p), 'normal')
  assert.equal(tierOf(st('switch.heater', 'off', { device_class: 'outlet' }), { ...p, protected: ['switch.heater'] }), 'security')
  assert.equal(tierOf(st('light.any', 'off'), { ...p, securityDomains: ['light'] }), 'security')
  assert.equal(confirmPhrase(st('lock.f', 'locked', { friendly_name: 'Front door' }), 'unlock', undefined, 'Second home'), 'Unlock Front door at Second home')
})

// ── Instances ────────────────────────────────────────────────────────────────

test('migration: the existing single configuration is instance #1, read in place, nothing written', async () => {
  const io = memIO({ 'plugin/home-assistant/url': 'http://ha.local:8123', 'plugin/home-assistant/token': TOKEN_A, 'plugin/home-assistant/battery_warn': '15' })
  const before = new Map(io.data)
  const store = new InstanceStore(io, undefined, openResolver)
  const list = await store.list()
  assert.equal(list.length, 1)
  assert.deepEqual({ id: list[0].id, name: list[0].name, clusterId: list[0].clusterId, insecureTLS: list[0].insecureTLS }, { id: DEFAULT_ID, name: 'Home', clusterId: null, insecureTLS: false })
  assert.deepEqual((await store.connection(DEFAULT_ID)), { url: 'http://ha.local:8123', token: TOKEN_A, insecureTLS: false, fingerprint: null })
  const views = await store.views()
  assert.equal(views[0].hasToken, true)
  assert.equal(JSON.stringify(views).includes(TOKEN_A), false)
  assert.deepEqual(io.data, before, 'reading the instances writes nothing')

  // Not configured: no instance. The first one created becomes the plug-in's own settings.
  const empty = memIO()
  const s2 = new InstanceStore(empty, id => id === 'c0123456789', openResolver)
  assert.deepEqual(await s2.list(), [])
  const first = await s2.create({ name: 'Home', url: 'http://ha.local:8123', token: TOKEN_A })
  assert.equal(first.id, DEFAULT_ID)
  assert.equal(empty.data.get('plugin/home-assistant/url'), 'http://ha.local:8123')
  assert.equal(empty.data.get('plugin/home-assistant/token'), TOKEN_A)
  const second = await s2.create({ name: 'Second home', url: 'https://ha2.example:8123', token: TOKEN_B })
  assert.match(second.id, /^h[0-9a-f]{8}$/)
  assert.equal(empty.data.get(`plugin/home-assistant.${second.id}/token`), TOKEN_B)
  assert.equal([...empty.data.get('plugin/home-assistant/instances')!].join('').includes(TOKEN_B), false, 'the list holds no token')

  // Edits: an empty token keeps the stored one; bad input is refused plainly.
  await s2.update(second.id, { token: '', name: 'Cottage' })
  assert.equal(empty.data.get(`plugin/home-assistant.${second.id}/token`), TOKEN_B)
  await assert.rejects(s2.create({ name: 'cottage', url: 'http://x:1', token: TOKEN_B }), /already has that name/)
  await assert.rejects(s2.create({ name: 'X', url: 'ftp://x', token: TOKEN_B }), /http/)
  await assert.rejects(s2.create({ name: 'Y', url: 'http://user:pw@x', token: TOKEN_B }), /login out of the address/)
  await assert.rejects(s2.update(second.id, { clusterId: 'cnotreal000' }), /not one HyperProx manages/)
  await assert.rejects(s2.update(second.id, { policy: { normalRole: 'viewer' } }), /operators or admins/)
  await assert.rejects(s2.update(second.id, { policy: { protected: ['not an id'] } }), /not an entity id/)
  await assert.rejects(s2.remove(DEFAULT_ID), /plug-in's own settings/)
  await s2.remove(second.id)
  assert.equal(empty.data.has(`plugin/home-assistant.${second.id}/token`), false)
})

// ── The service against the pretend houses ──────────────────────────────────

test('devices: grouped by area, only controllable domains, security marked with the confirm phrase', async () => {
  const { svc } = await twoHouses()
  const d = await svc.devices(DEFAULT_ID)
  assert.equal(d.areaSource, 'registry')
  assert.deepEqual(d.areas.map(a => a.name), ['Hall', 'Kitchen', 'No area'])
  const all = d.areas.flatMap(a => a.devices)
  assert.equal(all.some(x => x.entityId === 'sensor.temp'), false, 'sensors are not controls')
  const lockRow = all.find(x => x.entityId === 'lock.front_door')!
  assert.equal(lockRow.tier, 'security')
  assert.equal(lockRow.controls.find(c => c.action === 'unlock')!.confirm, 'Unlock Front door at Home')
  assert.equal(all.find(x => x.entityId === 'cover.garage')!.tier, 'security')
  assert.equal(all.find(x => x.entityId === 'switch.gone')!.unavailable, true)
  assert.equal(JSON.stringify(d).includes(TOKEN_A), false)
})

test('action: done, with the real state read back', async () => {
  const { svc } = await twoHouses()
  const r = await svc.act(DEFAULT_ID, { entityId: 'light.kitchen', action: 'brightness', value: 40 }, operator, false)
  assert.equal(r.changed, true)
  assert.equal(r.after!.state, 'on')
  assert.deepEqual(A.calls, ['light.turn_on {"entity_id":"light.kitchen","brightness_pct":40}'])
  const t = await svc.act(DEFAULT_ID, { entityId: 'climate.lounge', action: 'target_temperature', value: 22 }, operator, false)
  assert.equal(t.changed, true)
})

test('action: a device that does not change is said plainly', async () => {
  const { svc } = await twoHouses()
  const r = await svc.act(DEFAULT_ID, { entityId: 'switch.stuck', action: 'turn_on' }, operator, false)
  assert.equal(r.ok, true)
  assert.equal(r.changed, false)
  assert.match(r.message, /still reads "off"/)
  assert.equal(audits.at(-1)!.details.result, 'unconfirmed')
})

test('entity validation: only entities in the instance\'s current list, never unavailable ones', async () => {
  const { svc } = await twoHouses()
  for (const [entityId, code] of [['light.only_b', 'unknown_entity'], ['light.nope', 'unknown_entity'], ['LIGHT.x', 'bad_entity'], ['light.kitchen/../x', 'bad_entity'], ['sensor.temp', 'domain_not_allowed'], ['switch.gone', 'unavailable']] as const) {
    await assert.rejects(svc.act(DEFAULT_ID, { entityId, action: 'turn_on' }, owner, false), (e: any) => e.code === code, entityId)
  }
  assert.deepEqual(A.calls, [])
})

test('security tier: admin, a person, the secure route and the exact confirm phrase', async () => {
  const { svc } = await twoHouses()
  const req = { entityId: 'lock.front_door', action: 'unlock' }
  await assert.rejects(svc.act(DEFAULT_ID, req, owner, false), (e: any) => e.code === 'security_action' && e.status === 409)
  const ok = { confirm: 'Unlock Front door at Home', typed: 'front door' }
  await assert.rejects(svc.act(DEFAULT_ID, { ...req, ...ok }, operator, true), (e: any) => e.code === 'forbidden')
  await assert.rejects(svc.act(DEFAULT_ID, { ...req, ...ok }, { ...owner, token: 'automation' }, true), (e: any) => e.code === 'token_forbidden')
  await assert.rejects(svc.act(DEFAULT_ID, { ...req, confirm: 'yes', typed: 'Front door' }, owner, true), (e: any) => e.code === 'confirm_required' && !('confirm' in e.extra))
  await assert.rejects(svc.act(DEFAULT_ID, { entityId: 'light.kitchen', action: 'turn_on' }, owner, true), (e: any) => e.code === 'not_security')
  assert.deepEqual(A.calls, [], 'nothing reached the house')

  const r = await svc.act(DEFAULT_ID, { ...req, ...ok }, owner, true)
  assert.equal(r.changed, true)
  assert.equal(r.tier, 'security')
  const done = published.filter(e => e.type === 'ha.security.action')
  assert.equal(done.length, 1)
  assert.equal(done[0].title, 'Unlock Front door at Home')
  // The refusals before it sent one warning, not one per refusal.
  assert.equal(published.filter(e => e.type === 'ha.security.refused').length, 1)
  assert.equal(familyOf('ha.security.action'), 'home')

  // A garage door is security too, and an owner-protected switch.
  await assert.rejects(svc.act(DEFAULT_ID, { entityId: 'cover.garage', action: 'open' }, owner, false), (e: any) => e.code === 'security_action')
  await assert.rejects(svc.act(DEFAULT_ID, { entityId: 'cover.blind', action: 'open' }, owner, true), (e: any) => e.code === 'not_security')
})

test('API tokens: everyday controls only when the token role allows; the instance can raise the role', async () => {
  const { svc, store } = await twoHouses()
  const viewerToken: Actor = { sid: 'token:1', email: 'token:v', role: 'viewer', token: 'v' }
  const opToken: Actor = { sid: 'token:2', email: 'token:o', role: 'operator', token: 'o' }
  await assert.rejects(svc.act(DEFAULT_ID, { entityId: 'light.kitchen', action: 'turn_on' }, viewerToken, false), (e: any) => e.code === 'forbidden')
  assert.equal((await svc.act(DEFAULT_ID, { entityId: 'light.kitchen', action: 'turn_on' }, opToken, false)).changed, true)
  await store.update(DEFAULT_ID, { policy: { normalRole: 'admin' } })
  await assert.rejects(svc.act(DEFAULT_ID, { entityId: 'light.kitchen', action: 'turn_off' }, opToken, false), (e: any) => e.code === 'forbidden' && /admin/.test(e.message))
})

test('rate limit: per session, security tighter than everyday', async () => {
  const io = memIO({ 'plugin/home-assistant/url': A.url, 'plugin/home-assistant/token': TOKEN_A })
  const svc = new HAControlService({ store: new InstanceStore(io, undefined, openResolver), clientFor: testClient, audit: async () => {}, sleep: async () => {}, readBack: { tries: 1, everyMs: 0 }, limits: { normalPerMinute: 3, securityPerMinute: 1, devicesPerMinute: 40 } })
  for (let i = 0; i < 3; i++) await svc.act(DEFAULT_ID, { entityId: 'light.kitchen', action: i % 2 ? 'turn_off' : 'turn_on' }, operator, false)
  await assert.rejects(svc.act(DEFAULT_ID, { entityId: 'light.kitchen', action: 'turn_on' }, operator, false), (e: any) => e.code === 'rate_limited' && e.status === 429)
  // Another session is not held up by this one.
  await svc.act(DEFAULT_ID, { entityId: 'light.kitchen', action: 'turn_on' }, { ...operator, sid: 's-other' }, false)
  const lockReq = { entityId: 'lock.front_door', action: 'unlock', confirm: 'Unlock Front door at Home', typed: 'Front door' }
  await svc.act(DEFAULT_ID, lockReq, owner, true)
  await assert.rejects(svc.act(DEFAULT_ID, { ...lockReq, action: 'lock', confirm: 'Lock Front door at Home' }, owner, true), (e: any) => e.code === 'rate_limited')
})

test('audit: who, instance, entity, action and result, and never the token', async () => {
  const { svc } = await twoHouses()
  await svc.act(DEFAULT_ID, { entityId: 'light.kitchen', action: 'turn_on' }, operator, false)
  await assert.rejects(svc.act(DEFAULT_ID, { entityId: 'lock.front_door', action: 'unlock' }, operator, false))
  assert.equal(audits.length, 2)
  const [done, refused] = audits
  assert.equal(done.action, 'ha.action')
  assert.equal(done.resource, 'home-assistant:default')
  assert.deepEqual({ by: done.details.by, instance: done.details.instance, entity: done.details.entity, action: done.details.action, result: done.details.result, via: done.details.via },
    { by: 'op@example.com', instance: 'Home', entity: 'light.kitchen', action: 'turn_on', result: 'done', via: 'session' })
  assert.equal(refused.details.result, 'refused:security_action')
  const text = JSON.stringify(audits)
  assert.equal(text.includes(TOKEN_A) || text.includes(TOKEN_B), false)
})

test('isolation: an action for one house never reaches the other, and never carries its token', async () => {
  const { svc, b } = await twoHouses()
  await svc.act(b, { entityId: 'light.kitchen', action: 'turn_on' }, operator, false)
  assert.equal(B.calls.length, 1)
  assert.equal(A.calls.length, 0)
  assert.equal(B.states.get('light.kitchen')!.state, 'on')
  assert.equal(A.states.get('light.kitchen')!.state, 'off')
  // B's entity list decides what B accepts: house A's lock does not exist there.
  await assert.rejects(svc.act(b, { entityId: 'lock.front_door', action: 'unlock', confirm: 'Unlock Front door at Second home', typed: 'Front door' }, owner, true), (e: any) => e.code === 'unknown_entity')
  assert.equal(A.seenAuth.has(`Bearer ${TOKEN_B}`), false)
  assert.equal(B.seenAuth.has(`Bearer ${TOKEN_A}`), false)
  // On a remote cluster's page, only that cluster's houses answer.
  await assert.rejects(svc.act(DEFAULT_ID, { entityId: 'light.kitchen', action: 'turn_on' }, operator, false, 'c0123456789'), (e: any) => e.code === 'wrong_cluster')
  await assert.rejects(svc.devices(DEFAULT_ID, 'c0123456789'), (e: any) => e.code === 'wrong_cluster')
  assert.equal((await svc.devices(b, 'c0123456789')).areas.length, 1)
})

test('unreachable: a plain reason, no address and no token in it', async () => {
  const { svc } = await twoHouses()
  A.up = false
  const st1 = await svc.status(DEFAULT_ID)
  assert.equal(st1.reachable, false)
  assert.equal(String(st1.error).includes('127.0.0.1') || String(st1.error).includes(TOKEN_A), false)
  await assert.rejects(svc.act(DEFAULT_ID, { entityId: 'light.kitchen', action: 'turn_on' }, operator, false), (e: any) => e.code === 'unreachable' && !e.message.includes(TOKEN_A))
  await assert.rejects(svc.devices(DEFAULT_ID), (e: any) => e.name === 'HAUnreachableError')
  A.up = true
  clock += 11_000   // status is cached for 10 seconds per house
  const ok = await svc.status(DEFAULT_ID)
  assert.deepEqual({ reachable: ok.reachable, version: ok.version, user: ok.user }, { reachable: true, version: '2026.11.0', user: { name: 'hyperprox', isAdmin: false, isOwner: false } })
  A.isAdmin = true
  clock += 11_000
  assert.equal((await svc.status(DEFAULT_ID)).user!.isAdmin, true, 'an admin-user token is detected')
  // A wrong token is refused by name, not with the token in the message.
  const bad = new HttpHAClient({ url: A.url, token: 'wrongwrongwrongwrongwrong', insecureTLS: false }, 10_000, openResolver)
  await assert.rejects(bad.states(), (e: any) => /refused the token/.test(e.message) && !e.message.includes('wrongwrong'))
})

// ── The gate ─────────────────────────────────────────────────────────────────

test('roles: everyday actions operator, security and instance changes admin and re-confirmed', () => {
  const base = '/api/plugins/home-assistant/instances'
  assert.equal(requiredRole('GET', `${base}/default/devices`), 'viewer')
  assert.equal(requiredRole('POST', `${base}/default/actions`), 'operator')
  assert.equal(needsReconfirm('POST', `${base}/default/actions`), false)
  assert.equal(requiredRole('POST', `${base}/default/secure-actions`), 'admin')
  assert.equal(needsReconfirm('POST', `${base}/default/secure-actions`), true)
  for (const [m, p] of [['POST', base], ['PUT', `${base}/h0123abcd`], ['DELETE', `${base}/h0123abcd`]]) {
    assert.equal(requiredRole(m, p), 'admin', `${m} ${p}`)
    assert.equal(needsReconfirm(m, p), true, `${m} ${p}`)
  }
  assert.equal(remoteRouteAllowed('POST', `${base}/h0123abcd/actions`), true)
  assert.equal(remoteRouteAllowed('POST', `${base}/h0123abcd/secure-actions`), true)
  assert.equal(remoteRouteAllowed('PUT', `${base}/h0123abcd`), false, 'instance settings are changed from the plug-ins page')
})

test('through the gate: operator acts, a lock needs re-confirmation, an API token never gets one', async () => {
  const broker = new FakeBroker()
  broker.addUser('owner@example.com', 'owner master password', 'owner')
  broker.addUser('op@example.com', 'operator master password', 'operator')
  setBroker(broker)
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  const tokens = new MemoryApiTokenStore()
  setApiTokenStore(tokens)
  const { svc } = await twoHouses()
  setHAControlService(svc)
  const app: FastifyInstance = Fastify({ logger: false })
  await registerGate(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  // Registered beside the generic plug-in routes, as index.ts does: neither shadows the other.
  await app.register(pluginRoutes, { prefix: '/api/plugins' })
  await app.register(haControlRoutes, { prefix: '/api/plugins/home-assistant' })
  await app.ready()
  try {
    const ownerCookie = (await signIn(app, 'owner@example.com', 'owner master password')).cookie
    const opCookie = (await signIn(app, 'op@example.com', 'operator master password')).cookie
    assert.ok(ownerCookie && opCookie)
    const call = (method: string, url: string, headers: Record<string, string>, payload?: unknown) =>
      app.inject({ method: method as any, url: `/api/plugins/home-assistant${url}`, headers, payload: payload as any })

    const list = await call('GET', '/instances', { cookie: opCookie })
    assert.equal(list.statusCode, 200)
    assert.equal(list.body.includes(TOKEN_A) || list.body.includes(TOKEN_B), false, 'no token in any answer')

    const r = await call('POST', '/instances/default/actions', { cookie: opCookie }, { entityId: 'light.kitchen', action: 'turn_on' })
    assert.equal(r.statusCode, 200, r.body)
    assert.equal(r.json().data.changed, true)

    const lockBody = { entityId: 'lock.front_door', action: 'unlock', confirm: 'Unlock Front door at Home', typed: 'Front door' }
    assert.equal((await call('POST', '/instances/default/secure-actions', { cookie: opCookie }, lockBody)).statusCode, 403)
    const needs = await call('POST', '/instances/default/secure-actions', { cookie: ownerCookie }, lockBody)
    assert.equal(needs.json().code, 'reconfirm_required')
    // The everyday route does not take the lock either, re-confirmed or not.
    assert.equal((await call('POST', '/instances/default/actions', { cookie: ownerCookie }, lockBody)).json().code, 'security_action')

    const tok = (await createApiToken({ name: 'automation', role: 'admin' }, 'test', tokens)).token
    const viaToken = await call('POST', '/instances/default/secure-actions', { authorization: `Bearer ${tok}` }, lockBody)
    assert.equal(viaToken.statusCode, 403)
    assert.equal(viaToken.json().code, 'reconfirm_required')
    const tokNormal = await call('POST', '/instances/default/actions', { authorization: `Bearer ${tok}` }, { entityId: 'light.kitchen', action: 'turn_off' })
    assert.equal(tokNormal.statusCode, 200, tokNormal.body)
    assert.equal(A.calls.filter(c => c.startsWith('lock.')).length, 0, 'no lock call yet')

    await app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie: ownerCookie }, payload: { password: 'owner master password' } })
    const ok = await call('POST', '/instances/default/secure-actions', { cookie: ownerCookie }, lockBody)
    assert.equal(ok.statusCode, 200, ok.body)
    assert.equal(ok.json().data.after.state, 'unlocked')
    const noConfirm = await call('POST', '/instances/default/secure-actions', { cookie: ownerCookie }, { ...lockBody, action: 'lock', confirm: undefined })
    assert.equal(noConfirm.statusCode, 409)
    assert.equal(noConfirm.json().confirm, undefined, 'the answer never says what the phrase should be')

    const wishlist = await app.inject({ method: 'GET', url: '/api/plugins/wishlist', headers: { cookie: opCookie } })
    assert.equal(wishlist.statusCode, 200, 'the generic plug-in routes still answer')

    // Adding an instance is re-confirmed for the operator too (and refused by role first).
    assert.equal((await call('POST', '/instances', { cookie: opCookie }, { name: 'X', url: B.url, token: TOKEN_B })).statusCode, 403)
  } finally {
    setHAControlService(null); setApiTokenStore(null)
    if (isUnlocked()) await lock('manual')
    await app.close()
  }
})
