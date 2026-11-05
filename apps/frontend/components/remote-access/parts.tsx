'use client'

import { useEffect, useRef, useState } from 'react'
import type { RemoteCell, RemoteFirewallPreview, RemoteHostKey, RemoteJob, RemoteMachineRow, RemoteManualKey, RemoteProviderId } from '@hyperprox/types'
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
  'connected':     { tone: 'good',   label: 'Connected',       hint: 'Online: reported by the provider, or by the client on the machine.' },
  'offline':       { tone: 'warn',   label: 'Offline',         hint: 'Known to the provider but not connected right now.' },
  'missing':       { tone: 'crit',   label: 'Missing',         hint: 'HyperProx installed it, but the provider no longer lists the device (deleted in its console?).' },
  'not-installed': { tone: 'muted',  label: 'Not installed',   hint: 'Not on this machine.' },
  'manual':        { tone: 'accent', label: 'Manual install',  hint: 'Windows or macOS: install the app yourself with a one-time key.' },
  'unconfigured':  { tone: 'muted',  label: '—',               hint: 'Set the provider up under Settings → Credentials → Remote access.' },
  'unknown':       { tone: 'muted',  label: 'Unknown',         hint: 'The provider could not be asked.' },
  'signed-out':    { tone: 'warn',   label: 'Signed out',      hint: 'The client is installed and running, but not signed in.' },
  'unchecked':     { tone: 'muted',  label: 'Not checked',     hint: 'Not looked at yet. An admin can press Refresh to check every machine.' },
  'excluded':      { tone: 'muted',  label: 'Excluded',        hint: 'HyperProx never looks inside this guest or changes it (VPN exclusions, or the Proxmox tag hyperprox-ignore).' },
}

export function StateBadge({ cell }: { cell: RemoteCell }) {
  const s = STATE[cell.state]
  return <Badge tone={s.tone} title={s.hint}>{s.label}</Badge>
}

export type CellAction = 'install' | 'one-click' | 'panel' | 'check' | 'update' | 'routing' | 'uninstall' | 'manual-key' | 'tun' | 'firewall' | 'adopt' | 'adopt-lock'

/** The probe found this client on the machine, and HyperProx did not install or adopt it. */
export function foundUnmanaged(cell: RemoteCell): boolean {
  return !cell.managed && !!cell.detectedText && cell.detectedText !== 'not installed'
}

function Cell({ row, provider, cell, admin, busy, configured, onAction }: {
  row: RemoteMachineRow; provider: RemoteProviderId; cell: RemoteCell; admin: boolean; busy: boolean; configured: boolean
  onAction: (a: CellAction, row: RemoteMachineRow, p: RemoteProviderId) => void
}) {
  const installed = cell.managed && cell.state !== 'not-installed'
  const found = foundUnmanaged(cell)
  const act = (a: CellAction) => () => onAction(a, row, provider)
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <StateBadge cell={cell} />
        {cell.pending && <Badge tone="warn" title="The provider is waiting for this device to be approved">approval</Badge>}
        {cell.loginPending && <Badge tone="warn" title="Waiting for a sign-in; admins can open the link in the panel">sign-in</Badge>}
        {cell.expiryWarning && <Badge tone="warn" title={cell.expiresAt ? `Key expires ${fmtTime(cell.expiresAt)}` : ''}>key expires soon</Badge>}
        {cell.adopted && <Badge tone="muted" title="It was already there; HyperProx recorded it without changing it">adopted</Badge>}
        {cell.mode === 'userspace' && <Badge tone="muted" title="Userspace networking: reachable over the overlay, its own traffic does not go through it">userspace</Badge>}
        {(cell.routes.length > 0 || cell.exitNode) && (
          <Badge tone="warn" title={[...cell.routes, ...(cell.exitNode ? ['exit node'] : [])].join(', ')}>routing</Badge>
        )}
        {found ? (
          <Badge tone="accent" title="The client is on this machine, but HyperProx did not install it. Manage it here to adopt it.">found, not managed by HyperProx</Badge>
        ) : !cell.managed && cell.state !== 'not-installed' && cell.state !== 'unconfigured' && cell.state !== 'manual' && cell.state !== 'unchecked' && (
          <Badge tone="muted" title="Found at the provider by name; not installed by HyperProx">not managed</Badge>
        )}
      </div>
      {cell.detectedText && cell.detectedText !== 'not installed' && (
        <div className="text-xs" style={{ color: 'var(--text-soft)' }} title={cell.checkedAt ? `Checked on the machine ${fmtTime(cell.checkedAt)}` : ''}>{cell.detectedText}</div>
      )}
      {cell.state === 'unchecked' && cell.lastError && <div className="text-xs" style={{ color: 'var(--text-dim)' }} title={cell.lastError}>could not check: {cell.lastError.slice(0, 80)}</div>}
      {(cell.ip || cell.version) && (
        <div className="font-mono text-xs" style={{ color: 'var(--text-soft)' }}>
          {cell.ip ?? ''}{cell.ip && cell.version ? ' · ' : ''}{cell.version ? `v${cell.version}` : ''}
        </div>
      )}
      {cell.dnsName && <div className="truncate font-mono text-xs" style={{ color: 'var(--text-dim)' }} title={cell.dnsName}>{cell.dnsName}</div>}
      {cell.lastSeen && cell.state !== 'connected' && <div className="text-xs" style={{ color: 'var(--text-dim)' }}>last seen {fmtTime(cell.lastSeen)}</div>}
      {cell.expiresAt && !cell.keyExpiryDisabled && <div className="text-xs" style={{ color: cell.expiryWarning ? 'var(--warn)' : 'var(--text-dim)' }}>key expires {fmtTime(cell.expiresAt)}</div>}
      {admin && !row.self && !row.excluded && cell.state !== 'unconfigured' && (
        <div className="flex flex-wrap gap-1 pt-0.5">
          {found ? (
            <>
              <Btn small kind="primary" disabled={busy} onClick={act('adopt')}
                   title={row.kind === 'node' ? 'Adopt it: recorded as it is, only if it already meets the node locks' : 'Adopt it: recorded as it is, nothing on the machine changes'}>Manage it here</Btn>
              {row.kind === 'node' && <Btn small disabled={busy} onClick={act('adopt-lock')} title="Adopt it and switch off overlay DNS, accepted routes, overlay SSH and client firewall rules, as a guarded change">Manage + apply node locks</Btn>}
            </>
          ) : installed ? (
            <>
              <Btn small disabled={busy} onClick={act('panel')}>Settings…</Btn>
              <Btn small disabled={busy} onClick={act('check')}>Check</Btn>
              <Btn small disabled={busy} onClick={act('update')}>Update</Btn>
              <Btn small disabled={busy} onClick={act('routing')}>Routing…</Btn>
              {row.kind === 'node' && <Btn small disabled={busy} onClick={act('firewall')} title="Let SSH and the web UI through the Proxmox firewall from the overlay">Firewall…</Btn>}
              <Btn small kind="danger" disabled={busy} onClick={act('uninstall')}>Uninstall</Btn>
            </>
          ) : cell.state === 'manual' ? (
            <Btn small disabled={busy} onClick={act('manual-key')}>One-time key…</Btn>
          ) : cell.state === 'not-installed' ? (
            <>
              <Btn small kind="primary" disabled={busy || !row.running || !configured} onClick={act('one-click')}
                   title={!configured ? 'Installing needs an API key (for the one-time install key): add it under Settings → Credentials → Remote access' : row.running ? 'Install with the defaults from VPN settings' : 'Not running'}>Install</Btn>
              <Btn small disabled={busy || !row.running || !configured} onClick={act('install')}>Advanced…</Btn>
              {(row.kind === 'host' || row.kind === 'qemu') && <Btn small disabled={busy} onClick={act('manual-key')}>One-time key…</Btn>}
            </>
          ) : null}
        </div>
      )}
    </div>
  )
}

export function MachinesTable({ rows, admin, busy, selected, onSelect, onAction, configured = {} }: {
  rows: RemoteMachineRow[]; admin: boolean; busy: boolean; configured?: Partial<Record<RemoteProviderId, boolean>>
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
                  <input type="checkbox" aria-label={`Select ${r.name}`} disabled={!!r.self || !!r.excluded} checked={selected.has(r.id)} onChange={e => onSelect([r.id], e.target.checked)} />
                </td>
              )}
              <td className="px-4 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold" style={{ color: 'var(--text-bright)' }}>{r.name}</span>
                  <Badge tone={r.kind === 'node' ? 'violet' : 'muted'}>{KIND_LABEL[r.kind]}{r.vmid ? ` ${r.vmid}` : ''}</Badge>
                  {!r.running && <Badge tone="muted">stopped</Badge>}
                  {r.excluded && <Badge tone="muted" title={r.excludedBy === 'tag' ? 'Proxmox tag hyperprox-ignore' : 'Listed under VPN exclusions'}>excluded</Badge>}
                  {r.self && <Badge tone="accent" title="HyperProx runs here. Its VPN client is shown read-only and never changed from this page.">this HyperProx</Badge>}
                </div>
                {r.node && r.kind !== 'node' && <div className="text-xs" style={{ color: 'var(--text-dim)' }}>on {r.node}</div>}
              </td>
              {PROVIDERS.map(p => (
                <td key={p} className="px-4 py-2.5">
                  <Cell row={r} provider={p} cell={r.cells[p]} admin={admin} busy={busy} configured={!!configured[p]} onAction={onAction} />
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
const ACTION_TITLE: Record<RemoteJob['action'], string> = { install: 'Installing', check: 'Checking', update: 'Updating', routing: 'Changing routing', uninstall: 'Uninstalling', recovery: 'Re-checking after a restart:', configure: 'Changing settings for' }

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
  onCancel: () => void; onConfirm: (o: { tags: string[] | undefined; mode: 'kernel' | 'userspace'; existing?: 'adopt' | 'adopt-lock' | 'replace'; auth?: 'key' | 'login' }) => void
}) {
  const [login, setLogin] = useState(false)
  const [tags, setTags] = useState('')
  const [userspace, setUserspace] = useState(false)
  const [existing, setExisting] = useState<'' | 'adopt' | 'adopt-lock' | 'replace'>('')
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
      <label className="flex items-start gap-2 text-sm" style={{ color: 'var(--text-soft)' }}>
        <input type="checkbox" checked={login} onChange={e => setLogin(e.target.checked)} className="mt-1" />
        <span>Sign in with my account instead of a key. HyperProx shows the sign-in link on the machine&apos;s panel and sends it to your private notification channels; it expires after about ten minutes.</span>
      </label>
      <label className="block text-sm" style={{ color: 'var(--text-muted)' }}>
        If {PROVIDER_LABEL[provider]} is already on a machine (not installed by HyperProx)
        <select value={existing} onChange={e => setExisting(e.target.value as any)} style={{ ...FIELD, marginTop: 6 }}>
          <option value="">Leave it alone and skip the machine</option>
          <option value="adopt">Adopt it: record it as it is, change nothing (on a Proxmox node only if it already meets the node locks)</option>
          <option value="adopt-lock">Adopt and apply the node locks: on a node, switch off overlay DNS, accepted routes, overlay SSH and client firewall rules, guarded</option>
          <option value="replace">Replace it: sign it in to this account (its state is kept aside and put back if anything goes wrong)</option>
        </select>
      </label>
      <div className="flex justify-end gap-2">
        <Btn kind="primary" onClick={() => onConfirm({ tags: parsed.length ? parsed : undefined, mode: userspace ? 'userspace' : 'kernel', existing: existing || undefined, auth: login ? 'login' : 'key' })}>Install</Btn>
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
  const [exitNode, setExitNode] = useState(cell.exitNode && row.kind !== 'node')
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
      {row.kind === 'node' ? (
        <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
          A Proxmox node is never made an exit node, and HyperProx never changes a node&apos;s IP forwarding: turn it on yourself first if this node should route.
          Subnets that overlap any corosync link, Ceph network or the node&apos;s own addresses are refused.
        </p>
      ) : (
        <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-soft)' }}>
          <input type="checkbox" checked={exitNode} onChange={e => setExitNode(e.target.checked)} />
          Offer this machine as an exit node (devices choose it; nobody&apos;s traffic moves until they do)
        </label>
      )}
      {turningOn && (
        <label className="flex items-start gap-2 text-sm" style={{ color: 'var(--text-bright)' }}>
          <input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} className="mt-1" />
          I understand that cluster traffic must stay on the LAN.
        </label>
      )}
      <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
        {provider === 'tailscale' ? 'HyperProx advertises these, approves exactly these routes in Tailscale, and checks the machine really advertises them.' : 'HyperProx creates these as NetBird routes with this peer as the router, for the hyperprox-routes group only (add the peers that should use them), and checks the client took the change.'}
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

export function FirewallDialog({ row, provider, preview, error, onCancel, onConfirm }: {
  row: RemoteMachineRow; provider: RemoteProviderId; preview: RemoteFirewallPreview | null; error: string | null
  onCancel: () => void; onConfirm: () => void
}) {
  return (
    <ConfirmDialog title={`Firewall on ${row.name}`} onClose={onCancel}>
      <p className="text-sm" style={{ color: 'var(--text-soft)' }}>
        On a node, {PROVIDER_LABEL[provider]} adds no firewall rules of its own, so the Proxmox firewall decides what the overlay may reach.
        HyperProx can add one rule: SSH and the web UI, from the overlay, on its interface. Never corosync, Ceph or migration.
      </p>
      {error && <Notice tone="crit">{error}</Notice>}
      {!preview && !error && <p className="text-sm" style={{ color: 'var(--text-dim)' }}>Reading the firewall…</p>}
      {preview && (
        <>
          <code className="block rounded-md border px-3 py-2 font-mono text-xs" style={{ background: 'var(--ground-inset)', borderColor: 'var(--border)', color: 'var(--text-bright)' }}>
            IN ACCEPT -i {preview.rule.iface} -source {preview.rule.source} -p {preview.rule.proto} -dport {preview.rule.dport}
          </code>
          <Notice tone={preview.clusterEnabled && !preview.exists ? 'info' : 'warn'}>{preview.message}</Notice>
        </>
      )}
      <div className="flex justify-end gap-2">
        <Btn kind="primary" disabled={!preview || !preview.clusterEnabled || preview.exists} onClick={onConfirm}>Add this rule</Btn>
        <Btn onClick={onCancel}>Cancel</Btn>
      </div>
    </ConfirmDialog>
  )
}

export function HostKeyDialog({ row, info, error, onCancel, onConfirm }: {
  row: RemoteMachineRow; info: RemoteHostKey | null; error: string | null; onCancel: () => void; onConfirm: () => void
}) {
  return (
    <ConfirmDialog title={`Host key for ${row.name}`} onClose={onCancel}>
      <p className="text-sm" style={{ color: 'var(--text-soft)' }}>
        HyperProx sends scripts only to a host whose key is pinned. Check this fingerprint against the machine itself
        (for example <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> on its console) before you trust it.
        The pin is shared with the Terminal.
      </p>
      {error && <Notice tone="crit">{error}</Notice>}
      {!info && !error && <p className="text-sm" style={{ color: 'var(--text-dim)' }}>Reading the key…</p>}
      {info && (
        <>
          <div className="text-sm" style={{ color: 'var(--text-muted)' }}>{info.host}:{info.port}</div>
          <code className="block break-all rounded-md border px-3 py-2 font-mono text-xs" style={{ background: 'var(--ground-inset)', borderColor: 'var(--border)', color: 'var(--text-bright)' }}>
            {info.fingerprint}
          </code>
          {info.pinned && info.pinned !== info.fingerprint && (
            <Notice tone="crit">A different key is pinned ({info.pinned}). If the machine was rebuilt, clear the old pin in the Terminal; HyperProx will not replace it.</Notice>
          )}
          {info.pinned === info.fingerprint && <Notice tone="info">This key is already pinned.</Notice>}
        </>
      )}
      <div className="flex justify-end gap-2">
        <Btn kind="primary" disabled={!info || !!info.pinned} onClick={onConfirm}>Trust this key</Btn>
        <Btn onClick={onCancel}>Cancel</Btn>
      </div>
    </ConfirmDialog>
  )
}
