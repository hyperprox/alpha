// =============================================================================
//  HyperProx — Plex Library view: browse, then remove a show, a season, some
//  episodes or a movie
//
//  Reads come from the same cached reading as Clear-out (lib/plex-clearout),
//  plus, for one show, Plex's episode list and (when Sonarr manages the show,
//  matched by tvdb id) Sonarr's episodes and episode files.
//
//  Removal is planned here and done by lib/plex-remove/engine.ts:
//    a whole show or movie   the Arr that manages it (deleteFiles + an import
//                            exclusion), or Plex
//    a season, or episodes   Sonarr deletes the episode FILES and unmonitors
//                            those episodes (and the season) so they are not
//                            downloaded again, unless "keep monitored so a
//                            better copy downloads" is ticked; or Plex deletes
//                            them (a single version, when one is chosen)
// =============================================================================

import type { ClearoutService, Gathered, ItemMeta } from '../plex-clearout/service'
import { ClearoutRefusal, blockedBy, planContext, wholeItemPlan, type PlanContext } from '../plex-clearout/service'
import { RULE_LABEL } from '../plex-clearout/logic'
import { artRef } from '../plex-art'
import { PLEX_NOTE, executePlan, type ItemResult, type Plan, type PlanItem } from '../plex-remove/engine'
import {
  mapEpisodes, nextUpFor, playsByEpisode, plexEpisodes, seriesByTvdb, showPlays, versionsOf,
  type PlexEpisode, type PlexVersion, type SonarrLink,
} from './logic'

const SLOW = 60_000
const KEY = /^\d{1,10}$/

export interface EpisodeView {
  ratingKey: string; season: number; episode: number; title: string
  sizeBytes: number | null; quality: string; plays: number; viewers: number; lastPlayed: number | null
  watched: boolean; inProgress: boolean; nextUpFor: string[]; versions: PlexVersion[]
  via: 'sonarr' | 'plex'
  /** Why it cannot be removed (its file could not be confirmed as Sonarr's, Sonarr did not answer), or null. */
  refused: string | null
}
export interface ShowView {
  show: { ratingKey: string; title: string; year: number | null; art: string | null; via: 'sonarr' | 'plex'; keptBy: string | null; sizeBytes: number | null; refused: string | null }
  seasons: Array<{ season: number; title: string; episodes: EpisodeView[] }>
  plexDeletes: boolean | null
}

interface ShowData {
  m: ItemMeta; eps: PlexEpisode[]; links: Map<string, SonarrLink>; seriesId: number | null
  sonarrEpisodes: any[]; views: EpisodeView[]
  /** The whole show cannot be removed, and why (Sonarr did not answer, title-only match). */
  refuse: string | null
}

const SERIES_TTL = 45_000

export class LibraryService {
  constructor(private clearout: ClearoutService) {}
  private get d() { return this.clearout.d }
  private seriesCache: { at: number; list: any[] } | null = null

  /** Sonarr's series list, kept 45 seconds: opening shows one after another must not re-read it each time. */
  private async seriesList(sonarr: { get(p: string, t?: number): Promise<any> }): Promise<any[]> {
    if (this.seriesCache && this.d.now() - this.seriesCache.at < SERIES_TTL) return this.seriesCache.list
    const list = await sonarr.get('/api/v3/series', SLOW)
    if (!Array.isArray(list)) throw new Error('not a list')
    this.seriesCache = { at: this.d.now(), list }
    return list
  }

  async list(): Promise<{ rows: Gathered['library']; sections: Gathered['report']['sections']; arr: Gathered['report']['arr']; plexDeletes: boolean | null; historySince: number | null }> {
    const g = await this.clearout.report()
    const ctx = await planContext(this.d)
    return { rows: g.library, sections: g.report.sections, arr: g.report.arr, plexDeletes: ctx.plexDeletes, historySince: g.report.historySince }
  }

  private async showData(ratingKey: string): Promise<{ g: Gathered; s: ShowData }> {
    if (!KEY.test(ratingKey)) throw new ClearoutRefusal('That is not a show.', 404, 'not_found')
    const g = await this.clearout.report()
    const m = g.meta.get(`show:${ratingKey}`)
    if (!m) throw new ClearoutRefusal('That show is not in Plex any more.', 404, 'not_found')
    const plex = await this.d.plex()
    if (!plex) throw new ClearoutRefusal('Plex is not set.', 409, 'plex_not_set')
    const eps = plexEpisodes(await plex.get(`/library/metadata/${ratingKey}/allLeaves`, SLOW))
    // Sonarr only for a show it manages by id (never by title), and only for episodes whose files it confirms.
    let seriesId: number | null = null
    let links = new Map<string, SonarrLink>()
    let refusedEps = new Map<string, string>()
    let sonarrEpisodes: any[] = []
    let refuse = m.refuse
    if (!refuse && m.managed?.service === 'sonarr') {
      const sonarr = await this.d.sonarr()
      const NO = "Sonarr didn't answer, try again."
      if (!sonarr) refuse = 'Sonarr is not set up any more.'
      else {
        try {
          const series = (await this.seriesList(sonarr)).find(x => x?.id === m.managed!.arrId) ?? seriesByTvdb(this.seriesCache?.list ?? [], m.tvdbId)
          if (!series) refuse = 'Sonarr no longer has this show. Read the library again.'
          else {
            seriesId = series.id
            const [e, f] = await Promise.all([
              sonarr.get(`/api/v3/episode?seriesId=${series.id}`, SLOW),
              sonarr.get(`/api/v3/episodefile?seriesId=${series.id}`, SLOW),
            ])
            if (!Array.isArray(e) || !Array.isArray(f)) refuse = NO
            else {
              sonarrEpisodes = e
              const mapped = mapEpisodes(eps, e, f)
              links = mapped.links
              refusedEps = mapped.refused
            }
          }
        } catch { refuse = NO }
      }
    }
    const rows = showPlays(g.plays, ratingKey, m.item.title)
    const plays = playsByEpisode(eps, rows)
    const next = nextUpFor(eps, rows, g.names, this.d.now())
    const views: EpisodeView[] = eps.map(e => {
      const p = plays.get(e.ratingKey)
      const l = links.get(e.ratingKey)
      return {
        ratingKey: e.ratingKey, season: e.season, episode: e.episode, title: e.title,
        sizeBytes: l?.fileSize ?? e.sizeBytes, quality: l?.quality ? `${l.quality}${e.versions[0] ? ` · ${e.versions[0].label.split(' · ').pop()}` : ''}` : e.quality,
        plays: p?.plays ?? 0, viewers: p?.viewers.size ?? 0, lastPlayed: p?.lastPlayed ?? null,
        watched: (p?.plays ?? 0) > 0, inProgress: e.inProgress, nextUpFor: next.get(e.ratingKey) ?? [],
        versions: e.versions, via: m.managed ? 'sonarr' : 'plex',
        // A show Sonarr manages: an episode it cannot confirm is refused, never handed to Plex.
        refused: refuse ?? (m.managed ? (l?.fileId ? null : refusedEps.get(e.ratingKey) ?? 'Sonarr has no file for it, so it is left alone.') : null),
      }
    })
    return { g, s: { m, eps, links, seriesId, sonarrEpisodes, views, refuse } }
  }

  async show(ratingKey: string): Promise<ShowView> {
    const { s } = await this.showData(ratingKey)
    const ctx = await planContext(this.d)
    const seasons = new Map<number, EpisodeView[]>()
    for (const v of s.views) seasons.set(v.season, [...(seasons.get(v.season) ?? []), v])
    return {
      show: {
        ratingKey, title: s.m.item.title, year: s.m.item.year, art: artRef(s.m.item.thumb),
        via: s.m.managed ? 'sonarr' : 'plex', keptBy: s.m.keptBy ? RULE_LABEL[s.m.keptBy] : null, sizeBytes: s.m.item.sizeBytes, refused: s.refuse,
      },
      seasons: [...seasons.entries()].sort((a, b) => a[0] - b[0]).map(([season, episodes]) => ({ season, title: season === 0 ? 'Specials' : `Season ${season}`, episodes })),
      plexDeletes: ctx.plexDeletes,
    }
  }

  /** What would go, which way, how big, and who it would upset. Changes nothing. */
  async preview(body: any, owner: string): Promise<Plan & { versions?: PlexVersion[] }> {
    const kind = body?.kind
    const rk = String(body?.ratingKey ?? '')
    if (!KEY.test(rk)) throw new ClearoutRefusal('Choose something to remove first.')
    const keepMonitored = body?.keepMonitored === true
    const ctx = await planContext(this.d)
    const g = await this.clearout.report()

    if (kind === 'movie' || kind === 'show') {
      const m = g.meta.get(`${kind}:${rk}`)
      if (!m) throw new ClearoutRefusal('That is not in Plex any more.', 404, 'not_found')
      if (kind === 'movie') {
        const plex = await this.d.plex()
        const versions = plex ? versionsOf((await plex.get(`/library/metadata/${rk}`, SLOW).catch(() => null))?.MediaContainer?.Metadata?.[0]) : []
        const mediaId = typeof body?.mediaId === 'string' ? body.mediaId : null
        if (mediaId) {
          // One version goes through Plex, so never for a film an Arr manages (or might).
          if (m.refuse) throw new ClearoutRefusal(m.refuse)
          if (m.managed) throw new ClearoutRefusal('Radarr manages this film, and a single version can only be removed through Plex. Remove the whole film, or the version in Radarr.')
          const v = versions.find(x => x.mediaId === mediaId)
          if (!v) throw new ClearoutRefusal('That version is not in Plex any more.')
          if (versions.length < 2) throw new ClearoutRefusal('This film has one version: remove the whole film instead.')
          const item: PlanItem = {
            id: `movie:${rk}:media:${mediaId}`, title: `${m.item.title}${m.item.year ? ` (${m.item.year})` : ''}: ${v.label}`, via: 'plex',
            step: { kind: 'plex-media', ratingKey: rk, mediaId, expect: { type: 'movie', title: m.item.title } }, files: v.files.map(path => ({ path, sizeBytes: null })), sizeBytes: v.sizeBytes ?? 0,
            note: `Only this version. ${PLEX_NOTE}`, warnings: [], keptBy: m.keptBy ? RULE_LABEL[m.keptBy] : null,
            blocked: blockedBy(ctx, [rk], 'plex'), plex: { keys: [rk], section: m.item.section, folder: m.folder },
          }
          return { ...this.clearout.previews.put(owner, [item], [], 'library'), versions }
        }
        const it = await wholeItemPlan(m, { ...g, protectedArr: new Set() }, ctx, this.d, m.item.sizeBytes)
        if ('skip' in it) return { ...this.clearout.previews.put(owner, [], [{ id: `movie:${rk}`, reason: it.skip }], 'library'), versions }
        it.warnings.push(...sharedWarning(g, m))
        return { ...this.clearout.previews.put(owner, [it], [], 'library'), versions: versions.length > 1 ? versions : undefined }
      }
      // A whole show: same as Clear-out, plus who is part-way through it.
      const { s } = await this.showData(rk)
      const it = await wholeItemPlan(m, { ...g, protectedArr: new Set() }, ctx, this.d, m.item.sizeBytes)
      if ('skip' in it) return this.clearout.previews.put(owner, [], [{ id: `show:${rk}`, reason: it.skip }], 'library')
      it.warnings = [...warningsFor(s.views), ...sharedWarning(g, m)]
      it.plex.keys = [rk, ...new Set(s.eps.flatMap(e => [e.ratingKey, e.seasonKey ?? '']).filter(Boolean))]
      return this.clearout.previews.put(owner, [it], [], 'library')
    }

    if (kind !== 'season' && kind !== 'episodes') throw new ClearoutRefusal('Choose a show, a season, episodes or a movie.')
    const { s } = await this.showData(rk)
    const m = s.m
    const keptBy = m.keptBy ? RULE_LABEL[m.keptBy] : null
    let chosen: EpisodeView[]
    let season: number | null = null
    if (kind === 'season') {
      season = Number(body?.season)
      if (!Number.isInteger(season) || season < 0) throw new ClearoutRefusal('Choose a season.')
      chosen = s.views.filter(v => v.season === season)
      if (!chosen.length) throw new ClearoutRefusal('That season has no episodes in Plex.')
    } else {
      const want = new Set((Array.isArray(body?.episodes) ? body.episodes : []).map(String))
      if (!want.size) throw new ClearoutRefusal('Tick at least one episode first.')
      if (want.size > 500) throw new ClearoutRefusal('At most 500 episodes at a time.')
      chosen = s.views.filter(v => want.has(v.ratingKey))
      if (!chosen.length) throw new ClearoutRefusal('Those episodes are not in Plex any more.')
    }
    const mediaIds: Record<string, string> = body?.mediaIds && typeof body.mediaIds === 'object' ? body.mediaIds : {}
    const items: PlanItem[] = []
    const skipped: Plan['skipped'] = []
    if (s.refuse) return this.clearout.previews.put(owner, [], [{ id: `show:${rk}`, reason: s.refuse }], 'library')
    if (m.managed && Object.keys(mediaIds).length) throw new ClearoutRefusal('Sonarr manages this show, and a single version can only be removed through Plex. Remove the episode, or the version in Sonarr.')
    // Episodes Sonarr manages but whose files it could not confirm are refused, never handed to Plex.
    const refusedNow = chosen.filter(v => v.refused)
    if (kind === 'season' && refusedNow.length) {
      return this.clearout.previews.put(owner, [], [{ id: `season:${rk}:${season}`, reason: `${refusedNow.length} episode(s) in this season cannot be matched to Sonarr's files (${refusedNow[0].refused}), so the season is left alone. Remove the others one by one.` }], 'library')
    }
    for (const v of refusedNow) skipped.push({ id: `episode:${v.ratingKey}`, reason: `S${v.season}E${v.episode}: ${v.refused}` })
    chosen = chosen.filter(v => !v.refused)
    const label = (v: EpisodeView) => `${m.item.title} S${v.season}E${v.episode}`
    const keysOf = (v: EpisodeView) => [rk, v.ratingKey, s.eps.find(e => e.ratingKey === v.ratingKey)?.seasonKey ?? ''].filter(Boolean)

    // Through Sonarr: one item per episode FILE (a double episode is one file), with every episode it holds.
    const sonarrChosen = m.managed ? chosen : []
    const plexChosen = m.managed ? [] : chosen
    if (sonarrChosen.length && !s.seriesId) throw new ClearoutRefusal("Sonarr didn't answer, try again.")
    if (s.seriesId && sonarrChosen.length) {
      const byFile = new Map<number, EpisodeView[]>()
      for (const v of sonarrChosen) { const f = s.links.get(v.ratingKey)!.fileId!; byFile.set(f, [...(byFile.get(f) ?? []), v]) }
      const fileIds = [...byFile.keys()]
      // Every Sonarr episode those files hold, not only the ticked ones, is unmonitored with them.
      const episodeIds = s.sonarrEpisodes.filter(e => fileIds.includes(Number(e?.episodeFileId))).map(e => Number(e.id))
      if (kind === 'season') for (const v of chosen) { const l = s.links.get(v.ratingKey); if (l && !episodeIds.includes(l.episodeId)) episodeIds.push(l.episodeId) }
      const files = fileIds.map(f => { const l = [...s.links.values()].find(x => x.fileId === f)!; return { path: l.filePath ?? '(file)', sizeBytes: l.fileSize } })
      const extra: string[] = []
      // Every Plex episode that one of these files holds counts for "is it being watched", not only the ticked one.
      const inFiles = s.eps.filter(e => { const l = s.links.get(e.ratingKey); return !!l?.fileId && fileIds.includes(l.fileId) })
      const keys = [...new Set([...sonarrChosen.flatMap(keysOf), ...inFiles.flatMap(e => [e.ratingKey, e.seasonKey ?? ''])].filter(Boolean))]
      for (const f of fileIds) {
        const holds = s.sonarrEpisodes.filter(e => Number(e?.episodeFileId) === f)
        if (holds.length > 1) extra.push(`One file holds ${holds.map(e => `S${e.seasonNumber}E${e.episodeNumber}`).join(' and ')}: all of them go.`)
      }
      items.push({
        id: kind === 'season' ? `season:${rk}:${season}:sonarr` : `episodes:${rk}:sonarr:${fileIds.join(',')}`.slice(0, 200),
        title: kind === 'season' ? `${m.item.title}: ${season === 0 ? 'Specials' : `Season ${season}`}` : sonarrChosen.length === 1 ? label(sonarrChosen[0]) : `${m.item.title}: ${sonarrChosen.length} episodes`,
        via: 'sonarr',
        step: { kind: 'arr-files', seriesId: s.seriesId, fileIds, episodeIds, unmonitor: !keepMonitored, season: kind === 'season' && !keepMonitored ? season : null },
        files, sizeBytes: files.reduce((a, f) => a + (f.sizeBytes ?? 0), 0),
        note: keepMonitored
          ? 'Files deleted in Sonarr. The episodes stay monitored, so Sonarr may download a better copy.'
          : `Files deleted in Sonarr, and ${kind === 'season' ? 'the season and its episodes are' : 'these episodes are'} set to unmonitored so they are not downloaded again.`,
        warnings: [...warningsFor(sonarrChosen), ...extra], keptBy,
        blocked: blockedBy(ctx, keys, 'sonarr'),
        plex: { keys, section: m.item.section, folder: m.folder },
      })
    }
    // Through Plex: the whole season when nothing in it is Sonarr's, else each episode (or one chosen version).
    if (plexChosen.length) {
      const seasonKey = kind === 'season' ? s.eps.find(e => e.season === season)?.seasonKey ?? null : null
      if (seasonKey && KEY.test(seasonKey)) {
        const files = plexChosen.flatMap(v => v.versions.flatMap(x => x.files.map(path => ({ path, sizeBytes: null as number | null }))))
        items.push({
          id: `season:${rk}:${season}:plex`, title: `${m.item.title}: ${season === 0 ? 'Specials' : `Season ${season}`}`, via: 'plex',
          step: { kind: 'plex-item', ratingKey: seasonKey, expect: {
            type: 'season', title: s.eps.find(e => e.seasonKey === seasonKey)?.seasonTitle ?? '',
            // Re-listed just before deleting: a season that gained episodes since this preview is refused.
            children: s.eps.filter(e => e.seasonKey === seasonKey).map(e => e.ratingKey),
          } }, files, sizeBytes: plexChosen.reduce((a, v) => a + (v.sizeBytes ?? 0), 0),
          note: PLEX_NOTE, warnings: warningsFor(plexChosen), keptBy,
          blocked: blockedBy(ctx, [rk, seasonKey, ...plexChosen.map(v => v.ratingKey)], 'plex'),
          plex: { keys: [rk, seasonKey, ...plexChosen.map(v => v.ratingKey)], section: m.item.section, folder: m.folder },
        })
      } else {
        for (const v of plexChosen) {
          const mid = mediaIds[v.ratingKey]
          const ver = mid ? v.versions.find(x => x.mediaId === mid) : undefined
          if (mid && (!ver || v.versions.length < 2)) throw new ClearoutRefusal(`${label(v)}: that version is not in Plex, or it is the only one.`)
          items.push({
            id: `episode:${v.ratingKey}${ver ? `:media:${ver.mediaId}` : ''}`, title: `${label(v)}${ver ? `: ${ver.label}` : ''}`, via: 'plex',
            step: ver
              ? { kind: 'plex-media', ratingKey: v.ratingKey, mediaId: ver.mediaId, expect: { type: 'episode', title: s.eps.find(e => e.ratingKey === v.ratingKey)?.rawTitle ?? '' } }
              : { kind: 'plex-item', ratingKey: v.ratingKey, expect: { type: 'episode', title: s.eps.find(e => e.ratingKey === v.ratingKey)?.rawTitle ?? '' } },
            files: (ver ? [ver] : v.versions).flatMap(x => x.files.map(path => ({ path, sizeBytes: x.files.length === 1 ? x.sizeBytes : null }))),
            sizeBytes: ver?.sizeBytes ?? v.sizeBytes ?? 0,
            note: ver ? `Only this version. ${PLEX_NOTE}` : PLEX_NOTE, warnings: warningsFor([v]), keptBy,
            blocked: blockedBy(ctx, keysOf(v), 'plex'),
            plex: { keys: keysOf(v), section: m.item.section, folder: m.folder },
          })
        }
      }
    }
    return this.clearout.previews.put(owner, items, skipped, 'library')
  }

  async remove(previewId: unknown, owner: string, by = owner): Promise<{ preview: Plan; results: ItemResult[]; rescanned: number }> {
    const p = this.clearout.previews.take(previewId, owner, 'library')
    const out = await executePlan(p, { plex: this.d.plex, sonarr: this.d.sonarr, radarr: this.d.radarr, audit: this.d.audit }, by)
    this.clearout.invalidate()
    return { preview: p, ...out }
  }
}

/** The Arr entry also covers another item in Plex: removing it there removes both. */
function sharedWarning(g: Gathered, m: ItemMeta): string[] {
  if (!m.managed) return []
  const others = [...g.meta.values()].filter(x => x !== m && x.managed?.service === m.managed!.service && x.managed.arrId === m.managed!.arrId)
  return others.length ? [`${m.managed.service === 'sonarr' ? 'Sonarr' : 'Radarr'}'s entry also covers ${others.map(o => o.item.title).slice(0, 3).join(', ')} in Plex: it goes too.`] : []
}

/** Next up for someone, or partly watched: said in the preview, never blocking. */
export function warningsFor(views: EpisodeView[]): string[] {
  const out: string[] = []
  for (const v of views) {
    if (v.nextUpFor.length) out.push(`S${v.season}E${v.episode} is next up for ${v.nextUpFor.join(', ')}.`)
    if (v.inProgress) out.push(`S${v.season}E${v.episode} is partly watched.`)
  }
  return out.slice(0, 20)
}

export type { PlanContext }
