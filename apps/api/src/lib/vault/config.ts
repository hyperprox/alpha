// =============================================================================
//  HyperProx — vault broker configuration (environment only, read lazily)
// =============================================================================

import fs from 'node:fs'
import path from 'node:path'

/**
 * Base URL of the bundled Vaultwarden. Must be HTTPS: the Bitwarden CLI
 * (2026.10.0) refuses every non-https URL in production builds
 * (`InsecureUrlNotAllowedError`, no override). The vault serves TLS itself
 * (Rocket `ROCKET_TLS`) with a self-signed certificate that `VAULT_CA_CERT` trusts.
 */
export function vaultUrl(): string {
  return (process.env.VAULT_URL || 'https://127.0.0.1:8222').replace(/\/+$/, '')
}

/** PEM file (certificate only, no key) that the API and the CLI trust for `VAULT_URL`. */
export function vaultCaCertPath(): string | undefined {
  return process.env.VAULT_CA_CERT || undefined
}

let caCache: { path: string; pem: Buffer } | null = null
export function vaultCaCert(): Buffer | undefined {
  const p = vaultCaCertPath()
  if (!p) return undefined
  if (caCache?.path === p) return caCache.pem
  caCache = { path: p, pem: fs.readFileSync(p) }
  return caCache.pem
}

export function vaultAdminToken(): string | undefined {
  return process.env.VAULT_ADMIN_TOKEN || undefined
}

/**
 * Origin put on Send links instead of `VAULT_URL` (which is loopback-only and
 * useless to a recipient). Unset → the link keeps the vault's own origin.
 */
export function vaultPublicUrl(): string | undefined {
  const v = process.env.VAULT_PUBLIC_URL
  return v ? v.replace(/\/+$/, '') : undefined
}

export function idleLockMs(): number {
  const n = Number(process.env.VAULT_IDLE_LOCK_MINUTES ?? '30')
  return (Number.isFinite(n) && n > 0 ? n : 30) * 60_000
}

/** tmpfs root for the per-session CLI data dirs. */
export function sessionRoot(): string {
  return process.env.VAULT_SESSION_ROOT || '/dev/shm/hyperprox-vault'
}

/** `apps/api/node_modules/.bin/bw` — same depth from src/lib/vault and dist/lib/vault. */
export function bwBinary(): string {
  if (process.env.BW_CLI_PATH) return process.env.BW_CLI_PATH
  return path.resolve(__dirname, '..', '..', '..', 'node_modules', '.bin', 'bw')
}
