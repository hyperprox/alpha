'use client'

import { useEffect, useRef, useState } from 'react'
import type { RemoteCell, RemoteJob, RemoteMachineRow, RemoteManualKey, RemoteProviderId } from '@hyperprox/types'
import { Badge, Btn, ConfirmDialog, Notice, Panel, StepIcon, TH, THEAD_STYLE, fmtTime } from '@/components/updates/ui'

// Pieces of the Remote access page. Built from the Updates primitives so the page looks like the rest of
// HyperProx.

export const PROVIDERS: RemoteProviderId[] = ['tailscale', 'netbird']
export const PROVIDER_LABEL: Record<RemoteProviderId, string> = { tailscale: 'Tailscale', netbird: 'NetBird' }

const ROUTING_WARNING =
  'Cluster traffic (corosync, Ceph, migration) must stay on the LAN. Advertising a subnet that contains the cluster ' +
  'network from a node can move that traffic into the tunnel and get nodes fenced.'

const KIND_LABEL: Record<RemoteMachineRow['kind'], string> = { node: 'node', lxc: 'container', qemu: 'VM', host: 'host' }

const STATE: Record<RemoteCell['state'], { tone: 'good' | 'warn' | 'crit' | 'muted' | 'accent'; label: string; hint: string }> = {
  'connected':     { tone: 'good',   label: 'Connected',       hint: 'The provider reports this device online.' },
  'offline':       { tone: 'warn',   label: 'Offline',         hint: 'Known to the provider but not connected right now.' },
  'missing':       { tone: 'crit',   label: 'Missing',         hint: 'HyperProx installed it, but the provider no longer lists the device (deleted in its console?).' },
  'not-installed': { tone: 'muted',  label: 'Not installed',   hint: 'Not on this machine.' },
  'manual':        { tone: 'accent', label: 'Manual install',  hint: 'Windows or macOS: install the app yourself with a one-time key.' },
  'unconfigured':  { tone: 'muted',  label: '—',               hint: 'Set the provider up under Settings → Credentials → Remote access.' },
  'unknown':       { tone: 'muted',  label: 'Unknown',         hint: 'The provider could not be asked.' },
}

export function StateBadge({ cell }: { cell: RemoteCell }) {
  const s = STATE[cell.state]
  return <Badge tone={s.tone} title={s.hint}>{s.label}</Badge>
}

export type CellAction = 'install' | 'check' | 'update' | 'routing' | 'uninstall' | 'manual-key' | 'tun'

function Cell({ row, provider, cell, admin, busy, onAction }: {
  row: RemoteMachineRow; provider: RemoteProviderId; cell: RemoteCell; admin: boolean; busy: boolean
  onAction: (a: CellAction, row: RemoteMachineRow, p: RemoteProviderId) => void
}) {
  const installed = cell.managed && cell.state !== 'not-installed'
  const act = (a: CellAction) => () => onAction(a, row, provider)
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <StateBadge cell={cell} />
        {cell.mode === 'userspace' && <Badge tone="muted" title="Userspace networking: reachable over the overlay, its own traffic does not go through it">userspace</Badge>}
        {(cell.routes.length > 0 || cell.exitNode) && (
          <Badge tone="warn" title={[...cell.routes, ...(cell.exitNode ? ['exit node'] : [])].join(', ')}>routing</Badge>
        )}
        {!cell.managed && cell.state !== 'not-installed' && cell.state !== 'unconfigured' && cell.state !== 'manual' && (
          <Badge tone="muted" title="Found at the provider by name; not installed by HyperProx">not managed</Badge>
        )}
      </div>
      {(cell.ip || cell.version) && (
        <div className="font-mono text-xs" style={{ color: 'var(--text-soft)' }}>
          {cell.ip ?? ''}{cell.ip && cell.version ? ' · ' : ''}{cell.version ? `v${cell.version}` : ''}
        </div>
      )}
      {cell.lastSeen && cell.state !== 'connected' && <div className="text-xs" style={{ color: 'var(--text-dim)' }}>last seen {fmtTime(cell.lastSeen)}</div>}
      {admin && cell.state !== 'unconfigured' && (
        <div className="flex flex-wrap gap-1 pt-0.5">
          {installed ? (
            <>
              <Btn small disabled={busy} onClick={act('check')}>Check</Btn>
              <Btn small disabled={busy} onClick={act('update')}>Update</Btn>
              <Btn small disabled={busy} onClick={act('routing')}>Routing…</Btn>
              <Btn small kind="danger" disabled={busy} onClick={act('uninstall')}>Uninstall</Btn>
            </>
          ) : cell.state === 'manual' ? (
            <Btn small disabled={busy} onClick={act('manual-key')}>One-time key…</Btn>
          ) : cell.state === 'not-installed' ? (
            <>
              <Btn small disabled={busy || !row.running} onClick={act('install')} title={row.running ? undefined : 'Not running'}>Install</Btn>
              {(row.kind === 'host' || row.kind === 'qemu') && <Btn small disabled={busy} onClick={act('manual-key')}>One-time key…</Btn>}
            </>
          ) : null}
        </div>
      )}
    </div>
  )
}

export function MachinesTable({ rows, admin, busy, selected, onSelect, onAction }: {
  rows: RemoteMachineRow[]; admin: boolean; busy: boolean
  selected: Set<string>; onSelect: (ids: string[], on: boolean) => void
  onAction: (a: CellAction, row: RemoteMachineRow, p: RemoteProviderId) => void
}) {
  const all = rows.length > 0 && rows.every(r => selected.has(r.id))
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr style={THEAD_STYLE}>
            {admin && (
              <th scope="col" className={TH} style={{ width: 36 }}>
                <input type="checkbox" aria-label="Select all" checked={all} onChange={e => onSelect(rows.map(r => r.id), e.target.checked)} />
              </th>
            )}
            <th scope="col" className={TH}>MACHINE</th>
            {PROVIDERS.map(p => <th key={p} scope="col" className={TH}>{PROVIDER_LABEL[p].toUpperCase()}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id} style={{ borderBottom: '1px solid var(--border-dim)', verticalAlign: 'top' }}>
              {admin && (
                <td className="px-4 py-2.5">
                  <input type="checkbox" aria-label={`Select ${r.name}`} checked={selected.has(r.id)} onChange={e => onSelect([r.id], e.target.checked)} />
                </td>
              )}
              <td className="px-4 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold" style={{ color: 'var(--text-bright)' }}>{r.name}</span>
                  <Badge tone={r.kind === 'node' ? 'violet' : 'muted'}>{KIND_LABEL[r.kind]}{r.vmid ? ` ${r.vmid}` : ''}</Badge>
                  {!r.running && <Badge tone="muted">stopped</Badge>}
                </div>
                {r.node && r.kind !== 'node' && <div className="text-xs" style={{ color: 'var(--text-dim)' }}>on {r.node}</div>}
              </td>
              {PROVIDERS.map(p => (
                <td key={p} className="px-4 py-2.5">
                  <Cell row={r} provider={p} cell={r.cells[p]} admin={admin} busy={busy} onAction={onAction} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const STEP_ICON: Record<string, 'ok' | 'failed' | 'running' | 'skipped' | 'pending'> = { done: 'ok', failed: 'failed', running: 'running', skipped: 'skipped', pending: 'pending' }
const ACTION_TITLE: Record<RemoteJob['action'], string> = { install: 'Installing', check: 'Checking', update: 'Updating', routing: 'Changing routing', uninstall: 'Uninstalling' }

export function JobPanel({ job, onClose }: { job: RemoteJob; onClose: () => void }) {
  const el = useRef<HTMLPreElement>(null)
  const pinned = useRef(true)
  useEffect(() => { const e = el.current; if (e && pinned.current) e.scrollTop = e.scrollHeight }, [job.log])
  const title = `${ACTION_TITLE[job.action]} ${PROVIDER_LABEL[job.provider]}`
  return (
    <Panel title={title} right={
      <div className="flex items-center gap-2">
        <Badge tone={job.status === 'completed' ? 'good' : job.status === 'failed' ? 'crit' : 'accent'}>{job.status}</Badge>
        {job.status !== 'running' && <Btn small onClick={onClose}>Close</Btn>}
      </div>
    }>
      <div className="space-y-3 px-5 py-4">
        {job.error && <Notice tone="crit">{job.error}</Notice>}
        <ol className="divide-y rounded-md border" style={{ borderColor: 'var(--border)' }}>
          {job.steps.map(s => (
            <li key={s.machineId} className="flex items-start gap-3 px-3 py-1.5 text-sm" style={{ borderColor: 'var(--border-dim)' }}>
              <StepIcon status={STEP_ICON[s.status]} />
              <span className="w-40 shrink-0 truncate" style={{ color: 'var(--text-bright)' }}>{s.name}</span>
              <span className="min-w-0 flex-1 text-xs" style={{ color: s.status === 'failed' ? 'var(--crit-soft)' : 'var(--text-muted)' }}>
                {s.detail ?? (s.status === 'pending' ? 'waiting' : '')}
              </span>
            </li>
          ))}
        </ol>
        <pre ref={el} tabIndex={0} aria-label="Live log"
             onScroll={e => { const t = e.currentTarget; pinned.current = t.scrollHeight - t.scrollTop - t.clientHeight < 24 }}
             className="h-56 overflow-auto rounded-md border px-3 py-2 font-mono text-xs"
             style={{ background: 'var(--ground-inset)', borderColor: 'var(--border)', color: 'var(--text)' }}>
          {job.log || 'Waiting for output…'}
        </pre>
      </div>
    </Panel>
  )
}

const FIELD: React.CSSProperties = {
  background: 'var(--ground-deep)', border: '1px solid var(--border-strong)', color: 'var(--text-bright)',
  borderRadius: 6, padding: '6px 10px', fontSize: 14, width: '100%',
}

export function InstallDialog({ provider, rows, onCancel, onConfirm }: {
  provider: RemoteProviderId; rows: RemoteMachineRow[]
  onCancel: () => void; onConfirm: (o: { tags: string[] | undefined; mode: 'kernel' | 'userspace' }) => void
}) {
  const [tags, setTags] = useState('')
  const [userspace, setUserspace] = useState(false)
  const nodes = rows.filter(r => r.kind === 'node').length
  const containers = rows.filter(r => r.kind === 'lxc').length
  const parsed = tags.split(/[,\s]+/).map(t => t.trim()).filter(Boolean)
  return (
    <ConfirmDialog title={`Install ${PROVIDER_LABEL[provider]}`} onClose={onCancel}>
      <p className="text-sm" style={{ color: 'var(--text-soft)' }}>
        On {rows.length} machine{rows.length === 1 ? '' : 's'}, one at a time, in the order shown. It stops at the first failure.
        Each gets its own single-use key, which HyperProx revokes as soon as that install is done.
      </p>
      {nodes > 0 && (
        <Notice tone="info">
          {nodes} Proxmox node{nodes === 1 ? '' : 's'}: the client keeps the node&apos;s own DNS and routing table, and advertises nothing.
          HyperProx checks the default route, the resolver and quorum before and after, and undoes the install if any of them changed.
        </Notice>
      )}
      <label className="block text-sm" style={{ color: 'var(--text-muted)' }}>
        {provider === 'tailscale' ? 'Tags (blank: the defaults from Settings)' : 'Groups (blank: the defaults from Settings)'}
        <input style={{ ...FIELD, marginTop: 6 }} value={tags} onChange={e => setTags(e.target.value)}
               placeholder={provider === 'tailscale' ? 'tag:server' : 'servers'} />
      </label>
      {containers > 0 && (
        <label className="flex items-start gap-2 text-sm" style={{ color: 'var(--text-soft)' }}>
          <input type="checkbox" checked={userspace} onChange={e => setUserspace(e.target.checked)} className="mt-1" />
          <span>Use userspace networking for containers without /dev/net/tun. They can be reached over the overlay, but their own traffic does not go through it. Leave off to be told which containers need the device.</span>
        </label>
      )}
      <div className="flex justify-end gap-2">
        <Btn kind="primary" onClick={() => onConfirm({ tags: parsed.length ? parsed : undefined, mode: userspace ? 'userspace' : 'kernel' })}>Install</Btn>
        <Btn onClick={onCancel}>Cancel</Btn>
      </div>
    </ConfirmDialog>
  )
}

export function RoutingDialog({ row, provider, cell, onCancel, onConfirm }: {
  row: RemoteMachineRow; provider: RemoteProviderId; cell: RemoteCell
  onCancel: () => void; onConfirm: (o: { subnets: string[]; exitNode: boolean; acknowledge: boolean }) => void
}) {
  const [subnets, setSubnets] = useState(cell.routes.join('\n'))
  const [exitNode, setExitNode] = useState(cell.exitNode)
  const [ack, setAck] = useState(false)
  const list = subnets.split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
  const turningOn = list.length > 0 || exitNode
  return (
    <ConfirmDialog title={`Routing through ${row.name}`} onClose={onCancel}>
      {turningOn && <Notice tone={row.kind === 'node' ? 'crit' : 'warn'}>{ROUTING_WARNING}</Notice>}
      <label className="block text-sm" style={{ color: 'var(--text-muted)' }}>
        Subnets to offer through this machine, one per line (blank: none)
        <textarea style={{ ...FIELD, marginTop: 6, minHeight: 72, fontFamily: 'var(--font-mono, monospace)' }} value={subnets}
                  onChange={e => setSubnets(e.target.value)} placeholder="198.51.100.0/24" />
      </label>
      <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-soft)' }}>
        <input type="checkbox" checked={exitNode} onChange={e => setExitNode(e.target.checked)} />
        Offer this machine as an exit node (all internet traffic of devices that choose it)
      </label>
      {turningOn && (
        <label className="flex items-start gap-2 text-sm" style={{ color: 'var(--text-bright)' }}>
          <input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} className="mt-1" />
          I understand that cluster traffic must stay on the LAN.
        </label>
      )}
      <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
        {provider === 'tailscale' ? 'HyperProx advertises these and approves exactly these routes in Tailscale.' : 'HyperProx creates these as NetBird network routes with this peer as the router, for the All group.'}
      </p>
      <div className="flex justify-end gap-2">
        <Btn kind={turningOn ? 'danger' : 'primary'} disabled={turningOn && !ack} onClick={() => onConfirm({ subnets: list, exitNode, acknowledge: ack })}>
          {turningOn ? 'Turn routing on' : 'Turn routing off'}
        </Btn>
        <Btn onClick={onCancel}>Cancel</Btn>
      </div>
    </ConfirmDialog>
  )
}

export function UninstallDialog({ row, provider, onCancel, onConfirm }: {
  row: RemoteMachineRow; provider: RemoteProviderId; onCancel: () => void; onConfirm: () => void
}) {
  return (
    <ConfirmDialog title={`Uninstall ${PROVIDER_LABEL[provider]}`} onClose={onCancel}>
      <p className="text-sm" style={{ color: 'var(--text-soft)' }}>
        Removes the client and its state from {row.name}, then deletes the device from {PROVIDER_LABEL[provider]}.
        Anyone reaching {row.name} over {PROVIDER_LABEL[provider]} loses that access.
      </p>
      <div className="flex justify-end gap-2">
        <Btn kind="danger" onClick={onConfirm}>Uninstall</Btn>
        <Btn onClick={onCancel}>Cancel</Btn>
      </div>
    </ConfirmDialog>
  )
}

export function ManualKeyDialog({ row, provider, result, error, onRequest, onClose }: {
  row: RemoteMachineRow; provider: RemoteProviderId; result: RemoteManualKey | null; error: string | null
  onRequest: () => void; onClose: () => void
}) {
  const [copied, setCopied] = useState(false)
  return (
    <ConfirmDialog title={`${PROVIDER_LABEL[provider]} on ${row.name}`} onClose={onClose}>
      <p className="text-sm" style={{ color: 'var(--text-soft)' }}>
        HyperProx does not install on Windows or macOS. Download the app from the official page, then sign it in with a one-time key.
      </p>
      <a href={result?.downloadUrl ?? (provider === 'tailscale' ? 'https://tailscale.com/download' : 'https://docs.netbird.io/get-started/install')}
         target="_blank" rel="noreferrer noopener" className="text-sm underline" style={{ color: 'var(--accent)' }}>
        Official download page
      </a>
      {error && <Notice tone="crit">{error}</Notice>}
      {result ? (
        <div className="space-y-2">
          <Notice tone="warn">Shown once. It is single use and short-lived; HyperProx keeps no copy.</Notice>
          <code className="block break-all rounded-md border px-3 py-2 font-mono text-xs" style={{ background: 'var(--ground-inset)', borderColor: 'var(--border)', color: 'var(--text-bright)' }}>
            {result.secret}
          </code>
          <p className="text-xs" style={{ color: 'var(--text-dim)' }}>{result.note}</p>
          <Btn small onClick={() => { navigator.clipboard?.writeText(result.secret).then(() => setCopied(true)).catch(() => undefined) }}>{copied ? 'Copied' : 'Copy key'}</Btn>
        </div>
      ) : (
        <Btn kind="primary" onClick={onRequest}>Make a one-time key</Btn>
      )}
      <div className="flex justify-end"><Btn onClick={onClose}>Close</Btn></div>
    </ConfirmDialog>
  )
}
