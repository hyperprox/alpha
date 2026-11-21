// The daily check after a bad week: a check skipped while HyperProx was locked is owed after unlock; a plan waiting
// for a person is not a running job; a job ending does not stop a check, a genuinely new run does and the check is
// then owed; a plan nobody confirms for a day is cancelled; an empty selection gets a plain sentence.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { UpdatesChecker, MemoryCheckState, LOCKED_SKIP, type CheckClusterHandle } from '../src/lib/updates/check'
import { parsePolicy, type PolicyLoad } from '../src/lib/updates/policy'
import { UpdatesRunner, PLAN_EXPIRY_MS, PLAN_EXPIRED_REASON } from '../src/lib/updates/runner'
import { MemoryStore } from '../src/lib/updates/store'
import { MemoryAutoInstall, withAutoInstall, AUTO_INSTALL_CRON } from '../src/lib/updates/auto-install'
import { buildUpdatesRoutes } from '../src/routes/updates'
import { MemoryRebootState } from '../src/lib/updates/reboots'
import { setAuditSink } from '../src/lib/audit'
import { FakeCluster, node, guest, pkg, policyLoad, FAST } from './updates-fake'

const HOME = { id: 'home', name: 'Home cluster', kind: 'home' as const }
const YAML = 'nodes:\n  node-a: { upgrade: upgrade }\ncheck:\n  cron: "30 6 * * *"\n'

function setup(onSleep?: (n: number, c: UpdatesChecker) => void) {
  const file: PolicyLoad = { loaded: true, path: '/t', policy: parsePolicy(YAML) }
  const home = new FakeCluster({ nodes: [node('node-a', { pending: [pkg('curl', '8.1-2', '8.1-1')] })], guests: [guest(201, 'node-a')] })
  home.ceph = null
  const handles = (): CheckClusterHandle[] => [{ ref: HOME, exec: home, loadPolicy: () => file, remote: false }]
  const env = { job: null as { id: string; status?: string } | null, unlocked: true, now: new Date('2026-11-10T12:00:00Z') }
  const state = new MemoryCheckState()
  let n = 0
  const checker: UpdatesChecker = new UpdatesChecker({
    clusters: handles, loadPolicy: () => file,
    activeJob: async () => env.job, isUnlocked: () => env.unlocked, state,
    now: () => env.now, gapMs: 5, clusterGapMs: 0, afterJobMs: 30_000,
    sleep: async () => { n++; onSleep?.(n, checker) },
  })
  const advance = (ms: number) => { env.now = new Date(env.now.getTime() + ms) }
  return { checker, env, state, advance }
}

test('a check skipped because HyperProx was locked runs shortly after unlock, once, never while locked', async () => {
  const { checker, env, state, advance } = setup()
  env.unlocked = false
  await checker.run('manual')
  assert.equal(state.state.clusters.home.reason, LOCKED_SKIP)
  advance(120_000)
  assert.notEqual(await checker.tick(), 'ran', 'still locked: nothing runs')
  assert.equal(state.state.clusters.home.result, 'skipped')
  env.unlocked = true
  assert.equal(await checker.tick(), 'idle', 'debounced: not the instant it unlocks')
  assert.equal(checker.status().recheck, true)
  advance(31_000)
  assert.equal(await checker.tick(), 'ran')
  assert.equal(state.state.clusters.home.result, 'ok')
  advance(120_000)
  assert.equal(await checker.tick(), 'idle', 'only once')
})

test('the scheduled time falling while locked is owed too', async () => {
  const { checker, env, advance, state } = setup()
  env.now = new Date('2026-11-10T06:29:30Z')
  await checker.tick()
  advance(60_000)
  env.unlocked = false
  assert.equal(await checker.tick(), 'locked')
  env.unlocked = true
  advance(1000)
  assert.equal(await checker.tick(), 'idle')
  advance(31_000)
  assert.equal(await checker.tick(), 'ran')
  assert.ok(state.state.lastRun)
})

test('a plan waiting for a person is not a running job: the check reads and is not stopped', async () => {
  const { checker, env, state } = setup()
  env.job = { id: 'j1', status: 'awaiting-confirm' }
  await checker.run('manual')
  assert.equal(state.state.clusters.home.result, 'ok')
  env.job = { id: 'j1', status: 'running' }
  await checker.run('manual')
  assert.equal(state.state.clusters.home.result, 'skipped', 'a running job still skips it')
})

test('a job ending while a check is reading does not stop it', async () => {
  const { checker, state } = setup((_n, c) => c.jobEnded())
  await checker.run('manual')
  assert.equal(state.state.clusters.home.result, 'ok')
  assert.equal(state.state.clusters.home.reason, undefined)
})

test('a genuinely new run stops the check, which is then owed once that run is over', async () => {
  const { checker, env, state, advance } = setup((n, c) => { if (n === 1) c.abort('an Updates run was started') })
  await checker.run('manual')
  assert.equal(state.state.clusters.home.result, 'partial')
  assert.match(state.state.clusters.home.reason ?? '', /an Updates run was started/)
  env.job = { id: 'j2', status: 'running' }
  assert.equal(await checker.tick(), 'idle', 'nothing runs during the job')
  env.job = null
  advance(1000)
  assert.equal(await checker.tick(), 'ran')
  assert.equal(state.state.clusters.home.result, 'ok')
})

test('a job that starts mid-check stops it; a job that merely ends does not', async () => {
  const { checker, env, state } = setup(n => { if (n === 1) env.job = { id: 'j3', status: 'running' } })
  await checker.run('manual')
  assert.equal(state.state.clusters.home.result, 'partial')
})

test('a plan nobody confirms for a day is cancelled, audited, and the lock is released', async () => {
  const fake = new FakeCluster({ nodes: [node('node-a')], guests: [] })
  const store = new MemoryStore()
  const runner = new UpdatesRunner({ store, exec: fake, loadPolicy: policyLoad('nodes:\n  default: { upgrade: upgrade }\n'), timing: FAST, hostname: 'not-a-guest' })
  const job = await store.createJob({ trigger: 'manual', status: 'awaiting-confirm', plan: { steps: [], warnings: [] } })
  fake.t = job.startedAt.getTime() + 1000
  assert.equal(await runner.expireUnconfirmed(), null, 'not yet')
  fake.t = job.startedAt.getTime() + PLAN_EXPIRY_MS + 1000
  assert.equal(await runner.expireUnconfirmed(), job.id)
  const after = await store.getJob(job.id)
  assert.equal(after?.status, 'cancelled')
  assert.equal(after?.pauseReason, PLAN_EXPIRED_REASON)
  assert.equal(await store.activeJob(), null, 'lock released')
  assert.equal(PLAN_EXPIRY_MS, 24 * 3600_000)
})

test('a running job is never expired', async () => {
  const fake = new FakeCluster({ nodes: [node('node-a')], guests: [] })
  const store = new MemoryStore()
  const runner = new UpdatesRunner({ store, exec: fake, loadPolicy: policyLoad('nodes:\n  default: { upgrade: upgrade }\n'), timing: FAST })
  const job = await store.createJob({ trigger: 'manual', status: 'running', plan: { steps: [], warnings: [] } })
  fake.t = job.startedAt.getTime() + 10 * PLAN_EXPIRY_MS
  assert.equal(await runner.expireUnconfirmed(), null)
})

test('auto-install is 08:00 in the cluster time zone, not the server clock', async () => {
  const { dueMinutesIn } = await import('../src/lib/updates/scheduler')
  const { AUTO_INSTALL_TIME } = await import('../src/lib/updates/auto-install')
  assert.equal(AUTO_INSTALL_TIME, '08:00'); assert.equal(AUTO_INSTALL_CRON, '0 8 * * *')
  // 13:00 UTC in November is 08:00 in Toronto (UTC-5); 08:00 UTC is 03:00 there.
  const at = (iso: string) => dueMinutesIn(AUTO_INSTALL_CRON, new Date(Date.parse(iso) - 90_000), new Date(iso), 'America/Toronto').length
  assert.equal(at('2026-11-21T13:00:00Z'), 1)
  assert.equal(at('2026-11-21T08:00:00Z'), 0)
  assert.equal(at('2026-11-21T07:00:00Z'), 0)
})

test('auto-install overrides the schedule only while on', () => {
  const load: PolicyLoad = { loaded: true, path: '/t', policy: parsePolicy(YAML) }
  assert.equal(withAutoInstall(load, { enabled: false }).policy.schedule.enabled, false)
  const on = withAutoInstall(load, { enabled: true }).policy.schedule
  assert.equal(on.enabled, true); assert.equal(on.cron, AUTO_INSTALL_CRON)
})

async function routes(extra: { auto?: MemoryAutoInstall; session?: any } = {}) {
  const store = new MemoryStore()
  const fake = new FakeCluster({ nodes: [node('node-a')], guests: [] })
  const auto = extra.auto ?? new MemoryAutoInstall()
  const app = Fastify({ logger: false })
  const session = extra.session ?? { sid: 's', role: 'admin', email: 'admin@example.com' }
  app.addHook('onRequest', async req => { (req as any).session = { ...session } })
  await app.register(buildUpdatesRoutes({
    store, exec: fake, loadPolicy: policyLoad('nodes:\n  default: { upgrade: upgrade }\n'), timing: FAST,
    rebootState: new MemoryRebootState(), autoInstall: auto, isUnlocked: () => true, hostname: 'not-a-guest',
  }), { prefix: '/api/updates' })
  await app.ready()
  return { app, auto, store }
}
async function confirmed(app: any, method: 'PUT' | 'POST', url: string, payload?: unknown) {
  const first = await app.inject({ method, url, payload })
  if (first.statusCode !== 403 || first.json().code !== 'confirm_required') return first
  return app.inject({ method, url, payload, headers: { 'x-hyperprox-confirm': first.json().confirm.token } })
}

test('an empty selection is answered in plain words', async () => {
  const { app } = await routes()
  const a = await app.inject({ method: 'POST', url: '/api/updates/preview', payload: { select: [] } })
  assert.equal(a.statusCode, 400)
  assert.match(a.json().error, /Pick at least one machine, or run Check now first/)
  const b = await app.inject({ method: 'POST', url: '/api/updates/jobs', payload: { mode: 'dry-run', select: [] } })
  assert.equal(b.statusCode, 400)
  assert.match(b.json().error, /Pick at least one machine, or run Check now first/)
  await app.close()
})

test('Install updates automatically: off by default; turning it on is confirmed and audited', async () => {
  const audits: string[] = []
  setAuditSink({ async write(a: any) { audits.push(String(a?.action ?? a)) } } as any)
  const { app, auto, store } = await routes()
  assert.equal((await app.inject({ method: 'GET', url: '/api/updates/auto-install' })).json().enabled, false)
  const first = await app.inject({ method: 'PUT', url: '/api/updates/auto-install', payload: { enabled: true } })
  assert.equal(first.json().code, 'confirm_required')
  assert.equal(auto.load().enabled, false, 'nothing changed before the confirm')
  const done = await confirmed(app, 'PUT', '/api/updates/auto-install', { enabled: true })
  assert.equal(done.statusCode, 200)
  assert.equal(auto.load().enabled, true)
  assert.equal((await app.inject({ method: 'GET', url: '/api/updates/policy' })).json().schedule.enabled, true)
  assert.equal((await app.inject({ method: 'PUT', url: '/api/updates/auto-install', payload: { enabled: 'yes' } })).statusCode, 400)
  const { app: viewer } = await routes({ session: { sid: 's', role: 'viewer', email: 'v@example.com' } })
  assert.ok([401, 403].includes((await viewer.inject({ method: 'PUT', url: '/api/updates/auto-install', payload: { enabled: true } })).statusCode))
  void store
  await app.close(); await viewer.close(); setAuditSink(null)
})

// --- Review follow-ups ------------------------------------------------------------------------------

import { UpdatesRuntime } from '../src/lib/updates/runtime'
import { UpdatesScheduler } from '../src/lib/updates/scheduler'
import { ActiveJobError } from '../src/lib/updates/store'
import { tokenForbidden } from '../src/lib/api-tokens'
import { PLAN_CHANGED } from '../src/lib/updates/plan-hash'
import { setClusterStore, loadClusters } from '../src/lib/clusters/registry'
import { MemoryClusterStore } from '../src/lib/clusters/store'
import { installClusterContext } from '../src/lib/clusters/context'
import { standaloneServer } from './updates-remote-fake'

test('an owed re-run holds off while a plan waits for Go ahead, then runs', async () => {
  const { checker, env, advance, state } = setup((n, c) => { if (n === 1) c.abort('an Updates run was started') })
  await checker.run('manual')
  assert.equal(state.state.clusters.home.result, 'partial')
  env.job = { id: 'p1', status: 'awaiting-confirm' }
  advance(1000)
  assert.equal(await checker.tick(), 'busy', 'not while a plan awaits confirmation')
  env.job = null
  assert.equal(await checker.tick(), 'ran')
})

const POLICY_AUTO = 'nodes:\n  default: { upgrade: upgrade, reboot: auto }\n'
async function planRoutes(opts: { store?: MemoryStore; checkGapMs?: number } = {}) {
  setAuditSink({ write: async () => {} } as any)
  const store = opts.store ?? new MemoryStore()
  const fake = new FakeCluster({ nodes: [node('node-a', { pending: [pkg('curl', '8.1-2', '8.1-1')] }), node('node-b'), node('node-c')], guests: [] })
  fake.ceph = null
  const reboots = new MemoryRebootState()
  let runner: UpdatesRunner | undefined
  let checker: UpdatesChecker | undefined
  const app = Fastify({ logger: false })
  app.addHook('onRequest', async req => { (req as any).session = { sid: 's', role: 'admin', email: 'admin@example.com' } })
  await app.register(buildUpdatesRoutes({
    store, exec: fake, loadPolicy: policyLoad(POLICY_AUTO), timing: FAST, rebootState: reboots, autoInstall: new MemoryAutoInstall(),
    isUnlocked: () => true, hostname: 'not-a-guest', checkState: new MemoryCheckState(), checkGapMs: opts.checkGapMs ?? 0,
    onRunner: r => { runner = r }, onServices: (_s, c) => { checker = c },
  }), { prefix: '/api/updates' })
  await app.ready()
  return { app, store, fake, reboots, runner: () => runner!, checker: () => checker! }
}
async function selection(app: any): Promise<string[]> {
  const t = (await app.inject({ method: 'GET', url: '/api/updates/targets' })).json().targets as Array<{ id: string; selectable: boolean; everything?: boolean }>
  return t.filter(x => x.selectable && x.everything).map(x => x.id)
}

test('Update now: one confirmation covers the plan; a matching plan runs without a second stop, and queues the reboot only then', async () => {
  const { app, runner, reboots } = await planRoutes()
  const select = await selection(app)
  assert.ok(select.length > 0)
  const pv = (await app.inject({ method: 'POST', url: '/api/updates/preview', payload: { select } })).json()
  assert.match(pv.planHash, /^[0-9a-f]{64}$/)
  const first = await app.inject({ method: 'POST', url: '/api/updates/jobs', payload: { mode: 'run', select, autoReboot: true, planHash: pv.planHash } })
  assert.equal(first.json().code, 'confirm_required', 'the confirmation is bound to the body, hash included')
  assert.equal(reboots.get('home').queued ?? null, null, 'nothing queued before it runs')
  const res = await confirmed(app, 'POST', '/api/updates/jobs', { mode: 'run', select, autoReboot: true, planHash: pv.planHash })
  assert.equal(res.statusCode, 201)
  await runner().idle(); await runner().idle()
  const job = (await app.inject({ method: 'GET', url: `/api/updates/jobs/${res.json().job.id}` })).json().job
  assert.notEqual(job.status, 'awaiting-confirm')
  assert.ok(['done', 'paused', 'running'].includes(job.status), job.status)
  assert.ok(reboots.get('home').queued, 'queued once the run started')
  await app.close()
})

test('a plan that differs from the confirmed one stops for Go ahead with a plain line, and a cancelled plan leaves no reboot queued', async () => {
  const { app, runner, reboots } = await planRoutes()
  const select = await selection(app)
  const bad = 'a'.repeat(64)
  const res = await confirmed(app, 'POST', '/api/updates/jobs', { mode: 'run', select, autoReboot: true, planHash: bad })
  assert.equal(res.statusCode, 201)
  await runner().idle(); await runner().idle()
  const id = res.json().job.id
  const job = (await app.inject({ method: 'GET', url: `/api/updates/jobs/${id}` })).json().job
  assert.equal(job.status, 'awaiting-confirm')
  assert.equal(job.pauseReason, PLAN_CHANGED)
  assert.equal(reboots.get('home').queued ?? null, null)
  assert.equal((await app.inject({ method: 'POST', url: `/api/updates/jobs/${id}/cancel` })).statusCode, 200)
  assert.equal(reboots.get('home').queued ?? null, null, 'never queued for a plan that never ran')
  // The Advanced path (no hash) still stops for Go ahead.
  const adv = await confirmed(app, 'POST', '/api/updates/jobs', { mode: 'run', select })
  await runner().idle(); await runner().idle()
  assert.equal((await app.inject({ method: 'GET', url: `/api/updates/jobs/${adv.json().job.id}` })).json().job.status, 'awaiting-confirm')
  assert.equal((await app.inject({ method: 'POST', url: '/api/updates/jobs', payload: { mode: 'dry-run', planHash: bad } })).statusCode, 400)
  await app.close()
})

test('a /preview selection that differs from the /jobs selection cannot produce a match', async () => {
  const { app, runner } = await planRoutes()
  const all = (await app.inject({ method: 'GET', url: '/api/updates/targets' })).json().targets as Array<{ id: string; selectable: boolean }>
  const ids = all.filter(t => t.selectable).map(t => t.id)
  assert.ok(ids.length >= 2, `need two selectable targets, have ${ids.length}`)
  const pv = (await app.inject({ method: 'POST', url: '/api/updates/preview', payload: { select: ids } })).json()
  const narrower = ids.slice(0, 1)
  const res = await confirmed(app, 'POST', '/api/updates/jobs', { mode: 'run', select: narrower, planHash: pv.planHash })
  assert.equal(res.statusCode, 201, res.body)
  await runner().idle(); await runner().idle()
  const job = (await app.inject({ method: 'GET', url: `/api/updates/jobs/${res.json().job.id}` })).json().job
  assert.equal(job.status, 'awaiting-confirm', 'stops for Go ahead')
  assert.equal(job.pauseReason, PLAN_CHANGED)
  await app.close()
})

test('Go ahead stops a check that is reading instead of being refused', async () => {
  const { app, store, runner, checker } = await planRoutes({ checkGapMs: 40 })
  const select = await selection(app)
  const res = await confirmed(app, 'POST', '/api/updates/jobs', { mode: 'run', select })
  await runner().idle(); await runner().idle()
  const id = res.json().job.id
  assert.equal((await store.getJob(id))?.status, 'awaiting-confirm')
  // A check (an owed one, or the daily one) starts reading while the plan waits.
  const run = checker().run('manual')
  assert.equal(checker().running, true)
  const go = await confirmed(app, 'POST', `/api/updates/jobs/${id}/confirm`)
  assert.equal(go.statusCode, 200, go.body)
  const st = await run
  await checker().idle()
  assert.equal(checker().running, false)
  assert.match(String(st.clusters[0]?.reason ?? ''), /Updates run was started/)
  await runner().idle(); await runner().idle()
  await app.close()
})

test('the switch is refused on a remote cluster, and an audit failure blocks saving it', async () => {
  const REMOTE = 'c0123456789'
  const cs = new MemoryClusterStore()
  await cs.upsert({ id: REMOTE, name: 'Remote server', kind: 'remote', address: 'pve1.example', port: 8006, note: '', certFingerprint: 'AA', certConfirmedAt: new Date().toISOString(), certConfirmedBy: 'x', nodeAddresses: {}, allowedRoots: [], monitoring: {}, plexUrl: null, createdBy: 'x' })
  setClusterStore(cs); await loadClusters()
  setAuditSink({ write: async () => {} } as any)
  const store = new MemoryStore()
  const auto = new MemoryAutoInstall()
  const app = Fastify({ logger: false })
  app.addHook('onRequest', async req => { (req as any).session = { sid: 's', role: 'admin', email: 'admin@example.com' } })
  installClusterContext(app)
  await app.register(buildUpdatesRoutes({
    store, exec: new FakeCluster({ nodes: [node('node-a')], guests: [] }), remoteExec: () => standaloneServer({ guest: { config: { hostname: 'media' } } }),
    loadPolicy: policyLoad(POLICY_AUTO), timing: FAST, autoInstall: auto, isUnlocked: () => true, connection: () => 'c', rebootState: new MemoryRebootState(),
  }), { prefix: '/api/updates' })
  await app.ready()
  const H = { 'x-hyperprox-cluster': REMOTE }
  const g = await app.inject({ method: 'GET', url: '/api/updates/auto-install', headers: H })
  assert.ok([400, 409].includes(g.statusCode), g.body)
  assert.ok([400, 409].includes((await app.inject({ method: 'PUT', url: '/api/updates/auto-install', headers: H, payload: { enabled: true } })).statusCode))
  assert.equal(auto.load().enabled, false)
  // Home: the audit row cannot be written, so nothing is saved.
  const real = store.audit.bind(store)
  store.audit = async () => { throw new Error('audit down') }
  const res = await confirmed(app, 'PUT', '/api/updates/auto-install', { enabled: true })
  assert.ok(res.statusCode >= 400)
  assert.equal(auto.load().enabled, false, 'not saved when the audit row failed')
  store.audit = real
  await app.close()
})

test('the switch is a signed-in admin act: an API token is refused', () => {
  assert.equal(tokenForbidden('PUT', '/api/updates/auto-install'), true)
  assert.equal(tokenForbidden('GET', '/api/updates/auto-install'), false)
})

test('the schedule with the switch on: once a day at 08:00 cluster time, never while locked or with a job, policy rules intact', async () => {
  const load: PolicyLoad = { loaded: true, path: '/t', policy: parsePolicy('nodes:\n  node-a: { upgrade: upgrade, reboot: manual }\n') }
  const on = withAutoInstall(load, { enabled: true })
  assert.deepEqual(on.policy.nodes, load.policy.nodes, 'per-node policy untouched')
  const starts: string[] = []
  const env = { now: new Date('2026-11-21T12:58:00Z'), unlocked: true, busy: false }
  const sched = new UpdatesScheduler({
    runner: { start: async (...a: any[]) => { if (env.busy) throw new ActiveJobError('j1'); starts.push(String(a[1])); return {} as any } },
    loadPolicy: () => on, isUnlocked: () => env.unlocked, now: () => env.now, tz: () => 'America/Toronto',
  })
  assert.equal(await sched.tick(), 'idle')
  env.now = new Date('2026-11-21T13:00:20Z')           // 08:00 in Toronto
  assert.equal(await sched.tick(), 'started')
  env.now = new Date('2026-11-21T13:01:20Z')
  assert.equal(await sched.tick(), 'idle', 'once')
  env.now = new Date('2026-11-22T13:00:20Z')
  env.unlocked = false
  assert.equal(await sched.tick(), 'locked'); assert.equal(starts.length, 1)
  env.unlocked = true; env.busy = true
  env.now = new Date('2026-11-23T13:00:20Z')
  assert.equal(await sched.tick(), 'busy'); assert.equal(starts.length, 1)
  env.busy = false; env.now = new Date('2026-11-24T13:00:20Z')
  assert.equal(await sched.tick(), 'started'); assert.equal(starts.length, 2)
})

test('/policy shows the next automatic install in the cluster time zone while the switch is on', async () => {
  const { policyStatus } = await import('../src/lib/updates/policy')
  const on = withAutoInstall({ loaded: true, path: '/t', policy: parsePolicy(YAML) }, { enabled: true })
  const s = policyStatus(on, new Date('2026-11-21T14:00:00Z'), 'America/Toronto')
  assert.equal(s.schedule.nextRun, '2026-11-22T13:00:00.000Z')
})

test('expireWaitingPlans (the runtime) cancels a plan left a day, and says so if it lost a race', async () => {
  const fake = new FakeCluster({ nodes: [node('node-a')], guests: [] })
  const store = new MemoryStore()
  const audits: string[] = []
  const rt = new UpdatesRuntime({ store, exec: fake, loadPolicy: policyLoad(POLICY_AUTO), checkState: new MemoryCheckState(), publish: async () => {}, log: () => {}, autoInstall: new MemoryAutoInstall(), rebootState: new MemoryRebootState() })
  const realAudit = store.audit.bind(store)
  store.audit = async (a: string, r: string, d?: any) => { audits.push(a); return realAudit(a, r, d) }
  const job = await store.createJob({ trigger: 'manual', status: 'awaiting-confirm', plan: { steps: [], warnings: [] } })
  fake.t = job.startedAt.getTime() + 1000
  assert.equal(await rt.expireWaitingPlans(), null)
  fake.t = job.startedAt.getTime() + PLAN_EXPIRY_MS + 1000
  assert.equal(await rt.expireWaitingPlans(), job.id)
  assert.equal((await store.getJob(job.id))?.status, 'cancelled')
  assert.ok(audits.includes('updates.job.expired'))
  // Lost race: confirmed between the audit row and the cancel.
  const j2 = await store.createJob({ trigger: 'manual', status: 'awaiting-confirm', plan: { steps: [], warnings: [] } })
  fake.t = j2.startedAt.getTime() + PLAN_EXPIRY_MS + 1000
  const runner = rt.get('home').runner
  const realTransition = store.transitionJob.bind(store)
  store.transitionJob = async () => null
  assert.equal(await runner.expireUnconfirmed(), null)
  store.transitionJob = realTransition
  assert.ok(audits.includes('updates.job.expire-lost'))
})
