// /api/updates over HTTP, behind the real vault gate: admin only (reads included), 409 on a second job,
// and the policy rules for run vs dry-run. The cluster is the fake; the store is in memory.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import websocket from '@fastify/websocket'
import { buildUpdatesRoutes, updatesWsRoutes, updatesSubscriberCount } from '../src/routes/updates'
import { MemoryStore } from '../src/lib/updates/store'
import type { UpdatesRunner } from '../src/lib/updates/runner'
import { FakeBroker } from './fakes/fake-broker'
import { signIn } from './fakes/app'
import { FakeCluster, node, guest, policyLoad, FAST } from './updates-fake'

const broker = new FakeBroker()
broker.addUser('admin@example.com', 'admin master password', 'admin')
broker.addUser('op@example.com', 'operator master password', 'operator')
broker.addUser('viewer@example.com', 'viewer master password', 'viewer')

let app: FastifyInstance
let runner: UpdatesRunner
let store: MemoryStore
let fake: FakeCluster
let policyYaml: string | null = 'nodes:\n  default: { upgrade: upgrade, reboot: manual }\n'

before(async () => {
  setBroker(broker)
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  store = new MemoryStore()
  fake = new FakeCluster({ nodes: [node('node-a'), node('node-b')], guests: [guest(101, 'node-a')] })
  app = Fastify({ logger: false })
  await app.register(websocket)
  await registerGate(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(buildUpdatesRoutes({
    store, exec: fake, loadPolicy: () => policyLoad(policyYaml)(), timing: FAST,
    scheduler: false, recover: false, onRunner: r => { runner = r },
  }), { prefix: '/api/updates' })
  await app.register(updatesWsRoutes, { prefix: '/ws/updates' })
  await app.ready()
})
beforeEach(async () => { if (isUnlocked()) await lock('manual') })
after(async () => { if (isUnlocked()) await lock('manual'); await app.close() })

const READS = ['/api/updates/policy', '/api/updates/inventory', '/api/updates/plan', '/api/updates/jobs', '/api/updates/jobs/x']
const WRITES: Array<[string, any]> = [
  ['/api/updates/jobs', { mode: 'dry-run' }], ['/api/updates/jobs/x/confirm', {}], ['/api/updates/jobs/x/resume', {}],
  ['/api/updates/jobs/x/cancel', {}], ['/api/updates/nodes/node-a/reboot', {}], ['/api/updates/jobs/x/rollback', { target: '101' }],
]

test('locked: 423; no session: 401', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/updates/policy' })).statusCode, 423)
  const { cookie } = await signIn(app, 'viewer@example.com', 'viewer master password')
  assert.ok(cookie)
  assert.equal((await app.inject({ method: 'GET', url: '/api/updates/policy' })).statusCode, 401)
})

test('viewer and operator: 403 on every route, reads included', async () => {
  for (const [email, pw] of [['viewer@example.com', 'viewer master password'], ['op@example.com', 'operator master password']]) {
    const { cookie } = await signIn(app, email, pw)
    for (const url of READS) {
      const r = await app.inject({ method: 'GET', url, headers: { cookie } })
      assert.equal(r.statusCode, 403, `${email} GET ${url}`)
    }
    for (const [url, payload] of WRITES) {
      const r = await app.inject({ method: 'POST', url, headers: { cookie }, payload })
      assert.equal(r.statusCode, 403, `${email} POST ${url}`)
    }
  }
})

test('admin: policy, inventory, plan', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const pol = await app.inject({ method: 'GET', url: '/api/updates/policy', headers: { cookie } })
  assert.equal(pol.statusCode, 200)
  assert.equal(pol.json().loaded, true)
  const inv = await app.inject({ method: 'GET', url: '/api/updates/inventory?refresh=1', headers: { cookie } })
  assert.equal(inv.statusCode, 200)
  assert.deepEqual(inv.json().nodes.map((n: any) => n.node), ['node-a', 'node-b'])
  const plan = await app.inject({ method: 'GET', url: '/api/updates/plan', headers: { cookie } })
  assert.equal(plan.statusCode, 200)
  assert.ok(Array.isArray(plan.json().steps))
})

test('jobs: 201, then 409 with the running job id; confirm, list, get, cancel; audited', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const first = await app.inject({ method: 'POST', url: '/api/updates/jobs', headers: { cookie }, payload: { mode: 'run' } })
  assert.equal(first.statusCode, 201)
  const id = first.json().job.id
  await runner.idle()
  const second = await app.inject({ method: 'POST', url: '/api/updates/jobs', headers: { cookie }, payload: { mode: 'dry-run' } })
  assert.equal(second.statusCode, 409)
  assert.equal(second.json().runningJobId, id)

  const got = await app.inject({ method: 'GET', url: `/api/updates/jobs/${id}`, headers: { cookie } })
  assert.equal(got.json().job.status, 'awaiting-confirm')
  assert.ok(got.json().job.steps.length >= 2)
  assert.equal((await app.inject({ method: 'POST', url: `/api/updates/jobs/${id}/resume`, headers: { cookie } })).statusCode, 409, 'not paused')
  const cancel = await app.inject({ method: 'POST', url: `/api/updates/jobs/${id}/cancel`, headers: { cookie } })
  assert.equal(cancel.statusCode, 200)
  assert.equal(cancel.json().job.status, 'cancelled')

  const list = await app.inject({ method: 'GET', url: '/api/updates/jobs?limit=5', headers: { cookie } })
  assert.equal(list.json().jobs[0].id, id)
  assert.equal((await app.inject({ method: 'GET', url: '/api/updates/jobs/nope', headers: { cookie } })).statusCode, 404)
  assert.ok(store.audits.some(a => a.action === 'updates.job.start' && (a.details as any).by === 'admin@example.com'))
  assert.ok(store.audits.some(a => a.action === 'updates.job.cancel'))
})

test('without a policy file: run is refused with a reason, dry-run works; bad mode is 400', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  policyYaml = null
  try {
    const run = await app.inject({ method: 'POST', url: '/api/updates/jobs', headers: { cookie }, payload: { mode: 'run' } })
    assert.equal(run.statusCode, 400)
    assert.match(run.json().error, /policy file/)
    const dry = await app.inject({ method: 'POST', url: '/api/updates/jobs', headers: { cookie }, payload: { mode: 'dry-run' } })
    assert.equal(dry.statusCode, 201)
    await runner.idle()
    const done = await app.inject({ method: 'GET', url: `/api/updates/jobs/${dry.json().job.id}`, headers: { cookie } })
    assert.equal(done.json().job.status, 'done')
    assert.equal((await app.inject({ method: 'POST', url: '/api/updates/jobs', headers: { cookie }, payload: { mode: 'yolo' } })).statusCode, 400)
  } finally { policyYaml = 'nodes:\n  default: { upgrade: upgrade, reboot: manual }\n' }
})

test('per-node reboot: 202, unknown node 404', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  assert.equal((await app.inject({ method: 'POST', url: '/api/updates/nodes/node-z/reboot', headers: { cookie } })).statusCode, 404)
  const r = await app.inject({ method: 'POST', url: '/api/updates/nodes/node-b/reboot', headers: { cookie } })
  assert.equal(r.statusCode, 202)
  await runner.idle()
  const j = await app.inject({ method: 'GET', url: `/api/updates/jobs/${r.json().job.id}`, headers: { cookie } })
  assert.equal(j.json().job.status, 'done')
})

test('app approvals and rollback: malformed input is 400 before anything runs; rollback of an unknown job is 404', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: { cookie }, payload: payload as any })
  for (const approve of ['app:101:x:abcdef@1.0.0', ['app:101:demo:abcdef@1.0.0;reboot'], [42], Array(201).fill('app:101:demo:abcdef@1.0.0')]) {
    const r = await post('/api/updates/jobs', { mode: 'dry-run', approve })
    assert.equal(r.statusCode, 400, JSON.stringify(approve).slice(0, 80))
  }
  const plan = await app.inject({ method: 'GET', url: '/api/updates/plan?approve=' + encodeURIComponent('fix:101:demo:abcdef:zz'), headers: { cookie } })
  assert.equal(plan.statusCode, 400)
  const okPlan = await app.inject({ method: 'GET', url: '/api/updates/plan?approve=' + encodeURIComponent('app:101:demo:abcdef@1.0.0+b1'), headers: { cookie } })
  assert.equal(okPlan.statusCode, 200)
  assert.ok(okPlan.json().warnings.some((w: string) => /matches nothing planned now/.test(w)))
  assert.equal((await post('/api/updates/jobs/x/rollback', { target: '../101' })).statusCode, 400)
  assert.equal((await post('/api/updates/jobs/nope/rollback', { target: '101' })).statusCode, 404)
})

const closed = (ws: any, ms = 2000) => new Promise<boolean>(res => {
  if (ws.readyState === 3) return res(true)
  const t = setTimeout(() => res(false), ms)
  ws.once('close', () => { clearTimeout(t); res(true) })
})
const tick = (ms = 30) => new Promise(res => setTimeout(res, ms))

test('B8: the updates socket is admin-only; viewers are refused, admins get frames', async () => {
  const v = await signIn(app, 'viewer@example.com', 'viewer master password')
  const vs: any = await (app as any).injectWS('/ws/updates', { headers: { cookie: v.cookie } })
  assert.equal(await closed(vs), true, 'a viewer socket is closed by the server')
  assert.equal(updatesSubscriberCount(), 0)

  const a = await signIn(app, 'admin@example.com', 'admin master password')
  const as: any = await (app as any).injectWS('/ws/updates', { headers: { cookie: a.cookie } })
  const frames: any[] = []
  as.on('message', (m: Buffer) => frames.push(JSON.parse(m.toString())))
  await tick()
  assert.equal(updatesSubscriberCount(), 1)
  const dry = await app.inject({ method: 'POST', url: '/api/updates/jobs', headers: { cookie: a.cookie }, payload: { mode: 'dry-run' } })
  assert.equal(dry.statusCode, 201)
  await runner.idle()
  await tick()
  assert.ok(frames.some(f => f.type === 'updates' && f.payload.kind === 'job'))
  // Locking ends the session, and the socket with it.
  await lock('manual')
  assert.equal(await closed(as), true)
  assert.equal(updatesSubscriberCount(), 0)
})

test('inventory refresh while a job is active serves the cache instead of reading guests again', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  await app.inject({ method: 'GET', url: '/api/updates/inventory?refresh=1', headers: { cookie } })
  const job = await app.inject({ method: 'POST', url: '/api/updates/jobs', headers: { cookie }, payload: { mode: 'run' } })
  assert.equal(job.statusCode, 201)
  await runner.idle()
  const before = fake.calls.filter(c => c.cmd === 'guest:pending').length
  const r = await app.inject({ method: 'GET', url: '/api/updates/inventory?refresh=1', headers: { cookie } })
  assert.equal(r.statusCode, 200)
  assert.equal(fake.calls.filter(c => c.cmd === 'guest:pending').length, before)
  await app.inject({ method: 'POST', url: `/api/updates/jobs/${job.json().job.id}/cancel`, headers: { cookie } })
  await runner.idle()
})
