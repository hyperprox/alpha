'use client'

// The guest's GPU and devices: exactly what is passed and how (devN or raw lxc lines, hostpci), the NVIDIA
// userland check, who else shares it, the GPU access toggle, and the guided editor (pick, never type).

import { useEffect, useState } from 'react'
import { apiJson } from '@/lib/api'
import { GhostButton, Notice, PrimaryButton, BusyNote, INPUT } from '@/components/vault/ui'
import { PreviewDialog } from './PreviewDialog'
import { DevicePicker } from './DevicesPanel'
import { Section } from './ConfigEditor'
import { gpath, VENDOR_LABEL, type Device, type GuestView } from './types'

interface GpuDetail {
  gpu: GuestView['gpu']
  driver: { state: 'match' | 'mismatch' | 'unknown'; words: string } | null
  groups: { render?: number; video?: number } | null
  devices: Device[]
  inventoryProblem: string | null
  sharers: Array<{ device: string; users: string[] }>
  inUse: { device: string; name: string } | null
  portable: { whyRaw: string; noWriter: string }
}

export function GpuToggleButton({ view, onChange }: { view: GuestView; onChange: () => void }) {
  const [change, setChange] = useState<any>(null)
  const t = view.gpu.toggle
  if (view.guest.type !== 'lxc' || t === 'none') return null
  return (
    <>
      {t === 'on' && <GhostButton style={{ height: 34 }} onClick={() => setChange({ kind: 'gpu-off' })}>GPU access: on · Turn off</GhostButton>}
      {t === 'off' && <PrimaryButton style={{ height: 34 }} onClick={() => setChange({ kind: 'gpu-on' })}>GPU access: off · Turn back on</PrimaryButton>}
      {t === 'raw-only' && <GhostButton style={{ height: 34 }} onClick={() => setChange({ kind: 'gpu-off' })} title="Raw lxc lines: the API cannot remove them">GPU access: raw lines</GhostButton>}
      {change && <PreviewDialog guest={view.guest} change={change} title={change.kind === 'gpu-off' ? 'Turn GPU access off' : 'Turn GPU access back on'} onClose={() => setChange(null)} onApplied={onChange} />}
    </>
  )
}

export function GpuPanel({ view, nodes, canEdit, onSaved }: { view: GuestView; nodes: string[]; canEdit: boolean; onSaved: () => void }) {
  const [d, setD] = useState<GpuDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [change, setChange] = useState<null | { change: any; title: string }>(null)
  const [picking, setPicking] = useState<null | 'gpu' | 'device' | 'pci'>(null)
  const [gid, setGid] = useState('')
  const [card, setCard] = useState(false)
  const isLxc = view.guest.type === 'lxc'

  useEffect(() => {
    let live = true
    apiJson<{ data: GpuDetail }>(`${gpath(view.guest)}/gpu`).then(r => { if (!live) return; if (r.ok) setD(r.body!.data); else setErr(r.error ?? 'Could not read GPU details') })
    return () => { live = false }
  }, [view])
  useEffect(() => { if (d?.groups?.render !== undefined) setGid(String(d.groups.render)) }, [d])

  const others = nodes.filter(n => n !== view.guest.node)
  const managed = view.gpu.managed ?? {}
  const devEntries = Object.entries(view.config).filter(([k]) => /^(dev|usb|serial)\d+$/.test(k) && !view.gpu.entries.some(e => e.key === k))

  return (
    <div className="space-y-6">
      {err && <Notice kind="error">{err}</Notice>}
      <Section title="GPU" note={view.gpu.entries.length ? undefined : 'This guest has no GPU.'}>
        {view.gpu.entries.length > 0 && (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2 items-center">
              {view.gpu.vendors.map(v => <span key={v} className="font-mono rounded px-2 py-0.5 text-xs" style={{ color: 'var(--violet)', border: '1px solid color-mix(in srgb, var(--violet) 35%, transparent)' }}>{VENDOR_LABEL[v] ?? v} GPU</span>)}
              <GpuToggleButton view={view} onChange={onSaved} />
            </div>
            {view.gpu.toggle === 'off' && view.gpu.offSince && <Notice kind="info">GPU access was turned off {new Date(view.gpu.offSince).toLocaleString()}. Turning it back on restores exactly the entries that were removed.</Notice>}
            {d?.inUse && <p className="text-sm" style={{ color: 'var(--text)' }}>In use now on {view.guest.node}: <b style={{ color: 'var(--text-bright)' }}>{d.inUse.name}</b> <span className="font-mono text-xs" style={{ color: 'var(--text-dimmer)' }}>{d.inUse.device}</span></p>}
            {d && !d.inUse && view.guest.running && isLxc && <Notice kind="warn">No GPU device is visible inside the container on {view.guest.node}: anything that transcodes is on the CPU.</Notice>}
            {d?.driver?.state === 'mismatch' && <Notice kind="error">{d.driver.words}</Notice>}
            {d?.driver && d.driver.state !== 'mismatch' && <Notice kind={d.driver.state === 'match' ? 'info' : 'warn'}>{d.driver.words}</Notice>}
            <ul className="font-mono rounded-md border p-2 space-y-1 overflow-x-auto" style={{ fontSize: 12, borderColor: 'var(--border-dim)', background: 'var(--ground-deep)' }}>
              {view.gpu.entries.map((e, i) => (
                <li key={i} className="flex gap-2 flex-wrap">
                  <span className="rounded px-1" style={{ fontSize: 10, color: e.via === 'devN' || e.via === 'hostpci' ? 'var(--good)' : 'var(--warn-2)', border: '1px solid var(--border-dim)' }}>{e.via}</span>
                  <span style={{ color: 'var(--text)' }}>{e.key}: {e.value}</span>
                  {e.via !== 'devN' && e.via !== 'hostpci' && <span style={{ color: 'var(--text-dimmer)' }}>({e.device}{e.assumed ? ', major assumed' : ''})</span>}
                  {managed[e.key] === e.value && <span style={{ color: 'var(--accent)' }}>added by HyperProx</span>}
                </li>
              ))}
            </ul>
            {view.gpu.rawCount > 0 && (
              <Notice kind="warn">
                {view.gpu.rawCount} raw lxc.* line{view.gpu.rawCount === 1 ? '' : 's'}: Proxmox’s API does not accept lxc.* keys from any token, to set or to delete, so HyperProx cannot change these. It can add the equivalent devN entries; the raw lines then have to be removed by hand on the node.
              </Notice>
            )}
            {canEdit && isLxc && (
              <div className="flex gap-2 flex-wrap">
                {view.gpu.rawCount > 0 && <GhostButton style={{ height: 34 }} onClick={() => setChange({ change: { kind: 'gpu-convert' }, title: 'Convert raw GPU lines to devN' })}>Convert to devN</GhostButton>}
                {Object.keys(managed).some(k => view.config[k] === managed[k]) && <GhostButton style={{ height: 34 }} onClick={() => setChange({ change: { kind: 'gpu-revoke' }, title: 'Remove GPU access added by HyperProx' })}>Remove GPU access</GhostButton>}
              </div>
            )}
            {canEdit && !isLxc && view.gpu.entries.map(e => <GhostButton key={e.key} style={{ height: 34 }} onClick={() => setChange({ change: { kind: 'hostpci', hostpci: { remove: e.key } }, title: `Remove ${e.key}` })}>Remove {e.key}</GhostButton>)}
          </div>
        )}
        {d?.sharers.length ? (
          <div className="text-sm space-y-0.5" style={{ color: 'var(--text-muted)' }}>
            {d.sharers.map((s, i) => <p key={i}>{s.device} is also used by {s.users.join(', ')}.</p>)}
          </div>
        ) : null}
        {canEdit && (
          <div className="space-y-2">
            {isLxc ? <GhostButton onClick={() => setPicking(picking === 'gpu' ? null : 'gpu')}>Give this container a GPU…</GhostButton>
                   : <GhostButton onClick={() => setPicking(picking === 'pci' ? null : 'pci')}>Pass a PCI device to this VM…</GhostButton>}
            {!isLxc && picking === 'pci' && <Notice kind="warn">Some GPUs cannot be reset or handed back cleanly and can hang the host when the VM stops or restarts. Consumer NVIDIA cards from before Turing (Pascal and older) are known for this.</Notice>}
            {picking === 'gpu' && (
              <div className="rounded-md border p-3 space-y-2" style={{ borderColor: 'var(--border-soft)' }}>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div><label className="block text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Container render group id {d?.groups?.render !== undefined ? '(read from the container)' : '(start it to read, or enter)'}</label>
                    <input style={INPUT} value={gid} onChange={e => setGid(e.target.value)} inputMode="numeric" /></div>
                  <label className="flex items-center gap-2 text-sm self-end" style={{ color: 'var(--text)' }}><input type="checkbox" checked={card} onChange={e => setCard(e.target.checked)} /> Also pass the display node (cardN)</label>
                </div>
                <DevicePicker guestNode={view.guest.node} otherNodes={others} filter={x => x.kind === 'gpu'}
                  onPick={x => setChange({ change: { kind: 'gpu-grant', grant: { deviceId: x.id, renderGid: gid === '' ? undefined : Number(gid), includeCard: card, videoGid: d?.groups?.video } }, title: `Give ${view.guest.name} ${x.product}` })} />
              </div>
            )}
            {picking === 'pci' && <DevicePicker guestNode={view.guest.node} otherNodes={others} filter={x => x.shareAs.includes('vm-hostpci')}
              onPick={x => setChange({ change: { kind: 'hostpci', hostpci: { add: { deviceId: x.id, pcie: /q35/.test(String(view.config.machine ?? '')), allFunctions: x.kind === 'gpu' } } }, title: `Pass ${x.product} to ${view.guest.name}` })} />}
          </div>
        )}
      </Section>

      {isLxc && (
        <Section title="Portable GPU (follows the guest between nodes)" note="One config covering every node's GPU, so wherever HA starts the container it binds the GPU that node has. Nothing runs at failover time.">
          {d && <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>{d.portable.whyRaw}</p>}
          {d && <Notice kind="warn">{d.portable.noWriter}</Notice>}
          <GhostButton onClick={() => setChange({ change: { kind: 'gpu-portable' }, title: `Portable GPU for ${view.guest.name}` })}>Show the portable lines for every node</GhostButton>
          {view.guest.haManaged && <p className="text-[12px]" style={{ color: 'var(--text-dimmer)' }}>After an HA move HyperProx checks inside the container for a GPU and sends a notification saying which GPU it now uses, or that it is on the CPU.</p>}
        </Section>
      )}

      <Section title="Other devices" note="Serial sticks, USB devices, cameras, TPUs and /dev/net/tun, by their most stable name.">
        {devEntries.length === 0 ? <p className="text-sm" style={{ color: 'var(--text-dimmer)' }}>None.</p> : (
          <ul className="space-y-1">{devEntries.map(([k, v]) => (
            <li key={k} className="flex items-center gap-2 flex-wrap rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-dim)' }}>
              <span className="font-mono text-xs break-all" style={{ color: 'var(--text)' }}>{k}: {String(v)}</span>
              {canEdit && <GhostButton className="ml-auto" style={{ height: 30 }} onClick={() => setChange({ change: { kind: 'device', device: { deviceId: '', remove: k } }, title: `Remove ${k}` })}>Remove</GhostButton>}
            </li>))}
          </ul>
        )}
        {canEdit && <GhostButton onClick={() => setPicking(picking === 'device' ? null : 'device')}>Share a device…</GhostButton>}
        {picking === 'device' && <DevicePicker guestNode={view.guest.node} otherNodes={others}
          filter={x => !['gpu', 'pci'].includes(x.kind) && (isLxc ? x.shareAs.some(s => s.startsWith('lxc')) : x.shareAs.some(s => s.startsWith('vm-') && s !== 'vm-hostpci'))}
          onPick={x => setChange({ change: { kind: 'device', device: { deviceId: x.id } }, title: `Share ${x.product} with ${view.guest.name}` })} />}
      </Section>

      {!d && !err && <BusyNote>Reading GPU details…</BusyNote>}
      {d?.inventoryProblem && <Notice kind="warn">{d.inventoryProblem}</Notice>}
      {change && <PreviewDialog guest={view.guest} change={change.change} title={change.title} onClose={() => { setChange(null); setPicking(null) }} onApplied={onSaved} />}
    </div>
  )
}
