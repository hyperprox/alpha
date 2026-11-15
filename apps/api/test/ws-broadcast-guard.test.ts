// A tick that runs every two seconds must not pile up behind a slow Proxmox: a tick is skipped while the
// previous one is still running, and a failing tick never rejects.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { overlapGuard } from '../src/lib/ws-broadcast'

test('a tick is skipped while the previous one is still running', async () => {
  let started = 0
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const tick = overlapGuard(async () => { started++; await gate })
  const first = tick()
  await tick()
  await tick()
  assert.equal(started, 1)
  release()
  await first
  await tick()
  assert.equal(started, 2)
})

test('a failing tick is reported, frees the guard, and never rejects', async () => {
  const errors: string[] = []
  let calls = 0
  const tick = overlapGuard(async () => { calls++; throw new Error('proxmox down') }, e => errors.push((e as Error).message))
  await tick()
  await tick()
  assert.equal(calls, 2)
  assert.deepEqual(errors, ['proxmox down', 'proxmox down'])
})

test('a tick that never finishes is released by the watchdog, and its late result is ignored', async () => {
  let started = 0
  let stuck = 0
  const errors: string[] = []
  let releaseFirst!: () => void
  const first = new Promise<void>(r => { releaseFirst = r })
  const tick = overlapGuard(async () => { started++; if (started === 1) { await first; throw new Error('late') } }, e => errors.push((e as Error).message), { watchdogMs: 30, onStuck: () => { stuck++ } })
  const p1 = tick()
  await tick()
  assert.equal(started, 1)            // still inside the limit: skipped
  await new Promise(r => setTimeout(r, 50))
  await tick()                         // past the limit: released, a new tick runs
  assert.equal(started, 2)
  assert.equal(stuck, 1)
  releaseFirst()
  await p1
  assert.deepEqual(errors, [])         // the abandoned tick's failure is not reported
})
