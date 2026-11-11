// =============================================================================
//  Plug-in — QNAP
//
//  Each QNAP NAS as something to look at: its drive bays, volumes, shares,
//  temperatures and firmware, and a few safe things to do (refresh, a quick
//  SMART test, restart, shut down). The NAS logins, their address checks and
//  every action live in lib/qnap; this file is the gallery card and its detail,
//  read through lib/qnap's own transport (coreTransport), so the plug-in never
//  holds a login and the generic broker never sends one.
//
//  NAS are added on the plug-in's own page (Plug-ins → QNAP → Add a NAS), not
//  through settings here: like Home Assistant houses, there can be several.
// =============================================================================

import type { Plugin, PluginContext, PluginDetail, PluginTileData } from '../lib/plugin-host'
import { detailOf } from '../lib/qnap'
import type { QnapReading } from '../lib/qnap/parse'

type Row = { id: string; name: string; remote: boolean; reading: QnapReading | null; error: string | null }

function trouble(r: QnapReading): string[] {
  const out: string[] = []
  const bad = r.disks.filter(d => d.smart === 'bad' || d.smart === 'warning').length
  if (bad) out.push(`${bad} disk${bad === 1 ? '' : 's'} with a SMART warning`)
  const deg = r.volumes.filter(v => v.health === 'bad' || v.health === 'warning').length
  if (deg) out.push(`${deg} volume${deg === 1 ? '' : 's'} degraded`)
  const full = r.volumes.filter(v => v.totalBytes && v.usedBytes !== null && v.usedBytes / v.totalBytes >= 0.9).length
  if (full) out.push(`${full} volume${full === 1 ? '' : 's'} over 90% full`)
  if (r.update.available) out.push('firmware update available')
  return out
}

export const qnapPlugin: Plugin = {
  manifest: {
    id: 'qnap',
    name: 'QNAP',
    description: 'Each QNAP NAS: drive bays and SMART health, volumes, shares, temperatures and firmware, with restart and shut down behind the confirm step.',
    kind: 'device',
    icon: '🗄️',
    baseUrlSetting: 'url',
    // Logins never go through the generic broker: lib/qnap is the only transport.
    coreTransport: true,
    auth: { kind: 'none' },
    settings: [],
  },

  async load(ctx: PluginContext): Promise<PluginTileData> {
    const rows: Row[] = await ctx.get('/readings')
    if (!Array.isArray(rows) || !rows.length) throw new Error('Not configured yet: add a NAS on the QNAP page.')
    const lines = rows.map(x => {
      if (!x.reading) return { label: x.name, value: 'not reachable', tone: 'bad' as const }
      const t = trouble(x.reading)
      const used = x.reading.volumes.reduce((n, v) => n + (v.usedBytes ?? 0), 0)
      const total = x.reading.volumes.reduce((n, v) => n + (v.totalBytes ?? 0), 0)
      return { label: x.name, value: t.length ? t.join(', ') : `healthy${total ? `, ${Math.round((used / total) * 100)}% used` : ''}`, tone: (t.length ? 'warn' : 'good') as 'warn' | 'good' }
    })
    const bad = lines.filter(l => l.tone !== 'good').length
    return {
      headline: bad ? `${bad} of ${rows.length} NAS need a look` : `${rows.length} NAS, all healthy`,
      rows: lines,
      tone: lines.some(l => l.tone === 'bad') ? 'bad' : bad ? 'warn' : 'good',
    }
  },

  async detail(ctx: PluginContext): Promise<PluginDetail> {
    const rows: Row[] = await ctx.get('/readings')
    const first = (Array.isArray(rows) ? rows : []).find(r => r.reading)
    if (!first) throw new Error(rows?.length ? rows[0].error ?? 'No NAS could be read.' : 'Not configured yet: add a NAS on the QNAP page.')
    return detailOf(first.name, first.reading!)
  },
}
