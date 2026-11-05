// =============================================================================
//  HyperProx — Remote access: what to do on one machine, decided before doing it
//
//  Pure functions. The planner turns a machine and what detection found into
//  install / adopt / manual / needs-tun / refuse, and builds the client flags.
//  The flags are not defaults the caller may override: they are what is sent.
//  Every NetBird boolean is written out as =true or =false, because NetBird
//  only applies a flag that was given and otherwise keeps the stored value.
// =============================================================================

import { isIP } from 'node:net'
import type { Machine, MachineKind, ProviderId, RoutingRequest } from './types'
import { osSupport, type NetMode, type OsFacts, type Support } from './scripts'

export function safeHostname(raw: string): string {
  const h = raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63).replace(/-+$/, '')
  return h || 'hyperprox-host'
}

/**
 * The client's flags.
 *  Tailscale: never accept DNS or routes; advertising is done only by the routing action. On a node, no
 *    netfilter rules at all (`--netfilter-mode=off`), so pve-firewall stays the only firewall.
 *  NetBird: never configure DNS or accept routes; serve routes only when routing is on. On a node, no firewall
 *    rules of its own (`--disable-firewall=true`). Never `--allow-server-ssh`.
 */
export function clientFlags(p: ProviderId, o: { hostname: string; kind: MachineKind; managementUrl?: string; routing?: RoutingRequest; prefs?: Partial<VpnPrefs> }): string[] {
  const host = safeHostname(o.hostname)
  const node = o.kind === 'node'
  // A node is locked whatever is asked: its own DNS, no accepted routes, no SSH over the overlay.
  const pr = { ...DEFAULT_PREFS, ...(o.prefs ?? {}) }
  const acceptDns = !node && pr.acceptDns
  const acceptRoutes = !node && (pr.acceptRoutes || (p === 'netbird' && !!pr.exitNode))
  const ssh = !node && pr.ssh
  if (p === 'tailscale') {
    return [`--hostname=${host}`, `--accept-dns=${acceptDns}`, `--accept-routes=${acceptRoutes}`,
      ...(ssh ? ['--ssh=true'] : []), ...(node ? ['--netfilter-mode=off'] : [])]
  }
  const routing = !!o.routing && (o.routing.subnets.length > 0 || o.routing.exitNode)
  return [
    ...(o.managementUrl ? [`--management-url=${o.managementUrl}`] : []),
    `--hostname=${host}`,
    `--disable-dns=${!acceptDns}`,
    `--disable-client-routes=${!acceptRoutes}`,
    `--disable-server-routes=${routing ? 'false' : 'true'}`,
    `--disable-firewall=${node ? 'true' : 'false'}`,
    `--allow-server-ssh=${ssh}`,
  ]
}

// ── VPN per-machine settings ─────────────────────────────────────────────────

export interface VpnPrefs {
  acceptDns: boolean
  acceptRoutes: boolean
  ssh: boolean
  advertiseExitNode: boolean
  /** Tailscale: the exit node's overlay IP or MagicDNS name. NetBird: the exit node's network route id. */
  exitNode: string | null
  /** While using an exit node, keep reaching the local network directly (on by default). */
  exitNodeAllowLan: boolean
  subnets: string[]
}

export const DEFAULT_PREFS: VpnPrefs = { acceptDns: false, acceptRoutes: false, ssh: false, advertiseExitNode: false, exitNode: null, exitNodeAllowLan: true, subnets: [] }

// ── The node locks ───────────────────────────────────────────────────────────

/** What a client on a node reports about itself, from TS_PREFS_READBACK or NB_FLAGS_READBACK. */
export type LockObservation =
  | { provider: 'tailscale'; prefs: { acceptDns: boolean; acceptRoutes: boolean; ssh: boolean; netfilterOff: boolean; advertiseExitNode: boolean; exitNode: string | null } }
  | { provider: 'netbird'; flags: Record<string, boolean> }

/**
 * How a client on a Proxmox node differs from the node locks, in words; empty when it meets them. The locks:
 * no overlay DNS, no accepted routes, no overlay SSH, no client firewall rules (Tailscale netfilter off,
 * NetBird firewall off), never an exit node and never using one.
 */
export function nodeLockProblems(o: LockObservation): string[] {
  const out: string[] = []
  if (o.provider === 'tailscale') {
    const p = o.prefs
    if (p.acceptDns) out.push('it accepts DNS from the tailnet')
    if (p.acceptRoutes) out.push('it accepts routes from the tailnet')
    if (p.ssh) out.push('Tailscale SSH is on')
    if (!p.netfilterOff) out.push('it manages netfilter rules (netfilter mode is not off)')
    if (p.advertiseExitNode) out.push('it offers itself as an exit node')
    if (p.exitNode) out.push('it sends its traffic through an exit node')
  } else {
    const f = o.flags
    if (f.DisableDNS !== true) out.push('it accepts DNS from NetBird')
    if (f.DisableClientRoutes !== true) out.push('it accepts routes from NetBird')
    if (f.ServerSSHAllowed === true) out.push('NetBird SSH is on')
    if (f.DisableFirewall !== true) out.push('it manages firewall rules (NetBird firewall is not disabled)')
  }
  return out
}

/**
 * Tailscale flags for `tailscale set` that put a node under the locks, or (`restore`) back as it was. NetBird
 * is reconnected with clientFlags(…, kind 'node'), which already carry the locks.
 */
export function tailscaleLockFlags(prev?: { acceptDns: boolean; acceptRoutes: boolean; ssh: boolean; netfilterMode: number; advertiseExitNode: boolean; exitNode: string | null }): string[] {
  if (!prev) return ['--accept-dns=false', '--accept-routes=false', '--ssh=false', '--netfilter-mode=off', '--exit-node=', '--advertise-exit-node=false']
  const nf = prev.netfilterMode === 0 ? 'off' : prev.netfilterMode === 1 ? 'nodivert' : 'on'
  return [`--accept-dns=${prev.acceptDns}`, `--accept-routes=${prev.acceptRoutes}`, `--ssh=${prev.ssh}`, `--netfilter-mode=${nf}`,
    `--exit-node=${prev.exitNode ?? ''}`, `--advertise-exit-node=${prev.advertiseExitNode}`]
}

/** Null when these settings may be applied to `m`, or why not. Routing overlap is checked by checkRouting. */
export function checkPrefs(m: Machine, p: ProviderId, pr: VpnPrefs): string | null {
  if (m.kind === 'node') {
    if (pr.acceptDns) return 'DNS from the overlay is locked off on a Proxmox node: the node keeps its own resolver.'
    if (pr.acceptRoutes) return 'Accepting routes is locked off on a Proxmox node: cluster traffic must keep its own routing table.'
    if (pr.ssh) return 'SSH over the overlay is locked off on a Proxmox node; use the node\'s own SSH from the LAN or over the overlay with its normal login.'
    if (pr.advertiseExitNode) return 'A Proxmox node is never made an exit node.'
    if (pr.exitNode) return 'A Proxmox node never sends its traffic through an exit node: cluster traffic must stay on the LAN.'
  }
  if (pr.advertiseExitNode && pr.exitNode) return 'A machine cannot both offer itself as an exit node and use one.'
  if (pr.exitNode) {
    const okTs = isIP(pr.exitNode) !== 0 || /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(pr.exitNode)
    const okNb = /^[A-Za-z0-9_-]{1,64}$/.test(pr.exitNode)
    if (p === 'tailscale' ? !okTs : !okNb) return `${pr.exitNode} is not an exit node (${p === 'tailscale' ? 'an overlay IP or MagicDNS name' : 'a NetBird network route id'})`
  }
  return null
}

/** What each change does to this machine, in words. Empty when nothing changes. */
export function describePrefs(m: Machine, p: ProviderId, from: VpnPrefs, to: VpnPrefs): string[] {
  const name = p === 'tailscale' ? 'Tailscale' : 'NetBird'
  const dns = p === 'tailscale' ? 'MagicDNS' : 'NetBird DNS'
  const out: string[] = []
  if (from.acceptDns !== to.acceptDns) out.push(to.acceptDns
    ? `Uses ${dns}: ${name} takes over ${m.name}'s DNS (/etc/resolv.conf or systemd-resolved) so overlay names resolve; ordinary names are still looked up through it.`
    : `Keeps its own DNS: ${m.name}'s /etc/resolv.conf is left as it is, and overlay names will not resolve there.`)
  if (from.acceptRoutes !== to.acceptRoutes) out.push(to.acceptRoutes
    ? `Accepts routes other devices offer: traffic from ${m.name} to those subnets goes through the tunnel.`
    : `Ignores routes other devices offer: ${m.name}'s routing table is not changed by ${name}.`)
  if (from.ssh !== to.ssh) out.push(to.ssh
    ? `${name} SSH on: people your ${p === 'tailscale' ? 'tailnet ACL' : 'NetBird policy'} allows can open a shell on ${m.name} over ${name}.`
    : `${name} SSH off: ${m.name} only takes its own SSH logins.`)
  if (from.exitNode !== to.exitNode) out.push(to.exitNode
    ? `Sends all its internet traffic through ${to.exitNode}.`
    : 'Stops using an exit node: internet traffic goes out directly again.')
  if (to.exitNode && (from.exitNodeAllowLan !== to.exitNodeAllowLan || from.exitNode !== to.exitNode)) out.push(to.exitNodeAllowLan
    ? 'LAN access stays direct, so it keeps reaching the local network.'
    : 'LAN traffic goes through the exit node too: it may lose access to the local network.')
  if (from.advertiseExitNode !== to.advertiseExitNode) out.push(to.advertiseExitNode
    ? `Offers itself as an exit node: devices that choose it send their internet traffic through ${m.name}.`
    : 'Stops offering itself as an exit node.')
  if (JSON.stringify([...from.subnets].sort()) !== JSON.stringify([...to.subnets].sort())) out.push(to.subnets.length
    ? `Offers ${to.subnets.join(', ')} to the overlay: devices that accept routes reach those subnets through ${m.name}.`
    : 'Stops offering subnets.')
  return out
}

export type ExistingChoice = 'adopt' | 'adopt-lock' | 'replace'

export type InstallPlan =
  | { kind: 'install'; support: Extract<Support, { ok: true }>; mode: NetMode; existing: boolean }
  | { kind: 'adopt'; lock: boolean }
  | { kind: 'manual'; os: 'windows' | 'macos' }
  | { kind: 'needs-tun' }
  | { kind: 'refuse'; reason: string }

export function planInstall(o: {
  machine: Machine; provider: ProviderId; facts: OsFacts | null; mode?: NetMode
  /** HyperProx already has a record for this machine and provider (a re-run of its own install). */
  managed?: boolean
  existing?: ExistingChoice
}): InstallPlan {
  const { machine: m } = o
  if (m.kind === 'qemu' && /^win/i.test(m.ostype ?? '')) return { kind: 'manual', os: 'windows' }
  if (!m.running) return { kind: 'refuse', reason: `${m.name} is not running` }
  if (!o.facts) return { kind: 'refuse', reason: `could not read the operating system of ${m.name}` }
  const s = osSupport(o.facts)
  if (!s.ok) return s.manual ? { kind: 'manual', os: s.manual } : { kind: 'refuse', reason: s.reason }
  if (!o.facts.root) return { kind: 'refuse', reason: `the login used for ${m.name} is not root and cannot use sudo without a password` }

  const present = o.facts.installed[o.provider]
  if (present && !o.managed) {
    if (o.existing === 'adopt' || o.existing === 'adopt-lock') return { kind: 'adopt', lock: o.existing === 'adopt-lock' }
    if (o.existing !== 'replace') {
      return { kind: 'refuse', reason: `${m.name} already runs ${o.provider === 'tailscale' ? 'Tailscale' : 'NetBird'} (${present}), which HyperProx did not install. ` +
        'Choose “adopt” to record it as it is (nothing on the machine changes), or “replace” to sign it in to the configured account (its current state is kept aside and put back if anything goes wrong).' }
    }
  }

  if (m.kind === 'node' && o.mode === 'userspace') {
    return { kind: 'refuse', reason: 'userspace networking is for containers without /dev/net/tun; a Proxmox node uses the kernel device' }
  }
  const mode: NetMode = o.mode ?? 'kernel'
  if (mode === 'kernel' && !o.facts.tun) {
    if (m.kind === 'lxc') return { kind: 'needs-tun' }
    return { kind: 'refuse', reason: `${m.name} has no usable /dev/net/tun` }
  }
  return { kind: 'install', support: s, mode, existing: !!present }
}

export interface TunFix { configured: boolean; param?: string; value?: string; command?: string }

const TUN_RAW = /(\/dev\/net\/tun|dev\/net\/tun|c 10:200 )/

/**
 * The `devN: /dev/net/tun` change for a container, or that it is already there (and needs a restart). Raw
 * `lxc.*` lines come back from the API as one `lxc: [[key, value], ...]` array; those count too.
 */
export function tunFix(config: Record<string, unknown>, vmid: number): TunFix {
  const keys = Object.keys(config)
  const raw = Array.isArray(config.lxc) ? (config.lxc as unknown[]).filter(Array.isArray).map(x => [String((x as unknown[])[0]), String((x as unknown[])[1] ?? '')]) : []
  const has = keys.some(k => {
    const v = String(config[k] ?? '')
    if (/^dev\d+$/.test(k)) return v.split(',')[0] === '/dev/net/tun'
    if (k.startsWith('lxc.')) return TUN_RAW.test(`${v} `)
    return false
  }) || raw.some(([k, v]) => /^lxc\.(mount\.entry|cgroup2?\.devices\.allow)$/.test(k) && TUN_RAW.test(`${v} `))
  if (has) return { configured: true }
  let i = 0
  while (keys.includes(`dev${i}`)) i++
  return { configured: false, param: `dev${i}`, value: '/dev/net/tun', command: `pct set ${vmid} --dev${i} /dev/net/tun` }
}

// ── Address arithmetic, IPv4 and IPv6 ───────────────────────────────────────

function toBig(ip: string): { v: 4 | 6; n: bigint } | null {
  const ver = isIP(ip)
  if (ver === 4) return { v: 4, n: ip.split('.').reduce((a, o) => (a << 8n) + BigInt(Number(o)), 0n) }
  if (ver === 6) {
    let s = ip.toLowerCase().split('%')[0]
    if (s.includes('.')) {   // ::ffff:192.0.2.1
      const i = s.lastIndexOf(':'); const v4 = toBig(s.slice(i + 1))
      if (!v4) return null
      s = `${s.slice(0, i)}:${((v4.n >> 16n) & 0xffffn).toString(16)}:${(v4.n & 0xffffn).toString(16)}`
    }
    const [h, t] = s.split('::')
    const head = h ? h.split(':') : []
    const tail = t !== undefined ? (t ? t.split(':') : []) : []
    const groups = t !== undefined ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail] : head
    if (groups.length !== 8) return null
    return { v: 6, n: groups.reduce((a, g) => (a << 16n) + BigInt(parseInt(g || '0', 16)), 0n) }
  }
  return null
}

interface Net { v: 4 | 6; base: bigint; bits: number }

function parseCidr(c: string): Net | null {
  const m = /^([^/]+)\/(\d{1,3})$/.exec(c.trim())
  const addr = m ? m[1] : c.trim()
  const a = toBig(addr)
  if (!a) return null
  const max = a.v === 4 ? 32 : 128
  const bits = m ? Number(m[2]) : max
  if (bits < 0 || bits > max) return null
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(max - bits)
  return { v: a.v, base: a.n & mask, bits }
}

/** Do two networks share any address? */
export function cidrOverlaps(a: string, b: string): boolean {
  const x = parseCidr(a), y = parseCidr(b)
  if (!x || !y || x.v !== y.v) return false
  const max = x.v === 4 ? 32 : 128
  const bits = Math.min(x.bits, y.bits)
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(max - bits)
  return (x.base & mask) === (y.base & mask)
}

/** Does IPv4 or IPv6 `cidr` contain `ip`? */
export function cidrContains(cidr: string, ip: string): boolean {
  return isIP(ip) !== 0 && cidrOverlaps(cidr, ip)
}

function validCidr(c: string): boolean {
  const m = /^([^/]+)\/(\d{1,3})$/.exec(c)
  if (!m) return false
  const v = isIP(m[1]); const bits = Number(m[2])
  return (v === 4 && bits >= 1 && bits <= 32) || (v === 6 && bits >= 1 && bits <= 128)
}

export const ROUTING_WARNING =
  'Cluster traffic (corosync, Ceph, migration) must stay on the LAN. Advertising a subnet that contains the ' +
  'cluster network from a node can move that traffic into the tunnel and get nodes fenced.'

/**
 * Null when the request may go ahead, or the reason it may not. `clusterNets` are every corosync link, Ceph
 * network and monitor, and the node's own addresses (IPv4 and IPv6), read from the node itself.
 */
export function checkRouting(m: Machine, r: RoutingRequest, acknowledged: boolean, clusterNets: string[] = []): string | null {
  const turningOn = r.subnets.length > 0 || r.exitNode
  if (m.kind === 'node' && r.exitNode) return 'A Proxmox node is never made an exit node: it would forward and masquerade other devices\' internet traffic on the hypervisor.'
  if (turningOn && !acknowledged) return `Routing through ${m.name} must be acknowledged: ${ROUTING_WARNING}`
  if (r.subnets.length > 32) return 'At most 32 subnets'
  for (const s of r.subnets) if (!validCidr(s)) return `${s} is not a subnet (expected something like 198.51.100.0/24)`
  const nets = [...clusterNets, ...(m.address ? [m.address] : [])]
  for (const s of r.subnets) {
    const hit = nets.find(n => cidrOverlaps(s, n))
    if (hit) return `${s} overlaps the cluster network ${hit}. Advertising the cluster network is refused: ${ROUTING_WARNING}`
  }
  return null
}
