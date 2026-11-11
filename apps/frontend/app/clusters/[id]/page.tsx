'use client'

// One cluster, opened in full. A remote cluster is amber on every part of this page, with its name in the
// banner, so it is never mistaken for home. Every API call from here carries the cluster (lib/api.ts).

import Link from 'next/link'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { useClusters, bytes, ago, type ClusterPanel } from '@/lib/clusters'
import { Notice, BusyNote } from '@/components/vault/ui'
import { Dot, KindPill, PanelView, AttentionFeed } from '@/components/clusters/CommandCenter'
import { GuestsTab } from '@/components/clusters/GuestActions'
import { ServerSettings } from '@/components/clusters/ServerSettings'
import { HardwareScan } from '@/components/clusters/HardwareScan'
import { MonitoringSetup } from '@/components/clusters/MonitoringSetup'
import { FilesTab } from '@/components/clusters/FilesTab'
import { SendFilesButton } from '@/components/clusters/SendFiles'
import { Page, HudHeader, styles } from '@/components/visual/kit'
import { ClusterHomeTab, useInstances } from '@/components/plugins/home-assistant/HomeAssistant'

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'guests', label: 'Guests' },
  { id: 'storage', label: 'Storage' },
  { id: 'tasks', label: 'Tasks and backups' },
  { id: 'hardware', label: 'Hardware' },
  { id: 'files', label: 'Files' },
  { id: 'home', label: 'Home Assistant' },
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
    <div className={styles.tableWrap}><table className={styles.table} style={{ minWidth: '34rem' }}>
      <thead><tr><th>Storage</th><th>Node</th><th>Type</th><th>Used</th><th>Free</th></tr></thead>
      <tbody>{rows.sort((a, b) => `${a.node}${a.storage}`.localeCompare(`${b.node}${b.storage}`)).map((s, i) => (
        <tr key={i}>
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
    <div className={styles.tableWrap}><table className={styles.table} style={{ minWidth: '34rem' }}>
      <thead><tr><th>When</th><th>What</th><th>Node</th><th>By</th><th>Result</th></tr></thead>
      <tbody>{rows.map(t => (
        <tr key={t.upid}>
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
  const houses = useInstances().list
  const setTab = (t: TabId) => router.replace(`/clusters/${id}${t === 'overview' ? '' : `?tab=${t}`}`)

  const loadPanel = useCallback(async () => {
    const r = await apiJson<{ data: { panels: ClusterPanel[] } }>('/api/clusters/overview')
    if (r.ok) setPanel(r.body!.data.panels.find(p => p.id === id) ?? null)
  }, [id])
  useEffect(() => { if (tab === 'overview') { void loadPanel(); const t = setInterval(loadPanel, 30_000); return () => clearInterval(t) } }, [tab, loadPanel])

  if (error) return <Page><Notice kind="error">{error}</Notice></Page>
  if (!clusters) return <Page><BusyNote>Reading clusters…</BusyNote></Page>
  if (!c) return <Page><Notice kind="warn">No such cluster. It may have been removed.</Notice><Link href="/clusters" style={{ color: 'var(--accent)' }}>‹ Command center</Link></Page>

  const k = c.kind
  const remote = k === 'remote'
  // The Home Assistant tab shows only when a house is linked to this server (home: or not linked at all).
  const hasHouse = (houses ?? []).some(i => i.clusterId === c.id || (!remote && !i.clusterId))
  const tabs = (remote ? TABS : TABS.filter(t => ['hardware', 'files', 'home', 'settings'].includes(t.id))).filter(t => t.id !== 'home' || hasHouse)
  const current = tabs.find(t => t.id === tab) ? tab : tabs[0].id

  return (
    <Page remote={remote}>
      <HudHeader level={2} eyebrow={remote ? 'Remote server' : 'Home cluster'} title={c.name} icon="router" label={`${c.name} overview`}
        chips={[{ label: 'Kind', value: remote ? 'Remote' : 'Home', tone: remote ? 'warm' : 'accent' }]}
        actions={<>
          <Link href="/clusters" className={`${styles.btn} ${styles.btnGhost} inline-flex items-center`}>‹ Command center</Link>
          {!remote && <Link href="/dashboard" className={`${styles.btn} ${styles.btnGhost} inline-flex items-center`}>Home dashboard ›</Link>}
          {remote && <SendFilesButton clusterId={c.id} clusterName={c.name} />}
        </>}>
        <span className="flex items-center gap-2"><Dot kind={k} /><KindPill kind={k} /></span>
        {remote && (
          <p className="text-sm font-semibold" role="status" style={{ color: 'var(--remote)' }}>
            <span className="uppercase" style={{ letterSpacing: '0.04em' }}>You are managing: {c.name}.</span>{' '}
            <span className="font-medium" style={{ color: 'var(--text-soft)' }}>Anything you do here happens on that machine, not on your home cluster.</span>
          </p>
        )}
      </HudHeader>
      <div className="grid md:grid-cols-[13rem_minmax(0,1fr)] min-w-0">
        <nav className="flex md:flex-col flex-wrap gap-1 p-3 border-b md:border-b-0 md:border-r text-sm" style={{ borderColor: 'var(--hx-line)' }} aria-label={`${c.name} sections`}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} className="text-left rounded-md px-2.5 py-1.5"
              style={{ background: current === t.id ? 'var(--accent-wash)' : 'transparent', fontWeight: current === t.id ? 600 : 400, color: current === t.id ? 'var(--hx-accent)' : 'var(--text)' }}>{t.label}</button>
          ))}
          {remote && <Link href={`/clusters/${c.id}/updates`} className="rounded-md px-2.5 py-1.5" style={{ color: 'var(--text)' }}>Updates</Link>}
          {remote && HOME_ONLY.map(l => (
            <span key={l} className="flex items-center justify-between gap-2 px-2.5 py-1.5" style={{ color: 'var(--text-dimmer)' }} title="This page works on the home cluster only for now.">
              {l}<span className="font-mono rounded border px-1" style={{ fontSize: 9.5, borderColor: 'var(--text-dimmer)' }}>HOME ONLY</span>
            </span>
          ))}
        </nav>
        <main className="p-3 sm:p-4 flex flex-col gap-4 min-w-0">
          {current === 'overview' && (panel ? <><PanelView p={panel} /><AttentionFeed items={panel.attention} /></> : <BusyNote>Reading {c.name}…</BusyNote>)}
          {current === 'guests' && <GuestsTab clusterId={c.id} clusterName={c.name} kind={k} />}
          {current === 'storage' && <StorageTab />}
          {current === 'tasks' && <TasksTab clusterId={c.id} />}
          {current === 'hardware' && (atLeast(role, 'admin') ? <HardwareScan clusterId={c.id} kind={k} /> : <Notice kind="warn">The hardware scan needs the admin role.</Notice>)}
          {current === 'files' && <FilesTab clusterId={c.id} />}
          {current === 'home' && <ClusterHomeTab clusterId={c.id} kind={k} />}
          {current === 'settings' && (atLeast(role, 'admin') ? (
            <>
              <ServerSettings c={c} onChanged={() => { void reload() }} />
              {remote && <MonitoringSetup c={c} onChanged={() => { void reload() }} />}
            </>
          ) : <Notice kind="warn">Editing a server needs the admin role.</Notice>)}
          {remote && (
            <div className={styles.callout} style={{ color: 'var(--text-muted)' }}>
              <b style={{ color: 'var(--text)' }}>Full control. </b>Starting, stopping, snapshots, backups, settings and deleting all work here. Every change names {c.name},
              is checked afterwards, and deleting asks you to type the name. Only the files that join a cluster together (corosync) stay hands-off.
            </div>
          )}
        </main>
      </div>
    </Page>
  )
}
