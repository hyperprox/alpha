// A vault that is down is not a wrong 2FA code: sign-in says the vault is not running (503 vault_unreachable),
// and it never counts towards the per-account limit. Sign-in fields are capped.
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { FakeBroker } from './fakes/fake-broker'
import { buildTestApp, resetLock } from './fakes/app'
import { setBroker } from '../src/lib/vault/broker'
import { VaultAuthError, CliVaultBroker, authCodeFromMessage, isVaultConnectionError, cliLoginFailure } from '../src/lib/vault/broker'
import { signInLimiter } from '../src/lib/auth-limits'
import { VaultHttpError } from '../src/lib/vault/bw-crypto'
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

test('mapping: connection errors (by code) are connection errors; the vault\'s own refusals keep their codes', () => {
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

test('text that merely contains a connection word is never "vault unreachable"', () => {
  // The vault's own answer can echo the email; an email with ECONNREFUSED in it must stay a password verdict.
  assert.equal(authCodeFromMessage('Username or password is incorrect. Try again. (ECONNREFUSED@example.com)'), 'bad_credentials')
  assert.equal(authCodeFromMessage('connect ECONNREFUSED 127.0.0.1:8222'), null)
  assert.equal(isVaultConnectionError(new VaultHttpError(400, 'Username or password is incorrect. ECONNREFUSED@example.com')), false)
  assert.equal(isVaultConnectionError(new VaultHttpError(503, 'socket hang up')), false, 'an HTTP answer means the vault was reached')
  assert.equal(isVaultConnectionError(new Error('ECONNREFUSED@example.com is not a member')), false)
  assert.equal(isVaultConnectionError(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8222'), { code: 'ECONNREFUSED' })), true)
  assert.equal(isVaultConnectionError(new Error('socket hang up')), true)
})

test('CLI login: the vault\'s own refusal wins even when /alive is slow or down, and is counted', async () => {
  const never = () => new Promise<boolean>(() => undefined)        // a box so loaded /alive never answers
  const down = async () => false
  const e1 = await cliLoginFailure('Username or password is incorrect. Try again.', '123456', never)
  assert.equal(e1.code, 'bad_credentials')
  const e2 = await cliLoginFailure('Invalid TOTP code! Server time: ...', '123456', down)
  assert.equal(e2.code, 'totp_invalid')
  // Only unrecognised text asks /alive.
  assert.equal((await cliLoginFailure('Something odd happened.', '123456', down)).code, 'vault_unreachable')
  assert.equal((await cliLoginFailure('Something odd happened.', '123456', async () => true)).code, 'totp_invalid')
  assert.equal((await cliLoginFailure('Something odd happened.', '', async () => { throw new Error('x') })).code, 'vault_unreachable')

  // Through the route: that refusal counts towards the per-account limit.
  class CliRefuses extends FakeBroker {
    async signIn(): Promise<never> { throw await cliLoginFailure('Username or password is incorrect. Try again.', '123456', never) }
  }
  const b = new CliRefuses()
  b.addUser('cli@example.com', PW, 'owner')
  const app = await buildTestApp(b)
  try {
    signInLimiter.reset()
    for (let i = 0; i < signInLimiter.max; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/auth/sign-in', payload: { email: 'cli@example.com', password: 'wrong password!!', code: '123456' }, remoteAddress: `192.0.2.${i + 1}` })
      assert.equal(r.statusCode, 401)
      assert.equal(r.json().code, 'bad_credentials')
    }
    assert.ok(signInLimiter.retryAfter('cli@example.com') > 0, 'counted')
    const blocked = await app.inject({ method: 'POST', url: '/api/auth/sign-in', payload: { email: 'cli@example.com', password: 'x', code: '123456' }, remoteAddress: '192.0.2.250' })
    assert.equal(blocked.statusCode, 429)
  } finally {
    await app.close()
    setBroker(broker)
  }
})
