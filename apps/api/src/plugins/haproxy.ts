// =============================================================================
//  Plug-in — HAProxy
//
//  Each HAProxy as a load balancer to look after: frontends, backends and
//  servers with their live state (up, down, maintenance, drain), weights,
//  sessions, request rate, errors, health checks and response times, read from
//  its Runtime API socket. Load-balancing actions (drain, maintenance, ready,
//  weight, health checks, add and remove servers, the balance algorithm) and
//  "Proxy load balancing" live on its own page; the logic is lib/haproxy, this
//  file is the gallery card, read through lib/haproxy's own transport.
//
//  Instances connect by themselves (lib/auto-connect): a Catalogue install, the
//  Proxy page's HAProxy, or one the service scan finds.
// =============================================================================

import { PluginNotConfigured } from '../lib/plugin-host'
import type { Plugin, PluginContext, PluginDetail, PluginTileData } from '../lib/plugin-host'
import type { TileRow } from '../lib/haproxy'
import '../lib/haproxy'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const NONE = 'Not configured yet: HyperProx connects a HAProxy it finds by itself (or install one from the Catalogue); none found so far.'

export function tileOf(rows: TileRow[]): PluginTileData {
  if (!rows.length) throw new PluginNotConfigured(NONE)
  const lines = rows.map(x => {
    if (!x.numbers) return { label: x.name, value: x.error ?? 'not reachable', tone: 'bad' as const }
    const n = x.numbers
    const bad = n.critical > 0 || n.down > 0 || x.configOk === false
    const value = n.critical ? `${plural(n.critical, 'backend')} with no healthy server`
      : n.down ? `${n.down} of ${plural(n.servers, 'server')} down`
      : x.configOk === false ? 'configuration fails haproxy -c'
      : `${n.up}/${n.servers} servers up · ${plural(n.backends, 'backend')}`
    return { label: x.name, value, tone: (bad ? 'bad' : n.problems ? 'warn' : 'good') as 'good' | 'warn' | 'bad' }
  })
  const bad = lines.filter(l => l.tone !== 'good')
  return {
    headline: !bad.length ? (rows.length === 1 ? lines[0].value : `${rows.length} load balancers, all healthy`) : rows.length === 1 ? bad[0].value : `${bad[0].label}: ${bad[0].value}${bad.length > 1 ? ` (+${bad.length - 1})` : ''}`,
    rows: lines,
    tone: lines.some(l => l.tone === 'bad') ? 'bad' : bad.length ? 'warn' : 'good',
  }
}

export function detailOf(rows: TileRow[]): PluginDetail {
  return {
    stats: rows.map(r => ({ label: r.name, value: r.numbers ? `${r.numbers.up}/${r.numbers.servers} up` : '—', hint: r.error ?? (r.numbers ? plural(r.numbers.backends, 'backend') : undefined),
      tone: !r.numbers ? 'bad' as const : r.numbers.critical || r.numbers.down ? 'bad' as const : r.numbers.problems ? 'warn' as const : 'good' as const })),
    tables: [{ title: 'Load balancers', empty: 'No HAProxy connected yet.', columns: [
      { key: 'name', label: 'Name' }, { key: 'backends', label: 'Backends', align: 'right' }, { key: 'up', label: 'Servers up', align: 'right' },
      { key: 'down', label: 'Down', align: 'right' }, { key: 'problems', label: 'Problems', align: 'right' }],
      rows: rows.map(r => ({ name: r.name, backends: r.numbers?.backends ?? '—', up: r.numbers ? `${r.numbers.up}/${r.numbers.servers}` : '—', down: r.numbers?.down ?? '—', problems: r.numbers?.problems ?? '—' })) }],
  }
}

export const haproxyPlugin: Plugin = {
  manifest: {
    id: 'haproxy',
    name: 'HAProxy',
    description: 'Each HAProxy load balancer, drawn as frontends, backends and servers with live state, weights, sessions, request rates, errors, health checks and response times. Drain, maintenance, weights, health checks, adding and removing servers and the balance algorithm in a click, and Proxy load balancing: spread traffic for one app across two or more guests (the Load balancing page, by contrast, moves guests between nodes).',
    kind: 'device',
    icon: '⚖️',
    baseUrlSetting: 'url',
    coreTransport: true,
    auth: { kind: 'none' },
    settings: [],
  },
  needsWhat: 'a HAProxy on the cluster (connected by itself once found, or install one from the Catalogue)',

  async load(ctx: PluginContext): Promise<PluginTileData> {
    return tileOf(await ctx.get('/readings'))
  },

  async detail(ctx: PluginContext): Promise<PluginDetail> {
    const rows: TileRow[] = await ctx.get('/readings')
    if (!Array.isArray(rows) || !rows.length) throw new PluginNotConfigured(NONE)
    return detailOf(rows)
  },

  async summary(ctx: PluginContext) {
    const rows: TileRow[] = await ctx.get('/readings')
    return {
      title: 'HAProxy',
      lines: (Array.isArray(rows) ? rows : []).map(r => r.numbers
        ? `${r.name}: ${r.numbers.backends} backends, ${r.numbers.up} of ${r.numbers.servers} servers up, ${r.numbers.down} down, ${r.numbers.problems} problems${r.configOk === false ? ', configuration fails haproxy -c' : ''}`
        : `${r.name}: could not be read`),
    }
  },
}
