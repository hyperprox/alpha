// Private channels and sensitive links: a sign-in URL goes only to channels marked private, is never stored
// in the outbox, and is not sent once it has expired.
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
      usableWhileLocked: false, private: false, nonSecret: {}, seededFrom: null, createdBy: 'test', ...over,
    })
    await secrets.put(c, { url: `https://hooks.example.com/${id}` })
    return c
  }
  const at = (d: Date) => { now = d }
  const ev = (over: Partial<NotifyEventInput> = {}): NotifyEventInput => ({ type: 'certs.verdict.changed', severity: 'warning', title: 'A thing', ...over })
  const to = (id: string) => sent.filter(s => s.url.endsWith(`/${id}`))
  return { store, v, secrets, core, sent, channel, at, ev, to }
}

const URL_ = 'https://login.tailscale.com/a/abc123def456'

test('a sensitive link goes only to private channels, and never into the outbox', async () => {
  const r = rig()
  await r.channel('team')
  await r.channel('mine', { private: true })
  await r.core.publish(r.ev({ type: 'vpn.login.needed', severity: 'warning', title: 'web needs a Tailscale sign-in', sensitiveLink: URL_, sensitiveUntil: sec(600) }))
  assert.equal(JSON.stringify(await r.store.pendingOutbox(sec(1))).includes('abc123def456'), false, 'not in the stored rows')
  await r.core.tick()
  assert.equal(r.to('team').length, 0)
  assert.equal(r.to('mine').length, 1)
  assert.match(JSON.stringify(r.to('mine')[0].body), /abc123def456/)
  const all = await r.store.listOutbox({ limit: 100 })
  assert.doesNotMatch(JSON.stringify(all), /abc123def456/)
})

test('an ordinary event still reaches every channel, private or not', async () => {
  const r = rig()
  await r.channel('team')
  await r.channel('mine', { private: true })
  await r.core.publish(r.ev({ type: 'vpn.device.new', severity: 'info', title: 'New device' }))
  await r.core.tick()
  assert.equal(r.to('team').length, 1)
  assert.equal(r.to('mine').length, 1)
})

test('a sensitive link that has expired, or was lost in a restart, is not sent; the message says so', async () => {
  const r = rig()
  await r.channel('mine', { private: true, quietHours: { start: '11:00', end: '13:00', tz: 'UTC', criticalBreaksThrough: false } })
  await r.core.publish(r.ev({ type: 'vpn.login.needed', severity: 'warning', title: 'web needs a sign-in', sensitiveLink: URL_, sensitiveUntil: sec(600) }))
  await r.core.tick()
  assert.equal(r.to('mine').length, 0, 'held for quiet hours')
  r.at(new Date('2026-11-02T13:30:00Z'))
  await r.core.tick()
  assert.equal(r.to('mine').length, 1)
  const body = JSON.stringify(r.to('mine')[0].body)
  assert.doesNotMatch(body, /abc123def456/)
  assert.match(body, /expired/i)
})

test('a sensitive event is never grouped into a digest with others', async () => {
  const r = rig()
  await r.channel('mine', { private: true })
  await r.core.publish(r.ev({ title: 'first' }))
  await r.core.tick()
  r.at(sec(5))
  await r.core.publish(r.ev({ title: 'second' }))
  await r.core.publish(r.ev({ type: 'vpn.login.needed', title: 'sign in', sensitiveLink: URL_, sensitiveUntil: sec(600) }))
  r.at(sec(70))
  await r.core.tick()
  const bodies = r.to('mine').map(s => JSON.stringify(s.body))
  assert.ok(bodies.some(b => /abc123def456/.test(b) && !/second/.test(b)), 'sent on its own')
})
