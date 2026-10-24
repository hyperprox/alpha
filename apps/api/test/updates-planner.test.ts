// The planner on fixed inventories, plus the command builders and parsers it and the runner rely on.
// Fixture shapes follow what Proxmox returns; every name, address and id is generic.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { UpdatesInventory, UpdatesNode, UpdatesGuest } from '../src/lib/updates/types'
import { buildPlan, orderNodes } from '../src/lib/updates/planner'
import { parsePolicy, defaultPolicy, nodePolicyView } from '../src/lib/updates/policy'
import {
  parsePveAptList, parseGuestPending, parseNodeFacts, kernelsToRemove, nodeUpgradeCommand, isCephPackage, isKernelPackage,
  cephInstallCommand, kernelPurgeCommand,
} from '../src/lib/updates/commands'
import { lxcSnapshotCapable } from '../src/lib/updates/inventory'

const POLICY = parsePolicy(`
nodes:
  default: { upgrade: dist-upgrade, reboot: auto }
  node-a: { reboot: manual, order: last }
  node-c: { order: first }
  gpu-node: { upgrade: upgrade, reboot: manual, require_holds: [proxmox-default-kernel], require_pin: 7.0.1-1-pve }
guests:
  default: { reboot: if-required }
  exclude: [110]
  "205": { docker: auto, compose_dirs: [/opt/stack] }
  "301": { check: "http://127.0.0.1:8080/health" }
`)

function n(node: string, over: Partial<UpdatesNode> = {}): UpdatesNode {
  return {
    node, online: true, pending: [{ name: 'curl', from: '8.1-1', to: '8.1-2' }], cephPending: false, kernelPending: false,
    rebootRequired: false, rebootPending: false, policy: nodePolicyView(POLICY, node), holdsOk: null, pinOk: null, isSelf: false, ...over,
  }
}
function g(vmid: number, over: Partial<UpdatesGuest> = {}): UpdatesGuest {
  return {
    vmid, type: 'lxc', name: `guest-${vmid}`, node: 'node-b', running: true, managed: true,
    pending: [{ name: 'openssl', from: '3.0-1', to: '3.0-2' }], rebootRequired: false, haManaged: false,
    snapshotCapable: true, docker: 'none', ...over,
  }
}
const inv = (nodes: UpdatesNode[], guests: UpdatesGuest[]): UpdatesInventory => ({ refreshedAt: '2026-10-24T00:00:00Z', nodes, guests })
const steps = (p: ReturnType<typeof buildPlan>) => p.steps.map(s => `${s.target}:${s.action}`)

test('order: guests, then nodes one at a time (first, default, last), with exclusions and unmanaged left out', () => {
  const p = buildPlan(inv(
    [n('node-a'), n('node-b'), n('node-c')],
    [g(120), g(110, { managed: false, unmanagedReason: 'excluded' }), g(130, { managed: false, unmanagedReason: 'not-running', running: false }), g(101)],
  ), POLICY)
  assert.deepEqual(steps(p), [
    '101:snapshot', '101:apt', '120:snapshot', '120:apt',
    'node-c:node-upgrade', 'node-b:node-upgrade', 'node-a:node-upgrade',
  ])
  assert.deepEqual(p.steps.map(s => s.seq), p.steps.map((_, i) => i + 1))
})

test('guest steps: no snapshot possible is recorded, docker auto and checks follow apt, VM reboot only if policy allows', () => {
  const p = buildPlan(inv([], [
    g(205, { docker: 'auto', snapshotCapable: false }),
    g(301, { type: 'qemu' }),
    g(302, { pending: [] }),      // nothing pending, no docker: no steps
  ]), POLICY)
  assert.deepEqual(steps(p), ['205:snapshot', '205:apt', '205:docker', '301:snapshot', '301:apt', '301:check'])
  assert.match(p.steps[0].detail!, /^not possible/)
  assert.match(p.steps[4].detail!, /reboot if the guest asks/)
  const never = buildPlan(inv([], [g(301, { type: 'qemu' })]), defaultPolicy())
  assert.doesNotMatch(never.steps[1].detail!, /reboot/)
})

test('docker: manual reports newer images and pulls nothing', () => {
  const p = buildPlan(inv([], [g(225, { pending: [], docker: 'manual', dockerImages: [{ image: 'app:latest', current: 'sha256:a', latest: 'sha256:b' }] })]),
    parsePolicy('guests:\n  "225": { docker: manual }'))
  assert.equal(p.steps.length, 0)
  assert.ok(p.warnings.some(w => /new images available.*app:latest/.test(w)))
})

test('upgrade vs dist-upgrade comes from policy; a pinned node gets apt-get upgrade', () => {
  const p = buildPlan(inv([n('gpu-node', { holdsOk: true, pinOk: true }), n('node-b')], []), POLICY)
  assert.match(p.steps.find(s => s.target === 'gpu-node')!.detail!, /apt-get upgrade/)
  assert.match(p.steps.find(s => s.target === 'node-b')!.detail!, /apt-get dist-upgrade/)
  assert.equal(nodeUpgradeCommand('upgrade').includes('dist-upgrade'), false)
  assert.equal(nodeUpgradeCommand('upgrade').includes('full-upgrade'), false)
  assert.match(nodeUpgradeCommand('dist-upgrade'), /dist-upgrade$/)
})

test('missing holds or pin are warned about in the plan', () => {
  const p = buildPlan(inv([n('gpu-node', { holdsOk: false, pinOk: false })], []), POLICY)
  assert.ok(p.warnings.some(w => /gpu-node: required package holds are missing/.test(w)))
  assert.ok(p.warnings.some(w => /gpu-node: the required kernel pin/.test(w)))
})

test('reboot decisions: kernel pending + auto reboots, manual is left pending, nothing new means no reboot; cleanup follows a kernel', () => {
  const kernel = { name: 'proxmox-kernel-7.0.2-1-pve-signed', from: null, to: '7.0.2-1' }
  const p = buildPlan(inv([
    n('node-b', { pending: [kernel], kernelPending: true }),
    n('node-a', { pending: [kernel], kernelPending: true }),
    n('node-c'),
  ], []), POLICY)
  assert.deepEqual(steps(p), [
    'node-c:node-upgrade',
    'node-b:node-upgrade', 'node-b:node-reboot', 'node-b:kernel-cleanup',
    'node-a:node-upgrade', 'node-a:node-reboot', 'node-a:kernel-cleanup',
  ])
  assert.match(p.steps.find(s => s.target === 'node-b' && s.action === 'node-reboot')!.detail!, /^auto/)
  assert.match(p.steps.find(s => s.target === 'node-a' && s.action === 'node-reboot')!.detail!, /^manual/)
  // A reboot-required flag on its own also plans a reboot.
  assert.ok(steps(buildPlan(inv([n('node-b', { pending: [], rebootRequired: true })], []), POLICY)).includes('node-b:node-reboot'))
})

test('Ceph levelling: same version installed on every node that has it pending, then mon, mgr, osd restarts node by node', () => {
  const ceph = (v: string) => [{ name: 'ceph-osd', from: '19.2.6-pve4', to: v }, { name: 'librados2', from: '19.2.6-pve4', to: v }]
  const p = buildPlan(inv([
    n('node-b', { pending: ceph('19.2.7-pve1'), cephPending: true }),
    n('node-c', { pending: [...ceph('19.2.7-pve1'), { name: 'curl', from: '1', to: '2' }], cephPending: true }),
  ], []), POLICY)
  assert.deepEqual(steps(p), [
    'node-c:ceph', 'node-b:ceph',
    'node-c:ceph', 'node-b:ceph', 'node-c:ceph', 'node-b:ceph', 'node-c:ceph', 'node-b:ceph',
    'node-c:node-upgrade',
  ])
  assert.deepEqual(p.steps.filter(s => s.action === 'ceph').map(s => s.detail), [
    'install 19.2.7-pve1', 'install 19.2.7-pve1',
    'restart mon', 'restart mon', 'restart mgr', 'restart mgr', 'restart osd', 'restart osd',
  ])
})

test('Ceph versions that disagree: no Ceph or node phase, and the plan says why', () => {
  const p = buildPlan(inv([
    n('node-b', { pending: [{ name: 'ceph-osd', from: '1', to: '19.2.7-pve1' }], cephPending: true }),
    n('node-c', { pending: [{ name: 'ceph-osd', from: '1', to: '19.2.8-pve1' }], cephPending: true }),
  ], [g(101)]), POLICY)
  assert.deepEqual(steps(p), ['101:snapshot', '101:apt'])
  assert.ok(p.warnings.some(w => /Ceph candidate versions differ/.test(w)))
})

test("HyperProx itself goes last: its guest and its node's reboot through the handoff", () => {
  const kernel = { name: 'proxmox-kernel-7.0.2-1-pve-signed', from: null, to: '7.0.2-1' }
  const p = buildPlan(inv(
    [n('node-b', { isSelf: true, pending: [kernel], kernelPending: true }), n('node-c')],
    [g(150), g(160)],
  ), POLICY, { selfVmid: 150 })
  assert.deepEqual(steps(p), [
    '150:snapshot',                 // HyperProx's own guest: a rollback point before the handoff upgrades it
    '160:snapshot', '160:apt',
    'node-c:node-upgrade',
    'node-b:node-upgrade', 'node-b:kernel-cleanup',
    '150:self', 'node-b:self',
  ])
  assert.match(p.steps.at(-2)!.detail!, /^guest-apt/)
  assert.match(p.steps.at(-1)!.detail!, /^node-reboot/)
  assert.deepEqual(orderNodes([n('node-b', { isSelf: true }), n('node-a'), n('node-c')], POLICY).map(x => x.node), ['node-c', 'node-a', 'node-b'])
})

test('an offline node stops node planning; nothing pending says so', () => {
  const p = buildPlan(inv([n('node-b', { online: false, error: 'node is offline' }), n('node-c')], []), POLICY)
  assert.equal(p.steps.length, 0)
  assert.ok(p.warnings.some(w => /node-b is offline/.test(w)))
  assert.ok(buildPlan(inv([n('node-c', { pending: [] })], []), POLICY).warnings.some(w => /Nothing to do/.test(w)))
})

// --- Parsers and builders -----------------------------------------------------------------

test('Proxmox apt list (scrubbed fixture shape) parses to name/from/to', () => {
  const rows = [
    { Arch: 'amd64', OldVersion: '2:7.4-1', Origin: 'Debian', Package: 'cifs-utils', Priority: 'optional', Section: 'otherosfs', Title: 'x', Version: '2:7.4-1+deb13u2' },
    { Arch: 'all', OldVersion: '3.18-6', Origin: 'Proxmox', Package: 'pve-firmware', Version: '3.18-7' },
    { Arch: 'amd64', Package: 'proxmox-kernel-7.0.2-1-pve-signed', Version: '7.0.2-1' },
  ]
  assert.deepEqual(parsePveAptList(rows), [
    { name: 'cifs-utils', from: '2:7.4-1', to: '2:7.4-1+deb13u2' },
    { name: 'proxmox-kernel-7.0.2-1-pve-signed', from: null, to: '7.0.2-1' },
    { name: 'pve-firmware', from: '3.18-6', to: '3.18-7' },
  ])
  assert.deepEqual(parsePveAptList(null), [])
  assert.ok(isKernelPackage('proxmox-kernel-7.0.2-1-pve-signed') && isKernelPackage('proxmox-default-kernel') && !isKernelPackage('linux-libc-dev'))
  assert.ok(isCephPackage('ceph-osd') && isCephPackage('librados2') && isCephPackage('python3-rbd') && !isCephPackage('cephalopod-tools'))
})

test('guest apt list output parses; no apt and reboot-required are recognised', () => {
  const r = parseGuestPending('curl/stable-security 8.14.1-2+deb13u2 amd64 [upgradable from: 8.14.1-2+deb13u1]\nlibssl3t64/stable 3.5.4-1 amd64 [upgradable from: 3.5.1-1]\nHP_REBOOT_REQUIRED\n')
  assert.deepEqual(r.pending, [
    { name: 'curl', from: '8.14.1-2+deb13u1', to: '8.14.1-2+deb13u2' },
    { name: 'libssl3t64', from: '3.5.1-1', to: '3.5.4-1' },
  ])
  assert.equal(r.rebootRequired, true)
  assert.equal(parseGuestPending('HP_NO_APT').noApt, true)
})

test('node facts: free space, kernel, holds, pin on the line after its label, installed kernels', () => {
  const f = parseNodeFacts([
    'HP_FREE 5120', 'HP_KERNEL 7.0.1-1-pve', 'HP_REBOOT_REQUIRED',
    'HP_HOLDS_BEGIN', 'proxmox-default-kernel', 'proxmox-kernel-7.0', 'HP_HOLDS_END',
    'HP_PIN_BEGIN', 'Manually selected kernels:', 'None.', '', 'Automatically selected kernels:', '7.0.1-1-pve', '7.0.2-1-pve', '', 'Pinned kernel:', '7.0.1-1-pve', 'HP_PIN_END',
    'HP_KPKG_BEGIN', 'proxmox-kernel-7.0.1-1-pve-signed install ok installed', 'proxmox-kernel-7.0.2-1-pve-signed install ok installed',
    'proxmox-kernel-6.17.1-1-pve-signed deinstall ok config-files', 'proxmox-kernel-7.0 install ok installed', 'HP_KPKG_END',
  ].join('\n'))
  assert.equal(f.rootFreeMb, 5120)
  assert.equal(f.runningKernel, '7.0.1-1-pve')
  assert.equal(f.rebootRequired, true)
  assert.deepEqual(f.holds, ['proxmox-default-kernel', 'proxmox-kernel-7.0'])
  assert.equal(f.pinned, '7.0.1-1-pve')
  assert.deepEqual(f.kernelPackages, ['proxmox-kernel-7.0.1-1-pve-signed', 'proxmox-kernel-7.0.2-1-pve-signed'])
  assert.equal(parseNodeFacts('HP_PIN_BEGIN\nHP_PIN_END').pinned, null)
})

test('old kernels: keep running, pinned and one fallback; never guess when the running kernel is unknown', () => {
  const base = { rootFreeMb: 1, rebootRequired: false, holds: [] as string[], pinned: null as string | null }
  const pk = (v: string) => `proxmox-kernel-${v}-pve-signed`
  const all = ['6.17.1-1', '6.17.2-1', '7.0.1-1', '7.0.2-1'].map(pk)
  assert.deepEqual(kernelsToRemove({ ...base, runningKernel: '7.0.2-1-pve', kernelPackages: all }), [pk('6.17.1-1'), pk('6.17.2-1')])
  assert.deepEqual(kernelsToRemove({ ...base, runningKernel: '7.0.1-1-pve', pinned: '6.17.1-1-pve', kernelPackages: all }), [pk('6.17.2-1')])
  assert.deepEqual(kernelsToRemove({ ...base, runningKernel: null, kernelPackages: all }), [])
  assert.deepEqual(kernelsToRemove({ ...base, runningKernel: '7.0.2-1-pve', holds: [pk('6.17.1-1')], kernelPackages: all }), [pk('6.17.2-1')])
  assert.match(kernelPurgeCommand([pk('6.17.1-1')]), /apt-get -s purge/)
})

test('ceph install pins exact versions and refuses removals', () => {
  const c = cephInstallCommand([{ name: 'ceph-osd', to: '19.2.7-pve1' }])
  assert.match(c, /--no-remove --only-upgrade install 'ceph-osd=19\.2\.7-pve1'/)
})

test('bind mounts make a container unsnapshottable', () => {
  assert.equal(lxcSnapshotCapable({ rootfs: 'fast:vm-101-disk-0,size=8G', mp0: 'fast:vm-101-disk-1,mp=/data' }), true)
  assert.equal(lxcSnapshotCapable({ rootfs: 'fast:vm-101-disk-0,size=8G', mp0: '/mnt/media,mp=/media' }), false)
})
