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
//  not watched this one. "Watched" is a play in the history OR Plex's own
//  watched mark for that account (viewCount, lastViewedAt), so an episode
//  marked watched, or watched before the history starts, counts too.
// =============================================================================

import { normTitle, type PlayRow, type Watcher } from '../plex-clearout/logic'
import { hasWatched, type AccountView, type ViewMap } from '../plex-clearout/watchers'

const n0 = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const str = (v: unknown, max = 160) => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : '')

export interface PlexVersion { mediaId: string; label: string; sizeBytes: number | null; files: string[] }

/** One episode from Plex's /library/metadata/<show>/allLeaves. */
export interface PlexEpisode {
  ratingKey: string; seasonKey: string | null; season: number; episode: number; title: string
  /** Plex's own titles, exactly, for the check just before Plex deletes it. */
  rawTitle: string; seasonTitle: string
  sizeBytes: number | null; quality: string; versions: PlexVersion[]
  /** Plex's own (server owner's) progress through it. */
  inProgress: boolean
  /** Every file Plex has for it, with its size: what a Sonarr file must agree with. */
  parts: Array<{ file: string; size: number | null }>
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
      rawTitle: typeof m.title === 'string' ? m.title : '', seasonTitle: typeof m.parentTitle === 'string' ? m.parentTitle : '',
      sizeBytes: versions.reduce((a, v) => a + (v.sizeBytes ?? 0), 0) || null,
      quality: versions[0]?.label ?? '—', versions,
      inProgress: n0(m.viewOffset) > 0,
      parts: (Array.isArray(m?.Media) ? m.Media : []).flatMap((md: any) => (Array.isArray(md?.Part) ? md.Part : []).map((p: any) => ({ file: str(p?.file, 400), size: n0(p?.size) || null }))).filter((p: { file: string }) => p.file),
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

/** The last path segment, whatever the separator: container paths differ between Plex and Sonarr, names do not. */
export const baseName = (p: string | null | undefined): string => String(p ?? '').split(/[\\/]/).pop()!.trim().toLowerCase()

export interface EpisodeMapping {
  /** Plex episodes whose Sonarr file was confirmed: the same file name (and size, when both know it). */
  links:   Map<string, SonarrLink>
  /** Plex episodes in a Sonarr-managed series that could not be confirmed, and why. Never removed. */
  refused: Map<string, string>
}

/**
 * Plex episodes to Sonarr episode files. Season and episode numbers only PROPOSE a match: shows in absolute
 * (anime), DVD or another order, and specials, number episodes differently in Plex and Sonarr. A link is made
 * only when the Sonarr episode file and one of the Plex episode's files have the same name, and, when both
 * know the size, the same size. Anything else is refused, never guessed and never handed to Plex instead.
 */
export function mapEpisodes(eps: PlexEpisode[], sonarrEpisodes: any[], sonarrFiles: any[]): EpisodeMapping {
  const files = new Map<number, any>()
  for (const f of Array.isArray(sonarrFiles) ? sonarrFiles : []) if (typeof f?.id === 'number') files.set(f.id, f)
  const bySE = new Map<string, any[]>()
  for (const e of Array.isArray(sonarrEpisodes) ? sonarrEpisodes : []) {
    if (typeof e?.id !== 'number') continue
    const k = `${n0(e.seasonNumber)}x${n0(e.episodeNumber)}`
    bySE.set(k, [...(bySE.get(k) ?? []), e])
  }
  // A Sonarr file by its name, for the reason given when numbers disagree.
  const byName = new Map<string, any>()
  for (const f of files.values()) byName.set(baseName(f.path), f)
  const links = new Map<string, SonarrLink>()
  const refused = new Map<string, string>()
  for (const p of eps) {
    const where = `S${p.season}E${p.episode}`
    const hits = bySE.get(`${p.season}x${p.episode}`) ?? []
    const named = p.parts.map(x => byName.get(baseName(x.file))).find(Boolean)
    if (hits.length !== 1) {
      refused.set(p.ratingKey, hits.length ? `Sonarr has more than one ${where}, so it is left alone.`
        : named ? `Sonarr numbers this file differently (not ${where}), so it is left alone.` : `Sonarr has no ${where} with this file, so it is left alone.`)
      continue
    }
    const e = hits[0]
    const fid = n0(e.episodeFileId) || null
    const f = fid ? files.get(fid) : undefined
    if (!f) {
      refused.set(p.ratingKey, named ? `Sonarr numbers this file differently (not ${where}), so it is left alone.` : `Sonarr has no file for ${where}, so it is left alone.`)
      continue
    }
    const part = p.parts.find(x => baseName(x.file) === baseName(f.path))
    const sonarrSize = n0(f.size) || null
    if (!part || (part.size && sonarrSize && part.size !== sonarrSize)) {
      refused.set(p.ratingKey, `Plex's file for ${where} is not the one Sonarr has as ${where}, so it is left alone.`)
      continue
    }
    links.set(p.ratingKey, {
      episodeId: e.id, fileId: fid, monitored: !!e.monitored,
      filePath: str(f.path, 400) || null, fileSize: sonarrSize,
      quality: str(f?.quality?.quality?.name, 40) || null,
    })
  }
  return { links, refused }
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

/** One episode's watchers: the history's accounts, plus every account Plex has as watched (marked) without a play. */
export interface EpisodeWatch { watched: boolean; watchers: number; marked: number; who: Watcher[]; lastPlayed: number | null; inProgress: boolean }

export function episodeWatch(p: EpisodePlays | undefined, per: Map<number, AccountView> | undefined): EpisodeWatch {
  const played = p?.viewers ?? new Set<number>()
  const marked = new Set<number>()
  let last = p?.lastPlayed ?? null
  let inProgress = false
  for (const [acct, v] of per ?? []) {
    if (hasWatched(v)) {
      if (!played.has(acct)) marked.add(acct)
      if (v.lastViewedAt !== null && (last === null || v.lastViewedAt > last)) last = v.lastViewedAt
    }
    if (v.inProgress && v.viewCount === 0) inProgress = true
  }
  const who: Watcher[] = [
    ...[...played].sort((a, b) => a - b).map(account => ({ account, how: 'played' as const })),
    ...[...marked].sort((a, b) => a - b).map(account => ({ account, how: 'marked' as const })),
  ]
  return { watched: who.length > 0, watchers: who.length, marked: marked.size, who, lastPlayed: last, inProgress }
}

/**
 * Who this episode is next for: anyone who watched the episode just before it (in season and episode order)
 * within the last `days` days, and has never watched this one. `views` adds Plex's watched marks per account:
 * a mark counts as watched, and its lastViewedAt as when.
 */
export function nextUpFor(eps: PlexEpisode[], rows: PlayRow[], names: Map<number, string>, now: number, days = 14, views?: ViewMap): Map<string, string[]> {
  const ordered = eps.filter(e => e.season > 0).sort((a, b) => a.season - b.season || a.episode - b.episode)
  const watched = new Map<string, Map<number, number>>() // ratingKey → account → newest viewedAt (ms)
  const per = playsByEpisodeRaw(ordered, rows)
  for (const [k, list] of per) {
    const m = new Map<number, number>()
    for (const r of list) m.set(r.accountID, Math.max(m.get(r.accountID) ?? 0, r.viewedAt * 1000))
    watched.set(k, m)
  }
  for (const e of ordered) {
    for (const [acct, v] of views?.get(e.ratingKey) ?? []) {
      if (!hasWatched(v)) continue
      const m = watched.get(e.ratingKey) ?? new Map<number, number>()
      m.set(acct, Math.max(m.get(acct) ?? 0, v.lastViewedAt ?? 0))
      watched.set(e.ratingKey, m)
    }
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
