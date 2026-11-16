// =============================================================================
//  Plug-in — K3s (lightweight Kubernetes)
//
//  Each K3s cluster as something to look after: its nodes (ready, version, CPU
//  and memory), namespaces, workloads with desired against ready, the pods in
//  trouble (CrashLoopBackOff, an image that cannot be pulled, Pending and why,
//  restarting) with their reason and last log lines, recent warning events,
//  services and ingresses with their addresses, and whether a newer K3s exists.
//  Every problem has a fix: restart or roll back a workload, scale it, delete a
//  stuck pod, cordon, uncordon or drain a node, read the logs.
//
//  The tokens, the actions and auto-connect live in lib/k3s; this file is the
//  gallery card and its health, read through lib/k3s's own transport
//  (coreTransport), so the plug-in never holds a token. Clusters are connected
//  by the Catalogue install or by auto-connect; the K3s page asks for a
//  kubeconfig only when neither could find one.
// =============================================================================

import { PluginNotConfigured } from '../lib/plugin-host'
import type { Plugin, PluginContext, PluginDetail, PluginTileData } from '../lib/plugin-host'
import type { TileRow } from '../lib/k3s/service'
import '../lib/k3s'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const NOT_YET = 'Not configured yet: install K3s from the Catalogue, or HyperProx connects a K3s server it finds by itself.'

export function tileOf(rows: TileRow[]): PluginTileData {
  if (!rows.length) throw new PluginNotConfigured(NOT_YET)
  const lines = rows.map(x => {
    const r = x.reading
    if (!r) return { label: x.name, value: x.error ?? 'not reachable', tone: 'bad' as const }
    const ready = r.nodes.filter(n => n.ready).length
    const value = r.health.state === 'ok'
      ? `${ready}/${r.nodes.length} ${r.nodes.length === 1 ? 'node' : 'nodes'} ready, ${plural(r.counts.running, 'pod')} running${r.version.upgrade ? `, ${r.version.upgrade} available` : ''}`
      : r.health.reasons.join(', ')
    return { label: x.name, value, tone: (r.health.state === 'bad' ? 'bad' : r.health.state === 'attention' ? 'warn' : 'good') as 'good' | 'warn' | 'bad' }
  })
  const bad = lines.filter(l => l.tone !== 'good')
  return {
    headline: !bad.length ? (rows.length === 1 ? lines[0].value : `${rows.length} clusters, all healthy`)
      : rows.length === 1 ? bad[0].value : `${bad[0].label}: ${bad[0].value}${bad.length > 1 ? ` (+${bad.length - 1})` : ''}`,
    rows: lines,
    tone: lines.some(l => l.tone === 'bad') ? 'bad' : bad.length ? 'warn' : 'good',
  }
}

export function detailOf(rows: TileRow[]): PluginDetail {
  return {
    stats: rows.map(r => ({ label: r.name, value: r.reading?.version.current ?? '—', hint: r.reading ? (r.reading.health.reasons[0] ?? 'healthy') : r.error ?? undefined,
      tone: !r.reading || r.reading.health.state === 'bad' ? 'bad' as const : r.reading.health.state === 'attention' ? 'warn' as const : 'good' as const })),
    tables: rows.filter(r => r.reading).map(r => ({ title: `${r.name}: nodes`, empty: 'No nodes.', columns: [
      { key: 'name', label: 'Node' }, { key: 'ready', label: 'Ready' }, { key: 'version', label: 'Version' }, { key: 'pods', label: 'Pods', align: 'right' as const }],
      rows: r.reading!.nodes.map(n => ({ name: n.name, ready: n.ready ? 'yes' : `no: ${n.reason ?? ''}`, version: n.version ?? '—', pods: n.pods })) })),
  }
}

export const k3sPlugin: Plugin = {
  manifest: {
    id: 'k3s',
    name: 'K3s',
    description: 'Each K3s cluster: nodes with CPU and memory, namespaces, workloads (desired against ready), pods in CrashLoopBackOff, pending or restarting with the reason and their last log lines, warning events, services and ingresses, and whether a newer K3s exists. Fix buttons restart, roll back or scale a workload, delete a stuck pod and cordon, uncordon or drain a node, each confirmed. Reads with a read-only account; actions with a separate one.',
    kind: 'device',
    icon: '☸️',
    baseUrlSetting: 'url',
    coreTransport: true,
    auth: { kind: 'none' },
    settings: [],
  },
  needsWhat: 'a K3s cluster (installed from the Catalogue, or found and connected by itself)',

  async load(ctx: PluginContext): Promise<PluginTileData> {
    return tileOf(await ctx.get('/readings'))
  },

  async detail(ctx: PluginContext): Promise<PluginDetail> {
    const rows: TileRow[] = await ctx.get('/readings')
    if (!Array.isArray(rows) || !rows.length) throw new PluginNotConfigured(NOT_YET)
    return detailOf(rows)
  },

  async summary(ctx: PluginContext) {
    const rows: TileRow[] = await ctx.get('/readings')
    return {
      title: 'K3s',
      lines: (Array.isArray(rows) ? rows : []).map(r => r.reading
        ? `${r.name}: ${r.reading.version.current ?? 'K3s'}, ${r.reading.nodes.filter(n => n.ready).length} of ${r.reading.nodes.length} nodes ready, ${r.reading.counts.running} pods running; ${r.reading.health.reasons.length ? r.reading.health.reasons.join(', ') : 'healthy'}${r.reading.version.upgrade ? `; ${r.reading.version.upgrade} available` : ''}`
        : `${r.name}: could not be read`),
    }
  },
}
