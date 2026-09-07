// =============================================================================
//  Plug-in — Plex activity, via Tautulli
//
//  Tautulli rather than Plex's own /status/sessions: it already resolves the
//  things worth seeing at a glance — whether a stream is transcoding or direct,
//  how far through it is, and what it is costing in bandwidth — where the raw
//  Plex endpoint makes you infer all three.
// =============================================================================

import type { Plugin, PluginContext, PluginTileData } from '../lib/plugin-host'

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
}
