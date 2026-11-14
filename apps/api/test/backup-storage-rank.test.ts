// The backup dialog used to pre-select a single-copy CephFS media pool because it had the most free space.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sortBackupStorages, backupStorageRank } from '../src/lib/clusters/guest-actions'

test('backup storage: PBS first, then a directory or share, CephFS last and never preferred', () => {
  const out = sortBackupStorages([
    { storage: 'media', type: 'cephfs', availBytes: 40e12 },
    { storage: 'nas', type: 'cifs', availBytes: 5e12 },
    { storage: 'local', type: 'dir', availBytes: 2e11 },
    { storage: 'pbs', type: 'pbs', availBytes: 1e12 },
  ])
  assert.deepEqual(out.map(s => s.storage), ['pbs', 'nas', 'local', 'media'])
  assert.equal(out.at(-1)!.preferred, false)
  assert.match(out.at(-1)!.note!, /single copy/)
  assert.ok(out.slice(0, 3).every(s => s.preferred))
  assert.ok(backupStorageRank('cephfs') > backupStorageRank('rbd'))
})
