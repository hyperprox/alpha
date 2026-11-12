'use client'

// =============================================================================
//  HyperProx — ASUS router: the visual pieces of one router
//
//  The internet connection (state, address for operators, live down/up meters
//  with a short trail), one tile per Wi-Fi band, the health list, and the
//  connected devices with their connection, signal and online time. Every
//  piece says its reading in words as well as colour, and no label is drawn
//  over a line.
// =============================================================================

import { useState } from 'react'
import { Icon, duration, niceMax, type StatChip } from '@/components/visual/kit'
import a from './asus.module.css'

export interface Band { unit: number; label: string; ssid: string | null; channel: string | null; widthMhz: number | null; enabled: boolean; clients: number }
export interface Device {
  key: string; name: string; ip: string | null; mac: string | null; vendor: string | null
  connection: 'wired' | 'wifi'; band: string | null; rssi: number | null; bars: number | null; onlineSec: number | null
  node?: string | null
}
export interface MeshNode {
  key: string; name: string; model: string | null; firmware: string | null; update: string | null; main: boolean; online: boolean
  backhaul: string | null; rssi: number | null; bars: number | null; clients: number; ip: string | null
}
export interface Mode { kind: 'router' | 'ap' | 'repeater' | 'bridge' | 'node' | null; label: string | null; aimesh: 'main' | 'node' | null }
export interface Reading {
  fetchedAt: string
  /** Absent from an API older than mode detection. */
  mode?: Mode
  uplink?: { gateway: string | null } | null
  model: string | null
  firmware: { version: string | null; flavour: 'merlin' | 'stock' | null }
  update: { available: boolean | null; version: string | null }
  uptimeSec: number | null
  cpuPct: number | null; cpuCores: number | null
  mem: { totalKiB: number; usedKiB: number; pct: number } | null
  wan: { up: boolean | null; status: string | null; type: string | null; ip: string | null; gateway: string | null; unit: number | null; downBps: number | null; upBps: number | null }
  bands: Band[]
  /** Absent from an API older than the mesh view. */
  mesh?: MeshNode[]
  devices: Device[]
  offlineKnown: number
  health: { level: 'good' | 'attention'; reasons: string[] }
  missing: string[]
}

export function mbpsText(bps: number | null): string {
  if (bps === null) return '—'
  const m = bps / 1_000_000
  return m >= 100 ? m.toFixed(0) : m >= 10 ? m.toFixed(1) : m.toFixed(2)
}

/** Only a router has a WAN of its own; everything else gets the internet from upstream. */
export const routes = (r: Reading) => !r.mode || r.mode.kind === null || r.mode.kind === 'router'

export function hudChips(r: Reading): StatChip[] {
  return [
    ...(r.mode?.label ? [{ label: 'mode', value: r.mode.label, tone: 'accent' as const }] : []),
    { label: 'health', value: r.health.level === 'good' ? 'healthy' : 'needs attention', tone: r.health.level === 'good' ? 'good' : 'warn' },
    { label: r.firmware.flavour === 'merlin' ? 'Merlin firmware' : 'firmware', value: r.firmware.version ?? '—', tone: r.update.available ? 'warn' : 'dim' },
    { label: 'uptime', value: duration(r.uptimeSec), tone: 'dim' },
    { label: r.cpuCores ? `CPU · ${r.cpuCores} cores` : 'CPU', value: r.cpuPct === null ? '—' : `${Math.round(r.cpuPct)}%`, tone: r.cpuPct !== null && r.cpuPct >= 90 ? 'crit' : 'accent' },
    { label: 'RAM', value: r.mem ? `${r.mem.pct}%` : '—', tone: r.mem && r.mem.pct >= 92 ? 'crit' : 'violet' },
  ]
}

// ── internet ─────────────────────────────────────────────────────────────────

function Rate({ dir, bps, trail }: { dir: 'down' | 'up'; bps: number | null; trail: number[] }) {
  const max = niceMax(Math.max(...trail, bps ?? 0, 1_000_000) / 1_000_000, 10) * 1_000_000
  const frac = bps === null ? 0 : Math.min(1, bps / max)
  const word = dir === 'down' ? 'Download' : 'Upload'
  return (
    <div className={a.rate} data-dir={dir} role="group" aria-label={`${word}: ${bps === null ? 'not measured yet' : `${mbpsText(bps)} megabits per second`}`}>
      <span className={a.rateHead} aria-hidden>{dir === 'down' ? '↓' : '↑'} {word}</span>
      <span className={a.rateValue} aria-hidden>{mbpsText(bps)}<small>Mbps</small></span>
      <span className={a.meter} aria-hidden><i style={{ width: `${frac * 100}%` }} /></span>
      <span className={a.trail} aria-hidden>
        {trail.slice(-24).map((v, i) => <i key={i} style={{ height: `${Math.max(2, Math.round((v / max) * 22))}px` }} />)}
      </span>
    </div>
  )
}

export function WanPanel({ r, trail }: { r: Reading; trail: { down: number[]; up: number[] } }) {
  const w = r.wan
  const word = w.up === null ? 'Unknown' : w.up ? 'Connected' : 'Down'
  return (
    <div className={a.wan}>
      <div className={a.wanState} data-up={w.up === null ? undefined : String(w.up)}>
        <span className={a.wanWord}><i aria-hidden />{word}</span>
        <dl className={a.kv}>
          {w.status && w.status.toLowerCase() !== word.toLowerCase() && <><dt>Router says</dt><dd>{w.status}</dd></>}
          {w.type && <><dt>Type</dt><dd>{w.type.toUpperCase()}</dd></>}
          {w.ip && <><dt>Address</dt><dd className="font-mono">{w.ip}</dd></>}
          {w.gateway && <><dt>Gateway</dt><dd className="font-mono">{w.gateway}</dd></>}
        </dl>
      </div>
      <div className={a.rates}>
        <Rate dir="down" bps={w.downBps} trail={trail.down} />
        <Rate dir="up" bps={w.upBps} trail={trail.up} />
      </div>
    </div>
  )
}

/** An access point, repeater, bridge or mesh node: nothing is wrong with a WAN it does not use. */
export function UplinkPanel({ r }: { r: Reading }) {
  const what = r.mode?.kind === 'node' ? 'AiMesh node' : r.mode?.kind === 'repeater' ? 'Repeater' : r.mode?.kind === 'bridge' ? 'Media bridge' : 'Access point'
  return (
    <div className={a.wanState} data-up="true">
      <span className={a.wanWord}><i aria-hidden />{what}</span>
      <p className="text-sm" style={{ color: 'var(--text-soft)', margin: 0 }}>
        The internet is handled by your main router. This unit passes it on{r.mode?.aimesh === 'main' ? ' and leads the AiMesh network' : ''}, so it has no internet connection of its own to watch.
      </p>
      {r.uplink?.gateway && <dl className={a.kv}><dt>Upstream</dt><dd className="font-mono">{r.uplink.gateway}</dd></dl>}
    </div>
  )
}

// ── wi-fi ────────────────────────────────────────────────────────────────────

function Waves() {
  return (
    <svg className={a.waves} width="34" height="26" viewBox="0 0 34 26" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
      <path d="M13 17a6 6 0 0 1 8 0" /><path d="M9 13a12 12 0 0 1 16 0" /><path d="M5 9a18 18 0 0 1 24 0" />
      <circle cx="17" cy="21" r="1.8" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function BandTiles({ bands }: { bands: Band[] }) {
  if (!bands.length) return <p className="text-sm" style={{ color: 'var(--text-muted)' }}>The router reported no radios.</p>
  return (
    <ul className={a.bands} aria-label="Wi-Fi bands" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {bands.map(b => (
        <li key={b.unit} className={a.band} data-on={String(b.enabled)}
          aria-label={`${b.label}: ${b.enabled ? `${b.ssid ?? 'no name'}, channel ${b.channel ?? 'not reported'}, ${b.clients} client${b.clients === 1 ? '' : 's'}` : 'radio off'}`}>
          <span className={a.bandTop}><span className={a.bandName}>{b.label}</span><Waves /></span>
          <span className={a.ssid}>{b.ssid ?? 'No network name'}</span>
          <span className={a.bandRow}><span>channel</span><b>{b.enabled ? (b.channel ?? '—') : 'off'}</b></span>
          <span className={a.bandRow}><span>width</span><b>{b.widthMhz ? `${b.widthMhz} MHz` : '—'}</b></span>
          <span className={a.clients}><b>{b.enabled ? b.clients : '—'}</b><span>{b.enabled ? `client${b.clients === 1 ? '' : 's'}` : 'radio off'}</span></span>
        </li>
      ))}
    </ul>
  )
}

// ── health ───────────────────────────────────────────────────────────────────

export function HealthList({ r }: { r: Reading }) {
  if (r.health.level === 'good') {
    return <p className={a.allGood}><Icon name="check" size={18} /> Nothing needs attention.</p>
  }
  return (
    <ul className={a.health} aria-label="Needs attention">
      {r.health.reasons.map(x => <li key={x}><Icon name="warn" size={16} />{x}</li>)}
    </ul>
  )
}

// ── devices ──────────────────────────────────────────────────────────────────

function Signal({ d }: { d: { bars: number | null; rssi: number | null } }) {
  if (d.bars === null) return null
  const tone = d.bars >= 3 ? 'good' : d.bars === 2 ? 'warn' : 'bad'
  const word = ['very weak', 'weak', 'fair', 'good', 'excellent'][d.bars]
  return (
    <span className={a.signal}>
      <span className={a.bars} data-tone={tone} aria-hidden>{[1, 2, 3, 4].map(i => <i key={i} data-on={String(i <= d.bars!)} />)}</span>
      <span>{d.rssi !== null ? `${d.rssi} dBm` : ''} · {word}</span>
    </span>
  )
}

export function DeviceList({ devices, bands, offline }: { devices: Device[]; bands: Band[]; offline: number }) {
  const [filter, setFilter] = useState<string>('all')
  const kinds = ['all', 'wired', ...bands.map(b => b.label)]
  const count = (k: string) => (k === 'all' ? devices.length : k === 'wired' ? devices.filter(d => d.connection === 'wired').length : devices.filter(d => d.band === k).length)
  const shown = devices.filter(d => filter === 'all' || (filter === 'wired' ? d.connection === 'wired' : d.band === filter))
  return (
    <>
      <div className={a.filters} role="group" aria-label="Show devices">
        {kinds.filter(k => k === 'all' || count(k) > 0).map(k => (
          <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>{k === 'all' ? 'All' : k === 'wired' ? 'Wired' : k} {count(k)}</button>
        ))}
      </div>
      {shown.length === 0 ? <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No devices here right now.</p> : (
        <ul className={a.devices} aria-label="Connected devices">
          {shown.map(d => (
            <li key={d.key} className={a.device}>
              <span className={a.devName}>{d.name}</span>
              <span className={a.via} data-wired={String(d.connection === 'wired')}>{d.connection === 'wired' ? 'wired' : d.band ?? 'Wi-Fi'}</span>
              <span className={a.devMeta}>
                <Signal d={d} />
                {d.node && <span>on {d.node}</span>}
                {d.onlineSec !== null && <span>online {duration(d.onlineSec)}</span>}
                {d.ip && <span>{d.ip}</span>}
                {d.mac && <span>{d.mac}</span>}
                {d.vendor && d.vendor !== d.name && <span>{d.vendor}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {offline > 0 && <p className="mt-3 text-sm" style={{ color: 'var(--text-dimmer)' }}>The router also remembers {offline} device{offline === 1 ? '' : 's'} that {offline === 1 ? 'is' : 'are'} not online now.</p>}
    </>
  )
}

// ── AiMesh ───────────────────────────────────────────────────────────────────

function MeshCard({ n }: { n: MeshNode }) {
  const via = n.main ? 'main unit' : n.backhaul === 'wired' ? 'wired backhaul' : n.backhaul ? `${n.backhaul} backhaul` : 'backhaul not reported'
  return (
    <li className={a.meshNode} data-main={String(n.main)} data-online={String(n.online)}
      aria-label={`${n.name}${n.model ? `, ${n.model}` : ''}: ${n.online ? 'online' : 'offline'}, ${via}${n.rssi !== null ? `, ${n.rssi} dBm` : ''}, ${n.clients} client${n.clients === 1 ? '' : 's'}`}>
      <span className={a.meshTop}><span className={a.meshName}>{n.name}</span>{n.main && <span className={a.meshBadge}>main</span>}</span>
      <span className={a.ssid}>{n.model ?? 'ASUS unit'}{n.online ? '' : ' · offline'}</span>
      <span className={a.bandRow}><span>link</span><b>{n.main ? '—' : n.backhaul === 'wired' ? 'wired' : n.backhaul ?? '—'}</b></span>
      {!n.main && n.bars !== null && <span className={a.bandRow}><span>signal</span><b><Signal d={n} /></b></span>}
      <span className={a.bandRow}><span>firmware</span><b>{n.firmware ?? '—'}{n.update ? ' · update' : ''}</b></span>
      {n.ip && <span className={a.bandRow}><span>address</span><b className="font-mono">{n.ip}</b></span>}
      <span className={a.clients}><b>{n.clients}</b><span>client{n.clients === 1 ? '' : 's'}</span></span>
    </li>
  )
}

/** The mesh as one picture: the main unit on top, every node under it, each saying how it is connected. */
export function MeshView({ nodes }: { nodes: MeshNode[] }) {
  const main = nodes.filter(n => n.main), rest = nodes.filter(n => !n.main)
  return (
    <div className={a.mesh}>
      <ul className={a.meshRow} aria-label="AiMesh main unit" style={{ listStyle: 'none', margin: 0, padding: 0 }}>{main.map(n => <MeshCard key={n.key} n={n} />)}</ul>
      {rest.length > 0 && <>
        <span className={a.meshTrunk} aria-hidden />
        <ul className={a.meshNodes} aria-label="AiMesh nodes" style={{ listStyle: 'none', margin: 0, padding: 0 }}>{rest.map(n => <MeshCard key={n.key} n={n} />)}</ul>
      </>}
    </div>
  )
}
