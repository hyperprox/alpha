import { getClusterNetworkStats } from './network'
// =============================================================================
//  HyperProx — WebSocket Broadcast Service
//  Fast channel (2s): nodes, vms, gpu, cluster totals
//  Slow channel (15s): ceph, ha, storage, services
// =============================================================================

import { FastifyInstance } from 'fastify'
import { setWizardBroadcast }  from './wizard-executor'
import { livePve }         from './pve-env'
import type { ProxmoxClient } from './proxmox-client'
import { isUnlocked }      from './vault/state'
import { getGPUInfo }      from './gpu'
import { withCephMon } from './ceph'
import { NPMClient }       from './npm-client'
import { openSockets }     from './session-sockets'
import { createLogOnce }   from './log-once'
import { withTimeout }     from './service-health'
import { classifyFailure } from './failure'

let fastInterval: ReturnType<typeof setInterval> | null = null
let slowInterval: ReturnType<typeof setInterval> | null = null


/** A tick that has run this long is treated as stuck: the guard lets the next one start. */
export const TICK_WATCHDOG_MS = 60_000

/**
 * Wraps a timer body so a tick is skipped while the previous one is still running (a slow Proxmox must not pile
 * up requests every two seconds). Never rejects. A watchdog releases the guard if a tick never finishes, so one
 * hung call cannot freeze the feed until a restart; `onStuck` says so, and the late result of that tick is ignored.
 * The tick body gets `stillCurrent()`: false once the watchdog has given up on it and a newer tick has started, so a
 * late finish never broadcasts old numbers as fresh (or marks the problem cleared).
 */
export function overlapGuard(
  run: (stillCurrent: () => boolean) => Promise<void>,
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
    try { await run(() => mine === gen) } catch (e) { if (mine === gen) onError(e) } finally { if (mine === gen) busySince = null }
  }
}

/** The live feed's NPM read: one try, 10 s per call and 10 s in all, so a hung NPM cannot make ticks overlap. */
export const FEED_NPM_TIMEOUT_MS = 10_000

function getNPM(): NPMClient | null {
  if (!process.env.NPM_URL) return null
  return new NPMClient(process.env.NPM_URL, process.env.NPM_EMAIL!, process.env.NPM_PASSWORD!, undefined, { tries: 1, timeoutMs: FEED_NPM_TIMEOUT_MS })
}

/**
 * Why the live feed has no fresh numbers, in words for the dashboard: `proxmox_auth` (the token was refused),
 * `proxmox_unreachable` (no answer), or `internal`. Never the error's own text.
 */
export function feedProblem(e: unknown): { code: string; error: string } {
  const c = classifyFailure(e)
  if (c.body.code === 'proxmox_auth' || c.body.code === 'proxmox_unreachable') return { code: c.body.code, error: c.body.error }
  return { code: 'proxmox_error', error: "HyperProx couldn't read your Proxmox's status. It will keep trying." }
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

export interface FastTickDeps {
  pve: Pick<ProxmoxClient, 'getNodes' | 'getAllVMs'>
  problem: ((what: string, e: unknown) => void) & { ok: (what: string) => void }
  send: (type: string, payload: unknown) => void
  unlocked: () => boolean
  gpu?: typeof getGPUInfo
  network?: (nodes: string[]) => Promise<unknown>
}

/**
 * The fast channel's tick (every 2 s): nodes, guests, GPU, network, cluster totals. The node list is read first, so a
 * refused token (ProxmoxAuthError) or no answer ends the tick before anything else starts, and nothing is left
 * running unawaited. A failure re-sends the last good numbers marked stale with why (`problem`), or, before the
 * first good read, a `feed-problem` message, so the dashboard never waits on "connecting" for ever.
 */
export function makeFastTick(d: FastTickDeps): (stillCurrent: () => boolean) => Promise<void> {
  // The last good numbers, re-sent marked stale when a read fails, so the dashboard can say they are out of date.
  let lastFast: Record<string, unknown> | null = null
  const gpu = d.gpu ?? getGPUInfo
  const network = d.network ?? ((names: string[]) => getClusterNetworkStats(
    process.env.PROXMOX_HOST!,
    Number(process.env.PROXMOX_PORT ?? 8006),
    `${process.env.PROXMOX_USER}!${process.env.PROXMOX_TOKEN_ID}`,
    process.env.PROXMOX_TOKEN_SECRET!,
    names,
  ))
  return async (stillCurrent) => {
    if (!d.unlocked()) return   // nothing to read (and nothing to show) while locked
    try {
      const nodes = await d.pve.getNodes()
      const [vms, gpuInfo, net] = await Promise.all([d.pve.getAllVMs(), gpu(undefined), network(nodes.map(n => n.node))])

      const cluster = nodes.reduce((acc, n) => ({
        cpu_used:   acc.cpu_used   + (n.cpu * n.maxcpu),
        cpu_total:  acc.cpu_total  + n.maxcpu,
        mem_used:   acc.mem_used   + n.mem,
        mem_total:  acc.mem_total  + n.maxmem,
        disk_used:  acc.disk_used  + n.disk,
        disk_total: acc.disk_total + n.maxdisk,
      }), { cpu_used: 0, cpu_total: 0, mem_used: 0, mem_total: 0, disk_used: 0, disk_total: 0 })

      // Released by the watchdog and overtaken by a newer tick: these numbers are old, so they are not sent.
      if (!stillCurrent()) return
      lastFast = {
        nodes, vms, gpu: gpuInfo, network: net,
        cluster: {
          ...cluster,
          cpu_pct:  cluster.cpu_total  ? Math.round((cluster.cpu_used  / cluster.cpu_total)  * 100) : 0,
          mem_pct:  cluster.mem_total  ? Math.round((cluster.mem_used  / cluster.mem_total)  * 100) : 0,
          disk_pct: cluster.disk_total ? Math.round((cluster.disk_used / cluster.disk_total) * 100) : 0,
        },
      }
      d.send('fast', { ...lastFast, stale: false })
      d.problem.ok('live status (fast)')
    } catch (e) {
      if (!stillCurrent()) return
      d.problem('live status (fast)', e)
      const why = feedProblem(e)
      if (lastFast) d.send('fast', { ...lastFast, stale: true, problem: why })
      else d.send('feed-problem', why)
    }
  }
}

export function startBroadcast(server: FastifyInstance) {
  // Both resolve at each tick: the Proxmox token and NPM login arrive from the vault after start-up.
  const pve = livePve()
  const problem = createLogOnce(server.log)
  // ---------------------------------------------------------------------------
  //  FAST — every 2s: nodes + VMs + GPU + cluster totals
  // ---------------------------------------------------------------------------
  const fastTick = makeFastTick({
    pve, problem, send: (type, payload) => broadcast(server, type, payload), unlocked: isUnlocked,
  })
  fastInterval = setInterval(overlapGuard(fastTick, undefined, { onStuck: () => problem('live status (fast)', new Error('a tick was stuck for over 60 seconds and was released')) }), 2000)

  // ---------------------------------------------------------------------------
  //  SLOW — every 15s: ceph + ha + storage + services
  // ---------------------------------------------------------------------------
  slowInterval = setInterval(overlapGuard(async (stillCurrent) => {
    if (!isUnlocked()) return
    try {
      const [ceph, osds, ha, storage, npmStats] = await Promise.allSettled([
        pve.getClusterCephStatus(),
        withCephMon(pve, n => pve.getCephOSDs(n)),
        pve.getHAStatus(),
        pve.getAllStorage(),
        (() => { const npm = getNPM(); return npm ? withTimeout(npm.getStats(), FEED_NPM_TIMEOUT_MS, 'Nginx Proxy Manager') : Promise.resolve(null) })(),
      ])
      if (!stillCurrent()) return

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
