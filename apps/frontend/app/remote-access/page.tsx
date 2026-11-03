'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import type { RemoteFirewallPreview, RemoteHostKey, RemoteJob, RemoteMachineRow, RemoteManualKey, RemoteOverview, RemoteProviderId } from '@hyperprox/types'
import { apiJson, atLeast, type ApiResult } from '@/lib/api'
import { useSession } from '@/lib/session'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { Badge, Btn, Empty, Notice, Panel } from '@/components/updates/ui'
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

const enc = encodeURIComponent

export default function RemoteAccessPage() {
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
    if (r.ok && r.body) { setOv(r.body); setErr(null) } else setErr(r.status === 404 ? 'The Remote access API is not available on this server yet.' : r.error ?? 'Could not load')
  }, [])
  useEffect(() => { if (role) load() }, [role, load])

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
    if (a === 'routing') { setDialog({ kind: 'routing', provider: p, row }); return }
    if (a === 'uninstall') { setDialog({ kind: 'uninstall', provider: p, row }); return }
    if (a === 'manual-key') { setDialog({ kind: 'manual', provider: p, row, result: null, error: null }); return }
    if (a === 'firewall') {
      setDialog({ kind: 'firewall', provider: p, row, preview: null, error: null })
      const r = await apiJson<RemoteFirewallPreview>(`/api/remote/machines/${enc(row.id)}/${p}/firewall`)
      setDialog(d => (d?.kind === 'firewall' ? { ...d, preview: r.ok ? r.body : null, error: r.ok ? null : r.error ?? 'Could not read the firewall' } : d))
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

  return (
    <div className="min-h-full space-y-6 p-4 sm:p-8" style={{ background: 'var(--ground)' }}>
      <div>
        <div className="font-mono uppercase" style={{ fontSize: 12, letterSpacing: '0.14em', color: 'var(--accent)' }}>Manage</div>
        <h1 className="mt-2 font-display font-bold" style={{ fontSize: 36, lineHeight: 1.1, color: 'var(--text-bright)' }}>Remote access</h1>
        <p className="mt-3 max-w-3xl text-sm" style={{ color: 'var(--text-soft)' }}>
          Reach your nodes and guests from anywhere through Tailscale or NetBird, without opening a port.
          HyperProx installs the client from the official repository, signs it in with a key made for that one install,
          and keeps a Proxmox node&apos;s DNS and routing exactly as they were.
        </p>
      </div>

      {err && <Notice tone="crit">{err}</Notice>}
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

      {ov && (
        <div className="flex flex-wrap gap-3">
          {ov.providers.map(p => (
            <div key={p.id} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
              <span className="font-semibold" style={{ color: 'var(--text-bright)' }}>{p.label}</span>
              {p.configured
                ? (p.error ? <Badge tone="crit" title={p.error}>error</Badge> : <Badge tone="good">{p.devices} device{p.devices === 1 ? '' : 's'}</Badge>)
                : <Badge tone="muted">not set up</Badge>}
              {admin && <Link href="/settings?tab=remote" className="text-xs underline" style={{ color: 'var(--accent)' }}>{p.configured ? 'Settings' : 'Set up'}</Link>}
              {p.error && <span className="text-xs" style={{ color: 'var(--crit-soft)' }}>{p.error}</span>}
            </div>
          ))}
        </div>
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
                         onSelect={(ids, on) => setSelected(s => { const n = new Set(s); ids.forEach(i => (on ? n.add(i) : n.delete(i))); return n })} />
        )}
        {!admin && ov && <p className="px-5 pb-4 text-xs" style={{ color: 'var(--text-dim)' }}>Installing and changing remote access is for admins. You can see status.</p>}
      </Panel>

      {dialog?.kind === 'install' && (
        <InstallDialog provider={dialog.provider} rows={dialog.rows} onCancel={() => setDialog(null)} onConfirm={async o => {
          setDialog(null)
          started(await send<{ job: RemoteJob }>('/api/remote/jobs', 'POST', { provider: dialog.provider, machineIds: dialog.rows.map(r => r.id), tags: o.tags, mode: o.mode, existing: o.existing }))
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
      {confirm && <ReconfirmModal onDone={() => confirm()} onClose={() => setConfirm(null)} />}
    </div>
  )
}
