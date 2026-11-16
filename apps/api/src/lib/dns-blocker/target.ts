// =============================================================================
//  HyperProx — DNS blockers: where an address may point
//
//  A blocker's address receives its login on every read, from a process that sits next to the vault. So, as for Home
//  Assistant and QNAP (lib/ha-control/target.ts, whose rules these are), the address is checked when it is saved AND
//  every time it is used, against what its name resolves to at that moment, and the request goes to the checked address.
//  http:// is allowed only to a private address (a blocker lives on your own network); never loopback, link-local, a
//  metadata service or HyperProx's own services.
// =============================================================================

import net from 'node:net'
import dns from 'node:dns/promises'
import { checkHAAddresses, portOf, type TargetEnv } from '../ha-control/target'

export class DnsTargetError extends Error {
  constructor(message: string) { super(message); this.name = 'DnsTargetError' }
}

export { portOf }

/** Home Assistant's address rules, worded for a DNS blocker. */
export function checkBlockerAddresses(protocol: string, port: number, addresses: string[], env: TargetEnv = {}): { ok: true } | { ok: false; reason: string } {
  const v = checkHAAddresses(protocol, port, addresses, env)
  if (v.ok) return v
  return {
    ok: false,
    reason: v.reason
      .replace(/Home Assistant's/g, 'the DNS blocker\'s').replace(/Home Assistant's LAN or tailnet address/g, 'the blocker\'s LAN address')
      .replace(/Use Home Assistant\b/g, 'Use the blocker').replace(/Home Assistant/g, 'a DNS blocker'),
  }
}

/** Resolve the URL's host and check every address. Returns the address to connect to. */
export async function resolveBlockerTarget(u: URL): Promise<string> {
  const host = u.hostname.replace(/^\[|\]$/g, '')
  let addresses: string[]
  if (net.isIP(host)) addresses = [host]
  else {
    try { addresses = (await dns.lookup(host, { all: true, verbatim: true })).map(a => a.address) }
    catch { throw new DnsTargetError('That address does not resolve.') }
  }
  const verdict = checkBlockerAddresses(u.protocol, portOf(u), addresses)
  if (!verdict.ok) throw new DnsTargetError(verdict.reason)
  return addresses[0]
}

export type TargetResolver = (u: URL) => Promise<string>

/**
 * The IP address to send the DNS test lookup to, from the blocker's address: its literal IP, or what its name resolves
 * to (checked by the same rules). Null when it cannot be worked out.
 */
export async function dnsAddressOf(url: string, resolve: TargetResolver = resolveBlockerTarget): Promise<string | null> {
  try { return await resolve(new URL(url)) } catch { return null }
}
