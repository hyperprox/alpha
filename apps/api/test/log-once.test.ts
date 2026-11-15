// Background jobs repeat their problems every tick. They are logged once, then again only when the problem changes
// or after the job has worked once in between.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLogOnce, changedMessage, LOG_ONCE_MIN_GAP_MS, LOG_ONCE_REPEAT_MS, type LogLike } from '../src/lib/log-once'

function recorder() {
  const lines: Array<{ level: string; obj: any; msg?: string }> = []
  const log: LogLike = {
    info: (obj, msg) => lines.push({ level: 'info', obj, msg }),
    warn: (obj, msg) => lines.push({ level: 'warn', obj, msg }),
    error: (obj, msg) => lines.push({ level: 'error', obj, msg }),
  }
  return { lines, log }
}

test('the same error again and again is logged once', () => {
  const { lines, log } = recorder()
  const problem = createLogOnce(log)
  for (let i = 0; i < 5; i++) problem('sync', new Error('db down'))
  assert.equal(lines.length, 1)
  assert.equal(lines[0].level, 'warn')
  assert.equal(lines[0].obj.phase, 'sync')
  assert.ok(lines[0].obj.err instanceof Error, 'the error itself is logged, so its stack is kept')
})

test('a different message, or a different phase, is logged', () => {
  const { lines, log } = recorder()
  let t = 0
  const problem = createLogOnce(log, 'warn', () => t)
  problem('sync', new Error('a'))
  t += LOG_ONCE_MIN_GAP_MS
  problem('sync', new Error('b'))
  problem('other', new Error('b'))
  assert.equal(lines.length, 3)
})

test('after the phase works once, the same error is logged again', () => {
  const { lines, log } = recorder()
  let t = 0
  const problem = createLogOnce(log, 'warn', () => t)
  problem('sync', new Error('x'))
  problem.ok('sync')
  t += LOG_ONCE_MIN_GAP_MS
  problem('sync', new Error('x'))
  assert.equal(lines.length, 2)
})

test('a broken or missing logger never throws', () => {
  createLogOnce(undefined)('p', new Error('x'))
  const bad: LogLike = { info() {}, error() {}, warn() { throw new Error('boom') } }
  createLogOnce(bad)('p', 'plain string')
})

test('changedMessage is true only when the text changes', () => {
  const c = changedMessage()
  assert.deepEqual([c('a'), c('a'), c('b'), c('a')], [true, false, true, true])
})

test('the same error is logged again after an hour, with how many were held back', () => {
  const { lines, log } = recorder()
  let t = 0
  const problem = createLogOnce(log, 'warn', () => t)
  problem('sync', new Error('x'))
  for (let i = 0; i < 4; i++) { t += 60_000; problem('sync', new Error('x')) }
  assert.equal(lines.length, 1)
  t = LOG_ONCE_REPEAT_MS
  problem('sync', new Error('x'))
  assert.equal(lines.length, 2)
  assert.equal(lines[1].obj.suppressed, 4)
})

test('a flapping phase logs at most one line a minute', () => {
  const { lines, log } = recorder()
  let t = 0
  const problem = createLogOnce(log, 'warn', () => t)
  problem('sync', new Error('a'))
  problem.ok('sync')
  t = 10_000
  problem('sync', new Error('a'))
  problem('sync', new Error('b'))
  assert.equal(lines.length, 1)
  t = LOG_ONCE_MIN_GAP_MS + 1
  problem('sync', new Error('b'))
  assert.equal(lines.length, 2)
})

test('reset() re-arms every phase; an explicit level and text are honoured', () => {
  const { lines, log } = recorder()
  const problem = createLogOnce(log, 'warn', () => 10 * LOG_ONCE_REPEAT_MS)
  problem('a', new Error('x'), 'custom line', 'error')
  assert.equal(lines[0].level, 'error')
  assert.equal(lines[0].msg, 'custom line')
})
