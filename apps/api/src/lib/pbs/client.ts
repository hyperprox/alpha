// =============================================================================
//  HyperProx — Proxmox Backup Server: the reads and the two actions
//
//  Reads are GETs a read-only token (Audit on /: Datastore.Audit + Sys.Audit)
//  can make. A part the token may not read (a sync job list needs Remote.Audit
//  too, say) is listed in `missing` rather than failing the whole reading.
//
//  The two actions start a task on the server and return its UPID; the caller
//  reads the task's status back afterwards. Nothing here deletes, prunes or
//  forgets a snapshot.
// =============================================================================

import { buildReading, type PbsReading, type RawPbs } from './parse'
import { PbsHttpError } from './transport'

export interface PbsApi { call(method: 'GET' | 'POST' | 'PUT', path: string, params?: Record<string, string | number | boolean | undefined>, timeoutMs?: number): Promise<any> }

const enc = encodeURIComponent
/** Snapshot lists read per datastore; namespaces beyond this are left out and said so. */
export const MAX_NAMESPACES = 25
export const MAX_DATASTORES = 20

export class PbsClient {
  constructor(private api: PbsApi) {}

  /** The whole reading. The first call failing means the server is not there (or the token is refused): it throws. */
  async read(now: Date, staleHours: number): Promise<PbsReading> {
    const raw: RawPbs = { missing: [], status: {}, snapshots: {} }
    raw.version = await this.api.call('GET', '/version')
    const soft = async <T>(what: string, fn: () => Promise<T>): Promise<T | undefined> => {
      try { return await fn() } catch (e) {
        if (e instanceof PbsHttpError) { raw.missing!.push(e.status === 403 || e.status === 401 ? `${what} (the token may not read it)` : what); return undefined }
        throw e
      }
    }
    raw.usage = await soft('datastore usage', () => this.api.call('GET', '/status/datastore-usage'))
    const stores = ((raw.usage as any[]) ?? []).map(u => String(u?.store ?? '')).filter(s => /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/.test(s)).slice(0, MAX_DATASTORES)
    raw.gc = await soft('GC jobs', () => this.api.call('GET', '/admin/gc'))
    raw.prune = await soft('prune jobs', () => this.api.call('GET', '/admin/prune'))
    raw.verify = await soft('verify jobs', () => this.api.call('GET', '/admin/verify'))
    raw.sync = await soft('sync jobs', () => this.api.call('GET', '/admin/sync'))
    for (const s of stores) {
      const st = await soft(`${s} status`, () => this.api.call('GET', `/admin/datastore/${enc(s)}/status`, { verbose: true }))
      if (st) raw.status![s] = st
      const nsRows = await soft(`${s} namespaces`, () => this.api.call('GET', `/admin/datastore/${enc(s)}/namespace`))
      const all = Array.isArray(nsRows) ? nsRows.map((n: any) => (typeof n?.ns === 'string' ? n.ns : '')).filter(n => n === '' || /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,255}$/.test(n)) : ['']
      const list = [...new Set(all.length ? all : [''])]
      if (list.length > MAX_NAMESPACES) raw.missing!.push(`${s}: ${list.length - MAX_NAMESPACES} more namespaces not read`)
      raw.snapshots![s] = {}
      for (const ns of list.slice(0, MAX_NAMESPACES)) {
        const snaps = await soft(`${s}${ns ? `/${ns}` : ''} snapshots`, () => this.api.call('GET', `/admin/datastore/${enc(s)}/snapshots`, ns ? { ns } : undefined, 30_000))
        if (snaps) raw.snapshots![s][ns] = snaps
      }
    }
    const since = Math.floor(now.getTime() / 1000) - 24 * 3600
    raw.tasks = await soft('tasks', () => this.api.call('GET', '/nodes/localhost/tasks', { errors: true, since, limit: 100 }))
    return buildReading(raw, now, staleHours)
  }

  /** Start a verify of the whole datastore. Resolves with the task's UPID. */
  async verify(store: string): Promise<string> {
    return String(await this.api.call('POST', `/admin/datastore/${enc(store)}/verify`))
  }

  /** Start garbage collection on a datastore. Resolves with the task's UPID. */
  async gc(store: string): Promise<string> {
    return String(await this.api.call('POST', `/admin/datastore/${enc(store)}/gc`))
  }

  /** A task's state: running, or stopped with its exit status ("OK", or the error). */
  async taskStatus(upid: string): Promise<{ running: boolean; exit: string | null }> {
    const s = await this.api.call('GET', `/nodes/localhost/tasks/${enc(upid)}/status`)
    return { running: s?.status === 'running', exit: typeof s?.exitstatus === 'string' ? s.exitstatus.slice(0, 200) : null }
  }
}

/** A UPID as PBS writes one: "UPID:node:pid:pstart:taskid:starttime:type:id:user:". */
export const UPID_RE = /^UPID:[A-Za-z0-9._-]+:[0-9A-Fa-f]{8}:[0-9A-Fa-f]{8,9}:[0-9A-Fa-f]{8,16}:[0-9A-Fa-f]{8}:[A-Za-z0-9_-]+:[^:\s]*:[^:\s]+:$/
