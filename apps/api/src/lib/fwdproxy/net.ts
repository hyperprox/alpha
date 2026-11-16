// =============================================================================
//  HyperProx — 3proxy: which networks may be named
//
//  A forward proxy is only ever offered to private networks. A public client
//  network, or a public address for the proxy itself, would make it an open
//  proxy on the internet, which is refused here before anything is installed
//  (the in-guest helper refuses it again).
// =============================================================================

const CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** 10/8, 172.16/12, 192.168/16: the only places a proxy may listen or take clients from. */
export function isPrivateV4(ip: string): boolean {
  const m = IPV4.exec(String(ip ?? '').trim())
  if (!m) return false
  const [a, b, c, d] = m.slice(1, 5).map(Number)
  if ([a, b, c, d].some(o => o > 255)) return false
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/** Commas, semicolons or spaces. */
export function splitNetworks(raw: unknown): string[] {
  return String(raw ?? '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean)
}

const OCTET = /^(0|[1-9]\d{0,2})$/
/** The private blocks and the widest prefix inside each. */
const BLOCKS: Array<{ base: number; prefix: number; name: string }> = [
  { base: 10 << 24 >>> 0, prefix: 8, name: '10.0.0.0/8' },
  { base: ((172 << 24) | (16 << 16)) >>> 0, prefix: 12, name: '172.16.0.0/12' },
  { base: ((192 << 24) | (168 << 16)) >>> 0, prefix: 16, name: '192.168.0.0/16' },
]
const maskOf = (p: number) => (p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0)
const dotted = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')

/**
 * One network, checked, or the reason it cannot be used: a network address (no host bits) inside 10.0.0.0/8,
 * 172.16.0.0/12 or 192.168.0.0/16 and no wider than that block, so the whole range it names is private.
 */
export function networkProblem(c: string): string | null {
  const m = CIDR.exec(c)
  if (!m) return `${c} is not a network like 10.0.5.0/24.`
  const parts = m.slice(1, 6)
  if (!parts.every(o => OCTET.test(o))) return `${c} is not a network address (no leading zeros).`
  const octets = parts.slice(0, 4).map(Number), prefix = Number(parts[4])
  if (octets.some(o => o > 255) || prefix > 32) return `${c} is not a network address.`
  const num = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
  const net = (num & maskOf(prefix)) >>> 0
  if (net !== num) return `${c} has host bits set: write the network address, ${dotted(net)}/${prefix}.`
  const block = BLOCKS.find(b => ((num & maskOf(b.prefix)) >>> 0) === b.base)
  if (!block) return `${c} is not a private network, so the proxy would be open to the internet. Only networks inside 10.0.0.0/8, 172.16.0.0/12 and 192.168.0.0/16 can be allowed.`
  if (prefix < block.prefix) return `${c} is too wide: it reaches outside ${block.name}.`
  return null
}

/** Each network, checked: the plain reason for every one that cannot be used. */
export function networkProblems(list: string[]): string[] {
  const out: string[] = []
  if (list.length > 32) out.push('Give at most 32 networks.')
  for (const c of list) { const p = networkProblem(c); if (p) out.push(p) }
  return out
}

/** Normalised (one space between) or the problems. */
export function checkNetworks(raw: unknown, { allowEmpty }: { allowEmpty: boolean }): { value: string; problems: string[] } {
  const list = splitNetworks(raw)
  if (!list.length) return { value: '', problems: allowEmpty ? [] : ['Give at least one network, like 10.0.5.0/24.'] }
  return { value: list.join(' '), problems: networkProblems(list) }
}

/** Accounts every Debian container already has: never a proxy user, so nobody mistakes one for the other. */
export const RESERVED_USERS = new Set([
  'root', 'daemon', 'bin', 'sys', 'sync', 'games', 'man', 'lp', 'mail', 'news', 'uucp', 'proxy', 'www-data', 'backup',
  'list', 'irc', 'gnats', 'nobody', 'systemd-network', 'systemd-resolve', 'systemd-timesync', 'messagebus', 'sshd',
  '_apt', 'postfix', 'admin', 'administrator',
])

const USER = /^[a-z0-9][a-z0-9._-]{0,31}$/

/** A proxy user name, or the reason it cannot be one. */
export function userProblem(name: string): string | null {
  if (!USER.test(name)) return 'A user name is lowercase letters, digits, dots, dashes and underscores, up to 32, starting with a letter or digit.'
  if (RESERVED_USERS.has(name)) return `"${name}" is reserved on the container; pick another name.`
  return null
}
