// Guest config editor: the plan for an edit, the change in words, and the protection of raw and unknown keys.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildEditPlan, buildRevertPlan, verifyOutcome, protect, type GuestCtx } from '../src/lib/guest-config/plan'
import { inventory, parseProps, buildProps } from '../src/lib/guest-config/keys'
import { FIX, smallCt } from './fakes/guest-pve'

const ctx = (config: any, over: Partial<GuestCtx> = {}): GuestCtx => ({ type: 'lxc', vmid: 901, node: 'node-a', name: 'web', running: false, config, pendingKeys: [], haManaged: false, ...over })

test('an edit writes only the keys it changes, says each change in words, and leaves raw and unknown keys alone', () => {
  const p = buildEditPlan(ctx(smallCt()), { cores: 2, memory: 1024, tags: ['test', 'web'], description: 'hello' })
  assert.deepEqual(p.errors, [])
  assert.equal(p.ops.length, 1)
  const op = p.ops[0] as any
  assert.deepEqual(Object.keys(op.set).sort(), ['cores', 'description', 'memory', 'tags'])
  assert.deepEqual(op.delete, [])
  assert.ok(!Object.keys(op.set).some(k => k === 'lxc' || k === 'timezone' || k === 'tty'))
  const words = p.changes.map(c => c.words)
  assert.ok(words.includes('CPU cores: 1 → 2'))
  assert.ok(words.includes('Memory: 512 MiB → 1024 MiB'))
  assert.ok(words.includes("Tags: add 'web'"))
})

test('the same value is not a change, and an unchanged form is nothing to write', () => {
  const p = buildEditPlan(ctx(smallCt()), { cores: 1, tags: ['test'] })
  assert.equal(p.ops.length, 0)
  assert.equal(p.changes.length, 0)
})

test('raw lines and keys the form does not model are inventoried read-only', () => {
  const nv = JSON.parse(FIX('ct-nvidia.json'))
  const inv = inventory('lxc', nv)
  assert.equal(inv.raw.length, 12)
  assert.ok(inv.raw.every(r => r.key.startsWith('lxc.')))
  assert.deepEqual(inv.unknown.map(u => u.key).sort(), ['arch', 'features', 'ostype', 'parent', 'unprivileged'])
  const vm = inventory('qemu', JSON.parse(FIX('vm-hostpci.json')))
  assert.deepEqual(vm.raw.map(r => r.key).sort(), ['args', 'hostpci0'])
})

test('a plan that would write a raw key is refused with the key named', () => {
  const p = buildEditPlan(ctx(smallCt()), { cores: 2 })
  p.touched.push('args')
  protect(p, 'edit', 'lxc')
  assert.ok(p.errors.some(e => /args/.test(e)))
  const q = buildEditPlan(ctx(smallCt()), { cores: 2 })
  q.touched.push('dev0')
  protect(q, 'edit', 'lxc')
  assert.ok(q.errors.some(e => /dev0/.test(e)), 'device keys go through the device editor only')
})

test('network: bridge, address, gateway, VLAN, firewall and rate, keeping hwaddr and every other property', () => {
  const p = buildEditPlan(ctx(smallCt()), { net: { net0: { bridge: 'vmbr1', ip: '192.0.2.20/24', gw: '192.0.2.254', tag: 20, firewall: true, rate: 50 } } })
  assert.deepEqual(p.errors, [])
  const v = (p.ops[0] as any).set.net0 as string
  const props = parseProps(v)
  assert.equal(props.pairs.find(x => x[0] === 'hwaddr')?.[1], 'BC:24:11:00:09:01')
  assert.equal(props.pairs.find(x => x[0] === 'type')?.[1], 'veth')
  for (const [k, want] of [['bridge', 'vmbr1'], ['ip', '192.0.2.20/24'], ['gw', '192.0.2.254'], ['tag', '20'], ['firewall', '1'], ['rate', '50']]) assert.equal(props.pairs.find(x => x[0] === k)?.[1], want, k)
  assert.match(p.changes[0].words, /bridge vmbr0 → vmbr1/)
  assert.match(p.changes[0].words, /VLAN none → 20/)
  const dhcp = buildEditPlan(ctx(smallCt()), { net: { net0: { ip: 'dhcp' } } })
  assert.ok(!/gw=/.test((dhcp.ops[0] as any).set.net0), 'DHCP drops the static gateway')
})

test('bad input is refused before anything is planned', () => {
  const p = buildEditPlan(ctx(smallCt()), { cores: 0, memory: 1.5 as any, tags: ['ok', 'no spaces'], nameserver: 'one.one', startup: 'first', net: { net0: { ip: '10.0.0.1' } } })
  assert.ok(p.errors.length >= 6, p.errors.join('\n'))
})

test('a running guest: live keys say live, device and mount keys say after a restart', () => {
  const p = buildEditPlan(ctx(smallCt(), { running: true }), { cores: 2, mounts: { add: [{ kind: 'volume', storage: 'fast-ssd', sizeGb: 2, mp: '/data' }] } })
  assert.equal(p.changes.find(c => c.key === 'cores')?.restart, 'live')
  assert.notEqual(p.changes.find(c => c.key === 'mp0')?.restart, 'live')
  const vm = buildEditPlan(ctx(JSON.parse(FIX('vm-hostpci.json')), { type: 'qemu', running: true }), { cores: 6, sockets: 1, balloon: 2048 })
  assert.equal(vm.changes.find(c => c.key === 'cores')?.restart, 'restart')
  assert.equal(vm.changes.find(c => c.key === 'balloon')?.restart, 'live')
})

test('mount points: a volume is added at the next free slot, a removal keeps the volume, a resize only grows', () => {
  const c = ctx(smallCt({ mp0: 'fast-ssd:vm-901-disk-1,mp=/old,size=8G' }))
  const p = buildEditPlan(c, { mounts: { add: [{ kind: 'volume', storage: 'fast-ssd', sizeGb: 2, mp: '/data' }], remove: ['mp0'], resize: [{ key: 'rootfs', sizeGb: 6 }] } })
  assert.deepEqual(p.errors, [])
  assert.equal((p.ops[0] as any).set.mp1, 'fast-ssd:2,mp=/data')
  assert.deepEqual((p.ops[0] as any).delete, ['mp0'])
  assert.deepEqual(p.ops[1], { kind: 'resize', disk: 'rootfs', size: '6G' })
  assert.ok(p.warnings.some(w => /kept as an unused disk/.test(w)))
  const shrink = buildEditPlan(c, { mounts: { resize: [{ key: 'mp0', sizeGb: 4 }] } })
  assert.ok(shrink.errors.some(e => /only grows/.test(e)))
})

test('shared=1 is refused unless the path was verified on every node, and the missing nodes are named', () => {
  const add = { mounts: { add: [{ kind: 'bind' as const, source: '/mnt/media', mp: '/media', shared: true }] } }
  assert.ok(buildEditPlan(ctx(smallCt()), add).errors.some(e => /has not been checked/.test(e)))
  const missing = buildEditPlan(ctx(smallCt()), add, { '/mnt/media': { path: '/mnt/media', ok: false, missing: ['node-c'], unverified: [], detail: [] } })
  assert.ok(missing.errors.some(e => /missing on node-c/.test(e)))
  const offline = buildEditPlan(ctx(smallCt()), add, { '/mnt/media': { path: '/mnt/media', ok: false, missing: [], unverified: ['node-b (offline: cannot verify on node-b)'], detail: [] } })
  assert.ok(offline.errors.some(e => /cannot verify/.test(e)))
  const ok = buildEditPlan(ctx(smallCt()), add, { '/mnt/media': { path: '/mnt/media', ok: true, missing: [], unverified: [], detail: ['node-a: ceph', 'node-b: ceph', 'node-c: ceph'] } })
  assert.deepEqual(ok.errors, [])
  assert.match((ok.ops[0] as any).set.mp0, /^\/mnt\/media,mp=\/media,shared=1$/)
})

test('verifyOutcome: a task that said OK while nothing changed is a failure', () => {
  const before = smallCt()
  const p = buildEditPlan(ctx(before), { cores: 4 })
  const o = verifyOutcome('lxc', before, before, [], p)
  assert.equal(o.ok, false)
  assert.ok(o.problems.some(x => /cores/.test(x)))
})

test('verifyOutcome: a lost raw line or a changed unmodelled key fails the write, even when every planned key landed', () => {
  const before = smallCt()
  const p = buildEditPlan(ctx(before), { cores: 4 })
  const after = { ...before, cores: 4, lxc: [] }
  const o = verifyOutcome('lxc', before, after, [], p)
  assert.equal(o.ok, false)
  assert.equal(o.rawBefore, 1); assert.equal(o.rawAfter, 0)
  const tz = verifyOutcome('lxc', before, { ...before, cores: 4, timezone: 'UTC' }, [], p)
  assert.ok(tz.problems.some(x => /timezone changed/.test(x)))
  const good = verifyOutcome('lxc', before, { ...before, cores: 4 }, [], p)
  assert.equal(good.ok, true, good.problems.join('\n'))
})

test('verifyOutcome: Proxmox naming a new volume and a NIC gaining a MAC still count as landed', () => {
  const before = smallCt()
  const p = buildEditPlan(ctx(before), { mounts: { add: [{ kind: 'volume', storage: 'fast-ssd', sizeGb: 2, mp: '/data' }] }, net: { net1: { bridge: 'vmbr0', ip: 'dhcp' } } })
  const after = { ...before, mp0: 'fast-ssd:vm-901-disk-3,mp=/data,size=2G', net1: 'name=eth1,bridge=vmbr0,ip=dhcp,hwaddr=BC:24:11:00:00:02,type=veth' }
  const o = verifyOutcome('lxc', before, after, [], p)
  assert.equal(o.ok, true, o.problems.join('\n'))
  const wrong = verifyOutcome('lxc', before, { ...after, mp0: 'other:vm-901-disk-3,mp=/data,size=2G' }, [], p)
  assert.equal(wrong.ok, false)
})

test('a round trip through the props parser never loses or reorders a property', () => {
  for (const s of ['name=eth0,bridge=vmbr0,gw=192.0.2.1,hwaddr=BC:24:11:00:09:01,ip=192.0.2.11/24,type=veth', 'fast-ssd:vm-1-disk-0,mp=/x,backup=1,size=8G', 'virtio=BC:24:11:C6:BA:7B,bridge=vmbr0,firewall=1', '0000:42:00,pcie=1,x-vga=1', '/dev/dri/renderD128,gid=993'])
    assert.equal(buildProps(parseProps(s)), s)
})

test('revert: writes the editable keys back, never raw keys or disk sizes, and re-mounts a volume still kept as unused', () => {
  const target = smallCt({ cores: 2, mp0: 'fast-ssd:vm-901-disk-1,mp=/data,size=2G', lxc: [['lxc.cgroup2.devices.allow', 'c 10:200 rwm'], ['lxc.mount.entry', '/x x none bind']] })
  const now = smallCt({ cores: 4, memory: 2048, rootfs: 'fast-ssd:vm-901-disk-0,size=8G', unused0: 'fast-ssd:vm-901-disk-1' })
  const p = buildRevertPlan(ctx(now), target)
  assert.deepEqual(p.errors, [])
  const op = p.ops[0] as any
  assert.equal(op.set.cores, '2')
  assert.equal(op.set.memory, '512')
  assert.equal(op.set.mp0, 'fast-ssd:vm-901-disk-1,mp=/data,size=2G')
  assert.ok(!('lxc' in op.set) && !('rootfs' in op.set))
  assert.ok(!op.delete.includes('unused0'), 'deleting an unused key would destroy the volume')
  assert.ok(p.warnings.some(w => /lxc \(raw/.test(w) && /rootfs/.test(w)))
})
