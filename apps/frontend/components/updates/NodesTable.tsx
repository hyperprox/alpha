'use client'

import { Fragment, useState } from 'react'
import type { UpdatesNode, UpdatesPkgChange } from '@hyperprox/types'
import { Badge, Btn, Chevron, Icon, TH, THEAD_STYLE } from './ui'

export function PkgList({ pkgs }: { pkgs: UpdatesPkgChange[] }) {
  if (!pkgs.length) return <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Nothing pending.</p>
  return (
    <ul className="grid gap-x-6 gap-y-0.5 font-mono text-xs sm:grid-cols-2 lg:grid-cols-3">
      {pkgs.map(p => (
        <li key={p.name} className="truncate" title={`${p.name} ${p.from ?? 'new'} -> ${p.to}`}>
          <span style={{ color: 'var(--text-bright)' }}>{p.name}</span>{' '}
          <span style={{ color: 'var(--text-dim)' }}>{p.from ?? 'new'} → </span>
          <span style={{ color: 'var(--accent)' }}>{p.to}</span>
        </li>
      ))}
    </ul>
  )
}

export function PendingCell({ count, open, onToggle, label }: { count: number; open: boolean; onToggle: () => void; label: string }) {
  if (!count) return <span className="font-mono" style={{ color: 'var(--text-dimmer)' }}>0</span>
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} ${count} pending packages for ${label}`}
            className="inline-flex items-center gap-1.5 font-mono" style={{ color: 'var(--text-bright)' }}>
      <Chevron open={open} />{count}
    </button>
  )
}

export function NodesTable({ nodes, canReboot, rebootWhy, onReboot }: {
  nodes: UpdatesNode[]
  canReboot: boolean
  rebootWhy?: string
  onReboot: (n: UpdatesNode) => void
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr style={THEAD_STYLE}>
            <th scope="col" className={TH}>NODE</th>
            <th scope="col" className={TH}>PENDING</th>
            <th scope="col" className={TH}>FLAGS</th>
            <th scope="col" className={TH}>POLICY</th>
            <th scope="col" className={TH}>HOLDS / PIN</th>
            <th scope="col" className={TH}>REBOOT</th>
            <th scope="col" className={TH}><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {nodes.map(n => (
            <Fragment key={n.node}>
              <tr style={{ borderBottom: '1px solid var(--border-dim)' }}>
                <td className="px-4 py-2.5">
                  <span className="font-semibold" style={{ color: 'var(--text-bright)' }}>{n.node}</span>
                  {!n.online && <span className="ml-2"><Badge tone="crit">offline</Badge></span>}
                  {n.isSelf && <span className="ml-2"><Badge tone="accent" title="HyperProx itself runs on this node">runs HyperProx</Badge></span>}
                  {n.error && <div className="mt-0.5 text-xs" style={{ color: 'var(--crit-soft)' }}>{n.error}</div>}
                </td>
                <td className="px-4 py-2.5">
                  <PendingCell count={n.pending.length} open={!!open[n.node]} onToggle={() => setOpen(o => ({ ...o, [n.node]: !o[n.node] }))} label={n.node} />
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {n.kernelPending && <Badge tone="warn" title="A new kernel is among the pending packages">kernel</Badge>}
                    {n.cephPending && <Badge tone="violet" title="Ceph packages are pending; they update on every node together">ceph</Badge>}
                    {!n.kernelPending && !n.cephPending && <span style={{ color: 'var(--text-dimmer)' }}>—</span>}
                  </div>
                </td>
                <td className="px-4 py-2.5 font-mono text-xs" style={{ color: 'var(--text-soft)' }}>
                  {n.policy.upgrade} · reboot {n.policy.reboot}
                  {n.policy.order && <span style={{ color: 'var(--text-dim)' }}> · {n.policy.order}</span>}
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {n.holdsOk === false && <Badge tone="crit" title="A required apt hold is missing; the run stops before touching this node">holds missing</Badge>}
                    {n.pinOk === false && <Badge tone="crit" title="The required kernel pin is not set; the run stops before touching this node">pin missing</Badge>}
                    {n.holdsOk === true && <Badge tone="good">holds ok</Badge>}
                    {n.pinOk === true && <Badge tone="good">pin ok</Badge>}
                  </div>
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {n.rebootRequired && <Badge tone="warn">required</Badge>}
                    {n.rebootPending && <Badge tone="warn" title="A run deferred this reboot (manual policy, active streams or window ended)">pending</Badge>}
                    {!n.rebootRequired && !n.rebootPending && <span style={{ color: 'var(--text-dimmer)' }}>—</span>}
                  </div>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <span title={!canReboot ? rebootWhy : !n.online ? 'Node is offline' : undefined}>
                    <Btn small kind="danger" disabled={!canReboot || !n.online} onClick={() => onReboot(n)} aria-label={`Reboot ${n.node}`}>
                      <Icon name="reboot" />Reboot
                    </Btn>
                  </span>
                </td>
              </tr>
              {open[n.node] && (
                <tr style={{ borderBottom: '1px solid var(--border-dim)', background: 'var(--ground-inset)' }}>
                  <td colSpan={7} className="px-4 py-3"><PkgList pkgs={n.pending} /></td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}
