import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { FakeBroker } from './fakes/fake-broker'
import { buildTestApp, resetLock, signIn } from './fakes/app'
import { isUnlocked, lock } from '../src/lib/vault/state'

const broker = new FakeBroker()
broker.addUser('owner@example.com', 'correct horse battery staple', 'owner')
broker.addUser('viewer@example.com', 'viewer master password', 'viewer')
const appP = buildTestApp(broker)

beforeEach(resetLock)
after(async () => { await resetLock(); await (await appP).close() })

test('locked: data route answers 423 { ok:false, locked:true }', async () => {
  const app = await appP
  const res = await app.inject({ method: 'GET', url: '/api/proxmox/resources' })
  assert.equal(res.statusCode, 423)
  assert.deepEqual(res.json(), { ok: false, locked: true })
})

test('locked: 423 even with a token, and for websockets and secrets', async () => {
  const app = await appP
  for (const url of ['/ws', '/ws/terminal/term', '/api/secrets', '/api/plugins/metrics']) {
    const res = await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer x.y.z' } })
    assert.equal(res.statusCode, 423, url)
  }
})

test('locked: /health and /api/auth/status still answer', async () => {
  const app = await appP
  const h = await app.inject({ method: 'GET', url: '/health' })
  assert.equal(h.statusCode, 200)
  const s = await app.inject({ method: 'GET', url: '/api/auth/status' })
  assert.equal(s.statusCode, 200)
  assert.equal(s.json().locked, true)
  assert.equal(s.json().bootstrapped, true)
  assert.equal(s.json().reachable, true)
  assert.equal(s.json().user, undefined)
})

test('sign-in with the vault account unlocks, sets the cookie, and the session works', async () => {
  const app = await appP
  const { res, cookie } = await signIn(app, 'owner@example.com', 'correct horse battery staple')
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json().user, { email: 'owner@example.com', role: 'owner' })
  assert.match(cookie, /^hyperprox_token=.+/)
  assert.equal(isUnlocked(), true)

  const data = await app.inject({ method: 'GET', url: '/api/proxmox/resources', headers: { cookie } })
  assert.equal(data.statusCode, 200)

  const st = await app.inject({ method: 'GET', url: '/api/auth/status', headers: { cookie } })
  assert.equal(st.json().locked, false)
  assert.deepEqual(st.json().user, { email: 'owner@example.com', role: 'owner' })
})

test('wrong master password or 2FA code: 401, stays locked', async () => {
  const app = await appP
  const bad = await signIn(app, 'owner@example.com', 'wrong password!!')
  assert.equal(bad.res.statusCode, 401)
  assert.equal(bad.res.json().code, 'bad_credentials')
  const badCode = await signIn(app, 'owner@example.com', 'correct horse battery staple', '000000')
  assert.equal(badCode.res.statusCode, 401)
  assert.equal(badCode.res.json().code, 'totp_invalid')
  assert.equal(isUnlocked(), false)
})

test('unlocked: 401 with no session, a forged token, or a signed-out session', async () => {
  const app = await appP
  const { cookie } = await signIn(app, 'viewer@example.com', 'viewer master password')
  const none = await app.inject({ method: 'GET', url: '/api/proxmox/resources' })
  assert.equal(none.statusCode, 401)
  const forged = await app.inject({ method: 'GET', url: '/api/proxmox/resources', headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzaWQiOiJ4In0.AAAA' } })
  assert.equal(forged.statusCode, 401)

  const out = await app.inject({ method: 'POST', url: '/api/auth/sign-out', headers: { cookie } })
  assert.equal(out.statusCode, 200)
  assert.match(String(out.headers['set-cookie']), /Max-Age=0/)
  const after = await app.inject({ method: 'GET', url: '/api/proxmox/resources', headers: { cookie } })
  assert.equal(after.statusCode, 401)
  assert.equal(broker.callsTo('signOut').length >= 1, true)
})

test('a JWT from a previous unlock is rejected after lock + unlock (signing key rotates)', async () => {
  const app = await appP
  const first = await signIn(app, 'owner@example.com', 'correct horse battery staple')
  assert.equal((await app.inject({ method: 'GET', url: '/api/proxmox/resources', headers: { cookie: first.cookie } })).statusCode, 200)

  await lock('manual')
  const whileLocked = await app.inject({ method: 'GET', url: '/api/proxmox/resources', headers: { cookie: first.cookie } })
  assert.equal(whileLocked.statusCode, 423)

  // Someone else unlocks; the old cookie must not come back to life.
  const second = await signIn(app, 'viewer@example.com', 'viewer master password')
  assert.equal(second.res.statusCode, 200)
  const stale = await app.inject({ method: 'GET', url: '/api/proxmox/resources', headers: { cookie: first.cookie } })
  assert.equal(stale.statusCode, 401)
  const fresh = await app.inject({ method: 'GET', url: '/api/proxmox/resources', headers: { cookie: second.cookie } })
  assert.equal(fresh.statusCode, 200)
})

test('POST /api/auth/lock: viewer 403, owner locks and voids every session', async () => {
  const app = await appP
  const v = await signIn(app, 'viewer@example.com', 'viewer master password')
  const o = await signIn(app, 'owner@example.com', 'correct horse battery staple')
  const denied = await app.inject({ method: 'POST', url: '/api/auth/lock', headers: { cookie: v.cookie } })
  assert.equal(denied.statusCode, 403)
  const ok = await app.inject({ method: 'POST', url: '/api/auth/lock', headers: { cookie: o.cookie } })
  assert.equal(ok.statusCode, 200)
  assert.equal(isUnlocked(), false)
  assert.equal((await app.inject({ method: 'GET', url: '/api/proxmox/resources', headers: { cookie: v.cookie } })).statusCode, 423)
})

test('POST /api/auth/lock from the local CLI (loopback, no cookie, not proxied); 423 when already locked', async () => {
  const app = await appP
  await signIn(app, 'viewer@example.com', 'viewer master password')
  // Proxied (nginx over the docker bridge adds X-Forwarded-For): not local.
  const proxied = await app.inject({ method: 'POST', url: '/api/auth/lock', payload: {}, headers: { 'x-forwarded-for': '192.168.1.50' } })
  assert.equal(proxied.statusCode, 401)
  // Not loopback.
  const remote = await app.inject({ method: 'POST', url: '/api/auth/lock', payload: {}, remoteAddress: '192.168.1.50' })
  assert.equal(remote.statusCode, 401)
  assert.equal(isUnlocked(), true)
  // inject() comes from 127.0.0.1 by default: this is the CLI.
  const ok = await app.inject({ method: 'POST', url: '/api/auth/lock', payload: {} })
  assert.equal(ok.statusCode, 200)
  assert.equal(isUnlocked(), false)
  const again = await app.inject({ method: 'POST', url: '/api/auth/lock', payload: {} })
  assert.equal(again.statusCode, 423)
})

test('bootstrap is refused once the owner exists', async () => {
  const app = await appP
  const res = await app.inject({ method: 'POST', url: '/api/auth/bootstrap', payload: { email: 'x@example.com', password: 'a long enough password' } })
  assert.equal(res.statusCode, 409)
})
