// GET /api/auth/check is what nginx asks (auth_request) before it lets a request through to /grafana/.
// It must say yes only for a signed-in person while HyperProx is unlocked, answer in the two refusals
// nginx understands (401, 403; a 423 would surface as a 500), never be rate limited (every Grafana asset
// and query asks, all from nginx's one address), and not keep HyperProx unlocked on its own.
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { FakeBroker } from './fakes/fake-broker'
import { buildTestApp, resetLock, signIn } from './fakes/app'
import { isUnlocked, lock } from '../src/lib/vault/state'
import { requiredRole, SESSION_CHECK } from '../src/lib/roles'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { apiTokenRoutes } from '../src/routes/api-tokens'
import { MemoryApiTokenStore, setApiTokenStore, createApiToken } from '../src/lib/api-tokens'

const broker = new FakeBroker()
broker.addUser('owner@example.com', 'correct horse battery staple', 'owner')
broker.addUser('viewer@example.com', 'viewer master password', 'viewer')
const appP = buildTestApp(broker)

beforeEach(resetLock)
after(async () => { await resetLock(); await (await appP).close() })

const check = async (headers: Record<string, string> = {}) =>
  (await appP).inject({ method: 'GET', url: SESSION_CHECK, headers })

test('the route needs a session of any role, whatever the method', () => {
  assert.equal(SESSION_CHECK, '/api/auth/check')
  assert.equal(requiredRole('GET', '/api/auth/check'), 'viewer')
  assert.equal(requiredRole('POST', '/api/auth/check'), 'viewer')
})

test('locked: 401, not 423 (nginx would turn a 423 into a 500)', async () => {
  const res = await check()
  assert.equal(res.statusCode, 401)
  assert.equal(res.body, '')
})

test('locked: a cookie from before the lock is still 401', async () => {
  const app = await appP
  const { cookie } = await signIn(app, 'viewer@example.com', 'viewer master password')
  assert.equal((await check({ cookie })).statusCode, 204)
  await lock('manual')
  assert.equal((await check({ cookie })).statusCode, 401)
})

test('unlocked: no cookie is 401', async () => {
  const app = await appP
  await signIn(app, 'owner@example.com', 'correct horse battery staple')
  assert.equal(isUnlocked(), true)
  assert.equal((await check()).statusCode, 401)
})

test('unlocked: a signed-in viewer gets 204 with no body, never cached', async () => {
  const app = await appP
  const { cookie } = await signIn(app, 'viewer@example.com', 'viewer master password')
  const res = await check({ cookie })
  assert.equal(res.statusCode, 204)
  assert.equal(res.body, '')
  assert.equal(res.headers['cache-control'], 'no-store')
})

test('unlocked: a forged or garbled cookie is 401', async () => {
  const app = await appP
  await signIn(app, 'owner@example.com', 'correct horse battery staple')
  for (const cookie of ['hyperprox_token=eyJhbGciOiJIUzI1NiJ9.eyJzaWQiOiJ4In0.bad', 'hyperprox_token=', 'other=1']) {
    assert.equal((await check({ cookie })).statusCode, 401, cookie)
  }
})

test('unlocked: after sign-out the old cookie is 401', async () => {
  const app = await appP
  await signIn(app, 'owner@example.com', 'correct horse battery staple')          // keeps HyperProx unlocked
  const { cookie } = await signIn(app, 'viewer@example.com', 'viewer master password')
  await app.inject({ method: 'POST', url: '/api/auth/sign-out', headers: { cookie } })
  assert.equal(isUnlocked(), true)
  assert.equal((await check({ cookie })).statusCode, 401)
})

test('an API token is refused with 403, unlocked or locked', async () => {
  const app = await appP
  const store = new MemoryApiTokenStore()
  setApiTokenStore(store)
  const { token } = await createApiToken({ name: 'grafana-probe', role: 'admin' }, 'test', store)
  await signIn(app, 'owner@example.com', 'correct horse battery staple')
  assert.equal((await check({ authorization: `Bearer ${token}` })).statusCode, 403)
  await lock('manual')
  assert.equal((await check({ authorization: `Bearer ${token}` })).statusCode, 403)
})

test('the check does not reset the idle timer; other requests do', async () => {
  const app = await appP
  const was = process.env.VAULT_IDLE_LOCK_MINUTES
  process.env.VAULT_IDLE_LOCK_MINUTES = '0.01'   // 600 ms
  try {
    // An ordinary request keeps it unlocked past the timeout...
    let { cookie } = await signIn(app, 'viewer@example.com', 'viewer master password')
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 120))
      await app.inject({ method: 'GET', url: '/api/proxmox/resources', headers: { cookie } })
    }
    assert.equal(isUnlocked(), true, 'ordinary requests touch the idle timer')
    await lock('manual')

    // ...but Grafana asking the same thing every 120 ms does not.
    ;({ cookie } = await signIn(app, 'viewer@example.com', 'viewer master password'))
    for (let i = 0; i < 10 && isUnlocked(); i++) {
      await new Promise(r => setTimeout(r, 120))
      await check({ cookie })
    }
    assert.equal(isUnlocked(), false, 'the idle lock fired while only the check was being asked')
    assert.equal((await check({ cookie })).statusCode, 401)
  } finally {
    if (was === undefined) delete process.env.VAULT_IDLE_LOCK_MINUTES
    else process.env.VAULT_IDLE_LOCK_MINUTES = was
  }
})

test('the check is exempt from the API-wide rate limit', async () => {
  // The production order (index.ts): rate limit, then the gate, then the routes.
  const app = Fastify({ logger: false })
  await app.register(rateLimit, { max: 5, timeWindow: '1 minute' })
  await registerGate(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(apiTokenRoutes, { prefix: '/api/auth/tokens' })
  await app.ready()
  try {
    const { cookie } = await signIn(app, 'viewer@example.com', 'viewer master password')
    for (let i = 0; i < 30; i++) {
      const res = await app.inject({ method: 'GET', url: SESSION_CHECK, headers: { cookie } })
      assert.equal(res.statusCode, 204, `request ${i + 1}`)
    }
    let limited = 0
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({ method: 'GET', url: '/api/auth/status', headers: { cookie } })
      if (res.statusCode === 429) limited++
    }
    assert.ok(limited > 0, 'other routes are still limited')
  } finally {
    await app.close()
  }
})
