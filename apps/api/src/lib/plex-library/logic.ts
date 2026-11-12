// =============================================================================
//  HyperProx — Plex Library view: pure parts
//
//  Episode mapping: a Plex episode is matched to its Sonarr episode (and so its
//  episode file) by the show's tvdb id plus season and episode number. Never by
//  title: two shows called the same, or a renamed episode, must not delete the
//  wrong file. A show without a tvdb id in Plex is simply not Sonarr's to
//  delete, and goes through Plex instead.
//
//  The next-up warning: people binge in order, so an episode is someone's next
//  one when they watched the episode before it in the last 14 days and have
//  not watched this one.
// =============================================================================

import { normTitle, type PlayRow } from '../plex-clearout/logic'

const n0 = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const str = (v: unknown, max = 160) => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : '')

export interface PlexVersion { mediaId: string; label: string; sizeBytes: number | null; files: string[] }

/** One episode from Plex's /library/metadata/<show>/allLeaves. */
export interface PlexEpisode {
  ratingKey: string; seasonKey: string | null; season: number; episode: number; title: string
  sizeBytes: number | null; quality: string; versions: PlexVersion[]
  /** Plex's own (server owner's) progress through it. */
  inProgress: boolean
}

export function versionsOf(m: any): PlexVersion[] {
  return (Array.isArray(m?.Media) ? m.Media : []).filter((md: any) => md?.id != null && /^\d+$/.test(String(md.id))).map((md: any) => {
    const parts: any[] = Array.isArray(md?.Part) ? md.Part : []
    const res = str(md?.videoResolution, 10)
    const codec = str(md?.videoCodec, 12).toUpperCase()
    const size = parts.reduce((a, p) => a + n0(p?.size), 0)
    return {
      mediaId: String(md.id),
      label: [res ? (/^\d+$/.test(res) ? `${res}p` : res.toUpperCase()) : '', codec].filter(Boolean).join(' · ') || 'unknown quality',
      sizeBytes: size || null,
      files: parts.map(p => str(p?.file, 400)).filter(Boolean),
    }
  })
}

export function plexEpisodes(body: any): PlexEpisode[] {
  const rows: any[] = Array.isArray(body?.MediaContainer?.Metadata) ? body.MediaContainer.Metadata : []
  return rows.filter(m => m?.type === 'episode' && /^\d+$/.test(String(m?.ratingKey ?? ''))).map(m => {
    const versions = versionsOf(m)
    return {
      ratingKey: String(m.ratingKey), seasonKey: m?.parentRatingKey != null ? String(m.parentRatingKey) : null,
      season: n0(m.parentIndex), episode: n0(m.index), title: str(m.title, 200) || `Episode ${n0(m.index)}`,
      sizeBytes: versions.reduce((a, v) => a + (v.sizeBytes ?? 0), 0) || null,
      quality: versions[0]?.label ?? '—', versions,
      inProgress: n0(m.viewOffset) > 0,
    }
  }).sort((a, b) => a.season - b.season || a.episode - b.episode)
}

/** The Sonarr series for a tvdb id, or null. Never by title. */
export function seriesByTvdb(series: any[], tvdbId: number | null): any | null {
  if (!tvdbId) return null
  const hits = (Array.isArray(series) ? series : []).filter(s => n0(s?.tvdbId) === tvdbId && typeof s?.id === 'number')
  return hits.length === 1 ? hits[0] : null
}

export interface SonarrLink { episodeId: number; fileId: number | null; monitored: boolean; filePath: string | null; fileSize: number | null; quality: string | null }

/**
 * Plex episodes to Sonarr episodes, by season and episode number within the series the tvdb id chose. An
 * episode Sonarr does not have, or that two Sonarr episodes claim, maps to nothing.
 */
export function mapEpisodes(eps: PlexEpisode[], sonarrEpisodes: any[], sonarrFiles: any[]): Map<string, SonarrLink> {
  const files = new Map<number, any>()
  for (const f of Array.isArray(sonarrFiles) ? sonarrFiles : []) if (typeof f?.id === 'number') files.set(f.id, f)
  const bySE = new Map<string, any[]>()
  for (const e of Array.isArray(sonarrEpisodes) ? sonarrEpisodes : []) {
    if (typeof e?.id !== 'number') continue
    const k = `${n0(e.seasonNumber)}x${n0(e.episodeNumber)}`
    bySE.set(k, [...(bySE.get(k) ?? []), e])
  }
  const out = new Map<string, SonarrLink>()
  for (const p of eps) {
    const hits = bySE.get(`${p.season}x${p.episode}`) ?? []
    if (hits.length !== 1) continue
    const e = hits[0]
    const fid = n0(e.episodeFileId) || null
    const f = fid ? files.get(fid) : undefined
    out.set(p.ratingKey, {
      episodeId: e.id, fileId: fid && f ? fid : null, monitored: !!e.monitored,
      filePath: f ? str(f.path, 400) || null : null, fileSize: f ? n0(f.size) || null : null,
      quality: f ? str(f?.quality?.quality?.name, 40) || null : null,
    })
  }
  return out
}

/** History rows that belong to this show: by its ratingKey, or (a re-download) by its title. */
export function showPlays(plays: PlayRow[], showKey: string, showTitle: string): PlayRow[] {
  const t = normTitle(showTitle)
  return plays.filter(r => r.type === 'episode' && (String(r.grandparentKey ?? '').endsWith(`/${showKey}`) || normTitle(r.grandparentTitle) === t))
}

export interface EpisodePlays { plays: number; lastPlayed: number | null; viewers: Set<number> }

export function playsByEpisode(eps: PlexEpisode[], rows: PlayRow[]): Map<string, EpisodePlays> {
  const bySE = new Map(eps.map(e => [`${e.season}x${e.episode}`, e.ratingKey]))
  const keys = new Set(eps.map(e => e.ratingKey))
  const out = new Map<string, EpisodePlays>()
  for (const r of rows) {
    const k = keys.has(r.ratingKey) ? r.ratingKey : r.season && r.episode ? bySE.get(`${r.season}x${r.episode}`) : undefined
    if (!k) continue
    const e = out.get(k) ?? { plays: 0, lastPlayed: null, viewers: new Set<number>() }
    e.plays++
    e.viewers.add(r.accountID)
    const at = r.viewedAt * 1000
    if (e.lastPlayed === null || at > e.lastPlayed) e.lastPlayed = at
    out.set(k, e)
  }
  return out
}

/**
 * Who this episode is next for: anyone who watched the episode just before it (in season and episode order)
 * within the last `days` days, and has never watched this one.
 */
export function nextUpFor(eps: PlexEpisode[], rows: PlayRow[], names: Map<number, string>, now: number, days = 14): Map<string, string[]> {
  const ordered = eps.filter(e => e.season > 0).sort((a, b) => a.season - b.season || a.episode - b.episode)
  const watched = new Map<string, Map<number, number>>() // ratingKey → account → newest viewedAt (ms)
  const per = playsByEpisodeRaw(ordered, rows)
  for (const [k, list] of per) {
    const m = new Map<number, number>()
    for (const r of list) m.set(r.accountID, Math.max(m.get(r.accountID) ?? 0, r.viewedAt * 1000))
    watched.set(k, m)
  }
  const since = now - days * 86_400_000
  const out = new Map<string, string[]>()
  for (let i = 1; i < ordered.length; i++) {
    const prev = watched.get(ordered[i - 1].ratingKey)
    if (!prev) continue
    const cur = watched.get(ordered[i].ratingKey) ?? new Map()
    const who = [...prev.entries()].filter(([acct, at]) => at >= since && !cur.has(acct)).map(([acct]) => names.get(acct) ?? `account ${acct}`)
    if (who.length) out.set(ordered[i].ratingKey, who.sort())
  }
  return out
}

function playsByEpisodeRaw(eps: PlexEpisode[], rows: PlayRow[]): Map<string, PlayRow[]> {
  const bySE = new Map(eps.map(e => [`${e.season}x${e.episode}`, e.ratingKey]))
  const keys = new Set(eps.map(e => e.ratingKey))
  const out = new Map<string, PlayRow[]>()
  for (const r of rows) {
    const k = keys.has(r.ratingKey) ? r.ratingKey : r.season && r.episode ? bySE.get(`${r.season}x${r.episode}`) : undefined
    if (k) out.set(k, [...(out.get(k) ?? []), r])
  }
  return out
}
