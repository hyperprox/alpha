// =============================================================================
//  HyperProx — load balancing: does a move compete with the heartbeat?
//
//  Corosync is the cluster's heartbeat. With HA fencing armed, a node that
//  misses it for too long is fenced (rebooted). A migration copies memory and
//  disks as fast as the link allows, and by default it uses the cluster's own
//  network: the one corosync runs on. On a single 1 Gbit link that is how a
//  routine move turns into "the cluster lost its heartbeat link 36 times".
//
//  Read from /cluster/config/nodes (each node's ring addresses) and the
//  datacenter options (`migration: network=…`, `bwlimit: migration=…`).
// =============================================================================

import type { NetworkCost } from './types'
import { inCidrs, parseCidr, parseIP } from '../net/ip'

/** A conservative default: about 400 Mbit/s, leaving most of a 1 Gbit link to everything else. */
export const DEFAULT_BWLIMIT_KIB = 51_200

function kv(v: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = String(x); return out }
  for (const part of String(v ?? '').split(',')) {
    const [k, ...r] = part.split('=')
    if (k?.trim()) out[k.trim()] = r.join('=').trim()
  }
  return out
}

/** True when the IPv4 address is inside the CIDR; null when either cannot be read (a hostname, IPv6). */
export function inCidr(addr: string, cidr: string): boolean | null {
  const [net] = cidr.split('/')
  const a = parseIP(addr), n = parseCidr(cidr)
  if (!a || !n || a.v !== 4 || n.v !== 4) {
    // IPv6 or a name: only an exact match can be told apart.
    return addr.trim() === (net ?? '').trim() ? true : null
  }
  return inCidrs(addr, [cidr])
}

export function networkCost(input: {
  /** /cluster/config/nodes rows: ring0_addr, ring1_addr, … */
  corosyncNodes: any[] | null
  /** /cluster/options */
  options: any | null
  /** The bandwidth limit HyperProx suggests (from its settings). */
  suggestedBwlimit?: number
}): NetworkCost {
  const suggested = input.suggestedBwlimit && input.suggestedBwlimit > 0 ? Math.round(input.suggestedBwlimit) : DEFAULT_BWLIMIT_KIB
  const rows = input.corosyncNodes ?? []
  const rings = new Map<string, string[]>()
  for (const r of rows) for (const [k, v] of Object.entries(r ?? {})) {
    const m = /^ring(\d+)_addr$/.exec(k)
    if (m && v) rings.set(m[1], [...(rings.get(m[1]) ?? []), String(v)])
  }
  const ring0 = rings.get('0') ?? []
  const addresses = [...rings.values()].flat()
  const redundantRing = rings.size > 1
  const mig = kv(input.options?.migration)
  const bw = kv(input.options?.bwlimit)
  const dcBw = Number(bw.migration ?? bw.default)
  const datacenterBwlimit = Number.isFinite(dcBw) && dcBw > 0 ? dcBw : null
  const migrationNetwork = mig.network || null
  const words: string[] = []
  let shared: boolean | null
  if (!input.corosyncNodes) {
    shared = null
    words.push('The corosync addresses could not be read, so HyperProx cannot tell whether moves share its network.')
  } else if (!migrationNetwork) {
    shared = true
    words.push('No migration network is set, so moves use the cluster network: the same one corosync, the cluster heartbeat, runs on.')
  } else {
    const hits = ring0.map(a => inCidr(a, migrationNetwork))
    if (hits.some(h => h === true)) { shared = true; words.push(`Moves use ${migrationNetwork}, which is also where corosync runs.`) }
    else if (hits.length && hits.every(h => h === false)) { shared = false; words.push(`Moves use ${migrationNetwork}, a different network from corosync's: a move cannot starve the heartbeat.`) }
    else { shared = null; words.push(`Moves use ${migrationNetwork}; corosync's addresses could not be compared with it.`) }
  }
  if (shared !== false) {
    if (redundantRing) words.push('Corosync has a second link, so a busy network alone does not cut the heartbeat.')
    else words.push('Corosync has a single link. With HA fencing armed, a node that misses the heartbeat for long enough is fenced (rebooted).')
    if (datacenterBwlimit) words.push(`The cluster already limits migrations to ${Math.round(datacenterBwlimit / 1024)} MiB/s.`)
    else words.push(`HyperProx limits its moves to ${Math.round(suggested / 1024)} MiB/s by default. For HA guests the limit can only come from the datacenter's "bwlimit: migration=…" setting, which HyperProx does not change.`)
  }
  return { shared, migrationNetwork, corosyncAddresses: addresses, redundantRing, datacenterBwlimit, suggestedBwlimit: suggested, words }
}

/** Seconds to copy `bytes` at the link speed or the limit, whichever is lower. */
export function copySeconds(bytes: number, linkMbps: number, bwlimitKiB: number | null): number {
  const link = Math.max(1, linkMbps) * 1_000_000 / 8 * 0.9   // bytes/s, less protocol overhead
  const limit = bwlimitKiB && bwlimitKiB > 0 ? bwlimitKiB * 1024 : Infinity
  return Math.ceil(Math.max(0, bytes) / Math.min(link, limit))
}
