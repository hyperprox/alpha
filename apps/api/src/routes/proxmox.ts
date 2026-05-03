// =============================================================================
//  HyperProx — Proxmox Routes (with GPU + NPM + cluster totals)
// =============================================================================

import { FastifyPluginAsync } from 'fastify'
import { ProxmoxClient }      from '../lib/proxmox-client'
import { getGPUInfo }         from '../lib/gpu'
import { NPMClient }          from '../lib/npm-client'

let client: ProxmoxClient | null = null
let npmClient: NPMClient | null  = null

function getClient(): ProxmoxClient {
  if (!client) {
    const host   = process.env.PROXMOX_HOST!
    const port   = Number(process.env.PROXMOX_PORT ?? 8006)
    const token  = `${process.env.PROXMOX_USER}!${process.env.PROXMOX_TOKEN_ID}`
    const secret = process.env.PROXMOX_TOKEN_SECRET!
    if (!host || !secret) throw new Error('PROXMOX_HOST and PROXMOX_TOKEN_SECRET must be set')
    client = new ProxmoxClient(host, port, token, secret)
  }
  return client
}

function getNPM(): NPMClient | null {
  try {
    if (!npmClient) {
      const url      = process.env.NPM_URL
      const email    = process.env.NPM_EMAIL
      const password = process.env.NPM_PASSWORD
      if (!url || !email || !password) return null
      npmClient = new NPMClient(url, email, password)
    }
    return npmClient
  } catch { return null }
}

const wrap = async (reply: any, fn: () => Promise<any>) => {
  try   { return { success: true, data: await fn() } }
  catch (e: any) { return reply.status(500).send({ success: false, error: e.message }) }
}

export const proxmoxRoutes: FastifyPluginAsync = async (fastify) => {

  fastify.get('/ping',      async (_, r) => wrap(r, () => getClient().ping()))
  fastify.get('/nodes',     async (_, r) => wrap(r, () => getClient().getNodes()))
  fastify.get('/resources', async (_, r) => wrap(r, () => getClient().getClusterResources()))
  fastify.get('/storage',   async (_, r) => wrap(r, () => getClient().getAllStorage()))
  fastify.get('/ha',        async (_, r) => wrap(r, () => getClient().getHAStatus()))
  fastify.get('/ha/resources', async (_, r) => wrap(r, () => getClient().getHAResources()))
  fastify.get('/gpu',       async (_, r) => wrap(r, () => getGPUInfo()))

  fastify.get<{ Params: { node: string } }>('/nodes/:node', async (req, r) =>
    wrap(r, () => getClient().getNodeStatus(req.params.node)))

  fastify.get<{ Params: { node: string } }>('/nodes/:node/tasks', async (req, r) =>
    wrap(r, () => getClient().getNodeTasks(req.params.node)))

  fastify.get('/vms', async (_, r) => {
    const vms = await getClient().getAllVMs()
    return { success: true, data: vms, meta: { total: vms.length } }
  })

  fastify.get('/ceph/status', async (_, r) =>
    wrap(r, () => getClient().getCephStatus(process.env.CEPH_MON_NODE ?? '')))

  fastify.get('/ceph/osds', async (_, r) =>
    wrap(r, () => getClient().getCephOSDs(process.env.CEPH_MON_NODE ?? '')))

  fastify.get('/ceph/pools', async (_, r) =>
    wrap(r, () => getClient().getCephPools(process.env.CEPH_MON_NODE ?? '')))

  // POST /api/proxmox/vms/:node/:vmid/:type/:action
  fastify.post<{
    Params: { node: string; vmid: string; type: 'qemu' | 'lxc'; action: 'start' | 'stop' | 'reboot' | 'shutdown' }
  }>('/vms/:node/:vmid/:type/:action', async (req, r) => {
    const { node, vmid, type, action } = req.params
    return wrap(r, () => getClient().vmAction(node, Number(vmid), type, action))
  })

  // ==========================================================================
  //  SUMMARY — single call, everything the dashboard needs
  // ==========================================================================

  // ── CT/VM Creation ───────────────────────────────────────────────────────────
  fastify.get('/isos', async (_, r) =>
    wrap(r, () => getClient().getISOs()))

  fastify.get<{ Params: { node: string } }>('/nodes/:node/aplinfo', async (req, r) =>
    wrap(r, () => getClient().getDownloadableTemplates(req.params.node)))

  fastify.post<{ Body: { node: string; storage: string; template: string } }>('/templates/download', async (req, r) =>
    wrap(r, () => getClient().downloadTemplate(req.body.node, req.body.storage, req.body.template)))

  fastify.delete<{ Params: { node: string; vmid: string; type: string } }>('/nodes/:node/:type/:vmid', async (req, r) =>
    wrap(r, () => {
      const vmid = Number(req.params.vmid)
      if (req.params.type === 'lxc') return getClient().deleteLXC(req.params.node, vmid)
      if (req.params.type === 'qemu') return getClient().deleteVM(req.params.node, vmid)
      throw new Error(`Unknown type: ${req.params.type}`)
    }))


  fastify.get('/templates', async (_, r) =>
    wrap(r, () => getClient().getTemplates()))

  fastify.get('/nextid', async (_, r) =>
    wrap(r, () => getClient().getNextVMID()))

  fastify.post<{ Body: { node: string; params: any } }>('/lxc', async (req, r) =>
    wrap(r, () => getClient().createLXC(req.body.node, req.body.params)))

  fastify.post<{ Body: { node: string; params: any } }>('/vm', async (req, r) =>
    wrap(r, () => getClient().createVM(req.body.node, req.body.params)))


  fastify.get('/summary', async (_, r) => {
    try {
      const npm = getNPM()

      // Get VMs first so GPU consumer lookup can resolve CT names
      const [nodesR, vmsR] = await Promise.allSettled([
        getClient().getNodes(),
        getClient().getAllVMs(),
      ])
      const vmList = vmsR.status === 'fulfilled' ? vmsR.value : undefined

      const [cephR, osdR, haR, storageR, gpuR, npmR] = await Promise.allSettled([
        getClient().getCephStatus(process.env.CEPH_MON_NODE ?? ''),
        getClient().getCephOSDs(process.env.CEPH_MON_NODE ?? ''),
        getClient().getHAStatus(),
        getClient().getAllStorage(),
        getGPUInfo(vmList),
        npm ? npm.getStats() : Promise.resolve(null),
      ])

      const nodes   = nodesR.status   === 'fulfilled' ? nodesR.value   : []
      const vms     = vmsR.status     === 'fulfilled' ? vmsR.value     : []
      const ceph    = cephR.status    === 'fulfilled' ? cephR.value    : null
      const osds    = osdR.status     === 'fulfilled' ? osdR.value     : []
      const ha      = haR.status      === 'fulfilled' ? haR.value      : []
      const storage = storageR.status === 'fulfilled' ? storageR.value : []
      const gpu     = gpuR.status     === 'fulfilled' ? gpuR.value     : null
      const npmStats = npmR.status    === 'fulfilled' ? npmR.value     : null

      // Cluster totals — aggregate across all nodes
      const clusterTotals = nodes.reduce((acc, n) => ({
        cpu_used:  acc.cpu_used  + (n.cpu * n.maxcpu),
        cpu_total: acc.cpu_total + n.maxcpu,
        mem_used:  acc.mem_used  + n.mem,
        mem_total: acc.mem_total + n.maxmem,
        disk_used: acc.disk_used + n.disk,
        disk_total:acc.disk_total+ n.maxdisk,
      }), { cpu_used: 0, cpu_total: 0, mem_used: 0, mem_total: 0, disk_used: 0, disk_total: 0 })

      return {
        success: true,
        data: {
          nodes, vms, ceph, osds, ha, storage, gpu,
          cluster: {
            ...clusterTotals,
            cpu_pct:  clusterTotals.cpu_total  ? Math.round((clusterTotals.cpu_used  / clusterTotals.cpu_total)  * 100) : 0,
            mem_pct:  clusterTotals.mem_total  ? Math.round((clusterTotals.mem_used  / clusterTotals.mem_total)  * 100) : 0,
            disk_pct: clusterTotals.disk_total ? Math.round((clusterTotals.disk_used / clusterTotals.disk_total) * 100) : 0,
          },
          services: {
            npm: npmStats ? {
              connected: true,
              url:       process.env.NPM_URL,
              ...npmStats,
            } : { connected: false },
          },
        },
      }
    } catch (e: any) {
      return r.status(500).send({ success: false, error: e.message })
    }
  })
}
