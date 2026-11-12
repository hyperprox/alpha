// =============================================================================
//  Plug-in — Proxmox Backup Server
//
//  Each backup server as something to look at: datastores with their use,
//  deduplication and GC, every backup group's newest snapshot (stale ones in
//  red), the prune, GC, verify and sync jobs, and the failed tasks of the last
//  day; with "verify now" behind the master password (GC keeps its own schedule). The tokens,
//  their pins and both actions live in lib/pbs; this file is the gallery card
//  and its health, read through lib/pbs's own transport (coreTransport), so the
//  plug-in never holds a token and the generic broker never sends one.
//
//  Servers are added on the plug-in's own page (Add a backup server), not
//  through settings here.
// =============================================================================

import type { Plugin, PluginContext, PluginDetail, PluginTileData } from '../lib/plugin-host'
import { detailOf, type ReadingRow } from '../lib/pbs'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The card: "Active" means every datastore under 85%, nothing stale and no failure in 24 h, on every server. */
export function tileOf(rows: ReadingRow[]): PluginTileData {
  if (!rows.length) throw new Error('Not configured yet: add a backup server on the Proxmox Backup Server page.')
  const lines = rows.map(x => {
    if (!x.reading) return { label: x.name, value: 'not reachable', tone: 'bad' as const }
    const h = x.reading.health
    const ds = x.reading.datastores
    return {
      label: x.name,
      value: h.state === 'active' ? `active, ${plural(ds.length, 'datastore')}, ${plural(x.reading.groups.length, 'group')}` : h.reason!,
      tone: (h.state === 'active' ? 'good' : x.reading.groups.some(g => g.stale) || x.reading.datastores.some(d => d.error) ? 'bad' : 'warn') as 'good' | 'warn' | 'bad',
    }
  })
  const bad = lines.filter(l => l.tone !== 'good')
  return {
    // The dashboard chip shows the headline after "Needs attention:", so it is the reason itself.
    headline: !bad.length ? (rows.length === 1 ? 'all backups fresh' : `${rows.length} servers, all fresh`)
      : rows.length === 1 ? bad[0].value : `${bad[0].label}: ${bad[0].value}${bad.length > 1 ? ` (+${bad.length - 1})` : ''}`,
    rows: lines,
    tone: lines.some(l => l.tone === 'bad') ? 'bad' : bad.length ? 'warn' : 'good',
  }
}

export const pbsPlugin: Plugin = {
  manifest: {
    id: 'pbs',
    // Named as the wishlist names it, so the idea leaves the "not built yet" list.
    name: 'Proxmox Backup Server',
    description: 'Each backup server: datastores (use, deduplication, GC), every backup group with its newest snapshot and verify state, prune/GC/verify/sync jobs and failed tasks, with verify now behind the master password. It never prunes, forgets or deletes.',
    kind: 'device',
    icon: '🛡️',
    baseUrlSetting: 'url',
    coreTransport: true,
    auth: { kind: 'none' },
    settings: [],
  },

  async load(ctx: PluginContext): Promise<PluginTileData> {
    return tileOf(await ctx.get('/readings'))
  },

  async detail(ctx: PluginContext): Promise<PluginDetail> {
    const rows: ReadingRow[] = await ctx.get('/readings')
    const first = (Array.isArray(rows) ? rows : []).find(r => r.reading)
    if (!first) throw new Error(rows?.length ? rows[0].error ?? 'No backup server could be read.' : 'Not configured yet: add a backup server on the Proxmox Backup Server page.')
    return detailOf(first.name, first.reading!)
  },
}
