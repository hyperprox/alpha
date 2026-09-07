// =============================================================================
//  Plug-in — qBittorrent
//
//  Read-only. The API can pause, delete and reprioritise; none of that belongs
//  behind a dashboard tile that someone might click while scanning.
// =============================================================================

import type { Plugin, PluginContext, PluginTileData, PluginDetail, PluginMetric } from '../lib/plugin-host'

type Row = { label: string; value: string; tone?: 'good' | 'warn' | 'bad' }

function rate(bytesPerSecond: number): string {
  const v = Number(bytesPerSecond ?? 0)
  if (v < 1024) return `${v} B/s`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)} KB/s`
  return `${(v / 1024 / 1024).toFixed(1)} MB/s`
}

function size(bytes: number): string {
  const v = Number(bytes ?? 0)
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  if (!v) return '0'
  const i = Math.min(Math.floor(Math.log(v) / Math.log(1024)), u.length - 1)
  return `${(v / Math.pow(1024, i)).toFixed(1)} ${u[i]}`
}

const ACTIVE = new Set(['downloading', 'forcedDL', 'metaDL', 'stalledDL', 'uploading', 'forcedUP'])

export const qbittorrentPlugin: Plugin = {
  manifest: {
    id:   'qbittorrent',
    name: 'qBittorrent',
    description: 'Transfer rates, what is downloading, and which torrents have stopped making progress.',
    kind: 'device',
    icon: '⬇️',
    baseUrlSetting: 'url',
    // qBittorrent authenticates by cookie login. Where the WebUI is set to skip
    // authentication for the local subnet — common on a LAN — no credential is
    // needed and none is asked for.
    auth: { kind: 'none' },
    settings: [
      { key: 'url', label: 'WebUI address', type: 'url', required: true,
        hint: 'http://192.168.1.30:8080 — requires "Bypass authentication for clients on localhost/subnet", or a reverse proxy that adds it.' },
    ],
  },

  async load(ctx: PluginContext): Promise<PluginTileData> {
    const [info, torrents] = await Promise.all([
      ctx.get('/api/v2/transfer/info'),
      ctx.get('/api/v2/torrents/info').catch(() => [] as any[]),
    ])

    const list: any[] = Array.isArray(torrents) ? torrents : []
    const active   = list.filter(t => ACTIVE.has(t.state))
    const stalled  = list.filter(t => t.state === 'stalledDL')
    const errored  = list.filter(t => t.state === 'error' || t.state === 'missingFiles')

    const rows: Row[] = [
      { label: 'Down', value: rate(info?.dl_info_speed), tone: 'good' },
      { label: 'Up',   value: rate(info?.up_info_speed) },
      { label: 'Active', value: `${active.length} of ${list.length}` },
    ]
    if (stalled.length) rows.push({ label: 'Stalled', value: String(stalled.length), tone: 'warn' })
    if (errored.length) rows.push({ label: 'Errored', value: String(errored.length), tone: 'bad' })

    return {
      headline: `↓ ${rate(info?.dl_info_speed)} · ${active.length} active`,
      tone: errored.length ? 'bad' : stalled.length ? 'warn' : 'good',
      rows,
    }
  },

  async detail(ctx: PluginContext): Promise<PluginDetail> {
    const [info, torrents] = await Promise.all([
      ctx.get('/api/v2/transfer/info'),
      ctx.get('/api/v2/torrents/info').catch(() => [] as any[]),
    ])
    const list: any[] = Array.isArray(torrents) ? torrents : []

    const when = (unix: any) => {
      const n = Number(unix)
      return n > 0 ? new Date(n * 1000).toLocaleString() : '—'
    }
    const eta = (secs: any) => {
      const n = Number(secs)
      if (!n || n >= 8640000) return '—'
      if (n < 3600) return `${Math.round(n / 60)}m`
      return `${(n / 3600).toFixed(1)}h`
    }

    const byState = new Map<string, number>()
    for (const t of list) byState.set(t.state, (byState.get(t.state) ?? 0) + 1)

    // A torrent connected to peers but moving nothing is the case a naive
    // "0 seeds and 0 peers" check misses entirely, so surface it by last
    // activity rather than by peer count.
    const now = Date.now() / 1000
    const noProgress = list
      .filter(t => ACTIVE.has(t.state) && t.progress < 1 && now - Number(t.last_activity ?? now) > 3600)
      .sort((a, b) => Number(a.last_activity) - Number(b.last_activity))

    return {
      stats: [
        { label: 'Download',  value: rate(info?.dl_info_speed) },
        { label: 'Upload',    value: rate(info?.up_info_speed) },
        { label: 'Torrents',  value: String(list.length) },
        { label: 'Active',    value: String(list.filter(t => ACTIVE.has(t.state)).length) },
        { label: 'Session down', value: size(info?.dl_info_data) },
        { label: 'Connection',   value: String(info?.connection_status ?? '—'),
          tone: info?.connection_status === 'connected' ? 'good' : 'bad' },
      ],
      tables: [
        {
          title: 'No progress in over an hour',
          empty: 'Everything active is moving.',
          columns: [
            { key: 'name',     label: 'Torrent' },
            { key: 'state',    label: 'State' },
            { key: 'progress', label: 'Done', align: 'right' },
            { key: 'peers',    label: 'Peers', align: 'right' },
            { key: 'last',     label: 'Last activity' },
          ],
          rows: noProgress.slice(0, 25).map(t => ({
            name: t.name, state: t.state,
            progress: `${(Number(t.progress) * 100).toFixed(1)}%`,
            peers: `${t.num_leechs ?? 0}/${t.num_seeds ?? 0}`,
            last: when(t.last_activity),
          })),
        },
        {
          title: 'Active transfers',
          empty: 'Nothing is transferring.',
          columns: [
            { key: 'name',     label: 'Torrent' },
            { key: 'state',    label: 'State' },
            { key: 'progress', label: 'Done',  align: 'right' },
            { key: 'dl',       label: 'Down',  align: 'right' },
            { key: 'up',       label: 'Up',    align: 'right' },
            { key: 'eta',      label: 'ETA',   align: 'right' },
            { key: 'category', label: 'Category' },
          ],
          rows: list.filter(t => ACTIVE.has(t.state))
            .sort((a, b) => Number(b.dlspeed) - Number(a.dlspeed))
            .slice(0, 40)
            .map(t => ({
              name: t.name, state: t.state,
              progress: `${(Number(t.progress) * 100).toFixed(1)}%`,
              dl: rate(t.dlspeed), up: rate(t.upspeed),
              eta: eta(t.eta), category: t.category || '—',
            })),
        },
        {
          title: 'Everything, by state',
          empty: 'No torrents.',
          columns: [
            { key: 'state', label: 'State' },
            { key: 'count', label: 'Torrents', align: 'right' },
          ],
          rows: [...byState.entries()].sort((a, b) => b[1] - a[1]).map(([state, count]) => ({ state, count })),
        },
      ],
    }
  },

  async metrics(ctx: PluginContext): Promise<PluginMetric[]> {
    const [info, torrents] = await Promise.all([
      ctx.get('/api/v2/transfer/info'),
      ctx.get('/api/v2/torrents/info').catch(() => [] as any[]),
    ])
    const list: any[] = Array.isArray(torrents) ? torrents : []
    const count = (fn: (t: any) => boolean) => list.filter(fn).length

    return [
      { name: 'torrent_bytes_per_second', help: 'qBittorrent transfer rate.', type: 'gauge',
        value: Number(info?.dl_info_speed ?? 0), labels: { direction: 'down' } },
      { name: 'torrent_bytes_per_second', help: 'qBittorrent transfer rate.', type: 'gauge',
        value: Number(info?.up_info_speed ?? 0), labels: { direction: 'up' } },
      { name: 'torrents', help: 'Torrents by state.', type: 'gauge',
        value: list.length, labels: { state: 'all' } },
      { name: 'torrents', help: 'Torrents by state.', type: 'gauge',
        value: count(t => ACTIVE.has(t.state)), labels: { state: 'active' } },
      { name: 'torrents', help: 'Torrents by state.', type: 'gauge',
        value: count(t => t.state === 'stalledDL'), labels: { state: 'stalled' } },
      { name: 'torrents', help: 'Torrents by state.', type: 'gauge',
        value: count(t => t.state === 'error' || t.state === 'missingFiles'), labels: { state: 'error' } },
    ]
  },
}
