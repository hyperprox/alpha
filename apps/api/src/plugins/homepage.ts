// =============================================================================
//  Plug-in — Homepage (gethomepage.dev)
//
//  Fills a Homepage dashboard with what HyperProx knows runs on the cluster, and
//  keeps it in sync when asked. The finding, previewing, writing and fixing live
//  in lib/homepage and its page (/plugins/homepage); this file is the gallery
//  card, read through lib/homepage's own read-only transport (coreTransport), so
//  the plug-in never reaches a guest itself.
// =============================================================================

import { PluginNotConfigured } from '../lib/plugin-host'
import type { Plugin, PluginContext, PluginTileData } from '../lib/plugin-host'

type Row = { id: string; name: string; url: string | null; autoSync: boolean; entries: number; lastSync: { at: number; ok: boolean; message: string } | null }

export function tileOf(rows: Row[]): PluginTileData {
  if (!rows.length) throw new PluginNotConfigured('Not configured yet: HyperProx connects a Homepage it finds by itself; none found so far.')
  const lines = rows.map(r => ({
    label: r.name,
    value: !r.lastSync ? 'not filled yet' : r.lastSync.ok ? `${r.entries} entr${r.entries === 1 ? 'y' : 'ies'}${r.autoSync ? ', auto-sync on' : ''}` : r.lastSync.message.slice(0, 120),
    tone: (!r.lastSync ? 'warn' : r.lastSync.ok ? 'good' : 'bad') as 'good' | 'warn' | 'bad',
  }))
  const bad = lines.filter(l => l.tone !== 'good')
  return {
    headline: bad.length ? (rows.length === 1 ? bad[0].value : `${bad.length} of ${rows.length} dashboards need a look`) : rows.length === 1 ? lines[0].value : `${rows.length} dashboards in sync`,
    rows: lines,
    tone: lines.some(l => l.tone === 'bad') ? 'bad' : bad.length ? 'warn' : 'good',
  }
}

export const homepagePlugin: Plugin = {
  manifest: {
    id: 'homepage',
    name: 'Homepage',
    description: 'Fills a Homepage dashboard (gethomepage.dev) with every service on the cluster, grouped, with links and up/down dots, and keeps it in sync. Your own groups and edits are kept; every write is previewed as a diff and backed up first.',
    kind: 'device',
    icon: '🏠',
    baseUrlSetting: 'url',
    coreTransport: true,
    auth: { kind: 'none' },
    settings: [],
  },
  needsWhat: 'a Homepage on the cluster (connected by itself once found)',
  // Loaded when asked, so the plug-in list does not pull in the executor and inventory at import time.
  async isConfigured() { return (await (await import('../lib/homepage')).homepageService().instances()).length > 0 },
  async load(ctx: PluginContext): Promise<PluginTileData> { return tileOf(await ctx.get('/readings')) },
}
