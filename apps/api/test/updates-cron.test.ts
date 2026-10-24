// The schedule parser. A misread cron upgrades hosts at an hour nobody chose, so anything it does not
// understand must be refused rather than approximated.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCron, nextRun, cronMatches } from '../src/lib/updates/cron'
import { dueMinutes } from '../src/lib/updates/scheduler'

const at = (s: string) => new Date(s)   // local time, as the scheduler uses

test('fields: star, list, range, step, range with step, 7 is Sunday', () => {
  const c = parseCron('*/15 8-10 1,15 * 1-5/2')
  assert.deepEqual([...c.minute].sort((a, b) => a - b), [0, 15, 30, 45])
  assert.deepEqual([...c.hour].sort((a, b) => a - b), [8, 9, 10])
  assert.deepEqual([...c.dom].sort((a, b) => a - b), [1, 15])
  assert.equal(c.month.size, 12)
  assert.deepEqual([...c.dow].sort((a, b) => a - b), [1, 3, 5])
  assert.deepEqual([...parseCron('0 0 * * 7').dow], [0])
  assert.deepEqual([...parseCron('5/20 * * * *').minute].sort((a, b) => a - b), [5, 25, 45])
})

test('refuses what it does not understand', () => {
  for (const bad of ['', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8',
    '*/0 * * * *', '5-1 * * * *', 'a * * * *', '0 8 * * WED', '1,,2 * * * *', '1-2-3 * * * *', '0 8 ? * *', '*/5/2 * * * *']) {
    assert.throws(() => parseCron(bad), /cron/, bad)
  }
})

test('nextRun: the weekly Wednesday 08:00 example', () => {
  const n = nextRun('0 8 * * 3', at('2026-10-24T12:00:00'))!   // a Saturday
  assert.equal(n.getDay(), 3)
  assert.equal(n.getHours(), 8)
  assert.equal(n.getMinutes(), 0)
  assert.equal(n.getDate(), 28)
})

test('nextRun is strictly after the given time', () => {
  const n = nextRun('0 8 * * 3', at('2026-10-28T08:00:00'))!
  assert.equal(n.getDate(), 4)   // the following Wednesday, 4 November
  assert.equal(n.getMonth(), 10)
})

test('nextRun: every 5 minutes, month boundary, impossible date', () => {
  assert.equal(nextRun('*/5 * * * *', at('2026-10-24T12:03:30'))!.getMinutes(), 5)
  const n = nextRun('30 2 1 * *', at('2026-10-24T00:00:00'))!
  assert.equal(n.getMonth(), 10); assert.equal(n.getDate(), 1); assert.equal(n.getHours(), 2)
  assert.equal(nextRun('0 0 31 2 *', at('2026-01-01T00:00:00')), null)
})

test('day-of-month and day-of-week both restricted: either matches (standard cron)', () => {
  const c = parseCron('0 0 13 * 5')
  assert.equal(cronMatches(c, at('2026-11-13T00:00:00')), true)   // a Friday the 13th
  assert.equal(cronMatches(c, at('2026-11-06T00:00:00')), true)   // a Friday
  assert.equal(cronMatches(c, at('2026-10-13T00:00:00')), true)   // a 13th
  assert.equal(cronMatches(c, at('2026-10-14T00:00:00')), false)
})

test('scheduler: due minutes between ticks, and no burst after a long stall', () => {
  assert.equal(dueMinutes('0 8 * * 3', at('2026-10-28T07:59:40'), at('2026-10-28T08:00:10')).length, 1)
  assert.equal(dueMinutes('0 8 * * 3', at('2026-10-28T08:00:10'), at('2026-10-28T08:00:40')).length, 0)
  assert.equal(dueMinutes('* * * * *', at('2026-10-01T00:00:00'), at('2026-10-28T08:00:00')).length <= 61, true)
})
