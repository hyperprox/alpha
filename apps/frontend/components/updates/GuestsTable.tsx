'use client'

import { Fragment, useState } from 'react'
import type { UpdatesGuest } from '@hyperprox/types'
import { Badge, TH, THEAD_STYLE, REASONS } from './ui'
import { PendingCell, PkgList } from './NodesTable'

const byNodeThenId = (a: UpdatesGuest, b: UpdatesGuest) => a.node.localeCompare(b.node) || a.vmid - b.vmid

function imageUpdates(g: UpdatesGuest) {
  return (g.dockerImages ?? []).filter(i => i.latest !== null && i.latest !== i.current)
}

export function GuestsTable({ guests }: { guests: UpdatesGuest[] }) {
  const [open, setOpen] = useState<Record<number, boolean>>({})
  const managed = guests.filter(g => g.managed).sort(byNodeThenId)
  const unmanaged = guests.filter(g => !g.managed).sort(byNodeThenId)

  const row = (g: UpdatesGuest, dim: boolean) => {
    const imgs = imageUpdates(g)
    const expandable = g.pending.length > 0 || (g.dockerImages?.length ?? 0) > 0
    return (
      <Fragment key={g.vmid}>
        <tr style={{ borderBottom: '1px solid var(--border-dim)', opacity: dim ? 0.55 : 1 }}>
          <td className="px-4 py-2.5 font-mono" style={{ color: 'var(--text-muted)' }}>{g.vmid}</td>
          <td className="px-4 py-2.5">
            <span className="font-semibold" style={{ color: 'var(--text-bright)' }}>{g.name}</span>
            {g.error && <div className="mt-0.5 text-xs" style={{ color: 'var(--crit-soft)' }}>{g.error}</div>}
          </td>
          <td className="px-4 py-2.5"><span className="font-mono text-xs" style={{ color: g.type === 'lxc' ? 'var(--accent)' : 'var(--violet)' }}>{g.type === 'lxc' ? 'LXC' : 'VM'}</span></td>
          <td className="px-4 py-2.5" style={{ color: 'var(--text-soft)' }}>{g.node}</td>
          {dim ? (
            <td colSpan={4} className="px-4 py-2.5 text-sm" style={{ color: 'var(--text-muted)' }}>
              Not managed: {g.unmanagedReason ? REASONS[g.unmanagedReason] ?? g.unmanagedReason : 'unknown reason'}
            </td>
          ) : (
            <>
              <td className="px-4 py-2.5">
                {expandable
                  ? <PendingCell count={g.pending.length} open={!!open[g.vmid]} onToggle={() => setOpen(o => ({ ...o, [g.vmid]: !o[g.vmid] }))} label={g.name} />
                  : <span className="font-mono" style={{ color: 'var(--text-dimmer)' }}>0</span>}
              </td>
              <td className="px-4 py-2.5">
                {g.docker === 'none' ? <span style={{ color: 'var(--text-dimmer)' }}>—</span> : (
                  <div className="flex flex-wrap gap-1">
                    <Badge tone={g.docker === 'auto' ? 'accent' : 'muted'} title={g.docker === 'auto' ? 'Images are pulled and restarted by a run' : 'New images are reported, never pulled'}>docker {g.docker}</Badge>
                    {imgs.length > 0 && <Badge tone="warn">{imgs.length} image{imgs.length === 1 ? '' : 's'} newer</Badge>}
                  </div>
                )}
              </td>
              <td className="px-4 py-2.5">
                <div className="flex flex-wrap gap-1">
                  {g.haManaged && <Badge tone="violet" title="Started and stopped through ha-manager">HA</Badge>}
                  {g.rebootRequired && <Badge tone="warn">reboot required</Badge>}
                  {!g.haManaged && !g.rebootRequired && <span style={{ color: 'var(--text-dimmer)' }}>—</span>}
                </div>
              </td>
              <td className="px-4 py-2.5">
                {g.snapshotCapable ? <Badge tone="good" title="A snapshot is taken before upgrading">snapshot</Badge>
                  : <Badge tone="muted" title="Bind mounts or storage block snapshots; the run records that and continues">no snapshot</Badge>}
              </td>
            </>
          )}
        </tr>
        {!dim && open[g.vmid] && (
          <tr style={{ borderBottom: '1px solid var(--border-dim)', background: 'var(--ground-inset)' }}>
            <td colSpan={8} className="space-y-3 px-4 py-3">
              <PkgList pkgs={g.pending} />
              {g.dockerImages && g.dockerImages.length > 0 && (
                <ul className="font-mono text-xs">
                  {g.dockerImages.map(i => (
                    <li key={i.image} className="truncate">
                      <span style={{ color: 'var(--text-bright)' }}>{i.image}</span>{' '}
                      <span style={{ color: 'var(--text-dim)' }}>{i.current.slice(0, 19)}</span>
                      {i.latest === null ? <span style={{ color: 'var(--text-dimmer)' }}> · latest unknown</span>
                        : i.latest === i.current ? <span style={{ color: 'var(--good)' }}> · current</span>
                        : <span style={{ color: 'var(--warn)' }}> → {i.latest.slice(0, 19)}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </td>
          </tr>
        )}
      </Fragment>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr style={THEAD_STYLE}>
            <th scope="col" className={TH}>ID</th>
            <th scope="col" className={TH}>NAME</th>
            <th scope="col" className={TH}>TYPE</th>
            <th scope="col" className={TH}>NODE</th>
            <th scope="col" className={TH}>PENDING</th>
            <th scope="col" className={TH}>DOCKER</th>
            <th scope="col" className={TH}>STATE</th>
            <th scope="col" className={TH}>ROLLBACK</th>
          </tr>
        </thead>
        <tbody>
          {managed.map(g => row(g, false))}
          {unmanaged.length > 0 && (
            <tr style={{ background: 'var(--ground-inset)' }}>
              <th scope="rowgroup" colSpan={8} className="px-4 py-2 text-left font-mono font-normal" style={{ color: 'var(--text-dimmer)', fontSize: 11, letterSpacing: '0.1em' }}>
                NOT MANAGED ({unmanaged.length})
              </th>
            </tr>
          )}
          {unmanaged.map(g => row(g, true))}
        </tbody>
      </table>
    </div>
  )
}
