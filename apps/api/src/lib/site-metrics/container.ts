// =============================================================================
//  HyperProx — site metrics: the site's container, from Proxmox
//
//  The live status (CPU, memory, disk, uptime) and a week of network from the
//  RRD Proxmox keeps anyway. Read through the home cluster's API token; cached
//  for 30 seconds so a page full of people does not hammer it.
// =============================================================================

import { homePve } from '../pve-env'
import { seg } from '../proxmox-client'

export interface ContainerView {
  status: string
  cpuPct: number; cores: number
  memPct: number; memUsed: number; memMax: number
  diskPct: number; diskUsed: number; diskMax: number
  uptimeS: number
  /** Bytes in and out over the last 7 days, from the RRD averages. */
  netIn7d: number; netOut7d: number
}

export interface PveLike { fetchNode<T>(path: string): Promise<T> }

const cache = new Map<string, { at: number; v: ContainerView | null }>()
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0)

export async function containerView(node: string, vmid: number, pve: PveLike = homePve(), now = Date.now()): Promise<ContainerView | null> {
  const key = `${node}/${vmid}`
  const c = cache.get(key)
  if (c && now - c.at < 30_000) return c.v
  let v: ContainerView | null = null
  try {
    const s = await pve.fetchNode<any>(`/nodes/${seg(node)}/lxc/${seg(vmid)}/status/current`)
    if (s) {
      const rrd = (await pve.fetchNode<any[]>(`/nodes/${seg(node)}/lxc/${seg(vmid)}/rrddata?timeframe=week&cf=AVERAGE`).catch(() => [])) ?? []
      let netIn = 0, netOut = 0
      for (let i = 1; i < rrd.length; i++) {
        const dt = Number(rrd[i].time) - Number(rrd[i - 1].time)
        if (dt > 0 && dt < 86_400) { netIn += (Number(rrd[i].netin) || 0) * dt; netOut += (Number(rrd[i].netout) || 0) * dt }
      }
      v = {
        status: String(s.status ?? 'unknown'), cpuPct: Math.round((Number(s.cpu) || 0) * 1000) / 10, cores: Number(s.cpus) || 0,
        memPct: pct(Number(s.mem) || 0, Number(s.maxmem) || 0), memUsed: Number(s.mem) || 0, memMax: Number(s.maxmem) || 0,
        diskPct: pct(Number(s.disk) || 0, Number(s.maxdisk) || 0), diskUsed: Number(s.disk) || 0, diskMax: Number(s.maxdisk) || 0,
        uptimeS: Number(s.uptime) || 0, netIn7d: Math.round(netIn), netOut7d: Math.round(netOut),
      }
    }
  } catch { v = null }
  cache.set(key, { at: now, v })
  return v
}
