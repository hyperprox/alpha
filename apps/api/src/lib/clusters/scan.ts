// =============================================================================
//  HyperProx — the hardware scan for one cluster, in plain words
//
//  With the token alone: Proxmox's PCI list names the GPUs, exporters are asked over the network, and anything
//  else is "unknown". With a saved node login (host key confirmed): the full read-only probe, plus vainfo on
//  each render node when vainfo is installed, so the answer says what the card really decodes. Nothing is
//  installed or changed by a scan.
// =============================================================================

import { detectCluster, productionHardwareDeps, gpuCapability, parseVainfo, VAINFO_SCRIPT, type HardwareDeps, type VaInfo } from '../hardware'
import { runInCluster, currentClusterId } from './context'
import { auditCredentialUse } from '../audit'

export interface ScannedGpu { name: string; vendor: string; kind: string; capability: string; checkedWith: 'vainfo' | 'estimate'; decode: string[]; encode: string[] }
export interface ScannedNode {
  node: string
  address: string | null
  source: 'probe' | 'proxmox-api'
  gpus: ScannedGpu[]
  nodeExporter: string
  amdMetrics: string
  vainfo: 'checked' | 'not-installed' | 'no-login' | 'failed'
  note?: string
}

const words = (v: string | null | undefined, unknown = 'unknown') => (v === null || v === undefined ? unknown : v)

export async function scanCluster(clusterId: string, opts: { useLogin: boolean; deps?: HardwareDeps }): Promise<{ nodes: ScannedNode[]; summary: string }> {
  return runInCluster(clusterId, async () => {
    const deps = opts.deps ?? productionHardwareDeps()
    const det = await detectCluster(deps, { useLogin: opts.useLogin })
    const out: ScannedNode[] = []
    for (const n of det.nodes) {
      const node = String(n.node)
      const addr = det.addresses[node] ?? null
      let va: VaInfo[] = []
      let vainfo: ScannedNode['vainfo'] = 'no-login'
      if (opts.useLogin && addr && n.source === 'probe' && n.gpus.length) {
        const cred = await deps.login(node)
        if (cred) {
          try {
            await auditCredentialUse('node_login.use', `node:${node}`, { purpose: 'vainfo (read-only)', cluster: currentClusterId() })
            const r = await deps.exec(addr, cred, VAINFO_SCRIPT, 60_000)
            const parsed = parseVainfo(r.output)
            vainfo = parsed.installed ? 'checked' : 'not-installed'
            va = parsed.devices
          } catch { vainfo = 'failed' }
        }
      }
      out.push({
        node, address: addr, source: n.source,
        gpus: n.gpus.map((g, i) => {
          // One render node: it is this GPU's. Several: the one whose driver names this vendor, else by order.
          const vendorRe = g.vendor === 'amd' ? /amd|radeon/i : g.vendor === 'intel' ? /intel|iHD|i965/i : /nvidia|nouveau/i
          const match = va.length === 1 ? va[0] : (va.find(v => vendorRe.test(v.driver ?? '')) ?? va[i] ?? null)
          const cap = gpuCapability(g, match)
          return { name: g.name, vendor: g.vendor, kind: g.kind, capability: cap.summary, checkedWith: cap.source, decode: cap.decode, encode: cap.encode }
        }),
        nodeExporter: words(n.nodeExporter, 'unknown'),
        amdMetrics: words(n.amdMetrics, 'unknown'),
        vainfo: n.gpus.length ? vainfo : 'no-login',
        ...(addr ? {} : { note: 'No address is saved for this node, so HyperProx cannot reach it directly. Add one on the Edit page.' }),
        ...((n as any).error ? { note: (n as any).error } : {}),
      })
    }
    return { nodes: out, summary: det.summary }
  })
}
