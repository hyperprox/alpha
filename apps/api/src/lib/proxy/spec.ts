// =============================================================================
//  HyperProx — Proxy providers: host specs, checked once for every provider
// =============================================================================

import { isIP } from 'node:net'
import { ProxyRefusal, type FieldChange, type HostPatch, type HostSpec, type NpmExtras, type ProxyHostRecord } from './types'

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

/** One hostname HyperProx will point a proxy at: lower case, no wildcard, no scheme or port. */
export function checkHostname(raw: unknown): string {
  const v = String(raw ?? '').trim().toLowerCase().replace(/\.$/, '')
  if (!v) throw new ProxyRefusal('A host needs at least one domain name.', 400)
  if (v.length > 253) throw new ProxyRefusal(`${v.slice(0, 40)}… is longer than a hostname can be.`, 400)
  if (v.includes('*')) throw new ProxyRefusal(`${v} is a wildcard; HyperProx creates hosts for single names only.`, 400)
  const labels = v.split('.')
  if (labels.length < 2 || !labels.every(l => LABEL.test(l))) throw new ProxyRefusal(`"${v}" is not a hostname.`, 400)
  return v
}

/** The address a proxy forwards to: a hostname or an IP literal, nothing else. */
export function checkForwardHost(raw: unknown): string {
  const v = String(raw ?? '').trim()
  if (!v) throw new ProxyRefusal('The forward host is empty.', 400)
  if (isIP(v)) return v
  const h = v.toLowerCase()
  if (h.length <= 253 && h.split('.').every(l => LABEL.test(l))) return h
  throw new ProxyRefusal(`"${v}" is not a hostname or IP address.`, 400)
}

const NPM_BOOL: Array<keyof NpmExtras> = ['ssl_forced', 'block_exploits', 'http2_support', 'hsts_enabled', 'hsts_subdomains', 'caching_enabled']
export const NPM_OPTION_KEYS: Array<keyof NpmExtras> = ['certificate_id', ...NPM_BOOL, 'advanced_config']
export const NPM_OPTION_LABEL: Record<string, string> = {
  certificate_id: 'certificate', ssl_forced: 'force HTTPS', block_exploits: 'block exploits', http2_support: 'HTTP/2',
  hsts_enabled: 'HSTS', hsts_subdomains: 'HSTS subdomains', caching_enabled: 'caching', advanced_config: 'advanced config',
}

function parseNpm(raw: any): NpmExtras | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const n: NpmExtras = {}
  for (const k of NPM_BOOL) if (k in raw) (n as any)[k] = !!raw[k]
  if ('certificate_id' in raw) {
    const c = raw.certificate_id
    n.certificate_id = c === false || c === null || c === 0 ? false : Number(c)
    if (n.certificate_id !== false && (!Number.isInteger(n.certificate_id) || n.certificate_id < 1)) throw new ProxyRefusal('certificate_id is a certificate number or false.', 400)
  }
  if ('advanced_config' in raw) {
    const a = String(raw.advanced_config ?? '')
    if (a.length > 20_000) throw new ProxyRefusal('The advanced configuration is too long.', 400)
    n.advanced_config = a
  }
  return Object.keys(n).length ? n : undefined
}

function parseDomains(raw: unknown): string[] {
  const domains = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(',') : [])
  const clean = [...new Set(domains.map(checkHostname))] as string[]
  if (!clean.length) throw new ProxyRefusal('A host needs at least one domain name.', 400)
  if (clean.length > 20) throw new ProxyRefusal('A host can have at most 20 names.', 400)
  return clean
}
function parseScheme(raw: unknown): 'http' | 'https' {
  if (raw !== 'http' && raw !== 'https') throw new ProxyRefusal('The forward scheme is http or https.', 400)
  return raw
}
function parsePort(raw: unknown): number {
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ProxyRefusal('The forward port is a number from 1 to 65535.', 400)
  return port
}

/** Coerce and check a new host. Unknown fields are dropped, never passed on. */
export function parseHostSpec(body: any): HostSpec {
  if (!body || typeof body !== 'object') throw new ProxyRefusal('The host is missing.', 400)
  const spec: HostSpec = {
    domains: parseDomains(body.domains), forwardScheme: parseScheme(body.forwardScheme ?? 'http'),
    forwardHost: checkForwardHost(body.forwardHost), forwardPort: parsePort(body.forwardPort),
    enabled: body.enabled === undefined ? true : !!body.enabled,
    websockets: body.websockets === undefined ? true : !!body.websockets,
  }
  const npm = parseNpm(body.npm)
  if (npm) spec.npm = npm
  return spec
}

/** Coerce and check an update: only the fields given, each checked as for a new host. */
export function parseHostPatch(body: any): HostPatch {
  if (!body || typeof body !== 'object') throw new ProxyRefusal('The change is missing.', 400)
  const p: HostPatch = {}
  if (body.domains !== undefined) p.domains = parseDomains(body.domains)
  if (body.forwardScheme !== undefined) p.forwardScheme = parseScheme(body.forwardScheme)
  if (body.forwardHost !== undefined) p.forwardHost = checkForwardHost(body.forwardHost)
  if (body.forwardPort !== undefined) p.forwardPort = parsePort(body.forwardPort)
  if (body.enabled !== undefined) p.enabled = !!body.enabled
  if (body.websockets !== undefined) p.websockets = !!body.websockets
  const npm = parseNpm(body.npm)
  if (npm) p.npm = npm
  return p
}

/** The host as it will be: the current host with the patch over it, key by key (NPM options included). */
export function mergeSpec(before: ProxyHostRecord, patch: HostPatch): HostSpec {
  const spec: HostSpec = {
    domains: patch.domains ?? before.domains, forwardScheme: patch.forwardScheme ?? before.forwardScheme,
    forwardHost: patch.forwardHost ?? before.forwardHost, forwardPort: patch.forwardPort ?? before.forwardPort,
    enabled: patch.enabled ?? before.enabled,
  }
  const ws = patch.websockets ?? before.websockets
  if (ws !== undefined) spec.websockets = ws
  if (before.options || patch.npm) spec.npm = { ...(before.options as NpmExtras | undefined), ...(patch.npm ?? {}) }
  return spec
}

const norm = (v: unknown) => (v === 0 || v === null || v === undefined ? false : v)

/** Every field where the host as read differs from the spec. */
export function fieldChanges(spec: HostSpec, got: ProxyHostRecord): FieldChange[] {
  const out: FieldChange[] = []
  const add = (field: string, label: string, from: unknown, to: unknown) => out.push({ field, label, from, to })
  const want = [...spec.domains].sort().join(', '), have = [...got.domains].sort().join(', ')
  if (want !== have) add('domains', 'names', have || 'none', want)
  if (spec.forwardScheme !== got.forwardScheme) add('forwardScheme', 'forward scheme', got.forwardScheme, spec.forwardScheme)
  if (spec.forwardHost !== got.forwardHost) add('forwardHost', 'forward host', got.forwardHost, spec.forwardHost)
  if (spec.forwardPort !== got.forwardPort) add('forwardPort', 'forward port', got.forwardPort, spec.forwardPort)
  if (spec.enabled !== got.enabled) add('enabled', 'enabled', got.enabled, spec.enabled)
  if (spec.websockets !== undefined && got.websockets !== undefined && spec.websockets !== got.websockets) add('websockets', 'websockets', got.websockets, spec.websockets)
  for (const [k, v] of Object.entries(spec.npm ?? {})) {
    const cur = got.options?.[k]
    if (got.options && norm(cur) !== norm(v)) add(`npm.${k}`, NPM_OPTION_LABEL[k] ?? k, norm(cur), norm(v))
  }
  return out
}

/** The same, in words: what the read-back found, against what was planned. */
export function differences(spec: HostSpec, got: ProxyHostRecord): string[] {
  return fieldChanges(spec, got).map(c => `${c.label} is ${words(c.from)}, expected ${words(c.to)}`)
}

export function words(v: unknown): string {
  if (v === true) return 'on'
  if (v === false) return 'off'
  if (typeof v === 'string' && v.includes('\n')) return `${v.split('\n').length} lines`
  if (typeof v === 'string' && v.length > 60) return `${v.slice(0, 57)}…`
  return v === '' ? '(empty)' : String(v)
}

/** A provider-local id for a new host, from its first name: test-a.example.invalid → hpx-test-a-example-invalid. */
export function slugFor(spec: HostSpec, taken: Set<string>, prefix = 'hpx-', sep = '-'): string {
  const base = prefix + spec.domains[0].replace(/[^a-z0-9]+/g, sep).replace(new RegExp(`^\\${sep}+|\\${sep}+$`, 'g'), '').slice(0, 48)
  let id = base
  for (let i = 2; taken.has(id); i++) id = `${base}${sep}${i}`
  return id
}

/** A host as a spec, so an enable/disable can be checked with the same comparison. */
export function specOf(h: ProxyHostRecord): HostSpec {
  return mergeSpec(h, {})
}

/** "host:port" with IPv6 bracketed. */
export function hostPort(host: string, port: number): string {
  return isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`
}

/** Split "host:port" or "[v6]:port". */
export function splitHostPort(s: string, defaultPort: number): { host: string; port: number } {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(s) ?? /^([^:]+)(?::(\d+))?$/.exec(s)
  if (!m) return { host: s, port: defaultPort }
  return { host: m[1], port: m[2] ? Number(m[2]) : defaultPort }
}

/** Parse an upstream URL such as http://192.0.2.10:9000. */
export function parseUpstreamUrl(u: string): { scheme: 'http' | 'https'; host: string; port: number } {
  try {
    const url = new URL(u)
    const scheme = url.protocol === 'https:' ? 'https' : 'http'
    const host = url.hostname.replace(/^\[|\]$/g, '')
    return { scheme, host, port: url.port ? Number(url.port) : (scheme === 'https' ? 443 : 80) }
  } catch { return { scheme: 'http', host: u, port: 80 } }
}
