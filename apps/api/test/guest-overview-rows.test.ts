// Infrastructure listed a migrating guest twice: /cluster/resources can name it on both nodes for a moment.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { oneRowPerGuest } from '../src/lib/guest-config/service'
import { badParam } from '../src/lib/route-params'

test('one row per guest: the running one wins over the side being left', () => {
  const rows = [
    { vmid: 105, type: 'lxc', node: 'node-a', status: 'stopped', lock: 'migrate' },
    { vmid: 106, type: 'qemu', node: 'node-a', status: 'running', lock: null },
    { vmid: 105, type: 'lxc', node: 'node-b', status: 'running', lock: null },
    { vmid: 105, type: 'qemu', node: 'node-c', status: 'stopped', lock: null },
  ]
  const out = oneRowPerGuest(rows)
  assert.equal(out.length, 3, 'a VM and a container may share an id; they are different guests')
  assert.equal(out.find(r => r.vmid === 105 && r.type === 'lxc')!.node, 'node-b')
  assert.deepEqual(out.map(r => `${r.type}:${r.vmid}`), ['lxc:105', 'qemu:106', 'qemu:105'], 'order kept')
})

test('a task id is checked before it is put in a Proxmox path', () => {
  assert.equal(badParam({ node: 'node-b', upid: 'UPID:node-b:0012ABCD:01234567:6735A1B2:vzmigrate:105:root@pam:' }), null)
  assert.equal(badParam({ upid: 'UPID:node-b:0012ABCD:01234567:6735A1B2:vzmigrate:105:root@pam:/../../x' }), 'upid')
  assert.equal(badParam({ upid: 'nope' }), 'upid')
})
