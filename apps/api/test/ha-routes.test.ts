// /api/ha over HTTP behind the real vault gate: viewers see status, writes are admin, applying a preview
// needs the master password re-entered, locked is 423. Plus the planted-marker check: no secret value
// lands in the audit log, a response, or the log output, even when Proxmox echoes it in an error.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { buildHaRoutes } from '../src/routes/ha'
import { HaPlanner } from '../src/lib/ha/plans'
import { redactSecrets } from '../src/lib/ha'
import { requiredRole, needsReconfirm } from '../src/lib/roles'
import { FakeBroker } from './fakes/fake-broker'
import { signIn } from './fakes/app'
import { threeNodes, type FakeHaPve } from './ha-fake'

const MARKER = 'PLANTED-SECRET-7f3c9a1e5b'
const broker = new FakeBroker()
broker.addUser('admin@example.com', 'admin master password', 'admin')
broker.addUser('viewer@example.com', 'viewer master password', 'viewer')

let app: FastifyInstance
let fake: FakeHaPve
const audit: any[] = []
const logs: string[] = []

before(async () => {
  setBroker(broker)
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  process.env.PROXMOX_TOKEN_SECRET = MARKER
  fake = threeNodes()
  const planner = new HaPlanner({
    pve: () => fake, isLocked: () => !isUnlocked(),
    // The production audit writer passes details through redactSecrets; the same here.
    audit: async (action, resource, details) => { audit.push({ action, resource, details: redactSecrets(details, [MARKER]) }) },
  })
  app = Fastify({ logger: { level: 'info', stream: { write: (l: string) => { logs.push(l) } } } })
  await registerGate(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(buildHaRoutes({ planner: () => planner, pve: () => fake, cacheMs: 0 }), { prefix: '/api/ha' })
  await app.ready()
})
beforeEach(async () => { if (isUnlocked()) await lock('manual') })
after(async () => { if (isUnlocked()) await lock('manual'); await app.close(); delete process.env.PROXMOX_TOKEN_SECRET })

test('role matrix: reads viewer, writes admin, apply re-confirmed', () => {
  assert.equal(requiredRole('GET', '/api/ha/overview'), 'viewer')
  assert.equal(requiredRole('GET', '/api/ha/guests/lxc/901/preflight'), 'viewer')
  assert.equal(requiredRole('GET', '/api/ha/something-new'), 'admin')
  assert.equal(requiredRole('POST', '/api/ha/preview'), 'admin')
  assert.equal(requiredRole('POST', '/api/ha/plans/x/apply'), 'admin')
  assert.equal(needsReconfirm('POST', '/api/ha/plans/x/apply'), true)
  assert.equal(needsReconfirm('POST', '/api/ha/preview'), false)
})

test('locked: 423 for reads and writes', async () => {
  for (const [method, url] of [['GET', '/api/ha/overview'], ['POST', '/api/ha/preview']] as const) {
    assert.equal((await app.inject({ method, url, payload: method === 'POST' ? {} : undefined })).statusCode, 423)
  }
})

test('viewer: sees status, cannot preview', async () => {
  const { cookie } = await signIn(app, 'viewer@example.com', 'viewer master password')
  const ov = await app.inject({ method: 'GET', url: '/api/ha/overview', headers: { cookie } })
  assert.equal(ov.statusCode, 200)
  assert.match(ov.json().data.cluster.headline, /HA is armed/)
  const g = await app.inject({ method: 'GET', url: '/api/ha/guests/lxc/901', headers: { cookie } })
  assert.match(g.json().data.statusLine, /Not protected/)
  const pv = await app.inject({ method: 'POST', url: '/api/ha/preview', headers: { cookie }, payload: { action: 'protect', sid: 'ct:901' } })
  assert.equal(pv.statusCode, 403)
})

test('admin: preview, apply refused until re-confirmed, then applied and audited without secrets', async () => {
  fake.resources = []; fake.rules = []
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const pv = await app.inject({ method: 'POST', url: '/api/ha/preview', headers: { cookie }, payload: { action: 'protect', sid: 'ct:901' } })
  assert.equal(pv.statusCode, 200, pv.body)
  const id = pv.json().data.id
  const noConfirm = await app.inject({ method: 'POST', url: `/api/ha/plans/${id}/apply`, headers: { cookie } })
  assert.equal(noConfirm.json().code, 'reconfirm_required')
  await app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie }, payload: { password: 'admin master password' } })
  const ap = await app.inject({ method: 'POST', url: `/api/ha/plans/${id}/apply`, headers: { cookie } })
  assert.equal(ap.statusCode, 200, ap.body)
  assert.equal(ap.json().data.ok, true)
  assert.equal(fake.resources.length, 1)
  assert.ok(audit.some(a => a.action === 'ha.protect' && a.details.ok === true))
})

test('a refused preview comes back with its problems and fix, as 409', async () => {
  fake.resources = []; fake.rules = []
  fake.addResource('ct:901'); fake.addResource('ct:902')
  fake.addRule({ rule: 'h', type: 'node-affinity', resources: 'ct:901', nodes: 'node-a:2,node-b:1' })
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const r = await app.inject({ method: 'POST', url: '/api/ha/preview', headers: { cookie }, payload: { action: 'create-rule', rule: { id: 'apart', type: 'resource-affinity', affinity: 'negative', resources: ['ct:901', 'ct:902'] } } })
  assert.equal(r.statusCode, 409)
  assert.equal(r.json().problems[0].fix.rule, 'h')
})

test('planted marker: a secret echoed by Proxmox never reaches the audit log, a response or the logs', async () => {
  fake.resources = []; fake.rules = []
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const pv = await app.inject({ method: 'POST', url: '/api/ha/preview', headers: { cookie }, payload: { action: 'protect', sid: 'ct:902' } })
  await app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie }, payload: { password: 'admin master password' } })
  fake.failWrites = `token PVEAPIToken=x=${MARKER} rejected`
  const ap = await app.inject({ method: 'POST', url: `/api/ha/plans/${pv.json().data.id}/apply`, headers: { cookie } })
  fake.failWrites = null
  assert.equal(ap.json().data.ok, false)
  assert.ok(audit.length > 0)
  assert.ok(!JSON.stringify(audit).includes(MARKER), 'audit log is clean')
  assert.ok(!logs.join('\n').includes(MARKER), 'log output is clean')
  // The HA response itself: the person sees Proxmox's refusal, never a credential HyperProx holds.
  assert.ok(!ap.body.includes(MARKER), 'response is clean')
})
