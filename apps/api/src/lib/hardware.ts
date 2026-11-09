// =============================================================================
//  HyperProx — what every node has (the API side of @hyperprox/hardware)
//
//  With a node login, the node is probed over SSH with the shared probe script: GPUs, RAPL, exporters,
//  Docker. Without one, Proxmox's PCI list is classified by the same script and the exporters are asked
//  over the network, so GPUs are still right and the rest is "unknown" rather than guessed.
//
//  Per cluster: the deps read through pveFromEnv() and nodeCredential(), which follow the cluster context
//  (lib/clusters/context.ts). detectCluster(deps, { clusterId }) runs the whole scan for that cluster; a remote
//  node is reached on its saved private-link address, never the LAN address it reports.
// =============================================================================

import * as shared from '@hyperprox/hardware'
import type { NodeHardware } from '@hyperprox/hardware'
import { ProxmoxClient } from './proxmox-client'
import { nodeCredential, execOnNode } from './node-exec'
import type { TerminalCredential } from './ssh-broker'
import { auditCredentialUse } from './audit'
import { pveFromEnv as contextPve } from './pve-env'
import { addressesInContext } from './clusters/nodes'
import { runInCluster, currentClusterId, isRemoteContext } from './clusters/context'

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

/** The client for the cluster this runs for (kept under its old name for callers that import it from here). */
export function pveFromEnv(): ProxmoxClient {
  return contextPve()
}

export function productionHardwareDeps(): HardwareDeps {
  const pve = () => pveFromEnv()
  return {
    async nodes() { return ((await pve().getNodes()) as any[]).filter(n => n.status === 'online').map(n => n.node).sort() },
    async addresses() {
      const names = ((await pve().getNodes().catch(() => [])) as any[]).map(n => n.node)
      return addressesInContext(names, async () => {
        const rows = await pve().fetchNode<any[]>('/cluster/status').catch(() => [])
        const out: Record<string, string> = {}
        for (const r of rows ?? []) if (r?.type === 'node' && r.name && r.ip) out[r.name] = r.ip
        return out
      })
    },
    pci: node => pve().fetchNode<any[]>(`/nodes/${node}/hardware/pci`).catch(() => []),
    login: node => nodeCredential(node).catch(() => null),
    async exec(host, cred, script, timeoutMs = 15 * 60_000) {
      // A remote node's host key must be one the owner confirmed: the probe is read-only, but it is a root login.
      const r = await execOnNode({ host, cred, command: 'bash -s', input: script, timeoutMs, requirePin: isRemoteContext() })
      return { code: r.code, output: r.output }
    },
    async metrics(addr, port) {
      try {
        const h = addr.includes(':') ? `[${addr}]` : addr
        const res = await fetch(`http://${h}:${port}/metrics`, { signal: AbortSignal.timeout(4000) })
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
      await auditCredentialUse('node_login.use', `node:${node}`, { purpose: 'hardware probe (read-only)', cluster: currentClusterId() })
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
    amdMetrics: m9100 ? (/^node_drm_gpu_busy_percent/m.test(m9100) ? 'on' : 'off') : null,
    nvidiaExporter: m9835 && /^nvidia_smi_memory_total_bytes/m.test(m9835) ? 'running' : 'absent',
    ...(cred ? { error: 'the node login did not work, so only what Proxmox reports is shown' } : {}),
  } as any)
}

/**
 * Every online node, one at a time (a probe is cheap, but this keeps SSH to one node at once).
 * `clusterId` scans that cluster; without it, the cluster this code already runs for (home by default).
 */
export async function detectCluster(deps?: HardwareDeps, opts: { useLogin?: boolean; clusterId?: string } = {}) {
  const run = async () => {
    const d = deps ?? productionHardwareDeps()
    const [names, addrs] = await Promise.all([d.nodes(), d.addresses()])
    const nodes: Array<NodeHardware & { error?: string }> = []
    for (const n of names) nodes.push(await detectNode(n, addrs[n] ?? n, d, opts))
    return { nodes, addresses: addrs, summary: shared.summarise(nodes) }
  }
  return opts.clusterId ? runInCluster(opts.clusterId, run) : run()
}

// GPU badges change only when hardware does: cache the Proxmox-only view for a few minutes, per cluster.
const badgeCache = new Map<string, { at: number; data: Array<{ node: string; gpus: shared.Gpu[] }> }>()
export async function gpuBadges(deps: HardwareDeps = productionHardwareDeps(), ttlMs = 5 * 60_000) {
  const key = currentClusterId()
  const hit = badgeCache.get(key)
  if (hit && Date.now() - hit.at < ttlMs) return hit.data
  const names = await deps.nodes()
  const data = await Promise.all(names.map(async node => ({ node, gpus: shared.classifyPci(await deps.pci(node)) })))
  badgeCache.set(key, { at: Date.now(), data })
  return data
}
export function resetGpuBadgeCache(): void { badgeCache.clear() }

// =============================================================================
//  What a GPU can really decode
// =============================================================================

/** Read-only: vainfo on each render node, when vainfo is installed. Nothing is installed to run it. */
export const VAINFO_SCRIPT = [
  'command -v vainfo >/dev/null 2>&1 || { echo "HPX-VAINFO-ABSENT"; exit 0; }',
  'for d in /dev/dri/renderD*; do',
  '  [ -e "$d" ] || continue',
  '  echo "HPX-VAINFO-BEGIN $d"',
  '  timeout 15 vainfo --display drm --device "$d" 2>&1 | head -120',
  '  echo "HPX-VAINFO-END"',
  'done',
].join('\n')

export interface VaInfo { device: string; driver: string | null; decode: string[]; encode: string[] }

const CODEC_WORDS: Array<[RegExp, string]> = [
  [/^VAProfileH264/, 'H.264'],
  [/^VAProfileHEVCMain10/, 'HEVC 10-bit'],
  [/^VAProfileHEVC/, 'HEVC'],
  [/^VAProfileVP9/, 'VP9'],
  [/^VAProfileAV1/, 'AV1'],
  [/^VAProfileMPEG2/, 'MPEG-2'],
  [/^VAProfileVC1/, 'VC-1'],
  [/^VAProfileJPEG/, 'JPEG'],
]

/** Parse VAINFO_SCRIPT output into what each render node decodes and encodes. */
export function parseVainfo(text: string): { installed: boolean; devices: VaInfo[] } {
  if (/HPX-VAINFO-ABSENT/.test(text)) return { installed: false, devices: [] }
  const devices: VaInfo[] = []
  let cur: VaInfo | null = null
  for (const line of String(text ?? '').split('\n')) {
    const b = /^HPX-VAINFO-BEGIN (\S+)/.exec(line)
    if (b) { cur = { device: b[1], driver: null, decode: [], encode: [] }; continue }
    if (/^HPX-VAINFO-END/.test(line)) { if (cur) devices.push(cur); cur = null; continue }
    if (!cur) continue
    const drv = /Driver version:\s*(.+)$/.exec(line)
    if (drv) { cur.driver = drv[1].trim().slice(0, 160); continue }
    const m = /^\s*(VAProfile\w+)\s*:\s*(VAEntrypoint\w+)/.exec(line)
    if (!m) continue
    const word = CODEC_WORDS.find(([re]) => re.test(m[1]))?.[1]
    if (!word) continue
    const list = /VLD/.test(m[2]) ? cur.decode : /Enc/.test(m[2]) ? cur.encode : null
    if (list && !list.includes(word)) list.push(word)
  }
  return { installed: true, devices }
}

export interface GpuCapability { summary: string; source: 'vainfo' | 'estimate'; decode: string[]; encode: string[] }

/**
 * Plain words for what a GPU is good for. From vainfo when HyperProx could run it; otherwise an estimate from
 * the model, said to be one.
 */
export function gpuCapability(g: shared.Gpu, va?: VaInfo | null): GpuCapability {
  const brand = g.vendor === 'amd' ? 'AMD' : g.vendor === 'nvidia' ? 'NVIDIA' : 'Intel'
  if (va && (va.decode.length || va.encode.length)) {
    const dec = va.decode.length ? `decodes ${va.decode.join(', ')}` : 'decodes nothing VA-API can see'
    const enc = va.encode.length ? `encodes ${va.encode.join(', ')}` : 'does not encode'
    return { summary: `${brand}: ${dec}; ${enc} (checked with vainfo on that server).`, source: 'vainfo', decode: va.decode, encode: va.encode }
  }
  const n = g.name
  const est = (summary: string, decode: string[], encode: string[]): GpuCapability => ({ summary: `${summary} (an estimate from the model; a saved node login lets HyperProx check with vainfo).`, source: 'estimate', decode, encode })
  if (g.vendor === 'amd') {
    if (/fury|fiji|nano\b/i.test(n)) return est('AMD, older generation: good for H.264, decodes HEVC, does not encode HEVC', ['H.264', 'HEVC'], ['H.264'])
    if (/\b(R[579] ?\d{3}X?|HD ?[5-8]\d{3})\b|tonga|hawaii|tahiti|pitcairn|bonaire|oland|cape verde|curacao|antigua|grenada/i.test(n))
      return est('AMD, older generation: good for H.264, likely not HEVC', ['H.264'], ['H.264'])
    if (/\bRX ?[45]\d0\b|polaris|ellesmere|baffin|lexa/i.test(n)) return est('AMD: H.264 and HEVC, decode and encode', ['H.264', 'HEVC', 'HEVC 10-bit'], ['H.264', 'HEVC'])
    if (/vega|navi|\bRX ?[5-9]\d{3}\b|raphael|rembrandt|phoenix|renoir|cezanne|barcelo|lucienne|picasso|raven/i.test(n)) return est('AMD, newer generation: H.264 and HEVC, decode and encode', ['H.264', 'HEVC', 'HEVC 10-bit', 'VP9'], ['H.264', 'HEVC'])
    return est('AMD: what it decodes is unknown from the name alone', [], [])
  }
  if (g.vendor === 'nvidia') {
    if (/\b(GTX ?(9[5-9]0|10\d0|16\d0)|RTX|Quadro P|Tesla P|A\d{3,4})\b/i.test(n)) return est('NVIDIA: H.264 and HEVC, decode and encode', ['H.264', 'HEVC'], ['H.264', 'HEVC'])
    return est('NVIDIA: what it decodes is unknown from the name alone', [], [])
  }
  return est('Intel built-in graphics (Quick Sync): what it decodes depends on its generation', [], [])
}
