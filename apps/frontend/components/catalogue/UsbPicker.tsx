'use client'

// =============================================================================
//  HyperProx — the USB devices on a node, for passing a stick into Home Assistant (Catalogue install)
//
//  Read-only: the node's own list of what is plugged in, over its login. Nothing is passed in until the install runs, and
//  the server checks again that each chosen device is still there. Without one chosen, nothing is passed in.
// =============================================================================

import { useEffect, useState } from 'react'
import { apiJson } from '@/lib/api'

interface Usb { id: string; name: string }

/** The chosen codes as a list, and a list back to the codes the install takes (comma separated, no empties). */
export const usbCodes = (v: string): string[] => v.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
export const usbValue = (ids: string[]): string => ids.join(',')

export function UsbPicker({ node, value, onChange }: { node: string; value: string; onChange: (v: string) => void }) {
  const [list, setList] = useState<Usb[] | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  useEffect(() => {
    if (!node) return
    let live = true
    setState('loading')
    void apiJson<{ data: Usb[] }>(`/api/catalogue/wizard/homeassistant/usb?node=${encodeURIComponent(node)}`).then(r => {
      if (!live) return
      if (r.ok && r.body?.data) { setList(r.body.data); setState('ready') } else setState('error')
    })
    return () => { live = false }
  }, [node])
  const chosen = usbCodes(value)
  const toggle = (id: string, on: boolean) => onChange(usbValue(on ? [...new Set([...chosen, id])] : chosen.filter(x => x !== id)))
  return (
    <div className="rounded-lg border p-4 space-y-2 min-w-0" style={{ borderColor: 'var(--border-soft)', background: 'var(--ground-inset)' }}>
      <p className="font-display text-[17px] font-semibold" style={{ color: 'var(--text-bright)' }}>USB devices on {node}</p>
      {state === 'loading' && <p className="text-[12px] animate-pulse" style={{ color: 'var(--text-dim)' }}>Looking at {node}…</p>}
      {state === 'error' && <p className="text-[12px]" style={{ color: 'var(--warn-2)' }}>HyperProx could not look at {node}&apos;s USB devices (it needs the node login). Nothing is passed in.</p>}
      {state === 'ready' && list && list.length === 0 && <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>No USB device is plugged into {node}. Nothing is passed in; a Zigbee or Z-Wave stick can be added later in Proxmox.</p>}
      {state === 'ready' && list && list.length > 0 && (
        <ul className="space-y-1">
          {list.map(d => (
            <li key={d.id}>
              <label className="flex items-start gap-2 text-sm" style={{ color: 'var(--text)' }}>
                <input type="checkbox" checked={chosen.includes(d.id)} onChange={e => toggle(d.id, e.target.checked)} />
                <span>{d.name} <span className="font-mono text-[12px]" style={{ color: 'var(--text-dim)' }}>{d.id}</span></span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[12px]" style={{ color: 'var(--text-dim)' }}>Optional. A device passed in ties the machine to this node.</p>
    </div>
  )
}
