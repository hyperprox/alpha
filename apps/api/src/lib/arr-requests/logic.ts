// =============================================================================
//  HyperProx — Arr Stack, Seerr requests: reading them
//
//  Pure functions over what Seerr answers (GET /api/v1/request, one title lookup per film or show). Seerr keeps two
//  statuses, the request's (pending, approved, declined, failed) and the media's (processing, available), and a
//  download's progress; the page wants one plain word for where a request is now. Who asked is for admins only: a
//  viewer, and an API token, see "a family member". Nothing here makes a request; it only reads and shapes.
// =============================================================================

export type Group = 'pending' | 'approved' | 'downloading' | 'available' | 'failed' | 'declined'
export const GROUPS: Group[] = ['pending', 'approved', 'downloading', 'available', 'failed', 'declined']
export const GROUP_WORD: Record<Group, string> = {
  pending: 'Waiting for approval', approved: 'Approved', downloading: 'Downloading', available: 'Available', failed: 'Failed', declined: 'Declined',
}

// Seerr's own numbers (server/constants/media.ts).
const REQ_PENDING = 1, REQ_APPROVED = 2, REQ_DECLINED = 3, REQ_FAILED = 4, REQ_COMPLETED = 5
const MEDIA_PROCESSING = 3, MEDIA_PARTIAL = 4, MEDIA_AVAILABLE = 5

export type Kind = 'movie' | 'tv'

export interface RequestRow {
  id: number
  kind: Kind
  title: string
  year: number | null
  /** The file name of the poster in TMDB's image folder ("abc123.jpg"), or null. The page asks HyperProx for it. */
  poster: string | null
  group: Group
  /** Plain words for where it is now. */
  where: string
  /** Download progress, 0 to 1, while it downloads. */
  progress: number | null
  /** Who asked: a name for an admin, "a family member" for everyone else. */
  who: string
  at: string
  /** TV: how many seasons were asked for. */
  seasons: number | null
  /** The folder the folder sorter put it in, when it did. */
  sortedInto: string | null
  /** The decline reason, when Seerr kept one. */
  reason: string | null
  /** The request is for 4K. */
  is4k: boolean
}

export interface TitleInfo { title: string; year: number | null; poster: string | null }

const POSTER = /^\/?([A-Za-z0-9_-]{5,60}\.(?:jpg|jpeg|png|webp))$/

/** A TMDB poster path ("/abc.jpg") as the file name only; anything else is null. */
export function posterFile(v: unknown): string | null {
  const m = typeof v === 'string' ? POSTER.exec(v) : null
  return m ? m[1] : null
}

const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').trim().slice(0, max) : '')
const yearOf = (v: unknown): number | null => { const m = /^(\d{4})/.exec(String(v ?? '')); return m ? Number(m[1]) : null }

/** The film or show behind a request, from Seerr's /movie/{id} or /tv/{id} answer. */
export function titleOf(kind: Kind, raw: any): TitleInfo {
  const title = clean(kind === 'movie' ? raw?.title : raw?.name, 160)
  return { title, year: yearOf(kind === 'movie' ? raw?.releaseDate : raw?.firstAirDate), poster: posterFile(raw?.posterPath) }
}

/** Which group a request is in, and the words for it. */
export function classify(raw: any): { group: Group; progress: number | null; where: string } {
  const status = Number(raw?.status), media = raw?.media ?? {}
  const arr = raw?.media?.mediaType === 'tv' ? 'Sonarr' : 'Radarr'
  if (status === REQ_PENDING) return { group: 'pending', progress: null, where: 'Waiting for an admin to approve it.' }
  if (status === REQ_DECLINED) return { group: 'declined', progress: null, where: 'Declined.' }
  if (status === REQ_FAILED) return { group: 'failed', progress: null, where: `Seerr could not send it to ${arr}.` }
  if (status === REQ_COMPLETED || Number(media.status) === MEDIA_AVAILABLE) return { group: 'available', progress: null, where: 'In the library, ready to watch.' }
  if (status === REQ_APPROVED) {
    const dl: any[] = Array.isArray(media.downloadStatus) ? media.downloadStatus : []
    if (dl.length) {
      const size = dl.reduce((n, d) => n + (Number(d?.size) || 0), 0)
      const left = dl.reduce((n, d) => n + (Number(d?.sizeLeft) || 0), 0)
      const p = size > 0 ? Math.min(1, Math.max(0, (size - left) / size)) : null
      return { group: 'downloading', progress: p, where: p === null ? 'Downloading.' : `Downloading, ${Math.round(p * 100)}% done.` }
    }
    if (Number(media.status) === MEDIA_PARTIAL) return { group: 'available', progress: null, where: 'Part of it is in the library.' }
    return { group: 'approved', progress: null, where: `Approved. ${arr} is looking for a copy.` }
  }
  return { group: 'approved', progress: null, where: 'Approved.' }
}

/** The name Seerr shows for a person. */
export function personOf(u: any): string {
  return clean(u?.displayName, 60) || clean(u?.jellyfinUsername, 60) || clean(u?.plexUsername, 60) || clean(u?.username, 60) || clean(u?.email, 60) || 'someone'
}

export const FAMILY = 'a family member'

/** "Paper Lanterns" and "paper lanterns (2011)" are the same title. */
export const normTitle = (s: string) => s.toLowerCase().replace(/\(\d{4}\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim()

export interface SortedMove { app: 'radarr' | 'sonarr'; title: string; year: number; to: string; ok: boolean }

/** The folder name the folder sorter put a request's title in, or null when it has not sorted it. */
export function sortedFor(kind: Kind, title: string, year: number | null, moves: SortedMove[]): string | null {
  const want = normTitle(title)
  if (!want) return null
  const app = kind === 'movie' ? 'radarr' : 'sonarr'
  const m = moves.find(x => x.app === app && x.ok && normTitle(x.title) === want && (!year || !x.year || x.year === year))
  if (!m) return null
  const name = m.to.replace(/\/+$/, '').split('/').pop() ?? ''
  return clean(name, 80) || null
}

/** One row per request, newest first. `titles` is keyed "movie:123" or "tv:456". */
export function buildRows(raw: any[], titles: Map<string, TitleInfo>, moves: SortedMove[], admin: boolean): RequestRow[] {
  const rows: RequestRow[] = []
  for (const r of Array.isArray(raw) ? raw : []) {
    const id = Number(r?.id)
    const kind: Kind | null = r?.media?.mediaType === 'movie' ? 'movie' : r?.media?.mediaType === 'tv' ? 'tv' : r?.type === 'movie' ? 'movie' : r?.type === 'tv' ? 'tv' : null
    if (!Number.isInteger(id) || id < 1 || !kind) continue
    const info = titles.get(`${kind}:${r?.media?.tmdbId}`)
    const c = classify({ ...r, media: { ...(r.media ?? {}), mediaType: kind } })
    const title = info?.title || (kind === 'movie' ? 'A film' : 'A show')
    const seasons = kind === 'tv' && Array.isArray(r?.seasons) ? r.seasons.length : null
    rows.push({
      id, kind, title, year: info?.year ?? null, poster: info?.poster ?? null,
      group: c.group, where: c.where, progress: c.progress,
      who: admin ? personOf(r?.requestedBy) : FAMILY,
      at: typeof r?.createdAt === 'string' ? r.createdAt.slice(0, 40) : '',
      seasons: seasons || null,
      sortedInto: c.group === 'available' || c.group === 'downloading' || c.group === 'approved' ? sortedFor(kind, title, info?.year ?? null, moves) : null,
      reason: c.group === 'declined' ? (clean(r?.declineReason ?? r?.reason, 200) || null) : null,
      is4k: r?.is4k === true,
    })
  }
  return rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id - a.id)
}

export function countsOf(rows: RequestRow[]): Record<Group, number> {
  const c = Object.fromEntries(GROUPS.map(g => [g, 0])) as Record<Group, number>
  for (const r of rows) c[r.group]++
  return c
}

// ── Seerr's settings against the arr's own ───────────────────────────────────

export type ArrApp = 'radarr' | 'sonarr'
export interface ArrFacts { profiles: Array<{ id: number; name: string }>; roots: string[] }

export interface StaleServer {
  app: ArrApp
  /** Seerr's id for this server entry. */
  serverId: number
  name: string
  /** What Seerr points at now, in words. */
  nowProfile: string
  nowFolder: string
  profileStale: boolean
  folderStale: boolean
  /** What it would be pointed at. */
  wantProfileId: number | null
  wantProfile: string | null
  wantFolder: string | null
}

const trimSlash = (s: string) => (s.length > 1 ? s.replace(/\/+$/, '') : s)
const last = (p: string) => trimSlash(p).split('/').pop() ?? ''

/** A profile the arr has now, matched by name when Seerr's id is gone, else the arr's first. */
export function wantedProfile(profiles: ArrFacts['profiles'], wasName: string): { id: number; name: string } | null {
  return profiles.find(p => p.name.toLowerCase() === wasName.toLowerCase()) ?? profiles[0] ?? null
}

/** A root folder the arr has now: the same last folder name when there is one, else the arr's first. */
export function wantedFolder(roots: string[], was: string): string | null {
  return roots.find(r => last(r).toLowerCase() === last(was).toLowerCase() && last(was)) ?? roots[0] ?? null
}

/**
 * Seerr's server entries whose quality profile or root folder id/path no longer exists in the arr (a profile re-made,
 * a library folder renamed). Seerr keeps sending requests to them and the arr refuses: they show as Failed.
 */
export function staleServers(app: ArrApp, servers: any[], facts: ArrFacts): StaleServer[] {
  const out: StaleServer[] = []
  for (const s of Array.isArray(servers) ? servers : []) {
    const serverId = Number(s?.id)
    if (!Number.isInteger(serverId)) continue
    const profileStale = !facts.profiles.some(p => p.id === Number(s?.activeProfileId))
    const dir = clean(s?.activeDirectory, 300)
    const folderStale = !facts.roots.some(r => trimSlash(r) === trimSlash(dir))
    if (!profileStale && !folderStale) continue
    const wp = profileStale ? wantedProfile(facts.profiles, clean(s?.activeProfileName, 80)) : null
    out.push({
      app, serverId, name: clean(s?.name, 60) || (app === 'radarr' ? 'Radarr' : 'Sonarr'),
      nowProfile: clean(s?.activeProfileName, 80) || `profile ${Number(s?.activeProfileId) || '?'}`, nowFolder: dir || 'none',
      profileStale, folderStale,
      wantProfileId: wp?.id ?? null, wantProfile: wp?.name ?? null,
      wantFolder: folderStale ? wantedFolder(facts.roots, dir) : null,
    })
  }
  return out
}

/** The server entry with the fix applied: the whole object, since Seerr's PUT replaces it. */
export function fixedServer(entry: any, s: StaleServer): Record<string, unknown> {
  const out: Record<string, unknown> = { ...entry }
  if (s.profileStale && s.wantProfileId !== null) { out.activeProfileId = s.wantProfileId; out.activeProfileName = s.wantProfile }
  if (s.folderStale && s.wantFolder) out.activeDirectory = s.wantFolder
  return out
}

// ── Health ───────────────────────────────────────────────────────────────────

export type HealthKind = 'radarr' | 'sonarr' | 'media'
export interface HealthProblem {
  kind: HealthKind
  /** Seerr's server id, for radarr and sonarr. */
  serverId?: number
  /** `key`: the app refused the key Seerr holds; `down`: it did not answer; `other`: anything else. */
  why: 'key' | 'down' | 'other'
  text: string
}

export const APP_NAME: Record<HealthKind, string> = { radarr: 'Radarr', sonarr: 'Sonarr', media: 'the media server' }

/** What a failed connection test or library read means, in a plain sentence. Never repeats an address or a key. */
export function whyFailed(kind: HealthKind, e: unknown, mediaName = 'the media server'): HealthProblem['why'] {
  const text = String((e as any)?.message ?? e)
  if (/\b40[13]\b|unauthori[sz]ed|forbidden|api key|invalid key|token/i.test(text)) return 'key'
  if (/abort|time ?out|ECONN|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|fetch failed|\b5\d\d\b|failed to connect|could not|cannot/i.test(text)) return 'down'
  void kind; void mediaName
  return 'other'
}

export function problemText(kind: HealthKind, why: HealthProblem['why'], mediaName = 'the media server'): string {
  const who = kind === 'media' ? mediaName : APP_NAME[kind]
  if (why === 'key') return `Seerr cannot sign in to ${who}: the key or sign-in it holds was refused.`
  if (why === 'down') return `Seerr cannot reach ${who}. Requests cannot be sent or checked until it can.`
  return `Seerr could not use ${who}. Its answer was not what it expects.`
}
