// =============================================================================
//  Plug-ins — Pi-hole and AdGuard Home
//
//  Each DNS blocker as something to look after: queries today and how many were blocked, the domains blocked most, which
//  devices ask most (hideable), whether its upstream DNS servers answer and how fast, how old its block lists are, and
//  whether blocking is on. Every problem it shows has a fix button: turn blocking back on, update the lists, switch the
//  upstream, restart the service. The logins and every action live in lib/dns-blocker; this file is the gallery card and
//  its detail, read through that module's own transport (coreTransport), so the plug-in never holds a login and the
//  generic broker never sends one.
//
//  Instances are connected by themselves when HyperProx finds them (the service scan, a Catalogue install), with the
//  password from the vault; or added by hand on the plug-in's own page.
// =============================================================================

import { PluginNotConfigured } from '../lib/plugin-host'
import type { Plugin, PluginContext, PluginDetail, PluginTileData } from '../lib/plugin-host'
import { DNS_KINDS, KIND_NAME, type DnsKind, type TileRow } from '../lib/dns-blocker/types'
import '../lib/dns-blocker'

const num = (n: number) => n.toLocaleString('en')

export function tileOf(kind: DnsKind, rows: TileRow[]): PluginTileData {
  if (!rows.length) throw new PluginNotConfigured(`Not configured yet: HyperProx connects a ${KIND_NAME[kind]} it finds by itself; none found so far.`)
  const lines = rows.map(x => {
    const r = x.reading
    if (!r) return { label: x.name, value: x.error ?? 'not reachable', tone: 'bad' as const }
    const worst = r.problems.find(p => p.severity === 'bad') ?? r.problems.find(p => p.severity === 'warn')
    if (worst) return { label: x.name, value: worst.text.replace(/\.$/, ''), tone: worst.severity === 'bad' ? 'bad' as const : 'warn' as const }
    return { label: x.name, value: `${num(r.totals.queries)} queries, ${r.totals.percentBlocked}% blocked`, tone: 'good' as const }
  })
  const bad = lines.filter(l => l.tone !== 'good')
  return {
    headline: !bad.length ? (rows.length === 1 ? lines[0].value : `${rows.length} blockers, all fine`) : rows.length === 1 ? bad[0].value : `${bad[0].label}: ${bad[0].value}${bad.length > 1 ? ` (+${bad.length - 1})` : ''}`,
    rows: lines,
    tone: lines.some(l => l.tone === 'bad') ? 'bad' : bad.length ? 'warn' : 'good',
  }
}

export function detailOf(kind: DnsKind, rows: TileRow[]): PluginDetail {
  const ok = rows.filter(r => r.reading)
  return {
    stats: ok.flatMap(r => [
      { label: `${r.name}: queries`, value: num(r.reading!.totals.queries), tone: 'good' as const },
      { label: `${r.name}: blocked`, value: `${r.reading!.totals.percentBlocked}%`, tone: 'good' as const },
      { label: `${r.name}: blocking`, value: r.reading!.protection.on ? 'on' : 'off', tone: r.reading!.protection.on ? 'good' as const : 'warn' as const },
    ]),
    tables: [{
      title: KIND_NAME[kind] + 's', empty: `No ${KIND_NAME[kind]} connected yet.`,
      columns: [{ key: 'name', label: 'Name' }, { key: 'queries', label: 'Queries', align: 'right' }, { key: 'blocked', label: 'Blocked', align: 'right' }, { key: 'blocking', label: 'Blocking' }, { key: 'problems', label: 'Needs a look', align: 'right' }],
      rows: rows.map(r => ({
        name: r.name, queries: r.reading ? num(r.reading.totals.queries) : '—', blocked: r.reading ? `${r.reading.totals.percentBlocked}%` : '—',
        blocking: r.reading ? (r.reading.protection.on ? 'on' : 'off') : r.error ?? 'not reachable', problems: r.reading ? r.reading.problems.filter(p => p.severity !== 'info').length : '—',
      })),
    }],
  }
}

function makePlugin(kind: DnsKind): Plugin {
  const name = KIND_NAME[kind]
  return {
    manifest: {
      id: kind,
      name,
      description: `Each ${name}: queries today and the share blocked, the top blocked domains and busiest devices (hideable), whether its upstream DNS servers answer and how fast, the age of its block lists and whether blocking is on, with a fix for each problem: turn blocking back on, pause it for a while, update the lists, switch the upstream, allow a domain or restart it.`,
      kind: 'device',
      icon: kind === 'pihole' ? '🛡️' : '🚫',
      baseUrlSetting: 'url',
      coreTransport: true,
      auth: { kind: 'none' },
      settings: [],
      refreshSeconds: 60,
    },
    needsWhat: `a ${name} on the cluster (connected by itself once found)`,

    async load(ctx: PluginContext): Promise<PluginTileData> {
      return tileOf(kind, await ctx.get('/readings'))
    },

    async detail(ctx: PluginContext): Promise<PluginDetail> {
      const rows: TileRow[] = await ctx.get('/readings')
      if (!Array.isArray(rows) || !rows.length) throw new PluginNotConfigured(`Not configured yet: HyperProx connects a ${name} it finds by itself; none found so far.`)
      return detailOf(kind, rows)
    },

    async summary(ctx: PluginContext) {
      const rows: TileRow[] = await ctx.get('/readings')
      return {
        title: name,
        lines: (Array.isArray(rows) ? rows : []).map(r => r.reading
          ? `${r.name}: ${num(r.reading.totals.queries)} queries, ${r.reading.totals.percentBlocked}% blocked, blocking ${r.reading.protection.on ? 'on' : 'off'}${r.reading.problems.filter(p => p.severity !== 'info').length ? `; ${r.reading.problems.filter(p => p.severity !== 'info').map(p => p.id.replace(/_/g, ' ')).join(', ')}` : ''}`
          : `${r.name}: could not be read`),
      }
    },
  }
}

export const piholePlugin: Plugin = makePlugin('pihole')
export const adguardPlugin: Plugin = makePlugin('adguard')
export const DNS_PLUGINS: Plugin[] = DNS_KINDS.map(k => (k === 'pihole' ? piholePlugin : adguardPlugin))
