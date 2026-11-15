// A vault that is down is not a wrong 2FA code: sign-in says the vault is not running (503 vault_unreachable),
// and it never counts towards the per-account limit. Sign-in fields are capped.
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { FakeBroker } from './fakes/fake-broker'
import { buildTestApp, resetLock } from './fakes/app'
import { VaultAuthError, CliVaultBroker, authCodeFromMessage, isVaultConnectionError } from '../src/lib/vault/broker'
import { signInLimiter } from '../src/lib/auth-limits'
import { VAULT_UNREACHABLE, authInputProblem } from '../src/routes/auth'

const EMAIL = 'owner@example.com'
const PW = 'correct horse battery staple'

class DownBroker extends FakeBroker {
  async signIn(email: string, pw: string, totp: string) {
    this.calls.push({ fn: 'signIn', args: [email] })
    throw new VaultAuthError('vault_unreachable', 'connect ECONNREFUSED 127.0.0.1:8222')
  }
}
const broker = new DownBroker()
broker.addUser(EMAIL, PW, 'owner')
const appP = buildTestApp(broker)

beforeEach(async () => { await resetLock(); signInLimiter.reset(); broker.reachable = true })
after(async () => { await resetLock(); await (await appP).close() })

const signIn = async (body: Record<string, unknown>) => (await appP).inject({ method: 'POST', url: '/api/auth/sign-in', payload: body, remoteAddress: `192.0.2.${Math.floor(Math.random() * 200) + 1}` })

test('mapping: connection errors are vault_unreachable, never totp_invalid', () => {
  assert.equal(authCodeFromMessage('request to https://127.0.0.1:8222/identity/connect/token failed, reason: connect ECONNREFUSED 127.0.0.1:8222'), 'vault_unreachable')
  assert.equal(authCodeFromMessage('socket hang up'), 'vault_unreachable')
  assert.equal(authCodeFromMessage('getaddrinfo ENOTFOUND vault'), 'vault_unreachable')
  assert.equal(authCodeFromMessage('Invalid TOTP code! Server time: ...'), 'totp_invalid')
  const fetchErr = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }) })
  assert.equal(isVaultConnectionError(fetchErr), true)
  assert.equal(isVaultConnectionError(new Error('Username or password is incorrect')), false)
})

test('the real broker against a vault that is not running: vault_unreachable', async () => {
  const srv = net.createServer()
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()))
  const port = (srv.address() as net.AddressInfo).port
  await new Promise<void>(r => srv.close(() => r()))   // a port nothing listens on
  const saved = process.env.VAULT_URL
  process.env.VAULT_URL = `http://127.0.0.1:${port}`
  try {
    await assert.rejects(new CliVaultBroker().signIn(EMAIL, PW, '123456'), (e: any) => e instanceof VaultAuthError && e.code === 'vault_unreachable')
  } finally {
    if (saved === undefined) delete process.env.VAULT_URL; else process.env.VAULT_URL = saved
  }
})

test('sign-in while the vault is down: 503 in words, and never counted towards the limit', async () => {
  for (let i = 0; i < signInLimiter.max + 5; i++) {
    const r = await signIn({ email: EMAIL, password: PW, code: '123456' })
    assert.equal(r.statusCode, 503, `attempt ${i}: ${r.body}`)
    assert.equal(r.json().code, 'vault_unreachable')
    assert.equal(r.json().error, VAULT_UNREACHABLE)
  }
  assert.equal(signInLimiter.retryAfter(EMAIL), 0)
})

test('sign-in when the vault does not answer its health check: 503 before any code is sent', async () => {
  broker.reachable = false
  const before = broker.callsTo('signIn').length
  const r = await signIn({ email: EMAIL, password: PW, code: '123456' })
  assert.equal(r.statusCode, 503)
  assert.equal(r.json().code, 'vault_unreachable')
  assert.equal(broker.callsTo('signIn').length, before)
  assert.equal(signInLimiter.retryAfter(EMAIL), 0)
})

test('sign-in fields are capped: email 254, password 1024, code 6 to 8 digits', async () => {
  assert.equal(authInputProblem({ email: 'a@b.co', password: 'x', code: '123456' }), null)
  assert.equal(authInputProblem({ code: '12345678' }), null)
  assert.match(authInputProblem({ email: `${'a'.repeat(250)}@example.com` })!, /too long/)
  assert.match(authInputProblem({ password: 'x'.repeat(1025) })!, /too long/)
  assert.match(authInputProblem({ code: '12345' })!, /6-digit/)
  assert.match(authInputProblem({ code: 'abcdef' })!, /6-digit/)
  for (const body of [
    { email: `${'a'.repeat(250)}@example.com`, password: PW, code: '123456' },
    { email: EMAIL, password: 'x'.repeat(2000), code: '123456' },
    { email: EMAIL, password: PW, code: '12ab56' },
  ]) {
    const r = await signIn(body)
    assert.equal(r.statusCode, 400, JSON.stringify(body).slice(0, 60))
    assert.equal(r.json().code, 'invalid_input')
  }
})
