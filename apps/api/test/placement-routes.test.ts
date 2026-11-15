// Placement advisor routes behind the real vault gate: reads for a viewer, the move admin-only with the master password
// re-entered (so never an API token), the audit row written before Proxmox is called (no row, no move), an HA guest
// moved through HA and never a plain migrate, a plain migrate form-encoded with restart and the bandwidth limit, the
// task waited on and the guest read back on the target. Quiet windows: refused outside one without "move anyway";
// scheduled moves run from the database at their time and are skipped (with the reason) when things changed.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { buildPlacementRoutes } from '../src/routes/placement'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { setAuditSink } from '../src/lib/audit'
import { MemoryApiTokenStore, setApiTokenStore, createApiToken } from '../src/lib/api-tokens'
import { requiredRole, needsReconfirm } from '../src/lib/roles'
import { PlacementService, migrateParams } from '../src/lib/placement/service'
import { MemoryPlacementStore } from '../src/lib/placement/store'
import { FakeBroker } from './fakes/fake-broker'
import { signIn } from './fakes/app'
import { placementFixture, fakePve } from './fakes/placement-cluster'

const broker = new FakeBroker()
broker.addUser('admin@example.com', 'admin master password', 'admin')
broker.addUser('op@example.com', 'operator master password', 'operator')
broker.addUser('viewer@example.com', 'viewer master password', 'viewer')
const tokens = new MemoryApiTokenStore()

let clock = Date.UTC(2026, 5, 15, 12, 0)   // noon UTC: quiet (the fixture's backup job is at 02:00)
const audits: Array<{ action: string; resource: string; details?: Record<string, unknown> }> = []
let failAudit = false
const alerts: string[] = []
const roles: Record<string, string | null> = { 'admin@example.com': 'admin' }
let fixture = placementFixture()
let pve = makePve()
let store = new MemoryPlacementStore()
let svc: PlacementService
let app: FastifyInstance

/** A Proxmox that carries out a migration: the guest's node changes, and the task is there to be found. */
function makePve() {
  return fakePve(fixture, (method, path, body) => {
    const vms = fixture['/cluster/resources?type=vm'] as any[]
    let m = /^\/nodes\/([^/]+)\/(lxc|qemu)\/(\d+)\/migrate$/.exec(path)
    if (m && method === 'POST') {
      const target = new URLSearchParams(body).get('target')!
      vms.find(v => String(v.vmid) === m![3])!.node = target
      return `UPID:${m[1]}:0000AAAA:0000BBBB:6AF89939:${m[2] === 'lxc' ? 'vzmigrate' : 'qmigrate'}:${m[3]}:root@pam!hyperprox:`
    }
    m = /^\/cluster\/ha\/resources\/(ct|vm)(?::|%3A)(\d+)\/migrate$/.exec(path)
    if (m && method === 'POST') {
      const node = new URLSearchParams(body).get('node')!
      const v = vms.find(x => String(x.vmid) === m![2])!
      const from = v.node
      v.node = node
      ;(fixture['/cluster/tasks'] as any[]).push({ type: 'vzmigrate', id: m[2], node: from, starttime: Math.floor(clock / 1000), endtime: Math.floor(clock / 1000) + 5, status: 'OK', upid: `UPID:${from}:1:2:3:vzmigrate:${m[2]}:root@pam:` })
      return { sid: `${m[1]}:${m[2]}`, 'requested-node': node }
    }
    throw new Error(`unexpected write ${method} ${path}`)
  })
}

function newService() {
  return new PlacementService({
    pve: () => pve, prom: async () => [], store,
    audit: async (action, resource, details) => { if (failAudit) throw new Error('db down'); audits.push({ action, resource, details }) },
    isUnlocked: () => true, nodeExec: async () => null, now: () => clock, sleep: () => new Promise(r => setImmediate(r)), pollMs: 1, cacheMs: 0, taskTimeoutMs: 50,
    approverRole: async email => (email in roles ? roles[email] : null),
    alert: async (title) => { alerts.push(title) },
  })
}

before(async () => {
  setBroker(broker)
  setApiTokenStore(tokens)
  setAuditSink({ async write() {} })
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  svc = newService()
  app = Fastify({ logger: false })
  await registerGate(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(buildPlacementRoutes({ service: () => svc }), { prefix: '/api/placement' })
  await app.ready()
})
after(async () => { setApiTokenStore(null); setAuditSink(null); if (isUnlocked()) await lock('manual'); await app.close() })

function reset() {
  fixture = placementFixture(); pve = makePve(); store = new MemoryPlacementStore(); svc = newService()
  audits.length = 0; alerts.length = 0; failAudit = false; clock = Date.UTC(2026, 5, 15, 12, 0)
  for (const k of Object.keys(roles)) delete roles[k]
  roles['admin@example.com'] = 'admin'
}
const settle = async (id: string) => {
  for (let i = 0; i < 2000; i++) { const m = await store.get(id); if (m && m.status !== 'running' && m.status !== 'stuck') return m; await new Promise(r => setImmediate(r)) }
  return store.get(id)
}
const B = '/api/placement'
async function admin() {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  return cookie
}
async function reconfirmed() {
  const cookie = await admin()
  const rc = await app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie }, payload: { password: 'admin master password' } })
  assert.equal(rc.statusCode, 200)
  return cookie
}

test('the role matrix: reads are viewer, the check admin, the move admin and re-confirmed', () => {
  for (const u of ['map', 'advice', 'settings', 'moves', 'moves/mv1', 'guests/lxc/107']) assert.equal(requiredRole('GET', `${B}/${u}`), 'viewer', u)
  assert.equal(requiredRole('POST', `${B}/guests/lxc/107/check`), 'admin')
  assert.equal(requiredRole('POST', `${B}/guests/lxc/107/move`), 'admin')
  assert.equal(requiredRole('POST', `${B}/guests/lxc/107/paths`), 'admin')
  assert.equal(requiredRole('PUT', `${B}/settings`), 'admin')
  assert.equal(needsReconfirm('POST', `${B}/guests/lxc/107/move`), true)
  assert.equal(needsReconfirm('POST', `${B}/guests/lxc/107/check`), false)
  assert.equal(requiredRole('GET', `${B}/something-new`), 'admin', 'a new read stays admin until listed')
})

test('a viewer sees the map and cannot check or move', async () => {
  reset()
  const { cookie } = await signIn(app, 'viewer@example.com', 'viewer master password')
  const r = await app.inject({ method: 'GET', url: `${B}/map`, headers: { cookie } })
  assert.equal(r.statusCode, 200, r.body)
  assert.equal(r.json().data.map.guests.length, 8)
  for (const u of ['check', 'move']) {
    const x = await app.inject({ method: 'POST', url: `${B}/guests/lxc/107/${u}`, headers: { cookie }, payload: { target: 'node2' } })
    assert.equal(x.statusCode, 403, u)
  }
  assert.equal(pve.writes.length, 0)
})

test('an admin must re-enter the master password; an API token never can', async () => {
  reset()
  const cookie = await admin()
  const r = await app.inject({ method: 'POST', url: `${B}/guests/lxc/107/move`, headers: { cookie }, payload: { target: 'node2' } })
  assert.equal(r.statusCode, 403)
  assert.equal(r.json().code, 'reconfirm_required')
  const t = (await createApiToken({ name: 'auto', role: 'admin' }, 'test', tokens)).token
  const rt = await app.inject({ method: 'POST', url: `${B}/guests/lxc/107/move`, headers: { authorization: `Bearer ${t}` }, payload: { target: 'node2' } })
  assert.equal(rt.statusCode, 403)
  assert.equal(pve.writes.length, 0)
  assert.equal(audits.length, 0)
})

test('the check shows downtime, data, network cost and the exact call; it changes nothing', async () => {
  reset()
  const cookie = await admin()
  const r = await app.inject({ method: 'POST', url: `${B}/guests/lxc/107/check`, headers: { cookie }, payload: { target: 'node2' } })
  assert.equal(r.statusCode, 200, r.body)
  const p = r.json().data
  assert.equal(p.allowed, true)
  assert.equal(p.method, 'migrate')
  assert.ok(p.downtimeSec >= 10)
  assert.equal(p.network.shared, true)
  assert.equal(p.bwlimitKiB, 51200, 'corosync shares the network: the conservative limit')
  assert.equal(p.call, 'POST /nodes/node1/lxc/107/migrate  target=node2 restart=1 bwlimit=51200')
  assert.equal(p.quiet.quietNow, true)
  assert.equal(pve.writes.length, 0)
  const no = await app.inject({ method: 'POST', url: `${B}/guests/lxc/101/check`, headers: { cookie }, payload: { target: 'node2' } })
  assert.equal(no.json().data.allowed, false)
  assert.ok(no.json().data.refusals.some((x: string) => /bind mount/.test(x)))
})

test('a plain move: audit row first, form-encoded migrate with restart and bwlimit, task waited on, read back on the target', async () => {
  reset()
  const cookie = await reconfirmed()
  const r = await app.inject({ method: 'POST', url: `${B}/guests/lxc/107/move`, headers: { cookie }, payload: { target: 'node2' } })
  assert.equal(r.statusCode, 200, r.body)
  assert.equal(audits[0].action, 'placement.move')
  assert.equal(audits[0].details!.by, 'admin@example.com')
  const m = await settle(r.json().data.id)
  assert.equal(m!.status, 'done', m!.error ?? '')
  assert.deepEqual(pve.writes.map(w => [w.method, w.path, w.body]), [['POST', '/nodes/node1/lxc/107/migrate', 'target=node2&restart=1&bwlimit=51200']])
  assert.match(m!.upid!, /^UPID:node1:/)
  assert.ok(pve.reads.some(p => p.startsWith('/nodes/node1/tasks/') && p.endsWith('/status')), 'the task was waited on')
  assert.ok(audits.some(a => a.action === 'placement.move.result' && a.details!.ok === true))
})

test('no audit row, no move', async () => {
  reset()
  failAudit = true
  const cookie = await reconfirmed()
  const r = await app.inject({ method: 'POST', url: `${B}/guests/lxc/107/move`, headers: { cookie }, payload: { target: 'node2' } })
  assert.notEqual(r.statusCode, 200)
  assert.equal(pve.writes.length, 0)
  assert.equal((await store.list()).length, 0)
})

test('an HA guest moves through HA (never a plain migrate), and is verified on the target', async () => {
  reset()
  const cookie = await reconfirmed()
  const r = await app.inject({ method: 'POST', url: `${B}/guests/lxc/108/move`, headers: { cookie }, payload: { target: 'node3', bwlimitKiB: 20480 } })
  assert.equal(r.statusCode, 200, r.body)
  const m = await settle(r.json().data.id)
  assert.equal(m!.status, 'done', m!.error ?? '')
  assert.equal(m!.method, 'ha')
  assert.deepEqual(pve.writes.map(w => [w.path, w.body]), [['/cluster/ha/resources/ct%3A108/migrate', 'node=node3']])
  assert.ok(!pve.writes.some(w => /\/lxc\/108\/migrate$/.test(w.path)))
  assert.match(m!.upid!, /vzmigrate:108/, 'the task HA started was found and waited on')
  assert.equal(m!.bwlimitKiB, null, 'HA takes no bandwidth limit of its own')
})

test('a move to where Proxmox would refuse is refused before any call: a lower-ranked node under a preferred-node rule', async () => {
  reset()
  const cookie = await reconfirmed()
  const r = await app.inject({ method: 'POST', url: `${B}/guests/lxc/102/move`, headers: { cookie }, payload: { target: 'node3' } })
  assert.equal(r.statusCode, 409)
  assert.match(r.json().error, /change the rule/)
  assert.equal(pve.writes.length, 0)
})

test('a failed task is a failed move, with Proxmox\'s reason; a task that "succeeds" with the guest elsewhere is failed too', async () => {
  reset()
  const cookie = await reconfirmed()
  // The task fails.
  const failing = fakePve(fixture, () => 'UPID:node1:1:2:3:vzmigrate:107:root@pam:')
  fixture['/nodes/node1/tasks/UPID%3Anode1%3A1%3A2%3A3%3Avzmigrate%3A107%3Aroot%40pam%3A/status'] = { status: 'stopped', exitstatus: 'migration aborted' }
  pve = failing
  const r = await app.inject({ method: 'POST', url: `${B}/guests/lxc/107/move`, headers: { cookie }, payload: { target: 'node2' } })
  const m = await settle(r.json().data.id)
  assert.equal(m!.status, 'failed')
  assert.match(m!.error!, /migration aborted/)
  // The task says OK but the guest never left: not "done".
  reset()
  const c2 = await reconfirmed()
  pve = fakePve(fixture, () => 'UPID:node1:9:9:9:vzmigrate:107:root@pam:')
  const r2 = await app.inject({ method: 'POST', url: `${B}/guests/lxc/107/move`, headers: { cookie: c2 }, payload: { target: 'node2' } })
  const m2 = await settle(r2.json().data.id)
  assert.equal(m2!.status, 'failed')
  assert.match(m2!.error!, /is on node1, not node2/)
})

test('outside a quiet window: refused without "move anyway"; with it, it moves; or it is scheduled and run later', async () => {
  reset()
  clock = Date.UTC(2026, 5, 15, 1, 50)   // ten minutes before the 02:00 backup
  const cookie = await reconfirmed()
  const r = await app.inject({ method: 'POST', url: `${B}/guests/lxc/107/move`, headers: { cookie }, payload: { target: 'node2' } })
  assert.equal(r.statusCode, 409)
  assert.equal(r.json().code, 'not-quiet')
  assert.ok(r.json().nextQuiet.start > clock)
  assert.equal(pve.writes.length, 0)

  const s = await app.inject({ method: 'POST', url: `${B}/guests/lxc/107/move`, headers: { cookie }, payload: { target: 'node2', when: 'next-quiet' } })
  assert.equal(s.statusCode, 200, s.body)
  const rec = s.json().data
  assert.equal(rec.status, 'scheduled')
  assert.ok(rec.scheduledFor >= Date.UTC(2026, 5, 15, 5, 0), 'after the backup window')
  assert.equal(audits.at(-1)!.action, 'placement.move.schedule')
  await svc.tick()
  assert.equal((await store.get(rec.id))!.status, 'scheduled', 'not due yet')
  clock = rec.scheduledFor + 60_000
  await svc.tick()
  const done = await settle(rec.id)
  assert.equal(done!.status, 'done', done!.error ?? '')
  assert.equal(pve.writes.length, 1)

  reset()
  clock = Date.UTC(2026, 5, 15, 1, 50)
  const c3 = await reconfirmed()
  const any = await app.inject({ method: 'POST', url: `${B}/guests/lxc/107/move`, headers: { cookie: c3 }, payload: { target: 'node2', anyway: true } })
  assert.equal(any.statusCode, 200, any.body)
  assert.equal(audits[0].details!.anyway, true, 'the audit row says it was moved anyway')
  assert.equal((await settle(any.json().data.id))!.status, 'done')
})

test('a scheduled move is skipped, with the reason, when it no longer fits or its window passed', async () => {
  reset()
  clock = Date.UTC(2026, 5, 15, 1, 50)
  const cookie = await reconfirmed()
  const s = await app.inject({ method: 'POST', url: `${B}/guests/lxc/107/move`, headers: { cookie }, payload: { target: 'node2', when: 'next-quiet' } })
  const rec = s.json().data
  // In the meantime node2 went into maintenance.
  clock = rec.scheduledFor + 60_000
  ;(fixture['/cluster/ha/status/current'] as any[]).push({ type: 'lrm', node: 'node2', status: 'maintenance mode' })
  await svc.tick()
  const m = await store.get(rec.id)
  assert.equal(m!.status, 'skipped')
  assert.match(m!.error!, /maintenance/)
  assert.equal(pve.writes.length, 0)
  // A missed window.
  reset()
  const r2 = await store.create({ sid: 'ct:107', name: 'worker', fromNode: 'node1', toNode: 'node2', source: 'hyperprox', method: 'migrate', status: 'scheduled', scheduledFor: clock - 3600_000 })
  await svc.tick()
  assert.match((await store.get(r2.id))!.error!, /window passed/)
})

test('a scheduled move can be cancelled, atomically: once cancelled the scheduler never runs it, and a claimed one cannot be cancelled', async () => {
  reset()
  const r = await store.create({ sid: 'ct:107', name: 'worker', fromNode: 'node1', toNode: 'node2', source: 'hyperprox', method: 'migrate', status: 'scheduled', scheduledFor: clock - 60_000, by: 'admin@example.com' })
  const cookie = await admin()
  const c = await app.inject({ method: 'POST', url: `${B}/moves/${r.id}/cancel`, headers: { cookie } })
  assert.equal(c.statusCode, 200, c.body)
  assert.equal((await store.get(r.id))!.status, 'cancelled')
  await svc.tick()
  assert.equal(pve.writes.length, 0, 'a cancelled move never runs')
  assert.equal((await store.get(r.id))!.status, 'cancelled')
  // Claimed by the scheduler (scheduled -> running): the cancel loses, and says what it is now.
  const r2 = await store.create({ sid: 'ct:107', name: 'worker', fromNode: 'node1', toNode: 'node2', source: 'hyperprox', method: 'migrate', status: 'scheduled', scheduledFor: clock + 3600_000 })
  assert.ok(await store.transition(r2.id, { status: ['scheduled'] }, { status: 'running' }))
  assert.equal(await store.transition(r2.id, { status: ['scheduled'] }, { status: 'running' }), null, 'a second claim gets nothing')
  const c2 = await app.inject({ method: 'POST', url: `${B}/moves/${r2.id}/cancel`, headers: { cookie } })
  assert.equal(c2.statusCode, 409)
  assert.match(c2.json().error, /It is running/)
})

test('the scheduler never overlaps itself: two ticks at once run a due move once', async () => {
  reset()
  const r = await store.create({ sid: 'ct:107', name: 'worker', fromNode: 'node1', toNode: 'node2', source: 'hyperprox', method: 'migrate', status: 'scheduled', scheduledFor: clock - 60_000, by: 'admin@example.com' })
  await Promise.all([svc.tick(), svc.tick(), svc.tick()])
  assert.equal((await settle(r.id))!.status, 'done')
  assert.equal(pve.writes.length, 1)
})

test('restarts and second processes: a live watcher is left alone; a stale one with a task is taken over and watched to its end; one without a task is stuck', async () => {
  reset()
  // Another process, beating: untouched.
  const live = await store.create({ sid: 'ct:107', name: 'worker', fromNode: 'node1', toNode: 'node2', source: 'hyperprox', method: 'migrate', status: 'running', startedAt: clock, owner: 'other@1', heartbeatAt: clock - 60_000, upid: 'UPID:node1:1:1:1:vzmigrate:107:root@pam:' })
  await svc.tick()
  assert.equal((await store.get(live.id))!.owner, 'other@1')
  assert.equal((await store.get(live.id))!.status, 'running')
  // Its heartbeat goes stale: claimed, watched (no new Proxmox call), read back.
  ;(fixture['/cluster/resources?type=vm'] as any[]).find(v => v.vmid === 107).node = 'node2'
  clock += 10 * 60_000
  await svc.tick()
  const m = await settle(live.id)
  assert.equal(m!.status, 'done', m!.error ?? '')
  assert.equal(m!.owner, svc.owner)
  assert.equal(pve.writes.length, 0, 'taking over never repeats the migrate')
  // Stale and no task id: nobody can know where it got to, so it is stuck, with an alert.
  reset()
  const lost = await store.create({ sid: 'ct:107', name: 'worker', fromNode: 'node1', toNode: 'node2', source: 'hyperprox', method: 'migrate', status: 'running', startedAt: clock - 3600_000, owner: 'dead@1', heartbeatAt: clock - 3600_000 })
  await svc.tick()
  const l = await store.get(lost.id)
  assert.equal(l!.status, 'stuck')
  assert.match(l!.error!, /Resolve/)
  assert.equal(alerts.length, 1)
})

test('a task that outlives the wait is stuck, not failed: the slot stays held and an alert goes out until Proxmox shows it stopped', async () => {
  reset()
  const cookie = await reconfirmed()
  let release = false
  const key = '/nodes/node1/tasks/UPID%3Anode1%3A0000AAAA%3A0000BBBB%3A6AF89939%3Avzmigrate%3A107%3Aroot%40pam!hyperprox%3A/status'
  Object.defineProperty(fixture, key, { get: () => (release ? { status: 'stopped', exitstatus: 'OK' } : { status: 'running' }), configurable: true, enumerable: true })
  const r = await app.inject({ method: 'POST', url: `${B}/guests/lxc/107/move`, headers: { cookie }, payload: { target: 'node2' } })
  assert.equal(r.statusCode, 200, r.body)
  const id = r.json().data.id
  for (let i = 0; i < 2000 && (await store.get(id))!.status !== 'stuck'; i++) await new Promise(res => setImmediate(res))
  assert.equal((await store.get(id))!.status, 'stuck')
  assert.match((await store.get(id))!.error!, /still running after/)
  assert.equal(alerts.length, 1)
  const second = await app.inject({ method: 'POST', url: `${B}/guests/lxc/108/move`, headers: { cookie }, payload: { target: 'node3' } })
  assert.equal(second.statusCode, 409, 'no other move while one may still be running')
  assert.equal(second.json().code, 'busy')
  release = true
  const m = await settle(id)
  assert.equal(m!.status, 'done', m!.error ?? '')
  const third = await app.inject({ method: 'POST', url: `${B}/guests/lxc/108/move`, headers: { cookie }, payload: { target: 'node3' } })
  assert.equal(third.statusCode, 200, third.body)
})

test('resolve: a stuck move is settled by hand only once Proxmox shows its task stopped', async () => {
  reset()
  const upid = 'UPID:node1:7:7:7:vzmigrate:107:root@pam:'
  const key = `/nodes/node1/tasks/${encodeURIComponent(upid)}/status`
  fixture[key] = { status: 'running' }
  const s = await store.create({ sid: 'ct:107', name: 'worker', fromNode: 'node1', toNode: 'node2', source: 'hyperprox', method: 'migrate', status: 'stuck', upid, owner: 'dead@1', heartbeatAt: clock, startedAt: clock, snapshot: { running: true, type: 'lxc' } })
  const cookie = await admin()
  const early = await app.inject({ method: 'POST', url: `${B}/moves/${s.id}/resolve`, headers: { cookie } })
  assert.equal(early.statusCode, 409)
  assert.match(early.json().error, /still running/)
  fixture[key] = { status: 'stopped', exitstatus: 'OK' }
  ;(fixture['/cluster/resources?type=vm'] as any[]).find(v => v.vmid === 107).node = 'node2'
  const ok = await app.inject({ method: 'POST', url: `${B}/moves/${s.id}/resolve`, headers: { cookie } })
  assert.equal(ok.statusCode, 200, ok.body)
  assert.equal((await store.get(s.id))!.status, 'done')
  assert.ok(audits.some(a => a.action === 'placement.move.resolve'))
})

test('history: Proxmox migrations from the task log are kept, with the target read from the task log', async () => {
  reset()
  ;(fixture['/cluster/tasks'] as any[]).push({ type: 'vzmigrate', id: '107', node: 'node1', starttime: 1_790_000_000, endtime: 1_790_000_030, status: 'OK', user: 'root@pam', upid: 'UPID:node1:5:6:7:vzmigrate:107:root@pam:' })
  fixture['/nodes/node1/tasks/UPID%3Anode1%3A5%3A6%3A7%3Avzmigrate%3A107%3Aroot%40pam%3A/log?limit=40'] = [{ t: "starting migration of CT 107 to node 'node3' (192.0.2.13)" }]
  const cookie = await admin()
  // A read never syncs: no task logs fetched, nothing written.
  const before = await app.inject({ method: 'GET', url: `${B}/moves`, headers: { cookie } })
  assert.deepEqual(before.json().data, [])
  assert.ok(!pve.reads.some(r => r.includes('/log')), 'no per-task fan-out on a viewer read')
  await svc.tick()
  const h = await app.inject({ method: 'GET', url: `${B}/moves`, headers: { cookie } })
  assert.equal(h.statusCode, 200, h.body)
  const rows = h.json().data
  assert.equal(rows.length, 1)
  assert.deepEqual([rows[0].source, rows[0].fromNode, rows[0].toNode, rows[0].status], ['proxmox', 'node1', 'node3', 'done'])
  const g = await app.inject({ method: 'GET', url: `${B}/guests/lxc/107`, headers: { cookie } })
  assert.match(g.json().data.lastMove.words, /Corosync around this move has not been checked/)
  clock += 11 * 60_000
  await svc.tick()
  assert.equal((await store.list()).length, 1, 'once per task')
})

test('settings: the master password is needed to save; checked field by field, unknown fields refused, saved and audited', async () => {
  reset()
  assert.equal(needsReconfirm('PUT', `${B}/settings`), true)
  const plain = await admin()
  const no = await app.inject({ method: 'PUT', url: `${B}/settings`, headers: { cookie: plain }, payload: { bwlimitKiB: 30720 } })
  assert.equal(no.statusCode, 403)
  assert.equal(no.json().code, 'reconfirm_required')
  const cookie = await reconfirmed()
  const bad = await app.inject({ method: 'PUT', url: `${B}/settings`, headers: { cookie }, payload: { cpuAbove: 5, nonsense: 1 } })
  assert.equal(bad.statusCode, 400)
  assert.match(bad.json().error, /Unknown setting: nonsense/)
  const ok = await app.inject({ method: 'PUT', url: `${B}/settings`, headers: { cookie }, payload: { busyHours: [{ days: [5, 6], start: '19:00', end: '01:00', label: 'evenings' }], bwlimitKiB: 30720 } })
  assert.equal(ok.statusCode, 200, ok.body)
  assert.equal((await store.settings()).bwlimitKiB, 30720)
  assert.ok(audits.some(a => a.action === 'placement.settings'))
})

test('migrate parameters: a running VM moves online with its local disks; a stopped one offline', () => {
  assert.equal(migrateParams({ type: 'qemu', status: 'running', local: true }, 'n2', 20480).toString(), 'target=n2&online=1&with-local-disks=1&bwlimit=20480')
  assert.equal(migrateParams({ type: 'qemu', status: 'stopped' }, 'n2', null).toString(), 'target=n2')
  assert.equal(migrateParams({ type: 'lxc', status: 'stopped' }, 'n2', null).toString(), 'target=n2')
})

test('one move at a time: two requests at once start one move; a running row from another process blocks too', async () => {
  reset()
  const cookie = await reconfirmed()
  // Two calls in the same turn: the first takes the slot before it awaits anything, so the second is refused at once.
  const actor = { email: 'admin@example.com' }
  const [a, b] = await Promise.allSettled([svc.move('ct:107', 'node2', {}, actor), svc.move('ct:108', 'node3', {}, actor)])
  assert.equal(a.status, 'fulfilled')
  assert.equal(b.status, 'rejected')
  assert.equal((b as PromiseRejectedResult).reason.code, 'busy')
  await settle((a as PromiseFulfilledResult<any>).value.id)
  assert.equal(pve.writes.length, 1)
  void cookie
  // The database's own claim: another process holds a running row.
  reset()
  await store.create({ sid: 'ct:108', name: 'hafree', fromNode: 'node2', toNode: 'node3', source: 'hyperprox', method: 'ha', status: 'running', owner: 'other@1', heartbeatAt: clock })
  const c2 = await reconfirmed()
  const r = await app.inject({ method: 'POST', url: `${B}/guests/lxc/107/move`, headers: { cookie: c2 }, payload: { target: 'node2' } })
  assert.equal(r.statusCode, 409)
  assert.equal(pve.writes.length, 0)
  // And the store itself refuses a second in-flight row, whatever the caller checked first.
  await assert.rejects(() => store.create({ sid: 'ct:107', name: 'w', fromNode: 'node1', toNode: 'node2', source: 'hyperprox', method: 'migrate', status: 'running' }), /One at a time/)
})

test('a refused move frees the slot: the next request is checked normally', async () => {
  reset()
  const cookie = await reconfirmed()
  const no = await app.inject({ method: 'POST', url: `${B}/guests/lxc/101/move`, headers: { cookie }, payload: { target: 'node2' } })
  assert.equal(no.statusCode, 409)
  assert.equal(no.json().code, 'refused')
  const yes = await app.inject({ method: 'POST', url: `${B}/guests/lxc/107/move`, headers: { cookie }, payload: { target: 'node2' } })
  assert.equal(yes.statusCode, 200, yes.body)
  await settle(yes.json().data.id)
})

test('a guest whose config cannot be read is refused, and an unread task log refuses every move', async () => {
  reset()
  delete fixture['/nodes/node1/lxc/107/config']
  const cookie = await reconfirmed()
  const r = await app.inject({ method: 'POST', url: `${B}/guests/lxc/107/move`, headers: { cookie }, payload: { target: 'node2' } })
  assert.equal(r.statusCode, 409)
  assert.match(r.json().error, /configuration could not be read/)
  reset()
  delete fixture['/cluster/tasks']
  const c2 = await reconfirmed()
  const r2 = await app.inject({ method: 'POST', url: `${B}/guests/lxc/108/move`, headers: { cookie: c2 }, payload: { target: 'node3' } })
  assert.equal(r2.statusCode, 409)
  assert.match(r2.json().error, /task log could not be read/)
  assert.equal(pve.writes.length, 0)
})

test('an unread backup job list: no "now" without anyway, and nothing to schedule into', async () => {
  reset()
  delete fixture['/cluster/backup']
  const cookie = await reconfirmed()
  const r = await app.inject({ method: 'POST', url: `${B}/guests/lxc/107/move`, headers: { cookie }, payload: { target: 'node2' } })
  assert.equal(r.json().code, 'not-quiet')
  const s = await app.inject({ method: 'POST', url: `${B}/guests/lxc/107/move`, headers: { cookie }, payload: { target: 'node2', when: 'next-quiet' } })
  assert.equal(s.json().code, 'no-window')
  const any = await app.inject({ method: 'POST', url: `${B}/guests/lxc/107/move`, headers: { cookie }, payload: { target: 'node2', anyway: true } })
  assert.equal(any.statusCode, 200, any.body)
  await settle(any.json().data.id)
})

test('a scheduled move runs under the settings it was approved with, not ones changed after', async () => {
  reset()
  clock = Date.UTC(2026, 5, 15, 1, 50)
  const cookie = await reconfirmed()
  const s = await app.inject({ method: 'POST', url: `${B}/guests/lxc/107/move`, headers: { cookie }, payload: { target: 'node2', when: 'next-quiet' } })
  const rec = s.json().data
  assert.equal(rec.snapshot.settings.bwlimitKiB, 51200)
  // Changed afterwards: a busy-hours block over the whole day, and a far higher bandwidth limit.
  await store.saveSettings({ ...(await store.settings()), bwlimitKiB: 900_000, busyHours: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59' }] }, 'x')
  clock = rec.scheduledFor + 60_000
  await svc.tick()
  const done = await settle(rec.id)
  assert.equal(done!.status, 'done', done!.error ?? '')
  assert.match(pve.writes[0].body, /bwlimit=51200/)
})

test('a scheduled run is audited or it does not run; and only while its approver is still an admin', async () => {
  for (const [who, role, want] of [['admin@example.com', 'operator', /is now operator, not admin/], ['admin@example.com', null, /no longer a member/]] as const) {
    reset()
    roles[who] = role
    const r = await store.create({ sid: 'ct:107', name: 'worker', fromNode: 'node1', toNode: 'node2', source: 'hyperprox', method: 'migrate', status: 'scheduled', scheduledFor: clock - 60_000, by: who })
    await svc.tick()
    const m = await store.get(r.id)
    assert.equal(m!.status, 'skipped')
    assert.match(m!.error!, want)
    assert.equal(pve.writes.length, 0)
  }
  reset()
  const r = await store.create({ sid: 'ct:107', name: 'worker', fromNode: 'node1', toNode: 'node2', source: 'hyperprox', method: 'migrate', status: 'scheduled', scheduledFor: clock - 60_000, by: 'admin@example.com' })
  failAudit = true
  await svc.tick()
  assert.match((await store.get(r.id))!.error!, /audit row could not be written/)
  assert.equal(pve.writes.length, 0)
})

test('the task id race: a copy the history sync saved first is replaced by the move\'s own row, never left as a duplicate', async () => {
  reset()
  const upid = 'UPID:node1:0000AAAA:0000BBBB:6AF89939:vzmigrate:107:root@pam!hyperprox:'
  await store.upsertSeen({ upid, sid: 'ct:107', name: 'worker', fromNode: 'node1', toNode: 'node2', source: 'proxmox', method: null, status: 'done' })
  const cookie = await reconfirmed()
  const r = await app.inject({ method: 'POST', url: `${B}/guests/lxc/107/move`, headers: { cookie }, payload: { target: 'node2' } })
  const m = await settle(r.json().data.id)
  assert.equal(m!.status, 'done', m!.error ?? '')
  const rows = (await store.list()).filter(x => x.upid === upid)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].source, 'hyperprox')
})
