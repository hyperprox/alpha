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
import { createLogOnce }   from './log-once'

let fastInterval: ReturnType<typeof setInterval> | null = null
let slowInterval: ReturnType<typeof setInterval> | null = null


/** A tick that has run this long is treated as stuck: the guard lets the next one start. */
export const TICK_WATCHDOG_MS = 60_000

/**
 * Wraps a timer body so a tick is skipped while the previous one is still running (a slow Proxmox must not pile
 * up requests every two seconds). Never rejects. A watchdog releases the guard if a tick never finishes, so one
 * hung call cannot freeze the feed until a restart; `onStuck` says so, and the late result of that tick is ignored.
 */
export function overlapGuard(
  run: () => Promise<void>,
  onError: (e: unknown) => void = () => undefined,
  opts: { watchdogMs?: number; onStuck?: () => void } = {},
): () => Promise<void> {
  const watchdogMs = opts.watchdogMs ?? TICK_WATCHDOG_MS
  let gen = 0
  let busySince: number | null = null
  return async () => {
    if (busySince !== null) {
      if (Date.now() - busySince < watchdogMs) return
      try { opts.onStuck?.() } catch { /* logging must not break the timer */ }
    }
    const mine = ++gen
    busySince = Date.now()
    try { await run() } catch (e) { if (mine === gen) onError(e) } finally { if (mine === gen) busySince = null }
  }
}

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
  const problem = createLogOnce(server.log)
  // The last good numbers, re-sent marked stale when a read fails, so the dashboard can say they are out of date.
  let lastFast: Record<string, unknown> | null = null

  // ---------------------------------------------------------------------------
  //  FAST — every 2s: nodes + VMs + GPU + cluster totals
  // ---------------------------------------------------------------------------
  fastInterval = setInterval(overlapGuard(async () => {
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

      lastFast = {
        nodes, vms, gpu, network,
        cluster: {
          ...cluster,
          cpu_pct:  cluster.cpu_total  ? Math.round((cluster.cpu_used  / cluster.cpu_total)  * 100) : 0,
          mem_pct:  cluster.mem_total  ? Math.round((cluster.mem_used  / cluster.mem_total)  * 100) : 0,
          disk_pct: cluster.disk_total ? Math.round((cluster.disk_used / cluster.disk_total) * 100) : 0,
        },
      }
      broadcast(server, 'fast', { ...lastFast, stale: false })
      problem.ok('live status (fast)')
    } catch (e) {
      problem('live status (fast)', e)
      if (lastFast) broadcast(server, 'fast', { ...lastFast, stale: true })
    }
  }, undefined, { onStuck: () => problem('live status (fast)', new Error('a tick was stuck for over 60 seconds and was released')) }), 2000)

  // ---------------------------------------------------------------------------
  //  SLOW — every 15s: ceph + ha + storage + services
  // ---------------------------------------------------------------------------
  slowInterval = setInterval(overlapGuard(async () => {
    if (!isUnlocked()) return
    try {
      const [ceph, osds, ha, storage, npmStats] = await Promise.allSettled([
        pve.getClusterCephStatus(),
        withCephMon(pve, n => pve.getCephOSDs(n)),
        pve.getHAStatus(),
        pve.getAllStorage(),
        (() => { const npm = getNPM(); return npm ? npm.getStats() : Promise.resolve(null) })(),
      ])

      const failed = [ceph, osds, ha, storage].filter(x => x.status === 'rejected') as PromiseRejectedResult[]
      if (failed.length) problem('live status (slow)', failed[0].reason); else problem.ok('live status (slow)')
      broadcast(server, 'slow', {
        stale: failed.length > 0,
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
    } catch (e) { problem('live status (slow)', e) }
  }, undefined, { onStuck: () => problem('live status (slow)', new Error('a tick was stuck for over 60 seconds and was released')) }), 15000)

  server.log.info('[ws] Broadcast service started (fast: 2s, slow: 15s)')
  // A deploy job's progress goes to the person who started it, nobody else; with no owner, to nobody.
  setWizardBroadcast((type, payload, owner) => { if (owner) broadcast(server, type, payload, owner) })
}

export function stopBroadcast() {
  if (fastInterval) clearInterval(fastInterval)
  if (slowInterval) clearInterval(slowInterval)
}
