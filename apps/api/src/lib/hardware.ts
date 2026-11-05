// =============================================================================
//  HyperProx — what every node has (the API side of @hyperprox/hardware)
//
//  With a node login, the node is probed over SSH with the shared probe script: GPUs, RAPL, exporters,
//  Docker. Without one, Proxmox's PCI list is classified by the same script and the exporters are asked
//  over the network, so GPUs are still right and the rest is "unknown" rather than guessed.
// =============================================================================

import * as shared from '@hyperprox/hardware'
import type { NodeHardware } from '@hyperprox/hardware'
import { ProxmoxClient } from './proxmox-client'
import { nodeCredential, execOnNode } from './node-exec'
import type { TerminalCredential } from './ssh-broker'
import { auditCredentialUse } from './audit'

export type { NodeHardware }
export { shared as hardware }

export interface HardwareDeps {
  /** Online nodes. */
  nodes(): Promise<string[]>
  addresses(): Promise<Record<string, string>>
  pci(node: string): Promise<unknown[]>
  login(node: string): Promise<TerminalCredential | null>
  exec(host: string, cred: TerminalCredential, script: string, timeoutMs?: number): Promise<{ code: number; output: string }>
  /** /metrics from addr:port, or null when nothing answers. */
  metrics(addr: string, port: number): Promise<string | null>
}

export function pveFromEnv(): ProxmoxClient {
  return new ProxmoxClient(
    process.env.PROXMOX_HOST!, Number(process.env.PROXMOX_PORT ?? 8006),
    `${process.env.PROXMOX_USER}!${process.env.PROXMOX_TOKEN_ID}`, process.env.PROXMOX_TOKEN_SECRET!,
  )
}

export function productionHardwareDeps(): HardwareDeps {
  const pve = () => pveFromEnv()
  return {
    async nodes() { return ((await pve().getNodes()) as any[]).filter(n => n.status === 'online').map(n => n.node).sort() },
    async addresses() {
      const rows = await pve().fetchNode<any[]>('/cluster/status').catch(() => [])
      const out: Record<string, string> = {}
      for (const r of rows ?? []) if (r?.type === 'node' && r.name && r.ip) out[r.name] = r.ip
      return out
    },
    pci: node => pve().fetchNode<any[]>(`/nodes/${node}/hardware/pci`).catch(() => []),
    login: node => nodeCredential(node).catch(() => null),
    async exec(host, cred, script, timeoutMs = 15 * 60_000) {
      const r = await execOnNode({ host, cred, command: 'bash -s', input: script, timeoutMs })
      return { code: r.code, output: r.output }
    },
    async metrics(addr, port) {
      try {
        const res = await fetch(`http://${addr}:${port}/metrics`, { signal: AbortSignal.timeout(4000) })
        return res.ok ? await res.text() : null
      } catch { return null }
    },
  }
}

/** One node, as well as HyperProx can see it. `useLogin: false` never opens SSH. */
export async function detectNode(node: string, addr: string, deps: HardwareDeps, opts: { useLogin?: boolean } = {}): Promise<NodeHardware & { error?: string }> {
  const cred = opts.useLogin === false ? null : await deps.login(node)
  if (cred) {
    try {
      await auditCredentialUse('node_login.use', `node:${node}`, { purpose: 'hardware probe (read-only)' })
      const r = await deps.exec(addr, cred, shared.probeScript(), 60_000)
      const hw = shared.parseProbe(r.output, node)
      if (hw.arch) return hw
    } catch { /* fall through to what Proxmox can say */ }
  }
  const [pci, m9100, m8081, m9835] = await Promise.all([
    deps.pci(node), deps.metrics(addr, 9100), deps.metrics(addr, 8081), deps.metrics(addr, 9835),
  ])
  return shared.fromProxmox(node, pci, {
    nodeExporter: m9100 && /^node_exporter_build_info/m.test(m9100) ? 'running' : null,
    // node_exporter publishes RAPL only when it can read the counters.
    rapl: m9100 && /^node_rapl_package_joules_total/m.test(m9100) ? 'readable' : null,
    intelExporter: m8081 && /^igpu_/m.test(m8081) ? 'running' : 'absent',
    nvidiaExporter: m9835 && /^nvidia_smi_memory_total_bytes/m.test(m9835) ? 'running' : 'absent',
    ...(cred ? { error: 'the node login did not work, so only what Proxmox reports is shown' } : {}),
  } as any)
}

/** Every online node, one at a time (a probe is cheap, but this keeps SSH to one node at once). */
export async function detectCluster(deps: HardwareDeps = productionHardwareDeps(), opts: { useLogin?: boolean } = {}) {
  const [names, addrs] = await Promise.all([deps.nodes(), deps.addresses()])
  const nodes: Array<NodeHardware & { error?: string }> = []
  for (const n of names) nodes.push(await detectNode(n, addrs[n] ?? n, deps, opts))
  return { nodes, addresses: addrs, summary: shared.summarise(nodes) }
}

// GPU badges change only when hardware does: cache the Proxmox-only view for a few minutes.
let badgeCache: { at: number; data: Array<{ node: string; gpus: shared.Gpu[] }> } | null = null
export async function gpuBadges(deps: HardwareDeps = productionHardwareDeps(), ttlMs = 5 * 60_000) {
  if (badgeCache && Date.now() - badgeCache.at < ttlMs) return badgeCache.data
  const names = await deps.nodes()
  const data = await Promise.all(names.map(async node => ({ node, gpus: shared.classifyPci(await deps.pci(node)) })))
  badgeCache = { at: Date.now(), data }
  return data
}
export function resetGpuBadgeCache(): void { badgeCache = null }
