// =============================================================================
//  HyperProx — which cluster guest has which address
//
//  The router sees addresses; HyperProx knows which guest owns one. This joins
//  the two so a router page can say "plex" instead of a bare address, without
//  any name being written down anywhere: containers state their address in
//  their own netN line, cloud-init VMs in ipconfigN, and an address someone
//  typed for a guest on the Terminal page is remembered too.
//
//  Read-only, home cluster only, and cached for five minutes: the router page
//  polls every ten seconds and must not turn that into a Proxmox read storm.
// =============================================================================

import { livePve } from './pve-env'
import { listHostAddresses } from './terminal-hosts'

export interface GuestRef { vmid: number; name: string; type: 'lxc' | 'qemu'; config: Record<string, unknown> | null }

/** IPv4 addresses a guest's config states: LXC `netN: ...,ip=10.0.0.5/24` and cloud-init `ipconfigN: ip=...`. */
export function addressesInConfig(config: Record<string, unknown> | null): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(config ?? {})) {
    if (!/^(net|ipconfig)\d+$/.test(k) || typeof v !== 'string') continue
    const m = v.match(/(?:^|,)ip=(\d{1,3}(?:\.\d{1,3}){3})(?:\/\d+)?/)
    if (m && m[1] !== '0.0.0.0') out.push(m[1])
  }
  return out
}

/**
 * Address -> guest name. A stated address wins over a remembered one; when two guests claim one address (a
 * stopped copy of a running guest, say) the first one listed keeps it, so the caller lists running guests first.
 */
export function guestNamesFrom(guests: GuestRef[], remembered: Record<string, string> = {}): Map<string, string> {
  const out = new Map<string, string>()
  for (const g of guests) {
    for (const ip of addressesInConfig(g.config)) if (!out.has(ip)) out.set(ip, g.name)
  }
  for (const g of guests) {
    const ip = remembered[`${g.type}-${g.vmid}`]
    if (ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && !out.has(ip)) out.set(ip, g.name)
  }
  return out
}

let cache: { at: number; names: Map<string, string> } | null = null
let pending: Promise<Map<string, string>> | null = null
const TTL_MS = 5 * 60_000

/** The home cluster's guests by address. Empty (never an error) when Proxmox cannot be read. */
export async function clusterGuestNames(now = Date.now()): Promise<Map<string, string>> {
  if (cache && now - cache.at < TTL_MS) return cache.names
  if (pending) return pending
  pending = (async () => {
    try {
      const pve = livePve()
      const resources = (await pve.getClusterResources() as any[])
        .filter(r => (r.type === 'lxc' || r.type === 'qemu') && r.template !== 1)
        .sort((a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) || Number(a.vmid) - Number(b.vmid))
        .slice(0, 300)
      const guests: GuestRef[] = await Promise.all(resources.map(async r => ({
        vmid: Number(r.vmid), name: String(r.name ?? r.vmid), type: r.type,
        config: await pve.getVMConfig(r.node, Number(r.vmid), r.type).catch(() => null) as Record<string, unknown> | null,
      })))
      const remembered = await listHostAddresses().catch(() => ({} as Record<string, string>))
      const names = guestNamesFrom(guests, remembered)
      cache = { at: now, names }
      return names
    } catch {
      cache = { at: now, names: new Map() }
      return cache.names
    } finally {
      pending = null
    }
  })()
  return pending
}
