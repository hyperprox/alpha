// =============================================================================
//  HyperProx — Remote access: persistence
//
//  Three tables, none holding a secret:
//    RemoteAccessDevice         what HyperProx installed or adopted where
//    RemoteAccessPendingRevoke  every key that has left HyperProx and is not yet confirmed revoked (key id only)
//    RemoteAccessInflight       a change on a node that has started and not yet passed its guard
//  The last two are what make a restart safe: a sweep revokes what is left and re-runs the guard's
//  after-check on any node change a restart cut off.
// =============================================================================

import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import type { ProviderId } from './types'
import type { NetMode } from './scripts'

export interface RemoteRecord {
  machineId:  string
  provider:   ProviderId
  deviceId:   string | null
  nodeKey:    string | null
  hostname:   string | null
  address:    string | null
  mode:       NetMode
  version:    string | null
  routes:     string[]
  exitNode:   boolean
  /** NetBird route ids HyperProx created, so turning routing off removes exactly those. */
  routeIds:   string[]
  /** The client was already there and HyperProx only recorded it. */
  adopted:    boolean
  /** A guest's forwarding before HyperProx turned routing on, "v4:v6", restored when it goes off. */
  forwardingBefore: string | null
  connected:  boolean | null
  checkedAt:  Date | null
  lastError:  string | null
  installedAt: Date
  updatedAt:  Date
}

export type RemoteRecordInput = Omit<RemoteRecord, 'installedAt' | 'updatedAt'>

export interface PendingRevoke {
  id: string; provider: ProviderId; keyId: string; revokeAfter: Date; reason: string
  attempts: number; lastError: string | null; createdAt: Date
}

export interface Inflight {
  id: string; machineId: string; provider: ProviderId; action: string; jobId: string; by: string
  /** The process that started it; another process finding it means that one is gone. */
  owner: string
  before: unknown; undo: unknown; startedAt: Date
}

export interface RemoteStore {
  list(): Promise<RemoteRecord[]>
  get(machineId: string, provider: ProviderId): Promise<RemoteRecord | null>
  upsert(r: RemoteRecordInput): Promise<RemoteRecord>
  remove(machineId: string, provider: ProviderId): Promise<void>
  audit(action: string, resource: string, details: Record<string, unknown>): Promise<void>

  addPendingRevoke(r: { provider: ProviderId; keyId: string; revokeAfter: Date; reason: string }): Promise<string>
  listPendingRevokes(): Promise<PendingRevoke[]>
  removePendingRevoke(id: string): Promise<void>
  notePendingRevokeFailure(id: string, error: string): Promise<void>

  addInflight(r: Omit<Inflight, 'id' | 'startedAt'>): Promise<string>
  updateInflightUndo(id: string, undo: unknown): Promise<void>
  listInflight(): Promise<Inflight[]>
  removeInflight(id: string): Promise<void>
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))

export class MemoryRemoteStore implements RemoteStore {
  private rows = new Map<string, RemoteRecord>()
  readonly pending = new Map<string, PendingRevoke>()
  readonly inflight = new Map<string, Inflight>()
  readonly audits: Array<{ action: string; resource: string; details: Record<string, any> }> = []
  private key(m: string, p: string) { return `${m}|${p}` }

  async list() { return [...this.rows.values()].map(r => ({ ...r })) }
  async get(m: string, p: ProviderId) { const r = this.rows.get(this.key(m, p)); return r ? { ...r } : null }
  async upsert(r: RemoteRecordInput) {
    const prev = this.rows.get(this.key(r.machineId, r.provider))
    const row: RemoteRecord = { ...r, installedAt: prev?.installedAt ?? new Date(), updatedAt: new Date() }
    this.rows.set(this.key(r.machineId, r.provider), row)
    return { ...row }
  }
  async remove(m: string, p: ProviderId) { this.rows.delete(this.key(m, p)) }
  async audit(action: string, resource: string, details: Record<string, unknown>) { this.audits.push({ action, resource, details: clone(details) }) }

  async addPendingRevoke(r: { provider: ProviderId; keyId: string; revokeAfter: Date; reason: string }) {
    const id = randomUUID()
    this.pending.set(id, { id, ...r, attempts: 0, lastError: null, createdAt: new Date() })
    return id
  }
  async listPendingRevokes() { return [...this.pending.values()].map(p => ({ ...p })) }
  async removePendingRevoke(id: string) { this.pending.delete(id) }
  async notePendingRevokeFailure(id: string, error: string) {
    const p = this.pending.get(id)
    if (p) { p.attempts++; p.lastError = error }
  }

  async addInflight(r: Omit<Inflight, 'id' | 'startedAt'>) {
    const id = randomUUID()
    this.inflight.set(id, { ...clone(r), id, startedAt: new Date() })
    return id
  }
  async updateInflightUndo(id: string, undo: unknown) { const x = this.inflight.get(id); if (x) x.undo = clone(undo) }
  async listInflight() { return [...this.inflight.values()].map(x => clone(x)) }
  async removeInflight(id: string) { this.inflight.delete(id) }
}

export class PrismaRemoteStore implements RemoteStore {
  constructor(private readonly db: PrismaClient) {}
  private get t() { return (this.db as any).remoteAccessDevice }
  private get pr() { return (this.db as any).remoteAccessPendingRevoke }
  private get inf() { return (this.db as any).remoteAccessInflight }

  private static row(x: any): RemoteRecord {
    return {
      machineId: x.machineId, provider: x.provider, deviceId: x.deviceId, nodeKey: x.nodeKey, hostname: x.hostname,
      address: x.address, mode: x.mode === 'userspace' ? 'userspace' : 'kernel', version: x.version,
      routes: x.routes ?? [], exitNode: !!x.exitNode, routeIds: x.routeIds ?? [], adopted: !!x.adopted,
      forwardingBefore: x.forwardingBefore ?? null, connected: x.connected,
      checkedAt: x.checkedAt, lastError: x.lastError, installedAt: x.installedAt, updatedAt: x.updatedAt,
    }
  }

  async list() { return (await this.t.findMany({ orderBy: { machineId: 'asc' } })).map(PrismaRemoteStore.row) }
  async get(machineId: string, provider: ProviderId) {
    const x = await this.t.findUnique({ where: { machineId_provider: { machineId, provider } } })
    return x ? PrismaRemoteStore.row(x) : null
  }
  async upsert(r: RemoteRecordInput) {
    const x = await this.t.upsert({
      where: { machineId_provider: { machineId: r.machineId, provider: r.provider } },
      create: { ...r }, update: { ...r },
    })
    return PrismaRemoteStore.row(x)
  }
  async remove(machineId: string, provider: ProviderId) { await this.t.deleteMany({ where: { machineId, provider } }) }
  async audit(action: string, resource: string, details: Record<string, unknown>) {
    await this.db.auditLog.create({ data: { action, resource, details: details as any } })
  }

  async addPendingRevoke(r: { provider: ProviderId; keyId: string; revokeAfter: Date; reason: string }) {
    return String((await this.pr.create({ data: { ...r } })).id)
  }
  async listPendingRevokes() { return (await this.pr.findMany({ orderBy: { revokeAfter: 'asc' } })) as PendingRevoke[] }
  async removePendingRevoke(id: string) { await this.pr.deleteMany({ where: { id } }) }
  async notePendingRevokeFailure(id: string, error: string) {
    await this.pr.updateMany({ where: { id }, data: { attempts: { increment: 1 }, lastError: error.slice(0, 500) } })
  }

  async addInflight(r: Omit<Inflight, 'id' | 'startedAt'>) {
    return String((await this.inf.create({ data: { ...r, before: r.before as any, undo: r.undo as any } })).id)
  }
  async updateInflightUndo(id: string, undo: unknown) { await this.inf.updateMany({ where: { id }, data: { undo: undo as any } }) }
  async listInflight() { return (await this.inf.findMany({ orderBy: { startedAt: 'asc' } })) as Inflight[] }
  async removeInflight(id: string) { await this.inf.deleteMany({ where: { id } }) }
}
