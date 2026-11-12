// =============================================================================
//  HyperProx — site metrics: the addresses HyperProx's own requests come from
//
//  A request is HyperProx's own only when its User-Agent says HyperProx AND it
//  comes from one of these addresses. The name is public (this repository is),
//  so a scanner can borrow it; it cannot borrow the address. The addresses are
//  this machine's own (each network interface), the public address its
//  requests to a site's public name leave from (read from the DNS provider's
//  WAN lookup, kept an hour), and any listed in HYPERPROX_OWN_ADDRESSES (for a
//  HyperProx behind NAT, such as in Docker on a host whose address the sites see).
// =============================================================================

import os from 'node:os'

/** Strip an IPv4-mapped IPv6 prefix, so "::ffff:192.0.2.5" and "192.0.2.5" are one address. */
export const plainAddress = (a: string) => String(a ?? '').trim().replace(/^::ffff:/i, '').toLowerCase()

export function localAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(os.networkInterfaces())) for (const i of list ?? []) if (!i.internal) out.push(plainAddress(i.address))
  return out
}

export function envAddresses(raw = process.env.HYPERPROX_OWN_ADDRESSES ?? ''): string[] {
  return raw.split(/[\s,]+/).map(plainAddress).filter(a => /^[0-9a-f.:]+$/.test(a))
}

let wan: { ip: string; at: number } | null = null
const WAN_TTL_MS = 3600_000

/** Every address HyperProx's own requests may come from. A WAN lookup that fails leaves it out, never in. */
export async function ownAddresses(readWan: () => Promise<string> = defaultWan, now = Date.now()): Promise<Set<string>> {
  if (!wan || now - wan.at > WAN_TTL_MS) {
    const ip = await readWan().catch(() => '')
    wan = /^[0-9a-f.:]+$/i.test(ip) ? { ip: plainAddress(ip), at: now } : wan
  }
  return new Set([...localAddresses(), ...envAddresses(), ...(wan ? [wan.ip] : [])])
}

async function defaultWan(): Promise<string> {
  const { GoDaddyClient } = await import('../godaddy-client')
  return (await GoDaddyClient.getWanIP()).ip
}

/** Tests: forget the cached WAN address. */
export const resetOwnAddresses = () => { wan = null }
