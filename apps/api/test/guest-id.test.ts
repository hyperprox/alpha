// Guest identity spellings (lib/guest-id.ts) and the one guest listing (lib/pve/guests.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { machineId, sidOf, isSid, parseGuestPath } from '../src/lib/guest-id'
import { sidOf as haSidOf } from '../src/lib/ha/parse'
import { listGuests, guestListings } from '../src/lib/pve/guests'

test('machine id and service id spellings are unchanged', () => {
  assert.equal(machineId({ type: 'lxc', vmid: 101 }), 'lxc-101')
  assert.equal(machineId({ type: 'qemu', vmid: '7' }), 'qemu-7')
  assert.equal(sidOf('lxc', 101), 'ct:101')
  assert.equal(sidOf('qemu', '202'), 'vm:202')
  assert.equal(haSidOf('lxc', 5), 'ct:5')
})

test('a service id from a client: ct or vm, 1 to 9 digits', () => {
  for (const ok of ['ct:1', 'vm:123456789']) assert.equal(isSid(ok), true)
  for (const bad of ['ct:', 'ct:1234567890', 'lxc:1', 'ct:1\n', 'ct:1x', undefined, 5]) assert.equal(isSid(bad), false)
})

test('a guest path parameter', () => {
  assert.deepEqual(parseGuestPath('lxc', '101'), { type: 'lxc', vmid: 101 })
  assert.deepEqual(parseGuestPath('qemu', '000012'), { type: 'qemu', vmid: 12 })
  for (const [t, v] of [['ct', '1'], ['lxc', ''], ['lxc', '12a'], ['lxc', '1234567890'], ['node', '1'], ['lxc', '-1']]) assert.equal(parseGuestPath(t, v), null)
})

const ROWS = [
  { type: 'lxc', vmid: 101, node: 'n1', name: 'web', status: 'running', tags: 'A;hyperprox-ignore', cpu: 0.5, maxcpu: 2, mem: 10 },
  { type: 'qemu', vmid: 202, node: 'n2', status: 'stopped', template: 1 },
  { type: 'storage', id: 'x' },
  null,
]

test('listGuests: rows as {type, vmid, node, name, running, tags, template}, non-guests dropped', async () => {
  const pve = { fetchStrict: async (p: string) => { assert.equal(p, '/cluster/resources?type=vm'); return ROWS as any } }
  const g = await listGuests(pve as any)
  assert.deepEqual(g.map(({ raw, ...r }) => r), [
    { type: 'lxc', vmid: 101, node: 'n1', name: 'web', running: true, tags: ['a', 'hyperprox-ignore'], template: false },
    { type: 'qemu', vmid: 202, node: 'n2', name: '202', running: false, tags: [], template: true },
  ])
  assert.equal(g[0].raw.cpu, 0.5)
})

test('listGuests: strict throws on a failed read, non-strict follows getClusterResources', async () => {
  const bad = { fetchStrict: async () => { throw new Error('HTTP 500') }, getClusterResources: async () => undefined }
  await assert.rejects(listGuests(bad as any), /HTTP 500/)
  assert.deepEqual(await listGuests(bad as any, { strict: false }), [])
  const ok = { fetchStrict: async () => [], getClusterResources: async (t: string) => { assert.equal(t, 'vm'); return ROWS } }
  assert.equal((await listGuests(ok as any, { strict: false })).length, 2)
  assert.deepEqual(guestListings(null), [])
})
