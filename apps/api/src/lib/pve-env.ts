// =============================================================================
//  The Proxmox client built from the environment, at the moment it is used
//
//  Since the vault gate, the Proxmox token is not in the environment when the API starts: it arrives
//  from the vault on the first unlock and leaves again on lock. A client built once at start-up (or
//  cached forever) therefore holds an empty token and every call fails quietly, so the Storage page
//  showed 0 B and power actions could not reach Proxmox. Build from the current values instead; the
//  client is reused while they stay the same.
// =============================================================================

import { ProxmoxClient } from './proxmox-client'

let cached: { key: string; client: ProxmoxClient } | null = null

/** A client for the current PROXMOX_* values. Throws while they are not set (HyperProx locked). */
export function pveFromEnv(): ProxmoxClient {
  const host   = process.env.PROXMOX_HOST ?? ''
  const port   = Number(process.env.PROXMOX_PORT ?? 8006)
  const token  = `${process.env.PROXMOX_USER}!${process.env.PROXMOX_TOKEN_ID}`
  const secret = process.env.PROXMOX_TOKEN_SECRET ?? ''
  if (!host || !secret) throw new Error('Proxmox is not configured, or HyperProx is locked (sign in to unlock)')
  const key = `${host}|${port}|${token}|${secret}`
  if (cached?.key !== key) cached = { key, client: new ProxmoxClient(host, port, token, secret) }
  return cached.client
}

/**
 * A stand-in for code written as `const pve = getClient()` at registration time: every property access
 * resolves against pveFromEnv(), so the call sites stay as they are and always use the current token.
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
