// =============================================================================
//  HyperProx — removing media from the Plex plug-in (Clear-out and Library)
//
//  Every removal is a plan of items, each going one way:
//    sonarr / radarr  when the Arr Stack plug-in manages the item, matched by
//                     tvdb or tmdb id (never by title): the Arr deletes the
//                     files, and either excludes the show or film from import
//                     lists or unmonitors the episodes, so nothing downloads
//                     it again;
//    plex             otherwise: Plex's own DELETE /library/metadata/<key>
//                     (or one version, /media/<id>), which deletes the files
//                     from disk. Plex allows it only with "Allow media
//                     deletion" on, and something else may download it again.
//
//  The plan is built by a preview and held, single use, for its owner, for ten
//  minutes (PreviewStore). Removing re-checks what is streaming, never touches
//  a file being watched, writes an audit row before and after each item, reads
//  each one back, and asks Plex to rescan the folders it touched.
// =============================================================================

import type { CoreEndpointClient } from '../plugin-host'

export type Via = 'sonarr' | 'radarr' | 'plex'

export type Step =
  | { kind: 'arr-movie'; arrId: number; path: string | null }
  | { kind: 'arr-series'; arrId: number; path: string | null }
  | { kind: 'arr-files'; seriesId: number; fileIds: number[]; episodeIds: number[]; unmonitor: boolean; season: number | null }
  | { kind: 'plex-item'; ratingKey: string }
  | { kind: 'plex-media'; ratingKey: string; mediaId: string }

export interface PlanItem {
  id:        string
  title:     string
  via:       Via
  step:      Step
  /** Exactly which files go. */
  files:     Array<{ path: string; sizeBytes: number | null }>
  sizeBytes: number
  /** What happens, in plain English. */
  note:      string
  /** Someone's next episode, partly watched: shown, not blocking. */
  warnings:  string[]
  /** The keep rule that would have kept it (manual removal is allowed; the preview says so). */
  keptBy:    string | null
  /** Why it cannot go (being watched right now, Plex not allowing deletions). Never executed. */
  blocked:   string | null
  /** Plex keys: any of them streaming blocks the item. `section` and `folder` are what Plex rescans afterwards. */
  plex:      { keys: string[]; section: string | null; folder: string | null }
}

export interface Plan { id: string; owner: string; createdAt: number; items: PlanItem[]; totalBytes: number; skipped: Array<{ id: string; reason: string }> }

export interface ItemResult { id: string; title: string; via: Via; removed: boolean; message: string; sizeBytes: number }

export const PLEX_NOTE = 'Removed from disk by Plex. If something else downloads your media, it may come back.'
export const PLEX_DELETION_OFF = 'Plex is not allowing deletions. Turn it on in Plex: Settings → Server → Library → Allow media deletion.'
export const STREAMING = 'Someone is watching this right now, so it is left alone.'

export class RemoveRefusal extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'refused') { super(message); this.name = 'RemoveRefusal' }
}

const SLOW = 60_000
const PREVIEW_TTL = 10 * 60_000

/** Single-use plans, bound to whoever made them, for ten minutes. */
export class PreviewStore {
  private m = new Map<string, Plan>()
  constructor(private now: () => number, private newId: () => string = () => Math.random().toString(36).slice(2) + Date.now().toString(36)) {}
  put(owner: string, items: PlanItem[], skipped: Plan['skipped']): Plan {
    this.prune()
    const p: Plan = {
      id: this.newId(), owner, createdAt: this.now(), items, skipped,
      totalBytes: items.filter(i => !i.blocked).reduce((a, i) => a + i.sizeBytes, 0),
    }
    if (items.some(i => !i.blocked)) this.m.set(p.id, p)
    return p
  }
  take(id: unknown, owner: string): Plan {
    this.prune()
    const p = typeof id === 'string' ? this.m.get(id) : undefined
    if (!p) throw new RemoveRefusal('That preview has expired. Preview the removal again.', 409, 'preview_expired')
    if (p.owner !== owner) throw new RemoveRefusal('That preview belongs to someone else.', 403, 'not_yours')
    this.m.delete(p.id)
    return p
  }
  private prune() { const t = this.now(); for (const [k, v] of this.m) if (t - v.createdAt > PREVIEW_TTL) this.m.delete(k) }
}

/** Every key Plex is streaming now: the item, its season and its show. */
export async function streamingKeys(plex: CoreEndpointClient | null): Promise<Set<string>> {
  const out = new Set<string>()
  if (!plex) return out
  const body = await plex.get('/status/sessions', 10_000)
  for (const m of Array.isArray(body?.MediaContainer?.Metadata) ? body.MediaContainer.Metadata : []) {
    for (const k of [m?.ratingKey, m?.parentRatingKey, m?.grandparentRatingKey]) if (k != null) out.add(String(k))
  }
  return out
}

/** Plex's "Allow media deletion": true, false, or null when it cannot be read. */
export async function plexAllowsDeletion(plex: CoreEndpointClient | null): Promise<boolean | null> {
  if (!plex) return null
  try {
    const body = await plex.get('/:/prefs', 10_000)
    const s = (Array.isArray(body?.MediaContainer?.Setting) ? body.MediaContainer.Setting : []).find((x: any) => x?.id === 'allowMediaDeletion')
    if (!s) return null
    return s.value === true || s.value === 1 || s.value === '1' || s.value === 'true'
  } catch { return null }
}

const gone = async (f: () => Promise<any>, still: (x: any) => boolean): Promise<boolean> => {
  try { const x = await f(); return !x || !still(x) } catch (e: any) { return /HTTP 404\b/.test(String(e?.message)) }
}

export interface EngineDeps {
  plex(): Promise<CoreEndpointClient | null>
  sonarr(): Promise<CoreEndpointClient | null>
  radarr(): Promise<CoreEndpointClient | null>
  audit?(action: string, details: Record<string, unknown>): Promise<void>
}

/** Do one item's step and read it back. Returns whether it is really gone, and what to say. */
async function runStep(it: PlanItem, d: EngineDeps): Promise<{ removed: boolean; message: string }> {
  const s = it.step
  if (s.kind === 'arr-movie' || s.kind === 'arr-series') {
    const svc = s.kind === 'arr-movie' ? 'Radarr' : 'Sonarr'
    const c = s.kind === 'arr-movie' ? await d.radarr() : await d.sonarr()
    if (!c) return { removed: false, message: `${svc} is not set up.` }
    const base = `/api/v3/${s.kind === 'arr-movie' ? 'movie' : 'series'}/${s.arrId}`
    // Still what the preview showed: a re-added entry under the same id is never deleted unseen.
    const before = await c.get(base, SLOW).catch(() => null)
    if (!before || before.id !== s.arrId || (s.path && before.path !== s.path)) return { removed: false, message: `${svc} no longer has it as previewed, so it was left alone.` }
    await c.delete(`${base}?deleteFiles=true&${s.kind === 'arr-movie' ? 'addImportExclusion=true' : 'addImportListExclusion=true'}`, SLOW)
    const ok = await gone(() => c.get(base, SLOW), x => x.id === s.arrId)
    return { removed: ok, message: ok ? `Removed from ${svc} with its files, and excluded from import lists.` : `${svc} said yes but still lists it. Check ${svc}.` }
  }
  if (s.kind === 'arr-files') {
    const c = await d.sonarr()
    if (!c) return { removed: false, message: 'Sonarr is not set up.' }
    for (const f of s.fileIds) {
      const before = await c.get(`/api/v3/episodefile/${f}`, SLOW).catch(() => null)
      if (!before || before.id !== f || before.seriesId !== s.seriesId) return { removed: false, message: 'Sonarr no longer has these files as previewed, so they were left alone.' }
    }
    for (const f of s.fileIds) await c.delete(`/api/v3/episodefile/${f}`, SLOW)
    if (s.unmonitor && s.episodeIds.length) {
      await c.put('/api/v3/episode/monitor', { episodeIds: s.episodeIds, monitored: false }, SLOW)
      if (s.season !== null) {
        const series = await c.get(`/api/v3/series/${s.seriesId}`, SLOW)
        if (Array.isArray(series?.seasons)) {
          series.seasons = series.seasons.map((x: any) => (x?.seasonNumber === s.season ? { ...x, monitored: false } : x))
          await c.put(`/api/v3/series/${s.seriesId}`, series, SLOW)
        }
      }
    }
    // Read back: every file gone, and (when asked) every episode unmonitored.
    for (const f of s.fileIds) {
      if (!(await gone(() => c.get(`/api/v3/episodefile/${f}`, SLOW), x => x.id === f))) return { removed: false, message: 'Sonarr said yes but still has a file. Check Sonarr.' }
    }
    if (s.unmonitor && s.episodeIds.length) {
      const eps: any[] = await c.get(`/api/v3/episode?seriesId=${s.seriesId}`, SLOW).catch(() => [])
      const still = eps.filter(e => s.episodeIds.includes(e?.id) && e?.monitored)
      if (still.length) return { removed: true, message: `Files deleted in Sonarr, but ${still.length} episode(s) are still monitored. Check Sonarr.` }
      return { removed: true, message: 'Files deleted in Sonarr, and the episodes are unmonitored so they are not downloaded again.' }
    }
    return { removed: true, message: 'Files deleted in Sonarr. The episodes stay monitored, so Sonarr may download a better copy.' }
  }
  const c = await d.plex()
  if (!c) return { removed: false, message: 'Plex is not set.' }
  const base = `/library/metadata/${s.ratingKey}`
  if (s.kind === 'plex-item') {
    await c.delete(base, SLOW)
    const ok = await gone(() => c.get(base, SLOW), x => (x?.MediaContainer?.Metadata ?? []).some((m: any) => String(m?.ratingKey) === s.ratingKey))
    return { removed: ok, message: ok ? PLEX_NOTE : 'Plex said yes but still lists it. Check Plex.' }
  }
  await c.delete(`${base}/media/${s.mediaId}`, SLOW)
  const ok = await gone(() => c.get(base, SLOW), x => (x?.MediaContainer?.Metadata?.[0]?.Media ?? []).some((m: any) => String(m?.id) === s.mediaId))
  return { removed: ok, message: ok ? `That version was ${PLEX_NOTE.charAt(0).toLowerCase()}${PLEX_NOTE.slice(1)}` : 'Plex said yes but still lists that version. Check Plex.' }
}

/** Remove what a plan lists. Never throws for one item: each gets a result. */
export async function executePlan(plan: Plan, d: EngineDeps, by: string): Promise<{ results: ItemResult[]; rescanned: number }> {
  const plex = await d.plex()
  // Read now, not at preview time: someone may have pressed play since.
  const live = await streamingKeys(plex).catch(() => null)
  const results: ItemResult[] = []
  const rescans = new Map<string, Set<string | null>>()
  for (const it of plan.items) {
    const base = { id: it.id, title: it.title, via: it.via, sizeBytes: it.sizeBytes }
    if (it.blocked) { results.push({ ...base, removed: false, message: it.blocked }); continue }
    if (live === null && plex) { results.push({ ...base, removed: false, message: 'Plex could not say what is playing, so nothing was removed. Try again.' }); continue }
    if (live && it.plex.keys.some(k => live.has(k))) { results.push({ ...base, removed: false, message: STREAMING }); continue }
    const what = { by, title: it.title, via: it.via, step: it.step.kind, bytes: it.sizeBytes, files: it.files.map(f => f.path).slice(0, 50), preview: plan.id }
    await d.audit?.('plex.media.remove.start', what)
    let r: { removed: boolean; message: string }
    try { r = await runStep(it, d) } catch (e: any) { r = { removed: false, message: `${it.via === 'plex' ? 'Plex' : it.via === 'sonarr' ? 'Sonarr' : 'Radarr'} refused: ${String(e?.message ?? e).slice(0, 200)}` } }
    await d.audit?.('plex.media.remove.result', { ...what, removed: r.removed, message: r.message })
    results.push({ ...base, ...r })
    if (r.removed && it.plex.section) {
      const set = rescans.get(it.plex.section) ?? new Set()
      set.add(it.plex.folder)
      rescans.set(it.plex.section, set)
    }
  }
  // Ask Plex to look again at just the folders touched, so the item leaves Plex promptly.
  let rescanned = 0
  if (plex) {
    for (const [section, folders] of rescans) {
      if (!/^\d+$/.test(section)) continue
      for (const f of folders) {
        const q = f ? `?path=${encodeURIComponent(f)}` : ''
        await plex.trigger(`/library/sections/${section}/refresh${q}`, 15_000).then(() => { rescanned++ }).catch(() => {})
      }
    }
  }
  return { results, rescanned }
}
