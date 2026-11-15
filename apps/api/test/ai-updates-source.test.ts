// The assistant's "what updates does X have": answered from the Updates target tree as last read, admin only,
// without reading any machine and without offering to run anything.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readInventory } from '../src/lib/updates/inventory'
import { parsePolicy } from '../src/lib/updates/policy'
import { buildTargets } from '../src/lib/updates/targets'
import { updatesSource, machinesIn } from '../src/lib/ai/updates-source'
import { FakeCluster, node, guest, pkg } from './updates-fake'

async function tree() {
  const fake = new FakeCluster({
    nodes: [node('node-a', { rebootRequired: true }), node('gpu-node', { holds: ['proxmox-kernel-7.0'], pending: [pkg('curl', '8.1-2', '8.1-1'), pkg('proxmox-kernel-7.0', '7.0.2-1')] })],
    guests: [guest(101, 'node-a', { name: 'cloud', pending: [{ ...pkg('openssl', '3.0-2', '3.0-1'), security: true }] }), guest(102, 'gpu-node', { pending: [] })],
  })
  const policy = parsePolicy('nodes:\n  gpu-node: { require_holds: [proxmox-kernel-7.0] }\n')
  const inv = (await readInventory(fake, policy, { hostname: 'x' })).inventory
  return { fake, t: { refreshedAt: inv.refreshedAt, targets: buildTargets(inv, policy, {}) } }
}

test('by node name: its packages, what is held back, and its reboot', async () => {
  const { t } = await tree()
  const src = updatesSource({ role: 'admin', tree: () => t })
  const s = await src.load()
  const a = src.answer!('what updates does gpu-node have?', s)!
  assert.match(a, /Node gpu-node: 2 packages pending: curl 8\.1-1 → 8\.1-2/)
  assert.match(a, /not offered: proxmox-kernel-7\.0/)
  assert.match(a, /I cannot start one/)
  assert.match(src.answer!('does node-a need anything', s)!, /node-a: 1 package pending.*needs a reboot/)
})

test('by guest name or id, and security across the cluster', async () => {
  const { t } = await tree()
  const src = updatesSource({ role: 'admin', tree: () => t })
  const s = await src.load()
  assert.match(src.answer!('any updates for cloud?', s)!, /101 cloud: 1 package pending \(1 security\): openssl/)
  assert.match(src.answer!('updates on 101', s)!, /101 cloud/)
  assert.match(src.answer!('are there security updates?', s)!, /Security updates on: 101 cloud \(1\)/)
  assert.deepEqual(machinesIn('what about 102', t.targets).map(x => x.id), ['guest:102'])
  assert.match(s.headline, /2 nodes and 1 guest have updates, 1 with security updates/)
})

test('not an admin: nothing listed; nothing read yet: says how to read it', async () => {
  const { t } = await tree()
  assert.match((await updatesSource({ role: 'viewer', tree: () => t }).load()).lines[0], /limited to admins/)
  assert.match((await updatesSource({ role: 'admin', tree: () => null }).load()).lines[0], /Open the Updates page/)
})
