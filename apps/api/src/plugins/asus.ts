// =============================================================================
//  Plug-in — ASUS router (stock Asuswrt and Asuswrt-Merlin)
//
//  Router visibility without Home Assistant: the model and firmware, the
//  internet connection and its live rates, each Wi-Fi band, and who is
//  connected. Talks to the router's own web API (the one the ASUS phone app
//  uses). The router logins, their address and certificate checks, and the one
//  action (reboot) live in lib/asus; this file is the gallery card, its detail
//  and the AI page's summary, read through lib/asus's own transport
//  (coreTransport), so the plug-in never holds a login and the generic broker
//  never sends one. What it reads is always the viewer's shape: no MAC
//  addresses, client addresses or WAN address.
//
//  Routers are added on the plug-in's own page (Plug-ins → ASUS → Add a
//  router): the address, the admin user and its password, nothing more.
// =============================================================================

import type { Plugin, PluginContext, PluginDetail, PluginTileData } from '../lib/plugin-host'
import { detailOf, mbps, duration, type ReadingRow } from '../lib/asus'

async function rows(ctx: PluginContext): Promise<ReadingRow[]> {
  const r: ReadingRow[] = await ctx.get('/readings')
  if (!Array.isArray(r) || !r.length) throw new Error('Not configured yet: add a router on the ASUS page.')
  return r
}

export const asusPlugin: Plugin = {
  manifest: {
    id: 'asus',
    name: 'ASUS',
    description: 'ASUS routers on stock firmware or Merlin: internet status and live rates, Wi-Fi bands, connected devices and health, with reboot behind the confirm step.',
    kind: 'device',
    icon: '📶',
    baseUrlSetting: 'url',
    // Logins never go through the generic broker: lib/asus is the only transport.
    coreTransport: true,
    auth: { kind: 'none' },
    settings: [],
    refreshSeconds: 10,
  },

  async load(ctx: PluginContext): Promise<PluginTileData> {
    const list = await rows(ctx)
    const lines = list.map(x => {
      if (!x.reading) return { label: x.name, value: 'not reachable', tone: 'bad' as const }
      const r = x.reading
      const why = r.health.reasons
      const wan = r.wan.up === false ? 'internet down' : r.wan.downBps !== null ? `↓ ${mbps(r.wan.downBps)} ↑ ${mbps(r.wan.upBps)}` : 'online'
      return { label: x.name, value: why.length ? why.map(s => s.replace(/\.$/, '')).join(', ') : `${wan}, ${r.devices.length} devices`,
        tone: (r.wan.up === false ? 'bad' : why.length ? 'warn' : 'good') as 'bad' | 'warn' | 'good' }
    })
    const bad = lines.filter(l => l.tone !== 'good').length
    return {
      headline: bad ? `${bad} of ${list.length} router${list.length === 1 ? '' : 's'} need${bad === 1 ? 's' : ''} attention` : `${list.length} router${list.length === 1 ? '' : 's'}, all healthy`,
      rows: lines,
      tone: lines.some(l => l.tone === 'bad') ? 'bad' : bad ? 'warn' : 'good',
    }
  },

  async detail(ctx: PluginContext): Promise<PluginDetail> {
    const list = await rows(ctx)
    const first = list.find(r => r.reading)
    if (!first) throw new Error(list[0].error ?? 'No router could be read.')
    return detailOf(first.name, first.reading!)
  },

  /** Read-only, and viewer-shaped for everyone: the AI page never sees a MAC or an address. */
  async summary(ctx: PluginContext): Promise<{ title: string; lines: string[] }> {
    const list = await rows(ctx)
    const lines: string[] = []
    for (const x of list) {
      const r = x.reading
      if (!r) { lines.push(`${x.name}: not reachable (${x.error ?? 'no answer'})`); continue }
      lines.push(`${x.name}: ${r.health.level === 'good' ? 'healthy' : `needs attention: ${r.health.reasons.join(' ')}`}`)
      lines.push(`${x.name} is a ${r.model ?? 'ASUS router'} on ${r.firmware.flavour === 'merlin' ? 'Asuswrt-Merlin' : 'Asuswrt'} ${r.firmware.version ?? ''}`.trim() +
        `${r.update.available ? `, update ${r.update.version ?? ''} available`.trimEnd() : ''}, up ${duration(r.uptimeSec)}.`)
      lines.push(`${x.name} internet: ${r.wan.up === null ? 'unknown' : r.wan.up ? 'connected' : 'down'}${r.wan.downBps !== null ? `, ${mbps(r.wan.downBps)} down and ${mbps(r.wan.upBps)} up right now` : ''}.`)
      if (r.cpuPct !== null || r.mem) lines.push(`${x.name} load: CPU ${r.cpuPct ?? '—'}%, memory ${r.mem?.pct ?? '—'}%.`)
      for (const b of r.bands) lines.push(`${x.name} Wi-Fi ${b.label}${b.ssid ? ` "${b.ssid}"` : ''}: ${b.enabled ? `channel ${b.channel ?? '—'}, ${b.clients} client${b.clients === 1 ? '' : 's'}` : 'off'}.`)
      const wired = r.devices.filter(d => d.connection === 'wired').length
      lines.push(`${x.name} devices online: ${r.devices.length} (${wired} wired, ${r.devices.length - wired} on Wi-Fi).`)
      const named = r.devices.slice(0, 25).map(d => `${d.name} (${d.connection === 'wired' ? 'wired' : d.band ?? 'Wi-Fi'})`)
      if (named.length) lines.push(`${x.name} online: ${named.join(', ')}${r.devices.length > 25 ? ', …' : ''}.`)
    }
    return { title: 'ASUS', lines }
  },
}
