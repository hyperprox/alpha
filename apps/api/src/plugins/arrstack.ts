// =============================================================================
//  Plug-in — Sonarr and Radarr
//
//  Two services with two API keys, declared as two endpoints so each key is
//  bound to the box it belongs to. Either can be left blank; whichever is
//  configured is what gets reported.
//
//  Read-only. Nothing here searches, grabs or deletes.
// =============================================================================

import type { Plugin, PluginContext, PluginTileData, PluginDetail, PluginMetric } from '../lib/plugin-host'

interface ArrState {
  key: 'default' | 'radarr'
  label: string
  queue: any[]
  queueTotal: number
  health: any[]
  error?: string
}

const KIND = { default: 'sonarr', radarr: 'radarr' } as const

async function readArr(ctx: PluginContext, key: 'default' | 'radarr', label: string): Promise<ArrState | null> {
  if (key !== 'default' && !ctx.has(key)) return null
  const c = key === 'default' ? ctx : ctx.from(key)
  try {
    const [queue, health] = await Promise.all([
      c.get('/api/v3/queue?pageSize=200&includeUnknownSeriesItems=true&includeUnknownMovieItems=true'),
      c.get('/api/v3/health').catch(() => []),
    ])
    return {
      key, label,
      queue: queue?.records ?? [],
      queueTotal: Number(queue?.totalRecords ?? (queue?.records?.length ?? 0)),
      health: Array.isArray(health) ? health : [],
    }
  } catch (e: any) {
    return { key, label, queue: [], queueTotal: 0, health: [], error: e.message }
  }
}

async function readAll(ctx: PluginContext): Promise<ArrState[]> {
  const out = await Promise.all([
    readArr(ctx, 'default', 'Sonarr'),
    readArr(ctx, 'radarr',  'Radarr'),
  ])
  return out.filter((x): x is ArrState => x !== null)
}

/**
 * Two different problems, deliberately not one number.
 *
 * A blocked import needs a person — a title mismatch or a failed import sits in
 * the queue indefinitely and nothing escalates it. A stalled download does not:
 * the *arr flags it the moment a torrent loses its peers, and any half-decent
 * setup already has something removing dead downloads on a threshold. Counting
 * them together produced "8 stuck on import" when seven were stalled torrents
 * being handled automatically and one was a real import block.
 */
function importBlocked(items: any[]): any[] {
  return items.filter(i =>
    i.trackedDownloadState === 'importBlocked' ||
    i.trackedDownloadState === 'importFailed' ||
    i.trackedDownloadStatus === 'error' ||
    (i.trackedDownloadState && String(i.trackedDownloadState).startsWith('importPending')))
}

function downloadStalled(items: any[]): any[] {
  return items.filter(i =>
    !importBlocked([i]).length &&
    (i.trackedDownloadStatus === 'warning' || i.status === 'warning'))
}

function title(i: any): string {
  return i.title || i.series?.title || i.movie?.title || 'unknown'
}

export const arrstackPlugin: Plugin = {
  manifest: {
    id:   'arrstack',
    name: 'Sonarr & Radarr',
    description: 'Download queues, imports that need attention, and health warnings from both.',
    kind: 'device',
    icon: '📺',
    baseUrlSetting: 'sonarr_url',
    auth: { kind: 'header', header: 'X-Api-Key', fromSetting: 'sonarr_key' },
    endpoints: [
      { key: 'radarr', label: 'Radarr', baseUrlSetting: 'radarr_url',
        auth: { kind: 'header', header: 'X-Api-Key', fromSetting: 'radarr_key' } },
    ],
    settings: [
      { key: 'sonarr_url', label: 'Sonarr address', type: 'url',    required: true,
        hint: 'http://192.168.1.30:8989' },
      { key: 'sonarr_key', label: 'Sonarr API key', type: 'secret', required: true,
        hint: 'Settings → General → API Key.' },
      { key: 'radarr_url', label: 'Radarr address', type: 'url',    required: false,
        hint: 'http://192.168.1.30:7878 — leave blank if you do not run Radarr.' },
      { key: 'radarr_key', label: 'Radarr API key', type: 'secret', required: false },
    ],
  },

  async load(ctx: PluginContext): Promise<PluginTileData> {
    const arrs = await readAll(ctx)
    const queued  = arrs.reduce((t, a) => t + a.queueTotal, 0)
    const blocked = arrs.reduce((t, a) => t + importBlocked(a.queue).length, 0)
    const stalled = arrs.reduce((t, a) => t + downloadStalled(a.queue).length, 0)
    const issues  = arrs.reduce((t, a) => t + a.health.filter(h => h.type === 'error' || h.type === 'warning').length, 0)
    const down    = arrs.filter(a => a.error)

    const rows = arrs.map(a => ({
      label: a.label,
      value: a.error ? 'unreachable' : `${a.queueTotal} queued · ${a.health.length} health`,
      tone: (a.error ? 'bad' : importBlocked(a.queue).length ? 'warn' : 'good') as 'good' | 'warn' | 'bad',
    }))

    // Stalled downloads are reported, never as "needs attention" — something is
    // usually already clearing them, and a warning nobody should act on is how
    // people learn to ignore the panel.
    if (stalled) {
      rows.unshift({ label: 'Stalled', value: `${stalled} download${stalled === 1 ? '' : 's'}`, tone: 'warn' })
    }
    if (blocked) {
      rows.unshift({ label: 'Needs you', value: `${blocked} blocked import${blocked === 1 ? '' : 's'}`, tone: 'bad' })
    }

    return {
      headline: down.length === arrs.length ? 'Not reachable' : `${queued} in queue`,
      tone: down.length || blocked ? 'bad' : stalled || issues ? 'warn' : 'good',
      rows,
    }
  },

  async detail(ctx: PluginContext): Promise<PluginDetail> {
    const arrs = await readAll(ctx)
    const pct = (i: any) => {
      const total = Number(i.size ?? 0)
      const left  = Number(i.sizeleft ?? 0)
      return total ? `${(((total - left) / total) * 100).toFixed(0)}%` : '—'
    }

    return {
      stats: [
        { label: 'In queue', value: String(arrs.reduce((t, a) => t + a.queueTotal, 0)) },
        { label: 'Blocked imports', value: String(arrs.reduce((t, a) => t + importBlocked(a.queue).length, 0)),
          tone: arrs.some(a => importBlocked(a.queue).length) ? 'bad' : 'good' },
        { label: 'Stalled', value: String(arrs.reduce((t, a) => t + downloadStalled(a.queue).length, 0)),
          tone: arrs.some(a => downloadStalled(a.queue).length) ? 'warn' : 'good' },
        { label: 'Health',   value: String(arrs.reduce((t, a) => t + a.health.length, 0)),
          tone: arrs.some(a => a.health.some(h => h.type === 'error')) ? 'bad' : 'good' },
        { label: 'Services', value: `${arrs.filter(a => !a.error).length} of ${arrs.length}` },
      ],
      tables: [
        {
          title: 'Needs you — imports that will not resolve themselves',
          empty: 'No blocked imports.',
          columns: [
            { key: 'service', label: 'Service' },
            { key: 'title',   label: 'Title' },
            { key: 'state',   label: 'State' },
            { key: 'message', label: 'Why' },
          ],
          rows: arrs.flatMap(a => importBlocked(a.queue).map(i => ({
            service: a.label,
            title:   title(i),
            state:   i.trackedDownloadState || i.status || '—',
            message: (i.statusMessages?.[0]?.messages?.[0]) || i.errorMessage || '—',
          }))),
        },
        {
          title: 'Stalled downloads — usually cleared automatically',
          empty: 'Nothing stalled.',
          columns: [
            { key: 'service', label: 'Service' },
            { key: 'title',   label: 'Title' },
            { key: 'message', label: 'Why' },
          ],
          rows: arrs.flatMap(a => downloadStalled(a.queue).map(i => ({
            service: a.label,
            title:   title(i),
            message: (i.statusMessages?.[0]?.messages?.[0]) || i.errorMessage || '—',
          }))),
        },
        {
          title: 'Queue',
          empty: 'Both queues are empty.',
          // The stat tile counts every queued item; this table holds what the
          // API returned on one page. Say so rather than let the two disagree.
          total: arrs.reduce((t, a) => t + a.queueTotal, 0),
          columns: [
            { key: 'service',  label: 'Service' },
            { key: 'title',    label: 'Title' },
            { key: 'progress', label: 'Done',   align: 'right' },
            { key: 'status',   label: 'Status' },
            { key: 'client',   label: 'Client' },
          ],
          rows: arrs.flatMap(a => a.queue.slice(0, 150).map(i => ({
            service: a.label, title: title(i), progress: pct(i),
            status: i.status ?? '—', client: i.downloadClient ?? '—',
          }))),
        },
        {
          title: 'Health',
          empty: 'No health warnings.',
          columns: [
            { key: 'service', label: 'Service' },
            { key: 'type',    label: 'Type' },
            { key: 'message', label: 'Message' },
          ],
          rows: arrs.flatMap(a => a.health.map(h => ({
            service: a.label, type: h.type ?? '—', message: h.message ?? '—',
          }))),
        },
      ],
    }
  },

  async metrics(ctx: PluginContext): Promise<PluginMetric[]> {
    const arrs = await readAll(ctx)
    return arrs.flatMap(a => {
      const labels = { service: KIND[a.key] }
      return [
        { name: 'arr_queue', help: 'Items in the download queue.', type: 'gauge' as const,
          value: a.queueTotal, labels },
        { name: 'arr_import_blocked', help: 'Queue items needing a person.', type: 'gauge' as const,
          value: importBlocked(a.queue).length, labels },
        { name: 'arr_download_stalled', help: 'Downloads the *arr has flagged as stalled.', type: 'gauge' as const,
          value: downloadStalled(a.queue).length, labels },
        { name: 'arr_health_issues', help: 'Health check warnings and errors.', type: 'gauge' as const,
          value: a.health.length, labels },
        { name: 'arr_up', help: 'Whether the service answered.', type: 'gauge' as const,
          value: a.error ? 0 : 1, labels },
      ]
    })
  },
}
