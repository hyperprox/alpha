// =============================================================================
//  HyperProx — Proxy instances: persistence
//  Instances (no secrets) in Postgres; their secrets in the vault, one item per
//  instance (hyperprox:proxy-instance/<id>). Tests use the in-memory store and
//  the in-memory secrets, which keep the same rules.
// =============================================================================

import { Prisma, type PrismaClient } from '@prisma/client'
import { deleteProviderCredentials, getProviderCredentials, setCredentials } from '../credentials'
import type { ManagedRef, ProxyInstance, ProxyKind, InstanceMode } from './types'

export type StoredInstance = Omit<ProxyInstance, 'legacy'>
export type InstancePatch = Partial<Pick<StoredInstance, 'name' | 'url' | 'mode' | 'managed' | 'settings'>>

export interface ProxyStore {
  list(): Promise<StoredInstance[]>
  get(id: string): Promise<StoredInstance | null>
  create(i: Omit<StoredInstance, 'createdAt' | 'updatedAt'>): Promise<StoredInstance>
  update(id: string, patch: InstancePatch): Promise<StoredInstance>
  remove(id: string): Promise<void>
  audit(action: string, resource: string, details?: Record<string, unknown>): Promise<void>
}

const clone = <T>(v: T): T => structuredClone(v)

export class MemoryProxyStore implements ProxyStore {
  rows = new Map<string, StoredInstance>()
  audits: Array<{ action: string; resource: string; details?: Record<string, unknown> }> = []
  async list() { return [...this.rows.values()].map(clone).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) }
  async get(id: string) { const r = this.rows.get(id); return r ? clone(r) : null }
  async create(i: Omit<StoredInstance, 'createdAt' | 'updatedAt'>) {
    if (this.rows.has(i.id)) throw new Error(`proxy instance ${i.id} exists`)
    const now = new Date().toISOString()
    const row = { ...clone(i), createdAt: now, updatedAt: now }
    this.rows.set(i.id, row)
    return clone(row)
  }
  async update(id: string, patch: InstancePatch) {
    const r = this.rows.get(id)
    if (!r) throw new Error(`no proxy instance ${id}`)
    Object.assign(r, clone(patch), { updatedAt: new Date().toISOString() })
    return clone(r)
  }
  async remove(id: string) { this.rows.delete(id) }
  async audit(action: string, resource: string, details?: Record<string, unknown>) { this.audits.push({ action, resource, details }) }
}

type Row = { id: string; kind: string; name: string; url: string; mode: string; managed: unknown; settings: unknown; createdBy: string; createdAt: Date; updatedAt: Date }

function fromRow(r: Row): StoredInstance {
  return {
    id: r.id, kind: r.kind as ProxyKind, name: r.name, url: r.url, mode: r.mode as InstanceMode,
    managed: (r.managed as ManagedRef | null) ?? null, settings: (r.settings as Record<string, string>) ?? {},
    createdBy: r.createdBy, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  }
}

export class PrismaProxyStore implements ProxyStore {
  constructor(private db: PrismaClient) {}
  private get t(): any { return (this.db as any).proxyInstance }
  async list() { return ((await this.t.findMany({ orderBy: { createdAt: 'asc' } })) as Row[]).map(fromRow) }
  async get(id: string) { const r = await this.t.findUnique({ where: { id } }); return r ? fromRow(r) : null }
  async create(i: Omit<StoredInstance, 'createdAt' | 'updatedAt'>) {
    return fromRow(await this.t.create({ data: { id: i.id, kind: i.kind, name: i.name, url: i.url, mode: i.mode,
      managed: i.managed ?? undefined, settings: i.settings, createdBy: i.createdBy } }))
  }
  async update(id: string, patch: InstancePatch) {
    const data: any = { ...patch }
    if ('managed' in patch && patch.managed === null) data.managed = Prisma.DbNull
    return fromRow(await this.t.update({ where: { id }, data }))
  }
  async remove(id: string) { await this.t.delete({ where: { id } }).catch(() => undefined) }
  async audit(action: string, resource: string, details?: Record<string, unknown>) {
    await (this.db as any).auditLog.create({ data: { action, resource, details: details ?? {} } }).catch(() => undefined)
  }
}

// --- secrets -------------------------------------------------------------------------------------------

export const SECRET_CATEGORY = 'proxy-instance'

export interface InstanceSecrets {
  get(id: string): Promise<Record<string, string>>
  /** Merge these keys into the instance's item (one vault write). */
  set(id: string, values: Record<string, string>): Promise<void>
  remove(id: string): Promise<void>
}

export const vaultInstanceSecrets: InstanceSecrets = {
  get: id => getProviderCredentials(SECRET_CATEGORY, id),
  set: (id, values) => setCredentials(SECRET_CATEGORY, id, values),
  remove: id => deleteProviderCredentials(SECRET_CATEGORY, id),
}

export class MemoryInstanceSecrets implements InstanceSecrets {
  items = new Map<string, Record<string, string>>()
  locked = false
  private up() { if (this.locked) throw new Error('HyperProx is locked') }
  async get(id: string) { this.up(); return { ...(this.items.get(id) ?? {}) } }
  async set(id: string, values: Record<string, string>) { this.up(); this.items.set(id, { ...(this.items.get(id) ?? {}), ...values }) }
  async remove(id: string) { this.up(); this.items.delete(id) }
}
