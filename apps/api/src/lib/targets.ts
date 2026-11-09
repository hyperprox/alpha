// =============================================================================
//  HyperProx — Prometheus target lists, kept up to date by HyperProx itself
//
//  Nobody edits these by hand any more. They are synced when setup finishes, when a node joins (a watch
//  compares the node list every few minutes while HyperProx is unlocked), and on demand. A sync only adds:
//  an entry someone already has for a node or address is kept as it is.
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'
import { hardware } from './hardware'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const dashboard = require('@hyperprox/hardware/dashboard') as { vendorsOf(n: unknown[]): string[]; writeClusterDashboard(dir: string, v?: string[]): { changed: boolean; vendors: string[] } }
import { getProviderCredentials } from './credentials'
import { ProxmoxClient } from './proxmox-client'
import { prometheusBase } from './service-health'
import { isUnlocked, onUnlock } from './vault/state'
import { listClusters } from './clusters/registry'

/** GPU vendors whose figures remote clusters send here (monitoring installed by HyperProx), for the dashboard rows. */
export function remoteGpuVendors(): string[] {
  return listClusters().some(c => c.kind === 'remote' && Object.values(c.monitoring ?? {}).some(m => m?.amdGpu)) ? ['amd'] : []
}

/** Redraw the cluster dashboard's GPU rows for home's vendors (from the last sync) plus the remotes'. */
export function redrawGpuRows(write: (vendors: string[]) => void = v => { dashboard.writeClusterDashboard(process.env.HYPERPROX_DIR || '/opt/hyperprox', v) }): string[] | null {
  if (!last) return null
  const vendors = [...new Set([...last.gpuVendors, ...remoteGpuVendors()])]
  try { write(vendors) } catch { /* the template is missing: an install without the dashboards */ }
  return vendors
}

export const TARGET_FILES = ['nodes.json', 'pve.json', 'intel-gpu.json', 'nvidia.json', 'ceph.json'] as const

export function targetsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HYPERPROX_TARGETS_DIR || path.join(env.HYPERPROX_DIR || '/opt/hyperprox', 'config/prometheus/targets')
}

export function readTargets(file: string, dir = targetsDir()): any[] {
  try {
    const p = path.join(dir, file)
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : []
  } catch { return [] }
}

function writeTargets(file: string, targets: any[], dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, file)
  fs.writeFileSync(`${p}.tmp`, JSON.stringify(targets, null, 2))
  fs.renameSync(`${p}.tmp`, p)
}

export interface TargetSyncDeps {
  nodes(): Promise<string[]>
  /** The address Prometheus should scrape for a node. */
  address(node: string): Promise<string | null>
  pci(node: string): Promise<unknown[]>
  cephMgrs(nodes: string[]): Promise<Set<string>>
  reload(): Promise<void>
  dir: string
  /** Draw the cluster dashboard with only these GPU vendors' rows. */
  dashboard?(vendors: string[]): void
}

async function client(): Promise<ProxmoxClient> {
  const c = await getProviderCredentials('proxmox', 'proxmox')
  return new ProxmoxClient(c.host, Number(c.port ?? 8006), `${c.user ?? 'root@pam'}!${c.token_id}`, c.token_secret)
}

export async function productionTargetDeps(): Promise<TargetSyncDeps> {
  const pve = await client()
  return {
    async nodes() { return ((await pve.getNodes()) as any[]).map(n => n.node).sort() },
    async address(node) {
      try {
        const nets = await pve.fetchNode<any[]>(`/nodes/${node}/network`)
        // Tailscale first (reachable from anywhere HyperProx runs), then the main bridge.
        return nets.find((n: any) => n.iface === 'tailscale0' && n.address)?.address
          ?? nets.find((n: any) => n.iface === 'vmbr0' && n.address)?.address ?? null
      } catch { return null }
    },
    pci: node => pve.fetchNode<any[]>(`/nodes/${node}/hardware/pci`).catch(() => []),
    async cephMgrs(nodes) {
      // The mgr list is cluster-wide from any node; every mgr is listed so a failover needs no change.
      for (const n of nodes) {
        try {
          const mgrs = await pve.fetchNode<any[]>(`/nodes/${n}/ceph/mgr`)
          if (Array.isArray(mgrs)) return new Set(mgrs.filter(m => m?.host).map(m => String(m.host)))
        } catch { /* next node */ }
      }
      return new Set()
    },
    async reload() { try { await fetch(`${prometheusBase()}/-/reload`, { method: 'POST' }) } catch { /* not running */ } },
    dir: targetsDir(),
    dashboard: vendors => { dashboard.writeClusterDashboard(process.env.HYPERPROX_DIR || '/opt/hyperprox', vendors) },
  }
}

export interface SyncResult { nodes: string[]; added: Record<string, string[]>; at: string; gpuVendors: string[] }
let last: SyncResult | null = null
export function lastSync(): SyncResult | null { return last }

export async function syncTargets(deps?: TargetSyncDeps): Promise<SyncResult> {
  const d = deps ?? await productionTargetDeps()
  const names = await d.nodes()
  const addrs = new Map<string, string>()
  const facts = []
  for (const n of names) {
    addrs.set(n, (await d.address(n)) ?? n)
    facts.push(hardware.fromProxmox(n, await d.pci(n)))
  }
  const wanted = hardware.targetsFor(facts, n => addrs.get(n) ?? n, { cephMgrs: await d.cephMgrs(names) })
  const added: Record<string, string[]> = {}
  for (const file of TARGET_FILES) {
    const r = hardware.mergeTargets(readTargets(file, d.dir), wanted[file] ?? [])
    writeTargets(file, r.merged, d.dir)
    added[file] = r.added
  }
  await d.reload()
  // The dashboard follows the same detection: a GPU row only for a vendor this cluster has.
  const gpuVendors = dashboard.vendorsOf(facts)
  // Rows for a vendor a remote cluster reports too (its nodes appear on the same board under node@cluster).
  try { d.dashboard?.([...new Set([...gpuVendors, ...remoteGpuVendors()])]) } catch { /* the template is missing: an install without the dashboards */ }
  last = { nodes: names, added, at: new Date().toISOString(), gpuVendors }
  return last
}

/**
 * Keep the lists current without anyone asking: sync on unlock, then whenever the node list changes.
 * Nothing runs while locked (there is no Proxmox token to read with).
 */
export function watchTargets(opts: { everyMs?: number; log?: (m: string) => void; deps?: () => Promise<TargetSyncDeps> } = {}): () => void {
  const log = opts.log ?? (() => {})
  let seen = ''
  let busy = false
  let stopped = false
  const tick = async () => {
    if (stopped || busy || !isUnlocked()) return
    busy = true
    try {
      const d = await (opts.deps ?? productionTargetDeps)()
      const names = (await d.nodes()).join(',')
      if (names && names !== seen) {
        const r = await syncTargets(d)
        seen = names
        const n = Object.values(r.added).reduce((a, x) => a + x.length, 0)
        if (n) log(`[targets] metrics list updated for ${r.nodes.length} node(s): ${n} target(s) added`)
      }
    } catch (e: any) {
      log(`[targets] could not sync: ${e?.message ?? e}`)
    } finally { busy = false }
  }
  const timer = setInterval(() => { void tick() }, opts.everyMs ?? 5 * 60_000)
  timer.unref?.()
  onUnlock(() => { void tick() })
  if (isUnlocked()) void tick()
  return () => { stopped = true; clearInterval(timer) }
}
