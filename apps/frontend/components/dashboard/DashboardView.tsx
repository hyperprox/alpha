// =============================================================================

const gpuNodes = (process.env.NEXT_PUBLIC_GPU_NODES ?? '').split(',').filter(Boolean)

//  FILE: apps/frontend/app/page.tsx
//  HyperProx Dashboard — Nodes + CEPH + HA + VM table
// =============================================================================

'use client'

import { useEffect, useState, useCallback } from 'react'
import { formatBytes, formatUptime, pct } from '@/lib/utils'
import { alpha } from '@/lib/theme'

interface PVENode {
  node: string; status: string; cpu: number; maxcpu: number
  mem: number; maxmem: number; disk: number; maxdisk: number; uptime: number
}
interface PVEVM {
  vmid: number; name: string; status: string; type: 'qemu' | 'lxc'
  node: string; cpus: number; cpu: number; mem: number; maxmem: number
  netin: number; netout: number; uptime: number; hastate?: string
}
interface CephStatus {
  health: { status: string; checks: Record<string, { detail: { message: string }[] }> }
  osdmap: { num_osds: number; num_up_osds: number; num_in_osds: number }
  pgmap?: { bytes_total: number; bytes_used: number; bytes_avail: number; data_bytes: number; num_pgs: number }
}
interface CephOSD {
  id: string; name: string; host: string; status: string; in: number
  pgs: number; percent_used: number; bytes_used: number; total_space: number
  device_class: string; commit_latency_ms: number; apply_latency_ms: number
}
interface HAEntry {
  id: string; type: string; status: string; node: string
  quorate?: number; crm_state?: string; sid?: string
}
interface Summary { nodes: PVENode[]; vms: PVEVM[]; ceph: CephStatus | null; osds: CephOSD[]; ha: HAEntry[] }

function GaugeRing({ value, size = 64, label }: { value: number; size?: number; label: string }) {
  const r = (size - 8) / 2
  const circ = 2 * Math.PI * r
  const offset = circ - (value / 100) * circ
  const color = value > 90 ? 'var(--crit-2)' : value > 75 ? 'var(--warn-2)' : 'var(--accent)'
  return (
    <div className="flex flex-col items-center gap-1">
      <svg width={size} height={size}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--text-faint)" strokeWidth={6} />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={6}
          strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
          transform={`rotate(-90 ${size/2} ${size/2})`}
          style={{ transition: 'stroke-dashoffset 0.6s ease, stroke 0.3s ease' }} />
        <text x={size/2} y={size/2+5} textAnchor="middle" fill={color} fontSize={13} fontFamily="IBM Plex Mono" fontWeight={500}>{value}%</text>
      </svg>
      <span className="text-xs text-gray-500 font-mono uppercase tracking-wider">{label}</span>
    </div>
  )
}

function NodeCard({ node, vms }: { node: PVENode; vms: PVEVM[] }) {
  const cpuPct = Math.round(node.cpu * 100)
  const memPct = pct(node.mem, node.maxmem)
  const diskPct = pct(node.disk, node.maxdisk)
  const nodeVMs = vms.filter(v => v.node === node.node)
  const running = nodeVMs.filter(v => v.status === 'running').length
  const isGpu = gpuNodes.includes(node.node)
  const accent = isGpu ? 'var(--violet)' : 'var(--accent)'

  return (
    <div className="rounded-lg border p-4 flex flex-col gap-4" style={{
      background: 'linear-gradient(135deg, var(--surface) 0%, var(--ground) 100%)',
      borderColor: `${alpha(accent, 19)}`, boxShadow: `0 0 12px ${alpha(accent, 3)}`,
    }}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{ background: accent, boxShadow: `0 0 6px ${accent}` }} />
          <span className="font-display font-semibold tracking-wide uppercase text-sm" style={{ color: accent }}>{node.node}</span>
          {isGpu && <span className="text-xs px-1.5 py-0.5 rounded font-mono" style={{ background: 'color-mix(in srgb, var(--violet) 13%, transparent)', color: 'var(--violet)', border: '1px solid color-mix(in srgb, var(--violet) 25%, transparent)' }}>GPU</span>}
        </div>
        <span className="text-xs font-mono text-gray-500">{formatUptime(node.uptime)}</span>
      </div>
      <div className="flex justify-around">
        <GaugeRing value={cpuPct} label="CPU" />
        <GaugeRing value={memPct} label="MEM" />
        <GaugeRing value={diskPct} label="DISK" />
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        {[['CORES', node.maxcpu], ['RAM', formatBytes(node.maxmem)], ['DISK', formatBytes(node.maxdisk)]].map(([l, v]) => (
          <div key={String(l)}>
            <div className="text-xs text-gray-500 font-mono">{l}</div>
            <div className="text-sm font-mono text-white">{v}</div>
          </div>
        ))}
      </div>
      <div className="flex gap-2 pt-1 border-t" style={{ borderColor: 'var(--text-faint)' }}>
        <span className="text-xs font-mono" style={{ color: accent }}>▶ {running} running</span>
        <span className="text-xs font-mono text-gray-600">■ {nodeVMs.length - running} stopped</span>
        <span className="text-xs font-mono text-gray-600 ml-auto">{nodeVMs.length} total</span>
      </div>
    </div>
  )
}

function CephPanel({ ceph, osds }: { ceph: CephStatus | null; osds: CephOSD[] }) {
  if (!ceph) return null
  const healthOk = ceph.health.status === 'HEALTH_OK'
  const healthWarn = ceph.health.status === 'HEALTH_WARN'
  const healthColor = healthOk ? 'var(--good)' : healthWarn ? 'var(--warn-2)' : 'var(--crit-2)'
  const usedPct = ceph.pgmap ? pct(ceph.pgmap.bytes_used, ceph.pgmap.bytes_total) : 0
  const checks = Object.entries(ceph.health.checks)

  const byHost = osds.reduce((acc, osd) => {
    if (!acc[osd.host]) acc[osd.host] = []
    acc[osd.host].push(osd)
    return acc
  }, {} as Record<string, CephOSD[]>)

  return (
    <div className="rounded-lg border p-4" style={{
      background: 'linear-gradient(135deg, var(--surface) 0%, var(--ground) 100%)', borderColor: `${alpha(healthColor, 19)}`,
    }}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{ background: healthColor, boxShadow: `0 0 6px ${healthColor}` }} />
          <span className="font-display font-semibold tracking-wide uppercase text-sm" style={{ color: 'var(--accent)' }}>CEPH</span>
          <span className="text-xs font-mono px-1.5 py-0.5 rounded" style={{
            background: `${alpha(healthColor, 8)}`, color: healthColor, border: `1px solid ${alpha(healthColor, 19)}`,
          }}>{ceph.health.status}</span>
        </div>
        <div className="flex gap-3 text-xs font-mono text-gray-500">
          <span style={{ color: 'var(--good)' }}>{ceph.osdmap.num_up_osds}/{ceph.osdmap.num_osds} OSDs up</span>
          {ceph.pgmap && <span>{ceph.pgmap.num_pgs} PGs</span>}
        </div>
      </div>

      {ceph.pgmap && (
        <div className="mb-4">
          <div className="flex justify-between text-xs font-mono text-gray-500 mb-1">
            <span>CLUSTER USAGE</span>
            <span style={{ color: usedPct > 80 ? 'var(--crit-2)' : 'var(--accent)' }}>
              {formatBytes(ceph.pgmap.bytes_used)} / {formatBytes(ceph.pgmap.bytes_total)}
            </span>
          </div>
          <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--text-faint)' }}>
            <div className="h-full rounded-full transition-all duration-700" style={{
              width: `${usedPct}%`,
              background: usedPct > 80 ? 'var(--crit-2)' : usedPct > 60 ? 'var(--warn-2)' : 'var(--accent)',
            }} />
          </div>
          <div className="flex justify-between text-xs font-mono text-gray-600 mt-1">
            <span>DATA: {formatBytes(ceph.pgmap.data_bytes)}</span>
            <span>FREE: {formatBytes(ceph.pgmap.bytes_avail)}</span>
          </div>
        </div>
      )}

      {checks.length > 0 && (
        <div className="mb-4 space-y-1">
          {checks.map(([key]) => (
            <div key={key} className="flex items-center gap-2 text-xs font-mono p-2 rounded" style={{ background: 'color-mix(in srgb, var(--warn-2) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--warn-2) 15%, transparent)' }}>
              <span style={{ color: 'var(--warn-2)' }}>⚠</span>
              <span style={{ color: 'var(--warn-2)' }}>{key}</span>
              {key === 'POOL_NO_REDUNDANCY' && <span className="text-gray-500">(intentional — no-replica pool)</span>}
            </div>
          ))}
        </div>
      )}

      <div>
        <div className="text-xs font-mono text-gray-500 uppercase tracking-wider mb-2">OSD Map</div>
        <div className="space-y-3">
          {Object.entries(byHost).sort(([a], [b]) => a.localeCompare(b)).map(([host, hostOsds]) => (
            <div key={host}>
              <div className="text-xs font-mono text-gray-600 mb-1">{host}</div>
              <div className="flex flex-wrap gap-1">
                {hostOsds.map(osd => {
                  const p = Math.round(osd.percent_used)
                  const c = osd.status !== 'up' ? 'var(--crit-2)' : p > 85 ? 'var(--crit-2)' : p > 70 ? 'var(--warn-2)' : 'var(--good)'
                  return (
                    <div key={osd.id}
                      title={`${osd.name} | ${osd.device_class} | ${p}% used | ${osd.apply_latency_ms}ms lat`}
                      className="flex flex-col items-center gap-0.5 p-1.5 rounded cursor-default"
                      style={{ background: `${alpha(c, 6)}`, border: `1px solid ${alpha(c, 19)}`, minWidth: 52 }}>
                      <span className="text-xs font-mono" style={{ color: c }}>{osd.name}</span>
                      <span className="text-xs font-mono text-gray-600">{p}%</span>
                      <span className="font-mono text-gray-700" style={{ fontSize: 9 }}>{osd.device_class}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function HAPanel({ ha }: { ha: HAEntry[] }) {
  const quorum   = ha.find(h => h.type === 'quorum')
  const master   = ha.find(h => h.type === 'master')
  const fencing  = ha.find(h => h.type === 'fencing')
  const lrms     = ha.filter(h => h.type === 'lrm')
  const services = ha.filter(h => h.type === 'service')
  const masterNode = master?.status.split(' ')[0] ?? '—'
  const fencingArmed = fencing?.status.includes('armed') ?? false
  const allStarted = services.every(s => s.crm_state === 'started')

  return (
    <div className="rounded-lg border p-4" style={{
      background: 'linear-gradient(135deg, var(--surface) 0%, var(--ground) 100%)', borderColor: 'color-mix(in srgb, var(--accent) 13%, transparent)',
    }}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{ background: 'var(--good)', boxShadow: '0 0 6px var(--good)' }} />
          <span className="font-display font-semibold tracking-wide uppercase text-sm" style={{ color: 'var(--accent)' }}>HIGH AVAILABILITY</span>
        </div>
        <span className="text-xs font-mono" style={{ color: allStarted ? 'var(--good)' : 'var(--warn-2)' }}>
          {services.filter(s => s.crm_state === 'started').length}/{services.length} services
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2 mb-4">
        {[
          { label: 'QUORUM',  value: quorum?.quorate ? 'OK' : 'FAIL', ok: !!quorum?.quorate },
          { label: 'MASTER',  value: masterNode,                       ok: true },
          { label: 'FENCING', value: fencingArmed ? 'ARMED' : 'OFF',  ok: fencingArmed },
        ].map(({ label, value, ok }) => (
          <div key={label} className="flex flex-col items-center gap-1 p-2 rounded" style={{ background: 'var(--border-dim)', border: '1px solid var(--text-faint)' }}>
            <span className="text-xs font-mono text-gray-500">{label}</span>
            <span className="text-xs font-mono font-semibold" style={{ color: ok ? 'var(--good)' : 'var(--crit-2)' }}>{value}</span>
          </div>
        ))}
      </div>

      <div className="mb-4">
        <div className="text-xs font-mono text-gray-500 uppercase tracking-wider mb-2">LRM per Node</div>
        <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
          {lrms.map(lrm => {
            const active = lrm.status.includes('active')
            return (
              <div key={lrm.id} className="flex items-center gap-1.5 text-xs font-mono p-1.5 rounded" style={{
                background: active ? 'color-mix(in srgb, var(--good) 6%, transparent)' : 'var(--text-faint)', border: `1px solid ${active ? 'color-mix(in srgb, var(--good) 19%, transparent)' : 'var(--text-faint)'}`,
              }}>
                <div className="w-1.5 h-1.5 rounded-full" style={{ background: active ? 'var(--good)' : 'var(--text-muted)' }} />
                <span style={{ color: active ? 'var(--good-soft)' : 'var(--text-muted)' }}>{lrm.node}</span>
              </div>
            )
          })}
        </div>
      </div>

      <div>
        <div className="text-xs font-mono text-gray-500 uppercase tracking-wider mb-2">
          Protected Services ({services.length})
        </div>
        <div className="flex flex-wrap gap-1">
          {services.map(svc => {
            const ok = svc.crm_state === 'started'
            return (
              <span key={svc.id} className="text-xs font-mono px-1.5 py-0.5 rounded" style={{
                background: ok ? 'color-mix(in srgb, var(--good) 6%, transparent)' : 'color-mix(in srgb, var(--crit-2) 6%, transparent)',
                color:      ok ? 'var(--good-soft)'   : 'var(--crit-soft)',
                border:     `1px solid ${ok ? 'color-mix(in srgb, var(--good) 19%, transparent)' : 'color-mix(in srgb, var(--crit-2) 19%, transparent)'}`,
              }}>{svc.sid}</span>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function Header({ nodes, vms, lastSync }: { nodes: PVENode[]; vms: PVEVM[]; lastSync: Date | null }) {
  const online  = nodes.filter(n => n.status === 'online').length
  const running = vms.filter(v => v.status === 'running').length
  return (
    <header className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: 'var(--border-dim)', background: 'var(--ground)' }}>
      <div className="flex items-center gap-3">
        <h1 className="font-display text-2xl font-light tracking-widest">
          HYPER<span className="font-bold" style={{ color: 'var(--accent)' }}>PROX</span>
        </h1>
        <span className="text-xs font-mono text-gray-600">v0.1.0</span>
      </div>
      <div className="flex items-center gap-3">
        {[
          { label: 'NODES',   value: `${online}/${nodes.length}`, color: 'var(--accent)' },
          { label: 'RUNNING', value: String(running),             color: 'var(--good)' },
          { label: 'VMs+CTs', value: String(vms.length),          color: 'var(--text-muted)' },
        ].map(({ label, value, color }) => (
          <div key={label} className="flex items-center gap-1.5 px-2 py-1 rounded text-xs font-mono" style={{ background: `${alpha(color, 6)}`, border: `1px solid ${alpha(color, 19)}` }}>
            <span style={{ color }}>{value}</span>
            <span className="text-gray-600">{label}</span>
          </div>
        ))}
        {lastSync && <span className="text-xs font-mono text-gray-600 hidden md:block">{lastSync.toLocaleTimeString()}</span>}
        <div className="w-2 h-2 rounded-full animate-pulse" style={{ background: 'var(--accent)', boxShadow: '0 0 6px var(--accent)' }} />
      </div>
    </header>
  )
}

function VMTable({ vms }: { vms: PVEVM[] }) {
  const [filter, setFilter] = useState<'running' | 'all' | 'stopped'>('running')
  const filtered = vms.filter(v => filter === 'all' || v.status === filter).sort((a, b) => a.vmid - b.vmid)

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-mono uppercase tracking-widest text-gray-500">VMs & Containers ({filtered.length})</h2>
        <div className="flex gap-1">
          {(['running', 'all', 'stopped'] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)} className="text-xs font-mono px-2 py-1 rounded transition-colors" style={{
              background: filter === f ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : 'transparent',
              color:      filter === f ? 'var(--accent)' : 'var(--text-muted)',
              border:     `1px solid ${filter === f ? 'color-mix(in srgb, var(--accent) 19%, transparent)' : 'var(--text-faint)'}`,
            }}>{f}</button>
          ))}
        </div>
      </div>
      <div className="rounded-lg border overflow-hidden" style={{ borderColor: 'var(--border-dim)' }}>
        <table className="w-full text-xs font-mono">
          <thead>
            <tr style={{ background: 'var(--surface)', borderBottom: '1px solid var(--text-faint)' }}>
              {['ID', 'NAME', 'TYPE', 'NODE', 'STATUS', 'CPU', 'MEM', 'UPTIME', 'HA'].map(h => (
                <th key={h} className="px-4 py-2 text-left text-gray-500 uppercase tracking-wider">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((vm, i) => (
              <tr key={`${vm.node}-${vm.vmid}`} style={{ borderBottom: '1px solid var(--border-dim)', background: i % 2 === 0 ? 'var(--ground)' : 'var(--surface-raised)' }}>
                <td className="px-4 py-2 text-gray-500">{vm.vmid}</td>
                <td className="px-4 py-2 text-white">{vm.name}</td>
                <td className="px-4 py-2"><span style={{ color: vm.type === 'lxc' ? 'var(--accent)' : 'var(--violet)' }}>{vm.type.toUpperCase()}</span></td>
                <td className="px-4 py-2 text-gray-400">{vm.node}</td>
                <td className="px-4 py-2"><span style={{ color: vm.status === 'running' ? 'var(--good)' : 'var(--text-muted)' }}>{vm.status === 'running' ? '●' : '■'} {vm.status}</span></td>
                <td className="px-4 py-2 text-gray-400">{vm.status === 'running' ? `${Math.round(vm.cpu * 100)}%` : '—'}</td>
                <td className="px-4 py-2 text-gray-400">{vm.status === 'running' ? formatBytes(vm.mem) : '—'}</td>
                <td className="px-4 py-2 text-gray-600">{vm.uptime ? formatUptime(vm.uptime) : '—'}</td>
                <td className="px-4 py-2">{vm.hastate && <span style={{ color: vm.hastate === 'started' ? 'var(--good)' : 'var(--warn-2)' }}>{vm.hastate}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function DashboardView() {
  const [data,     setData]     = useState<Summary | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [lastSync, setLastSync] = useState<Date | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const res  = await fetch('/api/proxmox/summary')
      const json = await res.json()
      if (json.success) { setData(json.data); setLastSync(new Date()); setError(null) }
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchData(); const t = setInterval(fetchData, 15000); return () => clearInterval(t) }, [fetchData])

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--ground)' }}>
      <div className="flex flex-col items-center gap-4">
        <div className="font-display text-2xl font-light tracking-widest">HYPER<span className="font-bold" style={{ color: 'var(--accent)' }}>PROX</span></div>
        <div className="text-xs font-mono text-gray-500 animate-pulse">connecting to titancluster...</div>
      </div>
    </div>
  )

  if (error || !data) return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--ground)' }}>
      <div className="text-center">
        <div className="text-red-400 font-mono text-sm mb-2">connection failed</div>
        <div className="text-gray-600 font-mono text-xs">{error}</div>
      </div>
    </div>
  )

  const sorted = [...data.nodes].sort((a, b) => gpuNodes.includes(a.node) ? -1 : gpuNodes.includes(b.node) ? 1 : a.node.localeCompare(b.node))

  return (
    <div className="min-h-screen" style={{ background: 'var(--ground)' }}>
      <Header nodes={data.nodes} vms={data.vms} lastSync={lastSync} />
      <main className="p-6 max-w-7xl mx-auto space-y-8">
        <section>
          <h2 className="text-xs font-mono uppercase tracking-widest text-gray-500 mb-4">Cluster Nodes</h2>
          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
            {sorted.map(node => <NodeCard key={node.node} node={node} vms={data.vms} />)}
          </div>
        </section>
        <section className="grid gap-4 lg:grid-cols-2">
          <CephPanel ceph={data.ceph} osds={data.osds} />
          <HAPanel   ha={data.ha} />
        </section>
        <section>
          <VMTable vms={data.vms} />
        </section>
      </main>
    </div>
  )
}
