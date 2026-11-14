// Waiting for the Proxmox task an action started (lib/pve-task.ts): "done" only once the task has stopped OK.
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/*.test.tsx
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isUpid, upidNode, waitForTask, taskWords } from '../lib/pve-task'

const UPID = 'UPID:node-b:0012ABCD:01234567:6735A1B2:vzmigrate:105:root@pam:'
const noSleep = async () => {}

test('a migration is done only when its task stops, not after a fixed wait', async () => {
  const answers = [{ status: 'running' }, { status: 'running' }, null, { status: 'stopped', exitstatus: 'OK' }]
  let asked = 0
  const o = await waitForTask(async () => answers[asked++] ?? null, { sleep: noSleep })
  assert.equal(o.ok, true)
  assert.equal(asked, 4, 'kept asking through running and an unreadable answer')
  assert.equal(taskWords('Migration', null), 'Migration: running…')
  assert.equal(taskWords('Migration', o), 'Migration: done')
})

test('a failed task says why; one still running at the limit is not called done', async () => {
  const failed = await waitForTask(async () => ({ status: 'stopped', exitstatus: 'snapshot feature is not available' }), { sleep: noSleep })
  assert.equal(taskWords('Snapshot', failed), 'Snapshot failed: snapshot feature is not available')
  const slow = await waitForTask(async () => ({ status: 'running' }), { sleep: noSleep, intervalMs: 1, timeoutMs: 3 })
  assert.equal(slow.ok, false); assert.equal(slow.timedOut, true)
  assert.match(taskWords('Rollback', slow), /still running/)
})

test('a UPID is recognised and names its node', () => {
  assert.equal(isUpid(UPID), true)
  assert.equal(isUpid('done'), false)
  assert.equal(isUpid(null), false)
  assert.equal(upidNode(UPID), 'node-b')
})
