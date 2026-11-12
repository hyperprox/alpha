// =============================================================================
//  HyperProx — Plex clear-out and Library: reading Plex and the Arr Stack
//
//  Reads: Plex's own play history for every account, every movie and show with
//  its addedAt, files and folder, and (when the Arr Stack plug-in is set up)
//  Sonarr's series and Radarr's movies for size on disk, genres, year, path and
//  anime.
//
//  Removal (lib/plex-remove/engine.ts) goes through the Arr that manages an item,
//  matched by tvdb or tmdb id and never by title, or otherwise through Plex
//  itself. HyperProx never deletes a file itself. A removal is previewed first
//  (exactly which files go, which way, and how big), held single use for the
//  person who made it for ten minutes, and every item is read back afterwards.
// =============================================================================

import type { CoreEndpointClient } from '../plugin-host'
import {
  RULE_LABEL, buildReport, indexPlays, keptBy as keptByRule, normTitle, parseRules, playsFor,
  type ClearoutReport, type KeepRuleId, type LibItem, type MediaKind, type PlayRow,
} from './logic'
import { artRef } from '../plex-art'
import { accountNames } from '../plex-direct'
import {
  RemoveRefusal as ClearoutRefusal,
  PLEX_DELETION_OFF, PLEX_NOTE, PreviewStore, STREAMING, executePlan, plexAllowsDeletion, streamingKeys,
  type ItemResult, type Plan, type PlanItem,
} from '../plex-remove/engine'
export { ClearoutRefusal }

export interface ClearoutDeps {
  /** The Plex server endpoint of the Plex plug-in, or null when its address and token are not set. */
  plex():   Promise<CoreEndpointClient | null>
  /** The Arr Stack plug-in's Sonarr and Radarr, or null when not set up. */
  sonarr(): Promise<CoreEndpointClient | null>
  radarr(): Promise<CoreEndpointClient | null>
  /** The Plex plug-in's non-secret settings (the keep rules). */
  option(key: string): Promise<string | undefined>
  now(): number
  /** One audit row. Written per item, before and after each delete, so a failed write cannot hide a removal. */
  audit?(action: string, details: Record<string, unknown>): Promise<void>
}


const PAGE = 1000
const SLOW = 60_000

const n0 = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const mc = (b: any): any => b?.MediaContainer ?? {}

async function paged(c: CoreEndpointClient, path: string, limit = 200_000): Promise<any[]> {
  const out: any[] = []
  const sep = path.includes('?') ? '&' : '?'
  for (let start = 0; start < limit; start += PAGE) {
    const body = mc(await c.get(`${path}${sep}X-Plex-Container-Start=${start}&X-Plex-Container-Size=${PAGE}`, SLOW))
    const rows: any[] = Array.isArray(body.Metadata) ? body.Metadata : []
    out.push(...rows)
    const total = n0(body.totalSize ?? body.size)
    if (rows.length < PAGE || (total && out.length >= total)) break
  }
  return out
}

const partBytes = (m: any): number =>
  (Array.isArray(m?.Media) ? m.Media : []).reduce((a: number, md: any) =>
    a + (Array.isArray(md?.Part) ? md.Part : []).reduce((b: number, p: any) => b + n0(p?.size), 0), 0)

const guidsOf = (m: any): string[] =>
  (Array.isArray(m?.Guid) ? m.Guid : []).map((g: any) => String(g?.id ?? '')).map((id: string) => {
    const x = /^(tmdb|tvdb|imdb):\/\/(.+)$/.exec(id)
    return x ? `${x[1]}:${x[2]}` : ''
  }).filter(Boolean)

const tags = (v: any): string[] => (Array.isArray(v) ? v : []).map((g: any) => String(g?.tag ?? g ?? '')).filter(Boolean)

/** Sonarr series or Radarr movies, indexed by every id they carry and by title (+ year). */
function arrIndex(list: any[], service: 'sonarr' | 'radarr') {
  const by = new Map<string, any>()
  const titleCount = new Map<string, number>()
  for (const x of list) {
    if (!x || typeof x.id !== 'number') continue
    if (x.tvdbId) by.set(`tvdb:${x.tvdbId}`, x)
    if (x.tmdbId) by.set(`tmdb:${x.tmdbId}`, x)
    if (x.imdbId) by.set(`imdb:${x.imdbId}`, x)
    const t = normTitle(x.title)
    for (const k of [`t:${t}|${n0(x.year)}`, `t:${t}`]) {
      by.set(k, x)
      titleCount.set(k, (titleCount.get(k) ?? 0) + 1)
    }
  }
  return {
    service,
    /** Something in the Arr has this title (once or more): it may be this item under other ids. */
    hasTitle(title: string): boolean { return (titleCount.get(`t:${normTitle(title)}`) ?? 0) > 0 },
    /** By tvdb, tmdb or imdb id only: the match removal trusts. */
    byId(guids: string[]): any | null {
      for (const g of guids) { const hit = by.get(g); if (hit) return hit }
      return null
    },
    find(guids: string[], title: string, year: number | null): any | null {
      for (const g of guids) { const hit = by.get(g); if (hit) return hit }
      const t = normTitle(title)
      // A title match only when it is unique in the Arr: two entries with the same title (and year) are never
      // guessed between, and a title that has a year match but more than one entry refuses outright.
      const unique = (k: string) => (titleCount.get(k) === 1 ? by.get(k) ?? null : null)
      if (year) {
        const k = `t:${t}|${year}`
        if ((titleCount.get(k) ?? 0) > 1) return null
        const hit = unique(k)
        if (hit) return hit
      }
      return unique(`t:${t}`)
    },
  }
}

/** What the Library and Clear-out need about one Plex item beyond its row. Server-side only. */
export interface ItemMeta {
  item:    LibItem
  /** The Arr entry that manages it, matched by id (never by title); null: Plex removes it. */
  managed: { service: 'sonarr' | 'radarr'; arrId: number; path: string | null } | null
  /** Plex's own folder for it (a show's folder, a film's folder) and its files with sizes. */
  folder:  string | null
  files:   Array<{ path: string; sizeBytes: number | null }>
  keptBy:  KeepRuleId | null
  tvdbId:  number | null
  /**
   * Why this may not be removed at all, or null. Plex removes an item only when no Arr is set up for its kind, or
   * the Arr answered and positively does not have it (none of its ids is there). An Arr that did not answer, a
   * title that matches without an id, or no id to look up: refused, never handed to Plex instead.
   */
  refuse:  string | null
}

export interface LibraryRow {
  id: string; kind: MediaKind; ratingKey: string; title: string; year: number | null; section: string; sectionTitle: string
  sizeBytes: number | null; plays: number; viewers: number; lastPlayed: number | null; addedAt: number; art: string | null
  via: 'sonarr' | 'radarr' | 'plex'; keptBy: string | null
  /** Why it cannot be removed, or null. */
  refused: string | null
}

export interface Gathered {
  report:  ClearoutReport
  /** Every movie and show, for the Library view. */
  library: LibraryRow[]
  meta:    Map<string, ItemMeta>
  /** Plex's play history (every account), for per-episode plays and the next-up warning. */
  plays:   PlayRow[]
  /** Account id → name. */
  names:   Map<number, string>
  /** `${service}:${id}` of Arr entries that some Plex item NOT on the lists (watched, or kept by a rule) also maps to. */
  protectedArr: Set<string>
}

const dirOf = (p: string) => p.replace(/[\\/][^\\/]*$/, '')

export async function gather(d: ClearoutDeps): Promise<Gathered> {
  const plex = await d.plex()
  if (!plex) throw new ClearoutRefusal('This reads your Plex server directly. Add the Plex server address and token in this plug-in’s settings.', 409, 'plex_not_set')
  const notes: string[] = []
  // "Could not read the Arr Stack settings" is not "no Arr": items of that kind are refused, never handed to Plex.
  const unreadable = { sonarr: false, radarr: false }
  const [sonarr, radarr] = await Promise.all([
    d.sonarr().catch(() => { unreadable.sonarr = true; return null }),
    d.radarr().catch(() => { unreadable.radarr = true; return null }),
  ])
  if (unreadable.sonarr || unreadable.radarr) notes.push("Couldn't read the Arr settings, so nothing can be removed until they can be read. Try again.")

  const dirs = mc(await plex.get('/library/sections', SLOW)).Directory
  const sections = (Array.isArray(dirs) ? dirs : [])
    .filter((s: any) => s?.type === 'movie' || s?.type === 'show')
    .map((s: any) => ({ key: String(s.key), title: String(s.title ?? s.key).slice(0, 80), kind: (s.type === 'movie' ? 'movie' : 'show') as MediaKind }))
    .filter((s: { key: string }) => /^\d+$/.test(s.key))

  const [series, movies, history, accounts] = await Promise.all([
    sonarr ? sonarr.get('/api/v3/series', SLOW).catch((e: any) => { notes.push(`Sonarr could not be read (${e.message}), so TV sizes come from Plex and nothing in TV can be removed until it answers.`); return null }) : null,
    radarr ? radarr.get('/api/v3/movie', SLOW).catch((e: any) => { notes.push(`Radarr could not be read (${e.message}), so movie sizes come from Plex and no film can be removed until it answers.`); return null }) : null,
    paged(plex, '/status/sessions/history/all?sort=viewedAt:desc'),
    plex.get('/accounts', SLOW).catch(() => null),
  ])
  const sIdx = Array.isArray(series) ? arrIndex(series, 'sonarr') : null
  const rIdx = Array.isArray(movies) ? arrIndex(movies, 'radarr') : null

  const items: LibItem[] = []
  const partial = new Map<string, Omit<ItemMeta, 'item' | 'keptBy'>>()
  for (const s of sections) {
    const meta = await paged(plex, `/library/sections/${s.key}/all?type=${s.kind === 'movie' ? 1 : 2}&includeGuids=1`)
    // A show's files (and size, without Sonarr) are its episodes', read from Plex.
    const showBytes = new Map<string, number>()
    if (s.kind === 'show' && !sIdx) {
      for (const ep of await paged(plex, `/library/sections/${s.key}/all?type=4`)) {
        const k = String(ep?.grandparentRatingKey ?? '')
        if (k) showBytes.set(k, (showBytes.get(k) ?? 0) + partBytes(ep))
      }
    }
    for (const m of meta) {
      const ratingKey = String(m?.ratingKey ?? '')
      if (!/^\d+$/.test(ratingKey)) continue
      const title = String(m?.title ?? '').slice(0, 200)
      const year = n0(m?.year) || null
      const idx = s.kind === 'show' ? sIdx : rIdx
      const guids = guidsOf(m)
      const arr = idx?.find(guids, title, year) ?? null
      const managedArr = idx?.byId(guids) ?? null
      const plexBytes = s.kind === 'movie' ? partBytes(m) : (showBytes.get(ratingKey) ?? 0)
      const arrBytes = arr ? n0(arr.statistics?.sizeOnDisk ?? arr.sizeOnDisk) : 0
      const plexFiles: ItemMeta['files'] = s.kind === 'movie'
        ? (Array.isArray(m?.Media) ? m.Media : []).flatMap((md: any) => (Array.isArray(md?.Part) ? md.Part : []).map((pt: any) => ({ path: String(pt?.file ?? ''), sizeBytes: n0(pt?.size) || null }))).filter((f: { path: string }) => f.path)
        : []
      const folder = typeof m?.Location?.[0]?.path === 'string' ? m.Location[0].path : plexFiles[0] ? dirOf(plexFiles[0].path) : null
      const item: LibItem = {
        kind: s.kind, ratingKey, title, year: year ?? (n0(arr?.year) || null),
        addedAt: n0(m?.addedAt) * 1000,
        section: s.key, sectionTitle: s.title,
        sizeBytes: (arr ? arrBytes : plexBytes) || null,
        genres: [...new Set([...tags(m?.Genre), ...(Array.isArray(arr?.genres) ? arr.genres.map(String) : [])])],
        path: typeof arr?.path === 'string' ? arr.path : folder ?? (plexFiles[0]?.path ?? null),
        seriesType: typeof arr?.seriesType === 'string' ? arr.seriesType : null,
        arr: managedArr ? { service: s.kind === 'show' ? 'sonarr' : 'radarr', id: managedArr.id } : null,
        thumb: typeof m?.thumb === 'string' ? m.thumb : null,
      }
      items.push(item)
      const tvdb = guids.find(g => g.startsWith('tvdb:'))
      const name = s.kind === 'show' ? 'Sonarr' : 'Radarr'
      const configured = s.kind === 'show' ? !!sonarr : !!radarr
      const refuse = (s.kind === 'show' ? unreadable.sonarr : unreadable.radarr) ? "Couldn't read the Arr settings, try again."
        : !configured || managedArr ? null
        : !idx ? `${name} didn't answer, try again.`
        : arr || idx.hasTitle(title) ? `${name} has something with this title, but not with Plex's ids, so it is left alone. Fix the match in Plex or ${name}.`
        : !guids.length ? `Plex has no tvdb or tmdb id for it, so HyperProx cannot tell whether ${name} manages it.`
        : null
      partial.set(`${s.kind}:${ratingKey}`, {
        refuse,
        managed: managedArr ? { service: s.kind === 'show' ? 'sonarr' : 'radarr', arrId: managedArr.id, path: typeof managedArr.path === 'string' ? managedArr.path : null } : null,
        folder, files: plexFiles, tvdbId: tvdb ? n0(tvdb.slice(5)) || null : null,
      })
    }
  }

  const plays: PlayRow[] = history.map((h: any) => ({
    ratingKey: String(h?.ratingKey ?? ''), grandparentKey: h?.grandparentKey ?? null, type: String(h?.type ?? ''),
    title: String(h?.title ?? ''), grandparentTitle: h?.grandparentTitle ?? null,
    viewedAt: n0(h?.viewedAt), accountID: n0(h?.accountID),
    season: n0(h?.parentIndex) || null, episode: n0(h?.index) || null,
  }))

  const opts = new Map<string, string | undefined>()
  for (const k of ['keep_before_year', 'keep_anime', 'keep_folder_pattern', 'keep_folders', 'keep_genres', 'keep_names', 'keep_added_days', 'never_min_months', 'idle_months']) {
    opts.set(k, await d.option(k))
  }
  const { rules, cutoffs } = parseRules(k => opts.get(k))
  if (!sonarr && !radarr) notes.push('The Arr Stack plug-in is not set up, so removals go through Plex itself.')

  const now = d.now()
  const report = buildReport({
    items, plays, rules, cutoffs, now, sections,
    arr: { sonarr: !!sIdx, radarr: !!rIdx },
    sizesFrom: { tv: sIdx ? 'arr' : 'plex', movies: rIdx ? 'arr' : 'plex' },
    notes,
  })
  for (const r of report.rows) { const pm = partial.get(r.id); if (pm) r.refused = pm.refuse }
  const listed = new Set(report.rows.map(r => r.id))
  const index = indexPlays(plays)
  const meta = new Map<string, ItemMeta>()
  const library: LibraryRow[] = []
  const protectedArr = new Set<string>()
  for (const item of items) {
    const id = `${item.kind}:${item.ratingKey}`
    const pm = partial.get(id)!
    const keptBy = keptByRule(item, rules, now)
    meta.set(id, { item, keptBy, ...pm })
    // Removing an Arr entry removes it for every Plex item that maps to it: an entry shared with an item that is
    // not on the lists (watched, or kept by a rule) is protected.
    if (pm.managed && !listed.has(id)) protectedArr.add(`${pm.managed.service}:${pm.managed.arrId}`)
    const st = playsFor(index, item)
    library.push({
      id, kind: item.kind, ratingKey: item.ratingKey, title: item.title, year: item.year, section: item.section, sectionTitle: item.sectionTitle,
      sizeBytes: item.sizeBytes, plays: st.plays, viewers: st.viewers, lastPlayed: st.lastPlayed, addedAt: item.addedAt,
      art: artRef(item.thumb), via: pm.managed?.service ?? 'plex', keptBy: keptBy ? RULE_LABEL[keptBy] : null, refused: pm.refuse,
    })
  }
  return { report, library, meta, plays, names: accountNames(accounts), protectedArr }
}

// ---------------------------------------------------------------------------
//  The service: a cached reading, Clear-out previews and removal
// ---------------------------------------------------------------------------

const REPORT_TTL = 10 * 60_000
const MAX_ITEMS = 100

export class ClearoutService {
  private cached: { at: number; data: Gathered } | null = null
  private lastFresh = 0
  private inflight: Promise<Gathered> | null = null
  readonly previews: PreviewStore

  constructor(readonly d: ClearoutDeps, newId?: () => string) { this.previews = new PreviewStore(() => d.now(), newId) }

  async report(refresh = false): Promise<Gathered> {
    // A forced re-read reads the whole history and library: at most once a minute.
    if (refresh && this.cached && this.d.now() - this.lastFresh < 60_000) refresh = false
    if (!refresh && this.cached && this.d.now() - this.cached.at < REPORT_TTL) return this.cached.data
    if (!this.inflight) {
      this.inflight = gather(this.d)
        .then(data => { this.cached = { at: this.d.now(), data }; this.lastFresh = this.d.now(); return data })
        .finally(() => { this.inflight = null })
    }
    return this.inflight
  }

  /** Forget the reading: the library changed. */
  invalidate(): void { this.cached = null }

  /** Exactly what removing these would delete, and which way each goes, checked against the Arr and Plex now. */
  async preview(ids: unknown, owner: string): Promise<Plan> {
    if (!Array.isArray(ids) || ids.length === 0) throw new ClearoutRefusal('Tick at least one item first.')
    if (ids.length > MAX_ITEMS) throw new ClearoutRefusal(`At most ${MAX_ITEMS} items at a time.`)
    const want = [...new Set(ids.map(String))]
    const g = await this.report()
    const listed = new Map(g.report.rows.map(r => [r.id, r]))
    const ctx = await planContext(this.d)
    const items: PlanItem[] = []
    const skipped: Plan['skipped'] = []
    for (const id of want) {
      const row = listed.get(id)
      const m = g.meta.get(id)
      // Only rows on the never or idle list (kept by no rule) can be removed from Clear-out.
      if (!row || !m) { skipped.push({ id, reason: 'Not on the clear-out list.' }); continue }
      const it = await wholeItemPlan(m, g, ctx, this.d, row.sizeBytes)
      if ('skip' in it) { skipped.push({ id, reason: it.skip }); continue }
      items.push(it)
    }
    return this.previews.put(owner, items, skipped, 'clearout')
  }

  /** Remove what a preview listed, then read each one back. */
  async remove(previewId: unknown, owner: string, by = owner): Promise<{ preview: Plan; results: ItemResult[]; rescanned: number }> {
    const p = this.previews.take(previewId, owner, 'clearout')
    const out = await executePlan(p, { plex: this.d.plex, sonarr: this.d.sonarr, radarr: this.d.radarr, audit: this.d.audit }, by)
    // The list changed: the next read is fresh.
    this.invalidate()
    return { preview: p, ...out }
  }
}

/** What every preview checks once: who is streaming, and whether Plex allows deletions. */
export interface PlanContext { streaming: Set<string> | null; plexDeletes: boolean | null }
export async function planContext(d: Pick<ClearoutDeps, 'plex'>): Promise<PlanContext> {
  const plex = await d.plex()
  const [streaming, plexDeletes] = await Promise.all([streamingKeys(plex).catch(() => null), plexAllowsDeletion(plex)])
  return { streaming, plexDeletes }
}

export function blockedBy(ctx: PlanContext, keys: string[], via: 'sonarr' | 'radarr' | 'plex'): string | null {
  if (ctx.streaming === null) return 'Plex could not say what is playing, so this cannot be removed right now.'
  if (keys.some(k => ctx.streaming!.has(k))) return STREAMING
  if (via === 'plex' && ctx.plexDeletes !== true) return PLEX_DELETION_OFF
  return null
}

/** A whole movie or show: through the Arr that manages it (by id), else through Plex. */
export async function wholeItemPlan(m: ItemMeta, g: Gathered, ctx: PlanContext, d: ClearoutDeps, size: number | null): Promise<PlanItem | { skip: string }> {
  const { item } = m
  const title = `${item.title}${item.year ? ` (${item.year})` : ''}`
  const keys = [item.ratingKey]
  const keptBy = m.keptBy ? RULE_LABEL[m.keptBy] : null
  if (m.refuse) return { skip: `${item.title}: ${m.refuse}` }
  if (m.managed) {
    const t = m.managed
    const name = t.service === 'sonarr' ? 'Sonarr' : 'Radarr'
    if (g.protectedArr.has(`${t.service}:${t.arrId}`) && !m.keptBy) {
      return { skip: `${item.title} shares its ${name} entry with another Plex item that is watched or kept by a rule, so it is left alone.` }
    }
    const client = t.service === 'sonarr' ? await d.sonarr() : await d.radarr()
    if (!client) return { skip: `${name} is not set up.` }
    const live = await client.get(`/api/v3/${t.service === 'sonarr' ? 'series' : 'movie'}/${t.arrId}`, SLOW).catch(() => null)
    if (!live || live.id !== t.arrId) return { skip: `${item.title} is no longer in ${name}.` }
    const sizeBytes = n0(live.statistics?.sizeOnDisk ?? live.sizeOnDisk) || size || 0
    const path = typeof live.path === 'string' ? live.path : t.path
    return {
      id: `${item.kind}:${item.ratingKey}`, title, via: t.service,
      step: t.service === 'sonarr' ? { kind: 'arr-series', arrId: t.arrId, path } : { kind: 'arr-movie', arrId: t.arrId, path },
      files: [{ path: path ?? '(the whole folder)', sizeBytes }], sizeBytes,
      note: `Deleted in ${name} with its files, and added to its import-list exclusions so it is not downloaded again.`,
      warnings: [], keptBy, blocked: blockedBy(ctx, keys, t.service),
      plex: { keys, section: item.section, folder: m.folder },
    }
  }
  const files = m.files.length ? m.files : [{ path: m.folder ?? '(the files Plex has for it)', sizeBytes: size }]
  return {
    id: `${item.kind}:${item.ratingKey}`, title, via: 'plex',
    step: { kind: 'plex-item', ratingKey: item.ratingKey, expect: { type: item.kind === 'show' ? 'show' : 'movie', title: item.title } },
    files, sizeBytes: size ?? files.reduce((a, f) => a + (f.sizeBytes ?? 0), 0),
    note: PLEX_NOTE, warnings: [], keptBy, blocked: blockedBy(ctx, keys, 'plex'),
    plex: { keys, section: item.section, folder: m.folder },
  }
}
