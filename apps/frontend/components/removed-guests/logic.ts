// =============================================================================
//  HyperProx — removed guests: the page's view of /api/removed-guests
// =============================================================================

export type HoldingGroup = 'hyperprox' | 'cluster' | 'published'

export interface Holding {
  id: string
  kind: string
  group: HoldingGroup
  label: string
  change: string
  vault?: string[]
  job?: { id: string; before: number[]; after: number[]; empty: boolean; schedule: string | null; comment: string | null }
  plugin?: string
}

export interface RemovedGuest {
  vmid: number
  type: 'lxc' | 'qemu' | null
  name: string | null
  removedAt: number | null
  dateFrom: 'task' | 'last-seen' | 'noticed'
  noticedAt: number
  reused: { name: string; type: 'lxc' | 'qemu'; at: number } | null
  words: string
  holdings: Holding[]
  unread: string[]
}

export interface CleanResult { id: string; kind: string; outcome: 'removed' | 'kept' | 'failed'; words: string }

/** The guests a plug-in page shows: those holding something of that plug-in. All of them without a plug-in. */
export function forPlugin(guests: RemovedGuest[], plugin?: string): RemovedGuest[] {
  return plugin ? guests.filter(g => g.holdings.some(h => h.plugin === plugin)) : guests
}

/** What Clean up does, by group: HyperProx's records, the cluster's config (with each job's line), what was published. */
export function plan(g: RemovedGuest) {
  return {
    records: g.holdings.filter(h => h.group === 'hyperprox'),
    cluster: g.holdings.filter(h => h.group === 'cluster'),
    published: g.holdings.filter(h => h.group === 'published'),
    emptyJobs: g.holdings.filter(h => h.job?.empty).map(h => h.job!.id),
    vault: [...new Set(g.holdings.flatMap(h => h.vault ?? []))],
  }
}

/** A backup job's exact change: "vmid 100,105,110 → 100,110". */
export function jobLine(h: Holding): string {
  if (!h.job) return h.change
  return h.job.empty ? `vmid ${h.job.before.join(',')} → (nothing left)` : `vmid ${h.job.before.join(',')} → ${h.job.after.join(',')}`
}

export const guestWord = (g: Pick<RemovedGuest, 'type'>) => g.type === 'qemu' ? 'VM' : g.type === 'lxc' ? 'container' : 'guest'

export function resultSummary(results: CleanResult[]): string {
  const done = results.filter(r => r.outcome === 'removed').length
  const kept = results.filter(r => r.outcome === 'kept').length
  const failed = results.filter(r => r.outcome === 'failed').length
  return [`${done} cleaned up`, kept ? `${kept} kept` : '', failed ? `${failed} did not work` : ''].filter(Boolean).join(', ') + '.'
}
