// =============================================================================
//  HyperProx — Notifications: persistence
//
//  Channels (no secrets), the outbox (one row per event per channel, which is
//  also the delivery history), and a few named values (what has been seeded).
//  The outbox is what makes delivery survive an API restart: queued and
//  retrying rows are simply picked up again. Production uses Prisma; tests use
//  the in-memory store, which keeps the same rules.
// =============================================================================

import crypto from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import type { ChannelRecord, OutboxRecord, OutboxStatus } from './types'

export type NewChannel = Omit<ChannelRecord, 'createdAt' | 'updatedAt' | 'lastResult' | 'lastSentAt' | 'failingSince'> &
  Partial<Pick<ChannelRecord, 'lastResult' | 'lastSentAt' | 'failingSince'>>
export type ChannelPatch = Partial<Omit<ChannelRecord, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'>>
export type NewOutbox = Omit<OutboxRecord, 'id' | 'attempts' | 'httpStatus' | 'errorCode' | 'sentAt' | 'createdAt' | 'nextAttemptAt'> &
  Partial<Pick<OutboxRecord, 'attempts' | 'httpStatus' | 'errorCode' | 'sentAt' | 'createdAt' | 'nextAttemptAt'>>
export type OutboxPatch = Partial<Pick<OutboxRecord, 'status' | 'attempts' | 'nextAttemptAt' | 'httpStatus' | 'errorCode' | 'sentAt'>>

export interface NotifyStore {
  listChannels(): Promise<ChannelRecord[]>
  getChannel(id: string): Promise<ChannelRecord | null>
  createChannel(c: NewChannel): Promise<ChannelRecord>
  updateChannel(id: string, patch: ChannelPatch): Promise<ChannelRecord>
  deleteChannel(id: string): Promise<void>

  addOutbox(rows: NewOutbox[]): Promise<OutboxRecord[]>
  /**
   * Rows the dispatcher may act on: queued and due (at most QUEUED_LIMIT, soonest first), and held rows
   * (at most HELD_PER_CHANNEL per channel, oldest first). Fetched apart, so a channel with a pile of held
   * rows can never crowd out what is due for the others.
   */
  pendingOutbox(now: Date): Promise<OutboxRecord[]>
  updateOutbox(ids: string[], patch: OutboxPatch): Promise<void>
  /** Rows actually sent to a channel since `since` (rate brake, grouping window). */
  sentSince(channelId: string, since: Date): Promise<OutboxRecord[]>
  listOutbox(o: { channelId?: string; limit: number }): Promise<OutboxRecord[]>
  pruneOutbox(before: Date): Promise<number>

  getState<T>(key: string): Promise<T | null>
  setState(key: string, value: unknown): Promise<void>
  audit(action: string, resource: string, details?: Record<string, unknown>): Promise<void>
}

const HELD: OutboxStatus[] = ['held-quiet', 'held-locked']
export const QUEUED_LIMIT = 1000
export const HELD_PER_CHANNEL = 200
const clone = <T>(v: T): T => structuredClone(v)

export class MemoryNotifyStore implements NotifyStore {
  channels = new Map<string, ChannelRecord>()
  outbox: OutboxRecord[] = []
  state = new Map<string, unknown>()
  audits: Array<{ action: string; resource: string; details?: Record<string, unknown> }> = []
  /** Tests: make every call fail, as if Postgres were down. */
  down = false

  private up() { if (this.down) throw Object.assign(new Error('database unavailable'), { code: 'P1001' }) }

  async listChannels() { this.up(); return [...this.channels.values()].map(clone).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()) }
  async getChannel(id: string) { this.up(); const c = this.channels.get(id); return c ? clone(c) : null }
  async createChannel(c: NewChannel) {
    this.up()
    if (this.channels.has(c.id)) throw new Error(`channel ${c.id} exists`)
    const now = new Date()
    const row: ChannelRecord = { lastResult: null, lastSentAt: null, failingSince: null, ...clone(c), createdAt: now, updatedAt: now }
    this.channels.set(c.id, row)
    return clone(row)
  }
  async updateChannel(id: string, patch: ChannelPatch) {
    this.up()
    const c = this.channels.get(id)
    if (!c) throw new Error(`no channel ${id}`)
    Object.assign(c, clone(patch), { updatedAt: new Date() })
    return clone(c)
  }
  async deleteChannel(id: string) { this.up(); this.channels.delete(id) }

  async addOutbox(rows: NewOutbox[]) {
    this.up()
    const now = new Date()
    const made = rows.map(r => ({
      id: crypto.randomUUID(), attempts: 0, httpStatus: null, errorCode: null, sentAt: null, createdAt: now, nextAttemptAt: now, ...clone(r),
    }) as OutboxRecord)
    this.outbox.push(...made)
    return made.map(clone)
  }
  async pendingOutbox(now: Date) {
    this.up()
    const queued = this.outbox.filter(r => r.status === 'queued' && r.nextAttemptAt <= now)
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime()).slice(0, QUEUED_LIMIT)
    const held = new Map<string, OutboxRecord[]>()
    for (const r of [...this.outbox].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
      if (!HELD.includes(r.status)) continue
      const l = held.get(r.channelId) ?? []
      if (l.length < HELD_PER_CHANNEL) { l.push(r); held.set(r.channelId, l) }
    }
    return [...queued, ...[...held.values()].flat()].map(clone)
  }
  async updateOutbox(ids: string[], patch: OutboxPatch) {
    this.up()
    const set = new Set(ids)
    for (const r of this.outbox) if (set.has(r.id)) Object.assign(r, clone(patch))
  }
  async sentSince(channelId: string, since: Date) {
    this.up()
    return this.outbox.filter(r => r.channelId === channelId && r.status === 'sent' && r.sentAt && r.sentAt >= since).map(clone)
  }
  async listOutbox(o: { channelId?: string; limit: number }) {
    this.up()
    return this.outbox.filter(r => !o.channelId || r.channelId === o.channelId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, o.limit).map(clone)
  }
  async pruneOutbox(before: Date) {
    this.up()
    const n = this.outbox.length
    this.outbox = this.outbox.filter(r => r.createdAt >= before || r.status === 'queued' || HELD.includes(r.status))
    return n - this.outbox.length
  }
  async getState<T>(key: string) { this.up(); return (this.state.has(key) ? clone(this.state.get(key)) : null) as T | null }
  async setState(key: string, value: unknown) { this.up(); this.state.set(key, clone(value)) }
  async audit(action: string, resource: string, details?: Record<string, unknown>) { this.up(); this.audits.push({ action, resource, details }) }
}

// --- Prisma ------------------------------------------------------------------

function channelFrom(r: any): ChannelRecord {
  return {
    id: r.id, name: r.name, kind: r.kind, enabled: r.enabled, minSeverity: r.minSeverity,
    eventFilter: r.eventFilter ?? 'all', quietHours: r.quietHours ?? null, lanOverride: r.lanOverride,
    usableWhileLocked: r.usableWhileLocked, private: !!r.private, nonSecret: r.nonSecret ?? {}, lastResult: r.lastResult ?? null,
    lastSentAt: r.lastSentAt, failingSince: r.failingSince, seededFrom: r.seededFrom, createdBy: r.createdBy,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  }
}

function outboxFrom(r: any): OutboxRecord {
  return {
    id: r.id, eventId: r.eventId, channelId: r.channelId, type: r.type, severity: r.severity, fingerprint: r.fingerprint,
    resolved: r.resolved, payload: r.payload, status: r.status, attempts: r.attempts, nextAttemptAt: r.nextAttemptAt,
    httpStatus: r.httpStatus, errorCode: r.errorCode, createdAt: r.createdAt, sentAt: r.sentAt,
  }
}

const json = (v: unknown) => (v === null || v === undefined ? undefined : (v as any))

export class PrismaNotifyStore implements NotifyStore {
  constructor(private db: PrismaClient) {}
  private get t(): any { return this.db as any }

  async listChannels() { return (await this.t.notifyChannel.findMany({ orderBy: { createdAt: 'asc' } })).map(channelFrom) }
  async getChannel(id: string) { const r = await this.t.notifyChannel.findUnique({ where: { id } }); return r ? channelFrom(r) : null }
  async createChannel(c: NewChannel) {
    return channelFrom(await this.t.notifyChannel.create({ data: {
      id: c.id, name: c.name, kind: c.kind, enabled: c.enabled, minSeverity: c.minSeverity, eventFilter: c.eventFilter as any,
      quietHours: json(c.quietHours), lanOverride: c.lanOverride, usableWhileLocked: c.usableWhileLocked, private: !!c.private, nonSecret: c.nonSecret as any,
      lastResult: json(c.lastResult), lastSentAt: c.lastSentAt ?? null, failingSince: c.failingSince ?? null,
      seededFrom: c.seededFrom, createdBy: c.createdBy,
    } }))
  }
  async updateChannel(id: string, patch: ChannelPatch) {
    const data: any = { ...patch }
    // A JSON column set to null needs Prisma's JsonNull marker.
    for (const k of ['quietHours', 'lastResult'] as const) if (k in patch && patch[k] === null) data[k] = Prisma.JsonNull
    return channelFrom(await this.t.notifyChannel.update({ where: { id }, data }))
  }
  async deleteChannel(id: string) { await this.t.notifyChannel.deleteMany({ where: { id } }) }

  async addOutbox(rows: NewOutbox[]) {
    const made: OutboxRecord[] = []
    for (const r of rows) made.push(outboxFrom(await this.t.notifyOutbox.create({ data: { ...r, payload: r.payload as any } })))
    return made
  }
  async pendingOutbox(now: Date) {
    const queued = await this.t.notifyOutbox.findMany({
      where: { status: 'queued', nextAttemptAt: { lte: now } }, orderBy: { nextAttemptAt: 'asc' }, take: QUEUED_LIMIT,
    })
    const channels: Array<{ channelId: string }> = await this.t.notifyOutbox.findMany({
      where: { status: { in: HELD } }, distinct: ['channelId'], select: { channelId: true },
    })
    const held = await Promise.all(channels.map(c => this.t.notifyOutbox.findMany({
      where: { channelId: c.channelId, status: { in: HELD } }, orderBy: { createdAt: 'asc' }, take: HELD_PER_CHANNEL,
    })))
    return [...queued, ...held.flat()].map(outboxFrom)
  }
  async updateOutbox(ids: string[], patch: OutboxPatch) {
    if (ids.length) await this.t.notifyOutbox.updateMany({ where: { id: { in: ids } }, data: patch })
  }
  async sentSince(channelId: string, since: Date) {
    return (await this.t.notifyOutbox.findMany({ where: { channelId, status: 'sent', sentAt: { gte: since } } })).map(outboxFrom)
  }
  async listOutbox(o: { channelId?: string; limit: number }) {
    return (await this.t.notifyOutbox.findMany({
      where: o.channelId ? { channelId: o.channelId } : {}, orderBy: { createdAt: 'desc' }, take: o.limit,
    })).map(outboxFrom)
  }
  async pruneOutbox(before: Date) {
    const r = await this.t.notifyOutbox.deleteMany({ where: { createdAt: { lt: before }, status: { in: ['sent', 'failed', 'dropped'] } } })
    return r.count
  }
  async getState<T>(key: string) { const r = await this.t.notifyState.findUnique({ where: { id: key } }); return (r ? r.value : null) as T | null }
  async setState(key: string, value: unknown) {
    await this.t.notifyState.upsert({ where: { id: key }, create: { id: key, value: value as any }, update: { value: value as any } })
  }
  async audit(action: string, resource: string, details?: Record<string, unknown>) {
    await this.t.auditLog.create({ data: { action, resource, details: (details ?? undefined) as any } })
  }
}
