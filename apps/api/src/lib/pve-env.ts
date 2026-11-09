// =============================================================================
//  The Proxmox client built from the environment, at the moment it is used
//
//  Since the vault gate, the Proxmox token is not in the environment when the API starts: it arrives
//  from the vault on the first unlock and leaves again on lock. A client built once at start-up (or
//  cached forever) therefore holds an empty token and every call fails quietly, so the Storage page
//  showed 0 B and power actions could not reach Proxmox. Build from the current values instead; the
//  client is reused while they stay the same.
//
//  Multi-cluster: inside a request (or job) for a remote cluster (lib/clusters/context.ts) the client is that
//  cluster's: its address, its token from the vault, and a connection that accepts only the certificate the
//  owner confirmed. Outside one, nothing changes: the home cluster from PROXMOX_*.
// =============================================================================

import { ProxmoxClient } from './proxmox-client'
import { currentRemote } from './clusters/context'
import { createHash } from 'node:crypto'
import { remoteToken, clusterRow, HOME_ID } from './clusters/registry'
import { PinnedAgent } from './clusters/tls-pin'

let cached: { key: string; client: ProxmoxClient } | null = null
const remoteCache = new Map<string, { key: string; client: ProxmoxClient }>()

export class CertificateNotConfirmedError extends Error {
  readonly code = 'cert_unconfirmed'
  constructor(name: string) {
    super(`${name}'s certificate has not been confirmed at its current address, so HyperProx will not send it anything. Confirm its fingerprint first (Command center -> ${name} -> Edit).`)
    this.name = 'CertificateNotConfirmedError'
  }
}

/** The home cluster's client, from PROXMOX_*, whatever context this runs in. */
export function homePve(): ProxmoxClient {
  const host   = process.env.PROXMOX_HOST ?? ''
  const port   = Number(process.env.PROXMOX_PORT ?? 8006)
  const token  = `${process.env.PROXMOX_USER}!${process.env.PROXMOX_TOKEN_ID}`
  const secret = process.env.PROXMOX_TOKEN_SECRET ?? ''
  if (!host || !secret) throw new Error('Proxmox is not configured, or HyperProx is locked (sign in to unlock)')
  const key = `${host}|${port}|${token}|${secret}`
  if (cached?.key !== key) cached = { key, client: new ProxmoxClient(host, port, token, secret) }
  return cached.client
}

/** A remote cluster's pinned client. Throws while locked, without a token, or without a confirmed certificate. */
export function remotePve(r: { id: string; name: string; address: string; port: number; certFingerprint: string | null }): ProxmoxClient {
  if (!r.certFingerprint) throw new CertificateNotConfirmedError(r.name)
  const t = remoteToken(r.id)
  const key = `${r.address}|${r.port}|${r.certFingerprint}|${t.tokenId}|${t.secret}`
  const hit = remoteCache.get(r.id)
  if (hit?.key === key) return hit.client
  const client = new ProxmoxClient(r.address, r.port, t.tokenId, t.secret, { agent: new PinnedAgent(r.certFingerprint) })
  remoteCache.set(r.id, { key, client })
  return client
}

/** A client for the cluster this code runs for (home unless a remote cluster's context is set). */
export function pveFromEnv(): ProxmoxClient {
  const r = currentRemote()
  return r ? remotePve(r) : homePve()
}

/**
 * A one-way key of how HyperProx reaches a cluster: address, port, confirmed certificate and API token (home: the
 * PROXMOX_* settings). A plan made under one key is not applied under another. Only the hash is kept; it reveals
 * nothing of the token. Throws while locked (a remote's token is in the vault).
 */
export function connectionKey(id: string): string {
  const h = createHash('sha256')
  if (id === HOME_ID) {
    h.update(['home', process.env.PROXMOX_HOST ?? '', process.env.PROXMOX_PORT ?? '8006', process.env.PROXMOX_USER ?? '', process.env.PROXMOX_TOKEN_ID ?? '', process.env.PROXMOX_TOKEN_SECRET ?? ''].join('\n'))
  } else {
    const r = clusterRow(id)
    if (!r) throw new Error('That cluster was removed.')
    const t = remoteToken(id)
    h.update(['remote', r.address, String(r.port), r.certFingerprint ?? '', t.tokenId, t.secret].join('\n'))
  }
  return h.digest('hex').slice(0, 32)
}

/** Forget a remote's client (its token or certificate changed, or it was removed). */
export function forgetRemoteClient(id: string): void { remoteCache.delete(id) }

/**
 * A stand-in for code written as `const pve = getClient()` at registration time: every property access
 * resolves against pveFromEnv(), so the call sites stay as they are and always use the current token
 * (and the current request's cluster).
 */
export function livePve(): ProxmoxClient {
  return new Proxy({} as ProxmoxClient, {
    get(_t, prop) {
      const c = pveFromEnv() as any
      const v = c[prop]
      return typeof v === 'function' ? v.bind(c) : v
    },
  })
}
