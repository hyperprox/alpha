'use client'



import { useEffect, useState, useCallback, useRef } from 'react'
import { CommandCenterIfRemotes } from '@/components/clusters/CommandCenter'
import Link from 'next/link'
import { pct } from '@/lib/utils'
import { wsBase } from '@/lib/ws'
import { PluginCards } from '@/components/plugins/PluginCards'
import { DashboardSitesCard } from '@/components/sites/metrics/DashboardSitesCard'
import { Speedometer, Sparkline, StreamChart, Meter, useHistory, zoneColor, ACCENT, GOOD, WARN, CRIT } from '@/components/dashboard/Viz'
import { alpha } from '@/lib/theme'
import { CheckIcon, WarnIcon } from '@/components/dashboard/Icons'
import {
  HudHeader, Panel as KitPanel, Cols, GlowBars, Feed, styles as vs, type StatChip, type FeedTone,
} from '@/components/visual/kit'
import {
  formatBinary as formatBytes, formatBinaryPair, summarizeStorage, summarizeHA, powerStatus, serviceState, cephHealthWord,
  type ServiceState,
} from '@/components/dashboard/summaries'
import { buildAttention, attentionTitle, attentionItems, type AttnItem } from '@/components/dashboard/attention'

// Types
interface PVENode { node: string; status: string; cpu: number; maxcpu: number; mem: number; maxmem: number; disk: number; maxdisk: number; uptime: number }
interface PVEVM   { vmid: number; name: string; status: string; type: 'qemu'|'lxc'; node: string; cpus: number; cpu: number; mem: number; maxmem: number; uptime: number; hastate?: string }
interface CephStatus { health: { status: string; checks: Record<string,any> }; osdmap: { num_osds: number; num_up_osds: number }; pgmap?: { bytes_total: number; bytes_used: number; bytes_avail: number; data_bytes: number; num_pgs: number } }
interface CephOSD { id: string; name: string; host: string; status: string; percent_used: number; device_class: string; apply_latency_ms: number }
interface HAEntry  { id: string; type: string; status: string; node: string; quorate?: number; crm_state?: string; request_state?: string; sid?: string }
interface GPUInfo  { name: string; vram_total: number; vram_used: number; gpu_util: number; temp: number; power_draw: number; power_limit: number; vram_pct: number; power_pct: number }
interface ClusterTotals { cpu_used: number; cpu_total: number; cpu_pct: number; mem_used: number; mem_total: number; mem_pct: number; disk_used: number; disk_total: number; disk_pct: number }
interface ServiceInfo { connected: boolean; state?: ServiceState; url?: string; version?: string; message?: string; total?: number; enabled?: number; disabled?: number; ssl?: number; expiring?: number }

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
  prometheusUnreachable?: boolean
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
interface FastData { nodes: PVENode[]; vms: PVEVM[]; gpu: GPUInfoFull|null; cluster: ClusterTotals; network?: NetworkData; gpuStatus?: NodeGPUStatus[]; storage?: any[]; clusterName?: string|null }
interface SlowData { ceph: CephStatus|null; osds: CephOSD[]; ha: HAEntry[]; services: { npm: ServiceInfo; grafana?: ServiceInfo; prometheus?: ServiceInfo } }

// One title treatment for every card: the kit's uppercase condensed heading, led by a status dot in the
// card's colour. The name itself never takes the colour, so a card titled in green or red is never mistaken for
// a card reporting green or red; the badge beside it says the state in words.
function CardTitle({ title, accent = ACCENT, badge, right }: { title: string; accent?: string; badge?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <h2 className={vs.panelTitle} style={{ alignItems: 'center' }}>
      <span aria-hidden className="w-2 h-2 rounded-full flex-shrink-0" style={{ background:accent, boxShadow:`0 0 8px ${alpha(accent, 60)}` }}/>
      <span className="truncate min-w-0">{title}</span>
      {badge}
      {right && <span className={vs.panelActs} style={{ fontFamily:'var(--font-mono)', fontSize:12 }}>{right}</span>}
    </h2>
  )
}

// Panel chrome — every card wears the same frame, so the eye can stop parsing
// borders and start reading numbers.
function Panel({ title, accent = ACCENT, right, children, className = '' }: {
  title: string; accent?: string; right?: React.ReactNode; children: React.ReactNode; className?: string
}) {
  return (
    <section className={`${vs.panel} ${className}`} aria-label={title}>
      <CardTitle title={title} accent={accent} right={right}/>
      {children}
    </section>
  )
}

// Cluster summary
function ClusterPanel({ cluster, nodes, vms, ceph, storage, ha, power, stamp }: { cluster:ClusterTotals; nodes:PVENode[]; vms:PVEVM[]; ceph:CephStatus|null; storage?:any[]; ha:HAEntry[]|null; power?:ClusterPower|null; stamp:number|null }) {
  const running = vms.filter(v=>v.status==='running').length
  const online  = nodes.filter(n=>n.status==='online').length
  const cephPct = ceph?.pgmap ? pct(ceph.pgmap.bytes_used, ceph.pgmap.bytes_total) : 0
  // What Proxmox itself lists under Storage, each shared storage once. This is not the
  // Ceph figure below it: Ceph is raw device capacity, this is the usable space of the
  // storages built on top (and on other things besides Ceph).
  const stor     = summarizeStorage(storage)
  const haSum    = summarizeHA(ha)
  const powerUi  = powerStatus(power)

  const cpuHist = useHistory(cluster.cpu_pct, stamp)
  const memHist = useHistory(cluster.mem_pct, stamp)

  const tiles: Array<{ label: string; value: string; color: string; title?: string }> = [
    {label:'RUNNING', value:String(running),            color:GOOD},
    {label:'STOPPED', value:String(vms.length-running), color:'var(--text-dim)'},
    // Counted from the HA status feed. Guests from the per-node lists carry no HA field,
    // so counting those always gave 0.
    haSum.state === 'ok'
      ? {label:'HA', value:String(haSum.services), color:'var(--violet)', title:`${haSum.started} of ${haSum.services} HA resources started${haSum.stopped ? `, ${haSum.stopped} stopped on purpose` : ''}`}
      : {label:'HA', value:'n/a', color:'var(--text-dimmer)', title:'No HA data came back. The API token needs Sys.Audit on / to read HA status.'},
  ]
  if (powerUi.show && power) {
    tiles.push({
      label: power.silent.length ? `POWER ${power.reporting}/${power.of}` : 'POWER',
      value: `${power.total}W`,
      color: power.silent.length ? WARN : GOOD,
      title: [
        ...power.nodes.map(n => n.total === null
          ? `${n.node}: not instrumented`
          : `${n.node}: ${n.total.toFixed(1)} W` +
            (n.gpu ? ` (cpu ${n.cpu?.toFixed(1)} + gpu ${n.gpu.toFixed(1)})` : '') +
            ` · ${n.source}`),
        '',
        power.covers,
      ].join('\n'),
    })
  }

  return (
    <Panel title="Capacity"
      right={<Link href="/infrastructure" className={vs.panelLink}>{online}/{nodes.length} nodes · Infrastructure <span aria-hidden>→</span></Link>}>

      <div className="flex flex-wrap justify-around items-start gap-y-3 mb-4">
        <Speedometer value={cluster.cpu_pct} label="CPU" size={118}
          caption={`${(cluster.cpu_used ?? 0).toFixed(1)} of ${cluster.cpu_total} cores`}/>
        <Speedometer value={cluster.mem_pct} label="Memory" size={118}
          caption={formatBinaryPair(cluster.mem_used, cluster.mem_total)}/>
        <Speedometer value={stor.total > 0 ? stor.pct : cluster.disk_pct}
          label={stor.total > 0 ? 'Storage' : 'Disk'} size={118}
          color="var(--warn)"
          caption={stor.total > 0
            ? formatBinaryPair(stor.used, stor.total)
            : formatBinaryPair(cluster.disk_used, cluster.disk_total)}/>
      </div>

      {/* Where those two dials have just been */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        {[{ h: cpuHist, l: 'CPU', c: zoneColor(cluster.cpu_pct) },
          { h: memHist, l: 'MEM', c: zoneColor(cluster.mem_pct) }].map(({ h, l, c }) => (
          <div key={l} className="rounded-lg p-2" style={{ background:'var(--ground-inset)', border:'1px solid var(--border-dim)' }}>
            <div className="flex items-center justify-between mb-0.5">
              <span className="font-mono text-gray-500 uppercase tracking-wider" style={{ fontSize:11 }}>{l} trend</span>
              <span className="font-mono" style={{ fontSize:11, color:'var(--text-dim)' }}>{h.length}m</span>
            </div>
            <Sparkline data={h} color={c} width={150} height={28} baseline="zero"/>
          </div>
        ))}
      </div>

      <div className={`grid gap-2 mb-4 ${tiles.length > 3 ? 'grid-cols-4' : 'grid-cols-3'}`}>
        {tiles.map(({label,value,color,title})=>(
          <div key={label} title={title} className="text-center py-2 rounded-lg" style={{background:'var(--ground-inset)',border:`1px solid ${alpha(color, 15)}`}}>
            <div className="font-display text-lg font-bold" style={{color, fontVariantNumeric:'tabular-nums'}}>{value}</div>
            <div className="font-mono text-gray-500 mt-0.5" style={{fontSize:11}}>{label}</div>
          </div>
        ))}
      </div>
      {powerUi.note && (
        <div className="font-mono mb-4" style={{ fontSize:12, color:'var(--text-dim)', lineHeight:1.4 }}>{powerUi.note}</div>
      )}

      {ceph?.pgmap && (
        <div>
          <Meter label="Ceph raw" used={ceph.pgmap.bytes_used} total={ceph.pgmap.bytes_total} p={cephPct} fmt={formatBytes} color="var(--warn)"/>
          <div className="font-mono mt-1.5" style={{ fontSize:12, color:'var(--text-dim)', lineHeight:1.4 }}>
            Raw device capacity, before replication. Storage above is the usable space of Proxmox storages, so the two differ.
          </div>
        </div>
      )}

    </Panel>
  )
}

// Every GPU, one row each, "node · name" first so a cut-off row still says where it is. The full name is the
// row's title. Load figures for each GPU are on the Command center and in Grafana; this says which are watched.
function GpuList({ rows }: { rows: Array<{ node: string; name: string; reachable: boolean }> }) {
  if (!rows.length) return null
  return (
    <div className="space-y-1.5 mt-3">
      {rows.map((r, i) => (
        <div key={`${r.node}-${i}`} className="flex items-center gap-2 text-xs font-mono min-w-0">
          <span className="truncate min-w-0 flex-1" style={{ color:'var(--text)' }} title={`${r.node}: ${r.name}`}>{r.node} · {r.name.replace(/^(NVIDIA|Intel|AMD)\s+/i, '')}</span>
          {r.reachable
            ? <span className="shrink-0 inline-flex items-center gap-1" style={{ color:'var(--good)' }}><CheckIcon size={12}/> monitored</span>
            : <Link href="/settings/setup-checklist" className="shrink-0 font-semibold" style={{ color:'var(--accent)' }}>not monitored · set up</Link>}
        </div>
      ))}
    </div>
  )
}

// GPU panel — dynamic, supports NVIDIA/AMD/Intel iGPU/Arc
function GPUPanel({ gpu, gpuStatus }: { gpu: GPUInfoFull | null; gpuStatus?: NodeGPUStatus[] }) {
  const allGPUs = (gpuStatus ?? []).filter(n => n.gpus.length > 0)
  const anyReachable = allGPUs.some(n => n.reachable)
  // Vendor colours identify the maker and must not borrow the status palette: red for AMD read as a fault.
  const gpuTypeColors: Record<string, string> = { 'nvidia': 'var(--good)', 'amd': 'var(--violet-2)', 'intel-igpu': 'var(--accent-2)', 'intel-arc': 'var(--accent)' }
  const gpuTypeLabels: Record<string, string> = { 'nvidia': 'NVIDIA', 'amd': 'AMD', 'intel-igpu': 'Intel iGPU', 'intel-arc': 'Intel Arc' }

  // No GPUs detected at all
  if (allGPUs.length === 0) return (
    <section className={vs.panel} aria-label="GPU">
      <CardTitle title="GPU" accent="var(--text-dimmer)"/>
      <p className={vs.empty}>No GPU detected</p>
    </section>
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
      <section className={vs.panel}>
        <div className="flex items-center justify-between mb-4">
          <CardTitle title="GPU" accent={accent}/>
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
        {/* The card above is the first NVIDIA GPU; every other GPU in the cluster gets a row here. */}
        <GpuList rows={allGPUs.flatMap(n => n.gpus.map(g => ({ node: n.node, name: g.deviceName, reachable: n.reachable, nv: g.type === 'nvidia' })))
          .filter((r, i, all) => !(r.nv && all.findIndex(x => x.nv) === i)).map(({ nv: _nv, ...r }) => r)}/>
      </section>
    )
  }

  // Non-NVIDIA with reachable exporter — show active state
  if (anyReachable) {
    const color = 'var(--good)'
    return (
      <section className={vs.panel}>
        <div className="mb-3">
          <CardTitle title="GPU" accent={color}
            badge={<span className="text-xs font-mono px-1.5 py-0.5 rounded" style={{ background:`${alpha(color, 8)}`, color, border:`1px solid ${alpha(color, 19)}` }}>ACTIVE</span>}/>
        </div>
        <div className="space-y-2">
          {allGPUs.filter(n=>n.reachable).flatMap(n => n.gpus.map((g, i) => {
            const gpuColor = gpuTypeColors[g.type] ?? 'var(--violet)'
            return (
              <div key={`${n.node}-${i}`} className="flex items-center gap-2 p-2 rounded min-w-0" style={{ background:'var(--ground-deep)', border:`1px solid ${alpha(gpuColor, 13)}` }}>
                <span className="text-xs font-mono truncate min-w-0 flex-1" title={`${n.node}: ${g.deviceName}`}><b style={{ color:gpuColor }}>{n.node}</b> <span className="text-gray-500">· {g.deviceName}</span></span>
                {/* Status is green whatever the vendor: the vendor colour only tints the node name and border. */}
                <span className="shrink-0 inline-flex items-center gap-1 text-xs font-mono" style={{ color:'var(--good)' }}><CheckIcon size={12}/> active</span>
              </div>
            )
          }))}
          {allGPUs.filter(n=>!n.reachable).flatMap(n => n.gpus.map((g, i) => (
            <div key={`${n.node}-${i}`} className="flex items-center gap-2 p-2 rounded min-w-0" style={{ background:'var(--ground-deep)', border:'1px solid color-mix(in srgb, var(--warn-2) 13%, transparent)' }}>
              <span className="text-xs font-mono truncate min-w-0 flex-1" title={`${n.node}: ${g.deviceName}`}><b style={{ color:'var(--warn-2)' }}>{n.node}</b> <span className="text-gray-500">· {g.deviceName}</span></span>
              <Link href="/settings/setup-checklist" className="shrink-0 text-xs font-mono font-semibold" style={{ color:'var(--warn-2)' }}>not monitored · set up</Link>
            </div>
          )))}
        </div>
        <div className="text-sm text-gray-600 mt-3">View detailed metrics in Monitoring → Grafana</div>
      </section>
    )
  }

  // No exporter reachable — show install instructions
  const uniqueSteps = allGPUs[0]?.install?.steps ?? []
  const allSameSteps = allGPUs.every(n => JSON.stringify(n.install?.steps) === JSON.stringify(uniqueSteps))
  return (
    <section className={vs.panel}>
      <div className="mb-3">
        <CardTitle title="GPU" accent="var(--warn-2)" badge={<>
          {allGPUs.every(n => !n.reachable) && <span className="text-xs font-mono px-1.5 py-0.5 rounded" style={{ background:'color-mix(in srgb, var(--warn-2) 8%, transparent)', color:'var(--warn-2)', border:'1px solid color-mix(in srgb, var(--warn-2) 19%, transparent)' }}>EXPORTER NOT INSTALLED</span>}
          {allGPUs.some(n => n.reachable) && !allGPUs.every(n => n.reachable) && <span className="text-xs font-mono px-1.5 py-0.5 rounded" style={{ background:'color-mix(in srgb, var(--warn-2) 8%, transparent)', color:'var(--warn-2)', border:'1px solid color-mix(in srgb, var(--warn-2) 19%, transparent)' }}>PARTIAL</span>}
        </>}/>
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
          <div className="text-sm text-gray-500 mb-1">Run on each Proxmox node:</div>
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
    </section>
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
        <div className="text-gray-600 text-center py-4" style={{ fontSize:14 }}>
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

// CEPH compact
function CephPanel({ ceph, osds }: { ceph:CephStatus|null; osds:CephOSD[] }) {
  if (!ceph) return null
  const hOk=ceph.health.status==='HEALTH_OK', hWarn=ceph.health.status==='HEALTH_WARN'
  const hc=hOk?'var(--good)':hWarn?'var(--warn-2)':'var(--crit-2)'
  const up=ceph.pgmap?pct(ceph.pgmap.bytes_used,ceph.pgmap.bytes_total):0
  const checks=Object.entries(ceph.health.checks ?? {})
  const byHost=osds.reduce((a,o)=>{if(!a[o.host])a[o.host]=[];a[o.host].push(o);return a},{} as Record<string,CephOSD[]>)
  return (
    <section className={vs.panel}>
      <div className="flex items-center justify-between mb-4">
        <CardTitle title="Ceph" accent={hc}
          badge={<span className="text-xs font-mono px-1.5 py-0.5 rounded" style={{background:`${alpha(hc, 8)}`,color:hc,border:`1px solid ${alpha(hc, 19)}`}} title={ceph.health.status}>{cephHealthWord(ceph.health.status)}</span>}/>
        <span className="text-xs font-mono" style={{color:'var(--good)'}}>{ceph.osdmap.num_up_osds}/{ceph.osdmap.num_osds} OSDs</span>
      </div>
      {ceph.pgmap&&(
        <div className="flex flex-wrap items-center gap-4 mb-4">
          <Speedometer value={up} label="Raw used" size={110} color="var(--warn)"/>
          <div className="flex-1 space-y-2">
            {[['USED', formatBytes(ceph.pgmap.bytes_used), 'var(--warn)'],
              ['DATA', formatBytes(ceph.pgmap.data_bytes), 'var(--accent)'],
              ['FREE', formatBytes(ceph.pgmap.bytes_avail), 'var(--good)'],
              ['RAW',  formatBytes(ceph.pgmap.bytes_total), 'var(--text-muted)']].map(([l,v,c])=>(
              <div key={l} className="flex items-baseline justify-between font-mono" style={{fontSize:12}}>
                <span className="text-gray-600 uppercase tracking-wider">{l}</span>
                <span style={{color:c, fontVariantNumeric:'tabular-nums'}}>{v}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {checks.map(([key])=>(
        <div key={key} className="flex items-center gap-2 text-xs font-mono p-2 rounded mb-1" style={{background:'color-mix(in srgb, var(--warn-2) 6%, transparent)',border:'1px solid color-mix(in srgb, var(--warn-2) 15%, transparent)'}}>
          <span style={{color:'var(--warn-2)'}}><WarnIcon size={12}/></span>
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
    </section>
  )
}

// HA compact
function HAPanel({ ha: haIn }: { ha:HAEntry[]|null }) {
  // The slow feed sends null when Proxmox refuses the read (a token without Sys.Audit on /).
  const ha = Array.isArray(haIn) ? haIn : []
  const quorum=ha.find(h=>h.type==='quorum'), master=ha.find(h=>h.type==='master')
  const fencing=ha.find(h=>h.type==='fencing'), lrms=ha.filter(h=>h.type==='lrm')
  const services=ha.filter(h=>h.type==='service')
  const masterNode=master?.status.split(' ')[0]??'—', fencingArmed=fencing?.status.includes('armed')??false
  const allStarted=services.every(s=>s.crm_state==='started')
  // No data is not a failed cluster. Showing QUORUM FAIL / FENCING OFF here would be
  // inventing a fault from an empty answer.
  if (ha.length===0) return (
    <section className={vs.panel}>
      <div className="mb-3"><CardTitle title="High Availability" accent="var(--text-dimmer)"/></div>
      <div className="text-sm" style={{color:'var(--text-soft)'}}>No HA data came back from Proxmox.</div>
      <div className="font-mono mt-1" style={{fontSize:12,color:'var(--text-dim)',lineHeight:1.4}}>
        Reading HA status needs the Sys.Audit privilege on / for the API token. Grant it (for example the PVEAuditor role on /) and this panel fills in.
      </div>
    </section>
  )
  return (
    <section className={vs.panel}>
      <div className="flex items-center justify-between mb-4">
        <CardTitle title="High Availability" accent={allStarted?'var(--good)':'var(--warn-2)'}/>
        <span className="text-xs font-mono" style={{color:allStarted?'var(--good)':'var(--warn-2)'}}>
          {services.filter(s=>s.crm_state==='started').length}/{services.length} services
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2 mb-3">
        {[{label:'QUORUM',value:quorum?.quorate?'OK':'FAIL',ok:!!quorum?.quorate},{label:'MASTER',value:masterNode,ok:true},{label:'FENCING',value:fencingArmed?'ARMED':'OFF',ok:fencingArmed}].map(({label,value,ok:isOk})=>(
          <div key={label} className="flex flex-col items-center gap-1 p-2 rounded" style={{background:'var(--ground-deep)',border:'1px solid var(--border-dim)'}}>
            <span className="font-mono text-gray-500" style={{fontSize:11}}>{label}</span>
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
              <span className="font-mono" style={{color:active?'var(--good-soft)':'var(--text-dim)',fontSize:11}}>{lrm.node}</span>
            </div>
          )
        })}
      </div>
      <div className="flex flex-wrap gap-1">
        {services.map(svc=>{
          const ok=svc.crm_state==='started'
          return <span key={svc.id} className="font-mono px-1.5 py-0.5 rounded" style={{fontSize:11,background:ok?'color-mix(in srgb, var(--good) 6%, transparent)':'color-mix(in srgb, var(--crit-2) 6%, transparent)',color:ok?'var(--good-soft)':'var(--crit-soft)',border:`1px solid ${ok?'color-mix(in srgb, var(--good) 19%, transparent)':'color-mix(in srgb, var(--crit-2) 19%, transparent)'}`}}>{svc.sid}</span>
        })}
      </div>
    </section>
  )
}

// Main dashboard
export default function DashboardView() {
  const [fast, setFast]       = useState<FastData | null>(null)
  const [clusterPower, setClusterPower] = useState<ClusterPower | null>(null)
  const [bandwidth, setBandwidth] = useState<BandwidthData | null>(null)
  const [slow, setSlow]       = useState<SlowData | null>(null)
  const [lastSync, setLastSync] = useState<Date | null>(null)
  const alerts = useFiringAlerts()
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
      const down = (what: string): ServiceInfo => ({ connected:false, state:'unreachable', message:`${what} health check failed` })
      const grafana    = await grafanaRes.json().catch(()=>({data: down('Grafana')}))
      const prometheus = await prometheusRes.json().catch(()=>({data: down('Prometheus')}))
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
        setFast({ nodes: d.nodes, vms: d.vms, gpu: d.gpu, cluster: d.cluster, network: networkData.success ? networkData.data : undefined, gpuStatus: gpuStatus.success ? gpuStatus.data : [], storage: d.storage ?? [], clusterName: d.clusterName ?? null })
        setSlow({
          ceph: d.ceph, osds: d.osds, ha: d.ha,
          services: {
            npm:        d.services.npm,
            grafana:    grafana.data ?? down('Grafana'),
            prometheus: prometheus.data ?? down('Prometheus'),
          }
        })
        setLastSync(new Date())
      }
    } catch(e) { console.error(e) }
  }, [])

  // Grafana and Prometheus are not on the WebSocket feed. Without a re-check, a service that
  // came up (or went down) after the page loaded would show its first answer forever.
  useEffect(() => {
    let alive = true
    const recheck = async () => {
      const read = async (path: string, what: string): Promise<ServiceInfo> => {
        try { const j = await (await fetch(path)).json(); if (j?.data) return j.data } catch { /* fall through */ }
        return { connected:false, state:'unreachable', message:`${what} health check failed` }
      }
      const [grafana, prometheus] = await Promise.all([
        read('/api/services/grafana', 'Grafana'), read('/api/services/prometheus', 'Prometheus'),
      ])
      if (alive) setSlow(prev => prev ? { ...prev, services: { ...prev.services, grafana, prometheus } } : prev)
    }
    const id = setInterval(recheck, 30000)
    return () => { alive = false; clearInterval(id) }
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
          setFast(prev => ({ ...msg.payload, gpuStatus: prev?.gpuStatus ?? [], storage: msg.payload.storage ?? prev?.storage ?? [], clusterName: prev?.clusterName ?? null }))
          setLastSync(new Date())
        }
        if (msg.type === 'slow') {
          setSlow(prev => ({
            ...msg.payload,
            services: {
              // The feed's NPM entry predates `state`; keep "not configured" across ticks.
              npm: { ...msg.payload.services.npm, state: serviceState(msg.payload.services.npm, prev?.services?.npm?.state) },
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
    <div className="min-h-[50vh] flex items-center justify-center">
      <div className="text-sm text-gray-500 animate-pulse" role="status">connecting to your cluster...</div>
    </div>
  )

  const clusterLabel = fast.clusterName || process.env.NEXT_PUBLIC_CLUSTER_NAME || ''
  const sorted = [...fast.nodes].sort((a,b)=>{const ag=fast.gpuStatus?.find(g=>g.node===a.node)?.gpus.length??0;const bg=fast.gpuStatus?.find(g=>g.node===b.node)?.gpus.length??0;return bg-ag||a.node.localeCompare(b.node)})

  return (
    <div className={vs.page}>
      <ClusterHud fast={fast} slow={slow} clusterLabel={clusterLabel} lastSync={lastSync} power={clusterPower} alerts={alerts}/>

      {/* Every cluster side by side, once a remote server has been added (nothing shows with none). */}
      <CommandCenterIfRemotes/>

      <Cols>
        <StoragePanel storage={fast.storage}/>
        <HappeningPanel fast={fast} slow={slow} alerts={alerts}/>
      </Cols>

      <PluginCards variant="chips"/>

      <DashboardSitesCard/>

      {/* The dials, GPU, links and Ceph: detail rather than status, so folded away until asked for. */}
      <details className="hx-more">
        <summary className="font-mono" style={{ cursor: 'pointer', fontSize: 13, color: 'var(--text-soft)', padding: '8px 0' }}>More detail: cluster dials, GPU, network, Ceph, HA</summary>
        <div className="flex flex-col gap-4 mt-3">
      {/* The dials, the GPU and the services this install talks to */}
      <div className="grid gap-4 grid-cols-1 xl:grid-cols-[1.25fr_1.25fr_1fr]">
        <ClusterPanel cluster={fast.cluster} nodes={fast.nodes} vms={fast.vms} ceph={slow?.ceph??null} storage={fast.storage} ha={slow?.ha??null} power={clusterPower} stamp={lastSync?.getTime() ?? null}/>
        <GPUPanel gpu={fast.gpu} gpuStatus={fast.gpuStatus}/>
        {slow && <ServicesPanel services={slow.services}/>}
      </div>

      {/* The link meters, then the cluster's own traffic, full width because a time series needs time on it */}
      <BandwidthPanel data={bandwidth} stamp={bandwidth?.at ?? null}/>
      <NetworkPanel network={fast.network??null} stamp={lastSync?.getTime() ?? null}/>

      {slow && (
        <div className="grid gap-4 lg:grid-cols-2">
          <CephPanel ceph={slow.ceph} osds={slow.osds}/>
          <HAPanel   ha={slow.ha}/>
        </div>
      )}
        </div>
      </details>
    </div>
  )
}

// ---------------------------------------------------------------------------
//  The HUD: guests running on the outer ring, memory on the inner, the verdict
//  in words, and the five numbers people look for first.
// ---------------------------------------------------------------------------

function ClusterHud({ fast, slow, clusterLabel, lastSync, power, alerts }: { fast: FastData; slow: SlowData | null; clusterLabel: string; lastSync: Date | null; power: ClusterPower | null; alerts: FiringAlert[] | null }) {
  const running = fast.vms.filter(v => v.status === 'running').length
  const online  = fast.nodes.filter(n => n.status === 'online').length
  const stor    = summarizeStorage(fast.storage)
  const ha      = Array.isArray(slow?.ha) ? slow!.ha : []
  const quorum  = ha.find(h => h.type === 'quorum')
  const haSum   = summarizeHA(slow?.ha ?? null)
  const cephSt  = slow?.ceph?.health.status
  const powerUi = powerStatus(power)

  // The same list the "What's happening" panel shows, so the headline counts exactly what is listed there.
  const attn = buildAttention(attentionInputOf(fast, slow, alerts))
  const problems = attentionItems(attn).map(a => a.title)
  const title = attentionTitle(attn, cephSt)

  const verdict = quorum
    ? { text: quorum.quorate ? 'Quorum OK' : 'No quorum', tone: quorum.quorate ? 'good' as const : 'bad' as const }
    : { text: `${online}/${fast.nodes.length} online`, tone: online === fast.nodes.length ? 'good' as const : 'warn' as const }

  const chips: StatChip[] = [
    { label: 'nodes online', value: `${online}/${fast.nodes.length}`, tone: online === fast.nodes.length ? 'good' : 'crit' },
    { label: 'cluster CPU', value: `${Math.round(fast.cluster.cpu_pct)}%`, tone: 'accent' },
    { label: 'memory', value: `${Math.round(fast.cluster.mem_pct)}%`, tone: 'violet' },
    { label: stor.total > 0 ? 'storage used' : 'disk used', value: `${stor.total > 0 ? stor.pct : Math.round(fast.cluster.disk_pct)}%`, tone: (stor.total > 0 ? stor.pct : fast.cluster.disk_pct) >= 85 ? 'warn' : undefined },
    powerUi.show && power
      ? { label: power.silent.length ? `power ${power.reporting}/${power.of}` : 'power draw', value: `${power.total}W`, tone: power.silent.length ? 'warn' : undefined }
      : { label: 'HA guests', value: haSum.state === 'ok' ? `${haSum.started}/${haSum.wanted}` : 'n/a', tone: haSum.state === 'ok' && haSum.started === haSum.wanted ? 'good' : undefined },
  ]

  const eyebrow = [clusterLabel, cephSt && `Ceph ${cephHealthWord(cephSt)}`, lastSync && `synced ${lastSync.toLocaleTimeString()}`].filter(Boolean).join(' · ')

  return (
    <HudHeader level={2} label="Cluster status" eyebrow={eyebrow || 'Your cluster'} title={title} chips={chips}
      core={{
        outer: { value: fast.vms.length ? running / fast.vms.length : 0, label: 'guests running' },
        inner: { value: (fast.cluster.mem_pct || 0) / 100, label: 'memory' },
        text: `${running}/${fast.vms.length}`, caption: 'guests running', verdict,
      }}>
      {problems.length > 0 && <p className="font-mono" style={{ margin: 0, fontSize: 12, color: 'var(--crit)' }}>{problems.join(' · ')}</p>}
    </HudHeader>
  )
}

// ---------------------------------------------------------------------------
//  Storage as glow bars: each storage Proxmox lists, a shared one once and a
//  node-local one per node, with its percentage in text.
// ---------------------------------------------------------------------------

function StoragePanel({ storage }: { storage?: any[] }) {
  const seen = new Set<string>()
  const rows: Array<{ key: string; label: string; value: number; text: string; title: string }> = []
  for (const st of Array.isArray(storage) ? storage : []) {
    if (!st || typeof st.storage !== 'string' || st.active === 0 || st.enabled === 0 || !(Number(st.total) > 0)) continue
    const key = st.shared ? `shared:${st.storage}` : `${st.node ?? ''}:${st.storage}`
    if (seen.has(key)) continue
    seen.add(key)
    const p = pct(Number(st.used) || 0, Number(st.total))
    rows.push({ key, label: st.shared ? st.storage : `${st.storage} (${st.node})`, value: p, text: `${p}%`,
      title: `${st.storage}${st.shared ? '' : ` on ${st.node}`}: ${formatBinaryPair(Number(st.used) || 0, Number(st.total))}` })
  }
  rows.sort((a, b) => b.value - a.value)
  return (
    <KitPanel title="Storage" sub="used" href="/storage" linkLabel="Storage">
      {rows.length ? <GlowBars label="Storage used" items={rows} max={100} hiAt={70}/> : <p className={vs.empty}>No storage reported yet.</p>}
    </KitPanel>
  )
}

// ---------------------------------------------------------------------------
//  What's happening: firing alerts, then anything the cluster state itself
//  says is off. It is a reading of now, not a history.
// ---------------------------------------------------------------------------

interface FiringAlert { name: string; severity: string; state: string; node: string; summary: string; description: string; firedAt?: string }

function attentionInputOf(fast: FastData, slow: SlowData | null, alerts: FiringAlert[] | null) {
  const ha = Array.isArray(slow?.ha) ? slow!.ha : []
  const quorum = ha.find(h => h.type === 'quorum')
  const stor = summarizeStorage(fast.storage)
  const unreachable: Array<{ key: string; name: string; message?: string }> = []
  if (slow) {
    for (const [k, name] of [['npm', 'Nginx Proxy Manager'], ['grafana', 'Grafana'], ['prometheus', 'Prometheus']] as const) {
      const info = slow.services[k]
      if (info && serviceState(info) === 'unreachable') unreachable.push({ key: k, name, message: info.message })
    }
  }
  return {
    nodes: fast.nodes, quorate: quorum ? !!quorum.quorate : null, ceph: slow?.ceph?.health ?? null,
    storagePct: stor.total > 0 ? stor.pct : null, ha: slow?.ha ?? null, unreachable, alerts,
  }
}

/** Firing alerts from Prometheus, read every minute, for the headline and the list alike. */
function useFiringAlerts(): FiringAlert[] | null {
  const [alerts, setAlerts] = useState<FiringAlert[] | null>(null)
  useEffect(() => {
    let alive = true
    const load = async () => {
      try { const j = await (await fetch('/api/prometheus/alerts')).json(); if (alive) setAlerts(j?.success ? j.data : []) }
      catch { if (alive) setAlerts([]) }
    }
    load()
    const id = setInterval(load, 60_000)
    return () => { alive = false; clearInterval(id) }
  }, [])
  return alerts
}

function HappeningPanel({ fast, slow, alerts }: { fast: FastData; slow: SlowData | null; alerts: FiringAlert[] | null }) {
  const items: Array<{ key: string; title: React.ReactNode; detail?: React.ReactNode; meta?: React.ReactNode; tone: FeedTone }> = buildAttention(attentionInputOf(fast, slow, alerts)) as AttnItem[]
  if (!items.length) items.push({ key: 'calm', title: alerts === null ? 'Checking…' : 'Nothing needs attention', detail: alerts === null ? undefined : 'No alert is firing and every node is online.', tone: alerts === null ? 'off' : 'ok' })

  return (
    <KitPanel title="What's happening" sub="now" href="/monitoring" linkLabel="Monitoring">
      <Feed label="What is happening now" items={items.slice(0, 8)}/>
      {items.length > 8 && <p className={vs.empty} style={{ marginTop: 10, fontSize: 13 }}>and {items.length - 8} more on the Monitoring page.</p>}
    </KitPanel>
  )
}

// Every service ends in a visible state. "checking" exists only for the moment before the first answer.
const SERVICE_PILL: Record<ServiceState | 'checking', { text: string; color: string }> = {
  'connected':      { text: 'connected',      color: 'var(--good)' },
  'unreachable':    { text: 'unreachable',    color: 'var(--crit-2)' },
  'not-configured': { text: 'not configured', color: 'var(--text-muted)' },
  'checking':       { text: 'checking',       color: 'var(--text-muted)' },
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
    <section className={vs.panel}>
      <div className="mb-4"><CardTitle title="Connected Services"/></div>
      <div className="space-y-2">
        {rows.map(({key,name,accent,info,details})=>{
          const st    = info ? serviceState(info) : 'checking'
          const up    = st === 'connected'
          const pill  = SERVICE_PILL[st]
          const sub   = up ? info?.url : st === 'checking' ? undefined : info?.message
          return (
          <div key={key} className="flex items-center gap-3 p-3 rounded" style={{background:'var(--ground-deep)',border:`1px solid ${up?alpha(accent, 13):'var(--border-dim)'}`}}>
            <div className="w-2 h-2 rounded-full flex-shrink-0" style={{background:up?accent:'var(--text-dimmer)',boxShadow:up?`0 0 5px ${accent}`:'none'}}/>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold" style={{color:up?'var(--text-bright)':'var(--text-soft)'}}>{name}</div>
              {sub&&<div className="text-xs font-mono text-gray-500 truncate" title={sub}>{sub}</div>}
            </div>
            {up&&details.length>0&&(
              <div className="grid grid-cols-3 gap-1 flex-shrink-0">
                {details.map(d=>(
                  <div key={d.label} className="text-center">
                    <div className="text-xs font-mono font-bold" style={{color:d.color}}>{d.value}</div>
                    <div className="font-mono text-gray-500" style={{fontSize:11}}>{d.label}</div>
                  </div>
                ))}
              </div>
            )}
            <span className="text-xs font-mono px-2 py-0.5 rounded flex-shrink-0" style={{background:alpha(pill.color, 8),color:pill.color,border:`1px solid ${alpha(pill.color, 25)}`}}>{pill.text}</span>
          </div>
        )})}
      </div>
    </section>
  )
}
