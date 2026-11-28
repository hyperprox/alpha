'use client'

// One row per node: its name and a few chips. Open it for what is pending, the policy that holds it, and its
// reboot (quiet, behind the same confirmation as before).

import { useState } from 'react'
import type { UpdatesNode } from '@hyperprox/types'
import { isNoLoginText } from '@/lib/node-login'
import { nodeChips, pkgSummary } from '@/lib/updates-overview'
import { Badge, Btn, Chevron } from './ui'
import { PkgSummary } from './PkgList'

function NodeRow({ n, canReboot, rebootWhy, onReboot, wait }: {
  n: UpdatesNode; canReboot: boolean; rebootWhy?: string; onReboot: (n: UpdatesNode) => void; wait: string | null
}) {
  const [all, setAll] = useState(false)
  const { head, more } = pkgSummary(n.pending)
  return (
    <details className="group border-t first:border-t-0" style={{ borderColor: 'var(--hx-line)' }}>
      <summary className="flex min-h-[44px] cursor-pointer list-none flex-wrap items-center gap-2 py-2 [&::-webkit-details-marker]:hidden">
        <span className="group-open:rotate-90" aria-hidden style={{ transition: 'transform 120ms' }}><Chevron open={false} /></span>
        <span className="min-w-0 flex-1 font-semibold" style={{ color: 'var(--text-bright)', overflowWrap: 'anywhere' }}>{n.node}</span>
        <span className="flex flex-wrap gap-1">
          {nodeChips(n).map(c => <Badge key={c.label} tone={c.tone} title={c.title}>{c.label}</Badge>)}
        </span>
      </summary>
      <div className="space-y-2 pb-3 pl-5 text-sm" style={{ color: 'var(--text-soft)' }}>
        {n.error && <p className="text-xs" style={{ color: 'var(--crit-soft)', overflowWrap: 'anywhere' }}>{isNoLoginText(n.error) ? 'No saved node login' : n.error}</p>}
        {n.upgradeNote && <p className="text-xs" style={{ color: 'var(--warn-2)' }}>{n.upgradeNote}</p>}
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Policy: <span className="font-mono">{n.policy.upgrade}</span>, reboot <span className="font-mono">{n.policy.reboot}</span>
          {n.policy.order ? <>, runs <span className="font-mono">{n.policy.order}</span></> : null}.
          {n.preview && <> apt&apos;s own simulation of <span className="font-mono">apt-get {n.preview.verb}</span>{n.preview.error ? `: ${n.preview.error}` : ''}.</>}
        </p>
        {(n.rebootRequired || n.rebootPending || n.preview?.rebootAfter) && (
          <p className="text-xs" style={{ color: 'var(--warn-2)' }}>
            {n.rebootRequired ? 'Reboot needed now.' : n.rebootPending ? 'A run deferred this reboot.' : 'A reboot will be needed after the update (kernel or firmware).'}
          </p>
        )}
        <PkgSummary pkgs={n.pending} head={head} more={more} open={all} onToggle={() => setAll(a => !a)} />
        {!!n.preview?.removals.length && <p className="text-xs" style={{ color: 'var(--crit-soft)' }}>Would remove: {n.preview.removals.join(', ')}</p>}
        {!!n.held?.length && <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Held, not offered (never installed or unheld): {n.held.join(', ')}</p>}
        <div className="pt-1">
          {wait ? (
            <span className="text-xs" style={{ color: 'var(--accent)' }}>{wait}</span>
          ) : (
            <span title={!canReboot ? rebootWhy : !n.online ? 'Node is offline' : undefined}>
              <Btn small kind="ghost" disabled={!canReboot || !n.online} onClick={() => onReboot(n)} aria-label={`Reboot ${n.node}`}>Reboot this node…</Btn>
            </span>
          )}
        </div>
      </div>
    </details>
  )
}

export function NodeRows({ nodes, canReboot, rebootWhy, onReboot, waitText }: {
  nodes: UpdatesNode[]
  canReboot: boolean
  rebootWhy?: string
  onReboot: (n: UpdatesNode) => void
  /** Automatic reboots: what a node that waits for its reboot says instead of the Reboot button (null: the button). */
  waitText?: (node: string) => string | null
}) {
  return (
    <div>
      {nodes.map(n => <NodeRow key={n.node} n={n} canReboot={canReboot} rebootWhy={rebootWhy} onReboot={onReboot} wait={waitText?.(n.node) ?? null} />)}
    </div>
  )
}
