import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { FakeBroker, GOOD_CODE } from './fakes/fake-broker'
import { buildTestApp, resetLock } from './fakes/app'
import { isUnlocked } from '../src/lib/vault/state'

const broker = new FakeBroker()   // empty vault: not bootstrapped
const appP = buildTestApp(broker)
after(async () => { await resetLock(); await (await appP).close() })

test('owner bootstrap: status → bootstrap → confirm TOTP → signed in as owner, unlocked', async () => {
  const app = await appP
  const st = await app.inject({ method: 'GET', url: '/api/auth/status' })
  assert.equal(st.json().bootstrapped, false)

  const short = await app.inject({ method: 'POST', url: '/api/auth/bootstrap', payload: { email: 'owner@example.com', password: 'short' } })
  assert.equal(short.statusCode, 400)

  const b = await app.inject({ method: 'POST', url: '/api/auth/bootstrap', payload: { email: 'Owner@Example.com', password: 'correct horse battery staple' } })
  assert.equal(b.statusCode, 200, b.body)
  assert.match(b.json().otpauthUri, /^otpauth:\/\/totp\//)
  assert.equal(b.json().totpSecret, undefined)

  const wrong = await app.inject({ method: 'POST', url: '/api/auth/bootstrap/confirm', payload: { email: 'owner@example.com', password: 'correct horse battery staple', code: '000000' } })
  assert.equal(wrong.statusCode, 401)
  assert.equal(isUnlocked(), false)

  const c = await app.inject({ method: 'POST', url: '/api/auth/bootstrap/confirm', payload: { email: 'owner@example.com', password: 'correct horse battery staple', code: GOOD_CODE } })
  assert.equal(c.statusCode, 200, c.body)
  assert.deepEqual(c.json().user, { email: 'owner@example.com', role: 'owner' })
  assert.match(String(c.headers['set-cookie']), /hyperprox_token=/)
  assert.equal(isUnlocked(), true)

  const again = await app.inject({ method: 'POST', url: '/api/auth/bootstrap', payload: { email: 'evil@example.com', password: 'correct horse battery staple' } })
  assert.equal(again.statusCode, 409)
})
