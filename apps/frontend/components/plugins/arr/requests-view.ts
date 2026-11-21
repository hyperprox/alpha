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
  progress: number | null; who: string; at: string; seasons: number | null; sortedInto: string | null; is4k: boolean
}
export interface Listing { configured: boolean; rows: RequestRow[]; counts: Record<Group, number>; readAt: string; capped: boolean }

export type FixField = 'profile' | 'folder' | 'animeProfile' | 'animeFolder'
export interface Prof { id: number; name: string }
/** Something Seerr points at that the arr no longer has. `want` is null when nothing has the same name: the admin chooses. */
export interface StaleField<T> { now: string; want: T | null; options: T[] }
export interface StaleServer {
  app: 'radarr' | 'sonarr'; serverId: number; name: string
  profile?: StaleField<Prof>; folder?: StaleField<string>; animeProfile?: StaleField<Prof>; animeFolder?: StaleField<string>
}
export interface FixChoice { app: 'radarr' | 'sonarr'; serverId: number; field: FixField; value: string }
export interface HealthProblem { kind: 'radarr' | 'sonarr' | 'media'; serverId?: number; why: 'key' | 'down' | 'other'; text: string }
export interface Health { configured: boolean; problems: HealthProblem[]; stale: StaleServer[]; staleId: string; readAt: string }
export interface ActResult { action: string; done: boolean; summary: string; notes: string[] }

export type Act =
  | { action: 'approve'; id: number }
  | { action: 'decline'; id: number }
  | { action: 'retry'; id: number }
  | { action: 'fix-settings'; baseId: string; choices: FixChoice[] }
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
    case 'decline': return `Decline ${what}? It will not be downloaded.`
    case 'retry': return `Send ${what} to Radarr or Sonarr again?`
    case 'fix-settings': return 'Change Seerr\'s settings? Only Seerr\'s own settings change; nothing in Radarr or Sonarr is touched.'
    case 'reconnect': return a.target === 'media'
      ? 'Reconnect Seerr to your media server with the sign-in HyperProx has saved? Only Seerr\'s own settings change.'
      : `Put the ${a.target === 'sonarr' ? 'Sonarr' : 'Radarr'} key HyperProx has saved back into Seerr? Only Seerr\'s own settings change.`
  }
}

export const reconnectLabel = (k: HealthProblem['kind']) => (k === 'media' ? 'Reconnect the media server' : `Reconnect ${k === 'sonarr' ? 'Sonarr' : 'Radarr'}`)

export const FIELD_WORD: Record<FixField, string> = { profile: 'quality profile', folder: 'folder', animeProfile: 'anime profile', animeFolder: 'anime folder' }
export const FIELDS: FixField[] = ['profile', 'folder', 'animeProfile', 'animeFolder']

/** What one field would change to: the admin's choice, else the match by name, else nothing yet. */
export function fixTarget(s: StaleServer, field: FixField, choices: FixChoice[]): string | null {
  const f = s[field] as StaleField<Prof | string> | undefined
  if (!f) return null
  const pick = choices.find(c => c.app === s.app && c.serverId === s.serverId && c.field === field)
  if (pick) {
    const hit = (f.options as Array<Prof | string>).find(o => (typeof o === 'string' ? o : String(o.id)) === pick.value)
    return hit === undefined ? null : typeof hit === 'string' ? hit : hit.name
  }
  return f.want === null ? null : typeof f.want === 'string' ? f.want : f.want.name
}

/** True while some field has no match by name and no choice yet. */
export const needsChoice = (stale: StaleServer[], choices: FixChoice[]) => stale.some(s => FIELDS.some(f => s[f] && fixTarget(s, f, choices) === null))

/** The confirmation for "Fix Seerr's settings": every server, old to new. The same words the server confirms (lib/confirm-text.ts, from lib/arr-requests/logic.ts describeFix). */
export function fixSentence(stale: StaleServer[], choices: FixChoice[]): string {
  const parts = stale.map(s => `${s.name} (${s.app === 'radarr' ? 'Radarr' : 'Sonarr'}): ${FIELDS.filter(f => s[f]).map(f => `${FIELD_WORD[f]} "${(s[f] as StaleField<unknown>).now}" → "${fixTarget(s, f, choices)}"`).join(', ')}`)
  return `Change Seerr's settings? ${parts.join('; ')}. Only Seerr's own settings change; nothing in Radarr or Sonarr is touched.`
}

/** The rows of one group, or all of them. */
export const rowsIn = (rows: RequestRow[], g: Group | 'all') => (g === 'all' ? rows : rows.filter(r => r.group === g))

/** The first group worth showing: waiting ones if there are any, then failed, else everything. */
export function firstGroup(c: Record<Group, number>): Group | 'all' {
  if (c.pending > 0) return 'pending'
  if (c.failed > 0) return 'failed'
  return 'all'
}
