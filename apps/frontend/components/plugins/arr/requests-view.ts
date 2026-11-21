// =============================================================================
//  HyperProx — Arr Stack, Requests tab: the page's pure helpers
//
//  The shapes the API answers (routes/arr-requests.ts) take, and the words the tab builds from them. No fetching here,
//  so the tab is tested by rendering (test/arr-requests.test.tsx). The confirmation sentences match the ones the server
//  asks for (lib/confirm-text.ts), which are the ones that count.
// =============================================================================

export type Group = 'pending' | 'approved' | 'downloading' | 'available' | 'failed' | 'declined'
export const GROUP_ORDER: Group[] = ['pending', 'approved', 'downloading', 'available', 'failed', 'declined']
export const GROUP_WORD: Record<Group, string> = {
  pending: 'Waiting', approved: 'Approved', downloading: 'Downloading', available: 'Available', failed: 'Failed', declined: 'Declined',
}

export interface RequestRow {
  id: number; kind: 'movie' | 'tv'; title: string; year: number | null; poster: string | null; group: Group; where: string
  progress: number | null; who: string; at: string; seasons: number | null; sortedInto: string | null; reason: string | null; is4k: boolean
}
export interface Listing { configured: boolean; rows: RequestRow[]; counts: Record<Group, number>; readAt: string; capped: boolean }

export interface StaleServer {
  app: 'radarr' | 'sonarr'; serverId: number; name: string; nowProfile: string; nowFolder: string
  profileStale: boolean; folderStale: boolean; wantProfileId: number | null; wantProfile: string | null; wantFolder: string | null
}
export interface HealthProblem { kind: 'radarr' | 'sonarr' | 'media'; serverId?: number; why: 'key' | 'down' | 'other'; text: string }
export interface Health { configured: boolean; problems: HealthProblem[]; stale: StaleServer[]; readAt: string }
export interface ActResult { action: string; done: boolean; summary: string; notes: string[] }

export type Act =
  | { action: 'approve'; id: number }
  | { action: 'decline'; id: number; reason?: string }
  | { action: 'retry'; id: number }
  | { action: 'fix-settings' }
  | { action: 'reconnect'; target: 'radarr' | 'sonarr' | 'media' }

export const ACT_LABEL = { approve: 'Approve', decline: 'Decline', retry: 'Try again', 'fix-settings': 'Fix Seerr\'s settings' } as const

/** The poster's HyperProx path for a row, or null. */
export const posterPath = (r: Pick<RequestRow, 'poster'>): string | null => (r.poster && /^[A-Za-z0-9_-]{5,60}\.(jpg|jpeg|png|webp)$/.test(r.poster) ? `/api/plugins/arrstack/requests/poster/${r.poster}` : null)

export const kindWord = (r: Pick<RequestRow, 'kind' | 'seasons'>) => (r.kind === 'movie' ? 'Film' : r.seasons ? `Show, ${r.seasons} ${r.seasons === 1 ? 'season' : 'seasons'}` : 'Show')

/** "2 days ago", "today". */
export function ago(iso: string, now = Date.now()): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const d = Math.floor((now - t) / 86_400_000)
  if (d <= 0) return 'today'
  if (d === 1) return 'yesterday'
  if (d < 14) return `${d} days ago`
  if (d < 60) return `${Math.round(d / 7)} weeks ago`
  return `${Math.round(d / 30)} months ago`
}

/** The sentence a button's confirmation shows (the server's own sentence is what binds the action). */
export function confirmText(a: Act, title?: string): string {
  const what = title ? `"${title}"` : 'this request'
  switch (a.action) {
    case 'approve': return `Approve ${what}? Seerr sends it to Radarr or Sonarr to download.`
    case 'decline': return `Decline ${what}${a.reason ? ' with your reason' : ''}? It will not be downloaded.`
    case 'retry': return `Send ${what} to Radarr or Sonarr again?`
    case 'fix-settings': return 'Point Seerr\'s Radarr and Sonarr settings at the quality profile and library folder they have now? Only Seerr\'s own settings change.'
    case 'reconnect': return a.target === 'media'
      ? 'Reconnect Seerr to your media server with the sign-in HyperProx has saved? Only Seerr\'s own settings change.'
      : `Put the ${a.target === 'sonarr' ? 'Sonarr' : 'Radarr'} key HyperProx has saved back into Seerr? Only Seerr\'s own settings change.`
  }
}

export const reconnectLabel = (k: HealthProblem['kind']) => (k === 'media' ? 'Reconnect the media server' : `Reconnect ${k === 'sonarr' ? 'Sonarr' : 'Radarr'}`)

/** What a stale entry is pointed at now and what the fix will use, in one sentence. */
export function staleWords(s: StaleServer): string {
  const bits: string[] = []
  if (s.profileStale) bits.push(`the quality profile "${s.nowProfile}"${s.wantProfile ? `, which ${s.app === 'radarr' ? 'Radarr' : 'Sonarr'} no longer has, so it would use "${s.wantProfile}"` : ''}`)
  if (s.folderStale) bits.push(`the folder ${s.nowFolder}${s.wantFolder ? `, which is gone, so it would use ${s.wantFolder}` : ''}`)
  return `Seerr's ${s.name} still points at ${bits.join(' and ')}. Requests sent there fail.`
}

/** The rows of one group, or all of them. */
export const rowsIn = (rows: RequestRow[], g: Group | 'all') => (g === 'all' ? rows : rows.filter(r => r.group === g))

/** The first group worth showing: waiting ones if there are any, then failed, else everything. */
export function firstGroup(c: Record<Group, number>): Group | 'all' {
  if (c.pending > 0) return 'pending'
  if (c.failed > 0) return 'failed'
  return 'all'
}
