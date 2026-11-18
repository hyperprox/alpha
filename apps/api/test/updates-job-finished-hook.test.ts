// The runner tells the daily check when a job has ended, once, after its lock is released.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UpdatesRunner } from '../src/lib/updates/runner'
import { MemoryStore } from '../src/lib/updates/store'
import { FakeCluster, node, guest, policyLoad, FAST } from './updates-fake'

test('a finished job calls onJobFinished once, with the lock already released', async () => {
  const fake = new FakeCluster({ nodes: [node('node-a')], guests: [guest(101, 'node-a')] })
  const store = new MemoryStore()
  const seen: Array<unknown> = []
  const runner = new UpdatesRunner({
    store, exec: fake, loadPolicy: policyLoad('nodes:\n  default: { upgrade: upgrade }\n'), timing: FAST, hostname: 'not-a-guest',
    onJobFinished: () => { void store.activeJob().then(a => seen.push(a)) },
  })
  const job = await runner.start('run', 'schedule')
  await runner.idle(); await runner.idle()
  assert.ok(['done', 'failed', 'cancelled'].includes((await store.getJob(job.id))!.status))
  await new Promise(r => setTimeout(r, 20))
  assert.deepEqual(seen, [null])
})
