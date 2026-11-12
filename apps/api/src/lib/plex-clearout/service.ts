// =============================================================================
//  HyperProx — Plex clear-out: reading Plex and the Arr Stack, and removing
//
//  Reads: Plex's own play history for every account, every movie and show with
//  its addedAt, and (when the Arr Stack plug-in is set up) Sonarr's series and
//  Radarr's movies for size on disk, genres, year, path and anime.
//
//  Removal goes ONLY through Sonarr or Radarr: delete the series or movie with
//  its files, and add an import-list exclusion so it does not come straight
//  back. HyperProx never deletes a file itself. A removal must first be
//  previewed (exactly what goes and how big it is); the preview is held here,
//  bound to the person who made it, for ten minutes. After each delete the item
//  is read again from the Arr, and only an item the Arr no longer has counts as
//  removed.
// =============================================================================

import type { CoreEndpointClient } from '../plugin-host'
import {
  buildReport, normTitle, parseRules,
  type ClearoutReport, type ClearoutRow, type LibItem, type MediaKind, type PlayRow,
} from './logic'

export interface ClearoutDeps {
  /** The Plex server endpoint of the Plex plug-in, or null when its address and token are not set. */
  plex():   Promise<CoreEndpointClient | null>
  /** The Arr Stack plug-in's Sonarr and Radarr, or null when not set up. */
  sonarr(): Promise<CoreEndpointClient | null>
  radarr(): Promise<CoreEndpointClient | null>
  /** The Plex plug-in's non-secret settings (the keep rules). */
  option(key: string): Promise<string | undefined>
  now(): number
}

export class ClearoutRefusal extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'refused') { super(message); this.name = 'ClearoutRefusal' }
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
    by.set(`t:${t}|${n0(x.year)}`, x)
    titleCount.set(t, (titleCount.get(t) ?? 0) + 1)
    by.set(`t:${t}`, x)
  }
  return {
    service,
    find(guids: string[], title: string, year: number | null): any | null {
      for (const g of guids) { const hit = by.get(g); if (hit) return hit }
      const t = normTitle(title)
      if (year) { const hit = by.get(`t:${t}|${year}`); if (hit) return hit }
      // A bare title match only when the title is unique in the Arr: two "Dune"s must not be guessed between.
      return titleCount.get(t) === 1 ? by.get(`t:${t}`) ?? null : null
    },
  }
}

export interface Gathered {
  report: ClearoutReport
  /** Row id → what removing it means. Server-side only. */
  targets: Map<string, { row: ClearoutRow; service: 'sonarr' | 'radarr'; arrId: number; path: string | null }>
}

export async function gather(d: ClearoutDeps): Promise<Gathered> {
  const plex = await d.plex()
  if (!plex) throw new ClearoutRefusal('Clear-out reads your Plex server directly. Add the Plex server address and token in this plug-in’s settings.', 409, 'plex_not_set')
  const [sonarr, radarr] = await Promise.all([d.sonarr(), d.radarr()])
  const notes: string[] = []

  const dirs = mc(await plex.get('/library/sections', SLOW)).Directory
  const sections = (Array.isArray(dirs) ? dirs : [])
    .filter((s: any) => s?.type === 'movie' || s?.type === 'show')
    .map((s: any) => ({ key: String(s.key), title: String(s.title ?? s.key).slice(0, 80), kind: (s.type === 'movie' ? 'movie' : 'show') as MediaKind }))
    .filter((s: { key: string }) => /^\d+$/.test(s.key))

  const [series, movies, history] = await Promise.all([
    sonarr ? sonarr.get('/api/v3/series', SLOW).catch((e: any) => { notes.push(`Sonarr could not be read (${e.message}), so TV sizes come from Plex.`); return null }) : null,
    radarr ? radarr.get('/api/v3/movie', SLOW).catch((e: any) => { notes.push(`Radarr could not be read (${e.message}), so movie sizes come from Plex.`); return null }) : null,
    paged(plex, '/status/sessions/history/all?sort=viewedAt:desc'),
  ])
  const sIdx = Array.isArray(series) ? arrIndex(series, 'sonarr') : null
  const rIdx = Array.isArray(movies) ? arrIndex(movies, 'radarr') : null

  const items: LibItem[] = []
  const arrOf = new Map<string, any>()
  for (const s of sections) {
    const meta = await paged(plex, `/library/sections/${s.key}/all?type=${s.kind === 'movie' ? 1 : 2}&includeGuids=1`)
    // Without Sonarr, a show's size is the sum of its episodes' files, read from Plex.
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
      const arr = idx?.find(guidsOf(m), title, year) ?? null
      const plexBytes = s.kind === 'movie' ? partBytes(m) : (showBytes.get(ratingKey) ?? 0)
      const arrBytes = arr ? n0(arr.statistics?.sizeOnDisk ?? arr.sizeOnDisk) : 0
      const item: LibItem = {
        kind: s.kind, ratingKey, title, year: year ?? (n0(arr?.year) || null),
        addedAt: n0(m?.addedAt) * 1000,
        section: s.key, sectionTitle: s.title,
        sizeBytes: (arr ? arrBytes : plexBytes) || null,
        genres: [...new Set([...tags(m?.Genre), ...(Array.isArray(arr?.genres) ? arr.genres.map(String) : [])])],
        path: typeof arr?.path === 'string' ? arr.path
          : typeof m?.Location?.[0]?.path === 'string' ? m.Location[0].path
          : typeof m?.Media?.[0]?.Part?.[0]?.file === 'string' ? m.Media[0].Part[0].file : null,
        seriesType: typeof arr?.seriesType === 'string' ? arr.seriesType : null,
        arr: arr ? { service: s.kind === 'show' ? 'sonarr' : 'radarr', id: arr.id } : null,
        thumb: typeof m?.thumb === 'string' ? m.thumb : null,
      }
      items.push(item)
      if (arr) arrOf.set(`${s.kind}:${ratingKey}`, arr)
    }
  }

  const plays: PlayRow[] = history.map((h: any) => ({
    ratingKey: String(h?.ratingKey ?? ''), grandparentKey: h?.grandparentKey ?? null, type: String(h?.type ?? ''),
    title: String(h?.title ?? ''), grandparentTitle: h?.grandparentTitle ?? null,
    viewedAt: n0(h?.viewedAt), accountID: n0(h?.accountID),
  }))

  const opts = new Map<string, string | undefined>()
  for (const k of ['keep_before_year', 'keep_anime', 'keep_folder_pattern', 'keep_folders', 'keep_genres', 'keep_names', 'keep_added_days', 'never_min_months', 'idle_months']) {
    opts.set(k, await d.option(k))
  }
  const { rules, cutoffs } = parseRules(k => opts.get(k))
  if (!sonarr && !radarr) notes.push('The Arr Stack plug-in is not set up, so nothing can be removed from here: copy the list instead.')

  const report = buildReport({
    items, plays, rules, cutoffs, now: d.now(), sections,
    arr: { sonarr: !!sIdx, radarr: !!rIdx },
    sizesFrom: { tv: sIdx ? 'arr' : 'plex', movies: rIdx ? 'arr' : 'plex' },
    notes,
  })
  const targets: Gathered['targets'] = new Map()
  for (const row of report.rows) {
    const arr = arrOf.get(row.id)
    if (arr) targets.set(row.id, { row, service: row.kind === 'show' ? 'sonarr' : 'radarr', arrId: arr.id, path: typeof arr.path === 'string' ? arr.path : null })
  }
  return { report, targets }
}

// ---------------------------------------------------------------------------
//  The service: a cached report, previews and removal
// ---------------------------------------------------------------------------

export interface PreviewItem { id: string; title: string; year: number | null; service: 'sonarr' | 'radarr'; sizeBytes: number | null; path: string | null }
export interface Preview { id: string; owner: string; createdAt: number; items: PreviewItem[]; totalBytes: number; skipped: Array<{ id: string; reason: string }> }
export interface RemoveResult { id: string; title: string; service: 'sonarr' | 'radarr'; removed: boolean; message: string; sizeBytes: number | null }

const REPORT_TTL = 10 * 60_000
const PREVIEW_TTL = 10 * 60_000
const MAX_ITEMS = 100

export class ClearoutService {
  private cached: { at: number; data: Gathered } | null = null
  private inflight: Promise<Gathered> | null = null
  private previews = new Map<string, Preview & { targets: Map<string, { service: 'sonarr' | 'radarr'; arrId: number; path: string | null }> }>()

  constructor(private d: ClearoutDeps, private newId: () => string = () => Math.random().toString(36).slice(2) + Date.now().toString(36)) {}


  async report(refresh = false): Promise<Gathered> {
    if (!refresh && this.cached && this.d.now() - this.cached.at < REPORT_TTL) return this.cached.data
    if (!this.inflight) {
      this.inflight = gather(this.d)
        .then(data => { this.cached = { at: this.d.now(), data }; return data })
        .finally(() => { this.inflight = null })
    }
    return this.inflight
  }

  /** Exactly what removing these would delete, checked against the Arr as it is now. */
  async preview(ids: unknown, owner: string): Promise<Preview> {
    if (!Array.isArray(ids) || ids.length === 0) throw new ClearoutRefusal('Tick at least one item first.')
    if (ids.length > MAX_ITEMS) throw new ClearoutRefusal(`At most ${MAX_ITEMS} items at a time.`)
    const want = [...new Set(ids.map(String))]
    const { targets } = await this.report()
    const items: PreviewItem[] = []
    const skipped: Preview['skipped'] = []
    const held = new Map<string, { service: 'sonarr' | 'radarr'; arrId: number; path: string | null }>()
    for (const id of want) {
      const t = targets.get(id)
      // Only rows on the never or idle list, kept by no rule and matched in the Arr, can be removed.
      if (!t) { skipped.push({ id, reason: 'Not on the clear-out list, or not found in Sonarr or Radarr.' }); continue }
      const client = t.service === 'sonarr' ? await this.d.sonarr() : await this.d.radarr()
      if (!client) { skipped.push({ id, reason: `${t.service === 'sonarr' ? 'Sonarr' : 'Radarr'} is not set up.` }); continue }
      const live = await client.get(`/api/v3/${t.service === 'sonarr' ? 'series' : 'movie'}/${t.arrId}`, SLOW).catch(() => null)
      if (!live || live.id !== t.arrId) { skipped.push({ id, reason: `${t.row.title} is no longer in ${t.service === 'sonarr' ? 'Sonarr' : 'Radarr'}.` }); continue }
      const sizeBytes = n0(live.statistics?.sizeOnDisk ?? live.sizeOnDisk) || t.row.sizeBytes
      items.push({ id, title: String(live.title ?? t.row.title).slice(0, 200), year: n0(live.year) || t.row.year, service: t.service, sizeBytes, path: typeof live.path === 'string' ? live.path : t.path })
      held.set(id, { service: t.service, arrId: t.arrId, path: typeof live.path === 'string' ? live.path : t.path })
    }
    const p = { id: this.newId(), owner, createdAt: this.d.now(), items, totalBytes: items.reduce((a, x) => a + (x.sizeBytes ?? 0), 0), skipped }
    this.prune()
    if (items.length) this.previews.set(p.id, { ...p, targets: held })
    return p
  }

  /** Remove what a preview listed, through the Arr, then read each one back. */
  async remove(previewId: unknown, owner: string): Promise<{ preview: Preview; results: RemoveResult[] }> {
    this.prune()
    const p = typeof previewId === 'string' ? this.previews.get(previewId) : undefined
    if (!p) throw new ClearoutRefusal('That preview has expired. Preview the removal again.', 409, 'preview_expired')
    if (p.owner !== owner) throw new ClearoutRefusal('That preview belongs to someone else.', 403, 'not_yours')
    this.previews.delete(p.id)
    const results: RemoveResult[] = []
    for (const it of p.items) {
      const t = p.targets.get(it.id)!
      const name = t.service === 'sonarr' ? 'Sonarr' : 'Radarr'
      const client = t.service === 'sonarr' ? await this.d.sonarr() : await this.d.radarr()
      if (!client) { results.push({ id: it.id, title: it.title, service: t.service, removed: false, message: `${name} is not set up.`, sizeBytes: it.sizeBytes }); continue }
      const base = `/api/v3/${t.service === 'sonarr' ? 'series' : 'movie'}/${t.arrId}`
      // Still the same thing the preview showed: a re-added item under the same id must not be deleted unseen.
      const before = await client.get(base, SLOW).catch(() => null)
      if (!before || before.id !== t.arrId || (t.path && before.path !== t.path)) {
        results.push({ id: it.id, title: it.title, service: t.service, removed: false, message: `${name} no longer has it as previewed, so it was left alone.`, sizeBytes: it.sizeBytes })
        continue
      }
      const exclusion = t.service === 'sonarr' ? 'addImportListExclusion=true' : 'addImportExclusion=true'
      try {
        await client.delete(`${base}?deleteFiles=true&${exclusion}`, SLOW)
      } catch (e: any) {
        results.push({ id: it.id, title: it.title, service: t.service, removed: false, message: `${name} refused: ${e.message}`, sizeBytes: it.sizeBytes })
        continue
      }
      // Read after write: only an item the Arr no longer has is reported as removed.
      let gone = false
      try { const after = await client.get(base, SLOW); gone = !after || after.id !== t.arrId } catch (e: any) { gone = /HTTP 404\b/.test(String(e?.message)) }
      results.push({
        id: it.id, title: it.title, service: t.service, removed: gone, sizeBytes: it.sizeBytes,
        message: gone ? `Removed from ${name} with its files, and excluded from import lists.` : `${name} said yes but still lists it. Check ${name}.`,
      })
    }
    // The list changed: the next read is fresh.
    this.cached = null
    return { preview: { id: p.id, owner: p.owner, createdAt: p.createdAt, items: p.items, totalBytes: p.totalBytes, skipped: p.skipped }, results }
  }

  private prune() {
    const now = this.d.now()
    for (const [k, v] of this.previews) if (now - v.createdAt > PREVIEW_TTL) this.previews.delete(k)
  }
}
