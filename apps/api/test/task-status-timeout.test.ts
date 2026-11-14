// Polling a long task: a Proxmox read that times out is "still running", not a 500.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { taskStatusOrRunning } from '../src/routes/infrastructure'

test('a timed-out task read is still running; a real error is still an error', async () => {
  assert.deepEqual(await taskStatusOrRunning(async () => ({ status: 'stopped', exitstatus: 'OK' })), { status: 'stopped', exitstatus: 'OK' })
  const t = await taskStatusOrRunning(async () => { throw new Error('Proxmox GET /nodes/n/tasks/x/status: no answer within 20s') })
  assert.equal(t.status, 'running')
  await assert.rejects(taskStatusOrRunning(async () => { throw new Error('HTTP 403 permission denied') }), /403/)
})
