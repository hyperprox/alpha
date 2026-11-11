// =============================================================================
//  HyperProx — QNAP: where a NAS's address may point
//
//  A NAS's address receives an admin-chosen login on every read, from a process
//  that sits next to the vault. So, as for Home Assistant (lib/ha-control/
//  target.ts, whose rules these are), the address is checked when it is saved
//  AND every time it is used, against what its name resolves to at that moment,
//  and the request goes to the checked address.
//
//  A NAS reached THROUGH a remote cluster (lib/qnap/transport.ts) is checked by
//  remoteTargetProblem() instead: the request leaves from that cluster's node,
//  so the address must be a literal private IP (no name to resolve on a machine
//  HyperProx does not control), never loopback, link-local or a metadata
//  service, and never the node's own SSH port.
// =============================================================================

import net from 'node:net'
import { checkHAAddresses, portOf, type TargetEnv } from '../ha-control/target'
import { canonicalIp, classifyAddress } from '../notify/ssrf'
import dns from 'node:dns/promises'

export class QnapTargetError extends Error {
  constructor(message: string) { super(message); this.name = 'QnapTargetError' }
}

export { portOf }

const METADATA = new Set(['fd00:ec2:0:0:0:0:0:254', '100.100.100.200'])

/** Home Assistant's address rules, worded for a NAS. */
export function checkQnapAddresses(protocol: string, port: number, addresses: string[], env: TargetEnv = {}): { ok: true } | { ok: false; reason: string } {
  const v = checkHAAddresses(protocol, port, addresses, env)
  if (v.ok) return v
  return { ok: false, reason: v.reason.replace(/Home Assistant's/g, "the NAS's").replace(/Home Assistant/g, 'a NAS') }
}

/** Resolve the URL's host and check every address. Returns the address to connect to. */
export async function resolveQnapTarget(u: URL): Promise<string> {
  const host = u.hostname.replace(/^\[|\]$/g, '')
  let addresses: string[]
  if (net.isIP(host)) addresses = [host]
  else {
    try { addresses = (await dns.lookup(host, { all: true, verbatim: true })).map(a => a.address) }
    catch { throw new QnapTargetError('That address does not resolve.') }
  }
  const verdict = checkQnapAddresses(u.protocol, portOf(u), addresses)
  if (!verdict.ok) throw new QnapTargetError(verdict.reason)
  return addresses[0]
}

export type TargetResolver = (u: URL) => Promise<string>

/** Is this host a literal private address (LAN, ULA)? Tailnet (CGNAT) addresses are routable directly, so not here. */
export function isPrivateLanIp(host: string): boolean {
  const ip = canonicalIp(host.replace(/^\[|\]$/g, ''))
  if (!ip || classifyAddress(ip) !== 'private') return false
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number)
    if (a === 100 && b >= 64 && b <= 127) return false
  }
  return true
}

/** Null when the address may be reached from a remote cluster's node; otherwise why not. */
export function remoteTargetProblem(u: URL, nodeAddress: string | null): string | null {
  const host = u.hostname.replace(/^\[|\]$/g, '')
  const ip = canonicalIp(host)
  if (!ip) return 'Through a remote server, the NAS address must be its IP address on that LAN (for example http://10.0.0.20:8080), not a name.'
  if (METADATA.has(ip)) return 'That address is a metadata service, not a NAS.'
  const cls = classifyAddress(ip)
  if (cls === 'loopback') return 'That address is the remote server itself (loopback). Use the NAS\'s own LAN address.'
  if (cls === 'blocked') return 'That address is link-local, multicast or unspecified; a NAS cannot be there.'
  if (cls !== 'private') return 'Through a remote server, only a private LAN address is reached. A public address should be reached directly over https://.'
  if (nodeAddress && canonicalIp(nodeAddress) === ip) return 'That is the remote server\'s own address, not the NAS.'
  if (portOf(u) === 22) return 'Port 22 is SSH, not the NAS web interface (usually 8080, or 443 for https).'
  return null
}
