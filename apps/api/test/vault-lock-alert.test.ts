// The lock alert: which channel, what the message says, and what it never contains.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildAlert, detectKind, lockAlertConfig, lockMessage, sendLockAlert, unlockLink, resetLockAlertForTests,
  installLockAlerts, readMarker, writeMarker,
} from '../src/lib/vault/lock-alert'
import { lock, unlock, isUnlocked } from '../src/lib/vault/state'
import { setBroker } from '../src/lib/vault/broker'
import { FakeBroker } from './fakes/fake-broker'

const PUBLIC = 'https://hyperprox.example.com'
const now = new Date('2026-01-01T00:00:00Z')

process.env.HYPERPROX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'khtest-alert-'))
delete process.env.VAULT_KEYHOLDER_SOCKET

beforeEach(() => resetLockAlertForTests())

test('detectKind: Discord, Gotify, ntfy, anything else is a generic webhook', () => {
  assert.equal(detectKind('https://discord.com/api/webhooks/1/abc'), 'discord')
  assert.equal(detectKind('https://discordapp.com/api/webhooks/1/abc'), 'discord')
  assert.equal(detectKind('https://gotify.example.com/message'), 'gotify')
  assert.equal(detectKind('https://ntfy.sh/my-topic'), 'ntfy')
  assert.equal(detectKind('https://hooks.example.com/x'), 'webhook')
  assert.equal(detectKind('https://evil.example.com/discord.com/api/webhooks/1'), 'webhook')
})

test('config: LOCK_ALERT_URL first, else the existing Updates/Certificates webhook; none → null', () => {
  assert.equal(lockAlertConfig({}, () => undefined), null)
  assert.equal(lockAlertConfig({ LOCK_ALERT_URL: 'not a url' }, () => undefined), null)
  assert.deepEqual(lockAlertConfig({}, () => 'https://discord.com/api/webhooks/1/abc'), { url: 'https://discord.com/api/webhooks/1/abc', kind: 'discord' })
  const c = lockAlertConfig({ LOCK_ALERT_URL: 'https://push.example.com/t', LOCK_ALERT_KIND: 'ntfy', LOCK_ALERT_TOKEN: 'tok', HYPERPROX_PUBLIC_URL: PUBLIC + '/' }, () => 'https://discord.com/api/webhooks/1/abc')
  assert.deepEqual(c, { url: 'https://push.example.com/t', kind: 'ntfy', token: 'tok', publicUrl: PUBLIC })
})

test('the link is the sign-in page with the reason, and nothing else', () => {
  assert.equal(unlockLink(PUBLIC, 'idle'), `${PUBLIC}/login?locked=1&reason=idle`)
  assert.equal(unlockLink(undefined, 'idle'), null)
  assert.match(lockMessage('idle', 30), /after 30 minutes/)
})

test('ntfy: one-tap Click and a view action; the token only in the Authorization header', () => {
  const r = buildAlert({ url: 'https://ntfy.example.com/t', kind: 'ntfy', token: 'tk_1', publicUrl: PUBLIC }, 'idle', now, 30)
  assert.equal(r.headers.Click, `${PUBLIC}/login?locked=1&reason=idle`)
  assert.equal(r.headers.Actions, `view, Unlock, ${PUBLIC}/login?locked=1&reason=idle, clear=true`)
  assert.equal(r.headers.Authorization, 'Bearer tk_1')
  assert.equal(r.body.includes('tk_1'), false)
  assert.match(r.body, /after 30 minutes/)
})

test('Discord: the link without a preview, and no mention can ping', () => {
  const r = buildAlert({ url: 'https://discord.com/api/webhooks/1/abc', kind: 'discord', publicUrl: PUBLIC }, 'keyholder', now)
  const b = JSON.parse(r.body)
  assert.deepEqual(b.allowed_mentions, { parse: [] })
  assert.match(b.content, /<https:\/\/hyperprox\.example\.com\/login\?locked=1&reason=keyholder>/)
})

test('Gotify: click URL in extras, app token in X-Gotify-Key; generic webhook: content + text + url', () => {
  const g = buildAlert({ url: 'https://gotify.example.com/message', kind: 'gotify', token: 'A1', publicUrl: PUBLIC }, 'restart', now)
  assert.equal(g.headers['X-Gotify-Key'], 'A1')
  assert.equal(JSON.parse(g.body).extras['client::notification'].click.url, `${PUBLIC}/login?locked=1&reason=restart`)
  const w = JSON.parse(buildAlert({ url: 'https://hooks.example.com/x', kind: 'webhook', publicUrl: PUBLIC }, 'restart', now).body)
  assert.equal(w.event, 'hyperprox.locked')
  assert.equal(w.url, `${PUBLIC}/login?locked=1&reason=restart`)
  assert.match(w.content, /Tap to unlock/)
  assert.equal(w.text, w.content)
})

test('without HYPERPROX_PUBLIC_URL the message says how to unlock, with no link', () => {
  const r = buildAlert({ url: 'https://ntfy.example.com/t', kind: 'ntfy' }, 'idle', now)
  assert.equal(r.headers.Click, undefined)
  assert.match(r.body, /set HYPERPROX_PUBLIC_URL/)
})

test('sending: logs name the kind and status only, never the address or token', async () => {
  const logs: string[] = []
  const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) }
  const env = { LOCK_ALERT_URL: 'https://ntfy.example.com/secret-topic', LOCK_ALERT_TOKEN: 'tk_secret' }
  assert.equal(await sendLockAlert('idle', { env, log, fetch: async () => ({ ok: false, status: 403 }) }), 'failed')
  resetLockAlertForTests()
  assert.equal(await sendLockAlert('idle', { env, log, fetch: async () => { throw Object.assign(new TypeError('fetch failed: https://ntfy.example.com/secret-topic'), { cause: { code: 'ECONNREFUSED' } }) } }), 'failed')
  resetLockAlertForTests()
  assert.equal(await sendLockAlert('idle', { env, log, fetch: async () => ({ ok: true, status: 200 }) }), 'sent')
  assert.equal(await sendLockAlert('idle', { env, log, fetch: async () => ({ ok: true, status: 200 }) }), 'suppressed', 'one message per lock')
  assert.equal(await sendLockAlert('idle', { env: {}, log, fallback: () => undefined }), 'unconfigured')
  const all = logs.join('\n')
  assert.match(all, /HTTP 403/)
  assert.match(all, /ECONNREFUSED/)
  for (const needle of ['secret-topic', 'ntfy.example.com', 'tk_secret']) assert.equal(all.includes(needle), false)
})

test('in-process mode: idle and restart alert, "Lock now" does not; the marker tracks unlocked', async () => {
  const sent: string[] = []
  const broker = new FakeBroker()
  broker.addUser('o@example.com', 'a long master password', 'owner')
  setBroker(broker)
  const { startupCheck } = installLockAlerts({
    env: { LOCK_ALERT_URL: 'https://hooks.example.com/x', HYPERPROX_PUBLIC_URL: PUBLIC },
    fetch: async (_u, init) => { sent.push(JSON.parse(init.body).reason); return { ok: true, status: 200 } },
  })
  const s = await broker.signIn('o@example.com', 'a long master password', '123456')
  await unlock(s.sid)
  assert.equal(readMarker()?.unlocked, true)
  await lock('manual')
  assert.equal(readMarker()?.unlocked, false)
  assert.deepEqual(sent, [])

  const s2 = await broker.signIn('o@example.com', 'a long master password', '123456')
  await unlock(s2.sid)
  await lock('idle')
  await new Promise(r => setTimeout(r, 20))
  assert.deepEqual(sent, ['idle'])

  // HyperProx was unlocked when the process went away; this start is locked.
  resetLockAlertForTests()
  writeMarker(true)
  assert.equal(isUnlocked(), false)
  await startupCheck()
  assert.deepEqual(sent, ['idle', 'restart'])
  assert.equal(readMarker()?.unlocked, false)
})
