'use client'

import { useEffect, useState, useCallback } from 'react'
import { formatBytes } from '@/lib/utils'

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

interface VMDisk { key: string; storage: string; size: number; sizeStr: string }
interface VMStorageItem {
  vmid: number; name: string; type: 'qemu'|'lxc'; node: string; status: string
  disks: VMDisk[]; totalAllocated: number; diskUsed: number
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const TYPE_COLORS: Record<string, string> = {
  rbd:     '#a78bfa',
  cephfs:  '#00e5ff',
  pbs:     '#f59e0b',
  lvmthin: '#22c55e',
  dir:     '#6b7280',
  btrfs:   '#22d3ee',
  zfspool: '#818cf8',
}

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

function UsageBar({ used, total, color }: { used: number; total: number; color: string }) {
  const p = pct(used, total)
  const c = p > 90 ? '#ff4444' : p > 80 ? '#ffaa00' : color
  return (
    <div>
      <div className="h-1.5 rounded-full overflow-hidden" style={{ background: '#1f2937' }}>
        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${p}%`, background: c }}/>
      </div>
      <div className="flex justify-between text-xs font-mono mt-0.5">
        <span style={{ color: c }}>{p}%</span>
        <span className="text-gray-600">{formatBytes(used)} / {formatBytes(total)}</span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
//  Storage card
// ---------------------------------------------------------------------------

function StorageCard({ s }: { s: StorageItem }) {
  const color   = TYPE_COLORS[s.plugintype] ?? '#6b7280'
  const label   = TYPE_LABELS[s.plugintype] ?? s.plugintype
  const usedPct = pct(s.used, s.total)
  const isWarn  = usedPct > 85
  const isCrit  = usedPct > 90

  const contents = s.content?.split(',') ?? []

  return (
    <div className="rounded-lg border p-4" style={{
      background:  'linear-gradient(135deg, #0d1220 0%, #080c14 100%)',
      borderColor: isCrit ? '#ff444430' : isWarn ? '#ffaa0030' : `${color}25`,
      boxShadow:   isCrit ? '0 0 12px #ff444408' : isWarn ? '0 0 12px #ffaa0008' : 'none',
    }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{
            background: (s.active === 1 || s.status === 'available') ? '#22c55e' : '#ff4444',
            boxShadow:  (s.active === 1 || s.status === 'available') ? '0 0 5px #22c55e' : '0 0 5px #ff4444',
          }}/>
          <span className="font-mono text-sm font-semibold text-white">{s.storage}</span>
          {isWarn && <span className="text-xs font-mono px-1.5 py-0.5 rounded" style={{ background: '#ff444415', color: '#ff6666', border: '1px solid #ff444430', fontSize: 9 }}>
            {isCrit ? 'CRITICAL' : 'WARNING'}
          </span>}
        </div>
        <span className="text-xs font-mono px-1.5 py-0.5 rounded" style={{
          background: `${color}15`, color, border: `1px solid ${color}30`, fontSize: 9,
        }}>{label}</span>
      </div>

      {/* Usage bar */}
      <UsageBar used={s.used} total={s.total} color={color}/>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2 mt-3">
        {[
          { label: 'USED',  value: formatBytes(s.used)   },
          { label: 'FREE',  value: formatBytes(s.avail)  },
          { label: 'TOTAL', value: formatBytes(s.total)},
        ].map(({ label, value }) => (
          <div key={label} className="text-center">
            <div className="text-xs font-mono text-gray-600">{label}</div>
            <div className="text-xs font-mono text-white">{value}</div>
          </div>
        ))}
      </div>

      {/* Content types */}
      <div className="flex flex-wrap gap-1 mt-3 pt-2 border-t" style={{ borderColor: '#111827' }}>
        {contents.map(c => (
          <span key={c} className="text-xs font-mono px-1.5 py-0.5 rounded" style={{
            background: '#ffffff08', color: '#4b5563', border: '1px solid #1f2937', fontSize: 9,
          }}>{c.trim()}</span>
        ))}
        {(s.nodeCount ?? 0) > 1 && !s.shared && (
          <span key="nodes" className="text-xs font-mono px-1.5 py-0.5 rounded" style={{
            background: '#ffffff08', color: '#374151', border: '1px solid #1f2937', fontSize: 9,
          }}>{s.nodeCount} nodes</span>
        )}
        {s.shared === 1 && (
          <span className="text-xs font-mono px-1.5 py-0.5 rounded ml-auto" style={{
            background: '#00e5ff08', color: '#00e5ff60', border: '1px solid #00e5ff20', fontSize: 9,
          }}>SHARED</span>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
//  CEPH pools table
// ---------------------------------------------------------------------------

function CephPoolsTable({ pools }: { pools: CephPool[] }) {
  const visible = pools.filter(p => !p.pool_name.startsWith('.'))

  return (
    <div className="rounded-lg border overflow-hidden" style={{ borderColor: '#0f1929' }}>
      <table className="w-full text-xs font-mono">
        <thead>
          <tr style={{ background: '#060a10', borderBottom: '1px solid #0f1929' }}>
            {['Pool', 'Type', 'Size', 'PGs', 'Used', 'Usage', 'Crush Rule'].map(h => (
              <th key={h} className="px-4 py-2 text-left text-gray-600 uppercase tracking-wider">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((pool, i) => {
            const p   = Math.round(pool.percent_used * 100)
            const col = p > 85 ? '#ff4444' : p > 70 ? '#ffaa00' : '#00e5ff'
            return (
              <tr key={pool.pool} style={{ borderBottom: '1px solid #0a0f1a', background: i % 2 === 0 ? '#080c14' : '#0a0f1a' }}>
                <td className="px-4 py-2.5 text-white font-semibold">{pool.pool_name}</td>
                <td className="px-4 py-2.5 text-gray-400">{pool.type}</td>
                <td className="px-4 py-2.5">
                  <span style={{ color: '#e5e7eb' }}>{pool.size}</span>
                  <span className="text-gray-600">/{pool.min_size} min</span>
                </td>
                <td className="px-4 py-2.5 text-gray-400">{pool.pg_num}</td>
                <td className="px-4 py-2.5" style={{ color: col }}>{formatBytes(pool.bytes_used)}</td>
                <td className="px-4 py-2.5" style={{ minWidth: 120 }}>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: '#1f2937' }}>
                      <div className="h-full rounded-full" style={{ width: `${p}%`, background: col }}/>
                    </div>
                    <span style={{ color: col, minWidth: 32 }}>{p}%</span>
                  </div>
                </td>
                <td className="px-4 py-2.5 text-gray-600">{pool.crush_rule_name}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------------------
//  OSD map
// ---------------------------------------------------------------------------

function OSDMap({ osds }: { osds: CephOSD[] }) {
  const byHost = osds.reduce((acc, o) => {
    if (!acc[o.host]) acc[o.host] = []
    acc[o.host].push(o)
    return acc
  }, {} as Record<string, CephOSD[]>)

  return (
    <div className="space-y-4">
      {Object.entries(byHost).sort(([a], [b]) => a.localeCompare(b)).map(([host, hostOsds]) => (
        <div key={host}>
          <div className="text-xs font-mono text-gray-500 mb-2 uppercase tracking-wider">{host}</div>
          <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
            {hostOsds.map(osd => {
              const p   = Math.round(osd.percent_used)
              const col = osd.status !== 'up' ? '#ff4444' : p > 85 ? '#ff4444' : p > 70 ? '#ffaa00' : '#22c55e'
              return (
                <div key={osd.id} className="p-3 rounded-lg border" style={{
                  background:  `${col}08`,
                  borderColor: `${col}30`,
                }}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <div className="w-1.5 h-1.5 rounded-full" style={{ background: col, boxShadow: `0 0 4px ${col}` }}/>
                      <span className="text-xs font-mono font-semibold" style={{ color: col }}>{osd.name}</span>
                    </div>
                    <span className="font-mono text-gray-600" style={{ fontSize: 9 }}>{osd.device_class}</span>
                  </div>
                  <div className="h-1.5 rounded-full overflow-hidden mb-1" style={{ background: '#1f2937' }}>
                    <div className="h-full rounded-full" style={{ width: `${p}%`, background: col }}/>
                  </div>
                  <div className="flex justify-between text-xs font-mono">
                    <span style={{ color: col }}>{p}%</span>
                    <span className="text-gray-600">{formatBytes(osd.bytes_used)}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-1 mt-2 text-xs font-mono">
                    <div>
                      <span className="text-gray-700">LAT </span>
                      <span style={{ color: osd.apply_latency_ms > 20 ? '#ffaa00' : '#4b5563' }}>
                        {osd.apply_latency_ms}ms
                      </span>
                    </div>
                    <div>
                      <span className="text-gray-700">PGS </span>
                      <span className="text-gray-500">{osd.pgs}</span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
//  Summary bar
// ---------------------------------------------------------------------------

function SummaryBar({ storage }: { storage: StorageItem[] }) {
  const totalRaw  = storage.reduce((s, x) => s + (x.total ?? 0), 0)
  const usedRaw   = storage.reduce((s, x) => s + (x.used ?? 0), 0)
  const overallPct = pct(usedRaw, totalRaw)

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
      {[
        { label: 'Total Capacity', value: formatBytes(totalRaw),        color: '#6b7280' },
        { label: 'Used',           value: formatBytes(usedRaw),          color: '#00e5ff' },
        { label: 'Available',      value: formatBytes(totalRaw - usedRaw), color: '#22c55e' },
        { label: 'Overall',        value: `${overallPct}%`,              color: overallPct > 80 ? '#ff4444' : '#f59e0b' },
      ].map(({ label, value, color }) => (
        <div key={label} className="rounded-lg border p-4" style={{ background: '#0d1220', borderColor: `${color}25` }}>
          <div className="font-display text-xl font-bold" style={{ color }}>{value}</div>
          <div className="text-xs font-mono text-gray-600 mt-0.5">{label}</div>
        </div>
      ))}
    </div>
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
    <div className="min-h-full flex items-center justify-center" style={{ background: '#080c14' }}>
      <div className="text-xs font-mono text-gray-500 animate-pulse">loading storage...</div>
    </div>
  )

  if (error || !overview) return (
    <div className="min-h-full flex items-center justify-center" style={{ background: '#080c14' }}>
      <div className="text-red-400 font-mono text-sm">{error ?? 'No data'}</div>
    </div>
  )

  return (
    <div className="min-h-full p-6" style={{ background: '#080c14' }}>

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-1 h-6 rounded-full" style={{ background: '#818cf8', boxShadow: '0 0 8px #818cf8' }}/>
          <h1 className="font-display text-2xl font-semibold tracking-wide uppercase" style={{ color: '#818cf8' }}>Storage</h1>
        </div>
        {lastSync && <span className="text-xs font-mono text-gray-600">synced {lastSync.toLocaleTimeString()}</span>}
      </div>

      {/* Warnings */}
      {(overview.warnings?.length??0) > 0 && (
        <div className="mb-5 space-y-1">
          {(overview.warnings??[]).map((w, i) => (
            <div key={i} className="flex items-center gap-2 px-3 py-2 rounded text-xs font-mono" style={{
              background: '#ff444410', color: '#f87171', border: '1px solid #ff444430',
            }}>
              <span>⚠</span><span>{w}</span>
            </div>
          ))}
        </div>
      )}

      {/* Summary bar */}
      <SummaryBar storage={overview.storage}/>

      {/* Tabs */}
      <div className="flex gap-1 mb-5 border-b" style={{ borderColor: '#111827' }}>
        {([
          { key: 'volumes',    label: `Volumes (${overview.storage.length})` },
          { key: 'ceph-pools', label: `CEPH Pools (${(overview.pools??[]).filter(p => !p.pool_name.startsWith('.')).length})` },
          { key: 'osds',       label: `OSDs (${(overview.osds?.length??0)})` },
          { key: 'vms',        label: 'VM Disks' },
        ] as const).map(({ key, label }) => (
          <button key={key} onClick={() => setTab(key)}
            className="px-5 py-3 text-xs font-mono uppercase tracking-wider transition-colors"
            style={{
              borderBottom: tab === key ? '2px solid #818cf8' : '2px solid transparent',
              color:        tab === key ? '#818cf8' : '#4b5563',
              background:   'transparent',
            }}>{label}</button>
        ))}
      </div>

      {/* VOLUMES */}
      {tab === 'volumes' && (
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
          {(overview.storage??[]).map(s => <StorageCard key={s.storage} s={s}/>)}
        </div>
      )}

      {/* CEPH POOLS */}
      {tab === 'ceph-pools' && (
        <div className="space-y-4">
          {overview.ceph && (
            <div className="grid grid-cols-3 gap-3 mb-4">
              {[
                { label: 'Health',  value: overview.ceph.health.status, color: overview.ceph.health.status === 'HEALTH_OK' ? '#22c55e' : '#ffaa00' },
                { label: 'OSDs',    value: `${overview.ceph.osdmap.num_up_osds}/${overview.ceph.osdmap.num_osds} up`, color: '#22c55e' },
                { label: 'PGs',     value: String(overview.ceph.pgmap?.num_pgs ?? '—'), color: '#6b7280' },
              ].map(({ label, value, color }) => (
                <div key={label} className="p-3 rounded-lg border text-center" style={{ background: '#0d1220', borderColor: `${color}25` }}>
                  <div className="font-mono text-sm font-bold" style={{ color }}>{value}</div>
                  <div className="text-xs font-mono text-gray-600 mt-0.5">{label}</div>
                </div>
              ))}
            </div>
          )}
          <CephPoolsTable pools={overview.pools}/>
        </div>
      )}

      {/* OSDs */}
      {tab === 'osds' && <OSDMap osds={overview.osds}/>}

      {/* VM Disks */}
      {tab === 'vms' && (
        vmLoading ? (
          <div className="text-xs font-mono text-gray-600 animate-pulse py-8 text-center">Loading...</div>
        ) : (
          <div className="rounded-lg border overflow-hidden" style={{borderColor:'#0f1929'}}>
            <div className="flex items-center justify-between px-4 py-2 border-b text-xs font-mono text-gray-600" style={{background:'#060a10',borderColor:'#0f1929'}}>
              <span>{vmBreakdown.length} VMs &amp; Containers</span>
              <span style={{color:'#818cf8'}}>Total allocated: {formatBytes(vmBreakdown.reduce((s:number,v:any)=>s+(v.totalAllocated??0),0))}</span>
            </div>
            <table className="w-full text-xs font-mono">
              <thead>
                <tr style={{background:'#060a10',borderBottom:'1px solid #0f1929'}}>
                  {['ID','Name','Type','Node','Status','Storage','Allocated','Used'].map(h=>(
                    <th key={h} className="px-4 py-2 text-left text-gray-600 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {vmBreakdown.map((vm:any,i:number)=>(
                  <tr key={`${vm.node}-${vm.vmid}`} style={{borderBottom:'1px solid #0a0f1a',background:i%2===0?'#080c14':'#0a0f1a'}}
                    onMouseEnter={e=>(e.currentTarget as HTMLElement).style.background='#0d1220'}
                    onMouseLeave={e=>(e.currentTarget as HTMLElement).style.background=i%2===0?'#080c14':'#0a0f1a'}>
                    <td className="px-4 py-2.5 text-gray-500">{vm.vmid}</td>
                    <td className="px-4 py-2.5 text-white font-semibold">{vm.name}</td>
                    <td className="px-4 py-2.5"><span style={{color:vm.type==='lxc'?'#00e5ff':'#a78bfa'}}>{vm.type.toUpperCase()}</span></td>
                    <td className="px-4 py-2.5 text-gray-400">{vm.node}</td>
                    <td className="px-4 py-2.5"><span style={{color:vm.status==='running'?'#22c55e':'#374151'}}>{vm.status==='running'?'●':'■'} {vm.status}</span></td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {((vm.disks)??[]).map((d:any,di:number)=>(
                          <span key={di} className="px-1.5 py-0.5 rounded" style={{fontSize:9,background:'#a78bfa15',color:'#a78bfa',border:'1px solid #a78bfa30'}}>
                            {d.storage} <span style={{color:'#4b5563'}}>{d.sizeStr}</span>
                          </span>
                        ))}
                        {(!vm.disks||vm.disks.length===0)&&<span className="text-gray-700">—</span>}
                      </div>
                    </td>
                    <td className="px-4 py-2.5"><span style={{color:(vm.totalAllocated??0)>100*1024*1024*1024?'#ffaa00':'#e5e7eb'}}>{formatBytes(vm.totalAllocated??0)}</span></td>
                    <td className="px-4 py-2.5 text-gray-400">{vm.diskUsed>0?formatBytes(vm.diskUsed):'—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

    </div>
  )
}

// ---------------------------------------------------------------------------
//  VM Storage Breakdown component
// ---------------------------------------------------------------------------

function VMStorageBreakdown({ items, storageColors }: {
  items: VMStorageItem[]
  storageColors: Record<string, string>
}) {
  const [sortBy,      setSortBy]      = useState<'size'|'name'|'node'>('size')
  const [filterNode,  setFilterNode]  = useState('all')
  const [filterStore, setFilterStore] = useState('all')
  const [search,      setSearch]      = useState('')

  const nodes    = [...new Set(items.map(v => v.node))].sort()
  const storages = [...new Set(items.flatMap(v => v.disks.map(d => d.storage)))].sort()

  const filtered = items
    .filter(v => filterNode  === 'all' || v.node === filterNode)
    .filter(v => filterStore === 'all' || v.disks.some(d => d.storage === filterStore))
    .filter(v => !search || v.name.toLowerCase().includes(search.toLowerCase()) || String(v.vmid).includes(search))
    .sort((a, b) => {
      if (sortBy === 'size') return b.totalAllocated - a.totalAllocated
      if (sortBy === 'name') return a.name.localeCompare(b.name)
      return a.node.localeCompare(b.node)
    })

  const totalAllocated = filtered.reduce((s, v) => s + v.totalAllocated, 0)

  const SEL = { background:'#060a10', border:'1px solid #1f2937', color:'#9ca3af', borderRadius:6, padding:'6px 10px', fontFamily:'IBM Plex Mono,monospace', fontSize:11, outline:'none' } as React.CSSProperties

  return (
    <div>
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <select style={SEL} value={filterNode} onChange={e=>setFilterNode(e.target.value)}>
          <option value="all">All nodes</option>
          {nodes.map(n=><option key={n} value={n}>{n}</option>)}
        </select>
        <select style={SEL} value={filterStore} onChange={e=>setFilterStore(e.target.value)}>
          <option value="all">All storage</option>
          {storages.map(s=><option key={s} value={s}>{s}</option>)}
        </select>
        <select style={SEL} value={sortBy} onChange={e=>setSortBy(e.target.value as any)}>
          <option value="size">Sort: Size</option>
          <option value="name">Sort: Name</option>
          <option value="node">Sort: Node</option>
        </select>
        <input type="text" placeholder="Search..." value={search} onChange={e=>setSearch(e.target.value)}
          style={{...SEL, width:160, caretColor:'#818cf8'}}/>
        <div className="ml-auto flex items-center gap-3 text-xs font-mono">
          <span className="text-gray-600">{filtered.length} VMs/CTs</span>
          <span style={{color:'#818cf8'}}>Total allocated: {formatBytes(totalAllocated)}</span>
        </div>
      </div>

      <div className="rounded-lg border overflow-hidden" style={{borderColor:'#0f1929'}}>
        <table className="w-full text-xs font-mono">
          <thead>
            <tr style={{background:'#060a10',borderBottom:'1px solid #0f1929'}}>
              {['ID','Name','Type','Node','Status','Storage Pools','Allocated'].map(h=>(
                <th key={h} className="px-4 py-2 text-left text-gray-600 uppercase tracking-wider">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((vm,i)=>(
              <tr key={`${vm.node}-${vm.vmid}`}
                style={{borderBottom:'1px solid #0a0f1a',background:i%2===0?'#080c14':'#0a0f1a'}}
                onMouseEnter={e=>(e.currentTarget as HTMLElement).style.background='#0d1220'}
                onMouseLeave={e=>(e.currentTarget as HTMLElement).style.background=i%2===0?'#080c14':'#0a0f1a'}
              >
                <td className="px-4 py-2.5 text-gray-500">{vm.vmid}</td>
                <td className="px-4 py-2.5 text-white font-semibold">{vm.name}</td>
                <td className="px-4 py-2.5"><span style={{color:vm.type==='lxc'?'#00e5ff':'#a78bfa'}}>{vm.type.toUpperCase()}</span></td>
                <td className="px-4 py-2.5 text-gray-400">{vm.node}</td>
                <td className="px-4 py-2.5">
                  <span style={{color:vm.status==='running'?'#22c55e':'#374151'}}>
                    {vm.status==='running'?'●':'■'} {vm.status}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {vm.disks.map(d=>{
                      const color = storageColors[d.storage]??'#6b7280'
                      return (
                        <span key={d.key} title={`${d.key}: ${d.storage} ${d.sizeStr}`}
                          className="px-1.5 py-0.5 rounded"
                          style={{fontSize:9,background:`${color}15`,color,border:`1px solid ${color}30`}}>
                          {d.storage} <span style={{color:'#4b5563'}}>{d.sizeStr}</span>
                        </span>
                      )
                    })}
                    {vm.disks.length===0&&<span className="text-gray-700">—</span>}
                  </div>
                </td>
                <td className="px-4 py-2.5">
                  <span style={{color:vm.totalAllocated>100*1024*1024*1024?'#ffaa00':'#e5e7eb'}}>
                    {formatBytes(vm.totalAllocated)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
