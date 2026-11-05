// =============================================================================
//  HyperProx — Remote access: the node guard
//
//  Before and after any change on a Proxmox node, compare what decides whether
//  the node is still a healthy member of its cluster:
//    - every routing table and policy rule (table 52 included),
//    - the route to every corosync and Ceph peer (IPv4 and IPv6), to the
//      default gateways and to the resolvers (`ip route get`),
//    - the resolver: /etc/resolv.conf and systemd-resolved's per-link DNS,
//    - the firewall rules, as text: nftables, iptables and ip6tables (both
//      backends), ipset and ebtables,
//    - corosync's own link state, forwarding, and quorum.
//  Anything different, or anything that cannot be read, is a reason to roll
//  back. "Could not read quorum" never counts as "quorate".
//
//  The client being changed is allowed exactly this:
//    - routes on its own interface or in its own table whose destination lies
//      inside its overlay prefixes, or whose type is local, broadcast,
//      multicast or throw (and IPv6 link-local on its own interface);
//    - its own policy rules, each at its exact priority and shape.
//  Never a default route, never a /1 split, never a route in its table to
//  anything outside the overlay, never a moved path to a cluster peer.
//
//  Firewall text that changes on its own is left out: fail2ban's chains and
//  sets, pve-firewall's per-guest chains and the rules that jump to them, its
//  PVESIG signatures, sets with timeouts, and counter and quota values.
// =============================================================================

import { cidrOverlaps } from './planner'
import type { ProviderId } from './types'

export interface NodeSnapshot {
  read: boolean
  routes: string[]        // "4 <route>" / "6 <route>", normalised
  rules: string[]         // "4 <rule>" / "6 <rule>", normalised
  resolvLink: string
  resolv: string
  resolved: string        // active | inactive
  linkDns: string[]       // normalised resolvectl lines
  /** Firewall rules by source (nft, ipt4, ipt6, iptl4, iptl6, ipset, ebt), normalised, dynamic parts left out. */
  firewall: Record<string, string[]>
  forwarding: { v4: string; v6: string }
  /** Cluster networks and peer addresses: "corosync 192.0.2.12", "ceph 192.0.2.0/24", "own 192.0.2.11/24". */
  nets: string[]
  paths: Record<string, string>      // address → normalised `ip route get`
  corosync: string[]                 // "link0 node2 connected"
  quorate: string                    // Yes | No | standalone | unknown
}

/** Fields that change on their own and mean nothing (RA lifetimes, cache ages, counters). */
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

// ── Firewall text ───────────────────────────────────────────────────────────

/** pve-firewall's per-guest interfaces and proxmox-firewall's per-guest objects. */
const PER_GUEST = /\b(?:tap|veth|fwbr|fwln)\d+i\d+\b|\bfwpr\d+p\d+\b|\bguest-\d+\b|\bPVEFW-[1-9]\d{2,}-/
/** fail2ban, whichever backend. */
const FAIL2BAN = /\bf2b-|\baddr-set-|\bfail2ban\b/

function dynamicName(s: string): boolean { return PER_GUEST.test(s) || FAIL2BAN.test(s) }

function cleanCounters(l: string): string {
  return l
    .replace(/\bcounter packets \d+ bytes \d+/g, 'counter')
    .replace(/\bpackets \d+ bytes \d+/g, '')
    .replace(/\bused \d+ (?:bytes|kbytes|mbytes)\b/g, '')
    .replace(/\[\d+:\d+\]/g, '')
    .replace(/ -c \d+ \d+\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function normaliseNft(lines: string[]): string[] {
  const out: string[] = []
  // A stack of open blocks: whether each is dropped, and whether it is a set with timeouts.
  const stack: Array<{ drop: boolean; set: boolean; timeout: boolean }> = []
  const dropping = () => stack.some(b => b.drop)
  for (const raw of lines) {
    const l = raw.trim()
    if (!l) continue
    const opens = (l.match(/\{/g) ?? []).length
    const closes = (l.match(/\}/g) ?? []).length
    const top = stack[stack.length - 1]
    if (top?.set && /\b(flags [^;]*\btimeout\b|timeout \d+)/.test(l)) top.timeout = true
    const inTimeoutSet = !!top?.set && top.timeout && /\belements\b|\bexpires\b|\btimeout\b/.test(l)
    if (opens > closes) {
      // A set's element list over several lines: dropped whole when the set has timeouts.
      if (/^elements = \{/.test(l) && top?.set) {
        stack.push({ drop: top.timeout, set: false, timeout: false })
        if (!dropping()) out.push(cleanCounters(l))
        continue
      }
      // A table, chain or set whose own name is dynamic is left out whole.
      const name = /^(?:table \S+|chain|set|map) (\S+)/.exec(l)?.[1] ?? ''
      stack.push({ drop: dropping() || dynamicName(name), set: /^(set|map) /.test(l), timeout: false })
      if (!dropping()) out.push(cleanCounters(l))
      continue
    }
    if (closes > opens) {
      // An element list closing on its own line belongs to the set's elements, which may be dropped.
      if (!dropping()) out.push(cleanCounters(l))
      for (let i = 0; i < closes - opens; i++) stack.pop()
      continue
    }
    const jump = /\b(?:jump|goto) (\S+)/.exec(l)
    if (dropping() || inTimeoutSet || (jump && dynamicName(jump[1])) || /PVESIG:/.test(l) || /\bexpires\b/.test(l)) continue
    const c = cleanCounters(l)
    if (c) out.push(c)
  }
  return out
}

/**
 * iptables/ebtables save output. A dynamic chain (fail2ban, a guest's own chain) is left out whole: its
 * declaration, its rules, and the rules that jump or go to it. A rule that merely mentions such a name
 * (matching a guest's interface, say) is a real rule and is kept.
 */
function normaliseSave(lines: string[]): string[] {
  const dyn = new Set<string>()
  for (const l of lines) { const m = /^:(\S+)/.exec(l); if (m && dynamicName(m[1])) dyn.add(m[1]) }
  return lines
    .filter(l => {
      if (!l.trim() || l.startsWith('#') || /PVESIG:/.test(l)) return false
      const decl = /^:(\S+)/.exec(l)
      if (decl) return !dyn.has(decl[1])
      const member = /^-[AIN] (\S+)/.exec(l)
      if (member && (dyn.has(member[1]) || dynamicName(member[1]))) return false
      const jump = /\s-[jg] (\S+)/.exec(l)
      if (jump && (dyn.has(jump[1]) || dynamicName(jump[1]))) return false
      return true
    })
    .map(cleanCounters)
}

function normaliseIpset(lines: string[]): string[] {
  const dyn = new Set<string>()
  for (const l of lines) {
    const m = /^create (\S+) .*/.exec(l)
    if (m && (/\btimeout \d+/.test(l) || dynamicName(m[1]))) dyn.add(m[1])
  }
  return lines.filter(l => {
    const m = /^(create|add) (\S+)/.exec(l)
    if (!m) return !!l.trim()
    if (dynamicName(m[2])) return false
    return !(m[1] === 'add' && dyn.has(m[2]))
  }).map(cleanCounters)
}

export function normaliseFirewall(src: string, lines: string[]): string[] {
  const n = src === 'nft' ? normaliseNft(lines) : src === 'ipset' ? normaliseIpset(lines) : normaliseSave(lines)
  return [...n].sort()
}

/** Optional fields newer iproute prints (`proto kernel`, `proto boot`) say nothing about what the rule does. */
export function normaliseRule(r: string): string {
  return r.replace(/\bproto \S+/g, '').replace(/\s+/g, ' ').trim()
}

// ── Parsing ─────────────────────────────────────────────────────────────────

export function parseSnapshot(output: string): NodeSnapshot {
  const s: NodeSnapshot = {
    read: false, routes: [], rules: [], resolvLink: '', resolv: '', resolved: 'inactive', linkDns: [],
    firewall: {}, forwarding: { v4: '', v6: '' }, nets: [], paths: {}, corosync: [], quorate: 'unknown',
  }
  const fwRaw: Record<string, string[]> = {}
  let sawEnd = false
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\r$/, '')
    let m: RegExpExecArray | null
    if ((m = /^HP_ROUTE([46]) (.*)$/.exec(line))) s.routes.push(`${m[1]} ${normaliseRoute(m[2])}`)
    else if ((m = /^HP_RULE([46]) (.*)$/.exec(line))) s.rules.push(`${m[1]} ${normaliseRule(m[2])}`)
    else if ((m = /^HP_LINK(DNS|DOMAIN) (.*)$/.exec(line))) s.linkDns.push(`${m[1]} ${m[2].replace(/^Link \d+ /, '').replace(/\s+/g, ' ').trim()}`)
    else if ((m = /^HP_NET (\w+) (\S+)$/.exec(line))) s.nets.push(`${m[1]} ${m[2]}`)
    else if ((m = /^HP_PATH (\S+) ?(.*)$/.exec(line))) s.paths[m[1]] = normaliseRoute(m[2])
    else if ((m = /^HP_COROSYNC (.*)$/.exec(line))) s.corosync.push(m[1].replace(/\s+/g, ' ').trim())
    else if ((m = /^HP_FWSRC (\w+) (present|absent)$/.exec(line))) { if (m[2] === 'present') fwRaw[m[1]] ??= [] }
    else if ((m = /^HP_FWL (\w+) (.*)$/.exec(line))) (fwRaw[m[1]] ??= []).push(m[2])
    else if ((m = /^HP_FWD([46])=(.*)$/.exec(line))) s.forwarding[m[1] === '4' ? 'v4' : 'v6'] = m[2].trim()
    else if ((m = /^HP_RESOLV_LINK=(.*)$/.exec(line))) s.resolvLink = m[1].trim()
    else if ((m = /^HP_RESOLV=(.*)$/.exec(line))) s.resolv = m[1].trim()
    else if ((m = /^HP_RESOLVED=(.*)$/.exec(line))) s.resolved = m[1].trim()
    else if ((m = /^HP_QUORATE=(.*)$/.exec(line))) s.quorate = m[1].trim() || 'unknown'
    else if (line === 'HP_SNAPSHOT_END') sawEnd = true
  }
  for (const [src, lines] of Object.entries(fwRaw)) s.firewall[src] = normaliseFirewall(src, lines)
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

// ── What each client may do ─────────────────────────────────────────────────

const OVERLAY_DEV: Record<ProviderId, RegExp> = { tailscale: /\bdev tailscale\d*\b/, netbird: /\bdev wt\d+\b/ }
const OWN_TABLE: Record<ProviderId, RegExp> = { tailscale: /\btable 52\b/, netbird: /\btable 7120\b/ }
/** Where each client's own routes may point. */
export const OVERLAY_PREFIXES: Record<ProviderId, string[]> = {
  tailscale: ['100.64.0.0/10', 'fd7a:115c:a1e0::/48'],
  netbird:   ['100.64.0.0/10'],
}
/** Each client's policy rules, exactly as `ip rule show` prints them, per family. */
const OWN_RULES: Record<ProviderId, Set<string>> = {
  tailscale: new Set(['4', '6'].flatMap(f => [
    `${f} 5210: from all fwmark 0x80000/0xff0000 lookup main`,
    `${f} 5230: from all fwmark 0x80000/0xff0000 lookup default`,
    `${f} 5250: from all fwmark 0x80000/0xff0000 unreachable`,
    `${f} 5270: from all lookup 52`,
  ])),
  netbird: new Set(['4', '6'].flatMap(f => [
    `${f} 105: from all lookup main suppress_prefixlength 0`,
    `${f} 110: not from all fwmark 0x1bd00 lookup 7120`,
  ])),
}
const ROUTE_TYPES = new Set(['unicast', 'local', 'broadcast', 'multicast', 'throw', 'unreachable', 'prohibit', 'blackhole', 'anycast', 'nat'])
// `local` is not here: a local route is fine only for the overlay itself (checked below like any other).
const HARMLESS_TYPES = new Set(['broadcast', 'multicast', 'throw'])

/** "4 throw 127.0.0.0/8 table 52" → { family, type, dest }. */
export function parseRoute(r: string): { family: '4' | '6'; type: string; dest: string } {
  const [family, ...rest] = r.split(' ')
  let type = 'unicast'
  if (ROUTE_TYPES.has(rest[0])) type = rest.shift()!
  let dest = rest[0] ?? ''
  if (dest === 'default') dest = family === '6' ? '::/0' : '0.0.0.0/0'
  else if (!dest.includes('/')) dest = `${dest}/${family === '6' ? 128 : 32}`
  return { family: family as '4' | '6', type, dest }
}

function prefixLen(c: string): number { return Number(c.split('/')[1]) }

/** Is `inner` entirely inside `outer`? */
function within(inner: string, outer: string): boolean {
  return cidrOverlaps(inner, outer) && prefixLen(inner) >= prefixLen(outer)
}

/** Null when the client may own this route, or why not. */
export function ownRouteProblem(r: string, p: ProviderId): string | null {
  const { family, type, dest } = parseRoute(r)
  if (HARMLESS_TYPES.has(type)) return null
  if (family === '6' && within(dest, 'fe80::/64') && OVERLAY_DEV[p].test(r)) return null
  if (OVERLAY_PREFIXES[p].some(o => within(dest, o))) return null
  const len = prefixLen(dest)
  if (len === 0) return `a default route (${r.slice(2)})`
  if (len <= 2) return `a /${len} split of the default route (${r.slice(2)})`
  return `a route outside the overlay (${r.slice(2)})`
}

function setDiff(a: string[], b: string[]): { added: string[]; removed: string[] } {
  const A = new Set(a), B = new Set(b)
  return { added: b.filter(x => !A.has(x)), removed: a.filter(x => !B.has(x)) }
}

function list(xs: string[], n = 3): string {
  return xs.slice(0, n).map(x => `"${x}"`).join(', ') + (xs.length > n ? ` and ${xs.length - n} more` : '')
}

const FW_NAME: Record<string, string> = { nft: 'nftables', ipt4: 'iptables', ipt6: 'ip6tables', iptl4: 'iptables (legacy)', iptl6: 'ip6tables (legacy)', ipset: 'ipset', ebt: 'ebtables' }

/** Firewall differences only. `churn` is a second sample: lines whose shape changes between samples are noise. */
export function firewallChanges(before: NodeSnapshot, after: NodeSnapshot, churn?: NodeSnapshot): string[] {
  const out: string[] = []
  for (const src of new Set([...Object.keys(before.firewall), ...Object.keys(after.firewall)])) {
    if (!(src in before.firewall) || !(src in after.firewall)) { out.push(`the ${FW_NAME[src] ?? src} ruleset ${src in after.firewall ? 'appeared' : 'disappeared'}`); continue }
    let { added, removed } = setDiff(before.firewall[src], after.firewall[src])
    if (churn && src in churn.firewall) {
      const moving = setDiff(after.firewall[src], churn.firewall[src])
      // Exactly the lines that differ between the two after-samples; a line that only looks similar is not noise.
      const noisy = new Set([...moving.added, ...moving.removed])
      added = added.filter(l => !noisy.has(l))
      removed = removed.filter(l => !noisy.has(l))
    }
    if (added.length || removed.length) {
      out.push(`the ${FW_NAME[src] ?? src} ruleset changed (${[...added.map(l => `added ${l}`), ...removed.map(l => `removed ${l}`)].slice(0, 3).join('; ')})`)
    }
  }
  return out
}

/**
 * Every difference that matters, in plain words. Empty when the node is as it was. `provider` is the client
 * being changed. `churn`, when given, is a second after-sample used only to discount firewall noise.
 */
export function compareSnapshots(before: NodeSnapshot, after: NodeSnapshot, provider?: ProviderId, churn?: NodeSnapshot): string[] {
  if (!after.read) return ['could not read the node\'s routes, resolver, firewall and quorum after the change']
  const out: string[] = []
  const own = (r: string) => !!provider && (OVERLAY_DEV[provider].test(r) || OWN_TABLE[provider].test(r))

  const routes = setDiff(before.routes, after.routes)
  const foreign = [...routes.added.filter(r => !own(r)).map(r => `added ${r}`), ...routes.removed.filter(r => !own(r)).map(r => `removed ${r}`)]
  if (foreign.length) out.push(`the routing tables changed (${foreign.slice(0, 4).join('; ')})`)
  const badOwn = routes.added.filter(own).map(r => ownRouteProblem(r, provider!)).filter((x): x is string => !!x)
  if (badOwn.length) out.push(`the client added ${badOwn.slice(0, 3).join('; ')}`)

  const rules = setDiff(before.rules, after.rules)
  const badRules = [...rules.added, ...rules.removed].filter(r => !(provider && OWN_RULES[provider].has(r)))
  if (badRules.length) out.push(`the policy routing rules changed (${list(badRules)})`)

  for (const peer of new Set([...Object.keys(before.paths), ...Object.keys(after.paths)])) {
    if (before.paths[peer] !== after.paths[peer]) {
      out.push(`the route to ${peer} changed (was "${before.paths[peer] ?? 'none'}", now "${after.paths[peer] ?? 'none'}")`)
    }
  }

  if (before.resolvLink !== after.resolvLink || before.resolv !== after.resolv) {
    out.push(`the resolver changed (was "${before.resolv || 'empty'}" via ${before.resolvLink || '?'}, now "${after.resolv || 'empty'}" via ${after.resolvLink || '?'})`)
  }
  const ownLink = (l: string) => !!provider && (provider === 'tailscale' ? /\(tailscale\d*\)/ : /\(wt\d+\)/).test(l)
  const dns = setDiff(before.linkDns.filter(l => !ownLink(l)), after.linkDns.filter(l => !ownLink(l)))
  const ownLinkSet = after.linkDns.filter(l => ownLink(l) && !/:\s*$/.test(l))
  if (before.resolved !== after.resolved || dns.added.length || dns.removed.length || ownLinkSet.length) {
    out.push(`per-link DNS changed (${list([...dns.added, ...dns.removed, ...ownLinkSet])})`)
  }

  out.push(...firewallChanges(before, after, churn))
  if (before.forwarding.v4 !== after.forwarding.v4 || before.forwarding.v6 !== after.forwarding.v6) {
    out.push(`IP forwarding changed (was ${before.forwarding.v4}/${before.forwarding.v6}, now ${after.forwarding.v4}/${after.forwarding.v6})`)
  }

  const links = setDiff(before.corosync, after.corosync)
  const down = after.corosync.filter(l => !LINK_OK.test(l))
  if (links.added.length || links.removed.length || down.length) out.push(`corosync link state changed (${list([...links.removed.map(l => `was ${l}`), ...links.added.map(l => `now ${l}`)])})`)

  if (!QUORATE_OK.has(after.quorate) || before.quorate !== after.quorate) out.push(`quorum changed (was ${before.quorate}, now ${after.quorate})`)
  return out
}

/** True when the only differences are in the firewall text, where a second sample can tell noise from change. */
export function onlyFirewall(before: NodeSnapshot, after: NodeSnapshot, provider?: ProviderId): boolean {
  const all = compareSnapshots(before, after, provider)
  const fw = firewallChanges(before, after)
  return all.length > 0 && all.length === fw.length
}

/** The cluster's networks as CIDRs: corosync and Ceph peers as host routes, Ceph networks, the node's own. */
export function clusterNetworks(s: NodeSnapshot): string[] {
  return [...new Set(s.nets.map(n => {
    const addr = n.split(' ')[1]
    if (addr.includes('/')) return addr
    return addr.includes(':') ? `${addr}/128` : `${addr}/32`
  }))]
}
