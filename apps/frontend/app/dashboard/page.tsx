'use client'

const gpuNodes = (process.env.NEXT_PUBLIC_GPU_NODES ?? '').split(',').filter(Boolean)


import { useEffect, useState, useCallback, useRef } from 'react'
import Link from 'next/link'
import { formatBytes, formatUptime, pct } from '@/lib/utils'

// Types
interface PVENode { node: string; status: string; cpu: number; maxcpu: number; mem: number; maxmem: number; disk: number; maxdisk: number; uptime: number }
interface PVEVM   { vmid: number; name: string; status: string; type: 'qemu'|'lxc'; node: string; cpus: number; cpu: number; mem: number; maxmem: number; uptime: number; hastate?: string }
interface CephStatus { health: { status: string; checks: Record<string,any> }; osdmap: { num_osds: number; num_up_osds: number }; pgmap?: { bytes_total: number; bytes_used: number; bytes_avail: number; data_bytes: number; num_pgs: number } }
interface CephOSD { id: string; name: string; host: string; status: string; percent_used: number; device_class: string; apply_latency_ms: number }
interface HAEntry  { id: string; type: string; status: string; node: string; quorate?: number; crm_state?: string; sid?: string }
interface GPUInfo  { name: string; vram_total: number; vram_used: number; gpu_util: number; temp: number; power_draw: number; power_limit: number; vram_pct: number; power_pct: number }
interface ClusterTotals { cpu_used: number; cpu_total: number; cpu_pct: number; mem_used: number; mem_total: number; mem_pct: number; disk_used: number; disk_total: number; disk_pct: number }
interface ServiceInfo { connected: boolean; url?: string; version?: string; message?: string; total?: number; enabled?: number; disabled?: number; ssl?: number; expiring?: number }

interface GPUConsumer { pid: number; vram_mb: number; process: string; ct_id: string|null; ct_name: string|null; vram_pct: number }
interface GPUInfoFull { name: string; vram_total: number; vram_used: number; vram_free: number; gpu_util: number; temp: number; power_draw: number; power_limit: number; vram_pct: number; power_pct: number; consumers: GPUConsumer[] }
interface NodeNetStats { node: string; netin: number; netout: number; netin_mb: number; netout_mb: number }
interface CephIOStats { read_bps: number; write_bps: number; read_ops: number; write_ops: number }
interface NetworkData { nodes: NodeNetStats[]; ceph_io: CephIOStats|null; total_in: number; total_out: number }
interface FastData { nodes: PVENode[]; vms: PVEVM[]; gpu: GPUInfoFull|null; cluster: ClusterTotals; network?: NetworkData }
interface SlowData { ceph: CephStatus|null; osds: CephOSD[]; ha: HAEntry[]; services: { npm: ServiceInfo; grafana?: ServiceInfo; prometheus?: ServiceInfo } }

// Gauge
function GaugeRing({ value, size=64, label, color }: { value:number; size?:number; label:string; color?:string }) {
  const r=( size-8)/2, circ=2*Math.PI*r, offset=circ-(value/100)*circ
  const c = color ?? (value>90?'#ff4444':value>75?'#ffaa00':'#00e5ff')
  return (
    <div className="flex flex-col items-center gap-1">
      <svg width={size} height={size}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#1f2937" strokeWidth={6}/>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={c} strokeWidth={6}
          strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
          transform={`rotate(-90 ${size/2} ${size/2})`} style={{transition:'stroke-dashoffset 0.5s ease'}}/>
        <text x={size/2} y={size/2+5} textAnchor="middle" fill={c} fontSize={13} fontFamily="IBM Plex Mono" fontWeight={500}>{value}%</text>
      </svg>
      <span className="text-xs text-gray-500 font-mono uppercase tracking-wider">{label}</span>
    </div>
  )
}

// Usage bar
function UsageBar({ label, used, total, p, color='#00e5ff', fmt }: { label:string; used:number; total:number; p:number; color?:string; fmt:(v:number)=>string }) {
  const c = p>90?'#ff4444':p>75?'#ffaa00':color
  return (
    <div>
      <div className="flex justify-between text-xs font-mono mb-1">
        <span className="text-gray-500">{label}</span>
        <span style={{color:c}}>{fmt(used)} / {fmt(total)}</span>
      </div>
      <div className="h-1.5 rounded-full overflow-hidden" style={{background:'#1f2937'}}>
        <div className="h-full rounded-full transition-all duration-500" style={{width:`${p}%`,background:c}}/>
      </div>
      <div className="text-right text-xs font-mono mt-0.5" style={{color:c}}>{p}%</div>
    </div>
  )
}

// Cluster summary
function ClusterPanel({ cluster, nodes, vms, ceph }: { cluster:ClusterTotals; nodes:PVENode[]; vms:PVEVM[]; ceph:CephStatus|null }) {
  const running = vms.filter(v=>v.status==='running').length
  const online  = nodes.filter(n=>n.status==='online').length
  const cephPct = ceph?.pgmap ? pct(ceph.pgmap.bytes_used, ceph.pgmap.bytes_total) : 0

  return (
    <div className="rounded-lg border p-5" style={{background:'linear-gradient(135deg,#0d1220,#080c14)',borderColor:'#00e5ff20'}}>
      <div className="flex items-center gap-2 mb-4">
        <div className="w-2 h-2 rounded-full" style={{background:'#00e5ff',boxShadow:'0 0 6px #00e5ff'}}/>
        <span className="font-display font-semibold tracking-wide uppercase text-sm" style={{color:'#00e5ff'}}>Cluster Overview</span>
      </div>
      <div className="grid grid-cols-4 gap-2 mb-5">
        {[
          {label:'NODES',   value:`${online}/${nodes.length}`, color:'#00e5ff'},
          {label:'RUNNING', value:String(running),              color:'#22c55e'},
          {label:'STOPPED', value:String(vms.length-running),   color:'#374151'},
          {label:'HA VMs',  value:String(vms.filter(v=>v.hastate).length), color:'#a78bfa'},
        ].map(({label,value,color})=>(
          <div key={label} className="text-center p-2 rounded" style={{background:'#060a10',border:'1px solid #111827'}}>
            <div className="font-display text-xl font-bold" style={{color}}>{value}</div>
            <div className="text-xs font-mono text-gray-600 mt-0.5">{label}</div>
          </div>
        ))}
      </div>
      <div className="space-y-3">
        <UsageBar label="CPU"    used={cluster.cpu_used}  total={cluster.cpu_total}  p={cluster.cpu_pct}  fmt={v=>`${v.toFixed(1)} cores`}/>
        <UsageBar label="MEMORY" used={cluster.mem_used}  total={cluster.mem_total}  p={cluster.mem_pct}  fmt={formatBytes}/>
        <UsageBar label="DISK"   used={cluster.disk_used} total={cluster.disk_total} p={cluster.disk_pct} fmt={formatBytes} color="#818cf8"/>
        {ceph?.pgmap && (
          <UsageBar label="CEPH" used={ceph.pgmap.bytes_used} total={ceph.pgmap.bytes_total} p={cephPct} fmt={formatBytes} color="#f59e0b"/>
        )}
      </div>
      <Link href="/infrastructure" className="flex items-center justify-center gap-2 mt-4 py-2 rounded text-xs font-mono transition-all"
        style={{background:'#00e5ff08',color:'#00e5ff60',border:'1px solid #00e5ff15'}}>
        View Infrastructure →
      </Link>
    </div>
  )
}

// GPU panel
function GPUPanel({ gpu }: { gpu: GPUInfoFull | null }) {
  const accent = '#a78bfa'

  if (!gpu) return (
    <div className="rounded-lg border p-5 flex items-center justify-center" style={{ background:'#0d1220', borderColor:'#1f2937', minHeight:160 }}>
      <span className="text-xs font-mono text-gray-600">GPU unavailable</span>
    </div>
  )

  const vramC  = gpu.vram_pct  > 90 ? '#ff4444' : gpu.vram_pct  > 75 ? '#ffaa00' : accent
  const powerC = gpu.power_pct > 80 ? '#ff4444' : gpu.power_pct > 60 ? '#ffaa00' : '#22c55e'
  const tempC  = gpu.temp > 80 ? '#ff4444' : gpu.temp > 65 ? '#ffaa00' : '#22c55e'

  // Build VRAM segments for stacked bar
  const totalVRAM = gpu.vram_total
  const consumers = gpu.consumers ?? []
  const unaccounted = gpu.vram_used - consumers.reduce((s, c) => s + c.vram_mb, 0)

  return (
    <div className="rounded-lg border p-5" style={{ background:'linear-gradient(135deg,#0d1220,#080c14)', borderColor:`${accent}30`, boxShadow:`0 0 16px ${accent}08` }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{ background:accent, boxShadow:`0 0 6px ${accent}` }}/>
          <span className="font-display font-semibold tracking-wide uppercase text-sm" style={{ color:accent }}>GPU</span>
        </div>
        <span className="text-xs font-mono text-gray-500 truncate ml-2" style={{ maxWidth:140 }}>{gpu.name.replace('NVIDIA ','')}</span>
      </div>

      {/* VRAM stacked bar */}
      <div className="mb-3">
        <div className="flex justify-between text-xs font-mono mb-1">
          <span className="text-gray-500">VRAM</span>
          <span style={{ color:vramC }}>{gpu.vram_used} / {gpu.vram_total} MB</span>
        </div>
        <div className="h-3 rounded-full overflow-hidden flex" style={{ background:'#1f2937' }}>
          {consumers.map((c, i) => {
            const pct = (c.vram_mb / totalVRAM) * 100
            const colors = ['#a78bfa','#00e5ff','#22c55e','#f59e0b','#f87171']
            const color  = colors[i % colors.length]
            return (
              <div key={c.pid} title={`${c.ct_name ?? c.process}: ${c.vram_mb}MB`}
                className="h-full transition-all duration-500" style={{ width:`${pct}%`, background:color }}/>
            )
          })}
          {unaccounted > 0 && (
            <div className="h-full" style={{ width:`${(unaccounted/totalVRAM)*100}%`, background:'#374151' }}/>
          )}
        </div>
      </div>

      {/* Consumer list */}
      {consumers.length > 0 && (
        <div className="space-y-1 mb-4">
          {consumers.map((c, i) => {
            const colors = ['#a78bfa','#00e5ff','#22c55e','#f59e0b','#f87171']
            const color  = colors[i % colors.length]
            return (
              <div key={c.pid} className="flex items-center gap-2 text-xs font-mono">
                <div className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background:color }}/>
                <span style={{ color:'#e5e7eb' }}>{c.ct_name ?? c.process}</span>
                {c.ct_id && <span className="text-gray-600">CT {c.ct_id}</span>}
                <span className="ml-auto" style={{ color }}>{c.vram_mb} MB ({c.vram_pct}%)</span>
              </div>
            )
          })}
        </div>
      )}

      {/* Stats grid */}
      <div className="grid grid-cols-4 gap-2">
        {[
          { label:'GPU',   value:`${gpu.gpu_util}%`,              color:accent  },
          { label:'VRAM',  value:`${gpu.vram_pct}%`,              color:vramC   },
          { label:'TEMP',  value:`${gpu.temp}°C`,                 color:tempC   },
          { label:'POWER', value:`${gpu.power_draw.toFixed(0)}W`, color:powerC  },
        ].map(({ label, value, color }) => (
          <div key={label} className="text-center p-2 rounded" style={{ background:'#060a10', border:`1px solid ${color}20` }}>
            <div className="text-sm font-mono font-bold" style={{ color }}>{value}</div>
            <div className="text-xs font-mono text-gray-600 mt-0.5">{label}</div>
          </div>
        ))}
      </div>

      {/* Power bar */}
      <div className="mt-3">
        <div className="flex justify-between text-xs font-mono mb-1">
          <span className="text-gray-500">POWER</span>
          <span style={{ color:powerC }}>{gpu.power_draw.toFixed(1)}W / {gpu.power_limit}W</span>
        </div>
        <div className="h-1.5 rounded-full overflow-hidden" style={{ background:'#1f2937' }}>
          <div className="h-full rounded-full transition-all duration-500" style={{ width:`${gpu.power_pct}%`, background:powerC }}/>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
//  Network Panel
// ---------------------------------------------------------------------------

interface NodeNetStats {
  node: string; netin: number; netout: number; netin_mb: number; netout_mb: number
}
interface CephIOStats {
  read_bps: number; write_bps: number; read_ops: number; write_ops: number
}
interface NetworkData {
  nodes: NodeNetStats[]; ceph_io: CephIOStats | null
  total_in: number; total_out: number
}

function fmtSpeed(bps: number): string {
  if (bps >= 1024 * 1024 * 1024) return `${(bps / 1024 / 1024 / 1024).toFixed(1)} GB/s`
  if (bps >= 1024 * 1024)        return `${(bps / 1024 / 1024).toFixed(1)} MB/s`
  if (bps >= 1024)               return `${(bps / 1024).toFixed(0)} KB/s`
  return `${bps.toFixed(0)} B/s`
}

function SpeedBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0
  return (
    <div className="h-1 rounded-full overflow-hidden flex-1" style={{ background:'#1f2937' }}>
      <div className="h-full rounded-full transition-all duration-500" style={{ width:`${pct}%`, background:color }}/>
    </div>
  )
}


function NetworkPanel({ network }: { network: NetworkData | null }) {
  if (!network) return null

  const maxNodeSpeed = Math.max(
    ...network.nodes.flatMap(n => [n.netin, n.netout]), 1
  )

  const sortedNodes = [...network.nodes].sort((a, b) =>
    gpuNodes.includes(a.node) ? -1 : gpuNodes.includes(b.node) ? 1 : a.node.localeCompare(b.node)
  )

  return (
    <div className="rounded-lg border p-5" style={{ background:'linear-gradient(135deg,#0d1220,#080c14)', borderColor:'#00e5ff20' }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{ background:'#00e5ff', boxShadow:'0 0 6px #00e5ff' }}/>
          <span className="font-display font-semibold tracking-wide uppercase text-sm" style={{ color:'#00e5ff' }}>Network</span>
        </div>
        <div className="flex gap-3 text-xs font-mono">
          <span style={{ color:'#22c55e' }}>↓ {fmtSpeed(network.total_in)}</span>
          <span style={{ color:'#f59e0b' }}>↑ {fmtSpeed(network.total_out)}</span>
        </div>
      </div>

      {/* Per-node rows */}
      <div className="space-y-2 mb-4">
        {sortedNodes.map(n => {
          const isGpu = gpuNodes.includes(n.node)
          const accent = isGpu ? '#a78bfa' : '#00e5ff'
          return (
            <div key={n.node}>
              <div className="flex items-center gap-2 mb-1">
                <span className="font-mono text-xs w-12 flex-shrink-0" style={{ color:accent }}>{n.node}</span>
                <div className="flex-1 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono w-16 text-right" style={{ color:'#22c55e', fontSize:10 }}>↓ {fmtSpeed(n.netin)}</span>
                    <SpeedBar value={n.netin} max={maxNodeSpeed} color="#22c55e"/>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono w-16 text-right" style={{ color:'#f59e0b', fontSize:10 }}>↑ {fmtSpeed(n.netout)}</span>
                    <SpeedBar value={n.netout} max={maxNodeSpeed} color="#f59e0b"/>
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* CEPH I/O */}
      {network.ceph_io && (
        <div className="border-t pt-3" style={{ borderColor:'#111827' }}>
          <div className="text-xs font-mono text-gray-500 uppercase tracking-wider mb-2">CEPH I/O</div>
          <div className="grid grid-cols-2 gap-2">
            <div className="p-2 rounded" style={{ background:'#060a10', border:'1px solid #111827' }}>
              <div className="text-xs font-mono text-gray-600 mb-0.5">READ</div>
              <div className="text-sm font-mono font-bold" style={{ color:'#22c55e' }}>{fmtSpeed(network.ceph_io.read_bps)}</div>
              <div className="text-xs font-mono text-gray-700">{network.ceph_io.read_ops} ops/s</div>
            </div>
            <div className="p-2 rounded" style={{ background:'#060a10', border:'1px solid #111827' }}>
              <div className="text-xs font-mono text-gray-600 mb-0.5">WRITE</div>
              <div className="text-sm font-mono font-bold" style={{ color:'#f59e0b' }}>{fmtSpeed(network.ceph_io.write_bps)}</div>
              <div className="text-xs font-mono text-gray-700">{network.ceph_io.write_ops} ops/s</div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


// Node card
function NodeCard({ node, vms }: { node:PVENode; vms:PVEVM[] }) {
  const cpuPct=Math.round(node.cpu*100), memPct=pct(node.mem,node.maxmem), diskPct=pct(node.disk,node.maxdisk)
  const nodeVMs=vms.filter(v=>v.node===node.node), running=nodeVMs.filter(v=>v.status==='running').length
  const isGpu=gpuNodes.includes(node.node), accent=isGpu?'#a78bfa':'#00e5ff'
  return (
    <div className="rounded-lg border p-4 flex flex-col gap-4" style={{background:'linear-gradient(135deg,#0d1220,#080c14)',borderColor:`${accent}30`}}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{background:accent,boxShadow:`0 0 6px ${accent}`}}/>
          <span className="font-display font-semibold tracking-wide uppercase text-sm" style={{color:accent}}>{node.node}</span>
          {isGpu && <span className="text-xs px-1.5 py-0.5 rounded font-mono" style={{background:'#7c3aed20',color:'#a78bfa',border:'1px solid #7c3aed40',fontSize:9}}>GPU</span>}
        </div>
        <span className="text-xs font-mono text-gray-500">{formatUptime(node.uptime)}</span>
      </div>
      <div className="flex justify-around">
        <GaugeRing value={cpuPct}  label="CPU"  color={accent}/>
        <GaugeRing value={memPct}  label="MEM"/>
        <GaugeRing value={diskPct} label="DISK"/>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        {[['CORES',node.maxcpu],['RAM',formatBytes(node.maxmem)],['DISK',formatBytes(node.maxdisk)]].map(([l,v])=>(
          <div key={String(l)}>
            <div className="text-xs text-gray-600 font-mono">{l}</div>
            <div className="text-sm font-mono text-white">{v}</div>
          </div>
        ))}
      </div>
      <div className="flex gap-2 pt-1 border-t" style={{borderColor:'#111827'}}>
        <span className="text-xs font-mono" style={{color:accent}}>▶ {running} running</span>
        <span className="text-xs font-mono text-gray-600">■ {nodeVMs.length-running} stopped</span>
        <span className="text-xs font-mono text-gray-600 ml-auto">{nodeVMs.length} total</span>
      </div>
    </div>
  )
}

// CEPH compact
function CephPanel({ ceph, osds }: { ceph:CephStatus|null; osds:CephOSD[] }) {
  if (!ceph) return null
  const hOk=ceph.health.status==='HEALTH_OK', hWarn=ceph.health.status==='HEALTH_WARN'
  const hc=hOk?'#22c55e':hWarn?'#ffaa00':'#ff4444'
  const up=ceph.pgmap?pct(ceph.pgmap.bytes_used,ceph.pgmap.bytes_total):0
  const checks=Object.entries(ceph.health.checks)
  const byHost=osds.reduce((a,o)=>{if(!a[o.host])a[o.host]=[];a[o.host].push(o);return a},{} as Record<string,CephOSD[]>)
  return (
    <div className="rounded-lg border p-5" style={{background:'linear-gradient(135deg,#0d1220,#080c14)',borderColor:`${hc}30`}}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{background:hc,boxShadow:`0 0 6px ${hc}`}}/>
          <span className="font-display font-semibold tracking-wide uppercase text-sm" style={{color:'#00e5ff'}}>CEPH</span>
          <span className="text-xs font-mono px-1.5 py-0.5 rounded" style={{background:`${hc}15`,color:hc,border:`1px solid ${hc}30`}}>{ceph.health.status}</span>
        </div>
        <span className="text-xs font-mono" style={{color:'#22c55e'}}>{ceph.osdmap.num_up_osds}/{ceph.osdmap.num_osds} OSDs</span>
      </div>
      {ceph.pgmap&&(
        <div className="mb-3">
          <div className="flex justify-between text-xs font-mono mb-1">
            <span className="text-gray-500">USAGE</span>
            <span style={{color:up>80?'#ff4444':'#00e5ff'}}>{formatBytes(ceph.pgmap.bytes_used)} / {formatBytes(ceph.pgmap.bytes_total)}</span>
          </div>
          <div className="h-2 rounded-full overflow-hidden" style={{background:'#1f2937'}}>
            <div className="h-full rounded-full transition-all duration-500" style={{width:`${up}%`,background:up>80?'#ff4444':up>60?'#ffaa00':'#00e5ff'}}/>
          </div>
          <div className="flex justify-between text-xs font-mono mt-1 text-gray-600">
            <span>DATA {formatBytes(ceph.pgmap.data_bytes)}</span>
            <span>FREE {formatBytes(ceph.pgmap.bytes_avail)}</span>
          </div>
        </div>
      )}
      {checks.map(([key])=>(
        <div key={key} className="flex items-center gap-2 text-xs font-mono p-2 rounded mb-1" style={{background:'#ffaa0010',border:'1px solid #ffaa0025'}}>
          <span style={{color:'#ffaa00'}}>⚠</span>
          <span style={{color:'#ffaa00'}}>{key}</span>
          {key==='POOL_NO_REDUNDANCY'&&<span className="text-gray-600">(intentional)</span>}
        </div>
      ))}
      <div className="space-y-2 mt-2">
        {Object.entries(byHost).sort(([a],[b])=>a.localeCompare(b)).map(([host,hostOsds])=>(
          <div key={host}>
            <div className="text-xs font-mono text-gray-600 mb-1">{host}</div>
            <div className="flex flex-wrap gap-1">
              {hostOsds.map(osd=>{
                const p2=Math.round(osd.percent_used), c2=osd.status!=='up'?'#ff4444':p2>85?'#ff4444':p2>70?'#ffaa00':'#22c55e'
                return (
                  <div key={osd.id} title={`${osd.name}|${osd.device_class}|${p2}%|${osd.apply_latency_ms}ms`}
                    className="flex flex-col items-center gap-0.5 p-1.5 rounded cursor-default"
                    style={{background:`${c2}10`,border:`1px solid ${c2}30`,minWidth:48}}>
                    <span className="text-xs font-mono" style={{color:c2}}>{osd.name}</span>
                    <span className="text-xs font-mono text-gray-600">{p2}%</span>
                    <span className="font-mono text-gray-700" style={{fontSize:9}}>{osd.device_class}</span>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// HA compact
function HAPanel({ ha }: { ha:HAEntry[] }) {
  const quorum=ha.find(h=>h.type==='quorum'), master=ha.find(h=>h.type==='master')
  const fencing=ha.find(h=>h.type==='fencing'), lrms=ha.filter(h=>h.type==='lrm')
  const services=ha.filter(h=>h.type==='service')
  const masterNode=master?.status.split(' ')[0]??'—', fencingArmed=fencing?.status.includes('armed')??false
  const allStarted=services.every(s=>s.crm_state==='started')
  return (
    <div className="rounded-lg border p-5" style={{background:'linear-gradient(135deg,#0d1220,#080c14)',borderColor:'#00e5ff20'}}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{background:'#22c55e',boxShadow:'0 0 6px #22c55e'}}/>
          <span className="font-display font-semibold tracking-wide uppercase text-sm" style={{color:'#00e5ff'}}>HA</span>
        </div>
        <span className="text-xs font-mono" style={{color:allStarted?'#22c55e':'#ffaa00'}}>
          {services.filter(s=>s.crm_state==='started').length}/{services.length} services
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2 mb-3">
        {[{label:'QUORUM',value:quorum?.quorate?'OK':'FAIL',ok:!!quorum?.quorate},{label:'MASTER',value:masterNode,ok:true},{label:'FENCING',value:fencingArmed?'ARMED':'OFF',ok:fencingArmed}].map(({label,value,ok:isOk})=>(
          <div key={label} className="flex flex-col items-center gap-1 p-2 rounded" style={{background:'#060a10',border:'1px solid #111827'}}>
            <span className="font-mono text-gray-500" style={{fontSize:9}}>{label}</span>
            <span className="text-xs font-mono font-semibold" style={{color:isOk?'#22c55e':'#ff4444'}}>{value}</span>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-1 mb-2">
        {lrms.map(lrm=>{
          const active=lrm.status.includes('active')
          return (
            <div key={lrm.id} className="flex items-center gap-1 p-1.5 rounded" style={{background:active?'#22c55e10':'#1f2937',border:`1px solid ${active?'#22c55e30':'#1f2937'}`}}>
              <div className="w-1.5 h-1.5 rounded-full" style={{background:active?'#22c55e':'#374151'}}/>
              <span className="font-mono" style={{color:active?'#86efac':'#4b5563',fontSize:10}}>{lrm.node}</span>
            </div>
          )
        })}
      </div>
      <div className="flex flex-wrap gap-1">
        {services.map(svc=>{
          const ok=svc.crm_state==='started'
          return <span key={svc.id} className="font-mono px-1.5 py-0.5 rounded" style={{fontSize:9,background:ok?'#22c55e10':'#ff444410',color:ok?'#86efac':'#fca5a5',border:`1px solid ${ok?'#22c55e30':'#ff444430'}`}}>{svc.sid}</span>
        })}
      </div>
    </div>
  )
}

// Main dashboard
export default function DashboardView() {
  const [fast, setFast]       = useState<FastData | null>(null)
  const [slow, setSlow]       = useState<SlowData | null>(null)
  const [lastSync, setLastSync] = useState<Date | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  // Initial HTTP fetch for instant load
  const fetchInitial = useCallback(async () => {
    try {
      const [summaryRes, grafanaRes, prometheusRes] = await Promise.all([
        fetch('/api/proxmox/summary'),
        fetch('/api/services/grafana'),
        fetch('/api/services/prometheus'),
      ])
      const summary   = await summaryRes.json()
      const grafana   = await grafanaRes.json().catch(()=>({success:false}))
      const prometheus = await prometheusRes.json().catch(()=>({success:false}))

      if (summary.success) {
        const d = summary.data
        setFast({ nodes: d.nodes, vms: d.vms, gpu: d.gpu, cluster: d.cluster })
        setSlow({
          ceph: d.ceph, osds: d.osds, ha: d.ha,
          services: {
            npm:        d.services.npm,
            grafana:    grafana.data,
            prometheus: prometheus.data,
          }
        })
        setLastSync(new Date())
      }
    } catch(e) { console.error(e) }
  }, [])

  // WebSocket for live updates
  useEffect(() => {
    fetchInitial()

    const wsUrl = `ws://${window.location.hostname}:3002/ws`
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        if (msg.type === 'fast') {
          setFast(msg.payload)
          setLastSync(new Date())
        }
        if (msg.type === 'slow') {
          setSlow(prev => ({
            ...msg.payload,
            services: {
              ...msg.payload.services,
              grafana:    prev?.services?.grafana,
              prometheus: prev?.services?.prometheus,
            }
          }))
        }
      } catch { /* ignore */ }
    }

    ws.onerror = () => { /* fallback to HTTP */ }
    ws.onclose = () => {
      // Reconnect after 3s
      setTimeout(fetchInitial, 3000)
    }

    return () => { ws.close() }
  }, [fetchInitial])

  if (!fast) return (
    <div className="min-h-full flex items-center justify-center" style={{background:'#080c14'}}>
      <div className="text-xs font-mono text-gray-500 animate-pulse">connecting to titancluster...</div>
    </div>
  )

  const sorted = [...fast.nodes].sort((a,b)=>gpuNodes.includes(a.node)?-1:gpuNodes.includes(b.node)?1:a.node.localeCompare(b.node))

  return (
    <div className="min-h-full" style={{background:'#080c14'}}>
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b" style={{borderColor:'#111827',background:'#080c14'}}>
        <div className="flex items-center gap-3">
          <h1 className="font-display text-2xl font-light tracking-widest">
            HYPER<span className="font-bold" style={{color:'#00e5ff'}}>PROX</span>
          </h1>
          <span className="text-xs font-mono text-gray-700">v0.1.0</span>
        </div>
        <div className="flex items-center gap-3">
          {[
            {label:'NODES',  value:`${fast.nodes.filter(n=>n.status==='online').length}/${fast.nodes.length}`, color:'#00e5ff'},
            {label:'RUNNING',value:String(fast.vms.filter(v=>v.status==='running').length),                    color:'#22c55e'},
            {label:'VMs+CTs',value:String(fast.vms.length),                                                    color:'#374151'},
          ].map(({label,value,color})=>(
            <div key={label} className="flex items-center gap-1.5 px-2 py-1 rounded text-xs font-mono" style={{background:`${color}10`,border:`1px solid ${color}30`}}>
              <span style={{color}}>{value}</span>
              <span className="text-gray-600">{label}</span>
            </div>
          ))}
          {lastSync&&<span className="text-xs font-mono text-gray-700 hidden md:block">{lastSync.toLocaleTimeString()}</span>}
          <div className="w-2 h-2 rounded-full animate-pulse" style={{background:'#00e5ff',boxShadow:'0 0 6px #00e5ff'}}/>
        </div>
      </header>

      <main className="p-6 max-w-7xl mx-auto space-y-6">
        {/* Row 1 */}
        <div className="grid gap-4" style={{gridTemplateColumns:"1fr 1fr 1fr 1.1fr"}}>
          <ClusterPanel cluster={fast.cluster} nodes={fast.nodes} vms={fast.vms} ceph={slow?.ceph??null}/>
          <GPUPanel gpu={fast.gpu}/>
          <NetworkPanel network={fast.network??null}/>
          {slow && <ServicesPanel services={slow.services}/>}
        </div>

        {/* Row 2 — nodes */}
        <section>
          <h2 className="text-xs font-mono uppercase tracking-widest text-gray-600 mb-3">Cluster Nodes</h2>
          <div className="grid gap-4" style={{gridTemplateColumns:'repeat(auto-fill,minmax(220px,1fr))'}}>
            {sorted.map(node=><NodeCard key={node.node} node={node} vms={fast.vms}/>)}
          </div>
        </section>

        {/* Row 3 — CEPH + HA */}
        {slow && (
          <div className="grid gap-4 lg:grid-cols-2">
            <CephPanel ceph={slow.ceph} osds={slow.osds}/>
            <HAPanel   ha={slow.ha}/>
          </div>
        )}
      </main>
    </div>
  )
}

function ServicesPanel({ services }: { services: SlowData['services'] }) {
  const rows = [
    { key:'npm', name:'Nginx Proxy Manager', accent:'#00e5ff', info: services.npm,
      details: services.npm?.connected ? [
        {label:'Hosts',    value:String(services.npm.total??0),   color:'#e5e7eb'},
        {label:'Active',   value:String(services.npm.enabled??0), color:'#22c55e'},
        {label:'Inactive', value:String(services.npm.disabled??0),color:(services.npm.disabled??0)>0?'#ffaa00':'#374151'},
        {label:'SSL',      value:String(services.npm.ssl??0),     color:'#22c55e'},
        {label:'Expiring', value:String(services.npm.expiring??0),color:(services.npm.expiring??0)>0?'#ffaa00':'#374151'},
      ] : []
    },
    { key:'grafana',    name:'Grafana',    accent:'#f59e0b', info: services.grafana,    details:[] },
    { key:'prometheus', name:'Prometheus', accent:'#e11d48', info: services.prometheus, details:[] },
  ]
  return (
    <div className="rounded-lg border p-5" style={{background:'linear-gradient(135deg,#0d1220,#080c14)',borderColor:'#00e5ff20'}}>
      <div className="flex items-center gap-2 mb-4">
        <div className="w-2 h-2 rounded-full" style={{background:'#00e5ff',boxShadow:'0 0 6px #00e5ff'}}/>
        <span className="font-display font-semibold tracking-wide uppercase text-sm" style={{color:'#00e5ff'}}>Connected Services</span>
      </div>
      <div className="space-y-2">
        {rows.map(({key,name,accent,info,details})=>(
          <div key={key} className="flex items-center gap-3 p-3 rounded" style={{background:'#060a10',border:`1px solid ${info?.connected?accent+'20':'#111827'}`}}>
            <div className="w-2 h-2 rounded-full flex-shrink-0" style={{background:info?.connected?accent:'#374151',boxShadow:info?.connected?`0 0 5px ${accent}`:'none'}}/>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-mono" style={{color:info?.connected?'#e5e7eb':'#4b5563'}}>{name}</div>
              {info?.connected&&(info as any).url&&<div className="text-xs font-mono text-gray-600 truncate">{(info as any).url}</div>}
              {!info?.connected&&<div className="text-xs font-mono text-gray-700">checking...</div>}
            </div>
            {info?.connected&&details.length>0&&(
              <div className="grid grid-cols-3 gap-1 flex-shrink-0">
                {details.map(d=>(
                  <div key={d.label} className="text-center">
                    <div className="text-xs font-mono font-bold" style={{color:d.color}}>{d.value}</div>
                    <div className="font-mono text-gray-600" style={{fontSize:9}}>{d.label}</div>
                  </div>
                ))}
              </div>
            )}
            {!info?.connected&&<span className="text-xs font-mono px-2 py-0.5 rounded" style={{background:'#1f2937',color:'#374151',border:'1px solid #1f2937'}}>disconnected</span>}
          </div>
        ))}
      </div>
    </div>
  )
}
