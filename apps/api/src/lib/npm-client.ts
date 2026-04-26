// =============================================================================
//  HyperProx — Nginx Proxy Manager API Client
// =============================================================================

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

export class NPMClient {
  private url:      string
  private email:    string
  private password: string
  private cache:    TokenCache = null

  constructor(url: string, email: string, password: string) {
    this.url      = url.replace(/\/$/, '')
    this.email    = email
    this.password = password
  }

  private async getToken(): Promise<string> {
    if (this.cache && this.cache.expires > new Date()) return this.cache.token

    const res  = await fetch(`${this.url}/api/tokens`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: this.email, secret: this.password }),
    })
    if (!res.ok) throw new Error(`NPM auth failed: ${res.status}`)
    const json = await res.json() as { token: string; expires: string }
    this.cache = { token: json.token, expires: new Date(Date.now() + 23 * 60 * 60 * 1000) }
    return json.token
  }

  private async get<T>(path: string): Promise<T> {
    const token = await this.getToken()
    const res   = await fetch(`${this.url}/api${path}`, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`NPM API error ${res.status} on ${path}`)
    return res.json() as Promise<T>
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.getToken()
    const res   = await fetch(`${this.url}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`NPM ${method} ${path} failed ${res.status}: ${err}`)
    }
    if (method === 'DELETE') return undefined as any
    return res.json() as Promise<T>
  }

  async getCertificates():          Promise<NPMCertificate[]>  { return this.get('/nginx/certificates') }
  async getProxyHost(id: number):   Promise<NPMProxyHost>      { return this.get(`/nginx/proxy-hosts/${id}`) }
  async enableProxyHost(id: number): Promise<NPMProxyHost>     { return this.req('POST', `/nginx/proxy-hosts/${id}/enable`) }
  async disableProxyHost(id: number): Promise<NPMProxyHost>    { return this.req('POST', `/nginx/proxy-hosts/${id}/disable`) }
  async deleteProxyHost(id: number): Promise<void>             { return this.req('DELETE', `/nginx/proxy-hosts/${id}`) }
  async createProxyHost(data: Partial<NPMProxyHost>): Promise<NPMProxyHost> { return this.req('POST', '/nginx/proxy-hosts', data) }
  async updateProxyHost(id: number, data: Partial<NPMProxyHost>): Promise<NPMProxyHost> { return this.req('PUT', `/nginx/proxy-hosts/${id}`, data) }

  async requestCertificate(data: { domain_names: string[]; provider: string; nice_name: string; letsencrypt_email?: string }): Promise<NPMCertificate> {
    return this.req('POST', '/nginx/certificates', {
      domain_names: data.domain_names,
      provider:     data.provider,
      nice_name:    data.nice_name,
    })
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
