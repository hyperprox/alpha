// =============================================================================
//  HyperProx — Proxmox Backup Server: reading the API's answers
//
//  Pure functions from the PBS REST API's JSON (api2/json, the `data` member
//  already unwrapped) to one reading: datastores, backup groups, jobs, recent
//  failed tasks, and the health verdict with its few-word reason. Nothing here
//  talks to the network, so tests feed it fixtures.
//
//  Field names are the API's own (kebab-case), as PBS 3 and 4 answer them:
//    /status/datastore-usage           store, total, used, avail, gc-status, estimated-full-date
//    /admin/datastore/{s}/status       total, used, avail, gc-status, counts (verbose)
//    /admin/datastore/{s}/snapshots    backup-type, backup-id, backup-time, size, verification.state
//    /admin/gc|prune|verify|sync       id/store, schedule, next-run, last-run-state, last-run-endtime
//    /nodes/localhost/tasks?errors=1   upid, worker_type, worker_id, starttime, endtime, status
// =============================================================================

export const DEFAULT_STALE_HOURS = 26
/** A datastore at or above this share used needs attention. */
export const FULL_AT = 0.85

export interface PbsGc {
  /** 'ok', an error text, or null when GC never ran (or the token cannot see it). */
  lastState:   string | null
  lastEnd:     number | null
  next:        number | null
  schedule:    string | null
  removedBytes: number | null
  pendingBytes: number | null
}

export interface PbsDatastore {
  store:      string
  total:      number | null
  used:       number | null
  avail:      number | null
  /** used / total, 0..1, or null. */
  usedFrac:   number | null
  /** Logical bytes referenced by the indexes over bytes on disk: the "Deduplication Factor" in the PBS GUI. */
  dedup:      number | null
  gc:         PbsGc
  /** When PBS expects it to be full (epoch seconds), when it can tell. */
  estimatedFull: number | null
  /** An error PBS reported for the datastore (unmounted, unavailable). */
  error:      string | null
  groups:     number | null
  snapshots:  number | null
}

export type VerifyState = 'ok' | 'failed' | 'none'

export interface PbsGroup {
  store:   string
  /** '' is the root namespace. */
  ns:      string
  type:    string
  id:      string
  count:   number
  /** Newest snapshot time, epoch seconds. */
  newest:  number | null
  /** Size of the newest snapshot (logical bytes). */
  size:    number | null
  /** Verify state of the newest snapshot. */
  verify:  VerifyState
  /** How many of its snapshots failed verification. */
  failedVerifies: number
  stale:   boolean
  ageHours: number | null
}

export type JobKind = 'prune' | 'gc' | 'verify' | 'sync'

export interface PbsJob {
  kind:     JobKind
  id:       string
  store:    string
  ns:       string | null
  schedule: string | null
  lastEnd:  number | null
  /** 'ok', 'failed', or 'never' (no run recorded). */
  result:   'ok' | 'failed' | 'never'
  /** The error text when it failed. */
  detail:   string | null
  next:     number | null
}

export interface PbsTask {
  upid:   string
  type:   string
  /** What it ran on (a datastore, a group), as PBS names it. */
  target: string | null
  start:  number
  end:    number | null
  status: string
}

export interface PbsHealth {
  state:   'active' | 'attention'
  /** A few words, for the dashboard chip: "2 guests not backed up in 26 h". Null when active. */
  reason:  string | null
  reasons: string[]
}

export interface PbsReading {
  fetchedAt:   string
  version:     string | null
  staleHours:  number
  datastores:  PbsDatastore[]
  groups:      PbsGroup[]
  jobs:        PbsJob[]
  failedTasks: PbsTask[]
  /** Parts the token could not read, in words ("sync jobs", "tasks"). */
  missing:     string[]
  health:      PbsHealth
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const txt = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.trim() ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : null)
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : [])
const isOk = (s: string | null) => !!s && /^ok$/i.test(s)

export function dedupOf(gc: any): number | null {
  const idx = num(gc?.['index-data-bytes']), disk = num(gc?.['disk-bytes'])
  if (idx === null || disk === null || disk <= 0 || idx <= 0) return null
  return Math.round((idx / disk) * 100) / 100
}

/** One datastore from its datastore-usage row, its status answer and its GC job row (any may be missing). */
export function parseDatastore(usage: any, status: any, gcJob: any): PbsDatastore {
  const store = txt(usage?.store ?? gcJob?.store, 64) ?? 'unnamed'
  const total = num(status?.total) ?? num(usage?.total)
  const used = num(status?.used) ?? num(usage?.used)
  const avail = num(status?.avail) ?? num(usage?.avail)
  const gcStatus = status?.['gc-status'] ?? usage?.['gc-status'] ?? gcJob ?? null
  const counts = status?.counts
  const sum = (k: 'groups' | 'snapshots') => {
    if (!counts || typeof counts !== 'object') return null
    let n = 0
    for (const v of Object.values(counts)) n += num((v as any)?.[k]) ?? 0
    return n
  }
  const efd = num(usage?.['estimated-full-date'])
  return {
    store, total, used, avail,
    usedFrac: total && used !== null ? Math.max(0, Math.min(1, used / total)) : null,
    dedup: dedupOf(gcJob) ?? dedupOf(gcStatus),
    gc: {
      lastState: txt(gcJob?.['last-run-state']),
      lastEnd: num(gcJob?.['last-run-endtime']),
      next: num(gcJob?.['next-run']),
      schedule: txt(gcJob?.schedule, 64),
      removedBytes: num(gcJob?.['removed-bytes']) ?? num(gcStatus?.['removed-bytes']),
      pendingBytes: num(gcJob?.['pending-bytes']) ?? num(gcStatus?.['pending-bytes']),
    },
    // 0 means "never" in PBS, and a negative one means it cannot tell.
    estimatedFull: efd && efd > 0 ? efd : null,
    error: txt(usage?.error) ?? (usage?.['mount-status'] && usage['mount-status'] !== 'mounted' && usage['mount-status'] !== 'nonremovable' ? `not mounted (${txt(usage['mount-status'], 40)})` : null),
    groups: sum('groups'),
    snapshots: sum('snapshots'),
  }
}

/** Backup groups from one namespace's snapshot list. `now` is epoch seconds. */
export function groupsFromSnapshots(store: string, ns: string, snapshots: unknown, now: number, staleHours: number): PbsGroup[] {
  const by = new Map<string, any[]>()
  for (const s of arr(snapshots)) {
    const type = txt(s?.['backup-type'], 16), id = txt(s?.['backup-id'], 128)
    if (!type || !id || num(s?.['backup-time']) === null) continue
    const k = `${type}/${id}`
    const list = by.get(k) ?? []
    list.push(s)
    by.set(k, list)
  }
  const out: PbsGroup[] = []
  for (const [k, list] of by) {
    list.sort((a, b) => b['backup-time'] - a['backup-time'])
    const newest = list[0]
    const t = num(newest['backup-time'])
    const vs = (s: any): VerifyState => { const st = txt(s?.verification?.state, 16); return st === 'ok' ? 'ok' : st === 'failed' ? 'failed' : 'none' }
    const ageHours = t === null ? null : Math.max(0, (now - t) / 3600)
    const [type, ...rest] = k.split('/')
    out.push({
      store, ns, type, id: rest.join('/'), count: list.length, newest: t, size: num(newest.size),
      verify: vs(newest), failedVerifies: list.filter(s => vs(s) === 'failed').length,
      stale: ageHours !== null && ageHours > staleHours, ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
    })
  }
  return out.sort((a, b) => a.store.localeCompare(b.store) || a.ns.localeCompare(b.ns) || a.type.localeCompare(b.type) || a.id.localeCompare(b.id, undefined, { numeric: true }))
}

export function parseJobs(kind: JobKind, rows: unknown): PbsJob[] {
  return arr(rows).map(r => {
    const state = txt(r?.['last-run-state'])
    const lastEnd = num(r?.['last-run-endtime'])
    return {
      kind, id: txt(r?.id, 64) ?? (kind === 'gc' ? `gc-${txt(r?.store, 64) ?? ''}` : 'job'),
      store: txt(r?.store, 64) ?? '', ns: txt(r?.ns, 128),
      schedule: txt(r?.schedule, 64), lastEnd,
      result: state === null ? 'never' : isOk(state) ? 'ok' : 'failed',
      detail: state && !isOk(state) ? state : null,
      next: num(r?.['next-run']),
    } as PbsJob
  })
}

/** The worker id names what a task ran on: "store:ns:vm/100" style. Kept short and plain. */
function targetOf(t: any): string | null {
  const w = txt(t?.worker_id, 160)
  return w ? w.replace(/\\x3a/g, ':') : null
}

/** Failed tasks since `since` (epoch seconds). Warnings are not failures. */
export function parseFailedTasks(rows: unknown, since: number): PbsTask[] {
  return arr(rows)
    .filter(t => num(t?.starttime) !== null && t.starttime >= since)
    .map(t => ({ upid: txt(t.upid, 200) ?? '', type: txt(t.worker_type, 40) ?? 'task', target: targetOf(t), start: t.starttime, end: num(t.endtime), status: txt(t.status, 200) ?? 'unknown' }))
    .filter(t => t.status !== 'OK' && !/^WARNINGS?:/i.test(t.status) && t.end !== null)
    .sort((a, b) => b.start - a.start)
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const JOB_WORD: Record<JobKind, string> = { prune: 'prune', gc: 'GC', verify: 'verify', sync: 'sync' }

/** The health verdict: "Active" only with every datastore under 85%, no stale group and no failure in 24 h. */
export function healthOf(r: Pick<PbsReading, 'datastores' | 'groups' | 'jobs' | 'failedTasks' | 'staleHours'>): PbsHealth {
  const reasons: string[] = []
  const many = r.datastores.length > 1
  for (const d of r.datastores) {
    if (d.error) reasons.push(`datastore ${d.store} ${d.error}`)
    else if (d.usedFrac !== null && d.usedFrac >= FULL_AT) reasons.push(`datastore ${many ? `${d.store} ` : ''}${Math.round(d.usedFrac * 100)}% full`)
  }
  const stale = r.groups.filter(g => g.stale)
  if (stale.length) {
    const guests = stale.filter(g => g.type === 'vm' || g.type === 'ct').length
    const word = guests === stale.length ? 'guest' : 'backup group'
    reasons.push(`${plural(stale.length, word)} not backed up in ${r.staleHours} h`)
  }
  const failedVerify = r.groups.some(g => g.verify === 'failed') || r.jobs.some(j => j.kind === 'verify' && j.result === 'failed')
    || r.failedTasks.some(t => /verif/i.test(t.type))
  if (failedVerify) reasons.push('verify failed')
  for (const kind of ['gc', 'prune', 'sync'] as JobKind[]) {
    if (r.jobs.some(j => j.kind === kind && j.result === 'failed')) reasons.push(`${JOB_WORD[kind]} failed`)
  }
  const other = r.failedTasks.filter(t => !/verif/i.test(t.type))
  if (other.length) reasons.push(`${plural(other.length, 'failed task')} in 24 h`)
  if (!reasons.length) return { state: 'active', reason: null, reasons }
  return { state: 'attention', reason: reasons.length > 2 ? `${reasons[0]}, ${reasons[1]} +${reasons.length - 2}` : reasons.join(', '), reasons }
}

export interface RawPbs {
  version?: any
  usage?: any
  status?: Record<string, any>
  gc?: any
  prune?: any
  verify?: any
  sync?: any
  /** store -> ns -> snapshots */
  snapshots?: Record<string, Record<string, any>>
  tasks?: any
  missing?: string[]
}

/** Every answer into one reading. `now` is a Date; ages are measured from it. */
export function buildReading(raw: RawPbs, now: Date, staleHours = DEFAULT_STALE_HOURS): PbsReading {
  const t = Math.floor(now.getTime() / 1000)
  const gcRows = arr(raw.gc)
  const usage = arr(raw.usage)
  const stores = new Set<string>([...usage.map(u => txt(u?.store, 64)).filter(Boolean) as string[], ...Object.keys(raw.status ?? {})])
  const datastores = [...stores].sort().map(s => parseDatastore(usage.find(u => u?.store === s) ?? { store: s }, raw.status?.[s], gcRows.find(g => g?.store === s)))
  const groups: PbsGroup[] = []
  for (const [store, byNs] of Object.entries(raw.snapshots ?? {})) {
    for (const [ns, snaps] of Object.entries(byNs)) groups.push(...groupsFromSnapshots(store, ns, snaps, t, staleHours))
  }
  const jobs = [
    ...parseJobs('gc', gcRows.filter(g => g?.schedule || g?.['last-run-state'])),
    ...parseJobs('prune', raw.prune), ...parseJobs('verify', raw.verify), ...parseJobs('sync', raw.sync),
  ]
  const failedTasks = parseFailedTasks(raw.tasks, t - 24 * 3600)
  const base = { datastores, groups, jobs, failedTasks, staleHours }
  return {
    fetchedAt: now.toISOString(), version: txt(raw.version?.version, 40) ? `${txt(raw.version.version, 40)}${raw.version.release ? `.${txt(String(raw.version.release), 10)}` : ''}` : null,
    staleHours, datastores, groups, jobs, failedTasks, missing: raw.missing ?? [], health: healthOf(base),
  }
}

/** What PBS privilege an action needs, for the message when PBS refuses it. */
export const ACTION_PRIVILEGE = { verify: 'Datastore.Verify', gc: 'Datastore.Modify' } as const
