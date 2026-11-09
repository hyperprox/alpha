'use client'

// One guest: live stats and every existing action (power with HA awareness, HA state, migrate, delete),
// the config editor, network, GPU and devices, snapshots, console, history with revert, and the VPN slot.

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiJson } from '@/lib/api'
import { formatBytes, formatUptime } from '@/lib/utils'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { GhostButton, Notice, PrimaryButton, BusyNote, INPUT } from '@/components/vault/ui'
import { ConfigEditor, NetworkEditor, Section } from './ConfigEditor'
import { GpuPanel } from './GpuPanel'
import { PreviewDialog } from './PreviewDialog'
import { GUEST_TABS } from './tabs'
import { MiniBar, StatusDot, TypeBadge, VpnBadge, GpuBadge } from './GuestList'
import { gpath, type GuestRow, type GuestView, type HistoryItem } from './types'
import { HaPanel } from '@/components/ha'

export function GuestDrawer({ row, nodes, canOperate, canAdmin, onClose, onRefresh, remote = false }: {
  row: GuestRow; nodes: Array<{ node: string; status: string }>; canOperate: boolean; canAdmin: boolean
  onClose: () => void; onRefresh: () => void
  /**
   * The guest is on a remote cluster (Command center). The console opens the Terminal, which knows home guests
   * only, and HA and VPN are home features: those tabs are left out rather than pointing at a home guest with
   * the same ID.
   */
  remote?: boolean
}) {
  const REMOTE_HIDDEN = new Set(['console', 'ha', 'vpn'])
  const tabs = GUEST_TABS.filter(t => (!t.when || t.when(row, { canOperate, canAdmin })) && !(remote && REMOTE_HIDDEN.has(t.id)))
  const [tab, setTab] = useState(tabs[0].id)
  const [view, setView] = useState<GuestView | null>(null)
  const [viewErr, setViewErr] = useState<string | null>(null)
  const g = { node: row.node, type: row.type, vmid: row.vmid }

  const loadView = useCallback(async () => {
    const r = await apiJson<{ data: GuestView }>(gpath(g))
    if (r.ok) { setView(r.body!.data); setViewErr(null) } else setViewErr(r.error ?? 'Could not read the config')
  }, [row.node, row.type, row.vmid])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void loadView() }, [loadView])
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h) }, [onClose])
  const saved = () => { void loadView(); onRefresh() }

  return (
    <div className="fixed inset-0 z-50 flex justify-end" style={{ background: 'var(--scrim)' }} onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="h-full w-full sm:max-w-3xl flex flex-col border-l" style={{ background: 'var(--surface-raised)', borderColor: 'var(--border-soft)' }}>
        <div className="px-4 sm:px-5 pt-4 pb-2 border-b" style={{ borderColor: 'var(--border-dim)' }}>
          <div className="flex items-center gap-2">
            <StatusDot status={row.status} />
            <h2 className="font-display font-semibold truncate" style={{ fontSize: 24, color: 'var(--text-bright)' }}>{row.name}</h2>
            <button onClick={onClose} aria-label="Close" className="ml-auto" style={{ color: 'var(--text-dimmer)', fontSize: 20 }}>✕</button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 mt-1">
            <TypeBadge type={row.type} />
            <span className="font-mono text-xs" style={{ color: 'var(--text-dimmer)' }}>#{row.vmid} · {row.node}{row.ip ? ` · ${row.ip}` : ''}</span>
            {row.ha.managed && <span className="font-mono text-[10px] rounded px-1.5" style={{ color: 'var(--violet)', border: '1px solid color-mix(in srgb, var(--violet) 35%, transparent)' }}>HA {row.ha.state}</span>}
            <GpuBadge row={row} />
            <VpnBadge vpn={row.vpn} />
            {view?.pending.keys.length ? <span className="font-mono text-[10px] rounded px-1.5" style={{ color: 'var(--warn-2)', border: '1px solid color-mix(in srgb, var(--warn) 35%, transparent)' }}>pending restart</span> : null}
          </div>
          <div className="flex gap-1 mt-3 overflow-x-auto -mx-1 px-1" role="tablist">
            {tabs.map(t => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className="px-3 py-2 text-sm whitespace-nowrap"
                style={{ borderBottom: `2px solid ${tab === t.id ? 'var(--accent)' : 'transparent'}`, color: tab === t.id ? 'var(--accent)' : 'var(--text-dim)' }}>{t.label}</button>
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-4 sm:px-5 py-4">
          {viewErr && tab !== 'overview' && <Notice kind="error">{viewErr}</Notice>}
          {tab === 'overview' && <OverviewTab row={row} view={view} nodes={nodes} canOperate={canOperate} canAdmin={canAdmin} onRefresh={saved} onClose={onClose} />}
          {tab === 'config' && (view ? <ConfigEditor key={view.digest} view={view} canEdit={canAdmin} onSaved={saved} /> : <BusyNote>Reading the config…</BusyNote>)}
          {tab === 'network' && (view ? <NetworkEditor view={view} canEdit={canAdmin} onSaved={saved} /> : <BusyNote>Reading the config…</BusyNote>)}
          {tab === 'devices' && (view ? <GpuPanel view={view} nodes={nodes.map(n => n.node)} canEdit={canAdmin} onSaved={saved} /> : <BusyNote>Reading the config…</BusyNote>)}
          {tab === 'ha' && <HaPanel type={row.type} vmid={row.vmid} onChanged={saved} />}
          {tab === 'snapshots' && <SnapshotsTab row={row} canAdmin={canAdmin} onRefresh={onRefresh} />}
          {tab === 'console' && <ConsoleTab row={row} />}
          {tab === 'history' && view && <HistoryTab view={view} canAdmin={canAdmin} onSaved={saved} />}
          {tab === 'vpn' && <VpnTab row={row} />}
        </div>
      </div>
    </div>
  )
}

// ── overview: live stats and actions ─────────────────────────────────────────

function OverviewTab({ row, view, nodes, canOperate, canAdmin, onRefresh, onClose }: {
  row: GuestRow; view: GuestView | null; nodes: Array<{ node: string; status: string }>; canOperate: boolean; canAdmin: boolean; onRefresh: () => void; onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'info' | 'error'; text: string } | null>(null)
  const [reconfirm, setReconfirm] = useState<null | (() => void)>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [target, setTarget] = useState('')
  const [restart, setRestart] = useState(false)
  const running = row.status === 'running'
  const sid = `${row.type === 'qemu' ? 'vm' : 'ct'}:${row.vmid}`

  const call = async (label: string, path: string, method: string, body?: unknown, after?: () => void) => {
    setBusy(true); setMsg(null)
    const r = await apiJson(path, method, body)
    setBusy(false)
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(() => () => void call(label, path, method, body, after)); return }
    setMsg(r.ok ? { kind: 'info', text: `${label}: done` } : { kind: 'error', text: r.error ?? `${label} failed` })
    if (r.ok) { setTimeout(onRefresh, 1200); after?.() }
  }
  const power = (a: string) => call(a, `/api/infra/vms/${row.node}/${row.vmid}/${row.type}/${a}`, 'POST')
  const ha = (state: string) => call(`HA ${state}`, `/api/infra/ha/${encodeURIComponent(sid)}`, 'PUT', { state })
  const cpuPct = running ? Math.round(row.cpu * 100) : 0

  return (
    <div className="space-y-6">
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const f = reconfirm; setReconfirm(null); f() }} />}
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          ['CPU', `${cpuPct}% of ${row.maxcpu} core${row.maxcpu === 1 ? '' : 's'}`, cpuPct],
          ['Memory', `${formatBytes(row.mem)} / ${formatBytes(row.maxmem)}`, row.maxmem ? Math.round(row.mem / row.maxmem * 100) : 0],
          ['Disk', row.maxdisk ? `${row.disk ? formatBytes(row.disk) + ' / ' : ''}${formatBytes(row.maxdisk)}` : '—', row.maxdisk && row.disk ? Math.round(row.disk / row.maxdisk * 100) : 0],
          ['Uptime', row.uptime ? formatUptime(row.uptime) : '—', null],
        ].map(([l, v, p]) => (
          <div key={l as string} className="rounded-md border p-3" style={{ borderColor: 'var(--border-dim)', background: 'var(--ground-deep)' }}>
            <div className="font-mono uppercase" style={{ fontSize: 10, letterSpacing: '0.14em', color: 'var(--text-dimmer)' }}>{l}</div>
            <div className="text-sm mt-1" style={{ color: 'var(--text-bright)' }}>{v}</div>
            {p !== null && <div className="mt-2"><MiniBar pct={p as number} muted={l === 'Memory' && row.type === 'qemu'} /></div>}
          </div>
        ))}
      </div>
      {row.type === 'qemu' && <p className="text-[11px]" style={{ color: 'var(--text-dimmer)' }}>A VM’s memory figure counts the guest’s page cache, so it sits near the ceiling on a healthy machine.</p>}

      {view && view.pending.keys.length > 0 && (
        <Notice kind="warn">Applies on next restart: <span className="font-mono">{view.pending.keys.join(', ')}</span>{canAdmin && running && <> · <button className="underline" onClick={() => setRestart(true)}>Restart now</button></>}</Notice>
      )}
      {restart && view && <PreviewDialog guest={view.guest} change={{ kind: 'restart' }} title={`Restart ${row.name}`} onClose={() => setRestart(false)} onApplied={onRefresh} />}

      {canOperate && (
        <Section title="Power" note={row.ha.managed ? 'HA-managed: start and stop go through HA state, never a direct stop and start (HA would fight it).' : undefined}>
          <div className="flex flex-wrap gap-2">
            {row.ha.managed ? (<>
              {canAdmin && row.ha.state !== 'started' && <PrimaryButton style={{ height: 36 }} disabled={busy} onClick={() => ha('started')}>Start (HA)</PrimaryButton>}
              {canAdmin && row.ha.state === 'started' && <GhostButton style={{ height: 36 }} disabled={busy} onClick={() => ha('stopped')}>Stop (HA)</GhostButton>}
              {canAdmin && running && <GhostButton style={{ height: 36 }} disabled={busy} onClick={() => setRestart(true)}>Restart (HA)</GhostButton>}
              {canAdmin && row.ha.state !== 'disabled' && <GhostButton style={{ height: 36 }} disabled={busy} onClick={() => ha('disabled')}>Disable HA</GhostButton>}
              {!canAdmin && <p className="text-sm" style={{ color: 'var(--text-dimmer)' }}>Changing an HA guest’s state needs the admin role.</p>}
            </>) : running ? (<>
              <GhostButton style={{ height: 36 }} disabled={busy} onClick={() => power('shutdown')}>Shut down</GhostButton>
              <GhostButton style={{ height: 36 }} disabled={busy} onClick={() => power('reboot')}>Reboot</GhostButton>
              <GhostButton style={{ height: 36, color: 'var(--crit-soft)' }} disabled={busy} onClick={() => power('stop')}>Stop (hard)</GhostButton>
            </>) : <PrimaryButton style={{ height: 36 }} disabled={busy} onClick={() => power('start')}>Start</PrimaryButton>}
          </div>
        </Section>
      )}

      {canAdmin && (
        <Section title="Migrate">
          <div className="flex gap-2 flex-wrap">
            <select style={{ ...INPUT, width: 'auto', minWidth: 180 }} value={target} onChange={e => setTarget(e.target.value)}>
              <option value="">Target node…</option>
              {nodes.filter(n => n.node !== row.node && n.status === 'online').map(n => <option key={n.node} value={n.node}>{n.node}</option>)}
            </select>
            <GhostButton style={{ height: 42 }} disabled={!target || busy} onClick={() => call('Migration', `/api/infra/vms/${row.node}/${row.vmid}/${row.type}/migrate`, 'POST', { target })}>Migrate to {target || '…'}</GhostButton>
          </div>
          <p className="text-[12px]" style={{ color: 'var(--text-dimmer)' }}>{row.type === 'qemu' ? 'Live migration: the VM keeps running.' : 'A container migrates with a restart. A plain bind mount blocks it.'}</p>
        </Section>
      )}

      {canAdmin && (
        <Section title="Danger zone">
          {!confirmDelete ? <GhostButton style={{ height: 36, color: 'var(--crit-soft)' }} disabled={busy || running} onClick={() => setConfirmDelete(true)}>Delete {row.type === 'lxc' ? 'container' : 'VM'}</GhostButton> : (
            <div className="flex items-center gap-2 flex-wrap rounded-md border p-2" style={{ borderColor: 'color-mix(in srgb, var(--crit-2) 35%, transparent)' }}>
              <span className="text-sm" style={{ color: 'var(--crit-soft)' }}>Delete {row.name} ({row.vmid})? This cannot be undone.</span>
              <GhostButton style={{ height: 32, color: 'var(--crit-soft)' }} disabled={busy} onClick={() => call('Delete', `/api/proxmox/nodes/${row.node}/${row.type}/${row.vmid}`, 'DELETE', undefined, onClose)}>Delete</GhostButton>
              <GhostButton style={{ height: 32 }} onClick={() => setConfirmDelete(false)}>Cancel</GhostButton>
            </div>
          )}
          {running && <p className="text-[12px]" style={{ color: 'var(--text-dimmer)' }}>Stop it before deleting.</p>}
        </Section>
      )}
    </div>
  )
}

// ── snapshots ────────────────────────────────────────────────────────────────

function SnapshotsTab({ row, canAdmin, onRefresh }: { row: GuestRow; canAdmin: boolean; onRefresh: () => void }) {
  const [snaps, setSnaps] = useState<any[] | null>(null)
  const [name, setName] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const base = `/api/infra/vms/${row.node}/${row.vmid}/${row.type}/snapshots`
  const load = useCallback(async () => { const r = await apiJson<{ data: any[] }>(base); setSnaps(r.ok ? (r.body!.data ?? []).filter((s: any) => s.name !== 'current') : []); if (!r.ok) setMsg(r.error ?? null) }, [base])
  useEffect(() => { void load() }, [load])
  const act = async (label: string, path: string, method: string, body?: unknown) => {
    const r = await apiJson(path, method, body); setMsg(r.ok ? `${label}: started` : r.error ?? `${label} failed`); setTimeout(() => { void load(); onRefresh() }, 1500)
  }
  return (
    <div className="space-y-3">
      {msg && <Notice kind="info">{msg}</Notice>}
      {canAdmin && <div className="flex gap-2"><input style={INPUT} value={name} placeholder="snapshot name" onChange={e => setName(e.target.value)} /><PrimaryButton disabled={!name.trim()} onClick={() => { void act('Snapshot', base, 'POST', { name }); setName('') }}>Create</PrimaryButton></div>}
      {snaps === null ? <BusyNote>Reading snapshots…</BusyNote> : snaps.length === 0 ? <p className="text-sm" style={{ color: 'var(--text-dimmer)' }}>No snapshots. (A guest with a bind mount cannot be snapshotted.)</p> : snaps.map(s => (
        <div key={s.name} className="flex items-center gap-2 flex-wrap rounded-md border p-3" style={{ borderColor: 'var(--border-dim)', background: 'var(--ground-deep)' }}>
          <div className="min-w-0 flex-1"><div className="font-mono text-sm" style={{ color: 'var(--text-bright)' }}>{s.name}</div>
            <div className="text-xs" style={{ color: 'var(--text-dimmer)' }}>{s.snaptime ? new Date(s.snaptime * 1000).toLocaleString() : ''}{s.description ? ` · ${s.description}` : ''}</div></div>
          {canAdmin && <><GhostButton style={{ height: 32 }} onClick={() => { if (confirm(`Roll ${row.name} back to ${s.name}? Everything since is lost.`)) void act('Rollback', `${base}/${encodeURIComponent(s.name)}/rollback`, 'POST') }}>Rollback</GhostButton>
            <GhostButton style={{ height: 32, color: 'var(--crit-soft)' }} onClick={() => void act('Delete', `${base}/${encodeURIComponent(s.name)}`, 'DELETE')}>Delete</GhostButton></>}
        </div>
      ))}
    </div>
  )
}

function ConsoleTab({ row }: { row: GuestRow }) {
  const router = useRouter()
  return (
    <div className="space-y-3">
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Opens a pane on the Terminal page: it reconnects, keeps scrollback, and survives closing the tab.</p>
      <PrimaryButton onClick={() => router.push(`/terminal?open=${row.type}-${row.vmid}`)}>Open console</PrimaryButton>
    </div>
  )
}

// ── history and revert ───────────────────────────────────────────────────────

function HistoryTab({ view, canAdmin, onSaved }: { view: GuestView; canAdmin: boolean; onSaved: () => void }) {
  const [rows, setRows] = useState<HistoryItem[] | null>(null)
  const [revert, setRevert] = useState<null | { id: string; which: 'before' | 'after' }>(null)
  useEffect(() => { apiJson<{ data: HistoryItem[] }>(`${gpath(view.guest)}/history`).then(r => setRows(r.ok ? r.body!.data : [])) }, [view])
  if (rows === null) return <BusyNote>Reading history…</BusyNote>
  return (
    <div className="space-y-2">
      <p className="text-[12px]" style={{ color: 'var(--text-dimmer)' }}>Every change HyperProx made to this guest, with the config before and after it. Reverting is itself a previewed, digest-checked change.</p>
      {rows.length === 0 && <p className="text-sm" style={{ color: 'var(--text-dimmer)' }}>No changes made through HyperProx yet.</p>}
      {rows.map(r => (
        <div key={r.id} className="rounded-md border p-3 space-y-1" style={{ borderColor: 'var(--border-dim)', background: 'var(--ground-deep)' }}>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm" style={{ color: 'var(--text-bright)' }}>{new Date(r.createdAt).toLocaleString()}</span>
            <span className="text-xs" style={{ color: 'var(--text-dimmer)' }}>{r.actor}</span>
            {r.tag && <span className="font-mono text-[10px] rounded px-1.5" style={{ color: 'var(--accent)', border: '1px solid var(--border-dim)' }}>{r.tag}</span>}
            <span className="font-mono text-[10px]" style={{ color: r.outcome === 'ok' ? 'var(--good)' : 'var(--crit-soft)' }}>{r.outcome}</span>
            {canAdmin && r.kind !== 'restart' && <div className="ml-auto flex gap-2">
              <GhostButton style={{ height: 30 }} onClick={() => setRevert({ id: r.id, which: 'before' })}>Revert this change</GhostButton>
              {r.outcome === 'ok' && <GhostButton style={{ height: 30 }} onClick={() => setRevert({ id: r.id, which: 'after' })}>Return to this version</GhostButton>}
            </div>}
          </div>
          <ul className="text-[13px]" style={{ color: 'var(--text-muted)' }}>{r.changes.map((c, i) => <li key={i}>· {c.words}</li>)}</ul>
          {r.problems.map((p, i) => <p key={i} className="text-[12px]" style={{ color: 'var(--crit-soft)' }}>{p}</p>)}
        </div>
      ))}
      {revert && <PreviewDialog guest={view.guest} change={{ kind: 'revert', historyId: revert.id, which: revert.which }} title={revert.which === 'before' ? 'Revert this change' : 'Return to this version'} onClose={() => setRevert(null)} onApplied={onSaved} />}
    </div>
  )
}

function VpnTab({ row }: { row: GuestRow }) {
  const v = row.vpn
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2"><VpnBadge vpn={v} always /></div>
      {v.state === 'not-available' && <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No VPN service is set up in HyperProx yet. When remote access is configured, this tab shows whether {row.name} is on the VPN, its address there and when it was last seen.</p>}
      {v.state !== 'not-available' && (
        <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
          {[['Provider', v.provider], ['State', v.state], ['VPN address', v.address], ['VPN name', v.hostname], ['Last seen', v.lastSeen && new Date(v.lastSeen).toLocaleString()]].filter(([, x]) => x).flatMap(([k, x]) => [
            <dt key={`k${k}`} style={{ color: 'var(--text-dimmer)' }}>{k}</dt>, <dd key={`v${k}`} style={{ color: 'var(--text-bright)' }}>{x}</dd>,
          ])}
        </dl>
      )}
      {v.detail && <p className="text-[12px]" style={{ color: 'var(--text-dimmer)' }}>{v.detail}</p>}
    </div>
  )
}
