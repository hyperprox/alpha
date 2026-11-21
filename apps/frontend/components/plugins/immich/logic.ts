// =============================================================================
//  HyperProx — the Immich plug-in page: the pure parts (tested on their own)
// =============================================================================

export interface QueueRow { name: string; label: string; paused: boolean; active: number; waiting: number; failed: number; delayed: number }
export interface Problem {
  id: string; severity: 'bad' | 'warn'; title: string; detail: string
  fix: { action: 'resume-queue' | 'restart-queue' | 'clear-failed'; queue: string; label: string; confirm: string } | null
}
export interface UserRow { name: string; photos: number; videos: number; bytes: number; quotaBytes: number | null }
export interface Overview {
  version: string | null
  update: { latest: string | null; available: boolean; checkedAt: string | null }
  photos: number; videos: number; bytes: number; photoBytes: number; videoBytes: number
  users: UserRow[]; queues: QueueRow[]; problems: Problem[]
}

export function size(bytes: number): string {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1)} TB`
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(0, Math.round(bytes / 1024))} KB`
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The share of the library that is photos, 0 to 1 (0 for an empty one). */
export const photoShare = (o: Pick<Overview, 'photoBytes' | 'videoBytes'>) => { const t = o.photoBytes + o.videoBytes; return t > 0 ? o.photoBytes / t : 0 }

/** Queues in the order a person cares: trouble first, then the busy ones, then the rest by name. */
export function queueOrder(qs: QueueRow[]): QueueRow[] {
  const rank = (q: QueueRow) => (q.failed > 0 ? 0 : q.paused ? 1 : q.active > 0 ? 2 : q.waiting > 0 ? 3 : 4)
  return [...qs].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label))
}

/** How full a queue's bar is: running over running plus waiting, so an idle queue is empty and a backed-up one is nearly so. */
export const queueFill = (q: QueueRow) => { const t = q.active + q.waiting; return t > 0 ? q.active / t : 0 }

export function headline(o: Overview): string {
  const bad = o.problems.filter(p => p.severity === 'bad').length
  return bad ? `${plural(bad, 'problem')} to fix` : `${o.photos.toLocaleString('en-US')} photos, ${o.videos.toLocaleString('en-US')} videos`
}
