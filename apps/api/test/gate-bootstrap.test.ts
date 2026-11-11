import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { FakeBroker, GOOD_CODE } from './fakes/fake-broker'
import { buildTestApp, resetLock, useSetupKey } from './fakes/app'
import { readFileSync } from 'fs'
import { isUnlocked } from '../src/lib/vault/state'

const broker = new FakeBroker()   // empty vault: not bootstrapped
const appP = buildTestApp(broker)
let KEY = ''
after(async () => { await resetLock(); await (await appP).close() })

test('owner claim: without the setup key, bootstrap and confirm are refused and no account is made', async () => {
  const app = await appP
  // An install with no setup key at all: refused with the way to make one, not a 500 and not an open door.
  const none = await app.inject({ method: 'POST', url: '/api/auth/bootstrap', payload: { email: 'evil@example.com', password: 'correct horse battery staple' } })
  assert.equal(none.statusCode, 403, none.body)
  assert.equal(none.json().code, 'setup_key_missing')
  const noneConfirm = await app.inject({ method: 'POST', url: '/api/auth/bootstrap/confirm', payload: { email: 'evil@example.com', password: 'correct horse battery staple', code: GOOD_CODE } })
  assert.equal(noneConfirm.statusCode, 403, noneConfirm.body)

  KEY = useSetupKey()
  for (const headers of [{}, { 'x-setup-key': 'wrong' }, { 'x-setup-key': '' }]) {
    const b = await app.inject({ method: 'POST', url: '/api/auth/bootstrap', headers, payload: { email: 'evil@example.com', password: 'correct horse battery staple' } })
    assert.equal(b.statusCode, 401, b.body)
    assert.equal(b.json().code, 'setup_key_required')
    const c = await app.inject({ method: 'POST', url: '/api/auth/bootstrap/confirm', headers, payload: { email: 'evil@example.com', password: 'correct horse battery staple', code: GOOD_CODE } })
    assert.equal(c.statusCode, 401, c.body)
  }
  assert.equal(broker.callsTo('bootstrapOwner').length + broker.callsTo('confirmOwnerTotp').length, 0)
  assert.equal(isUnlocked(), false)
})

test('owner bootstrap: status → bootstrap → confirm TOTP → signed in as owner, unlocked', async () => {
  const app = await appP
  const headers = { 'x-setup-key': KEY }
  const st = await app.inject({ method: 'GET', url: '/api/auth/status' })
  assert.equal(st.json().bootstrapped, false)

  const short = await app.inject({ method: 'POST', url: '/api/auth/bootstrap', headers, payload: { email: 'owner@example.com', password: 'short' } })
  assert.equal(short.statusCode, 400)

  const b = await app.inject({ method: 'POST', url: '/api/auth/bootstrap', headers, payload: { email: 'Owner@Example.com', password: 'correct horse battery staple' } })
  assert.equal(b.statusCode, 200, b.body)
  assert.match(b.json().otpauthUri, /^otpauth:\/\/totp\//)
  assert.equal(b.json().totpSecret, undefined)

  const wrong = await app.inject({ method: 'POST', url: '/api/auth/bootstrap/confirm', headers, payload: { email: 'owner@example.com', password: 'correct horse battery staple', code: '000000' } })
  assert.equal(wrong.statusCode, 401)
  assert.equal(isUnlocked(), false)

  // The key stays in .env until the owner's first sign-in, which is this confirm.
  assert.match(readFileSync(process.env.ENV_FILE_PATH!, 'utf8'), /^SETUP_SECRET=/m)
  const c = await app.inject({ method: 'POST', url: '/api/auth/bootstrap/confirm', headers, payload: { email: 'owner@example.com', password: 'correct horse battery staple', code: GOOD_CODE } })
  assert.equal(c.statusCode, 200, c.body)
  // ...which removes it: the owner exists, so the owner-claim routes have nothing left to guard.
  assert.doesNotMatch(readFileSync(process.env.ENV_FILE_PATH!, 'utf8'), /^SETUP_SECRET=/m)
  assert.deepEqual(c.json().user, { email: 'owner@example.com', role: 'owner' })
  assert.match(String(c.headers['set-cookie']), /hyperprox_token=/)
  assert.equal(isUnlocked(), true)

  const again = await app.inject({ method: 'POST', url: '/api/auth/bootstrap', headers, payload: { email: 'evil@example.com', password: 'correct horse battery staple' } })
  assert.equal(again.statusCode, 409)
})

test('a confirm after the owner exists (e.g. HyperProx restarted between the steps) sends the user to sign in, not a 500', async () => {
  const app = await appP
  const r = await app.inject({ method: 'POST', url: '/api/auth/bootstrap/confirm',
    payload: { email: 'owner@example.com', password: 'correct horse battery staple', code: GOOD_CODE } })
  assert.equal(r.statusCode, 409, r.body)
  assert.equal(r.json().code, 'sign_in')
})
