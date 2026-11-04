// =============================================================================
//  HyperProx — Proxy provider: Nginx Proxy Manager
//  The NPM client HyperProx has always used, behind ProxyProvider. NPM is
//  driven whole, as before: every proxy host is editable, certificates are
//  listed and requested through NPM.
//
//  An update is a merge: the current host is read, the fields asked for are
//  laid over it, and the whole merged object is sent. A field nobody named
//  (certificate, HSTS, HTTP/2, caching, advanced config, access list,
//  locations, …) keeps its value. An update that changes nothing sends nothing.
// =============================================================================

import { NPMClient, type NPMProxyHost, type NPMCertificate } from '../../npm-client'
import { NPM_OPTION_KEYS } from '../spec'
import type { HostSpec, ProxyCertificate, ProxyHealth, ProxyHostRecord, ProxyProvider } from '../types'
import type { FetchLike } from '../http'

export interface NpmConfig { url: string; email: string; password: string }

export function npmCertificate(c: NPMCertificate): ProxyCertificate {
  return { id: String(c.id), names: c.domain_names, expiresAt: c.expires_on ?? null, issuer: c.provider, native: c as unknown as Record<string, unknown> }
}

/** The fields a proxy host is made of, as NPM's PUT takes them. Everything else (ids, dates, meta) is NPM's. */
const HOST_FIELDS = ['domain_names', 'forward_scheme', 'forward_host', 'forward_port', 'allow_websocket_upgrade', 'certificate_id',
  'ssl_forced', 'block_exploits', 'http2_support', 'hsts_enabled', 'hsts_subdomains', 'caching_enabled', 'advanced_config',
  'access_list_id', 'trust_forwarded_proto', 'locations'] as const

const certNum = (v: unknown): number | false => (typeof v === 'number' && v > 0 ? v : false)

/** What the preview fingerprints: the whole host, without the fields NPM changes by itself. */
export function npmState(h: any): unknown {
  const { modified_on: _m, certificate: _c, meta, ...rest } = h ?? {}
  const { nginx_online: _o, nginx_err: _e, ...m } = meta ?? {}
  return { ...rest, meta: m }
}

export class NpmProvider implements ProxyProvider {
  readonly kind = 'npm' as const
  readonly capabilities = { certificates: 'list' as const, requestCertificate: true, multiDomain: true,
    disabledMeans: 'NPM stops serving the host; its configuration is kept.' }
  readonly client: NPMClient

  constructor(cfg: NpmConfig, fetchImpl?: FetchLike) {
    this.client = new NPMClient(cfg.url, cfg.email, cfg.password, fetchImpl)
  }

  async health(): Promise<ProxyHealth> {
    try {
      const hosts = await this.client.getProxyHosts()
      let admin = false
      try { admin = await this.client.isAdmin() } catch { /* reported below */ }
      return { ok: true, checks: [
        { name: 'api', ok: true, detail: `Signed in; ${hosts.length} proxy host(s)` },
        { name: 'login', ok: admin, warn: !admin, detail: admin ? 'The login is an NPM administrator' : 'The login is not an NPM administrator: it sees only its own hosts' },
      ] }
    } catch (e: any) {
      return { ok: false, checks: [{ name: 'api', ok: false, detail: e.message }] }
    }
  }

  private record(h: NPMProxyHost): ProxyHostRecord {
    const cert = h.certificate
    const n = h as any
    return {
      id: String(h.id), domains: h.domain_names, forwardScheme: h.forward_scheme === 'https' ? 'https' : 'http',
      forwardHost: h.forward_host, forwardPort: Number(h.forward_port), enabled: !!h.enabled, owned: true,
      tls: cert ? { kind: 'certificate', certificateId: String(cert.id), certificateName: cert.nice_name || cert.domain_names?.[0], expiresAt: cert.expires_on ?? null, forced: !!h.ssl_forced } : { kind: 'none' },
      online: h.meta?.nginx_online ?? null, websockets: !!h.allow_websocket_upgrade,
      options: Object.fromEntries(NPM_OPTION_KEYS.map(k => [k, k === 'certificate_id' ? certNum(n[k]) : k === 'advanced_config' ? String(n[k] ?? '') : !!n[k]])),
      state: npmState(h),
      native: h as unknown as Record<string, unknown>,
    }
  }

  async listHosts(): Promise<ProxyHostRecord[]> {
    return (await this.client.getProxyHosts()).map(h => this.record(h))
  }

  /** The full host body: `base` (the current host, or NPM's defaults for a new one) with the spec over it. */
  private body(spec: HostSpec, base: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = Object.fromEntries(HOST_FIELDS.filter(k => k in base).map(k => [k, base[k]]))
    out.domain_names = spec.domains
    out.forward_scheme = spec.forwardScheme
    out.forward_host = spec.forwardHost
    out.forward_port = spec.forwardPort
    if (spec.websockets !== undefined) out.allow_websocket_upgrade = spec.websockets
    for (const [k, v] of Object.entries(spec.npm ?? {})) if (v !== undefined) out[k] = v
    out.certificate_id = certNum(out.certificate_id) || 0
    return out
  }

  async createHost(spec: HostSpec): Promise<string> {
    const defaults = { allow_websocket_upgrade: true, certificate_id: 0, ssl_forced: false, block_exploits: true, http2_support: false,
      hsts_enabled: false, hsts_subdomains: false, caching_enabled: false, advanced_config: '', locations: [] }
    // NPM takes `enabled` on create (2.16.0 honours enabled:false): one call, nothing to undo half-way.
    const h = await this.client.createProxyHost({ ...this.body(spec, defaults), meta: {}, enabled: spec.enabled } as any)
    return String(h.id)
  }

  async updateHost(id: string, spec: HostSpec): Promise<void> {
    const current: any = await this.client.getProxyHost(Number(id))
    const merged = this.body(spec, current)
    const same = (k: string) => JSON.stringify(merged[k]) === JSON.stringify(k === 'certificate_id' ? (certNum(current[k]) || 0) : current[k])
    if (!HOST_FIELDS.every(k => !(k in merged) || same(k))) await this.client.updateProxyHost(Number(id), merged as any)
    if (!!current.enabled !== spec.enabled) await this.setEnabled(id, spec.enabled)
  }

  async deleteHost(id: string): Promise<void> { await this.client.deleteProxyHost(Number(id)) }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    if (enabled) await this.client.enableProxyHost(Number(id))
    else await this.client.disableProxyHost(Number(id))
  }

  async listCertificates(): Promise<ProxyCertificate[]> {
    return (await this.client.getCertificates()).map(npmCertificate)
  }

  async requestCertificate(domains: string[], email: string): Promise<ProxyCertificate> {
    return npmCertificate(await this.client.requestCertificate({ domain_names: domains, provider: 'letsencrypt', nice_name: domains[0], letsencrypt_email: email }))
  }
}
