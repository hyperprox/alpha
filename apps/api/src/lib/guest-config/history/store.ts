// =============================================================================
//  HyperProx — guest config history: the config before and after every write
//  HyperProx makes, so any change can be read back ("what changed, when, by
//  whom") and reverted through a fresh, digest-checked preview.
//  Production uses Postgres (GuestConfigVersion); tests use the memory store.
// =============================================================================

import type { PrismaClient } from '@prisma/client'
import type { PveConfig } from '../keys'

export interface HistoryRow {
  id: string
  /** "lxc/123" or "qemu/123". */
  guest: string
  node: string
  /** edit | revert | device | gpu-off | gpu-on | restart */
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

export interface HistoryStore {
  add(r: Omit<HistoryRow, 'id' | 'createdAt'>): Promise<HistoryRow>
  /** Newest first. */
  list(guest: string, limit?: number): Promise<HistoryRow[]>
  get(id: string): Promise<HistoryRow | null>
}

/** Keys whose values are never kept in history or shown: cloud-init passwords, SSH keys, anything named like a secret. */
export const SECRET_KEY = /(pass(word|wd)?|secret|token|sshkeys|apikey|api_key|credential)/i
export const REDACTED = '**redacted**'
export function isSecretKey(k: string): boolean { return SECRET_KEY.test(k) }
export function redactSecrets<T extends PveConfig | null>(cfg: T): T {
  if (!cfg) return cfg
  const out: PveConfig = { ...cfg }
  for (const k of Object.keys(out)) if (isSecretKey(k)) out[k] = REDACTED
  return out as T
}
/** For display: "set" or "not set" in place of a secret's value. */
export function maskSecrets(cfg: PveConfig): PveConfig {
  const out: PveConfig = { ...cfg }
  for (const k of Object.keys(out)) if (isSecretKey(k)) out[k] = out[k] === undefined || out[k] === '' ? 'not set' : 'set'
  return out
}

export class MemoryHistoryStore implements HistoryStore {
  rows: HistoryRow[] = []
  private n = 0
  async add(r: Omit<HistoryRow, 'id' | 'createdAt'>) {
    const row: HistoryRow = structuredClone({ ...r, before: redactSecrets(r.before)!, after: redactSecrets(r.after), id: `h${++this.n}`, createdAt: new Date(Date.now() + this.n) })
    this.rows.push(row)
    return structuredClone(row)
  }
  async list(guest: string, limit = 100) { return structuredClone(this.rows.filter(r => r.guest === guest).sort((a, b) => +b.createdAt - +a.createdAt).slice(0, limit)) }
  async get(id: string) { const r = this.rows.find(x => x.id === id); return r ? structuredClone(r) : null }
}

export class PrismaHistoryStore implements HistoryStore {
  constructor(private db: PrismaClient) {}
  private row = (r: any): HistoryRow => ({ ...r, changes: r.changes ?? [], problems: r.problems ?? [], meta: r.meta ?? null })
  async add(r: Omit<HistoryRow, 'id' | 'createdAt'>) {
    const created = await (this.db as any).guestConfigVersion.create({ data: {
      guest: r.guest, node: r.node, kind: r.kind, tag: r.tag, actor: r.actor, previewId: r.previewId,
      before: redactSecrets(r.before) as any, after: (redactSecrets(r.after) ?? undefined) as any,
      changes: r.changes as any, outcome: r.outcome, problems: r.problems as any, meta: (r.meta ?? undefined) as any,
    } })
    return this.row(created)
  }
  async list(guest: string, limit = 100) {
    return ((await (this.db as any).guestConfigVersion.findMany({ where: { guest }, orderBy: { createdAt: 'desc' }, take: limit })) as any[]).map(this.row)
  }
  async get(id: string) { const r = await (this.db as any).guestConfigVersion.findUnique({ where: { id } }); return r ? this.row(r) : null }
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
