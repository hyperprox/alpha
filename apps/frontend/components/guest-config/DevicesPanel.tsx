'use client'

// What a node can share: every device named in plain language first, its identity underneath in muted text,
// who uses it, and what sharing it means. Also the picker source for the guest device editor: devices on the
// guest's own node can be picked; devices elsewhere are shown greyed out.

import { useCallback, useEffect, useState } from 'react'
import { apiJson } from '@/lib/api'
import { GhostButton, Notice, BusyNote } from '@/components/vault/ui'
import { API, SHARE_LABEL, type Device, type NodeInventory } from './types'

const KIND_ORDER: Device['kind'][] = ['gpu', 'render', 'serial', 'usb', 'video', 'tpu', 'tun', 'pci']
const KIND_LABEL: Record<string, string> = { gpu: 'Graphics', render: 'Render nodes', serial: 'Serial devices', usb: 'USB devices', video: 'Cameras and capture', tpu: 'AI accelerators', tun: 'Network tunnels', pci: 'PCI devices for VM passthrough' }

export function useInventory(node: string | null) {
  const [inv, setInv] = useState<NodeInventory | null>(null)
  const [redacted, setRedacted] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async (refresh = false) => {
    if (!node) return
    setBusy(true); setErr(null)
    const r = await apiJson<{ data: NodeInventory; redacted: boolean }>(`${API}/nodes/${encodeURIComponent(node)}/devices${refresh ? '?refresh=1' : ''}`)
    setBusy(false)
    if (!r.ok) { setErr(r.error ?? 'Could not list devices'); return }
    setInv(r.body!.data); setRedacted(!!r.body!.redacted)
  }, [node])
  useEffect(() => { void load() }, [load])
  return { inv, redacted, err, busy, reload: load }
}

export function DeviceRow({ d, picking, disabledNote, onPick, compact }: { d: Device; picking?: boolean; disabledNote?: string; onPick?: (d: Device) => void; compact?: boolean }) {
  const identity = [
    d.vendorProduct && `ID ${d.vendorProduct}`,
    d.serial && `serial ${d.serial}`,
    d.stableRef && d.stableRef !== d.vendorProduct && (d.stableRef.startsWith('/dev/') ? d.stableRef : d.pciAddress ? `PCI ${d.pciAddress}` : d.stableRef),
    d.port && `USB port ${d.port}`,
    `on ${d.node}`,
  ].filter(Boolean) as string[]
  const facts = [
    d.driverVersion && `driver ${d.driverVersion}`, d.vram && `${d.vram} VRAM`, d.driver && `kernel driver ${d.driver}`,
    d.iommuGroup !== undefined && `IOMMU group ${d.iommuGroup}${d.iommuClean ? ' (clean)' : d.iommuClean === false ? ' (shared with other devices)' : ''}`,
    d.vfio && 'bound to vfio', d.bootDisplay && 'host display',
  ].filter(Boolean) as string[]
  const warn = (n: string) => /^(Unsafe|These look identical|NVIDIA cards from before|IOMMU group .* holds|No \/dev\/serial|This is the node)/.test(n)
  return (
    <div className="rounded-md border p-3 space-y-1.5" style={{ borderColor: 'var(--border-dim)', background: 'var(--ground-deep)', opacity: disabledNote ? 0.5 : 1 }}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium break-words" style={{ color: 'var(--text-bright)' }}>{d.name}</div>
          {identity.length > 0 && <div className="font-mono break-all" style={{ fontSize: 11, color: 'var(--text-dimmer)' }}>{identity.join(' · ')}</div>}
          {!compact && facts.length > 0 && <div className="text-[11px]" style={{ color: 'var(--text-dimmer)' }}>{facts.join(' · ')}</div>}
        </div>
        {picking && !disabledNote && <GhostButton style={{ height: 32 }} onClick={() => onPick?.(d)}>Use</GhostButton>}
      </div>
      {disabledNote && <p className="text-[12px]" style={{ color: 'var(--text-dimmer)' }}>{disabledNote}</p>}
      {!compact && <div className="flex flex-wrap gap-1">{d.shareAs.map(s => <span key={s} className="font-mono rounded px-1.5" style={{ fontSize: 10, color: 'var(--text-muted)', border: '1px solid var(--border-dim)' }}>{SHARE_LABEL[s] ?? s}</span>)}</div>}
      <ul className="space-y-0.5">
        {d.notes.map((n, i) => <li key={i} className="text-[12px]" style={{ color: warn(n) ? 'var(--warn-2)' : 'var(--text-muted)' }}>{n}</li>)}
      </ul>
    </div>
  )
}

/** The per-node Devices view on Infrastructure. */
export function DevicesPanel({ nodes }: { nodes: string[] }) {
  const [node, setNode] = useState<string | null>(nodes[0] ?? null)
  useEffect(() => { if (!node && nodes[0]) setNode(nodes[0]) }, [nodes, node])
  const { inv, redacted, err, busy, reload } = useInventory(node)
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        {nodes.map(n => (
          <button key={n} onClick={() => setNode(n)} className="px-3 rounded-md text-sm" style={{ height: 36, border: `1px solid ${n === node ? 'var(--accent)' : 'var(--border-strong)'}`, color: n === node ? 'var(--accent)' : 'var(--text-soft)', background: 'transparent' }}>{n}</button>
        ))}
        <GhostButton className="ml-auto" style={{ height: 36 }} disabled={busy} onClick={() => void reload(true)}>{busy ? 'Reading…' : 'Refresh'}</GhostButton>
      </div>
      {busy && !inv && <BusyNote>Asking the node (read-only)…</BusyNote>}
      {err && <Notice kind="error">{err}</Notice>}
      {inv?.problem && <Notice kind="warn">{inv.problem}</Notice>}
      {redacted && <Notice kind="info">Device paths, IDs and serial numbers are shown to admins only.</Notice>}
      {inv && KIND_ORDER.map(k => {
        const list = inv.devices.filter(d => d.kind === k)
        if (!list.length) return null
        return (
          <section key={k} className="space-y-2">
            <h3 className="font-mono uppercase" style={{ fontSize: 11, letterSpacing: '0.14em', color: 'var(--text-dimmer)' }}>{KIND_LABEL[k]} · {list.length}</h3>
            <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 340px), 1fr))' }}>
              {list.map(d => <DeviceRow key={d.id} d={d} />)}
            </div>
          </section>
        )
      })}
      {inv && <p className="text-[11px]" style={{ color: 'var(--text-dimmer)' }}>Read {new Date(inv.collectedAt).toLocaleTimeString()} · cached for a minute</p>}
    </div>
  )
}

/**
 * The picker: the guest's node first, devices on other nodes greyed out ("only on node X"). Never a typed path.
 */
export function DevicePicker({ guestNode, otherNodes, filter, onPick }: { guestNode: string; otherNodes: string[]; filter: (d: Device) => boolean; onPick: (d: Device) => void }) {
  const here = useInventory(guestNode)
  const [showOthers, setShowOthers] = useState(false)
  return (
    <div className="space-y-2">
      {here.busy && !here.inv && <BusyNote>Listing {guestNode}’s devices…</BusyNote>}
      {here.err && <Notice kind="error">{here.err}</Notice>}
      {here.inv?.problem && <Notice kind="warn">{here.inv.problem}</Notice>}
      {here.inv?.devices.filter(filter).map(d => <DeviceRow key={d.id} d={d} picking onPick={onPick} />)}
      {here.inv && here.inv.devices.filter(filter).length === 0 && <p className="text-sm" style={{ color: 'var(--text-dimmer)' }}>Nothing suitable on {guestNode}.</p>}
      {otherNodes.length > 0 && <GhostButton style={{ height: 32 }} onClick={() => setShowOthers(x => !x)}>{showOthers ? 'Hide' : 'Show'} devices on other nodes</GhostButton>}
      {showOthers && otherNodes.map(n => <OtherNode key={n} node={n} filter={filter} />)}
    </div>
  )
}

function OtherNode({ node, filter }: { node: string; filter: (d: Device) => boolean }) {
  const { inv } = useInventory(node)
  return <>{inv?.devices.filter(filter).map(d => <DeviceRow key={d.id} d={d} compact disabledNote={`Only on ${node}: the guest would need to live there.`} />)}</>
}
