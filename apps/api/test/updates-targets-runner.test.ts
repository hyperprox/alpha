// Runs of chosen targets against the pretend cluster: each item on its own (a failure stops only what waits for
// it), the guarded node's kernel never moved by a per-package or per-node run, refusals at run time from what is
// on the node then, backups, and the per-item report.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UpdatesRunner, JobStateError } from '../src/lib/updates/runner'
import { MemoryStore, type StepRecord } from '../src/lib/updates/store'
import { FakeCluster, node, guest, pkg, policyLoad, FAST } from './updates-fake'
import { NODE_FACTS_COMMAND } from '../src/lib/updates/commands'

const POLICY = `
nodes:
  default: { upgrade: dist-upgrade, reboot: auto }
  gpu-node: { upgrade: dist-upgrade, reboot: manual, require_holds: [proxmox-default-kernel, proxmox-kernel-7.0, proxmox-headers-7.0], require_pin: 7.0.1-1-pve }
guests:
  exclude: [110]
`
const HOLDS = ['proxmox-default-kernel', 'proxmox-kernel-7.0', 'proxmox-headers-7.0']
const KERNEL = pkg('proxmox-kernel-7.0.2-1-pve-signed', '7.0.2-1', null)

function cluster(): FakeCluster {
  return new FakeCluster({
    nodes: [
      node('node-a', { rebootRequired: true }),
      node('node-b', { pending: [pkg('curl', '8.1-2', '8.1-1'), KERNEL] }),
      node('gpu-node', { holds: HOLDS, pinned: '7.0.1-1-pve', pending: [pkg('curl', '8.1-2', '8.1-1'), pkg('proxmox-headers-7.0', '7.0.2-1'), pkg('pve-manager', '9.2-3', '9.2-2')] }),
    ],
    guests: [guest(101, 'node-a'), guest(102, 'node-b'), guest(103, 'node-b'), guest(301, 'gpu-node')],
  })
}

function setup(fake: FakeCluster, yaml = POLICY) {
  const store = new MemoryStore()
  const runner = new UpdatesRunner({ store, exec: fake, loadPolicy: policyLoad(yaml), timing: FAST, hostname: 'not-a-guest' })
  return { runner, store }
}
async function settle(r: UpdatesRunner) { await r.idle(); await r.idle() }
async function run(runner: UpdatesRunner, store: MemoryStore, selection: string[]) {
  const job = await runner.start('run', 'manual', 'admin@example.com', 'all', [], selection)
  await settle(runner)
  const planned = (await store.getJob(job.id))!
  assert.equal(planned.status, 'awaiting-confirm', planned.pauseReason ?? '')
  await runner.confirm(job.id, 'admin@example.com')
  await settle(runner)
  return { job: (await store.getJob(job.id))!, steps: await store.getSteps(job.id) }
}
const line = (s: StepRecord) => `${s.target}:${s.action}:${s.status}`
const APT_WIDE = /apt-get [^\n]*\b(dist-upgrade|full-upgrade)\b|apt-get -y -q [^\n]*\supgrade$/m

test('a failed guest stops only what waits for it: its node is not rebooted, unrelated items carry on', async () => {
  const fake = cluster()
  fake.inject = (where, cmd) => (where === '101' && cmd === 'guest:apt' ? { code: 100, output: 'E: dpkg was interrupted', timedOut: false } : undefined)
  const { runner, store } = setup(fake)
  const { job, steps } = await run(runner, store, ['guest:101', 'node:node-a:reboot', 'guest:102', 'node:node-b'])
  assert.equal(job.status, 'done', job.pauseReason ?? '')
  assert.deepEqual(steps.map(line), [
    'cluster:preflight:ok', 'cluster:refresh:ok',
    '101:snapshot:ok', '101:apt:failed', '102:snapshot:ok', '102:apt:ok',
    'node-a:node-reboot:skipped',
    'node-b:node-upgrade:ok', 'node-b:kernel-cleanup:ok',
  ])
  const reboot = steps.find(s => s.action === 'node-reboot')!
  assert.match(reboot.reason!, /^not run: it waits for 101/)
  assert.equal(fake.ran(/systemctl reboot/), false, 'node-a was never rebooted')
  assert.equal(fake.maintenance.size, 0)
  // The report says, item by item, what happened.
  const items = Object.fromEntries(job.report!.items!.map(i => [i.id, i.status]))
  assert.deepEqual(items, { 'guest:101': 'failed', 'guest:102': 'ok', 'node:node-b': 'ok', 'node:node-a:reboot': 'skipped' })
  assert.match(job.report!.summary, /2 of 4 chosen items did not/)
  assert.ok(store.audits.some(a => a.action === 'updates.job.start' && JSON.stringify(a.details).includes('node:node-a:reboot')), 'audited with the selection, before it ran')
})

test('a failed node update stops its own reboot, not the next node', async () => {
  const fake = cluster()
  fake.nodes[0].pending = [pkg('curl', '8.1-2', '8.1-1')]
  fake.inject = (where, cmd) => (where === 'node-a' && /--only-upgrade install 'curl=8\.1-2'/.test(cmd) ? { code: 100, output: 'E: broken', timedOut: false } : undefined)
  const { runner, store } = setup(fake)
  const { job, steps } = await run(runner, store, ['node:node-a:pkg:curl', 'node:node-a:reboot', 'node:node-b'])
  assert.equal(job.status, 'done', job.pauseReason ?? '')
  const by = (t: string, a: string) => steps.find(s => s.target === t && s.action === a)!
  assert.equal(by('node-a', 'node-packages').status, 'failed')
  assert.equal(by('node-a', 'node-reboot').status, 'skipped')
  assert.equal(by('node-b', 'node-upgrade').status, 'ok')
})

test('a failed item and what waited for it run again when chosen again', async () => {
  const fake = cluster()
  let fail = true
  fake.inject = (where, cmd) => (fail && where === '101' && cmd === 'guest:apt' ? { code: 100, output: 'E: lock', timedOut: false } : undefined)
  const { runner, store } = setup(fake)
  const { job } = await run(runner, store, ['guest:101', 'node:node-a:reboot'])
  assert.equal(job.status, 'done')
  // A finished job is not resumed; a new run is. Here: the same selection again, now that the guest is fixed.
  fail = false
  const again = await run(runner, store, ['guest:101', 'node:node-a:reboot'])
  assert.deepEqual(again.steps.filter(s => s.action !== 'preflight' && s.action !== 'refresh').map(line), ['101:snapshot:ok', '101:apt:ok', 'node-a:node-reboot:ok'])
})

test('the guarded node: a per-package run installs upgrade-only, never upgrade, dist-upgrade or full-upgrade', async () => {
  const fake = cluster()
  const { runner, store } = setup(fake)
  const { job, steps } = await run(runner, store, ['node:gpu-node:pkg:curl', 'node:gpu-node:pkg:pve-manager'])
  assert.equal(job.status, 'done', job.pauseReason ?? '')
  assert.equal(steps.find(s => s.action === 'node-packages')!.status, 'ok')
  const cmds = fake.cmds('gpu-node')
  assert.ok(cmds.some(c => /--no-remove --only-upgrade install 'curl=8\.1-2' 'pve-manager=9\.2-3'$/m.test(c)), 'installed pinned to the simulated versions')
  assert.equal(cmds.some(c => APT_WIDE.test(c)), false, cmds.join('\n'))
  assert.deepEqual(fake.nodes[2].holds, HOLDS)
  assert.equal(fake.nodes[2].pinned, '7.0.1-1-pve')
})

test('the guarded node: a chosen whole-node update gets apt-get upgrade even though its policy names dist-upgrade', async () => {
  const fake = cluster()
  fake.nodes[2].pending = [pkg('curl', '8.1-2', '8.1-1')]
  const { runner, store } = setup(fake)
  const { job } = await run(runner, store, ['node:gpu-node'])
  assert.equal(job.status, 'done', job.pauseReason ?? '')
  const cmds = fake.cmds('gpu-node')
  assert.ok(cmds.some(c => /apt-get -y -q .* upgrade$/m.test(c)), 'upgraded')
  assert.equal(cmds.some(c => /\b(dist-upgrade|full-upgrade)\b/.test(c) && !/apt-get -s/.test(c)), false, cmds.join('\n'))
  assert.equal(cmds.some(c => /apt-get -s .*dist-upgrade/.test(c)), false, 'not even simulated')
})

test('a held kernel package slipped into a stored step is refused at run time, and nothing is installed', async () => {
  const fake = cluster()
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'manual', 'a', 'all', [], ['node:gpu-node:pkg:curl'])
  await settle(runner)
  // As if the stored plan had been tampered with between planning and confirming.
  const step = (await store.getSteps(job.id)).find(s => s.action === 'node-packages')!
  await store.updateStep(step.id, { detail: 'only-upgrade (2 packages): curl proxmox-headers-7.0' })
  await runner.confirm(job.id, 'a'); await settle(runner)
  const s = (await store.getSteps(job.id)).find(x => x.action === 'node-packages')!
  assert.equal(s.status, 'failed')
  assert.match(s.reason!, /refusing: proxmox-headers-7.0 is held/)
  assert.equal(fake.ran(/--only-upgrade install/, 'gpu-node'), false)
})

test('a chosen package that would pull a new kernel along is refused after apt\'s simulation', async () => {
  const fake = cluster()
  fake.nodes[2].simExtra = [pkg('proxmox-kernel-7.0.2-1-pve-signed', '7.0.2-1', null)]
  const { runner, store } = setup(fake)
  const { steps } = await run(runner, store, ['node:gpu-node:pkg:pve-manager'])
  const s = steps.find(x => x.action === 'node-packages')!
  assert.equal(s.status, 'failed')
  assert.match(s.reason!, /refusing: .*(kernel|new packages)/)
  assert.equal(fake.cmds('gpu-node').some(c => /apt-get -y -q .*--only-upgrade install/.test(c)), false)
})

test('unknown holds at run time: refused, nothing installed', async () => {
  const fake = cluster()
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'manual', 'a', 'all', [], ['node:gpu-node:pkg:curl'])
  await settle(runner)
  fake.inject = (where, cmd) => (where === 'gpu-node' && cmd === NODE_FACTS_COMMAND ? { code: 0, output: 'HP_FREE 9000', timedOut: false } : undefined)
  await runner.confirm(job.id, 'a'); await settle(runner)
  const s = (await store.getSteps(job.id)).find(x => x.action === 'node-packages')!
  assert.equal(s.status, 'failed')
  assert.match(s.reason!, /could not be read.*Nothing was installed/)
  assert.equal(fake.ran(/--only-upgrade install/, 'gpu-node'), false)
})

test('a node with unknown holds is refused in the plan, and the rest of the selection still runs', async () => {
  const fake = cluster()
  fake.inject = (where, cmd) => (where === 'gpu-node' && cmd === NODE_FACTS_COMMAND ? { code: 1, output: 'permission denied', timedOut: false } : undefined)
  const { runner, store } = setup(fake)
  const { job, steps } = await run(runner, store, ['node:gpu-node', 'guest:102'])
  assert.equal(job.status, 'done', job.pauseReason ?? '')
  assert.ok(job.plan.refused!.some(r => r.id === 'node:gpu-node' && /could not be read/.test(r.reason)))
  assert.equal(steps.some(s => s.target === 'gpu-node'), false)
  assert.equal(steps.find(s => s.target === '102' && s.action === 'apt')!.status, 'ok')
})

test('a guest being backed up is left alone; the others update', async () => {
  const fake = cluster()
  fake.backupTasks = async () => [{ node: 'node-b', at: fake.t, ok: null, vmid: 103 }]
  const { runner, store } = setup(fake)
  const { job, steps } = await run(runner, store, ['guest:101', 'guest:103'])
  assert.equal(job.status, 'done')
  assert.match(steps.find(s => s.target === '103' && s.action === 'apt')!.reason!, /^not run: a backup is running/)
  assert.equal(steps.find(s => s.target === '101' && s.action === 'apt')!.status, 'ok')
  assert.equal(fake.ran(/^guest:apt$/, '103'), false)
})

test('a guest package run: held packages refused inside the guest', async () => {
  const fake = cluster()
  fake.guests[0].pending.push(pkg('libfoo', '2'))
  fake.guests[0].held = ['libfoo']
  const { runner, store } = setup(fake)
  const { steps } = await run(runner, store, ['guest:101:pkg:libfoo'])
  const s = steps.find(x => x.action === 'apt-packages')!
  assert.equal(s.status, 'failed')
  assert.match(s.reason!, /refusing: libfoo is held/)
})

test('a guest tagged hyperprox-ignore is never entered, and choosing it is refused', async () => {
  const fake = cluster()
  fake.guests[1].tags = ['hyperprox-ignore']
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'manual', 'a', 'all', [], ['guest:102', 'guest:101'])
  await settle(runner)
  const j = (await store.getJob(job.id))!
  assert.ok(j.plan.refused!.some(r => r.id === 'guest:102' && /hyperprox-ignore/.test(r.reason)))
  assert.equal(fake.calls.some(c => c.where === '102'), false, 'not even read')
})

test('selections are checked before a job exists; a scheduled run never takes one', async () => {
  const { runner } = setup(cluster())
  await assert.rejects(runner.start('run', 'manual', 'a', 'all', [], ['node:x;reboot']), JobStateError)
  await assert.rejects(runner.start('run', 'manual', 'a', 'all', [], []), JobStateError)
})

test('a run of the whole plan keeps its old rules: a failed guest still holds the node phase', async () => {
  const fake = cluster()
  fake.inject = (where, cmd) => (where === '101' && cmd === 'guest:apt' ? { code: 100, output: 'E', timedOut: false } : undefined)
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule')
  await settle(runner)
  const j = (await store.getJob(job.id))!
  assert.equal(j.status, 'paused')
  assert.match(j.pauseReason!, /Guest 101 failed/)
})

test("HyperProx's own guest: a failed snapshot stops its upgrade; the handoff never starts", async () => {
  const fake = cluster()
  fake.inject = (where, cmd) => (where === '301' && cmd === 'snapshot' ? new Error('snapshot failed: storage busy') : undefined)
  const { runner, store } = setup(fake, POLICY + 'self: { vmid: 301 }\n')
  const { job, steps } = await run(runner, store, ['guest:301', 'guest:101'])
  assert.equal(job.status, 'done', job.pauseReason ?? '')
  assert.equal(steps.find(s => s.target === '301' && s.action === 'snapshot')!.status, 'failed')
  const self = steps.find(s => s.target === '301' && s.action === 'self')!
  assert.equal(self.status, 'skipped')
  assert.equal(self.reason, 'an earlier step of this item failed')
  assert.equal(fake.ran(/systemd-run/), false, 'no handoff was started')
  assert.equal(steps.find(s => s.target === '101' && s.action === 'apt')!.status, 'ok')
})
