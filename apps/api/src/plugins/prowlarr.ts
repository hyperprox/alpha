// =============================================================================
//  Plug-in — Prowlarr
//
//  Two jobs. It reports indexer health as a tile, and it provides the free-text
//  search the *arr apps structurally cannot do: they query by scene naming for a
//  specific episode or season, then reject anything failing a quality profile,
//  a seeder floor or a cutoff rule — silently. A complete-series pack sitting on
//  three trackers never reaches you.
//
//  A plain query across every configured indexer, showing raw results, is what
//  people open a separate tool for. This puts it back where it belongs.
// =============================================================================

import type {
  Plugin, PluginContext, PluginTileData, PluginDetail,
  PluginMetric, PluginSearchResult,
} from '../lib/plugin-host'

function gb(bytes: number): string {
  const v = Number(bytes ?? 0)
  if (!v) return '—'
  return v >= 1e9 ? `${(v / 1e9).toFixed(1)} GB` : `${(v / 1e6).toFixed(0)} MB`
}

export const prowlarrPlugin: Plugin = {
  manifest: {
    id:   'prowlarr',
    name: 'Prowlarr',
    description: 'Indexer health, and free-text search across every indexer at once.',
    kind: 'device',
    icon: '🔎',
    baseUrlSetting: 'url',
    auth: { kind: 'header', header: 'X-Api-Key', fromSetting: 'apikey' },
    settings: [
      { key: 'url',    label: 'Prowlarr address', type: 'url',    required: true,
        hint: 'http://192.168.1.30:9696' },
      { key: 'apikey', label: 'API key',          type: 'secret', required: true,
        hint: 'Settings → General → API Key.' },
    ],
  },

  async load(ctx: PluginContext): Promise<PluginTileData> {
    const [indexers, stats] = await Promise.all([
      ctx.get('/api/v1/indexer'),
      ctx.get('/api/v1/indexerstats').catch(() => null),
    ])
    const list: any[] = Array.isArray(indexers) ? indexers : []
    const on  = list.filter(i => i.enable)
    const off = list.filter(i => !i.enable)

    // A disabled indexer is worth surfacing: it is usually one that failed once
    // and was switched off, and nobody ever switches it back on.
    const rows: Array<{ label: string; value: string; tone?: 'good' | 'warn' | 'bad' }> = [
      { label: 'Enabled',  value: String(on.length), tone: on.length ? 'good' : 'bad' },
    ]
    if (off.length) rows.push({ label: 'Disabled', value: String(off.length), tone: 'warn' })

    const st: any[] = stats?.indexers ?? []
    const failing = st.filter(x => Number(x.numberOfFailedQueries ?? 0) > 0)
    if (failing.length) {
      const worst = failing.sort((a, b) =>
        Number(b.numberOfFailedQueries) - Number(a.numberOfFailedQueries))[0]
      rows.push({
        label: 'Most failures',
        value: `${worst.indexerName} · ${worst.numberOfFailedQueries}`,
        tone: 'warn',
      })
    }
    const grabs = st.reduce((t, x) => t + Number(x.numberOfGrabs ?? 0), 0)
    if (grabs) rows.push({ label: 'Grabs', value: String(grabs) })

    return {
      headline: `${on.length} indexer${on.length === 1 ? '' : 's'} searching`,
      tone: !on.length ? 'bad' : off.length ? 'warn' : 'good',
      rows,
    }
  },

  async detail(ctx: PluginContext): Promise<PluginDetail> {
    const [indexers, stats] = await Promise.all([
      ctx.get('/api/v1/indexer'),
      ctx.get('/api/v1/indexerstats').catch(() => null),
    ])
    const list: any[] = Array.isArray(indexers) ? indexers : []
    const st: Record<string, any> = {}
    for (const x of (stats?.indexers ?? [])) st[x.indexerName] = x

    return {
      stats: [
        { label: 'Indexers',  value: String(list.length) },
        { label: 'Enabled',   value: String(list.filter(i => i.enable).length),
          tone: list.some(i => i.enable) ? 'good' : 'bad' },
        { label: 'Disabled',  value: String(list.filter(i => !i.enable).length),
          tone: list.some(i => !i.enable) ? 'warn' : 'good' },
      ],
      tables: [
        {
          title: 'Indexers',
          empty: 'No indexers configured.',
          columns: [
            { key: 'name',     label: 'Name' },
            { key: 'state',    label: 'State' },
            { key: 'privacy',  label: 'Privacy' },
            { key: 'queries',  label: 'Queries',  align: 'right' },
            { key: 'grabs',    label: 'Grabs',    align: 'right' },
            { key: 'failures', label: 'Failures', align: 'right' },
          ],
          rows: list
            .sort((a, b) => Number(b.enable) - Number(a.enable) || a.name.localeCompare(b.name))
            .map(i => ({
              name: i.name,
              state: i.enable ? 'enabled' : 'disabled',
              privacy: i.privacy ?? '—',
              queries:  st[i.name]?.numberOfQueries ?? 0,
              grabs:    st[i.name]?.numberOfGrabs ?? 0,
              failures: st[i.name]?.numberOfFailedQueries ?? 0,
            })),
        },
      ],
    }
  },

  async search(ctx: PluginContext, query: string): Promise<PluginSearchResult[]> {
    const q = encodeURIComponent(query.trim())
    if (!q) return []
    // Fans out to every configured indexer, some behind FlareSolverr, so this
    // routinely takes a minute or more. A tile-length timeout kills it.
    const res = await ctx.get(`/api/v1/search?query=${q}&type=search&limit=200`, { timeoutMs: 180_000 })
    const list: any[] = Array.isArray(res) ? res : []

    return list.map(r => ({
      title:      r.title ?? '—',
      indexer:    r.indexer ?? '—',
      size:       Number(r.size ?? 0),
      seeders:    Number(r.seeders ?? 0),
      leechers:   Number(r.leechers ?? 0),
      published:  r.publishDate ?? '',
      categories: (r.categories ?? []).map((c: any) => c?.name).filter(Boolean),
      guid:       r.guid ?? '',
      indexerId:  Number(r.indexerId ?? 0),
    }))
    // Deliberately unsorted and unfiltered here — ranking is the caller's
    // business, and hiding low-seeder results is exactly the behaviour that
    // made the *arr search unhelpful in the first place.
  },

  async grab(ctx: PluginContext, guid: string, indexerId: number): Promise<string> {
    await ctx.post('/api/v1/search', { guid, indexerId }, { timeoutMs: 60_000 })
    return 'Sent to the download client'
  },

  async metrics(ctx: PluginContext): Promise<PluginMetric[]> {
    const indexers = await ctx.get('/api/v1/indexer')
    const list: any[] = Array.isArray(indexers) ? indexers : []
    return [
      { name: 'indexers', help: 'Indexers configured in Prowlarr.', type: 'gauge',
        value: list.filter(i => i.enable).length, labels: { state: 'enabled' } },
      { name: 'indexers', help: 'Indexers configured in Prowlarr.', type: 'gauge',
        value: list.filter(i => !i.enable).length, labels: { state: 'disabled' } },
    ]
  },
}
