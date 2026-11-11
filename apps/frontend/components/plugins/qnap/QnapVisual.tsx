'use client'

// =============================================================================
//  HyperProx — QNAP: the visual pieces of one NAS
//
//  The drive bays (one tile per disk, glowing by SMART health), volume rings,
//  share tiles, temperature and load gauges, fans, the firmware card and the
//  network list. Every one says its reading in words as well as colour.
// =============================================================================

import { Icon, Panel, RingGauge, SemiGauge, bytes, duration, useReducedMotion, type StatChip } from '@/components/visual/kit'
import q from './qnap.module.css'

export type Health = 'good' | 'warning' | 'bad'
export interface Disk {
  bay: number; model: string | null; capacity: string | null; sizeBytes: number | null; tempC: number | null
  smart: Health | null; smartText: string | null; lastTest: { status: string | null; type: string | null; time: string | null }
  serial: string | null; firmware: string | null
}
export interface Volume { id: string; name: string; health: Health | null; status: string | null; degraded: boolean; totalBytes: number | null; freeBytes: number | null; usedBytes: number | null; disks: number[]; pool: string | null }
export interface Pool { id: string; name: string; health: Health | null; status: string | null; totalBytes: number | null; usedBytes: number | null }
export interface Reading {
  fetchedAt: string; generation: 'legacy' | 'storage-v2' | null; model: string | null; hostname: string | null; serial: string | null
  firmware: { version: string | null; build: string | null; number: string | null }
  update: { available: boolean | null; version: string | null; checkedAt: string | null }
  uptimeSec: number | null; health: Health | null; cpuPct: number | null; memTotalMB: number | null; memFreeMB: number | null
  sysTempC: number | null; cpuTempC: number | null
  thresholds: { sysWarnC: number | null; sysErrC: number | null; diskWarnC: number | null; diskErrC: number | null; ssdWarnC: number | null }
  fans: Array<{ index: number; rpm: number | null; ok: boolean | null }>
  disks: Disk[]; volumes: Volume[]; pools: Pool[]
  shares: Array<{ name: string; volume: string | null; usedBytes: number | null }>
  interfaces: Array<{ name: string; up: boolean | null; speedMbps: number | null; ip: string | null; mask: string | null; mac: string | null; mode: string | null; rxBps: number | null; txBps: number | null }>
  missing: string[]
}

const WORD: Record<string, string> = { good: 'healthy', warning: 'warning', bad: 'failing', unknown: 'not reported' }
const toneVar = (h: Health | null | 'unknown') => (h === 'bad' ? 'var(--crit)' : h === 'warning' ? 'var(--warn)' : h === 'good' ? 'var(--good)' : 'var(--text-dimmer)')

export const usage = (r: Reading) => {
  const used = r.volumes.reduce((n, v) => n + (v.usedBytes ?? 0), 0)
  const total = r.volumes.reduce((n, v) => n + (v.totalBytes ?? 0), 0)
  return { used, total, frac: total ? used / total : 0 }
}

/** The NAS's state in one word: the worst of QTS's own health, disks, volumes and pools. */
export function overall(r: Reading): Health | null {
  const all = [r.health, ...r.disks.map(d => d.smart), ...r.volumes.map(v => v.health), ...r.pools.map(p => p.health)]
  if (all.includes('bad')) return 'bad'
  if (all.includes('warning')) return 'warning'
  return all.some(h => h === 'good') ? 'good' : null
}

export function hudChips(r: Reading): StatChip[] {
  const h = overall(r)
  const u = usage(r)
  const temp = r.cpuTempC ?? r.sysTempC
  const warn = r.thresholds.sysWarnC ?? 60
  return [
    { label: 'health', value: h ? WORD[h] : '—', tone: h === 'bad' ? 'crit' : h === 'warning' ? 'warn' : h === 'good' ? 'good' : 'dim' },
    { label: 'used / total', value: u.total ? `${bytes(u.used)} / ${bytes(u.total)}` : '—', tone: u.frac >= 0.9 ? 'warn' : 'accent' },
    { label: r.cpuTempC !== null ? 'CPU temp' : 'system temp', value: temp === null ? '—' : `${temp} °C`, tone: temp === null ? 'dim' : temp >= warn ? 'warn' : 'violet' },
    { label: 'uptime', value: duration(r.uptimeSec), tone: 'dim' },
  ]
}

// ── drive bays ───────────────────────────────────────────────────────────────

export function BayView({ disks, warnC, errC, busyBay, onOpen }: { disks: Disk[]; warnC: number; errC: number | null; busyBay: number | null; onOpen: (d: Disk) => void }) {
  if (!disks.length) return <p className="text-sm" style={{ color: 'var(--text-muted)' }}>The NAS reported no disks.</p>
  return (
    <div className={q.bays} role="list" aria-label="Drive bays">
      {disks.map(d => {
        const h = d.smart ?? 'unknown'
        const max = Math.max(errC ?? warnC + 10, 70)
        const t = d.tempC
        const tc = t === null ? 'var(--text-dimmer)' : errC !== null && t >= errC ? 'var(--crit)' : t >= warnC ? 'var(--warn)' : 'var(--good)'
        return (
          <div role="listitem" key={d.bay}>
            <button type="button" className={q.bay} data-health={h} data-busy={busyBay === d.bay} onClick={() => onOpen(d)}
              aria-label={`Bay ${d.bay}: ${d.model ?? 'unknown disk'}, ${d.capacity ?? 'size unknown'}, ${t === null ? 'temperature not reported' : `${t} °C`}, SMART ${d.smartText ?? WORD[h]}. Open for details.`}>
              <span className={q.bayTop}><span className={q.bayNo}><small>bay</small>{d.bay}</span><i className={q.led} aria-hidden /></span>
              <span className={q.bayModel}>{d.model ?? 'Unknown disk'}</span>
              <span className={q.baySize}>{d.capacity ?? '—'}</span>
              <span className={q.bayRow}><span>temp</span><b>{t === null ? '—' : `${t} °C`}</b></span>
              <span className={q.thermo} aria-hidden><i style={{ width: `${t === null ? 0 : Math.min(100, (t / max) * 100)}%`, ['--thermo-c' as any]: tc }} /></span>
              <span className={q.bayRow}><span>smart</span><b className={q.word}>{d.smartText ?? WORD[h]}</b></span>
            </button>
          </div>
        )
      })}
    </div>
  )
}

// ── volumes and shares ───────────────────────────────────────────────────────

export function VolumeRings({ volumes, pools }: { volumes: Volume[]; pools: Pool[] }) {
  if (!volumes.length) return <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No volumes reported.</p>
  return (
    <>
      <div className={q.volumes}>
        {volumes.map(v => {
          const frac = v.totalBytes && v.usedBytes !== null ? v.usedBytes / v.totalBytes : 0
          const color = v.health === 'bad' ? 'var(--crit)' : v.health === 'warning' || frac >= 0.9 ? 'var(--warn)' : 'var(--hx-accent)'
          return (
            <div key={v.id} className={q.volume}>
              <RingGauge value={frac} size={112} stroke={8} color={color} text={v.totalBytes ? `${Math.round(frac * 100)}%` : '—'} label={v.name} />
              <small>{v.totalBytes ? `${bytes(v.usedBytes ?? 0)} of ${bytes(v.totalBytes)}` : 'size unknown'}</small>
              <small style={{ color: toneVar(v.health) }}>{v.status ?? WORD[v.health ?? 'unknown']}{v.disks.length ? ` · disk${v.disks.length > 1 ? 's' : ''} ${v.disks.join(', ')}` : ''}</small>
            </div>
          )
        })}
      </div>
      {pools.length > 0 && (
        <ul className={q.pools} aria-label="Storage pools">
          {pools.map(p => (
            <li key={p.id}><i className={q.dot} data-up={p.health === 'good'} aria-hidden style={p.health !== 'good' ? { background: toneVar(p.health) } : undefined} />
              <b style={{ color: 'var(--text-bright)' }}>{p.name}</b> {p.status ?? WORD[p.health ?? 'unknown']}{p.totalBytes ? ` · ${bytes(p.usedBytes ?? 0)} of ${bytes(p.totalBytes)} allocated` : ''}</li>
          ))}
        </ul>
      )}
    </>
  )
}

export function ShareTiles({ shares }: { shares: Reading['shares'] }) {
  if (!shares.length) return <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No shares reported.</p>
  const max = Math.max(...shares.map(s => s.usedBytes ?? 0), 1)
  return (
    <ul className={q.shares} aria-label="Shared folders" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {shares.map(s => (
        <li key={`${s.volume}-${s.name}`} className={q.share}>
          <b>{s.name}</b>
          <span>{s.usedBytes === null ? 'size not reported' : bytes(s.usedBytes)}{s.volume ? ` · vol ${s.volume}` : ''}</span>
          <i aria-hidden style={{ width: `${s.usedBytes ? Math.max(3, (s.usedBytes / max) * 100) : 0}%` }} />
        </li>
      ))}
    </ul>
  )
}

// ── sensors ──────────────────────────────────────────────────────────────────

export function SensorGauges({ r }: { r: Reading }) {
  const reduced = useReducedMotion()
  const sysWarn = r.thresholds.sysWarnC ?? 60
  const sysMax = r.thresholds.sysErrC ?? 80
  const mem = r.memTotalMB ? Math.round(((r.memTotalMB - (r.memFreeMB ?? 0)) / r.memTotalMB) * 100) : null
  const tone = (v: number, warn: number) => (v >= warn ? 'var(--warn)' : 'var(--hx-violet)')
  return (
    <>
      <div className="flex flex-wrap justify-around gap-4">
        {r.sysTempC !== null && <SemiGauge value={r.sysTempC} max={sysMax} label="system" unit="°C" color={tone(r.sysTempC, sysWarn)} />}
        {r.cpuTempC !== null && <SemiGauge value={r.cpuTempC} max={100} label="CPU" unit="°C" color={tone(r.cpuTempC, 85)} />}
        {r.cpuPct !== null && <SemiGauge value={Math.round(r.cpuPct)} max={100} label="CPU load" unit="%" />}
        {mem !== null && <SemiGauge value={mem} max={100} label="memory" unit="%" color={tone(mem, 90)} />}
      </div>
      {r.fans.length > 0 ? (
        <ul className={q.fans} aria-label="Fans" style={{ listStyle: 'none', padding: 0 }}>
          {r.fans.map(f => (
            <li key={f.index} className={q.fan} data-ok={f.ok !== false}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden className={f.ok !== false && !reduced ? q.fanSpin : undefined}>
                <path d="M12 12c0-3 1-7 4-7 2 0 3 1.5 3 3 0 3-4 4-7 4zM12 12c3 0 7 1 7 4 0 2-1.5 3-3 3-3 0-4-4-4-7zM12 12c0 3-1 7-4 7-2 0-3-1.5-3-3 0-3 4-4 7-4zM12 12c-3 0-7-1-7-4 0-2 1.5-3 3-3 3 0 4 4 4 7z" />
              </svg>
              Fan {f.index}: {f.rpm !== null ? `${f.rpm} rpm` : f.ok === false ? 'stopped' : 'running'}{f.ok === false ? ' (stopped)' : ''}
            </li>
          ))}
        </ul>
      ) : <p className="mt-3 text-sm" style={{ color: 'var(--text-dimmer)' }}>This model reports no fans (passively cooled, or not exposed by its firmware).</p>}
    </>
  )
}

// ── firmware and network ─────────────────────────────────────────────────────

export function FirmwareCard({ r, readAt }: { r: Reading; readAt: string }) {
  const u = r.update
  return (
    <Panel title="Firmware" sub={r.generation === 'storage-v2' ? 'storage & snapshots' : r.generation === 'legacy' ? 'legacy storage' : undefined}>
      <dl className={q.fw}>
        <dt>Model</dt><dd>{r.model ?? '—'}</dd>
        <dt>Version</dt><dd>{r.firmware.version ?? '—'}{r.firmware.build ? ` · build ${r.firmware.build}` : ''}</dd>
        <dt>Update</dt>
        <dd style={{ color: u.available ? 'var(--warn)' : u.available === false ? 'var(--good)' : 'var(--text-muted)' }}>
          {u.available === null ? 'Not reported' : u.available ? `Available: ${u.version ?? 'a newer version'}` : 'Up to date'}
        </dd>
        <dt>Last checked</dt><dd>{u.checkedAt ? `${u.checkedAt} (by the NAS)` : '—'}</dd>
        <dt>Read</dt><dd>{readAt}</dd>
      </dl>
      {u.available && <p className="mt-3 text-sm" style={{ color: 'var(--text-soft)' }}>Install it from the NAS itself (Control Panel → Firmware Update). HyperProx does not update NAS firmware.</p>}
    </Panel>
  )
}

export function NetworkList({ r }: { r: Reading }) {
  if (!r.interfaces.length) return <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No interfaces reported.</p>
  return (
    <ul className={q.nics}>
      {r.interfaces.map(n => (
        <li key={n.name}>
          <i className={q.dot} data-up={n.up === true} aria-hidden /><b>{n.name}</b>
          <span>{n.up === null ? 'link unknown' : n.up ? `up${n.speedMbps ? ` · ${n.speedMbps >= 1000 ? `${n.speedMbps / 1000} Gb/s` : `${n.speedMbps} Mb/s`}` : ''}` : 'down'}</span>
          {n.ip && <span className="font-mono">{n.ip}</span>}
          {n.mode && <span>{n.mode}</span>}
          {(n.rxBps !== null || n.txBps !== null) && n.up && <span className="font-mono"><Icon name="arr" size={12} /> {bytes(n.rxBps ?? 0)}/s · ↑ {bytes(n.txBps ?? 0)}/s</span>}
        </li>
      ))}
    </ul>
  )
}
