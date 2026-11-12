// =============================================================================
//  HyperProx — Arr Stack queue actions
//
//  What a person can DO about a problem in the queue, on queue downloads only (never on library files):
//    find-another   remove the download from the client, blocklist the release, search for what it covered
//    remove         the same removal, blocklist optional, no search
//    retry-import   ask the Arr to check its downloads again (importBlocked / importFailed)
//    prioritise     move a torrent to the top of qBittorrent's queue
//    swap-pack      remove a season's single-episode downloads (not blocklisted) and search for a season pack
//    fix-stalled    find-another over every stalled download the person confirmed
//    clear-done     remove (not blocklisted, no search) every finished download whose items are all already in the library
//    swap-check     read-only: did a season pack get grabbed after a swap
//
//  The browser sends an instance and a download id (or a show and season, or a list of download ids). It never
//  sends a queue row id: this module reads the whole queue fresh, resolves the ids itself, verifies that every row it
//  selected really belongs to that download, and acts only on those. Sonarr's `GET /queue?seriesId=` is silently
//  ignored (the parameter is `seriesIds`) and returns everything, so no upstream filter is ever trusted.
//
//  Everything is planned first (planAction: pure), so the page can show exactly what would be removed, then run.
// =============================================================================

import type { CoreEndpointClient } from '../plugin-host'
import { collapseByDownload, importHint, isDone, problemOf, readAllQueue, stripPaths, type FileInfo } from './logic'
import { readEpisodeInfo, readMovieInfo } from './lookup'
export { importHint }

export type Instance = 'sonarr' | 'radarr'
export type ActionName = 'find-another' | 'remove' | 'retry-import' | 'prioritise' | 'swap-pack' | 'fix-stalled' | 'clear-done' | 'swap-check'
export const ACTIONS: ActionName[] = ['find-another', 'remove', 'retry-import', 'prioritise', 'swap-pack', 'fix-stalled', 'clear-done', 'swap-check']
/** Actions that remove something from a client: the server wants `confirmed: true` for them. */
export const DESTRUCTIVE: ActionName[] = ['find-another', 'remove', 'swap-pack', 'fix-stalled', 'clear-done']

export interface ActionRequest {
  action: ActionName
  instance: Instance
  downloadId?: string
  downloadIds?: string[]
  blocklist?: boolean
  showKey?: string
  seasonKey?: string
  known?: string[]
}

export class ActionRefusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = 'ActionRefusal' }
}

export interface Command { name: 'EpisodeSearch' | 'SeasonSearch' | 'MoviesSearch' | 'RefreshMonitoredDownloads'; body: Record<string, unknown>; label: string }
export interface PlanItem { downloadId: string; name: string; rows: number; episodes: number }
export interface Plan {
  action: ActionName
  instance: Instance
  items: PlanItem[]
  /** Queue row ids of the selected downloads, resolved here and nowhere else. */
  rowIds: number[]
  blocklist: boolean
  commands: Command[]
  skipped: Array<{ downloadId: string; name: string; reason: string }>
  qbitHash?: string
  /** swap-pack / swap-check: the multi-episode downloads that were already in the season. */
  packsBefore?: string[]
  seasonLabel?: string
}

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const ID_RE = /^(?:d:[\x21-\x7e]{1,200}|i:\d{1,12}|n:\d{1,6})$/
const HASH_RE = /^(?:[A-Fa-f0-9]{40}|[A-Fa-f0-9]{64})$/
const nameOf = (rows: any[]) => stripPaths(String(rows[0]?.title ?? 'unknown release')).slice(0, 160)
const epIdOf = (r: any): number | null => { const n = Number(r?.episodeId ?? r?.episode?.id); return Number.isInteger(n) && n > 0 ? n : null }
const seasonOf = (r: any): number | null => { const n = Number(r?.seasonNumber ?? r?.episode?.seasonNumber); return Number.isInteger(n) && n >= 0 ? n : null }
const seriesOf = (r: any): number | null => { const n = Number(r?.seriesId ?? r?.series?.id); return Number.isInteger(n) && n > 0 ? n : null }
const movieOf = (r: any): number | null => { const n = Number(r?.movieId ?? r?.movie?.id); return Number.isInteger(n) && n > 0 ? n : null }
const distinct = <T,>(xs: T[]): T[] => [...new Set(xs)]
const pad = (n: number) => String(n).padStart(2, '0')
const seasonName = (n: number) => (n === 0 ? 'Specials' : `season ${n}`)

/**
 * The rows of one download, picked from a FRESH full queue by id, and checked: every row must carry that downloadId
 * (or be that one row). Null when the download is no longer in the queue.
 */
export function resolveDownload(allRows: any[], id: string): any[] | null {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new ActionRefusal(400, 'bad_request', 'That is not a download id.')
  const hit = collapseByDownload(allRows).find(d => d.id === id)
  if (!hit) return null
  const ok = id.startsWith('d:') ? hit.rows.every(r => `d:${r.downloadId}` === id)
    : id.startsWith('i:') ? hit.rows.length === 1 && `i:${hit.rows[0].id}` === id
    : hit.rows.length === 1
  if (!ok || !hit.rows.length) throw new ActionRefusal(500, 'selection_mismatch', 'The rows picked from the queue did not all belong to that download, so nothing was changed.')
  return hit.rows
}

/** Each row's id, as a number, for the removal call. A row without a usable id cannot be removed by id. */
function rowIdsOf(rows: any[]): number[] {
  const ids = rows.map(r => Number(r.id))
  if (!ids.every(n => Number.isInteger(n) && n > 0)) throw new ActionRefusal(409, 'no_row_id', 'This download has a queue row Sonarr or Radarr gave no id, so it cannot be removed from here.')
  return distinct(ids)
}

const PACK_EPISODE_MARK = /S\d{1,3}\s*[._ -]?E\d{1,4}|\b\d{1,2}x\d{2,3}\b/i

/**
 * What a download covered, as search commands. One episode: EpisodeSearch for it. Several episodes with no episode
 * marker in the release name (a season pack): SeasonSearch for each season it spans. Several episodes named
 * individually (S01E01E02): EpisodeSearch for exactly those. A film: MoviesSearch. Nothing matched: no commands.
 */
export function searchCommands(instance: Instance, rows: any[]): Command[] {
  if (instance === 'radarr') {
    const ids = distinct(rows.map(movieOf).filter((n): n is number => n !== null))
    return ids.length ? [{ name: 'MoviesSearch', body: { name: 'MoviesSearch', movieIds: ids }, label: ids.length === 1 ? 'the movie' : `${ids.length} movies` }] : []
  }
  const eps = distinct(rows.map(epIdOf).filter((n): n is number => n !== null))
  if (!eps.length) return []
  const title = String(rows[0]?.title ?? '')
  if (eps.length >= 2 && !PACK_EPISODE_MARK.test(title)) {
    const pairs = distinct(rows.map(r => { const s = seriesOf(r), n = seasonOf(r); return s !== null && n !== null ? `${s}:${n}` : '' }))
    if (pairs.every(Boolean)) {
      return pairs.map(p => { const [s, n] = p.split(':').map(Number); return { name: 'SeasonSearch' as const, body: { name: 'SeasonSearch', seriesId: s, seasonNumber: n }, label: seasonName(n) } })
    }
  }
  return [{ name: 'EpisodeSearch', body: { name: 'EpisodeSearch', episodeIds: eps }, label: eps.length === 1 ? 'the episode' : `${eps.length} episodes` }]
}

/** Merge search commands: one EpisodeSearch or MoviesSearch with every id, one SeasonSearch per season. */
export function mergeCommands(cmds: Command[]): Command[] {
  const out: Command[] = []
  const eps: number[] = [], movies: number[] = [], seasons = new Map<string, Command>()
  for (const c of cmds) {
    if (c.name === 'EpisodeSearch') eps.push(...(c.body.episodeIds as number[]))
    else if (c.name === 'MoviesSearch') movies.push(...(c.body.movieIds as number[]))
    else seasons.set(`${c.body.seriesId}:${c.body.seasonNumber}`, c)
  }
  if (eps.length) { const ids = distinct(eps); out.push({ name: 'EpisodeSearch', body: { name: 'EpisodeSearch', episodeIds: ids }, label: ids.length === 1 ? 'the episode' : `${ids.length} episodes` }) }
  if (movies.length) { const ids = distinct(movies); out.push({ name: 'MoviesSearch', body: { name: 'MoviesSearch', movieIds: ids }, label: ids.length === 1 ? 'the movie' : `${ids.length} movies` }) }
  return [...out, ...seasons.values()]
}

const isPack = (rows: any[]) => distinct(rows.map(epIdOf).filter((n): n is number => n !== null)).length >= 2
const item = (id: string, rows: any[]): PlanItem => ({ downloadId: id, name: nameOf(rows), rows: rows.length, episodes: distinct(rows.map(epIdOf).filter((n): n is number => n !== null)).length })

function parseSwapTarget(req: ActionRequest): { seriesId: number; season: number } {
  const s = /^s:(\d{1,9})$/.exec(req.showKey ?? ''), n = /^(\d{1,4})$/.exec(req.seasonKey ?? '')
  if (!s || !n) throw new ActionRefusal(400, 'bad_request', 'Name the show and one season to swap.')
  return { seriesId: Number(s[1]), season: Number(n[1]) }
}

/** The multi-episode downloads in one season. */
function packsIn(rows: any[], seriesId: number, season: number): string[] {
  return collapseByDownload(rows).filter(d => d.rows.some(r => seriesOf(r) === seriesId && seasonOf(r) === season) && isPack(d.rows)).map(d => d.id)
}

/** Pure: from a fresh, full queue and a request, exactly what would be done. Throws ActionRefusal when it should not. */
export function planAction(allRows: any[], req: ActionRequest, info?: Map<number, FileInfo>): Plan {
  const base = { action: req.action, instance: req.instance, items: [] as PlanItem[], rowIds: [] as number[], blocklist: false, commands: [] as Command[], skipped: [] as Plan['skipped'] }
  const gone = () => new ActionRefusal(404, 'gone', 'That download is no longer in the queue.')

  switch (req.action) {
    case 'remove': {
      const rows = resolveDownload(allRows, req.downloadId as string); if (!rows) throw gone()
      return { ...base, items: [item(req.downloadId!, rows)], rowIds: rowIdsOf(rows), blocklist: req.blocklist === true }
    }
    case 'find-another': {
      const rows = resolveDownload(allRows, req.downloadId as string); if (!rows) throw gone()
      const commands = searchCommands(req.instance, rows)
      if (!commands.length) throw new ActionRefusal(409, 'nothing_to_search', `${req.instance === 'sonarr' ? 'Sonarr' : 'Radarr'} has not matched this download to ${req.instance === 'sonarr' ? 'an episode' : 'a movie'}, so there is nothing to search for. Use Remove instead.`)
      return { ...base, items: [item(req.downloadId!, rows)], rowIds: rowIdsOf(rows), blocklist: true, commands }
    }
    case 'retry-import': {
      const rows = resolveDownload(allRows, req.downloadId as string); if (!rows) throw gone()
      if (problemOf(rows) !== 'blocked') throw new ActionRefusal(409, 'not_blocked', 'This download is not waiting on an import, so there is nothing to retry.')
      return { ...base, items: [item(req.downloadId!, rows)], commands: [{ name: 'RefreshMonitoredDownloads', body: { name: 'RefreshMonitoredDownloads' }, label: 'a re-check of its downloads' }] }
    }
    case 'prioritise': {
      const rows = resolveDownload(allRows, req.downloadId as string); if (!rows) throw gone()
      const hash = String(rows[0].downloadId ?? '')
      if (String(rows[0].protocol ?? '') !== 'torrent' || !HASH_RE.test(hash)) throw new ActionRefusal(409, 'not_a_torrent', 'Only a torrent can be moved to the top of the queue.')
      return { ...base, items: [item(req.downloadId!, rows)], qbitHash: hash.toLowerCase() }
    }
    case 'swap-pack': {
      if (req.instance !== 'sonarr') throw new ActionRefusal(400, 'bad_request', 'Season packs are a Sonarr thing.')
      const { seriesId, season } = parseSwapTarget(req)
      const singles = collapseByDownload(allRows).filter(d => {
        if (!d.rows.every(r => seriesOf(r) === seriesId && seasonOf(r) === season)) return false
        if (isPack(d.rows) || !d.rows.some(r => epIdOf(r) !== null)) return false
        // A single that has finished downloading is about to import: it is not thrown away.
        return !d.rows.every(r => num(r.size) > 0 && num(r.sizeleft) === 0)
      })
      if (singles.length < 2) throw new ActionRefusal(409, 'not_enough_singles', 'This season needs at least two single-episode downloads still in progress to swap them for a pack.')
      // The confirm sends the downloads the person was shown: if the season's singles are not exactly those any more,
      // nothing is removed (a single grabbed in between would otherwise go unseen).
      if (req.downloadIds) {
        const now = singles.map(d => d.id).sort().join('\n'), shown = distinct(req.downloadIds).sort().join('\n')
        if (now !== shown) throw new ActionRefusal(409, 'changed', 'This season\'s downloads changed since you looked, so nothing was removed. Open the swap again to see the current list.')
      }
      return {
        ...base, items: singles.map(d => item(d.id, d.rows)), rowIds: distinct(singles.flatMap(d => rowIdsOf(d.rows))), blocklist: false,
        commands: [{ name: 'SeasonSearch', body: { name: 'SeasonSearch', seriesId, seasonNumber: season }, label: seasonName(season) }],
        packsBefore: packsIn(allRows, seriesId, season), seasonLabel: seasonName(season),
      }
    }
    case 'swap-check': {
      const { seriesId, season } = parseSwapTarget(req)
      return { ...base, packsBefore: packsIn(allRows, seriesId, season), seasonLabel: seasonName(season) }
    }
    case 'fix-stalled': {
      const ids = distinct(req.downloadIds ?? [])
      if (!ids.length || ids.length > 50) throw new ActionRefusal(400, 'bad_request', 'Name between 1 and 50 downloads.')
      const items: PlanItem[] = [], skipped: Plan['skipped'] = [], rowIds: number[] = [], cmds: Command[] = []
      for (const id of ids) {
        const rows = resolveDownload(allRows, id)
        if (!rows) { skipped.push({ downloadId: id, name: id, reason: 'no longer in the queue' }); continue }
        if (problemOf(rows) !== 'stalled') { skipped.push({ downloadId: id, name: nameOf(rows), reason: 'no longer stalled' }); continue }
        const c = searchCommands(req.instance, rows)
        if (!c.length) { skipped.push({ downloadId: id, name: nameOf(rows), reason: 'not matched to anything, so nothing to search for' }); continue }
        items.push(item(id, rows)); rowIds.push(...rowIdsOf(rows)); cmds.push(...c)
      }
      if (!items.length) throw new ActionRefusal(409, 'nothing_to_do', 'None of those downloads is still stalled, so nothing was changed.')
      return { ...base, items, skipped, rowIds: distinct(rowIds), blocklist: true, commands: mergeCommands(cmds) }
    }
    case 'clear-done': {
      const ids = distinct(req.downloadIds ?? [])
      if (!ids.length || ids.length > 50) throw new ActionRefusal(400, 'bad_request', 'Name between 1 and 50 downloads.')
      const items: PlanItem[] = [], skipped: Plan['skipped'] = [], rowIds: number[] = []
      for (const id of ids) {
        const rows = resolveDownload(allRows, id)
        if (!rows) { skipped.push({ downloadId: id, name: id, reason: 'no longer in the queue' }); continue }
        // Re-checked on this fresh read: only a download that is still finished with nothing left to import goes.
        if (!isDone(rows, info)) { skipped.push({ downloadId: id, name: nameOf(rows), reason: 'no longer done' }); continue }
        items.push(item(id, rows)); rowIds.push(...rowIdsOf(rows))
      }
      if (!items.length) throw new ActionRefusal(409, 'nothing_to_do', 'None of those downloads is still done, so nothing was changed.')
      return { ...base, items, skipped, rowIds: distinct(rowIds), blocklist: false }
    }
  }
  throw new ActionRefusal(400, 'bad_request', 'Unknown action.')
}

export interface ActionDeps {
  sonarr: () => Promise<CoreEndpointClient | null>
  radarr: () => Promise<CoreEndpointClient | null>
  qbit: () => Promise<CoreEndpointClient | null>
  /** Throws when the entry cannot be written: the action then does not run. */
  audit: (action: string, details: Record<string, unknown>) => Promise<void>
}

export interface ActionResult {
  action: ActionName
  instance: Instance
  done: boolean
  summary: string
  removed: Array<{ name: string; rows: number }>
  searched: string[]
  notes: string[]
  messages?: string[]
  hint?: string | null
  packsBefore?: string[]
  packGrabbed?: boolean
}

const label = (i: Instance) => (i === 'sonarr' ? 'Sonarr' : 'Radarr')
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

async function readRows(c: CoreEndpointClient, i: Instance): Promise<any[]> {
  return readAllQueue((p, t) => c.get(p, t), i)
}

/** The preview (what would happen) or the run. Always starts from a fresh read of the whole queue. */
export async function runAction(deps: ActionDeps, req: ActionRequest, who: string, opts: { preview?: boolean; delay?: (ms: number) => Promise<void> } = {}): Promise<{ plan: Plan; result?: ActionResult }> {
  const client = await (req.instance === 'sonarr' ? deps.sonarr() : deps.radarr())
  if (!client) throw new ActionRefusal(409, 'not_configured', `${label(req.instance)} is not set up in the Arr Stack plug-in.`)
  const rows = await readRows(client, req.instance).catch(e => { throw new ActionRefusal(502, 'queue_failed', `${label(req.instance)}'s queue could not be read: ${String(e?.message ?? e).slice(0, 120)}`) })
  if (!opts.preview && req.action === 'swap-pack' && !req.downloadIds?.length) throw new ActionRefusal(400, 'bad_request', 'Confirm the swap with the downloads you were shown.')
  // "Done" also means every episode it covers has a file now: read that fresh, here, never trusting the page.
  const info = req.action === 'clear-done'
    ? await (req.instance === 'sonarr' ? readEpisodeInfo((p, t) => client.get(p, t), rows, Date.now()) : readMovieInfo((p, t) => client.get(p, t), rows, Date.now()))
    : undefined
  const plan = planAction(rows, req, info)
  if (opts.preview) return { plan }

  const named = plan.items.map(i => i.name.slice(0, 120)).slice(0, 20)
  const base = { action: req.action, instance: req.instance, by: who.slice(0, 120), downloads: plan.items.length, rows: plan.rowIds.length, blocklist: plan.blocklist, names: named, search: plan.commands.map(c => c.name).join(',') }
  const res: ActionResult = { action: req.action, instance: req.instance, done: false, summary: '', removed: [], searched: [], notes: [], packsBefore: plan.packsBefore }

  if (req.action === 'swap-check') {
    const fresh = collapseByDownload(rows).filter(d => (plan.packsBefore ?? []).includes(d.id) && !(req.known ?? []).includes(d.id))
    res.packGrabbed = fresh.length > 0
    res.done = true
    res.summary = fresh.length ? `A season pack was grabbed: ${nameOf(fresh[0].rows)}.` : 'no season pack found; singles will be re-grabbed'
    return { plan, result: res }
  }

  // Audited before it runs; no entry, no action.
  try { await deps.audit('arr.queue.action', base) } catch { throw new ActionRefusal(503, 'audit_unavailable', 'The audit log could not be written, so nothing was changed.') }
  const finish = async (r: ActionResult, ok: boolean) => { await deps.audit('arr.queue.action.result', { ...base, ok, summary: r.summary.slice(0, 190) }).catch(() => {}) }

  try {
    if (plan.qbitHash) {
      const q = await deps.qbit()
      if (!q?.get || !q.postForm) throw new ActionRefusal(409, 'no_qbit', 'qBittorrent is not set up in the Arr Stack plug-in.')
      const known = await q.get(`/api/v2/torrents/info?hashes=${plan.qbitHash}`, 10_000)
      if (!Array.isArray(known) || !known.length) throw new ActionRefusal(409, 'not_in_qbit', 'qBittorrent does not have this torrent, so it was not moved.')
      await q.postForm('/api/v2/torrents/topPrio', { hashes: plan.qbitHash }, 10_000)
      res.done = true
      res.summary = `Moved "${plan.items[0].name}" to the top of qBittorrent's queue.`
      await finish(res, true)
      return { plan, result: res }
    }

    if (plan.rowIds.length) {
      if (!client.deleteBody) throw new ActionRefusal(501, 'unsupported', 'This connection cannot remove downloads.')
      await client.deleteBody(`/api/v3/queue/bulk?removeFromClient=true&blocklist=${plan.blocklist}&skipRedownload=true`, { ids: plan.rowIds }, 30_000)
      res.removed = plan.items.map(i => ({ name: i.name, rows: i.rows }))
      // Read it back: the call's own answer is empty either way.
      const after = await readRows(client, req.instance).catch(() => null)
      const left = after ? after.filter(r => plan.rowIds.includes(Number(r.id))).length : 0
      if (left) res.notes.push(`${label(req.instance)} still lists ${plural(left, 'row')} of it; it may be waiting on the download client.`)
      if (!after) res.notes.push('The queue could not be read back to confirm the removal.')
    }

    if (plan.commands.length) {
      if (!client.post) throw new ActionRefusal(501, 'unsupported', 'This connection cannot start searches.')
      for (const c of plan.commands) {
        let r: any
        try { r = await client.post(`/api/v3/command`, c.body, 30_000) }
        catch (e: any) {
          res.summary = (res.removed.length ? `Removed ${plural(res.removed.length, 'download')}, but the ${c.name} failed: ` : `${c.name} failed: `) + String(e?.message ?? e).slice(0, 120)
          await finish(res, false)
          throw new ActionRefusal(502, 'command_failed', res.summary)
        }
        if (!r || typeof r.id !== 'number') {
          res.summary = `${label(req.instance)} did not confirm the ${c.name}.`
          await finish(res, false)
          throw new ActionRefusal(502, 'command_unconfirmed', (res.removed.length ? `Removed ${plural(res.removed.length, 'download')}, but ` : '') + res.summary)
        }
        res.searched.push(c.label)
      }
    }

    res.done = true
    const first = plan.items[0]
    const nm = plan.items.length === 1 ? `"${first.name}"${first.episodes > 1 ? ` (${plural(first.episodes, 'episode')})` : ''}` : plural(plan.items.length, 'download')
    switch (req.action) {
      case 'remove': res.summary = `Removed ${nm} from the queue and the download client${plan.blocklist ? ', and blocklisted the release' : ''}.`; break
      case 'find-another': res.summary = `Removed ${nm} and blocklisted the release. Searching for another copy of ${res.searched.join(' and ')}.`; break
      case 'fix-stalled': res.summary = `Removed ${nm} and blocklisted them. Searching for another copy of ${res.searched.join(', ')}.${plan.skipped.length ? ` Skipped ${plural(plan.skipped.length, 'download')} that changed meanwhile.` : ''}`; break
      case 'clear-done': res.summary = `Cleared ${nm} from the queue (not blocklisted). Everything they cover is already in your library.${plan.skipped.length ? ` Skipped ${plural(plan.skipped.length, 'download')} that changed meanwhile.` : ''}`; break
      case 'swap-pack': res.summary = `Removed ${nm} (not blocklisted) and searched for a ${plan.seasonLabel} pack. Checking in about 20 seconds whether one was grabbed.`; break
      case 'retry-import': {
        res.messages = [...new Set(rows.filter(r => `d:${r.downloadId}` === first.downloadId || `i:${r.id}` === first.downloadId).flatMap(r => [r.errorMessage, ...(r.statusMessages ?? []).flatMap((m: any) => m?.messages?.length ? m.messages : [m?.title])]).filter(Boolean).map((t: any) => stripPaths(String(t)).slice(0, 240)))].slice(0, 6)
        res.hint = importHint(res.messages)
        res.summary = `Asked ${label(req.instance)} to check its downloads again. If "${first.name}" is still blocked in a minute, the reason below still stands.`
        break
      }
    }
    await finish(res, true)
    return { plan, result: res }
  } catch (e) {
    if (!(e instanceof ActionRefusal)) await finish({ ...res, summary: String((e as any)?.message ?? e) }, false)
    throw e instanceof ActionRefusal ? e : new ActionRefusal(502, 'action_failed', String((e as any)?.message ?? e).slice(0, 200))
  }
}
