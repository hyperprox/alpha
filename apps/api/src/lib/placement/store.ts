// =============================================================================
//  HyperProx — placement advisor: settings and the move history
//
//  Two tables: one settings row, and one row per move (HyperProx's own, and
//  Proxmox migrations seen in the cluster task log, kept so the history outlives
//  the task log). A scheduled move is a row with status "scheduled": it
//  survives a restart, and the scheduler picks it up again on start.
// =============================================================================

import { busyHoursProblems } from './windows'
import { DEFAULT_BWLIMIT_KIB } from './network'
import type { BusyHours, CorosyncCount, MoveRecord, MoveStatus, PlacementSettings } from './types'

export const DEFAULT_SETTINGS: PlacementSettings = {
  avoidBackups: true, backupHours: 3, backupMarginMin: 30, busyHours: [],
  bwlimitKiB: DEFAULT_BWLIMIT_KIB, linkMbps: 1000,
  cpuAbove: 0.8, memAbove: 0.9, minHours: 6, windowHours: 72,
}

const num = (v: unknown, lo: number, hi: number, name: string, problems: string[]): number | undefined => {
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isFinite(n) || n < lo || n > hi) { problems.push(`${name} must be between ${lo} and ${hi}.`); return undefined }
  return n
}

/** A partial update checked field by field; unknown fields are refused, not ignored. */
export function mergeSettings(cur: PlacementSettings, body: unknown): { settings: PlacementSettings; problems: string[] } {
  const problems: string[] = []
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const known = new Set(Object.keys(DEFAULT_SETTINGS))
  for (const k of Object.keys(b)) if (!known.has(k)) problems.push(`Unknown setting: ${k}.`)
  const next: PlacementSettings = { ...cur }
  if (b.avoidBackups !== undefined) next.avoidBackups = b.avoidBackups === true
  const set = <K extends keyof PlacementSettings>(k: K, v: PlacementSettings[K] | undefined) => { if (v !== undefined) next[k] = v }
  set('backupHours', num(b.backupHours, 0.25, 24, 'Backup length (hours)', problems))
  set('backupMarginMin', num(b.backupMarginMin, 0, 240, 'Minutes kept clear before a backup', problems))
  set('bwlimitKiB', num(b.bwlimitKiB, 1024, 10_000_000, 'Bandwidth limit (KiB/s)', problems))
  set('linkMbps', num(b.linkMbps, 10, 400_000, 'Link speed (Mbit/s)', problems))
  set('cpuAbove', num(b.cpuAbove, 0.3, 0.99, 'CPU threshold', problems))
  set('memAbove', num(b.memAbove, 0.3, 0.99, 'Memory threshold', problems))
  set('minHours', num(b.minHours, 0.5, 168, 'Busy hours needed', problems))
  set('windowHours', num(b.windowHours, 6, 336, 'Hours looked back', problems))
  if (b.busyHours !== undefined) {
    if (!Array.isArray(b.busyHours) || b.busyHours.length > 20) problems.push('Busy hours must be a list (at most 20).')
    else {
      const list: BusyHours[] = (b.busyHours as any[]).map(x => ({
        days: Array.isArray(x?.days) ? x.days.map(Number) : [], start: String(x?.start ?? ''), end: String(x?.end ?? ''),
        ...(x?.label ? { label: String(x.label).slice(0, 40) } : {}),
      }))
      problems.push(...busyHoursProblems(list))
      next.busyHours = list
    }
  }
  return { settings: next, problems }
}

export interface NewMove {
  sid: string; name: string; fromNode: string; toNode: string; source: 'hyperprox' | 'proxmox'; method: 'ha' | 'migrate' | null
  status: MoveStatus; upid?: string | null; by?: string | null; scheduledFor?: number | null; startedAt?: number | null; endedAt?: number | null
  error?: string | null; bwlimitKiB?: number | null
}

export interface PlacementStore {
  settings(): Promise<PlacementSettings>
  saveSettings(s: PlacementSettings, by: string): Promise<void>
  create(m: NewMove): Promise<MoveRecord>
  update(id: string, patch: Partial<Omit<MoveRecord, 'id'>>): Promise<MoveRecord | null>
  get(id: string): Promise<MoveRecord | null>
  /** Newest first. */
  list(opts?: { sid?: string; status?: MoveStatus[]; limit?: number }): Promise<MoveRecord[]>
  /** A Proxmox migration from the task log, once per task id. */
  upsertSeen(m: NewMove & { upid: string }): Promise<void>
}

export class MemoryPlacementStore implements PlacementStore {
  s: PlacementSettings = { ...DEFAULT_SETTINGS }
  rows: MoveRecord[] = []
  private n = 0
  async settings() { return { ...this.s } }
  async saveSettings(s: PlacementSettings) { this.s = { ...s } }
  async create(m: NewMove) {
    const r: MoveRecord = {
      id: `mv${++this.n}`, sid: m.sid, name: m.name, fromNode: m.fromNode, toNode: m.toNode, source: m.source, method: m.method,
      status: m.status, upid: m.upid ?? null, by: m.by ?? null, scheduledFor: m.scheduledFor ?? null, startedAt: m.startedAt ?? null,
      endedAt: m.endedAt ?? null, error: m.error ?? null, bwlimitKiB: m.bwlimitKiB ?? null, corosync: null,
    }
    this.rows.push(r)
    return { ...r }
  }
  async update(id: string, patch: Partial<Omit<MoveRecord, 'id'>>) {
    const r = this.rows.find(x => x.id === id)
    if (!r) return null
    Object.assign(r, patch)
    return { ...r }
  }
  async get(id: string) { const r = this.rows.find(x => x.id === id); return r ? { ...r } : null }
  async list(opts: { sid?: string; status?: MoveStatus[]; limit?: number } = {}) {
    return this.rows.filter(r => (!opts.sid || r.sid === opts.sid) && (!opts.status || opts.status.includes(r.status)))
      .sort((a, b) => (b.startedAt ?? b.scheduledFor ?? 0) - (a.startedAt ?? a.scheduledFor ?? 0)).slice(0, opts.limit ?? 200).map(r => ({ ...r }))
  }
  async upsertSeen(m: NewMove & { upid: string }) {
    if (this.rows.some(r => r.upid === m.upid)) return
    await this.create(m)
  }
}

const ms = (d: Date | null | undefined) => (d ? d.getTime() : null)
const dt = (n: number | null | undefined) => (n ? new Date(n) : null)

function fromRow(r: any): MoveRecord {
  return {
    id: r.id, sid: r.sid, name: r.name, fromNode: r.fromNode, toNode: r.toNode, source: r.source, method: r.method ?? null,
    status: r.status, upid: r.upid ?? null, by: r.by ?? null, scheduledFor: ms(r.scheduledFor), startedAt: ms(r.startedAt),
    endedAt: ms(r.endedAt), error: r.error ?? null, bwlimitKiB: r.bwlimitKiB ?? null, corosync: (r.corosync ?? null) as CorosyncCount | null,
  }
}

function toData(p: Partial<Omit<MoveRecord, 'id'>>): Record<string, unknown> {
  const d: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(p)) {
    if (k === 'scheduledFor' || k === 'startedAt' || k === 'endedAt') d[k] = dt(v as number | null)
    else if (k === 'corosync') d[k] = v ?? undefined
    else d[k] = v
  }
  return d
}

export function prismaPlacementStore(db: any): PlacementStore {
  return {
    async settings() {
      // Before the migration has run (or with no database) the defaults apply: reading must never fail the page.
      let row: any = null
      try { row = await db.placementSettings.findUnique({ where: { id: 'singleton' } }) } catch { row = null }
      return { ...DEFAULT_SETTINGS, ...((row?.data ?? {}) as Partial<PlacementSettings>) }
    },
    async saveSettings(s, by) {
      await db.placementSettings.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', data: s as any, updatedBy: by }, update: { data: s as any, updatedBy: by } })
    },
    async create(m) {
      return fromRow(await db.placementMove.create({ data: toData({ ...m, corosync: null } as any) }))
    },
    async update(id, patch) {
      const r = await db.placementMove.update({ where: { id }, data: toData(patch) }).catch(() => null)
      return r ? fromRow(r) : null
    },
    async get(id) { const r = await db.placementMove.findUnique({ where: { id } }); return r ? fromRow(r) : null },
    async list(opts = {}) {
      const rows = await db.placementMove.findMany({
        where: { ...(opts.sid ? { sid: opts.sid } : {}), ...(opts.status ? { status: { in: opts.status } } : {}) },
        orderBy: [{ startedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }], take: opts.limit ?? 200,
      })
      return rows.map(fromRow)
    },
    async upsertSeen(m) {
      await db.placementMove.upsert({ where: { upid: m.upid }, create: toData({ ...m, corosync: null } as any), update: {} })
    },
  }
}
