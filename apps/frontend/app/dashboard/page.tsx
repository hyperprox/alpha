'use client'



import { useEffect, useState, useCallback, useRef } from 'react'
import Link from 'next/link'
import { formatBytes, formatUptime, pct } from '@/lib/utils'
import { wsBase } from '@/lib/ws'
import { PluginCards } from '@/components/plugins/PluginCards'
import { Speedometer, Sparkline, StreamChart, Meter, useHistory, zoneColor, ACCENT, GOOD, WARN, CRIT } from '@/components/dashboard/Viz'
import { alpha } from '@/lib/theme'

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
interface BwLink {
  id: string; label: string; kind: 'wan' | 'lan'
  downBps: number; upBps: number
  downCapacityBps?: number; upCapacityBps?: number
  source: string
}
interface NodePower {
  node: string; cpu: number | null; gpu: number | null
  total: number | null; source: string
}
interface ClusterPower {
  total: number; nodes: NodePower[]; silent: string[]
  reporting: number; of: number; covers: string
}
interface BandwidthData { links: BwLink[]; unavailable: Array<{ plugin: string; reason: string }>; at: number }
interface CephIOStats { read_bps: number; write_bps: number; read_ops: number; write_ops: number }
interface NetworkData { nodes: NodeNetStats[]; ceph_io: CephIOStats|null; total_in: number; total_out: number }
interface NodeGPUStatus {
  node: string
  reachable: boolean
  gpus: { type: string; vendorName: string; deviceName: string; dedicated: boolean }[]
  port: number
  install: { title: string; steps: string[] } | null
}
interface FastData { nodes: PVENode[]; vms: PVEVM[]; gpu: GPUInfoFull|null; cluster: ClusterTotals; network?: NetworkData; gpuStatus?: NodeGPUStatus[]; storage?: any[] }
interface SlowData { ceph: CephStatus|null; osds: CephOSD[]; ha: HAEntry[]; services: { npm: ServiceInfo; grafana?: ServiceInfo; prometheus?: ServiceInfo } }

// Panel chrome — every card wears the same frame, so the eye can stop parsing
// borders and start reading numbers.
function Panel({ title, accent = ACCENT, right, children, className = '' }: {
  title: string; accent?: string; right?: React.ReactNode; children: React.ReactNode; className?: string
}) {
  return (
    <div className={`rounded-xl border p-5 ${className}`}
      style={{ background:'linear-gradient(150deg,var(--surface),var(--ground) 60%)', borderColor:`${alpha(accent, 15)}` }}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background:accent, boxShadow:`0 0 8px ${accent}` }}/>
          <span className="font-display font-semibold tracking-widest uppercase text-sm truncate" style={{ color:accent }}>{title}</span>
        </div>
        {right}
      </div>
      {children}
    </div>
  )
}

// Cluster summary
function ClusterPanel({ cluster, nodes, vms, ceph, storage, power, stamp }: { cluster:ClusterTotals; nodes:PVENode[]; vms:PVEVM[]; ceph:CephStatus|null; storage?:any[]; power?:ClusterPower|null; stamp:number|null }) {
  const running = vms.filter(v=>v.status==='running').length
  const online  = nodes.filter(n=>n.status==='online').length
  const cephPct = ceph?.pgmap ? pct(ceph.pgmap.bytes_used, ceph.pgmap.bytes_total) : 0
  // Deduplicate storage — sum unique storages by name (avoid double counting shared)
  const storageMap = new Map<string, {used:number;total:number}>()
  for (const s of storage ?? []) {
    if (!storageMap.has(s.storage)) storageMap.set(s.storage, { used: s.used ?? 0, total: s.total ?? 0 })
  }
  const storTotalUsed  = [...storageMap.values()].reduce((a, s) => a + s.used, 0)
  const storTotalBytes = [...storageMap.values()].reduce((a, s) => a + s.total, 0)
  const storPct        = storTotalBytes > 0 ? Math.round((storTotalUsed / storTotalBytes) * 100) : 0

  const cpuHist = useHistory(cluster.cpu_pct, stamp)
  const memHist = useHistory(cluster.mem_pct, stamp)

  return (
    <Panel title="Cluster Overview"
      right={<span className="text-xs font-mono text-gray-600">{online}/{nodes.length} nodes online</span>}>

      <div className="flex flex-wrap justify-around items-start gap-y-3 mb-4">
        <Speedometer value={cluster.cpu_pct} label="CPU" size={118}
          caption={`${(cluster.cpu_used ?? 0).toFixed(1)} of ${cluster.cpu_total} cores`}/>
        <Speedometer value={cluster.mem_pct} label="Memory" size={118}
          caption={`${formatBytes(cluster.mem_used)} of ${formatBytes(cluster.mem_total)}`}/>
        <Speedometer value={storTotalBytes > 0 ? storPct : cluster.disk_pct}
          label={storTotalBytes > 0 ? 'Storage' : 'Disk'} size={118}
          color="var(--warn)"
          caption={storTotalBytes > 0
            ? `${formatBytes(storTotalUsed)} of ${formatBytes(storTotalBytes)}`
            : `${formatBytes(cluster.disk_used)} of ${formatBytes(cluster.disk_total)}`}/>
      </div>

      {/* Where those two dials have just been */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        {[{ h: cpuHist, l: 'CPU', c: zoneColor(cluster.cpu_pct) },
          { h: memHist, l: 'MEM', c: zoneColor(cluster.mem_pct) }].map(({ h, l, c }) => (
          <div key={l} className="rounded-lg p-2" style={{ background:'var(--ground-inset)', border:'1px solid var(--border-dim)' }}>
            <div className="flex items-center justify-between mb-0.5">
              <span className="font-mono text-gray-600 uppercase tracking-wider" style={{ fontSize:9 }}>{l} trend</span>
              <span className="font-mono" style={{ fontSize:9, color:'var(--text-dim)' }}>{h.length}m</span>
            </div>
            <Sparkline data={h} color={c} width={150} height={28} baseline="zero"/>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-4 gap-2 mb-4">
        {[
          {label:'RUNNING', value:String(running),                             color:GOOD},
          {label:'STOPPED', value:String(vms.length-running),                  color:'var(--text-dim)'},
          {label:'HA',      value:String(vms.filter(v=>v.hastate).length),     color:'var(--violet)'},
          {label: power && power.silent.length ? `POWER ${power.reporting}/${power.of}` : 'POWER',
           value: power && power.total > 0 ? `${power.total}W` : '—',
           color: !power || power.total <= 0 ? 'var(--text-dimmer)' : power.silent.length ? WARN : GOOD,
           title: power
             ? [
                 ...power.nodes.map(n => n.total === null
                   ? `${n.node}: not instrumented`
                   : `${n.node}: ${n.total.toFixed(1)} W` +
                     (n.gpu ? ` (cpu ${n.cpu?.toFixed(1)} + gpu ${n.gpu.toFixed(1)})` : '') +
                     ` · ${n.source}`),
                 '',
                 power.covers,
               ].join('\n')
             : 'Waiting for Prometheus.'},
        ].map(({label,value,color,title}: any)=>(
          <div key={label} title={title} className="text-center py-2 rounded-lg" style={{background:'var(--ground-inset)',border:`1px solid ${alpha(color, 15)}`}}>
            <div className="font-display text-lg font-bold" style={{color, fontVariantNumeric:'tabular-nums'}}>{value}</div>
            <div className="font-mono text-gray-600 mt-0.5" style={{fontSize:9}}>{label}</div>
          </div>
        ))}
      </div>

      {ceph?.pgmap && (
        <Meter label="Ceph" used={ceph.pgmap.bytes_used} total={ceph.pgmap.bytes_total} p={cephPct} fmt={formatBytes} color="var(--warn)"/>
      )}

      <Link href="/infrastructure" className="flex items-center justify-center gap-2 mt-4 py-2 rounded-lg text-xs font-mono transition-all hover:brightness-150"
        style={{background:'color-mix(in srgb, var(--accent) 3%, transparent)',color:'color-mix(in srgb, var(--accent) 44%, transparent)',border:'1px solid color-mix(in srgb, var(--accent) 9%, transparent)'}}>
        View Infrastructure →
      </Link>
    </Panel>
  )
}

// GPU panel — dynamic, supports NVIDIA/AMD/Intel iGPU/Arc
function GPUPanel({ gpu, gpuStatus }: { gpu: GPUInfoFull | null; gpuStatus?: NodeGPUStatus[] }) {
  const allGPUs = (gpuStatus ?? []).filter(n => n.gpus.length > 0)
  const anyReachable = allGPUs.some(n => n.reachable)
  const gpuTypeColors: Record<string, string> = { 'nvidia': 'var(--good)', 'amd': 'var(--crit)', 'intel-igpu': 'var(--accent-2)', 'intel-arc': 'var(--accent)' }
  const gpuTypeLabels: Record<string, string> = { 'nvidia': 'NVIDIA', 'amd': 'AMD', 'intel-igpu': 'Intel iGPU', 'intel-arc': 'Intel Arc' }

  // No GPUs detected at all
  if (allGPUs.length === 0) return (
    <div className="rounded-lg border p-5 flex items-center justify-center" style={{ background:'var(--surface)', borderColor:'var(--text-faint)', minHeight:160 }}>
      <span className="text-xs font-mono text-gray-600">No GPU detected</span>
    </div>
  )

  // NVIDIA with full telemetry — show detailed panel
  if (gpu) {
    const accent = 'var(--violet)'
    const vramC  = gpu.vram_pct  > 90 ? 'var(--crit-2)' : gpu.vram_pct  > 75 ? 'var(--warn-2)' : accent
    const powerC = gpu.power_pct > 80 ? 'var(--crit-2)' : gpu.power_pct > 60 ? 'var(--warn-2)' : 'var(--good)'
    const tempC  = gpu.temp > 80 ? 'var(--crit-2)' : gpu.temp > 65 ? 'var(--warn-2)' : 'var(--good)'
    const consumers = gpu.consumers ?? []
    const unaccounted = gpu.vram_used - consumers.reduce((s, c) => s + c.vram_mb, 0)
    return (
      <div className="rounded-lg border p-5" style={{ background:'linear-gradient(135deg,var(--surface),var(--ground))', borderColor:`${alpha(accent, 19)}` }}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full" style={{ background:accent, boxShadow:`0 0 6px ${accent}` }}/>
            <span className="font-display font-semibold tracking-wide uppercase text-sm" style={{ color:accent }}>GPU</span>
          </div>
          <span className="text-xs font-mono text-gray-500 truncate ml-2" style={{ maxWidth:140 }}>{gpu.name.replace('NVIDIA ','')}</span>
        </div>
        <div className="mb-3">
          <div className="flex justify-between text-xs font-mono mb-1">
            <span className="text-gray-500">VRAM</span>
            <span style={{ color:vramC }}>{gpu.vram_used} / {gpu.vram_total} MB</span>
          </div>
          <div className="h-3 rounded-full overflow-hidden flex" style={{ background:'var(--text-faint)' }}>
            {consumers.map((c, i) => {
              const pct = (c.vram_mb / gpu.vram_total) * 100
              const colors = ['var(--violet)','var(--accent)','var(--good)','var(--warn)','var(--crit-soft)']
              return <div key={c.pid} title={`${c.ct_name ?? c.process}: ${c.vram_mb}MB`} className="h-full" style={{ width:`${pct}%`, background:colors[i % colors.length] }}/>
            })}
            {unaccounted > 0 && <div className="h-full" style={{ width:`${(unaccounted/gpu.vram_total)*100}%`, background:'var(--text-dimmer)' }}/>}
          </div>
        </div>
        {consumers.length > 0 && (
          <div className="space-y-1 mb-4">
            {consumers.map((c, i) => {
              const colors = ['var(--violet)','var(--accent)','var(--good)','var(--warn)','var(--crit-soft)']
              return (
                <div key={c.pid} className="flex items-center gap-2 text-xs font-mono">
                  <div className="w-2 h-2 rounded-sm" style={{ background:colors[i % colors.length] }}/>
                  <span style={{ color:'var(--text-bright)' }}>{c.ct_name ?? c.process}</span>
                  {c.ct_id && <span className="text-gray-600">CT {c.ct_id}</span>}
                  <span className="ml-auto" style={{ color:colors[i % colors.length] }}>{c.vram_mb} MB ({c.vram_pct}%)</span>
                </div>
              )
            })}
          </div>
        )}
        <div className="flex flex-wrap justify-around items-start gap-y-3">
          <Speedometer value={gpu.gpu_util}   label="Load"  size={92} color={accent}/>
          <Speedometer value={gpu.vram_pct}   label="VRAM"  size={92} color={vramC}
            caption={`${gpu.vram_used} MB`}/>
          <Speedometer value={gpu.temp}       label="Temp"  size={92} unit="°" color={tempC} max={100}/>
          <Speedometer value={gpu.power_draw} label="Power" size={92} unit="W" color={powerC}
            max={gpu.power_limit || 250} caption={`limit ${gpu.power_limit}W`}/>
        </div>
      </div>
    )
  }

  // Non-NVIDIA with reachable exporter — show active state
  if (anyReachable) {
    const color = 'var(--good)'
    return (
      <div className="rounded-lg border p-4" style={{ background:'linear-gradient(135deg,var(--surface),var(--ground))', borderColor:`${alpha(color, 19)}` }}>
        <div className="flex items-center gap-2 mb-3">
          <div className="w-2 h-2 rounded-full" style={{ background:color, boxShadow:`0 0 6px ${color}` }}/>
          <span className="font-display font-semibold tracking-wide uppercase text-sm" style={{ color }}>GPU METRICS</span>
          <span className="text-xs font-mono px-1.5 py-0.5 rounded" style={{ background:`${alpha(color, 8)}`, color, border:`1px solid ${alpha(color, 19)}` }}>ACTIVE</span>
        </div>
        <div className="space-y-2">
          {allGPUs.filter(n=>n.reachable).map(n => {
            const gpu0 = n.gpus[0]
            const gpuColor = gpuTypeColors[gpu0.type] ?? 'var(--violet)'
            return (
              <div key={n.node} className="flex items-center gap-2 p-2 rounded" style={{ background:'var(--ground-deep)', border:`1px solid ${alpha(gpuColor, 13)}` }}>
                <span className="text-xs font-mono font-bold" style={{ color:gpuColor }}>{n.node}</span>
                <span className="text-xs font-mono text-gray-500 flex-1">{gpu0.deviceName}</span>
                <span className="text-xs font-mono" style={{ color:gpuColor }}>✓ active</span>
              </div>
            )
          })}
          {allGPUs.filter(n=>!n.reachable).map(n => (
            <div key={n.node} className="flex items-center gap-2 p-2 rounded" style={{ background:'var(--ground-deep)', border:'1px solid color-mix(in srgb, var(--warn-2) 13%, transparent)' }}>
              <span className="text-xs font-mono font-bold" style={{ color:'var(--warn-2)' }}>{n.node}</span>
              <span className="text-xs font-mono text-gray-500 flex-1">{n.gpus[0]?.deviceName}</span>
              <span className="text-xs font-mono" style={{ color:'var(--warn-2)' }}>⚠ offline</span>
            </div>
          ))}
        </div>
        <div className="text-xs font-mono text-gray-600 mt-3">View detailed metrics in Monitoring → Grafana</div>
      </div>
    )
  }

  // No exporter reachable — show install instructions
  const uniqueSteps = allGPUs[0]?.install?.steps ?? []
  const allSameSteps = allGPUs.every(n => JSON.stringify(n.install?.steps) === JSON.stringify(uniqueSteps))
  return (
    <div className="rounded-lg border p-4" style={{ background:'linear-gradient(135deg,var(--surface),var(--ground))', borderColor:'color-mix(in srgb, var(--warn-2) 19%, transparent)' }}>
      <div className="flex items-center gap-2 mb-3">
        <div className="w-2 h-2 rounded-full" style={{ background:'var(--warn-2)', boxShadow:'0 0 6px var(--warn-2)' }}/>
        <span className="font-display font-semibold tracking-wide uppercase text-sm" style={{ color:'var(--warn-2)' }}>GPU METRICS</span>
        {allGPUs.every(n => !n.reachable) && <span className="text-xs font-mono px-1.5 py-0.5 rounded" style={{ background:'color-mix(in srgb, var(--warn-2) 8%, transparent)', color:'var(--warn-2)', border:'1px solid color-mix(in srgb, var(--warn-2) 19%, transparent)' }}>EXPORTER NOT INSTALLED</span>}
        {allGPUs.some(n => n.reachable) && !allGPUs.every(n => n.reachable) && <span className="text-xs font-mono px-1.5 py-0.5 rounded" style={{ background:'color-mix(in srgb, var(--warn-2) 8%, transparent)', color:'var(--warn-2)', border:'1px solid color-mix(in srgb, var(--warn-2) 19%, transparent)' }}>PARTIAL</span>}
      </div>
      <div className="flex gap-2 flex-wrap mb-3">
        {allGPUs.map(n => {
          const gpu0 = n.gpus[0]
          const color = gpuTypeColors[gpu0.type] ?? 'var(--violet)'
          return <span key={n.node} className="text-xs font-mono px-2 py-1 rounded" style={{ background:`${alpha(color, 8)}`, color, border:`1px solid ${alpha(color, 19)}` }}>{n.node} — {gpuTypeLabels[gpu0.type] ?? gpu0.type}</span>
        })}
      </div>
      {allSameSteps ? (
        <div className="space-y-1.5">
          <div className="text-xs font-mono text-gray-500 mb-1">Run on each Proxmox node:</div>
          {uniqueSteps.map((step, i) => {
            const isCmd = ['docker','apt','curl','systemctl'].some(p => step.startsWith(p))
            return (
              <div key={i} className="flex items-center gap-2">
                <span className="text-xs font-mono flex-1 truncate" style={{ color: isCmd ? 'var(--accent)' : 'var(--text-muted)' }}>{step}</span>
                {isCmd && <button onClick={() => { try { navigator.clipboard.writeText(step) } catch { const el = document.createElement('textarea'); el.value=step; document.body.appendChild(el); el.select(); document.execCommand('copy'); document.body.removeChild(el) } }} className="text-xs font-mono px-1.5 py-0.5 rounded flex-shrink-0" style={{ background:'color-mix(in srgb, var(--accent) 8%, transparent)', color:'var(--accent)', border:'1px solid color-mix(in srgb, var(--accent) 19%, transparent)' }}>copy</button>}
              </div>
            )
          })}
        </div>
      ) : (
        <div className="space-y-2">
          {allGPUs.map(n => n.install && (
            <div key={n.node} className="rounded p-2" style={{ background:'var(--ground-deep)', border:'1px solid var(--text-faint)' }}>
              <div className="text-xs font-mono text-gray-500 mb-1">{n.node}:</div>
              {n.install.steps.map((step, i) => {
                const isCmd = ['docker','apt','curl','systemctl'].some(p => step.startsWith(p))
                return (
                  <div key={i} className="flex items-center gap-2">
                    <span className="text-xs font-mono flex-1 truncate" style={{ color: isCmd ? 'var(--accent)' : 'var(--text-muted)' }}>{step}</span>
                    {isCmd && <button onClick={() => { try { navigator.clipboard.writeText(step) } catch { const el = document.createElement('textarea'); el.value=step; document.body.appendChild(el); el.select(); document.execCommand('copy'); document.body.removeChild(el) } }} className="text-xs font-mono px-1.5 py-0.5 rounded flex-shrink-0" style={{ background:'color-mix(in srgb, var(--accent) 8%, transparent)', color:'var(--accent)', border:'1px solid color-mix(in srgb, var(--accent) 19%, transparent)' }}>copy</button>}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}
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
    <div className="h-1 rounded-full overflow-hidden flex-1" style={{ background:'var(--text-faint)' }}>
      <div className="h-full rounded-full transition-all duration-500" style={{ width:`${pct}%`, background:color }}/>
    </div>
  )
}


function NetworkPanel({ network, stamp }: { network: NetworkData | null; stamp: number | null }) {
  // Hooks before the early return — a panel that sometimes has no data must
  // still call the same hooks in the same order every render.
  const inHist  = useHistory(network?.total_in  ?? 0, stamp, 60)
  const outHist = useHistory(network?.total_out ?? 0, stamp, 60)

  if (!network) return null

  const maxNodeSpeed = Math.max(
    ...network.nodes.flatMap(n => [n.netin, n.netout]), 1
  )

  const sortedNodes = [...network.nodes].sort((a, b) => a.node.localeCompare(b.node))

  return (
    <Panel title="Network"
      right={
        <div className="flex gap-3 text-xs font-mono" style={{ fontVariantNumeric:'tabular-nums' }}>
          <span style={{ color:GOOD }}>↓ {fmtSpeed(network.total_in)}</span>
          <span style={{ color:WARN }}>↑ {fmtSpeed(network.total_out)}</span>
        </div>
      }>

      {/* Cluster throughput over the last minute — in above the line, out below */}
      <div className="rounded-lg p-3 mb-4" style={{ background:'var(--ground-inset)', border:'1px solid var(--border-dim)' }}>
        <div className="flex items-center justify-between mb-1">
          <span className="font-mono text-gray-600 uppercase tracking-widest" style={{ fontSize:9 }}>Throughput</span>
          <div className="flex gap-3 font-mono" style={{ fontSize:9 }}>
            <span style={{ color:GOOD }}>■ in</span>
            <span style={{ color:WARN }}>■ out</span>
            <span className="text-gray-700">peak {fmtSpeed(Math.max(...inHist, ...outHist, 0))}</span>
          </div>
        </div>
        <StreamChart inData={inHist} outData={outHist} height={92} width={560}/>
      </div>

      {/* Per-node rows */}
      <div className="grid gap-x-6 gap-y-2 mb-4" style={{ gridTemplateColumns:'repeat(auto-fit,minmax(min(100%,240px),1fr))' }}>
        {sortedNodes.map(n => {
          const accent = 'var(--accent)'
          return (
            <div key={n.node}>
              <div className="flex items-center gap-2 mb-1">
                <span className="font-mono text-xs w-12 flex-shrink-0" style={{ color:accent }}>{n.node}</span>
                <div className="flex-1 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono w-16 text-right" style={{ color:'var(--good)', fontSize:10 }}>↓ {fmtSpeed(n.netin)}</span>
                    <SpeedBar value={n.netin} max={maxNodeSpeed} color="var(--good)"/>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono w-16 text-right" style={{ color:'var(--warn)', fontSize:10 }}>↑ {fmtSpeed(n.netout)}</span>
                    <SpeedBar value={n.netout} max={maxNodeSpeed} color="var(--warn)"/>
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* CEPH I/O */}
      {network.ceph_io && (
        <div className="border-t pt-3" style={{ borderColor:'var(--border-dim)' }}>
          <div className="text-xs font-mono text-gray-500 uppercase tracking-wider mb-2">CEPH I/O</div>
          <div className="grid gap-2" style={{ gridTemplateColumns:'repeat(auto-fit,minmax(min(100%,160px),1fr))' }}>
            <div className="p-2 rounded" style={{ background:'var(--ground-deep)', border:'1px solid var(--border-dim)' }}>
              <div className="text-xs font-mono text-gray-600 mb-0.5">READ</div>
              <div className="text-sm font-mono font-bold" style={{ color:'var(--good)' }}>{fmtSpeed(network.ceph_io.read_bps)}</div>
              <div className="text-xs font-mono text-gray-700">{network.ceph_io.read_ops} ops/s</div>
            </div>
            <div className="p-2 rounded" style={{ background:'var(--ground-deep)', border:'1px solid var(--border-dim)' }}>
              <div className="text-xs font-mono text-gray-600 mb-0.5">WRITE</div>
              <div className="text-sm font-mono font-bold" style={{ color:'var(--warn)' }}>{fmtSpeed(network.ceph_io.write_bps)}</div>
              <div className="text-xs font-mono text-gray-700">{network.ceph_io.write_ops} ops/s</div>
            </div>
          </div>
        </div>
      )}
    </Panel>
  )
}


// ---------------------------------------------------------------------------
//  Bandwidth — what the internet link and the LAN are actually doing
// ---------------------------------------------------------------------------

/** Bits, not bytes. Every device and every ISP quotes bits; converting at the
 *  edge is how a 500 Mbps plan starts reading as 62.5. */
function fmtBits(bps: number): string {
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(2)} Gbps`
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} Mbps`
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(0)} kbps`
  return `${Math.round(bps)} bps`
}

/** A denominator a person recognises, so an auto-scaled dial still reads as a dial. */
function niceCeil(mbps: number): number {
  const steps = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000]
  return steps.find(v => v >= mbps) ?? Math.ceil(mbps / 10000) * 10000
}

function LinkMeters({ link, stamp }: { link: BwLink; stamp: number | null }) {
  const down = useHistory(link.downBps, stamp, 60)
  const up   = useHistory(link.upBps,   stamp, 60)

  const meter = (bps: number, capacity: number | undefined, hist: number[], label: string, color: string) => {
    const mbps  = bps / 1e6
    const capM  = capacity ? capacity / 1e6 : null
    // With no stated capacity the dial scales to the largest thing it has seen,
    // and says so — an invented denominator would make a quiet link look busy.
    const max   = capM ?? niceCeil(Math.max(...hist, bps) / 1e6 || 10)
    return (
      <div className="flex flex-col items-center">
        <Speedometer value={mbps} max={max} label={label} unit="" size={104} color={color}
          caption={capM ? `of ${capM} Mbps` : `auto · peak ${niceCeil(Math.max(...hist, bps) / 1e6 || 10)}`}/>
        <div className="font-mono text-gray-500" style={{ fontSize: 10, marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>
          {fmtBits(bps)}
        </div>
      </div>
    )
  }

  const isWan = link.kind === 'wan'
  const accent = isWan ? 'var(--accent)' : 'var(--violet)'

  return (
    <div className="rounded-lg p-3" style={{ background:'var(--ground-inset)', border:`1px solid ${alpha(accent, 13)}` }}>
      <div className="flex items-baseline justify-between mb-2">
        <span className="font-display font-semibold uppercase tracking-widest" style={{ color:accent, fontSize:12 }}>
          {isWan ? 'Internet' : 'LAN'}
        </span>
        <span className="font-mono text-gray-600" style={{ fontSize:10 }}>{link.label}</span>
      </div>
      <div className="flex justify-around items-start mb-2">
        {meter(link.downBps, link.downCapacityBps, down, 'Down', GOOD)}
        {meter(link.upBps,   link.upCapacityBps,   up,   'Up',   WARN)}
      </div>
      <StreamChart inData={down} outData={up} height={64} width={420}/>
    </div>
  )
}

function BandwidthPanel({ data, stamp }: { data: BandwidthData | null; stamp: number | null }) {
  if (!data) return null

  const wan = data.links.filter(l => l.kind === 'wan')
  const lan = data.links.filter(l => l.kind === 'lan')
  const ordered = [...wan, ...lan]

  if (!ordered.length) {
    return (
      <Panel title="Bandwidth" accent="var(--text-dim)"
        right={<span className="font-mono text-gray-600" style={{ fontSize:10 }}>no link source</span>}>
        <div className="font-mono text-gray-600 text-center py-4" style={{ fontSize:12 }}>
          {data.unavailable.length
            ? <>Configure the <span style={{ color:ACCENT }}>{data.unavailable.map(u => u.plugin).join(', ')}</span> plug-in to read WAN and LAN throughput.</>
            : 'No plug-in on this install can report link throughput.'}
        </div>
      </Panel>
    )
  }

  return (
    <Panel title="Bandwidth"
      right={
        <div className="flex gap-3 font-mono" style={{ fontSize:11, fontVariantNumeric:'tabular-nums' }}>
          {ordered.map(l => (
            <span key={l.id} className="text-gray-600">
              {l.kind === 'wan' ? 'WAN' : 'LAN'}{' '}
              <span style={{ color:GOOD }}>↓{fmtBits(l.downBps)}</span>{' '}
              <span style={{ color:WARN }}>↑{fmtBits(l.upBps)}</span>
            </span>
          ))}
        </div>
      }>
      <div className={`grid gap-4 grid-cols-1 ${ordered.length > 1 ? 'lg:grid-cols-2' : ''}`}>
        {ordered.map(l => <LinkMeters key={`${l.source}-${l.id}`} link={l} stamp={stamp}/>)}
      </div>
    </Panel>
  )
}

// Node card
function NodeCard({ node, vms, gpuInfo, power, powerTotal }: { node:PVENode; vms:PVEVM[]; gpuInfo?: NodeGPUStatus; power?: NodePower; powerTotal?: number }) {
  const cpuPct=Math.round(node.cpu*100), memPct=pct(node.mem,node.maxmem), diskPct=pct(node.disk,node.maxdisk)
  const nodeVMs=vms.filter(v=>v.node===node.node), running=nodeVMs.filter(v=>v.status==='running').length
  const hasGpu = gpuInfo && gpuInfo.gpus.length > 0
  const gpuType = gpuInfo?.gpus[0]?.type ?? null
  const gpuAccentMap: Record<string, string> = { 'nvidia': 'var(--good)', 'amd': 'var(--crit)', 'intel-igpu': 'var(--accent-2)', 'intel-arc': 'var(--accent)' }
  const accent = gpuType ? (gpuAccentMap[gpuType] ?? 'var(--violet)') : 'var(--accent)'
  return (
    <div className="rounded-lg border p-4 flex flex-col gap-4" style={{background:'linear-gradient(135deg,var(--surface),var(--ground))',borderColor:`${alpha(accent, 19)}`}}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{background:accent,boxShadow:`0 0 6px ${accent}`}}/>
          <span className="font-display font-semibold tracking-wide uppercase text-sm" style={{color:accent}}>{node.node}</span>
          {hasGpu && (
            <span className="text-xs px-1.5 py-0.5 rounded font-mono" style={{background:`${alpha(accent, 13)}`,color:accent,border:`1px solid ${alpha(accent, 25)}`,fontSize:9}}
              title={gpuInfo?.reachable ? gpuInfo.gpus[0].deviceName : `${gpuInfo?.install?.title ?? 'GPU detected'} — metrics not available`}>
              {gpuType === 'nvidia' ? 'NVIDIA' : gpuType === 'amd' ? 'AMD' : gpuType === 'intel-arc' ? 'ARC' : 'iGPU'}
              {!gpuInfo?.reachable && ' ⚠'}
            </span>
          )}
        </div>
        <span className="text-xs font-mono text-gray-500">{formatUptime(node.uptime)}</span>
      </div>
      <div className="flex flex-wrap justify-around items-start gap-y-2">
        <Speedometer value={cpuPct}  label="CPU"  size={76} color={accent} caption={`${node.maxcpu} cores`}/>
        <Speedometer value={memPct}  label="MEM"  size={76} caption={formatBytes(node.maxmem)}/>
        <Speedometer value={diskPct} label="DISK" size={76} caption={formatBytes(node.maxdisk)}/>
      </div>
{/* Power. A node has no rated maximum worth gauging against, so the bar
          is its share of what the cluster is drawing — a denominator that is
          measured rather than invented. */}
      {power && (
        <div className="rounded-lg px-2.5 py-2" style={{ background:'var(--ground-inset)', border:'1px solid var(--border-dim)' }}>
          {power.total === null ? (
            <div title="No RAPL on this CPU, and no exporter reporting a package figure. Nothing here is measuring watts.">
              <div className="flex items-baseline justify-between">
                <span className="font-mono uppercase tracking-widest text-gray-600" style={{ fontSize:9 }}>Power</span>
                <span className="font-mono text-gray-700" style={{ fontSize:12 }}>no meter</span>
              </div>
              <div className="font-mono text-gray-700 mt-1" style={{ fontSize:9 }}>nothing on this node reports watts</div>
            </div>
          ) : (
            <>
              <div className="flex items-baseline justify-between mb-1.5">
                <span className="font-mono uppercase tracking-widest text-gray-600" style={{ fontSize:9 }}>Power</span>
                <span className="font-mono font-bold" style={{ fontSize:15, color:'var(--warn)', fontVariantNumeric:'tabular-nums' }}>
                  {power.total.toFixed(1)}<span style={{ fontSize:10, color:'color-mix(in srgb, var(--warn) 56%, transparent)' }}> W</span>
                </span>
              </div>
              {powerTotal ? (
                <div className="flex items-center gap-2 mb-1.5">
                  <div className="h-1 flex-1 rounded-full overflow-hidden" style={{ background:'var(--border-strong)' }}>
                    <div className="h-full rounded-full"
                      style={{ width:`${Math.min((power.total / powerTotal) * 100, 100)}%`,
                               background:'var(--warn)', boxShadow:'0 0 8px color-mix(in srgb, var(--warn) 38%, transparent)',
                               transition:'width .6s cubic-bezier(.22,1,.36,1)' }}/>
                  </div>
                  <span className="font-mono" style={{ fontSize:9, color:'var(--text-dim)', fontVariantNumeric:'tabular-nums' }}>
                    {Math.round((power.total / powerTotal) * 100)}% of cluster
                  </span>
                </div>
              ) : null}
              <div className="font-mono" style={{ fontSize:9, color:'var(--text-dim)' }}>
                {power.gpu
                  ? `cpu ${power.cpu?.toFixed(1)} · gpu ${power.gpu.toFixed(1)} W`
                  : `cpu package · ${power.source}`}
              </div>
            </>
          )}
        </div>
      )}

      <div className="flex gap-2 pt-1 border-t items-center" style={{borderColor:'var(--border-dim)'}}>
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
  const hc=hOk?'var(--good)':hWarn?'var(--warn-2)':'var(--crit-2)'
  const up=ceph.pgmap?pct(ceph.pgmap.bytes_used,ceph.pgmap.bytes_total):0
  const checks=Object.entries(ceph.health.checks)
  const byHost=osds.reduce((a,o)=>{if(!a[o.host])a[o.host]=[];a[o.host].push(o);return a},{} as Record<string,CephOSD[]>)
  return (
    <div className="rounded-lg border p-5" style={{background:'linear-gradient(135deg,var(--surface),var(--ground))',borderColor:`${alpha(hc, 19)}`}}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{background:hc,boxShadow:`0 0 6px ${hc}`}}/>
          <span className="font-display font-semibold tracking-wide uppercase text-sm" style={{color:'var(--accent)'}}>CEPH</span>
          <span className="text-xs font-mono px-1.5 py-0.5 rounded" style={{background:`${alpha(hc, 8)}`,color:hc,border:`1px solid ${alpha(hc, 19)}`}}>{ceph.health.status}</span>
        </div>
        <span className="text-xs font-mono" style={{color:'var(--good)'}}>{ceph.osdmap.num_up_osds}/{ceph.osdmap.num_osds} OSDs</span>
      </div>
      {ceph.pgmap&&(
        <div className="flex flex-wrap items-center gap-4 mb-4">
          <Speedometer value={up} label="Capacity" size={110} color="var(--warn)"/>
          <div className="flex-1 space-y-2">
            {[['USED', formatBytes(ceph.pgmap.bytes_used), 'var(--warn)'],
              ['DATA', formatBytes(ceph.pgmap.data_bytes), 'var(--accent)'],
              ['FREE', formatBytes(ceph.pgmap.bytes_avail), 'var(--good)'],
              ['RAW',  formatBytes(ceph.pgmap.bytes_total), 'var(--text-muted)']].map(([l,v,c])=>(
              <div key={l} className="flex items-baseline justify-between font-mono" style={{fontSize:11}}>
                <span className="text-gray-600 uppercase tracking-wider">{l}</span>
                <span style={{color:c, fontVariantNumeric:'tabular-nums'}}>{v}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {checks.map(([key])=>(
        <div key={key} className="flex items-center gap-2 text-xs font-mono p-2 rounded mb-1" style={{background:'color-mix(in srgb, var(--warn-2) 6%, transparent)',border:'1px solid color-mix(in srgb, var(--warn-2) 15%, transparent)'}}>
          <span style={{color:'var(--warn-2)'}}>⚠</span>
          <span style={{color:'var(--warn-2)'}}>{key}</span>
          {key==='POOL_NO_REDUNDANCY'&&<span className="text-gray-600">(intentional)</span>}
        </div>
      ))}
      <div className="space-y-2 mt-2">
        {Object.entries(byHost).sort(([a],[b])=>a.localeCompare(b)).map(([host,hostOsds])=>(
          <div key={host}>
            <div className="text-xs font-mono text-gray-600 mb-1">{host}</div>
            <div className="flex flex-wrap gap-1">
              {hostOsds.map(osd=>{
                const p2=Math.round(osd.percent_used), c2=osd.status!=='up'?'var(--crit-2)':p2>85?'var(--crit-2)':p2>70?'var(--warn-2)':'var(--good)'
                return (
                  <div key={osd.id} title={`${osd.name}|${osd.device_class}|${p2}%|${osd.apply_latency_ms}ms`}
                    className="flex flex-col items-center gap-0.5 p-1.5 rounded cursor-default"
                    style={{background:`${alpha(c2, 6)}`,border:`1px solid ${alpha(c2, 19)}`,minWidth:48}}>
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
    <div className="rounded-lg border p-5" style={{background:'linear-gradient(135deg,var(--surface),var(--ground))',borderColor:'color-mix(in srgb, var(--accent) 13%, transparent)'}}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{background:'var(--good)',boxShadow:'0 0 6px var(--good)'}}/>
          <span className="font-display font-semibold tracking-wide uppercase text-sm" style={{color:'var(--accent)'}}>HA</span>
        </div>
        <span className="text-xs font-mono" style={{color:allStarted?'var(--good)':'var(--warn-2)'}}>
          {services.filter(s=>s.crm_state==='started').length}/{services.length} services
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2 mb-3">
        {[{label:'QUORUM',value:quorum?.quorate?'OK':'FAIL',ok:!!quorum?.quorate},{label:'MASTER',value:masterNode,ok:true},{label:'FENCING',value:fencingArmed?'ARMED':'OFF',ok:fencingArmed}].map(({label,value,ok:isOk})=>(
          <div key={label} className="flex flex-col items-center gap-1 p-2 rounded" style={{background:'var(--ground-deep)',border:'1px solid var(--border-dim)'}}>
            <span className="font-mono text-gray-500" style={{fontSize:9}}>{label}</span>
            <span className="text-xs font-mono font-semibold" style={{color:isOk?'var(--good)':'var(--crit-2)'}}>{value}</span>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-1 mb-2">
        {lrms.map(lrm=>{
          const active=lrm.status.includes('active')
          return (
            <div key={lrm.id} className="flex items-center gap-1 p-1.5 rounded" style={{background:active?'color-mix(in srgb, var(--good) 6%, transparent)':'var(--text-faint)',border:`1px solid ${active?'color-mix(in srgb, var(--good) 19%, transparent)':'var(--text-faint)'}`}}>
              <div className="w-1.5 h-1.5 rounded-full" style={{background:active?'var(--good)':'var(--text-dimmer)'}}/>
              <span className="font-mono" style={{color:active?'var(--good-soft)':'var(--text-dim)',fontSize:10}}>{lrm.node}</span>
            </div>
          )
        })}
      </div>
      <div className="flex flex-wrap gap-1">
        {services.map(svc=>{
          const ok=svc.crm_state==='started'
          return <span key={svc.id} className="font-mono px-1.5 py-0.5 rounded" style={{fontSize:9,background:ok?'color-mix(in srgb, var(--good) 6%, transparent)':'color-mix(in srgb, var(--crit-2) 6%, transparent)',color:ok?'var(--good-soft)':'var(--crit-soft)',border:`1px solid ${ok?'color-mix(in srgb, var(--good) 19%, transparent)':'color-mix(in srgb, var(--crit-2) 19%, transparent)'}`}}>{svc.sid}</span>
        })}
      </div>
    </div>
  )
}

// Main dashboard
export default function DashboardView() {
  const [fast, setFast]       = useState<FastData | null>(null)
  const [clusterPower, setClusterPower] = useState<ClusterPower | null>(null)
  const [bandwidth, setBandwidth] = useState<BandwidthData | null>(null)
  const [slow, setSlow]       = useState<SlowData | null>(null)
  const [lastSync, setLastSync] = useState<Date | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  // Initial HTTP fetch for instant load
  const fetchInitial = useCallback(async () => {
    try {
      const [summaryRes, grafanaRes, prometheusRes, gpuStatusRes, networkRes] = await Promise.all([
        fetch('/api/proxmox/summary'),
        fetch('/api/services/grafana'),
        fetch('/api/services/prometheus'),
        fetch('/api/gpu/all/metrics-status'),
        fetch('/api/network/stats'),
      ])
      const summary   = await summaryRes.json()
      const grafana   = await grafanaRes.json().catch(()=>({success:false}))
      const prometheus = await prometheusRes.json().catch(()=>({success:false}))
      const gpuStatus = await gpuStatusRes.json().catch(()=>({success:false}))
      const networkData = await networkRes.json().catch(()=>({success:false}))
      // Power is its own endpoint now. Summing RAPL in a query string only ever
      // covered the nodes whose CPUs expose it — two of five here — and a bare
      // sum cannot tell a node drawing nothing from one measuring nothing.
      fetch('/api/prometheus/power')
        .then(r=>r.json())
        .then(d=>{ if(d.success) setClusterPower(d.data) })
        .catch(()=>{})

      if (summary.success) {
        const d = summary.data
        setFast({ nodes: d.nodes, vms: d.vms, gpu: d.gpu, cluster: d.cluster, network: networkData.success ? networkData.data : undefined, gpuStatus: gpuStatus.success ? gpuStatus.data : [], storage: d.storage ?? [] })
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

  // Bandwidth comes from the router, not from Proxmox, so it is on its own
  // clock — the WebSocket carries cluster state and knows nothing about it.
  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const res = await fetch('/api/network/bandwidth')
        const j   = await res.json()
        if (alive && j.success) setBandwidth(j.data)
      } catch { /* the panel keeps its last reading */ }
    }
    poll()
    const id = setInterval(poll, 5000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  // WebSocket for live updates
  useEffect(() => {
    fetchInitial()

    const ws = new WebSocket(wsBase())
    wsRef.current = ws

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        if (msg.type === 'fast') {
          setFast(prev => ({ ...msg.payload, gpuStatus: prev?.gpuStatus ?? [], storage: msg.payload.storage ?? prev?.storage ?? [] }))
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
    <div className="min-h-full flex items-center justify-center" style={{background:'var(--ground)'}}>
      <div className="text-xs font-mono text-gray-500 animate-pulse">connecting to titancluster...</div>
    </div>
  )

  const sorted = [...fast.nodes].sort((a,b)=>{const ag=fast.gpuStatus?.find(g=>g.node===a.node)?.gpus.length??0;const bg=fast.gpuStatus?.find(g=>g.node===b.node)?.gpus.length??0;return bg-ag||a.node.localeCompare(b.node)})

  return (
    <div className="min-h-full" style={{background:'var(--ground)'}}>
      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-y-2 px-3 sm:px-6 py-3 sm:py-4 border-b" style={{borderColor:'var(--border-dim)',background:'var(--ground)'}}>
        <div className="flex items-center gap-3">
          <h1 className="font-display text-2xl font-light tracking-widest">
            HYPER<span className="font-bold" style={{color:'var(--accent)'}}>PROX</span>
          </h1>
          <span className="text-xs font-mono text-gray-700">v0.1.0</span>
        </div>
        <div className="flex items-center gap-3">
          {[
            {label:'NODES',  value:`${fast.nodes.filter(n=>n.status==='online').length}/${fast.nodes.length}`, color:'var(--accent)'},
            {label:'RUNNING',value:String(fast.vms.filter(v=>v.status==='running').length),                    color:'var(--good)'},
            {label:'VMs+CTs',value:String(fast.vms.length),                                                    color:'var(--text-dimmer)'},
          ].map(({label,value,color})=>(
            <div key={label} className="flex items-center gap-1.5 px-2 py-1 rounded text-xs font-mono" style={{background:`${alpha(color, 6)}`,border:`1px solid ${alpha(color, 19)}`}}>
              <span style={{color}}>{value}</span>
              <span className="text-gray-600">{label}</span>
            </div>
          ))}
          {lastSync&&<span className="text-xs font-mono text-gray-700 hidden md:block" style={{fontVariantNumeric:'tabular-nums'}}>{lastSync.toLocaleTimeString()}</span>}
          <div className="w-2 h-2 rounded-full animate-pulse" style={{background:'var(--accent)',boxShadow:'0 0 6px var(--accent)'}}/>
        </div>
      </header>

      <main className="p-3 sm:p-6 max-w-7xl mx-auto space-y-4 sm:space-y-6">
        {/* Row 1 — the three panels that are mostly dials */}
        <div className="grid gap-4 grid-cols-1 xl:grid-cols-[1.25fr_1.25fr_1fr]">
          <ClusterPanel cluster={fast.cluster} nodes={fast.nodes} vms={fast.vms} ceph={slow?.ceph??null} storage={fast.storage} power={clusterPower} stamp={lastSync?.getTime() ?? null}/>
          <GPUPanel gpu={fast.gpu} gpuStatus={fast.gpuStatus}/>
          {slow && <ServicesPanel services={slow.services}/>}
        </div>

        {/* Row 2 — the link meters, then the cluster's own traffic */}
        <BandwidthPanel data={bandwidth} stamp={bandwidth?.at ?? null}/>

        {/* Row 3 — throughput, full width, because a time series needs time on it */}
        <NetworkPanel network={fast.network??null} stamp={lastSync?.getTime() ?? null}/>

        {/* Row 4 — nodes */}
        <section>
          <h2 className="text-xs font-mono uppercase tracking-widest text-gray-600 mb-3">Cluster Nodes</h2>
          <div className="grid gap-4" style={{gridTemplateColumns:'repeat(auto-fill,minmax(min(100%,250px),1fr))'}}>
            {sorted.map(node=><NodeCard key={node.node} node={node} vms={fast.vms} gpuInfo={fast.gpuStatus?.find(g=>g.node===node.node)} power={clusterPower?.nodes.find(p=>p.node===node.node)} powerTotal={clusterPower?.total}/>)}
          </div>
        </section>

        {/* Row 3 — plug-ins */}
        <PluginCards />

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
    { key:'npm', name:'Nginx Proxy Manager', accent:'var(--accent)', info: services.npm,
      details: services.npm?.connected ? [
        {label:'Hosts',    value:String(services.npm.total??0),   color:'var(--text-bright)'},
        {label:'Active',   value:String(services.npm.enabled??0), color:'var(--good)'},
        {label:'Inactive', value:String(services.npm.disabled??0),color:(services.npm.disabled??0)>0?'var(--warn-2)':'var(--text-dimmer)'},
        {label:'SSL',      value:String(services.npm.ssl??0),     color:'var(--good)'},
        {label:'Expiring', value:String(services.npm.expiring??0),color:(services.npm.expiring??0)>0?'var(--warn-2)':'var(--text-dimmer)'},
      ] : []
    },
    { key:'grafana',    name:'Grafana',    accent:'var(--warn)', info: services.grafana,    details:[] },
    { key:'prometheus', name:'Prometheus', accent:'var(--crit)', info: services.prometheus, details:[] },
  ]
  return (
    <div className="rounded-lg border p-5" style={{background:'linear-gradient(135deg,var(--surface),var(--ground))',borderColor:'color-mix(in srgb, var(--accent) 13%, transparent)'}}>
      <div className="flex items-center gap-2 mb-4">
        <div className="w-2 h-2 rounded-full" style={{background:'var(--accent)',boxShadow:'0 0 6px var(--accent)'}}/>
        <span className="font-display font-semibold tracking-wide uppercase text-sm" style={{color:'var(--accent)'}}>Connected Services</span>
      </div>
      <div className="space-y-2">
        {rows.map(({key,name,accent,info,details})=>(
          <div key={key} className="flex items-center gap-3 p-3 rounded" style={{background:'var(--ground-deep)',border:`1px solid ${info?.connected?accent+'20':'var(--border-dim)'}`}}>
            <div className="w-2 h-2 rounded-full flex-shrink-0" style={{background:info?.connected?accent:'var(--text-dimmer)',boxShadow:info?.connected?`0 0 5px ${accent}`:'none'}}/>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-mono" style={{color:info?.connected?'var(--text-bright)':'var(--text-dim)'}}>{name}</div>
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
            {!info?.connected&&<span className="text-xs font-mono px-2 py-0.5 rounded" style={{background:'var(--text-faint)',color:'var(--text-dimmer)',border:'1px solid var(--text-faint)'}}>disconnected</span>}
          </div>
        ))}
      </div>
    </div>
  )
}
