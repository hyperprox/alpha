// =============================================================================
//  HyperProx — Arr Stack, Seerr requests: reading them
//
//  Pure functions over what Seerr answers (GET /api/v1/request, one title lookup per film or show). Seerr keeps two
//  statuses, the request's (pending, approved, declined, failed) and the media's (processing, available), and a
//  download's progress; the page wants one plain word for where a request is now. Who asked is for admins only: a
//  viewer, and an API token, see "a family member". Nothing here makes a request; it only reads and shapes.
// =============================================================================

import { createHash } from 'node:crypto'

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
export type FixField = 'profile' | 'folder' | 'animeProfile' | 'animeFolder'
export const FIX_FIELDS: FixField[] = ['profile', 'folder', 'animeProfile', 'animeFolder']
export interface Prof { id: number; name: string }

/** One thing in a Seerr server entry that points at something the arr no longer has. `want` is null when nothing the arr has matches by name: the admin chooses from `options`. */
export interface StaleField<T> { now: string; want: T | null; options: T[] }

export interface StaleServer {
  app: ArrApp
  /** Seerr's id for this server entry. */
  serverId: number
  name: string
  profile?: StaleField<Prof>
  folder?: StaleField<string>
  /** Sonarr only: the anime profile and folder. */
  animeProfile?: StaleField<Prof>
  animeFolder?: StaleField<string>
}

const trimSlash = (s: string) => (s.length > 1 ? s.replace(/\/+$/, '') : s)
const last = (p: string) => trimSlash(p).split('/').pop() ?? ''

/** A profile the arr has now with the same name as the one Seerr remembers. No match is null: nothing is guessed. */
export function wantedProfile(profiles: ArrFacts['profiles'], wasName: string): Prof | null {
  return wasName ? profiles.find(p => p.name.toLowerCase() === wasName.toLowerCase()) ?? null : null
}

/** A root folder the arr has now with the same last folder name. No match is null: nothing is guessed. */
export function wantedFolder(roots: string[], was: string): string | null {
  const l = last(was).toLowerCase()
  return l ? roots.find(r => last(r).toLowerCase() === l) ?? null : null
}

const profField = (id: unknown, name: unknown, facts: ArrFacts): StaleField<Prof> | undefined => {
  if (id === null || id === undefined || id === '') return undefined
  const n = Number(id)
  if (facts.profiles.some(p => p.id === n)) return undefined
  const was = clean(name, 80)
  return { now: was || `profile ${Number.isFinite(n) ? n : '?'}`, want: wantedProfile(facts.profiles, was), options: facts.profiles }
}
const dirField = (dir: unknown, facts: ArrFacts): StaleField<string> | undefined => {
  const d = clean(dir, 300)
  if (!d || facts.roots.some(r => trimSlash(r) === trimSlash(d))) return undefined
  return { now: d, want: wantedFolder(facts.roots, d), options: facts.roots }
}

/**
 * Seerr's server entries whose quality profile or root folder (Sonarr: and anime profile and folder) no longer exists in
 * the arr (a profile re-made, a library folder renamed). Seerr keeps sending requests to them and the arr refuses.
 */
export function staleServers(app: ArrApp, servers: any[], facts: ArrFacts): StaleServer[] {
  const out: StaleServer[] = []
  for (const s of Array.isArray(servers) ? servers : []) {
    const serverId = Number(s?.id)
    if (!Number.isInteger(serverId)) continue
    const e: StaleServer = { app, serverId, name: clean(s?.name, 60) || (app === 'radarr' ? 'Radarr' : 'Sonarr') }
    const p = profField(s?.activeProfileId, s?.activeProfileName, facts); if (p) e.profile = p
    const f = dirField(s?.activeDirectory, facts); if (f) e.folder = f
    if (app === 'sonarr') {
      const ap = profField(s?.activeAnimeProfileId, s?.activeAnimeProfileName, facts); if (ap) e.animeProfile = ap
      const af = dirField(s?.activeAnimeDirectory, facts); if (af) e.animeFolder = af
    }
    if (e.profile || e.folder || e.animeProfile || e.animeFolder) out.push(e)
  }
  return out
}

/** What an admin picked where nothing matched by name: the value is a profile id or a folder path. */
export interface FixChoice { app: ArrApp; serverId: number; field: FixField; value: string }

export interface FixLine { field: FixField; from: string; to: string; toId?: number }
export interface FixItem { app: ArrApp; serverId: number; name: string; lines: FixLine[] }

const FIELD_WORD: Record<FixField, string> = { profile: 'quality profile', folder: 'folder', animeProfile: 'anime profile', animeFolder: 'anime folder' }

/**
 * The exact changes for a stale set and the admin's choices, plus the fields still waiting for a choice. The same function
 * builds the confirmation's words and the changes the action makes.
 */
export function planFix(stale: StaleServer[], choices: FixChoice[] = []): { items: FixItem[]; unresolved: Array<{ app: ArrApp; serverId: number; name: string; field: FixField }>; invalid: string[] } {
  const items: FixItem[] = [], unresolved: Array<{ app: ArrApp; serverId: number; name: string; field: FixField }> = [], invalid: string[] = []
  for (const c of choices) if (!stale.some(s => s.app === c.app && s.serverId === c.serverId && s[c.field])) invalid.push(`${c.app} ${c.serverId} ${c.field}`)
  for (const s of stale) {
    const lines: FixLine[] = []
    for (const field of FIX_FIELDS) {
      const f = s[field] as StaleField<Prof | string> | undefined
      if (!f) continue
      const pick = choices.find(c => c.app === s.app && c.serverId === s.serverId && c.field === field)
      let to: Prof | string | null = f.want
      if (pick) {
        const hit = field === 'profile' || field === 'animeProfile'
          ? (f.options as Prof[]).find(p => String(p.id) === pick.value) ?? null
          : (f.options as string[]).find(r => r === pick.value) ?? null
        if (!hit) { invalid.push(`${s.app} ${s.serverId} ${field}`); continue }
        to = hit
      }
      if (to === null) { unresolved.push({ app: s.app, serverId: s.serverId, name: s.name, field }); continue }
      lines.push(typeof to === 'string' ? { field, from: f.now, to } : { field, from: f.now, to: to.name, toId: to.id })
    }
    if (lines.length) items.push({ app: s.app, serverId: s.serverId, name: s.name, lines })
  }
  return { items, unresolved, invalid }
}

/** The confirmation sentence: server, old to new profile and folder, nothing hidden. */
export function describeFix(items: FixItem[]): string {
  const parts = items.map(i => `${i.name} (${i.app === 'radarr' ? 'Radarr' : 'Sonarr'}): ${i.lines.map(l => `${FIELD_WORD[l.field]} "${l.from}" → "${l.to}"`).join(', ')}`)
  return `Change Seerr's settings? ${parts.join('; ')}. Only Seerr's own settings change; nothing in Radarr or Sonarr is touched.`
}

/** A short fingerprint of the stale set, so an action can tell that what was confirmed is what it is about to change. */
export function staleId(stale: StaleServer[]): string {
  return createHash('sha256').update(JSON.stringify(stale)).digest('hex').slice(0, 16)
}

/** The server entry with the plan applied: the whole object, since Seerr's PUT replaces it. */
export function fixedServer(entry: any, item: FixItem): Record<string, unknown> {
  const out: Record<string, unknown> = { ...entry }
  for (const l of item.lines) {
    if (l.field === 'profile') { out.activeProfileId = l.toId; out.activeProfileName = l.to }
    else if (l.field === 'animeProfile') { out.activeAnimeProfileId = l.toId; out.activeAnimeProfileName = l.to }
    else if (l.field === 'folder') out.activeDirectory = l.to
    else out.activeAnimeDirectory = l.to
  }
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
