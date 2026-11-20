// Automatic reboots against a pretend cluster: the window and its time zone, the settings, the quorum guard, the Ceph
// gate with noout, HA maintenance (and the path without it for guests that cannot move), HyperProx's own node last
// and a run that carries on after HyperProx restarts, stopping safe at the first problem, waiting for viewers, the
// policy's never-reboot nodes and leave-alone guests, and what is kept on disk. Nothing here touches a real machine.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { UpdatesRunner } from '../src/lib/updates/runner'
import { MemoryStore } from '../src/lib/updates/store'
import { readInventory } from '../src/lib/updates/inventory'
import { AutoReboots } from '../src/lib/updates/auto-reboots'
import {
  windowState, mergeRebootSettings, defaultRebootSettings, RebootSettingsError, rebootQuorumGate, immovableReason,
  nodeRebootNeeded, rebootTargets, FileRebootState, MemoryRebootState, parseHaRules,
} from '../src/lib/updates/reboots'
import { orderNodes } from '../src/lib/updates/planner'
import { parsePolicy } from '../src/lib/updates/policy'
import type { ClusterUpdates } from '../src/lib/updates/service'
import type { NotifyEventInput } from '../src/lib/notify/types'
import { FakeCluster, node, guest, policyLoad, FAST } from './updates-fake'

const POLICY = `
nodes:
  default: { upgrade: upgrade, reboot: manual }
self: { vmid: 150 }
`
const NEWER = ['proxmox-kernel-7.0.1-1-pve-signed', 'proxmox-kernel-7.0.2-1-pve-signed']
const HOUR = 3_600_000

function cluster(over: { b?: Partial<ReturnType<typeof node>> } = {}): FakeCluster {
  return new FakeCluster({
    nodes: [node('node-a', { pending: [] }), node('node-b', { pending: [], kernelPkgs: [...NEWER], ...(over.b ?? {}) }), node('node-c', { pending: [] })],
    guests: [guest(101, 'node-a', { pending: [] })],
  })
}

function setup(fake: FakeCluster, yaml = POLICY, store = new MemoryStore()) {
  const events: NotifyEventInput[] = []
  const runner = new UpdatesRunner({ store, exec: fake, loadPolicy: policyLoad(yaml), timing: FAST, hostname: 'not-a-guest', publish: async e => { events.push(e) } })
  return { runner, store, events }
}
async function settle(r: UpdatesRunner) { await r.idle(); await r.idle() }
const run = (r: UpdatesRunner, fake: FakeCluster, o: Partial<Parameters<UpdatesRunner['startRebootRun']>[0]> = {}) =>
  r.startRebootRun({ kind: 'window', windowEnd: fake.t + 3 * HOUR, quiet: true, nodes: ['node-b'], guests: [], ...o })
const idx = (fake: FakeCluster, re: RegExp) => fake.calls.findIndex(c => re.test(c.cmd))

// --- the window ----------------------------------------------------------------------------------

test('window: 03:00 for 3 hours in UTC — before, inside, at the end; the next one', () => {
  const w = { start: '03:00', hours: 3, days: [0, 1, 2, 3, 4, 5, 6] }
  const before = windowState(Date.parse('2027-01-15T02:59:00Z'), w, 'UTC')
  assert.equal(before.inWindow, false)
  assert.equal(new Date(before.next!.start).toISOString(), '2027-01-15T03:00:00.000Z')
  const inside = windowState(Date.parse('2027-01-15T03:00:00Z'), w, 'UTC')
  assert.equal(inside.inWindow, true)
  assert.equal(new Date(inside.current!.end).toISOString(), '2027-01-15T06:00:00.000Z')
  assert.equal(new Date(inside.next!.start).toISOString(), '2027-01-16T03:00:00.000Z')
  assert.equal(windowState(Date.parse('2027-01-15T06:00:00Z'), w, 'UTC').inWindow, false)
})

test('window: read in the cluster time zone, and across midnight it belongs to the day it starts on', () => {
  const ny = windowState(Date.parse('2027-01-15T08:30:00Z'), { start: '03:00', hours: 3, days: [5] }, 'America/New_York')   // 03:30 on a Friday
  assert.equal(ny.inWindow, true)
  assert.equal(new Date(ny.current!.start).toISOString(), '2027-01-15T08:00:00.000Z')
  const sat = { start: '23:00', hours: 4, days: [6] }   // Saturday 23:00 to Sunday 03:00
  assert.equal(windowState(Date.parse('2027-01-16T23:30:00Z'), sat, 'UTC').inWindow, true)
  assert.equal(windowState(Date.parse('2027-01-17T02:00:00Z'), sat, 'UTC').inWindow, true, 'Sunday 02:00 is still Saturday\'s window')
  const sun = windowState(Date.parse('2027-01-17T23:30:00Z'), sat, 'UTC')
  assert.equal(sun.inWindow, false, 'Sunday is not a window day')
  assert.equal(new Date(sun.next!.start).toISOString(), '2027-01-23T23:00:00.000Z')
})

test('window: the next start keeps its local time across a clock change', () => {
  const s = windowState(Date.parse('2027-03-27T12:00:00Z'), { start: '03:00', hours: 3, days: [0, 1, 2, 3, 4, 5, 6] }, 'Europe/Berlin')
  assert.equal(new Date(s.next!.start).toISOString(), '2027-03-28T01:00:00.000Z', '03:00 summer time')
})

test('settings: off for a new install, 03:00–06:00 daily; bad values refused in words', () => {
  const d = defaultRebootSettings('UTC')
  assert.deepEqual([d.nodes, d.guests, d.quiet, d.window.start, d.window.hours, d.window.days.length], [false, false, true, '03:00', 3, 7])
  const on = mergeRebootSettings(d, { nodes: true, window: { start: '02:30', days: [6, 0, 6] } })
  assert.deepEqual([on.nodes, on.window.start, on.window.days], [true, '02:30', [0, 6]])
  for (const bad of [{ nodes: 'yes' }, { window: { start: '25:00' } }, { window: { hours: 0 } }, { window: { days: [] } }, { timezone: 'Mars/Base' }, { reboot: true }]) {
    assert.throws(() => mergeRebootSettings(d, bad), RebootSettingsError, JSON.stringify(bad))
  }
})

// --- the pure rules -----------------------------------------------------------------------------------

test('reboot needed: /run/reboot-required, or the kernel it would boot is not the running one; a pin decides', () => {
  const f = { rebootRequired: false, runningKernel: '7.0.1-1-pve', pinned: null, kernelPackages: NEWER }
  assert.equal(nodeRebootNeeded(f), true)
  assert.equal(nodeRebootNeeded({ ...f, pinned: '7.0.1-1-pve' }), false, 'pinned to the running kernel: a newer one installed is no reason')
  assert.equal(nodeRebootNeeded({ ...f, pinned: '7.0.1-1-pve', rebootRequired: true }), true)
})

test('quorum guard: every node online, and still quorate without the node', () => {
  const nodes = (n: number, off: string[] = []) => Array.from({ length: n }, (_, i) => ({ name: `n${i}`, online: !off.includes(`n${i}`) }))
  assert.equal(rebootQuorumGate({ quorate: true, nodes: nodes(3) }, 'n1').ok, true)
  assert.match(rebootQuorumGate({ quorate: true, nodes: nodes(2) }, 'n1').reason, /fewer than the 2/)
  assert.match(rebootQuorumGate({ quorate: true, nodes: nodes(5, ['n4']) }, 'n1').reason, /not every node is online/)
  assert.equal(rebootQuorumGate({ quorate: false, nodes: nodes(3) }, 'n1').ok, false)
})

test('guests that cannot move: bind mount without shared=1, passed-through devices, a strict one-node HA rule', () => {
  const ct = { vmid: 120, type: 'lxc' as const }
  assert.match(immovableReason(ct, { mp0: '/srv/media,mp=/media' }, [])!, /bind mount/)
  assert.equal(immovableReason(ct, { mp0: '/srv/media,mp=/media,shared=1' }, []), null)
  assert.equal(immovableReason(ct, { mp0: 'fast-pool:subvol-120-disk-1,mp=/data' }, []), null)
  assert.match(immovableReason(ct, { lxc: [['lxc.cgroup2.devices.allow', 'c 195:* rwm']] }, [])!, /raw lxc/)
  assert.match(immovableReason({ vmid: 220, type: 'qemu' }, { hostpci0: '0000:01:00' }, [])!, /PCI/)
  const rules = parseHaRules([{ rule: 'gpu-lock', type: 'node-affinity', resources: 'ct:120,vm:221', nodes: 'node-b:5', strict: 1 }])
  assert.match(immovableReason(ct, {}, rules)!, /strict HA rule \(gpu-lock\) keeps it on node-b/)
  assert.equal(immovableReason(ct, {}, parseHaRules([{ rule: 'soft', type: 'node-affinity', resources: 'ct:120', nodes: 'node-b', strict: 0 }])), null)
})

test('targets: the policy\'s never-reboot nodes are skipped and listed; leave-alone guests are never targets', async () => {
  const fake = cluster({ b: {} })
  fake.nodes[2].kernelPkgs = [...NEWER]
  fake.guests.push(guest(140, 'node-a', { pending: [], tags: ['hyperprox-ignore'] }))
  const policy = parsePolicy(POLICY.replace('nodes:\n', 'nodes:\n  node-c: { auto_reboot: false }\n'))
  const inv = (await readInventory(fake, policy, { rebootPending: new Set(), hostname: 'x' })).inventory
  inv.guests.find(g => g.vmid === 101)!.rebootRequired = true
  inv.guests.find(g => g.vmid === 140)!.rebootRequired = true
  const t = rebootTargets(inv, policy, { nodes: true, guests: true }, n => orderNodes(n, policy))
  assert.deepEqual(t.nodes, ['node-b'])
  assert.deepEqual(t.never, ['node-c'])
  assert.ok(t.skipped.some(s => s.target === 'node-c' && /auto_reboot: false/.test(s.reason)))
  assert.deepEqual(t.guests, [101])
  assert.ok(t.skipped.some(s => s.target === '140' && /left alone/.test(s.reason)))
})

// --- the engine -------------------------------------------------------------------------------------------

test('a node reboot: Ceph gate, noout set then cleared, HA maintenance on then off; kernel before → after; one start and one summary', async () => {
  const fake = cluster()
  const { runner, store, events } = setup(fake)
  const job = await run(runner, fake); await settle(runner)
  const j = (await store.getJob(job.id))!
  assert.equal(j.status, 'done', j.pauseReason ?? '')
  const setNoout = idx(fake, /^ceph osd set noout$/), maintOn = idx(fake, /node-maintenance enable 'node-b'/)
  const reboot = idx(fake, /^systemctl reboot$/), maintOff = idx(fake, /node-maintenance disable 'node-b'/), unset = idx(fake, /^ceph osd unset noout$/)
  assert.ok(setNoout >= 0 && setNoout < maintOn && maintOn < reboot && reboot < maintOff && maintOff < unset, 'noout, maintenance, reboot, maintenance off, noout off')
  assert.equal(fake.noout, false); assert.equal(fake.maintenance.size, 0)
  const r = j.plan.reboots!.results['node-b']
  assert.deepEqual([r.kernelBefore, r.kernelAfter], ['7.0.1-1-pve', '7.0.2-1-pve'])
  assert.ok((r.downSeconds ?? 0) > 0)
  assert.deepEqual(events.map(e => e.type), ['updates.reboots.started', 'updates.reboots.finished'])
  assert.match(events[1].lines!.join(' '), /node-b: rebooted, kernel 7\.0\.1-1-pve → 7\.0\.2-1-pve, away about \d+ min/)
  assert.ok(store.audits.some(a => a.action === 'updates.reboots.start'))
})

test('Ceph not healthy beyond the accepted warnings: nothing is rebooted, the run stops and says so', async () => {
  const fake = cluster()
  fake.ceph!.checks = ['POOL_NO_REDUNDANCY']
  const { runner, store, events } = setup(fake)
  const job = await run(runner, fake); await settle(runner)
  assert.equal((await store.getJob(job.id))!.status, 'failed')
  assert.equal(fake.ran(/systemctl reboot/), false)
  assert.equal(events.at(-1)!.type, 'updates.reboots.stopped')
  // Accepted in the policy: it goes ahead.
  const fake2 = cluster(); fake2.ceph!.checks = ['POOL_NO_REDUNDANCY']
  const s2 = setup(fake2, POLICY + 'ceph: { accepted_warnings: [POOL_NO_REDUNDANCY] }\n')
  const job2 = await run(s2.runner, fake2); await settle(s2.runner)
  assert.equal((await s2.store.getJob(job2.id))!.status, 'done')
})

test('quorum: a two-node cluster never reboots a node on its own; the run stops without touching anything', async () => {
  const fake = new FakeCluster({ nodes: [node('node-a', { pending: [] }), node('node-b', { pending: [], kernelPkgs: [...NEWER] })], guests: [] })
  const { runner, store } = setup(fake)
  const job = await run(runner, fake); await settle(runner)
  const j = (await store.getJob(job.id))!
  assert.equal(j.status, 'failed', 'stopped, never paused')
  assert.match(j.pauseReason!, /would leave 1 of 2 nodes/)
  assert.equal(fake.ran(/systemctl reboot|noout|node-maintenance/), false)
  assert.equal(await store.activeJob(), null, 'the lock is released')
})

test('a node whose HA guest cannot move: no HA maintenance, HA restarts it in place; noout still guards Ceph', async () => {
  const fake = cluster()
  fake.guests.push(guest(120, 'node-b', { pending: [], config: { mp0: '/srv/media,mp=/media' } }))
  fake.haSids = ['ct:120']; fake.haServices = [{ sid: 'ct:120', node: 'node-b', state: 'started' }]
  const { runner, store } = setup(fake)
  const job = await run(runner, fake); await settle(runner)
  const j = (await store.getJob(job.id))!
  assert.equal(j.status, 'done', j.pauseReason ?? '')
  assert.equal(fake.ran(/node-maintenance/), false)
  assert.ok(fake.ran(/^ceph osd set noout$/) && fake.ran(/^systemctl reboot$/, 'node-b'))
  assert.equal(j.plan.reboots!.results['node-b'].inPlace, true)
  const step = (await store.getSteps(job.id)).find(s => s.target === 'node-b')!
  assert.match(step.output!, /no HA maintenance \(guests restarted in place\)/)
})

test('guests that were running come back: non-HA ones are started again, leave-alone ones never', async () => {
  const fake = cluster()
  fake.guests.push(guest(130, 'node-b', { pending: [], config: { onboot: '0' } }), guest(131, 'node-b', { pending: [], tags: ['hyperprox-ignore'] }))
  fake.inject = (w, c) => {
    if (w === 'node-b' && c === 'systemctl reboot') for (const g of fake.guests.filter(x => x.node === 'node-b')) g.running = false
    if (c === 'pct start 130') fake.guests.find(g => g.vmid === 130)!.running = true
    return undefined
  }
  const { runner, store } = setup(fake)
  const job = await run(runner, fake); await settle(runner)
  const j = (await store.getJob(job.id))!
  assert.equal(j.status, 'done', j.pauseReason ?? '')
  assert.ok(fake.ran(/^pct start 130$/))
  assert.equal(fake.ran(/^pct start 131$/), false, 'a leave-alone guest is never started by HyperProx')
  assert.deepEqual(j.plan.reboots!.results['node-b'].started, ['130 (guest-130)'])
  assert.match((await store.getSteps(job.id)).find(s => s.target === 'node-b')!.output!, /left alone, not started by HyperProx: 131/)
})

test('HyperProx\'s own node goes last, through the handoff from another node', async () => {
  const fake = cluster()
  for (const n of fake.nodes) n.kernelPkgs = [...NEWER]
  fake.guests.push(guest(150, 'node-b', { pending: [] }))
  fake.handoffResults.set('*', '{"ok":true,"message":"node-b rebooted (new boot id) and returned"}')
  const { runner, store } = setup(fake)
  const job = await run(runner, fake, { nodes: ['node-b', 'node-a', 'node-c'] }); await settle(runner)
  const steps = await store.getSteps(job.id)
  assert.deepEqual(steps.slice(1).map(s => `${s.target}:${s.action}:${s.status}`), ['node-a:node-reboot:ok', 'node-c:node-reboot:ok', 'node-b:self:ok'])
  assert.equal(fake.ran(/systemctl reboot/, 'node-b'), false, 'the API never reboots its own node directly')
  assert.ok(fake.ran(/systemd-run --unit=hyperprox-handoff-/, 'node-a'))
})

test('HyperProx restarts while its own node reboots: the run is not paused, and carries on by itself once unlocked', async () => {
  const fake = cluster()
  fake.guests.push(guest(150, 'node-b', { pending: [] }), guest(151, 'node-b', { pending: [], config: { onboot: '0' } }))
  fake.handoffResults.set('*', '{"ok":true,"message":"node-b rebooted (new boot id) and returned"}')
  const store = new MemoryStore()
  const s1 = setup(fake, POLICY, store)
  const job = await run(s1.runner, fake); await settle(s1.runner)
  // As if the API had gone away mid-handoff: the self step running, the job running, the lock held.
  const self = (await store.getSteps(job.id)).find(s => s.action === 'self')!
  assert.match(self.detail!, /handoff@node-a/)
  await store.updateStep(self.id, { status: 'running', endedAt: null })
  await store.updateJob(job.id, { status: 'running', finishedAt: null })
  store.lock = job.id
  fake.guests.find(g => g.vmid === 151)!.running = false
  fake.inject = (_w, c) => { if (c === 'pct start 151') fake.guests.find(g => g.vmid === 151)!.running = true; return undefined }

  const s2 = setup(fake, POLICY, store)
  await s2.runner.recoverAfterRestart()
  assert.equal((await store.getJob(job.id))!.status, 'running', 'not paused')
  assert.equal(await s2.runner.continueRebootRun(), job.id)
  await settle(s2.runner)
  const j = (await store.getJob(job.id))!
  assert.equal(j.status, 'done', j.pauseReason ?? '')
  assert.deepEqual(j.plan.reboots!.results['node-b'].started, ['151 (guest-151)'], 'checked back from what was written before the reboot')
  assert.equal(await s2.runner.continueRebootRun(), null)
  assert.ok(store.audits.some(a => a.action === 'updates.reboots.continue'))
})

test('a restart in the middle of any other reboot step stops the run instead of carrying on', async () => {
  const fake = cluster()
  const store = new MemoryStore()
  const s1 = setup(fake, POLICY, store)
  const job = await run(s1.runner, fake); await settle(s1.runner)
  const step = (await store.getSteps(job.id)).find(s => s.target === 'node-b')!
  await store.updateStep(step.id, { status: 'running' })
  await store.updateJob(job.id, { status: 'running', finishedAt: null }); store.lock = job.id
  const s2 = setup(fake, POLICY, store)
  await s2.runner.recoverAfterRestart()
  const j = (await store.getJob(job.id))!
  assert.equal(j.status, 'failed')
  assert.match(j.pauseReason!, /restarted in the middle of node-reboot on node-b/)
})

test('a node that does not come back: the run stops, noout and maintenance stay on, one critical alert; Make safe clears them once safe', async () => {
  const fake = cluster()
  fake.rebootTakesMs = Infinity
  const { runner, store, events } = setup(fake)
  const job = await run(runner, fake); await settle(runner)
  const j = (await store.getJob(job.id))!
  assert.equal(j.status, 'failed')
  assert.deepEqual(j.plan.reboots!.leftOn, { node: 'node-b', maintenance: true, noout: true })
  assert.equal(fake.noout, true); assert.ok(fake.maintenance.has('node-b'))
  const stops = events.filter(e => e.type === 'updates.reboots.stopped')
  assert.equal(stops.length, 1)
  assert.equal(stops[0].severity, 'critical')
  assert.match(stops[0].lines!.join(' '), /Make safe/)

  // Still down: maintenance comes off, noout stays (OSDs are down).
  const first = await runner.makeSafe('admin@example.com')
  assert.deepEqual(first.cleared, ['HA maintenance on node-b'])
  assert.match(first.left.join(' '), /noout: 2 OSD\(s\) still down/)
  assert.equal(fake.noout, true)
  // Back: noout comes off, and nothing is left on any more.
  fake.nodes[1].offlineUntil = fake.t
  const second = await runner.makeSafe('admin@example.com')
  assert.deepEqual(second.cleared, ['Ceph noout'])
  assert.equal(fake.noout, false)
  assert.equal((await store.getJob(job.id))!.plan.reboots!.leftOn, null)
  assert.ok(store.audits.some(a => a.action === 'updates.reboots.make-safe'))
  await assert.rejects(runner.makeSafe('admin@example.com'), /No rolling reboot left anything on/)
})

test('a refused reboot clears its flags and stops the run (never a pause); nothing is left on', async () => {
  const fake = cluster()
  fake.inject = (w, c) => (w === 'node-b' && c === 'systemctl reboot' ? { code: 1, output: 'Failed to reboot', timedOut: false } : undefined)
  const { runner, store, events } = setup(fake)
  const job = await run(runner, fake); await settle(runner)
  const j = (await store.getJob(job.id))!
  assert.equal(j.status, 'failed')
  assert.equal(j.plan.reboots!.leftOn, null)
  assert.equal(fake.noout, false); assert.equal(fake.maintenance.size, 0)
  assert.equal(events.at(-1)!.severity, 'warning')
  assert.match(events.at(-1)!.lines!.join(' '), /Nothing was left on/)
})

test('viewers: waits, asking again every 10 minutes, then reboots; past the window it waits for the next one', async () => {
  const fake = cluster()
  fake.plex = [2, 1, 0]
  const { runner, store } = setup(fake)
  const t0 = fake.t
  const job = await run(runner, fake); await settle(runner)
  assert.equal((await store.getJob(job.id))!.status, 'done')
  assert.ok(fake.t - t0 >= 20 * 60_000, 'two waits of 10 minutes')

  const fake2 = cluster(); fake2.plex = [3]
  const s2 = setup(fake2)
  const job2 = await run(s2.runner, fake2, { windowEnd: fake2.t + 25 * 60_000 }); await settle(s2.runner)
  const step = (await s2.store.getSteps(job2.id)).find(s => s.target === 'node-b')!
  assert.equal(step.status, 'skipped')
  assert.match(step.reason!, /3 Plex streams active until the reboot window closed/)
  assert.equal(fake2.ran(/systemctl reboot/), false)
  // "Only when nobody is watching" off: viewers do not hold it back.
  const fake3 = cluster(); fake3.plex = [3]
  const s3 = setup(fake3)
  const job3 = await run(s3.runner, fake3, { quiet: false }); await settle(s3.runner)
  assert.equal((await s3.store.getJob(job3.id))!.status, 'done')
  assert.ok(fake3.ran(/systemctl reboot/, 'node-b'))
})

test('guest reboots: only one that still asks, HA guests through ha-manager, leave-alone ones skipped', async () => {
  const fake = cluster()
  fake.guests.push(guest(160, 'node-a', { pending: [] }), guest(161, 'node-a', { pending: [] }), guest(162, 'node-c', { pending: [], tags: ['hyperprox-ignore'] }), guest(163, 'node-c', { pending: [] }))
  fake.haSids = ['ct:161']; fake.haServices = [{ sid: 'ct:161', node: 'node-a', state: 'started' }]
  fake.inject = (w, c) => (c === 'guest:other' && w !== '163' ? { code: 0, output: 'HP_REBOOT_REQUIRED', timedOut: false } : undefined)
  const { runner, store } = setup(fake)
  const job = await run(runner, fake, { nodes: [], guests: [160, 161, 162, 163] }); await settle(runner)
  const by = async (t: string) => (await store.getSteps(job.id)).find(s => s.target === t)!
  assert.equal((await store.getJob(job.id))!.status, 'done')
  assert.equal((await by('160')).status, 'ok'); assert.ok(fake.ran(/^pct reboot 160$/, 'node-a'))
  assert.equal((await by('161')).status, 'ok'); assert.ok(fake.ran(/ha-manager set 'ct:161' --state stopped/)); assert.equal(fake.ran(/pct reboot 161/), false)
  assert.match((await by('162')).reason!, /hyperprox-ignore/)
  assert.match((await by('163')).reason!, /no reboot needed any more/)
})

// --- the service: the window timer, policy skips and what is kept ---------------------------------------

function service(fake: FakeCluster, yaml = POLICY, store = new MemoryStore()) {
  const s = setup(fake, yaml, store)
  const load = policyLoad(yaml)
  let cached: any = null
  const svc = {
    ref: { id: 'home', name: 'Home cluster', kind: 'home' }, remote: false, exec: fake, store, runner: s.runner, loadPolicy: load,
    inventory: async () => { cached = (await readInventory(fake, load().policy, { rebootPending: s.runner.rebootPending, hostname: 'x' })).inventory; return cached },
    cached: () => cached,
  } as unknown as ClusterUpdates
  const state = new MemoryRebootState()
  const auto = new AutoReboots({ service: () => svc, state, isUnlocked: () => true, now: () => fake.t })
  return { ...s, auto, state, svc }
}

test('the window timer: off by default; on, it starts one run per window and leaves the never-reboot node out', async () => {
  const fake = cluster()
  fake.nodes[2].kernelPkgs = [...NEWER]
  fake.t = Date.parse('2027-01-15T03:30:00Z')
  const { auto, state, store, runner } = service(fake, POLICY.replace('nodes:\n', 'nodes:\n  node-c: { auto_reboot: false }\n'))
  assert.equal(await auto.tick(), 'off')
  state.set('home', { settings: { ...defaultRebootSettings('UTC'), nodes: true } })
  assert.equal(await auto.tick(), 'started')
  await settle(runner)
  const job = (await store.listJobs(1))[0]
  assert.equal(job.trigger, 'schedule')
  assert.deepEqual(job.plan.reboots!.nodes, ['node-b'])
  assert.ok(job.plan.reboots!.skipped.some(s => s.target === 'node-c'))
  assert.equal(job.status, 'done', job.pauseReason ?? '')
  assert.equal(await auto.tick(), 'done', 'once per window')
  const st = await auto.status('home')
  assert.equal(st.history.length, 1)
  assert.deepEqual(st.never, ['node-c'])
})

test('a queued "reboot in the next window" runs even with the switches off, once; outside the window nothing starts', async () => {
  const fake = cluster()
  fake.t = Date.parse('2027-01-15T02:00:00Z')
  const { auto, state, store, runner } = service(fake)
  auto.queueNext('home', 'admin@example.com', 'job1')
  assert.equal(await auto.tick(), 'outside')
  const st = await auto.status('home')
  assert.equal(st.waiting.at, '2027-01-15T03:00:00.000Z')
  fake.t = Date.parse('2027-01-15T03:01:00Z')
  assert.equal(await auto.tick(), 'started')
  await settle(runner)
  assert.equal(state.get('home').queued, null)
  assert.equal((await store.listJobs(1))[0].status, 'done')
})

test('settings and the queue are kept on disk; an unreadable file means the safe defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-reboots-'))
  const file = path.join(dir, 'updates-reboots.json')
  const a = new FileRebootState(file)
  a.set('home', { settings: { ...defaultRebootSettings('UTC'), guests: true }, queued: { at: '2027-01-15T00:00:00.000Z', by: 'admin@example.com' } })
  const b = new FileRebootState(file)
  assert.equal(b.get('home').settings!.guests, true)
  assert.equal(b.get('home').queued!.by, 'admin@example.com')
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600')
  fs.writeFileSync(file, 'not json')
  assert.deepEqual(new FileRebootState(file).get('home'), {})
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the plan of a rolling reboot is the record: results survive in the job', async () => {
  const fake = cluster()
  const store = new MemoryStore()
  const { runner } = setup(fake, POLICY, store)
  const job = await run(runner, fake); await settle(runner)
  const kept = (await store.getJob(job.id))!
  assert.ok(kept.plan.reboots!.results['node-b'].kernelAfter)
  assert.equal(kept.plan.reboots!.kind, 'window')
})
