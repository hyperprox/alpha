// =============================================================================
//  HyperProx — the 3proxy page: the pure parts (tested on their own)
// =============================================================================

export interface Counted { requests: number; bytes: number }

export interface Reading {
  at: number; active: boolean; version: string | null; listen: string | null; minutes: number
  allow: string[]; lanTargets: boolean; perClient: boolean; users: string[]
  http: boolean; socks: boolean
  conns: { http: number | null; socks: number | null }
  perMinute: Array<{ at: number } & Counted>
  totals: Counted & { denied: number; errors: number }
  denied: Array<{ code: string; label: string; count: number }>
  services: Array<{ name: 'HTTP' | 'SOCKS' } & Counted>
  byUser: Array<{ name: string } & Counted>
  byClient: Array<{ address: string } & Counted>
}

export interface Instance {
  id: string; vmid: number; node: string; name: string; listen: string | null; url: string | null
  vaultItem: string; addedAt: number; addedBy: string; autoConnected: { at: number; evidence: string[] } | null
}

export interface Problem {
  id: string; severity: 'bad' | 'warn'; title: string; detail: string
  fix: { id: 'reload' | 'block_lan' | 'reset_user' | 'add_user' | 'recheck'; label: string; confirm?: string; user?: string } | null
}

export interface SelfCheck { id: string; state: 'ok' | 'fail' | 'info'; detail: string }


export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function size(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0, v = bytes
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`
}

/** Requests a minute, averaged over the last five minutes. */
export function rate(r: Reading): number {
  const last = r.perMinute.slice(-5)
  return last.length ? Math.round(last.reduce((a, b) => a + b.requests, 0) / last.length) : 0
}

/** The vault field that holds a user's password: the first user keeps the installer's admin_password. */
export function fieldFor(user: string, fields: Record<string, string>): string | null {
  const key = user === fields.admin_user ? 'admin_password' : `user_${user}`
  return fields[key] ? key : null
}

/** The protocols one proxy serves, with the address an app is given. */
export function endpoints(listen: string | null, r?: Pick<Reading, 'http' | 'socks'> | null): Array<{ protocol: 'HTTP' | 'SOCKS5'; host: string; port: number; url: string }> {
  const host = listen ?? '<proxy address>'
  const out: Array<{ protocol: 'HTTP' | 'SOCKS5'; host: string; port: number; url: string }> = []
  const http = r?.http !== false, socks = r?.socks !== false
  if (http) out.push({ protocol: 'HTTP', host, port: 3128, url: `http://${host}:3128` })
  if (socks) out.push({ protocol: 'SOCKS5', host, port: 1080, url: `socks5h://${host}:1080` })
  return out
}

/** "How to use this proxy": where each kind of client takes the address. */
export function howTo(listen: string | null, r?: Pick<Reading, 'http' | 'socks'> | null): Array<{ where: string; what: string }> {
  const e = endpoints(listen, r)
  const http = e.find(x => x.protocol === 'HTTP'), socks = e.find(x => x.protocol === 'SOCKS5')
  const out: Array<{ where: string; what: string }> = []
  if (http) {
    out.push({ where: 'Windows', what: `Settings → Network & internet → Proxy → Manual proxy setup → Use a proxy server: address ${http.host}, port ${http.port}. Windows asks for the user name and password the first time.` })
    out.push({ where: 'macOS', what: `System Settings → Network → your network → Details → Proxies: turn on Web proxy (HTTP) and Secure web proxy (HTTPS), both ${http.host} port ${http.port}, with "Proxy server requires password".` })
    out.push({ where: 'iPhone, iPad, Android', what: `Wi-Fi → your network → Proxy → Manual: server ${http.host}, port ${http.port}, with authentication on (Android may not ask for a password: use an app that supports proxies instead).` })
    out.push({ where: 'Linux, command line', what: `export https_proxy=http://USER:PASSWORD@${http.host}:${http.port} (and http_proxy the same), or curl -x ${http.url} -U USER https://example.com` })
  }
  if (socks) {
    out.push({ where: 'Firefox', what: `Settings → General → Network settings → Manual proxy configuration: SOCKS host ${socks.host}, port ${socks.port}, SOCKS v5, and tick "Proxy DNS when using SOCKS v5". It asks for the user name and password.` })
    out.push({ where: 'Apps with a SOCKS setting', what: `SOCKS5 proxy ${socks.host}, port ${socks.port}, with user name and password, and remote (proxy) DNS on where offered.` })
    out.push({ where: 'Command line', what: `curl -x ${socks.url} -U USER https://example.com, or ssh -o ProxyCommand='nc -X 5 -x ${socks.host}:${socks.port} %h %p' for SSH.` })
  }
  return out
}

/** The rules that are always in force, in words, for the safety panel. */
export function ruleWords(r: Reading): Array<{ id: string; text: string; on: boolean }> {
  return [
    { id: 'auth', text: 'Sign-in required for every request', on: true },
    { id: 'listen', text: `Listens only on ${r.listen ?? 'its LAN address'}`, on: true },
    { id: 'allow', text: `Only ${r.allow.join(', ') || 'the allowed networks'} may use it`, on: r.allow.length > 0 },
    { id: 'lan', text: r.lanTargets ? 'Can reach your own network (you allowed it)' : 'Cannot reach your own network', on: !r.lanTargets },
    { id: 'self', text: 'Never reaches itself, loopback or link-local', on: true },
    ...(r.http ? [{ id: 'tls', text: 'HTTPS tunnels only to port 443', on: true }] : []),
    ...(r.socks ? [{ id: 'smtp', text: 'SOCKS never to port 25 (mail)', on: true }] : []),
    { id: 'cap', text: 'At most 256 connections at once', on: true },
  ]
}

const CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/
const OCTET = /^(0|[1-9]\d{0,2})$/
const BLOCKS = [{ base: 10 << 24 >>> 0, prefix: 8, name: '10.0.0.0/8' }, { base: ((172 << 24) | (16 << 16)) >>> 0, prefix: 12, name: '172.16.0.0/12' }, { base: ((192 << 24) | (168 << 16)) >>> 0, prefix: 16, name: '192.168.0.0/16' }]
const maskOf = (p: number) => (p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0)

/** The same rule as the server: network addresses inside a private block and no wider than it; 1 to 32 of them. */
export function checkNetworks(raw: string): { ok: boolean; list: string[]; problem: string | null } {
  const list = raw.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean)
  const bad = (problem: string) => ({ ok: false, list, problem })
  if (!list.length) return bad('Give at least one network, like 10.0.5.0/24.')
  if (list.length > 32) return bad('Give at most 32 networks.')
  for (const c of list) {
    const m = CIDR.exec(c)
    if (!m || !m.slice(1, 6).every(o => OCTET.test(o))) return bad(`${c} is not a network like 10.0.5.0/24.`)
    const o = m.slice(1, 5).map(Number), p = Number(m[5])
    if (o.some(x => x > 255) || p > 32) return bad(`${c} is not a network address.`)
    const num = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0
    if (((num & maskOf(p)) >>> 0) !== num) return bad(`${c} has host bits set: write its network address.`)
    const block = BLOCKS.find(b => ((num & maskOf(b.prefix)) >>> 0) === b.base)
    if (!block) return bad(`${c} is not a private network: the proxy would be open to the internet.`)
    if (p < block.prefix) return bad(`${c} is too wide: it reaches outside ${block.name}.`)
  }
  return { ok: true, list, problem: null }
}

export const USER_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/

/** An SVG area path for the per-minute series, in a width x height box. */
export function areaPath(values: number[], width: number, height: number): { line: string; area: string; max: number } {
  const max = Math.max(1, ...values)
  if (!values.length) return { line: '', area: '', max }
  const step = values.length > 1 ? width / (values.length - 1) : width
  const pts = values.map((v, i) => [Math.round(i * step * 10) / 10, Math.round((height - (v / max) * (height - 4) - 2) * 10) / 10])
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ')
  return { line, area: `${line} L${pts[pts.length - 1][0]} ${height} L0 ${height} Z`, max }
}

export const CHECK_TITLE: Record<string, string> = {
  http_auth: 'Sign-in required (HTTP)', http_ok: 'A signed-in request works (HTTP)', connect_443: 'Tunnels only to port 443',
  self: 'Cannot reach itself', lan: 'Cannot reach your network', socks_auth: 'Sign-in required (SOCKS)',
  socks_ok: 'A signed-in request works (SOCKS)', socks_self: 'Cannot reach itself (SOCKS)', socks_lan: 'Cannot reach your network (SOCKS)',
  source: 'Checked from the proxy', running: 'The proxy is running', localhost: 'Refuses localhost by name', socks_localhost: 'Refuses localhost by name (SOCKS)',
}
