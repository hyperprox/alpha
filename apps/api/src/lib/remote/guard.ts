// =============================================================================
//  HyperProx — Remote access: the node guard
//
//  Before and after any change on a Proxmox node, compare what decides whether
//  the node is still a healthy member of its cluster:
//    - every routing table and policy rule (table 52 included),
//    - the route to every corosync and Ceph peer (`ip route get`),
//    - the resolver: /etc/resolv.conf and systemd-resolved's per-link DNS,
//    - the firewall ruleset (nftables, iptables, ip6tables; hashed),
//    - corosync's own link state, forwarding, and quorum.
//  Anything different, or anything that cannot be read, is a reason to roll
//  back. "Could not read quorum" never counts as "quorate".
//
//  The client being installed is allowed exactly one kind of change: routes on
//  its own interface or in its own table (never a default route), and its own
//  policy rules. A route to a cluster peer that moves is never allowed.
// =============================================================================

import type { ProviderId } from './types'

export interface NodeSnapshot {
  read: boolean
  routes: string[]        // "4 <route>" / "6 <route>", normalised
  rules: string[]         // "4 <rule>" / "6 <rule>", normalised
  resolvLink: string
  resolv: string
  resolved: string        // active | inactive
  linkDns: string[]       // normalised resolvectl lines
  firewall: Record<string, string>   // NFT / IPT4 / IPT6 → hash
  forwarding: { v4: string; v6: string }
  /** Cluster networks and peer addresses: "corosync 192.0.2.12", "ceph 192.0.2.0/24", "own 192.0.2.11/24". */
  nets: string[]
  paths: Record<string, string>      // peer address → normalised `ip route get`
  corosync: string[]                 // "link0 node2 connected"
  quorate: string                    // Yes | No | standalone | unknown
}

/** Fields that change on their own, every second, and mean nothing (RA lifetimes, cache ages, counters). */
export function normaliseRoute(line: string): string {
  return line
    .replace(/\bexpires -?\d+sec\b/g, '')
    .replace(/\bage [\d.]+sec\b/g, '')
    .replace(/\bused \d+\b/g, '')
    .replace(/\buid \d+\b/g, '')
    .replace(/\bcache\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function parseSnapshot(output: string): NodeSnapshot {
  const s: NodeSnapshot = {
    read: false, routes: [], rules: [], resolvLink: '', resolv: '', resolved: 'inactive', linkDns: [],
    firewall: {}, forwarding: { v4: '', v6: '' }, nets: [], paths: {}, corosync: [], quorate: 'unknown',
  }
  let sawEnd = false
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\r$/, '')
    let m: RegExpExecArray | null
    if ((m = /^HP_ROUTE([46]) (.*)$/.exec(line))) s.routes.push(`${m[1]} ${normaliseRoute(m[2])}`)
    else if ((m = /^HP_RULE([46]) (.*)$/.exec(line))) s.rules.push(`${m[1]} ${m[2].replace(/\s+/g, ' ').trim()}`)
    else if ((m = /^HP_LINK(DNS|DOMAIN) (.*)$/.exec(line))) s.linkDns.push(`${m[1]} ${m[2].replace(/^Link \d+ /, '').replace(/\s+/g, ' ').trim()}`)
    else if ((m = /^HP_NET (\w+) (\S+)$/.exec(line))) s.nets.push(`${m[1]} ${m[2]}`)
    else if ((m = /^HP_PATH (\S+) ?(.*)$/.exec(line))) s.paths[m[1]] = normaliseRoute(m[2])
    else if ((m = /^HP_COROSYNC (.*)$/.exec(line))) s.corosync.push(m[1].replace(/\s+/g, ' ').trim())
    else if ((m = /^HP_FW_([A-Z0-9]+)=(.*)$/.exec(line))) s.firewall[m[1]] = m[2].trim()
    else if ((m = /^HP_FWD([46])=(.*)$/.exec(line))) s.forwarding[m[1] === '4' ? 'v4' : 'v6'] = m[2].trim()
    else if ((m = /^HP_RESOLV_LINK=(.*)$/.exec(line))) s.resolvLink = m[1].trim()
    else if ((m = /^HP_RESOLV=(.*)$/.exec(line))) s.resolv = m[1].trim()
    else if ((m = /^HP_RESOLVED=(.*)$/.exec(line))) s.resolved = m[1].trim()
    else if ((m = /^HP_QUORATE=(.*)$/.exec(line))) s.quorate = m[1].trim() || 'unknown'
    else if (line === 'HP_SNAPSHOT_END') sawEnd = true
  }
  s.routes.sort(); s.rules.sort(); s.linkDns.sort(); s.corosync.sort()
  s.read = sawEnd && s.routes.length > 0 && Object.keys(s.firewall).length > 0
  return s
}

const QUORATE_OK = new Set(['Yes', 'standalone'])
const LINK_OK = /\b(connected|localhost)$/

/** Null when the node may be changed, or why not. */
export function snapshotReady(s: NodeSnapshot): string | null {
  if (!s.read) return 'could not read the node\'s routes, resolver, firewall and quorum'
  if (s.quorate === 'No') return 'the cluster is not quorate'
  if (!QUORATE_OK.has(s.quorate)) return `could not read quorum (pvecm status said "${s.quorate}")`
  const down = s.corosync.filter(l => !LINK_OK.test(l))
  if (down.length) return `corosync reports links that are not connected (${down.join('; ')})`
  return null
}

// What each client may add or remove on its own.
const OVERLAY_DEV: Record<ProviderId, RegExp> = { tailscale: /\bdev tailscale\d*\b/, netbird: /\bdev wt\d+\b/ }
const OWN_TABLE: Record<ProviderId, RegExp> = { tailscale: /\btable 52\b/, netbird: /\btable 7120\b/ }
const OWN_RULE: Record<ProviderId, RegExp> = {
  tailscale: /^[46] 52\d0: from all (fwmark 0x80000\/0xff0000 (lookup (main|default)|unreachable)|lookup 52)$/,
  netbird:   /^[46] \d+: (not )?from all (fwmark 0x1bd0[0-9a-f]? )?lookup (7120|main suppress_prefixlength 0)$/,
}

const isDefault = (route: string) => /^[46] (unicast )?(default|0\.0\.0\.0\/0|::\/0)\b/.test(route)

function setDiff(a: string[], b: string[]): { added: string[]; removed: string[] } {
  const A = new Set(a), B = new Set(b)
  return { added: b.filter(x => !A.has(x)), removed: a.filter(x => !B.has(x)) }
}

function list(xs: string[], n = 3): string {
  return xs.slice(0, n).map(x => `"${x}"`).join(', ') + (xs.length > n ? ` and ${xs.length - n} more` : '')
}

/**
 * Every difference that matters, in plain words. Empty when the node is as it was. `provider` is the client
 * being changed, whose own interface, table and rules may come and go.
 */
export function compareSnapshots(before: NodeSnapshot, after: NodeSnapshot, provider?: ProviderId): string[] {
  if (!after.read) return ['could not read the node\'s routes, resolver, firewall and quorum after the change']
  const out: string[] = []
  const own = (r: string) => !!provider && (OVERLAY_DEV[provider].test(r) || OWN_TABLE[provider].test(r))

  const routes = setDiff(before.routes, after.routes)
  const foreignAdded = routes.added.filter(r => !own(r))
  const foreignRemoved = routes.removed.filter(r => !own(r))
  const ownDefault = routes.added.filter(r => own(r) && isDefault(r))
  if (foreignAdded.length || foreignRemoved.length) {
    out.push(`the routing tables changed (${[...foreignAdded.map(r => `added ${r}`), ...foreignRemoved.map(r => `removed ${r}`)].slice(0, 4).join('; ')})`)
  }
  if (ownDefault.length) out.push(`the client added a default route (${list(ownDefault)})`)

  const rules = setDiff(before.rules, after.rules)
  const badRules = [...rules.added, ...rules.removed].filter(r => !(provider && OWN_RULE[provider].test(r)))
  if (badRules.length) out.push(`the policy routing rules changed (${list(badRules)})`)

  for (const peer of new Set([...Object.keys(before.paths), ...Object.keys(after.paths)])) {
    if (before.paths[peer] !== after.paths[peer]) {
      out.push(`the route to cluster peer ${peer} changed (was "${before.paths[peer] ?? 'none'}", now "${after.paths[peer] ?? 'none'}")`)
    }
  }

  if (before.resolvLink !== after.resolvLink || before.resolv !== after.resolv) {
    out.push(`the resolver changed (was "${before.resolv || 'empty'}" via ${before.resolvLink || '?'}, now "${after.resolv || 'empty'}" via ${after.resolvLink || '?'})`)
  }
  const ownLink = (l: string) => !!provider && (provider === 'tailscale' ? /\(tailscale\d*\)/ : /\(wt\d+\)/).test(l)
  const dns = setDiff(before.linkDns.filter(l => !ownLink(l)), after.linkDns.filter(l => !ownLink(l)))
  // The client's own link may appear, but only with nothing set on it.
  const ownLinkSet = after.linkDns.filter(l => ownLink(l) && !/:\s*$/.test(l))
  if (before.resolved !== after.resolved || dns.added.length || dns.removed.length || ownLinkSet.length) {
    out.push(`per-link DNS changed (${list([...dns.added, ...dns.removed, ...ownLinkSet])})`)
  }

  for (const k of new Set([...Object.keys(before.firewall), ...Object.keys(after.firewall)])) {
    if (before.firewall[k] !== after.firewall[k]) out.push(`the ${k === 'NFT' ? 'nftables' : k === 'IPT6' ? 'ip6tables' : 'iptables'} ruleset changed`)
  }
  if (before.forwarding.v4 !== after.forwarding.v4 || before.forwarding.v6 !== after.forwarding.v6) {
    out.push(`IP forwarding changed (was ${before.forwarding.v4}/${before.forwarding.v6}, now ${after.forwarding.v4}/${after.forwarding.v6})`)
  }

  const links = setDiff(before.corosync, after.corosync)
  const down = after.corosync.filter(l => !LINK_OK.test(l))
  if (links.added.length || links.removed.length || down.length) out.push(`corosync link state changed (${list([...links.removed.map(l => `was ${l}`), ...links.added.map(l => `now ${l}`)])})`)

  if (!QUORATE_OK.has(after.quorate) || before.quorate !== after.quorate) out.push(`quorum changed (was ${before.quorate}, now ${after.quorate})`)
  return out
}

/** The cluster's networks as CIDRs: corosync and Ceph peers as host routes, Ceph networks, the node's own. */
export function clusterNetworks(s: NodeSnapshot): string[] {
  return [...new Set(s.nets.map(n => {
    const addr = n.split(' ')[1]
    if (addr.includes('/')) return addr
    return addr.includes(':') ? `${addr}/128` : `${addr}/32`
  }))]
}
