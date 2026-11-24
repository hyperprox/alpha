// =============================================================================
//  HyperProx — Arr Stack, the queue in plain words: the page's pure helpers
//
//  The shapes the queue route answers under `plain` (lib/arr-queue/plain.ts on the API), and the few words the page
//  builds from them. The summary sentence and every count come from the server, so the dashboard tile, the header and
//  the Advanced tab quote the same reading. No React and no fetching here, so it is tested by plain calls.
// =============================================================================

export type LiveState = 'downloading' | 'waiting' | 'paused' | 'stuck' | 'problem' | 'done'
export type ItemKind = 'show' | 'film' | 'artist'
export type Instance = 'sonarr' | 'radarr' | 'lidarr'
export type Problem = 'failed' | 'blocked' | 'incomplete' | 'sample' | 'stalled' | 'warning'

export interface PlainDownload {
  id: string; state: LiveState; text: string; progress: number; size: number; sizeLeft: number; episodes: number; problem: Problem | null; torrent: boolean
}
export interface PlainChild { key: string; label: string; state: LiveState; text: string; progress: number; sizeLeft: number; downloads: PlainDownload[] }
export interface PlainItem {
  key: string; kind: ItemKind; instance: Instance; title: string; detail: string; order: number; state: LiveState; text: string; line: number | null
  progress: number; sizeLeft: number; etaSec: number | null; problem: Problem | null
  downloadIds: string[]; problemIds: string[]; torrentIds: string[]; children: PlainChild[]
}
export interface NeedItem {
  key: string; kind: ItemKind; instance: Instance; title: string; severity: 'bad' | 'warn'; what: string
  problemIds: string[]; retryIds: string[]; blocked: boolean
}
export interface PlainSummary {
  shows: number; films: number; artists: number; downloading: number; waiting: number; stuck: number; requestsStuck: number; done: number
  sizeLeft: number; speedBps: number | null; text: string; unit: string
}
export interface PlainData { summary: PlainSummary; items: PlainItem[]; needs: NeedItem[] }

/** "Show", "Film", "Artist": what one row is, in a word. */
export const KIND_WORD: Record<ItemKind, string> = { show: 'Show', film: 'Film', artist: 'Artist' }

/**
 * The count on the "Needs you" tab and in the header: everything the server counted (stuck downloads, failed requests,
 * faults in Seerr's links) plus finished downloads this page found that cannot be filed (read by the page on its own).
 */
export function needsCount(p: PlainData | null | undefined, unfiled = 0): number {
  return (p?.summary.stuck ?? 0) + unfiled
}

/** The summary line, with unfiled finished downloads added to the stuck count the same way the tab does. */
export function summaryLine(p: PlainData | null | undefined, unfiled = 0): string {
  if (!p) return 'Reading the queue…'
  if (!unfiled) return p.summary.text
  const t = p.summary.text
  const n = p.summary.stuck + unfiled
  return /nothing stuck$/.test(t) ? t.replace(/nothing stuck$/, `${n} stuck`) : /\d+ stuck$/.test(t) ? t.replace(/\d+ stuck$/, `${n} stuck`) : `${t} · ${n} stuck`
}

/** A queue row's state as a dot colour name. */
export function toneOf(s: LiveState): 'good' | 'accent' | 'warn' | 'bad' | 'dim' {
  return s === 'downloading' ? 'accent' : s === 'done' ? 'good' : s === 'problem' ? 'bad' : s === 'stuck' ? 'warn' : 'dim'
}

/** Which of an item's downloads can be searched for in the release list ("Find better copy"): only a real download id. */
export function findableId(it: Pick<PlainItem, 'downloadIds'>): string | null {
  return it.downloadIds.length === 1 && /^d:[\x21-\x7e]{1,200}$/.test(it.downloadIds[0]) ? it.downloadIds[0] : null
}

/** Sizes as the dashboard tile writes them (decimal): "1.9 GB", "791 MB". */
export function sizeWord(bytes: number): string {
  const v = Number(bytes)
  if (!Number.isFinite(v) || v <= 0) return '0 B'
  if (v >= 1e12) return `${(v / 1e12).toFixed(2)} TB`
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)} GB`
  if (v >= 1e6) return `${(v / 1e6).toFixed(0)} MB`
  return `${Math.max(1, Math.round(v / 1e3))} KB`
}

/** "1.9 GB left", for a row; empty when nothing is left. */
export const leftWord = (bytes: number): string => (bytes > 0 ? `${sizeWord(bytes)} left` : '')

/** "2 downloads", "1 download". */
export const downloadsWord = (n: number) => `${n} ${n === 1 ? 'download' : 'downloads'}`
