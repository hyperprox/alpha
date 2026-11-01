// Messages a person can take in from a lock screen: short title, two or three lines, a link, no secrets.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toMessage, scrub, groupMessage, digestMessage, brakeMessage, testMessage, fitLines } from '../src/lib/notify/render'

const PUBLIC = 'https://hyperprox.example.com'

test('title at most 60 characters, and it stands alone', () => {
  const m = toMessage({ type: 'updates.job.finished', severity: 'info', title: 'Disk almost full on the node '.repeat(8) }, { publicUrl: PUBLIC })
  assert.ok(m.title.length <= 60, String(m.title.length))
  assert.match(m.title, /\.\.\.$/)
})

test('two or three lines, each under 100 characters, body under 400', () => {
  const m = toMessage({ type: 'certs.verdict.changed', severity: 'warning', title: 'Certificate changes', where: 'Certificates page',
    lines: ['a long line '.repeat(30), 'another long line '.repeat(20), 'c', 'd', 'e'], link: '/certificates' }, { publicUrl: PUBLIC })
  assert.equal(m.lines.length, 3)
  for (const l of m.lines) assert.ok(l.length < 100, String(l.length))
  assert.match(m.lines[2], /and 3 more/)
  assert.equal(m.link, `${PUBLIC}/certificates`)
  assert.ok((m.lines.join('\n') + m.link).length < 400)
})

test('no public URL: no link, and the message says where to look', () => {
  const m = toMessage({ type: 'updates.job.finished', severity: 'info', title: 'Updates finished', link: '/updates', where: 'Updates page' }, {})
  assert.equal(m.link, null)
  assert.equal(m.hint, 'Open the Updates page in HyperProx.')
})

test('URLs and tokens are scrubbed from titles and lines', () => {
  const s = scrub('failed: https://hooks.example.com/abc?token=1 with Bearer abcdefgh and key=supersecretvalue and ' + 'Z'.repeat(40))
  assert.equal(s.includes('hooks.example.com'), false)
  assert.equal(s.includes('abcdefgh'), false)
  assert.equal(s.includes('supersecretvalue'), false)
  assert.equal(s.includes('Z'.repeat(40)), false)
  assert.equal(scrub('pool 82% full on node-a'), 'pool 82% full on node-a')
  assert.equal(scrub('the token is hunter2', ['hunter2']).includes('hunter2'), false)
  const m = toMessage({ type: 'x', severity: 'info', title: 'Sent to https://evil.example.com/x', lines: ['tok_' + 'q'.repeat(40)] }, {})
  assert.doesNotMatch(m.title + m.lines.join(''), /evil|qqqq/)
})

test('grouped message: count title, at most five lines', () => {
  const ms = Array.from({ length: 8 }, (_, i) => toMessage({ type: 'certs.verdict.changed', severity: i === 3 ? 'critical' : 'warning', title: `Problem ${i}` }, {}))
  const g = groupMessage(ms, { publicUrl: PUBLIC })
  assert.equal(g.title, '8 new alerts')
  assert.equal(g.severity, 'critical')
  assert.ok(g.lines.length <= 5)
  assert.match(g.lines.at(-1)!, /and 4 more/)
})

test('digest: at most ten lines, critical first', () => {
  const ms = Array.from({ length: 14 }, (_, i) => toMessage({ type: 't', severity: i === 13 ? 'critical' : 'warning', title: `T${i}` }, {}))
  const d = digestMessage(ms, 'quiet', { publicUrl: PUBLIC })
  assert.match(d.title, /14 alerts held during quiet hours/)
  assert.ok(d.lines.length <= 10)
  assert.match(d.lines[0], /T13/)
  assert.match(digestMessage(ms, 'locked', {}).title, /while HyperProx was locked/)
})

test('brake and test messages', () => {
  assert.match(brakeMessage({}).title, /Many alerts at once/)
  const t = testMessage('Phone', { publicUrl: PUBLIC })
  assert.equal(t.title, 'HyperProx test')
  assert.deepEqual(t.lines, ['If you can read this, alerts to Phone work.'])
  assert.equal(t.link, PUBLIC)
})

test('fitLines cuts whole lines with "and N more"', () => {
  const r = fitLines(['aaaa', 'bbbb', 'cccc', 'dddd'], 20)
  assert.ok(r.join('\n').length <= 20)
  assert.match(r.at(-1)!, /more/)
  assert.deepEqual(fitLines(['a', 'b'], 100), ['a', 'b'])
})
