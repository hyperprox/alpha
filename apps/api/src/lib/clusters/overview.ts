// =============================================================================
//  HyperProx — the Command center: one panel per cluster, and one "needs attention" list
//
//  Every panel is read inside its own cluster's context with its own time limit, so one slow or unreachable
//  remote shows as "not answering" on its own panel and never holds up the others. Nothing here writes.
// =============================================================================

import { checkSummary } from '../updates/check-summary'
import * as shared from '@hyperprox/hardware'
import type { ProxmoxClient } from '../proxmox-client'
import { pveFromEnv } from '../pve-env'
import { listClusters, type ClusterInfo } from './registry'
import { runInCluster } from './context'
import { prometheusBase } from '../service-health'
import { gpuCapability } from '../hardware'

export interface GpuRow {
  node: string
  /** The full name, and a short one for a phone row ("HD Graphics 630", "GTX 1070 Ti"). */
  name: string
  shortName: string
  vendor: string
  kind: 'integrated' | 'dedicated'
  /** PCI address from Proxmox's list ("0000:00:02.0"), when it gave one. */
  pci: string | null
  /** Busy percent (the busiest engine, for Intel), video memory and temperature/fan when monitoring reports them; null when it does not. */
  load: number | null
  vramUsed: number | null
  vramTotal: number | null
  /** "shared": built-in graphics use system memory, so there is no separate video memory to report. */
  memory: 'dedicated' | 'shared'
  tempC: number | null
  fanPct: number | null
  /** Clock (MHz) and power (W), where the collector reports them (Intel). */
  freqMHz: number | null
  powerW: number | null
  /**
   * measured: figures just now. waiting: monitoring is set up, no figures yet. stale: figures stopped arriving.
   * unsupported: the collector does not support this GPU. not-monitored: nothing collects this GPU's figures.
   */
  state: 'measured' | 'waiting' | 'stale' | 'unsupported' | 'not-monitored'
  /** Why, in a few words, when not measured. */
  stateNote: string | null
  /** Where to set monitoring up, when it is not. */
  setupHref: string | null
  /** The longer explanation of what it decodes, and the one-line version. */
  capability: string
  capabilityShort: string
  capabilitySource: 'vainfo' | 'estimate'
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
  /** Network storage (NAS) mounted on the nodes that is not a Proxmox storage, one entry per server. */
  networkStorage: NetworkStorage[]
  gpus: GpuRow[]
  /** One honest line about the GPU figures: what is measured, what is estimated, and how to improve it. */
  gpuNote: string | null
  lastBackup: { at: number; ok: boolean; node: string } | null
  attention: Attention[]
  /** Monitoring is installed (a remote) or present (home). */
  monitoring: boolean
  /** From the last daily updates check (stored; nothing is read from the machines for this). */
  updates?: PanelUpdates | null
}

export interface NetworkStorage { server: string; shares: number; usedBytes: number; totalBytes: number; pct: number }

export interface FsRow { metric: Record<string, string>; value: number }

/** The Prometheus matcher for network filesystem types. */
export const NETWORK_FSTYPES = 'nfs4?|cifs|smb3|fuse.sshfs'

/** The server of a network mount's device: "host:/export" (NFS, sshfs), "//host/share" (CIFS), "[::1]:/export". Null when it is neither. */
export function networkServer(device: string): string | null {
  const d = String(device ?? '').trim()
  let m = /^(?:\\\\|\/\/)(?:[^@/\\]*@)?(\[[^\]]+\]|[^/\\]+)[/\\]/.exec(d)
  if (!m) m = /^(?:[^@/:]*@)?(\[[^\]]+\]|[^/:\[\]]+):/.exec(d)
  const host = m?.[1]?.replace(/^\[|\]$/g, '')
  return host ? host.toLowerCase() : null
}

/**
 * Network storage from the filesystem collector's size and available series. One entry per server. Within a server
 * each distinct (size, available) pair is one volume and counts once, because several exports of one NAS volume
 * report the same figures; "shares" is the number of distinct exports. Mounts under /mnt/pve/ are Proxmox's own
 * storages, which the Storage bar already covers, so they are left out.
 */
export function groupNetworkStorage(size: FsRow[], avail: FsRow[]): NetworkStorage[] {
  const key = (m: Record<string, string>) => `${m.node ?? ''}\u0000${m.instance ?? ''}\u0000${m.device ?? ''}\u0000${m.mountpoint ?? ''}`
  const free = new Map(avail.map(r => [key(r.metric), r.value]))
  const servers = new Map<string, { shares: Set<string>; volumes: Map<string, { total: number; used: number }> }>()
  for (const r of size) {
    const m = r.metric
    const server = networkServer(m.device ?? '')
    const mp = m.mountpoint ?? ''
    if (!server || /^\/mnt\/pve(\/|$)/.test(mp) || !(r.value > 0)) continue
    const a = free.get(key(m))
    if (a === undefined) continue
    const s = servers.get(server) ?? { shares: new Set<string>(), volumes: new Map() }
    s.shares.add(m.device)
    s.volumes.set(`${r.value}:${a}`, { total: r.value, used: Math.max(0, r.value - a) })
    servers.set(server, s)
  }
  return [...servers].map(([server, s]) => {
    let usedBytes = 0, totalBytes = 0
    for (const v of s.volumes.values()) { usedBytes += v.used; totalBytes += v.total }
    return { server, shares: s.shares.size, usedBytes, totalBytes, pct: pct(usedBytes, totalBytes) ?? 0 }
  }).sort((a, b) => a.server.localeCompare(b.server))
}

/** One cluster's network storage, read from Prometheus and limited to that cluster's nodes (by their series labels). */
export async function readNetworkStorage(c: { id: string; kind: string }, nodeLabels: string[], prom: PromQuery): Promise<NetworkStorage[]> {
  const sel = `${clusterSelector(c)},fstype=~"${NETWORK_FSTYPES}"`
  const [size, avail] = await Promise.all([
    prom(`node_filesystem_size_bytes{${sel}}`).catch(() => []),
    prom(`node_filesystem_avail_bytes{${sel}}`).catch(() => []),
  ])
  const mine = new Set(nodeLabels)
  const ours = (rows: FsRow[]) => (mine.size ? rows.filter(r => !r.metric.node || mine.has(r.metric.node)) : rows)
  return groupNetworkStorage(ours(size), ours(avail))
}

export interface PanelUpdates { available: number; packages: number; security: number; checkedAt: string; result: 'ok' | 'partial' | 'skipped'; reason?: string }

/** The panel's updates line, from the stored check result. */
export function panelUpdates(id: string): PanelUpdates | null {
  const c = checkSummary(id)
  if (!c) return null
  const out: PanelUpdates = { available: c.available, packages: c.packages, security: c.security, checkedAt: c.at, result: c.result }
  if (c.reason) out.reason = c.reason
  return out
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

export interface GpuFigure { load: number | null; vramUsed: number | null; vramTotal: number | null; tempC: number | null; fanPct: number | null; freqMHz: number | null; powerW: number | null }
export interface IntelFigure extends GpuFigure { pci: string; status: string; reason: string; stale: boolean }

const STALE_S = 120
const cardNo = (c: string | undefined) => Number(/(\d+)$/.exec(c ?? '')?.[1] ?? 1e9)

/**
 * GPU figures by node and by GPU, from whatever exporters report them. Every GPU gets its own figures:
 *   AMD (node_exporter's drm collector): one series per card, in card order.
 *   NVIDIA (nvidia_gpu_exporter): one series per uuid, in nvidia-smi's index order (PCI order).
 *   Intel: HyperProx's textfile collector labels each GPU with its PCI address; the older port-8081 exporter
 *   reports one GPU per node, with no address.
 */
export async function gpuFigures(c: { id: string; kind: string }, prom: PromQuery, nowS: number = Date.now() / 1000) {
  const sel = clusterSelector(c)
  // A remote's series carry node="<node>@<cluster>" (remoteNodeLabel); home's carry the plain node name.
  const nodeOf = (m: Record<string, string>) => m.node || ''
  const safe = (e: string) => prom(e).catch(() => [] as Awaited<ReturnType<PromQuery>>)
  const [amdBusy, amdUsed, amdSize, amdTemp, amdPwm, nvUtil, nvUsed, nvTotal, nvTemp, nvFan, nvIndex, inBusy, inFreq, inPower, inInfo, inTs, gpuUp] = await Promise.all([
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
    safe(`nvidia_smi_index{${sel}}`),
    safe(`max by (node, pci) ({__name__=~"igpu_engines_.+_busy",${sel}})`),
    safe(`max by (node, pci) (igpu_frequency_actual{${sel}})`),
    safe(`max by (node, pci) (igpu_power_gpu{${sel}})`),
    safe(`hyperprox_intel_gpu_info{${sel}}`),
    safe(`hyperprox_intel_gpu_sample_timestamp_seconds{${sel}}`),
    safe(`up{job=~"intel-gpu|nvidia",${sel}}`),
  ])
  type Rows = typeof amdBusy
  const on = (rows: Rows, node: string) => rows.filter(r => nodeOf(r.metric) === node)
  const by = (rows: Rows, node: string, key: string, val: string) => on(rows, node).find(r => (r.metric[key] ?? '') === val)?.value ?? null
  const pctOf = (v: number | null) => (v === null ? null : Math.round(v * 100))
  const none = { tempC: null, fanPct: null, freqMHz: null, powerW: null }
  return {
    amd(node: string): GpuFigure[] {
      const cards = [...new Set([...on(amdBusy, node), ...on(amdSize, node)].map(r => r.metric.card ?? ''))].sort((a, b) => cardNo(a) - cardNo(b))
      // hwmon is per node here: a temperature or fan only when one AMD card reports.
      const one = cards.length === 1
      const t = one ? on(amdTemp, node)[0]?.value ?? null : null
      const f = one ? on(amdPwm, node)[0]?.value ?? null : null
      return cards.map(card => ({ ...none, load: by(amdBusy, node, 'card', card), vramUsed: by(amdUsed, node, 'card', card), vramTotal: by(amdSize, node, 'card', card), tempC: t, fanPct: f === null ? null : Math.round((f / 255) * 100) }))
    },
    nvidia(node: string): GpuFigure[] {
      const idx = (u: string) => by(nvIndex, node, 'uuid', u) ?? 1e9
      const uuids = [...new Set([...on(nvUtil, node), ...on(nvTotal, node)].map(r => r.metric.uuid ?? ''))].sort((a, b) => idx(a) - idx(b) || a.localeCompare(b))
      return uuids.map(u => ({ ...none, load: pctOf(by(nvUtil, node, 'uuid', u)), vramUsed: by(nvUsed, node, 'uuid', u), vramTotal: by(nvTotal, node, 'uuid', u), tempC: by(nvTemp, node, 'uuid', u), fanPct: pctOf(by(nvFan, node, 'uuid', u)) }))
    },
    intel(node: string): IntelFigure[] {
      const pcis = [...new Set([...on(inBusy, node), ...on(inInfo, node)].map(r => r.metric.pci ?? ''))]
      return pcis.map(pci => {
        const info = on(inInfo, node).find(r => (r.metric.pci ?? '') === pci)?.metric
        const ts = by(inTs, node, 'pci', pci)
        const stale = ts !== null && nowS - ts > STALE_S
        const status = info?.status ?? (by(inBusy, node, 'pci', pci) !== null ? 'ok' : 'unknown')
        const load = stale || status !== 'ok' ? null : by(inBusy, node, 'pci', pci)
        return { pci, status, reason: info?.reason ?? '', stale, load: load === null ? null : Math.round(load), vramUsed: null, vramTotal: null, tempC: null, fanPct: null,
          freqMHz: stale ? null : by(inFreq, node, 'pci', pci), powerW: stale ? null : by(inPower, node, 'pci', pci) }
      })
    },
    /** An exporter for this vendor is listed for the node but not answering (home's port-8081 and 9835 exporters). */
    down(node: string, vendor: string): boolean {
      const job = vendor === 'intel' ? 'intel-gpu' : vendor === 'nvidia' ? 'nvidia' : ''
      return !!job && on(gpuUp, node).some(r => r.metric.job === job && r.value === 0)
    },
  }
}

/**
 * Proxmox's PCI rows → the GPUs, each with its PCI address. classifyPci keeps NVIDIA, Intel and AMD display
 * devices in the order given, so the same rows filtered the same way line up one to one.
 */
export function gpusWithSlots(pci: unknown[]): Array<shared.Gpu & { pci: string | null }> {
  const rows = (Array.isArray(pci) ? pci : []).filter((d: any) => /^0x03/i.test(String(d?.class ?? '')) && /^(0x)?(10de|8086|1002)$/i.test(String(d?.vendor ?? '')))
  let gpus: shared.Gpu[] = []
  try { gpus = shared.classifyPci(rows) } catch { gpus = [] }
  const aligned = gpus.length === rows.length
  return gpus.map((g, i) => {
    const id = aligned ? String((rows[i] as any)?.id ?? '') : ''
    return { ...g, pci: /^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/i.test(id) ? id.toLowerCase() : null }
  })
}

/** "NVIDIA GeForce GTX 1070 Ti" → "GTX 1070 Ti"; "Intel HD Graphics 630" → "HD Graphics 630"; first of "A / B". */
export function shortGpuName(name: string): string {
  let n = String(name ?? '').split(' / ')[0]
  n = n.replace(/^(NVIDIA|Intel|AMD)\s+/i, '').replace(/^(GeForce|Radeon)\s+(?=\S+\s+\S)/i, '').replace(/\s+/g, ' ').trim()
  return n.length > 28 ? `${n.slice(0, 27)}…` : n || String(name ?? '')
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
    guests: { running: 0, total: 0 }, cpuPct: null, memPct: null, storagePct: null, networkStorage: [], gpus: [], gpuNote: null, lastBackup: null, attention: [],
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

  // Network storage (a NAS mounted on a node) that Proxmox itself does not list as a storage.
  const onlineNodes = nodes.filter(n => n.status === 'online').map(n => String(n.node))
  base.networkStorage = await readNetworkStorage(c, onlineNodes.map(n => (c.kind === 'remote' ? remoteNodeLabel(c.id, n) : n)), deps.prom).catch(() => [])
  for (const n of base.networkStorage) {
    if (n.pct >= 90) att('warn', `Network storage ${n.server} is ${n.pct}% full`, `${n.shares} share${n.shares === 1 ? '' : 's'} on this NAS.`)
  }

  // GPUs: what Proxmox's PCI list says is there, every one of them, with figures where monitoring reports them.
  const online = nodes.filter(n => n.status === 'online').map(n => String(n.node))
  const figures = await gpuFigures(c, deps.prom, deps.now() / 1000).catch(() => null)
  const setupHref = c.kind === 'remote' ? `/clusters/${encodeURIComponent(c.id)}?tab=settings` : '/settings/setup-checklist'
  for (const node of online) {
    const pci = await pve.fetchNode<any[]>(`/nodes/${encodeURIComponent(node)}/hardware/pci`).catch(() => [])
    const label = c.kind === 'remote' ? remoteNodeLabel(c.id, node) : node
    const gpus = gpusWithSlots(pci)
    const rec = c.kind === 'remote' ? (c.monitoring ?? {})[node] : undefined
    const amd = figures?.amd(label) ?? [], nv = figures?.nvidia(label) ?? [], intel = figures?.intel(label) ?? []
    let amdI = 0, nvI = 0
    const intelUsed = new Set<string>()
    for (const g of gpus) {
      let f: GpuFigure | null = null
      let state: GpuRow['state'] = 'not-monitored'
      let stateNote: string | null = null
      if (g.vendor === 'amd') f = amd[amdI++] ?? null
      else if (g.vendor === 'nvidia') f = nv[nvI++] ?? null
      else if (g.vendor === 'intel') {
        // By PCI address when the collector gives one; the port-8081 exporter (no address) is the node's first Intel GPU.
        const fi = intel.find(x => x.pci && x.pci === g.pci) ?? (intelUsed.size === 0 ? intel.find(x => !x.pci) : undefined) ?? null
        if (fi) {
          intelUsed.add(fi.pci || 'first')
          if (fi.stale) { state = 'stale'; stateNote = 'figures stopped arriving' }
          else if (fi.status === 'unsupported') { state = 'unsupported'; stateNote = 'not supported on this GPU' }
          else if (fi.status === 'no_permission') { state = 'unsupported'; stateNote = 'collector has no permission' }
          else if (fi.status !== 'ok' && fi.status !== 'unknown') { state = 'waiting'; stateNote = fi.reason ? `collector: ${fi.reason}` : 'no figures yet' }
          f = fi
        } else if (rec?.intelGpu?.status === 'unsupported') { state = 'unsupported'; stateNote = 'not supported on this GPU' }
      }
      if (f && f.load !== null && state === 'not-monitored') state = 'measured'
      else if (state === 'not-monitored') {
        const set = figures?.down(label, g.vendor) || (g.vendor === 'amd' && !!rec?.amdGpu) || (g.vendor === 'intel' && rec?.intelGpu?.status === 'measured') || (!!f)
        if (set) { state = 'waiting'; stateNote = figures?.down(label, g.vendor) ? 'exporter not answering' : 'no figures yet' }
        else stateNote = 'not monitored'
      }
      const cap = gpuCapability(g)
      const shared_ = g.vendor === 'intel' ? g.kind === 'integrated' : g.vendor === 'amd' && g.kind === 'integrated'
      base.gpus.push({
        node, name: g.name, shortName: shortGpuName(g.name), vendor: g.vendor, kind: g.kind === 'integrated' ? 'integrated' : 'dedicated', pci: g.pci,
        load: state === 'measured' ? f?.load ?? null : null,
        vramUsed: f?.vramUsed ?? null, vramTotal: f?.vramTotal ?? null, memory: shared_ ? 'shared' : 'dedicated',
        tempC: f?.tempC ?? null, fanPct: f?.fanPct ?? null, freqMHz: f?.freqMHz ?? null, powerW: f?.powerW ?? null,
        state, stateNote, setupHref: state === 'not-monitored' ? setupHref : null,
        capability: cap.summary, capabilityShort: cap.short, capabilitySource: cap.source,
      })
    }
  }
  base.gpuNote = gpuNote(base.gpus, c.kind)

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

/**
 * One short, honest line under the GPU rows: how many GPUs have measured load, that the HEVC lines are estimates
 * from the model name, and what improves either.
 */
export function gpuNote(gpus: GpuRow[], kind: 'home' | 'remote'): string | null {
  if (!gpus.length) return null
  const measured = gpus.filter(g => g.state === 'measured').length
  const missing = gpus.filter(g => g.state === 'not-monitored').length
  const load = measured === gpus.length ? 'Load: measured on every GPU.' : `Load: measured on ${measured} of ${gpus.length} GPUs${missing ? ` (set up monitoring${kind === 'remote' ? ' in Edit server, step 5' : ' in the setup checklist'} for the rest)` : ''}.`
  const est = gpus.some(g => g.capabilitySource === 'estimate')
  return `${load} ${est ? 'HEVC lines are estimates from the model name; a Full scan on the hardware page checks them with vainfo, where vainfo is installed on the node.' : 'HEVC lines were checked with vainfo.'}`
}

/** Every cluster's panel, at once, each in its own context. */
export async function commandCenter(deps: Partial<PanelDeps> = {}): Promise<{ panels: ClusterPanel[]; attention: Attention[] }> {
  const clusters = listClusters()
  const panels = await Promise.all(clusters.map(c => runInCluster(c.id, async () => {
    const d: PanelDeps = { pve: deps.pve ?? (() => pveFromEnv()), prom: deps.prom ?? livePromQuery, now: deps.now ?? Date.now }
    try { return await timed(() => readPanel(c, d), 20_000, c.name) }
    catch (e: any) {
      const p: ClusterPanel = { id: c.id, name: c.name, kind: c.kind, reachable: false, error: e?.message ?? String(e), latencyMs: null, nodes: { online: 0, total: 0 }, quorum: 'unknown', guests: { running: 0, total: 0 }, cpuPct: null, memPct: null, storagePct: null, networkStorage: [], gpus: [], gpuNote: null, lastBackup: null, attention: [], monitoring: false }
      p.attention.push({ clusterId: c.id, clusterName: c.name, kind: c.kind, severity: 'crit', title: 'Not answering', detail: p.error! })
      return p
    }
  })))
  for (const p of panels) {
    p.updates = panelUpdates(p.id)
    const u = p.updates
    if (u && u.available > 0) {
      p.attention.push({
        clusterId: p.id, clusterName: p.name, kind: p.kind, severity: u.security ? 'warn' : 'info',
        title: u.security ? `Security updates on ${u.available} machine${u.available === 1 ? '' : 's'}` : `Updates available on ${u.available} machine${u.available === 1 ? '' : 's'}`,
        detail: `${u.packages} package${u.packages === 1 ? '' : 's'} at the last check; see the Updates page.`,
      })
    }
  }
  const rank = { crit: 0, warn: 1, info: 2 }
  const attention = panels.flatMap(p => p.attention).sort((a, b) => rank[a.severity] - rank[b.severity])
  return { panels, attention }
}
