// The gate with a keyholder: the unlocked state lives in the keyholder process, so an API restart
// keeps HyperProx unlocked; a keyholder restart, the idle timeout or "Lock now" still lock it,
// and a self-lock posts an alert with a sign-in link and no secret.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FakeBroker } from './fakes/fake-broker'
import { startKeyholder, waitFor, type RunningKeyholder } from './fakes/keyholder'
import { KeyholderClient } from '../src/lib/vault/keyholder'

const OWNER = 'owner@example.com'
const PW = 'correct horse battery staple'
const SECRET = 'godaddy-key-4e1b7d0c'
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khtest-data-'))

let k: RunningKeyholder
let sockDir: string
const logs: string[] = []
const alerts: Array<{ url: string; headers: Record<string, string>; body: string }> = []

process.env.HYPERPROX_DATA_DIR = dataDir
process.env.VAULT_IDLE_LOCK_MINUTES = '30'

// Loaded after the env is set (the modules read it lazily, but keep the order obvious).
let state: typeof import('../src/lib/vault/state')
let lockAlert: typeof import('../src/lib/vault/lock-alert')
let appMod: typeof import('./fakes/app')
let app: Awaited<ReturnType<typeof import('./fakes/app')['buildTestApp']>>
const broker = new FakeBroker()
broker.addUser(OWNER, PW, 'owner')
let startupCheck: () => Promise<void>

before(async () => {
  k = await startKeyholder()
  sockDir = k.dir
  process.env.VAULT_KEYHOLDER_SOCKET = k.socket
  state = await import('../src/lib/vault/state')
  lockAlert = await import('../src/lib/vault/lock-alert')
  appMod = await import('./fakes/app')
  state.setStateLogger({ info: m => logs.push(m), warn: m => logs.push(m) })
  startupCheck = lockAlert.installLockAlerts({
    log: { info: m => logs.push(m), warn: m => logs.push(m) },
    env: { LOCK_ALERT_URL: 'https://ntfy.example.com/hyperprox-alerts', LOCK_ALERT_TOKEN: 'tk_ntfy_secret_token', HYPERPROX_PUBLIC_URL: 'https://hyperprox.example.com' },
    fetch: async (url, init) => { alerts.push({ url, headers: init.headers, body: init.body }); return { ok: true, status: 200 } },
  }).startupCheck
  app = await appMod.buildTestApp(broker)
  const a = await state.attachUnlockState(5000)
  assert.deepEqual(a, { mode: 'keyholder', reachable: true })
})

after(async () => {
  await app.close()
  await k.stop('SIGKILL')
  state.detachForTests()
})

beforeEach(async () => {
  process.env.VAULT_IDLE_LOCK_MINUTES = '30'
  if (state.isUnlocked()) await state.lock('manual')
  alerts.length = 0
  lockAlert.resetLockAlertForTests()
})

async function signInAndStore() {
  const { res, cookie } = await appMod.signIn(app, OWNER, PW)
  assert.equal(res.statusCode, 200, res.body)
  const put = await app.inject({ method: 'PUT', url: '/api/test/probe', headers: { cookie }, payload: { value: SECRET } })
  assert.equal(put.statusCode, 200, put.body)
  return cookie
}

async function keyholderState() {
  const c = new KeyholderClient(k.socket, { locked: () => undefined, gone: () => undefined })
  await c.connect()
  try { return await c.get() } finally { c.close() }
}

/** Simulates the API process dying and starting again: its memory is gone; the keyholder is not. */
async function restartApi() {
  state.detachForTests()
  // The test app's in-memory session map and the fake broker's sessions die with the process too.
  const auth = await import('../src/lib/auth')
  auth.clearSessions()
  broker.sessions.clear()
  return state.attachUnlockState(5000)
}

test('sign-in puts the unlocked state in the keyholder, kept current as it changes', async () => {
  await signInAndStore()
  assert.equal(state.isUnlocked(), true)
  const held = await keyholderState()
  assert.equal(held.unlocked, true)
  const doc = JSON.parse(Buffer.from(held.snapshot!, 'base64').toString('utf8'))
  assert.equal(doc.v, 1)
  assert.equal(doc.parts.sessions.length, 1)
  assert.equal(doc.parts.sessions[0].email, OWNER)
  // The write after sign-in reached the keyholder's copy (updates are coalesced, so give it a moment).
  await new Promise(r => setTimeout(r, 50))
  const again = JSON.parse(Buffer.from((await keyholderState()).snapshot!, 'base64').toString('utf8'))
  assert.ok(again.secrets.some((s: any) => JSON.stringify(s.fields).includes(SECRET)))
})

test('an API restart keeps HyperProx unlocked: same cookie, same secrets, re-confirmation still works', async () => {
  const cookie = await signInAndStore()
  await new Promise(r => setTimeout(r, 50))    // the coalesced snapshot update
  const r = await restartApi()
  assert.equal(r.reachable, true)
  assert.equal(state.isUnlocked(), true)

  const st = await app.inject({ method: 'GET', url: '/api/auth/status', headers: { cookie } })
  assert.equal(st.json().locked, false)
  assert.deepEqual(st.json().user, { email: OWNER, role: 'owner' })
  const probe = await app.inject({ method: 'GET', url: '/api/test/probe', headers: { cookie } })
  assert.equal(probe.statusCode, 200)
  assert.equal(probe.json().value, SECRET)
  const rc = await app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie }, payload: { password: PW } })
  assert.equal(rc.statusCode, 200, rc.body)
  assert.ok(broker.callsTo('importSessions').length >= 1)
  await startupCheck()
  assert.equal(alerts.length, 0, 'nothing was lost, so no alert')
})

test('a keyholder restart locks HyperProx, and the alert carries a sign-in link and no secret', async () => {
  const cookie = await signInAndStore()
  await k.stop('SIGKILL')
  await waitFor(() => !state.isUnlocked(), 5000, 'API locked')
  assert.equal((await app.inject({ method: 'GET', url: '/api/test/probe', headers: { cookie } })).statusCode, 423)
  await waitFor(() => alerts.length === 1, 2000, 'alert')
  const a = alerts[0]
  assert.equal(a.url, 'https://ntfy.example.com/hyperprox-alerts')
  assert.equal(a.headers.Click, 'https://hyperprox.example.com/login?locked=1&reason=keyholder')
  assert.match(a.body, /keyholder service stopped or restarted/)
  for (const needle of [SECRET, PW, cookie.split('=')[1]]) assert.equal(JSON.stringify(a).includes(needle), false)

  // A new keyholder: the API reconnects, stays locked, and a sign-in unlocks again.
  k = await startKeyholder({ dir: sockDir })
  const { res } = await appMod.signIn(app, OWNER, PW)
  assert.equal(res.statusCode, 200, res.body)
  assert.equal((await keyholderState()).unlocked, true)
})

test('the idle timeout, enforced by the keyholder, locks the API and alerts', async () => {
  process.env.VAULT_IDLE_LOCK_MINUTES = String(0.6 / 60)   // 600 ms
  await signInAndStore()
  assert.equal(state.isUnlocked(), true)
  await waitFor(() => !state.isUnlocked(), 4000, 'idle lock')
  const held = await keyholderState()
  assert.equal(held.unlocked, false)
  assert.equal(held.lastLock?.reason, 'idle')
  await waitFor(() => alerts.length === 1, 2000, 'alert')
  assert.equal(alerts[0].headers.Click, 'https://hyperprox.example.com/login?locked=1&reason=idle')
})

test('requests from a signed-in user keep it unlocked past the idle timeout', async () => {
  process.env.VAULT_IDLE_LOCK_MINUTES = String(0.8 / 60)   // 800 ms; touches go out at most every 80 ms
  const cookie = await signInAndStore()
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 150))
    assert.equal((await app.inject({ method: 'GET', url: '/api/proxmox/resources', headers: { cookie } })).statusCode, 200, `request ${i}`)
  }
  assert.equal(state.isUnlocked(), true)
})

test('"Lock now" locks the keyholder too, and sends no alert', async () => {
  const cookie = await signInAndStore()
  const r = await app.inject({ method: 'POST', url: '/api/auth/lock', headers: { cookie } })
  assert.equal(r.statusCode, 200)
  assert.equal(state.isUnlocked(), false)
  assert.equal((await keyholderState()).unlocked, false)
  await new Promise(r => setTimeout(r, 100))
  assert.equal(alerts.length, 0)
})

test('a restart that finds the keyholder locked (it idled out meanwhile) stays locked and alerts once', async () => {
  process.env.VAULT_IDLE_LOCK_MINUTES = String(0.3 / 60)
  await signInAndStore()
  state.detachForTests()                    // the API is down...
  ;(await import('../src/lib/auth')).clearSessions()
  await new Promise(r => setTimeout(r, 700)) // ...while the keyholder idles out
  await state.attachUnlockState(5000)
  assert.equal(state.isUnlocked(), false)
  await startupCheck()
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].headers.Click, 'https://hyperprox.example.com/login?locked=1&reason=idle')
  await startupCheck()
  assert.equal(alerts.length, 1, 'the marker is cleared: one alert per lock')
})

test('no keyholder running: sign-in is 503 and HyperProx stays locked', async () => {
  await k.stop('SIGKILL')
  await new Promise(r => setTimeout(r, 100))
  const { res } = await appMod.signIn(app, OWNER, PW)
  assert.equal(res.statusCode, 503, res.body)
  assert.equal(res.json().code, 'keyholder_unavailable')
  assert.equal(state.isUnlocked(), false)
  assert.equal(broker.sessions.size, 0, 'the vault session was signed out again')
  k = await startKeyholder({ dir: sockDir })
})

test('a snapshot this API cannot read locks both sides, and a sign-in works again', async () => {
  state.detachForTests()
  const c = new KeyholderClient(k.socket, { locked: () => undefined, gone: () => undefined })
  await c.connect()
  await c.lock('manual')
  await c.unlock(Buffer.from(JSON.stringify({ v: 99 })).toString('base64'), 60_000)   // e.g. an older or newer format
  c.close()
  await state.attachUnlockState(5000)
  assert.equal(state.isUnlocked(), false)
  assert.equal((await keyholderState()).unlocked, false)
  assert.ok(logs.some(l => /could not restore the keyholder's state \(snapshot version 99/.test(l)))
  const { res } = await appMod.signIn(app, OWNER, PW)
  assert.equal(res.statusCode, 200, res.body)
})

test('nothing sensitive in the API or keyholder logs', async () => {
  const cookie = await signInAndStore()
  await restartApi()
  await app.inject({ method: 'GET', url: '/api/test/probe', headers: { cookie } })
  await k.stop('SIGKILL')
  await waitFor(() => !state.isUnlocked(), 5000, 'locked')
  await waitFor(() => alerts.length === 1, 2000, 'alert')
  const all = logs.join('\n') + '\n' + k.output()
  assert.ok(logs.some(l => /restored from the keyholder/.test(l)))
  assert.ok(logs.some(l => /lock alert sent/.test(l)))
  for (const needle of [SECRET, PW, 'tk_ntfy_secret_token', 'ntfy.example.com', cookie.split('=')[1]]) {
    assert.equal(all.includes(needle), false, `logs contain ${needle}`)
  }
  k = await startKeyholder({ dir: sockDir })
})
