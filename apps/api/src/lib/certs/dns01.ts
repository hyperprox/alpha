// =============================================================================
//  HyperProx — Certificates: DNS-01 challenge records
//
//  Two rules shape this file:
//    - A provider adds a TXT value beside whatever the name already holds and
//      removes only the value it added. An apex and its wildcard need two
//      values on one name at the same time, and unrelated TXT records (SPF on
//      a shared name, another tool's challenge) must survive.
//    - Propagation is checked on the zone's authoritative nameservers, never a
//      recursive resolver: a resolver that cached the NXDOMAIN keeps saying
//      "not there" for the negative TTL, and one that answers early proves
//      nothing about what the CA's resolver will see.
// =============================================================================

import { Resolver } from 'node:dns/promises'
import type { GoDaddyClient } from '../godaddy-client'

export interface DnsProvider {
  name: string
  zones(): Promise<string[]>
  present(zone: string, fqdn: string, value: string): Promise<void>
  /** Removes only `value`; other TXT values of the name stay. */
  cleanup(zone: string, fqdn: string, value: string): Promise<void>
}

export const CHALLENGE_TTL = 600

function norm(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, '')
}

/** The managed zone containing `fqdn`: the longest zone that equals it or is a suffix at a label boundary. */
export function findZone(fqdn: string, zones: string[]): string | null {
  const n = norm(fqdn).replace(/^\*\./, '')
  let best: string | null = null
  for (const raw of zones) {
    const z = norm(raw)
    if (!z) continue
    if ((n === z || n.endsWith('.' + z)) && (!best || z.length > best.length)) best = z
  }
  return best
}

/** The record name relative to its zone, as GoDaddy wants it: `_acme-challenge.mail` in `example.com`. */
export function relativeName(zone: string, fqdn: string): string {
  const z = norm(zone), n = norm(fqdn)
  if (n === z) return '@'
  if (!n.endsWith('.' + z)) throw new Error(`${n} is not inside zone ${z}`)
  return n.slice(0, -(z.length + 1))
}

export function godaddyProvider(client: GoDaddyClient): DnsProvider {
  async function txtValues(zone: string, rel: string) {
    const all = await client.getRecords(zone, 'TXT')
    return all.filter(r => norm(r.name) === rel)
  }

  return {
    name: 'godaddy',

    async zones() {
      return (await client.getDomains()).map(d => norm(d.domain))
    },

    async present(rawZone, fqdn, value) {
      const zone = norm(rawZone), rel = relativeName(zone, fqdn)
      // A retry after a timeout may find its own value already there; adding it twice is an API error.
      if ((await txtValues(zone, rel)).some(r => r.data === value)) return
      // PATCH appends: existing values of the name are untouched.
      await client.createRecord(zone, { type: 'TXT', name: rel, data: value, ttl: CHALLENGE_TTL })
    },

    async cleanup(rawZone, fqdn, value) {
      const zone = norm(rawZone), rel = relativeName(zone, fqdn)
      const records = await txtValues(zone, rel)
      const keep = records.filter(r => r.data !== value)
      if (keep.length === records.length) return
      if (!keep.length) { await client.deleteRecord(zone, 'TXT', rel); return }
      // GoDaddy has no per-value delete. PUT replaces every value of the name; the client's PUT carries one
      // record, so the first survivor goes back with the PUT and any others are appended after it.
      const [first, ...rest] = keep
      await client.updateRecord(zone, 'TXT', rel, { data: first.data, ttl: first.ttl })
      for (const r of rest) await client.createRecord(zone, { type: 'TXT', name: rel, data: r.data, ttl: r.ttl })
    },
  }
}

// --- Propagation ---------------------------------------------------------------------

export interface PropagationOpts {
  timeoutMs?:  number
  intervalMs?: number
  /** The zone's authoritative nameserver addresses (`ip` or `ip:port`); injectable for tests. */
  authoritative?: (zone: string) => Promise<string[]>
  zone?: string
}

/** The zone apex for `fqdn`: the nearest enclosing name that has NS records. */
async function zoneOf(fqdn: string): Promise<string> {
  const r = new Resolver({ timeout: 5000, tries: 2 })
  const labels = norm(fqdn).split('.')
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join('.')
    try { if ((await r.resolveNs(candidate)).length) return candidate } catch { /* not a zone apex */ }
  }
  throw new Error(`no zone with NS records found above ${fqdn}`)
}

/** Addresses of the zone's authoritative nameservers, from its NS records. */
export async function authoritativeServers(zone: string): Promise<string[]> {
  const r = new Resolver({ timeout: 5000, tries: 2 })
  const ns = await r.resolveNs(norm(zone))
  const ips = new Set<string>()
  for (const host of ns) {
    let v4: string[] = []
    try { v4 = await r.resolve4(host) } catch { /* try v6 */ }
    if (v4.length) { v4.forEach(ip => ips.add(ip)); continue }
    try { (await r.resolve6(host)).forEach(ip => ips.add(ip)) } catch { /* unreachable name server */ }
  }
  if (!ips.size) throw new Error(`no address for any name server of ${zone} (${ns.join(', ')})`)
  return [...ips]
}

async function visibleOn(server: string, fqdn: string, value: string): Promise<boolean> {
  const r = new Resolver({ timeout: 5000, tries: 1 })
  r.setServers([server])
  try {
    const records = await r.resolveTxt(fqdn)
    return records.some(chunks => chunks.join('') === value)
  } catch {
    return false
  }
}

/** Resolves once every authoritative server serves `value` at `fqdn`; rejects at the timeout. */
export async function waitForPropagation(fqdn: string, value: string, opts: PropagationOpts = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000
  const intervalMs = opts.intervalMs ?? 15_000
  const name = norm(fqdn)
  const zone = opts.zone ?? await zoneOf(name)
  const servers = await (opts.authoritative ?? authoritativeServers)(zone)
  if (!servers.length) throw new Error(`no authoritative name servers for ${zone}`)

  const deadline = Date.now() + timeoutMs
  let missing = servers
  for (;;) {
    const seen = await Promise.all(missing.map(s => visibleOn(s, name, value)))
    missing = missing.filter((_, i) => !seen[i])
    if (!missing.length) return
    if (Date.now() + intervalMs > deadline) {
      throw new Error(`TXT ${name} not visible on ${missing.join(', ')} after ${Math.round(timeoutMs / 1000)} s`)
    }
    await new Promise(r => setTimeout(r, intervalMs))
  }
}
