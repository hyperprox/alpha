// =============================================================================
//  HyperProx — Proxy providers: host specs, checked once for every provider
// =============================================================================

import { isIP } from 'node:net'
import { ProxyRefusal, type HostSpec, type NpmExtras, type ProxyHostRecord } from './types'

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

/** Coerce and check a request body into a HostSpec. Unknown fields are dropped, never passed on. */
export function parseHostSpec(body: any): HostSpec {
  if (!body || typeof body !== 'object') throw new ProxyRefusal('The host is missing.', 400)
  const domains = Array.isArray(body.domains) ? body.domains : (typeof body.domains === 'string' ? body.domains.split(',') : [])
  const clean = [...new Set(domains.map(checkHostname))] as string[]
  if (!clean.length) throw new ProxyRefusal('A host needs at least one domain name.', 400)
  if (clean.length > 20) throw new ProxyRefusal('A host can have at most 20 names.', 400)
  const scheme = body.forwardScheme ?? 'http'
  if (scheme !== 'http' && scheme !== 'https') throw new ProxyRefusal('The forward scheme is http or https.', 400)
  const port = Number(body.forwardPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ProxyRefusal('The forward port is a number from 1 to 65535.', 400)
  const spec: HostSpec = {
    domains: clean, forwardScheme: scheme, forwardHost: checkForwardHost(body.forwardHost), forwardPort: port,
    enabled: body.enabled === undefined ? true : !!body.enabled,
    websockets: body.websockets === undefined ? true : !!body.websockets,
  }
  if (body.npm && typeof body.npm === 'object') {
    const n: NpmExtras = {}
    for (const k of NPM_BOOL) if (k in body.npm) (n as any)[k] = !!body.npm[k]
    if ('certificate_id' in body.npm) {
      const c = body.npm.certificate_id
      n.certificate_id = c === false || c === null || c === 0 ? false : Number(c)
      if (n.certificate_id !== false && (!Number.isInteger(n.certificate_id) || n.certificate_id < 1)) throw new ProxyRefusal('certificate_id is a certificate number or false.', 400)
    }
    if ('advanced_config' in body.npm) {
      const a = String(body.npm.advanced_config ?? '')
      if (a.length > 20_000) throw new ProxyRefusal('The advanced configuration is too long.', 400)
      n.advanced_config = a
    }
    spec.npm = n
  }
  return spec
}

/** A provider-local id for a new host, from its first name: test-a.example.invalid → hpx-test-a-example-invalid. */
export function slugFor(spec: HostSpec, taken: Set<string>, prefix = 'hpx-', sep = '-'): string {
  const base = prefix + spec.domains[0].replace(/[^a-z0-9]+/g, sep).replace(new RegExp(`^\\${sep}+|\\${sep}+$`, 'g'), '').slice(0, 48)
  let id = base
  for (let i = 2; taken.has(id); i++) id = `${base}${sep}${i}`
  return id
}

/** Whether a host as read back is what was asked for. Returns the differences, in words. */
export function differences(spec: HostSpec, got: ProxyHostRecord): string[] {
  const out: string[] = []
  const want = [...spec.domains].sort().join(', ')
  const have = [...got.domains].sort().join(', ')
  if (want !== have) out.push(`names are ${have || 'none'}, expected ${want}`)
  if (spec.forwardHost !== got.forwardHost) out.push(`forward host is ${got.forwardHost}, expected ${spec.forwardHost}`)
  if (spec.forwardPort !== got.forwardPort) out.push(`forward port is ${got.forwardPort}, expected ${spec.forwardPort}`)
  if (spec.forwardScheme !== got.forwardScheme) out.push(`forward scheme is ${got.forwardScheme}, expected ${spec.forwardScheme}`)
  if (spec.enabled !== got.enabled) out.push(`host is ${got.enabled ? 'enabled' : 'disabled'}, expected ${spec.enabled ? 'enabled' : 'disabled'}`)
  return out
}

/** A host as a spec, so an enable/disable can be checked with the same comparison. */
export function specOf(h: ProxyHostRecord): HostSpec {
  return { domains: h.domains, forwardScheme: h.forwardScheme, forwardHost: h.forwardHost, forwardPort: h.forwardPort, enabled: h.enabled, websockets: h.websockets }
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
