'use client'

// One cluster, opened in full. A remote cluster is amber on every part of this page, with its name in the
// banner, so it is never mistaken for home. Every API call from here carries the cluster (lib/api.ts).

import Link from 'next/link'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { useClusters, clusterColor, bytes, ago, type ClusterPanel } from '@/lib/clusters'
import { Notice, BusyNote } from '@/components/vault/ui'
import { Dot, KindPill, PanelView, AttentionFeed } from '@/components/clusters/CommandCenter'
import { GuestsTab } from '@/components/clusters/GuestActions'
import { ServerSettings } from '@/components/clusters/ServerSettings'
import { HardwareScan } from '@/components/clusters/HardwareScan'
import { MonitoringSetup } from '@/components/clusters/MonitoringSetup'
import { FilesTab } from '@/components/clusters/FilesTab'

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'guests', label: 'Guests' },
  { id: 'storage', label: 'Storage' },
  { id: 'tasks', label: 'Tasks and backups' },
  { id: 'hardware', label: 'Hardware' },
  { id: 'files', label: 'Files' },
  { id: 'settings', label: 'Edit server' },
] as const
type TabId = typeof TABS[number]['id']

// Pages that work on the home cluster only for now. Shown, so nobody wonders where they went, and labelled.
const HOME_ONLY = ['High availability', 'GPU sharing']

function StorageTab() {
  const [rows, setRows] = useState<any[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { apiJson<{ data: any[] }>('/api/proxmox/storage').then(r => { if (r.ok) setRows(r.body!.data ?? []); else setErr(r.error ?? 'Could not read storage') }) }, [])
  if (err) return <Notice kind="error">{err}</Notice>
  if (!rows) return <BusyNote>Reading storage…</BusyNote>
  return (
    <div className="overflow-x-auto"><table className="w-full text-sm" style={{ minWidth: '34rem' }}>
      <thead><tr className="text-left font-mono uppercase" style={{ fontSize: 11, letterSpacing: '0.08em', color: 'var(--text-muted)' }}><th className="py-2 pr-3">Storage</th><th className="py-2 pr-3">Node</th><th className="py-2 pr-3">Type</th><th className="py-2 pr-3">Used</th><th className="py-2">Free</th></tr></thead>
      <tbody>{rows.sort((a, b) => `${a.node}${a.storage}`.localeCompare(`${b.node}${b.storage}`)).map((s, i) => (
        <tr key={i} className="border-t" style={{ borderColor: 'var(--border-dim)' }}>
          <td className="py-2 pr-3" style={{ color: 'var(--text-bright)' }}>{s.storage}{Number(s.shared) === 1 && <span className="ml-1 text-xs" style={{ color: 'var(--text-dimmer)' }}>shared</span>}</td>
          <td className="py-2 pr-3" style={{ color: 'var(--text-dim)' }}>{s.node}</td>
          <td className="py-2 pr-3 font-mono text-xs" style={{ color: 'var(--text-dim)' }}>{s.type}</td>
          <td className="py-2 pr-3 font-mono text-xs" style={{ color: 'var(--text)' }}>{s.total ? `${bytes(s.used)} of ${bytes(s.total)} (${Math.round((s.used / s.total) * 100)}%)` : '—'}</td>
          <td className="py-2 font-mono text-xs" style={{ color: 'var(--text)' }}>{bytes(s.avail)}</td>
        </tr>
      ))}</tbody>
    </table></div>
  )
}

function TasksTab({ clusterId }: { clusterId: string }) {
  const [rows, setRows] = useState<any[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    const load = () => apiJson<{ data: any[] }>(`/api/clusters/${clusterId}/tasks`).then(r => { if (r.ok) setRows(r.body!.data ?? []); else setErr(r.error ?? 'Could not read tasks') })
    void load(); const t = setInterval(load, 15_000); return () => clearInterval(t)
  }, [clusterId])
  if (err) return <Notice kind="error">{err}</Notice>
  if (!rows) return <BusyNote>Reading tasks…</BusyNote>
  return (
    <div className="overflow-x-auto"><table className="w-full text-sm" style={{ minWidth: '34rem' }}>
      <thead><tr className="text-left font-mono uppercase" style={{ fontSize: 11, letterSpacing: '0.08em', color: 'var(--text-muted)' }}><th className="py-2 pr-3">When</th><th className="py-2 pr-3">What</th><th className="py-2 pr-3">Node</th><th className="py-2 pr-3">By</th><th className="py-2">Result</th></tr></thead>
      <tbody>{rows.map(t => (
        <tr key={t.upid} className="border-t" style={{ borderColor: 'var(--border-dim)' }}>
          <td className="py-2 pr-3 text-xs" style={{ color: 'var(--text-dim)' }}>{ago(t.starttime * 1000)}</td>
          <td className="py-2 pr-3" style={{ color: t.type === 'vzdump' ? 'var(--text-bright)' : 'var(--text)' }}>{t.type === 'vzdump' ? 'Backup' : t.type}{t.id ? ` ${t.id}` : ''}</td>
          <td className="py-2 pr-3" style={{ color: 'var(--text-dim)' }}>{t.node}</td>
          <td className="py-2 pr-3 text-xs" style={{ color: 'var(--text-dim)' }}>{t.user}</td>
          <td className="py-2 text-xs font-semibold" style={{ color: !t.endtime ? 'var(--warn-2)' : t.status === 'OK' ? 'var(--good)' : 'var(--crit-soft)' }}>{!t.endtime ? 'running' : t.status}</td>
        </tr>
      ))}</tbody>
    </table></div>
  )
}

export default function ClusterPage() {
  const params = useParams<{ id: string }>()
  const id = String(params?.id ?? '')
  const search = useSearchParams()
  const router = useRouter()
  const { role } = useSession()
  const { clusters, error, reload } = useClusters()
  const c = useMemo(() => clusters?.find(x => x.id === id) ?? null, [clusters, id])
  const tab = (TABS.find(t => t.id === search?.get('tab'))?.id ?? 'overview') as TabId
  const [panel, setPanel] = useState<ClusterPanel | null>(null)
  const setTab = (t: TabId) => router.replace(`/clusters/${id}${t === 'overview' ? '' : `?tab=${t}`}`)

  const loadPanel = useCallback(async () => {
    const r = await apiJson<{ data: { panels: ClusterPanel[] } }>('/api/clusters/overview')
    if (r.ok) setPanel(r.body!.data.panels.find(p => p.id === id) ?? null)
  }, [id])
  useEffect(() => { if (tab === 'overview') { void loadPanel(); const t = setInterval(loadPanel, 30_000); return () => clearInterval(t) } }, [tab, loadPanel])

  if (error) return <div className="p-8"><Notice kind="error">{error}</Notice></div>
  if (!clusters) return <div className="p-8"><BusyNote>Reading clusters…</BusyNote></div>
  if (!c) return <div className="p-8 flex flex-col gap-3"><Notice kind="warn">No such cluster. It may have been removed.</Notice><Link href="/clusters" style={{ color: 'var(--accent)' }}>‹ Command center</Link></div>

  const k = c.kind
  const remote = k === 'remote'
  const tabs = remote ? TABS : TABS.filter(t => ['hardware', 'files', 'settings'].includes(t.id))
  const current = tabs.find(t => t.id === tab) ? tab : tabs[0].id

  return (
    <div className="min-h-full" style={{ background: 'var(--ground)' }}>
      <div className="flex items-center gap-3 flex-wrap px-4 sm:px-8 py-3 border-b" style={{ background: 'var(--surface-raised)', borderColor: 'var(--border)' }}>
        <Link href="/clusters" className="text-sm rounded-md border px-2.5 py-1" style={{ borderColor: 'var(--border-strong)', color: 'var(--text)' }}>‹ Command center</Link>
        <Dot kind={k} /><b className="font-display" style={{ fontSize: 20, color: 'var(--text-bright)' }}>{c.name}</b><KindPill kind={k} />
        {!remote && <Link href="/dashboard" className="ml-auto text-sm" style={{ color: 'var(--accent)' }}>Home dashboard ›</Link>}
      </div>
      {remote && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 sm:px-8 py-2 font-semibold" style={{ background: 'var(--remote)', color: 'var(--remote-ink)' }} role="status">
          <span className="uppercase" style={{ letterSpacing: '0.04em' }}>You are managing: {c.name}</span>
          <small className="font-medium" style={{ opacity: 0.85 }}>Anything you do here happens on that machine, not on your home cluster.</small>
        </div>
      )}
      <div className="grid md:grid-cols-[13rem_minmax(0,1fr)] min-w-0">
        <nav className="flex md:flex-col flex-wrap gap-1 p-3 border-b md:border-b-0 md:border-r text-sm" style={{ borderColor: 'var(--border)' }} aria-label={`${c.name} sections`}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} className="text-left rounded-md px-2.5 py-1.5"
              style={{ background: current === t.id ? 'var(--surface)' : 'transparent', fontWeight: current === t.id ? 600 : 400, color: current === t.id ? clusterColor(k) : 'var(--text)' }}>{t.label}</button>
          ))}
          {remote && <Link href={`/clusters/${c.id}/updates`} className="rounded-md px-2.5 py-1.5" style={{ color: 'var(--text)' }}>Updates</Link>}
          {remote && HOME_ONLY.map(l => (
            <span key={l} className="flex items-center justify-between gap-2 px-2.5 py-1.5" style={{ color: 'var(--text-dimmer)' }} title="This page works on the home cluster only for now.">
              {l}<span className="font-mono rounded border px-1" style={{ fontSize: 9.5, borderColor: 'var(--text-dimmer)' }}>HOME ONLY</span>
            </span>
          ))}
        </nav>
        <main className="p-4 sm:p-6 flex flex-col gap-4 min-w-0">
          {current === 'overview' && (panel ? <><PanelView p={panel} /><AttentionFeed items={panel.attention} /></> : <BusyNote>Reading {c.name}…</BusyNote>)}
          {current === 'guests' && <GuestsTab clusterId={c.id} clusterName={c.name} kind={k} />}
          {current === 'storage' && <StorageTab />}
          {current === 'tasks' && <TasksTab clusterId={c.id} />}
          {current === 'hardware' && (atLeast(role, 'admin') ? <HardwareScan clusterId={c.id} kind={k} /> : <Notice kind="warn">The hardware scan needs the admin role.</Notice>)}
          {current === 'files' && <FilesTab clusterId={c.id} />}
          {current === 'settings' && (atLeast(role, 'admin') ? (
            <>
              <ServerSettings c={c} onChanged={() => { void reload() }} />
              {remote && <MonitoringSetup c={c} onChanged={() => { void reload() }} />}
            </>
          ) : <Notice kind="warn">Editing a server needs the admin role.</Notice>)}
          {remote && (
            <div className="rounded-lg border border-dashed p-3 text-sm" style={{ borderColor: 'var(--border-strong)', color: 'var(--text-muted)' }}>
              <b style={{ color: 'var(--text)' }}>Full control. </b>Starting, stopping, snapshots, backups, settings and deleting all work here. Every change names {c.name},
              is checked afterwards, and deleting asks you to type the name. Only the files that join a cluster together (corosync) stay hands-off.
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
