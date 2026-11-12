'use client'

// =============================================================================
//  HyperProx — the ID and address a wizard offers, and the override confirmation
//
//  The server picks (Settings → Naming & addresses, else the numbering the
//  guests already follow, else a free address on the node's own network) and
//  pings each candidate from the node. The wizard shows where the pick came
//  from, fills it in until the person changes something, and asks for a typed
//  confirmation before DHCP under a "never" policy or an address outside the
//  range. The server checks the same again at preview and apply.
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import { apiJson } from '@/lib/api'

export interface NamingSettingsView {
  subnet: string; rangeStart: string; rangeEnd: string; gateway: string; dns: string[]; bridge: string; vlan?: number
  idScheme: 'next-free' | 'node-ip'; nodeIndex: Record<string, number>; dhcp: 'never' | 'warn' | 'allowed'
}

export interface Proposal {
  source: 'settings' | 'detected' | 'subnet' | 'none'
  label: string
  vmid: number
  ip: string
  gateway?: string
  bridge: string
  dns: string[]
  vlan?: number
  quiet?: boolean | null
  warnings: string[]
  settings?: NamingSettingsView
  detection: { verdict: 'follows' | 'mixed' | 'none'; matching: number; considered: number; total: number }
}

const toInt = (ip: string) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0)
const isIp = (ip: string) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(ip) && ip.split('.').every(o => Number(o) <= 255)

/** The same range test the server applies; the server decides. */
export function inRange(ip: string, s: Pick<NamingSettingsView, 'rangeStart' | 'rangeEnd'>): boolean {
  const bare = ip.split('/')[0]
  return isIp(bare) && toInt(bare) >= toInt(s.rangeStart) && toInt(bare) <= toInt(s.rangeEnd)
}

/** What the person must type to go against the saved settings, or null when nothing is needed. */
export function confirmNeeded(saved: NamingSettingsView | null | undefined, mode: 'dhcp' | 'static', ip: string): { word: string; why: string } | null {
  if (!saved) return null
  if (mode === 'dhcp') {
    return saved.dhcp === 'never'
      ? { word: 'DHCP', why: `Your naming settings never allow DHCP: new guests get a fixed address in ${saved.rangeStart}–${saved.rangeEnd}. DHCP can hand out an address on another network.` }
      : null
  }
  const bare = ip.split('/')[0]
  if (!isIp(bare) || inRange(bare, saved)) return null
  return { word: bare, why: `${bare} is outside your range ${saved.rangeStart}–${saved.rangeEnd}.` }
}

/** Ask the server for an ID and address on `node` when `active`; again with refresh(). */
export function useProposal(node: string, active: boolean) {
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const refresh = useCallback(async () => {
    if (!node) return
    setLoading(true); setError('')
    const r = await apiJson<{ data: Proposal }>('/api/catalogue/wizard/propose', 'POST', { node })
    setLoading(false)
    if (r.ok && r.body?.data) setProposal(r.body.data)
    else setError(r.error ?? 'Could not pick an address.')
  }, [node])
  useEffect(() => { setProposal(null); if (active && node) void refresh() }, [node, active, refresh])
  return { proposal, loading, error, refresh }
}

/** "Follows your numbering: CT 3xx ↔ 192.0.2.2xx", with what was picked and a way to take it again. */
export function NamingCallout({ proposal, loading, error, applied, onUse, onRefresh }: {
  proposal: Proposal | null; loading: boolean; error?: string; applied: boolean; onUse: () => void; onRefresh: () => void
}) {
  const tone = proposal?.ip === 'dhcp' ? 'var(--warn)' : 'var(--accent)'
  return (
    <div className="rounded-lg border px-4 py-3 space-y-1.5" role="status"
      style={{ borderColor: `color-mix(in srgb, ${tone} 40%, transparent)`, background: `color-mix(in srgb, ${tone} 7%, transparent)` }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em]" style={{ color: tone }}>
          {proposal?.source === 'settings' || proposal?.source === 'detected' ? 'Follows your numbering' : proposal?.source === 'subnet' ? 'Address on the node’s network' : 'ID and address'}
        </p>
        <div className="flex gap-2">
          {proposal && !applied && <button type="button" onClick={onUse} className="text-[12px] underline" style={{ color: 'var(--accent)' }}>Use this</button>}
          <button type="button" onClick={onRefresh} disabled={loading} className="text-[12px] underline" style={{ color: 'var(--text-muted)' }}>{loading ? 'Picking…' : 'Pick again'}</button>
        </div>
      </div>
      {loading && !proposal && <p className="text-sm animate-pulse" style={{ color: 'var(--text-muted)' }}>Picking the next free ID and address, and pinging it from the node…</p>}
      {error && <p className="text-sm" style={{ color: 'var(--crit-soft)' }}>{error}</p>}
      {proposal && (
        <p className="text-sm" style={{ color: 'var(--text-bright)' }}>
          {proposal.ip === 'dhcp'
            ? <>CT {proposal.vmid} · DHCP</>
            : <>CT {proposal.vmid} · {proposal.ip.split('/')[0]} <span style={{ color: 'var(--text-muted)' }}>({proposal.label})</span></>}
          {proposal.ip !== 'dhcp' && proposal.quiet === true && <span style={{ color: 'var(--text-muted)' }}> · nothing answered a ping or ARP</span>}
          {applied ? <span style={{ color: 'var(--text-muted)' }}> · filled in below; change anything you like</span> : <span style={{ color: 'var(--text-muted)' }}> · you changed it below</span>}
        </p>
      )}
      {proposal?.source === 'detected' && (
        <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
          Read from your guests ({proposal.detection.matching} of {proposal.detection.considered} with a fixed address follow it). Save it under Settings → Naming &amp; addresses to make it the rule.
        </p>
      )}
      {proposal?.warnings.map((w, i) => <p key={i} className="text-[12px]" style={{ color: 'var(--warn-2)' }}>⚠ {w}</p>)}
    </div>
  )
}

/** The typed confirmation an override needs. */
export function ConfirmOverride({ need, value, onChange, inputStyle }: {
  need: { word: string; why: string }; value: string; onChange: (v: string) => void; inputStyle?: React.CSSProperties
}) {
  const ok = value.trim().toUpperCase() === need.word.toUpperCase()
  return (
    <div className="rounded-lg border p-3 space-y-2" style={{ borderColor: 'color-mix(in srgb, var(--crit) 40%, transparent)', background: 'color-mix(in srgb, var(--crit) 6%, transparent)' }}>
      <p className="text-sm" style={{ color: 'var(--crit-soft)' }}>{need.why}</p>
      <label className="block text-sm" style={{ color: 'var(--text)' }}>
        Type <b className="font-mono">{need.word}</b> to go ahead anyway. It is recorded in the audit log.
        <input value={value} onChange={e => onChange(e.target.value)} aria-invalid={!ok} autoCapitalize="none" spellCheck={false}
          className="mt-1 block w-full" style={inputStyle} placeholder={need.word} />
      </label>
    </div>
  )
}
