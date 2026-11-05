// Follow-up to the Ceph safety hotfix: Ceph packages never change in a node upgrade, OSDMAP_FLAGS cannot be
// accepted, the package-script fence reads the unit past options, left-over fences are reported, and a checker
// that throws says "layout unreadable", never "skipped for safety". Names are generic: this repo is public.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UpdatesRunner } from '../src/lib/updates/runner'
import { MemoryStore, type StepRecord } from '../src/lib/updates/store'
import { parsePolicy } from '../src/lib/updates/policy'
import { parseAptSimulation, parseNodeFacts, withCephStartGuard, CEPH_LAYOUT_COMMAND } from '../src/lib/updates/commands'
import { annotatePlanSafety, osdVerdict } from '../src/lib/updates/ceph-checks'
import { REBOOT_CHECK_PY } from '../src/lib/updates/handoff'
import { FakeCluster, node, pkg, policyLoad, FAST, type FakeCephLayout } from './updates-fake'
import type { NotifyEventInput } from '../src/lib/notify/types'

const POLICY = `
nodes:
  default: { upgrade: dist-upgrade, reboot: auto }
ceph:
  accepted_warnings: [POOL_NO_REDUNDANCY]
`
const KERNEL = pkg('proxmox-kernel-7.0.2-1-pve-signed', '7.0.2-1', null)
const REPLICATED: FakeCephLayout = {
  osdsByNode: { 'node-a': [0, 1], 'node-b': [2, 3], 'node-c': [4, 5] },
  pools: [{ id: 1, name: 'vm-disks', size: 3, minSize: 2, pgNum: 32, storedBytes: 300e9 }],
}
function cluster(): FakeCluster {
  const fake = new FakeCluster({ nodes: ['node-a', 'node-b', 'node-c'].map(n => node(n, { pending: [pkg('curl', '8.1-2', '8.1-1')] })) })
  fake.cephLayout = REPLICATED
  return fake
}
function setup(fake: FakeCluster, yaml = POLICY) {
  const store = new MemoryStore()
  const published: NotifyEventInput[] = []
  const runner = new UpdatesRunner({ store, exec: fake, loadPolicy: policyLoad(yaml), timing: FAST, hostname: 'not-a-guest', publish: async e => { published.push(e) } })
  return { store, published, runner }
}
async function settle(r: UpdatesRunner) { await r.idle(); await r.idle(); await r.idle() }
const step = (steps: StepRecord[], target: string, action: string) => steps.find(s => s.target === target && s.action === action)!

// --- 1. Ceph never changes in a node upgrade ------------------------------------------------------------

test('simulation parsing: installs, upgrades and removals, with versions', () => {
  const out = [
    'Inst ceph-osd [19.2.6-pve4] (19.2.7-pve1 vendor:9/main [amd64])',
    'Inst curl [8.1-1] (8.1-2 stable [amd64])',
    'Inst libnew (1.0 stable [amd64])',
    'Remv librados2 [19.2.6-pve4]',
    'Conf curl (8.1-2 stable [amd64])',
    'HP_SIM_END',
  ].join('\n')
  assert.deepEqual(parseAptSimulation(out), [
    { name: 'ceph-osd', from: '19.2.6-pve4', to: '19.2.7-pve1', action: 'upgrade' },
    { name: 'curl', from: '8.1-1', to: '8.1-2', action: 'upgrade' },
    { name: 'libnew', from: null, to: '1.0', action: 'install' },
    { name: 'librados2', from: '19.2.6-pve4', to: null, action: 'remove' },
  ])
  assert.equal(parseAptSimulation('Inst curl [8.1-1] (8.1-2 stable [amd64])'), null, 'no end marker: the simulation did not finish')
})

test('a node upgrade that would change a Ceph package is refused, and nothing is installed', async () => {
  const fake = cluster()
  fake.nodes[1].simExtra = [pkg('ceph-osd', '19.2.7-pve1', '19.2.6-pve4'), pkg('librados2', '19.2.7-pve1', '19.2.6-pve4')]
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  const b = step(await store.getSteps(job.id), 'node-b', 'node-upgrade')
  assert.equal(b.status, 'failed')
  assert.match(b.reason!, /refusing: apt-get dist-upgrade on node-b would also change Ceph packages \(ceph-osd 19\.2\.6-pve4 → 19\.2\.7-pve1, librados2 19\.2\.6-pve4 → 19\.2\.7-pve1\)\. Ceph is upgraded only in the Ceph phase/)
  assert.equal(fake.ran(/apt-get -y -q .*dist-upgrade$/, 'node-b'), false, 'the real upgrade never ran')
  assert.equal(fake.ran(/apt-mark hold/), false, 'no holds are placed')
  assert.equal((await store.getJob(job.id))!.status, 'paused')
})

test('the simulation runs before every node upgrade; without Ceph in it the upgrade goes ahead', async () => {
  const fake = cluster()
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  assert.equal(step(await store.getSteps(job.id), 'node-a', 'node-upgrade').status, 'ok')
  const cmds = fake.cmds('node-a')
  const sim = cmds.findIndex(c => /apt-get -s .*dist-upgrade; echo HP_SIM_END$/.test(c))
  const real = cmds.findIndex(c => /apt-get -y -q .*dist-upgrade$/.test(c))
  assert.ok(sim >= 0 && real > sim, 'simulated first')
})

test('a simulation that fails or does not finish refuses the upgrade', async () => {
  const fake = cluster()
  fake.inject = (w, c) => (w === 'node-a' && /HP_SIM_END$/.test(c) ? { code: 100, output: 'E: Could not get lock', timedOut: false } : undefined)
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  assert.match(step(await store.getSteps(job.id), 'node-a', 'node-upgrade').reason!, /could not simulate apt-get dist-upgrade on node-a/)
  assert.equal(fake.ran(/apt-get -y -q .*dist-upgrade$/, 'node-a'), false)
})

// --- 2. OSDMAP_FLAGS cannot be accepted -----------------------------------------------------------

test('policy: OSDMAP_FLAGS in accepted_warnings is refused, with the reason', () => {
  assert.throws(() => parsePolicy('ceph:\n  accepted_warnings: [POOL_NO_REDUNDANCY, OSDMAP_FLAGS]'), /ceph\.accepted_warnings.*OSDMAP_FLAGS cannot be accepted.*noout/)
  assert.deepEqual(parsePolicy('ceph:\n  accepted_warnings: [POOL_NO_REDUNDANCY]').acceptedWarnings, ['POOL_NO_REDUNDANCY'])
})

// --- 3. The fence reads the unit name past options --------------------------------------------------

test('fence: options such as --quiet before the unit do not let a Ceph start through', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hp-guard-'))
  try {
    writeFileSync(join(dir, 'policy-rc.d'), '#!/bin/sh\nexit 7\n'); chmodSync(join(dir, 'policy-rc.d'), 0o755)
    const line = [
      `${dir}/policy-rc.d --quiet ceph-osd.target start; echo "a=$?"`,
      `${dir}/policy-rc.d --quiet --force ceph-mon@x.service restart; echo "b=$?"`,
      `${dir}/policy-rc.d --quiet ssh restart; echo "c=$?"`,
      `${dir}/policy-rc.d ceph-mgr.target start; echo "d=$?"`,
    ].join('; ')
    const r = spawnSync('sh', ['-c', withCephStartGuard(line, dir)], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /a=101/); assert.match(r.stdout, /b=101/); assert.match(r.stdout, /d=101/)
    assert.match(r.stdout, /c=7/, 'everything else still goes to the policy that was there')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// --- 4. Left-overs from a killed run are reported -----------------------------------------------------

test('node facts report a left-over fence', () => {
  assert.equal(parseNodeFacts('HP_FREE 100\nHP_FENCE_LEFT').fence, 'ours')
  assert.equal(parseNodeFacts('HP_FREE 100\nHP_FENCE_SAVED').fence, 'saved')
  assert.equal(parseNodeFacts('HP_FREE 100').fence, null)
})

test('a fence left by a killed run is reported at the start of the next run, with a notification', async () => {
  const fake = cluster()
  fake.nodes[0].fenceLeft = 'ours'
  fake.nodes[2].fenceLeft = 'saved'
  const { runner, store, published } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  const pre = step(await store.getSteps(job.id), 'cluster', 'preflight')
  assert.match(pre.output ?? '', /node-a: a Ceph start fence \(policy-rc\.d\) left by an interrupted run is still in place/)
  assert.match(pre.output ?? '', /node-c: a saved policy-rc\.d from an interrupted run/)
  const n = published.find(e => /fence/i.test(e.title))
  assert.ok(n, 'a notification')
  assert.equal(n!.severity, 'warning')
  assert.ok(n!.lines!.some(l => /node-a/.test(l)) && n!.lines!.some(l => /node-c/.test(l)))
})

test('noout left by a killed run is reported at the start of the next run, with a critical notification', async () => {
  const fake = cluster()
  fake.noout = true
  const { runner, store, published } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  assert.match((await store.getJob(job.id))!.pauseReason!, /Ceph noout is set/)
  assert.ok(published.some(e => e.severity === 'critical' && /noout is set/.test(e.title)))
})

// --- 5. A checker that throws is "layout unreadable" ------------------------------------------------

test('an exception inside the check is "layout unreadable", at plan time and when it runs', async () => {
  const fake = cluster()
  fake.inject = (_w, c) => (/^ceph osd ok-to-stop/.test(c) ? new Error('ssh: connection reset') : undefined)
  const v = await osdVerdict(fake, 'node-a', 'node-b', 'rebooting')
  assert.equal(v.kind, 'unreadable')
  assert.match(v.reason, /the Ceph layout is unreadable: ssh: connection reset/)

  const plan = await annotatePlanSafety(fake, { warnings: [], steps: [{ seq: 1, target: 'node-a', action: 'node-reboot', detail: 'auto — if needed' }] }, true)
  assert.match(plan.steps[0].detail!, / · safety: the step would refuse: the Ceph layout is unreadable: ssh: connection reset/)
  assert.doesNotMatch(plan.steps[0].detail!, /skipped for safety/)

  const r = cluster()
  r.nodes[0].pending.push(KERNEL)
  r.inject = (_w, c) => (c === CEPH_LAYOUT_COMMAND ? new Error('boom') : undefined)
  const { runner, store } = setup(r)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  const a = step(await store.getSteps(job.id), 'node-a', 'node-reboot')
  assert.equal(a.status, 'failed')
  assert.match(a.reason!, /the Ceph layout is unreadable: .*boom.*node-a was not rebooted/)
  assert.doesNotMatch(a.reason!, /skipped for safety/)
})

const hasPython = spawnSync('python3', ['--version']).status === 0
test('the handoff checker: an unexpected error is "unreadable" (exit 2), never a safety skip', { skip: !hasPython && 'no python3 here' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'hp-check-'))
  try {
    // A PG row without a pgid: the checker's own code throws.
    writeFileSync(join(dir, 'ceph'), `#!/usr/bin/env python3
import json, sys
a = sys.argv[1:]
if a[:2] == ['osd', 'pool']: print(json.dumps([{"pool_id": 1, "pool_name": "p", "size": 3, "min_size": 2, "pg_num": 1, "type": 1}]))
elif a[:2] == ['osd', 'metadata']: print(json.dumps([{"id": 0, "hostname": "node-a"}]))
elif a[:2] == ['pg', 'dump']: print(json.dumps({"pg_ready": True, "pg_stats": [{"up": [0], "acting": [0]}]}))
`)
    chmodSync(join(dir, 'ceph'), 0o755)
    const r = spawnSync('python3', ['-', 'node-a', '0'], { input: REBOOT_CHECK_PY, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8' })
    assert.equal(r.status, 2, r.stdout + r.stderr)
    assert.match(r.stdout, /the Ceph layout could not be read/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
