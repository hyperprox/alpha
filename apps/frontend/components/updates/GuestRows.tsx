'use client'

// One row per guest. Open it for its packages, apps and compose projects, and "Update just this".

import { useState } from 'react'
import type { UpdatesGuest, UpdatesTarget } from '@hyperprox/types'
import { isNoLoginText, unmanagedWords } from '@/lib/node-login'
import { guestChips, guestOrder, guestSelection, pkgSummary } from '@/lib/updates-overview'
import { Badge, Btn, Chevron, REASONS } from './ui'
import { PkgSummary } from './PkgList'

function snapshotWords(g: UpdatesGuest): string {
  return g.snapshotCapable ? 'snapshot first' : 'no snapshot possible here'
}

function GuestRow({ g, targets, disabled, onUpdate }: { g: UpdatesGuest; targets: UpdatesTarget[] | null; disabled: boolean; onUpdate: (ids: string[]) => void }) {
  const [all, setAll] = useState(false)
  const { head, more } = pkgSummary(g.pending)
  const sel = targets ? guestSelection(targets, g.vmid) : { ids: [], blocked: 'Still reading what can be updated.' }
  const images = (g.dockerImages ?? []).filter(i => i.latest !== null && i.latest !== i.current)
  const apps = (g.apps ?? []).filter(a => a.latest !== null && a.latest !== a.installed)
  const compose = g.compose ?? []
  return (
    <details className="group border-t first:border-t-0" style={{ borderColor: 'var(--hx-line)' }}>
      <summary className="flex min-h-[44px] cursor-pointer list-none flex-wrap items-center gap-2 py-2 [&::-webkit-details-marker]:hidden">
        <span className="group-open:rotate-90" aria-hidden style={{ transition: 'transform 120ms' }}><Chevron open={false} /></span>
        <span className="min-w-0 flex-1">
          <span className="font-semibold" style={{ color: 'var(--text-bright)', overflowWrap: 'anywhere' }}>{g.name}</span>{' '}
          <span className="font-mono text-xs" style={{ color: 'var(--text-muted)' }}>{g.type === 'lxc' ? 'ct' : 'vm'} {g.vmid}</span>
          <span className="block text-xs" style={{ color: 'var(--text-muted)' }}>on {g.node} · {snapshotWords(g)}{g.haManaged ? ' · HA' : ''}</span>
        </span>
        <span className="flex flex-wrap gap-1">
          {guestChips(g).map(c => <Badge key={c.label} tone={c.tone} title={c.title}>{c.label}</Badge>)}
        </span>
      </summary>
      <div className="space-y-2 pb-3 pl-5 text-sm" style={{ color: 'var(--text-soft)' }}>
        {g.error && <p className="text-xs" style={{ color: 'var(--crit-soft)', overflowWrap: 'anywhere' }}>{isNoLoginText(g.error) ? 'No saved node login' : g.error}</p>}
        {!g.snapshotCapable && <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Bind mounts or storage block snapshots, so this guest is updated without one{g.noSnapshotAckId ? ' only when you approve it in Advanced' : ''}.</p>}
        <PkgSummary pkgs={g.pending} head={head} more={more} open={all} onToggle={() => setAll(a => !a)} />
        {compose.length > 0 && (
          <ul className="space-y-0.5 font-mono text-xs" aria-label="Compose projects">
            {compose.map(p => (
              <li key={p.dir} className="truncate" title={p.dir}>
                <span style={{ color: 'var(--text-bright)' }}>{p.name ?? p.dir}</span>{' '}
                <span style={{ color: 'var(--text-dim)' }}>{p.images.filter(i => i.latest !== null && i.latest !== i.current).length} of {p.images.length} images newer</span>
              </li>
            ))}
          </ul>
        )}
        {!compose.length && images.length > 0 && (
          <ul className="space-y-0.5 font-mono text-xs" aria-label="Docker images">
            {images.map(i => <li key={i.image} className="truncate"><span style={{ color: 'var(--text-bright)' }}>{i.image}</span> <span style={{ color: 'var(--warn)' }}>newer image waiting</span></li>)}
          </ul>
        )}
        {apps.length > 0 && (
          <ul className="space-y-0.5 font-mono text-xs" aria-label="Apps">
            {apps.map(a => <li key={a.key} className="truncate"><span style={{ color: 'var(--text-bright)' }}>{a.name}</span> <span style={{ color: 'var(--text-dim)' }}>{a.installed} → </span><span style={{ color: 'var(--accent)' }}>{a.latest}</span></li>)}
          </ul>
        )}
        <div className="pt-1">
          <span title={sel.blocked}>
            <Btn small kind="ghost" disabled={disabled || !sel.ids.length} onClick={() => onUpdate(sel.ids)} aria-label={`Update just ${g.name}`}>Update just this</Btn>
          </span>
        </div>
      </div>
    </details>
  )
}

export function GuestRows({ guests, targets, disabled, onUpdate }: { guests: UpdatesGuest[]; targets: UpdatesTarget[] | null; disabled: boolean; onUpdate: (ids: string[]) => void }) {
  const managed = guests.filter(g => g.managed).sort(guestOrder)
  const skipped = guests.filter(g => !g.managed).sort((a, b) => a.node.localeCompare(b.node) || a.vmid - b.vmid)
  return (
    <div>
      {managed.map(g => <GuestRow key={g.vmid} g={g} targets={targets} disabled={disabled} onUpdate={onUpdate} />)}
      {skipped.length > 0 && (
        <details className="border-t pt-1" style={{ borderColor: 'var(--hx-line)' }}>
          <summary className="min-h-[44px] cursor-pointer py-2 text-sm font-semibold" style={{ color: 'var(--text-muted)' }}>Skipped ({skipped.length})</summary>
          <ul className="space-y-2 pb-2">
            {skipped.map(g => (
              <li key={g.vmid} className="flex flex-wrap items-baseline justify-between gap-2 text-sm" style={{ opacity: 0.8 }}>
                <span><b style={{ color: 'var(--text-bright)' }}>{g.name}</b> <span className="font-mono text-xs" style={{ color: 'var(--text-muted)' }}>{g.type === 'lxc' ? 'ct' : 'vm'} {g.vmid}</span></span>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{unmanagedWords(g, REASONS)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
