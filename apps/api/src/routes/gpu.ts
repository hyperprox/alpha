// =============================================================================
//  HyperProx — GPUs on every node
//
//  Classified by @hyperprox/hardware (the same probe bootstrap.sh and the setup wizard use), so a GPU is
//  "built in" or "dedicated" for the same reason everywhere. Badges on Infrastructure come from here;
//  nobody types a list of GPU nodes into .env any more. Exporters are installed from
//  Settings → Setup checklist, never from copy-paste commands.
// =============================================================================
import { FastifyPluginAsync } from 'fastify'
import * as net from 'net'
import { getProviderCredentials } from '../lib/credentials'
import { ProxmoxClient } from '../lib/proxmox-client'
import { hardware, gpuBadges } from '../lib/hardware'
import { answerData } from '../lib/http/answer'
import { livePromQuery } from '../lib/clusters/overview'
import { readGpuLive, gpuGuests, withLiveAndGuests, withNodeFromAddress, type LiveFigures, type GuestsByKind } from '../lib/gpu-live'

export type GPUType = 'nvidia' | 'amd' | 'intel-igpu' | 'intel-arc' | 'unknown'

export interface NodeGPU {
  node:        string
  type:        GPUType
  vendor:      string
  deviceName:  string
  deviceId:    string
  pciId:       string
  dedicated:   boolean   // false = built in (iGPU or APU graphics)
}

function typeOf(g: { vendor: string; kind: string }): GPUType {
  if (g.vendor === 'nvidia') return 'nvidia'
  if (g.vendor === 'amd') return 'amd'
  if (g.vendor === 'intel') return g.kind === 'integrated' ? 'intel-igpu' : 'intel-arc'
  return 'unknown'
}

async function getProxmoxClient(): Promise<ProxmoxClient> {
  const creds = await getProviderCredentials('proxmox', 'proxmox')
  return new ProxmoxClient(creds.host, Number(creds.port ?? 8006), `${creds.user ?? 'root@pam'}!${creds.token_id}`, creds.token_secret)
}

export async function detectNodeGPUs(nodeName: string, client: ProxmoxClient): Promise<NodeGPU[]> {
  try {
    const pci = await client.fetchNode<any[]>(`/nodes/${nodeName}/hardware/pci`)
    const displays = pci.filter((d: any) => /^0x03/i.test(String(d.class ?? '')))
    return hardware.classifyPci(displays).map((g, i) => ({
      node: nodeName, type: typeOf(g), vendor: g.vendor, deviceName: g.name, deviceId: g.id.split(':')[1] ?? '',
      pciId: displays.find((d: any) => `${String(d.vendor).replace(/^0x/, '')}:${String(d.device).replace(/^0x/, '')}`.toLowerCase() === g.id)?.id ?? displays[i]?.id ?? '',
      dedicated: g.kind === 'dedicated',
    }))
  } catch {
    return []
  }
}


// Where each vendor's figures are served. AMD's come from node_exporter's drm collector, on its own port.
const EXPORTER_PORTS: Record<GPUType, number> = { nvidia: 9835, amd: 9100, 'intel-igpu': 8081, 'intel-arc': 8081, unknown: 0 }
const SETUP_HINT = { title: 'Not monitored yet', steps: ['Open Settings → Setup checklist and answer yes to "Do you want HyperProx to monitor your GPUs?". HyperProx installs the exporter for you.'] }

export const gpuRoutes: FastifyPluginAsync = async (fastify) => {

  // GET /api/gpu — all GPUs across all nodes
  fastify.get('/', async (_, r) => answerData(r, async () => {
    const client = await getProxmoxClient()
    const nodes  = await client.getNodes()
    return (await Promise.all(nodes.map((n: any) => detectNodeGPUs(n.node, client)))).flat()
  }))

  // GET /api/gpu/badges — [{ node, gpus: [{ vendor, kind, name }] }] for the Infrastructure badges
  fastify.get('/badges', async (_, r) => answerData(r, () => gpuBadges()))

  // GET /api/gpu/:node — GPUs for a specific node
  fastify.get('/:node', async (req: any, r) => answerData(r, async () => detectNodeGPUs(req.params.node, await getProxmoxClient())))

  // GET /api/gpu/:node/metrics-status — is its exporter answering
  fastify.get('/:node/metrics-status', async (req: any, r) => answerData(r, async () => {
    const client = await getProxmoxClient()
    const addrs = await nodeAddresses(client)
    return statusFor(req.params.node, client, addrs, await extras(client, [req.params.node], addrs))
  }))

  // GET /api/gpu/all/metrics-status — every node
  fastify.get('/all/metrics-status', async (_, r) => answerData(r, async () => {
    const client = await getProxmoxClient()
    const [nodes, addrs] = await Promise.all([client.getNodes(), nodeAddresses(client)])
    const names: string[] = nodes.map((n: any) => n.node)
    const found = await Promise.all(names.map(n => detectNodeGPUs(n, client)))
    const withGpu = names.filter((_, i) => found[i].length > 0)
    const more = await extras(client, withGpu, addrs)
    return Promise.all(names.map((n, i) => statusFor(n, client, addrs, more, found[i])))
  }))
}

interface Extras { live: LiveFigures | null; guests: Record<string, GuestsByKind> | null }

/** Live figures and guests, read once for every node asked about. Either is null when it could not be read. */
async function extras(client: ProxmoxClient, nodes: string[], addrs: Record<string, string>): Promise<Extras> {
  const byAddr: Record<string, string> = {}
  for (const [n, a] of Object.entries(addrs)) byAddr[a] = n
  const [live, guests] = await Promise.all([
    readGpuLive(withNodeFromAddress(livePromQuery, byAddr)).catch(() => null),
    nodes.length ? gpuGuests(client, nodes).catch(() => null) : Promise.resolve(null),
  ])
  return { live, guests }
}

async function statusFor(node: string, client: ProxmoxClient, addrs: Record<string, string>, more: Extras, found?: NodeGPU[]) {
  const gpus = found ?? await detectNodeGPUs(node, client)
  if (!gpus.length) return { node, reachable: false, gpus: [], install: null }
  const gpu = gpus.find(g => EXPORTER_PORTS[g.type]) ?? gpus[0]
  const port = EXPORTER_PORTS[gpu.type]
  const rich = (list: NodeGPU[], reachable: boolean) => withLiveAndGuests(list, reachable ? more.live : null, more.guests)
  if (!port) return { node, reachable: false, gpus: rich(gpus, false), port: null, install: SETUP_HINT }
  const reachable = await reachableAt(addrs[node] ?? node, port)
  return { node, reachable, gpus: rich(gpus, reachable), port, install: reachable ? null : SETUP_HINT }
}

/** Node name to the address it answers on: names do not reliably resolve from a container. */
async function nodeAddresses(client: any): Promise<Record<string, string>> {
  try {
    const map: Record<string, string> = {}
    for (const row of await client.fetchNode('/cluster/status')) if (row?.type === 'node' && row.name && row.ip) map[row.name] = row.ip
    return map
  } catch { return {} }
}

function reachableAt(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const s = new net.Socket()
    s.setTimeout(3000)
    s.on('connect', () => { s.destroy(); resolve(true) })
    s.on('timeout', () => { s.destroy(); resolve(false) })
    s.on('error', () => { s.destroy(); resolve(false) })
    s.connect(port, host)
  })
}
