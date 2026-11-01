// The in-memory notifications store keeps the rules the Prisma store keeps, so the dispatcher tests mean something.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryNotifyStore, type NewOutbox } from '../src/lib/notify/store'

const T0 = new Date('2026-11-02T12:00:00Z')
const at = (s: number) => new Date(T0.getTime() + s * 1000)
const row = (over: Partial<NewOutbox> = {}): NewOutbox => ({
  eventId: 'e', channelId: 'c1', type: 't', severity: 'warning', fingerprint: null, resolved: false,
  payload: { id: 'e', type: 't', severity: 'warning', resolved: false, title: 'x', lines: [], link: null, linkLabel: 'Open', hint: '', at: T0.toISOString() },
  status: 'queued', createdAt: T0, nextAttemptAt: T0, ...over,
})

test('due rows by status and time: queued once due, held always, finished never', async () => {
  const s = new MemoryNotifyStore()
  await s.addOutbox([row(), row({ nextAttemptAt: at(60) }), row({ status: 'held-quiet' }), row({ status: 'held-locked' }), row({ status: 'sent' }), row({ status: 'failed' })])
  assert.equal((await s.pendingOutbox(T0)).length, 3)
  assert.equal((await s.pendingOutbox(at(60))).length, 4)
})

test('sent rows per channel since a time', async () => {
  const s = new MemoryNotifyStore()
  await s.addOutbox([row({ status: 'sent', sentAt: at(0) }), row({ status: 'sent', sentAt: at(100) }), row({ status: 'sent', sentAt: at(100), channelId: 'c2' })])
  assert.equal((await s.sentSince('c1', at(50))).length, 1)
  assert.equal((await s.sentSince('c2', at(0))).length, 1)
})

test('prune drops finished history past the cut-off, never what is still waiting', async () => {
  const s = new MemoryNotifyStore()
  await s.addOutbox([row({ status: 'sent', createdAt: at(0) }), row({ status: 'held-locked', createdAt: at(0) }), row({ status: 'sent', createdAt: at(1000) })])
  assert.equal(await s.pruneOutbox(at(500)), 1)
  assert.deepEqual(s.outbox.map(r => r.status), ['held-locked', 'sent'])
})

test('channels: create, update, delete; state round-trips', async () => {
  const s = new MemoryNotifyStore()
  await s.createChannel({ id: 'c1', name: 'A', kind: 'ntfy', enabled: true, minSeverity: 'warning', eventFilter: 'all', quietHours: null,
    lanOverride: false, usableWhileLocked: false, nonSecret: {}, seededFrom: null, createdBy: 'x' })
  await assert.rejects(s.createChannel({ ...(await s.getChannel('c1'))! }), /exists/)
  assert.equal((await s.updateChannel('c1', { name: 'B' })).name, 'B')
  await s.deleteChannel('c1')
  assert.equal(await s.getChannel('c1'), null)
  await s.setState('k', { a: 1 })
  assert.deepEqual(await s.getState('k'), { a: 1 })
})
