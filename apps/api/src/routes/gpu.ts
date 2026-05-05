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

  // GET /api/gpu/:node/metrics-status — check if exporter is reachable
  fastify.get("/:node/metrics-status", async (req: any, r) => wrap(r, async () => {
    const client  = await getProxmoxClient()
    const gpus    = await detectNodeGPUs(req.params.node, client)
    if (!gpus.length) return { reachable: false, gpus: [], install: null }
    const gpu     = gpus[0]
    const port    = EXPORTER_PORTS[gpu.type]
    
    const nodes   = await client.getNodes()
    
    const nodeIp  = req.params.node
    const reachable = await checkExporterReachable(nodeIp, port)
    return { reachable, gpus, port, install: reachable ? null : EXPORTER_INSTALL[gpu.type] }
  }))

  // GET /api/gpu/all/metrics-status — check all nodes
  fastify.get("/all/metrics-status", async (_, r) => wrap(r, async () => {
    const client  = await getProxmoxClient()
    const nodes   = await client.getNodes()
    const results = await Promise.all(nodes.map(async (n: any) => {
      const gpus      = await detectNodeGPUs(n.node, client)
      if (!gpus.length) return { node: n.node, reachable: false, gpus: [], install: null }
      const gpu       = gpus[0]
      const port      = EXPORTER_PORTS[gpu.type]
      const reachable = await checkExporterReachable(n.node, port)
      return { node: n.node, reachable, gpus, port, install: reachable ? null : EXPORTER_INSTALL[gpu.type] }
    }))
    return results
  }))

}

// ── Exporter port map ─────────────────────────────────────────────────────────
const EXPORTER_PORTS: Record<GPUType, number> = {
  'nvidia':     9835,
  'amd':        9100,
  'intel-igpu': 8081,
  'intel-arc':  8081,
  'unknown':    0,
}

const EXPORTER_INSTALL: Record<GPUType, { title: string; steps: string[] }> = {
  'nvidia': {
    title: 'Install NVIDIA SMI Exporter',
    steps: [
      "curl -fsSL https://get.docker.com | sh",
      "systemctl enable docker --now",
      "docker run -d --name nvidia-smi-exporter --restart unless-stopped --runtime nvidia -p 9835:9835 utkuozdemir/nvidia_gpu_exporter:1.1.0",
    ]
  },
  'amd': {
    title: 'Install ROCm SMI Exporter',
    steps: [
      "apt-get update && apt-get install -y rocm-smi curl",
      "curl -fsSL https://get.docker.com | sh",
      "systemctl enable docker --now",
      "docker run -d --name rocm-smi-exporter --restart unless-stopped --device /dev/kfd --device /dev/dri -p 9915:9915 amdgpu/rocm_smi_exporter:latest",
    ]
  },
  'intel-igpu': {
    title: 'Install Intel GPU Exporter',
    steps: [
      'apt-get update && apt-get install -y intel-gpu-tools curl gnupg',
      'curl -fsSL https://get.docker.com | sh',
      'systemctl enable docker --now',
      'docker run -d --name intel-gpu-exporter --restart unless-stopped --privileged --pid host -v /dev/dri:/dev/dri -p 8081:8080 ghcr.io/onedr0p/intel-gpu-exporter:rolling',
    ]
  },
  'intel-arc': {
    title: 'Install Intel GPU Exporter',
    steps: [
      'apt-get update && apt-get install -y intel-gpu-tools curl gnupg',
      'curl -fsSL https://get.docker.com | sh',
      'systemctl enable docker --now',
      'docker run -d --name intel-gpu-exporter --restart unless-stopped --privileged --pid host -v /dev/dri:/dev/dri -p 8081:8080 ghcr.io/onedr0p/intel-gpu-exporter:rolling',
    ]
  },
  'unknown': {
    title: 'Unknown GPU Type',
    steps: [ 'GPU type could not be determined. Manual exporter setup required.' ]
  }
}

async function checkExporterReachable(host: string, port: number): Promise<boolean> {
  if (!port) return false
  return new Promise((resolve) => {
    const net = require('net')
    const socket = new net.Socket()
    socket.setTimeout(3000)
    socket.on('connect', () => { socket.destroy(); resolve(true) })
    socket.on('timeout', () => { socket.destroy(); resolve(false) })
    socket.on('error',   () => { socket.destroy(); resolve(false) })
    socket.connect(port, host)
  })
}
