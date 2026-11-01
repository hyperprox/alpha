// Alerts: one message per change of verdict, saying which way it went; one daily reminder while anything is
// critical; and one notification event per check (the bus renders and delivers it, lib/notify).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alertChanges, certsEvent, type AlertState } from '../src/lib/certs/alerts'

const NOW = new Date('2026-10-26T06:15:00Z')
const H = 3_600_000
const s = (key: string, verdict: AlertState['verdict'], reason: string | null = null): AlertState => ({ key, verdict, reason })
const map = (...xs: AlertState[]) => new Map(xs.map(x => [x.key, x]))

test('changes either way are announced with their direction; unchanged verdicts are quiet', () => {
  const prev = map(s('a:443', 'ok'), s('b:443', 'critical', 'expired'), s('c:993', 'warn', 'old reason'), s('d:443', 'ok'))
  const r = alertChanges(prev, [
    s('a:443', 'critical', 'serves a self-signed certificate where a public one is expected'),
    s('b:443', 'ok'),
    s('c:993', 'warn', 'new reason'),
    s('d:443', 'ok'),
  ], NOW, new Date(NOW.getTime() - 2 * H))
  assert.deepEqual(r.messages, [
    'Worse: a:443: OK -> CRITICAL - serves a self-signed certificate where a public one is expected',
    'Better: b:443: CRITICAL -> OK',
  ])
  assert.equal(r.reminderSent, false)
  assert.equal(r.state.get('a:443')!.verdict, 'critical')
  assert.equal(r.state.size, 4)
})

test('first sight: only problems are announced; a key that disappears while bad is mentioned', () => {
  const r = alertChanges(map(s('gone:443', 'error', 'refused'), s('fine:443', 'ok')), [s('new:443', 'warn', 'staging'), s('quiet:443', 'ok')], NOW, NOW)
  assert.deepEqual(r.messages, ['New: new:443: WARN - staging', 'No longer checked: gone:443 (was ERROR)'])
  assert.deepEqual([...r.state.keys()], ['new:443', 'quiet:443'])
})

test('daily reminder: everything still critical, not what was just announced, at most once a day', () => {
  const prev = map(s('a', 'critical', 'expires in 3 days'), s('b', 'critical', 'name mismatch'), s('c', 'ok'))
  const next = [s('a', 'critical', 'expires in 2 days'), s('b', 'critical', 'name mismatch'), s('c', 'critical', 'expired')]

  const due = alertChanges(prev, next, NOW, new Date(NOW.getTime() - 24 * H))
  assert.deepEqual(due.messages, [
    'Worse: c: OK -> CRITICAL - expired',
    'Still critical (2):',
    '- a: CRITICAL - expires in 2 days',
    '- b: CRITICAL - name mismatch',
  ])
  assert.equal(due.reminderSent, true)

  // A check that runs a little early still counts as the next day; one a few hours later does not.
  assert.equal(alertChanges(prev, next, NOW, new Date(NOW.getTime() - 23 * H)).reminderSent, true)
  const soon = alertChanges(prev, next, NOW, new Date(NOW.getTime() - 3 * H))
  assert.equal(soon.reminderSent, false)
  assert.deepEqual(soon.messages, ['Worse: c: OK -> CRITICAL - expired'])
  assert.equal(alertChanges(prev, next, NOW, null).reminderSent, true)

  // Nothing critical, nothing to remind about.
  const calm = alertChanges(map(s('a', 'warn')), [s('a', 'warn')], NOW, null)
  assert.deepEqual([calm.messages, calm.reminderSent], [[], false])
})

test('severity: a change is as bad as its worse side; the daily reminder is critical', () => {
  assert.equal(alertChanges(map(s('a', 'ok')), [s('a', 'warn')], NOW, NOW).severity, 'warning')
  assert.equal(alertChanges(map(s('a', 'critical')), [s('a', 'ok')], NOW, NOW).severity, 'critical', 'better from critical')
  assert.equal(alertChanges(map(), [s('n', 'error', 'refused')], NOW, NOW).severity, 'critical')
  const only = alertChanges(map(s('c', 'critical')), [s('c', 'critical')], NOW, new Date(NOW.getTime() - 24 * H))
  assert.equal(only.severity, 'critical')
  assert.equal(only.reminderOnly, true)
})

test('one event per check: title from the change, the messages as lines, a link to the page', () => {
  const one = certsEvent(['Worse: mail.example.com:993: OK -> CRITICAL - expired'], 'critical', false)
  assert.equal(one.type, 'certs.verdict.changed')
  assert.equal(one.title, 'Certificate worse: mail.example.com:993')
  assert.equal(one.link, '/certificates')
  assert.deepEqual(one.lines, ['Worse: mail.example.com:993: OK -> CRITICAL - expired'])
  assert.equal(certsEvent(['New: a:443: WARN', 'Better: b:443: ERROR -> OK'], 'critical', false).title, '2 certificate changes')
  const rem = certsEvent(['Still critical (2):', '- a: CRITICAL', '- b: CRITICAL'], 'critical', true)
  assert.equal(rem.type, 'certs.still.critical')
  assert.equal(rem.title, '2 certificates are still critical')
})
