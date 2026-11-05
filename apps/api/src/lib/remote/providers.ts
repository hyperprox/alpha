// =============================================================================
//  HyperProx — Remote access: providers built from the vault
//
//  Credentials are vault items like every other integration
//  (hyperprox:remote/tailscale, hyperprox:remote/netbird), edited under
//  Settings → Credentials → Remote access. A provider is null when it has not
//  been set up, and reading one while locked throws, as every credential does.
// =============================================================================

import { getProviderCredentials } from '../credentials'
import { TailscaleClient } from './tailscale'
import { NetbirdClient } from './netbird'
import type { FetchFn } from './http'
import { ProviderError, type ProviderId, type RemoteProvider } from './types'
import type { ProviderSettings } from './service'

export const REMOTE_CATEGORY = 'remote'

type Reader = (category: string, provider: string) => Promise<Record<string, string>>

const list = (v: string | undefined) => (v ?? '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
const yes = (v: string | undefined) => /^(1|y|yes|on|true)$/i.test((v ?? '').trim())

/**
 * Every read of a provider credential is audited, without the value. Reads happen on each page load, so one
 * entry per provider per minute is written, not one per read.
 */
type Auditor = (provider: ProviderId) => void
let auditor: Auditor | null = null
const lastAudit = new Map<ProviderId, number>()
export function setCredentialAuditor(fn: ((action: string, resource: string, details: Record<string, unknown>) => Promise<unknown>) | null): void {
  auditor = fn ? (id => {
    const t = Date.now()
    if ((lastAudit.get(id) ?? 0) > t - 60_000) return
    lastAudit.set(id, t)
    void fn('remote.credential.read', `${REMOTE_CATEGORY}/${id}`, { provider: id }).catch(() => undefined)
  }) : null
}

// OAuth tokens are cached inside a client, so the client is reused while the stored values stay the same.
const cache = new Map<ProviderId, { sig: string; p: RemoteProvider }>()

export async function providerFromVault(id: ProviderId, read: Reader = getProviderCredentials, fetchFn?: FetchFn): Promise<RemoteProvider | null> {
  // While locked this throws "HyperProx is locked — sign in to ...": there is nothing to fall back to.
  const c = await read(REMOTE_CATEGORY, id)
  auditor?.(id)
  const sig = JSON.stringify(c)
  const hit = cache.get(id)
  if (hit && hit.sig === sig && !fetchFn) return hit.p
  let p: RemoteProvider | null = null
  if (id === 'tailscale') {
    if (!c.api_token && !(c.oauth_client_id && c.oauth_client_secret)) return null
    p = new TailscaleClient({ apiToken: c.api_token, oauthClientId: c.oauth_client_id, oauthClientSecret: c.oauth_client_secret, tailnet: c.tailnet }, { fetch: fetchFn })
  } else {
    if (!c.api_token) return null
    p = new NetbirdClient({ managementUrl: c.management_url, apiToken: c.api_token }, { fetch: fetchFn })
  }
  if (!fetchFn) cache.set(id, { sig, p })
  return p
}

export async function providerSettingsFromVault(id: ProviderId, read: Reader = getProviderCredentials): Promise<ProviderSettings> {
  const c = await read(REMOTE_CATEGORY, id)
  const dns = { acceptDnsCt: yes(c.default_accept_dns_ct), acceptDnsVm: yes(c.default_accept_dns_vm) }
  if (id === 'tailscale') return { tags: list(c.default_tags), ...dns }
  const p = await providerFromVault(id, read).catch(() => null)
  return { tags: list(c.default_groups), managementUrl: p instanceof NetbirdClient ? p.clientManagementUrl : undefined, ...dns }
}

/** The Settings Test button: one line, or throws with a reason a person can act on. */
export async function testProvider(id: string, read: Reader = getProviderCredentials, fetchFn?: FetchFn): Promise<string> {
  if (id !== 'tailscale' && id !== 'netbird') throw new ProviderError(`No remote access provider called ${id}`)
  const p = await providerFromVault(id, read, fetchFn)
  if (!p) throw new ProviderError(id === 'tailscale'
    ? 'Add an API access token, or an OAuth client ID and secret, then save'
    : 'Add a personal access token (and your management URL if you self-host), then save')
  return p.test()
}
