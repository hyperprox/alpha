// Redaction across output chunks: a key split over two SSH data events is still removed, and NetBird
// setup keys have a shape of their own while one is live.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StreamRedactor, makeRedactor, NETBIRD_SETUP_KEY } from '../src/lib/remote/redact'

const KEY = 'tskey-auth-kAbCdEf1234CNTRL-abcdefghijklmnop'

test('a key split across chunks never appears in the output', () => {
  for (let cut = 1; cut < KEY.length; cut++) {
    const r = new StreamRedactor([KEY])
    const line = `before ${KEY} after\n`
    const at = 'before '.length + cut
    const out = r.push(line.slice(0, at)) + r.push(line.slice(at)) + r.flush()
    assert.equal(out, 'before [redacted] after\n', `cut at ${cut}`)
  }
})

test('a key-shaped string split one character at a time is still redacted', () => {
  const r = new StreamRedactor([])
  let out = ''
  for (const ch of `x tskey-api-SOMETHINGLONG123 y`) out += r.push(ch)
  out += r.flush()
  assert.equal(out, 'x [redacted] y')
})

test('ordinary output passes through whole and in order', () => {
  const r = new StreamRedactor([KEY])
  let out = ''
  const text = 'Reading package lists...\nSetting up tailscale (1.90.1) ...\n'
  for (let i = 0; i < text.length; i += 7) out += r.push(text.slice(i, i + 7))
  assert.equal(out + r.flush(), text)
})

test('NetBird setup keys are redacted by shape when asked, and only then', () => {
  const nb = 'A1B2C3D4-E5F6-4711-8899-AABBCCDDEEFF'
  assert.match(nb, NETBIRD_SETUP_KEY)
  assert.equal(makeRedactor([], { netbird: true })(`key ${nb}.`), 'key [redacted].')
  assert.equal(makeRedactor([])(`id ${nb}.`), `id ${nb}.`)
  const r = new StreamRedactor([], { netbird: true })
  assert.equal(r.push(`k=${nb.slice(0, 10)}`) + r.push(`${nb.slice(10)};`) + r.flush(), 'k=[redacted];')
})
