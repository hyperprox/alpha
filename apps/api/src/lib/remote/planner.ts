// =============================================================================
//  HyperProx — Remote access: what to do on one machine, decided before doing it
//
//  Pure functions. The planner turns a machine and what detection found into
//  install / manual / needs-tun / refuse, and builds the client flags. The flags
//  are not defaults the caller may override: they are what is sent. The only way
//  to route through a machine is the explicit routing action, checked by
//  checkRouting().
// =============================================================================

import { isIP } from 'node:net'
import type { Machine, ProviderId, RoutingRequest } from './types'
import { osSupport, type NetMode, type OsFacts, type Support } from './scripts'

export function safeHostname(raw: string): string {
  const h = raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63).replace(/-+$/, '')
  return h || 'hyperprox-host'
}

/**
 * The client's flags. Tailscale: never accept DNS or routes; advertising is done only by the routing action.
 * NetBird: never configure DNS or accept routes; serve routes only when routing has been turned on.
 */
export function clientFlags(p: ProviderId, o: { hostname: string; managementUrl?: string; routing?: RoutingRequest }): string[] {
  const host = safeHostname(o.hostname)
  if (p === 'tailscale') return [`--hostname=${host}`, '--accept-dns=false', '--accept-routes=false']
  const routing = !!o.routing && (o.routing.subnets.length > 0 || o.routing.exitNode)
  return [
    ...(o.managementUrl ? [`--management-url=${o.managementUrl}`] : []),
    `--hostname=${host}`,
    '--disable-dns',
    '--disable-client-routes',
    ...(routing ? [] : ['--disable-server-routes']),
  ]
}

export type InstallPlan =
  | { kind: 'install'; support: Extract<Support, { ok: true }>; mode: NetMode; reinstall: boolean }
  | { kind: 'manual'; os: 'windows' | 'macos' }
  | { kind: 'needs-tun' }
  | { kind: 'refuse'; reason: string }

export function planInstall(o: { machine: Machine; provider: ProviderId; facts: OsFacts | null; mode?: NetMode }): InstallPlan {
  const { machine: m } = o
  if (m.kind === 'qemu' && /^win/i.test(m.ostype ?? '')) return { kind: 'manual', os: 'windows' }
  if (!m.running) return { kind: 'refuse', reason: `${m.name} is not running` }
  if (!o.facts) return { kind: 'refuse', reason: `could not read the operating system of ${m.name}` }
  const s = osSupport(o.facts)
  if (!s.ok) return s.manual ? { kind: 'manual', os: s.manual } : { kind: 'refuse', reason: s.reason }
  if (!o.facts.root) return { kind: 'refuse', reason: `the login used for ${m.name} is not root and cannot use sudo without a password` }
  if (m.kind === 'node' && o.mode === 'userspace') {
    return { kind: 'refuse', reason: 'userspace networking is for containers without /dev/net/tun; a Proxmox node uses the kernel device' }
  }
  const mode: NetMode = o.mode ?? 'kernel'
  if (mode === 'kernel' && !o.facts.tun) {
    if (m.kind === 'lxc') return { kind: 'needs-tun' }
    return { kind: 'refuse', reason: `${m.name} has no usable /dev/net/tun` }
  }
  return { kind: 'install', support: s, mode, reinstall: !!o.facts.installed[o.provider] }
}

export interface TunFix { configured: boolean; param?: string; value?: string; command?: string }

/** The `devN: /dev/net/tun` change for a container, or that it is already there (and needs a restart). */
export function tunFix(config: Record<string, unknown>, vmid: number): TunFix {
  const keys = Object.keys(config)
  const has = keys.some(k => {
    const v = String(config[k] ?? '')
    if (/^dev\d+$/.test(k)) return v.split(',')[0] === '/dev/net/tun'
    if (k === 'lxc.mount.entry' || k.startsWith('lxc.mount.entry')) return /\/dev\/net\/tun|dev\/net\/tun/.test(v)
    return false
  })
  if (has) return { configured: true }
  let i = 0
  while (keys.includes(`dev${i}`)) i++
  return { configured: false, param: `dev${i}`, value: '/dev/net/tun', command: `pct set ${vmid} --dev${i} /dev/net/tun` }
}

function ipv4ToInt(ip: string): number { return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0 }

/** Does IPv4 `cidr` contain `ip`? */
export function cidrContains(cidr: string, ip: string): boolean {
  const [net, bitsRaw] = cidr.split('/')
  const bits = Number(bitsRaw)
  if (isIP(net) !== 4 || isIP(ip) !== 4) return false
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return (ipv4ToInt(net) & mask) === (ipv4ToInt(ip) & mask)
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

/** Null when the request may go ahead, or the reason it may not. */
export function checkRouting(m: Machine, r: RoutingRequest, acknowledged: boolean): string | null {
  const turningOn = r.subnets.length > 0 || r.exitNode
  if (turningOn && !acknowledged) return `Routing through ${m.name} must be acknowledged: ${ROUTING_WARNING}`
  if (r.subnets.length > 32) return 'At most 32 subnets'
  for (const s of r.subnets) if (!validCidr(s)) return `${s} is not a subnet (expected something like 198.51.100.0/24)`
  if (m.kind === 'node' && m.address) {
    const hit = r.subnets.find(s => cidrContains(s, m.address!))
    if (hit) return `${hit} contains this node's cluster address. Advertising the cluster network from a node is refused: ${ROUTING_WARNING}`
  }
  return null
}
