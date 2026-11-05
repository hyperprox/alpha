// Review fixes for the Ceph safety gate: which OSDs are on a node (three sources that must agree), survivors
// counted from the acting set, a PG map that must be complete, a health gate by identity, the reboot check
// repeated right before the reboot (also in the own-node handoff), stale noout, and package scripts that must
// not start or restart Ceph daemons. Names are generic: this repo is public.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { UpdatesRunner } from '../src/lib/updates/runner'
import { MemoryStore, type StepRecord } from '../src/lib/updates/store'
import {
  parseCephLayout, nodeOsdSet, assessOsdRestart, describeBlockers, parseUnitListing, parseCephState, judgeRestoredState,
  RISKY_PG, type CephLayout, type CephState,
} from '../src/lib/updates/ceph-safety'
import { annotatePlanSafety } from '../src/lib/updates/ceph-checks'
import { REBOOT_CHECK_PY, selfNodeRebootScript } from '../src/lib/updates/handoff'
import { nodeUpgradeCommand, cephInstallCommand, withCephStartGuard, POLICY_RC_MARK } from '../src/lib/updates/commands'
import { proxmoxRoutes } from '../src/routes/proxmox'
import { FakeCluster, node, guest, pkg, policyLoad, FAST, type FakeCephLayout } from './updates-fake'
import type { NotifyEventInput } from '../src/lib/notify/types'

const POLICY = `
nodes:
  default: { upgrade: dist-upgrade, reboot: auto }
ceph:
  accepted_warnings: [POOL_NO_REDUNDANCY]
self: { vmid: 150 }
`
const CEPH = [pkg('ceph-osd', '19.2.7-pve1', '19.2.6-pve4')]
const KERNEL = pkg('proxmox-kernel-7.0.2-1-pve-signed', '7.0.2-1', null)
const OSDS = { 'node-a': [0, 1], 'node-b': [2, 3], 'node-c': [4, 5] }
const REPLICATED: FakeCephLayout = { osdsByNode: OSDS, pools: [{ id: 1, name: 'vm-disks', size: 3, minSize: 2, pgNum: 32, storedBytes: 300e9 }] }
const WITH_SINGLE_COPY: FakeCephLayout = {
  osdsByNode: OSDS,
  pools: [
    { id: 1, name: 'vm-disks', size: 3, minSize: 2, pgNum: 32, storedBytes: 300e9 },
    { id: 2, name: 'bulk-media', size: 1, minSize: 1, pgNum: 16, storedBytes: 8000e9, hosts: ['node-c'] },
  ],
}

function cluster(layout: FakeCephLayout, pending: 'ceph' | 'kernel' = 'kernel', names = ['node-a', 'node-b', 'node-c']): FakeCluster {
  const fake = new FakeCluster({ nodes: names.map(n => node(n, { pending: pending === 'ceph' ? CEPH : [pkg('curl', '8.1-2'), KERNEL] })) })
  fake.cephLayout = layout
  return fake
}
function setup(fake: FakeCluster, yaml = POLICY, store = new MemoryStore()) {
  const published: NotifyEventInput[] = []
  const runner = new UpdatesRunner({ store, exec: fake, loadPolicy: policyLoad(yaml), timing: FAST, hostname: 'not-a-guest', publish: async e => { published.push(e) } })
  return { store, published, runner }
}
async function settle(r: UpdatesRunner) { await r.idle(); await r.idle(); await r.idle() }
const step = (steps: StepRecord[], target: string, action: string, detail?: RegExp) =>
  steps.find(s => s.target === target && s.action === action && (!detail || detail.test(s.detail ?? '')))!
const layoutOf = (fake: FakeCluster) => parseCephLayout(String((fake as any).layoutOutput()))
const units = (ids: string[]) => ({ ok: true, ids })

// --- 1. Which OSDs are on a node --------------------------------------------------------------------

test('mapping: a per-device-class bucket is pulled in through OSD metadata, and the union is used', () => {
  const fake = cluster(REPLICATED)
  fake.crushOverride = { 'node-a': [0], 'node-a-hdd': [1], 'node-b': [2, 3], 'node-c': [4, 5] }
  const l = layoutOf(fake)
  assert.deepEqual(nodeOsdSet(l, 'node-a', units(['0', '1'])), { ok: true, osds: [0, 1] })
})

test('mapping: no bucket by the node name falls back to the bucket its OSDs report', () => {
  const fake = cluster(REPLICATED)
  fake.crushOverride = { 'rack1-host-a': [0, 1], 'node-b': [2, 3], 'node-c': [4, 5] }
  assert.deepEqual(nodeOsdSet(layoutOf(fake), 'node-a', units(['0', '1'])), { ok: true, osds: [0, 1] })
})

test('mapping: sources that disagree, a failed listing, or units with no OSD id are refusals', () => {
  const fake = cluster(REPLICATED)
  fake.osdHostOverride = { 1: 'node-b' }       // CRUSH and the units say node-a, metadata says node-b
  const l = layoutOf(fake)
  const d = nodeOsdSet(l, 'node-a', units(['0', '1']))
  assert.equal(d.ok, false)
  assert.match((d as any).reason, /sources disagree about which OSDs are on node-a: CRUSH \{0, 1\}, OSD metadata \{0\}, systemd units \{0, 1\}/)
  const clean = layoutOf(cluster(REPLICATED))
  assert.equal(nodeOsdSet(clean, 'node-a', units(['0'])).ok, false, 'a unit missing')
  assert.equal(nodeOsdSet(clean, 'node-a', { ok: false, ids: [], reason: 'systemctl exited 1' }).ok, false)
  assert.equal(nodeOsdSet(clean, 'node-a', units(['main'])).ok, false)
  assert.equal(nodeOsdSet(clean, 'node-x', units(['7'])).ok, false, 'units but no OSD in CRUSH or metadata')
  // Genuinely none: all three empty.
  assert.deepEqual(nodeOsdSet(clean, 'node-x', units([])), { ok: true, osds: [] })
  // The listing's exit status is what decides, not its output.
  assert.equal(parseUnitListing('osd', 'ceph-osd@0.service loaded active running\nHP_RC 0').ok, true)
  assert.equal(parseUnitListing('osd', 'Failed to connect to bus\nHP_RC 1').ok, false)
  assert.equal(parseUnitListing('osd', 'ceph-osd@0.service loaded active running').ok, false, 'no exit status')
})

test('mapping, runner: a disagreement refuses both the OSD restart and the reboot; nothing restarts or reboots', async () => {
  const ceph = cluster(REPLICATED, 'ceph')
  ceph.osdHostOverride = { 1: 'node-b' }
  const a = setup(ceph)
  const j1 = await a.runner.start('run', 'schedule'); await settle(a.runner)
  assert.equal((await a.store.getJob(j1.id))!.status, 'paused')
  assert.match(step(await a.store.getSteps(j1.id), 'node-a', 'ceph', /^restart osd/).reason!, /sources disagree.*nothing was restarted/)
  assert.deepEqual(ceph.restartedOsds, [])

  const reboot = cluster(REPLICATED)
  reboot.unitsOverride = { 'node-a': null }
  const b = setup(reboot)
  const j2 = await b.runner.start('run', 'schedule'); await settle(b.runner)
  assert.match(step(await b.store.getSteps(j2.id), 'node-a', 'node-reboot').reason!, /could not list the Ceph OSD units on node-a.*node-a was not rebooted/)
  assert.equal(reboot.ran(/^systemctl reboot$/), false)
})

test('mapping, runner: a node that really has no OSDs reboots, proven by all three sources', async () => {
  const fake = cluster({ osdsByNode: { 'node-a': [0, 1], 'node-b': [2, 3], 'node-c': [4, 5], 'node-d': [] }, pools: REPLICATED.pools }, 'kernel', ['node-a', 'node-b', 'node-c', 'node-d'])
  fake.ceph!.numOsds = fake.ceph!.numUpOsds = fake.ceph!.numInOsds = 6
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  const d = step(await store.getSteps(job.id), 'node-d', 'node-reboot')
  assert.equal(d.status, 'ok', d.reason ?? '')
  assert.match(d.output ?? '', /rebooted/)
})

// --- 2. Survivors from the acting set; EC labels ------------------------------------------------------

function layout(pools: CephLayout['pools'], pgs: CephLayout['pgs']): CephLayout {
  return { pools, osdsByHost: { 'node-a': [0, 1] }, allOsds: [0, 1, 2, 3, 4], osdHost: { 0: 'node-a', 1: 'node-a' }, pgs }
}

test('acting set: a remapped PG whose new copy is still backfilling has no survivor', () => {
  const l = layout([{ id: 1, name: 'pool-r', size: 2, minSize: 1, pgNum: 1, erasure: false, k: null, m: null, storedBytes: 10e9 }],
    [{ pgid: '1.0', pool: 1, state: 'active+remapped+backfilling', up: [0, 4], acting: [0, 1] }])
  const b = assessOsdRestart(l, [0, 1])
  assert.equal(b.length, 1)
  assert.equal(b[0].kind, 'offline', 'osd.4 is only up, not acting: its copy is incomplete')
})

test('EC: fewer than k shards left is offline, and the pool is labelled erasure-coded', () => {
  const ec = { id: 2, name: 'pool-ec', size: 3, minSize: 3, pgNum: 2, erasure: true, k: 2, m: 1, storedBytes: 20e9 }
  const l = layout([ec], [
    { pgid: '2.0', pool: 2, state: 'active+clean', up: [0, 1, 4], acting: [0, 1, 4] },   // 1 shard left < k
    { pgid: '2.1', pool: 2, state: 'active+clean', up: [0, 3, 4], acting: [0, 3, 4] },   // 2 left = k, < min_size
  ])
  const b = assessOsdRestart(l, [0, 1])
  assert.equal(b[0].kind, 'offline')
  assert.equal(b[0].pgs, 2)
  assert.match(describeBlockers(b), /pool "pool-ec" \(erasure-coded k=2 m=1, min_size=3\)/)
  const only = assessOsdRestart(layout([ec], [{ pgid: '2.1', pool: 2, state: 'active+clean', up: [0, 3, 4], acting: [0, 3, 4] },
    { pgid: '2.0', pool: 2, state: 'active+clean', up: [2, 3, 4], acting: [2, 3, 4] }]), [0])
  assert.equal(only[0].kind, 'blocked')
  assert.match(describeBlockers(only), /fewer than min_size=3 shards left/)
})

test('EC pools and k come from the layout reads', () => {
  const fake = cluster({ osdsByNode: OSDS, pools: [{ id: 3, name: 'pool-ec', size: 3, minSize: 3, pgNum: 8, storedBytes: 1e9, ec: { profile: 'ec21', k: 2, m: 1 } }] })
  const p = layoutOf(fake).pools[0]
  assert.deepEqual([p.erasure, p.k, p.m], [true, 2, 1])
})

// --- 3. A complete PG map, and stored bytes only -------------------------------------------------------

test('PG map: pg_ready must be true and every pool must have pg_num rows', () => {
  const notReady = cluster(REPLICATED); notReady.pgReady = false
  assert.throws(() => layoutOf(notReady), /pg_ready is not true/)
  const partial = cluster(REPLICATED); partial.pgRowsDropped = 3
  assert.throws(() => layoutOf(partial), /lists 29 PGs for pool "vm-disks", which has pg_num 32/)
})

test('PG map, runner: a partial map refuses the reboot', async () => {
  const fake = cluster(WITH_SINGLE_COPY); fake.pgRowsDropped = 16   // the whole single-copy pool missing
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  assert.match(step(await store.getSteps(job.id), 'node-a', 'node-reboot').reason!, /could not read the Ceph pool layout.*bulk-media/)
  assert.equal(fake.ran(/^systemctl reboot$/), false)
})

test('GB figure: per-pool `stored` only; raw `bytes_used` is never used as a stand-in', () => {
  const fake = cluster(WITH_SINGLE_COPY)
  const out = String((fake as any).layoutOutput()).replace(/"stored":\d+(e\+\d+)?,/g, '')
  const l = parseCephLayout(out)
  assert.deepEqual(l.pools.map(p => p.storedBytes), [null, null])
  assert.doesNotMatch(describeBlockers(assessOsdRestart(l, [4, 5])), /GB|TB/)
})

// --- 4. The health gate, by identity --------------------------------------------------------------------

function state(osds: Record<number, [boolean, boolean]>, pgs: Record<string, [string, number[]]>, flags: string[] = []): CephState {
  return {
    flags: new Set(flags),
    osds: new Map(Object.entries(osds).map(([id, [up, inn]]) => [Number(id), { up, in: inn }])),
    pgs: new Map(Object.entries(pgs).map(([pgid, [st, o]]) => [pgid, { pgid, pool: 1, state: st, up: o, acting: o }])),
  }
}

test('health gate: the restarted OSD must be up and in, with none of its PGs degraded or undersized', () => {
  const before = state({ 0: [true, true], 1: [true, true] }, { '1.0': ['active+clean', [0, 1]] })
  assert.match(judgeRestoredState(before, state({ 0: [false, true], 1: [true, true] }, { '1.0': ['active+clean', [0, 1]] }), 0).reason, /osd\.0 is not up/)
  assert.match(judgeRestoredState(before, state({ 0: [true, false], 1: [true, true] }, { '1.0': ['active+clean', [0, 1]] }), 0).reason, /osd\.0 is not in/)
  assert.match(judgeRestoredState(before, state({ 0: [true, true], 1: [true, true] }, { '1.0': ['active+undersized+degraded', [0, 1]] }), 0).reason, /on osd\.0 still degraded/)
  assert.equal(judgeRestoredState(before, state({ 0: [true, true], 1: [true, true] }, { '1.0': ['active+clean', [0, 1]] }), 0).ok, true)
})

test('health gate: sets, not counts — one PG recovering cannot hide another degrading, one OSD up cannot hide another down', () => {
  const before = state({ 0: [true, true], 1: [true, true], 5: [false, true] }, { '1.0': ['active+degraded', [1, 5]], '1.1': ['active+clean', [0, 1]] })
  const swappedPgs = state({ 0: [true, true], 1: [true, true], 5: [false, true] }, { '1.0': ['active+clean', [1, 5]], '1.1': ['active+degraded', [0, 1]] })
  assert.match(judgeRestoredState(before, swappedPgs).reason, /at risk that were not before \(1\.1\)/)
  const swappedOsds = state({ 0: [true, true], 1: [false, true], 5: [true, true] }, { '1.0': ['active+degraded', [1, 5]], '1.1': ['active+clean', [0, 1]] })
  assert.match(judgeRestoredState(before, swappedOsds).reason, /down that were up before: osd\.1/)
  assert.ok(RISKY_PG.test('active+remapped+backfill_toofull') && RISKY_PG.test('active+recovery_toofull+degraded'))
  assert.ok(!RISKY_PG.test('active+remapped+backfilling'))
})

test('health gate, runner: an OSD map flag other than our noout during the step fails it, even when OSDMAP_FLAGS is accepted', async () => {
  const fake = cluster(REPLICATED, 'ceph')
  fake.flagsAfterRestart = ['pause']
  const { runner, store } = setup(fake, POLICY.replace('[POOL_NO_REDUNDANCY]', '[POOL_NO_REDUNDANCY, OSDMAP_FLAGS]'))
  const job = await runner.start('run', 'schedule'); await settle(runner)
  assert.match(step(await store.getSteps(job.id), 'node-a', 'ceph', /^restart osd/).reason!, /OSD map flag set during the step: pause/)
  assert.deepEqual(fake.restartedOsds, [0])
})

test('state parsing needs the OSD map and a ready PG map', () => {
  assert.throws(() => parseCephState('HP_OSDS\n{}\nHP_PGS\n{"pg_ready":true,"pg_stats":[]}\nHP_END'), /no OSD map/)
  assert.throws(() => parseCephState('HP_OSDS\n{"osds":[]}\nHP_PGS\n{"pg_ready":false,"pg_stats":[]}\nHP_END'), /not ready/)
})

// --- 5. The reboot check again, right before the reboot ------------------------------------------------

test('reboot, API path: checked again after the HA drain; unsafe by then means no reboot and the flags come off', async () => {
  const fake = cluster(REPLICATED)
  fake.inject = (_w, c) => { if (/node-maintenance enable 'node-c'/.test(c)) fake.cephLayout = WITH_SINGLE_COPY; return undefined }
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  const c = step(await store.getSteps(job.id), 'node-c', 'node-reboot')
  assert.equal(c.status, 'skipped')
  assert.match(c.reason!, /^skipped for safety: rebooting node-c .*bulk-media.*checked again after HA moved the guests; maintenance and noout cleared/)
  assert.equal(fake.ran(/^systemctl reboot$/, 'node-c'), false)
  assert.equal(fake.maintenance.has('node-c'), false)
  assert.equal(fake.noout, false)
  assert.ok(runner.rebootPending.has('node-c'))
})

function selfCluster(layout: FakeCephLayout): FakeCluster {
  const fake = new FakeCluster({
    nodes: [node('node-a', { pending: [] }), node('node-b', { pending: [] }), node('node-c', { pending: [KERNEL] })],
    guests: [guest(150, 'node-c', { pending: [] })],
  })
  fake.cephLayout = layout
  return fake
}

test('reboot, own node: unsafe before the handoff means no handoff and no reboot', async () => {
  const fake = selfCluster(WITH_SINGLE_COPY)
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  const s = step(await store.getSteps(job.id), 'node-c', 'self')
  assert.equal(s.status, 'skipped')
  assert.match(s.reason!, /^skipped for safety: rebooting node-c .*bulk-media/)
  assert.equal(fake.ran(/systemd-run/), false)
  assert.ok(runner.rebootPending.has('node-c'))
})

test('reboot, own node: the handoff checks again right before rebooting, and a no there is a safety skip', async () => {
  const fake = selfCluster(REPLICATED)
  fake.handoffResults.set('*', '{"ok":false,"message":"skipped for safety: rebooting node-c would take data out of service: pool bulk-media: 16 PGs. node-c was not rebooted; the reboot is pending"}')
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  const j = (await store.getJob(job.id))!
  const s = step(await store.getSteps(job.id), 'node-c', 'self')
  assert.equal(s.status, 'skipped')
  assert.notEqual(j.status, 'failed')
  assert.ok(runner.rebootPending.has('node-c'))
  assert.deepEqual(j.report!.rebootsPending, ['node-c'])
  // The script checks between the drain and the reboot, against the OSDs the API saw.
  const sh = selfNodeRebootScript('job1', 'stp1', 'node-c', { ceph: true, osds: [4, 5] })
  const drained = sh.indexOf('if [ "$drained" != "1" ]'), check = sh.indexOf('python3 - "$target" \'4,5\''), reboot = sh.indexOf('ssh_t systemctl reboot')
  assert.ok(drained > 0 && check > drained && reboot > check, 'drain, then check, then reboot')
  assert.match(sh, /result false "skipped for safety: \$why/)
})

/** Runs the handoff's checker against a stand-in `ceph`. */
function runChecker(node: string, want: string, answers: Record<string, unknown>, okToStopRc = 0): { rc: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'hp-check-'))
  try {
    writeFileSync(join(dir, 'answers.json'), JSON.stringify(answers))
    writeFileSync(join(dir, 'ceph'), `#!/usr/bin/env python3
import json, sys
a = json.load(open(${JSON.stringify(join(dir, 'answers.json'))}))
args = [x for x in sys.argv[1:] if x not in ('-f', 'json')]
key = ' '.join(args[:3]) if args[:2] == ['osd', 'pool'] else ' '.join(args[:2])
if key == 'osd ok-to-stop':
    sys.exit(${okToStopRc})
print(json.dumps(a[key]))
`)
    chmodSync(join(dir, 'ceph'), 0o755)
    const r = spawnSync('python3', ['-', node, want], { input: REBOOT_CHECK_PY, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8' })
    return { rc: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? '') }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

const hasPython = spawnSync('python3', ['--version']).status === 0
test('reboot, own node: the handoff checker itself decides like the API', { skip: !hasPython && 'no python3 here' }, () => {
  const base = {
    'osd pool ls': [{ pool_id: 1, pool_name: 'vm-disks', size: 3, min_size: 2, pg_num: 2, type: 1 }, { pool_id: 2, pool_name: 'bulk-media', size: 1, min_size: 1, pg_num: 1, type: 1 }],
    'osd metadata': [{ id: 0, hostname: 'node-a' }, { id: 1, hostname: 'node-b' }, { id: 2, hostname: 'node-c' }],
    'pg dump': { pg_ready: true, pg_stats: [
      { pgid: '1.0', up: [0, 1, 2], acting: [0, 1, 2] }, { pgid: '1.1', up: [0, 1, 2], acting: [0, 1, 2] },
      { pgid: '2.0', up: [2], acting: [2] },
    ] },
  }
  assert.deepEqual(runChecker('node-a', '0', base), { rc: 0, out: 'safe\n' })
  const c = runChecker('node-c', '2', base)
  assert.equal(c.rc, 1); assert.match(c.out, /would take data out of service: pool bulk-media: 1 PGs/)
  assert.equal(runChecker('node-a', '0', base, 16).rc, 1, 'ok-to-stop says no')
  assert.equal(runChecker('node-a', '0,9', base).rc, 2, 'the OSD set changed')
  assert.equal(runChecker('node-a', '0', { ...base, 'pg dump': { pg_ready: false, pg_stats: [] } }).rc, 2)
  assert.equal(runChecker('node-a', '0', { ...base, 'pg dump': { pg_ready: true, pg_stats: base['pg dump'].pg_stats.slice(1) } }).rc, 2, 'incomplete map')
})

// --- 6. Stale noout -------------------------------------------------------------------------------

test('stale noout at the start of a run: named in the preflight, a critical notification, nothing runs — even with OSDMAP_FLAGS accepted', async () => {
  const fake = cluster(REPLICATED, 'ceph')
  fake.noout = true
  const { runner, store, published } = setup(fake, POLICY.replace('[POOL_NO_REDUNDANCY]', '[POOL_NO_REDUNDANCY, OSDMAP_FLAGS]'))
  const job = await runner.start('run', 'schedule'); await settle(runner)
  const j = (await store.getJob(job.id))!
  assert.equal(j.status, 'failed')
  assert.match(j.pauseReason!, /Ceph noout is set — left by an earlier run/)
  assert.ok(published.some(e => e.severity === 'critical' && /noout is set/.test(e.title) && e.lines!.some(l => /start of an Updates run/.test(l))))
  assert.equal(fake.ran(/systemctl (restart|reboot)|apt-get/), false)
})

test('noout surviving an API restart mid-step: the pause says so, a critical notification goes out, and Resume will not restart anything', async () => {
  const fake = cluster(REPLICATED, 'ceph')
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'manual'); await settle(runner)
  // The API died in the middle of node-a's OSD step: noout set, the step running.
  const osdA = step(await store.getSteps(job.id), 'node-a', 'ceph', /^restart osd/)
  for (const s of await store.getSteps(job.id)) if (s.seq < osdA.seq && s.status === 'pending') await store.updateStep(s.id, { status: 'ok' })
  await store.updateStep(osdA.id, { status: 'running', startedAt: new Date() })
  await store.updateJob(job.id, { status: 'running' })
  fake.noout = true

  const after = setup(fake, POLICY, store)
  await after.runner.recoverAfterRestart()
  const j = (await store.getJob(job.id))!
  assert.equal(j.status, 'paused')
  assert.match(j.pauseReason!, /HyperProx restarted mid-job, and Ceph noout is set/)
  assert.ok(after.published.some(e => e.severity === 'critical' && /noout is set/.test(e.title)))

  await after.runner.resume(job.id); await settle(after.runner)
  const r = (await store.getJob(job.id))!
  assert.equal(r.status, 'paused')
  assert.match(r.pauseReason!, /Gate failed before ceph on node-a: .*Ceph noout is set/)
  assert.deepEqual(fake.restartedOsds, [])
  assert.equal(after.published.filter(e => /noout is set/.test(e.title)).length, 2, 'also announced on resume')
})

// --- 7. Package scripts -------------------------------------------------------------------------------

test('node and Ceph package installs carry the guard and NEEDRESTART_SUSPEND', () => {
  for (const c of [nodeUpgradeCommand('dist-upgrade'), cephInstallCommand([{ name: 'ceph-osd', to: '19.2.7-pve1' }])]) {
    assert.match(c, /NEEDRESTART_SUSPEND=1/)
    assert.ok(c.indexOf('trap unguard EXIT') < c.indexOf('apt-get -y'), 'the guard is up before apt runs')
    assert.ok(c.includes(POLICY_RC_MARK))
  }
})

function runGuard(aptLine: string, existing?: string): { rc: number; out: string; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'hp-guard-'))
  if (existing !== undefined) { writeFileSync(join(dir, 'policy-rc.d'), existing); chmodSync(join(dir, 'policy-rc.d'), 0o755) }
  const r = spawnSync('sh', ['-c', withCephStartGuard(aptLine.replace(/\$DIR/g, dir), dir)], { encoding: 'utf8' })
  return { rc: r.status ?? -1, out: r.stdout + r.stderr, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('guard: during apt, ceph starts and restarts are refused (101), everything else goes to the old policy; afterwards it is put back', () => {
  const g = runGuard('$DIR/policy-rc.d ceph-osd.target start; echo "ceph=$?"; $DIR/policy-rc.d ssh restart; echo "other=$?"; echo "NR=$NEEDRESTART_SUSPEND"',
    '#!/bin/sh\nexit 7\n')
  try {
    assert.equal(g.rc, 0, g.out)
    assert.match(g.out, /ceph=101/)
    assert.match(g.out, /other=7/, 'the original policy still decides non-Ceph services')
    assert.match(g.out, /NR=1/)
    assert.equal(readFileSync(join(g.dir, 'policy-rc.d'), 'utf8'), '#!/bin/sh\nexit 7\n', 'the original is back')
    assert.equal(existsSync(join(g.dir, 'policy-rc.d.hyperprox-saved')), false)
  } finally { g.cleanup() }
})

test('guard: removed when apt fails, and apt’s failure is the exit status', () => {
  const g = runGuard('false')
  try {
    assert.equal(g.rc, 1)
    assert.equal(existsSync(join(g.dir, 'policy-rc.d')), false)
  } finally { g.cleanup() }
})

test('guard: a copy left by a killed run is replaced, and an unknown saved file stops the install', () => {
  const left = runGuard('echo ran', `#!/bin/sh\n${POLICY_RC_MARK}\nexit 101\n`)
  try { assert.equal(left.rc, 0); assert.match(left.out, /ran/); assert.equal(existsSync(join(left.dir, 'policy-rc.d')), false) } finally { left.cleanup() }
  const dir = mkdtempSync(join(tmpdir(), 'hp-guard-'))
  try {
    writeFileSync(join(dir, 'policy-rc.d.hyperprox-saved'), 'someone else')
    const r = spawnSync('sh', ['-c', withCephStartGuard('echo ran', dir)], { encoding: 'utf8' })
    assert.equal(r.status, 1); assert.match(r.stdout, /refusing/); assert.doesNotMatch(r.stdout, /ran/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// --- 8. Plan annotation for other daemons ---------------------------------------------------------

test('plan time: mds is asked ok-to-stop, and any other daemon is a refusal', async () => {
  const fake = cluster(REPLICATED)
  const plan = await annotatePlanSafety(fake, { warnings: [], steps: [
    { seq: 1, target: 'node-a', action: 'ceph', detail: 'restart mds' },
    { seq: 2, target: 'node-a', action: 'ceph', detail: 'restart rgw' },
  ] }, true)
  assert.match(plan.steps[0].detail!, / · safety: will restart \(no mds on node-a\)/)
  assert.match(plan.steps[1].detail!, / · safety: the step would refuse: HyperProx has no safety check for ceph-rgw/)
  assert.equal(fake.ran(/ceph osd ok-to-stop/), false, 'neither falls through to the OSD check')
})

// --- 10. The sibling power route ------------------------------------------------------------------

test('POST /api/proxmox/vms/…/:action takes only the four power actions', async () => {
  const app = Fastify()
  await app.register(proxmoxRoutes, { prefix: '/api/proxmox' })
  await app.ready()
  for (const a of ['vnc', 'termproxy', 'suspend']) {
    const r = await app.inject({ method: 'POST', url: `/api/proxmox/vms/n1/100/qemu/${a}` })
    assert.equal(r.statusCode, 404, a)
  }
  await app.close()
})
