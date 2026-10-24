// Inventory: who is managed and why not, what is pending, holds and pin, HyperProx's own guest.
// Read-only by construction; the last test proves it ran nothing that changes a machine.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readInventory } from '../src/lib/updates/inventory'
import { parsePolicy } from '../src/lib/updates/policy'
import { FakeCluster, node, guest, pkg } from './updates-fake'

const policy = parsePolicy(`
nodes:
  gpu-node: { upgrade: upgrade, require_holds: [proxmox-default-kernel, proxmox-kernel-7.0], require_pin: 7.0.1-1-pve }
guests:
  exclude: [110]
  "205": { docker: manual, compose_dirs: [/opt/stack] }
`)

function fake() {
  return new FakeCluster({
    nodes: [
      node('gpu-node', { holds: ['proxmox-default-kernel'], pinned: '7.0.1-1-pve', pending: [pkg('ceph-common', '19.2.7-pve1'), pkg('proxmox-kernel-7.0.2-1-pve-signed', '7.0.2-1', null)] }),
      node('node-b', { rebootRequired: true }),
      node('node-c', { online: false }),
    ],
    guests: [
      guest(101, 'node-b', { config: { rootfs: 'fast:vm-101-disk-0', mp0: '/mnt/media,mp=/media' } }),
      guest(110, 'node-b'),
      guest(120, 'node-b', { running: false }),
      guest(130, 'node-b', { type: 'qemu', config: { ostype: 'win11', agent: '1' } }),
      guest(140, 'node-b', { type: 'qemu', config: { ostype: 'l26' } }),
      guest(150, 'node-b', { noApt: true, name: 'hyperprox-host' }),
      guest(160, 'node-c'),
      guest(205, 'node-b'),
      { ...guest(900, 'node-b'), template: true },
    ],
  })
}

test('nodes: pending, Ceph and kernel flags, reboot-required, holds and pin, offline', async () => {
  const { inventory } = await readInventory(fake(), policy, { hostname: 'hyperprox-host' })
  const gpu = inventory.nodes.find(n => n.node === 'gpu-node')!
  assert.equal(gpu.cephPending, true)
  assert.equal(gpu.kernelPending, true)
  assert.equal(gpu.holdsOk, false, 'one required hold is missing')
  assert.equal(gpu.pinOk, true)
  assert.deepEqual(gpu.policy, { upgrade: 'upgrade', reboot: 'manual', requireHolds: ['proxmox-default-kernel', 'proxmox-kernel-7.0'], requirePin: '7.0.1-1-pve' })
  const b = inventory.nodes.find(n => n.node === 'node-b')!
  assert.equal(b.rebootRequired, true)
  assert.equal(b.holdsOk, null)
  assert.equal(b.isSelf, true)
  const c = inventory.nodes.find(n => n.node === 'node-c')!
  assert.equal(c.online, false)
  assert.match(c.error!, /offline/)
})

test('guests: managed, and every unmanaged reason', async () => {
  const { inventory } = await readInventory(fake(), policy, { hostname: 'hyperprox-host' })
  const by = (id: number) => inventory.guests.find(g => g.vmid === id)!
  assert.equal(by(101).managed, true)
  assert.equal(by(101).snapshotCapable, false, 'bind mount')
  assert.deepEqual(by(101).pending, [{ name: 'openssl', from: '3.0-1', to: '3.0-2' }])
  assert.equal(by(110).unmanagedReason, 'excluded')
  assert.equal(by(120).unmanagedReason, 'not-running')
  assert.equal(by(130).unmanagedReason, 'windows')
  assert.equal(by(140).unmanagedReason, 'no-agent')
  assert.equal(by(150).unmanagedReason, 'no-apt')
  assert.equal(by(160).managed, false, 'its node is offline')
  assert.equal(by(205).docker, 'manual')
  assert.equal(inventory.guests.some(g => g.vmid === 900), false, 'templates are not guests')
})

test('inventory changes nothing', async () => {
  const f = fake()
  await readInventory(f, policy)
  const writes = /^POST apt\/update$|^guest:(apt|refresh|docker|check)$|^snapshot|apt-get|systemctl (reboot|restart)|noout|ha-manager|systemd-run/
  assert.deepEqual(f.calls.filter(c => writes.test(c.cmd)), [])
})

test('a guest that never answers is reported after the deadline instead of holding the whole read', async () => {
  const f = fake()
  const real = f.guestExec.bind(f)
  f.guestExec = ((g: any, ...rest: any[]) => g.vmid === 101 ? new Promise(() => {}) : real(g, ...rest)) as any
  const started = Date.now()
  const { inventory } = await readInventory(f, policy, { itemDeadlineMs: 200 })
  assert.ok(Date.now() - started < 5_000, 'the read finished')
  const stuck = inventory.guests.find(g => g.vmid === 101)!
  assert.equal(stuck.managed, false)
  assert.match(stuck.error!, /no answer within/)
  assert.ok(inventory.guests.some(g => g.vmid !== 101 && g.managed), 'the other guests were still read')
})
