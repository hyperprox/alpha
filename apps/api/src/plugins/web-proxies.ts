// =============================================================================
//  Plug-ins — NGINX, Caddy and Envoy
//
//  Each proxy as something to look after. NGINX: its status page (connections,
//  requests), its sites and upstreams, nginx -t, certificates and the error
//  rate. Caddy: its admin API, routes, upstream health and certificates. Envoy:
//  clusters and their hosts' health, listeners, requests and 5xx. Every problem
//  shown has its fix (reload, test, start, renew, retry certificates, drain),
//  admin only, confirmed and audited. The reading and the actions live in
//  lib/webproxy, which reaches each container through the remote executor;
//  these cards read through its own transport (coreTransport), so a plug-in
//  never enters a guest itself.
//
//  Proxies are connected by themselves once found (a Catalogue install, the
//  Catalogue's detection, the install marker), not through settings here.
// =============================================================================

import { PluginNotConfigured } from '../lib/plugin-host'
import type { Plugin, PluginContext, PluginDetail, PluginTileData } from '../lib/plugin-host'

type Row = { label: string; value: string; tone: 'good' | 'warn' | 'bad'; problems: number; ok: boolean }

export function tileOf(name: string, rows: Row[]): PluginTileData {
  if (!rows.length) throw new PluginNotConfigured(`Not configured yet: HyperProx connects ${name === 'Envoy' ? 'an' : 'a'} ${name} it finds by itself (install one from the Catalogue); none found so far.`)
  const bad = rows.filter(r => r.tone !== 'good')
  return {
    headline: !bad.length ? (rows.length === 1 ? rows[0].value : `${rows.length} proxies, all fine`)
      : rows.length === 1 ? bad[0].value : `${bad[0].label}: ${bad[0].value}${bad.length > 1 ? ` (+${bad.length - 1})` : ''}`,
    rows: rows.map(r => ({ label: r.label, value: r.value, tone: r.tone })),
    tone: rows.some(r => r.tone === 'bad') ? 'bad' : bad.length ? 'warn' : 'good',
  }
}

/** The plain view (the AI page and anything without the visual page): one figure and one row per proxy. */
export function detailOf(name: string, rows: Row[]): PluginDetail {
  if (!rows.length) tileOf(name, rows)
  return {
    stats: rows.map(r => ({ label: r.label, value: r.tone === 'good' ? 'healthy' : r.tone === 'warn' ? 'needs a look' : 'needs a fix', hint: r.value, tone: r.tone })),
    tables: [{ title: 'Proxies', empty: `No ${name} connected yet.`, columns: [{ key: 'name', label: 'Name' }, { key: 'state', label: 'State' }, { key: 'problems', label: 'Problems', align: 'right' }],
      rows: rows.map(r => ({ name: r.label, state: r.value, problems: r.problems })) }],
  }
}

function webProxyPlugin(id: 'nginx' | 'caddy' | 'envoy', name: string, icon: string, description: string): Plugin {
  return {
    manifest: { id, name, description, kind: 'device', icon, baseUrlSetting: 'url', coreTransport: true, auth: { kind: 'none' }, settings: [] },
    needsWhat: `${name === 'Envoy' ? 'an' : 'a'} ${name} on the cluster (connected by itself once found)`,
    // Loaded when asked, so the plug-in list does not pull in the executor at import time.
    async isConfigured() { return (await (await import('../lib/webproxy')).webProxyService().instances(id)).length > 0 },
    async load(ctx: PluginContext): Promise<PluginTileData> { return tileOf(name, await ctx.get('/readings')) },
    async detail(ctx: PluginContext): Promise<PluginDetail> { return detailOf(name, await ctx.get('/readings')) },
    async summary(ctx: PluginContext) {
      const rows: Row[] = await ctx.get('/readings')
      return { title: name, lines: (Array.isArray(rows) ? rows : []).map(r => `${r.label}: ${r.value}${r.problems ? ` (${r.problems} problem${r.problems === 1 ? '' : 's'})` : ''}`) }
    },
  }
}

export const nginxPlugin = webProxyPlugin('nginx', 'NGINX', '🟩',
  'Each NGINX: connections and requests from its status page, every site and upstream, the nginx -t result, certificate expiry and the error rate of the last five minutes. Reload, test the configuration, start it, turn the status page on, renew certificates (with certbot).')
export const caddyPlugin = webProxyPlugin('caddy', 'Caddy', '🔒',
  'Each Caddy: its routes and where they forward, each upstream’s requests and failures, and every certificate with its expiry or the names still waiting for one. Reload, retry certificates, start it. The admin API stays on the container’s loopback.')
export const envoyPlugin = webProxyPlugin('envoy', 'Envoy', '🛰️',
  'Each Envoy: its clusters and every host’s health, its listeners, requests and 5xx since it started. Drain and undrain it, reload its listener and cluster files, start it. The admin stays on the container’s loopback.')
