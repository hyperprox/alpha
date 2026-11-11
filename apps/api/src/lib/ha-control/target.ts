// =============================================================================
//  HyperProx — Home Assistant control: where a house's address may point
//
//  A house's address is typed by an admin and then receives a long-lived token on
//  every request, from a process that sits next to the vault, Postgres and the
//  API itself. So the address is checked when it is saved AND every time it is
//  used, against the addresses its name resolves to at that moment, and the
//  request goes to the checked address (Host and TLS name unchanged): a name that
//  later resolves somewhere else (DNS rebinding) gets nowhere.
//
//    - loopback, link-local (cloud metadata included), unspecified, multicast:
//      always refused, as are this host's container networks;
//    - this host's own addresses: refused on HyperProx's own service ports;
//    - http:// only to a private address (RFC 1918, CGNAT tailnets, IPv6 ULA),
//      which covers a LAN, Tailscale and WireGuard; anything public needs https.
//
//  The address classes and service ports are the notification guard's
//  (lib/notify/ssrf.ts), so the two cannot drift apart.
// =============================================================================

import dns from 'node:dns/promises'
import net from 'node:net'
import { bridgeNets, canonicalIp, classifyAddress, ownAddresses, ownServicePorts } from '../notify/ssrf'

export class HATargetError extends Error {
  constructor(message: string) { super(message); this.name = 'HATargetError' }
}

/** fd00:ec2::254 and friends: metadata services that live inside private ranges. */
const METADATA = new Set(['fd00:ec2:0:0:0:0:0:254', '100.100.100.200'])

export interface TargetEnv {
  own?:     Set<string>
  ports?:   Set<number>
  bridges?: net.BlockList
}

/** Pure: may a request with this scheme and port go to every one of these addresses? */
export function checkHAAddresses(protocol: string, port: number, addresses: string[], env: TargetEnv = {}): { ok: true } | { ok: false; reason: string } {
  if (!addresses.length) return { ok: false, reason: 'That address does not resolve.' }
  const own = env.own ?? ownAddresses()
  const ports = env.ports ?? ownServicePorts()
  const bridges = env.bridges ?? bridgeNets()
  for (const raw of addresses) {
    const ip = canonicalIp(raw)
    if (!ip) return { ok: false, reason: 'That address does not resolve to an IP address.' }
    const cls = classifyAddress(ip)
    if (cls === 'blocked' || METADATA.has(ip)) return { ok: false, reason: 'That address is link-local, multicast or a metadata service; Home Assistant cannot be there.' }
    if (cls === 'loopback') return { ok: false, reason: 'That address is this machine (loopback). Use Home Assistant\'s LAN or tailnet address.' }
    if (bridges.check(ip, net.isIP(ip) === 4 ? 'ipv4' : 'ipv6')) return { ok: false, reason: 'That address is inside HyperProx\'s own container network.' }
    if (own.has(ip) && ports.has(port)) return { ok: false, reason: `Port ${port} on this machine is one of HyperProx's own services, not Home Assistant.` }
    if (protocol === 'http:' && cls !== 'private') return { ok: false, reason: 'http:// is only allowed to a private address (your LAN, Tailscale or WireGuard). Use https:// for anything else.' }
  }
  return { ok: true }
}

export function portOf(u: URL): number {
  return u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80
}

/** Resolve the URL's host and check every address. Returns the address to connect to. */
export async function resolveHATarget(u: URL): Promise<string> {
  const host = u.hostname.replace(/^\[|\]$/g, '')
  let addresses: string[]
  if (net.isIP(host)) addresses = [host]
  else {
    try { addresses = (await dns.lookup(host, { all: true, verbatim: true })).map(a => a.address) }
    catch { throw new HATargetError('That address does not resolve.') }
  }
  const verdict = checkHAAddresses(u.protocol, portOf(u), addresses)
  if (!verdict.ok) throw new HATargetError(verdict.reason)
  return addresses[0]
}

export type TargetResolver = (u: URL) => Promise<string>
