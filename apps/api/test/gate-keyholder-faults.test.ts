// A keyholder that does not confirm. Locking must never be reported while the keyholder may still hold
// the state: the keyholder is told first, and restarted (which wipes it) when it does not answer ok.
// An unlock the keyholder may have half-taken is locked again before the sign-in fails.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FakeBroker } from './fakes/fake-broker'
import { FakeKeyholderServer } from './fakes/fake-keyholder-server'

const OWNER = 'owner@example.com'
const PW = 'correct horse battery staple'
const timeline: string[] = []
const fake = new FakeKeyholderServer(timeline)
const restarts: string[] = []
let restartFails = false

process.env.HYPERPROX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'khtest-faults-'))
process.env.VAULT_KEYHOLDER_TIMEOUT_MS = '300'

class OrderedBroker extends FakeBroker {
  async signOutAll() { timeline.push('broker:signOutAll'); return super.signOutAll() }
}
const broker = new OrderedBroker()
broker.addUser(OWNER, PW, 'owner')

let state: typeof import('../src/lib/vault/state')
let appMod: typeof import('./fakes/app')
let app: Awaited<ReturnType<typeof import('./fakes/app')['buildTestApp']>>

before(async () => {
  await fake.start()
  process.env.VAULT_KEYHOLDER_SOCKET = fake.socket
  state = await import('../src/lib/vault/state')
  appMod = await import('./fakes/app')
  state.setKeyholderRestarter(async (reason) => {
    restarts.push(reason)
    if (restartFails) throw new Error('systemctl restart failed')
    await fake.restart()
  })
  app = await appMod.buildTestApp(broker)
  assert.equal((await state.attachUnlockState(3000)).reachable, true)
})

after(async () => { await app.close(); state.detachForTests(); await fake.stop() })

beforeEach(async () => {
  fake.unlockMode = 'ok'; fake.lockMode = 'ok'
  restartFails = false
  if (state.isUnlocked()) await state.lock('manual').catch(() => undefined)
  timeline.length = 0; restarts.length = 0; fake.ops.length = 0
})

async function signedIn() {
  const { res, cookie } = await appMod.signIn(app, OWNER, PW)
  assert.equal(res.statusCode, 200, res.body)
  return cookie
}

test('Lock now tells the keyholder first, before wiping here and signing out of the vault', async () => {
  const cookie = await signedIn()
  timeline.length = 0
  const r = await app.inject({ method: 'POST', url: '/api/auth/lock', headers: { cookie } })
  assert.equal(r.statusCode, 200)
  assert.equal(r.json().locked, true)
  assert.ok(timeline.indexOf('keyholder:lock') >= 0, timeline.join(', '))
  assert.ok(timeline.indexOf('keyholder:lock') < timeline.indexOf('broker:signOutAll'), timeline.join(', '))
  assert.deepEqual(restarts, [])
})

test('the keyholder answers the lock with an error: it is restarted, and only then is it reported locked', async () => {
  const cookie = await signedIn()
  fake.lockMode = 'error'
  const r = await app.inject({ method: 'POST', url: '/api/auth/lock', headers: { cookie } })
  assert.deepEqual(restarts, ['manual'])
  assert.equal(r.statusCode, 200, r.body)
  assert.equal(state.isUnlocked(), false)
})

test('the keyholder never answers the lock: it is restarted', async () => {
  const cookie = await signedIn()
  fake.lockMode = 'hang'
  const r = await app.inject({ method: 'POST', url: '/api/auth/lock', headers: { cookie } })
  assert.deepEqual(restarts, ['manual'])
  assert.equal(r.statusCode, 200, r.body)
})

test('no confirmation and the restart fails too: an error, never locked:true', async () => {
  const cookie = await signedIn()
  fake.lockMode = 'hang'
  restartFails = true
  const r = await app.inject({ method: 'POST', url: '/api/auth/lock', headers: { cookie } })
  assert.notEqual(r.statusCode, 200)
  assert.notEqual(r.json().locked, true)
  assert.equal(r.json().code, 'keyholder_lock_unconfirmed')
  assert.deepEqual(restarts, ['manual'])
  assert.equal(state.isUnlocked(), false, 'this process wipes its own copy regardless')
})

test('unlock times out: the keyholder is locked again before the sign-in fails', async () => {
  fake.unlockMode = 'hang'
  const { res } = await appMod.signIn(app, OWNER, PW)
  assert.equal(res.statusCode, 503, res.body)
  assert.equal(state.isUnlocked(), false)
  assert.ok(fake.ops.lastIndexOf('lock') > fake.ops.indexOf('unlock'), fake.ops.join(', '))
  assert.deepEqual(restarts, [])
})

test('unlock errors: the keyholder is locked again', async () => {
  fake.unlockMode = 'error'
  const { res } = await appMod.signIn(app, OWNER, PW)
  assert.equal(res.statusCode, 503, res.body)
  assert.ok(fake.ops.includes('lock'), fake.ops.join(', '))
})

test('unlock and lock both time out: the keyholder is restarted', async () => {
  fake.unlockMode = 'hang'
  fake.lockMode = 'hang'
  const { res } = await appMod.signIn(app, OWNER, PW)
  assert.equal(res.statusCode, 503, res.body)
  assert.deepEqual(restarts, ['restart'])
})
