// =============================================================================
//  Plug-in — Plex activity
//
//  Plex itself is the source: now streaming from /status/sessions, plays from
//  its own history, libraries from /library/sections (lib/plex-direct.ts).
//  Tautulli is optional and only adds what Plex does not keep: hours watched
//  and its stream-quality wording. An install set up before this, with only
//  Tautulli, keeps every reading it had and is asked for the Plex server.
// =============================================================================

import type { Plugin, PluginContext, PluginTileData, PluginDetail, PluginMetric } from '../lib/plugin-host'
import type { PlexVisual } from '../lib/plugin-visual-types'
import { artRef } from '../lib/plex-art'
import { accountNames, historyStats, librarySections, plexSessions, sectionCount, withTautulliQuality } from '../lib/plex-direct'

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
      // An episode shows its show's poster. Only a HyperProx path goes to the page, never Plex's address or token.
      art:       artRef(episode(s) ? (s.grandparent_thumb || s.thumb) : s.thumb),
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
    // Tautulli orders top_users by plays; the page charts hours, so it is sorted by time watched.
    topWatchers: rowsOf('top_users').map(r => ({
      user: str(r.friendly_name ?? r.user, '—', 60), minutes: Math.round(n0(r.total_duration) / 60), plays: n0(r.total_plays),
    })).sort((a, b) => b.minutes - a.minutes).slice(0, 10),
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

/**
 * The live part of the Plex page (now streaming, counts, bandwidth) from one get_activity answer: what the page
 * re-reads every few seconds, without the history and stats calls the full detail makes.
 */
export function plexLiveVisual(body: any): Pick<PlexVisual, 'sessions' | 'counts' | 'bandwidth'> {
  const envelope = body?.response
  if (envelope?.result !== 'success') throw new Error(envelope?.message || 'Tautulli rejected the request — check the API key.')
  const v = buildPlexVisual(envelope.data ?? {}, [], [])
  return { sessions: v.sessions, counts: v.counts, bandwidth: v.bandwidth }
}

// ── Tautulli (optional): the plug-in as it worked before Plex was read directly ──

async function tautulliLoad(ctx: PluginContext): Promise<PluginTileData> {
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
}

async function tautulliDetail(ctx: PluginContext): Promise<PluginDetail> {
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
}

async function tautulliMetrics(ctx: PluginContext): Promise<PluginMetric[]> {
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
}

// ── Plex itself: the main source ──────────────────────────────────────────────

const DAY_S = 86_400
const libCache = { at: 0, data: [] as NonNullable<PlexVisual['libraries']> }

/** Each library and its size: one small call per library, kept ten minutes. */
async function libraries(ctx: PluginContext): Promise<NonNullable<PlexVisual['libraries']>> {
  if (Date.now() - libCache.at < 10 * 60_000) return libCache.data
  const sections = librarySections(await ctx.get('/library/sections'))
  const data = await Promise.all(sections.map(async s => ({
    title: s.title, kind: s.kind,
    count: sectionCount(await ctx.get(`/library/sections/${s.key}/all?X-Plex-Container-Start=0&X-Plex-Container-Size=0`).catch(() => null)),
  })))
  libCache.at = Date.now(); libCache.data = data
  return data
}

/** Plex's plays in the last `days` days, newest first (up to 5,000). */
async function recentHistory(ctx: PluginContext, days: number): Promise<any[]> {
  const since = Math.floor(Date.now() / 1000) - days * DAY_S
  const out: any[] = []
  for (let start = 0; start < 5000; start += 1000) {
    const body = await ctx.get(`/status/sessions/history/all?sort=viewedAt:desc&viewedAt%3E=${since}&X-Plex-Container-Start=${start}&X-Plex-Container-Size=1000`, { timeoutMs: 20_000 })
    const rows: any[] = Array.isArray(body?.MediaContainer?.Metadata) ? body.MediaContainer.Metadata : []
    out.push(...rows)
    if (rows.length < 1000) break
  }
  return out
}

/** Now streaming from Plex, with Tautulli's quality wording when Tautulli is also set. */
export async function liveFromPlex(plex: { get(p: string, t?: number): Promise<any> }, tautulli?: { get(p: string, t?: number): Promise<any> } | null) {
  const [s, act] = await Promise.all([
    plex.get('/status/sessions', 5000),
    tautulli ? tautulli.get('/api/v2?cmd=get_activity', 5000).catch(() => null) : null,
  ])
  const live = plexSessions(s)
  return act ? { ...live, sessions: withTautulliQuality(live.sessions, act) } : live
}

const NEEDS_PLEX = 'Needs attention: add your Plex server for live data'

async function plexVisual(ctx: PluginContext): Promise<PlexVisual> {
  const t = ctx.has('tautulli') ? ctx.from('tautulli') : null
  const plex = { get: (p: string, ms?: number) => ctx.get(p, { timeoutMs: ms }) }
  const tau = t ? { get: (p: string, ms?: number) => t.get(p, { timeoutMs: ms }) } : null
  const [live, rows, names, libs, home] = await Promise.all([
    liveFromPlex(plex, tau),
    recentHistory(ctx, 30).catch(() => []),
    ctx.get('/accounts').then(accountNames).catch(() => new Map<number, string>()),
    libraries(ctx).catch(() => []),
    // Tautulli adds what Plex does not keep: how long each person watched.
    t ? t.get('/api/v2?cmd=get_home_stats&time_range=30&stats_count=10').catch(() => null) : null,
  ])
  const plays = historyStats(rows, names)
  const stats = home?.response?.result === 'success' ? buildPlexVisual({}, [], home.response.data) : null
  const useTautulli = !!stats && stats.topWatchers.length > 0
  return {
    kind: 'plex',
    ...live,
    topWatchers: useTautulli ? stats!.topWatchers : plays.topWatchers,
    topTitles:   useTautulli && stats!.topTitles.length ? stats!.topTitles : plays.topTitles,
    recent:      plays.recent,
    topBy:       useTautulli ? 'minutes' : 'plays',
    libraries:   libs,
    source:      t ? 'both' : 'plex',
  }
}

export const plexPlugin: Plugin = {
  manifest: {
    id:   'plex',
    name: 'Plex activity',
    description: 'Who is watching right now, what they are watching, what is transcoding, and what nobody watches.',
    kind: 'tile',
    icon: '🎬',
    // Plex itself. Tautulli is an optional second connection (endpoint "tautulli") for hours watched and
    // stream quality wording; an install that only ever had Tautulli keeps working and is asked for Plex.
    baseUrlSetting: 'plex_url',
    auth: { kind: 'header', header: 'X-Plex-Token', fromSetting: 'plex_token' },
    // The whole page every minute; now streaming and bandwidth every five seconds through /api/plugins/plex/live.
    refreshSeconds: 60,
    requiredAny: [['plex_url', 'plex_token'], ['url', 'apikey']],
    settings: [
      { key: 'plex_url',   label: 'Plex server address', type: 'url', required: false, section: 'Plex server',
        hint: 'Like http://plex.local:32400. Use https if Plex is on another network.' },
      { key: 'plex_token', label: 'Plex token', type: 'secret', required: false,
        hint: 'In Plex Web, open any item, choose Get Info, then View XML: the token is the X-Plex-Token at the end of the address. Stored in the vault and only ever sent to the address above.' },
      { key: 'url',    label: 'Tautulli address', type: 'url', required: false, section: 'Add Tautulli for richer stats (optional)',
        hint: 'Like http://tautulli.local:8181. Adds hours watched and stream quality. Plex works without it.' },
      { key: 'apikey', label: 'Tautulli API key', type: 'secret', required: false,
        hint: 'Tautulli → Settings → Web Interface → API key.' },
      { key: 'notify_new', label: 'Tell me when something new is added', type: 'toggle', required: false, section: 'Notifications',
        hint: 'Off by default. Sends one message per batch to your notification channels that take "Plex: new in the library". If Tautulli already tells you, you will get these twice.' },
      // Clear-out keep rules. Blank uses the default shown; "none" turns a rule off.
      { key: 'keep_before_year',    label: 'Keep anything released before', type: 'text', required: false, section: 'Clear-out keep rules',
        hint: 'A year. Default 2000.' },
      { key: 'keep_anime',          label: 'Keep anime', type: 'text', required: false,
        hint: 'yes or no. Default yes (Sonarr’s anime series type).' },
      { key: 'keep_folder_pattern', label: 'Keep folders whose path contains', type: 'text', required: false,
        hint: 'Default "complete series".' },
      { key: 'keep_folders',        label: 'Keep these folders', type: 'text', required: false,
        hint: 'Paths, comma-separated: everything under them is kept.' },
      { key: 'keep_genres',         label: 'Keep these genres', type: 'text', required: false,
        hint: 'Comma-separated. Default "Science Fiction".' },
      { key: 'keep_names',          label: 'Keep these names', type: 'text', required: false,
        hint: 'Comma-separated. A name keeps every title that starts with it, so "Night Desk" keeps every Night Desk show. Names of three letters or fewer must match the whole title.' },
      { key: 'keep_added_days',     label: 'Keep anything added in the last … days', type: 'text', required: false,
        hint: 'Default 90.' },
      { key: 'never_min_months',    label: '"Never watched" only after … months in Plex', type: 'text', required: false,
        hint: 'Default 6.' },
      { key: 'idle_months',         label: '"Idle" when not played for … months', type: 'text', required: false,
        hint: 'Default 6.' },
    ],
    endpoints: [
      { key: 'tautulli', label: 'Tautulli', baseUrlSetting: 'url',
        auth: { kind: 'query', param: 'apikey', fromSetting: 'apikey' } },
    ],
  },

  async load(ctx: PluginContext): Promise<PluginTileData> {
    if (!ctx.has('default')) {
      // Only Tautulli (an install from before Plex was read directly): keep showing what it shows, and ask.
      const t = await tautulliLoad(ctx.from('tautulli'))
      return { headline: NEEDS_PLEX, tone: 'warn', rows: [{ label: 'Now', value: t.headline }, ...(t.rows ?? [])] }
    }
    const v = await liveFromPlex({ get: (p, ms) => ctx.get(p, { timeoutMs: ms }) })
    const { streams, transcodes } = v.counts
    const rows = v.sessions.slice(0, 6).map(s => ({
      label: s.user,
      value: `${s.title}${s.episode ? ` — ${s.episode}` : ''} · ${s.state === 'paused' ? 'paused' : s.mode} · ${Math.round(s.progress)}%`,
      tone: (s.state === 'paused' || s.mode === 'transcode' ? 'warn' : 'good') as 'warn' | 'good',
    }))
    if (v.bandwidth.totalMbps) rows.push({ label: 'Bandwidth', value: `${v.bandwidth.totalMbps} Mbps`, tone: 'good' })
    if (!streams) return { headline: 'Nobody watching', tone: 'good', rows }
    return { headline: transcodes ? `${streams} watching · ${transcodes} transcoding` : `${streams} watching`, tone: transcodes > 1 ? 'warn' : 'good', rows }
  },

  async detail(ctx: PluginContext): Promise<PluginDetail> {
    if (!ctx.has('default')) {
      const d = await tautulliDetail(ctx.from('tautulli'))
      return { ...d, visual: d.visual?.kind === 'plex' ? { ...d.visual, source: 'tautulli', needsPlex: true, topBy: 'minutes' } : d.visual }
    }
    const v = await plexVisual(ctx)
    const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : '—')
    return {
      visual: v,
      stats: [
        { label: 'Watching now', value: String(v.counts.streams) },
        { label: 'Transcoding',  value: String(v.counts.transcodes), tone: v.counts.transcodes > 1 ? 'warn' : 'good' },
        { label: 'Direct play',  value: String(v.counts.direct) },
        { label: 'Bandwidth',    value: `${v.bandwidth.totalMbps} Mbps` },
        { label: 'Local',        value: `${v.bandwidth.lanMbps} Mbps` },
        { label: 'Remote',       value: `${v.bandwidth.wanMbps} Mbps` },
      ],
      tables: [
        {
          title: 'Playing now', empty: 'Nobody is watching anything.',
          columns: [{ key: 'user', label: 'Who' }, { key: 'title', label: 'What' }, { key: 'player', label: 'Player' },
            { key: 'quality', label: 'Quality' }, { key: 'mode', label: 'Mode' }, { key: 'state', label: 'State' }, { key: 'at', label: 'Progress', align: 'right' }],
          rows: v.sessions.map(s => ({ user: s.user, title: s.episode ? `${s.title} — ${s.episode}` : s.title, player: s.player,
            quality: s.quality, mode: s.mode, state: s.state, at: `${Math.round(s.progress)}%` })),
        },
        {
          title: 'Recently watched', empty: 'No plays in the last 30 days.',
          columns: [{ key: 'when', label: 'When' }, { key: 'user', label: 'Who' }, { key: 'title', label: 'What' }],
          rows: v.recent.map(r => ({ when: when(r.at), user: r.user, title: r.title })),
        },
        {
          title: v.topBy === 'minutes' ? 'Top watchers, 30 days' : 'Top watchers by plays, 30 days', empty: 'Not enough history yet.',
          columns: [{ key: 'user', label: 'Who' }, { key: 'plays', label: 'Plays', align: 'right' }],
          rows: v.topWatchers.map(w => ({ user: w.user, plays: w.plays })),
        },
        {
          title: 'Libraries', empty: 'No libraries.',
          columns: [{ key: 'title', label: 'Library' }, { key: 'kind', label: 'Kind' }, { key: 'count', label: 'Items', align: 'right' }],
          rows: (v.libraries ?? []).map(l => ({ title: l.title, kind: l.kind, count: l.count })),
        },
      ],
    }
  },

  async metrics(ctx: PluginContext): Promise<PluginMetric[]> {
    if (!ctx.has('default')) return tautulliMetrics(ctx.from('tautulli'))
    const v = await liveFromPlex({ get: (p, ms) => ctx.get(p, { timeoutMs: ms }) })
    const g = (value: number, labels: Record<string, string>, name = 'plex_streams', help = 'Plex streams in progress.'): PluginMetric => ({ name, help, type: 'gauge', value, labels })
    return [
      g(v.counts.streams, { decision: 'all' }),
      g(v.counts.transcodes, { decision: 'transcode' }),
      g(v.counts.direct, { decision: 'direct_play' }),
      g(Math.round(v.bandwidth.totalMbps * 1000), { scope: 'total' }, 'plex_bandwidth_kbps', 'Bandwidth used by Plex streams.'),
      g(Math.round(v.bandwidth.lanMbps * 1000), { scope: 'lan' }, 'plex_bandwidth_kbps', 'Bandwidth used by Plex streams.'),
      g(Math.round(v.bandwidth.wanMbps * 1000), { scope: 'wan' }, 'plex_bandwidth_kbps', 'Bandwidth used by Plex streams.'),
    ]
  },
}
