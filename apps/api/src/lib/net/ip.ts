// =============================================================================
//  HyperProx — addresses and networks, in one place
//
//  Every "is this address on that network" question goes through here: the
//  guest-exclusion rule (lib/guest-guard.ts), auto-connect, Homepage, Remote
//  access's routing check and load balancing's corosync check. IPv4 and IPv6;
//  an IPv4-mapped IPv6 address (::ffff:192.0.2.1, or its hex form) counts as
//  the IPv4 address it carries, so it cannot slip past an IPv4 network.
//
//  An address may be written as a bare IP, host:port, [v6]:port or a URL; a
//  name (not an IP) is never inside any network.
//
//  Pure functions, no I/O.
// =============================================================================

import { isIP } from 'node:net'

export interface IP { v: 4 | 6; n: bigint }
export interface Net { v: 4 | 6; base: bigint; bits: number }

const V4_MAPPED = 0xffffn << 32n

/** An IPv4-mapped IPv6 address as the IPv4 it carries; anything else unchanged. */
function unmap(ip: IP): IP {
  return ip.v === 6 && (ip.n >> 32n) === 0xffffn ? { v: 4, n: ip.n & 0xffffffffn } : ip
}

function toBig(ip: string): IP | null {
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

/** A bare IP (v4 or v6, zone id allowed) as a number; an IPv4-mapped IPv6 comes back as IPv4. Null otherwise. */
export function parseIP(ip: string): IP | null {
  const s = String(ip ?? '').trim().replace(/^\[|\]$/g, '')
  const a = toBig(s)
  return a ? unmap(a) : null
}

/**
 * The host part of an address: a URL's hostname, host of host:port or [v6]:port, or the text itself. Lower-case,
 * without brackets. Null for an empty or unreadable URL.
 */
export function hostOf(address: string | null | undefined): string | null {
  const a = String(address ?? '').trim()
  if (!a) return null
  let host = a
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(a)) { try { host = new URL(a).hostname } catch { return null } }
  else if (/^\[[^\]]+\](:\d+)?$/.test(a)) host = a.slice(1, a.indexOf(']'))
  else if (/^[^:]+:\d+$/.test(a)) host = a.slice(0, a.indexOf(':'))
  host = host.replace(/^\[|\]$/g, '').toLowerCase()
  return host || null
}

/** The IP an address (URL, host:port or bare) names; null when it names a host by name or is unreadable. */
export function addressIP(address: string | null | undefined): IP | null {
  const h = hostOf(address)
  return h ? parseIP(h) : null
}

/** The IPv4 an address names, as a 32-bit number (an IPv4-mapped IPv6 counts); null when it is not one. */
export function parseIPv4(address: string | null | undefined): number | null {
  const ip = addressIP(address)
  return ip && ip.v === 4 ? Number(ip.n) : null
}

const maskOf = (v: 4 | 6, bits: number) => {
  const max = v === 4 ? 32 : 128
  return bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(max - bits)
}

/**
 * "a.b.c.d/nn" or "v6/nn" as a network; a bare IP is a one-address network. An IPv4-mapped IPv6 network (::ffff:a.b.c.d/1nn)
 * is read as the IPv4 network it covers. Null when it is not one.
 */
export function parseCidr(c: string): Net | null {
  const m = /^([^/]+)\/(\d{1,3})$/.exec(String(c ?? '').trim())
  const addr = m ? m[1] : String(c ?? '').trim()
  const raw = toBig(addr.replace(/^\[|\]$/g, ''))
  if (!raw) return null
  const max = raw.v === 4 ? 32 : 128
  const bits = m ? Number(m[2]) : max
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return null
  if (raw.v === 6 && (raw.n & (0xffffffffffffffffffffffffn << 32n)) === V4_MAPPED && bits >= 96) {
    const b4 = bits - 96
    return { v: 4, base: raw.n & 0xffffffffn & maskOf(4, b4), bits: b4 }
  }
  return { v: raw.v, base: raw.n & maskOf(raw.v, bits), bits }
}

/** Do two networks (or addresses) share any address? */
export function cidrOverlaps(a: string, b: string): boolean {
  const x = parseCidr(a), y = parseCidr(b)
  if (!x || !y || x.v !== y.v) return false
  const mask = maskOf(x.v, Math.min(x.bits, y.bits))
  return (x.base & mask) === (y.base & mask)
}

/** Is a bare IP inside this network? */
export function cidrContains(cidr: string, ip: string): boolean {
  const a = parseIP(ip), n = parseCidr(cidr)
  if (!a || !n || a.v !== n.v) return false
  return (a.n & maskOf(n.v, n.bits)) === n.base
}

/** Is this address (a URL, host:port or bare IP) inside one of these networks? A name, or a malformed network, never matches. */
export function inCidrs(address: string | null | undefined, cidrs: readonly string[]): boolean {
  const a = addressIP(address)
  if (!a) return false
  return cidrs.some(c => {
    const n = parseCidr(c)
    return !!n && n.v === a.v && (a.n & maskOf(n.v, n.bits)) === n.base
  })
}

export interface CidrRules {
  /** Only IPv4 networks. */
  v4Only?: boolean
  /** The narrowest prefix allowed (a /8 at the widest, say). Default 0 for IPv4 and IPv6. */
  minBits?: number
  /** Require the prefix length to be written. Default true. */
  requirePrefix?: boolean
}

/** Is this one network, written as these rules ask? */
export function validCidr(c: string, rules: CidrRules = {}): boolean {
  const s = String(c ?? '').trim()
  const m = /^([^/]+)\/(\d{1,3})$/.exec(s)
  if (!m && rules.requirePrefix !== false) return false
  const addr = m ? m[1] : s
  const v = isIP(addr)
  if (!v || (rules.v4Only && v !== 4)) return false
  const max = v === 4 ? 32 : 128
  const bits = m ? Number(m[2]) : max
  return bits >= (rules.minBits ?? 0) && bits <= max
}

/** The entries of a list that are not networks under these rules (empty when the list is good). */
export function invalidCidrs(list: readonly string[], rules: CidrRules = {}): string[] {
  return list.filter(c => !validCidr(c, rules))
}

/** A list of networks (separated by commas, semicolons or white space) as entries, empty ones dropped. */
export function splitCidrList(raw: string | null | undefined): string[] {
  return String(raw ?? '').split(/[,;\s]+/).map(s => s.trim()).filter(Boolean)
}

/** scheme, host and port of an http(s) URL (default port by scheme); null when it is not one. */
export function hostPort(url: string | null | undefined): { scheme: string; host: string; port: number } | null {
  if (!url) return null
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80
    return { scheme: u.protocol.slice(0, -1), host: u.hostname.replace(/^\[|\]$/g, '').toLowerCase(), port }
  } catch { return null }
}

const DEFAULT_PORT: Record<string, string> = { 'http:': '80', 'https:': '443' }

export interface Origin { scheme: string; host: string; port: string }

/** scheme (with its colon), host and port of an address; a bare host or host:port is read as http. */
export function originParts(v: string): (Origin & { schemeGiven: boolean; portGiven: boolean }) | null {
  const s = String(v ?? '').trim()
  if (!s) return null
  const schemeGiven = /^[a-z][a-z0-9+.-]*:\/\//i.test(s)
  let u: URL
  try { u = new URL(schemeGiven ? s : `http://${s}`) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return null
  // URL drops a port that is the scheme's default; it was still given when the text names it.
  const portGiven = !!u.port || /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:\[[^\]]*\]|[^/:?#]+):\d+/i.test(s)
  return { scheme: u.protocol, host, port: u.port || DEFAULT_PORT[u.protocol], schemeGiven, portGiven }
}
