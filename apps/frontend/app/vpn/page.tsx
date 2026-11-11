'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import type { RemoteFirewallPreview, RemoteHostKey, RemoteJob, RemoteMachineRow, RemoteManualKey, RemoteOverview, RemoteProviderId } from '@hyperprox/types'
import { apiJson, atLeast, type ApiResult } from '@/lib/api'
import { useSession } from '@/lib/session'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { MachinePanel, OneClickDialog, PendingDevices } from '@/components/remote-access/vpn-panel'
import { WireguardSection } from '@/components/remote-access/WireguardSection'
import { Badge, Btn, Notice, fmtTime } from '@/components/updates/ui'
import { Empty, Panel } from '@/components/remote-access/panel'
import { GlowBars, HudHeader, Page, Panel as KitPanel, Pill, type PillTone, type StatChip } from '@/components/visual/kit'
import {
  FirewallDialog, HostKeyDialog, InstallDialog, JobPanel, MachinesTable, ManualKeyDialog, PROVIDERS, PROVIDER_LABEL, RoutingDialog, UninstallDialog, type CellAction,
} from '@/components/remote-access/parts'

type Dialog =
  | { kind: 'install'; provider: RemoteProviderId; rows: RemoteMachineRow[] }
  | { kind: 'routing'; provider: RemoteProviderId; row: RemoteMachineRow }
  | { kind: 'uninstall'; provider: RemoteProviderId; row: RemoteMachineRow }
  | { kind: 'manual'; provider: RemoteProviderId; row: RemoteMachineRow; result: RemoteManualKey | null; error: string | null }
  | { kind: 'firewall'; provider: RemoteProviderId; row: RemoteMachineRow; preview: RemoteFirewallPreview | null; error: string | null }
  | { kind: 'host-key'; row: RemoteMachineRow; info: RemoteHostKey | null; error: string | null }
  | { kind: 'one-click'; provider: RemoteProviderId; row: RemoteMachineRow }
  | { kind: 'panel'; provider: RemoteProviderId; row: RemoteMachineRow }

const enc = encodeURIComponent

export default function VpnPage() {
  const { role } = useSession()
  const admin = atLeast(role, 'admin')
  const [ov, setOv] = useState<RemoteOverview | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkProvider, setBulkProvider] = useState<RemoteProviderId>('tailscale')
  const [job, setJob] = useState<RemoteJob | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [notice, setNotice] = useState<{ tone: 'info' | 'warn' | 'crit'; text: string } | null>(null)
  const [confirm, setConfirm] = useState<null | (() => void)>(null)
  const jobRef = useRef<RemoteJob | null>(null)
  jobRef.current = job

  const load = useCallback(async () => {
    const r = await apiJson<RemoteOverview>('/api/remote/overview')
    if (r.ok && r.body) { setOv(r.body); setErr(null) } else setErr(r.status === 404 ? 'The VPN API is not available on this server yet.' : r.error ?? 'Could not load')
  }, [])
  useEffect(() => { if (role) load() }, [role, load])

  // A link from another page (/vpn?machine=lxc-101&provider=tailscale) opens that machine's panel.
  const deepLinked = useRef(false)
  useEffect(() => {
    if (!ov || !admin || deepLinked.current) return
    deepLinked.current = true
    const q = new URLSearchParams(window.location.search)
    const row = ov.machines.find(m => m.id === q.get('machine'))
    const p = q.get('provider') === 'netbird' ? 'netbird' : 'tailscale'
    if (row && row.cells[p].managed) setDialog({ kind: 'panel', provider: p, row })
  }, [ov, admin])

  // Live progress: poll the running job until it settles, then re-read the table.
  useEffect(() => {
    if (!job || job.status !== 'running') return
    const t = setInterval(async () => {
      const r = await apiJson<{ job: RemoteJob }>(`/api/remote/jobs/${enc(job.id)}`)
      if (r.ok && r.body?.job) {
        setJob(r.body.job)
        if (r.body.job.status !== 'running') load()
      }
    }, 1500)
    return () => clearInterval(t)
  }, [job, load])

  // A job someone else started (or one from before a reload) is picked up so the page shows it.
  useEffect(() => {
    if (!admin || !ov?.activeJobId || jobRef.current?.id === ov.activeJobId) return
    apiJson<{ job: RemoteJob }>(`/api/remote/jobs/${enc(ov.activeJobId)}`).then(r => { if (r.ok && r.body?.job) setJob(r.body.job) })
  }, [admin, ov?.activeJobId])

  /** Send a request; when the gate wants the master password again, ask once and resend. */
  const send = useCallback(async <T,>(path: string, method: string, body?: unknown): Promise<ApiResult<T> | null> => {
    const r = await apiJson<T>(path, method, body)
    if (r.status === 403 && r.code === 'reconfirm_required') {
      return new Promise(resolve => setConfirm(() => async () => { setConfirm(null); resolve(await apiJson<T>(path, method, body)) }))
    }
    return r
  }, [])

  const started = (r: ApiResult<{ job: RemoteJob }> | null) => {
    if (!r) return
    if (r.ok && r.body?.job) { setJob(r.body.job); setNotice(null); return }
    setNotice({ tone: 'crit', text: r.error ?? 'Could not start' })
  }

  const onAction = async (a: CellAction, row: RemoteMachineRow, p: RemoteProviderId) => {
    setNotice(null)
    if (a === 'install') { setDialog({ kind: 'install', provider: p, rows: [row] }); return }
    if (a === 'one-click') { setDialog({ kind: 'one-click', provider: p, row }); return }
    if (a === 'panel') { setDialog({ kind: 'panel', provider: p, row }); return }
    if (a === 'routing') { setDialog({ kind: 'routing', provider: p, row }); return }
    if (a === 'uninstall') { setDialog({ kind: 'uninstall', provider: p, row }); return }
    if (a === 'manual-key') { setDialog({ kind: 'manual', provider: p, row, result: null, error: null }); return }
    if (a === 'firewall') {
      setDialog({ kind: 'firewall', provider: p, row, preview: null, error: null })
      const r = await apiJson<RemoteFirewallPreview>(`/api/remote/machines/${enc(row.id)}/${p}/firewall`)
      setDialog(d => (d?.kind === 'firewall' ? { ...d, preview: r.ok ? r.body : null, error: r.ok ? null : r.error ?? 'Could not read the firewall' } : d))
      return
    }
    if (a === 'adopt' || a === 'adopt-lock') {
      // Manage it here: the adopt flow, with the node-lock rules; it works without an API key.
      started(await send<{ job: RemoteJob }>('/api/remote/jobs', 'POST', { provider: p, machineIds: [row.id], existing: a }))
      return
    }
    if (a === 'check' || a === 'update') started(await send<{ job: RemoteJob }>(`/api/remote/machines/${enc(row.id)}/${p}/${a}`, 'POST'))
  }

  const addTun = async (row: RemoteMachineRow) => {
    const r = await send<{ applied: boolean; message: string; command?: string }>(`/api/remote/machines/${enc(row.id)}/tun`, 'POST')
    if (!r) return
    setNotice(r.ok && r.body ? { tone: r.body.applied ? 'info' : 'warn', text: r.body.message } : { tone: 'crit', text: r.error ?? 'Could not change the container' })
  }

  const openHostKey = async (row: RemoteMachineRow) => {
    setDialog({ kind: 'host-key', row, info: null, error: null })
    const r = await apiJson<RemoteHostKey>(`/api/remote/machines/${enc(row.id)}/host-key`)
    setDialog(d => (d?.kind === 'host-key' ? { ...d, info: r.ok ? r.body : null, error: r.ok ? null : r.error ?? 'Could not read the key' } : d))
  }

  const [refreshing, setRefreshing] = useState(false)
  const refresh = async () => {
    setRefreshing(true)
    const r = await apiJson<RemoteOverview & { refreshNote?: string | null }>('/api/remote/detect/refresh', 'POST')
    setRefreshing(false)
    if (r.ok && r.body) { setOv(r.body); if (r.body.refreshNote) setNotice({ tone: 'info', text: r.body.refreshNote }) }
    else setNotice({ tone: 'crit', text: r.error ?? 'Could not check the machines' })
  }

  // While the machines are being checked (an admin's page load started it), reload until it is done.
  useEffect(() => {
    if (!ov?.detection.running) return
    const t = setTimeout(() => { load() }, 3000)
    return () => clearTimeout(t)
  }, [ov, load])

  const busy = job?.status === 'running'
  const rows = ov?.machines ?? []
  const selectedRows = rows.filter(r => selected.has(r.id))
  // Containers the last job stopped on for want of /dev/net/tun.
  // Machines the last job refused because their host key was never pinned.
  const pinAsk = job && job.status === 'failed'
    ? job.steps.filter(s => s.status === 'failed' && /no pinned host key/.test(s.detail ?? '')).map(s => rows.find(r => r.id === s.machineId)).filter((r): r is RemoteMachineRow => !!r)
    : []
  const tunAsk = job && job.status === 'failed'
    ? job.steps.filter(s => s.status === 'failed' && /\/dev\/net\/tun/.test(s.detail ?? '')).map(s => rows.find(r => r.id === s.machineId)).filter((r): r is RemoteMachineRow => !!r && r.kind === 'lxc')
    : []

  // Per provider, how the machines stand: the picture the HUD and the tunnels panel are drawn from.
  const tally = (p: RemoteProviderId) => {
    const states = rows.map(r => r.cells[p].state)
    return {
      connected: states.filter(s => s === 'connected').length,
      offline: states.filter(s => s === 'offline' || s === 'signed-out' || s === 'missing').length,
      installed: rows.filter(r => r.cells[p].managed && r.cells[p].state !== 'not-installed').length,
    }
  }
  const tallies = ov ? ov.providers.map(p => ({ p, ...tally(p.id) })) : []
  const connectedTotal = tallies.reduce((n, x) => n + x.connected, 0)
  const troubled = tallies.reduce((n, x) => n + x.offline, 0) + (ov?.providers.filter(p => p.error).length ?? 0)
  const chips: StatChip[] = ov ? [
    { label: 'machines', value: rows.length },
    { label: 'tunnels connected', value: connectedTotal, tone: connectedTotal ? 'good' : undefined },
    { label: 'offline or signed out', value: troubled, tone: troubled ? 'warn' : undefined },
    { label: 'waiting for approval', value: ov.pendingDevices.length, tone: ov.pendingDevices.length ? 'warn' : undefined },
  ] : []
  const title = !ov ? (err ? 'VPN unavailable' : 'Reading VPN status')
    : troubled ? `${troubled} tunnel${troubled === 1 ? ' is' : 's are'} down or signed out`
    : connectedTotal ? `${connectedTotal} tunnel${connectedTotal === 1 ? ' is' : 's are'} connected`
    : 'No tunnels connected yet'

  return (
    <Page>
      <HudHeader eyebrow="Manage" title={title} icon="mesh" level={2} chips={chips} label="VPN overview">
        <p className="text-sm" style={{ color: 'var(--text-soft)', margin: 0, maxWidth: '60ch' }}>
          Reach your nodes and guests from anywhere through Tailscale or NetBird, without opening a port.
          HyperProx installs the client from the official repository, signs it in with a key made for that one install,
          and keeps a Proxmox node&apos;s DNS and routing exactly as they were.
        </p>
      </HudHeader>

      {err && <Notice tone="crit">{err}</Notice>}
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

      {ov && (
        <KitPanel title="Providers" sub={ov.detection.running ? 'checking every machine…' : ov.detection.checkedAt ? `checked ${fmtTime(ov.detection.checkedAt)}` : 'machines not checked yet'}
          actions={admin ? <Btn small disabled={refreshing || ov.detection.running} onClick={refresh} title="Look at every running node and guest now (read-only)">Refresh</Btn> : undefined}>
          <ul className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 18rem), 1fr))', listStyle: 'none', padding: 0, margin: 0 }} aria-label="VPN providers">
            {tallies.map(({ p, connected, offline, installed }) => {
              const state: { text: string; tone: PillTone | undefined } = !p.configured ? { text: 'not set up', tone: undefined }
                : p.error ? { text: 'error', tone: 'bad' } : { text: 'ready', tone: 'good' }
              return (
                <li key={p.id} className="rounded-lg p-3" style={{ background: 'var(--ground-deep)', border: '1px solid var(--border-soft)', minWidth: 0 }}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-display font-semibold" style={{ color: 'var(--text-bright)', fontSize: 18 }}>{p.label}</span>
                    <Pill tone={state.tone}>{state.text}</Pill>
                    {p.configured && !p.error && <Pill tone="accent">{p.devices} device{p.devices === 1 ? '' : 's'}</Pill>}
                  </div>
                  {p.configured && !p.error ? (
                    <div className="mt-2 text-xs font-mono" style={{ color: 'var(--text-soft)' }}>
                      {connected} connected · {offline} offline or signed out · {installed} installed by HyperProx
                    </div>
                  ) : <div className="mt-2 text-xs" style={{ color: 'var(--text-soft)' }}>{p.summary}</div>}
                  {p.error && <div className="mt-1 text-xs" style={{ color: 'var(--crit)' }}>{p.error}</div>}
                  {admin && <Link href="/settings?tab=remote" className="mt-2 inline-block text-xs underline" style={{ color: 'var(--accent)' }}>{p.configured ? 'Settings' : 'Add an API key'}</Link>}
                </li>
              )
            })}
          </ul>
          {rows.length > 0 && tallies.some(x => x.p.configured && !x.p.error) && (
            <div style={{ marginTop: 14 }}>
              <GlowBars label="Machines connected through each provider" max={rows.length}
                items={tallies.filter(x => x.p.configured && !x.p.error).map(x => ({ key: x.p.id, label: x.p.label, value: x.connected, text: `${x.connected} of ${rows.length}` }))} />
            </div>
          )}
        </KitPanel>
      )}

      {ov && ov.attention.some(a => a.interrupted) && (
        <Notice tone="crit">
          A restart interrupted a change on {ov.attention.filter(a => a.interrupted).map(a => rows.find(r => r.id === a.machineId)?.name ?? a.machineId).join(', ')}.
          HyperProx re-checks it (and rolls it back if the node differs) as soon as it can reach the node.
        </Notice>
      )}
      {admin && ov && ov.pendingRevokes > 0 && (
        <Notice tone="warn">{ov.pendingRevokes} key{ov.pendingRevokes === 1 ? ' has' : 's have'} not been confirmed revoked yet. HyperProx retries every minute.</Notice>
      )}
      {job && <JobPanel job={job} onClose={() => setJob(null)} />}
      {admin && ov && <Exclusions rows={rows} send={send} onSaved={() => load()} />}
      {admin && ov && <PendingDevices ov={ov} send={send} onDone={(text, ok) => { setNotice({ tone: ok ? 'info' : 'crit', text }); load() }} />}
      {pinAsk.length > 0 && admin && (
        <Notice tone="warn">
          <div className="space-y-2">
            <div>HyperProx will not send anything to a host whose key has never been pinned. Check the key and trust it, then run the job again.</div>
            <div className="flex flex-wrap gap-2">{pinAsk.map(r => <Btn key={r.id} small onClick={() => openHostKey(r)}>Check the host key for {r.name}</Btn>)}</div>
          </div>
        </Notice>
      )}
      {tunAsk.length > 0 && admin && (
        <Notice tone="warn">
          <div className="space-y-2">
            <div>These containers have no /dev/net/tun. HyperProx can add it through the Proxmox API (it takes effect after the container restarts, which HyperProx leaves to you), or you can install again with userspace networking.</div>
            <div className="flex flex-wrap gap-2">{tunAsk.map(r => <Btn key={r.id} small onClick={() => addTun(r)}>Add /dev/net/tun to {r.name}</Btn>)}</div>
          </div>
        </Notice>
      )}

      <Panel title="Machines" right={
        <div className="flex flex-wrap items-center gap-2">
          {admin && (
            <>
              <select aria-label="Provider" value={bulkProvider} onChange={e => setBulkProvider(e.target.value as RemoteProviderId)}
                      className="rounded-md px-2 text-sm" style={{ height: 36, background: 'var(--ground-deep)', color: 'var(--text-bright)', border: '1px solid var(--border-strong)' }}>
                {PROVIDERS.map(p => <option key={p} value={p} disabled={!ov?.providers.find(x => x.id === p)?.configured}>{PROVIDER_LABEL[p]}</option>)}
              </select>
              <Btn kind="primary" disabled={busy || !selectedRows.length || !ov?.providers.find(x => x.id === bulkProvider)?.configured}
                   onClick={() => setDialog({ kind: 'install', provider: bulkProvider, rows: selectedRows })}>
                Install on selected{selectedRows.length ? ` (${selectedRows.length})` : ''}
              </Btn>
            </>
          )}
          <Btn onClick={load}>Refresh</Btn>
        </div>
      }>
        {!ov ? <Empty>Loading…</Empty> : rows.length === 0 ? <Empty>No nodes or guests found.</Empty> : (
          <MachinesTable rows={rows} admin={admin} busy={!!busy} selected={selected} onAction={onAction}
                         configured={Object.fromEntries((ov?.providers ?? []).map(p => [p.id, p.configured]))}
                         onSelect={(ids, on) => setSelected(s => { const n = new Set(s); ids.forEach(i => (on ? n.add(i) : n.delete(i))); return n })} />
        )}
        {!admin && ov && <p className="pt-3 text-xs" style={{ color: 'var(--text-dim)' }}>Installing and changing remote access is for admins. You can see status.</p>}
      </Panel>

      {admin && ov && <WireguardSection machines={ov.machines} send={send} notice={(tone, text) => setNotice({ tone, text })} />}

      {dialog?.kind === 'install' && (
        <InstallDialog provider={dialog.provider} rows={dialog.rows} onCancel={() => setDialog(null)} onConfirm={async o => {
          setDialog(null)
          started(await send<{ job: RemoteJob }>('/api/remote/jobs', 'POST', { provider: dialog.provider, machineIds: dialog.rows.map(r => r.id), tags: o.tags, mode: o.mode, existing: o.existing, auth: o.auth }))
          setSelected(new Set())
        }} />
      )}
      {dialog?.kind === 'routing' && (
        <RoutingDialog row={dialog.row} provider={dialog.provider} cell={dialog.row.cells[dialog.provider]} onCancel={() => setDialog(null)} onConfirm={async o => {
          setDialog(null)
          started(await send<{ job: RemoteJob }>(`/api/remote/machines/${enc(dialog.row.id)}/${dialog.provider}/routing`, 'POST', o))
        }} />
      )}
      {dialog?.kind === 'uninstall' && (
        <UninstallDialog row={dialog.row} provider={dialog.provider} onCancel={() => setDialog(null)} onConfirm={async () => {
          setDialog(null)
          started(await send<{ job: RemoteJob }>(`/api/remote/machines/${enc(dialog.row.id)}/${dialog.provider}`, 'DELETE'))
        }} />
      )}
      {dialog?.kind === 'manual' && (
        <ManualKeyDialog row={dialog.row} provider={dialog.provider} result={dialog.result} error={dialog.error}
          onClose={() => setDialog(null)}
          onRequest={async () => {
            const r = await send<RemoteManualKey>(`/api/remote/machines/${enc(dialog.row.id)}/${dialog.provider}/manual-key`, 'POST', {})
            if (!r) return
            setDialog(d => (d?.kind === 'manual' ? { ...d, result: r.ok ? r.body : null, error: r.ok ? null : r.error ?? 'Could not make a key' } : d))
          }} />
      )}
      {dialog?.kind === 'firewall' && (
        <FirewallDialog row={dialog.row} provider={dialog.provider} preview={dialog.preview} error={dialog.error} onCancel={() => setDialog(null)}
          onConfirm={async () => {
            const r = await send<{ added: boolean; message: string }>(`/api/remote/machines/${enc(dialog.row.id)}/${dialog.provider}/firewall`, 'POST', { confirm: true })
            if (!r) return
            setDialog(null)
            setNotice(r.ok && r.body ? { tone: 'info', text: r.body.message } : { tone: 'crit', text: r.error ?? 'Could not add the rule' })
          }} />
      )}
      {dialog?.kind === 'host-key' && (
        <HostKeyDialog row={dialog.row} info={dialog.info} error={dialog.error} onCancel={() => setDialog(null)}
          onConfirm={async () => {
            if (!dialog.info) return
            const r = await send<{ pinned: boolean; message: string }>(`/api/remote/machines/${enc(dialog.row.id)}/host-key`, 'POST', { fingerprint: dialog.info.fingerprint })
            if (!r) return
            setDialog(null)
            setNotice(r.ok && r.body ? { tone: 'info', text: r.body.message } : { tone: 'crit', text: r.error ?? 'Could not pin the key' })
          }} />
      )}
      {dialog?.kind === 'one-click' && (
        <OneClickDialog row={dialog.row} provider={dialog.provider} send={send} onCancel={() => setDialog(null)}
          onStarted={r => { setDialog(null); started(r) }} />
      )}
      {dialog?.kind === 'panel' && (
        <MachinePanel row={dialog.row} provider={dialog.provider} cell={dialog.row.cells[dialog.provider]} send={send}
          onClose={() => setDialog(null)} onJob={r => { setDialog(null); started(r) }}
          onNotice={(tone, text) => { setNotice({ tone, text }); load() }} />
      )}
      {confirm && <ReconfirmModal onDone={() => confirm()} onClose={() => setConfirm(null)} />}
    </Page>
  )
}

/**
 * "Never look inside these guests": guests HyperProx must never probe or change for VPN work. Saving asks for the
 * master password again. The Proxmox tag hyperprox-ignore does the same from Proxmox, and is shown here.
 */
function Exclusions({ rows, send, onSaved }: {
  rows: RemoteMachineRow[]
  send: <T>(path: string, method: string, body?: unknown) => Promise<ApiResult<T> | null>
  onSaved: () => void
}) {
  const [open, setOpen] = useState(false)
  const [ids, setIds] = useState<Set<string> | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => {
    if (!open || ids) return
    apiJson<{ machineIds: string[] }>('/api/remote/exclusions').then(r => setIds(new Set(r.ok ? r.body?.machineIds ?? [] : [])))
  }, [open, ids])
  const guests = rows.filter(r => r.kind === 'lxc' || r.kind === 'qemu')
  const tagged = guests.filter(r => r.excludedBy === 'tag')
  const count = rows.filter(r => r.excluded).length
  return (
    <Panel title="Never look inside these guests" right={<span className="text-xs" style={{ color: 'var(--text-dim)' }}>{count ? `${count} excluded` : 'none excluded'}</span>}>
      <div className="space-y-3 text-sm" style={{ color: 'var(--text-soft)' }}>
        <p>HyperProx never checks, installs on, adopts or changes a guest listed here, for any VPN. Tagging a guest <code className="font-mono">hyperprox-ignore</code> in Proxmox does the same.</p>
        {!open ? <Btn small onClick={() => setOpen(true)}>Choose guests…</Btn> : !ids ? <p>Loading…</p> : (
          <>
            <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
              {guests.map(g => (
                <label key={g.id} className="flex items-center gap-2">
                  <input type="checkbox" disabled={g.excludedBy === 'tag'} checked={g.excludedBy === 'tag' || ids.has(g.id)}
                         onChange={e => setIds(s => { const n = new Set(s ?? []); if (e.target.checked) n.add(g.id); else n.delete(g.id); return n })} />
                  <span>{g.name} <span className="font-mono text-xs" style={{ color: 'var(--text-dim)' }}>{g.id}</span>{g.excludedBy === 'tag' ? ' (tagged in Proxmox)' : ''}</span>
                </label>
              ))}
            </div>
            {tagged.length > 0 && <p className="text-xs" style={{ color: 'var(--text-dim)' }}>Tagged guests are excluded by Proxmox; remove the tag there to include them.</p>}
            <div className="flex gap-2">
              <Btn small kind="primary" onClick={async () => {
                const r = await send<{ machineIds: string[] }>('/api/remote/exclusions', 'PUT', { machineIds: [...(ids ?? [])] })
                if (!r) return
                setMsg(r.ok ? 'Saved.' : r.error ?? 'Could not save')
                if (r.ok) { setOpen(false); setIds(null); onSaved() }
              }}>Save</Btn>
              <Btn small onClick={() => { setOpen(false); setIds(null) }}>Cancel</Btn>
            </div>
          </>
        )}
        {msg && <p className="text-xs">{msg}</p>}
      </div>
    </Panel>
  )
}
