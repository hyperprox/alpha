// =============================================================================
//  HyperProx — Proxy provider: Nginx Proxy Manager
//  The NPM client HyperProx has always used, behind ProxyProvider. NPM is
//  driven whole, as before: every proxy host is editable, certificates are
//  listed and requested through NPM.
// =============================================================================

import { NPMClient, type NPMProxyHost, type NPMCertificate } from '../../npm-client'
import type { HostSpec, ProxyCertificate, ProxyHealth, ProxyHostRecord, ProxyProvider } from '../types'
import type { FetchLike } from '../http'

export interface NpmConfig { url: string; email: string; password: string }

export const NPM_SECRET_KEYS = ['password'] as const
export const NPM_SETTING_KEYS = ['email'] as const

export function npmCertificate(c: NPMCertificate): ProxyCertificate {
  return { id: String(c.id), names: c.domain_names, expiresAt: c.expires_on ?? null, issuer: c.provider, native: c as unknown as Record<string, unknown> }
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
    return {
      id: String(h.id), domains: h.domain_names, forwardScheme: h.forward_scheme === 'https' ? 'https' : 'http',
      forwardHost: h.forward_host, forwardPort: Number(h.forward_port), enabled: !!h.enabled, owned: true,
      tls: cert ? { kind: 'certificate', certificateId: String(cert.id), expiresAt: cert.expires_on ?? null, forced: !!h.ssl_forced } : { kind: 'none' },
      online: h.meta?.nginx_online ?? null, websockets: !!h.allow_websocket_upgrade,
      native: h as unknown as Record<string, unknown>,
    }
  }

  async listHosts(): Promise<ProxyHostRecord[]> {
    return (await this.client.getProxyHosts()).map(h => this.record(h))
  }

  private body(spec: HostSpec): Partial<NPMProxyHost> {
    const n = spec.npm ?? {}
    return {
      domain_names: spec.domains, forward_scheme: spec.forwardScheme, forward_host: spec.forwardHost, forward_port: spec.forwardPort,
      allow_websocket_upgrade: spec.websockets ?? true, enabled: spec.enabled,
      certificate_id: n.certificate_id ?? false, ssl_forced: n.ssl_forced ?? false, block_exploits: n.block_exploits ?? true,
      http2_support: n.http2_support ?? false, hsts_enabled: n.hsts_enabled ?? false, hsts_subdomains: n.hsts_subdomains ?? false,
      caching_enabled: n.caching_enabled ?? false, advanced_config: n.advanced_config ?? '',
      meta: {} as any,
    }
  }

  async createHost(spec: HostSpec): Promise<string> {
    const h = await this.client.createProxyHost(this.body(spec))
    // NPM creates every host enabled; a host asked for disabled is disabled straight after.
    if (!spec.enabled) await this.client.disableProxyHost(h.id)
    return String(h.id)
  }

  async updateHost(id: string, spec: HostSpec): Promise<void> {
    const current = await this.client.getProxyHost(Number(id))
    const body: any = this.body(spec)
    delete body.enabled
    // Options the form did not send keep their current value.
    if (!spec.npm) for (const k of ['certificate_id', 'ssl_forced', 'block_exploits', 'http2_support', 'hsts_enabled', 'hsts_subdomains', 'caching_enabled', 'advanced_config']) body[k] = (current as any)[k]
    delete body.meta
    await this.client.updateProxyHost(Number(id), body)
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
