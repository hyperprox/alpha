// =============================================================================
//  HyperProx — the Command center: one panel per cluster, and one "needs attention" list
//
//  Every panel is read inside its own cluster's context with its own time limit, so one slow or unreachable
//  remote shows as "not answering" on its own panel and never holds up the others. Nothing here writes.
// =============================================================================

import * as shared from '@hyperprox/hardware'
import type { ProxmoxClient } from '../proxmox-client'
import { pveFromEnv } from '../pve-env'
import { listClusters, type ClusterInfo } from './registry'
import { runInCluster } from './context'
import { prometheusBase } from '../service-health'
import { gpuCapability } from '../hardware'

export interface GpuRow {
  node: string
  name: string
  vendor: string
  /** Busy percent, video memory and temperature/fan when monitoring reports them; null when it does not. */
  load: number | null
  vramUsed: number | null
  vramTotal: number | null
  tempC: number | null
  fanPct: number | null
  capability: string
}

export interface ClusterPanel {
  id: string
  name: string
  kind: 'home' | 'remote'
  reachable: boolean
  error?: string
  latencyMs: number | null
  nodes: { online: number; total: number }
  quorum: 'ok' | 'lost' | 'standalone' | 'unknown'
  guests: { running: number; total: number }
  cpuPct: number | null
  memPct: number | null
  storagePct: number | null
  gpus: GpuRow[]
  lastBackup: { at: number; ok: boolean; node: string } | null
  attention: Attention[]
  /** Monitoring is installed (a remote) or present (home). */
  monitoring: boolean
}

export interface Attention { clusterId: string; clusterName: string; kind: 'home' | 'remote'; severity: 'warn' | 'crit' | 'info'; title: string; detail: string }

export interface PromQuery { (expr: string): Promise<Array<{ metric: Record<string, string>; value: number }>> }

export const livePromQuery: PromQuery = async (expr) => {
  const res = await fetch(`${prometheusBase()}/api/v1/query?query=${encodeURIComponent(expr)}`, { signal: AbortSignal.timeout(3000) })
  if (!res.ok) return []
  const j: any = await res.json().catch(() => null)
  return (j?.data?.result ?? []).map((r: any) => ({ metric: r.metric ?? {}, value: Number(r.value?.[1]) })).filter((r: any) => Number.isFinite(r.value))
}

const pct = (used: number, total: number) => (total > 0 ? Math.round((used / total) * 100) : null)

/**
 * The Prometheus label filter for a cluster's series. Remote targets carry hpx_cluster; home series have none,
 * so `hpx_cluster=""` selects exactly them.
 */
export function clusterSelector(c: { id: string; kind: string }): string {
  return c.kind === 'remote' ? `hpx_cluster="${c.id}"` : 'hpx_cluster=""'
}

/** The `node` label HyperProx gives a remote node's series, so a remote "pve" never merges with a home "pve". */
export function remoteNodeLabel(clusterId: string, node: string): string { return `${node}@${clusterId}` }

/** GPU figures by node, from whatever exporters report them. */
export async function gpuFigures(c: { id: string; kind: string }, prom: PromQuery) {
  const sel = clusterSelector(c)
  // A remote's series carry node="<node>@<cluster>" (remoteNodeLabel); home's carry the plain node name.
  const nodeOf = (m: Record<string, string>) => m.node || ''
  const safe = (e: string) => prom(e).catch(() => [])
  const [amdBusy, amdUsed, amdSize, amdTemp, amdPwm, nvUtil, nvUsed, nvTotal, nvTemp, nvFan] = await Promise.all([
    safe(`node_drm_gpu_busy_percent{${sel}}`),
    safe(`node_drm_memory_vram_used_bytes{${sel}}`),
    safe(`node_drm_memory_vram_size_bytes{${sel}}`),
    safe(`max by (node, hpx_node) (node_hwmon_temp_celsius{${sel}} * on (chip, instance) group_left (chip_name) node_hwmon_chip_names{chip_name="amdgpu",${sel}})`),
    safe(`max by (node, hpx_node) (node_hwmon_pwm{${sel}} * on (chip, instance) group_left (chip_name) node_hwmon_chip_names{chip_name="amdgpu",${sel}})`),
    safe(`nvidia_smi_utilization_gpu_ratio{${sel}}`),
    safe(`nvidia_smi_memory_used_bytes{${sel}}`),
    safe(`nvidia_smi_memory_total_bytes{${sel}}`),
    safe(`nvidia_smi_temperature_gpu{${sel}}`),
    safe(`nvidia_smi_fan_speed_ratio{${sel}}`),
  ])
  const first = (rows: typeof amdBusy, node: string) => rows.find(r => nodeOf(r.metric) === node)?.value ?? null
  return {
    amd: (node: string) => ({ load: first(amdBusy, node), vramUsed: first(amdUsed, node), vramTotal: first(amdSize, node), tempC: first(amdTemp, node), fanPct: (() => { const v = first(amdPwm, node); return v === null ? null : Math.round((v / 255) * 100) })() }),
    nvidia: (node: string) => ({ load: (() => { const v = first(nvUtil, node); return v === null ? null : Math.round(v * 100) })(), vramUsed: first(nvUsed, node), vramTotal: first(nvTotal, node), tempC: first(nvTemp, node), fanPct: (() => { const v = first(nvFan, node); return v === null ? null : Math.round(v * 100) })() }),
  }
}

async function timed<T>(fn: () => Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined
  try {
    return await Promise.race([fn(), new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`${what} did not answer within ${Math.round(ms / 1000)} seconds`)), ms) })])
  } finally { if (t) clearTimeout(t) }
}

export interface PanelDeps { pve(): ProxmoxClient; prom: PromQuery; now(): number }

/** One cluster's panel, read in the current cluster context. */
export async function readPanel(c: ClusterInfo, deps: PanelDeps): Promise<ClusterPanel> {
  const base: ClusterPanel = {
    id: c.id, name: c.name, kind: c.kind, reachable: false, latencyMs: null, nodes: { online: 0, total: 0 }, quorum: 'unknown',
    guests: { running: 0, total: 0 }, cpuPct: null, memPct: null, storagePct: null, gpus: [], lastBackup: null, attention: [],
    monitoring: c.kind === 'home' || Object.values(c.monitoring ?? {}).some(m => m?.nodeExporter),
  }
  const att = (severity: Attention['severity'], title: string, detail: string) => base.attention.push({ clusterId: c.id, clusterName: c.name, kind: c.kind, severity, title, detail })
  let pve: ProxmoxClient
  try { pve = deps.pve() } catch (e: any) {
    base.error = e?.message ?? String(e)
    att('crit', 'Cannot connect', base.error!)
    return base
  }
  const t0 = deps.now()
  try {
    await pve.fetchStrict('/version', 'GET', undefined, 8000)
    base.latencyMs = deps.now() - t0
    base.reachable = true
  } catch (e: any) {
    base.error = e?.code === 'cert_changed' || e?.name === 'CertificateChangedError' ? e.message : `Not answering: ${e?.message ?? e}`
    att('crit', e?.name === 'CertificateChangedError' ? 'Certificate changed: nothing was sent' : 'Not answering', base.error!)
    return base
  }

  const [nodesR, statusR, vmsR, storR] = await Promise.allSettled([
    pve.fetchStrict<any[]>('/nodes'),
    pve.fetchStrict<any[]>('/cluster/status'),
    pve.fetchStrict<any[]>('/cluster/resources?type=vm'),
    pve.fetchStrict<any[]>('/cluster/resources?type=storage'),
  ])
  const nodes = nodesR.status === 'fulfilled' ? nodesR.value ?? [] : []
  base.nodes = { online: nodes.filter(n => n.status === 'online').length, total: nodes.length }
  for (const n of nodes) if (n.status !== 'online') att('crit', `Node ${n.node} is offline`, 'Proxmox reports it as not online.')
  const used = nodes.reduce((a, n) => ({ cpu: a.cpu + (n.cpu ?? 0) * (n.maxcpu ?? 0), maxcpu: a.maxcpu + (n.maxcpu ?? 0), mem: a.mem + (n.mem ?? 0), maxmem: a.maxmem + (n.maxmem ?? 0) }), { cpu: 0, maxcpu: 0, mem: 0, maxmem: 0 })
  base.cpuPct = pct(used.cpu, used.maxcpu)
  base.memPct = pct(used.mem, used.maxmem)
  if ((base.memPct ?? 0) >= 90) att('warn', `Memory ${base.memPct}% used`, 'Guests may start to swap or fail to start.')

  if (statusR.status === 'fulfilled') {
    const cl = (statusR.value ?? []).find((r: any) => r?.type === 'cluster')
    base.quorum = !cl ? 'standalone' : Number(cl.quorate) === 1 ? 'ok' : 'lost'
    if (base.quorum === 'lost') att('crit', 'Quorum lost', 'The cluster cannot change its configuration until enough nodes are back.')
  }
  const vms = (vmsR.status === 'fulfilled' ? vmsR.value ?? [] : []).filter((v: any) => (v.type === 'lxc' || v.type === 'qemu') && Number(v.template ?? 0) !== 1)
  base.guests = { running: vms.filter((v: any) => v.status === 'running').length, total: vms.length }

  // Storage: each shared storage once, each local one per node; only active ones with a size.
  const seen = new Set<string>()
  let sUsed = 0, sTotal = 0
  for (const s of (storR.status === 'fulfilled' ? storR.value ?? [] : [])) {
    if (s.status !== 'available' || !(s.maxdisk > 0)) continue
    const key = Number(s.shared) === 1 ? `shared:${s.storage}` : `${s.node}:${s.storage}`
    if (seen.has(key)) continue
    seen.add(key)
    sUsed += s.disk ?? 0; sTotal += s.maxdisk
    const p = pct(s.disk ?? 0, s.maxdisk)
    if ((p ?? 0) >= 90) att('warn', `Storage ${s.storage} is ${p}% full`, Number(s.shared) === 1 ? 'Shared storage.' : `On ${s.node}.`)
  }
  base.storagePct = pct(sUsed, sTotal)

  // GPUs: what Proxmox's PCI list says is there, with figures where monitoring reports them.
  const online = nodes.filter(n => n.status === 'online').map(n => String(n.node))
  const figures = await gpuFigures(c, deps.prom).catch(() => null)
  for (const node of online) {
    const pci = await pve.fetchNode<any[]>(`/nodes/${encodeURIComponent(node)}/hardware/pci`).catch(() => [])
    let gpus: shared.Gpu[] = []
    try { gpus = shared.classifyPci(pci) } catch { gpus = [] }
    const label = c.kind === 'remote' ? remoteNodeLabel(c.id, node) : node
    for (const g of gpus) {
      const f = figures ? (g.vendor === 'amd' ? figures.amd(label) : g.vendor === 'nvidia' ? figures.nvidia(label) : null) : null
      base.gpus.push({ node, name: g.name, vendor: g.vendor, load: f?.load ?? null, vramUsed: f?.vramUsed ?? null, vramTotal: f?.vramTotal ?? null, tempC: f?.tempC ?? null, fanPct: f?.fanPct ?? null, capability: gpuCapability(g).summary })
    }
  }

  // Last backup: the newest vzdump task on any node.
  for (const node of online) {
    const tasks = await pve.fetchNode<any[]>(`/nodes/${encodeURIComponent(node)}/tasks?typefilter=vzdump&limit=5`).catch(() => [])
    for (const t of tasks ?? []) {
      const at = Number(t.starttime) * 1000
      if (!Number.isFinite(at) || t.status === undefined) continue
      if (!base.lastBackup || at > base.lastBackup.at) base.lastBackup = { at, ok: t.status === 'OK', node }
    }
  }
  if (base.lastBackup && !base.lastBackup.ok) att('warn', 'The last backup did not finish cleanly', `On ${base.lastBackup.node}; see its task log.`)
  if (base.lastBackup && deps.now() - base.lastBackup.at > 3 * 86_400_000) att('warn', 'No backup in 3 days', 'The newest backup task is older than three days.')
  if (c.kind === 'remote' && !base.monitoring) att('info', 'Monitoring not installed', 'GPU and server figures appear once monitoring is installed (Edit server, step 5).')
  return base
}

/** Every cluster's panel, at once, each in its own context. */
export async function commandCenter(deps: Partial<PanelDeps> = {}): Promise<{ panels: ClusterPanel[]; attention: Attention[] }> {
  const clusters = listClusters()
  const panels = await Promise.all(clusters.map(c => runInCluster(c.id, async () => {
    const d: PanelDeps = { pve: deps.pve ?? (() => pveFromEnv()), prom: deps.prom ?? livePromQuery, now: deps.now ?? Date.now }
    try { return await timed(() => readPanel(c, d), 20_000, c.name) }
    catch (e: any) {
      const p: ClusterPanel = { id: c.id, name: c.name, kind: c.kind, reachable: false, error: e?.message ?? String(e), latencyMs: null, nodes: { online: 0, total: 0 }, quorum: 'unknown', guests: { running: 0, total: 0 }, cpuPct: null, memPct: null, storagePct: null, gpus: [], lastBackup: null, attention: [], monitoring: false }
      p.attention.push({ clusterId: c.id, clusterName: c.name, kind: c.kind, severity: 'crit', title: 'Not answering', detail: p.error! })
      return p
    }
  })))
  const rank = { crit: 0, warn: 1, info: 2 }
  const attention = panels.flatMap(p => p.attention).sort((a, b) => rank[a.severity] - rank[b.severity])
  return { panels, attention }
}
