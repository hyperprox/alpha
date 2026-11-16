// =============================================================================
//  HyperProx — Arr Stack, give up after X tries: the page's pure helpers
//
//  Shapes the API answers (routes/arr-giveup.ts) take, and the words the panels build from them. No fetching here,
//  so the panels are tested by rendering (test/arr-giveup.test.tsx).
// =============================================================================

export type App = 'sonarr' | 'radarr' | 'lidarr'
export const APPS: App[] = ['sonarr', 'radarr', 'lidarr']
export const APP_LABEL: Record<App, string> = { sonarr: 'TV', radarr: 'Films', lidarr: 'Music' }
export const APP_NAME: Record<App, string> = { sonarr: 'Sonarr', radarr: 'Radarr', lidarr: 'Lidarr' }

export interface WeeklySearch { enabled: boolean; day: number; hour: number }
export interface Settings { enabled: boolean; weeks: number; action: 'unmonitor' | 'remove'; search: WeeklySearch }
export interface SearchRun { at: string; app: App; count: number; commandId: number | null; status: string; error?: string }
export interface Reason { code: string; text: string }
export interface Row {
  key: string; app: App; keys: string[]; title: string; detail: string; tries: number; since: string; reason: Reason
  gaveUpAt?: string; action?: 'unmonitor' | 'remove'; season?: { number: number; episodes: number }
}
export interface RunResult { at: string; app: App; given: number; skipped: Array<{ title: string; why: string }>; failed: Array<{ title: string; why: string }>; error?: string }
export interface AppStatus { app: App; configured: boolean; settings: Settings; tracking: number; givenUp: number; soon: number; observedAt: string | null; lastRun: RunResult | null; lastSearch: SearchRun | null; nextSearch: string | null }
export interface Status { apps: AppStatus[]; givenUp: Row[] }
export interface Preview {
  previewId: string; app: App; summary: string; count: number; series?: number; rows: Row[]
  reasons: Array<{ code: string; text: string; count: number }>; tracking: number; capped: boolean; observedAt: string | null
}

export interface Release {
  id: string; title: string; quality: string; resolution: number | null; source: string; codec: string; size: number
  protocol: 'torrent' | 'usenet' | 'unknown'; seeders: number | null; peers: number | null; ageDays: number | null; grabs: number | null
  indexer: string; languages: string[]; approved: boolean; topPick: boolean; reasons: string[]; executable: boolean
  belowProfile: boolean; belowNote?: string
}
export interface ReleaseAnswer {
  rows: Release[]; found: number; approved: number; hidden: { av1: number; threeD: number; hfr: number; zeroSeed: number }; top: string[]
  target: string; label: string; searchedAt: string; reused: boolean; nextSearchAt: string
}
export interface GrabAnswer { result: 'queued' | 'not-seen' | 'removed-executable'; filesChecked: boolean; summary: string; notes: string[] }

/** The Missing panel's row ids ("tv-12", "film-3", "music-9") as the API's item keys. */
export function missingTarget(id: string): string | null {
  const m = /^(tv|film|music)-(\d{1,10})$/.exec(id)
  if (!m) return null
  return `${m[1] === 'tv' ? 'sonarr' : m[1] === 'film' ? 'radarr' : 'lidarr'}:${m[2]}`
}

/** The release search target for a given-up row: a whole season is searched as a season. */
export function rowTarget(r: Row): string {
  return r.season ? r.key : r.keys[0]
}

export function sizeWord(n: number): string {
  if (!n || n < 0) return '?'
  const gb = n / 1024 ** 3
  return gb >= 1 ? `${gb.toFixed(gb >= 10 ? 0 : 1)} GB` : `${Math.round(n / 1024 ** 2)} MB`
}

/** "today", "3 days ago", "12 Nov". */
export function sinceWord(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const days = Math.floor((now - t) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 60) return `${days} days ago`
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** What the hidden counts say, or null when nothing is hidden by the hard rules. */
export function hiddenWord(h: ReleaseAnswer['hidden']): string | null {
  const n = h.av1 + h.threeD + h.hfr
  if (!n) return null
  const parts = [h.av1 ? `${h.av1} AV1` : '', h.threeD ? `${h.threeD} 3D` : '', h.hfr ? `${h.hfr} 48 fps` : ''].filter(Boolean)
  return `${n} hidden: ${parts.join(', ')}. These are never offered.`
}

/** Swarm health 0-1 for the seeders bar: 0 seeders empty, 50 or more full. */
export const swarm = (seeders: number | null) => (seeders === null ? 0 : Math.max(0, Math.min(1, Math.log10(seeders + 1) / Math.log10(51))))

/** The confirm text for "Download this". */
export function grabConfirm(r: Release, label: string, app: App): string {
  const head = `Download ${r.title} for ${label}?`
  if (r.belowNote) return `${head} ${r.belowNote}`
  if (!r.approved) return `${head} ${APP_NAME[app]} rejected it (${r.reasons.join('; ') || 'no reason given'}). It will be downloaded anyway; nothing about your quality profile changes.`
  return `${head} ${APP_NAME[app]} would accept it.`
}

export const ACTION_WORD: Record<'unmonitor' | 'remove', string> = { unmonitor: 'Stopped searching', remove: 'Removed from the library' }

/** The rule in one line. */
export function ruleWord(s: Settings, app: App): string {
  const what = s.action === 'remove' ? 'remove it from the library (no files are deleted)' : 'stop searching (everything is kept)'
  const n = s.weeks === 1 ? '1 week' : `${s.weeks} weeks`
  return `Give up after ${n} of weekly searches with nothing found, then ${what}. ${app === 'sonarr' ? 'An episode' : app === 'radarr' ? 'A film' : 'An album'} must be missing at least ${n} and searched at least ${s.weeks} ${s.weeks === 1 ? 'time' : 'times'}.`
}

export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
export const hourWord = (h: number) => `${String(h).padStart(2, '0')}:00`

/** "Every Monday at 08:00". */
export const searchWhen = (w: WeeklySearch) => `every ${DAYS[w.day] ?? '?'} at ${hourWord(w.hour)}`

/** "Last weekly search: Sunday 08:00 — 68 films searched (completed)." */
export function lastSearchWord(r: SearchRun | null, app: App): string | null {
  if (!r) return null
  const d = new Date(r.at)
  const when = `${DAYS[d.getDay()]} ${hourWord(d.getHours()).slice(0, 2)}:${String(d.getMinutes()).padStart(2, '0')}`
  if (r.error) return `Last weekly search: ${when} — it did not run: ${r.error}`
  const what = APP_LABEL[app] === 'TV' ? (r.count === 1 ? 'episode' : 'episodes') : APP_LABEL[app] === 'Films' ? (r.count === 1 ? 'film' : 'films') : (r.count === 1 ? 'album' : 'albums')
  return `Last weekly search: ${when} — ${r.count} ${what} searched (${r.status}).`
}
