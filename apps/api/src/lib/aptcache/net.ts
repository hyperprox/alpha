// =============================================================================
//  HyperProx — the package cache: which networks may use it
//
//  Only private networks, each written as its network address (no host bits
//  set) and never wider than the private block it sits in: 10/8, 172.16/12 or
//  192.168/16. So 10.0.0.0/7 (which reaches 11.x) and 10.0.5.7/24 (host bits
//  set: a typo, or a guess) are both refused, and so is any number written with
//  a leading zero (010), which tcp wrappers would read as octal. The in-guest
//  helper checks the same rules again before it writes anything.
// =============================================================================

// No leading zeros, anywhere: tcp wrappers read an octet like 010 as octal (8), so 010.0.0.0/8 would let in 8.x.
const OCT = '(0|[1-9]\\d{0,2})'
const CIDR = new RegExp(`^${OCT}\\.${OCT}\\.${OCT}\\.${OCT}\\/(0|[1-9]\\d?)$`)
const IPV4 = new RegExp(`^${OCT}\\.${OCT}\\.${OCT}\\.${OCT}$`)

const toInt = (o: number[]) => ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0
const maskOf = (p: number) => (p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0)
const dotted = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')

/** The private block an address is in (its short name and prefix), or null. */
export function privateBlock(ip: string): { net: string; prefix: number } | null {
  const m = IPV4.exec(String(ip ?? '').trim())
  if (!m) return null
  const o = m.slice(1, 5).map(Number)
  if (o.some(x => x > 255)) return null
  if (o[0] === 10) return { net: '10/8', prefix: 8 }
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return { net: '172.16/12', prefix: 12 }
  if (o[0] === 192 && o[1] === 168) return { net: '192.168/16', prefix: 16 }
  return null
}

export const isPrivateV4 = (ip: string) => privateBlock(ip) !== null

/** Commas, semicolons or white space. */
export function splitNetworks(raw: unknown): string[] {
  return String(raw ?? '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean)
}

/** The plain reason a network cannot be allowed, or null. */
export function networkProblem(c: string): string | null {
  const m = CIDR.exec(c)
  if (!m) return `${c} is not a network like 10.0.5.0/24${/(^|[./])0\d/.test(c) ? ' (no leading zeros: 010 would be read as 8)' : ''}.`
  const o = m.slice(1, 5).map(Number), prefix = Number(m[5])
  if (o.some(x => x > 255) || prefix > 32) return `${c} is not a network address.`
  const block = privateBlock(o.join('.'))
  if (!block) return `${c} is not a private network. Only networks in 10/8, 172.16/12 and 192.168/16 can use the cache, so it is never open to the internet.`
  if (prefix < block.prefix) return `${c} is wider than the private block it starts in (${block.net}), so it would take in public addresses. Use /${block.prefix} or narrower.`
  const n = toInt(o)
  const masked = (n & maskOf(prefix)) >>> 0
  if (masked !== n) return `${c} has host bits set: the network is ${dotted(masked)}/${prefix}.`
  return null
}

/** Each network checked: the plain reason for every one that cannot be used. */
export function networkProblems(list: string[]): string[] {
  const out: string[] = []
  if (list.length > 32) out.push('Give at most 32 networks.')
  for (const c of list) { const p = networkProblem(c); if (p) out.push(p) }
  return out
}

/** Normalised (one space between, no repeats) or the problems. */
export function checkNetworks(raw: unknown, { allowEmpty }: { allowEmpty: boolean }): { value: string; problems: string[] } {
  const list = [...new Set(splitNetworks(raw))]
  if (!list.length) return { value: '', problems: allowEmpty ? [] : ['Give at least one network, like 10.0.5.0/24.'] }
  return { value: list.join(' '), problems: networkProblems(list) }
}

/** The network an address is on (masked), as a.b.c.d/p. */
export function networkOf(ip: string, prefix: number): string | null {
  const m = IPV4.exec(ip)
  if (!m || !(prefix >= 0 && prefix <= 32)) return null
  return `${dotted((toInt(m.slice(1, 5).map(Number)) & maskOf(prefix)) >>> 0)}/${prefix}`
}

/** True when an IPv4 address is inside one of the networks. */
export function inNetworks(ip: string, nets: string[]): boolean {
  const m = IPV4.exec(ip)
  if (!m) return false
  const n = toInt(m.slice(1, 5).map(Number))
  return nets.some(c => {
    const x = CIDR.exec(c)
    if (!x) return false
    const mask = maskOf(Number(x[5]))
    return ((n & mask) >>> 0) === ((toInt(x.slice(1, 5).map(Number)) & mask) >>> 0)
  })
}
