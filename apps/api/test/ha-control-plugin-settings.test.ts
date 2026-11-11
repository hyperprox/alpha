// Review finding 1: the generic plug-in settings route could move house #1 (or any plug-in) to another address
// and keep sending the stored credential there, with no re-confirmation and API tokens allowed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { needsReconfirm, requiredRole } from '../src/lib/roles'
import { settingsChangeProblem, type PluginManifest } from '../src/lib/plugin-host'
import { homeAssistantPlugin } from '../src/plugins/home-assistant'
import { plexPlugin } from '../src/plugins/plex'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { pluginRoutes } from '../src/routes/plugins'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { MemoryApiTokenStore, setApiTokenStore, createApiToken } from '../src/lib/api-tokens'
import { FakeBroker } from './fakes/fake-broker'
import { signIn } from './fakes/app'

test('finding 1: every plug-in settings save is admin and re-confirmed (which also keeps API tokens out)', () => {
  for (const id of ['home-assistant', 'plex', 'mikrotik', 'arrstack']) {
    assert.equal(requiredRole('PUT', `/api/plugins/${id}/settings`), 'admin')
    assert.equal(needsReconfirm('PUT', `/api/plugins/${id}/settings`), true, id)
  }
  assert.equal(needsReconfirm('GET', '/api/plugins/plex/detail'), false)
})

test('finding 1: an address that moves to another host or port needs its credential again in the same save', () => {
  const ha = homeAssistantPlugin.manifest
  const stored = { url: 'http://ha.lan:8123', token: 'stored-token' }
  assert.match(settingsChangeProblem(ha, stored, { url: 'http://elsewhere:8123', token: '' })!, /Long-lived token/)
  assert.match(settingsChangeProblem(ha, stored, { url: 'http://ha.lan:9999' })!, /again/)
  assert.equal(settingsChangeProblem(ha, stored, { url: 'http://elsewhere:8123', token: 'new-token' }), null)
  assert.equal(settingsChangeProblem(ha, stored, { url: 'http://ha.lan:8123/' }), null, 'same host and port')
  assert.equal(settingsChangeProblem(ha, stored, { battery_warn: '10' }), null)
  assert.equal(settingsChangeProblem(ha, {}, { url: 'http://first:8123', token: '' }), null, 'nothing stored yet: nothing to carry over')

  const basic: PluginManifest = {
    id: 'x', name: 'Router', description: '', kind: 'device', icon: '', baseUrlSetting: 'url',
    auth: { kind: 'basic', userSetting: 'user', passSetting: 'pass' },
    settings: [{ key: 'url', label: 'Address', type: 'url', required: true }, { key: 'user', label: 'User', type: 'text', required: true },
      { key: 'pass', label: 'Password', type: 'secret', required: true }, { key: 'url2', label: 'Second', type: 'url', required: false },
      { key: 'key2', label: 'Second key', type: 'secret', required: false }],
    endpoints: [{ key: 'two', label: 'Second box', baseUrlSetting: 'url2', auth: { kind: 'header', header: 'X-Key', fromSetting: 'key2' } }],
  }
  assert.match(settingsChangeProblem(basic, { url: 'https://a', pass: 'p' }, { url: 'https://b' })!, /Password/)
  assert.match(settingsChangeProblem(basic, { url2: 'https://a', key2: 'k' }, { url2: 'https://b' })!, /Second box.*Second key/)
  assert.equal(settingsChangeProblem(basic, { url2: 'https://a', key2: 'k' }, { url2: 'https://b', key2: 'k2' }), null)
})

test('finding 1: through the gate, the route refuses Home Assistant\'s address and token, and a moved address without its key', async () => {
  const broker = new FakeBroker()
  broker.addUser('owner@example.com', 'owner master password', 'owner')
  setBroker(broker)
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  broker.items.set('hyperprox:plugin/plex', { id: 'p1', name: 'hyperprox:plugin/plex', fields: { url: 'http://tautulli.lan:8181', apikey: 'old-key' } } as any)
  broker.items.set('hyperprox:plugin/home-assistant', { id: 'h1', name: 'hyperprox:plugin/home-assistant', fields: { url: 'http://ha.lan:8123', token: 'old-token' } } as any)
  const tokens = new MemoryApiTokenStore()
  setApiTokenStore(tokens)
  const app = Fastify({ logger: false })
  await registerGate(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(pluginRoutes, { prefix: '/api/plugins' })
  await app.ready()
  try {
    const cookie = (await signIn(app, 'owner@example.com', 'owner master password')).cookie
    const put = (id: string, payload: unknown, headers: Record<string, string> = { cookie }) => app.inject({ method: 'PUT', url: `/api/plugins/${id}/settings`, headers, payload: payload as any })

    assert.equal((await put('home-assistant', { url: 'http://attacker.lan:8123' })).json().code, 'reconfirm_required')
    const tok = (await createApiToken({ name: 'automation', role: 'admin' }, 'test', tokens)).token
    assert.equal((await put('home-assistant', { battery_warn: '10' }, { authorization: `Bearer ${tok}` })).json().code, 'reconfirm_required')

    await app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie }, payload: { password: 'owner master password' } })
    const ha = await put('home-assistant', { url: 'http://attacker.lan:8123' })
    assert.equal(ha.statusCode, 400)
    assert.equal(ha.json().code, 'use_instances')
    assert.equal((await put('home-assistant', { token: 'x'.repeat(30) })).json().code, 'use_instances')
    assert.equal((await put('home-assistant', { battery_warn: '15' })).statusCode, 200, 'other settings still save')

    const plex = await put('plex', { url: 'http://elsewhere.lan:8181', apikey: '' })
    assert.equal(plex.statusCode, 400)
    assert.equal(plex.json().code, 'credential_required')
    assert.equal((broker.items.get('hyperprox:plugin/plex') as any).fields.url, 'http://tautulli.lan:8181', 'nothing was saved')
    assert.equal((await put('plex', { url: 'http://elsewhere.lan:8181', apikey: 'new-key' })).statusCode, 200)
    assert.ok(plexPlugin)
  } finally {
    setApiTokenStore(null)
    if (isUnlocked()) await lock('manual')
    await app.close()
  }
})
