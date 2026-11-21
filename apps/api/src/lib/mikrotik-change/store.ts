// =============================================================================
//  HyperProx — MikroTik change engine: where the history and the router backups live
//
//  Per router: a history of the last 50 changes (what was done and exactly what puts it back) and the last 20 router
//  exports taken just before a change. They live in HyperProx's data folder, owner-only. The export text is never
//  sent to a page: the page sees only that a backup exists, when, and how big it is.
// =============================================================================

import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { HistoryEntry } from './types'

export const KEEP_HISTORY = 50
export const KEEP_BACKUPS = 20

export interface ChangeStore {
  /** Newest first. */
  list(routerKey: string): Promise<HistoryEntry[]>
  save(routerKey: string, entry: HistoryEntry): Promise<void>
  saveBackup(routerKey: string, id: string, text: string): Promise<void>
  readBackup(routerKey: string, id: string): Promise<string | null>
}

function insert(list: HistoryEntry[], e: HistoryEntry): HistoryEntry[] {
  const i = list.findIndex(x => x.id === e.id)
  if (i >= 0) { const c = list.slice(); c[i] = e; return c }
  return [e, ...list].slice(0, KEEP_HISTORY)
}

export class MemoryChangeStore implements ChangeStore {
  history = new Map<string, HistoryEntry[]>()
  backups = new Map<string, Map<string, string>>()
  async list(k: string) { return structuredClone(this.history.get(k) ?? []) }
  async save(k: string, e: HistoryEntry) { this.history.set(k, insert(this.history.get(k) ?? [], structuredClone(e))) }
  async saveBackup(k: string, id: string, text: string) {
    const m = this.backups.get(k) ?? new Map<string, string>()
    m.set(id, text)
    for (const old of [...m.keys()].slice(0, Math.max(0, m.size - KEEP_BACKUPS))) {
      m.delete(old)
      this.history.set(k, (this.history.get(k) ?? []).map(e => e.id === old ? { ...e, backup: undefined } : e))
    }
    this.backups.set(k, m)
  }
  async readBackup(k: string, id: string) { return this.backups.get(k)?.get(id) ?? null }
}

const safe = (s: string) => /^[A-Za-z0-9_-]{1,64}$/.test(s)

export class FileChangeStore implements ChangeStore {
  constructor(private root: string) {}
  private dir(k: string) { if (!safe(k)) throw new Error('Not a router key.'); return path.join(this.root, k) }
  private async write(file: string, data: string) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    await fs.writeFile(tmp, data, { mode: 0o600 })
    await fs.rename(tmp, file)
  }
  async list(k: string): Promise<HistoryEntry[]> {
    try { const v = JSON.parse(await fs.readFile(path.join(this.dir(k), 'history.json'), 'utf8')); return Array.isArray(v) ? v : [] } catch { return [] }
  }
  async save(k: string, e: HistoryEntry) { await this.write(path.join(this.dir(k), 'history.json'), JSON.stringify(insert(await this.list(k), e))) }
  async saveBackup(k: string, id: string, text: string) {
    if (!safe(id)) throw new Error('Not a change id.')
    const d = path.join(this.dir(k), 'backups')
    await this.write(path.join(d, `${id}.rsc`), text)
    const files = (await fs.readdir(d)).filter(f => f.endsWith('.rsc'))
    const withTime = await Promise.all(files.map(async f => ({ f, t: (await fs.stat(path.join(d, f))).mtimeMs })))
    const drop = withTime.sort((a, b) => b.t - a.t).slice(KEEP_BACKUPS)
    if (!drop.length) return
    const gone = new Set(drop.map(x => x.f.replace(/\.rsc$/, '')))
    for (const x of drop) await fs.rm(path.join(d, x.f), { force: true })
    const list = await this.list(k)
    await this.write(path.join(this.dir(k), 'history.json'), JSON.stringify(list.map(e => gone.has(e.id) ? { ...e, backup: undefined } : e)))
  }
  async readBackup(k: string, id: string) {
    if (!safe(id)) return null
    try { return await fs.readFile(path.join(this.dir(k), 'backups', `${id}.rsc`), 'utf8') } catch { return null }
  }
}

export function defaultChangeStore(): ChangeStore {
  const root = process.env.HYPERPROX_DATA_DIR || path.resolve(__dirname, '..', '..', '..', '..', '..', 'data')
  return new FileChangeStore(path.join(root, 'mikrotik'))
}

/** The key a router's files live under: steady for one address. */
export function routerKeyOf(host: string): string {
  return 'r-' + createHash('sha256').update(host).digest('hex').slice(0, 12)
}
