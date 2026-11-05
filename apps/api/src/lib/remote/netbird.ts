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

  /** The account's login expiration, for working out when each peer's login runs out. Read once per client. */
  private expiry: Promise<number | null> | null = null
  private loginExpirySeconds(): Promise<number | null> {
    this.expiry ??= this.call<any[]>('/accounts', 'read account').then(a => {
      const st = (Array.isArray(a) ? a[0] : a)?.settings
      return st?.peer_login_expiration_enabled && Number(st.peer_login_expiration) > 0 ? Number(st.peer_login_expiration) : null
    }).catch(() => null)
    return this.expiry
  }

  async listDevices(): Promise<ProviderDevice[]> {
    const r = await this.call<any[]>('/peers', 'list peers')
    const expiry = (Array.isArray(r) && r.some((p: any) => p.login_expiration_enabled)) ? await this.loginExpirySeconds() : null
    return (Array.isArray(r) ? r : []).map((p: any): ProviderDevice => ({
      id:        String(p.id ?? ''),
      name:      String(p.name ?? p.hostname ?? ''),
      hostname:  p.hostname ? String(p.hostname) : undefined,
      addresses: p.ip ? [String(p.ip)] : [],
      online:    p.connected === true,
      lastSeen:  p.last_seen ? String(p.last_seen) : null,
      version:   p.version ? String(p.version) : null,
      os:        p.os ? String(p.os) : undefined,
      dnsName:   p.dns_label ? String(p.dns_label) : null,
      expiresAt: p.login_expiration_enabled && expiry && p.last_login ? new Date(Date.parse(p.last_login) + expiry * 1000).toISOString() : null,
      keyExpiryDisabled: p.login_expiration_enabled === false,
      pending:   p.approval_required === true,
      tags:      Array.isArray(p.groups) ? p.groups.map((g: any) => String(g?.name ?? '')).filter((n: string) => n && n !== 'All') : [],
      user:      p.user_id ? String(p.user_id) : null,
      createdAt: null,
    }))
  }

  /** Change some of a peer's settings: NetBird replaces the whole peer, so the others are read and sent back. */
  private async updatePeer(id: string, patch: Record<string, unknown>): Promise<void> {
    const p = await this.call<any>(`/peers/${encodeURIComponent(id)}`, 'read peer')
    const body: Record<string, unknown> = {
      name: p?.name, ssh_enabled: !!p?.ssh_enabled, login_expiration_enabled: !!p?.login_expiration_enabled,
      inactivity_expiration_enabled: !!p?.inactivity_expiration_enabled, approval_required: !!p?.approval_required, ...patch,
    }
    await this.call(`/peers/${encodeURIComponent(id)}`, 'update peer', { method: 'PUT', json: body })
  }

  async setKeyExpiry(device: ProviderDevice, disabled: boolean): Promise<void> {
    await this.updatePeer(device.id, { login_expiration_enabled: !disabled })
  }

  async setSsh(device: ProviderDevice, on: boolean): Promise<void> {
    await this.updatePeer(device.id, { ssh_enabled: on })
  }

  async approve(device: ProviderDevice): Promise<void> {
    await this.updatePeer(device.id, { approval_required: false })
  }

  /** The peer's groups become exactly `names` (All is never touched). Every name must exist. */
  async setTags(device: ProviderDevice, names: string[]): Promise<void> {
    const groups = await this.call<any[]>('/groups', 'list groups')
    const list = Array.isArray(groups) ? groups : []
    const missing = names.filter(n => !list.some((g: any) => g.name === n))
    if (missing.length) throw new ProviderError(`NetBird has no group called ${missing.join(', ')}`)
    for (const g of list) {
      if (g.name === 'All') continue
      const ids: string[] = (Array.isArray(g.peers) ? g.peers : []).map((x: any) => String(typeof x === 'string' ? x : x?.id))
      const member = ids.includes(device.id)
      const want = names.includes(g.name)
      if (want === member) continue
      const peers = want ? [...ids, device.id] : ids.filter(i => i !== device.id)
      await this.call(`/groups/${encodeURIComponent(g.id)}`, 'update group', { method: 'PUT', json: { name: g.name, peers } })
    }
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
