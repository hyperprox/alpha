// =============================================================================
//  HyperProx — how much of the address space a set of prefixes covers
//
//  A node may route a few networks through a tunnel, never a large share of
//  the internet. Prefix length alone is not enough: four /2s are the default
//  route, two /8s are a /7. So prefixes are merged and their union measured.
//  Shared by the WireGuard AllowedIPs check and the node guard.
// =============================================================================

import { isIP } from 'node:net'

type Range = [bigint, bigint] // inclusive

function toBig(addr: string, v: 4 | 6): bigint {
  if (v === 4) return addr.split('.').reduce((a, o) => (a << 8n) + BigInt(Number(o)), 0n)
  let [head, tail] = addr.split('::') as [string, string | undefined]
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : []
  // An embedded IPv4 tail counts as two groups.
  const groups = (xs: string[]) => xs.flatMap(g => (g.includes('.') ? (() => { const n = toBig(g, 4); return [(n >> 16n).toString(16), (n & 0xffffn).toString(16)] })() : [g]))
  const H = groups(h), T = groups(t)
  const all = tail === undefined ? H : [...H, ...Array(8 - H.length - T.length).fill('0'), ...T]
  return all.reduce((a, g) => (a << 16n) + BigInt(parseInt(g || '0', 16)), 0n)
}

function range(cidr: string): { v: 4 | 6; r: Range } | null {
  const m = /^([^/]+)\/(\d{1,3})$/.exec(cidr)
  if (!m) return null
  const v = isIP(m[1]) as 0 | 4 | 6
  if (!v) return null
  const B = v === 4 ? 32n : 128n, bits = BigInt(Number(m[2]))
  if (bits > B) return null
  const size = 1n << (B - bits)
  const start = (toBig(m[1], v) / size) * size
  return { v, r: [start, start + size - 1n] }
}

function merge(rs: Range[]): Range[] {
  const s = [...rs].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const out: Range[] = []
  for (const r of s) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1] + 1n) { if (r[1] > last[1]) last[1] = r[1] } else out.push([r[0], r[1]])
  }
  return out
}

function subtract(a: Range[], b: Range[]): Range[] {
  let cur = merge(a)
  for (const [s, e] of merge(b)) {
    cur = cur.flatMap(([x, y]): Range[] => {
      if (e < x || s > y) return [[x, y]]
      const parts: Range[] = []
      if (s > x) parts.push([x, s - 1n])
      if (e < y) parts.push([e + 1n, y])
      return parts
    })
  }
  return cur
}

const total = (rs: Range[]) => rs.reduce((n, [s, e]) => n + (e - s + 1n), 0n)

/**
 * Null when these prefixes, together, are a small part of the address space; otherwise why not.
 * `exempt` (the overlay pool, declared site subnets) does not count toward the /8 limit, but nothing,
 * exempt or not, may add up to half the space or more: that is the default route in pieces.
 */
export function coverageProblem(cidrs: string[], exempt: string[] = [], what = 'these prefixes'): string | null {
  for (const v of [4, 6] as const) {
    const all = cidrs.map(range).filter((x): x is { v: 4 | 6; r: Range } => !!x && x.v === v).map(x => x.r)
    if (!all.length) continue
    const B = v === 4 ? 32n : 128n
    const merged = merge(all)
    if (total(merged) >= 1n << (B - 1n)) return `${what} cover the default route (half the IPv${v} space or more)`
    const ex = exempt.map(range).filter((x): x is { v: 4 | 6; r: Range } => !!x && x.v === v).map(x => x.r)
    const counted = total(subtract(merged, ex))
    if (counted > 1n << (B - 8n)) return `${what} cover more than a /8 of the IPv${v} space outside the overlay`
  }
  return null
}
