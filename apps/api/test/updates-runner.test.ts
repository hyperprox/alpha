// The runner against a pretend cluster: happy path, a failure at every action type, gates, resume after a
// restart, stream waits, and the node that never comes back. Nothing here touches a real machine.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UpdatesRunner, PolicyRequiredError } from '../src/lib/updates/runner'
import { MemoryStore, ActiveJobError, type StepRecord } from '../src/lib/updates/store'
import { readInventory } from '../src/lib/updates/inventory'
import { FakeCluster, node, guest, pkg, policyLoad, FAST } from './updates-fake'
import type { UpdatesWsPayload } from '../src/lib/updates/types'

const POLICY = `
nodes:
  default: { upgrade: dist-upgrade, reboot: auto }
guests:
  default: { reboot: if-required }
  exclude: [110]
  "205": { docker: auto, compose_dirs: [/opt/stack] }
  "206": { check: "http://127.0.0.1:8080/health" }
batch_size: 2
self: { vmid: 150 }
`
// For the clusters that have a pinned GPU node. Kept out of POLICY: naming a node the cluster lacks fails a run (B7).
const GPU_POLICY = POLICY.replace('nodes:\n', 'nodes:\n  gpu-node: { upgrade: upgrade, reboot: auto, require_holds: [proxmox-default-kernel], require_pin: 7.0.1-1-pve }\n')
const KERNEL = pkg('proxmox-kernel-7.0.2-1-pve-signed', '7.0.2-1', null)

function cluster(): FakeCluster {
  return new FakeCluster({
    nodes: [node('node-a'), node('node-b', { pending: [pkg('curl', '8.1-2'), KERNEL] }), node('node-c', { pending: [] })],
    guests: [
      guest(101, 'node-a'), guest(102, 'node-b'), guest(110, 'node-a'),
      guest(205, 'node-b'), guest(206, 'node-c', { type: 'qemu', config: { agent: '1', ostype: 'l26' } }),
    ],
  })
}

function setup(fake: FakeCluster, yaml: string | null = POLICY, store = new MemoryStore()) {
  const events: UpdatesWsPayload[] = []
  const runner = new UpdatesRunner({ store, exec: fake, loadPolicy: policyLoad(yaml), emit: e => events.push(e), timing: FAST, hostname: 'not-a-guest' })
  return { runner, store, events }
}

async function settle(r: UpdatesRunner) { await r.idle(); await r.idle() }
const byAction = (steps: StepRecord[], target: string, action: string) => steps.find(s => s.target === target && s.action === action)

test('a scheduled run: preflight, refresh, guests, nodes; everything ok, report written, lock released', async () => {
  const fake = cluster()
  const { runner, store, events } = setup(fake)
  const job = await runner.start('run', 'schedule')
  await settle(runner)
  const j = (await store.getJob(job.id))!
  const steps = await store.getSteps(job.id)
  assert.equal(j.status, 'done', j.pauseReason ?? '')
  assert.deepEqual(steps.map(s => `${s.target}:${s.action}:${s.status}`), [
    'cluster:preflight:ok', 'cluster:refresh:ok',
    '101:snapshot:ok', '101:apt:ok', '102:snapshot:ok', '102:apt:ok',
    '205:snapshot:ok', '205:apt:ok', '205:docker:ok', '206:snapshot:ok', '206:apt:ok', '206:check:ok',
    'node-a:node-upgrade:ok', 'node-b:node-upgrade:ok', 'node-b:node-reboot:ok', 'node-b:kernel-cleanup:ok',
  ])
  // Excluded guest never touched; snapshot before apt; apt update ran only in the refresh step.
  assert.equal(fake.calls.some(c => c.where === '110' && c.cmd !== 'guest:pending'), false)
  assert.ok(fake.calls.findIndex(c => c.where === '101' && c.cmd.startsWith('snapshot')) < fake.calls.findIndex(c => c.where === '101' && c.cmd === 'guest:apt'))
  assert.equal(fake.noout, false)
  assert.equal(fake.maintenance.size, 0)
  assert.ok(j.report!.summary.startsWith('Updates finished'))
  assert.ok(j.report!.changed.some(c => c.target === 'node-b' && c.packages === 2))
  assert.equal(await store.activeJob(), null)
  assert.ok(events.some(e => e.kind === 'step') && events.some(e => e.kind === 'log') && events.some(e => e.kind === 'job'))
  assert.ok(store.audits.some(a => a.action === 'updates.job.start'))
})

test('batch_size bounds how many guests update at once', async () => {
  const fake = cluster()
  fake.guests.push(guest(103, 'node-a'), guest(104, 'node-c'))
  const { runner } = setup(fake)
  await runner.start('run', 'schedule'); await settle(runner)
  assert.ok(fake.maxConcurrentGuests <= 2, `saw ${fake.maxConcurrentGuests}`)
  assert.ok(fake.maxConcurrentGuests >= 2)
})

test('a node whose policy says upgrade can never get dist-upgrade, even from a tampered plan', async () => {
  const fake = new FakeCluster({ nodes: [node('gpu-node', { holds: ['proxmox-default-kernel'], pinned: '7.0.1-1-pve', kernel: '7.0.1-1-pve' }), node('node-b')] })
  const { runner, store } = setup(fake, GPU_POLICY)
  const job = await runner.start('run', 'manual'); await settle(runner)
  assert.equal((await store.getJob(job.id))!.status, 'awaiting-confirm')
  // Rewrite the stored step as if the plan had said dist-upgrade.
  const up = byAction(await store.getSteps(job.id), 'gpu-node', 'node-upgrade')!
  await store.updateStep(up.id, { detail: 'apt-get dist-upgrade (1 package)' })
  await runner.confirm(job.id); await settle(runner)
  const gpu = fake.cmds('gpu-node')
  assert.ok(gpu.some(c => /apt-get .* (dist-)?upgrade$/.test(c)))
  assert.equal(gpu.some(c => /dist-upgrade|full-upgrade/.test(c)), false)
  assert.ok(fake.cmds('node-b').some(c => /dist-upgrade$/.test(c)))
})

test('manual run waits at awaiting-confirm and holds the lock; dry run executes nothing and ends done', async () => {
  const fake = cluster()
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'manual'); await settle(runner)
  assert.equal((await store.getJob(job.id))!.status, 'awaiting-confirm')
  assert.equal(fake.ran(/apt-get .* (dist-)?upgrade$/), false)
  await assert.rejects(runner.start('dry-run'), (e: any) => e instanceof ActiveJobError && e.runningJobId === job.id)
  await runner.cancel(job.id); await settle(runner)
  assert.equal((await store.getJob(job.id))!.status, 'cancelled')

  const fake2 = cluster()
  const s2 = setup(fake2, null)    // no policy file: dry runs still work
  const dry = await s2.runner.start('dry-run'); await settle(s2.runner)
  const d = (await s2.store.getJob(dry.id))!
  assert.equal(d.status, 'done')
  assert.equal(d.trigger, 'dry-run')
  assert.match(d.report!.summary, /^Dry run/)
  assert.ok(d.plan.steps.length > 0)
  assert.ok(d.plan.warnings.some(w => /safe defaults/.test(w)))
  assert.deepEqual((await s2.store.getSteps(dry.id)).map(s => s.action), ['preflight'])
  const writes = /^POST apt\/update$|^guest:(apt|refresh|docker|check)$|^snapshot|apt-get|systemctl (reboot|restart)|noout|ha-manager|systemd-run/
  assert.deepEqual(fake2.calls.filter(c => writes.test(c.cmd)), [])
})

test('a real run is refused without a policy file', async () => {
  const { runner } = setup(cluster(), null)
  await assert.rejects(runner.start('run'), PolicyRequiredError)
})

test('preflight failure ends the job before anything changes', async () => {
  const fake = cluster()
  fake.ceph!.checks = ['OSD_DOWN']
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  const j = (await store.getJob(job.id))!
  assert.equal(j.status, 'failed')
  assert.match(j.pauseReason!, /OSD_DOWN/)
  assert.equal(fake.calls.some(c => c.cmd === 'POST apt/update'), false)
  assert.equal(await store.activeJob(), null)
})

test('missing holds stop the run in preflight; never repaired', async () => {
  const fake = new FakeCluster({ nodes: [node('gpu-node', { holds: [], pinned: '7.0.1-1-pve' }), node('node-b')] })
  const { runner, store } = setup(fake, GPU_POLICY)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  const j = (await store.getJob(job.id))!
  assert.equal(j.status, 'failed')
  assert.match(j.pauseReason!, /gpu-node: required hold missing: proxmox-default-kernel/)
  assert.equal(fake.ran(/apt-mark hold|proxmox-boot-tool kernel pin/), false)
})

test('holds that disappear during the upgrade stop the run after installing', async () => {
  const fake = new FakeCluster({ nodes: [node('gpu-node', { holds: ['proxmox-default-kernel'], pinned: '7.0.1-1-pve' })] })
  const gpu = fake.nodes[0]
  fake.inject = (_w, cmd) => { if (/apt-get .* (dist-)?upgrade$/.test(cmd)) gpu.holds = []; return undefined }
  const { runner, store } = setup(fake, GPU_POLICY)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  const j = (await store.getJob(job.id))!
  assert.equal(j.status, 'paused')
  assert.match(j.pauseReason!, /after the upgrade: gpu-node: required hold missing/)
})

test('refresh failure fails the job', async () => {
  const fake = cluster()
  fake.inject = (w, cmd) => (cmd === 'POST apt/update' && w === 'node-b' ? new Error('task failed') : undefined)
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  assert.equal((await store.getJob(job.id))!.status, 'failed')
  assert.equal(byAction(await store.getSteps(job.id), 'cluster', 'refresh')!.status, 'failed')
})

for (const [label, target, cmd] of [
  ['snapshot', '101', 'snapshot'],
  ['apt', '101', 'guest:apt'],
  ['docker', '205', 'guest:docker'],
  ['check', '206', 'guest:check'],
] as const) {
  test(`a guest failure at ${label}: that guest stops, others carry on, the node phase does not start`, async () => {
    const fake = cluster()
    fake.inject = (w, c) => (w === target && c === cmd ? (cmd === 'snapshot' ? new Error('snapshot refused') : { code: 1, output: 'E: boom', timedOut: false }) : undefined)
    const { runner, store } = setup(fake)
    const job = await runner.start('run', 'schedule'); await settle(runner)
    const j = (await store.getJob(job.id))!
    const steps = await store.getSteps(job.id)
    assert.equal(j.status, 'paused')
    assert.match(j.pauseReason!, new RegExp(`Guest ${target} failed`))
    assert.equal(steps.find(s => s.target === target && s.status === 'failed')!.action, label)
    // Other guests finished.
    assert.equal(byAction(steps, '102', 'apt')!.status, 'ok')
    // No node was touched.
    assert.equal(fake.ran(/apt-get .* upgrade$|systemctl reboot/), false)
    if (label !== 'snapshot') assert.match(steps.find(s => s.status === 'failed')!.reason!, /snapshot hp-upd-/)

    // Fix it and resume: the failed guest is retried, then the node phase runs.
    fake.inject = () => undefined
    await runner.resume(job.id); await settle(runner)
    assert.equal((await store.getJob(job.id))!.status, 'done')
    assert.equal(fake.calls.filter(c => c.where === '102' && c.cmd === 'guest:apt').length, 1, 'finished guests are not re-run')
  })
}

test('a Ceph install failure pauses the run', async () => {
  const ceph = [pkg('ceph-osd', '19.2.7-pve1', '19.2.6-pve4')]
  const fake = new FakeCluster({ nodes: [node('node-a', { pending: ceph }), node('node-b', { pending: ceph })] })
  fake.inject = (w, c) => (w === 'node-b' && /--only-upgrade install/.test(c) ? { code: 100, output: 'E: held broken', timedOut: false } : undefined)
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  const j = (await store.getJob(job.id))!
  assert.equal(j.status, 'paused')
  assert.match(j.pauseReason!, /ceph on node-b failed: Ceph package install failed/)
  assert.equal(fake.ran(/systemctl restart ceph/), false)
})

test('Ceph restarts settle before moving on, and the OSD restart uses noout', async () => {
  const ceph = [pkg('ceph-osd', '19.2.7-pve1', '19.2.6-pve4')]
  const fake = new FakeCluster({ nodes: [node('node-a', { pending: ceph }), node('node-b', { pending: ceph })] })
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  assert.equal((await store.getJob(job.id))!.status, 'done')
  const order = fake.calls.filter(c => /ceph-(mon|mgr|osd)\.target|noout/.test(c.cmd)).map(c => `${c.where}:${/ceph-(\w+)\.target/.exec(c.cmd)?.[1] ?? c.cmd}`)
  assert.deepEqual(order, [
    'node-a:mon', 'node-b:mon', 'node-a:mgr', 'node-b:mgr',
    'node-b:ceph osd set noout', 'node-a:osd', 'node-b:ceph osd unset noout',
    'node-a:ceph osd set noout', 'node-b:osd', 'node-a:ceph osd unset noout',
  ])
})

test('a node-upgrade failure pauses; resume retries it', async () => {
  const fake = cluster()
  let fail = true
  fake.inject = (w, c) => (fail && w === 'node-a' && /apt-get .* (dist-)?upgrade$/.test(c) ? { code: 100, output: 'dpkg error', timedOut: false } : undefined)
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  assert.equal((await store.getJob(job.id))!.status, 'paused')
  assert.equal(fake.ran(/apt-get .* (dist-)?upgrade$/, 'node-b'), false, 'the next node waits')
  fail = false
  await runner.resume(job.id); await settle(runner)
  assert.equal((await store.getJob(job.id))!.status, 'done')
})

test('a gate failing between nodes pauses the run', async () => {
  const fake = cluster()
  fake.inject = (w, c) => {
    if (w === 'node-a' && /upgrade$/.test(c)) fake.haServices.push({ sid: 'ct:120', node: 'node-a', state: 'migrate' })
    return undefined
  }
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  const j = (await store.getJob(job.id))!
  assert.equal(j.status, 'paused')
  assert.match(j.pauseReason!, /Gate failed before node-upgrade on node-b: HA not settled: ct:120 migrate/)
})

test('a node that does not come back: job fails, noout and HA maintenance are left on', async () => {
  const fake = cluster()
  fake.rebootTakesMs = Infinity
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  const j = (await store.getJob(job.id))!
  assert.equal(j.status, 'failed')
  assert.match(j.pauseReason!, /node-b did not come back within 15 min.*LEFT ON/)
  assert.equal(fake.noout, true)
  assert.ok(fake.maintenance.has('node-b'))
  assert.equal(fake.ran(/ceph osd unset noout|node-maintenance disable/), false)
  assert.equal(byAction(await store.getSteps(job.id), 'node-b', 'kernel-cleanup')!.status, 'skipped')
  assert.deepEqual(j.report!.rebootsPending, ['node-b'])
  assert.equal(await store.activeJob(), null)
})

test('streams delay a reboot, re-checked every 5 minutes, then it proceeds', async () => {
  const fake = cluster()
  fake.plex = [2, 1, 0]
  const { runner, store } = setup(fake, POLICY + 'quiet: { plex_streams_block_reboots: true }\n')
  const job = await runner.start('run', 'schedule'); await settle(runner)
  assert.equal((await store.getJob(job.id))!.status, 'done')
  const reboot = byAction(await store.getSteps(job.id), 'node-b', 'node-reboot')!
  assert.equal(reboot.status, 'ok')
  assert.match(reboot.output!, /2 Plex streams active — re-checking in 5 min/)
  assert.ok(reboot.endedAt!.getTime() - reboot.startedAt!.getTime() >= 10 * 60_000)
})

test('streams past the window: the reboot is skipped, left pending, and the run continues', async () => {
  const fake = cluster()
  fake.plex = [3]
  const { runner, store } = setup(fake, POLICY + 'schedule: { window_hours: 1 }\n')
  const job = await runner.start('run', 'schedule'); await settle(runner)
  const j = (await store.getJob(job.id))!
  assert.equal(j.status, 'done')
  const reboot = byAction(await store.getSteps(job.id), 'node-b', 'node-reboot')!
  assert.equal(reboot.status, 'skipped')
  assert.match(reboot.reason!, /3 Plex streams active until the 1 h window closed — reboot pending/)
  assert.equal(fake.ran(/systemctl reboot/), false)
  assert.deepEqual(j.report!.rebootsPending, ['node-b'])
  assert.equal(byAction(await store.getSteps(job.id), 'node-b', 'kernel-cleanup')!.status, 'ok', 'the run carries on')
})

test('a Plex source that does not answer is treated like viewers; none configured passes', async () => {
  const fake = cluster()
  fake.plex = ['error']
  const { runner, store } = setup(fake, POLICY + 'schedule: { window_hours: 1 }\n')
  const job = await runner.start('run', 'schedule'); await settle(runner)
  assert.match(byAction(await store.getSteps(job.id), 'node-b', 'node-reboot')!.reason!, /Plex source did not answer/)
})

test('manual reboot policy: no reboot, marked pending', async () => {
  const fake = cluster()
  const { runner, store } = setup(fake, POLICY.replace('default: { upgrade: dist-upgrade, reboot: auto }', 'default: { upgrade: dist-upgrade, reboot: manual }'))
  const job = await runner.start('run', 'schedule'); await settle(runner)
  const j = (await store.getJob(job.id))!
  assert.equal(byAction(await store.getSteps(job.id), 'node-b', 'node-reboot')!.reason, 'reboot: manual — reboot pending')
  assert.equal(fake.ran(/systemctl reboot/), false)
  assert.deepEqual(j.report!.rebootsPending, ['node-b'])
  // The next inventory shows it.
  const inv = await readInventory(fake, policyLoad(POLICY)().policy, { rebootPending: runner.rebootPending })
  assert.equal(inv.inventory.nodes.find(n => n.node === 'node-b')!.rebootPending, true)
})

test('kernel cleanup failing does not stop the run', async () => {
  const fake = cluster()
  fake.inject = (w, c) => (/apt-get -s purge|apt-get clean/.test(c) ? { code: 1, output: 'refusing', timedOut: false } : undefined)
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  assert.equal((await store.getJob(job.id))!.status, 'done')
  assert.equal(byAction(await store.getSteps(job.id), 'node-b', 'kernel-cleanup')!.status, 'failed')
})

test('an HA-managed VM is rebooted through ha-manager, never qm', async () => {
  const fake = new FakeCluster({
    nodes: [node('node-a', { pending: [] }), node('node-b', { pending: [] })],
    guests: [guest(301, 'node-a', { type: 'qemu', config: { agent: 'enabled=1' }, rebootAfterUpgrade: true })],
  })
  fake.haSids = ['vm:301']
  fake.haServices = [{ sid: 'vm:301', node: 'node-a', state: 'started' }]
  const { runner, store } = setup(fake, POLICY)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  assert.equal((await store.getJob(job.id))!.status, 'done', (await store.getJob(job.id))!.pauseReason ?? '')
  assert.ok(fake.ran(/ha-manager set 'vm:301' --state stopped/))
  assert.ok(fake.ran(/ha-manager set 'vm:301' --state started/))
  assert.equal(fake.ran(/qm (reboot|stop|start)/), false)
})

test('cancel while running stops after the current step', async () => {
  const fake = cluster()
  const { runner, store } = setup(fake)
  let jobId = ''
  fake.inject = (w, c) => { if (w === '101' && c === 'guest:apt') void runner.cancel(jobId); return undefined }
  const job = await runner.start('run', 'schedule'); jobId = job.id
  await settle(runner)
  const j = (await store.getJob(job.id))!
  assert.equal(j.status, 'cancelled')
  assert.equal(fake.ran(/apt-get .* (dist-)?upgrade$/), false)
  assert.ok((await store.getSteps(job.id)).some(s => s.status === 'skipped' && s.reason === 'cancelled'))
})

test('restart mid-job: paused (never auto-resumed); Resume continues without redoing finished steps', async () => {
  const fake = cluster()
  const store = new MemoryStore()
  const first = setup(fake, POLICY, store)
  const job = await first.runner.start('run', 'manual'); await settle(first.runner)
  // Pretend the API died during the first node upgrade: guests done, node-a step left "running".
  const steps = await store.getSteps(job.id)
  for (const s of steps) {
    if (['snapshot', 'apt', 'docker', 'check'].includes(s.action)) await store.updateStep(s.id, { status: 'ok' })
  }
  await store.updateStep(byAction(steps, 'node-a', 'node-upgrade')!.id, { status: 'running', startedAt: new Date() })
  await store.updateJob(job.id, { status: 'running' })

  const second = setup(fake, POLICY, store)
  await second.runner.recoverAfterRestart()
  const paused = (await store.getJob(job.id))!
  assert.equal(paused.status, 'paused')
  assert.match(paused.pauseReason!, /HyperProx restarted mid-job/)
  assert.equal(fake.ran(/apt-get .* (dist-)?upgrade$/), false, 'nothing ran on its own')

  await second.runner.resume(job.id); await settle(second.runner)
  assert.equal((await store.getJob(job.id))!.status, 'done')
  assert.equal(fake.calls.filter(c => c.cmd === 'guest:apt').length, 0, 'finished guest steps were not redone')
  assert.ok(fake.ran(/apt-get .* (dist-)?upgrade$/, 'node-a'), 'the interrupted step was re-run')
})

test('restart before the plan existed: the job fails cleanly and frees the lock', async () => {
  const store = new MemoryStore()
  const job = await store.createJob({ trigger: 'manual', status: 'running', plan: { steps: [], warnings: [] } })
  await store.addSteps(job.id, [{ seq: 1, target: 'cluster', action: 'preflight', status: 'running' }])
  const { runner } = setup(cluster(), POLICY, store)
  await runner.recoverAfterRestart()
  assert.equal((await store.getJob(job.id))!.status, 'failed')
  assert.equal(await store.activeJob(), null)
})

test("HyperProx's own guest and node go through the handoff; a restart collects the result", async () => {
  const fake = new FakeCluster({
    nodes: [node('node-a', { pending: [] }), node('node-b', { pending: [KERNEL] })],
    guests: [guest(150, 'node-b')],
  })
  fake.handoffResults.set('*', '{"ok":true,"message":"done","finishedAt":"2026-10-24T08:00:00Z"}')
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  const j = (await store.getJob(job.id))!
  const steps = await store.getSteps(job.id)
  assert.equal(j.status, 'done', j.pauseReason ?? '')
  assert.deepEqual(steps.slice(-2).map(s => `${s.target}:${s.action}:${s.status}`), ['150:self:ok', 'node-b:self:ok'])
  assert.match(steps.at(-2)!.detail!, /handoff@node-b/)        // guest upgrade runs on its own node
  assert.match(steps.at(-1)!.detail!, /handoff@node-a/)        // the node reboot runs from a peer
  assert.equal(fake.ran(/systemctl reboot/, 'node-b'), false, 'the API never reboots its own node directly')
  assert.ok(fake.ran(/systemd-run --unit=hyperprox-handoff-/, 'node-a'))

  // Now: the API restarts while the node-reboot handoff is still out, and the script reports failure.
  const store2 = new MemoryStore()
  const fake2 = new FakeCluster({ nodes: [node('node-a', { pending: [] }), node('node-b', { pending: [KERNEL] })], guests: [guest(150, 'node-b', { pending: [] })] })
  const s2 = setup(fake2, POLICY, store2)
  const job2 = await s2.runner.start('run', 'manual'); await settle(s2.runner)
  const selfStep = byAction(await store2.getSteps(job2.id), 'node-b', 'self')!
  await store2.updateStep(selfStep.id, { status: 'running', startedAt: new Date(), detail: `${selfStep.detail} · handoff@node-a` })
  for (const s of await store2.getSteps(job2.id)) if (s.status === 'pending') await store2.updateStep(s.id, { status: 'ok' })
  await store2.updateJob(job2.id, { status: 'running' })
  fake2.handoffResults.set('*', '{"ok":false,"message":"node-b did not return within 15 minutes; noout and HA maintenance LEFT ON"}')
  const s3 = setup(fake2, POLICY, store2)
  await s3.runner.recoverAfterRestart()
  const after = (await store2.getJob(job2.id))!
  assert.equal(after.status, 'paused')
  assert.equal(byAction(await store2.getSteps(job2.id), 'node-b', 'self')!.status, 'failed', 'result collected before pausing')
  assert.match(byAction(await store2.getSteps(job2.id), 'node-b', 'self')!.reason!, /did not return/)
})

test('a failed self guest handoff pauses the run', async () => {
  const fake = new FakeCluster({ nodes: [node('node-a', { pending: [] }), node('node-b', { pending: [] })], guests: [guest(150, 'node-b')] })
  fake.handoffResults.set('*', '{"ok":false,"message":"guest 150 upgrade failed"}')
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  const j = (await store.getJob(job.id))!
  assert.equal(j.status, 'paused')
  assert.match(j.pauseReason!, /self on 150 failed: guest 150 upgrade failed/)
})

test('one-node reboot job: same gates, forced reboot, flags cleared', async () => {
  const fake = cluster()
  const { runner, store } = setup(fake)
  const job = await runner.rebootNode('node-c'); await settle(runner)
  const j = (await store.getJob(job.id))!
  assert.equal(j.status, 'done', j.pauseReason ?? '')
  assert.ok(fake.ran(/systemctl reboot/, 'node-c'))
  assert.equal(fake.noout, false)
  assert.equal(fake.maintenance.size, 0)
  assert.ok(store.audits.some(a => a.action === 'updates.node.reboot' && (a.details as any).node === 'node-c'))
})
