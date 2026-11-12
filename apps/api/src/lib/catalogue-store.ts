// =============================================================================
//  HyperProx — what the install wizard keeps across an API restart
//
//  Previews, install jobs, the "this ID is being created" marks and the websites made. One small
//  table, one row per thing, the thing itself as JSON. A restart used to drop
//  all three, which left a container that was mid-install with nobody able to
//  clean it up. Production uses Prisma; tests use the in-memory store.
// =============================================================================

import type { PrismaClient } from '@prisma/client'

export type WizardKind = 'preview' | 'job' | 'creating' | 'site' | 'setting'

export interface WizardRecord {
  id:        string
  kind:      WizardKind
  owner:     string
  data:      any
  expiresAt: Date | null
}

export interface WizardStore {
  put(r: WizardRecord): Promise<void>
  get(id: string): Promise<WizardRecord | null>
  list(kind: WizardKind): Promise<WizardRecord[]>
  delete(id: string): Promise<void>
  count(kind: WizardKind): Promise<number>
  /** Delete rows whose expiresAt is before `now`; returns how many. */
  pruneExpired(now: Date): Promise<number>
}

const clone = <T>(v: T): T => structuredClone(v)

export class MemoryWizardStore implements WizardStore {
  rows = new Map<string, WizardRecord>()
  /** Tests: fail every call, as if Postgres were down. */
  down = false
  private up() { if (this.down) throw new Error('database unavailable') }
  async put(r: WizardRecord) { this.up(); this.rows.set(r.id, clone(r)) }
  async get(id: string) { this.up(); const r = this.rows.get(id); return r ? clone(r) : null }
  async list(kind: WizardKind) { this.up(); return [...this.rows.values()].filter(r => r.kind === kind).map(clone) }
  async delete(id: string) { this.up(); this.rows.delete(id) }
  async count(kind: WizardKind) { this.up(); return [...this.rows.values()].filter(r => r.kind === kind).length }
  async pruneExpired(now: Date) {
    this.up()
    let n = 0
    for (const [k, r] of this.rows) if (r.expiresAt && r.expiresAt < now) { this.rows.delete(k); n++ }
    return n
  }
}

export class PrismaWizardStore implements WizardStore {
  constructor(private db: PrismaClient) {}
  private row = (r: any): WizardRecord => ({ id: r.id, kind: r.kind, owner: r.owner, data: r.data, expiresAt: r.expiresAt ?? null })
  async put(r: WizardRecord) {
    const v = { kind: r.kind, owner: r.owner, data: r.data, expiresAt: r.expiresAt }
    await this.db.catalogueRecord.upsert({ where: { id: r.id }, create: { id: r.id, ...v }, update: v })
  }
  async get(id: string) { const r = await this.db.catalogueRecord.findUnique({ where: { id } }); return r ? this.row(r) : null }
  async list(kind: WizardKind) { return (await this.db.catalogueRecord.findMany({ where: { kind } })).map(this.row) }
  async delete(id: string) { await this.db.catalogueRecord.deleteMany({ where: { id } }) }
  async count(kind: WizardKind) { return this.db.catalogueRecord.count({ where: { kind } }) }
  async pruneExpired(now: Date) { return (await this.db.catalogueRecord.deleteMany({ where: { expiresAt: { lt: now } } })).count }
}

let store: WizardStore = new MemoryWizardStore()
export function setWizardStore(s: WizardStore): void { store = s }
export function wizardStore(): WizardStore { return store }
