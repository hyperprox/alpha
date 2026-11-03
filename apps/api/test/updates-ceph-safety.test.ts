// Ceph restart safety: a node's OSDs are restarted one at a time, under noout, with a health gate between
// each, and never at all when a pool with no second copy (size=1) or `ceph osd ok-to-stop` says it would
// take data offline. Fixtures: a size=3 pool spread over three nodes, and a size=1 pool on one node.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UpdatesRunner } from '../src/lib/updates/runner'
import { MemoryStore, type StepRecord } from '../src/lib/updates/store'
import {
  parseCephLayout, assessOsdRestart, osdsOnNode, describeBlockers, parseOsdOkToStop, parseDaemonOkToStop, parseUnitIds,
} from '../src/lib/updates/ceph-safety'
import { CEPH_LAYOUT_COMMAND, cephOsdRestartCommand } from '../src/lib/updates/commands'
import { FakeCluster, node, pkg, policyLoad, FAST, type FakeCephLayout } from './updates-fake'

const POLICY = `
nodes:
  default: { upgrade: dist-upgrade, reboot: auto }
ceph:
  accepted_warnings: [POOL_NO_REDUNDANCY]
`
const CEPH = [pkg('ceph-osd', '19.2.7-pve1', '19.2.6-pve4')]
const OSDS = { 'node-a': [0, 1], 'node-b': [2, 3], 'node-c': [4, 5] }

const REPLICATED: FakeCephLayout = {
  osdsByNode: OSDS,
  pools: [{ id: 1, name: 'vm-disks', size: 3, minSize: 2, pgNum: 32, storedBytes: 300e9 }],
}
const WITH_SINGLE_COPY: FakeCephLayout = {
  osdsByNode: OSDS,
  pools: [
    { id: 1, name: 'vm-disks', size: 3, minSize: 2, pgNum: 32, storedBytes: 300e9 },
    { id: 2, name: 'bulk-media', size: 1, minSize: 1, pgNum: 16, storedBytes: 8000e9, hosts: ['node-c'] },
  ],
}

function cephCluster(layout: FakeCephLayout): FakeCluster {
  const fake = new FakeCluster({ nodes: ['node-a', 'node-b', 'node-c'].map(n => node(n, { pending: CEPH })) })
  fake.cephLayout = layout
  return fake
}
function setup(fake: FakeCluster) {
  const store = new MemoryStore()
  return { store, runner: new UpdatesRunner({ store, exec: fake, loadPolicy: policyLoad(POLICY), timing: FAST, hostname: 'not-a-guest' }) }
}
async function settle(r: UpdatesRunner) { await r.idle(); await r.idle(); await r.idle() }
const osdStep = (steps: StepRecord[], target: string) => steps.find(s => s.target === target && s.action === 'ceph' && s.detail === 'restart osd')!
const layoutOf = (fake: FakeCluster) => parseCephLayout(String((fake as any).layoutOutput()))

// --- pure decisions -------------------------------------------------------------------------------

test('layout: pools, hosts and PGs are read from Ceph JSON, and a missing part is an error', () => {
  const l = layoutOf(cephCluster(WITH_SINGLE_COPY))
  assert.deepEqual(l.pools.map(p => [p.name, p.size, p.minSize, p.pgNum, p.storedBytes]), [['vm-disks', 3, 2, 32, 300e9], ['bulk-media', 1, 1, 16, 8000e9]])
  assert.deepEqual(l.osdsByHost['node-c'], [4, 5])
  assert.equal(l.pgs.length, 48)
  assert.throws(() => parseCephLayout('HP_POOLS\n[]\nHP_TREE\n\nHP_PGS\n{}\nHP_DF\n{}\nHP_END'), /no OSD tree/)
})

test('size=3: one node down leaves two copies of everything, so nothing blocks', () => {
  const l = layoutOf(cephCluster(REPLICATED))
  assert.deepEqual(assessOsdRestart(l, osdsOnNode(l, 'node-a', [])), [])
})

test('size=1: every PG on the node goes offline, stated as pool, GB and percent', () => {
  const l = layoutOf(cephCluster(WITH_SINGLE_COPY))
  const b = assessOsdRestart(l, osdsOnNode(l, 'node-c', []))
  assert.equal(b.length, 1)
  assert.deepEqual({ ...b[0] }, { pool: 'bulk-media', size: 1, minSize: 1, kind: 'offline', pgs: 16, pgNum: 16, percent: 100, approxBytes: 8000e9 })
  assert.match(describeBlockers(b), /pool "bulk-media" \(size=1, min_size=1\): 100% of it \(16 of 16 placement groups\), about 8\.0 TB would go offline/)
  // A single OSD of the two holds half of it.
  const half = assessOsdRestart(l, [4])[0]
  assert.equal(half.percent, 50); assert.equal(half.approxBytes, 4000e9)
  // The other nodes hold none of it.
  assert.deepEqual(assessOsdRestart(l, osdsOnNode(l, 'node-a', [])), [])
})

test('size=2, min_size=2: one copy left is below min_size, so I/O would stop', () => {
  const l = layoutOf(cephCluster({ osdsByNode: OSDS, pools: [{ id: 1, name: 'strict', size: 2, minSize: 2, pgNum: 12, storedBytes: 120e9 }] }))
  const b = assessOsdRestart(l, osdsOnNode(l, 'node-a', []))
  assert.equal(b[0].kind, 'blocked')
  assert.match(describeBlockers(b), /would stop accepting reads and writes/)
})

test('ok-to-stop parsing: only an explicit yes is yes', () => {
  assert.equal(parseOsdOkToStop('{"ok_to_stop":true,"osds":[0],"num_ok_pgs":39,"num_not_ok_pgs":0}\nHP_RC 0').ok, true)
  const no = parseOsdOkToStop('{"ok_to_stop":false,"osds":[9],"num_ok_pgs":0,"num_not_ok_pgs":93}\nHP_RC 16')
  assert.equal(no.ok, false); assert.match(no.reason, /93 placement groups/)
  assert.equal(parseOsdOkToStop('Error ENOENT: osd.99 does not exist\nHP_RC 2').ok, false)
  assert.equal(parseOsdOkToStop('').ok, false)
  assert.equal(parseDaemonOkToStop('mon', 'quorum should be preserved (b,c) after stopping [a]\nHP_RC 0').ok, true)
  // Real Ceph exits 0 for an unknown mon; that is not a yes.
  assert.equal(parseDaemonOkToStop('mon', 'invalid mon(s) specified: [x]\nHP_RC 0').ok, false)
  assert.equal(parseDaemonOkToStop('mds', 'should be safe to stop [a]\nHP_RC 0').ok, true)
  assert.deepEqual(parseUnitIds('osd', 'ceph-osd@3.service\nceph-osd@10.service\njunk'), ['10', '3'])
})

test('the OSD target restart is gone; single-OSD restarts take numbers only', () => {
  assert.equal(cephOsdRestartCommand(7), 'systemctl restart ceph-osd@7.service')
  assert.throws(() => cephOsdRestartCommand(-1)); assert.throws(() => cephOsdRestartCommand(1.5))
})

// --- the runner -----------------------------------------------------------------------------------

test('size=3: OSDs restart one at a time under noout, with a health check between each, never by target', async () => {
  const fake = cephCluster(REPLICATED)
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  const j = (await store.getJob(job.id))!
  assert.equal(j.status, 'done', j.pauseReason ?? '')
  assert.equal(fake.ran(/ceph-osd\.target/), false, 'never the whole target')
  assert.deepEqual(fake.restartedOsds, [0, 1, 2, 3, 4, 5])
  assert.equal(fake.noout, false)
  // Per node: layout read, noout set, then for each OSD ok-to-stop → restart, noout cleared at the end.
  const a = fake.calls.filter(c => /ceph osd (set|unset) noout|restart ceph-osd@|ceph osd ok-to-stop|^echo HP_POOLS/.test(c.cmd))
    .map(c => c.cmd.replace(/ -f json.*$/, '').replace(/^echo HP_POOLS.*$/, 'layout'))
  const firstNode = a.slice(0, a.indexOf('ceph osd unset noout') + 1)
  assert.deepEqual(firstNode, [
    'layout', 'ceph osd ok-to-stop 0 1', 'ceph osd set noout',
    'ceph osd ok-to-stop 0', 'systemctl restart ceph-osd@0.service',
    'ceph osd ok-to-stop 1', 'systemctl restart ceph-osd@1.service',
    'ceph osd unset noout',
  ])
  const steps = await store.getSteps(job.id)
  assert.equal(osdStep(steps, 'node-a').status, 'ok')
  assert.match(osdStep(steps, 'node-a').output!, /osd\.0 back: .*osd\.1 back/s)
  assert.ok(j.report!.summary.startsWith('Updates finished:'))
})

test('the health gate waits for each OSD to rejoin before the next restart', async () => {
  const fake = cephCluster(REPLICATED)
  const healthAt: number[] = []
  const orig = fake.cephHealth.bind(fake)
  fake.cephHealth = async () => { const h = await orig(); healthAt.push(fake.restartedOsds.length); return h }
  const { runner } = setup(fake)
  await runner.start('run', 'schedule'); await settle(runner)
  // After each restart there is at least one health read before the next restart happens.
  for (let i = 1; i <= 6; i++) assert.ok(healthAt.includes(i), `no health read after OSD restart ${i}`)
})

test('size=1 on the node: the OSD step is a dry run, explained, and the report says skipped for safety', async () => {
  const fake = cephCluster(WITH_SINGLE_COPY)
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  const j = (await store.getJob(job.id))!
  const steps = await store.getSteps(job.id)
  const c = osdStep(steps, 'node-c')
  assert.equal(c.status, 'skipped')
  assert.match(c.reason!, /^skipped for safety: /)
  assert.match(c.reason!, /pool "bulk-media" \(size=1, min_size=1\): 100% of it \(16 of 16 placement groups\), about 8\.0 TB would go offline/)
  assert.match(c.output!, /would run: systemctl restart ceph-osd@4\.service/)
  assert.equal(fake.restartedOsds.some(id => id === 4 || id === 5), false, 'nothing on node-c restarted')
  assert.equal(fake.ran(/restart ceph-osd/, 'node-c'), false)
  // The other nodes hold no single-copy data and are restarted normally.
  assert.equal(osdStep(steps, 'node-a').status, 'ok')
  assert.deepEqual(fake.restartedOsds, [0, 1, 2, 3])
  assert.equal(fake.noout, false)
  // Not reported as a plain success.
  assert.match(j.report!.summary, /skipped for safety/)
  assert.ok(!j.report!.summary.startsWith('Updates finished:'))
  assert.ok(j.report!.skipped.some(s => s.target === 'node-c' && /skipped for safety/.test(s.reason)))
})

test('ok-to-stop says no (size=3 pool): dry run, nothing restarted on that node, noout never set for it', async () => {
  const fake = cephCluster(REPLICATED)
  fake.okToStopOverride = ids => (ids.includes(2) ? false : undefined)
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  const b = osdStep(await store.getSteps(job.id), 'node-b')
  assert.equal(b.status, 'skipped')
  assert.match(b.reason!, /^skipped for safety: ceph osd ok-to-stop says no/)
  assert.equal(fake.restartedOsds.includes(2) || fake.restartedOsds.includes(3), false)
  assert.match((await store.getJob(job.id))!.report!.summary, /skipped for safety/)
})

test('an OSD that does not rejoin aborts the step: the next OSD is not restarted, and noout is cleared', async () => {
  const fake = cephCluster(REPLICATED)
  fake.osdStuck.add(0)
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  const j = (await store.getJob(job.id))!
  assert.equal(j.status, 'paused')
  const a = osdStep(await store.getSteps(job.id), 'node-a')
  assert.equal(a.status, 'failed')
  assert.match(a.reason!, /after restarting osd\.0 on node-a.*OSD\(s\) down.*noout cleared/)
  assert.deepEqual(fake.restartedOsds, [0])
  assert.equal(fake.noout, false)
})

test('a failing restart command still clears noout', async () => {
  const fake = cephCluster(REPLICATED)
  fake.inject = (_w, c) => (c === 'systemctl restart ceph-osd@1.service' ? { code: 1, output: 'Job failed', timedOut: false } : undefined)
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  const a = osdStep(await store.getSteps(job.id), 'node-a')
  assert.equal(a.status, 'failed')
  assert.match(a.reason!, /restarting osd\.1 failed.*noout cleared/)
  assert.equal(fake.noout, false)
})

test('noout that cannot be cleared is named in the failure', async () => {
  const fake = cephCluster(REPLICATED)
  fake.osdStuck.add(0)
  fake.inject = (_w, c) => (c === 'ceph osd unset noout' ? { code: 1, output: 'mon down', timedOut: false } : undefined)
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  assert.match(osdStep(await store.getSteps(job.id), 'node-a').reason!, /noout is LEFT ON/)
})

test('unreadable pool layout: the step fails before restarting anything', async () => {
  const fake = cephCluster(REPLICATED)
  fake.inject = (_w, c) => (c === CEPH_LAYOUT_COMMAND ? { code: 0, output: 'HP_POOLS\nHP_END', timedOut: false } : undefined)
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  assert.equal((await store.getJob(job.id))!.status, 'paused')
  assert.match(osdStep(await store.getSteps(job.id), 'node-a').reason!, /could not read the Ceph pool layout/)
  assert.deepEqual(fake.restartedOsds, [])
  assert.equal(fake.ran(/noout/), false)
})

test('mons keep their order and are asked ok-to-stop first; a no is a dry run', async () => {
  const fake = cephCluster(REPLICATED)
  fake.monOkToStop = false
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  const steps = await store.getSteps(job.id)
  const mon = steps.find(s => s.target === 'node-a' && s.detail === 'restart mon')!
  assert.equal(mon.status, 'skipped')
  assert.match(mon.reason!, /^skipped for safety: ceph mon ok-to-stop says no/)
  assert.equal(fake.ran(/ceph-mon\.target/), false)
  // mgrs have no ok-to-stop in Ceph and restart as before.
  assert.ok(fake.ran(/restart ceph-mgr\.target/))
})

test('mon, mgr, then OSD: the existing order holds', async () => {
  const fake = cephCluster(REPLICATED)
  const { runner } = setup(fake)
  await runner.start('run', 'schedule'); await settle(runner)
  const order = fake.calls.filter(c => /restart ceph-(mon|mgr)\.target|restart ceph-osd@/.test(c.cmd)).map(c => `${c.where}:${/ceph-(mon|mgr|osd)/.exec(c.cmd)![1]}`)
  assert.deepEqual(order.filter((x, i) => order.indexOf(x) === i), [
    'node-a:mon', 'node-b:mon', 'node-c:mon', 'node-a:mgr', 'node-b:mgr', 'node-c:mgr', 'node-a:osd', 'node-b:osd', 'node-c:osd',
  ])
})
