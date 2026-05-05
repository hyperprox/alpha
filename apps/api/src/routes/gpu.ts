// =============================================================================
//  HyperProx — GPU Detection & Classification
// =============================================================================
import { FastifyPluginAsync } from 'fastify'
import { getProviderCredentials } from '../lib/credentials'
import { ProxmoxClient } from '../lib/proxmox-client'

export type GPUType = 'nvidia' | 'amd' | 'intel-igpu' | 'intel-arc' | 'unknown'

export interface NodeGPU {
  node:        string
  type:        GPUType
  vendor:      string
  vendorName:  string
  deviceName:  string
  deviceId:    string
  pciId:       string
  dedicated:   boolean   // false = iGPU
}

function classifyGPU(pci: any): GPUType {
  const vendor = pci.vendor?.toLowerCase()
  const device = parseInt(pci.device, 16)

  if (vendor === '0x10de') return 'nvidia'
  if (vendor === '0x1002') return 'amd'
  if (vendor === '0x8086') {
    // Intel Arc dedicated GPUs: device IDs 0x5690+ (Alchemist)
    if (device >= 0x5690) return 'intel-arc'
    return 'intel-igpu'
  }
  return 'unknown'
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

export async function detectNodeGPUs(nodeName: string, client: ProxmoxClient): Promise<NodeGPU[]> {
  try {
    const pciDevices = await client.fetchNode<any[]>(`/nodes/${nodeName}/hardware/pci`)
    const gpuDevices = pciDevices.filter((d: any) => d.class?.startsWith('0x03'))

    return gpuDevices.map((pci: any) => {
      const type = classifyGPU(pci)
      return {
        node:       nodeName,
        type,
        vendor:     pci.vendor,
        vendorName: pci.vendor_name,
        deviceName: pci.device_name,
        deviceId:   pci.device,
        pciId:      pci.id,
        dedicated:  type !== 'intel-igpu',
      }
    })
  } catch {
    return []
  }
}

const wrap = async (reply: any, fn: () => Promise<any>) => {
  try   { return { success: true, data: await fn() } }
  catch (e: any) { return reply.status(500).send({ success: false, error: e.message }) }
}

export const gpuRoutes: FastifyPluginAsync = async (fastify) => {

  // GET /api/gpu — all GPUs across all nodes
  fastify.get('/', async (_, r) => wrap(r, async () => {
    const client = await getProxmoxClient()
    const nodes  = await client.getNodes()
    const results = await Promise.all(
      nodes.map((n: any) => detectNodeGPUs(n.node, client))
    )
    return results.flat()
  }))

  // GET /api/gpu/:node — GPUs for a specific node
  fastify.get('/:node', async (req: any, r) => wrap(r, async () => {
    const client = await getProxmoxClient()
    return detectNodeGPUs(req.params.node, client)
  }))

}
