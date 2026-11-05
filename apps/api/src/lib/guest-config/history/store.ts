// =============================================================================
//  HyperProx — guest config history: the config before and after every write
//  HyperProx makes, so any change can be read back ("what changed, when, by
//  whom") and reverted through a fresh, digest-checked preview.
//  Production uses Postgres (GuestConfigVersion); tests use the memory store.
//
//  Nothing secret is kept: configs are redacted by key and by value
//  (secrets.ts) before they are stored, and so is every string in the meta.
//  Retention: the last 50 versions of each guest, plus everything from the last
//  90 days, whichever is more.
// =============================================================================

import type { PrismaClient } from '@prisma/client'
import type { PveConfig } from '../keys'
import { redactConfig, redactText, isSecretKey, REDACTED, maskConfig } from '../secrets'

export { isSecretKey, REDACTED }
/** For display: "set" or "not set" in place of a secret's value; other values redacted by pattern. */
export const maskSecrets = maskConfig
export const redactSecrets = redactConfig

export const KEEP_VERSIONS = 50
export const KEEP_DAYS = 90

export interface HistoryRow {
  id: string
  /** "lxc/123" or "qemu/123". */
  guest: string
  node: string
  /** edit | revert | device | gpu-off | gpu-on | restart | raw */
  kind: string
  /** A short label shown in the list, e.g. "GPU off". */
  tag: string | null
  actor: string
  previewId: string
  before: PveConfig
  after: PveConfig | null
  changes: Array<{ key: string; words: string }>
  outcome: 'ok' | 'failed'
  problems: string[]
  meta: Record<string, unknown> | null
  createdAt: Date
}

/**
 * A guest's GPU toggle state, kept apart from the history rows so it never depends on how many rows are read or
 * kept: the entries HyperProx added, and the open "GPU off" record (what "Turn back on" restores).
 */
export interface GpuState {
  guest: string
  /** devN key → the exact value HyperProx wrote. */
  dev: Record<string, string>
  /** Raw device lines HyperProx wrote. */
  raw: Array<[string, string]>
  /** The open "GPU off": exactly what was removed. null when GPU access is on. */
  off: { removed: Record<string, string>; rawRemoved: Array<[string, string]>; kept: Array<{ key: string; value: string }> } | null
  offAt: Date | null
  /** The history row that recorded the open "GPU off". */
  offRow: string | null
}

export const emptyGpuState = (guest: string): GpuState => ({ guest, dev: {}, raw: [], off: null, offAt: null, offRow: null })

export interface HistoryStore {
  add(r: Omit<HistoryRow, 'id' | 'createdAt'>): Promise<HistoryRow>
  /** Newest first. */
  list(guest: string, limit?: number): Promise<HistoryRow[]>
  get(id: string): Promise<HistoryRow | null>
  getGpu(guest: string): Promise<GpuState>
  setGpu(s: GpuState): Promise<void>
  /** Read, change and write one guest's GPU state in a single transaction. */
  updateGpu(guest: string, fn: (s: GpuState) => GpuState): Promise<GpuState>
  /** Every guest with GPU state, for the list view (one read, not one per guest). */
  listGpu(): Promise<GpuState[]>
}

/** Every string in the meta, redacted by pattern (device paths and raw GPU lines come through unchanged). */
export function redactMeta(m: unknown): any {
  if (typeof m === 'string') return redactText(m)
  if (Array.isArray(m)) return m.map(redactMeta)
  if (m && typeof m === 'object') return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, isSecretKey(k) && typeof v === 'string' ? REDACTED : redactMeta(v)]))
  return m
}

/** What a row looks like on its way into storage. */
export function scrub(r: Omit<HistoryRow, 'id' | 'createdAt'>): Omit<HistoryRow, 'id' | 'createdAt'> {
  return {
    ...r,
    before: redactConfig(r.before)!, after: redactConfig(r.after),
    changes: r.changes.map(c => ({ key: c.key, words: redactText(c.words) })),
    problems: r.problems.map(redactText), meta: redactMeta(r.meta),
  }
}

/** Rows retention never deletes: the ones that record HyperProx-managed GPU entries or a "GPU off". */
export function pinned(r: { meta?: any }): boolean {
  const m = r.meta
  return !!m && typeof m === 'object' && (m.gpuManaged !== undefined || m.gpuManagedRaw !== undefined || m.gpuOff !== undefined)
}

/** Ids to delete: beyond the newest KEEP_VERSIONS, older than KEEP_DAYS, and not pinned. Rows newest first. */
export function prunable(rows: Array<{ id: string; createdAt: Date; meta?: any }>, now = Date.now()): string[] {
  const cutoff = now - KEEP_DAYS * 86_400_000
  return rows.slice(KEEP_VERSIONS).filter(r => +r.createdAt < cutoff && !pinned(r)).map(r => r.id)
}

export class MemoryHistoryStore implements HistoryStore {
  rows: HistoryRow[] = []
  gpu = new Map<string, GpuState>()
  async getGpu(guest: string) { return structuredClone(this.gpu.get(guest) ?? emptyGpuState(guest)) }
  async setGpu(st: GpuState) { this.gpu.set(st.guest, structuredClone(st)) }
  async updateGpu(guest: string, fn: (s: GpuState) => GpuState) {
    // No await between read and write: one step on the event loop, so nothing interleaves.
    const next = fn(structuredClone(this.gpu.get(guest) ?? emptyGpuState(guest)))
    this.gpu.set(guest, structuredClone({ ...next, guest }))
    return structuredClone(next)
  }
  async listGpu() { return structuredClone([...this.gpu.values()]) }
  private n = 0
  now = () => Date.now()
  async add(r: Omit<HistoryRow, 'id' | 'createdAt'>) {
    const row: HistoryRow = structuredClone({ ...scrub(r), id: `h${++this.n}`, createdAt: new Date(this.now() + this.n) })
    this.rows.push(row)
    const drop = new Set(prunable([...this.rows.filter(x => x.guest === r.guest)].sort((a, b) => +b.createdAt - +a.createdAt), this.now()))
    this.rows = this.rows.filter(x => !drop.has(x.id))
    return structuredClone(row)
  }
  async list(guest: string, limit = 100) { return structuredClone(this.rows.filter(r => r.guest === guest).sort((a, b) => +b.createdAt - +a.createdAt).slice(0, limit)) }
  async get(id: string) { const r = this.rows.find(x => x.id === id); return r ? structuredClone(r) : null }
}

export class PrismaHistoryStore implements HistoryStore {
  constructor(private db: PrismaClient) {}
  private row = (r: any): HistoryRow => ({ ...r, changes: r.changes ?? [], problems: r.problems ?? [], meta: r.meta ?? null })
  async add(input: Omit<HistoryRow, 'id' | 'createdAt'>) {
    const r = scrub(input)
    const t = (this.db as any).guestConfigVersion
    const created = await t.create({ data: {
      guest: r.guest, node: r.node, kind: r.kind, tag: r.tag, actor: r.actor, previewId: r.previewId,
      before: r.before as any, after: (r.after ?? undefined) as any,
      changes: r.changes as any, outcome: r.outcome, problems: r.problems as any, meta: (r.meta ?? undefined) as any,
    } })
    // Retention; a failure here never fails the write that was just recorded.
    try {
      if (typeof t.findMany === 'function' && typeof t.deleteMany === 'function') {
        const all = await t.findMany({ where: { guest: r.guest }, orderBy: { createdAt: 'desc' }, select: { id: true, createdAt: true, meta: true } })
        const ids = prunable(all)
        if (ids.length) await t.deleteMany({ where: { id: { in: ids } } })
      }
    } catch { /* kept until the next write */ }
    return this.row(created)
  }
  async list(guest: string, limit = 100) {
    return ((await (this.db as any).guestConfigVersion.findMany({ where: { guest }, orderBy: { createdAt: 'desc' }, take: limit })) as any[]).map(this.row)
  }
  async get(id: string) { const r = await (this.db as any).guestConfigVersion.findUnique({ where: { id } }); return r ? this.row(r) : null }
  private gpuRow = (r: any): GpuState => ({ guest: r.guest, dev: r.dev ?? {}, raw: r.raw ?? [], off: r.off ?? null, offAt: r.offAt ?? null, offRow: r.offRow ?? null })
  async getGpu(guest: string) { const r = await (this.db as any).guestGpuState.findUnique({ where: { guest } }); return r ? this.gpuRow(r) : emptyGpuState(guest) }
  private gpuValues = (st: GpuState) => ({ dev: redactMeta(st.dev), raw: redactMeta(st.raw), off: (st.off ? redactMeta(st.off) : null) ?? undefined, offAt: st.offAt, offRow: st.offRow })
  async setGpu(st: GpuState) {
    const v = this.gpuValues(st)
    await (this.db as any).guestGpuState.upsert({ where: { guest: st.guest }, create: { guest: st.guest, ...v }, update: v })
  }
  async updateGpu(guest: string, fn: (s: GpuState) => GpuState) {
    return (this.db as any).$transaction(async (tx: any) => {
      const cur = await tx.guestGpuState.findUnique({ where: { guest } })
      const next = { ...fn(cur ? this.gpuRow(cur) : emptyGpuState(guest)), guest }
      const v = this.gpuValues(next)
      await tx.guestGpuState.upsert({ where: { guest }, create: { guest, ...v }, update: v })
      return next
    }, { isolationLevel: 'Serializable' })
  }
  async listGpu() { return ((await (this.db as any).guestGpuState.findMany()) as any[]).map(this.gpuRow) }
}

/** The most recent successful "GPU off" not yet followed by a successful "GPU on". */
export function openGpuOff(rows: HistoryRow[]): HistoryRow | null {
  for (const r of rows) {   // newest first
    if (r.outcome !== 'ok') continue
    if (r.kind === 'gpu-on') return null
    if (r.kind === 'gpu-off') return r
  }
  return null
}

/** devN entries HyperProx wrote for a GPU, key → value, across this guest's history. */
export function managedGpuEntries(rows: HistoryRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of [...rows].reverse()) {
    if (r.outcome !== 'ok') continue
    const m = (r.meta as any)?.gpuManaged
    if (m && typeof m === 'object') Object.assign(out, m)
  }
  return out
}

/** Raw GPU lines HyperProx wrote (raw edits, Portable GPU), across this guest's history. */
export function managedRawLines(rows: HistoryRow[]): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const r of rows) {
    if (r.outcome !== 'ok') continue
    const m = (r.meta as any)?.gpuManagedRaw
    if (Array.isArray(m)) for (const l of m) if (Array.isArray(l) && l.length === 2 && !out.some(o => o[0] === l[0] && o[1] === l[1])) out.push([String(l[0]), String(l[1])])
  }
  return out
}
