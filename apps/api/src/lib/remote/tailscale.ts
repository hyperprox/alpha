// =============================================================================
//  HyperProx — Remote access: Tailscale API client
//
//  Authenticates with an API access token, or with an OAuth client (preferred
//  when both are stored: its tokens last an hour and its scopes are narrow).
//  Keys are minted per install: single use, not ephemeral, preauthorized, the
//  install's tags, ten minutes to live. HyperProx revokes each one as soon as
//  the install ends, used or not.
// =============================================================================

import { requestJson, type FetchFn } from './http'
import { ProviderError, type MintedKey, type ProviderDevice, type RemoteProvider, type RoutingRequest } from './types'

export const TAILSCALE_API = 'https://api.tailscale.com'
export const TAG_RE = /^tag:[A-Za-z0-9][A-Za-z0-9-]{0,62}$/
/** Long enough for a slow apt run, short enough that a leaked key is useless by the time anyone finds it. */
export const KEY_EXPIRY_SECONDS = 600

export interface TailscaleCreds {
  apiToken?:          string
  oauthClientId?:     string
  oauthClientSecret?: string
  /** Blank or "-" is the credential's own tailnet. */
  tailnet?:           string
}

export interface ClientOptions { fetch?: FetchFn; now?: () => number; base?: string }

export class TailscaleClient implements RemoteProvider {
  readonly id = 'tailscale' as const
  private readonly f: FetchFn
  private readonly now: () => number
  private readonly base: string
  private oauth: { token: string; until: number } | null = null

  constructor(private readonly creds: TailscaleCreds, o: ClientOptions = {}) {
    this.f = o.fetch ?? fetch
    this.now = o.now ?? Date.now
    this.base = (o.base ?? TAILSCALE_API).replace(/\/+$/, '')
    if (!this.usesOAuth && !creds.apiToken) throw new ProviderError('Tailscale is not configured: add an API access token or an OAuth client')
  }

  get usesOAuth(): boolean { return !!(this.creds.oauthClientId && this.creds.oauthClientSecret) }
  private get tailnet(): string { return encodeURIComponent((this.creds.tailnet ?? '').trim() || '-') }

  private async authHeader(): Promise<string> {
    if (!this.usesOAuth) return `Bearer ${this.creds.apiToken}`
    if (this.oauth && this.oauth.until > this.now()) return `Bearer ${this.oauth.token}`
    const r = await requestJson<any>(this.f, `${this.base}/api/v2/oauth/token`, 'Tailscale OAuth', {
      method: 'POST',
      form: { client_id: this.creds.oauthClientId!, client_secret: this.creds.oauthClientSecret!, grant_type: 'client_credentials' },
    })
    if (!r?.access_token) throw new ProviderError('Tailscale OAuth: no access token in the answer')
    const life = Number(r.expires_in) > 0 ? Number(r.expires_in) * 1000 : 3600_000
    // Renewed a minute early so a token never expires between this check and the call it authorises.
    this.oauth = { token: String(r.access_token), until: this.now() + life - 60_000 }
    return `Bearer ${this.oauth.token}`
  }

  private async call<T = any>(path: string, what: string, r: Parameters<typeof requestJson>[3] = {}): Promise<T> {
    return requestJson<T>(this.f, `${this.base}${path}`, `Tailscale ${what}`, { ...r, headers: { authorization: await this.authHeader() } })
  }

  async test(): Promise<string> {
    const n = (await this.listDevices()).length
    return `Connected — ${n} device${n === 1 ? '' : 's'}`
  }

  async mintKey(o: { name: string; tags: string[] }): Promise<MintedKey> {
    const tags = [...new Set(o.tags.map(t => t.trim()).filter(Boolean))]
    const bad = tags.filter(t => !TAG_RE.test(t))
    if (bad.length) throw new ProviderError(`Not a Tailscale tag: ${bad.join(', ')} (tags look like tag:server)`)
    if (this.usesOAuth && !tags.length) {
      throw new ProviderError('Tailscale only lets an OAuth client make keys that carry at least one tag. Choose a tag (for example tag:server).')
    }
    const r = await this.call<any>(`/api/v2/tailnet/${this.tailnet}/keys`, 'create key', {
      method: 'POST',
      json: {
        capabilities: { devices: { create: { reusable: false, ephemeral: false, preauthorized: true, tags } } },
        expirySeconds: KEY_EXPIRY_SECONDS,
        description: `HyperProx ${o.name}`.replace(/[^A-Za-z0-9 -]/g, '-').slice(0, 50),
      },
    })
    if (!r?.id || !r?.key) throw new ProviderError('Tailscale create key: the answer had no key')
    return { id: String(r.id), secret: String(r.key), expiresAt: String(r.expires ?? '') }
  }

  async revokeKey(id: string): Promise<void> {
    await this.call(`/api/v2/tailnet/${this.tailnet}/keys/${encodeURIComponent(id)}`, 'revoke key', { method: 'DELETE', okStatus: [404] })
  }

  async keyRevoked(id: string): Promise<boolean> {
    const r = await this.call<any>(`/api/v2/tailnet/${this.tailnet}/keys/${encodeURIComponent(id)}`, 'read key', { okStatus: [404] })
    if (!r || !r.id) return true                                       // 404: gone
    if (r.revoked || r.invalid === true) return true
    return !!r.expires && Date.parse(r.expires) <= Date.now()
  }

  async listDevices(): Promise<ProviderDevice[]> {
    const r = await this.call<any>(`/api/v2/tailnet/${this.tailnet}/devices?fields=all`, 'list devices')
    return (Array.isArray(r?.devices) ? r.devices : []).map((d: any): ProviderDevice => ({
      id:        String(d.id ?? ''),
      nodeKey:   d.nodeId ? String(d.nodeId) : undefined,
      name:      String(d.name ?? d.hostname ?? ''),
      hostname:  d.hostname ? String(d.hostname) : undefined,
      addresses: Array.isArray(d.addresses) ? d.addresses.map(String) : [],
      online:    d.connectedToControl === true,
      lastSeen:  d.lastSeen ? String(d.lastSeen) : null,
      // "1.90.1-t1234abcd-g..." → "1.90.1"
      version:   d.clientVersion ? String(d.clientVersion).split('-')[0] : null,
      os:        d.os ? String(d.os) : undefined,
    }))
  }

  async deleteDevice(id: string): Promise<void> {
    await this.call(`/api/v2/device/${encodeURIComponent(id)}`, 'delete device', { method: 'DELETE', okStatus: [404] })
  }

  async advertisedRoutes(device: ProviderDevice): Promise<string[]> {
    const r = await this.call<any>(`/api/v2/device/${encodeURIComponent(device.id)}/routes`, 'read routes')
    return Array.isArray(r?.advertisedRoutes) ? r.advertisedRoutes.map(String) : []
  }

  async setRouting(device: ProviderDevice, r: RoutingRequest, _previous: string[]): Promise<string[]> {
    const routes = [...r.subnets, ...(r.exitNode ? ['0.0.0.0/0', '::/0'] : [])]
    await this.call(`/api/v2/device/${encodeURIComponent(device.id)}/routes`, 'approve routes', { method: 'POST', json: { routes } })
    return []
  }
}
