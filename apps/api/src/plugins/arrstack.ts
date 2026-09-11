// =============================================================================
//  Plug-in — Arr Stack
//
//  Sonarr, Radarr, Prowlarr and qBittorrent are one pipeline, not four services,
//  and splitting them across four cards meant reading four places to answer one
//  question: is anything stuck between "wanted" and "on disk".
//
//  Each still gets its own endpoint and its own credential — Sonarr's key can
//  never reach Radarr — but they report as one thing, because that is how the
//  stack actually fails: the indexers stop returning results, so the queue dries
//  up, so nothing imports.
//
//  Read-only throughout, with one exception: search can send a release to the
//  download client, and only when a person clicks it.
// =============================================================================

import type {
  Plugin, PluginContext, PluginTileData, PluginDetail,
  PluginMetric, PluginSearchResult, PluginStuckImport } from '../lib/plugin-host'

type Tone = 'good' | 'warn' | 'bad'
const EPISODE = /[Ss]\d{1,2}[Ee]\d{1,2}|\b\d{1,2}x\d{2}\b/

function gb(bytes: number): string {
  const v = Number(bytes ?? 0)
  if (!v) return '—'
  return v >= 1e9 ? `${(v / 1e9).toFixed(1)} GB` : `${(v / 1e6).toFixed(0)} MB`
}
function rate(bps: number): string {
  const v = Number(bps ?? 0)
  if (v < 1024) return `${v} B/s`
  if (v < 1048576) return `${(v / 1024).toFixed(0)} KB/s`
  return `${(v / 1048576).toFixed(1)} MB/s`
}

/** Needs a person: a blocked import sits forever and nothing escalates it. */
function importBlocked(items: any[]): any[] {
  return items.filter(i =>
    i.trackedDownloadState === 'importBlocked' ||
    i.trackedDownloadState === 'importFailed' ||
    i.trackedDownloadStatus === 'error' ||
    String(i.trackedDownloadState ?? '').startsWith('importPending'))
}
/** Reported, never as "needs attention" — something usually clears these. */
function downloadStalled(items: any[]): any[] {
  return items.filter(i => !importBlocked([i]).length &&
    (i.trackedDownloadStatus === 'warning' || i.status === 'warning'))
}
function etaOf(secs: any): string {
  const n = Number(secs)
  if (!n || n >= 8_640_000) return '—'
  if (n < 3600) return `${Math.round(n / 60)}m`
  if (n < 86_400) return `${(n / 3600).toFixed(1)}h`
  return `${(n / 86_400).toFixed(1)}d`
}

const ACTIVE_STATES = new Set([
  'downloading', 'forcedDL', 'metaDL', 'stalledDL', 'uploading', 'forcedUP', 'checkingDL',
])

function titleOf(i: any): string {
  return i.title || i.series?.title || i.movie?.title || 'unknown'
}

interface Arr { key: string; label: string; queue: any[]; total: number; health: any[]; error?: string }

async function readArr(ctx: PluginContext, key: string, label: string): Promise<Arr | null> {
  if (key !== 'default' && !ctx.has(key)) return null
  const c = key === 'default' ? ctx : ctx.from(key)
  try {
    const [q, health] = await Promise.all([
      c.get('/api/v3/queue?pageSize=200&includeUnknownSeriesItems=true&includeUnknownMovieItems=true'),
      c.get('/api/v3/health').catch(() => []),
    ])
    return { key, label, queue: q?.records ?? [],
             total: Number(q?.totalRecords ?? (q?.records?.length ?? 0)),
             health: Array.isArray(health) ? health : [] }
  } catch (e: any) {
    return { key, label, queue: [], total: 0, health: [], error: e.message }
  }
}

async function readAll(ctx: PluginContext) {
  const [sonarr, radarr, indexers, transfer, torrents] = await Promise.all([
    readArr(ctx, 'default', 'Sonarr'),
    readArr(ctx, 'radarr', 'Radarr'),
    ctx.has('prowlarr') ? ctx.from('prowlarr').get('/api/v1/indexer').catch(() => null) : null,
    ctx.has('qbit') ? ctx.from('qbit').get('/api/v2/transfer/info').catch(() => null) : null,
    ctx.has('qbit') ? ctx.from('qbit').get('/api/v2/torrents/info').catch(() => null) : null,
  ])
  return {
    arrs: [sonarr, radarr].filter((x): x is Arr => x !== null),
    indexers: Array.isArray(indexers) ? indexers : null,
    transfer,
    torrents: Array.isArray(torrents) ? torrents : null,
  }
}


// ---------------------------------------------------------------------------
//  Rescuing imports that cannot resolve themselves
//
//  Twice in one week a season pack arrived complete and correct and could not
//  be filed, because the release group numbered episodes in a way the parser
//  does not read: "Crossing Jordan - 601 - Retribution" and "MacGyver (2016) -
//  S01 E01 - The Rising". Both were fixed by hand the same way — read the
//  numbers out of the filename, look up the matching episode, import against it
//  explicitly. Doing that twice is a lesson; doing it a third time by hand is a
//  choice.
//
//  Nothing here guesses. A file is mapped only when the pattern is unambiguous
//  AND the episode it names exists in the library AND no other file in the same
//  release claims it. Anything else is reported unmapped rather than filed
//  somewhere plausible, because a wrongly filed episode is harder to notice
//  than a missing one.
// ---------------------------------------------------------------------------

/** Ordered most-explicit first. The first that matches wins. */
const EPISODE_PATTERNS: Array<{ name: string; rx: RegExp }> = [
  // S01E01, S01 E01, S01.E01, s1e1
  { name: 'SxxExx',      rx: /\bS(\d{1,2})[ ._-]?E(\d{1,3})\b/i },
  // 6x01
  { name: 'NxNN',        rx: /\b(\d{1,2})x(\d{2})\b/ },
  // "Season 6 Episode 1"
  { name: 'Season/Ep',   rx: /\bSeason[ ._-]?(\d{1,2})\b.*?\bEpisode[ ._-]?(\d{1,3})\b/i },
  // " - 601 - ", the bare three-digit form. Anchored on separators either side
  // so a title like "33 Bullets" or a year cannot be read as an episode number.
  { name: 'dash-NNN',    rx: / - (\d)(\d{2}) - / },
]

export function readEpisode(name: string): { season: number; episode: number; via: string } | null {
  for (const p of EPISODE_PATTERNS) {
    const m = name.match(p.rx)
    if (!m) continue
    const season = parseInt(m[1], 10)
    const episode = parseInt(m[2], 10)
    if (!Number.isFinite(season) || !Number.isFinite(episode)) continue
    // Season 0 is specials; those are genuinely ambiguous in packs and are left
    // for a person. A season beyond 50 is a misread, not a television show.
    if (season < 1 || season > 50 || episode < 1 || episode > 999) continue
    return { season, episode, via: p.name }
  }
  return null
}

const VIDEO = /\.(mkv|mp4|avi|m4v|ts)$/i

/** Group a Sonarr queue into one entry per download rather than per episode. */
function byDownload(queue: any[]): Map<string, any[]> {
  const out = new Map<string, any[]>()
  for (const i of queue) {
    const k = i.downloadId || String(i.id)
    if (!out.has(k)) out.set(k, [])
    out.get(k)!.push(i)
  }
  return out
}

/**
 * Work out what could be filed, without filing it.
 *
 * Shared by the scan and the run so the count a person is shown is produced by
 * the same code that later acts — a preview that is computed differently from
 * the action it previews is a preview of nothing.
 */
async function planRescue(ctx: PluginContext, seriesId: number, folder: string) {
  const [files, eps] = await Promise.all([
    ctx.get(`/api/v3/manualimport?folder=${encodeURIComponent(folder)}&filterExistingFiles=false`,
            { timeoutMs: 60_000 }).catch(() => [] as any[]),
    ctx.get(`/api/v3/episode?seriesId=${seriesId}`, { timeoutMs: 30_000 }).catch(() => [] as any[]),
  ])

  const known = new Map<string, any>()
  for (const e of (Array.isArray(eps) ? eps : [])) known.set(`${e.seasonNumber}x${e.episodeNumber}`, e)

  const claimed = new Map<string, string>()   // episode key -> first filename
  const mapped: any[] = []
  const unmapped: string[] = []

  for (const f of (Array.isArray(files) ? files : [])) {
    const name = String(f.name || '')
    if (!VIDEO.test(String(f.path || name))) continue

    const read = readEpisode(name)
    if (!read) { unmapped.push(`${name} — no season/episode in the name`); continue }

    const key = `${read.season}x${read.episode}`
    const ep = known.get(key)
    if (!ep) { unmapped.push(`${name} — S${read.season}E${read.episode} is not in this series`); continue }
    if (claimed.has(key)) {
      unmapped.push(`${name} — S${read.season}E${read.episode} already claimed by ${claimed.get(key)}`)
      continue
    }
    claimed.set(key, name)

    mapped.push({
      path: f.path, seriesId, episodeIds: [ep.id],
      quality: f.quality, languages: f.languages,
      releaseGroup: f.releaseGroup || '', indexerFlags: 0, releaseType: 'singleEpisode',
    })
  }

  return { mapped, unmapped, total: mapped.length + unmapped.length }
}

export const arrstackPlugin: Plugin = {
  manifest: {
    id:   'arrstack',
    name: 'Arr Stack',
    description: 'The whole pipeline — Sonarr, Radarr, Prowlarr and qBittorrent — as one view, with search across every indexer.',
    kind: 'device',
    icon: '📺',
    baseUrlSetting: 'sonarr_url',
    auth: { kind: 'header', header: 'X-Api-Key', fromSetting: 'sonarr_key' },
    endpoints: [
      { key: 'radarr',   label: 'Radarr',   baseUrlSetting: 'radarr_url',
        auth: { kind: 'header', header: 'X-Api-Key', fromSetting: 'radarr_key' } },
      { key: 'prowlarr', label: 'Prowlarr', baseUrlSetting: 'prowlarr_url',
        auth: { kind: 'header', header: 'X-Api-Key', fromSetting: 'prowlarr_key' } },
      // qBittorrent's WebUI is normally set to skip auth for the local subnet.
      { key: 'qbit',     label: 'qBittorrent', baseUrlSetting: 'qbit_url', auth: { kind: 'none' } },
    ],
    settings: [
      { key: 'sonarr_url',   label: 'Sonarr address',   type: 'url',    required: true,  hint: 'http://192.168.1.30:8989' },
      { key: 'sonarr_key',   label: 'Sonarr API key',   type: 'secret', required: true,  hint: 'Settings → General → API Key.' },
      { key: 'radarr_url',   label: 'Radarr address',   type: 'url',    required: false, hint: 'Leave blank if you do not run Radarr.' },
      { key: 'radarr_key',   label: 'Radarr API key',   type: 'secret', required: false },
      { key: 'prowlarr_url', label: 'Prowlarr address', type: 'url',    required: false, hint: 'Enables Search across every indexer.' },
      { key: 'prowlarr_key', label: 'Prowlarr API key', type: 'secret', required: false },
      { key: 'qbit_url',     label: 'qBittorrent WebUI', type: 'url',   required: false,
        hint: 'http://192.168.1.30:8080 — needs "Bypass authentication for clients on localhost/subnet".' },
    ],
  },

  async load(ctx: PluginContext): Promise<PluginTileData> {
    const { arrs, indexers, transfer, torrents } = await readAll(ctx)
    const queued  = arrs.reduce((t, a) => t + a.total, 0)
    const blocked = arrs.reduce((t, a) => t + importBlocked(a.queue).length, 0)
    const stalled = arrs.reduce((t, a) => t + downloadStalled(a.queue).length, 0)
    const down    = arrs.filter(a => a.error)

    const rows: Array<{ label: string; value: string; tone?: Tone }> = []
    if (blocked) rows.push({ label: 'Needs you', value: `${blocked} blocked import${blocked === 1 ? '' : 's'}`, tone: 'bad' })
    if (stalled) rows.push({ label: 'Stalled',   value: `${stalled} download${stalled === 1 ? '' : 's'}`, tone: 'warn' })

    if (transfer) {
      rows.push({ label: 'Transfer', value: `↓ ${rate(transfer.dl_info_speed)} · ↑ ${rate(transfer.up_info_speed)}` })
    }
    if (torrents) {
      const moving = torrents.filter((t: any) => (t.dlspeed ?? 0) > 0 || (t.upspeed ?? 0) > 0).length
      const downloading = torrents.filter((t: any) => Number(t.progress ?? 1) < 1).length
      rows.push({
        label: 'Torrents',
        value: `${downloading} downloading · ${moving} moving of ${torrents.length}`,
      })
      // The one currently pulling hardest, named — "12 active" says nothing
      // about whether the thing you are waiting for is one of them.
      const top = [...torrents].sort((a: any, b: any) => Number(b.dlspeed ?? 0) - Number(a.dlspeed ?? 0))[0]
      if (top && Number(top.dlspeed ?? 0) > 0) {
        rows.push({
          label: 'Fastest',
          value: `${String(top.name).slice(0, 34)} · ${rate(top.dlspeed)} · ${(Number(top.progress) * 100).toFixed(0)}%`,
        })
      }
    }
    if (indexers) {
      const on = indexers.filter((i: any) => i.enable).length
      const off = indexers.length - on
      rows.push({ label: 'Indexers', value: off ? `${on} on · ${off} off` : `${on} searching`,
                  tone: on ? (off ? 'warn' : 'good') : 'bad' })
    }
    for (const a of arrs) {
      if (a.error) rows.push({ label: a.label, value: 'unreachable', tone: 'bad' })
    }

    return {
      headline: down.length === arrs.length && arrs.length
        ? 'Not reachable'
        : `${queued} in queue`,
      tone: down.length || blocked ? 'bad' : stalled ? 'warn' : 'good',
      rows,
    }
  },

  async detail(ctx: PluginContext): Promise<PluginDetail> {
    const { arrs, indexers, transfer, torrents } = await readAll(ctx)
    const pct = (i: any) => {
      const total = Number(i.size ?? 0), left = Number(i.sizeleft ?? 0)
      return total ? `${(((total - left) / total) * 100).toFixed(0)}%` : '—'
    }
    const tor = torrents ?? []
    const now = Date.now() / 1000

    return {
      stats: [
        { label: 'In queue', value: String(arrs.reduce((t, a) => t + a.total, 0)) },
        { label: 'Blocked imports', value: String(arrs.reduce((t, a) => t + importBlocked(a.queue).length, 0)),
          tone: arrs.some(a => importBlocked(a.queue).length) ? 'bad' : 'good' },
        { label: 'Stalled', value: String(arrs.reduce((t, a) => t + downloadStalled(a.queue).length, 0)),
          tone: arrs.some(a => downloadStalled(a.queue).length) ? 'warn' : 'good' },
        ...(transfer ? [
          { label: 'Download', value: rate(transfer.dl_info_speed) },
          { label: 'Upload',   value: rate(transfer.up_info_speed) },
        ] : []),
        ...(indexers ? [{ label: 'Indexers', value: `${indexers.filter((i: any) => i.enable).length} of ${indexers.length}`,
          tone: (indexers.some((i: any) => !i.enable) ? 'warn' : 'good') as Tone }] : []),
      ],
      tables: [
        {
          title: 'Needs you — imports that will not resolve themselves',
          empty: 'No blocked imports.',
          columns: [
            { key: 'service', label: 'Service' }, { key: 'title', label: 'Title' },
            { key: 'state', label: 'State' }, { key: 'message', label: 'Why' },
          ],
          rows: arrs.flatMap(a => importBlocked(a.queue).map(i => ({
            service: a.label, title: titleOf(i),
            state: i.trackedDownloadState || i.status || '—',
            message: (i.statusMessages?.[0]?.messages?.[0]) || i.errorMessage || '—',
          }))),
        },
        {
          title: 'Queue',
          empty: 'Both queues are empty.',
          total: arrs.reduce((t, a) => t + a.total, 0),
          columns: [
            { key: 'service', label: 'Service' }, { key: 'title', label: 'Title' },
            { key: 'kind', label: 'Kind' },
            { key: 'progress', label: 'Done', align: 'right' }, { key: 'status', label: 'Status' },
          ],
          rows: arrs.flatMap(a => a.queue.slice(0, 150).map(i => ({
            service: a.label, title: titleOf(i),
            // Which of these is a pack is the whole point of the queue for this
            // library, so it is a column rather than something to squint at.
            kind: EPISODE.test(titleOf(i)) ? 'episode' : 'pack',
            progress: pct(i), status: i.status ?? '—',
          }))),
        },
        {
          title: 'Active downloads',
          empty: 'Nothing is transferring.',
          total: tor.length,
          columns: [
            { key: 'name',     label: 'Torrent' },
            { key: 'state',    label: 'State' },
            { key: 'progress', label: 'Done',     align: 'right' },
            { key: 'size',     label: 'Size',     align: 'right' },
            { key: 'dl',       label: 'Down',     align: 'right' },
            { key: 'up',       label: 'Up',       align: 'right' },
            { key: 'eta',      label: 'ETA',      align: 'right' },
            { key: 'category', label: 'Category' },
          ],
          rows: tor
            .filter((t: any) => ACTIVE_STATES.has(t.state))
            .sort((a: any, b: any) => Number(b.dlspeed ?? 0) - Number(a.dlspeed ?? 0))
            .slice(0, 60)
            .map((t: any) => ({
              name: t.name,
              state: t.state,
              progress: `${(Number(t.progress ?? 0) * 100).toFixed(1)}%`,
              size: gb(t.size),
              dl: rate(t.dlspeed),
              up: rate(t.upspeed),
              eta: etaOf(t.eta),
              // A manual grab from Search lands under `prowlarr`, so the category
              // is how you tell it apart from anything the *arr apps asked for.
              category: t.category || '—',
            })),
        },
        {
          title: 'Torrents by state',
          empty: 'No torrents.',
          columns: [
            { key: 'state', label: 'State' },
            { key: 'count', label: 'Torrents', align: 'right' },
            { key: 'size',  label: 'Size',     align: 'right' },
          ],
          rows: (() => {
            const by = new Map<string, { count: number; size: number }>()
            for (const t of tor) {
              const e = by.get(t.state) ?? { count: 0, size: 0 }
              e.count += 1; e.size += Number(t.size ?? 0)
              by.set(t.state, e)
            }
            return [...by.entries()]
              .sort((a, b) => b[1].count - a[1].count)
              .map(([state, v]) => ({ state, count: v.count, size: gb(v.size) }))
          })(),
        },
        {
          title: 'No progress in over an hour',
          empty: 'Everything active is moving.',
          columns: [
            { key: 'name', label: 'Torrent' }, { key: 'state', label: 'State' },
            { key: 'progress', label: 'Done', align: 'right' }, { key: 'peers', label: 'Peers', align: 'right' },
          ],
          rows: tor
            .filter((t: any) => t.progress < 1 && now - Number(t.last_activity ?? now) > 3600)
            .sort((a: any, b: any) => Number(a.last_activity) - Number(b.last_activity))
            .slice(0, 25)
            .map((t: any) => ({
              name: t.name, state: t.state,
              progress: `${(Number(t.progress) * 100).toFixed(1)}%`,
              peers: `${t.num_leechs ?? 0}/${t.num_seeds ?? 0}`,
            })),
        },
        {
          title: 'Indexers',
          empty: 'Prowlarr is not configured.',
          columns: [
            { key: 'name', label: 'Name' }, { key: 'state', label: 'State' },
            { key: 'privacy', label: 'Privacy' },
          ],
          rows: (indexers ?? [])
            .sort((a: any, b: any) => Number(b.enable) - Number(a.enable) || a.name.localeCompare(b.name))
            .map((i: any) => ({ name: i.name, state: i.enable ? 'enabled' : 'disabled', privacy: i.privacy ?? '—' })),
        },
        {
          title: 'Health',
          empty: 'No health warnings.',
          columns: [
            { key: 'service', label: 'Service' }, { key: 'type', label: 'Type' }, { key: 'message', label: 'Message' },
          ],
          rows: arrs.flatMap(a => a.health.map(h => ({
            service: a.label, type: h.type ?? '—', message: h.message ?? '—',
          }))),
        },
      ],
    }
  },

  /**
   * Find complete downloads the library will not file.
   *
   * Scoped to Sonarr: Radarr's equivalent failure is a different shape (a movie
   * folder, not an episode map) and pretending one function covers both would
   * produce a button that silently does nothing half the time.
   */
  async rescueScan(ctx: PluginContext): Promise<PluginStuckImport[]> {
    const queue = await ctx.get('/api/v3/queue?pageSize=200&includeUnknownSeriesItems=true&includeSeries=true',
                                { timeoutMs: 30_000 }).catch(() => null) as any
    const items = importBlocked(queue?.records ?? [])
    const out: PluginStuckImport[] = []

    for (const [downloadId, group] of byDownload(items)) {
      const first = group[0]
      const folder = first.outputPath
      const seriesId = first.seriesId
      if (!folder || !seriesId) continue

      const plan = await planRescue(ctx, seriesId, folder).catch(() => null)
      if (!plan || !plan.total) continue

      const reasons = [...new Set(group.flatMap((g: any) =>
        (g.statusMessages ?? []).flatMap((m: any) => m.messages ?? [])))] as string[]

      out.push({
        id: downloadId,
        title: String(first.title ?? '').slice(0, 160),
        series: String(first.series?.title ?? 'unknown'),
        path: folder,
        reason: reasons[0] ? String(reasons[0]).slice(0, 140) : 'import blocked',
        files: plan.total,
        mappable: plan.mapped.length,
        unmappable: plan.unmapped.slice(0, 10),
      })
    }
    return out
  },

  async rescueRun(ctx: PluginContext, id: string): Promise<string> {
    const queue = await ctx.get('/api/v3/queue?pageSize=200&includeUnknownSeriesItems=true&includeSeries=true',
                                { timeoutMs: 30_000 }) as any
    const group = importBlocked(queue?.records ?? []).filter((i: any) => (i.downloadId || String(i.id)) === id)
    if (!group.length) throw new Error('That download is no longer blocked — it may have resolved on its own.')

    const { outputPath: folder, seriesId } = group[0]
    if (!folder || !seriesId) throw new Error('This download has no folder or series recorded, so nothing can be mapped.')

    const plan = await planRescue(ctx, seriesId, folder)
    if (!plan.mapped.length) {
      throw new Error(`Nothing could be mapped from ${plan.total} file(s). The names carry no season and episode this understands.`)
    }

    await ctx.post('/api/v3/command',
      { name: 'ManualImport', importMode: 'copy', files: plan.mapped },
      { timeoutMs: 60_000 })

    // Deliberately reports the shortfall rather than only the success. A rescue
    // that files most of a season looks identical to a complete one unless it
    // says otherwise.
    const short = plan.unmapped.length
      ? ` ${plan.unmapped.length} file(s) were left alone because their names could not be read.`
      : ''
    return `Importing ${plan.mapped.length} of ${plan.total} file(s) by filename.${short}`
  },

  async search(ctx: PluginContext, query: string): Promise<PluginSearchResult[]> {
    if (!ctx.has('prowlarr')) throw new Error('Search needs a Prowlarr address and API key.')
    const q = encodeURIComponent(query.trim())
    if (!q) return []
    // Fans out to every indexer, some behind FlareSolverr, so this is slow by
    // nature — a tile-length timeout kills it.
    const res = await ctx.from('prowlarr')
      .get(`/api/v1/search?query=${q}&type=search&limit=200`, { timeoutMs: 180_000 })
    return (Array.isArray(res) ? res : []).map((r: any) => ({
      title: r.title ?? '—', indexer: r.indexer ?? '—',
      size: Number(r.size ?? 0), seeders: Number(r.seeders ?? 0),
      leechers: Number(r.leechers ?? 0), published: r.publishDate ?? '',
      categories: (r.categories ?? []).map((c: any) => c?.name).filter(Boolean),
      guid: r.guid ?? '', indexerId: Number(r.indexerId ?? 0),
    }))
  },

  async grab(ctx: PluginContext, guid: string, indexerId: number): Promise<string> {
    if (!ctx.has('prowlarr')) throw new Error('Sending a download needs Prowlarr configured.')
    await ctx.from('prowlarr').post('/api/v1/search', { guid, indexerId }, { timeoutMs: 60_000 })
    return 'Sent to the download client'
  },

  async metrics(ctx: PluginContext): Promise<PluginMetric[]> {
    const { arrs, indexers, transfer, torrents } = await readAll(ctx)
    const out: PluginMetric[] = []
    for (const a of arrs) {
      const labels = { service: a.label.toLowerCase() }
      out.push({ name: 'arr_queue', help: 'Items in the download queue.', type: 'gauge', value: a.total, labels })
      out.push({ name: 'arr_import_blocked', help: 'Queue items needing a person.', type: 'gauge',
                 value: importBlocked(a.queue).length, labels })
      out.push({ name: 'arr_download_stalled', help: 'Downloads flagged as stalled.', type: 'gauge',
                 value: downloadStalled(a.queue).length, labels })
      out.push({ name: 'arr_up', help: 'Whether the service answered.', type: 'gauge',
                 value: a.error ? 0 : 1, labels })
    }
    if (transfer) {
      out.push({ name: 'torrent_bytes_per_second', help: 'qBittorrent transfer rate.', type: 'gauge',
                 value: Number(transfer.dl_info_speed ?? 0), labels: { direction: 'down' } })
      out.push({ name: 'torrent_bytes_per_second', help: 'qBittorrent transfer rate.', type: 'gauge',
                 value: Number(transfer.up_info_speed ?? 0), labels: { direction: 'up' } })
    }
    if (torrents) {
      out.push({ name: 'torrents', help: 'Torrents by state.', type: 'gauge',
                 value: torrents.length, labels: { state: 'all' } })
      out.push({ name: 'torrents', help: 'Torrents by state.', type: 'gauge',
                 value: torrents.filter((t: any) => t.state === 'stalledDL').length, labels: { state: 'stalled' } })
    }
    if (indexers) {
      out.push({ name: 'indexers', help: 'Indexers configured in Prowlarr.', type: 'gauge',
                 value: indexers.filter((i: any) => i.enable).length, labels: { state: 'enabled' } })
      out.push({ name: 'indexers', help: 'Indexers configured in Prowlarr.', type: 'gauge',
                 value: indexers.filter((i: any) => !i.enable).length, labels: { state: 'disabled' } })
    }
    return out
  },
}
