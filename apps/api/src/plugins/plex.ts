// =============================================================================
//  Plug-in — Plex activity, via Tautulli
//
//  Tautulli rather than Plex's own /status/sessions: it already resolves the
//  things worth seeing at a glance — whether a stream is transcoding or direct,
//  how far through it is, and what it is costing in bandwidth — where the raw
//  Plex endpoint makes you infer all three.
// =============================================================================

import type { Plugin, PluginContext, PluginTileData, PluginDetail, PluginMetric } from '../lib/plugin-host'
import type { PlexVisual } from '../lib/plugin-visual-types'

function mbps(kbps: number): string {
  if (!kbps) return '0 Mbps'
  return (kbps / 1000).toFixed(1) + ' Mbps'
}

function hours(seconds: number): string {
  if (!seconds) return '0h'
  const h = seconds / 3600
  return h < 1 ? `${Math.round(seconds / 60)}m` : `${h.toFixed(1)}h`
}

/** Tautulli's `after` filter wants YYYY-MM-DD. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10)
}

const n0 = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : 0
}
const str = (v: unknown, fallback = '—', max = 160): string =>
  (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : fallback).slice(0, max)

/**
 * The Plex page's numbers, from Tautulli's own answers: get_activity's data, get_history's rows and
 * get_home_stats' blocks. Pure, so it is tested without a Tautulli.
 */
export function buildPlexVisual(activity: any, history: unknown, home: unknown): PlexVisual {
  const a = activity ?? {}
  const sessions: any[] = Array.isArray(a.sessions) ? a.sessions : []
  const stats: any[] = Array.isArray(home) ? home : []
  const rowsOf = (id: string): any[] => stats.find(x => x?.stat_id === id)?.rows ?? []
  const episode = (s: any) => s.media_type === 'episode'
  return {
    kind: 'plex',
    sessions: sessions.slice(0, 12).map(s => ({
      title:     str(episode(s) ? (s.grandparent_title || s.full_title) : (s.title || s.full_title), 'Something'),
      episode:   episode(s) && s.title ? str(s.title) : null,
      number:    episode(s) && n0(s.media_index) ? `S${n0(s.parent_media_index)} · E${n0(s.media_index)}` : null,
      year:      n0(s.year) || null,
      mediaType: str(s.media_type, 'unknown', 20),
      user:      str(s.friendly_name || s.user, 'someone', 60),
      player:    str(s.player || s.product, '—', 60),
      quality:   str(s.quality_profile, '—', 40),
      mode:      str(s.transcode_decision, 'direct play', 20),
      state:     str(s.state, 'playing', 20),
      progress:  Math.max(0, Math.min(100, n0(s.progress_percent))),
    })),
    counts: {
      streams:    n0(a.stream_count ?? sessions.length),
      transcodes: n0(a.stream_count_transcode),
      direct:     n0(a.stream_count_direct_play),
    },
    bandwidth: {
      totalMbps: Math.round(n0(a.total_bandwidth) / 100) / 10,
      lanMbps:   Math.round(n0(a.lan_bandwidth) / 100) / 10,
      wanMbps:   Math.round(n0(a.wan_bandwidth) / 100) / 10,
    },
    topWatchers: rowsOf('top_users').slice(0, 10).map(r => ({
      user: str(r.friendly_name ?? r.user, '—', 60), minutes: Math.round(n0(r.total_duration) / 60), plays: n0(r.total_plays),
    })),
    topTitles: [...rowsOf('top_tv'), ...rowsOf('top_movies')]
      .sort((x, y) => n0(y.total_plays) - n0(x.total_plays))
      .slice(0, 10)
      .map(r => ({ title: str(r.title), plays: n0(r.total_plays), minutes: Math.round(n0(r.total_duration) / 60) })),
    recent: (Array.isArray(history) ? history : []).slice(0, 12).map((h: any) => ({
      at:      n0(h.date ?? h.started) ? n0(h.date ?? h.started) * 1000 : null,
      user:    str(h.friendly_name || h.user, '—', 60),
      title:   str(h.full_title || h.title),
      player:  str(h.player, '—', 60),
      minutes: Math.round(n0(h.duration ?? h.play_duration) / 60),
    })),
  }
}

export const plexPlugin: Plugin = {
  manifest: {
    id:   'plex',
    name: 'Plex activity',
    description: 'Who is watching right now, what they are watching, and what is transcoding.',
    kind: 'tile',
    icon: '🎬',
    baseUrlSetting: 'url',
    auth: { kind: 'query', param: 'apikey', fromSetting: 'apikey' },
    settings: [
      { key: 'url',    label: 'Tautulli address', type: 'url',    required: true,
        hint: 'http://192.168.1.20:8181 — Tautulli, not the Plex server itself.' },
      { key: 'apikey', label: 'API key',          type: 'secret', required: true,
        hint: 'Tautulli → Settings → Web Interface → API key.' },
    ],
  },

  async load(ctx: PluginContext): Promise<PluginTileData> {
    // Live activity is the headline and must not be held up by history, so the
    // two history calls are allowed to fail without taking the tile with them.
    const [body, history, home] = await Promise.all([
      ctx.get('/api/v2?cmd=get_activity'),
      ctx.get(`/api/v2?cmd=get_history&length=0&after=${daysAgo(1)}`).catch(() => null),
      ctx.get('/api/v2?cmd=get_home_stats&time_range=7&stats_count=1').catch(() => null),
    ])

    // Tautulli answers 200 with result:"error" for a bad key, so the envelope
    // has to be checked — an HTTP-status-only check reads that as success.
    const envelope = body?.response
    if (envelope?.result !== 'success') {
      throw new Error(envelope?.message || 'Tautulli rejected the request — check the API key.')
    }

    const data     = envelope.data ?? {}
    const sessions: any[] = data.sessions ?? []
    const count      = Number(data.stream_count ?? sessions.length)
    const transcodes = Number(data.stream_count_transcode ?? 0)

    // --- history ------------------------------------------------------------
    const past: Array<{ label: string; value: string; tone?: 'good' | 'warn' | 'bad' }> = []
    // (Row is declared below, where the live rows are built.)

    const plays24h = history?.response?.data?.recordsFiltered
                  ?? history?.response?.data?.totalRecords
    if (plays24h !== undefined) {
      past.push({ label: 'Plays, 24h', value: String(plays24h) })
    }

    const stats: any[] = home?.response?.data ?? []
    const pick = (id: string) => stats.find(x => x?.stat_id === id)?.rows?.[0]

    const topUser = pick('top_users')
    if (topUser) {
      past.push({
        label: 'Top watcher, 7d',
        value: `${topUser.friendly_name ?? topUser.user} · ${hours(Number(topUser.total_duration ?? 0))}`,
      })
    }

    const topTv = pick('top_tv') ?? pick('top_movies')
    if (topTv) {
      past.push({ label: 'Most watched, 7d', value: String(topTv.title ?? '—') })
    }

    if (!count) {
      return {
        headline: 'Nobody watching',
        tone: 'good',
        rows: past.length ? past : [{ label: 'History', value: 'no plays recorded' }],
      }
    }

    type Row = { label: string; value: string; tone?: 'good' | 'warn' | 'bad' }
    const rows: Row[] = sessions.slice(0, 6).map((s): Row => {
      const title = s.full_title
        || (s.grandparent_title ? `${s.grandparent_title} — ${s.title}` : s.title)
        || 'unknown'
      const decision = String(s.transcode_decision ?? 'direct play')
      const progress = s.progress_percent ? ` · ${s.progress_percent}%` : ''
      const paused   = s.state === 'paused'
      return {
        label: String(s.friendly_name || s.user || 'someone'),
        value: `${title} · ${paused ? 'paused' : decision}${progress}`,
        tone: paused ? 'warn' : decision === 'transcode' ? 'warn' : 'good',
      }
    })

    // Transcoding is the number that matters on a shared GPU: several at once
    // is the thing worth noticing without opening anything.
    const bandwidth = Number(data.total_bandwidth ?? 0)
    if (bandwidth) rows.push({ label: 'Bandwidth', value: mbps(bandwidth), tone: 'good' })
    rows.push(...past)

    return {
      headline: transcodes
        ? `${count} watching · ${transcodes} transcoding`
        : `${count} watching`,
      tone: transcodes > 1 ? 'warn' : 'good',
      rows,
    }
  },

  async detail(ctx: PluginContext): Promise<PluginDetail> {
    const [act, hist, home] = await Promise.all([
      ctx.get('/api/v2?cmd=get_activity'),
      ctx.get('/api/v2?cmd=get_history&length=25&order_column=date&order_dir=desc').catch(() => null),
      ctx.get('/api/v2?cmd=get_home_stats&time_range=30&stats_count=10').catch(() => null),
    ])

    if (act?.response?.result !== 'success') {
      throw new Error(act?.response?.message || 'Tautulli rejected the request — check the API key.')
    }

    const data = act.response.data ?? {}
    const sessions: any[] = data.sessions ?? []

    const pct = (v: any) => (v === undefined || v === null ? '—' : `${v}%`)
    const when = (unix: any) => {
      const n = Number(unix)
      return n ? new Date(n * 1000).toLocaleString() : '—'
    }
    const mins = (sec: any) => {
      const n = Number(sec ?? 0)
      return n ? `${Math.round(n / 60)} min` : '—'
    }

    const historyRows: any[] = hist?.response?.data?.data ?? []
    const stats: any[] = home?.response?.data ?? []
    const rowsOf = (id: string) => stats.find(x => x?.stat_id === id)?.rows ?? []

    const topUsers = rowsOf('top_users').map((r: any) => ({
      user:   r.friendly_name ?? r.user ?? '—',
      plays:  r.total_plays ?? 0,
      time:   mins(r.total_duration),
    }))

    const topMedia = [...rowsOf('top_tv'), ...rowsOf('top_movies')]
      .sort((a: any, b: any) => Number(b.total_plays ?? 0) - Number(a.total_plays ?? 0))
      .slice(0, 10)
      .map((r: any) => ({ title: r.title ?? '—', plays: r.total_plays ?? 0, time: mins(r.total_duration) }))

    return {
      visual: buildPlexVisual(data, historyRows, stats),
      stats: [
        { label: 'Watching now',  value: String(data.stream_count ?? 0) },
        { label: 'Transcoding',   value: String(data.stream_count_transcode ?? 0),
          tone: Number(data.stream_count_transcode ?? 0) > 1 ? 'warn' : 'good' },
        { label: 'Direct play',   value: String(data.stream_count_direct_play ?? 0) },
        { label: 'Bandwidth',     value: mbps(Number(data.total_bandwidth ?? 0)) },
        { label: 'LAN bandwidth', value: mbps(Number(data.lan_bandwidth ?? 0)) },
        { label: 'WAN bandwidth', value: mbps(Number(data.wan_bandwidth ?? 0)) },
      ],
      tables: [
        {
          title: 'Playing now',
          empty: 'Nobody is watching anything.',
          columns: [
            { key: 'user',    label: 'Who' },
            { key: 'title',   label: 'What' },
            { key: 'player',  label: 'Player' },
            { key: 'quality', label: 'Quality' },
            { key: 'mode',    label: 'Mode' },
            { key: 'state',   label: 'State' },
            { key: 'at',      label: 'Progress', align: 'right' },
          ],
          rows: sessions.map(x => ({
            user:    x.friendly_name || x.user || '—',
            title:   x.full_title || x.title || '—',
            player:  x.player || '—',
            quality: x.quality_profile || '—',
            mode:    x.transcode_decision || '—',
            state:   x.state || '—',
            at:      pct(x.progress_percent),
          })),
        },
        {
          title: 'Recently watched',
          empty: 'No history recorded yet.',
          columns: [
            { key: 'when',   label: 'When' },
            { key: 'user',   label: 'Who' },
            { key: 'title',  label: 'What' },
            { key: 'player', label: 'Player' },
            { key: 'length', label: 'Watched', align: 'right' },
          ],
          rows: historyRows.map((h: any) => ({
            when:   when(h.date ?? h.started),
            user:   h.friendly_name || h.user || '—',
            title:  h.full_title || h.title || '—',
            player: h.player || '—',
            length: mins(h.duration),
          })),
        },
        {
          title: 'Top watchers, 30 days',
          empty: 'Not enough history yet.',
          columns: [
            { key: 'user',  label: 'Who' },
            { key: 'plays', label: 'Plays', align: 'right' },
            { key: 'time',  label: 'Time',  align: 'right' },
          ],
          rows: topUsers,
        },
        {
          title: 'Most watched, 30 days',
          empty: 'Not enough history yet.',
          columns: [
            { key: 'title', label: 'Title' },
            { key: 'plays', label: 'Plays', align: 'right' },
            { key: 'time',  label: 'Time',  align: 'right' },
          ],
          rows: topMedia,
        },
      ],
    }
  },

  async metrics(ctx: PluginContext): Promise<PluginMetric[]> {
    const body = await ctx.get('/api/v2?cmd=get_activity')
    if (body?.response?.result !== 'success') {
      throw new Error(body?.response?.message || 'Tautulli rejected the request.')
    }
    const d = body.response.data ?? {}

    return [
      { name: 'plex_streams', help: 'Plex streams in progress.', type: 'gauge',
        value: Number(d.stream_count ?? 0), labels: { decision: 'all' } },
      { name: 'plex_streams', help: 'Plex streams in progress.', type: 'gauge',
        value: Number(d.stream_count_transcode ?? 0), labels: { decision: 'transcode' } },
      { name: 'plex_streams', help: 'Plex streams in progress.', type: 'gauge',
        value: Number(d.stream_count_direct_play ?? 0), labels: { decision: 'direct_play' } },
      { name: 'plex_bandwidth_kbps', help: 'Bandwidth used by Plex streams.', type: 'gauge',
        value: Number(d.total_bandwidth ?? 0), labels: { scope: 'total' } },
      { name: 'plex_bandwidth_kbps', help: 'Bandwidth used by Plex streams.', type: 'gauge',
        value: Number(d.lan_bandwidth ?? 0), labels: { scope: 'lan' } },
      { name: 'plex_bandwidth_kbps', help: 'Bandwidth used by Plex streams.', type: 'gauge',
        value: Number(d.wan_bandwidth ?? 0), labels: { scope: 'wan' } },
    ]
  },
}
