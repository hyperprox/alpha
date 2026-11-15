// Updates by target: the tree of everything that can be updated, and the plan for any mix a person chooses.
// Pure: an inventory read from the pretend cluster, a policy, a selection; nothing runs.
// The guarded node stands for a node whose GPU driver needs its kernel to stay exactly where it is.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readInventory } from '../src/lib/updates/inventory'
import { parsePolicy } from '../src/lib/updates/policy'
import { buildPlan } from '../src/lib/updates/planner'
import {
  buildTargets, buildSelectedPlan, everythingSelection, parseTargetId, targetId, nodePackageRefusal, packagesOf, composeKeyOf,
} from '../src/lib/updates/targets'
import { FakeCluster, node, guest, pkg } from './updates-fake'

const POLICY = `
nodes:
  default: { upgrade: dist-upgrade, reboot: auto }
  gpu-node: { upgrade: dist-upgrade, reboot: manual, require_holds: [proxmox-default-kernel, proxmox-kernel-7.0, proxmox-headers-7.0], require_pin: 7.0.1-1-pve }
guests:
  exclude: [110]
  "205": { docker: auto, compose_dirs: [/opt/stack] }
self: { vmid: 150 }
`
const HOLDS = ['proxmox-default-kernel', 'proxmox-kernel-7.0', 'proxmox-headers-7.0']
const KERNEL = pkg('proxmox-kernel-7.0.2-1-pve-signed', '7.0.2-1', null)

function cluster(): FakeCluster {
  return new FakeCluster({
    nodes: [
      node('node-a'),
      node('node-b', { pending: [pkg('curl', '8.1-2', '8.1-1'), KERNEL] }),
      // What the pending list can show for a guarded node: its kernel series and headers metapackages among the rest.
      node('gpu-node', { holds: HOLDS, pinned: '7.0.1-1-pve', pending: [pkg('curl', '8.1-2', '8.1-1'), pkg('proxmox-kernel-7.0', '7.0.2-1'), pkg('proxmox-headers-7.0', '7.0.2-1'), pkg('pve-manager', '9.2-3', '9.2-2')] }),
    ],
    guests: [
      guest(101, 'node-a'), guest(102, 'node-b'), guest(110, 'node-a'),
      guest(120, 'gpu-node', { tags: ['hyperprox-ignore'] }),
      guest(205, 'node-b', { compose: [{ dir: '/opt/stack', images: [{ image: 'app:1', current: 'sha256:a', latest: 'sha256:b' }] }, { dir: '/srv/other', images: [] }] }),
      guest(150, 'gpu-node', { name: 'hyperprox' }),
    ],
  })
}

async function inventory(fake = cluster(), yaml = POLICY) {
  const policy = parsePolicy(yaml)
  const r = await readInventory(fake, policy, { hostname: 'x', discoverCompose: 'all' })
  return { inv: r.inventory, policy }
}
const ctx = { selfVmid: 150 }

test('target ids: only well-formed ids parse; anything shell-like is refused', () => {
  assert.deepEqual(parseTargetId('node:node-a'), { kind: 'node', node: 'node-a' })
  assert.deepEqual(parseTargetId('node:node-a:pkg:libc6'), { kind: 'node-pkg', node: 'node-a', pkg: 'libc6' })
  assert.deepEqual(parseTargetId('guest:205:compose:/opt/stack'), { kind: 'compose', vmid: 205, key: '/opt/stack' })
  assert.deepEqual(parseTargetId('guest:205:compose:web-dev'), { kind: 'compose', vmid: 205, key: 'web-dev' })
  for (const bad of ['node:a;rm -rf /', 'node:a:pkg:curl;id', 'guest:1:compose:/opt/../etc', 'guest:1:compose:Not A Name', 'guest:1:pkg:$(id)', 'guest:x', 'whatever', 42]) {
    assert.equal(parseTargetId(bad), null, String(bad))
  }
})

test('the tree: nodes in order with their packages, guests under their node, blocked rows say why', async () => {
  const { inv, policy } = await inventory()
  const t = buildTargets(inv, policy, ctx)
  const row = (id: string) => t.find(x => x.id === id)!
  assert.ok(row('node:node-a') && row('node:node-b') && row('node:gpu-node'))
  assert.equal(row('guest:101').parent, 'node:node-a')
  assert.equal(row('guest:205').parent, 'node:node-b')
  assert.equal(row('node:node-b').pending, 2)
  // The guarded node: its kernel and headers metapackages are listed, never selectable, with the reason.
  for (const p of ['proxmox-kernel-7.0', 'proxmox-headers-7.0']) {
    const r = row(`node:gpu-node:pkg:${p}`)
    assert.equal(r.selectable, false, p)
    assert.match(r.blocked!, /held|kernel/)
  }
  assert.equal(row('node:gpu-node:pkg:curl').selectable, true)
  assert.match(row('node:gpu-node').sub!, /apt-get upgrade/, 'a guarded node is offered upgrade, never dist-upgrade')
  assert.match(row('node:node-a').sub!, /apt-get dist-upgrade/)
  // Excluded and ignored guests are listed, never selectable.
  assert.equal(row('guest:110').selectable, false)
  assert.match(row('guest:120').blocked!, /hyperprox-ignore/)
  // A reboot row only where one is due: node-b's new kernel.
  assert.ok(row('node:node-b:reboot'))
  assert.equal(t.some(x => x.id === 'node:node-a:reboot'), false)
  // Compose projects: the policy's and one found running; images counted.
  assert.equal(row('guest:205:compose:p0').pending, 1)
  assert.equal(row('guest:205:compose:p0').everything, true)
  assert.equal(row('guest:205:compose:p1').everything, false, 'a found project is never part of "everything"')
  assert.equal(row('guest:150').label, '150 hyperprox (HyperProx)')
  assert.equal(row('guest:150:pkg:openssl').selectable, false)
})

test('a single-package request for a held kernel package is refused, and nothing is planned', async () => {
  const { inv, policy } = await inventory()
  for (const p of ['proxmox-kernel-7.0', 'proxmox-headers-7.0', 'proxmox-default-kernel']) {
    const plan = buildSelectedPlan(inv, policy, { ...ctx, selection: [targetId.nodePkg('gpu-node', p)] })
    assert.equal(plan.steps.length, 0, p)
    assert.equal(plan.refused!.length, 1)
    assert.match(plan.refused![0].reason, /held|kernel/, p)
  }
  // The refusal does not depend on the package being pending: held always wins.
  const gpu = inv.nodes.find(n => n.node === 'gpu-node')!
  assert.match(nodePackageRefusal(policy, gpu, 'proxmox-default-kernel')!, /held/)
  // Linux images and versioned kernels on the guarded node, even ones not held by name.
  assert.match(nodePackageRefusal(policy, { ...gpu, pending: [...gpu.pending, KERNEL] }, KERNEL.name)!, /kernel/)
})

test('per-item selection on the guarded node never plans dist-upgrade or full-upgrade', async () => {
  const { inv, policy } = await inventory()
  // Kernel metapackages are pending there: the whole node is refused, the chosen packages run on their own.
  const plan = buildSelectedPlan(inv, policy, { ...ctx, selection: ['node:gpu-node', 'node:gpu-node:pkg:curl', 'node:gpu-node:pkg:pve-manager'] })
  const details = plan.steps.map(s => s.detail ?? '').join('\n')
  assert.doesNotMatch(details, /dist-upgrade|full-upgrade/)
  assert.deepEqual(plan.steps.map(s => `${s.target}:${s.action}`), ['gpu-node:node-packages'])
  assert.match(plan.refused!.find(r => r.id === 'node:gpu-node')!.reason, /kernel packages are pending/)
  // Without kernel packages pending, the whole node gets apt-get upgrade, though its policy names dist-upgrade.
  const gpu = inv.nodes.find(n => n.node === 'gpu-node')!
  const clean = { ...inv, nodes: inv.nodes.map(n => n === gpu ? { ...n, pending: n.pending.filter(p => !p.name.startsWith('proxmox-')) } : n) }
  const whole = buildSelectedPlan(clean, policy, { ...ctx, selection: ['node:gpu-node'] })
  assert.deepEqual(whole.steps.map(s => `${s.target}:${s.action}`), ['gpu-node:node-upgrade'])
  assert.match(whole.steps[0].detail!, /^apt-get upgrade/)
  // Packages alone: one chosen-packages step, upgrade-only.
  const pk = buildSelectedPlan(inv, policy, { ...ctx, selection: ['node:gpu-node:pkg:curl', 'node:gpu-node:pkg:pve-manager', 'node:gpu-node:pkg:proxmox-kernel-7.0'] })
  assert.deepEqual(pk.steps.map(s => s.action), ['node-packages'])
  assert.deepEqual(packagesOf(pk.steps[0].detail), ['curl', 'pve-manager'])
  assert.deepEqual(pk.refused!.map(r => r.id), ['node:gpu-node:pkg:proxmox-kernel-7.0'])
})

test('a node whose holds and pin could not be read is refused, package by package too', async () => {
  const fake = cluster()
  fake.inject = (where, cmd) => (where === 'gpu-node' && cmd.includes('HP_HOLDS_BEGIN') ? { code: 0, output: 'HP_FREE 9000', timedOut: false } : undefined)
  const { inv, policy } = await inventory(fake)
  assert.equal(inv.nodes.find(n => n.node === 'gpu-node')!.factsUnknown, true)
  const plan = buildSelectedPlan(inv, policy, { ...ctx, selection: ['node:gpu-node', 'node:gpu-node:pkg:curl'] })
  assert.equal(plan.steps.length, 0)
  assert.equal(plan.refused!.length, 2)
  for (const r of plan.refused!) assert.match(r.reason, /could not be read/)
  const t = buildTargets(inv, policy, ctx)
  assert.equal(t.find(x => x.id === 'node:gpu-node:pkg:curl')!.selectable, false)
})

test('a mixed selection runs guests before their node, nodes one at a time, a reboot only where chosen and after what it waits for', async () => {
  const { inv, policy } = await inventory()
  const plan = buildSelectedPlan(inv, policy, { ...ctx, selection: [
    'node:node-b:reboot', 'node:node-b', 'guest:102', 'node:node-a:pkg:curl', 'guest:205:compose:p1', 'guest:101:pkg:openssl',
  ] })
  assert.deepEqual(plan.refused, [])
  assert.deepEqual(plan.steps.map(s => `${s.target}:${s.action}`), [
    '101:snapshot', '101:apt-packages',
    '102:snapshot', '102:apt',
    '205:snapshot', '205:docker',
    'node-a:node-packages',
    'node-b:node-upgrade', 'node-b:kernel-cleanup', 'node-b:node-reboot',
  ])
  assert.equal(composeKeyOf(plan.steps[5].detail), 'p1')
  const reboot = plan.items!.find(i => i.id === 'node:node-b:reboot')!
  assert.deepEqual(reboot.dependsOn.sort(), ['guest:102', 'guest:205:compose:p1', 'node:node-b'])
  assert.match(plan.steps.at(-1)!.detail!, /\(forced\)$/)
  // Every step belongs to exactly one item.
  const seqs = plan.items!.flatMap(i => i.seqs).sort((a, b) => a - b)
  assert.deepEqual(seqs, plan.steps.map(s => s.seq))
})

test('a node upgrade never brings its reboot along, even where the policy reboots automatically', async () => {
  const { inv, policy } = await inventory()
  const plan = buildSelectedPlan(inv, policy, { ...ctx, selection: ['node:node-b'] })
  assert.equal(plan.steps.some(s => s.action === 'node-reboot'), false)
})

test('refusals per item: held in the guest, policy exclusion, ignore tag, offline node, Ceph pending without the Ceph item', async () => {
  const fake = cluster()
  fake.guests.find(g => g.vmid === 102)!.pending.push(pkg('libfoo', '2'))
  fake.nodes.find(n => n.name === 'node-a')!.pending.push(pkg('ceph-common', '19.2.7'))
  const { inv, policy } = await inventory(fake)
  inv.guests.find(g => g.vmid === 102)!.keptBack = ['libfoo']
  const plan = buildSelectedPlan(inv, policy, { ...ctx, selection: ['guest:102:pkg:libfoo', 'guest:110', 'guest:120', 'node:node-a', 'node:node-a:pkg:ceph-common'] })
  const why = Object.fromEntries(plan.refused!.map(r => [r.id, r.reason]))
  assert.match(why['guest:102:pkg:libfoo'], /held or kept back/)
  assert.match(why['guest:110'], /excluded/)
  assert.match(why['guest:120'], /hyperprox-ignore/)
  assert.match(why['node:node-a'], /choose Ceph too/)
  assert.match(why['node:node-a:pkg:ceph-common'], /Ceph/)
  assert.equal(plan.steps.length, 0)
})

test('Ceph is one item, first among the nodes; a node with Ceph pending can then be upgraded and waits for it', async () => {
  const fake = cluster()
  for (const n of fake.nodes) n.pending.push(pkg('ceph-common', '19.2.7'))
  const { inv, policy } = await inventory(fake)
  const plan = buildSelectedPlan(inv, policy, { ...ctx, selection: ['node:node-a', 'ceph'] })
  assert.deepEqual(plan.refused, [])
  const actions = plan.steps.map(s => `${s.target}:${s.action}`)
  assert.ok(actions.indexOf('node-a:ceph') < actions.indexOf('node-a:node-upgrade'))
  assert.deepEqual(plan.items!.find(i => i.id === 'node:node-a')!.dependsOn, ['ceph'])
})

test('HyperProx itself goes last, through the handoff; its own node reboot after it', async () => {
  const fake = cluster()
  fake.nodes.find(n => n.name === 'gpu-node')!.rebootRequired = true
  const { inv, policy } = await inventory(fake)
  const plan = buildSelectedPlan(inv, policy, { ...ctx, selection: ['guest:150', 'guest:101', 'node:gpu-node:reboot', 'node:node-a'] })
  const tail = plan.steps.slice(-2).map(s => `${s.target}:${s.action}`)
  // gpu-node is HyperProx's node in this inventory: its reboot is the self handoff, after the self guest.
  assert.deepEqual(tail, ['150:self', 'gpu-node:self'])
  assert.ok(plan.steps.findIndex(s => s.target === '150' && s.action === 'snapshot') < plan.steps.findIndex(s => s.target === 'node-a'))
})

test('"Update everything" chooses what the whole-plan run does: same steps as the old run, reboots where the policy reboots', async () => {
  const { inv, policy } = await inventory()
  const all = everythingSelection(buildTargets(inv, policy, ctx))
  assert.ok(all.includes('node:node-b:reboot'), 'node-b reboots automatically by policy')
  assert.ok(!all.includes('node:gpu-node:reboot'))
  const plan = buildSelectedPlan(inv, policy, { ...ctx, selection: all })
  const old = buildPlan(inv, policy, ctx)
  const key = (s: { target: string; action: string }) => `${s.target}:${s.action}`
  // The old run also listed a "manual — left pending" reboot that does nothing; a chosen run simply leaves it out.
  // Nor does it clean old kernels off a node that holds or pins its kernel (no new one is installed there).
  // And the guarded node, whose pending list includes kernel metapackages, is not offered as a whole (pick packages).
  const oldSteps = old.steps.filter(s => !(s.action === 'node-reboot' && /^manual/.test(s.detail ?? '')) && s.target !== 'gpu-node')
  assert.deepEqual(plan.steps.map(key).sort(), oldSteps.map(key).sort())
})

test('a remote guest that cannot be snapshotted needs its explicit approval, item by item', async () => {
  const { inv, policy } = await inventory()
  const g = inv.guests.find(x => x.vmid === 101)!
  g.snapshotCapable = false
  const without = buildSelectedPlan(inv, policy, { selection: ['guest:101'], remote: true })
  assert.match(without.refused![0].reason, /nosnap:101/)
  const withAck = buildSelectedPlan(inv, policy, { selection: ['guest:101'], remote: true, approvals: ['nosnap:101'] })
  assert.deepEqual(withAck.steps.map(s => s.action), ['snapshot', 'apt'])
  assert.deepEqual(withAck.approved, ['nosnap:101'])
})
