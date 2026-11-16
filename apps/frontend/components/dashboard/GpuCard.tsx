'use client'

import Link from 'next/link'
import { alpha } from '@/lib/theme'
import { Speedometer, zoneColor } from '@/components/dashboard/Viz'
import { CheckIcon } from '@/components/dashboard/Icons'
import { CardTitle } from '@/components/dashboard/CardTitle'
import { styles as vs } from '@/components/visual/kit'
import {
  shortGpuLabel, whereLine, guestsLine, primaryNvidia, hasFigures, sizeShort, pctOfTotal, missingWhy,
  type NodeGPUStatus, type GpuLiveFigures, type GpuGuestRef,
} from '@/lib/gpu-card'

export interface GPUConsumer { pid: number; vram_mb: number; process: string; ct_id: string|null; ct_name: string|null; vram_pct: number }
export interface GPUInfoFull { name: string; vram_total: number; vram_used: number; vram_free: number; gpu_util: number; temp: number; power_draw: number; power_limit: number; vram_pct: number; power_pct: number; consumers: GPUConsumer[] }

// Vendor colours identify the maker and must not borrow the status palette: red for AMD read as a fault.
const TYPE_COLORS: Record<string, string> = { 'nvidia': 'var(--good)', 'amd': 'var(--violet-2)', 'intel-igpu': 'var(--accent-2)', 'intel-arc': 'var(--accent)' }
const TYPE_LABELS: Record<string, string> = { 'nvidia': 'NVIDIA', 'amd': 'AMD', 'intel-igpu': 'Intel iGPU', 'intel-arc': 'Intel Arc' }

type OneGpu = NodeGPUStatus['gpus'][number]

/** One figure: a small label over a value, "—" with a plain reason when it is missing. */
export function Stat({ label, value, why }: { label: string; value: string | null; why: string }) {
  const missing = value === null
  return (
    <div className="min-w-0" title={missing ? why : undefined} data-missing={missing ? 'true' : undefined}>
      <div className="font-mono text-gray-500 uppercase tracking-wider" style={{ fontSize:11 }}>{label}</div>
      <div className="font-mono" style={{ fontSize:13, color: missing ? 'var(--text-dimmer)' : 'var(--text-bright)', fontVariantNumeric:'tabular-nums' }}>{missing ? '—' : value}</div>
    </div>
  )
}

/** A thin bar with its label and reading; an empty track and "—" when there is no figure. */
export function MiniBar({ label, p, right, why }: { label: string; p: number | null; right: string | null; why: string }) {
  const c = p === null ? 'var(--text-dimmer)' : zoneColor(p)
  return (
    <div title={p === null ? why : undefined} data-missing={p === null ? 'true' : undefined}>
      <div className="flex items-baseline justify-between font-mono" style={{ fontSize:11 }}>
        <span className="text-gray-500 uppercase tracking-wider">{label}</span>
        <span style={{ color: p === null ? 'var(--text-dimmer)' : 'var(--text-bright)', fontVariantNumeric:'tabular-nums' }}>{right ?? '—'}</span>
      </div>
      <div className="h-1.5 rounded-full overflow-hidden mt-0.5" style={{ background:'var(--border-strong)' }}>
        {p !== null && <div className="h-full rounded-full" style={{ width:`${Math.max(0, Math.min(p, 100))}%`, background:c, boxShadow:`0 0 8px ${alpha(c, 38)}`, transition:'width .6s cubic-bezier(.22,1,.36,1)' }}/>}
      </div>
    </div>
  )
}

const pctText = (v: number | null) => (v === null ? null : `${v}%`)

/** The figures of a built-in (or non-NVIDIA) GPU in the card's compact form. */
export function GpuMetrics({ type, live }: { type: string; live: GpuLiveFigures }) {
  if (live.kind === 'intel' || type.startsWith('intel')) {
    const e = live.engines
    return (
      <div className="space-y-2" data-metrics="intel">
        <MiniBar label="Busy" p={live.busy} right={pctText(live.busy)} why={missingWhy('Busy', live)}/>
        <div className="grid grid-cols-3 gap-2">
          <Stat label="3D" value={pctText(e?.render ?? null)} why={missingWhy('The 3D engine load', live)}/>
          <Stat label="Video" value={pctText(e?.video ?? null)} why={missingWhy('The video (encode and decode) engine load', live)}/>
          <Stat label="Enhance" value={pctText(e?.enhance ?? null)} why={missingWhy('The video enhance engine load', live)}/>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Clock" value={live.freqMHz === null ? null : `${live.freqMHz} MHz`} why={missingWhy('The clock speed', live)}/>
          <Stat label="Power" value={live.powerW === null ? null : `${live.powerW} W`} why={missingWhy('GPU power', live)}/>
        </div>
      </div>
    )
  }
  return (
    <div className="space-y-2" data-metrics="amd">
      <MiniBar label="Busy" p={live.busy} right={pctText(live.busy)} why={missingWhy('Busy', live)}/>
      <MiniBar label="VRAM" p={pctOfTotal(live.vramUsed, live.vramTotal)} right={live.vramTotal === null ? null : `${sizeShort(live.vramUsed)} / ${sizeShort(live.vramTotal)}`} why={missingWhy('Video memory', live)}/>
      <MiniBar label="GTT" p={pctOfTotal(live.gttUsed, live.gttTotal)} right={live.gttTotal === null ? null : `${sizeShort(live.gttUsed)} / ${sizeShort(live.gttTotal)}`} why={missingWhy('Shared system memory (GTT)', live)}/>
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Temp" value={live.tempC === null ? null : `${live.tempC}°C`} why={missingWhy('Temperature', live)}/>
        <Stat label="Power" value={live.powerW === null ? null : `${live.powerW} W`} why={missingWhy('GPU power', live)}/>
      </div>
    </div>
  )
}

/** One GPU in the list: where it is, what it is, its live figures, and the guests that use it. */
export function GpuRow({ node, g, reachable }: { node: string; g: OneGpu; reachable: boolean }) {
  const color = reachable ? (TYPE_COLORS[g.type] ?? 'var(--violet)') : 'var(--warn-2)'
  const guests = guestsLine(g.guests)
  const live = g.live ?? null
  return (
    <div className="rounded p-2 min-w-0" style={{ background:'var(--ground-deep)', border:`1px solid ${alpha(color, 13)}` }} data-gpu-row={`${node}`}>
      <div className="flex items-center gap-2 text-xs font-mono min-w-0">
        <span className="truncate min-w-0 flex-1" title={`${node}: ${g.deviceName}`}>
          <b style={{ color }}>{node}</b> <span className="text-gray-500">· {shortGpuLabel(g.deviceName)}</span>
        </span>
        <span className="shrink-0 px-1.5 py-0.5 rounded" style={{ color, border:`1px solid ${alpha(color, 19)}`, fontSize:11 }}>{g.dedicated ? 'Dedicated' : 'Built-in'}</span>
      </div>
      {reachable && hasFigures(live) && <div className="mt-2"><GpuMetrics type={g.type} live={live!}/></div>}
      {reachable && !hasFigures(live) && (
        <div className="mt-1.5 flex items-center gap-2 text-xs font-mono" title={missingWhy('Live load', live)}>
          <span style={{ color:'var(--text-dimmer)' }}>—</span>
          <span className="inline-flex items-center gap-1" style={{ color:'var(--good)' }}><CheckIcon size={12}/> monitored</span>
        </div>
      )}
      {!reachable && (
        <div className="mt-1.5 text-xs font-mono"><Link href="/settings/setup-checklist" className="font-semibold" style={{ color:'var(--warn-2)' }}>not monitored · set up</Link></div>
      )}
      {guests && <div className="mt-2 text-xs font-mono text-gray-500" title={guests}>{guests}</div>}
    </div>
  )
}

function GpuList({ rows }: { rows: Array<{ node: string; g: OneGpu; reachable: boolean }> }) {
  if (!rows.length) return null
  return (
    <div className="space-y-2 mt-3">
      {rows.map((r, i) => <GpuRow key={`${r.node}-${i}`} node={r.node} g={r.g} reachable={r.reachable}/>)}
    </div>
  )
}

// GPU panel — dynamic, supports NVIDIA/AMD/Intel iGPU/Arc
export function GPUPanel({ gpu, gpuStatus }: { gpu: GPUInfoFull | null; gpuStatus?: NodeGPUStatus[] }) {
  const allGPUs = (gpuStatus ?? []).filter(n => n.gpus.length > 0)
  const anyReachable = allGPUs.some(n => n.reachable)

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
    const home = primaryNvidia(allGPUs, gpu.name)
    const homeGpu = home ? allGPUs.find(n => n.node === home.node)?.gpus[home.index] : undefined
    const guests = guestsLine(homeGpu?.guests)
    return (
      <section className={vs.panel} aria-label="GPU">
        <div className="flex items-center justify-between mb-2">
          <CardTitle title="GPU" accent={accent}/>
          <span className="text-xs font-mono text-gray-500 ml-2 text-right min-w-0" title={gpu.name}>
            {shortGpuLabel(gpu.name)}{home && <> · <b style={{ color:'var(--text-bright)' }} data-gpu-node={home.node}>{whereLine(home.node)}</b></>}
          </span>
        </div>
        {guests && <div className="mb-3 text-xs font-mono text-gray-500" title={guests}>{guests}</div>}
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
        {/* The card above is one NVIDIA GPU; every other GPU in the cluster gets a row here, with its node and its figures. */}
        <GpuList rows={allGPUs.flatMap(n => n.gpus.map((g, index) => ({ node: n.node, g, reachable: n.reachable, skip: !!home && home.node === n.node && home.index === index })))
          .filter(r => !r.skip).map(({ skip: _s, ...r }) => r)}/>
      </section>
    )
  }

  // Non-NVIDIA with reachable exporter — show active state
  if (anyReachable) {
    const color = 'var(--good)'
    return (
      <section className={vs.panel} aria-label="GPU">
        <div className="mb-3">
          <CardTitle title="GPU" accent={color}
            badge={<span className="text-xs font-mono px-1.5 py-0.5 rounded" style={{ background:`${alpha(color, 8)}`, color, border:`1px solid ${alpha(color, 19)}` }}>ACTIVE</span>}/>
        </div>
        <GpuList rows={[
          ...allGPUs.filter(n => n.reachable).flatMap(n => n.gpus.map(g => ({ node: n.node, g, reachable: true }))),
          ...allGPUs.filter(n => !n.reachable).flatMap(n => n.gpus.map(g => ({ node: n.node, g, reachable: false }))),
        ]}/>
      </section>
    )
  }

  // No exporter reachable — show install instructions
  const uniqueSteps = allGPUs[0]?.install?.steps ?? []
  const allSameSteps = allGPUs.every(n => JSON.stringify(n.install?.steps) === JSON.stringify(uniqueSteps))
  return (
    <section className={vs.panel} aria-label="GPU">
      <div className="mb-3">
        <CardTitle title="GPU" accent="var(--warn-2)" badge={<>
          {allGPUs.every(n => !n.reachable) && <span className="text-xs font-mono px-1.5 py-0.5 rounded" style={{ background:'color-mix(in srgb, var(--warn-2) 8%, transparent)', color:'var(--warn-2)', border:'1px solid color-mix(in srgb, var(--warn-2) 19%, transparent)' }}>EXPORTER NOT INSTALLED</span>}
        </>}/>
      </div>
      <div className="flex gap-2 flex-wrap mb-3">
        {allGPUs.map(n => {
          const gpu0 = n.gpus[0]
          const color = TYPE_COLORS[gpu0.type] ?? 'var(--violet)'
          return <span key={n.node} className="text-xs font-mono px-2 py-1 rounded" style={{ background:`${alpha(color, 8)}`, color, border:`1px solid ${alpha(color, 19)}` }}>{n.node} — {TYPE_LABELS[gpu0.type] ?? gpu0.type}</span>
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

export type { GpuGuestRef }
