'use client'

import { useEffect, useState, useCallback } from 'react'
import { formatBytes } from '@/lib/utils'
import { alpha } from '@/lib/theme'
import { Page, Panel, HudHeader, Details, Tiles, Pill, GlowBars, styles, type StatChip } from '@/components/visual/kit'

// ---------------------------------------------------------------------------
//  Types
// ---------------------------------------------------------------------------

interface StorageItem {
  storage:     string
  plugintype:  string
  type:        string
  status:      string
  active?:     number
  disk?:       number
  maxdisk?:    number
  used:        number
  total:       number
  avail:       number
  shared:      number
  content:     string
  node?:       string
  nodeCount?:  number
  nodes?:      string[]
}

interface CephOSD {
  id: string; name: string; host: string; status: string; in: number
  pgs: number; percent_used: number; bytes_used: number; total_space: number
  device_class: string; commit_latency_ms: number; apply_latency_ms: number
}

interface CephPool {
  pool:             string
  pool_name:        string
  type:             string
  size:             number
  min_size:         number
  pg_num:           number
  bytes_used:       number
  percent_used:     number
  crush_rule_name:  string
  pg_autoscale_mode: string
}

interface CephStatus {
  health: { status: string; checks: Record<string, any> }
  osdmap: { num_osds: number; num_up_osds: number; num_in_osds: number }
  pgmap?: { bytes_total: number; bytes_used: number; bytes_avail: number; data_bytes: number; num_pgs: number }
}

interface Overview {
  storage:     StorageItem[]
  nodeStorage: StorageItem[]
  rawStorage:  StorageItem[]
  ceph:        CephStatus | null
  osds:        CephOSD[]
  pools:       CephPool[]
  warnings:    string[]
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const TYPE_LABELS: Record<string, string> = {
  rbd:     'CEPH RBD',
  cephfs:  'CephFS',
  pbs:     'PBS Backup',
  lvmthin: 'LVM-Thin',
  dir:     'Directory',
  btrfs:   'BTRFS',
  zfspool: 'ZFS',
}

function pct(used: number, total: number) {
  return total > 0 ? Math.round((used / total) * 100) : 0
}

const fmtPct = (p: number) => `${p}%`

// ---------------------------------------------------------------------------
//  Volumes: one glow bar each, the exact numbers in Details
// ---------------------------------------------------------------------------

function Volumes({ storage }: { storage: StorageItem[] }) {
  const rows = [...storage].sort((a, b) => pct(b.used, b.total) - pct(a.used, a.total)).map(s => {
    const p = pct(s.used, s.total)
    return { key: s.storage, label: s.storage, value: p, text: fmtPct(p), title: `${s.storage}: ${formatBytes(s.used)} of ${formatBytes(s.total)}` }
  })
  return (
    <>
      <Panel title="Volumes" sub={`${storage.length} storages · used`}>
        {rows.length ? <GlowBars label="Storage used" items={rows} max={100} hiAt={80} /> : <p className={styles.empty}>No storage reported yet.</p>}
      </Panel>
      <Details summary="Volume details" sub="exact sizes, kind and content types">
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>Storage</th><th>Kind</th><th>State</th><th>Used</th><th>Free</th><th>Total</th><th>Use</th><th>Content</th></tr></thead>
            <tbody>
              {storage.map(s => {
                const p = pct(s.used, s.total)
                const up = s.active === 1 || s.status === 'available'
                return (
                  <tr key={s.storage}>
                    <td style={{ color: 'var(--text-bright)', fontWeight: 600 }}>{s.storage}{s.shared === 1 && <> <Pill tone="accent">shared</Pill></>}{(s.nodeCount ?? 0) > 1 && !s.shared && <> <Pill>{s.nodeCount} nodes</Pill></>}</td>
                    <td>{TYPE_LABELS[s.plugintype] ?? s.plugintype}</td>
                    <td><Pill tone={up ? 'good' : 'bad'}>{up ? 'active' : 'inactive'}</Pill></td>
                    <td>{formatBytes(s.used)}</td><td>{formatBytes(s.avail)}</td><td>{formatBytes(s.total)}</td>
                    <td><Pill tone={p > 90 ? 'bad' : p > 85 ? 'warn' : undefined}>{p}%{p > 90 ? ' critical' : p > 85 ? ' warning' : ''}</Pill></td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{(s.content?.split(',') ?? []).map(c => c.trim()).join(' · ')}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Details>
    </>
  )
}

// ---------------------------------------------------------------------------
//  Ceph pools: glow bars, the exact table in Details
// ---------------------------------------------------------------------------

function CephPools({ pools, ceph }: { pools: CephPool[]; ceph: CephStatus | null }) {
  const visible = pools.filter(p => !p.pool_name.startsWith('.'))
  return (
    <>
      {ceph && (
        <Tiles label="Ceph" items={[
          { label: 'Health', value: ceph.health.status, tone: ceph.health.status === 'HEALTH_OK' ? 'good' : 'warn' },
          { label: 'OSDs up', value: `${ceph.osdmap.num_up_osds}/${ceph.osdmap.num_osds}`, tone: ceph.osdmap.num_up_osds === ceph.osdmap.num_osds ? 'good' : 'crit' },
          { label: 'PGs', value: String(ceph.pgmap?.num_pgs ?? '—') },
        ]} />
      )}
      <Panel title="Pools" sub={`${visible.length} · used`}>
        {visible.length ? (
          <GlowBars label="Pool usage" max={100} hiAt={70}
            items={visible.map(p => { const v = Math.round(p.percent_used * 100); return { key: p.pool, label: p.pool_name, value: v, text: `${v}% · ${formatBytes(p.bytes_used)}`, title: `${p.pool_name}: size ${p.size}/${p.min_size} min` } })} />
        ) : <p className={styles.empty}>No pools reported.</p>}
      </Panel>
      <Details summary="Pool details" sub="size, placement groups and rule">
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>Pool</th><th>Type</th><th>Size</th><th>PGs</th><th>Used</th><th>Usage</th><th>Crush rule</th></tr></thead>
            <tbody>
              {visible.map(pool => {
                const p = Math.round(pool.percent_used * 100)
                return (
                  <tr key={pool.pool}>
                    <td style={{ color: 'var(--text-bright)', fontWeight: 600 }}>{pool.pool_name}</td>
                    <td>{pool.type}</td>
                    <td>{pool.size}<span style={{ color: 'var(--text-muted)' }}>/{pool.min_size} min</span></td>
                    <td>{pool.pg_num}</td>
                    <td>{formatBytes(pool.bytes_used)}</td>
                    <td><Pill tone={p > 85 ? 'bad' : p > 70 ? 'warn' : undefined}>{p}%{p > 85 ? ' critical' : p > 70 ? ' high' : ''}</Pill></td>
                    <td>{pool.crush_rule_name}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Details>
    </>
  )
}

// ---------------------------------------------------------------------------
//  OSD map: a tile per OSD, state in words, grouped by host
// ---------------------------------------------------------------------------

function OSDMap({ osds }: { osds: CephOSD[] | null }) {
  const byHost = (osds ?? []).reduce((acc, o) => {
    if (!acc[o.host]) acc[o.host] = []
    acc[o.host].push(o)
    return acc
  }, {} as Record<string, CephOSD[]>)
  const entries = Object.entries(byHost).sort(([a], [b]) => a.localeCompare(b))
  if (!entries.length) return <Panel title="OSDs"><p className={styles.empty}>No OSDs reported.</p></Panel>

  return (
    <>
      {entries.map(([host, hostOsds]) => (
        <Panel key={host} title={host} sub={`${hostOsds.length} OSD${hostOsds.length === 1 ? '' : 's'}`}>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 170px), 1fr))' }}>
            {hostOsds.map(osd => {
              const p = Math.round(osd.percent_used)
              const down = osd.status !== 'up'
              const col = down || p > 85 ? 'var(--crit)' : p > 70 ? 'var(--warn)' : 'var(--good)'
              const word = down ? 'down' : p > 85 ? 'nearly full' : p > 70 ? 'filling' : 'healthy'
              return (
                <li key={osd.id} style={{ padding: 12, borderRadius: 10, border: `1px solid ${alpha(col, 30)}`, background: alpha(col, 6), minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: 'var(--text-bright)' }}>
                      <i aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: col, boxShadow: `0 0 6px ${col}` }} />{osd.name}
                    </span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>{osd.device_class}</span>
                  </div>
                  <div style={{ height: 6, borderRadius: 3, overflow: 'hidden', background: 'var(--track)', marginBottom: 6 }} aria-hidden>
                    <div style={{ height: '100%', width: `${Math.max(0, Math.min(100, p))}%`, background: col, borderRadius: 3 }} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                    <span style={{ color: col }}>{p}% · {word}</span>
                    <span style={{ color: 'var(--text-muted)' }}>{formatBytes(osd.bytes_used)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>
                    <span>lat <span style={{ color: osd.apply_latency_ms > 20 ? 'var(--warn)' : 'var(--text-soft)' }}>{osd.apply_latency_ms}ms{osd.apply_latency_ms > 20 ? ' slow' : ''}</span></span>
                    <span>pgs <span style={{ color: 'var(--text-soft)' }}>{osd.pgs}</span></span>
                  </div>
                </li>
              )
            })}
          </ul>
        </Panel>
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------
//  Main storage page
// ---------------------------------------------------------------------------

export default function StoragePage() {
  const [overview,  setOverview]  = useState<Overview | null>(null)
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)
  const [tab,       setTab]       = useState<'volumes' | 'ceph-pools' | 'osds' | 'vms'>('volumes')
  const [lastSync,  setLastSync]  = useState<Date | null>(null)
  const [vmBreakdown, setVmBreakdown] = useState<any[]>([])
  const [vmLoading,   setVmLoading]   = useState(false)

  const fetchData = useCallback(async () => {
    try {
      const res  = await fetch('/api/storage/overview')
      const json = await res.json()
      if (json.success) { setOverview(json.data); setLastSync(new Date()) }
      else setError(json.error)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchData(); const t = setInterval(fetchData, 15000); return () => clearInterval(t) }, [fetchData])

  useEffect(() => {
    if (tab === 'vms') {
      setVmLoading(true)
      fetch('/api/storage/vms-breakdown').then(r => r.json())
        .then(j => { if (j.success) setVmBreakdown(j.data) })
        .finally(() => setVmLoading(false))
    }
  }, [tab])

  if (loading) return (
    <Page><p className={styles.empty} role="status">Loading storage…</p></Page>
  )

  if (error || !overview) return (
    <Page><div className={styles.callout} role="alert" style={{ color: 'var(--crit)' }}>{error ?? 'No data'}</div></Page>
  )

  const totalRaw = overview.storage.reduce((s, x) => s + (x.total ?? 0), 0)
  const usedRaw  = overview.storage.reduce((s, x) => s + (x.used ?? 0), 0)
  const overallPct = pct(usedRaw, totalRaw)
  const cephOk = overview.ceph?.health.status === 'HEALTH_OK'
  const chips: StatChip[] = [
    { label: 'capacity', value: formatBytes(totalRaw) },
    { label: 'used', value: formatBytes(usedRaw), tone: 'accent' },
    { label: 'available', value: formatBytes(totalRaw - usedRaw), tone: 'good' },
    ...(overview.ceph ? [{ label: 'Ceph', value: overview.ceph.health.status.replace('HEALTH_', ''), tone: cephOk ? 'good' as const : 'warn' as const }] : []),
  ]
  const title = overallPct > 90 ? 'Storage is nearly full' : overallPct > 80 ? 'Storage is filling up' : 'Storage has room'
  const poolCount = (overview.pools ?? []).filter(p => !p.pool_name.startsWith('.')).length
  const tabs = [
    { key: 'volumes',    label: `Volumes (${overview.storage.length})` },
    { key: 'ceph-pools', label: `Ceph pools (${poolCount})` },
    { key: 'osds',       label: `OSDs (${overview.osds?.length ?? 0})` },
    { key: 'vms',        label: 'VM disks' },
  ] as const

  return (
    <Page>
      <HudHeader level={2} label="Storage status" eyebrow="Ceph and volumes" title={title} chips={chips}
        ring={{ value: overallPct / 100, text: `${overallPct}%`, label: 'used' }}>
        {lastSync && <p style={{ margin: 0, color: 'var(--text-soft)', fontSize: 14 }}>synced {lastSync.toLocaleTimeString()}</p>}
      </HudHeader>

      {(overview.warnings?.length ?? 0) > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(overview.warnings ?? []).map((w, i) => (
            <div key={i} className={styles.callout} role="alert" style={{ borderStyle: 'solid', borderColor: alpha('var(--crit)', 40), color: 'var(--crit)' }}>
              <span aria-hidden>⚠ </span><span>Warning: {w}</span>
            </div>
          ))}
        </div>
      )}

      <div className={styles.row} role="group" aria-label="Storage view">
        {tabs.map(({ key, label }) => (
          <button key={key} onClick={() => setTab(key)} aria-pressed={tab === key} className={`${styles.btn} ${tab === key ? styles.btnPri : ''}`}>{label}</button>
        ))}
      </div>

      {tab === 'volumes' && <Volumes storage={overview.storage ?? []} />}
      {tab === 'ceph-pools' && <CephPools pools={overview.pools ?? []} ceph={overview.ceph} />}
      {tab === 'osds' && <OSDMap osds={overview.osds ?? []} />}

      {tab === 'vms' && (
        vmLoading ? <p className={styles.empty} role="status">Loading…</p> : (
          <Panel title="VM disks" sub={`${vmBreakdown.length} VMs & containers · total allocated ${formatBytes(vmBreakdown.reduce((s: number, v: any) => s + (v.totalAllocated ?? 0), 0))}`}>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead><tr>{['ID', 'Name', 'Type', 'Node', 'Status', 'Storage', 'Allocated', 'Used'].map(h => <th key={h}>{h}</th>)}</tr></thead>
                <tbody>
                  {vmBreakdown.map((vm: any) => (
                    <tr key={`${vm.node}-${vm.vmid}`}>
                      <td>{vm.vmid}</td>
                      <td style={{ color: 'var(--text-bright)', fontWeight: 600 }}>{vm.name}</td>
                      <td><Pill tone={vm.type === 'lxc' ? 'accent' : 'violet'}>{vm.type.toUpperCase()}</Pill></td>
                      <td>{vm.node}</td>
                      <td><Pill tone={vm.status === 'running' ? 'good' : undefined}>{vm.status === 'running' ? '●' : '■'} {vm.status}</Pill></td>
                      <td>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                          {(vm.disks ?? []).map((d: any, di: number) => <Pill key={di} tone="violet">{d.storage} {d.sizeStr}</Pill>)}
                          {(!vm.disks || vm.disks.length === 0) && <span style={{ color: 'var(--text-muted)' }}>—</span>}
                        </div>
                      </td>
                      <td style={{ color: (vm.totalAllocated ?? 0) > 100 * 1024 * 1024 * 1024 ? 'var(--warn)' : 'var(--text-bright)' }}>{formatBytes(vm.totalAllocated ?? 0)}</td>
                      <td>{vm.diskUsed > 0 ? formatBytes(vm.diskUsed) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        )
      )}
    </Page>
  )
}
