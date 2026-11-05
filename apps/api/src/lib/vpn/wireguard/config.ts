// =============================================================================
//  HyperProx — WireGuard: what is written, and how it is checked
//
//  Pure functions. A machine's interface file never carries its private key:
//  wg-quick loads it from the key file next to it (PostUp), so HyperProx never
//  has it, and no command line ever shows it. Peers change live with `wg set`,
//  which leaves every other peer alone.
// =============================================================================

import { isIP } from 'node:net'
import { cidrOverlaps } from '../../remote/planner'
import { coverageProblem } from '../../remote/coverage'
import { isWgKey } from './keys'

export const IFACE_RE = /^hp-wg\d{1,2}$/
export const NAME_RE = /^[A-Za-z0-9 ._-]{1,40}$/
const ENDPOINT_RE = /^(?:\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]{1,253}):\d{1,5}$/

export interface WgPeerSpec {
  publicKey: string
  allowedIps: string[]
  endpoint?: string | null
  keepalive?: number | null
}

export interface WgInterfaceSpec {
  iface: string
  /** The interface's own tunnel address, e.g. 192.0.2.1/24 on a server, 192.0.2.2/32 on a client. */
  address: string
  listenPort?: number | null
  peers: WgPeerSpec[]
}

export function validCidr(c: string): boolean {
  const m = /^([^/]+)\/(\d{1,3})$/.exec(c)
  if (!m) return false
  const v = isIP(m[1]); const bits = Number(m[2])
  return (v === 4 && bits >= 0 && bits <= 32) || (v === 6 && bits >= 0 && bits <= 128)
}

/** Null when the spec is safe to write, or why not. Every value reaches a file, so all of them are checked. */
export function checkSpec(s: WgInterfaceSpec): string | null {
  if (!IFACE_RE.test(s.iface)) return 'The interface name must look like hp-wg0'
  if (!validCidr(s.address)) return `${s.address} is not an address with a prefix (like 192.0.2.1/24)`
  if (s.listenPort != null && !(Number.isInteger(s.listenPort) && s.listenPort > 0 && s.listenPort < 65536)) return 'The listen port must be 1-65535'
  for (const p of s.peers) {
    if (!isWgKey(p.publicKey)) return 'A peer public key is not a WireGuard key'
    if (!p.allowedIps.length || !p.allowedIps.every(validCidr)) return `Allowed IPs must be addresses with prefixes (${p.allowedIps.join(', ') || 'none given'})`
    if (p.endpoint && !ENDPOINT_RE.test(p.endpoint)) return `${p.endpoint} is not host:port`
    if (p.keepalive != null && !(Number.isInteger(p.keepalive) && p.keepalive >= 0 && p.keepalive <= 3600)) return 'Keepalive must be 0-3600 seconds'
  }
  return null
}

/**
 * Null when these AllowedIPs may be routed on this machine, or why not. Everywhere: nothing overlapping a
 * cluster network. On a Proxmox node also: never the default route, and together (not prefix by prefix) no
 * more than a /8 outside the overlay `pool`, unless it is a declared site-to-site subnet (`sites`), which
 * passes the same overlap checks.
 */
export function checkAllowedIps(allowed: string[], o: { node: boolean; clusterNets: string[]; pool?: string[]; sites?: string[] }): string | null {
  if (o.node) {
    const why = coverageProblem(allowed, [...(o.pool ?? []), ...(o.sites ?? [])], `AllowedIPs ${allowed.join(', ')}`.slice(0, 120))
    if (why) return `${why}; a Proxmox node never routes its default, or a large share of the address space, through WireGuard`
  }
  for (const a of [...allowed, ...(o.sites ?? [])]) {
    const hit = o.clusterNets.find(n => cidrOverlaps(a, n))
    if (hit) return `${a} overlaps the cluster network ${hit}; cluster traffic must stay on the LAN`
  }
  return null
}

/** The interface file. No PrivateKey line: PostUp loads the key from its own file on the machine. */
export function renderInterface(s: WgInterfaceSpec): string {
  const L = [
    '# Managed by HyperProx. Changes here are overwritten.',
    '[Interface]',
    `Address = ${s.address}`,
    ...(s.listenPort ? [`ListenPort = ${s.listenPort}`] : []),
    `PostUp = wg set %i private-key /etc/wireguard/${s.iface}.key`,
  ]
  for (const p of s.peers) {
    L.push('', '[Peer]', `PublicKey = ${p.publicKey}`, `AllowedIPs = ${p.allowedIps.join(', ')}`)
    if (p.endpoint) L.push(`Endpoint = ${p.endpoint}`)
    if (p.keepalive) L.push(`PersistentKeepalive = ${p.keepalive}`)
  }
  return L.join('\n') + '\n'
}

/** A phone or laptop's whole config, for the QR code and the download. Kept in the vault, never in Postgres. */
export function renderClientConfig(o: { privateKey: string; address: string; serverPublicKey: string; endpoint: string; allowedIps: string[]; keepalive?: number | null; dns?: string | null }): string {
  return [
    '[Interface]', `PrivateKey = ${o.privateKey}`, `Address = ${o.address}`, ...(o.dns ? [`DNS = ${o.dns}`] : []),
    '', '[Peer]', `PublicKey = ${o.serverPublicKey}`, `Endpoint = ${o.endpoint}`, `AllowedIPs = ${o.allowedIps.join(', ')}`,
    ...(o.keepalive ? [`PersistentKeepalive = ${o.keepalive}`] : []), '',
  ].join('\n')
}

/** The next free host address in an IPv4 pool, skipping the ones in use. */
export function nextAddress(pool: string, used: string[]): string | null {
  const [base, bitsRaw] = pool.split('/')
  const bits = Number(bitsRaw)
  if (isIP(base) !== 4 || bits < 8 || bits > 30) return null
  const toInt = (ip: string) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0)
  const toIp = (n: number) => [24, 16, 8, 0].map(s => Math.floor(n / 2 ** s) % 256).join('.')
  const net = toInt(base) - (toInt(base) % 2 ** (32 - bits))
  const taken = new Set(used.map(u => toInt(u.split('/')[0])))
  for (let n = net + 1; n < net + 2 ** (32 - bits) - 1; n++) if (!taken.has(n)) return `${toIp(n)}/32`
  return null
}

export interface WgPeerStatus { publicKey: string; endpoint: string | null; allowedIps: string[]; latestHandshake: string | null; rx: number; tx: number; keepalive: number | null }

/** `wg show <if> dump`, peer lines only (the first line, which has the private key, is never read). */
export function parseDump(output: string): WgPeerStatus[] {
  const m = /HP_WG_DUMP_BEGIN\n([\s\S]*?)HP_WG_DUMP_END/.exec(output)
  if (!m) return []
  return m[1].split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const [publicKey, endpoint, allowed, hs, rx, tx, ka] = l.split(/\s+/)
    return {
      publicKey, endpoint: endpoint && endpoint !== '(none)' ? endpoint : null,
      allowedIps: allowed && allowed !== '(none)' ? allowed.split(',') : [],
      latestHandshake: hs && hs !== '0' ? new Date(Number(hs) * 1000).toISOString() : null,
      rx: Number(rx) || 0, tx: Number(tx) || 0, keepalive: ka && ka !== 'off' ? Number(ka) : null,
    }
  }).filter(p => isWgKey(p.publicKey))
}
