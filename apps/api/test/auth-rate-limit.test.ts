// Sign-in and re-confirmation limits: per client address (req.ip, which is the browser's because only nginx on
// loopback is trusted for X-Forwarded-For) and per account. One client exhausting its limit leaves everyone else
// alone; many addresses taking turns at one account are stopped.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { serverOptions } from '../src/lib/server-options'
import { signInLimiter, reconfirmLimiter, AttemptLimiter } from '../src/lib/auth-limits'
import { FakeBroker, GOOD_CODE } from './fakes/fake-broker'

const broker = new FakeBroker()
broker.addUser('a@example.com', 'a master password', 'admin')
broker.addUser('b@example.com', 'b master password', 'viewer')
let app: FastifyInstance

before(async () => {
  setBroker(broker)
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  app = Fastify(serverOptions(false))
  await app.register(rateLimit, { max: 200, timeWindow: '1 minute' })
  await registerGate(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.ready()
})
beforeEach(() => { signInLimiter.reset(); reconfirmLimiter.reset() })
after(async () => { if (isUnlocked()) await lock('manual'); await app.close() })

// nginx appends the browser's address to whatever X-Forwarded-For the browser sent.
const viaNginx = (client: string, spoofed?: string) => ({
  remoteAddress: '127.0.0.1',
  headers: { 'x-forwarded-for': spoofed ? `${spoofed}, ${client}` : client },
})
const signInFrom = (from: ReturnType<typeof viaNginx>, email: string, password: string, code = GOOD_CODE) =>
  app.inject({ method: 'POST', url: '/api/auth/sign-in', remoteAddress: from.remoteAddress, headers: from.headers, payload: { email, password, code } })

test('req.ip is the client behind nginx; a spoofed X-Forwarded-For prefix and a direct caller\'s header are ignored', async () => {
  assert.deepEqual(serverOptions(false).trustProxy, ['127.0.0.1', '::1'])
  const f = Fastify(serverOptions(false))
  f.get('/ip', async (req) => ({ ip: req.ip }))
  await f.ready()
  const ip = async (o: any) => (await f.inject({ method: 'GET', url: '/ip', ...o })).json().ip
  assert.equal(await ip(viaNginx('203.0.113.5')), '203.0.113.5')
  assert.equal(await ip(viaNginx('203.0.113.5', '10.9.9.9')), '203.0.113.5')
  assert.equal(await ip({ remoteAddress: '198.51.100.7', headers: { 'x-forwarded-for': '203.0.113.99' } }), '198.51.100.7')
  await f.close()
})

test('one client exhausting the sign-in limit does not lock out another client', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await signInFrom(viaNginx('203.0.113.5'), 'a@example.com', 'wrong')).statusCode, 401)
  assert.equal((await signInFrom(viaNginx('203.0.113.5'), 'a@example.com', 'wrong')).statusCode, 429)
  // Writing a different address into X-Forwarded-For does not buy a fresh bucket.
  assert.equal((await signInFrom(viaNginx('203.0.113.5', '192.0.2.77'), 'b@example.com', 'b master password')).statusCode, 429)
  // Another client signs in normally.
  const ok = await signInFrom(viaNginx('203.0.113.6'), 'b@example.com', 'b master password')
  assert.equal(ok.statusCode, 200, ok.body)
})

test('many addresses taking turns at one account are stopped; other accounts are not', async () => {
  for (let i = 0; i < 20; i++) {
    const r = await signInFrom(viaNginx(`198.18.0.${i + 1}`), 'a@example.com', 'wrong')
    assert.equal(r.statusCode, 401, `attempt ${i}`)
  }
  const blocked = await signInFrom(viaNginx('198.18.1.1'), 'a@example.com', 'a master password')
  assert.equal(blocked.statusCode, 429)
  assert.equal(blocked.json().code, 'too_many_attempts')
  assert.ok(Number(blocked.headers['retry-after']) > 0)
  const other = await signInFrom(viaNginx('198.18.1.2'), 'b@example.com', 'b master password')
  assert.equal(other.statusCode, 200, other.body)
})

test('re-confirmation: wrong master passwords are limited per person', async () => {
  const s = await signInFrom(viaNginx('198.18.2.1'), 'b@example.com', 'b master password')
  const cookie = String(s.headers['set-cookie']).split(';')[0]
  for (let i = 0; i < 10; i++) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/reconfirm', remoteAddress: '127.0.0.1', headers: { cookie, 'x-forwarded-for': `198.18.3.${i}` }, payload: { password: 'wrong' } })
    assert.equal(r.statusCode, 401, r.body)
  }
  const r = await app.inject({ method: 'POST', url: '/api/auth/reconfirm', remoteAddress: '127.0.0.1', headers: { cookie, 'x-forwarded-for': '198.18.4.1' }, payload: { password: 'b master password' } })
  assert.equal(r.statusCode, 429)
})

test('the limiter forgets failures outside its window', () => {
  let now = 0
  const l = new AttemptLimiter(2, 1000, () => now)
  l.fail('k'); l.fail('k')
  assert.ok(l.retryAfter('k') > 0)
  now = 1001
  assert.equal(l.retryAfter('k'), 0)
})
