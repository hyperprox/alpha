import { getClusterNetworkStats } from './network'
// =============================================================================
//  HyperProx — WebSocket Broadcast Service
//  Fast channel (2s): nodes, vms, gpu, cluster totals
//  Slow channel (15s): ceph, ha, storage, services
// =============================================================================

import { FastifyInstance } from 'fastify'
import { ProxmoxClient }   from './proxmox-client'
import { getGPUInfo }      from './gpu'
import { NPMClient }       from './npm-client'

let fastInterval: ReturnType<typeof setInterval> | null = null
let slowInterval: ReturnType<typeof setInterval> | null = null

function getClient() {
  return new ProxmoxClient(
    process.env.PROXMOX_HOST!,
    Number(process.env.PROXMOX_PORT ?? 8006),
    `${process.env.PROXMOX_USER}!${process.env.PROXMOX_TOKEN_ID}`,
    process.env.PROXMOX_TOKEN_SECRET!,
  )
}

function getNPM(): NPMClient | null {
  if (!process.env.NPM_URL) return null
  return new NPMClient(process.env.NPM_URL, process.env.NPM_EMAIL!, process.env.NPM_PASSWORD!)
}

function broadcast(server: FastifyInstance, type: string, payload: any) {
  const msg = JSON.stringify({ type, payload, ts: Date.now() })
  // @ts-ignore
  const wss = server.websocketServer
  if (!wss) return
  wss.clients.forEach((client: any) => {
    if (client.readyState === 1) client.send(msg)
  })
}

export function startBroadcast(server: FastifyInstance) {
  const pve = getClient()
  const npm = getNPM()

  // ---------------------------------------------------------------------------
  //  FAST — every 2s: nodes + VMs + GPU + cluster totals
  // ---------------------------------------------------------------------------
  fastInterval = setInterval(async () => {
    try {
      const nodes = await pve.getNodes()
      const [vms, gpu, network] = await Promise.all([
        pve.getAllVMs(),
        getGPUInfo(undefined),
        getClusterNetworkStats(
          process.env.PROXMOX_HOST!,
          Number(process.env.PROXMOX_PORT ?? 8006),
          `${process.env.PROXMOX_USER}!${process.env.PROXMOX_TOKEN_ID}`,
          process.env.PROXMOX_TOKEN_SECRET!,
          nodes.map(n => n.node),
          process.env.CEPH_MON_NODE ?? '',
        ),
      ])

      const cluster = nodes.reduce((acc, n) => ({
        cpu_used:   acc.cpu_used   + (n.cpu * n.maxcpu),
        cpu_total:  acc.cpu_total  + n.maxcpu,
        mem_used:   acc.mem_used   + n.mem,
        mem_total:  acc.mem_total  + n.maxmem,
        disk_used:  acc.disk_used  + n.disk,
        disk_total: acc.disk_total + n.maxdisk,
      }), { cpu_used: 0, cpu_total: 0, mem_used: 0, mem_total: 0, disk_used: 0, disk_total: 0 })

      broadcast(server, 'fast', {
        nodes, vms, gpu, network,
        cluster: {
          ...cluster,
          cpu_pct:  cluster.cpu_total  ? Math.round((cluster.cpu_used  / cluster.cpu_total)  * 100) : 0,
          mem_pct:  cluster.mem_total  ? Math.round((cluster.mem_used  / cluster.mem_total)  * 100) : 0,
          disk_pct: cluster.disk_total ? Math.round((cluster.disk_used / cluster.disk_total) * 100) : 0,
        },
      })
    } catch { /* swallow — don't crash the interval */ }
  }, 2000)

  // ---------------------------------------------------------------------------
  //  SLOW — every 15s: ceph + ha + storage + services
  // ---------------------------------------------------------------------------
  slowInterval = setInterval(async () => {
    try {
      const cephNode = process.env.CEPH_MON_NODE ?? ''
      const [ceph, osds, ha, storage, npmStats] = await Promise.allSettled([
        pve.getCephStatus(cephNode),
        pve.getCephOSDs(cephNode),
        pve.getHAStatus(),
        pve.getAllStorage(),
        npm ? npm.getStats() : Promise.resolve(null),
      ])

      broadcast(server, 'slow', {
        ceph:    ceph.status    === 'fulfilled' ? ceph.value    : null,
        osds:    osds.status    === 'fulfilled' ? osds.value    : [],
        ha:      ha.status      === 'fulfilled' ? ha.value      : [],
        storage: storage.status === 'fulfilled' ? storage.value : [],
        services: {
          npm: npmStats.status === 'fulfilled' && npmStats.value
            ? { connected: true, url: process.env.NPM_URL, ...npmStats.value }
            : { connected: false },
        },
      })
    } catch { /* swallow */ }
  }, 15000)

  server.log.info('[ws] Broadcast service started (fast: 2s, slow: 15s)')
}

export function stopBroadcast() {
  if (fastInterval) clearInterval(fastInterval)
  if (slowInterval) clearInterval(slowInterval)
}
