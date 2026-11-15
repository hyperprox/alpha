// =============================================================================
//  HyperProx — load balancing: settings, the move history and the plans
//
//  Three tables: the settings rows (the settings, and automatic balancing's own
//  row), one row per move (HyperProx's own, and Proxmox migrations seen in the
//  cluster task log, kept so the history outlives the task log), and one row
//  per balancing plan with its steps. A scheduled move or plan is a row with
//  status "scheduled": it survives a restart, and the scheduler picks it up
//  again on start. At most one move and one plan run at a time (partial unique
//  indexes in the database).
// =============================================================================

import { busyHoursProblems } from './windows'
import { DEFAULT_BWLIMIT_KIB } from './network'
import type { AutoSettings, AutoState, BalanceGoal, BusyHours, CorosyncCount, MoveRecord, MoveSnapshot, MoveStatus, PlacementSettings, PlanRecord, PlanSnapshot, PlanStatus, PlanStepRecord } from './types'

export const DEFAULT_SETTINGS: PlacementSettings = {
  avoidBackups: true, backupHours: 3, backupMarginMin: 30, busyHours: [],
  bwlimitKiB: DEFAULT_BWLIMIT_KIB, linkMbps: 1000,
  cpuAbove: 0.8, memAbove: 0.9, minHours: 6, windowHours: 72,
  balanceGoal: 'both', unevenAbove: 0.25, minGain: 3, maxPlanMoves: 5,
}

/** Automatic balancing is off until someone turns it on, and only notifies until "apply automatically" is re-confirmed. */
export const DEFAULT_AUTO: AutoSettings = { enabled: false, apply: false, sustainHours: 6, checkEveryMin: 60, maxMovesPerDay: 2, minHoursBetween: 6 }
export const EMPTY_AUTO_STATE: AutoState = { approver: null, cephBaseline: null, lastCheckAt: null, lastWhy: null, lastNotifiedAt: null, lastNotifiedSig: null, lastMoveAt: null }
const GOALS: BalanceGoal[] = ['mem', 'cpu', 'both']

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
  if (b.balanceGoal !== undefined) {
    if (GOALS.includes(b.balanceGoal as BalanceGoal)) next.balanceGoal = b.balanceGoal as BalanceGoal
    else problems.push('Balance by must be mem, cpu or both.')
  }
  set('unevenAbove', num(b.unevenAbove, 0.05, 0.9, 'Uneven above (spread)', problems))
  set('minGain', num(b.minGain, 0.5, 50, 'Smallest gain worth a move (points)', problems))
  const moves = num(b.maxPlanMoves, 1, 10, 'Moves in one plan', problems)
  if (moves !== undefined) next.maxPlanMoves = Math.round(moves)
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

/**
 * The settings a scheduled move runs under: the stricter of what was approved and what is set now, so a change made
 * after approval can only make the move safer. Busy hours are joined, the larger backup margin and length are kept,
 * backups are avoided if either says so, and the lower bandwidth and link speed are used (the slower estimate).
 */
export function stricterSettings(approved: Partial<PlacementSettings> | undefined, current: PlacementSettings): PlacementSettings {
  const a: PlacementSettings = { ...DEFAULT_SETTINGS, ...(approved ?? {}) }
  const key = (b: BusyHours) => JSON.stringify([[...b.days].sort(), b.start, b.end])
  const busy = [...a.busyHours, ...current.busyHours].filter((b, i, all) => all.findIndex(x => key(x) === key(b)) === i)
  return {
    ...current,
    avoidBackups: a.avoidBackups || current.avoidBackups,
    backupMarginMin: Math.max(a.backupMarginMin, current.backupMarginMin),
    backupHours: Math.max(a.backupHours, current.backupHours),
    busyHours: busy,
    bwlimitKiB: Math.min(a.bwlimitKiB, current.bwlimitKiB),
    linkMbps: Math.min(a.linkMbps, current.linkMbps),
    cpuAbove: Math.min(a.cpuAbove, current.cpuAbove),
    memAbove: Math.min(a.memAbove, current.memAbove),
  }
}

/** Automatic balancing's settings, checked field by field; unknown fields are refused. */
export function mergeAuto(cur: AutoSettings, body: unknown): { settings: AutoSettings; problems: string[] } {
  const problems: string[] = []
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const known = new Set(Object.keys(DEFAULT_AUTO))
  for (const k of Object.keys(b)) if (!known.has(k)) problems.push(`Unknown setting: ${k}.`)
  const next: AutoSettings = { ...cur }
  for (const k of ['enabled', 'apply'] as const) {
    if (b[k] === undefined) continue
    if (typeof b[k] !== 'boolean') problems.push(`${k} must be true or false.`)
    else next[k] = b[k] as boolean
  }
  const set = <K extends keyof AutoSettings>(k: K, v: number | undefined, int = false) => { if (v !== undefined) (next as any)[k] = int ? Math.round(v) : v }
  set('sustainHours', num(b.sustainHours, 1, 72, 'Uneven for at least (hours)', problems))
  set('checkEveryMin', num(b.checkEveryMin, 15, 1440, 'Check every (minutes)', problems), true)
  set('maxMovesPerDay', num(b.maxMovesPerDay, 1, 10, 'Moves per day', problems), true)
  set('minHoursBetween', num(b.minHoursBetween, 0.5, 48, 'Hours between moves', problems))
  // Applying needs automatic balancing on.
  if (next.apply && !next.enabled) next.apply = false
  return { settings: next, problems }
}

export interface NewPlan {
  source: 'manual' | 'auto'; status: PlanStatus; by: string | null; goal: BalanceGoal; scoreBefore: number; scoreTarget: number
  steps: PlanStepRecord[]; scheduledFor?: number | null; startedAt?: number | null; owner?: string | null; heartbeatAt?: number | null
  snapshot?: PlanSnapshot | null
}

/** Another plan is already running (the database refused a second running row). */
export class PlanSlotTaken extends Error { constructor() { super('Another balancing plan is running. One at a time: wait for it, or stop it.') } }

export interface PlanWhere { status: PlanStatus[]; owner?: string; heartbeatBefore?: number }

export interface NewMove {
  sid: string; name: string; fromNode: string; toNode: string; source: 'hyperprox' | 'proxmox'; method: 'ha' | 'migrate' | null
  status: MoveStatus; upid?: string | null; by?: string | null; scheduledFor?: number | null; startedAt?: number | null; endedAt?: number | null
  error?: string | null; bwlimitKiB?: number | null; owner?: string | null; heartbeatAt?: number | null; snapshot?: MoveSnapshot | null
}

/** Statuses that hold the cluster's one move slot: the database allows one row in either (a partial unique index). */
export const IN_FLIGHT: MoveStatus[] = ['running', 'stuck']

/** Another move already holds the slot (the database refused a second in-flight row). */
export class MoveSlotTaken extends Error { constructor() { super('Another move is running. One at a time: wait for it to finish.') } }

export interface TransitionWhere { status: MoveStatus[]; heartbeatBefore?: number; owner?: string }

export interface PlacementStore {
  settings(): Promise<PlacementSettings>
  saveSettings(s: PlacementSettings, by: string): Promise<void>
  /** Throws MoveSlotTaken when the row would be a second in-flight move. */
  create(m: NewMove): Promise<MoveRecord>
  update(id: string, patch: Partial<Omit<MoveRecord, 'id'>>): Promise<MoveRecord | null>
  /**
   * The atomic claim: applies `patch` only while the row is still in one of `where.status` (and, with heartbeatBefore,
   * only when its heartbeat is older). Null when nothing changed: someone else got there first, or the slot is taken.
   */
  transition(id: string, where: TransitionWhere, patch: Partial<Omit<MoveRecord, 'id'>>): Promise<MoveRecord | null>
  /** Gives the move its task id; a copy of that task the history sync may have saved first is removed in the same step. */
  attachUpid(id: string, upid: string): Promise<void>
  get(id: string): Promise<MoveRecord | null>
  /** Newest first. */
  list(opts?: { sid?: string; status?: MoveStatus[]; limit?: number }): Promise<MoveRecord[]>
  /** A Proxmox migration from the task log, once per task id. */
  upsertSeen(m: NewMove & { upid: string }): Promise<void>
  /** Throws PlanSlotTaken when the row would be a second running plan. */
  createPlan(p: NewPlan): Promise<PlanRecord>
  getPlan(id: string): Promise<PlanRecord | null>
  /** Newest first. */
  listPlans(opts?: { status?: PlanStatus[]; source?: 'manual' | 'auto'; limit?: number }): Promise<PlanRecord[]>
  /** The atomic claim for plans, as transition() is for moves. */
  transitionPlan(id: string, where: PlanWhere, patch: Partial<Omit<PlanRecord, 'id'>>): Promise<PlanRecord | null>
  auto(): Promise<{ settings: AutoSettings; state: AutoState }>
  saveAuto(settings: AutoSettings, state: AutoState, by: string): Promise<void>
}

export class MemoryPlacementStore implements PlacementStore {
  s: PlacementSettings = { ...DEFAULT_SETTINGS }
  rows: MoveRecord[] = []
  private n = 0
  async settings() { return { ...this.s } }
  async saveSettings(s: PlacementSettings) { this.s = { ...s } }
  private slotTaken(exceptId: string | null, status: MoveStatus | undefined) {
    return !!status && IN_FLIGHT.includes(status) && this.rows.some(r => r.id !== exceptId && IN_FLIGHT.includes(r.status))
  }
  async create(m: NewMove) {
    if (this.slotTaken(null, m.status)) throw new MoveSlotTaken()
    if (m.upid && this.rows.some(r => r.upid === m.upid)) throw new Error('duplicate upid')
    const r: MoveRecord = {
      id: `mv${++this.n}`, sid: m.sid, name: m.name, fromNode: m.fromNode, toNode: m.toNode, source: m.source, method: m.method,
      status: m.status, upid: m.upid ?? null, by: m.by ?? null, scheduledFor: m.scheduledFor ?? null, startedAt: m.startedAt ?? null,
      endedAt: m.endedAt ?? null, error: m.error ?? null, bwlimitKiB: m.bwlimitKiB ?? null, corosync: null,
      owner: m.owner ?? null, heartbeatAt: m.heartbeatAt ?? null, snapshot: m.snapshot ?? null,
    }
    this.rows.push(r)
    return { ...r }
  }
  async update(id: string, patch: Partial<Omit<MoveRecord, 'id'>>) {
    const r = this.rows.find(x => x.id === id)
    if (!r) return null
    if (this.slotTaken(id, patch.status)) throw new MoveSlotTaken()
    Object.assign(r, patch)
    return { ...r }
  }
  async transition(id: string, where: TransitionWhere, patch: Partial<Omit<MoveRecord, 'id'>>) {
    const r = this.rows.find(x => x.id === id)
    if (!r || !where.status.includes(r.status)) return null
    if (where.heartbeatBefore !== undefined && r.heartbeatAt !== null && r.heartbeatAt >= where.heartbeatBefore) return null
    if (where.owner !== undefined && r.owner !== where.owner) return null
    if (this.slotTaken(id, patch.status)) return null
    Object.assign(r, patch)
    return { ...r }
  }
  async attachUpid(id: string, upid: string) {
    this.rows = this.rows.filter(x => !(x.upid === upid && x.id !== id && x.source === 'proxmox'))
    const r = this.rows.find(x => x.id === id)
    if (!r) throw new Error('No such move.')
    r.upid = upid
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
  plans: PlanRecord[] = []
  autoRow: { settings: AutoSettings; state: AutoState } = { settings: { ...DEFAULT_AUTO }, state: { ...EMPTY_AUTO_STATE } }
  private p = 0
  private planSlotTaken(exceptId: string | null, status: PlanStatus | undefined) {
    return status === 'running' && this.plans.some(r => r.id !== exceptId && r.status === 'running')
  }
  async createPlan(n: NewPlan) {
    if (this.planSlotTaken(null, n.status)) throw new PlanSlotTaken()
    const r: PlanRecord = {
      id: `pl${++this.p}`, source: n.source, status: n.status, by: n.by, goal: n.goal, scoreBefore: n.scoreBefore, scoreTarget: n.scoreTarget,
      steps: n.steps.map(x => ({ ...x })), scheduledFor: n.scheduledFor ?? null, startedAt: n.startedAt ?? null, endedAt: null, error: null,
      stopRequested: false, owner: n.owner ?? null, heartbeatAt: n.heartbeatAt ?? null, snapshot: n.snapshot ?? null,
    }
    this.plans.push(r)
    return clonePlan(r)
  }
  async getPlan(id: string) { const r = this.plans.find(x => x.id === id); return r ? clonePlan(r) : null }
  async listPlans(opts: { status?: PlanStatus[]; source?: 'manual' | 'auto'; limit?: number } = {}) {
    return this.plans.filter(r => (!opts.status || opts.status.includes(r.status)) && (!opts.source || r.source === opts.source))
      .map((r, i) => ({ r, i })).sort((a, b) => (b.r.startedAt ?? b.r.scheduledFor ?? 0) - (a.r.startedAt ?? a.r.scheduledFor ?? 0) || b.i - a.i)
      .slice(0, opts.limit ?? 50).map(x => clonePlan(x.r))
  }
  async transitionPlan(id: string, where: PlanWhere, patch: Partial<Omit<PlanRecord, 'id'>>) {
    const r = this.plans.find(x => x.id === id)
    if (!r || !where.status.includes(r.status)) return null
    if (where.owner !== undefined && r.owner !== where.owner) return null
    if (where.heartbeatBefore !== undefined && r.heartbeatAt !== null && r.heartbeatAt >= where.heartbeatBefore) return null
    if (this.planSlotTaken(id, patch.status)) return null
    Object.assign(r, patch, patch.steps ? { steps: patch.steps.map(x => ({ ...x })) } : {})
    return clonePlan(r)
  }
  async auto() { return { settings: { ...this.autoRow.settings }, state: { ...this.autoRow.state } } }
  async saveAuto(settings: AutoSettings, state: AutoState) { this.autoRow = { settings: { ...settings }, state: { ...state } } }
}

const clonePlan = (r: PlanRecord): PlanRecord => ({ ...r, steps: r.steps.map(x => ({ ...x })), snapshot: r.snapshot ? JSON.parse(JSON.stringify(r.snapshot)) : null })

const ms = (d: Date | null | undefined) => (d ? d.getTime() : null)
const dt = (n: number | null | undefined) => (n ? new Date(n) : null)

function fromRow(r: any): MoveRecord {
  return {
    id: r.id, sid: r.sid, name: r.name, fromNode: r.fromNode, toNode: r.toNode, source: r.source, method: r.method ?? null,
    status: r.status, upid: r.upid ?? null, by: r.by ?? null, scheduledFor: ms(r.scheduledFor), startedAt: ms(r.startedAt),
    endedAt: ms(r.endedAt), error: r.error ?? null, bwlimitKiB: r.bwlimitKiB ?? null, corosync: (r.corosync ?? null) as CorosyncCount | null,
    owner: r.owner ?? null, heartbeatAt: ms(r.heartbeatAt), snapshot: (r.snapshot ?? null) as MoveSnapshot | null,
  }
}

const DATES = new Set(['scheduledFor', 'startedAt', 'endedAt', 'heartbeatAt'])
function toData(p: Partial<Omit<MoveRecord, 'id'>>): Record<string, unknown> {
  const d: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(p)) {
    if (DATES.has(k)) d[k] = dt(v as number | null)
    else if (k === 'corosync' || k === 'snapshot') d[k] = v ?? undefined
    else d[k] = v
  }
  return d
}

const unique = (e: any) => e?.code === 'P2002'

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
      try { return fromRow(await db.placementMove.create({ data: toData({ ...m, corosync: null } as any) })) }
      catch (e) { if (unique(e) && IN_FLIGHT.includes(m.status)) throw new MoveSlotTaken(); throw e }
    },
    async update(id, patch) {
      try { return fromRow(await db.placementMove.update({ where: { id }, data: toData(patch) })) }
      catch (e: any) { if (unique(e) && patch.status && IN_FLIGHT.includes(patch.status)) throw new MoveSlotTaken(); if (e?.code === 'P2025') return null; throw e }
    },
    async transition(id, where, patch) {
      const hb = where.heartbeatBefore !== undefined ? { OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: new Date(where.heartbeatBefore) } }] } : {}
      let n = 0
      const own = where.owner !== undefined ? { owner: where.owner } : {}
      try { n = (await db.placementMove.updateMany({ where: { id, status: { in: where.status }, ...hb, ...own }, data: toData(patch) })).count }
      catch (e) { if (unique(e)) return null; throw e }
      if (!n) return null
      const r = await db.placementMove.findUnique({ where: { id } })
      return r ? fromRow(r) : null
    },
    async attachUpid(id, upid) {
      await db.$transaction([
        db.placementMove.deleteMany({ where: { upid, source: 'proxmox', NOT: { id } } }),
        db.placementMove.update({ where: { id }, data: { upid } }),
      ])
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
    async createPlan(n) {
      try { return planFromRow(await db.placementPlan.create({ data: planData({ ...n, endedAt: null, error: null, stopRequested: false } as any) })) }
      catch (e) { if (unique(e) && n.status === 'running') throw new PlanSlotTaken(); throw e }
    },
    async getPlan(id) { const r = await db.placementPlan.findUnique({ where: { id } }); return r ? planFromRow(r) : null },
    async listPlans(opts = {}) {
      const rows = await db.placementPlan.findMany({
        where: { ...(opts.status ? { status: { in: opts.status } } : {}), ...(opts.source ? { source: opts.source } : {}) },
        orderBy: [{ createdAt: 'desc' }], take: opts.limit ?? 50,
      })
      return rows.map(planFromRow)
    },
    async transitionPlan(id, where, patch) {
      const hb = where.heartbeatBefore !== undefined ? { OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: new Date(where.heartbeatBefore) } }] } : {}
      const own = where.owner !== undefined ? { owner: where.owner } : {}
      let n = 0
      try { n = (await db.placementPlan.updateMany({ where: { id, status: { in: where.status }, ...hb, ...own }, data: planData(patch) })).count }
      catch (e) { if (unique(e)) return null; throw e }
      if (!n) return null
      const r = await db.placementPlan.findUnique({ where: { id } })
      return r ? planFromRow(r) : null
    },
    async auto() {
      // Before the migration has run the defaults apply: automatic balancing is then simply off.
      let row: any = null
      try { row = await db.placementSettings.findUnique({ where: { id: AUTO_ROW } }) } catch { row = null }
      const d = (row?.data ?? {}) as { settings?: Partial<AutoSettings>; state?: Partial<AutoState> }
      return { settings: { ...DEFAULT_AUTO, ...(d.settings ?? {}) }, state: { ...EMPTY_AUTO_STATE, ...(d.state ?? {}) } }
    },
    async saveAuto(settings, state, by) {
      const data = { settings, state } as any
      await db.placementSettings.upsert({ where: { id: AUTO_ROW }, create: { id: AUTO_ROW, data, updatedBy: by }, update: { data, updatedBy: by } })
    },
  }
}

/** Automatic balancing's row in the settings table, beside the settings' own. */
const AUTO_ROW = 'balance-auto'

const PLAN_DATES = new Set(['scheduledFor', 'startedAt', 'endedAt', 'heartbeatAt'])
function planData(p: Partial<Omit<PlanRecord, 'id'>>): Record<string, unknown> {
  const d: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(p)) {
    if (PLAN_DATES.has(k)) d[k] = dt(v as number | null)
    else if (k === 'steps' || k === 'snapshot') d[k] = v ?? undefined
    else d[k] = v
  }
  return d
}

function planFromRow(r: any): PlanRecord {
  return {
    id: r.id, source: r.source, status: r.status, by: r.by ?? null, goal: r.goal, scoreBefore: Number(r.scoreBefore), scoreTarget: Number(r.scoreTarget),
    steps: (r.steps ?? []) as PlanStepRecord[], scheduledFor: ms(r.scheduledFor), startedAt: ms(r.startedAt), endedAt: ms(r.endedAt),
    error: r.error ?? null, stopRequested: !!r.stopRequested, owner: r.owner ?? null, heartbeatAt: ms(r.heartbeatAt),
    snapshot: (r.snapshot ?? null) as PlanSnapshot | null,
  }
}
