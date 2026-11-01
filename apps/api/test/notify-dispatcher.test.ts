// The bus and the dispatcher: who gets an event, when, how often, and what happens when a send fails.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NotifyCore, inQuietHours } from '../src/lib/notify/dispatcher'
import { MemoryNotifyStore } from '../src/lib/notify/store'
import { ChannelSecrets, LockedChannelsFile, type SecretBackend } from '../src/lib/notify/secrets'
import type { ChannelRecord, OutboundRequest, SendOutcome, NotifyEventInput } from '../src/lib/notify/types'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-disp-'))
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }))
const T0 = new Date('2026-11-02T12:00:00Z')   // a Monday, 12:00 UTC
const sec = (s: number) => new Date(T0.getTime() + s * 1000)

function vault(): SecretBackend & { items: Map<string, any>; open: boolean } {
  const items = new Map<string, any>()
  const v = {
    items, open: true,
    readable: () => v.open,
    read: (id: string) => (v.open ? items.get(id) ?? null : null),
    write: async (id: string, s: any) => { items.set(id, s) },
    remove: async (id: string) => { items.delete(id) },
  }
  return v
}

let n = 0
function rig(opts: { answer?: (req: OutboundRequest) => SendOutcome } = {}) {
  const store = new MemoryNotifyStore()
  const v = vault()
  const secrets = new ChannelSecrets(v, new LockedChannelsFile(path.join(dir, `f${n++}.json`)))
  const sent: Array<{ url: string; body: any }> = []
  let now = T0
  const core = new NotifyCore({
    store, secrets, publicUrl: () => 'https://hyperprox.example.com', now: () => now, log: () => undefined, autoKick: false,
    transport: async req => { sent.push({ url: req.url, body: JSON.parse(req.body) }); return opts.answer?.(req) ?? { ok: true, status: 204 } },
  })
  async function channel(id: string, over: Partial<ChannelRecord> = {}) {
    const c = await store.createChannel({
      id, name: id, kind: 'webhook', enabled: true, minSeverity: 'info', eventFilter: 'all', quietHours: null, lanOverride: false,
      usableWhileLocked: false, nonSecret: {}, seededFrom: null, createdBy: 'test', ...over,
    })
    await secrets.put(c, { url: `https://hooks.example.com/${id}` })
    return c
  }
  const at = (d: Date) => { now = d }
  const ev = (over: Partial<NotifyEventInput> = {}): NotifyEventInput => ({ type: 'certs.verdict.changed', severity: 'warning', title: 'A thing', ...over })
  const to = (id: string) => sent.filter(s => s.url.endsWith(`/${id}`))
  return { store, v, secrets, core, sent, channel, at, ev, to }
}

test('severity and family filters decide who gets an event', async () => {
  const r = rig()
  await r.channel('all')
  await r.channel('crit', { minSeverity: 'critical' })
  await r.channel('upd', { eventFilter: ['updates'] })
  await r.channel('off', { enabled: false })
  await r.core.publish(r.ev({ type: 'updates.job.finished', severity: 'info', title: 'Updates finished' }))
  await r.core.tick()
  assert.deepEqual(r.sent.map(s => s.url.split('/').pop()).sort(), ['all', 'upd'])
  await r.core.publish(r.ev({ type: 'certs.verdict.changed', severity: 'critical', title: 'Cert expired' }))
  r.at(sec(120)); await r.core.tick()
  assert.deepEqual(r.to('crit').map(s => s.body.title), ['Cert expired'])
  assert.equal(r.to('upd').length, 1, 'certs is not in its filter')
})

test('quiet hours hold a warning and digest it at the end; critical breaks through', async () => {
  const r = rig()
  await r.channel('q', { quietHours: { start: '11:00', end: '13:00', tz: 'UTC', criticalBreaksThrough: true } })
  await r.core.publish(r.ev({ title: 'Disk filling' }))
  await r.core.tick()
  assert.equal(r.sent.length, 0)
  assert.equal(r.store.outbox[0].status, 'held-quiet')
  await r.core.publish(r.ev({ severity: 'critical', title: 'Node offline' }))
  await r.core.tick()
  assert.deepEqual(r.sent.map(s => s.body.title), ['Node offline'])
  r.at(sec(3600 + 60))   // 13:01
  await r.core.tick()
  assert.equal(r.sent.length, 2)
  assert.match(r.sent[1].body.title, /1 alert held during quiet hours/)
  assert.deepEqual(r.sent[1].body.lines, ['Warning: Disk filling'])
  r.at(sec(7200)); await r.core.tick()
  assert.equal(r.sent.length, 2, 'the digest is sent once')
})

test('fired and resolved inside quiet hours: nothing left to say, so nothing is sent', async () => {
  const r = rig()
  await r.channel('q', { quietHours: { start: '11:00', end: '13:00', tz: 'UTC', criticalBreaksThrough: true } })
  await r.core.publish(r.ev({ title: 'Disk filling', fingerprint: 'disk:a' }))
  await r.core.tick()
  await r.core.publish(r.ev({ title: 'Disk filling', fingerprint: 'disk:a', resolved: true }))
  r.at(sec(3700)); await r.core.tick()
  assert.equal(r.sent.length, 0)
  assert.deepEqual(r.store.outbox.map(o => o.status), ['dropped', 'dropped'])
})

test('quiet hours across midnight and on chosen days', () => {
  const q = { start: '22:00', end: '07:00', tz: 'UTC', criticalBreaksThrough: true }
  assert.equal(inQuietHours(q, new Date('2026-11-02T23:30:00Z')), true)
  assert.equal(inQuietHours(q, new Date('2026-11-02T06:59:00Z')), true)
  assert.equal(inQuietHours(q, new Date('2026-11-02T07:00:00Z')), false)
  // Days are the day the window starts: Sunday night into Monday morning counts as Sunday.
  assert.equal(inQuietHours({ ...q, days: [0] }, new Date('2026-11-02T05:00:00Z')), true)
  assert.equal(inQuietHours({ ...q, days: [1] }, new Date('2026-11-02T05:00:00Z')), false)
  assert.equal(inQuietHours({ ...q, start: '09:00', end: '09:00' }, new Date('2026-11-02T09:00:00Z')), false)
})

test('events close together are grouped into one message', async () => {
  const r = rig()
  await r.channel('g')
  await r.core.publish(r.ev({ title: 'First' }))
  await r.core.tick()
  for (const t of ['Second', 'Third', 'Fourth']) await r.core.publish(r.ev({ title: t }))
  r.at(sec(10)); await r.core.tick()
  assert.equal(r.sent.length, 1, 'held for the grouping window')
  r.at(sec(61)); await r.core.tick()
  assert.equal(r.sent.length, 2)
  assert.equal(r.sent[1].body.title, '3 new alerts')
  assert.deepEqual(r.sent[1].body.lines, ['Second', 'Third', 'Fourth'])
})

test('20 events in a short time: at most 6 messages plus one "many alerts" message', async () => {
  const r = rig()
  await r.channel('b')
  for (let i = 0; i < 20; i++) {
    r.at(sec(i * 25))
    await r.core.publish(r.ev({ title: `Alert ${i}` }))
    await r.core.tick()
  }
  r.at(sec(599)); await r.core.tick()
  const brakes = r.sent.filter(s => /Many alerts at once/.test(s.body.title))
  assert.equal(brakes.length, 1)
  assert.ok(r.sent.length - brakes.length <= 6, `${r.sent.length} sent`)
  // The window clears; the channel works again.
  r.at(sec(1300)); await r.core.publish(r.ev({ title: 'Later' })); await r.core.tick()
  assert.equal(r.sent.at(-1)!.body.title, 'Later')
})

test('retries: 10 s, 1 min, 5 min, then failed and the channel is marked failing', async () => {
  let calls = 0
  const r = rig({ answer: req => { if (req.url.endsWith('/flaky')) { calls++; return { ok: false, code: 'ECONNREFUSED' } } return { ok: true, status: 200 } } })
  await r.channel('flaky')
  await r.channel('other')
  await r.core.publish(r.ev({ title: 'X', type: 'updates.job.finished' }))
  await r.core.tick()
  assert.equal(calls, 1)
  const row = () => r.store.outbox.find(o => o.channelId === 'flaky')!
  assert.equal(row().nextAttemptAt.getTime(), sec(10).getTime())
  r.at(sec(10)); await r.core.tick(); assert.equal(calls, 2)
  assert.equal(row().nextAttemptAt.getTime(), sec(70).getTime())
  r.at(sec(70)); await r.core.tick(); assert.equal(calls, 3)
  assert.equal(row().nextAttemptAt.getTime(), sec(370).getTime())
  r.at(sec(370)); await r.core.tick(); assert.equal(calls, 4)
  assert.equal(row().status, 'failed')
  assert.equal(row().errorCode, 'ECONNREFUSED')
  const ch = (await r.store.getChannel('flaky'))!
  assert.ok(ch.failingSince)
  assert.equal(ch.lastResult?.code, 'ECONNREFUSED')
  // A broken channel is not told about itself; the others are.
  r.at(sec(500)); await r.core.tick()
  const told = r.to('other').filter(s => s.body.type === 'notify.channel.failing')
  assert.equal(told.length, 1)
  assert.match(told[0].body.title, /flaky/)
  assert.equal(r.to('flaky').filter(s => s.body.type === 'notify.channel.failing').length, 0)
})

test('429 honours Retry-After; another 4xx fails at once with no retry', async () => {
  let n429 = 0
  const r = rig({ answer: req => {
    if (req.url.endsWith('/limited')) return ++n429 === 1 ? { ok: false, status: 429, retryAfterSec: 30 } : { ok: true, status: 204 }
    if (req.url.endsWith('/gone')) return { ok: false, status: 404 }
    return { ok: true, status: 204 }
  } })
  await r.channel('limited'); await r.channel('gone')
  await r.core.publish(r.ev())
  await r.core.tick()
  const lim = () => r.store.outbox.find(o => o.channelId === 'limited')!
  assert.equal(lim().nextAttemptAt.getTime(), sec(30).getTime())
  const gone = r.store.outbox.find(o => o.channelId === 'gone')!
  assert.equal(gone.status, 'failed'); assert.equal(gone.httpStatus, 404)
  r.at(sec(30)); await r.core.tick()
  assert.equal(lim().status, 'sent')
  assert.equal(r.to('gone').length, 1, 'tried once')
})

test('a redirect or a blocked address is a failure, not a retry', async () => {
  const r = rig({ answer: () => ({ ok: false, status: 302, code: 'redirect' }) })
  await r.channel('r')
  await r.core.publish(r.ev())
  await r.core.tick()
  assert.equal(r.store.outbox[0].status, 'failed')
  assert.equal(r.store.outbox[0].errorCode, 'redirect')
})

test('held while locked for vault-only channels; one digest on unlock; older than 24 h dropped', async () => {
  const r = rig()
  await r.channel('vaulted')
  await r.channel('lockedok', { usableWhileLocked: true })
  r.v.open = false
  await r.core.publish(r.ev({ title: 'Old one' }))
  await r.core.tick()
  assert.deepEqual(r.sent.map(s => s.url.split('/').pop()), ['lockedok'], 'the usable-while-locked channel still gets it')
  r.at(sec(25 * 3600))
  await r.core.publish(r.ev({ title: 'Disk filling' }))
  await r.core.publish(r.ev({ title: 'Backup failed', severity: 'critical' }))
  await r.core.tick()
  assert.deepEqual(r.store.outbox.filter(o => o.channelId === 'vaulted').map(o => o.status), ['dropped', 'held-locked', 'held-locked'])
  r.v.open = true
  await r.core.tick()
  const d = r.to('vaulted')
  assert.equal(d.length, 1)
  assert.match(d[0].body.title, /2 alerts while HyperProx was locked/)
  assert.deepEqual(d[0].body.lines, ['Critical: Backup failed', 'Warning: Disk filling'])
})

test('a new dispatcher on the same store picks up what the old one had queued (API restart)', async () => {
  const r = rig({ answer: () => ({ ok: false, code: 'ETIMEDOUT' }) })
  await r.channel('w')
  await r.core.publish(r.ev({ title: 'Survives' }))
  await r.core.tick()
  const sent: string[] = []
  const again = new NotifyCore({
    store: r.store, secrets: r.secrets, publicUrl: () => undefined, now: () => sec(11), log: () => undefined, autoKick: false,
    transport: async req => { sent.push(JSON.parse(req.body).title); return { ok: true, status: 200 } },
  })
  await again.tick()
  assert.deepEqual(sent, ['Survives'])
  assert.equal(r.store.outbox[0].status, 'sent')
})

test('publishing never throws, even with the database down', async () => {
  const r = rig()
  await r.channel('x')
  r.store.down = true
  await r.core.publish(r.ev())
  await r.core.tick()
  assert.equal(r.sent.length, 0)
})
