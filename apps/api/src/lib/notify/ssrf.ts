// =============================================================================
//  HyperProx — Notifications: SSRF guard
//
//  A channel URL is user input aimed at a process that sits next to things a
//  URL must never reach: Prometheus with its lifecycle endpoint, Ollama with no
//  authentication, Postgres, the API itself, a cloud metadata service. So:
//    - https only; http only with the channel's "self-hosted" switch;
//    - Discord, Slack, Teams and Telegram are pinned to their public hosts;
//    - the host is resolved at SEND time and every address is checked; the
//      request then goes to the checked address (Host and SNI unchanged), so a
//      name that resolves elsewhere later (DNS rebinding) gets nowhere;
//    - link-local, unspecified, multicast and broadcast: always refused;
//    - loopback, RFC 1918, CGNAT, ULA: only with the self-hosted switch, and
//      never on HyperProx's own service ports;
//    - redirects are not followed; at most 1 KB of a response is read, and
//      only its status is kept; 10 s per request.
// =============================================================================

import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import { SELF_HOSTABLE, type ChannelKind, type OutboundRequest, type SendOutcome } from './types'

export type AddressClass = 'public' | 'private' | 'loopback' | 'blocked'

const blocked = new net.BlockList()
blocked.addSubnet('0.0.0.0', 8, 'ipv4')
blocked.addSubnet('169.254.0.0', 16, 'ipv4')
blocked.addSubnet('224.0.0.0', 4, 'ipv4')     // multicast
blocked.addSubnet('240.0.0.0', 4, 'ipv4')     // reserved + 255.255.255.255
blocked.addAddress('::', 'ipv6')
blocked.addSubnet('fe80::', 10, 'ipv6')
blocked.addSubnet('ff00::', 8, 'ipv6')

const loopback = new net.BlockList()
loopback.addSubnet('127.0.0.0', 8, 'ipv4')
loopback.addAddress('::1', 'ipv6')

const privateNets = new net.BlockList()
privateNets.addSubnet('10.0.0.0', 8, 'ipv4')
privateNets.addSubnet('172.16.0.0', 12, 'ipv4')
privateNets.addSubnet('192.168.0.0', 16, 'ipv4')
privateNets.addSubnet('100.64.0.0', 10, 'ipv4')   // CGNAT: VPN overlays
privateNets.addSubnet('fc00::', 7, 'ipv6')

/** Eight 16-bit groups of an IPv6 address in any spelling (compressed, expanded, dotted tail), or null. */
function groups6(ip: string): number[] | null {
  let s = ip
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (dotted) {
    const o = dotted[1].split('.').map(Number)
    if (o.some(x => x > 255)) return null
    s = s.slice(0, -dotted[1].length) + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const part = (h: string) => (h ? h.split(':') : [])
  const head = part(halves[0]), tail = halves.length === 2 ? part(halves[1]) : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null
  const all = [...head, ...Array(fill).fill('0'), ...tail]
  if (all.length !== 8 || !all.every(g => /^[0-9a-f]{1,4}$/.test(g))) return null
  return all.map(g => parseInt(g, 16))
}

/**
 * One spelling per address, so two spellings of the same host compare equal: IPv4 dotted; IPv4 inside
 * IPv6 (mapped ::ffff:0:0/96 in hex or dotted form, NAT64 64:ff9b::/96, the old compatible ::a.b.c.d)
 * as that IPv4; any other IPv6 fully expanded, lower case. Null for anything that is not an address.
 */
export function canonicalIp(raw: string): string | null {
  const s = raw.trim().replace(/^\[|\]$/g, '').split('%')[0].toLowerCase()
  const fam = net.isIP(s)
  if (fam === 4) return s.split('.').map(Number).join('.')
  if (fam !== 6) return null
  const g = groups6(s)
  if (!g) return null
  const v4 = () => `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`
  const zero = (from: number, to: number) => g.slice(from, to).every(x => x === 0)
  if (zero(0, 5) && g[5] === 0xffff) return v4()                         // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4()        // NAT64
  if (zero(0, 6) && g[6] !== 0) return v4()                               // ::a.b.c.d (deprecated "compatible")
  return g.map(x => x.toString(16)).join(':')
}

export function classifyAddress(raw: string): AddressClass {
  const ip = canonicalIp(raw)
  if (!ip) return 'blocked'
  const family = net.isIP(ip)
  const type = family === 4 ? 'ipv4' : 'ipv6'
  if (blocked.check(ip, type)) return 'blocked'
  if (loopback.check(ip, type)) return 'loopback'
  if (privateNets.check(ip, type)) return 'private'
  return 'public'
}

/** The ports HyperProx's own services listen on: never a notification target on this host. */
export function ownServicePorts(env: Record<string, string | undefined> = process.env): Set<number> {
  const ports = new Set<number>([
    3000, 3001,      // web front end
    3002,            // API (default PORT)
    3003,            // Grafana
    9090,            // Prometheus (--web.enable-lifecycle)
    9100,            // node_exporter
    9221,            // pve-exporter
    11434,           // Ollama
    5432,            // Postgres
    6379,            // Redis
    8222,            // the vault
    81,              // Nginx Proxy Manager admin (npm profile)
  ])
  for (const v of [env.PORT, ...(env.NOTIFY_BLOCKED_PORTS ?? '').split(',')]) {
    const n = Number(String(v ?? '').trim())
    if (Number.isInteger(n) && n > 0 && n < 65536) ports.add(n)
  }
  return ports
}

type Ifaces = NodeJS.Dict<os.NetworkInterfaceInfo[]>

/** This host's own addresses, canonical: the same port rule applies to them as to loopback. */
export function ownAddresses(ifaces: Ifaces = safeIfaces()): Set<string> {
  const s = new Set<string>()
  for (const list of Object.values(ifaces)) for (const a of list ?? []) { const c = canonicalIp(a.address); if (c) s.add(c) }
  return s
}

function safeIfaces(): Ifaces {
  try { return os.networkInterfaces() } catch { return {} }
}

const BRIDGE = /^(docker\d*|br-[0-9a-f]{6,}|cni\d*|podman\d*|virbr\d*)$/

/**
 * The container networks on this host (Docker's docker0 and br-* bridges): the API's neighbours there
 * (Postgres, Redis, Grafana, the vault...) answer on whatever port, so no channel may point into them,
 * self-hosted or not.
 */
export function bridgeNets(ifaces: Ifaces = safeIfaces()): net.BlockList {
  const b = new net.BlockList()
  for (const [name, list] of Object.entries(ifaces)) {
    if (!BRIDGE.test(name)) continue
    for (const a of list ?? []) {
      const [addr, prefix] = String(a.cidr ?? '').split('/')
      const p = Number(prefix)
      if (!addr || !Number.isInteger(p)) continue
      try {
        if (a.family === 'IPv4' || (a.family as unknown) === 4) {
          const n = addr.split('.').reduce((x, o) => ((x << 8) | Number(o)) >>> 0, 0)
          const m = p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0
          const v = (n & m) >>> 0
          b.addSubnet(`${v >>> 24}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}`, p, 'ipv4')
        } else {
          b.addSubnet(addr, p, 'ipv6')
        }
      } catch { /* odd entry: skip */ }
    }
  }
  return b
}

const host = (u: URL) => u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
const under = (h: string, domain: string) => h === domain || h.endsWith(`.${domain}`)

/** Static checks on a channel URL: scheme, and the public host a pinned kind must use. */
export function checkChannelUrl(kind: ChannelKind, url: string, lanOverride: boolean): { ok: true } | { ok: false; reason: string } {
  let u: URL
  try { u = new URL(url) } catch { return { ok: false, reason: 'That is not a valid address.' } }
  const selfHost = lanOverride && SELF_HOSTABLE.includes(kind)
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && selfHost)) {
    return { ok: false, reason: SELF_HOSTABLE.includes(kind)
      ? 'Use an https:// address (http:// only with "Self-hosted on my network").'
      : 'Use an https:// address.' }
  }
  const h = host(u)
  switch (kind) {
    case 'discord':
      if (!(under(h, 'discord.com') || under(h, 'discordapp.com')) || !u.pathname.startsWith('/api/webhooks/'))
        return { ok: false, reason: 'A Discord webhook looks like https://discord.com/api/webhooks/...' }
      break
    case 'slack':
      if (h !== 'hooks.slack.com') return { ok: false, reason: 'A Slack webhook looks like https://hooks.slack.com/services/...' }
      break
    case 'teams':
      if (!(under(h, 'logic.azure.com') || under(h, 'powerplatform.com') || under(h, 'webhook.office.com')))
        return { ok: false, reason: 'Use the URL of a Teams "When a Teams webhook request is received" workflow.' }
      break
    case 'telegram':
      if (h !== 'api.telegram.org') return { ok: false, reason: 'Telegram messages go to api.telegram.org.' }
      break
    default:
      break
  }
  return { ok: true }
}

/** Every resolved address must pass; one bad answer is enough to refuse (a resolver may hand out either). */
export function checkResolved(kind: ChannelKind, addresses: string[], port: number, lanOverride: boolean, blockedPorts: Set<number>,
                              own: Set<string> = new Set(), bridges: net.BlockList = new net.BlockList()): { ok: true } | { ok: false; reason: string } {
  if (!addresses.length) return { ok: false, reason: 'no address' }
  const selfHost = lanOverride && SELF_HOSTABLE.includes(kind)
  const ownC = new Set([...own].map(a => canonicalIp(a)).filter((x): x is string => !!x))
  for (const a of addresses) {
    const c = classifyAddress(a)
    const ip = canonicalIp(a)
    if (c === 'blocked' || !ip) return { ok: false, reason: 'link-local, multicast or unspecified address' }
    if (bridges.check(ip, net.isIP(ip) === 4 ? 'ipv4' : 'ipv6')) return { ok: false, reason: 'a container network on this host' }
    if ((c === 'loopback' || ownC.has(ip)) && blockedPorts.has(port)) return { ok: false, reason: "one of HyperProx's own service ports" }
    if ((c === 'loopback' || c === 'private') && !selfHost) return { ok: false, reason: 'a private address (turn on "Self-hosted on my network")' }
  }
  return { ok: true }
}

export type Lookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>
export type Connect = (req: OutboundRequest, pinnedAddress: string, family: number, timeoutMs: number) => Promise<{ status: number; retryAfterSec?: number }>

export interface GuardOptions {
  lanOverride: boolean
  blockedPorts?: Set<number>
  lookup?: Lookup
  connect?: Connect
  timeoutMs?: number
  /** DNS answer deadline (default 5 s). */
  dnsTimeoutMs?: number
  /** Tests: this host's addresses and container networks (default: read from the interfaces). */
  ownAddresses?: string[]
  bridges?: net.BlockList
}

const defaultLookup: Lookup = async (h) => dns.lookup(h, { all: true, verbatim: true })

export function withTimeout<T>(p: Promise<T>, ms: number, code: string): Promise<T> {
  let t: NodeJS.Timeout
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, reject) => { t = setTimeout(() => reject(Object.assign(new Error(code), { code })), ms) }),
  ])
}

function retryAfter(v: string | string[] | undefined): number | undefined {
  const s = Array.isArray(v) ? v[0] : v
  if (!s) return undefined
  const n = Number(s)
  if (Number.isFinite(n) && n >= 0) return Math.round(n)
  const at = Date.parse(s)
  return Number.isFinite(at) ? Math.max(0, Math.round((at - Date.now()) / 1000)) : undefined
}

/** One request to an already-checked address. Never follows a redirect; reads at most 1 KB, then discards it. */
export const defaultConnect: Connect = (req, pinned, family, timeoutMs) => new Promise((resolve, reject) => {
  const u = new URL(req.url)
  const mod = u.protocol === 'https:' ? https : http
  const lookup = (_h: string, opts: any, cb: any) => {
    if (opts && opts.all) cb(null, [{ address: pinned, family }])
    else cb(null, pinned, family)
  }
  const r = mod.request({
    protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || undefined,
    path: `${u.pathname}${u.search}`, method: req.method,
    headers: { ...req.headers, 'Content-Length': Buffer.byteLength(req.body).toString(), 'User-Agent': 'HyperProx-Notify/1' },
    lookup, servername: net.isIP(u.hostname) ? undefined : u.hostname,
    signal: AbortSignal.timeout(timeoutMs),
  } as any, res => {
    let read = 0
    const done = () => resolve({ status: res.statusCode ?? 0, retryAfterSec: retryAfter(res.headers['retry-after']) })
    res.on('data', (c: Buffer) => { read += c.length; if (read >= 1024) { done(); res.destroy() } })
    res.on('end', done)
    res.on('close', done)
    res.on('error', done)
  })
  r.on('error', reject)
  r.end(req.body)
})

/** An error's kind only: fetch and socket errors can carry the URL in their message. */
export function errorCode(e: unknown): string {
  const any = e as any
  const code = any?.code ?? any?.cause?.code
  if (typeof code === 'string' && /^[A-Za-z0-9_]{2,40}$/.test(code)) return code === 'ABORT_ERR' ? 'TimeoutError' : code
  const name = any?.name
  if (name === 'TimeoutError' || name === 'AbortError') return 'TimeoutError'
  return typeof name === 'string' && /^[A-Za-z]{2,40}$/.test(name) ? name : 'error'
}

/** The only way a notification leaves HyperProx. */
export async function guardedSend(req: OutboundRequest, kind: ChannelKind, o: GuardOptions): Promise<SendOutcome> {
  const stat = checkChannelUrl(kind, req.url, o.lanOverride)
  if (!stat.ok) return { ok: false, code: 'blocked-url' }
  const u = new URL(req.url)
  const h = host(u)
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
  let addrs: Array<{ address: string; family: number }>
  if (net.isIP(h)) addrs = [{ address: h, family: net.isIP(h) }]
  else {
    try { addrs = await withTimeout((o.lookup ?? defaultLookup)(h), o.dnsTimeoutMs ?? 5_000, 'DNSTimeout') }
    catch (e) { return { ok: false, code: errorCode(e) } }
  }
  const own = o.ownAddresses ? new Set(o.ownAddresses) : ownAddresses()
  const verdict = checkResolved(kind, addrs.map(a => a.address), port, o.lanOverride, o.blockedPorts ?? ownServicePorts(), own, o.bridges ?? bridgeNets())
  if (!verdict.ok) return { ok: false, code: 'blocked-address' }
  const first = addrs[0]
  try {
    const r = await (o.connect ?? defaultConnect)(req, first.address, first.family, o.timeoutMs ?? 10_000)
    if (r.status >= 300 && r.status < 400) return { ok: false, status: r.status, code: 'redirect' }
    return { ok: r.status >= 200 && r.status < 300, status: r.status, ...(r.retryAfterSec !== undefined ? { retryAfterSec: r.retryAfterSec } : {}) }
  } catch (e) {
    return { ok: false, code: errorCode(e) }
  }
}
