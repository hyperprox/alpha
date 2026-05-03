import { FastifyPluginAsync } from 'fastify'
import { getClusterNetworkStats } from '../lib/network'
import { ProxmoxClient }          from '../lib/proxmox-client'

export const networkRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/stats', async (_, reply) => {
    try {
      const host    = process.env.PROXMOX_HOST!
      const port    = Number(process.env.PROXMOX_PORT ?? 8006)
      const tokenId = `${process.env.PROXMOX_USER}!${process.env.PROXMOX_TOKEN_ID}`
      const secret  = process.env.PROXMOX_TOKEN_SECRET!
      const cephMon = process.env.CEPH_MON_NODE ?? ''

      const pve      = new ProxmoxClient(host, port, tokenId, secret)
      const nodes    = await pve.getNodes()
      const nodeNames = nodes.map(n => n.node)

      const stats = await getClusterNetworkStats(host, port, tokenId, secret, nodeNames, cephMon)
      return { success: true, data: stats }
    } catch (e: any) {
      return reply.status(500).send({ success: false, error: e.message })
    }
  })
}
