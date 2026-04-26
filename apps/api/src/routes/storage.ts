import { FastifyPluginAsync } from 'fastify'
import { ProxmoxClient }      from '../lib/proxmox-client'

function getClient() {
  return new ProxmoxClient(
    process.env.PROXMOX_HOST!,
    Number(process.env.PROXMOX_PORT ?? 8006),
    `${process.env.PROXMOX_USER}!${process.env.PROXMOX_TOKEN_ID}`,
    process.env.PROXMOX_TOKEN_SECRET!,
  )
}

const wrap = async (reply: any, fn: () => Promise<any>) => {
  try   { return { success: true, data: await fn() } }
  catch (e: any) { return reply.status(500).send({ success: false, error: e.message }) }
}

export const storageRoutes: FastifyPluginAsync = async (fastify) => {
  const pve = getClient()

  fastify.get('/overview', async (_, r) => {
    try {
      const cephMon = process.env.CEPH_MON_NODE ?? 'titan7'

      const [nodesR, cephStatusR, osdR, poolsR] = await Promise.allSettled([
        pve.getNodes(),
        pve.getCephStatus(cephMon),
        pve.getCephOSDs(cephMon),
        pve.fetchNode<any[]>(`/nodes/${cephMon}/ceph/pool`),
      ])

      const nodes = nodesR.status === 'fulfilled' ? nodesR.value : []
      const ceph  = cephStatusR.status === 'fulfilled' ? cephStatusR.value : null
      const osds  = osdR.status === 'fulfilled' ? osdR.value : []
      const pools = poolsR.status === 'fulfilled' ? poolsR.value : []

      // Fetch storage from titan7 only as the representative node
      // (shared storage is same across all nodes, local storage we show per-node separately)
      const titan7Storage = await pve.fetchNode<any[]>('/nodes/titan7/storage')
        .then(s => s.map((x: any) => ({ ...x, node: 'titan7' })))
        .catch(() => [])

      // For non-shared storage, fetch from each node separately
      const nonSharedByNode: Record<string, any[]> = {}
      await Promise.allSettled(
        nodes.map(async n => {
          const s = await pve.fetchNode<any[]>(`/nodes/${n.node}/storage`)
          nonSharedByNode[n.node] = s
            .filter((x: any) => x.shared === 0)
            .map((x: any) => ({ ...x, node: n.node }))
        })
      )

      // Shared storage — from titan7, deduplicated by name
      const sharedStorage = titan7Storage.filter((s: any) => s.shared === 1)

      // Non-shared — one entry per storage per node, grouped
      // For display: aggregate local-lvm across nodes as "local-lvm (5 nodes)"
      const nonSharedAggregated: any[] = []
      const nonSharedNames = new Set<string>()
      Object.values(nonSharedByNode).flat().forEach((s: any) => nonSharedNames.add(s.storage))

      nonSharedNames.forEach(name => {
        const instances = Object.values(nonSharedByNode).flat().filter((s: any) => s.storage === name)
        const totalUsed  = instances.reduce((sum, s) => sum + (s.used ?? 0), 0)
        const totalAvail = instances.reduce((sum, s) => sum + (s.avail ?? 0), 0)
        const totalSize  = instances.reduce((sum, s) => sum + (s.total ?? 0), 0)
        nonSharedAggregated.push({
          ...instances[0],
          used:     totalUsed,
          avail:    totalAvail,
          total:    totalSize,
          nodeCount: instances.length,
          nodes:    instances.map((s: any) => s.node),
          shared:   0,
        })
      })

      const storage = [...sharedStorage, ...nonSharedAggregated]
        .filter(s => s.total > 0)
        .sort((a, b) => (b.total - a.total))

      // Warnings
      const warnings: string[] = []
      storage.forEach(s => {
        const p = s.total > 0 ? Math.round((s.used / s.total) * 100) : 0
        if (p > 85) warnings.push(`${s.storage} is ${p}% full`)
      })
      pools.forEach((p: any) => {
        const pct = Math.round(p.percent_used * 100)
        if (pct > 85) warnings.push(`CEPH pool ${p.pool_name} is ${pct}% full`)
      })

      return { success: true, data: { storage, ceph, osds, pools, nodes, warnings } }
    } catch (e: any) {
      return r.status(500).send({ success: false, error: e.message })
    }
  })

  fastify.get<{ Params: { node: string } }>('/nodes/:node', async (req, r) =>
    wrap(r, () => pve.getStorage(req.params.node)))

  fastify.get('/ceph/status', async (_, r) =>
    wrap(r, () => pve.getCephStatus(process.env.CEPH_MON_NODE ?? 'titan7')))

  fastify.get('/ceph/osds', async (_, r) =>
    wrap(r, () => pve.getCephOSDs(process.env.CEPH_MON_NODE ?? 'titan7')))

  fastify.get('/ceph/pools', async (_, r) =>
    wrap(r, () => pve.fetchNode<any[]>(`/nodes/${process.env.CEPH_MON_NODE ?? 'titan7'}/ceph/pool`)))

  // GET /api/storage/vms-breakdown — disk allocation per VM/CT
  fastify.get('/vms-breakdown', async (_, r) =>
    wrap(r, () => pve.getVMStorageBreakdown()))

}