// /api/updates for a remote cluster, over HTTP behind the real vault gate and the cluster context hook: the
// request's cluster decides which server is read and changed; a job planned for one cluster is "No job" through
// another; on a remote every change needs a fresh master-password re-confirmation, which an API token can never
// give; admin only; locked is 423; the daily check covers both clusters and feeds the Command center.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { setAuditSink } from '../src/lib/audit'
import { setClusterStore, loadClusters } from '../src/lib/clusters/registry'
import { MemoryClusterStore } from '../src/lib/clusters/store'
import { installClusterContext } from '../src/lib/clusters/context'
import { MemoryApiTokenStore, setApiTokenStore, createApiToken } from '../src/lib/api-tokens'
import { buildUpdatesRoutes } from '../src/routes/updates'
import { MemoryStore } from '../src/lib/updates/store'
import { MemoryCheckState, type UpdatesChecker } from '../src/lib/updates/check'
import type { UpdatesServices } from '../src/lib/updates/service'
import { panelUpdates } from '../src/lib/clusters/overview'
import { FakeBroker } from './fakes/fake-broker'
import { signIn } from './fakes/app'
import { FakeCluster, node, guest, policyLoad, FAST } from './updates-fake'
import { standaloneServer } from './updates-remote-fake'

const REMOTE = 'c0123456789'
const H = { 'x-hyperprox-cluster': REMOTE }
const broker = new FakeBroker()
broker.addUser('admin@example.com', 'admin master password', 'admin')
broker.addUser('op@example.com', 'operator master password', 'operator')

let app: FastifyInstance
let services: UpdatesServices
let checker: UpdatesChecker
const store = new MemoryStore()
const tokens = new MemoryApiTokenStore()
const home = new FakeCluster({ nodes: [node('pve1', { pinned: '7.0.1-1-pve' }), node('node-b')], guests: [guest(201, 'pve1')] })
const remote = standaloneServer({ guest: { config: { hostname: 'media', onboot: 1 } } })

before(async () => {
  setBroker(broker)
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  setAuditSink({ write: async () => {} })
  setApiTokenStore(tokens)
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  const cs = new MemoryClusterStore()
  await cs.upsert({ id: REMOTE, name: 'Remote server', kind: 'remote', address: 'pve1.example', port: 8006, note: '', certFingerprint: 'AA', certConfirmedAt: null, certConfirmedBy: null, nodeAddresses: { pve1: '10.0.0.9' }, allowedRoots: [], monitoring: {}, plexUrl: null, createdBy: 'x' })
  setClusterStore(cs); await loadClusters()
  app = Fastify({ logger: false })
  await registerGate(app)
  installClusterContext(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(buildUpdatesRoutes({
    store, exec: home, remoteExec: () => remote,
    loadPolicy: policyLoad('nodes:\n  pve1: { upgrade: upgrade, reboot: manual, require_pin: 7.0.1-1-pve }\n'),
    timing: FAST, scheduler: false, recover: false, check: false, checkState: new MemoryCheckState(), checkGapMs: 0,
    connection: () => 'conn-1', publish: async () => {},
    onServices: (s, c) => { services = s; checker = c },
  }), { prefix: '/api/updates' })
  await app.ready()
})
after(async () => { if (isUnlocked()) await lock('manual'); setApiTokenStore(null); await app.close() })

const idle = () => Promise.all([services.get('home').runner.idle(), services.get(REMOTE).runner.idle()])

test('locked: 423 for a remote too; below admin: 403', async () => {
  if (isUnlocked()) await lock('manual')
  assert.equal((await app.inject({ method: 'GET', url: '/api/updates/inventory', headers: H })).statusCode, 423)
  const { cookie } = await signIn(app, 'op@example.com', 'operator master password')
  for (const [m, url] of [['GET', '/api/updates/inventory'], ['GET', '/api/updates/check'], ['POST', '/api/updates/jobs'], ['POST', '/api/updates/nodes/pve1/reboot']]) {
    const r = await app.inject({ method: m as any, url, headers: { cookie, ...H }, payload: m === 'POST' ? { mode: 'run' } : undefined })
    assert.equal(r.statusCode, 403, `${m} ${url}`)
  }
  assert.ok(!remote.ran(/apt-get -y|systemctl reboot/))
})

test('the request\'s cluster decides what is read: the remote preview is its own simulation, home is untouched', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const before = home.calls.length
  const inv = await app.inject({ method: 'GET', url: '/api/updates/inventory?refresh=1', headers: { cookie, ...H } })
  assert.equal(inv.statusCode, 200, inv.body)
  assert.deepEqual(inv.json().cluster, { id: REMOTE, name: 'Remote server', kind: 'remote' })
  const n = inv.json().nodes[0]
  assert.equal(n.node, 'pve1')
  assert.equal(n.preview.verb, 'dist-upgrade', 'the home pve1 rule (upgrade only, pinned) does not apply to the remote pve1')
  assert.equal(n.policy.requirePin, undefined)
  assert.equal(home.calls.length, before, 'nothing was read from home')
  const pol = await app.inject({ method: 'GET', url: '/api/updates/policy', headers: { cookie, ...H } })
  assert.equal(pol.json().cluster.kind, 'remote')
  assert.equal(pol.json().section, null)
  assert.ok(pol.json().notes.some((x: string) => /built-in remote defaults/.test(x)))
  const homeInv = await app.inject({ method: 'GET', url: '/api/updates/inventory?refresh=1', headers: { cookie } })
  assert.equal(homeInv.json().cluster.kind, 'home')
  assert.equal(homeInv.json().nodes.find((x: any) => x.node === 'pve1').policy.requirePin, '7.0.1-1-pve')
  const plan = await app.inject({ method: 'GET', url: '/api/updates/plan', headers: { cookie, ...H } })
  assert.equal(plan.json().cluster.id, REMOTE)
})

test('remote changes need a fresh re-confirmation; a dry run and a cancel do not', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const run = await app.inject({ method: 'POST', url: '/api/updates/jobs', headers: { cookie, ...H }, payload: { mode: 'run' } })
  assert.equal(run.statusCode, 403)
  assert.equal(run.json().code, 'reconfirm_required')
  assert.equal((await app.inject({ method: 'POST', url: '/api/updates/nodes/pve1/reboot', headers: { cookie, ...H } })).json().code, 'reconfirm_required')
  const dry = await app.inject({ method: 'POST', url: '/api/updates/jobs', headers: { cookie, ...H }, payload: { mode: 'dry-run' } })
  assert.equal(dry.statusCode, 201, dry.body)
  await idle()
  assert.ok(!remote.ran(/apt-get -y|POST apt\/update/), 'a dry run changes nothing')
  // Home keeps its own rules: no re-confirmation was ever asked there.
  const homeRun = await app.inject({ method: 'POST', url: '/api/updates/jobs', headers: { cookie }, payload: { mode: 'dry-run' } })
  assert.equal(homeRun.statusCode, 201)
  await idle()
})

test('preview -> re-confirm -> apply on the remote; the job is "No job" through home, and home\'s through the remote', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  await app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie }, payload: { password: 'admin master password' } })
  const start = await app.inject({ method: 'POST', url: '/api/updates/jobs', headers: { cookie, ...H }, payload: { mode: 'run' } })
  assert.equal(start.statusCode, 201, start.body)
  const id = start.json().job.id
  await idle()
  const got = await app.inject({ method: 'GET', url: `/api/updates/jobs/${id}`, headers: { cookie, ...H } })
  assert.equal(got.json().job.status, 'awaiting-confirm')
  assert.equal(got.json().job.plan.cluster.id, REMOTE)

  // Through home: the remote job does not exist.
  assert.equal((await app.inject({ method: 'GET', url: `/api/updates/jobs/${id}`, headers: { cookie } })).statusCode, 404)
  assert.equal((await app.inject({ method: 'POST', url: `/api/updates/jobs/${id}/confirm`, headers: { cookie } })).statusCode, 404)
  assert.ok(!(await app.inject({ method: 'GET', url: '/api/updates/jobs', headers: { cookie } })).json().jobs.some((j: any) => j.id === id))

  // An API token, even an admin one, cannot re-confirm: refused on the remote.
  const { token } = await createApiToken({ name: 'ci', role: 'admin' }, 'test', tokens)
  const viaToken = await app.inject({ method: 'POST', url: `/api/updates/jobs/${id}/confirm`, headers: { authorization: `Bearer ${token}`, ...H } })
  assert.equal(viaToken.statusCode, 403)
  assert.equal(viaToken.json().code, 'reconfirm_required')

  const ok = await app.inject({ method: 'POST', url: `/api/updates/jobs/${id}/confirm`, headers: { cookie, ...H } })
  assert.equal(ok.statusCode, 200, ok.body)
  await idle()
  const done = (await app.inject({ method: 'GET', url: `/api/updates/jobs/${id}`, headers: { cookie, ...H } })).json().job
  assert.equal(done.status, 'done', done.pauseReason)
  assert.ok(remote.ran(/apt-get -y -q .* dist-upgrade$/))
  assert.ok(!remote.ran(/systemctl reboot/), 'no automatic reboot')
  assert.ok(!home.ran(/apt-get -y/), 'home was never touched')
  assert.ok(store.audits.some(a => a.action === 'updates.job.confirm' && (a.details as any).cluster === REMOTE))

  // Home's job through the remote: no job.
  const hj = await app.inject({ method: 'POST', url: '/api/updates/jobs', headers: { cookie }, payload: { mode: 'run' } })
  assert.equal(hj.statusCode, 201, hj.body)
  await idle()
  const hid = hj.json().job.id
  assert.equal((await app.inject({ method: 'POST', url: `/api/updates/jobs/${hid}/confirm`, headers: { cookie, ...H } })).statusCode, 404)
  assert.equal((await app.inject({ method: 'POST', url: `/api/updates/jobs/${hid}/cancel`, headers: { cookie, ...H } })).statusCode, 404)
  assert.equal((await app.inject({ method: 'POST', url: `/api/updates/jobs/${hid}/cancel`, headers: { cookie } })).statusCode, 200)
})

test('the reboot preview, then the separate re-confirmed reboot', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const pv = await app.inject({ method: 'GET', url: '/api/updates/nodes/pve1/reboot-preview', headers: { cookie, ...H } })
  assert.equal(pv.statusCode, 200, pv.body)
  assert.deepEqual(pv.json().goingDown.map((g: any) => g.name), ['media'])
  assert.equal(pv.json().cluster.kind, 'remote')
  await app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie }, payload: { password: 'admin master password' } })
  const r = await app.inject({ method: 'POST', url: '/api/updates/nodes/pve1/reboot', headers: { cookie, ...H } })
  assert.equal(r.statusCode, 202, r.body)
  await idle()
  assert.ok(remote.ran(/^systemctl reboot$/))
  assert.ok(!home.ran(/systemctl reboot/))
})

test('the check covers both clusters, read-only, and the Command center shows its stored count', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  remote.guests[0].pending = [{ name: 'openssl', from: '3.0-1', to: '3.0-2' }]
  const r = await app.inject({ method: 'POST', url: '/api/updates/check', headers: { cookie, ...H } })
  assert.equal(r.statusCode, 202, r.body)
  await checker.run('manual')
  const st = (await app.inject({ method: 'GET', url: '/api/updates/check', headers: { cookie } })).json()
  assert.deepEqual(st.clusters.map((c: any) => c.cluster.id), ['home', REMOTE])
  assert.ok(st.lastRun)
  const p = panelUpdates(REMOTE)
  assert.ok(p && p.available >= 1, JSON.stringify(p))
})
