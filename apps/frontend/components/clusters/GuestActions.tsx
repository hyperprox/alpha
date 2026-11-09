'use client'

// Guests on any cluster: each action is shown first (naming the cluster), then applied, then read back from
// Proxmox, and the answer says what Proxmox reported. Delete asks for the guest's name, typed exactly.

import { useCallback, useEffect, useState } from 'react'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { clusterColor, clusterInk, bytes } from '@/lib/clusters'
import { INPUT, LABEL, Notice, BusyNote, Modal } from '@/components/vault/ui'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { GuestDrawer } from '@/components/guest-config/GuestDrawer'
import type { GuestRow } from '@/components/guest-config/types'

type Kind = 'home' | 'remote'
type Action = { kind: 'power'; action: 'start' | 'stop' | 'shutdown' | 'reboot' } | { kind: 'snapshot' } | { kind: 'backup' } | { kind: 'delete' }

const powerWords: Record<string, { verb: string; impact: string }> = {
  start: { verb: 'Start', impact: 'It boots up and its services come back.' },
  shutdown: { verb: 'Shut down', impact: 'It is asked to shut down cleanly. Anyone using it is disconnected.' },
  stop: { verb: 'Stop', impact: 'It is switched off at once, like pulling the plug. Unsaved work inside it is lost.' },
  reboot: { verb: 'Restart', impact: 'It is down for a short while. Anyone using it is interrupted.' },
}

function ActionDialog({ g, act, clusterId, clusterName, kind, onClose, onDone }: { g: GuestRow; act: Action; clusterId: string; clusterName: string; kind: Kind; onClose: () => void; onDone: () => void }) {
  const [snapName, setSnapName] = useState(`hpx-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`)
  const [storages, setStorages] = useState<Array<{ storage: string; type: string; availBytes: number }> | null>(null)
  const [storage, setStorage] = useState('')
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [task, setTask] = useState<{ node: string; upid: string } | null>(null)
  const [reconfirm, setReconfirm] = useState<null | (() => void)>(null)
  const label = `${g.name} (${g.type === 'lxc' ? 'CT' : 'VM'} ${g.vmid})`
  const base = `/api/clusters/${clusterId}/guests/${encodeURIComponent(g.node)}/${g.type}/${g.vmid}`

  useEffect(() => {
    if (act.kind !== 'backup') return
    apiJson<{ data: typeof storages }>(`/api/clusters/${clusterId}/nodes/${encodeURIComponent(g.node)}/backup-storages`).then(r => {
      const list = r.ok ? r.body!.data ?? [] : []
      setStorages(list); if (list[0]) setStorage(list[0].storage)
      if (!r.ok) setResult({ ok: false, text: r.error ?? 'Could not list backup storage' })
    })
  }, [act.kind, clusterId, g.node])

  // A backup can run for a long time: follow its task until it finishes.
  useEffect(() => {
    if (!task) return
    let stop = false
    const tick = async () => {
      const r = await apiJson<{ data: { running: boolean; ok: boolean | null; exitstatus: string | null } }>(`/api/clusters/${clusterId}/tasks/${encodeURIComponent(task.node)}/${encodeURIComponent(task.upid)}`)
      if (stop) return
      if (r.ok && !r.body!.data.running) { setResult({ ok: !!r.body!.data.ok, text: r.body!.data.ok ? `The backup of ${label} finished: Proxmox reports OK.` : `The backup of ${label} ended with: ${r.body!.data.exitstatus}` }); setTask(null); onDone(); return }
      setTimeout(tick, 4000)
    }
    void tick()
    return () => { stop = true }
  }, [task, clusterId, label, onDone])

  const apply = async () => {
    setBusy(true); setResult(null)
    const [path, body] = act.kind === 'power' ? [`${base}/power`, { action: act.action }]
      : act.kind === 'snapshot' ? [`${base}/snapshot`, { name: snapName }]
      : act.kind === 'backup' ? [`${base}/backup`, { storage }]
      : [`${base}/delete`, { confirmName: typed }]
    const r = await apiJson<{ data: any }>(path, 'POST', body)
    setBusy(false)
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(() => () => void apply()); return }
    if (act.kind === 'backup' && r.ok) { setTask({ node: r.body!.data.node, upid: r.body!.data.upid }); setResult({ ok: true, text: 'The backup has started. HyperProx is following it and will say when Proxmox reports it finished.' }); return }
    setResult({ ok: r.ok, text: r.ok ? r.body!.data.words : r.error ?? 'It did not work' })
    if (r.ok) onDone()
  }

  const title = act.kind === 'power' ? `${powerWords[act.action].verb} ${label}` : act.kind === 'snapshot' ? `Snapshot ${label}` : act.kind === 'backup' ? `Back up ${label} now` : `Delete ${label}`
  const impact = act.kind === 'power' ? powerWords[act.action].impact
    : act.kind === 'snapshot' ? 'A point you can roll back to. It is kept on the same storage as the guest. (A guest with a bind mount cannot be snapshotted.)'
    : act.kind === 'backup' ? 'A full backup to the storage you pick. It runs in the background on that server.'
    : 'The guest and its disks are destroyed. This cannot be undone. It must be stopped first, and not under HA.'
  const canApply = !busy && !task && !(result?.ok) && (act.kind !== 'delete' || typed === g.name) && (act.kind !== 'backup' || !!storage) && (act.kind !== 'snapshot' || /^[A-Za-z][A-Za-z0-9_-]{1,39}$/.test(snapName))

  return (
    <Modal title={title} onClose={onClose}>
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const f = reconfirm; setReconfirm(null); f() }} />}
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>On <b style={{ color: clusterColor(kind) }}>{clusterName}</b>. {impact}</p>
      {act.kind === 'snapshot' && <div><label style={LABEL}>Snapshot name</label><input style={INPUT} value={snapName} onChange={e => setSnapName(e.target.value)} /></div>}
      {act.kind === 'backup' && (storages === null ? <BusyNote>Reading backup storage…</BusyNote> : storages.length === 0 ? <Notice kind="warn">No storage on {g.node} takes backups.</Notice> : (
        <div><label style={LABEL}>Back up to</label>
          <select style={INPUT} value={storage} onChange={e => setStorage(e.target.value)}>
            {storages.map(s => <option key={s.storage} value={s.storage}>{s.storage} ({s.type}, {bytes(s.availBytes)} free)</option>)}
          </select>
        </div>
      ))}
      {act.kind === 'delete' && <div><label style={LABEL}>Type <b style={{ color: 'var(--text-bright)' }}>{g.name}</b> to delete it</label><input style={INPUT} value={typed} onChange={e => setTyped(e.target.value)} autoComplete="off" /></div>}
      {result && <Notice kind={result.ok ? 'info' : 'error'}>{result.text}</Notice>}
      {task && <BusyNote>Backing up… (you can close this; the backup carries on)</BusyNote>}
      <div className="flex gap-2 items-center flex-wrap">
        {!result?.ok && <button disabled={!canApply} onClick={apply} className="px-4 rounded-md text-sm font-semibold disabled:opacity-40" style={{ height: 38, background: act.kind === 'delete' ? 'var(--crit)' : clusterColor(kind), color: act.kind === 'delete' ? '#fff' : clusterInk(kind) }}>{busy ? 'Working…' : act.kind === 'delete' ? 'Delete' : 'Apply'}</button>}
        <button onClick={onClose} className="px-4 rounded-md text-sm border" style={{ height: 38, borderColor: 'var(--border-strong)', color: 'var(--text-soft)' }}>{result?.ok ? 'Close' : 'Cancel'}</button>
        {!result && <span className="text-xs" style={{ color: 'var(--text-dimmer)' }}>After applying, HyperProx reads the result back from Proxmox.</span>}
      </div>
    </Modal>
  )
}

const btn = (kind: Kind) => ({ height: 28, borderColor: 'var(--border-strong)', color: 'var(--text)' } as React.CSSProperties)

export function GuestsTab({ clusterId, clusterName, kind }: { clusterId: string; clusterName: string; kind: Kind }) {
  const { role } = useSession()
  const canOperate = atLeast(role, 'operator'), canAdmin = atLeast(role, 'admin')
  const [rows, setRows] = useState<GuestRow[] | null>(null)
  const [nodes, setNodes] = useState<Array<{ node: string; status: string }>>([])
  const [err, setErr] = useState<string | null>(null)
  const [act, setAct] = useState<{ g: GuestRow; a: Action } | null>(null)
  const [open, setOpen] = useState<GuestRow | null>(null)
  const [q, setQ] = useState('')
  const load = useCallback(async () => {
    const [o, n] = await Promise.all([apiJson<{ data: GuestRow[] }>('/api/infra/guest-config/overview'), apiJson<{ data: Array<{ node: string; status: string }> }>('/api/proxmox/nodes')])
    if (o.ok) { setRows((o.body!.data ?? []).filter(r => !r.template).sort((a, b) => a.vmid - b.vmid)); setErr(null) } else setErr(o.error ?? 'Could not read the guests')
    if (n.ok) setNodes(n.body!.data ?? [])
  }, [])
  useEffect(() => { void load(); const t = setInterval(load, 15_000); return () => clearInterval(t) }, [load])

  const shown = (rows ?? []).filter(r => !q || r.name.toLowerCase().includes(q.toLowerCase()) || String(r.vmid).includes(q))
  return (
    <div className="flex flex-col gap-3">
      {act && <ActionDialog g={act.g} act={act.a} clusterId={clusterId} clusterName={clusterName} kind={kind} onClose={() => setAct(null)} onDone={() => { void load() }} />}
      <input type="search" placeholder="Search name or ID" value={q} onChange={e => setQ(e.target.value)} className="text-sm px-3 rounded-md outline-none w-full sm:w-64" style={{ height: 36, background: 'var(--ground-deep)', border: '1px solid var(--border-strong)', color: 'var(--text-bright)' }} />
      {err && <Notice kind="error">{err}</Notice>}
      {rows === null && !err ? <BusyNote>Reading guests…</BusyNote> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ minWidth: '40rem' }}>
            <thead><tr className="text-left font-mono uppercase" style={{ fontSize: 11, letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
              <th className="py-2 pr-3">Guest</th><th className="py-2 pr-3">Name</th><th className="py-2 pr-3">Node</th><th className="py-2 pr-3">State</th><th className="py-2 pr-3">Memory</th><th className="py-2">Actions</th>
            </tr></thead>
            <tbody>
              {shown.map(g => {
                const running = g.status === 'running'
                return (
                  <tr key={`${g.type}${g.vmid}`} className="border-t" style={{ borderColor: 'var(--border-dim)' }}>
                    <td className="py-2 pr-3 font-mono" style={{ color: 'var(--text-dim)' }}>{g.type === 'lxc' ? 'CT' : 'VM'} {g.vmid}</td>
                    <td className="py-2 pr-3" style={{ color: 'var(--text-bright)' }}>{g.name}{g.ha.managed && <span className="ml-1 font-mono text-[10px]" style={{ color: 'var(--violet)' }}>HA</span>}</td>
                    <td className="py-2 pr-3" style={{ color: 'var(--text-dim)' }}>{g.node}</td>
                    <td className="py-2 pr-3 font-semibold" style={{ color: running ? 'var(--good)' : 'var(--text-dimmer)' }}>{g.status}</td>
                    <td className="py-2 pr-3 font-mono text-xs" style={{ color: 'var(--text-dim)' }}>{running ? `${bytes(g.mem)} / ${bytes(g.maxmem)}` : bytes(g.maxmem)}</td>
                    <td className="py-2"><div className="flex gap-1.5 flex-wrap">
                      {canOperate && (running ? (
                        <>
                          <button className="text-xs font-semibold rounded-md border px-2" style={btn(kind)} onClick={() => setAct({ g, a: { kind: 'power', action: 'reboot' } })}>Restart</button>
                          <button className="text-xs font-semibold rounded-md border px-2" style={btn(kind)} onClick={() => setAct({ g, a: { kind: 'power', action: 'shutdown' } })}>Shut down</button>
                          <button className="text-xs font-semibold rounded-md border px-2" style={btn(kind)} onClick={() => setAct({ g, a: { kind: 'power', action: 'stop' } })}>Stop</button>
                        </>
                      ) : <button className="text-xs font-semibold rounded-md border px-2" style={btn(kind)} onClick={() => setAct({ g, a: { kind: 'power', action: 'start' } })}>Start</button>)}
                      {canAdmin && <button className="text-xs font-semibold rounded-md border px-2" style={btn(kind)} onClick={() => setAct({ g, a: { kind: 'snapshot' } })}>Snapshot</button>}
                      {canAdmin && <button className="text-xs font-semibold rounded-md border px-2" style={btn(kind)} onClick={() => setAct({ g, a: { kind: 'backup' } })}>Back up now</button>}
                      <button className="text-xs font-semibold rounded-md border px-2" style={btn(kind)} onClick={() => setOpen(g)}>Settings</button>
                      {canAdmin && <button className="text-xs font-semibold rounded-md border px-2" style={{ ...btn(kind), color: 'var(--crit-soft)' }} onClick={() => setAct({ g, a: { kind: 'delete' } })}>Delete</button>}
                    </div></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {rows && shown.length === 0 && <p className="text-sm py-3" style={{ color: 'var(--text-dimmer)' }}>No guests match.</p>}
        </div>
      )}
      {open && <GuestDrawer row={open} nodes={nodes} canOperate={canOperate} canAdmin={canAdmin} remote={kind === 'remote'} onClose={() => setOpen(null)} onRefresh={() => { void load() }} />}
    </div>
  )
}
