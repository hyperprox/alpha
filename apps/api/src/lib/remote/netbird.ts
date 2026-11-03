// =============================================================================
//  HyperProx — Remote access: NetBird management API client
//
//  NetBird Cloud or a self-hosted management server, with a personal access
//  token. Setup keys are one-off, single use, not ephemeral. NetBird will not
//  make a key that lives less than a day, so HyperProx asks for exactly a day
//  and deletes the key the moment the install ends.
// =============================================================================

import { requestJson, type FetchFn } from './http'
import { ProviderError, type MintedKey, type ProviderDevice, type RemoteProvider, type RoutingRequest } from './types'

export const NETBIRD_CLOUD = 'https://api.netbird.io'
/** NetBird's minimum setup-key lifetime. */
export const SETUP_KEY_EXPIRY_SECONDS = 86400
/** Routes HyperProx creates are distributed to this group only, never to All. Peers join it on purpose. */
export const ROUTES_GROUP = 'hyperprox-routes'

export interface NetbirdCreds { managementUrl?: string; apiToken: string }

/**
 * The API base for a management URL as people paste it (`https://nb.example.com`, `.../api/`). Blank is
 * NetBird Cloud. https only, with no exception: the token travels in a header.
 */
export function normaliseManagementUrl(raw: string | undefined): string {
  const s = (raw ?? '').trim()
  if (!s) return NETBIRD_CLOUD
  let u: URL
  try { u = new URL(s) } catch { throw new ProviderError(`Not a URL: ${s.slice(0, 80)} (it should start with https://)`) }
  if (u.username || u.password) throw new ProviderError('The management URL must not contain credentials')
  if (u.protocol !== 'https:') throw new ProviderError('The management URL must use https://')
  const path = u.pathname.replace(/\/+$/, '').replace(/\/api$/, '')
  return `${u.protocol}//${u.host}${path}`
}

export class NetbirdClient implements RemoteProvider {
  readonly id = 'netbird' as const
  readonly base: string
  private readonly f: FetchFn

  constructor(private readonly creds: NetbirdCreds, o: { fetch?: FetchFn } = {}) {
    if (!creds.apiToken) throw new ProviderError('NetBird is not configured: add a personal access token')
    this.base = normaliseManagementUrl(creds.managementUrl)
    this.f = o.fetch ?? fetch
  }

  /** What the client is given as --management-url: the cloud's own default, or the self-hosted base. */
  get clientManagementUrl(): string { return this.base === NETBIRD_CLOUD ? 'https://api.netbird.io:443' : this.base }

  private call<T = any>(path: string, what: string, r: Parameters<typeof requestJson>[3] = {}): Promise<T> {
    return requestJson<T>(this.f, `${this.base}/api${path}`, `NetBird ${what}`, { ...r, headers: { authorization: `Token ${this.creds.apiToken}` } })
  }

  async test(): Promise<string> {
    const n = (await this.listDevices()).length
    return `Connected — ${n} peer${n === 1 ? '' : 's'}`
  }

  private async groupIds(names: string[]): Promise<string[]> {
    if (!names.length) return []
    const groups = await this.call<any[]>('/groups', 'list groups')
    const byName = new Map((Array.isArray(groups) ? groups : []).map((g: any) => [String(g.name), String(g.id)]))
    const missing = names.filter(n => !byName.has(n))
    if (missing.length) throw new ProviderError(`NetBird has no group called ${missing.join(', ')}`)
    return names.map(n => byName.get(n)!)
  }

  async mintKey(o: { name: string; tags: string[] }): Promise<MintedKey> {
    const groups = await this.groupIds([...new Set(o.tags.map(t => t.trim()).filter(Boolean))])
    const r = await this.call<any>('/setup-keys', 'create setup key', {
      method: 'POST',
      json: { name: o.name.slice(0, 60), type: 'one-off', expires_in: SETUP_KEY_EXPIRY_SECONDS, auto_groups: groups, usage_limit: 1, ephemeral: false },
    })
    if (!r?.id || !r?.key) throw new ProviderError('NetBird create setup key: the answer had no key')
    return { id: String(r.id), secret: String(r.key), expiresAt: String(r.expires ?? '') }
  }

  async revokeKey(id: string): Promise<void> {
    await this.call(`/setup-keys/${encodeURIComponent(id)}`, 'delete setup key', { method: 'DELETE', okStatus: [404] })
  }

  async keyRevoked(id: string): Promise<boolean> {
    const r = await this.call<any>(`/setup-keys/${encodeURIComponent(id)}`, 'read setup key', { okStatus: [404] })
    if (!r || !r.id) return true
    return r.revoked === true || r.valid === false || r.state === 'revoked' || r.state === 'expired'
  }

  /** The id of the HyperProx routes group, made the first time it is needed. */
  private async routesGroup(): Promise<string> {
    const groups = await this.call<any[]>('/groups', 'list groups')
    const hit = (Array.isArray(groups) ? groups : []).find((g: any) => g.name === ROUTES_GROUP)
    if (hit?.id) return String(hit.id)
    const made = await this.call<any>('/groups', 'create group', { method: 'POST', json: { name: ROUTES_GROUP } })
    if (!made?.id) throw new ProviderError(`NetBird create group: no id for ${ROUTES_GROUP}`)
    return String(made.id)
  }

  async listDevices(): Promise<ProviderDevice[]> {
    const r = await this.call<any[]>('/peers', 'list peers')
    return (Array.isArray(r) ? r : []).map((p: any): ProviderDevice => ({
      id:        String(p.id ?? ''),
      name:      String(p.name ?? p.hostname ?? ''),
      hostname:  p.hostname ? String(p.hostname) : undefined,
      addresses: p.ip ? [String(p.ip)] : [],
      online:    p.connected === true,
      lastSeen:  p.last_seen ? String(p.last_seen) : null,
      version:   p.version ? String(p.version) : null,
      os:        p.os ? String(p.os) : undefined,
    }))
  }

  async deleteDevice(id: string): Promise<void> {
    await this.call(`/peers/${encodeURIComponent(id)}`, 'delete peer', { method: 'DELETE', okStatus: [404] })
  }

  async setRouting(device: ProviderDevice, r: RoutingRequest, previous: string[]): Promise<string[]> {
    for (const id of previous) await this.call(`/routes/${encodeURIComponent(id)}`, 'delete route', { method: 'DELETE', okStatus: [404] })
    const networks = [...r.subnets, ...(r.exitNode ? ['0.0.0.0/0'] : [])]
    if (!networks.length) return []
    const group = await this.routesGroup()
    const made: string[] = []
    for (const network of networks) {
      const res = await this.call<any>('/routes', 'create route', {
        method: 'POST',
        json: {
          description: `HyperProx: ${network === '0.0.0.0/0' ? 'exit node' : network} via ${device.name}`.slice(0, 100),
          network_id: `hp-${device.name}-${network}`.replace(/[^A-Za-z0-9.-]/g, '-').slice(0, 40),
          enabled: true, peer: device.id, network, metric: 9999, masquerade: true, groups: [group], keep_route: false,
          // An exit node is offered, never pushed: no peer's default route moves until its user picks it.
          ...(network === '0.0.0.0/0' ? { skip_auto_apply: true } : {}),
        },
      })
      if (res?.id) made.push(String(res.id))
    }
    return made
  }
}
