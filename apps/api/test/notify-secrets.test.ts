// Where a channel's secret lives: the vault, or (usable while locked) a 0600 file. And what the UI sees.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LockedChannelsFile, ChannelSecrets, maskSecret, vaultSecretBackend, type SecretBackend } from '../src/lib/notify/secrets'
import type { ChannelRecord } from '../src/lib/notify/types'
import { setBroker } from '../src/lib/vault/broker'
import { lock, unlock, isUnlocked, cachedSecret } from '../src/lib/vault/state'
import { addSession, clearSessions } from '../src/lib/auth'
import { setCredentialTable } from '../src/lib/credentials'
import { FakeBroker } from './fakes/fake-broker'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-secrets-'))
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }))

const ch = (over: Partial<ChannelRecord> = {}): ChannelRecord => ({
  id: 'ch_1', name: 'Phone', kind: 'ntfy', enabled: true, minSeverity: 'warning', eventFilter: 'all', quietHours: null,
  lanOverride: false, usableWhileLocked: false, nonSecret: {}, lastResult: null, lastSentAt: null, failingSince: null,
  seededFrom: null, createdBy: 'o@example.com', createdAt: new Date(), updatedAt: new Date(), ...over,
})

function memVault(): SecretBackend & { items: Map<string, any> } {
  const items = new Map<string, any>()
  return {
    items,
    readable: () => true,
    read: id => items.get(id) ?? null,
    write: async (id, s) => { items.set(id, { ...s }) },
    remove: async id => { items.delete(id) },
  }
}

test('the locked file is 0600, written atomically, and holds what a lock alert needs without Postgres', () => {
  const p = path.join(dir, 'a', 'notify-locked-channels.json')
  const f = new LockedChannelsFile(p)
  assert.deepEqual(f.read().channels, {})
  f.upsert(ch({ usableWhileLocked: true }), { url: 'https://ntfy.example.com/t', token: 'tk' })
  assert.equal(fs.statSync(p).mode & 0o777, 0o600)
  assert.equal(fs.readdirSync(path.dirname(p)).length, 1, 'no temp file left behind')
  const e = f.read().channels.ch_1
  assert.equal(e.kind, 'ntfy'); assert.equal(e.secret.token, 'tk'); assert.equal(e.minSeverity, 'warning')
  f.markSeeded('lockAlert')
  assert.ok(f.read().seeded.lockAlert)
  f.remove('ch_1')
  assert.deepEqual(f.read().channels, {})
  fs.writeFileSync(p, 'not json')
  assert.deepEqual(f.read().channels, {}, 'a damaged file reads as empty')
})

test('a secret lives in exactly one place, and moves when usable-while-locked changes', async () => {
  const file = new LockedChannelsFile(path.join(dir, 'b.json'))
  const vault = memVault()
  const s = new ChannelSecrets(vault, file)
  const c = ch()
  await s.put(c, { url: 'https://ntfy.example.com/t' })
  assert.ok(vault.items.has('ch_1'))
  assert.equal(file.read().channels.ch_1, undefined)
  assert.equal(s.get(c)?.url, 'https://ntfy.example.com/t')

  const locked = { ...c, usableWhileLocked: true }
  await s.put(locked, s.get(c)!)
  assert.equal(vault.items.has('ch_1'), false, 'the vault copy is removed')
  assert.equal(file.read().channels.ch_1.secret.url, 'https://ntfy.example.com/t')
  assert.equal(s.get(locked)?.url, 'https://ntfy.example.com/t')

  await s.put(c, s.get(locked)!)
  assert.equal(file.read().channels.ch_1, undefined)
  assert.ok(vault.items.has('ch_1'))
  await s.remove(c)
  assert.equal(vault.items.has('ch_1'), false)
})

test('mask: host and last four only', () => {
  assert.equal(maskSecret('discord', { url: 'https://discord.com/api/webhooks/123/abcdef3f9a' }, {}), 'discord.com/…/••••3f9a')
  assert.equal(maskSecret('ntfy', { url: 'https://ntfy.example.com/my-topic', token: 'tk_long_token' }, {}), 'ntfy.example.com/…/••••opic + token')
  assert.equal(maskSecret('telegram', { botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ' }, { chatId: '-1001' }), 'bot ••••WXYZ, chat -1001')
  assert.equal(maskSecret('webhook', {}, {}), '—')
})

// --- The vault backend, through the real credential store and a fake vault -----------------------

const broker = new FakeBroker()
broker.addUser('o@example.com', 'a long master password', 'owner')
before(() => {
  setBroker(broker)
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
})
after(async () => { if (isUnlocked()) await lock('manual'); clearSessions() })

test('vault backend: item hyperprox:notify/<id>; unreadable while locked', async () => {
  const v = vaultSecretBackend()
  const s = await broker.signIn('o@example.com', 'a long master password', '123456')
  await unlock(s.sid)
  addSession(s)
  await v.write('ch_9', { url: 'https://hooks.example.com/x', signingSecret: 'sig' })
  assert.deepEqual(cachedSecret('hyperprox:notify/ch_9')?.fields, { url: 'https://hooks.example.com/x', token: '', bot_token: '', signing_secret: 'sig' })
  assert.deepEqual(v.read('ch_9'), { url: 'https://hooks.example.com/x', signingSecret: 'sig' })
  assert.equal(v.readable(), true)
  await v.remove('ch_9')
  assert.equal(cachedSecret('hyperprox:notify/ch_9'), undefined)
  await lock('manual')
  assert.equal(v.readable(), false)
  assert.equal(v.read('ch_9'), null)
})
