// =============================================================================
//  HyperProx — Network Stats Service
//  Per-node netin/netout from Proxmox RRD + CEPH I/O from ceph status
// =============================================================================
import { homeTlsAgent } from './home-tls'

import https from 'https'

interface NodeNetStats {
  node:     string
  netin:    number    // bytes/sec current
  netout:   number    // bytes/sec current
  netin_mb: number    // MB/s
  netout_mb: number   // MB/s
}

interface CephIOStats {
  read_bps:   number   // bytes/sec
  write_bps:  number   // bytes/sec
  read_ops:   number   // ops/sec
  write_ops:  number   // ops/sec
}

export interface ClusterNetworkStats {
  nodes:    NodeNetStats[]
  ceph_io:  CephIOStats | null
  total_in:  number   // bytes/sec across all nodes
  total_out: number
}

const CACHE_TTL = 4_000
let cache: { data: ClusterNetworkStats; ts: number } | null = null

/** How long one Proxmox read may take: this runs every two seconds, so a hung connection must not pile up. */
export const PROXMOX_READ_TIMEOUT_MS = 10_000

export function proxmoxFetch<T>(host: string, port: number, token: string, path: string, timeoutMs = PROXMOX_READ_TIMEOUT_MS, agent: https.Agent | false | undefined = homeTlsAgent()): Promise<T> {
  return new Promise((resolveP, rejectP) => {
    // Exactly one outcome, whichever way the request ends: an answer, an error, a timeout, or a connection cut
    // mid-body (which fires no 'end'). The timer is cleared only when the promise settles.
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const settle = (f: () => void) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); f() }
    const resolve = (v: T) => settle(() => resolveP(v))
    const reject = (e: Error) => settle(() => rejectP(e))
    const url  = new URL(`https://${host}:${port}/api2/json${path}`)
    const opts: https.RequestOptions = {
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method: 'GET',
      // The home cluster's certificate rule (lib/home-tls.ts), checked before the token is sent.
      agent,
      headers: { Authorization: `PVEAPIToken=${token}` },
    }
    const req = https.request(opts, (res) => {
      let data = ''
      res.on('error', reject)
      res.on('aborted', () => reject(new Error('Proxmox closed the connection mid-answer')))
      res.on('close', () => { if (!res.complete) reject(new Error('Proxmox closed the connection before the answer finished')) })
      res.on('data', c => { data += c })
      res.on('end', () => {
        try { resolve((JSON.parse(data) as { data: T }).data) }
        catch (e) { reject(new Error(`Parse error: ${data.slice(0, 100)}`)) }
      })
    })
    // A hard deadline for the whole read, not an idle timer: a slow trickle must not keep it alive.
    timer = setTimeout(() => { const e = new Error(`Proxmox did not answer within ${Math.round(timeoutMs / 1000)} seconds`); reject(e); req.destroy(e) }, timeoutMs)
    req.on('error', reject)
    req.on('close', () => reject(new Error('Proxmox closed the connection without an answer')))
    req.end()
  })
}

function getLatestRRD(rrd: any[]): { netin: number; netout: number } {
  // RRD data comes newest-last, find last entry with actual values
  for (let i = rrd.length - 1; i >= 0; i--) {
    const row = rrd[i]
    if (row.netin != null && row.netout != null) {
      return { netin: row.netin, netout: row.netout }
    }
  }
  return { netin: 0, netout: 0 }
}

export async function getClusterNetworkStats(
  host: string,
  port: number,
  tokenId: string,
  tokenSecret: string,
  nodeNames: string[],
): Promise<ClusterNetworkStats> {
  if (cache && Date.now() - cache.ts < CACHE_TTL) return cache.data

  const token = `${tokenId}=${tokenSecret}`

  const [nodeResults, cephResult] = await Promise.allSettled([
    // Fetch RRD for all nodes in parallel
    Promise.all(nodeNames.map(async node => {
      try {
        const rrd = await proxmoxFetch<any[]>(
          host, port, token,
          `/nodes/${node}/rrddata?timeframe=hour&cf=AVERAGE`
        )
        const { netin, netout } = getLatestRRD(rrd)
        return {
          node,
          netin,
          netout,
          netin_mb:  Math.round((netin  / 1024 / 1024) * 100) / 100,
          netout_mb: Math.round((netout / 1024 / 1024) * 100) / 100,
        } as NodeNetStats
      } catch {
        return { node, netin: 0, netout: 0, netin_mb: 0, netout_mb: 0 } as NodeNetStats
      }
    })),

    // CEPH I/O from status pgmap. /cluster/ceph/status is cluster-scoped and
    // carries the same pgmap as the node-level alias, so this needs no monitor
    // node — and on a cluster without CEPH it simply yields null.
    proxmoxFetch<any>(host, port, token, '/cluster/ceph/status'),
  ])

  const nodes: NodeNetStats[] = nodeResults.status === 'fulfilled' ? nodeResults.value : []

  let ceph_io: CephIOStats | null = null
  if (cephResult.status === 'fulfilled') {
    const pgmap = cephResult.value?.pgmap
    if (pgmap) {
      ceph_io = {
        read_bps:  pgmap.read_bytes_sec  ?? 0,
        write_bps: pgmap.write_bytes_sec ?? 0,
        read_ops:  pgmap.read_op_per_sec  ?? 0,
        write_ops: pgmap.write_op_per_sec ?? 0,
      }
    }
  }

  const result: ClusterNetworkStats = {
    nodes,
    ceph_io,
    total_in:  nodes.reduce((s, n) => s + n.netin,  0),
    total_out: nodes.reduce((s, n) => s + n.netout, 0),
  }

  cache = { data: result, ts: Date.now() }
  return result
}
