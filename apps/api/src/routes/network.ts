import { FastifyPluginAsync } from 'fastify'
import { getClusterNetworkStats } from '../lib/network'
import { ProxmoxClient }          from '../lib/proxmox-client'
import { PLUGINS }                from '../plugins'
import { runPluginBandwidth, type PluginLink } from '../lib/plugin-host'

export const networkRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/stats', async (_, reply) => {
    try {
      const host    = process.env.PROXMOX_HOST!
      const port    = Number(process.env.PROXMOX_PORT ?? 8006)
      const tokenId = `${process.env.PROXMOX_USER}!${process.env.PROXMOX_TOKEN_ID}`
      const secret  = process.env.PROXMOX_TOKEN_SECRET!

      const pve      = new ProxmoxClient(host, port, tokenId, secret)
      const nodes    = await pve.getNodes()
      const nodeNames = nodes.map(n => n.node)

      const stats = await getClusterNetworkStats(host, port, tokenId, secret, nodeNames)
      return { success: true, data: stats }
    } catch (e: any) {
      return reply.status(500).send({ success: false, error: e.message })
    }
  })

  /**
   * GET /bandwidth — live WAN and LAN throughput, from whichever plug-in can see it.
   *
   * The cluster's own netin/netout, which /stats already reports, is only the
   * traffic Proxmox itself moves. It cannot tell you the house is saturating
   * the uplink, because none of that goes near a node. The router can, so the
   * router is asked — through the plug-in broker, so no credential reaches this
   * route and adding a second brand of router means writing a plug-in, not
   * editing this file.
   */
  fastify.get('/bandwidth', async (_, reply) => {
    const links: Array<PluginLink & { source: string }> = []
    const unavailable: Array<{ plugin: string; reason: string }> = []

    for (const plugin of PLUGINS.filter(p => p.bandwidth)) {
      try {
        const read = await runPluginBandwidth(plugin)
        for (const link of read) links.push({ ...link, source: plugin.manifest.id })
      } catch (e: any) {
        // A plug-in that is not set up is not an error here — the panel just
        // has nothing to draw, and should say which plug-in would fill it.
        unavailable.push({ plugin: plugin.manifest.name, reason: e.message })
      }
    }

    return reply.send({ success: true, data: { links, unavailable, at: Date.now() } })
  })
}
