// =============================================================================
//  HyperProx — Nginx Proxy Manager API Client
// =============================================================================

import { createHash } from 'node:crypto'

export interface NPMProxyHost {
  id:                      number
  domain_names:            string[]
  forward_host:            string
  forward_port:            number
  forward_scheme:          string
  certificate_id:          number | 'new' | false
  ssl_forced:              boolean
  enabled:                 boolean
  block_exploits:          boolean
  allow_websocket_upgrade: boolean
  http2_support:           boolean
  hsts_enabled:            boolean
  hsts_subdomains:         boolean
  caching_enabled:         boolean
  trust_forwarded_proto:   boolean
  advanced_config:         string
  created_on:              string
  modified_on:             string
  meta: {
    nginx_online:       boolean
    nginx_err:          string | null
    letsencrypt_email?: string
    letsencrypt_agree?: boolean
    dns_challenge?:     boolean
  }
  certificate?: NPMCertificate
}

/** A redirection host, 404 host or stream, as far as certificates are concerned. */
export interface NPMCertificateUser {
  id:             number
  certificate_id?: number | 'new' | false | null
}

export interface NPMCertificate {
  id:           number
  nice_name:    string
  domain_names: string[]
  expires_on:   string
  provider:     string
  meta:         Record<string, any>
}

export interface NPMStats {
  total: number; enabled: number; disabled: number
  online: number; ssl: number; expiring: number; expired: number
}

type TokenCache = { token: string; expires: Date } | null

// Tokens are shared by every client for the same NPM and login, until shortly before NPM says they expire:
// a new NPMClient per request no longer means a new sign-in per request.
const tokens = new Map<string, { token: string; expires: Date }>()
// A sign-in in flight, shared by every request that needs it (two lists fetched at once sign in once).
const signingIn = new Map<string, Promise<{ token: string; expires: Date }>>()
/** Tests: forget every cached token. */
export function clearNpmTokens(): void { tokens.clear(); signingIn.clear() }

/** How long one try of one NPM request may take: reads 15 s, writes 60 s, a certificate request 180 s (NPM runs certbot before it answers). */
export const NPM_READ_TIMEOUT_MS = 15_000
export const NPM_WRITE_TIMEOUT_MS = 60_000
export const NPM_CERT_TIMEOUT_MS = 180_000
export function npmTimeoutFor(method: string | undefined, url: string): number {
  const m = (method ?? 'GET').toUpperCase()
  if (m === 'GET' || m === 'HEAD') return NPM_READ_TIMEOUT_MS
  if (m === 'POST' && /\/nginx\/certificates(\/|\?|$)/.test(url)) return NPM_CERT_TIMEOUT_MS
  return NPM_WRITE_TIMEOUT_MS
}

export class NPMClient {
  private url:      string
  private email:    string
  private password: string
  private cache:    TokenCache = null
  private fetchImpl: (url: string, init?: RequestInit) => Promise<Response>
  private tries: number

  /**
   * `fetchImpl` is for tests (recorded fixtures); production uses the global fetch. `opts.tries` (default 5) is how
   * many times a read or the sign-in is tried on a connection error; `opts.timeoutMs` replaces the per-try limit
   * for every call (the live feed uses one 10 s try, so a hung NPM cannot hold up its tick).
   */
  constructor(url: string, email: string, password: string, fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>,
    opts: { tries?: number; timeoutMs?: number } = {}) {
    this.url      = url.replace(/\/$/, '')
    this.email    = email
    this.password = password
    // Each try gets its own limit (the retry loop in idempotent() then starts a fresh one); a caller's own signal wins.
    const inner = fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i))
    this.fetchImpl = (u, i) => inner(u, { ...i, signal: i?.signal ?? AbortSignal.timeout(opts.timeoutMs ?? npmTimeoutFor(i?.method, u)) })
    this.tries = Math.max(1, Math.floor(opts.tries ?? 5))
  }

  private cacheKey(): string {
    return `${this.url}\n${this.email}\n${createHash('sha256').update(this.password).digest('hex')}`
  }

  private async getToken(): Promise<string> {
    if (this.cache && this.cache.expires > new Date()) return this.cache.token
    const shared = tokens.get(this.cacheKey())
    if (shared && shared.expires > new Date()) { this.cache = shared; return shared.token }

    const key = this.cacheKey()
    let pending = signingIn.get(key)
    if (!pending) {
      pending = this.signIn().finally(() => signingIn.delete(key))
      signingIn.set(key, pending)
    }
    this.cache = await pending
    tokens.set(key, this.cache)
    return this.cache.token
  }

  private async signIn(): Promise<{ token: string; expires: Date }> {
    // Never follow a redirect here: it would resend the password to wherever NPM pointed.
    const res  = await this.idempotent(`${this.url}/api/tokens`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'manual',
      body: JSON.stringify({ identity: this.email, secret: this.password }),
    })
    if (!res.ok) throw new Error(res.status >= 300 && res.status < 400 ? `NPM answered the sign-in with a redirect (${res.status}); HyperProx does not follow it` : `NPM auth failed: ${res.status}`)
    const json = await res.json() as { token: string; expires: string }
    const said = Date.parse(json.expires ?? '')
    const until = Number.isFinite(said) ? Math.min(said - 5 * 60_000, Date.now() + 23 * 3600_000) : Date.now() + 23 * 3600_000
    return { token: json.token, expires: new Date(until) }
  }

  /**
   * GETs and the sign-in are retried on a connection error (never on an HTTP answer): NPM reloads its own
   * nginx, which also fronts its API, after every write, so the API refuses connections for a moment.
   */
  private async idempotent(url: string, init: RequestInit): Promise<Response> {
    for (let i = 0; ; i++) {
      try { return await this.fetchImpl(url, init) }
      catch (e) { if (i >= this.tries - 1) throw e; await new Promise(r => setTimeout(r, 400 * (i + 1))) }
    }
  }

  private forgetToken(): void { this.cache = null; tokens.delete(this.cacheKey()) }

  private async get<T>(path: string): Promise<T> {
    const token = await this.getToken()
    const res   = await this.idempotent(`${this.url}/api${path}`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'manual' })
    if (res.status === 401) this.forgetToken()
    if (!res.ok) throw new Error(`NPM API error ${res.status} on ${path}`)
    return res.json() as Promise<T>
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.getToken()
    const res   = await this.fetchImpl(`${this.url}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'manual',
    })
    if (res.status === 401) this.forgetToken()
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`NPM ${method} ${path} failed ${res.status}: ${err}`)
    }
    if (method === 'DELETE') return undefined as any
    return res.json() as Promise<T>
  }

  async getCertificates():          Promise<NPMCertificate[]>  { return this.get('/nginx/certificates') }
  async deleteCertificate(id: number): Promise<void>           { return this.req('DELETE', `/nginx/certificates/${id}`) }
  // The other host kinds that can carry a certificate. Read-only, and only the fields certificate
  // housekeeping needs: a certificate any of them uses is not "unused".
  async getRedirectionHosts(): Promise<NPMCertificateUser[]> { return this.get('/nginx/redirection-hosts') }
  async getDeadHosts():        Promise<NPMCertificateUser[]> { return this.get('/nginx/dead-hosts') }
  async getStreams():          Promise<NPMCertificateUser[]> { return this.get('/nginx/streams') }
  async getProxyHost(id: number):   Promise<NPMProxyHost>      { return this.get(`/nginx/proxy-hosts/${id}`) }
  async enableProxyHost(id: number): Promise<NPMProxyHost>     { return this.req('POST', `/nginx/proxy-hosts/${id}/enable`) }
  async disableProxyHost(id: number): Promise<NPMProxyHost>    { return this.req('POST', `/nginx/proxy-hosts/${id}/disable`) }
  async deleteProxyHost(id: number): Promise<void>             { return this.req('DELETE', `/nginx/proxy-hosts/${id}`) }
  async createProxyHost(data: Partial<NPMProxyHost>): Promise<NPMProxyHost> { return this.req('POST', '/nginx/proxy-hosts', data) }
  async updateProxyHost(id: number, data: Partial<NPMProxyHost>): Promise<NPMProxyHost> { return this.req('PUT', `/nginx/proxy-hosts/${id}`, data) }

  /** Whether this login has the admin role; lesser logins only see their own items. */
  async isAdmin(): Promise<boolean> {
    const me = await this.get<{ roles?: string[] }>('/users/me')
    return Array.isArray(me.roles) && me.roles.includes('admin')
  }

  async requestCertificate(data: { domain_names: string[]; provider: string; nice_name: string; letsencrypt_email?: string }): Promise<NPMCertificate> {
    const base = { domain_names: data.domain_names, provider: data.provider, nice_name: data.nice_name }
    // NPM before 2.13 wants the Let's Encrypt address and agreement on each request. Newer NPM takes the
    // address from the account and refuses those fields ("data/meta must NOT have additional properties").
    // A refused request creates nothing, so the newer shape is tried only after that exact refusal.
    const attempts: Array<Record<string, unknown>> = [
      ...(data.letsencrypt_email ? [{ ...base, meta: { letsencrypt_email: data.letsencrypt_email, letsencrypt_agree: true, dns_challenge: false } }] : []),
      { ...base, meta: { dns_challenge: false } },
      base,
    ]
    let last: unknown
    for (const body of attempts) {
      try { return await this.req('POST', '/nginx/certificates', body) }
      catch (e: any) {
        last = e
        if (!/additional properties/i.test(String(e?.message ?? ''))) throw e
      }
    }
    throw last
  }

  async getProxyHosts(): Promise<NPMProxyHost[]> {
    const [hosts, certs] = await Promise.all([
      this.get<NPMProxyHost[]>('/nginx/proxy-hosts'),
      this.getCertificates(),
    ])
    const certMap = new Map(certs.map(c => [c.id, c]))
    return hosts.map(h => ({
      ...h,
      certificate: typeof h.certificate_id === 'number' ? certMap.get(h.certificate_id) : undefined,
    }))
  }

  async getStats(): Promise<NPMStats> {
    const hosts = await this.getProxyHosts()
    const now   = new Date()
    let expiring = 0, expired = 0, ssl = 0
    for (const h of hosts) {
      if (h.certificate) {
        ssl++
        const days = (new Date(h.certificate.expires_on).getTime() - now.getTime()) / 86400000
        if (days < 0) expired++
        else if (days < 30) expiring++
      }
    }
    return {
      total:    hosts.length,
      enabled:  hosts.filter(h => h.enabled).length,
      disabled: hosts.filter(h => !h.enabled).length,
      online:   hosts.filter(h => h.meta?.nginx_online).length,
      ssl, expiring, expired,
    }
  }

  static daysUntilExpiry(expiresOn: string): number {
    return Math.floor((new Date(expiresOn).getTime() - Date.now()) / 86400000)
  }

  static sslStatus(host: NPMProxyHost): 'valid' | 'expiring' | 'expired' | 'none' {
    if (!host.certificate) return 'none'
    const d = NPMClient.daysUntilExpiry(host.certificate.expires_on)
    if (d < 0)  return 'expired'
    if (d < 30) return 'expiring'
    return 'valid'
  }
}
