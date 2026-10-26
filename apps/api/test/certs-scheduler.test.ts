// The daily check's clock: fires on schedule.check, skips (and records it) while HyperProx is locked,
// never overlaps itself, and refuses a schedule it cannot read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CertsScheduler } from '../src/lib/certs/scheduler'

function setup(opts: { unlocked?: boolean; cron?: string } = {}) {
  const calls = { checks: 0, skips: [] as string[] }
  let release: () => void = () => undefined
  const clock = { t: new Date(2026, 9, 26, 6, 14, 0) }
  const state = { unlocked: opts.unlocked ?? true, cron: opts.cron ?? '15 6 * * *' }
  const s = new CertsScheduler({
    service: {
      dailyCheck: () => { calls.checks++; return new Promise<void>(r => { release = r }) },
      recordSkip: async (reason: string) => { calls.skips.push(reason) },
    },
    cron: () => state.cron,
    isUnlocked: () => state.unlocked,
    now: () => clock.t,
  })
  const advance = (min: number) => { clock.t = new Date(clock.t.getTime() + min * 60_000) }
  return { s, calls, clock, state, advance, release: () => release() }
}

test('idle before the time, started at it', async () => {
  const w = setup()
  assert.equal(await w.s.tick(), 'idle')
  w.advance(1)
  assert.equal(await w.s.tick(), 'started')
  assert.equal(w.calls.checks, 1)
  w.release()
  await w.s.idle()
})

test('locked at check time: skipped, recorded, and not caught up after unlocking', async () => {
  const w = setup({ unlocked: false })
  w.advance(1)
  assert.equal(await w.s.tick(), 'locked')
  assert.equal(w.calls.checks, 0)
  assert.deepEqual(w.calls.skips, ['HyperProx was locked'])
  w.state.unlocked = true
  w.advance(1)
  assert.equal(await w.s.tick(), 'idle')
  assert.equal(w.calls.checks, 0)
})

test('a check still running when the next one falls due is not doubled', async () => {
  const w = setup({ cron: '* * * * *' })
  w.advance(1)
  assert.equal(await w.s.tick(), 'started')
  w.advance(1)
  assert.equal(await w.s.tick(), 'busy')
  w.release()
  await w.s.idle()
  w.advance(1)
  assert.equal(await w.s.tick(), 'started')
  assert.equal(w.calls.checks, 2)
  w.release()
  await w.s.idle()
})

test('a schedule it cannot read is an error, not a guess', async () => {
  const w = setup({ cron: 'every morning' })
  w.advance(1)
  assert.equal(await w.s.tick(), 'error')
  assert.equal(w.calls.checks, 0)
})
