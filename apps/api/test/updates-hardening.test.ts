// Review fixes: error answers never pass a gate, status changes cannot race, gates are re-checked after the
// viewer wait, restarts mid-guest-step, reboots confirmed by boot id, unknown policy nodes, and the smaller
// safety items (snapshots pruned, HA desired state restored, flags never stranded, stale locks).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UpdatesRunner, PolicyRequiredError, JobStateError } from '../src/lib/updates/runner'
import { MemoryStore, type StepRecord } from '../src/lib/updates/store'
import { productionExecutor } from '../src/lib/updates/executor'
import { readInventory } from '../src/lib/updates/inventory'
import { nodePolicy, parsePolicy } from '../src/lib/updates/policy'
import { selfNodeRebootScript } from '../src/lib/updates/handoff'
import type { ProxmoxClient } from '../src/lib/proxmox-client'
import { FakeCluster, node, guest, pkg, policyLoad, FAST } from './updates-fake'

const POLICY = `
nodes:
  default: { upgrade: dist-upgrade, reboot: auto }
guests:
  default: { reboot: if-required }
batch_size: 2
`
const KERNEL = pkg('proxmox-kernel-7.0.2-1-pve-signed', '7.0.2-1', null)
const WRITES = /^POST apt\/update$|^guest:(apt|refresh|docker|check)$|^snapshot|apt-get|systemctl (reboot|restart)|noout|ha-manager|systemd-run/

function cluster(): FakeCluster {
  return new FakeCluster({
    nodes: [node('node-a'), node('node-b', { pending: [pkg('curl', '8.1-2'), KERNEL] }), node('node-c', { pending: [] })],
    guests: [guest(101, 'node-a'), guest(102, 'node-b')],
  })
}
function setup(fake: FakeCluster, yaml: string | null = POLICY, store = new MemoryStore()) {
  const runner = new UpdatesRunner({ store, exec: fake, loadPolicy: policyLoad(yaml), timing: FAST, hostname: 'not-a-guest' })
  return { runner, store }
}
async function settle(r: UpdatesRunner) { await r.idle(); await r.idle(); await r.idle() }
const byAction = (steps: StepRecord[], target: string, action: string) => steps.find(s => s.target === target && s.action === action)

// --- B1: error answers ------------------------------------------------------------------------

for (const read of ['clusterStatus', 'haStatus', 'haResources', 'cephPresent', 'cephHealth', 'listGuests', 'nodeAptPending']) {
  test(`B1: an error answer from ${read} stops the run before anything changes`, async () => {
    const fake = cluster()
    fake.readFail.add(read)
    const { runner, store } = setup(fake)
    let job
    try { job = await runner.start('run', 'schedule') }
    catch (e: any) {
      // clusterStatus is read before the job exists (unknown-node check): refused outright is fine too.
      assert.equal(read, 'clusterStatus'); assert.match(e.message, /HTTP 500/); return
    }
    await settle(runner)
    const j = (await store.getJob(job.id))!
    assert.equal(j.status, 'failed', `${read}: ${j.pauseReason}`)
    assert.deepEqual(fake.calls.filter(c => WRITES.test(c.cmd)), [], `${read}: nothing may run`)
  })
}

test('B1: Ceph health failing mid-run is a gate failure, not "no Ceph"', async () => {
  const fake = cluster()
  const { runner, store } = setup(fake)
  fake.inject = (w, c) => { if (w === '101' && c === 'guest:apt') fake.readFail.add('cephHealth'); return undefined }
  const job = await runner.start('run', 'schedule'); await settle(runner)
  const j = (await store.getJob(job.id))!
  assert.equal(j.status, 'paused')
  assert.match(j.pauseReason!, /could not read Ceph health/)
  assert.equal(fake.ran(/systemctl reboot|ceph osd set noout/), false)
})

test('B1: an HA resource list that cannot be read never falls back to qm reboot', async () => {
  const fake = new FakeCluster({
    nodes: [node('node-a', { pending: [] }), node('node-b', { pending: [] })],
    guests: [guest(301, 'node-a', { type: 'qemu', config: { agent: '1' }, rebootAfterUpgrade: true })],
  })
  fake.haSids = ['vm:301']
  fake.inject = (w, c) => { if (w === '301' && c === 'guest:apt') fake.readFail.add('haResources'); return undefined }
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  assert.equal((await store.getJob(job.id))!.status, 'paused')
  assert.equal(fake.ran(/qm reboot/), false)
})

test('B1: HA status that cannot be read during the drain means not drained: flags cleared, no reboot', async () => {
  const fake = cluster()
  fake.inject = (w, c) => { if (/node-maintenance enable/.test(c)) fake.readFail.add('haStatus'); return undefined }
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  const reboot = byAction(await store.getSteps(job.id), 'node-b', 'node-reboot')!
  assert.equal(reboot.status, 'failed')
  assert.match(reboot.reason!, /HA could not move every guest off node-b/)
  assert.equal(fake.ran(/systemctl reboot/), false)
  assert.equal(fake.noout, false); assert.equal(fake.maintenance.size, 0)
})

test('B1: an unreadable guest config leaves the guest unmanaged rather than guessing', async () => {
  const fake = cluster()
  fake.readFail.add('guestConfig')
  const { inventory } = await readInventory(fake, parsePolicy(POLICY))
  assert.ok(inventory.guests.every(g => !g.managed && /config could not be read/.test(g.error ?? '')))
})

test('B1: the production executor rejects null and non-array answers on every read', async () => {
  for (const answer of [null, {}, 'oops']) {
    const pve = { fetchStrict: async () => answer } as unknown as ProxmoxClient
    const exec = productionExecutor(pve)
    const g = { vmid: 101, type: 'lxc' as const, node: 'node-a', name: 'web' }
    const reads: Array<[string, () => Promise<unknown>]> = [
      ['clusterStatus', () => exec.clusterStatus()], ['haStatus', () => exec.haStatus()],
      ['haResources', () => exec.haResources()], ['cephHealth', () => exec.cephHealth()],
      ['listGuests', () => exec.listGuests()], ['nodeAptPending', () => exec.nodeAptPending('node-a')],
      ['listSnapshots', () => exec.listSnapshots(g)],
    ]
    if (answer !== null && typeof answer !== 'object') reads.push(['guestConfig', () => exec.guestConfig(g)])
    if (answer === null) reads.push(['guestConfig', () => exec.guestConfig(g)])
    for (const [name, fn] of reads) await assert.rejects(fn(), /Proxmox returned/, `${name} with ${JSON.stringify(answer)}`)
  }
  const failing = { fetchStrict: async () => { throw new Error('Proxmox GET /cluster/ceph/status: HTTP 500 — rados_connect failed') } } as unknown as ProxmoxClient
  await assert.rejects(productionExecutor(failing).cephHealth(), /HTTP 500/)
})

// --- B2: racing transitions -----------------------------------------------------------------------

test('B2: two Resumes at once: exactly one wins, the failed step runs once more, never skipped', async () => {
  const fake = cluster()
  let fail = true
  fake.inject = (w, c) => (fail && w === 'node-a' && /apt-get .* (dist-)?upgrade$/.test(c) ? { code: 100, output: 'held packages', timedOut: false } : undefined)
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  assert.equal((await store.getJob(job.id))!.status, 'paused')
  fail = false
  const results = await Promise.allSettled([runner.resume(job.id), runner.resume(job.id)])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.ok(results.some(r => r.status === 'rejected' && r.reason instanceof JobStateError))
  await settle(runner)
  assert.equal((await store.getJob(job.id))!.status, 'done')
  assert.equal(fake.cmds('node-a').filter(c => /apt-get .* (dist-)?upgrade$/.test(c)).length, 2, 'one failure, one retry')
})

test('B2: a failed node step is a hard stop even if execute() is entered again', async () => {
  const fake = cluster()
  fake.inject = (w, c) => (w === 'node-a' && /apt-get .* (dist-)?upgrade$/.test(c) ? { code: 100, output: 'boom', timedOut: false } : undefined)
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  // Force the job back to running without resetting the failed step, as a racing second execute would see it.
  await store.updateJob(job.id, { status: 'running' })
  await (runner as any).execute(job.id)
  assert.equal((await store.getJob(job.id))!.status, 'paused')
  assert.equal(fake.ran(/apt-get .* (dist-)?upgrade$/, 'node-b'), false, 'the next node was not reached')
})

for (const order of ['confirm-first', 'cancel-first'] as const) {
  test(`B2: Confirm racing Cancel (${order}) ends cancelled, lock released, node phase never runs`, async () => {
    const fake = cluster()
    const { runner, store } = setup(fake)
    const job = await runner.start('run', 'manual'); await settle(runner)
    assert.equal((await store.getJob(job.id))!.status, 'awaiting-confirm')
    const calls = order === 'confirm-first' ? [runner.confirm(job.id), runner.cancel(job.id)] : [runner.cancel(job.id), runner.confirm(job.id)]
    const [a, b] = await Promise.allSettled(calls)
    await settle(runner)
    const j = (await store.getJob(job.id))!
    assert.equal(j.status, 'cancelled', `${a.status}/${b.status}`)
    assert.equal(await store.activeJob(), null)
    assert.equal(fake.ran(/apt-get .* (dist-)?upgrade$|systemctl reboot/), false)
    const cancelResult = order === 'confirm-first' ? b : a
    if (cancelResult.status === 'fulfilled' && cancelResult.value.status === 'cancelled') {
      assert.deepEqual(fake.calls.filter(c => /^guest:apt$|^snapshot/.test(c.cmd)), [], 'cancelled before confirm: nothing ran')
    }
  })
}

test('B2: cancel during preflight is honoured, and the stale request does not cancel a later job', async () => {
  const fake = cluster()
  const { runner, store } = setup(fake)
  let jobId = ''
  let once = true
  fake.inject = (_w, c) => { if (once && c === 'guest:pending') { once = false; void runner.cancel(jobId) } return undefined }
  const job = await runner.start('run', 'manual'); jobId = job.id
  await settle(runner)
  assert.equal((await store.getJob(job.id))!.status, 'cancelled')
  assert.equal(fake.calls.some(c => c.cmd === 'POST apt/update'), false, 'refresh did not run')
  const next = await runner.start('run', 'manual'); await settle(runner)
  await runner.confirm(next.id); await settle(runner)
  assert.equal((await store.getJob(next.id))!.status, 'done')
})

// --- B3: gates after the viewer wait ------------------------------------------------------------

test('B3: HA unsettled after waiting for viewers stops the reboot before noout', async () => {
  const fake = cluster()
  fake.plex = [2, 0]
  const sleep = fake.sleep.bind(fake)
  fake.sleep = async (ms: number) => {
    await sleep(ms)
    if (ms === FAST.streamRecheckMs) fake.haServices.push({ sid: 'ct:120', node: 'node-a', state: 'migrate' })
  }
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  const j = (await store.getJob(job.id))!
  const reboot = byAction(await store.getSteps(job.id), 'node-b', 'node-reboot')!
  assert.equal(j.status, 'paused')
  assert.equal(reboot.status, 'failed')
  assert.match(reboot.reason!, /after waiting for viewers: HA not settled: ct:120 migrate/)
  assert.equal(fake.ran(/ceph osd set noout|node-maintenance enable|systemctl reboot/), false)
})

// --- B4: restart during a guest step ---------------------------------------------------------------

test('B4: a guest step interrupted by a restart is failed, holds the node phase, and is retried on Resume', async () => {
  const fake = cluster()
  const store = new MemoryStore()
  const first = setup(fake, POLICY, store)
  const job = await first.runner.start('run', 'manual'); await settle(first.runner)
  const steps = await store.getSteps(job.id)
  await store.updateStep(byAction(steps, '101', 'snapshot')!.id, { status: 'ok' })
  await store.updateStep(byAction(steps, '101', 'apt')!.id, { status: 'running', startedAt: new Date() })
  await store.updateJob(job.id, { status: 'running' })

  const second = setup(fake, POLICY, store)
  await second.runner.recoverAfterRestart()
  const apt = byAction(await store.getSteps(job.id), '101', 'apt')!
  assert.equal(apt.status, 'failed')
  assert.match(apt.reason!, /interrupted by a HyperProx restart/)
  assert.equal((await store.getJob(job.id))!.status, 'paused')

  await second.runner.resume(job.id); await settle(second.runner)
  assert.equal((await store.getJob(job.id))!.status, 'done')
  assert.equal(fake.calls.filter(c => c.where === '101' && c.cmd === 'guest:apt').length, 1, 'retried once')
  assert.ok(fake.calls.findIndex(c => c.where === '101' && c.cmd === 'guest:apt') < fake.calls.findIndex(c => /apt-get .* (dist-)?upgrade$/.test(c.cmd)),
    'the guest finished before any node was touched')
})

// --- B5: boot id ------------------------------------------------------------------------------------

test('B5: a node whose boot id never changes did not reboot: step failed, flags cleared, job paused', async () => {
  const fake = cluster()
  fake.rebootIgnored = true
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  const j = (await store.getJob(job.id))!
  const reboot = byAction(await store.getSteps(job.id), 'node-b', 'node-reboot')!
  assert.equal(reboot.status, 'failed')
  assert.match(reboot.reason!, /never rebooted \(its boot id did not change\)/)
  assert.equal(j.status, 'paused')
  assert.equal(fake.noout, false); assert.equal(fake.maintenance.size, 0)
})

test('B5: a refused reboot command fails the step and clears the flags', async () => {
  const fake = cluster()
  fake.inject = (_w, c) => (c === 'systemctl reboot' ? { code: 1, output: 'Failed to reboot: Access denied', timedOut: false } : undefined)
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  const reboot = byAction(await store.getSteps(job.id), 'node-b', 'node-reboot')!
  assert.match(reboot.reason!, /refused the reboot.*Access denied/)
  assert.equal(fake.noout, false); assert.equal(fake.maintenance.size, 0)
})

test('B5/B6: the self-reboot handoff checks HA drained, compares boot ids, checks the flag clearing, and quotes the node', () => {
  const sh = selfNodeRebootScript('job1', 'stp1', "node-b'; rm -rf /", { ceph: true })
  assert.match(sh, /cluster\/ha\/status\/current/)
  assert.match(sh, /boot_before=\$\(ssh_t cat \/proc\/sys\/kernel\/random\/boot_id/)
  assert.match(sh, /"\$boot_now" != "\$boot_before"/)
  assert.match(sh, /node-maintenance disable "\$target" \|\| left=/)
  assert.match(sh, /HA did not move every guest off/)
  assert.match(sh, /target='node-b'\\''; rm -rf \/'/)
  assert.doesNotMatch(sh, /sleep 60\s+# let HA move guests off/)
})

// --- B7: unknown policy nodes, guarded upgrade default ------------------------------------------------

test('B7: a policy naming a node the cluster lacks refuses a run and stops a dry run in preflight', async () => {
  const yaml = POLICY.replace('nodes:\n', 'nodes:\n  nod-b: { reboot: manual }\n')
  const fake = cluster()
  const { runner, store } = setup(fake, yaml)
  await assert.rejects(runner.start('run', 'schedule'), (e: any) => e instanceof PolicyRequiredError && /not in this cluster: nod-b/.test(e.message))
  const dry = await runner.start('dry-run'); await settle(runner)
  const d = (await store.getJob(dry.id))!
  assert.equal(d.status, 'done')
  assert.match(d.report!.summary, /preflight would stop the run: .*not in this cluster: nod-b/)
})

test('B7: a node with holds or a pin never inherits dist-upgrade from the default', () => {
  const p = parsePolicy(`
nodes:
  default: { upgrade: dist-upgrade, reboot: auto }
  gpu-node: { require_pin: 7.0.1-1-pve }
  held-node: { require_holds: [proxmox-default-kernel] }
  chosen: { require_pin: 7.0.1-1-pve, upgrade: dist-upgrade }
`)
  assert.equal(nodePolicy(p, 'gpu-node').upgrade, 'upgrade')
  assert.equal(nodePolicy(p, 'held-node').upgrade, 'upgrade')
  assert.equal(nodePolicy(p, 'chosen').upgrade, 'dist-upgrade', 'an explicit choice stands')
  assert.equal(nodePolicy(p, 'other').upgrade, 'dist-upgrade')
})

// --- Minors -----------------------------------------------------------------------------------------

test('snapshots: after a clean run only the newest hp-upd-* is kept; other snapshots are never touched', async () => {
  const fake = cluster()
  fake.snapshots.set(101, [{ name: 'hp-upd-202609010800', snaptime: 1 }, { name: 'hp-upd-202610010800', snaptime: 2 }, { name: 'before-migration', snaptime: 0 }])
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  assert.equal((await store.getJob(job.id))!.status, 'done')
  const left = fake.snapshots.get(101)!.map(s => s.name).sort()
  assert.equal(left.length, 2)
  assert.ok(left.includes('before-migration'))
  assert.ok(left.some(n => n.startsWith('hp-upd-') && n !== 'hp-upd-202609010800' && n !== 'hp-upd-202610010800'))
})

test('snapshots: a guest that failed keeps all of its snapshots', async () => {
  const fake = cluster()
  fake.snapshots.set(101, [{ name: 'hp-upd-202609010800', snaptime: 1 }])
  fake.inject = (w, c) => (w === '101' && c === 'guest:apt' ? { code: 1, output: 'E', timedOut: false } : undefined)
  const { runner } = setup(fake)
  await runner.start('run', 'schedule'); await settle(runner)
  assert.equal(fake.snapshots.get(101)!.length, 2)
})

test('HA guest reboot: a stop that times out puts the desired state back to started and fails the step', async () => {
  const fake = new FakeCluster({
    nodes: [node('node-a', { pending: [] }), node('node-b', { pending: [] })],
    guests: [guest(301, 'node-a', { type: 'qemu', config: { agent: '1' }, rebootAfterUpgrade: true })],
  })
  fake.haSids = ['vm:301']
  fake.haServices = [{ sid: 'vm:301', node: 'node-a', state: 'started' }]
  fake.inject = (_w, c) => (/--state stopped/.test(c) ? { code: 0, output: '', timedOut: false } : undefined)   // accepted, never stops
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  const apt = byAction(await store.getSteps(job.id), '301', 'apt')!
  assert.equal(apt.status, 'failed')
  assert.match(apt.reason!, /did not stop in time; its HA state was set back to started/)
  assert.ok(fake.ran(/ha-manager set 'vm:301' --state started/))
})

test('flags: maintenance that cannot be enabled takes noout back off; a flag that cannot be cleared is named', async () => {
  const fake = cluster()
  fake.inject = (_w, c) => (/node-maintenance enable/.test(c) ? { code: 255, output: 'crm not reachable', timedOut: false } : undefined)
  const { runner, store } = setup(fake)
  const job = await runner.start('run', 'schedule'); await settle(runner)
  assert.match(byAction(await store.getSteps(job.id), 'node-b', 'node-reboot')!.reason!, /crm not reachable; noout cleared again/)
  assert.equal(fake.noout, false)

  const fake2 = cluster()
  fake2.inject = (_w, c) => (c === 'ceph osd unset noout' ? { code: 1, output: 'mon down', timedOut: false } : undefined)
  const s2 = setup(fake2)
  const job2 = await s2.runner.start('run', 'schedule'); await settle(s2.runner)
  const j2 = (await s2.store.getJob(job2.id))!
  assert.equal(j2.status, 'paused')
  assert.match(j2.pauseReason!, /could not clear Ceph noout — LEFT ON/)
  assert.equal(fake2.maintenance.size, 0, 'maintenance was still cleared')
})

test('a lock left behind by a finished job does not block the next one', async () => {
  const store = new MemoryStore()
  const old = await store.createJob({ trigger: 'manual', status: 'running', plan: { steps: [], warnings: [] } })
  await store.updateJob(old.id, { status: 'done' })   // crashed before releasing the lock
  assert.equal(await store.activeJob(), null)
  const fresh = await store.createJob({ trigger: 'manual', status: 'running', plan: { steps: [], warnings: [] } })
  assert.ok(fresh.id)
  assert.equal((await store.transitionJob(fresh.id, ['paused'], { status: 'running' })), null, 'transition refuses a wrong from-state')
})
