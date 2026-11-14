'use client'

// The guest list: one row per guest with status, type, node, CPU/RAM/disk mini bars, uptime, IP, tags
// (Proxmox tags, GPU, and the VPN slot) and HA state. A table on wide screens, cards on a phone.

import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { placeMenu } from '@/lib/popover'
import { formatBytes, formatUptime } from '@/lib/utils'
import { PreviewDialog } from './PreviewDialog'
import { VENDOR_LABEL, type GuestRow, type VpnStatus } from './types'
import { styles } from '@/components/visual/kit'
import { HaBadge, sidOf, type HaBadgeInfo } from '@/components/ha'

export const STATUS_COLOR: Record<string, string> = { running: 'var(--good)', stopped: 'var(--text-dimmer)', paused: 'var(--warn-2)', suspended: 'var(--violet-2)' }

export function StatusDot({ status }: { status: string }) {
  const c = STATUS_COLOR[status] ?? 'var(--text-dimmer)'
  return <span title={status} aria-label={status} className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: c, boxShadow: status === 'running' ? `0 0 6px ${c}` : 'none' }} />
}

export function TypeBadge({ type }: { type: 'lxc' | 'qemu' }) {
  const c = type === 'lxc' ? 'var(--accent)' : 'var(--violet)'
  return <span className="font-mono rounded px-1.5" style={{ fontSize: 10, color: c, border: `1px solid color-mix(in srgb, ${c} 35%, transparent)` }}>{type === 'lxc' ? 'CT' : 'VM'}</span>
}

export function MiniBar({ pct, muted }: { pct: number; muted?: boolean }) {
  const p = Math.max(0, Math.min(100, pct || 0))
  const c = muted ? 'var(--text-muted)' : p > 90 ? 'var(--crit-2)' : p > 75 ? 'var(--warn-2)' : 'var(--accent)'
  return <div className="h-1 rounded-full overflow-hidden w-full" style={{ background: 'var(--track)' }}><div className="h-full rounded-full" style={{ width: `${p}%`, background: c, transition: 'width .4s' }} /></div>
}

export function GpuBadge({ row }: { row: GuestRow }) {
  if (!row.gpu.vendors.length && row.gpu.toggle !== 'off') return null
  const label = row.gpu.vendors.length ? row.gpu.vendors.map(v => VENDOR_LABEL[v] ?? 'GPU').join('/') : 'GPU'
  const off = row.gpu.toggle === 'off'
  return (
    <span className="font-mono rounded px-1.5" title={off ? 'GPU access turned off' : `GPU via ${row.gpu.via.join(', ')}`}
      style={{ fontSize: 10, color: off ? 'var(--text-dimmer)' : 'var(--violet)', border: `1px ${off ? 'dashed' : 'solid'} color-mix(in srgb, var(--violet) 35%, transparent)` }}>
      {off ? `GPU off` : `GPU ${label}`}
    </span>
  )
}

/** The VPN slot. Hidden in the list while no VPN service exists; the drill-down's VPN tab always shows it. */
export function VpnBadge({ vpn, always }: { vpn: VpnStatus; always?: boolean }) {
  if (vpn.state === 'not-available' && !always) return null
  const c = vpn.state === 'connected' ? 'var(--good)' : vpn.state === 'disconnected' ? 'var(--warn-2)' : 'var(--text-dimmer)'
  const text = vpn.state === 'not-available' ? 'VPN not set up' : vpn.state === 'none' ? 'no VPN' : `${vpn.provider ?? 'VPN'} ${vpn.state}`
  return <span className="font-mono rounded px-1.5" title={vpn.detail} style={{ fontSize: 10, color: c, border: `1px solid color-mix(in srgb, ${c} 35%, transparent)` }}>{text}</span>
}

function Tags({ row }: { row: GuestRow }) {
  return (
    <div className="flex flex-wrap gap-1">
      <GpuBadge row={row} />
      <VpnBadge vpn={row.vpn} />
      {row.tags.map(t => <span key={t} className="font-mono rounded px-1.5" style={{ fontSize: 10, color: 'var(--text-muted)', background: 'var(--ground-deep)', border: '1px solid var(--border-dim)' }}>{t}</span>)}
    </div>
  )
}

/** HA in a row: the HA page's own badge (home, warnings) when it has one, else the state Proxmox reports. */
function HaCell({ row, ha }: { row: GuestRow; ha?: (sid: string) => HaBadgeInfo | undefined }) {
  const info = ha?.(sidOf(row.type, row.vmid))
  if (info) return <HaBadge info={info} />
  if (!row.ha.managed) return <span className="text-xs" style={{ color: 'var(--text-faint)' }}>—</span>
  const c = row.ha.state === 'started' ? 'var(--violet)' : 'var(--text-dimmer)'
  return <span className="font-mono text-[11px]" style={{ color: c }} title={row.ha.status ?? undefined}>HA {row.ha.state}</span>
}

function pct(a: number, b: number) { return b ? Math.round(a / b * 100) : 0 }

function RowMenu({ row, canOperate, canAdmin, onPower, onOpen, onRefresh, onBackup }: { row: GuestRow; canOperate: boolean; canAdmin: boolean; onPower: (row: GuestRow, a: string) => void; onOpen: () => void; onRefresh: () => void; onBackup?: (row: GuestRow) => void }) {
  const [open, setOpen] = useState(false)
  const [change, setChange] = useState<null | { change: any; title: string }>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    const place = () => {
      const b = btn.current?.getBoundingClientRect(), m = menu.current
      if (!b || !m) return
      setPos(placeMenu(b, { width: m.offsetWidth, height: m.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }))
    }
    place()
    const outside = (e: MouseEvent) => { if (!menu.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const away = () => setOpen(false)
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', key)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', away, true)
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', key); window.removeEventListener('resize', place); window.removeEventListener('scroll', away, true) }
  }, [open])
  const running = row.status === 'running'
  const items: Array<[string, () => void]> = [['Details', onOpen]]
  if (canOperate && !row.ha.managed) items.push(...(running ? [['Shut down', () => onPower(row, 'shutdown')], ['Reboot', () => onPower(row, 'reboot')]] as Array<[string, () => void]> : [['Start', () => onPower(row, 'start')]] as Array<[string, () => void]>))
  if (canAdmin && row.ha.managed) items.push(running ? ['Stop (HA)', () => onPower(row, 'ha:stopped')] : ['Start (HA)', () => onPower(row, 'ha:started')])
  if (canAdmin && onBackup) items.push(['Back up now…', () => onBackup(row)])
  if (canAdmin && row.type === 'lxc' && row.gpu.toggle === 'on') items.push(['GPU access: turn off', () => setChange({ change: { kind: 'gpu-off' }, title: `Turn GPU access off for ${row.name}` })])
  if (canAdmin && row.type === 'lxc' && row.gpu.toggle === 'off') items.push(['GPU access: turn back on', () => setChange({ change: { kind: 'gpu-on' }, title: `Turn GPU access back on for ${row.name}` })])
  return (
    <div className="relative" onClick={e => e.stopPropagation()}>
      <button ref={btn} aria-label={`Actions for ${row.name}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)} className="px-2 rounded-md" style={{ height: 32, color: 'var(--text-dim)', border: '1px solid var(--border-dim)' }}>⋯</button>
      {open && typeof document !== 'undefined' && createPortal(
        // On document.body, placed by the button and flipped above it near the bottom of the window: the table's
        // own scroller (overflow-x) clipped it. It stays open until a choice, a click outside, Escape or a scroll.
        <div ref={menu} role="menu" className="fixed z-[60] min-w-[200px] rounded-md border py-1 shadow-lg"
             style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, background: 'var(--surface-raised)', borderColor: 'var(--border-soft)' }}
             onClick={e => e.stopPropagation()}>
          {items.map(([l, f]) => <button key={l} role="menuitem" className="block w-full text-left px-3 py-2 text-sm hover:opacity-80" style={{ color: 'var(--text)' }} onClick={() => { setOpen(false); f() }}>{l}</button>)}
        </div>, document.body)}
      {change && <PreviewDialog guest={{ node: row.node, type: row.type, vmid: row.vmid, name: row.name }} change={change.change} title={change.title} onClose={() => setChange(null)} onApplied={onRefresh} />}
    </div>
  )
}

export function GuestTable({ rows, canOperate, canAdmin, onOpen, onPower, onRefresh, onBackup, ha }: {
  rows: GuestRow[]; canOperate: boolean; canAdmin: boolean
  /** HA badges, read once per list (useHaBadges). */
  ha?: (sid: string) => HaBadgeInfo | undefined
  onOpen: (r: GuestRow) => void; onPower: (r: GuestRow, a: string) => void; onRefresh: () => void
  /** Back up now (opens the backup dialog). Absent: no such menu item. */
  onBackup?: (r: GuestRow) => void
}) {
  return (
    <>
      {/* wide screens */}
      <div className={`hidden md:block ${styles.tableWrap}`}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Guest</th><th>Node</th><th>CPU</th><th>RAM</th><th>Disk</th>
              <th>Uptime</th><th>IP</th><th>Tags</th><th>HA</th><th><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const running = r.status === 'running'
              return (
                <tr key={`${r.type}${r.vmid}`} onClick={() => onOpen(r)} className="cursor-pointer">
                  <td>
                    <div className="flex items-center gap-2 min-w-0"><StatusDot status={r.status} /><span className="font-mono text-[10px] uppercase" style={{ color: STATUS_COLOR[r.status] ?? 'var(--text-muted)' }}>{r.status}</span><TypeBadge type={r.type} />
                      <span className="font-medium truncate" style={{ color: 'var(--text-bright)', maxWidth: 220 }}>{r.name}</span>
                      <span className="font-mono text-xs" style={{ color: 'var(--text-dimmer)' }}>#{r.vmid}</span></div>
                  </td>
                  <td className="font-mono text-xs" style={{ color: 'var(--text-dim)' }}>{r.node}</td>
                  <td><div className="font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>{running ? `${Math.round(r.cpu * 100)}%` : '—'} <span style={{ color: 'var(--text-faint)' }}>/{r.maxcpu}c</span></div>{running && <MiniBar pct={r.cpu * 100} />}</td>
                  <td><div className="font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>{running ? formatBytes(r.mem, 0) : '—'} <span style={{ color: 'var(--text-faint)' }}>/{formatBytes(r.maxmem, 0)}</span></div>{running && <MiniBar pct={pct(r.mem, r.maxmem)} muted={r.type === 'qemu'} />}</td>
                  <td><div className="font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>{formatBytes(r.maxdisk, 0)}</div>{r.disk > 0 && <MiniBar pct={pct(r.disk, r.maxdisk)} />}</td>
                  <td className="font-mono text-[11px]" style={{ color: 'var(--text-dimmer)' }}>{r.uptime ? formatUptime(r.uptime) : '—'}</td>
                  <td className="font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>{r.ip ?? '—'}</td>
                  <td><Tags row={r} /></td>
                  <td><HaCell row={r} ha={ha} /></td>
                  <td><RowMenu row={r} canOperate={canOperate} canAdmin={canAdmin} onPower={onPower} onOpen={() => onOpen(r)} onRefresh={onRefresh} onBackup={onBackup} /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* phones */}
      <div className="md:hidden space-y-2">
        {rows.map(r => {
          const running = r.status === 'running'
          return (
            <div key={`${r.type}${r.vmid}`} onClick={() => onOpen(r)} className="rounded-lg border p-3 space-y-2" style={{ borderColor: 'var(--border)', background: 'var(--ground-deep)' }}>
              <div className="flex items-center gap-2 min-w-0">
                <StatusDot status={r.status} /><span className="font-mono text-[10px] uppercase" style={{ color: STATUS_COLOR[r.status] ?? 'var(--text-muted)' }}>{r.status}</span><TypeBadge type={r.type} />
                <span className="font-medium truncate flex-1" style={{ color: 'var(--text-bright)' }}>{r.name}</span>
                <RowMenu row={r} canOperate={canOperate} canAdmin={canAdmin} onPower={onPower} onOpen={() => onOpen(r)} onRefresh={onRefresh} onBackup={onBackup} />
              </div>
              <div className="font-mono text-[11px] flex flex-wrap gap-x-3" style={{ color: 'var(--text-dimmer)' }}>
                <span>#{r.vmid}</span><span>{r.node}</span>{r.ip && <span>{r.ip}</span>}{r.uptime > 0 && <span>{formatUptime(r.uptime)}</span>}<HaCell row={r} ha={ha} />
              </div>
              {running && (
                <div className="grid grid-cols-3 gap-2 font-mono text-[10px]" style={{ color: 'var(--text-dimmer)' }}>
                  <div>CPU {Math.round(r.cpu * 100)}%<MiniBar pct={r.cpu * 100} /></div>
                  <div>RAM {pct(r.mem, r.maxmem)}%<MiniBar pct={pct(r.mem, r.maxmem)} muted={r.type === 'qemu'} /></div>
                  <div>Disk {r.disk ? `${pct(r.disk, r.maxdisk)}%` : formatBytes(r.maxdisk, 0)}{r.disk > 0 && <MiniBar pct={pct(r.disk, r.maxdisk)} />}</div>
                </div>
              )}
              <Tags row={r} />
            </div>
          )
        })}
      </div>
    </>
  )
}
