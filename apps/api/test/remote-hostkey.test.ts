// The host-key rule for remote access: a pinned key must match; an unpinned host is refused when the caller
// requires a pin, and the refusal names the fingerprint the admin should check.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hostKeyDecision, HostKeyNotPinnedError } from '../src/lib/node-exec'

test('a pinned key must match, whatever the caller asked', () => {
  assert.equal(hostKeyDecision('SHA256:aaa', 'SHA256:aaa', false), 'accept')
  assert.equal(hostKeyDecision('SHA256:aaa', 'SHA256:bbb', false), 'reject-changed')
  assert.equal(hostKeyDecision('SHA256:aaa', 'SHA256:bbb', true), 'reject-changed')
})

test('an unpinned host fails closed when a pin is required, and is accepted only where it always was', () => {
  assert.equal(hostKeyDecision(null, 'SHA256:aaa', true), 'reject-unpinned')
  assert.equal(hostKeyDecision(undefined, 'SHA256:aaa', true), 'reject-unpinned')
  assert.equal(hostKeyDecision(null, 'SHA256:aaa', false), 'accept')
})

test('the refusal shows the fingerprint and says how to pin it', () => {
  const e = new HostKeyNotPinnedError('192.0.2.102', 2222, 'SHA256:abcDEF')
  assert.match(e.message, /192\.0\.2\.102:2222/)
  assert.match(e.message, /SHA256:abcDEF/)
  assert.match(e.message, /Terminal/)
})

test('probeHostKey reads the key a real SSH server presents, without logging in', async () => {
  const mod: any = await import('ssh2')
  const { Server, utils } = mod.default ?? mod
  const { fingerprintOf } = await import('../src/lib/ssh-broker')
  const { probeHostKey } = await import('../src/lib/node-exec')
  const kp = utils.generateKeyPairSync('ed25519')
  let authTried = false
  const server = new Server({ hostKeys: [kp.private] }, client => {
    client.on('authentication', ctx => { authTried = true; ctx.reject() })
    client.on('error', () => undefined)
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  try {
    const port = (server.address() as any).port
    const fp = await probeHostKey('127.0.0.1', port)
    const pub = utils.parseKey(kp.public) as any
    assert.equal(fp, fingerprintOf(pub.getPublicSSH()))
    assert.equal(authTried, false, 'no login was attempted')
  } finally { server.close() }
})
