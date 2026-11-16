// =============================================================================
//  Plug-in — 3proxy (forward proxy: HTTP and SOCKS5)
//
//  The gallery card, the detail tables (folded into Details on the page) and a
//  summary for the AI page. The readings, users, settings and fixes live in
//  lib/fwdproxy and its page (/plugins/3proxy); the card reads through
//  lib/fwdproxy's own read-only transport (coreTransport), so the plug-in never
//  reaches a guest itself. A proxy is connected by itself after a Catalogue
//  install. Who used it stays on the admin-only page: nothing here names a user
//  or a client address.
// =============================================================================

import { PluginNotConfigured } from '../lib/plugin-host'
import type { Plugin, PluginContext, PluginDetail, PluginTileData } from '../lib/plugin-host'
import type { ProxyReading } from '../lib/fwdproxy/types'

export type CardRow = { id: string; name: string; vmid: number; listen: string | null; ok: boolean; error?: string; reading?: ProxyReading }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const notYet = () => new PluginNotConfigured('Not configured yet: install 3proxy from the Catalogue and HyperProx connects it by itself.')

export function mb(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

function lineOf(x: CardRow): { label: string; value: string; tone: 'good' | 'warn' | 'bad' } {
  if (!x.ok || !x.reading) return { label: x.name, value: x.error ?? 'not reachable', tone: 'bad' }
  const r = x.reading
  if (!r.active) return { label: x.name, value: 'not running', tone: 'bad' }
  const conns = (r.conns.http ?? 0) + (r.conns.socks ?? 0)
  return { label: x.name, value: `${plural(conns, 'connection')} · ${mb(r.totals.bytes)} in ${r.minutes} min`, tone: r.lanTargets || !r.users.length ? 'warn' : 'good' }
}

export function tileOf(rows: CardRow[]): PluginTileData {
  if (!rows.length) throw notYet()
  const lines = rows.map(lineOf)
  const bad = lines.filter(l => l.tone !== 'good')
  return {
    headline: bad.length ? (rows.length === 1 ? bad[0].value : `${bad[0].label}: ${bad[0].value}`) : rows.length === 1 ? lines[0].value : `${rows.length} proxies running`,
    rows: lines,
    tone: lines.some(l => l.tone === 'bad') ? 'bad' : bad.length ? 'warn' : 'good',
  }
}

/** Totals and refusals only: users, client addresses and where they went stay on the admin page. */
export function detailOf(rows: CardRow[]): PluginDetail {
  const readings = rows.filter(r => r.reading).map(r => ({ row: r, r: r.reading! }))
  const total = readings.reduce((a, { r }) => a + r.totals.requests, 0)
  const bytes = readings.reduce((a, { r }) => a + r.totals.bytes, 0)
  return {
    stats: [
      { label: 'Proxies', value: String(rows.length), tone: rows.some(r => !r.ok || !r.reading?.active) ? 'bad' : 'good' },
      { label: 'Requests (window)', value: String(total) },
      { label: 'Traffic (window)', value: mb(bytes) },
    ],
    tables: [
      {
        title: 'Proxies', empty: 'None connected yet.',
        columns: [{ key: 'name', label: 'Container' }, { key: 'listen', label: 'Address' }, { key: 'state', label: 'State' }, { key: 'http', label: 'HTTP now', align: 'right' }, { key: 'socks', label: 'SOCKS now', align: 'right' }, { key: 'requests', label: 'Requests', align: 'right' }, { key: 'traffic', label: 'Traffic', align: 'right' }, { key: 'denied', label: 'Refused', align: 'right' }],
        rows: rows.map(x => ({
          name: x.name, listen: x.listen ?? '—', state: !x.ok ? 'unreachable' : x.reading?.active ? 'running' : 'stopped',
          http: x.reading?.conns.http ?? '—', socks: x.reading?.conns.socks ?? '—',
          requests: x.reading?.totals.requests ?? '—', traffic: x.reading ? mb(x.reading.totals.bytes) : '—', denied: x.reading?.totals.denied ?? '—',
        })),
      },
      { title: 'Refused', empty: 'Nothing refused in the window.', columns: [{ key: 'proxy', label: 'Proxy' }, { key: 'why', label: 'Why' }, { key: 'count', label: 'Times', align: 'right' }],
        rows: readings.flatMap(({ row, r }) => r.denied.map(d => ({ proxy: row.name, why: d.label, count: d.count }))) },
    ],
  }
}

export const threeProxyPlugin: Plugin = {
  manifest: {
    id: '3proxy',
    name: '3proxy',
    description: '3proxy forward proxy (HTTP and SOCKS5): open connections per protocol, traffic, refusals and users. Reload, add or remove users (passwords in the vault), and change who may use it.',
    kind: 'device', icon: '🧭', baseUrlSetting: 'url', coreTransport: true, auth: { kind: 'none' }, settings: [],
  },
  needsWhat: 'a 3proxy installed from the Catalogue (connected by itself)',
  async isConfigured() { return (await (await import('../lib/fwdproxy')).fwdProxyService().instances()).length > 0 },
  async load(ctx: PluginContext) { return tileOf(await ctx.get('/readings')) },
  async detail(ctx: PluginContext) {
    const rows: CardRow[] = await ctx.get('/readings')
    if (!Array.isArray(rows) || !rows.length) throw notYet()
    return detailOf(rows)
  },
  async summary(ctx: PluginContext) {
    const rows: CardRow[] = await ctx.get('/readings')
    return {
      title: '3proxy',
      lines: (Array.isArray(rows) ? rows : []).map(x => x.reading
        ? `${x.name}: ${x.reading.active ? 'running' : 'not running'} on ${x.reading.listen ?? 'its LAN address'}; ${plural(x.reading.users.length, 'user')}; ${x.reading.totals.requests} requests and ${mb(x.reading.totals.bytes)} in the last ${x.reading.minutes} minutes; ${x.reading.totals.denied} refused`
        : `${x.name}: could not be read`),
    }
  },
}
