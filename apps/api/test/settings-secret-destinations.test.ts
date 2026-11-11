// Settings → connections: moving where a provider's secret is sent needs that secret again in the same save, every
// save or test needs the master password again, and an API token can do neither. Real gate and routes, fake vault.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { settingsRoutes, settingsSaveProblem } from '../src/routes/settings'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { MemoryApiTokenStore, setApiTokenStore, createApiToken } from '../src/lib/api-tokens'
import { FakeBroker } from './fakes/fake-broker'
import { signIn } from './fakes/app'

const broker = new FakeBroker()
broker.addUser('admin@example.com', 'admin master password', 'admin')
broker.items.set('hyperprox:proxmox/proxmox', { id: 'p1', name: 'hyperprox:proxmox/proxmox', fields: { host: '192.0.2.10', port: '8006', token_secret: 'pve-secret' } })
broker.items.set('hyperprox:proxy/npm', { id: 'n1', name: 'hyperprox:proxy/npm', fields: { url: 'http://192.0.2.20:81', email: 'a@example.com', password: 'npm-pw' } })
let app: FastifyInstance
const store = new MemoryApiTokenStore()

before(async () => {
  setBroker(broker)
  setApiTokenStore(store)
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  app = Fastify({ logger: false })
  await registerGate(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(settingsRoutes, { prefix: '/api/settings' })
  await app.ready()
})
after(async () => { setApiTokenStore(null); if (isUnlocked()) await lock('manual'); await app.close() })

test('the rule: a changed address needs its secret in the same save; the first address and same-origin edits do not', () => {
  const stored = { host: '192.0.2.10', port: '8006', token_secret: 's' }
  assert.match(settingsSaveProblem('proxmox', 'proxmox', stored, { host: '198.51.100.9' })!, /Token Secret again/)
  assert.match(settingsSaveProblem('proxmox', 'proxmox', stored, { port: '9006' })!, /Token Secret/)
  assert.equal(settingsSaveProblem('proxmox', 'proxmox', stored, { host: '198.51.100.9', token_secret: 'new' }), null)
  assert.equal(settingsSaveProblem('proxmox', 'proxmox', stored, { host: '192.0.2.10' }), null)
  assert.equal(settingsSaveProblem('proxmox', 'proxmox', {}, { host: '198.51.100.9' }), null)
  const npm = { url: 'http://192.0.2.20:81', password: 'p' }
  assert.equal(settingsSaveProblem('proxy', 'npm', npm, { url: 'http://192.0.2.20:81/' }), null, 'same origin')
  assert.match(settingsSaveProblem('proxy', 'npm', npm, { url: 'https://evil.example' })!, /Password/)
  assert.match(settingsSaveProblem('ai', 'openai', { base_url: 'https://api.openai.com/v1', api_key: 'k' }, { base_url: 'https://evil.example/v1' })!, /API Key/)
  assert.match(settingsSaveProblem('remote', 'netbird', { management_url: 'https://api.netbird.io', api_token: 't' }, { management_url: 'https://evil.example' })!, /access token/)
})

test('saving needs the master password again, then refuses a moved address without its secret', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const first = await app.inject({ method: 'PUT', url: '/api/settings/proxmox/proxmox', headers: { cookie }, payload: { host: '198.51.100.9' } })
  assert.equal(first.statusCode, 403)
  assert.equal(first.json().code, 'reconfirm_required')
  const test1 = await app.inject({ method: 'POST', url: '/api/settings/test/proxy/npm', headers: { cookie } })
  assert.equal(test1.json().code, 'reconfirm_required')

  const rc = await app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie }, payload: { password: 'admin master password' } })
  assert.equal(rc.statusCode, 200)
  const moved = await app.inject({ method: 'PUT', url: '/api/settings/proxmox/proxmox', headers: { cookie }, payload: { host: '198.51.100.9' } })
  assert.equal(moved.statusCode, 400, moved.body)
  assert.equal(moved.json().code, 'secret_required')
  assert.equal(broker.items.get('hyperprox:proxmox/proxmox')!.fields.host, '192.0.2.10', 'nothing was saved')

  const withSecret = await app.inject({ method: 'PUT', url: '/api/settings/proxmox/proxmox', headers: { cookie }, payload: { host: '198.51.100.9', token_secret: 'new-secret' } })
  assert.equal(withSecret.statusCode, 200, withSecret.body)
  const npm = await app.inject({ method: 'PUT', url: '/api/settings/proxy/npm', headers: { cookie }, payload: { url: 'https://evil.example' } })
  assert.equal(npm.statusCode, 400, npm.body)
  const bad = await app.inject({ method: 'PUT', url: '/api/settings/proxy/npm', headers: { cookie }, payload: { url: ['x'] } })
  assert.equal(bad.statusCode, 400)
})

test('an API token can read settings (admin) but never save or test a connection', async () => {
  const t = (await createApiToken({ name: 'auto', role: 'admin' }, 'test', store)).token
  const h = { authorization: `Bearer ${t}` }
  assert.equal((await app.inject({ method: 'GET', url: '/api/settings/proxmox', headers: h })).statusCode, 200)
  const put = await app.inject({ method: 'PUT', url: '/api/settings/proxmox/proxmox', headers: h, payload: { host: '198.51.100.9', token_secret: 'x' } })
  assert.equal(put.statusCode, 403)
  assert.equal(put.json().code, 'reconfirm_required')
  const tst = await app.inject({ method: 'POST', url: '/api/settings/test/proxy/npm', headers: h })
  assert.equal(tst.statusCode, 403)
})
