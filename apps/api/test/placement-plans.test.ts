// Load balancing plans and automatic balancing behind the real vault gate. A plan is approved once (admin, master
// password re-entered; never an API token), audited at creation and at each move, and run one move at a time through
// the same safe move path as a single move. Before each move it checks the cluster again: quorum, the nodes that were
// online, Ceph against what it was when approved, where the guest is, and whether the move still evens the load out.
// A failed move, a refusal or any change stops the plan. Automatic balancing is off by default, notifies only unless
// "apply automatically" was re-confirmed, moves one non-HA guest at a time within its limits, and has an emergency stop.
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
import { MemoryApiTokenStore, setApiTokenStore, createApiToken, tokenForbidden } from '../src/lib/api-tokens'
import { requiredRole, needsReconfirm } from '../src/lib/roles'
import { PlacementService } from '../src/lib/placement/service'
import { MemoryPlacementStore } from '../src/lib/placement/store'
import type { PromRange } from '../src/lib/placement/read'
import type { Sample } from '../src/lib/placement/types'
import { FakeBroker } from './fakes/fake-broker'
import { signIn } from './fakes/app'
import { placementFixture, fakePve } from './fakes/placement-cluster'
import { balanceSource } from '../src/lib/ai/placement-source'

const G = 1024 ** 3
const broker = new FakeBroker()
broker.addUser('admin@example.com', 'admin master password', 'admin')
broker.addUser('viewer@example.com', 'viewer master password', 'viewer')
const tokens = new MemoryApiTokenStore()

let clock = Date.UTC(2026, 5, 15, 12, 0)   // noon UTC: quiet (the fixture's backup job is at 02:00)
const audits: Array<{ action: string; resource: string; details?: Record<string, unknown> }> = []
const notes: Array<{ title: string; lines: string[] }> = []
const changed: Record<string, string | null> = {}
let fixture = placementFixture()
let failMigrate: string | null = null
let afterMove: ((n: number) => void) | null = null
let moves = 0
let pve = makePve()
let store = new MemoryPlacementStore()
let svc: PlacementService
let app: FastifyInstance

/** Node memory as a share of each node, and guests' memory: node1 is busy, node2 and node3 are not. */
let nodeMem: Record<string, number> = { node1: 0.85, node2: 0.3, node3: 0.35 }
let guestMem: Record<string, number> = { 'lxc/107': 4 * G, 'lxc/109': 2 * G }
const prom: PromRange = async (expr, start, end, step) => {
  const ts: number[] = []
  for (let t = start; t <= end; t += step) ts.push(t)
  const flat = (v: number): Sample[] => ts.map(t => [t, v])
  if (/id=~"node\/\.\+"/.test(expr) && /pve_memory_usage_bytes/.test(expr)) return Object.entries(nodeMem).map(([n, v]) => ({ metric: { id: `node/${n}` }, values: flat(v) }))
  if (/id=~"node\/\.\+"/.test(expr)) return Object.keys(nodeMem).map(n => ({ metric: { id: `node/${n}` }, values: flat(0.2) }))
  if (/pve_memory_usage_bytes/.test(expr)) return Object.entries(guestMem).map(([id, v]) => ({ metric: { id }, values: flat(v) }))
  return Object.keys(guestMem).map(id => ({ metric: { id }, values: flat(0.1) }))
}

/** A second free container on node1, so a plan has two moves. */
function withSecondWorker(f: Record<string, any>) {
  ;(f['/cluster/resources?type=vm'] as any[]).push({ id: 'lxc/109', vmid: 109, type: 'lxc', name: 'worker2', node: 'node1', status: 'running', maxcpu: 2, cpu: 0.1, mem: 2 * G, maxmem: 4 * G, template: 0 })
  f['/nodes/node1/lxc/109/config'] = { cores: 2, memory: 4096, rootfs: 'shared-rbd:vm-109-disk-0,size=8G' }
  f['/nodes/node1/lxc/109/migrate'] = {}
  return f
}

function makePve() {
  return fakePve(fixture, (method, path, body) => {
    const vms = fixture['/cluster/resources?type=vm'] as any[]
    const m = /^\/nodes\/([^/]+)\/(lxc|qemu)\/(\d+)\/migrate$/.exec(path)
    if (m && method === 'POST') {
      const target = new URLSearchParams(body).get('target')!
      const upid = `UPID:${m[1]}:0000AAAA:0000BBBB:6AF89939:vzmigrate:${m[3]}:root@pam!hyperprox:`
      moves++
      if (failMigrate === m[3]) {
        fixture[`/nodes/${m[1]}/tasks/${encodeURIComponent(upid)}/status`] = { status: 'stopped', exitstatus: 'migration aborted' }
      } else {
        const v = vms.find(x => String(x.vmid) === m![3])!
        v.node = target
        // The guest's config now lives on the target.
        fixture[`/nodes/${target}/lxc/${m[3]}/config`] = fixture[`/nodes/${m[1]}/lxc/${m[3]}/config`]
        fixture[`/nodes/${target}/lxc/${m[3]}/migrate`] = {}
      }
      afterMove?.(moves)
      return upid
    }
    throw new Error(`unexpected write ${method} ${path}`)
  })
}

function newService() {
  return new PlacementService({
    pve: () => pve, prom, store,
    audit: async (action, resource, details) => { audits.push({ action, resource, details }) },
    isUnlocked: () => true, nodeExec: async () => null, now: () => clock, sleep: () => new Promise(r => setImmediate(r)), pollMs: 1, cacheMs: 0, taskTimeoutMs: 50,
    approverChanged: async email => changed[email] ?? null,
    notify: async (title, lines) => { notes.push({ title, lines }) },
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

function reset(two = true) {
  fixture = two ? withSecondWorker(placementFixture()) : placementFixture()
  pve = makePve(); store = new MemoryPlacementStore(); svc = newService()
  audits.length = 0; notes.length = 0; failMigrate = null; afterMove = null; moves = 0; clock = Date.UTC(2026, 5, 15, 12, 0)
  nodeMem = { node1: 0.85, node2: 0.3, node3: 0.35 }
  guestMem = { 'lxc/107': 4 * G, 'lxc/109': 2 * G }
  for (const k of Object.keys(changed)) delete changed[k]
}
const B = '/api/placement'
const admin = async () => (await signIn(app, 'admin@example.com', 'admin master password')).cookie
async function reconfirmed() {
  const cookie = await admin()
  const rc = await app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie }, payload: { password: 'admin master password' } })
  assert.equal(rc.statusCode, 200)
  return cookie
}
const settlePlan = async (id: string) => {
  for (let i = 0; i < 5000; i++) { const p = await store.getPlan(id); if (p && p.status !== 'running') return p; await new Promise(r => setImmediate(r)) }
  return store.getPlan(id)
}
const actorAdmin = { email: 'admin@example.com', role: 'admin' }
async function proposed(cookie: string) {
  const r = await app.inject({ method: 'GET', url: `${B}/balance?goal=mem`, headers: { cookie } })
  assert.equal(r.statusCode, 200, r.body)
  return r.json().data
}

test('the role matrix: balance, plans and auto are viewer reads; running a plan and saving auto are admin, re-confirmed and never a token', () => {
  for (const u of ['balance', 'plans', 'plans/pl1', 'auto']) assert.equal(requiredRole('GET', `${B}/${u}`), 'viewer', u)
  assert.equal(requiredRole('POST', `${B}/plans`), 'admin')
  assert.equal(requiredRole('PUT', `${B}/auto`), 'admin')
  assert.equal(requiredRole('POST', `${B}/plans/pl1/stop`), 'admin')
  assert.equal(requiredRole('POST', `${B}/auto/stop`), 'admin')
  assert.equal(needsReconfirm('POST', `${B}/plans`), true)
  assert.equal(needsReconfirm('PUT', `${B}/auto`), true)
  assert.equal(needsReconfirm('POST', `${B}/plans/pl1/stop`), false, 'stopping is always safe')
  assert.equal(needsReconfirm('POST', `${B}/auto/stop`), false, 'the emergency stop needs no password')
  assert.equal(tokenForbidden('POST', `${B}/plans`), true)
  assert.equal(tokenForbidden('PUT', `${B}/auto`), true)
  assert.equal(tokenForbidden('POST', `${B}/guests/lxc/107/move`), true)
  assert.equal(tokenForbidden('GET', `${B}/balance`), false)
})

test('the balance: per-node load, a score, a headline, and a plan that evens it out', async () => {
  reset()
  const { cookie } = await signIn(app, 'viewer@example.com', 'viewer master password')
  const v = await proposed(cookie)
  assert.equal(v.uneven, true)
  assert.match(v.headline, /^Uneven: node1 carries \d+% of the memory in use and runs at 85% of its own/)
  assert.equal(v.nodes.length, 3)
  assert.ok(v.nodes.every((n: any) => n.history.mem.length > 0), 'hourly history for the sparklines')
  assert.deepEqual(v.plan.steps.map((s: any) => [s.sid, s.from]), [['ct:107', 'node1'], ['ct:109', 'node1']])
  assert.ok(v.plan.target.score > v.plan.score.score)
  assert.ok(v.plan.words.some((w: string) => /auto-rebalance on/.test(w)), 'the fixture runs dynamic CRS with auto-rebalance: HA guests are left to it')
  assert.equal(v.auto.settings.enabled, false, 'automatic balancing is off by default')
  assert.equal(v.auto.settings.apply, false)
  assert.equal(v.quiet.quietNow, true)
  const x = await app.inject({ method: 'POST', url: `${B}/plans`, headers: { cookie }, payload: { expect: v.plan.steps.map((s: any) => ({ sid: s.sid, to: s.to })) } })
  assert.equal(x.statusCode, 403, 'a viewer cannot run it')
  assert.equal(pve.writes.length, 0)
})

test('running a plan needs the master password; an API token never can', async () => {
  reset()
  const cookie = await admin()
  const v = await proposed(cookie)
  const expect = v.plan.steps.map((s: any) => ({ sid: s.sid, to: s.to }))
  const r = await app.inject({ method: 'POST', url: `${B}/plans`, headers: { cookie }, payload: { expect, goal: 'mem' } })
  assert.equal(r.statusCode, 403)
  assert.equal(r.json().code, 'reconfirm_required')
  const t = (await createApiToken({ name: 'auto', role: 'admin' }, 'test', tokens)).token
  const rt = await app.inject({ method: 'POST', url: `${B}/plans`, headers: { authorization: `Bearer ${t}` }, payload: { expect, goal: 'mem' } })
  assert.equal(rt.statusCode, 403)
  const ra = await app.inject({ method: 'PUT', url: `${B}/auto`, headers: { authorization: `Bearer ${t}` }, payload: { enabled: true, apply: true } })
  assert.equal(ra.statusCode, 403)
  assert.equal(pve.writes.length, 0)
  assert.equal(audits.length, 0)
  assert.equal((await store.listPlans()).length, 0)
})

test('a plan runs its moves in sequence, each audited before Proxmox is called and through the safe move path', async () => {
  reset()
  const cookie = await reconfirmed()
  const v = await proposed(cookie)
  const expect = v.plan.steps.map((s: any) => ({ sid: s.sid, to: s.to }))
  const r = await app.inject({ method: 'POST', url: `${B}/plans`, headers: { cookie }, payload: { expect, goal: 'mem' } })
  assert.equal(r.statusCode, 200, r.body)
  const p = await settlePlan(r.json().data.id)
  assert.equal(p!.status, 'done', p!.error ?? '')
  assert.deepEqual(p!.steps.map(s => s.status), ['done', 'done'])
  assert.deepEqual(pve.writes.map(w => w.path), ['/nodes/node1/lxc/107/migrate', '/nodes/node1/lxc/109/migrate'], 'one at a time, in order')
  assert.ok(pve.writes.every(w => /restart=1/.test(w.body) && /bwlimit=51200/.test(w.body)), 'container restarts under the bandwidth limit')
  const acts = audits.map(a => a.action)
  assert.equal(acts[0], 'placement.plan.create')
  assert.deepEqual(audits[0].details!.moves, v.plan.steps.map((s: any) => `${s.sid} ${s.from}>${s.to}`))
  assert.equal(acts.filter(a => a === 'placement.plan.move').length, 2)
  assert.ok(acts.indexOf('placement.plan.move') < acts.indexOf('placement.move.result'), 'each move is audited before it runs')
  assert.equal(acts[acts.length - 1], 'placement.plan.result')
  for (const s of p!.steps) assert.equal((await store.get(s.moveId!))!.snapshot!.planId, p!.id)
  const detail = await app.inject({ method: 'GET', url: `${B}/plans/${p!.id}`, headers: { cookie } })
  assert.equal(detail.json().data.status, 'done', 'progress is readable')
})

test('the plan changed since it was shown: refused, nothing stored or moved', async () => {
  reset()
  const cookie = await reconfirmed()
  const r = await app.inject({ method: 'POST', url: `${B}/plans`, headers: { cookie }, payload: { expect: [{ sid: 'ct:107', to: 'node3' }], goal: 'mem' } })
  assert.equal(r.statusCode, 409)
  assert.equal(r.json().code, 'changed')
  assert.ok(r.json().plan.steps.length > 0, 'the new plan comes back to look at')
  assert.equal((await store.listPlans()).length, 0)
  assert.equal(audits.length, 0)
  assert.equal(pve.writes.length, 0)
})

test('a failed move stops the plan: the rest is skipped and nothing else moves', async () => {
  reset()
  failMigrate = '107'
  const cookie = await reconfirmed()
  const v = await proposed(cookie)
  const r = await app.inject({ method: 'POST', url: `${B}/plans`, headers: { cookie }, payload: { expect: v.plan.steps.map((s: any) => ({ sid: s.sid, to: s.to })), goal: 'mem' } })
  const p = await settlePlan(r.json().data.id)
  assert.equal(p!.status, 'failed')
  assert.deepEqual(p!.steps.map(s => s.status), ['failed', 'skipped'])
  assert.match(p!.error!, /Move 1 \(worker\) failed: .*migration aborted.*The rest of the plan did not run/)
  assert.equal(pve.writes.length, 1)
  assert.ok(notes.some(n => /plan failed/.test(n.title)), 'people are told')
})

test('re-checked before each move: a node going offline, lost quorum, or a new Ceph warning stops the plan', async () => {
  for (const change of ['offline', 'quorum', 'ceph'] as const) {
    reset()
    fixture['/cluster/ceph/status'] = { health: { status: 'HEALTH_WARN', checks: { POOL_NO_REDUNDANCY: {} } }, osdmap: { num_osds: 3, num_up_osds: 3 } }
    afterMove = n => {
      if (n !== 1) return
      const st = fixture['/cluster/status'] as any[]
      if (change === 'offline') st.find(x => x.name === 'node3').online = 0
      if (change === 'quorum') st.find(x => x.type === 'cluster').quorate = 0
      if (change === 'ceph') fixture['/cluster/ceph/status'].health.checks.PG_DEGRADED = {}
    }
    const cookie = await reconfirmed()
    const v = await proposed(cookie)
    const r = await app.inject({ method: 'POST', url: `${B}/plans`, headers: { cookie }, payload: { expect: v.plan.steps.map((s: any) => ({ sid: s.sid, to: s.to })), goal: 'mem' } })
    assert.equal(r.statusCode, 200, r.body)
    const p = await settlePlan(r.json().data.id)
    assert.equal(p!.status, 'stopped', change)
    assert.deepEqual(p!.steps.map(s => s.status), ['done', 'skipped'], change)
    assert.match(p!.error!, change === 'offline' ? /node3 is offline/ : change === 'quorum' ? /lost quorum/ : /did not have when the plan was approved \(PG_DEGRADED\)/)
    assert.equal(pve.writes.length, 1, `${change}: the second move never ran`)
  }
})

test('re-checked before each move: a guest that moved meanwhile, or a move that no longer helps, stops the plan', async () => {
  reset()
  afterMove = n => { if (n === 1) (fixture['/cluster/resources?type=vm'] as any[]).find(x => x.vmid === 109).node = 'node3' }
  let cookie = await reconfirmed()
  let v = await proposed(cookie)
  let r = await app.inject({ method: 'POST', url: `${B}/plans`, headers: { cookie }, payload: { expect: v.plan.steps.map((s: any) => ({ sid: s.sid, to: s.to })), goal: 'mem' } })
  let p = await settlePlan(r.json().data.id)
  assert.equal(p!.status, 'stopped')
  assert.match(p!.error!, /worker2 is on node3 now, not on node1/)

  reset()
  afterMove = n => { if (n === 1) nodeMem = { node1: 0.45, node2: 0.8, node3: 0.8 } }
  cookie = await reconfirmed()
  v = await proposed(cookie)
  r = await app.inject({ method: 'POST', url: `${B}/plans`, headers: { cookie }, payload: { expect: v.plan.steps.map((s: any) => ({ sid: s.sid, to: s.to })), goal: 'mem' } })
  p = await settlePlan(r.json().data.id)
  assert.equal(p!.status, 'stopped')
  assert.match(p!.error!, /the cluster changed/)
  assert.equal(pve.writes.length, 1)
})

test('stop: a running plan stops after the move under way; a scheduled one is cancelled', async () => {
  reset()
  const cookie = await reconfirmed()
  afterMove = n => { if (n === 1) void svc.stopPlan('pl1', actorAdmin) }
  const v = await proposed(cookie)
  const r = await app.inject({ method: 'POST', url: `${B}/plans`, headers: { cookie }, payload: { expect: v.plan.steps.map((s: any) => ({ sid: s.sid, to: s.to })), goal: 'mem' } })
  const p = await settlePlan(r.json().data.id)
  assert.equal(p!.status, 'stopped')
  assert.deepEqual(p!.steps.map(s => s.status), ['done', 'skipped'])
  assert.match(p!.error!, /Stopped on request before move 2/)
  assert.ok(audits.some(a => a.action === 'placement.plan.stop'))
})

test('outside a quiet window: "run now" is refused; scheduled, it runs at the window and is checked again then', async () => {
  reset()
  clock = Date.UTC(2026, 5, 15, 2, 10)   // in the 02:00 backup window
  const cookie = await reconfirmed()
  const v = await proposed(cookie)
  const expect = v.plan.steps.map((s: any) => ({ sid: s.sid, to: s.to }))
  const now = await app.inject({ method: 'POST', url: `${B}/plans`, headers: { cookie }, payload: { expect, goal: 'mem' } })
  assert.equal(now.statusCode, 409)
  assert.equal(now.json().code, 'not-quiet')
  const later = await app.inject({ method: 'POST', url: `${B}/plans`, headers: { cookie }, payload: { expect, goal: 'mem', when: 'next-quiet' } })
  assert.equal(later.statusCode, 200, later.body)
  const rec = later.json().data
  assert.equal(rec.status, 'scheduled')
  assert.ok(rec.scheduledFor > clock)
  assert.equal(audits[0].action, 'placement.plan.schedule')
  await svc.tick()
  assert.equal(pve.writes.length, 0, 'not before its time')
  clock = rec.scheduledFor + 60_000
  await svc.tick()
  const p = await settlePlan(rec.id)
  assert.equal(p!.status, 'done', p!.error ?? '')
  assert.ok(audits.some(a => a.action === 'placement.plan.scheduled-run'))
  assert.equal(pve.writes.length, 2)
})

test('a scheduled plan whose approver was demoted is skipped; a running plan whose process died is stopped, not resumed', async () => {
  reset()
  clock = Date.UTC(2026, 5, 15, 2, 10)
  const cookie = await reconfirmed()
  const v = await proposed(cookie)
  const later = await app.inject({ method: 'POST', url: `${B}/plans`, headers: { cookie }, payload: { expect: v.plan.steps.map((s: any) => ({ sid: s.sid, to: s.to })), goal: 'mem', when: 'next-quiet' } })
  changed['admin@example.com'] = 'is now viewer, not admin'
  clock = later.json().data.scheduledFor + 60_000
  await svc.tick()
  const p = await store.getPlan(later.json().data.id)
  assert.equal(p!.status, 'skipped')
  assert.match(p!.error!, /is now viewer/)
  assert.equal(pve.writes.length, 0)

  const dead = await store.createPlan({ source: 'manual', status: 'running', by: 'x', goal: 'mem', scoreBefore: 50, scoreTarget: 80,
    steps: [{ sid: 'ct:107', name: 'worker', from: 'node1', to: 'node2', method: 'migrate', status: 'pending', moveId: null, error: null, startedAt: null, endedAt: null }],
    startedAt: clock - 3600_000, owner: 'gone@1', heartbeatAt: clock - 3600_000 })
  await svc.tick()
  const d = await store.getPlan(dead.id)
  assert.equal(d!.status, 'stopped')
  assert.equal(d!.steps[0].status, 'skipped')
  assert.equal(pve.writes.length, 0)
})

test('automatic balancing: off by default; on, it notifies only, once, and moves nothing', async () => {
  reset()
  await svc.autoTick()
  assert.equal(notes.length, 0, 'off by default: nothing is even checked')
  await svc.saveAuto({ enabled: true, sustainHours: 6 }, actorAdmin)
  await svc.autoTick()
  assert.equal(notes.length, 1, (await store.auto()).state.lastWhy ?? '')
  assert.match(notes[0].title, /uneven: a balancing plan is ready/)
  assert.ok(notes[0].lines.some(l => /applies only to guests HA does not manage/.test(l)))
  assert.equal(pve.writes.length, 0)
  clock += 2 * 3600_000
  await svc.autoTick()
  assert.equal(notes.length, 1, 'the same plan is not notified again the same day')
  assert.ok(audits.some(a => a.action === 'placement.auto.settings' && a.details!.enabled === true && a.details!.apply === false))
})

test('automatic balancing waits for a sustained imbalance and a quiet window', async () => {
  reset()
  await svc.saveAuto({ enabled: true, sustainHours: 6 }, actorAdmin)
  nodeMem = { node1: 0.5, node2: 0.45, node3: 0.4 }
  await svc.autoTick()
  assert.equal(notes.length, 0)
  assert.match((await store.auto()).state.lastWhy!, /^Balanced/)
  nodeMem = { node1: 0.85, node2: 0.3, node3: 0.35 }
  clock = Date.UTC(2026, 5, 16, 2, 10)
  await svc.autoTick()
  assert.equal(notes.length, 0)
  assert.match((await store.auto()).state.lastWhy!, /not a quiet window/)
})

test('apply automatically: one non-HA move per check, audited, within the daily limit and the hours between moves', async () => {
  reset()
  nodeMem = { node1: 0.95, node2: 0.3, node3: 0.35 }   // still uneven after one move
  await svc.saveAuto({ enabled: true, apply: true, maxMovesPerDay: 1, minHoursBetween: 6 }, actorAdmin)
  const a = await store.auto()
  assert.equal(a.state.approver?.email, 'admin@example.com', 'who approved it is recorded')
  await svc.autoTick()
  const plans = await store.listPlans({ source: 'auto' })
  assert.equal(plans.length, 1)
  const p = await settlePlan(plans[0].id)
  assert.equal(p!.status, 'done', p!.error ?? '')
  assert.equal(p!.steps.length, 1, 'one move at a time')
  assert.equal(pve.writes.length, 1)
  assert.ok(audits.some(x => x.action === 'placement.auto.plan'))
  assert.ok(audits.some(x => x.action === 'placement.auto.move'))
  assert.ok(notes.some(n => /Automatic balancing moved a guest/.test(n.title)))
  // The next check: still uneven by the fixture's figures, but the daily limit is reached.
  clock += 61 * 60_000
  await svc.autoTick()
  assert.equal(pve.writes.length, 1)
  assert.match((await store.auto()).state.lastWhy!, /1 automatic move in the last 24 h is the limit/)
})

test('apply automatically: minimum hours between moves, the emergency stop, and a demoted approver turn it off', async () => {
  reset()
  nodeMem = { node1: 0.95, node2: 0.3, node3: 0.35 }
  await svc.saveAuto({ enabled: true, apply: true, maxMovesPerDay: 5, minHoursBetween: 6 }, actorAdmin)
  await svc.autoTick()
  await settlePlan((await store.listPlans({ source: 'auto' }))[0].id)
  clock += 61 * 60_000
  await svc.autoTick()
  assert.equal(pve.writes.length, 1)
  assert.match((await store.auto()).state.lastWhy!, /less than 6 h ago/)

  const cookie = await admin()
  const stop = await app.inject({ method: 'POST', url: `${B}/auto/stop`, headers: { cookie } })
  assert.equal(stop.statusCode, 200, stop.body)
  assert.equal(stop.json().data.settings.apply, false)
  assert.equal(stop.json().data.settings.enabled, true, 'it still notifies')
  assert.ok(audits.some(x => x.action === 'placement.auto.stop'))
  clock += 7 * 3600_000
  await svc.autoTick()
  assert.equal(pve.writes.length, 1, 'stopped: nothing more moves')

  reset()
  await svc.saveAuto({ enabled: true, apply: true }, actorAdmin)
  changed['admin@example.com'] = 'is now viewer, not admin'
  await svc.autoTick()
  assert.equal(pve.writes.length, 0)
  assert.equal((await store.auto()).settings.apply, false)
  assert.ok(notes.some(n => /stopped applying/.test(n.title)))
})

test('apply automatically never moves HA guests: with only HA guests uneven, it suggests and moves nothing', async () => {
  reset(false)
  // Only the HA guests carry load: ct:108 (HA, no rule) on node2, and CRS auto-rebalance off.
  fixture['/cluster/options'] = { crs: { ha: 'static' } }
  ;(fixture['/cluster/resources?type=vm'] as any[]).find(x => x.vmid === 107).status = 'stopped'
  nodeMem = { node1: 0.3, node2: 0.85, node3: 0.35 }
  guestMem = { 'lxc/108': 4 * G }
  await svc.saveAuto({ enabled: true, apply: true }, actorAdmin)
  await svc.autoTick()
  assert.equal(pve.writes.length, 0)
  assert.equal((await store.listPlans()).length, 0)
  assert.ok(notes.some(n => n.lines.some(l => /does not move HA guests/.test(l))), JSON.stringify(notes))
})

test('auto settings: unknown fields and out-of-range limits are refused; saving is re-confirmed', async () => {
  reset()
  await assert.rejects(svc.saveAuto({ enabled: true, maxMovesPerDay: 50 }, actorAdmin), /Moves per day must be between 1 and 10/)
  await assert.rejects(svc.saveAuto({ whatever: 1 }, actorAdmin), /Unknown setting: whatever/)
  const cookie = await admin()
  const r = await app.inject({ method: 'PUT', url: `${B}/auto`, headers: { cookie }, payload: { enabled: true, apply: true } })
  assert.equal(r.statusCode, 403)
  assert.equal(r.json().code, 'reconfirm_required')
  const ok = await app.inject({ method: 'PUT', url: `${B}/auto`, headers: { cookie: await reconfirmed() }, payload: { enabled: true, apply: true } })
  assert.equal(ok.statusCode, 200, ok.body)
  assert.equal(ok.json().data.settings.apply, true)
})

test('the assistant answers "is it balanced?" from the same score and plan, and never moves anything', async () => {
  reset()
  const src = balanceSource({ unlocked: () => true, map: async () => (await svc.map()).map, advice: () => svc.advice(), balance: () => svc.balanceView('mem') })
  assert.ok(src.aliases!.test('is the cluster balanced?'))
  const summary = await src.load()
  const answer = src.answer!('is the cluster balanced?', summary)!
  assert.match(answer, /^Uneven: node1 carries/)
  assert.match(answer, /Balance score: \d+ of 100/)
  assert.match(answer, /A balancing plan of 2 moves would take the score from \d+ to \d+/)
  assert.match(answer, /Automatic balancing is off/)
  assert.match(answer, /I cannot move anything/)
  assert.equal(pve.writes.length, 0)
  const locked = await balanceSource({ unlocked: () => false, map: async () => (await svc.map()).map, advice: () => svc.advice() }).load()
  assert.equal(locked.locked, true)
})
