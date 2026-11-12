// =============================================================================
//  HyperProx — ASUS router: where a router's address may point
//
//  The address receives the router's admin login, from a process that sits next
//  to the vault. So, as for Home Assistant and QNAP (lib/ha-control/target.ts,
//  whose rules these are), it is checked when it is saved AND on every use,
//  against what its name resolves to at that moment, and the request goes to the
//  checked address. http:// is allowed only to a private address (the LAN, a
//  tailnet, WireGuard); anything else must be https://.
// =============================================================================

import net from 'node:net'
import dns from 'node:dns/promises'
import { checkHAAddresses, portOf, type TargetEnv } from '../ha-control/target'

export class AsusTargetError extends Error {
  constructor(message: string) { super(message); this.name = 'AsusTargetError' }
}

export { portOf }

export function checkAsusAddresses(protocol: string, port: number, addresses: string[], env: TargetEnv = {}): { ok: true } | { ok: false; reason: string } {
  const v = checkHAAddresses(protocol, port, addresses, env)
  if (v.ok) return v
  return { ok: false, reason: v.reason.replace(/Home Assistant's/g, "the router's").replace(/Home Assistant/g, 'a router') }
}

export type TargetResolver = (u: URL) => Promise<string>

/** Resolve the URL's host and check every address. Returns the address to connect to. */
export async function resolveAsusTarget(u: URL): Promise<string> {
  const host = u.hostname.replace(/^\[|\]$/g, '')
  let addresses: string[]
  if (net.isIP(host)) addresses = [host]
  else {
    try { addresses = (await dns.lookup(host, { all: true, verbatim: true })).map(a => a.address) }
    catch { throw new AsusTargetError('That address does not resolve.') }
  }
  const verdict = checkAsusAddresses(u.protocol, portOf(u), addresses)
  if (!verdict.ok) throw new AsusTargetError(verdict.reason)
  return addresses[0]
}
