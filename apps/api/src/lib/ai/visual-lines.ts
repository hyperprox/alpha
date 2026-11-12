// =============================================================================
//  HyperProx — a plug-in's visual reading, in words
//
//  Plex now playing, the arr pipeline, Unmanic's workers, the router and
//  MeshCentral each return their page's figures as a typed `visual` object
//  (lib/plugin-visual-types.ts). These lines say the same in plain sentences,
//  worked out by code, so the assistant answers from the page's own numbers.
//  No address, port forward, MAC or log line is put in, and every line also
//  goes through stripAddresses.
// =============================================================================

import type { PluginVisual } from '../plugin-visual-types'
import { stripAddresses } from '../redact-addresses'

const mbps = (bps: number | null | undefined) => (bps == null ? 'unknown' : `${(bps * 8 / 1e6).toFixed(1)} Mb/s`)
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

export function visualLines(v: PluginVisual): string[] {
  const out: string[] = []
  switch (v.kind) {
    case 'plex': {
      out.push(`${plural(v.counts.streams, 'stream')} now: ${v.counts.transcodes} transcoding, ${v.counts.direct} direct; ${v.bandwidth.totalMbps} Mb/s.`)
      for (const s of v.sessions.slice(0, 10)) {
        const what = `${s.title}${s.number ? ` ${s.number}` : ''}${s.episode ? ` "${s.episode}"` : ''}`
        out.push(`${s.user} is watching ${what} on ${s.player}: ${s.mode}, ${s.state}, ${Math.round(s.progress)}%, ${s.quality}.`)
      }
      if (v.needsPlex) out.push('Only Tautulli is set up: add the Plex server address and token to the Plex plug-in for live data straight from Plex.')
      if (v.topWatchers.length) {
        out.push(v.topBy === 'plays'
          ? `Most watching in 30 days, by plays (Plex keeps no watch time): ${v.topWatchers.slice(0, 5).map(w => `${w.user} ${plural(w.plays, 'play')}`).join(', ')}.`
          : `Most watching in 30 days: ${v.topWatchers.slice(0, 5).map(w => `${w.user} ${Math.round(w.minutes / 60)} h`).join(', ')}.`)
      }
      if (v.libraries?.length) out.push(`Libraries: ${v.libraries.map(l => `${l.title} ${l.count}`).join(', ')}.`)
      if (v.topTitles.length) out.push(`Most played in 30 days: ${v.topTitles.slice(0, 5).map(t => `${t.title} (${t.plays})`).join(', ')}.`)
      break
    }
    case 'arrstack': {
      const p = v.pipeline
      out.push(`Indexers ${p.indexersOn} of ${p.indexersTotal} on, ${p.indexersFailing} failing; ${p.queued} queued, ${p.downloading} downloading, ${p.stalled} stalled, ${p.seeding} seeding, ${p.importBlocked} imports blocked; down ${mbps(p.downBps)}, up ${mbps(p.upBps)}.`)
      for (const d of v.downloads.slice(0, 8)) out.push(`Download ${d.name}: ${d.state}, ${Math.round(d.progress)}%.`)
      for (const b of v.blocked.slice(0, 6)) out.push(`Import blocked in ${b.service}: ${b.title} (${b.reason}).`)
      const failing = v.indexers.filter(i => i.state === 'failing')
      if (failing.length) out.push(`Failing indexers: ${failing.map(i => i.name).join(', ')}.`)
      for (const h of v.health.slice(0, 6)) out.push(`${h.service} ${h.level}: ${h.message}`)
      if (v.music) out.push(`Music (Lidarr): ${plural(v.music.artists, 'artist')}, ${plural(v.music.albums, 'album')}, ${plural(v.music.tracks, 'track')} on disk${v.music.missingAlbums !== null ? `, ${plural(v.music.missingAlbums, 'monitored album')} missing` : ''}.`)
      const down = v.services.filter(s => !s.up)
      out.push(down.length ? `Not answering: ${down.map(s => s.name).join(', ')}.` : `All ${plural(v.services.length, 'service')} answer.`)
      break
    }
    case 'unmanic': {
      const t = v.totals
      out.push(`Workers: ${t.busy} busy, ${t.idle} idle, ${t.paused} paused of ${t.slots}; ${t.pending} files waiting.`)
      for (const w of v.workers) {
        out.push(`${w.name}: ${w.up ? `${w.busy} busy, ${w.pending} waiting` : 'not answering'}.`)
        for (const e of w.encoding.slice(0, 4)) out.push(`${w.name} is encoding ${e.file}${e.progress !== null ? ` (${Math.round(e.progress)}%)` : ''}.`)
      }
      break
    }
    case 'mikrotik': {
      out.push(`${v.router.name} (${v.router.model}, RouterOS ${v.router.version}), up ${v.router.uptime}.`)
      out.push(`Internet now: down ${mbps(v.total.downBps / 8)}, up ${mbps(v.total.upBps / 8)}` + (v.wans.length > 1 ? ` across ${v.wans.map(w => w.name).join(', ')}.` : '.'))
      out.push(`CPU ${v.health.cpuPct}%, memory ${v.health.memPct}%${v.health.tempC !== null ? `, ${v.health.tempC} °C` : ''}.`)
      const named = v.talkers.filter(t => t.name).slice(0, 5)
      if (named.length) out.push(`Busiest devices: ${named.map(t => `${t.name} (down ${mbps(t.downBps / 8)})`).join(', ')}.`)
      out.push(`${plural(v.forwardsActive, 'port forward')} in use.`)
      break
    }
    case 'meshcentral': {
      if (!v.connected) out.push(`Not connected to MeshCentral yet: ${v.needs.join(' ') || 'nothing to show'}`)
      else out.push(`${plural(v.devices?.length ?? 0, 'device')}, ${v.devices?.filter(d => d.online).length ?? 0} online.`)
      break
    }
  }
  return out.map(l => stripAddresses(l).replace(/\s+/g, ' ').trim())
}
