// =============================================================================
//  HyperProx — Immich: what the plug-in reads, and what its fix buttons do
//
//  Reads (through the plug-in's own connection, HyperProx's API key): how many photos and videos, who uses how much,
//  the server's version and whether a newer release exists, and every job queue. A queue that is paused or holds failed
//  jobs is a problem, and each problem names its fix.
//
//  Fixes are three, all on one queue: resume it, restart it (pause, then resume) and clear its failed jobs. A fix
//  never reads, moves or deletes a photo: the key HyperProx holds cannot. Each is audited before it runs and read back
//  after (the queue is read again and must show the result).
// =============================================================================

export interface ImmichClient {
  get(path: string, timeoutMs?: number): Promise<any>
  put(path: string, body: unknown, timeoutMs?: number): Promise<any>
}

export const QUEUE_NAMES = [
  'thumbnailGeneration', 'metadataExtraction', 'videoConversion', 'faceDetection', 'facialRecognition', 'smartSearch', 'duplicateDetection',
  'backgroundTask', 'storageTemplateMigration', 'migration', 'search', 'sidecar', 'library', 'notifications', 'backupDatabase', 'ocr', 'workflow', 'integrityCheck', 'editor',
] as const
export type QueueName = typeof QUEUE_NAMES[number]

export const QUEUE_LABELS: Record<QueueName, string> = {
  thumbnailGeneration: 'Thumbnails', metadataExtraction: 'Metadata', videoConversion: 'Video conversion', faceDetection: 'Face detection', facialRecognition: 'Face recognition',
  smartSearch: 'Smart search', duplicateDetection: 'Duplicates', backgroundTask: 'Background tasks', storageTemplateMigration: 'Storage template', migration: 'Migration',
  search: 'Search index', sidecar: 'Sidecar files', library: 'External libraries', notifications: 'Notifications', backupDatabase: 'Database backup', ocr: 'Text in photos',
  workflow: 'Workflows', integrityCheck: 'Integrity check', editor: 'Editor',
}

export const ACTIONS = ['resume-queue', 'restart-queue', 'clear-failed'] as const
export type ImmichAction = typeof ACTIONS[number]

export interface QueueView { name: QueueName; label: string; paused: boolean; active: number; waiting: number; failed: number; delayed: number }
export interface ImmichProblem { id: string; severity: 'bad' | 'warn'; title: string; detail: string; fix: { action: ImmichAction; queue: QueueName; label: string; confirm: string } | null }
export interface UserUsage { name: string; photos: number; videos: number; bytes: number; quotaBytes: number | null }
export interface ImmichOverview {
  version: string | null
  update: { latest: string | null; available: boolean; checkedAt: string | null }
  photos: number; videos: number; bytes: number; photoBytes: number; videoBytes: number
  users: UserUsage[]
  queues: QueueView[]
  problems: ImmichProblem[]
}

const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)
const isQueue = (n: unknown): n is QueueName => (QUEUE_NAMES as readonly string[]).includes(n as string)

export function queueOf(raw: any): QueueView | null {
  if (!raw || !isQueue(raw.name)) return null
  const s = raw.statistics ?? {}
  return { name: raw.name, label: QUEUE_LABELS[raw.name as QueueName], paused: raw.isPaused === true, active: int(s.active), waiting: int(s.waiting), failed: int(s.failed), delayed: int(s.delayed) }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function problemsOf(queues: QueueView[], update: ImmichOverview['update'], version: string | null): ImmichProblem[] {
  const out: ImmichProblem[] = []
  for (const q of queues) {
    if (q.paused) {
      out.push({ id: `paused:${q.name}`, severity: 'warn', title: `${q.label} is paused`, detail: `${plural(q.waiting, 'job')} wait${q.waiting === 1 ? 's' : ''} and nothing runs until the queue is resumed.`,
        fix: { action: 'resume-queue', queue: q.name, label: 'Resume it', confirm: `Resume the ${q.label} queue in Immich? Its waiting jobs start again.` } })
    }
    if (q.failed > 0) {
      out.push({ id: `failed:${q.name}`, severity: 'bad', title: `${q.label}: ${plural(q.failed, 'job')} failed`, detail: 'Failed jobs stay on the queue until they are cleared. Clearing removes the failed entries only; the photos are untouched, and a later run picks the work up again.',
        fix: { action: 'clear-failed', queue: q.name, label: 'Clear the failed jobs', confirm: `Clear the ${plural(q.failed, 'failed job')} on the ${q.label} queue in Immich? Only the failed entries are removed; no photo or video is changed.` } })
    }
    // Work waiting while the queue is not paused and nothing is active is a queue that has stopped moving.
    if (!q.paused && q.waiting > 0 && q.active === 0 && q.failed === 0) {
      out.push({ id: `stuck:${q.name}`, severity: 'warn', title: `${q.label} has ${plural(q.waiting, 'job')} waiting and none running`, detail: 'It may only be between jobs. If this stays, restarting the queue (a pause and a resume) gets it moving.',
        fix: { action: 'restart-queue', queue: q.name, label: 'Restart the queue', confirm: `Restart the ${q.label} queue in Immich? It is paused and resumed; running jobs finish first and no photo is changed.` } })
    }
  }
  if (update.available) out.push({ id: 'update', severity: 'warn', title: `Immich ${update.latest} is available`, detail: `This server runs ${version ?? 'an unknown version'}. Upgrade by changing the version in its compose folder; Immich's release notes say what to read first.`, fix: null })
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'bad' ? -1 : 1))
}

/** The version Immich reports, as "v3.4.2". */
export function versionOf(raw: any): string | null {
  if (!raw || ![raw.major, raw.minor, raw.patch].every(n => Number.isInteger(n))) return null
  return `v${raw.major}.${raw.minor}.${raw.patch}${Number.isInteger(raw.prerelease) ? `-rc.${raw.prerelease}` : ''}`
}

const cmp = (a: string, b: string) => {
  const p = (s: string) => s.replace(/^v/, '').split(/[.-]/).map(x => Number(x) || 0)
  const x = p(a), y = p(b)
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}

export async function readOverview(c: Pick<ImmichClient, 'get'>): Promise<ImmichOverview> {
  const [stats, ver, check, queues] = await Promise.all([
    c.get('/api/server/statistics', 20_000),
    c.get('/api/server/version', 15_000).catch(() => null),
    c.get('/api/server/version-check', 15_000).catch(() => null),
    c.get('/api/queues', 20_000).catch(() => [] as unknown[]),
  ])
  const version = versionOf(ver)
  const latest = typeof check?.releaseVersion === 'string' ? check.releaseVersion : null
  const update = { latest, available: !!(latest && version && cmp(latest, version) > 0), checkedAt: typeof check?.checkedAt === 'string' ? check.checkedAt : null }
  const qs = (Array.isArray(queues) ? queues : []).map(queueOf).filter((q): q is QueueView => !!q)
  return {
    version, update,
    photos: int(stats?.photos), videos: int(stats?.videos), bytes: int(stats?.usage), photoBytes: int(stats?.usagePhotos), videoBytes: int(stats?.usageVideos),
    users: (Array.isArray(stats?.usageByUser) ? stats.usageByUser : []).map((u: any): UserUsage => ({
      name: String(u?.userName ?? 'Unknown').slice(0, 80), photos: int(u?.photos), videos: int(u?.videos), bytes: int(u?.usage), quotaBytes: Number.isFinite(u?.quotaSizeInBytes) ? u.quotaSizeInBytes : null,
    })),
    queues: qs,
    problems: problemsOf(qs, update, version),
  }
}

export class ImmichRefusal extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); this.name = 'ImmichRefusal' }
}

export interface ActionInput { action: unknown; queue: unknown }
export interface ActionDeps { client: ImmichClient; audit(action: string, details: Record<string, unknown>): Promise<void>; wait?(ms: number): Promise<unknown> }

/** The body, checked field by field. Nothing here is passed on as given: only a name from the list and an action from the list. */
export function parseAction(b: unknown): { action: ImmichAction; queue: QueueName } {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new ImmichRefusal('bad_request', 'Send a JSON body.')
  const o = b as Record<string, unknown>
  if (!(ACTIONS as readonly string[]).includes(o.action as string)) throw new ImmichRefusal('bad_request', 'Unknown action.')
  if (!isQueue(o.queue)) throw new ImmichRefusal('bad_request', 'Name one of Immich\'s queues.')
  return { action: o.action as ImmichAction, queue: o.queue }
}

/** Run one fix, audited first, read back after. Returns what happened in words and the queue as it reads now. */
export async function runAction(raw: ActionInput, actor: string, d: ActionDeps): Promise<{ message: string; queue: QueueView }> {
  const { action, queue } = parseAction(raw)
  const readQueue = async () => {
    const q = queueOf(await d.client.get(`/api/queues/${queue}`, 20_000))
    if (!q) throw new ImmichRefusal('unexpected', `Immich did not answer like itself about the ${QUEUE_LABELS[queue]} queue.`, 502)
    return q
  }
  const before = await readQueue()
  // Written before anything is changed: when it cannot be, nothing is.
  await d.audit(`immich.${action}`, { queue, by: actor, failed: before.failed, waiting: before.waiting, paused: before.paused })
  const pause = (isPaused: boolean) => d.client.put(`/api/queues/${queue}`, { isPaused }, 30_000)
  if (action === 'resume-queue') await pause(false)
  else if (action === 'restart-queue') { await pause(true); await d.wait?.(1000); await pause(false) }
  // Immich's deprecated PUT /jobs/{name} (since v2.4.0): the only call that clears failed jobs and leaves the waiting ones. Its replacement,
  // DELETE /queues/{name}/jobs, empties the queue. When Immich removes it, this is the line to change (the test pins it).
  else await d.client.put(`/api/jobs/${queue}`, { command: 'clear-failed' }, 60_000)
  const after = await readQueue()
  if (action !== 'clear-failed' && after.paused) throw new ImmichRefusal('not_applied', `Immich still shows the ${after.label} queue as paused after the request.`, 502)
  if (action === 'clear-failed' && after.failed > 0) throw new ImmichRefusal('not_applied', `Immich still shows ${plural(after.failed, 'failed job')} on the ${after.label} queue.`, 502)
  const message = action === 'clear-failed' ? `Cleared ${plural(before.failed, 'failed job')} on the ${after.label} queue.`
    : action === 'resume-queue' ? `The ${after.label} queue is running again.` : `The ${after.label} queue was restarted and is running.`
  return { message, queue: after }
}
