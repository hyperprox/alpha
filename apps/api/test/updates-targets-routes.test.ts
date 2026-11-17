// /api/updates targets and runs of chosen targets over HTTP, behind the real vault gate: admin only, the master
// password re-entered to start, confirm or resume one (an API token never can), audited, and refused outright when
// nothing chosen can run (a held kernel package alone).
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import websocket from '@fastify/websocket'
import { buildUpdatesRoutes } from '../src/routes/updates'
import { MemoryStore } from '../src/lib/updates/store'
import type { UpdatesRunner } from '../src/lib/updates/runner'
import { lastTargets } from '../src/lib/updates/targets-summary'
import { FakeBroker } from './fakes/fake-broker'
import { signIn } from './fakes/app'
import { FakeCluster, node, guest, pkg, policyLoad, FAST } from './updates-fake'
import { confirmAfterReconfirm } from './fakes/confirm'

const broker = new FakeBroker()
broker.addUser('admin@example.com', 'admin master password', 'admin')
broker.addUser('viewer@example.com', 'viewer master password', 'viewer')

const POLICY = `
nodes:
  default: { upgrade: upgrade, reboot: manual }
  gpu-node: { require_holds: [proxmox-kernel-7.0], require_pin: 7.0.1-1-pve }
`
let app: FastifyInstance
let runner: UpdatesRunner
let store: MemoryStore
let fake: FakeCluster

before(async () => {
  setBroker(broker)
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  store = new MemoryStore()
  fake = new FakeCluster({
    nodes: [node('node-a'), node('gpu-node', { holds: ['proxmox-kernel-7.0'], pinned: '7.0.1-1-pve', pending: [pkg('curl', '8.1-2'), pkg('proxmox-kernel-7.0', '7.0.2-1')] })],
    guests: [guest(101, 'node-a')],
  })
  app = confirmAfterReconfirm(Fastify({ logger: false }))
  await app.register(websocket)
  await registerGate(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(buildUpdatesRoutes({
    store, exec: fake, loadPolicy: policyLoad(POLICY), timing: FAST, onRunner: r => { runner = r },
  }), { prefix: '/api/updates' })
  await app.ready()
})
beforeEach(async () => { if (isUnlocked()) await lock('manual') })
after(async () => { if (isUnlocked()) await lock('manual'); await app.close() })

const reconfirm = (cookie: string) => app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie }, payload: { password: 'admin master password' } })

test('viewer: 403 on the tree, the preview and a chosen run', async () => {
  const { cookie } = await signIn(app, 'viewer@example.com', 'viewer master password')
  assert.equal((await app.inject({ method: 'GET', url: '/api/updates/targets', headers: { cookie } })).statusCode, 403)
  assert.equal((await app.inject({ method: 'POST', url: '/api/updates/preview', headers: { cookie }, payload: { select: ['guest:101'] } })).statusCode, 403)
  assert.equal((await app.inject({ method: 'POST', url: '/api/updates/jobs', headers: { cookie }, payload: { mode: 'run', select: ['guest:101'] } })).statusCode, 403)
})

test('admin: the tree, with the held kernel package listed but not selectable; the assistant sees the same tree', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const r = await app.inject({ method: 'GET', url: '/api/updates/targets?refresh=1', headers: { cookie } })
  assert.equal(r.statusCode, 200)
  const t = r.json().targets as any[]
  const k = t.find(x => x.id === 'node:gpu-node:pkg:proxmox-kernel-7.0')
  assert.equal(k.selectable, false)
  assert.equal(t.find(x => x.id === 'guest:101').parent, 'node:node-a')
  assert.equal(lastTargets('home')!.targets.length, t.length)
})

test('preview: the order and the refusals, read-only', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const calls = fake.calls.length
  const r = await app.inject({ method: 'POST', url: '/api/updates/preview', headers: { cookie }, payload: { select: ['node:node-a', 'guest:101', 'node:gpu-node:pkg:proxmox-kernel-7.0'] } })
  assert.equal(r.statusCode, 200)
  const p = r.json()
  assert.deepEqual(p.items.map((i: any) => i.id), ['guest:101', 'node:node-a'])
  assert.deepEqual(p.refused.map((x: any) => x.id), ['node:gpu-node:pkg:proxmox-kernel-7.0'])
  assert.equal(fake.calls.length, calls, 'nothing was run to preview')
  assert.equal((await app.inject({ method: 'POST', url: '/api/updates/preview', headers: { cookie }, payload: { select: ['node:a;id'] } })).statusCode, 400)
})

test('a chosen run needs the master password again; then it is audited with its selection', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const first = await app.inject({ method: 'POST', url: '/api/updates/jobs', headers: { cookie }, payload: { mode: 'run', select: ['guest:101'] } })
  assert.equal(first.statusCode, 403)
  assert.equal(first.json().code, 'confirm_required')
  assert.equal(store.audits.some(a => a.action === 'updates.job.start'), false, 'nothing started')
  assert.equal((await reconfirm(cookie)).statusCode, 200)
  const ok = await app.inject({ method: 'POST', url: '/api/updates/jobs', headers: { cookie }, payload: { mode: 'run', select: ['guest:101'] } })
  assert.equal(ok.statusCode, 201, ok.body)
  const id = ok.json().job.id
  await runner.idle(); await runner.idle()
  const audit = store.audits.find(a => a.action === 'updates.job.start' && a.resource === id)!
  assert.deepEqual(audit.details!.selection, ['guest:101'])
  assert.equal(audit.details!.by, 'admin@example.com')
  const job = (await app.inject({ method: 'GET', url: `/api/updates/jobs/${id}`, headers: { cookie } })).json().job
  assert.equal(job.status, 'awaiting-confirm')
  assert.deepEqual(job.plan.items.map((i: any) => i.id), ['guest:101'])
  assert.equal(job.plan.stepOffset, 2)
  const conf = await app.inject({ method: 'POST', url: `/api/updates/jobs/${id}/confirm`, headers: { cookie } })
  assert.equal(conf.statusCode, 200, conf.body)
  await runner.idle(); await runner.idle()
  const done = (await app.inject({ method: 'GET', url: `/api/updates/jobs/${id}`, headers: { cookie } })).json().job
  assert.equal(done.status, 'done')
  assert.deepEqual(done.report.items.map((i: any) => [i.id, i.status]), [['guest:101', 'ok']])
})

test('confirming a chosen run is confirmed on the page again, by whoever confirms it', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  await reconfirm(cookie)
  const ok = await app.inject({ method: 'POST', url: '/api/updates/jobs', headers: { cookie }, payload: { mode: 'run', select: ['node:node-a'] } })
  assert.equal(ok.statusCode, 201, ok.body)
  const id = ok.json().job.id
  await runner.idle(); await runner.idle()
  // Another session has confirmed nothing: its first confirm is answered with a confirmation to show.
  const { cookie: other } = await signIn(app, 'admin@example.com', 'admin master password')
  const conf = await app.inject({ method: 'POST', url: `/api/updates/jobs/${id}/confirm`, headers: { cookie: other } })
  assert.equal(conf.statusCode, 403)
  assert.equal(conf.json().code, 'confirm_required')
  assert.match(conf.json().confirm.summary, /Carry on with this update run\?/)
  await app.inject({ method: 'POST', url: `/api/updates/jobs/${id}/cancel`, headers: { cookie: other } })
})

test('a held kernel package alone is refused before any job exists', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  await reconfirm(cookie)
  const before = store.audits.length
  const r = await app.inject({ method: 'POST', url: '/api/updates/jobs', headers: { cookie }, payload: { mode: 'run', select: ['node:gpu-node:pkg:proxmox-kernel-7.0'] } })
  assert.equal(r.statusCode, 400)
  assert.match(r.json().refused[0].reason, /held|kernel/)
  assert.equal(store.audits.length, before)
  assert.equal((await app.inject({ method: 'POST', url: '/api/updates/jobs', headers: { cookie }, payload: { mode: 'run', select: [] } })).statusCode, 400)
})

test('looking inside every guest for compose projects is an admin POST; a viewer never causes it, and a GET no longer can', async () => {
  const composeLs = () => fake.calls.filter(c => c.cmd === 'guest:compose-ls').length
  const before = composeLs()
  const v = await signIn(app, 'viewer@example.com', 'viewer master password')
  const denied = await app.inject({ method: 'POST', url: '/api/updates/targets/discover', headers: { cookie: v.cookie } })
  assert.equal(denied.statusCode, 403, denied.body)
  assert.equal((await app.inject({ method: 'GET', url: '/api/updates/targets?discover=1', headers: { cookie: v.cookie } })).statusCode, 403)
  assert.equal(composeLs(), before, 'nothing was run in any guest for the viewer')
  const a = await signIn(app, 'admin@example.com', 'admin master password')
  const old = await app.inject({ method: 'GET', url: '/api/updates/targets?discover=1', headers: { cookie: a.cookie } })
  assert.equal(old.statusCode, 400, 'discovery is not a GET any more')
  assert.equal(composeLs(), before)
  const ok = await app.inject({ method: 'POST', url: '/api/updates/targets/discover', headers: { cookie: a.cookie } })
  assert.equal(ok.statusCode, 200, ok.body)
  assert.ok(Array.isArray(ok.json().targets))
  assert.ok(composeLs() > before, 'the admin\'s request looked in the guests')
})
