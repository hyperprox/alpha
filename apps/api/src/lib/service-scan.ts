// =============================================================================
//  HyperProx — the one service scan
//
//  The probes themselves live in @hyperprox/hardware/service-probes (plain JS, so the setup wizard can
//  require the same file). This is the API side: where to look (every running guest's address, from its
//  config and from what it reports live, and the nodes themselves), the real GET, and a five-minute cache
//  shared by the two API consumers:
//
//    - the Plug-ins page's "Scan for services" (routes/plugins.ts GET /discover)
//    - the Catalogue's "already here" (routes/catalogue.ts GET /detected), merged with the proxy-host
//      fingerprints of lib/catalogue-detect.ts
//
//  So the Catalogue can no longer say "not found" for something Scan just found: they read the same result.
// =============================================================================

import { PROBES, scanHosts, realGet, guestAddresses, isProbeAddress, type ProbeGetter, type ScanHost, type ServiceFinding } from '@hyperprox/hardware/service-probes'
import { configAddresses, liveAddresses } from './wizard-placement'
import type { DetectResult, Running } from './catalogue-detect'
import { homePve } from './pve-env'

export { PROBES }
export type GuestRef = { vmid: number; name: string; node: string; type: 'lxc' | 'qemu'; status: string }
export type Finding = ServiceFinding<GuestRef | null>

/** What the scan reads from Proxmox. Tests pass a fake. */
export interface ScanSource {
  /** Running and stopped guests (`/cluster/resources?type=vm`). */
  guests(): Promise<Array<{ vmid: number; name?: string; node: string; type: string; status: string }>>
  config(node: string, vmid: number, type: 'lxc' | 'qemu'): Promise<Record<string, unknown> | null>
  /** LXC `/interfaces` or QEMU agent `network-get-interfaces`; null when there is no answer. */
  live(node: string, vmid: number, type: 'lxc' | 'qemu'): Promise<unknown>
  nodes(): Promise<Array<{ name: string; ip?: string }>>
}

/** Every address worth asking: each running guest's (config, then live) and each node's. */
export async function scanTargets(src: ScanSource): Promise<Array<ScanHost<GuestRef | null>>> {
  const out: Array<ScanHost<GuestRef | null>> = []
  const guests = ((await src.guests().catch(() => [])) ?? [])
    .filter(g => (g.type === 'lxc' || g.type === 'qemu') && g.status === 'running')
  await Promise.all(guests.map(async g => {
    const type = g.type as 'lxc' | 'qemu'
    const ref: GuestRef = { vmid: Number(g.vmid), name: String(g.name ?? g.vmid), node: String(g.node), type, status: g.status }
    const fromConfig = configAddresses(await src.config(ref.node, ref.vmid, type).catch(() => null))
    // The agent is only asked when the config names no address of its own (it reports bridge addresses too).
    const addrs = fromConfig.some(isProbeAddress)
      ? guestAddresses(fromConfig, [])
      : guestAddresses([], liveAddresses(await src.live(ref.node, ref.vmid, type).catch(() => null)))
    for (const a of addrs) out.push({ address: a, source: `${ref.name} (${ref.vmid})`, guest: ref })
  }))
  for (const n of (await src.nodes().catch(() => [])) ?? []) if (n.ip && isProbeAddress(n.ip)) out.push({ address: n.ip, source: `node ${n.name}`, guest: null })
  // Same order every time, whatever order Proxmox answered in; one entry per address (a guest wins over a node).
  const sorted = out.sort((a, b) => a.address.localeCompare(b.address, undefined, { numeric: true }) || (a.guest ? 0 : 1) - (b.guest ? 0 : 1) || (a.guest?.vmid ?? 0) - (b.guest?.vmid ?? 0))
  return sorted.filter((t, i) => i === 0 || sorted[i - 1].address !== t.address)
}

/** The real probe: the shared one (no credentials or cookies, redirects decided by the scan, capped body). */
export const realProbeGet: ProbeGetter = realGet

export interface ScanResult { findings: Finding[]; builtAt: number; scanned: number }

export const SCAN_TTL_MS = 5 * 60_000

/** The scan, cached five minutes, one run at a time. */
export class ServiceScanCache {
  private found: ScanResult | null = null
  private running: Promise<ScanResult> | null = null
  constructor(private src: () => ScanSource, private get: ProbeGetter = realProbeGet, private now: () => number = Date.now) {}
  async result(refresh = false): Promise<ScanResult> {
    if (this.found && !refresh && this.now() - this.found.builtAt < SCAN_TTL_MS) return this.found
    if (this.running) return this.running
    this.running = (async () => {
      const targets = await scanTargets(this.src())
      const findings = await scanHosts(targets, this.get)
      return (this.found = { findings, builtAt: this.now(), scanned: targets.length })
    })().finally(() => { this.running = null })
    return this.running
  }
}

// ── What each consumer makes of the findings ────────────────────────────────

/** The Plug-ins page's shape: one row per plug-in setting (Unmanic may have several), no recipe-only services. */
export function pluginFindings(findings: Finding[]) {
  const seen = new Set<string>()
  return findings
    // A finding a plug-in can take: by its address setting, or (a plug-in with its own device list, PBS) on its page.
    .filter(f => f.pluginId && (f.setting || f.page))
    .filter(f => {
      if (f.multiple) return true
      const key = `${f.pluginId}:${f.setting}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map(f => ({ pluginId: f.pluginId!, setting: f.setting ?? null, page: f.page ?? null, label: f.label, address: f.address, source: f.source, needs: f.needs, key: f.key, recipeId: f.recipeId }))
}

/** The Catalogue's shape: per recipe, where it runs (as lib/catalogue-detect.ts's Running). */
export function catalogueRunning(findings: Finding[]): Record<string, Running[]> {
  const apps: Record<string, Running[]> = {}
  for (const f of findings) {
    if (!f.recipeId) continue
    const list = apps[f.recipeId] ?? (apps[f.recipeId] = [])
    const target = `${f.host}:${f.port}`
    if (list.some(r => r.target === target)) continue
    list.push({ guest: f.guest, target, publicUrl: null, domains: [], version: null, via: 'port-scan', service: f.label, url: f.address })
  }
  return apps
}

/** The proxy-fingerprint detection and the port scan, as one answer for the Catalogue. */
export function mergeDetection(fingerprints: DetectResult, scan: ScanResult): DetectResult {
  const apps: Record<string, Running[]> = {}
  for (const [id, list] of Object.entries(fingerprints.apps)) apps[id] = [...list]
  for (const [id, list] of Object.entries(catalogueRunning(scan.findings))) {
    const viaProxy = fingerprints.apps[id] ?? []
    const into = apps[id] ?? (apps[id] = [])
    for (const r of list) {
      // The same guest already found through its proxy host is one app, not two.
      if (viaProxy.some(x => x.target === r.target || (r.guest && x.guest?.vmid === r.guest.vmid))) continue
      into.push(r)
    }
  }
  for (const list of Object.values(apps)) list.sort((a, b) => (a.guest?.vmid ?? 1e9) - (b.guest?.vmid ?? 1e9) || a.target.localeCompare(b.target))
  return { apps, builtAt: Math.min(fingerprints.builtAt, scan.builtAt), probed: fingerprints.probed + scan.scanned, errors: fingerprints.errors }
}

// ── The live source and the shared cache ────────────────────────────────────

let shared: ServiceScanCache | null = null

/** The process-wide scan both the Plug-ins page and the Catalogue read. */
export function sharedServiceScan(): ServiceScanCache {
  return (shared ??= new ServiceScanCache(() => liveSource()))
}

function liveSource(): ScanSource {
  const pve = homePve()
  const enc = encodeURIComponent
  return {
    guests: async () => ((await pve.getClusterResources('vm').catch(() => [])) ?? []) as any[],
    config: (node, vmid, type) => pve.getVMConfig(node, vmid, type).catch(() => null),
    live: (node, vmid, type) => pve.fetchStrict<unknown>(type === 'lxc'
      ? `/nodes/${enc(node)}/lxc/${vmid}/interfaces`
      : `/nodes/${enc(node)}/qemu/${vmid}/agent/network-get-interfaces`, 'GET', undefined, 5000).catch(() => null),
    nodes: async () => ((await pve.fetchNode<any[]>('/cluster/status').catch(() => [])) ?? [])
      .filter((r: any) => r?.type === 'node').map((r: any) => ({ name: String(r.name), ip: r.ip ? String(r.ip) : undefined })),
  }
}
