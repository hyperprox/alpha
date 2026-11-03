// =============================================================================
//  HyperProx — Remote access: what HyperProx installed where
//
//  One row per machine and provider. Nothing here is secret: device ids,
//  overlay addresses and the routes HyperProx turned on. Keys are never stored
//  at all. Production uses Prisma; tests use the in-memory store.
// =============================================================================

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
  connected:  boolean | null
  checkedAt:  Date | null
  lastError:  string | null
  installedAt: Date
  updatedAt:  Date
}

export type RemoteRecordInput = Omit<RemoteRecord, 'installedAt' | 'updatedAt'>

export interface RemoteStore {
  list(): Promise<RemoteRecord[]>
  get(machineId: string, provider: ProviderId): Promise<RemoteRecord | null>
  upsert(r: RemoteRecordInput): Promise<RemoteRecord>
  remove(machineId: string, provider: ProviderId): Promise<void>
  audit(action: string, resource: string, details: Record<string, unknown>): Promise<void>
}

export class MemoryRemoteStore implements RemoteStore {
  private rows = new Map<string, RemoteRecord>()
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
  async audit(action: string, resource: string, details: Record<string, unknown>) { this.audits.push({ action, resource, details }) }
}

export class PrismaRemoteStore implements RemoteStore {
  constructor(private readonly db: PrismaClient) {}
  private get t() { return (this.db as any).remoteAccessDevice }

  private static row(x: any): RemoteRecord {
    return {
      machineId: x.machineId, provider: x.provider, deviceId: x.deviceId, nodeKey: x.nodeKey, hostname: x.hostname,
      address: x.address, mode: x.mode === 'userspace' ? 'userspace' : 'kernel', version: x.version,
      routes: x.routes ?? [], exitNode: !!x.exitNode, routeIds: x.routeIds ?? [], connected: x.connected,
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
}
