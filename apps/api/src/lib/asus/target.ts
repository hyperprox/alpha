// =============================================================================
//  HyperProx — ASUS router: where a router's address may point
//
//  The address receives the router's admin login, from a process that sits next
//  to the vault. So, as for Home Assistant and QNAP (lib/ha-control/target.ts,
//  whose rules these are), it is checked when it is saved AND on every use,
//  against what its name resolves to at that moment, and the request goes to the
//  checked address: a name that later resolves somewhere else (DNS rebinding) is
//  refused at request time. http:// is allowed only to a private address (the
//  LAN, a tailnet, WireGuard); anything else must be https://.
//
//  One rule stricter than Home Assistant's: none of HyperProx's own addresses,
//  on ANY port. A router is never this machine, so there is no port on it that
//  should receive a router's admin login.
// =============================================================================

import net from 'node:net'
import dns from 'node:dns/promises'
import { checkHAAddresses, portOf, type TargetEnv } from '../ha-control/target'
import { canonicalIp, ownAddresses } from '../notify/ssrf'

export class AsusTargetError extends Error {
  constructor(message: string) { super(message); this.name = 'AsusTargetError' }
}

export { portOf }

export function checkAsusAddresses(protocol: string, port: number, addresses: string[], env: TargetEnv = {}): { ok: true } | { ok: false; reason: string } {
  const own = env.own ?? ownAddresses()
  for (const raw of addresses) {
    const ip = canonicalIp(raw)
    if (ip && own.has(ip)) return { ok: false, reason: 'That address is HyperProx\'s own machine, not a router.' }
  }
  const v = checkHAAddresses(protocol, port, addresses, { ...env, own })
  if (v.ok) return v
  return { ok: false, reason: v.reason.replace(/Home Assistant's/g, "the router's").replace(/Home Assistant/g, 'a router') }
}

export type TargetResolver = (u: URL) => Promise<string>
export type Lookup = (host: string) => Promise<string[]>

const dnsLookup: Lookup = async host => (await dns.lookup(host, { all: true, verbatim: true })).map(a => a.address)

/** A resolver with its own name lookup and environment (tests); production uses resolveAsusTarget. */
export function asusResolver(o: { lookup?: Lookup; env?: TargetEnv } = {}): TargetResolver {
  return async (u: URL) => {
    const host = u.hostname.replace(/^\[|\]$/g, '')
    let addresses: string[]
    if (net.isIP(host)) addresses = [host]
    else {
      try { addresses = await (o.lookup ?? dnsLookup)(host) }
      catch { throw new AsusTargetError('That address does not resolve.') }
    }
    const verdict = checkAsusAddresses(u.protocol, portOf(u), addresses, o.env ?? {})
    if (!verdict.ok) throw new AsusTargetError(verdict.reason)
    return addresses[0]
  }
}

/** Resolve the URL's host and check every address. Returns the address to connect to. */
export const resolveAsusTarget: TargetResolver = asusResolver()
