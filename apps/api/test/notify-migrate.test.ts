// Moving the lock alert, the Updates webhook and the Certificates webhook onto channels, once each,
// without anything that alerts today going quiet, and without a secret leaking anywhere on the way.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NotifyService } from '../src/lib/notify/service'
import { MemoryNotifyStore } from '../src/lib/notify/store'
import { ChannelSecrets, LockedChannelsFile, type SecretBackend } from '../src/lib/notify/secrets'
import { SEED_IDS } from '../src/lib/notify/migrate'
import { sendLockAlert, resetLockAlertForTests } from '../src/lib/vault/lock-alert'
import type { OutboundRequest } from '../src/lib/notify/types'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-mig-'))
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }))

const LOCK_URL = 'https://ntfy.example.com/lock-topic-x1'
const LOCK_TOKEN = 'tk_lock_token_value'
const UPD_URL = 'https://discord.com/api/webhooks/111/upd-secret-abc'
const CERT_URL = 'https://hooks.example.com/certs-secret-def'

function vault(): SecretBackend & { items: Map<string, any>; open: boolean } {
  const items = new Map<string, any>()
  const v = {
    items, open: true,
    readable: () => v.open,
    read: (id: string) => (v.open ? items.get(id) ?? null : null),
    write: async (id: string, s: any) => { items.set(id, { ...s }) },
    remove: async (id: string) => { items.delete(id) },
  }
  return v
}

let n = 0
function rig(o: { env?: Record<string, string>; updates?: string; certs?: string; store?: MemoryNotifyStore; file?: string } = {}) {
  const store = o.store ?? new MemoryNotifyStore()
  const v = vault()
  const file = new LockedChannelsFile(o.file ?? path.join(dir, `l${n++}.json`))
  const secrets = new ChannelSecrets(v, file)
  const sent: OutboundRequest[] = []
  const logs: string[] = []
  const legacy = { updatesUrl: () => o.updates, certsUrl: () => o.certs }
  const svc = new NotifyService({
    store, secrets, legacy, env: o.env ?? {}, publicUrl: () => 'https://hyperprox.example.com',
    transport: async req => { sent.push(req); return { ok: true, status: 204 } },
    isPrivate: async () => false, log: m => logs.push(m), autoKick: false, tickMs: 0,
  })
  return { store, v, file, secrets, svc, sent, logs, legacy }
}

test('the lock channel is seeded once from LOCK_ALERT_*, usable while locked, vault events only', async () => {
  const r = rig({ env: { LOCK_ALERT_URL: LOCK_URL, LOCK_ALERT_TOKEN: LOCK_TOKEN } })
  await r.svc.start()
  const f = r.file.read()
  assert.ok(f.seeded.lockAlert)
  const e = f.channels[SEED_IDS.lock]
  assert.equal(e.kind, 'ntfy'); assert.deepEqual(e.secret, { url: LOCK_URL, token: LOCK_TOKEN })
  assert.equal(e.minSeverity, 'critical'); assert.deepEqual(e.eventFilter, ['vault'])
  const row = await r.store.getChannel(SEED_IDS.lock)
  assert.equal(row?.usableWhileLocked, true); assert.equal(row?.seededFrom, 'lock-alert')
  assert.equal(r.v.items.size, 0, 'never in the vault')
  // Again: nothing new, even with a different address in .env now.
  const again = rig({ env: { LOCK_ALERT_URL: 'https://ntfy.example.com/other' }, store: r.store, file: r.file.path })
  await again.svc.start()
  assert.equal(Object.keys(again.file.read().channels).length, 1)
  assert.equal(again.file.read().channels[SEED_IDS.lock].secret.url, LOCK_URL)
  assert.equal((await r.store.listChannels()).length, 1)
  assert.ok(again.logs.some(l => /LOCK_ALERT_URL in \.env is no longer read/.test(l)))
})

test('with no LOCK_ALERT_URL, the YAML webhook the lock alert fell back to is seeded the same way', async () => {
  const r = rig({ updates: UPD_URL })
  await r.svc.start()
  const e = r.file.read().channels[SEED_IDS.lock]
  assert.equal(e.kind, 'discord'); assert.equal(e.secret.url, UPD_URL)
})

test('seeded while Postgres is down: the row is created once it is back', async () => {
  const store = new MemoryNotifyStore()
  store.down = true
  const r = rig({ env: { LOCK_ALERT_URL: LOCK_URL }, store })
  await r.svc.start()
  assert.ok(r.file.read().channels[SEED_IDS.lock])
  store.down = false
  await r.svc.seedOnOwnerUnlock()
  assert.ok(await store.getChannel(SEED_IDS.lock))
})

test('an idle lock with Postgres down reaches the seeded channel, and no vault-only channel', async () => {
  const r = rig({ env: { LOCK_ALERT_URL: LOCK_URL, LOCK_ALERT_TOKEN: LOCK_TOKEN } })
  await r.svc.start()
  await r.svc.createChannel({ name: 'Team chat', kind: 'webhook', url: 'https://hooks.example.com/team', minSeverity: 'info' }, { email: 'a@example.com', role: 'admin' })
  r.v.open = false
  r.store.down = true
  resetLockAlertForTests()
  const res = await sendLockAlert('idle', { notify: r.svc, log: { info: () => undefined, warn: () => undefined } })
  assert.equal(res, 'sent')
  assert.equal(r.sent.length, 1)
  assert.equal(r.sent[0].url, LOCK_URL)
  assert.equal(r.sent[0].headers.Authorization, `Bearer ${LOCK_TOKEN}`)
  assert.equal(r.sent[0].headers.Title, 'HyperProx is locked')
  assert.match(r.sent[0].headers.Click, /\/login\?locked=1&reason=idle$/)
})

test('owner unlock seeds Updates and Certificates once; one URL behind both is one channel', async () => {
  const r = rig({ updates: CERT_URL, certs: CERT_URL })
  await r.svc.start()
  // The lock alert fell back to the same address, so it is already a (locked) channel: it gains both families.
  await r.svc.seedOnOwnerUnlock()
  const all = await r.store.listChannels()
  assert.equal(all.length, 1)
  assert.deepEqual(all[0].eventFilter, ['vault', 'updates', 'certs'])
  assert.equal(all[0].minSeverity, 'info')
  assert.equal(r.file.read().channels[all[0].id].minSeverity, 'info', 'the locked copy follows')
  await r.svc.seedOnOwnerUnlock()
  assert.equal((await r.store.listChannels()).length, 1, 'idempotent')

  // An Updates run and a certificate change: exactly one message each.
  await r.svc.publish({ type: 'updates.job.finished', severity: 'info', title: 'Updates finished' })
  await r.svc.core.tick()
  await r.svc.publish({ type: 'certs.verdict.changed', severity: 'warning', title: 'Certificate problem' })
  // Past the grouping window, so each is its own message.
  const later = new Date(Date.now() + 61_000)
  const svc2 = new NotifyService({
    store: r.store, secrets: r.secrets, legacy: r.legacy, env: {}, transport: async req => { r.sent.push(req); return { ok: true, status: 204 } },
    isPrivate: async () => false, now: () => later, autoKick: false, tickMs: 0,
  })
  await svc2.core.tick()
  const titles = r.sent.map(q => JSON.parse(q.body).title)
  assert.deepEqual(titles, ['Updates finished', 'Certificate problem'])
})

test('separate URLs: an Updates channel (info) and a Certificates channel (warning), secrets in the vault', async () => {
  const r = rig({ updates: UPD_URL, certs: CERT_URL, env: { LOCK_ALERT_URL: LOCK_URL } })
  await r.svc.start()
  await r.svc.seedOnOwnerUnlock()
  const byId = new Map((await r.store.listChannels()).map(c => [c.id, c]))
  assert.deepEqual([...byId.keys()].sort(), [SEED_IDS.certs, SEED_IDS.lock, SEED_IDS.updates].sort())
  assert.equal(byId.get(SEED_IDS.updates)!.minSeverity, 'info')
  assert.deepEqual(byId.get(SEED_IDS.updates)!.eventFilter, ['updates'])
  assert.equal(byId.get(SEED_IDS.certs)!.minSeverity, 'warning')
  assert.equal(byId.get(SEED_IDS.updates)!.usableWhileLocked, false)
  assert.equal(r.v.items.get(SEED_IDS.updates).url, UPD_URL)
  assert.equal(r.v.items.get(SEED_IDS.certs).url, CERT_URL)
  assert.ok(r.logs.some(l => /notify\.webhook_url in config\/updates\.yaml is now the channel "Updates reports"/.test(l)))
})

test('until seeded, the old YAML settings still deliver; after, they are ignored', async () => {
  const r = rig({ updates: UPD_URL, env: { LOCK_ALERT_URL: LOCK_URL } })
  await r.svc.start()
  await r.svc.publish({ type: 'updates.job.finished', severity: 'info', title: 'Before the seed' })
  await r.svc.core.tick()
  assert.deepEqual(r.sent.map(q => q.url), [UPD_URL])
  assert.equal(JSON.parse(r.sent[0].body).embeds[0].title, 'Before the seed')
  await r.svc.publish({ type: 'certs.verdict.changed', severity: 'critical', title: 'Not an updates event' })
  await r.svc.core.tick()
  assert.equal(r.sent.length, 1, 'the legacy Updates channel only takes updates events')

  await r.svc.seedOnOwnerUnlock()
  const ch = await r.store.getChannel(SEED_IDS.updates)
  assert.ok(ch)
  await r.svc.publish({ type: 'updates.job.finished', severity: 'info', title: 'After the seed' })
  const later = new Date(Date.now() + 61_000)
  const svc2 = new NotifyService({
    store: r.store, secrets: r.secrets, legacy: r.legacy, env: {}, transport: async req => { r.sent.push(req); return { ok: true, status: 204 } },
    isPrivate: async () => false, now: () => later, autoKick: false, tickMs: 0,
  })
  await svc2.core.tick()
  assert.equal(r.sent.length, 2, 'once, through the seeded channel, not also through the YAML')
})

test('no log line, outbox row or audit entry contains a channel URL or token', async () => {
  const r = rig({ updates: UPD_URL, certs: CERT_URL, env: { LOCK_ALERT_URL: LOCK_URL, LOCK_ALERT_TOKEN: LOCK_TOKEN } })
  await r.svc.start()
  await r.svc.seedOnOwnerUnlock()
  const c = await r.svc.createChannel({ name: 'Bot', kind: 'telegram', botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWX', chatId: '-100123' }, { email: 'o@example.com', role: 'owner' })
  await r.svc.testChannel(c.id, { email: 'o@example.com', role: 'owner' })
  await r.svc.publish({ type: 'certs.verdict.changed', severity: 'critical', title: `Leak ${CERT_URL}`, lines: [`token=${LOCK_TOKEN}`] })
  await r.svc.core.tick()
  resetLockAlertForTests()
  await sendLockAlert('idle', { notify: r.svc })
  await new Promise(res => setTimeout(res, 20))
  const views = JSON.stringify(await r.svc.listChannels()) + JSON.stringify(await r.svc.deliveries(undefined, 200))
  const dump = JSON.stringify([...r.store.channels.values()]) + JSON.stringify(r.store.outbox) + JSON.stringify(r.store.audits) +
    JSON.stringify([...r.store.state.values()]) + r.logs.join('\n') + views
  for (const s of [LOCK_URL, LOCK_TOKEN, UPD_URL, CERT_URL, 'lock-topic-x1', 'upd-secret-abc', 'certs-secret-def', '123456:ABCDEFGHIJKLMNOPQRSTUVWX']) {
    assert.equal(dump.includes(s), false, `found ${s}`)
  }
})
