// Alerts: one message per change of verdict, saying which way it went; one daily reminder while anything is
// critical; a webhook body Discord accepts, cut on whole lines with a count of what was left out.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { alertChanges, sendWebhook, webhookBody, DISCORD_LIMIT, type AlertState } from '../src/lib/certs/alerts'

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

test('webhook body: under the limit, whole lines, a count of what was dropped, no mentions', () => {
  const small = webhookBody(['one', 'two'])
  assert.equal(small.content, 'HyperProx certificates\none\ntwo')
  assert.deepEqual(small.allowed_mentions, { parse: [] })

  const many = Array.from({ length: 100 }, (_, i) => `line ${i}: ${'x'.repeat(40)}`)
  const big = webhookBody(many)
  assert.ok(big.content.length <= DISCORD_LIMIT, String(big.content.length))
  const shown = big.content.split('\n').filter(l => l.startsWith('line ')).length
  assert.ok(shown > 10 && shown < 100)
  assert.match(big.content, new RegExp(`\\.\\.\\.and ${100 - shown} more line\\(s\\); see the Certificates page$`))

  const huge = webhookBody(['y'.repeat(5000)])
  assert.ok(huge.content.length <= DISCORD_LIMIT)
  assert.match(huge.content, /and 1 more line/)
})

test('sendWebhook posts JSON, skips empty batches, and reports a refusal', async () => {
  const got: Array<{ body: any; type: string | undefined }> = []
  let status = 204
  const server = http.createServer((req, res) => {
    let b = ''
    req.on('data', c => { b += c })
    req.on('end', () => { got.push({ body: JSON.parse(b), type: req.headers['content-type'] }); res.statusCode = status; res.end(status >= 400 ? 'bad embed' : '') })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const url = `http://127.0.0.1:${(server.address() as any).port}/hook`
  try {
    await sendWebhook(url, [])
    assert.equal(got.length, 0)
    await sendWebhook(url, ['Worse: a: OK -> CRITICAL'])
    assert.equal(got[0].type, 'application/json')
    assert.equal(got[0].body.content, 'HyperProx certificates\nWorse: a: OK -> CRITICAL')
    status = 400
    await assert.rejects(sendWebhook(url, ['x']), /answered 400: bad embed/)
  } finally {
    server.close()
  }
})
