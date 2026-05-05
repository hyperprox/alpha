// =============================================================================
//  HyperProx — Prometheus Target Sync
//  Detects nodes, GPU types, and updates target files without wiping existing
// =============================================================================
import { FastifyPluginAsync } from 'fastify'
import { getProviderCredentials } from '../lib/credentials'
import { ProxmoxClient } from '../lib/proxmox-client'
import { detectNodeGPUs } from './gpu'
import * as fs from 'fs'
import * as path from 'path'

const TARGETS_DIR = '/opt/hyperprox/config/prometheus/targets'

function readTargets(file: string): any[] {
  try {
    const p = path.join(TARGETS_DIR, file)
    if (!fs.existsSync(p)) return []
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch { return [] }
}

function writeTargets(file: string, targets: any[]) {
  const p = path.join(TARGETS_DIR, file)
  fs.writeFileSync(p, JSON.stringify(targets, null, 2))
}

function mergeTargets(existing: any[], newTargets: any[]): { merged: any[]; added: string[]; skipped: string[] } {
  const added: string[] = []
  const skipped: string[] = []
  const merged = [...existing]

  for (const t of newTargets) {
    const node = t.labels?.node
    const target = t.targets?.[0]
    const exists = existing.some(e => e.labels?.node === node || e.targets?.[0] === target)
    if (!exists) {
      merged.push(t)
      added.push(node ?? target)
    } else {
      skipped.push(node ?? target)
    }
  }
  return { merged, added, skipped }
}

async function getProxmoxClient(): Promise<ProxmoxClient> {
  const creds = await getProviderCredentials('proxmox', 'proxmox')
  return new ProxmoxClient(
    creds.host,
    Number(creds.port ?? 8006),
    `${creds.user ?? 'root@pam'}!${creds.token_id}`,
    creds.token_secret
  )
}

async function getNodeTailscaleIP(nodeName: string, client: ProxmoxClient): Promise<string | null> {
  try {
    const networks = await client.fetchNode<any[]>(`/nodes/${nodeName}/network`)
    // Look for Tailscale interface (tailscale0) first, then fall back to vmbr0
    const tailscale = networks.find((n: any) => n.iface === 'tailscale0' && n.address)
    if (tailscale) return tailscale.address
    const bridge = networks.find((n: any) => n.iface === 'vmbr0' && n.address)
    if (bridge) return bridge.address
    return null
  } catch { return null }
}

export const targetsRoutes: FastifyPluginAsync = async (fastify) => {

  // GET /api/targets/status — show current target files
  fastify.get('/status', async (_, r) => {
    try {
      return {
        success: true,
        data: {
          nodes:     readTargets('nodes.json'),
          pve:       readTargets('pve.json'),
          intelGpu:  readTargets('intel-gpu.json'),
          nvidiaGpu: readTargets('nvidia.json'),
          ceph:      readTargets('ceph.json'),
        }
      }
    } catch (e: any) {
      return r.status(500).send({ success: false, error: e.message })
    }
  })

  // POST /api/targets/sync — detect nodes and merge into target files
  fastify.post('/sync', async (_, r) => {
    try {
      const client = await getProxmoxClient()
      const nodes  = await client.getNodes()

      const newNodeTargets:    any[] = []
      const newPveTargets:     any[] = []
      const newIntelTargets:   any[] = []
      const newNvidiaTargets:  any[] = []

      for (const node of nodes) {
        const ip = await getNodeTailscaleIP(node.node, client)
        const addr = ip ?? node.node  // fall back to node name if no IP found

        // node_exporter target
        newNodeTargets.push({ targets: [`${addr}:9100`], labels: { node: node.node } })

        // pve-exporter target
        newPveTargets.push({ targets: [addr], labels: { node: node.node } })

        // GPU targets
        const gpus = await detectNodeGPUs(node.node, client)
        for (const gpu of gpus) {
          if (gpu.type === 'intel-igpu' || gpu.type === 'intel-arc') {
            newIntelTargets.push({ targets: [`${addr}:8081`], labels: { node: node.node } })
          } else if (gpu.type === 'amd') {
            newNodeTargets.push({ targets: [`${addr}:9100`], labels: { node: node.node } }) // AMD uses node_exporter with --collector.drm
          } else if (gpu.type === 'nvidia') {
            newNvidiaTargets.push({ targets: [`${addr}:9835`], labels: { node: node.node } })
          }
        }
      }

      // Merge into existing targets
      const nodeResult   = mergeTargets(readTargets('nodes.json'),    newNodeTargets)
      const pveResult    = mergeTargets(readTargets('pve.json'),       newPveTargets)
      const intelResult  = mergeTargets(readTargets('intel-gpu.json'), newIntelTargets)
      const nvidiaResult = mergeTargets(readTargets('nvidia.json'),    newNvidiaTargets)

      writeTargets('nodes.json',    nodeResult.merged)
      writeTargets('pve.json',      pveResult.merged)
      writeTargets('intel-gpu.json', intelResult.merged)
      writeTargets('nvidia.json',   nvidiaResult.merged)

      // Reload Prometheus
      try {
        await fetch('http://localhost:9090/-/reload', { method: 'POST' })
      } catch { /* Prometheus may not be running */ }

      return {
        success: true,
        data: {
          nodes:    { added: nodeResult.added,   skipped: nodeResult.skipped   },
          pve:      { added: pveResult.added,    skipped: pveResult.skipped    },
          intel:    { added: intelResult.added,  skipped: intelResult.skipped  },
          nvidia:   { added: nvidiaResult.added, skipped: nvidiaResult.skipped },
        }
      }
    } catch (e: any) {
      return r.status(500).send({ success: false, error: e.message })
    }
  })

}
