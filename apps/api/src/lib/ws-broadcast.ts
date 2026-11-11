import { getClusterNetworkStats } from './network'
// =============================================================================
//  HyperProx — WebSocket Broadcast Service
//  Fast channel (2s): nodes, vms, gpu, cluster totals
//  Slow channel (15s): ceph, ha, storage, services
// =============================================================================

import { FastifyInstance } from 'fastify'
import { setWizardBroadcast }  from './wizard-executor'
import { livePve }         from './pve-env'
import { isUnlocked }      from './vault/state'
import { getGPUInfo }      from './gpu'
import { withCephMon } from './ceph'
import { NPMClient }       from './npm-client'
import { openSockets }     from './session-sockets'

let fastInterval: ReturnType<typeof setInterval> | null = null
let slowInterval: ReturnType<typeof setInterval> | null = null


function getNPM(): NPMClient | null {
  if (!process.env.NPM_URL) return null
  return new NPMClient(process.env.NPM_URL, process.env.NPM_EMAIL!, process.env.NPM_PASSWORD!)
}

/**
 * To the live-status sockets (/ws) only: not terminals or update logs, which share the WebSocket server. With
 * `owner`, only that person's sockets: a job's progress names guests, addresses and steps, so it goes to the
 * person who started it, not to every viewer.
 */
export function broadcast(_server: FastifyInstance | null, type: string, payload: any, owner?: string) {
  const msg = JSON.stringify({ type, payload, ts: Date.now() })
  for (const client of openSockets('live', owner)) {
    try { client.send(msg) } catch { /* closing */ }
  }
}

export function startBroadcast(server: FastifyInstance) {
  // Both resolve at each tick: the Proxmox token and NPM login arrive from the vault after start-up.
  const pve = livePve()

  // ---------------------------------------------------------------------------
  //  FAST — every 2s: nodes + VMs + GPU + cluster totals
  // ---------------------------------------------------------------------------
  fastInterval = setInterval(async () => {
    if (!isUnlocked()) return   // nothing to read (and nothing to show) while locked
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
    if (!isUnlocked()) return
    try {
      const [ceph, osds, ha, storage, npmStats] = await Promise.allSettled([
        pve.getClusterCephStatus(),
        withCephMon(pve, n => pve.getCephOSDs(n)),
        pve.getHAStatus(),
        pve.getAllStorage(),
        (() => { const npm = getNPM(); return npm ? npm.getStats() : Promise.resolve(null) })(),
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
  // A deploy job's progress goes to the person who started it, nobody else; with no owner, to nobody.
  setWizardBroadcast((type, payload, owner) => { if (owner) broadcast(server, type, payload, owner) })
}

export function stopBroadcast() {
  if (fastInterval) clearInterval(fastInterval)
  if (slowInterval) clearInterval(slowInterval)
}
