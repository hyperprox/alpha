// =============================================================================
//  Plug-in — Package cache (apt-cacher-ng)
//
//  The gallery card, the detail tables (folded into Details on the page) and a
//  summary for the AI page. The figures, fixes and Updates' "Use the package
//  cache" setting live in lib/aptcache and its page (/plugins/apt-cacher-ng);
//  the card reads through lib/aptcache's own read-only transport
//  (coreTransport), so the plug-in never reaches a guest itself. A cache is
//  connected by itself after a Catalogue install.
//  The card and its details are viewer reads, so they carry no guest names:
//  which guests use the cache is on the admin page only.
// =============================================================================

import { PluginNotConfigured } from '../lib/plugin-host'
import type { Plugin, PluginContext, PluginDetail, PluginTileData } from '../lib/plugin-host'
import { PLUGIN_ID, type CacheReading } from '../lib/aptcache/types'
import type { ClientView } from '../lib/aptcache/service'

type View = Omit<CacheReading, 'clients'> & { clients: ClientView[] }
export type CardRow = { id: string; name: string; vmid: number; ok: boolean; error?: string; reading?: View }

const notYet = () => new PluginNotConfigured('Not configured yet: install the package cache from the Catalogue and HyperProx connects it by itself.')

export function size(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

export const pct = (r: number | null) => (r === null ? '—' : `${Math.round(r * 100)}%`)

function lineOf(x: CardRow): { label: string; value: string; tone: 'good' | 'warn' | 'bad' } {
  if (!x.ok || !x.reading) return { label: x.name, value: x.error ?? 'not reachable', tone: 'bad' }
  const r = x.reading
  if (!r.active) return { label: x.name, value: 'not running (guests fetch directly)', tone: 'bad' }
  const used = r.disk && r.disk.sizeKb ? r.disk.usedKb / r.disk.sizeKb : 0
  const value = `${size(r.totals.hitBytes)} saved · ${pct(r.byteHitRatio)} from cache in ${r.hours} h`
  return { label: x.name, value, tone: used >= 0.9 ? 'warn' : 'good' }
}

export function tileOf(rows: CardRow[]): PluginTileData {
  if (!rows.length) throw notYet()
  const lines = rows.map(lineOf)
  const bad = lines.filter(l => l.tone !== 'good')
  return {
    headline: bad.length ? (rows.length === 1 ? bad[0].value : `${bad[0].label}: ${bad[0].value}`) : rows.length === 1 ? lines[0].value : `${rows.length} caches running`,
    rows: lines,
    tone: lines.some(l => l.tone === 'bad') ? 'bad' : bad.length ? 'warn' : 'good',
  }
}

export function detailOf(rows: CardRow[]): PluginDetail {
  const rs = rows.filter(r => r.reading).map(r => ({ row: r, r: r.reading! }))
  const tables: NonNullable<PluginDetail['tables']> = [
    { title: 'Caches', empty: 'None connected yet.',
      columns: [{ key: 'name', label: 'Container' }, { key: 'state', label: 'State' }, { key: 'hit', label: 'From cache', align: 'right' }, { key: 'saved', label: 'Saved', align: 'right' }, { key: 'disk', label: 'Disk used', align: 'right' }],
      rows: rows.map(x => ({
        name: x.name, state: !x.ok ? 'unreachable' : x.reading?.active ? 'running' : 'stopped',
        hit: x.reading ? pct(x.reading.byteHitRatio) : '—', saved: x.reading ? size(x.reading.totals.hitBytes) : '—',
        disk: x.reading?.disk ? `${Math.round(x.reading.disk.usedKb / Math.max(1, x.reading.disk.sizeKb) * 100)}%` : '—',
      })) },
    { title: 'Busiest packages', empty: 'No packages fetched in the window.',
      columns: [{ key: 'name', label: 'Package' }, { key: 'requests', label: 'Fetches', align: 'right' }, { key: 'hits', label: 'From cache', align: 'right' }, { key: 'bytes', label: 'Size', align: 'right' }],
      rows: rs.flatMap(({ r }) => r.packages.map(p => ({ name: p.name, requests: p.requests, hits: p.hits, bytes: size(p.bytes) }))) },
  ]
  const saved = rs.reduce((a, { r }) => a + r.totals.hitBytes, 0)
  const served = rs.reduce((a, { r }) => a + r.totals.bytes, 0)
  return {
    stats: [
      { label: 'Caches', value: String(rows.length), tone: rows.some(r => !r.ok || !r.reading?.active) ? 'bad' : 'good' },
      { label: 'Saved (window)', value: size(saved) },
      { label: 'From cache', value: served ? pct(saved / served) : '—' },
    ],
    tables,
  }
}

export const aptCachePlugin: Plugin = {
  manifest: {
    id: PLUGIN_ID, name: 'Package cache', kind: 'device', icon: '📦', baseUrlSetting: 'url', coreTransport: true, auth: { kind: 'none' }, settings: [],
    description: 'apt-cacher-ng for your guests\' Debian and Ubuntu packages: what it saves, hit ratio over time, the busiest packages and repositories, which guests use it, the disk, and the last clean-up. Run the clean-up, restart it, grow its disk, and repair or remove the cache setting on your guests.',
  },
  needsWhat: 'the package cache installed from the Catalogue (connected by itself)',
  async isConfigured() { return (await (await import('../lib/aptcache')).aptCacheService().instances()).length > 0 },
  async load(ctx: PluginContext) { return tileOf(await ctx.get('/readings')) },
  async detail(ctx: PluginContext) {
    const rows: CardRow[] = await ctx.get('/readings')
    if (!Array.isArray(rows) || !rows.length) throw notYet()
    return detailOf(rows)
  },
  async summary(ctx: PluginContext) {
    const rows: CardRow[] = await ctx.get('/readings')
    return {
      title: 'Package cache',
      lines: (Array.isArray(rows) ? rows : []).map(x => x.reading
        ? `${x.name}: ${x.reading.active ? 'running' : 'not running'}; ${size(x.reading.totals.hitBytes)} of ${size(x.reading.totals.bytes)} served from the cache in the last ${x.reading.hours} hours; ${x.reading.clients.filter(c => c.kind === 'guest' || c.kind === 'node').length} guests using it`
        : `${x.name}: could not be read`),
    }
  },
}
