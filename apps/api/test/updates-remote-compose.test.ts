// Compose projects on a remote cluster, over HTTP behind the real vault gate and the cluster context hook, exactly as
// on home: the tree and the preview answer for a remote (never "home cluster only"), "Find compose projects in
// every guest" runs `docker compose ls` through the remote's own executor and nowhere else, the policy's exclusions,
// `docker: none` and the hyperprox-ignore tag keep guests out of it, and a chosen project is pulled and restarted
// by its name and every config file `docker compose ls` lists at run time (-p / -f), with the master password
// re-entered, audited, and one item's failure leaving the others alone. The node protections (held packages, a
// pinned kernel, required holds) hold on a remote too.
// Names, addresses and ids are generic on purpose: this repo is public.
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
import { installClusterContext, remoteRouteAllowed } from '../src/lib/clusters/context'
import { buildUpdatesRoutes } from '../src/routes/updates'
import { MemoryStore } from '../src/lib/updates/store'
import { MemoryCheckState } from '../src/lib/updates/check'
import type { UpdatesServices } from '../src/lib/updates/service'
import type { GuestRef, LineSink } from '../src/lib/updates/executor'
import { FakeBroker } from './fakes/fake-broker'
import { signIn } from './fakes/app'
import { FakeCluster, node, guest, pkg, policyLoad, FAST } from './updates-fake'
import { RemoteFake } from './updates-remote-fake'

const REMOTE = 'c0123456789'
const H = { 'x-hyperprox-cluster': REMOTE }
const broker = new FakeBroker()
broker.addUser('admin@example.com', 'admin master password', 'admin')

const img = (image: string, latest: string | null = 'sha256:new') => ({ image, current: 'sha256:old', latest })

// Home has a guest with compose projects too: nothing on the remote's page may read it.
const home = new FakeCluster({
  nodes: [node('pve1')],
  guests: [guest(101, 'pve1', { compose: [{ dir: '/srv/home-app', name: 'homeapp', images: [img('nginx:1')] }] })],
})

// The remote: one server. 101 bind-mounts its media (no snapshot); 102 is excluded and 104 has docker: none in the
// remote's own policy section; 103 carries the hyperprox-ignore tag; 105 can be snapshotted. The node holds and pins
// its kernel, and the remote's section requires both.
const remote = new RemoteFake({
  nodes: [node('pve1', {
    holds: ['proxmox-kernel-7.0'], pinned: '7.0.1-1-pve',
    pending: [pkg('curl', '8.1-2', '8.1-1'), pkg('proxmox-kernel-7.0', '7.0.2-1', '7.0.1-1')],
  })],
  guests: [
    guest(101, 'pve1', { name: 'media', config: { hostname: 'media', mp0: '/srv/media,mp=/media' },
      compose: [{ dir: '/opt/web', name: 'web', files: ['/opt/web/compose.yaml', '/opt/web/compose.override.yaml'], images: [img('nginx:1'), img('redis:7', 'sha256:old')] }] }),
    guest(102, 'pve1', { name: 'excluded', compose: [{ dir: '/opt/x', name: 'xproj', images: [img('busybox:1')] }] }),
    guest(103, 'pve1', { name: 'private', tags: ['hyperprox-ignore'], compose: [{ dir: '/opt/p', name: 'pproj', images: [img('busybox:1')] }] }),
    guest(104, 'pve1', { name: 'nodocker', compose: [{ dir: '/opt/n', name: 'nproj', images: [img('busybox:1')] }] }),
    guest(105, 'pve1', { name: 'api', compose: [{ dir: '/srv/api', name: 'api', images: [img('node:22')] }] }),
  ],
})
// Every script a remote guest is sent, with its guest: the run must use what `docker compose ls` lists then.
const sent: { vmid: number; script: string }[] = []
const realGuestExec = remote.guestExec.bind(remote)
remote.guestExec = async (g: GuestRef, script: string, onLine?: LineSink) => { sent.push({ vmid: g.vmid, script }); return realGuestExec(g, script, onLine) }

const POLICY = `
nodes:
  pve1: { upgrade: upgrade, reboot: manual }
clusters:
  ${REMOTE}:
    nodes:
      pve1: { upgrade: upgrade, require_holds: [proxmox-kernel-7.0], require_pin: 7.0.1-1-pve }
    guests:
      exclude: [102]
      "104": { docker: none }
`

let app: FastifyInstance
let services: UpdatesServices
const store = new MemoryStore()

before(async () => {
  setBroker(broker)
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  setAuditSink({ write: async () => {} })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  const cs = new MemoryClusterStore()
  await cs.upsert({ id: REMOTE, name: 'Remote server', kind: 'remote', address: 'pve1.example', port: 8006, note: '', certFingerprint: 'AA', certConfirmedAt: null, certConfirmedBy: null, nodeAddresses: { pve1: '10.0.0.9' }, allowedRoots: [], monitoring: {}, plexUrl: null, createdBy: 'x' })
  setClusterStore(cs); await loadClusters()
  app = Fastify({ logger: false })
  await registerGate(app)
  installClusterContext(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(buildUpdatesRoutes({
    store, exec: home, remoteExec: () => remote, loadPolicy: policyLoad(POLICY),
    timing: FAST, checkState: new MemoryCheckState(), checkGapMs: 0,
    connection: () => 'conn-1', publish: async () => {},
    onServices: s => { services = s },
  }), { prefix: '/api/updates' })
  await app.ready()
})
after(async () => { if (isUnlocked()) await lock('manual'); await app.close() })

const idle = async () => { for (let i = 0; i < 3; i++) await services.get(REMOTE).runner.idle() }
const composeLsIn = () => new Set(remote.calls.filter(c => c.cmd === 'guest:compose-ls').map(c => Number(c.where)))
const homeOnly = (body: string) => /home cluster only|home_only/.test(body)

test('the tree and the preview are open to a remote cluster; HyperProx\'s own update stays home-only', () => {
  assert.ok(remoteRouteAllowed('GET', '/api/updates/targets'))
  assert.ok(remoteRouteAllowed('POST', '/api/updates/targets/discover'))
  assert.ok(remoteRouteAllowed('POST', '/api/updates/preview'))
  assert.ok(!remoteRouteAllowed('POST', '/api/self-update/install'), 'HyperProx updates itself, never a remote')
  assert.ok(!remoteRouteAllowed('GET', '/api/self-update/status'))
})

test('without discovery nothing is looked for: the remote defaults keep docker off', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const r = await app.inject({ method: 'GET', url: '/api/updates/targets?refresh=1', headers: { cookie, ...H } })
  assert.equal(r.statusCode, 200, r.body)
  assert.ok(!homeOnly(r.body))
  assert.equal(r.json().cluster.id, REMOTE)
  assert.equal(composeLsIn().size, 0, 'no guest was asked for compose projects')
  assert.ok(!r.json().targets.some((t: any) => t.kind === 'compose'))
})

test('"Find compose projects in every guest" on a remote: through the remote executor only, exclusions, docker: none and the ignore tag win', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const homeCalls = home.calls.length
  const r = await app.inject({ method: 'POST', url: '/api/updates/targets/discover', headers: { cookie, ...H } })
  assert.equal(r.statusCode, 200, r.body)
  assert.ok(!homeOnly(r.body), 'no "home only" answer for a supported feature')
  assert.equal(home.calls.length, homeCalls, 'nothing was read from home')
  assert.deepEqual([...composeLsIn()].sort(), [101, 105], 'only the guests HyperProx may look inside')
  assert.deepEqual(remote.refused, [], 'every script passed the remote script guard')

  const t = r.json().targets as any[]
  const web = t.find(x => x.id === 'guest:101:compose:web')
  assert.ok(web, 'the project is offered by its name')
  assert.equal(web.selectable, true)
  assert.equal(web.pending, 1)
  assert.ok(web.notes.some((n: string) => /compose\.override\.yaml/.test(n)), 'every config file is shown')
  assert.deepEqual(web.approvals, ['nosnap:101'], 'a guest that cannot be snapshotted still needs its approval')
  assert.ok(t.find(x => x.id === 'guest:105:compose:api'))
  for (const v of [102, 103, 104]) assert.ok(!t.some(x => x.kind === 'compose' && x.vmid === v), `no compose row for ${v}`)
  assert.equal(t.find(x => x.id === 'guest:102').selectable, false)
  assert.equal(t.find(x => x.id === 'guest:103').selectable, false)
})

test('the preview of chosen compose projects on a remote, and the refusals it would give', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const calls = remote.calls.length
  const r = await app.inject({ method: 'POST', url: '/api/updates/preview', headers: { cookie, ...H },
    payload: { select: ['guest:101:compose:web', 'guest:105:compose:api', 'guest:104:compose:nproj', 'guest:103:compose:pproj'], approve: ['nosnap:101'] } })
  assert.equal(r.statusCode, 200, r.body)
  assert.ok(!homeOnly(r.body))
  const p = r.json()
  assert.equal(p.cluster.id, REMOTE)
  assert.deepEqual(p.items.map((i: any) => i.id).sort(), ['guest:101:compose:web', 'guest:105:compose:api'])
  const why = Object.fromEntries(p.refused.map((x: any) => [x.id, x.reason]))
  assert.match(why['guest:104:compose:nproj'], /docker is off/)
  assert.match(why['guest:103:compose:pproj'], /hyperprox-ignore|never looks/)
  assert.equal(remote.calls.length, calls, 'nothing was run to preview')
})

test('the node protections hold on a remote: a held kernel is never offered, and its preview refuses it', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const t = (await app.inject({ method: 'GET', url: '/api/updates/targets', headers: { cookie, ...H } })).json().targets as any[]
  const k = t.find(x => x.id === 'node:pve1:pkg:proxmox-kernel-7.0')
  assert.ok(k)
  assert.equal(k.selectable, false)
  assert.match(k.blocked, /held|kernel|pin/)
  const p = (await app.inject({ method: 'POST', url: '/api/updates/preview', headers: { cookie, ...H }, payload: { select: ['node:pve1:pkg:proxmox-kernel-7.0'] } })).json()
  assert.deepEqual(p.items, [])
  assert.equal(p.refused[0].id, 'node:pve1:pkg:proxmox-kernel-7.0')
  // With the required holds gone, the node is not touched at all.
  const held = remote.nodes[0].holds
  remote.nodes[0].holds = []
  try {
    const t2 = (await app.inject({ method: 'GET', url: '/api/updates/targets?refresh=1', headers: { cookie, ...H } })).json().targets as any[]
    assert.equal(t2.find(x => x.id === 'node:pve1').selectable, false)
    assert.equal(t2.find(x => x.id === 'node:pve1:pkg:curl').selectable, false)
  } finally {
    remote.nodes[0].holds = held
    await app.inject({ method: 'GET', url: '/api/updates/targets?refresh=1', headers: { cookie, ...H } })
  }
})

test('a chosen compose project on a remote: master password again, -p and every -f from docker compose ls at run time, audited, one failure isolated', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const select = ['guest:101:compose:web', 'guest:105:compose:api']
  await app.inject({ method: 'POST', url: '/api/updates/targets/discover', headers: { cookie, ...H } })
  const first = await app.inject({ method: 'POST', url: '/api/updates/jobs', headers: { cookie, ...H }, payload: { mode: 'run', select, approve: ['nosnap:101'] } })
  assert.equal(first.statusCode, 403)
  assert.equal(first.json().code, 'reconfirm_required')
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie }, payload: { password: 'admin master password' } })).statusCode, 200)

  // After the tree was read, a third config file is added to the project: the run must use what is listed now.
  remote.guests.find(g => g.vmid === 101)!.compose![0].files = ['/opt/web/compose.yaml', '/opt/web/compose.override.yaml', '/opt/web/compose.prod.yaml']
  // 105's pull fails; 101 must not be affected.
  remote.inject = (where, cmd) => (where === '105' && cmd === 'guest:docker' ? { code: 1, output: 'not healthy: api:exited', timedOut: false } : undefined)
  const start = await app.inject({ method: 'POST', url: '/api/updates/jobs', headers: { cookie, ...H }, payload: { mode: 'run', select, approve: ['nosnap:101'] } })
  assert.equal(start.statusCode, 201, start.body)
  const id = start.json().job.id
  await idle()
  const planned = (await app.inject({ method: 'GET', url: `/api/updates/jobs/${id}`, headers: { cookie, ...H } })).json().job
  assert.equal(planned.status, 'awaiting-confirm', planned.pauseReason ?? '')
  assert.equal(planned.plan.cluster.id, REMOTE)
  const conf = await app.inject({ method: 'POST', url: `/api/updates/jobs/${id}/confirm`, headers: { cookie, ...H } })
  assert.equal(conf.statusCode, 200, conf.body)
  await idle()
  remote.inject = () => undefined

  const done = (await app.inject({ method: 'GET', url: `/api/updates/jobs/${id}`, headers: { cookie, ...H } })).json().job
  assert.equal(done.status, 'done', done.pauseReason ?? '')
  const items = Object.fromEntries(done.report.items.map((i: any) => [i.id, i.status]))
  assert.deepEqual(items, { 'guest:101:compose:web': 'ok', 'guest:105:compose:api': 'failed' })

  const pull = sent.filter(s => s.vmid === 101 && /pull -q/.test(s.script)).at(-1)!
  assert.ok(pull, 'the project was pulled')
  assert.match(pull.script, /docker compose -p 'web' -f '\/opt\/web\/compose\.yaml' -f '\/opt\/web\/compose\.override\.yaml' -f '\/opt\/web\/compose\.prod\.yaml' pull -q/)
  assert.match(pull.script, /up -d --remove-orphans/)
  assert.ok(!sent.some(s => [102, 103, 104].includes(s.vmid) && /pull -q/.test(s.script)), 'nothing pulled where HyperProx may not go')
  assert.ok(!home.calls.some(c => c.cmd === 'guest:docker'), 'nothing ran on home')
  assert.deepEqual(remote.refused, [])
  assert.ok(!remote.ran(/apt-get -y/), 'choosing compose projects upgrades no packages')
  assert.ok(!remote.calls.some(c => c.cmd.startsWith('snapshot') && c.where === '101'), 'no snapshot was asked of a bind-mounted guest')
  const audit = store.audits.find(a => a.action === 'updates.job.start' && a.resource === id)!
  assert.deepEqual(audit.details!.selection, select)
  assert.equal((audit.details as any).cluster, REMOTE)
})

test('a project that is gone by run time is refused, not guessed at', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  await app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie }, payload: { password: 'admin master password' } })
  await app.inject({ method: 'POST', url: '/api/updates/targets/discover', headers: { cookie, ...H } })
  const g = remote.guests.find(x => x.vmid === 105)!
  const saved = g.compose
  // Between the plan and the run, Docker stops listing it (renamed, removed).
  const start = await app.inject({ method: 'POST', url: '/api/updates/jobs', headers: { cookie, ...H }, payload: { mode: 'run', select: ['guest:105:compose:api'] } })
  assert.equal(start.statusCode, 201, start.body)
  const id = start.json().job.id
  await idle()
  g.compose = [{ dir: '/srv/api2', name: 'api2', images: [] }]
  const before = sent.length
  await app.inject({ method: 'POST', url: `/api/updates/jobs/${id}/confirm`, headers: { cookie, ...H } })
  await idle()
  g.compose = saved
  const job = (await app.inject({ method: 'GET', url: `/api/updates/jobs/${id}`, headers: { cookie, ...H } })).json().job
  const step = job.steps.find((s: any) => s.action === 'docker')
  assert.equal(step.status, 'failed')
  assert.match(step.reason, /no longer a compose project/)
  assert.ok(!sent.slice(before).some(s => /pull -q/.test(s.script)), 'nothing was pulled')
})
