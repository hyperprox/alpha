// =============================================================================
//  HyperProx — Certificates: persistence
//
//  Metadata only. Keys and certificate PEMs are in the vault (see service.ts);
//  nothing here is secret, so a database dump never carries a private key.
//
//  One issuance per label at a time is enforced by the database, not by a flag
//  in this process: beginIssue is a conditional update on the row's status, so
//  two requests racing for the same label cannot both see "not renewing".
//  Production uses Prisma; tests use the in-memory store, which keeps the same
//  rule.
// =============================================================================

import type { PrismaClient } from '@prisma/client'
import type { CertsEvent, CertsManaged, CertsProbe } from './types'

export type ManagedStatus = CertsManaged['status']

export interface ManagedRecord {
  id:          string
  label:       string
  names:       string[]
  status:      ManagedStatus
  issuer:      string | null
  serial:      string | null
  fingerprint: string | null
  notBefore:   Date | null
  notAfter:    Date | null
  ariStart:    Date | null
  ariEnd:      Date | null
  renewAfter:  Date | null
  staging:     boolean
  lastError:   string | null
  issuedAt:    Date | null
  updatedAt:   Date
}

export interface TargetRecord {
  name:         string
  kind:         string
  lastDeployAt: Date | null
  ok:           boolean | null
  detail:       string | null
  fingerprint:  string | null
}

export interface ProbeRecord {
  host:        string
  port:        number
  starttls:    CertsProbe['starttls']
  source:      CertsProbe['source']
  internal:    boolean
  checkedAt:   Date | null
  verdict:     CertsProbe['verdict'] | null
  reason:      string | null
  fingerprint: string | null
  issuer:      string | null
  notAfter:    Date | null
  trusted:     boolean | null
  namesMatch:  boolean | null
}

export interface EventRecord {
  id:     string
  label:  string | null
  kind:   CertsEvent['kind']
  ok:     boolean
  detail: string
  at:     Date
}

export type ManagedPatch = Partial<Omit<ManagedRecord, 'id' | 'label' | 'updatedAt'>>

export class RenewingError extends Error {
  constructor(public label: string) {
    super(`Certificate ${label} is already being issued`)
    this.name = 'RenewingError'
  }
}

export interface CertsStore {
  listManaged(): Promise<ManagedRecord[]>
  getManaged(label: string): Promise<ManagedRecord | null>
  /**
   * Mark `label` renewing, creating its row on first issuance. Throws RenewingError when it
   * already is. Clears lastError: the attempt now running is the one that matters.
   */
  beginIssue(label: string, names: string[]): Promise<ManagedRecord>
  updateManaged(label: string, patch: ManagedPatch): Promise<ManagedRecord>
  /** A restart ends every issuance in flight; their rows are released as failed. Returns the labels. */
  recoverInterrupted(reason: string): Promise<string[]>

  listTargets(label: string): Promise<TargetRecord[]>
  setTarget(label: string, target: TargetRecord): Promise<void>

  listProbes(): Promise<ProbeRecord[]>
  upsertProbe(p: ProbeRecord): Promise<void>
  /** A full probe run: keep exactly these endpoints, so ones no longer discovered drop off the page. */
  replaceProbes(list: ProbeRecord[]): Promise<void>

  addEvent(e: Omit<EventRecord, 'id' | 'at'>): Promise<EventRecord>
  listEvents(label: string | undefined, limit: number): Promise<EventRecord[]>

  getState<T>(key: string): Promise<T | null>
  setState(key: string, value: unknown): Promise<void>

  audit(action: string, resource: string, details?: Record<string, unknown>): Promise<void>
}

// --- Shapes for the API ------------------------------------------------------------------

export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)

export function probeView(p: ProbeRecord): CertsProbe {
  return {
    host: p.host, port: p.port, starttls: p.starttls, source: p.source, internal: p.internal,
    checkedAt: iso(p.checkedAt), verdict: p.verdict ?? 'unknown', reason: p.reason,
    fingerprint: p.fingerprint, issuer: p.issuer, notAfter: iso(p.notAfter),
    trusted: p.trusted, namesMatch: p.namesMatch,
  }
}

export function eventView(e: EventRecord): CertsEvent {
  return { id: e.id, label: e.label, kind: e.kind, ok: e.ok, detail: e.detail, at: e.at.toISOString() }
}

// --- In memory ------------------------------------------------------------------------------

let counter = 0
const newId = (p: string) => `${p}${Date.now().toString(36)}${(++counter).toString(36).padStart(4, '0')}`
const probeKey = (host: string, port: number) => `${host.toLowerCase()}:${port}`

function blankManaged(label: string, names: string[]): ManagedRecord {
  return {
    id: newId('crt'), label, names: [...names], status: 'pending', issuer: null, serial: null, fingerprint: null,
    notBefore: null, notAfter: null, ariStart: null, ariEnd: null, renewAfter: null, staging: false,
    lastError: null, issuedAt: null, updatedAt: new Date(),
  }
}

export class MemoryCertsStore implements CertsStore {
  managed = new Map<string, ManagedRecord>()
  targets = new Map<string, Map<string, TargetRecord>>()
  probes = new Map<string, ProbeRecord>()
  events: EventRecord[] = []
  state = new Map<string, unknown>()
  audits: Array<{ action: string; resource: string; details?: Record<string, unknown> }> = []

  async listManaged() { return [...this.managed.values()].sort((a, b) => a.label.localeCompare(b.label)).map(r => ({ ...r })) }
  async getManaged(label: string) { const r = this.managed.get(label); return r ? { ...r } : null }
  async beginIssue(label: string, names: string[]) {
    const r = this.managed.get(label) ?? blankManaged(label, names)
    if (r.status === 'renewing') throw new RenewingError(label)
    Object.assign(r, { status: 'renewing', names: [...names], lastError: null, updatedAt: new Date() })
    this.managed.set(label, r)
    return { ...r }
  }
  async updateManaged(label: string, patch: ManagedPatch) {
    const r = this.managed.get(label)
    if (!r) throw new Error(`no managed certificate ${label}`)
    Object.assign(r, patch, { updatedAt: new Date() })
    return { ...r }
  }
  async recoverInterrupted(reason: string) {
    const out: string[] = []
    for (const r of this.managed.values()) {
      if (r.status !== 'renewing') continue
      Object.assign(r, { status: 'failed', lastError: reason, updatedAt: new Date() })
      out.push(r.label)
    }
    return out
  }
  async listTargets(label: string) { return [...(this.targets.get(label)?.values() ?? [])].map(t => ({ ...t })) }
  async setTarget(label: string, t: TargetRecord) {
    if (!this.managed.has(label)) throw new Error(`no managed certificate ${label}`)
    let m = this.targets.get(label)
    if (!m) { m = new Map(); this.targets.set(label, m) }
    m.set(t.name, { ...t })
  }
  async listProbes() {
    return [...this.probes.values()].sort((a, b) => a.host.localeCompare(b.host) || a.port - b.port).map(p => ({ ...p }))
  }
  async upsertProbe(p: ProbeRecord) { this.probes.set(probeKey(p.host, p.port), { ...p }) }
  async replaceProbes(list: ProbeRecord[]) {
    this.probes = new Map(list.map(p => [probeKey(p.host, p.port), { ...p }]))
  }
  async addEvent(e: Omit<EventRecord, 'id' | 'at'>) {
    const r: EventRecord = { ...e, id: newId('evt'), at: new Date() }
    this.events.push(r)
    return { ...r }
  }
  async listEvents(label: string | undefined, limit: number) {
    return this.events.filter(e => label === undefined || e.label === label)
      .sort((a, b) => b.at.getTime() - a.at.getTime() || b.id.localeCompare(a.id))
      .slice(0, limit).map(e => ({ ...e }))
  }
  async getState<T>(key: string) { return this.state.has(key) ? structuredClone(this.state.get(key)) as T : null }
  async setState(key: string, value: unknown) { this.state.set(key, structuredClone(value)) }
  async audit(action: string, resource: string, details?: Record<string, unknown>) { this.audits.push({ action, resource, details }) }
}

// --- Prisma -----------------------------------------------------------------------------------

function toManaged(r: any): ManagedRecord {
  return {
    id: r.id, label: r.label, names: [...(r.names ?? [])], status: r.status,
    issuer: r.issuer ?? null, serial: r.serial ?? null, fingerprint: r.fingerprint ?? null,
    notBefore: r.notBefore ?? null, notAfter: r.notAfter ?? null, ariStart: r.ariStart ?? null, ariEnd: r.ariEnd ?? null,
    renewAfter: r.renewAfter ?? null, staging: !!r.staging, lastError: r.lastError ?? null, issuedAt: r.issuedAt ?? null,
    updatedAt: r.updatedAt,
  }
}

function toTarget(r: any): TargetRecord {
  return { name: r.name, kind: r.kind, lastDeployAt: r.lastDeployAt ?? null, ok: r.ok ?? null, detail: r.detail ?? null, fingerprint: r.fingerprint ?? null }
}

function toProbe(r: any): ProbeRecord {
  return {
    host: r.host, port: r.port, starttls: r.starttls, source: r.source, internal: !!r.internal,
    checkedAt: r.checkedAt ?? null, verdict: r.verdict ?? null, reason: r.reason ?? null,
    fingerprint: r.fingerprint ?? null, issuer: r.issuer ?? null, notAfter: r.notAfter ?? null,
    trusted: r.trusted ?? null, namesMatch: r.namesMatch ?? null,
  }
}

function toEvent(r: any): EventRecord {
  return { id: r.id, label: r.label ?? null, kind: r.kind, ok: r.ok, detail: r.detail, at: r.at }
}

export class PrismaCertsStore implements CertsStore {
  constructor(private db: PrismaClient) {}

  async listManaged() {
    return (await this.db.managedCertificate.findMany({ orderBy: { label: 'asc' } })).map(toManaged)
  }
  async getManaged(label: string) {
    const r = await this.db.managedCertificate.findUnique({ where: { label } })
    return r ? toManaged(r) : null
  }
  async beginIssue(label: string, names: string[]) {
    const r = await this.db.managedCertificate.updateMany({
      where: { label, status: { not: 'renewing' } },
      data: { status: 'renewing', names, lastError: null },
    })
    if (r.count === 1) return (await this.getManaged(label))!
    if (await this.db.managedCertificate.findUnique({ where: { label } })) throw new RenewingError(label)
    try {
      return toManaged(await this.db.managedCertificate.create({ data: { label, names, status: 'renewing' } }))
    } catch (e: any) {
      // Another request created the row between our two reads, and so holds the issuance.
      if (e?.code === 'P2002') throw new RenewingError(label)
      throw e
    }
  }
  async updateManaged(label: string, patch: ManagedPatch) {
    return toManaged(await this.db.managedCertificate.update({ where: { label }, data: patch as any }))
  }
  async recoverInterrupted(reason: string) {
    const rows = await this.db.managedCertificate.findMany({ where: { status: 'renewing' }, select: { label: true } })
    if (rows.length) {
      await this.db.managedCertificate.updateMany({ where: { status: 'renewing' }, data: { status: 'failed', lastError: reason } })
    }
    return rows.map(r => r.label)
  }
  async listTargets(label: string) {
    const cert = await this.db.managedCertificate.findUnique({ where: { label }, include: { targets: { orderBy: { name: 'asc' } } } })
    return (cert?.targets ?? []).map(toTarget)
  }
  async setTarget(label: string, t: TargetRecord) {
    const cert = await this.db.managedCertificate.findUnique({ where: { label }, select: { id: true } })
    if (!cert) throw new Error(`no managed certificate ${label}`)
    const data = { kind: t.kind, lastDeployAt: t.lastDeployAt, ok: t.ok, detail: t.detail, fingerprint: t.fingerprint }
    await this.db.certTarget.upsert({
      where: { certId_name: { certId: cert.id, name: t.name } },
      create: { certId: cert.id, name: t.name, ...data },
      update: data,
    })
  }
  async listProbes() {
    return (await this.db.certProbe.findMany({ orderBy: [{ host: 'asc' }, { port: 'asc' }] })).map(toProbe)
  }
  async upsertProbe(p: ProbeRecord) {
    const { host, port, ...rest } = p
    await this.db.certProbe.upsert({ where: { host_port: { host, port } }, create: { host, port, ...rest }, update: rest })
  }
  async replaceProbes(list: ProbeRecord[]) {
    await this.db.$transaction(async tx => {
      const keep = list.map(p => ({ host: p.host, port: p.port }))
      await tx.certProbe.deleteMany({ where: keep.length ? { NOT: { OR: keep } } : {} })
      for (const p of list) {
        const { host, port, ...rest } = p
        await tx.certProbe.upsert({ where: { host_port: { host, port } }, create: { host, port, ...rest }, update: rest })
      }
    })
  }
  async addEvent(e: Omit<EventRecord, 'id' | 'at'>) {
    const cert = e.label ? await this.db.managedCertificate.findUnique({ where: { label: e.label }, select: { id: true } }) : null
    return toEvent(await this.db.certEvent.create({ data: { ...e, certId: cert?.id ?? null } }))
  }
  async listEvents(label: string | undefined, limit: number) {
    return (await this.db.certEvent.findMany({
      where: label === undefined ? {} : { label }, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: limit,
    })).map(toEvent)
  }
  async getState<T>(key: string) {
    const r = await this.db.certState.findUnique({ where: { id: key } })
    return r ? (r.value as T) : null
  }
  async setState(key: string, value: unknown) {
    await this.db.certState.upsert({ where: { id: key }, create: { id: key, value: value as any }, update: { value: value as any } })
  }
  async audit(action: string, resource: string, details?: Record<string, unknown>) {
    await this.db.auditLog.create({ data: { action, resource, details: (details ?? undefined) as any } })
  }
}
