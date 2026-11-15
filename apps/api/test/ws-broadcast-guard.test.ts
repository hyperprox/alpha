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
