// The check after an Updates job: a check skipped for a running job is owed and runs once when the job ends;
// any job end schedules one debounced check; never while locked or while another job runs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UpdatesChecker, MemoryCheckState, JOB_SKIP, type CheckClusterHandle } from '../src/lib/updates/check'
import { parsePolicy, type PolicyLoad } from '../src/lib/updates/policy'
import { FakeCluster, node as homeNode, pkg as homePkg } from './updates-fake'

const HOME = { id: 'home', name: 'Home cluster', kind: 'home' as const }
const YAML = 'nodes:\n  node-a: { upgrade: upgrade }\ncheck:\n  cron: "30 6 * * *"\n'

function setup() {
  const file: PolicyLoad = { loaded: true, path: '/t', policy: parsePolicy(YAML) }
  const home = new FakeCluster({ nodes: [homeNode('node-a', { pending: [homePkg('curl', '8.1-2', '8.1-1')] })], guests: [] })
  home.ceph = null
  const handles = (): CheckClusterHandle[] => [{ ref: HOME, exec: home, loadPolicy: () => file, remote: false }]
  const env = { active: false, unlocked: true, now: new Date('2026-11-10T12:00:00Z') }
  const state = new MemoryCheckState()
  const checker = new UpdatesChecker({
    clusters: handles, loadPolicy: () => file,
    activeJob: async () => (env.active ? { id: 'job1' } : null),
    isUnlocked: () => env.unlocked, state,
    now: () => env.now, gapMs: 0, clusterGapMs: 0, sleep: async () => {}, afterJobMs: 30_000,
  })
  const runs = () => checker.status().lastRun
  const advance = (ms: number) => { env.now = new Date(env.now.getTime() + ms) }
  return { checker, env, state, advance, runs }
}

test('a manual check skipped for a running job is owed: one check runs when the job ends', async () => {
  const { checker, env, state, advance } = setup()
  env.active = true
  await checker.run('manual')
  assert.equal(state.state.clusters.home.reason, JOB_SKIP)
  env.active = false
  assert.equal(await checker.tick(), 'ran', 'owed check runs on the next tick, no end announced')
  assert.equal(state.state.clusters.home.result, 'ok')
  advance(60_000)
  assert.equal(await checker.tick(), 'idle', 'only once')
})

test('a job ending with no skipped check schedules one check after the quiet time', async () => {
  const { checker, state, advance } = setup()
  checker.jobEnded()
  assert.equal(checker.status().recheck, true)
  assert.equal(await checker.tick(), 'idle', 'too soon')
  assert.equal(state.state.lastRun, null)
  advance(31_000)
  assert.equal(await checker.tick(), 'ran')
  assert.ok(state.state.lastRun)
  assert.equal(checker.status().recheck, undefined)
  advance(60_000)
  assert.equal(await checker.tick(), 'idle')
})

test('skipped then job ends: exactly one check, and the stale wording clears', async () => {
  const { checker, env, state, advance } = setup()
  env.active = true
  await checker.run('manual')
  checker.jobEnded()   // still marked active for a moment: busy, nothing runs
  advance(31_000)
  assert.equal(await checker.tick(), 'busy')
  env.active = false
  assert.equal(await checker.tick(), 'ran')
  assert.equal(state.state.clusters.home.result, 'ok')
  advance(120_000)
  assert.equal(await checker.tick(), 'idle')
})

test('no check while locked or while another job runs; it runs once those clear', async () => {
  const { checker, env, state, advance } = setup()
  checker.jobEnded()
  advance(31_000)
  env.unlocked = false
  assert.equal(await checker.tick(), 'locked')
  assert.equal(state.state.lastRun, null)
  env.unlocked = true; env.active = true
  assert.equal(await checker.tick(), 'busy')
  assert.equal(state.state.lastRun, null)
  env.active = false
  assert.equal(await checker.tick(), 'ran')
})

test('repeated job ends restart the quiet time; a check that already started after the end is not repeated', async () => {
  const { checker, state, advance } = setup()
  checker.jobEnded()
  advance(20_000)
  checker.jobEnded()
  advance(20_000)
  assert.equal(await checker.tick(), 'idle', '20 s since the last end')
  checker.jobEnded()
  advance(5_000)
  await checker.run('manual')   // a person checked after the end
  const at = state.state.lastRun
  advance(40_000)
  assert.equal(await checker.tick(), 'idle')
  assert.equal(state.state.lastRun, at, 'no second check')
  assert.equal(checker.status().recheck, undefined)
})
