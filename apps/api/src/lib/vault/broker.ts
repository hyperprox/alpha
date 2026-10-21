// STUB — replaced by vg-broker at merge
// Mirrors the VaultBroker interface in docs/superpowers/plans/2026-10-21-vault-gate-mvp.md so the
// gate compiles and can be tested against a fake. The real broker (Bitwarden CLI) replaces this file.
//
// GATE relies on one addition to the contract: setBroker(), a test seam that swaps the broker the
// process uses. The real broker.ts must keep exporting it.

export type Role = 'owner' | 'admin' | 'operator' | 'viewer'
export interface VaultSession { sid: string; email: string; role: Role; userId: string }
export interface SecretItem { name: string; fields: Record<string, string>; notes?: string; id: string }

export interface VaultBroker {
  status(): Promise<{ reachable: boolean; bootstrapped: boolean }>
  bootstrapOwner(email: string, masterPassword: string): Promise<{ totpSecret: string; otpauthUri: string }>
  confirmOwnerTotp(email: string, masterPassword: string, code: string): Promise<void>
  signIn(email: string, masterPassword: string, totp: string): Promise<VaultSession>
  verifyPassword(sid: string, masterPassword: string): Promise<boolean>
  signOut(sid: string): Promise<void>
  listSecrets(sid: string): Promise<SecretItem[]>
  upsertSecret(sid: string, name: string, fields: Record<string, string>, notes?: string): Promise<SecretItem>
  deleteSecret(sid: string, name: string): Promise<void>
  createSend(sid: string, text: string, opts?: { hours?: number; maxViews?: number; password?: string }): Promise<{ url: string; expiresAt: string }>
}

export class VaultAuthError extends Error {
  code: 'bad_credentials' | 'totp_required' | 'totp_invalid' | 'not_member' | 'locked_out'
  constructor(code: VaultAuthError['code'], message?: string) {
    super(message ?? code)
    this.name = 'VaultAuthError'
    this.code = code
  }
}

let current: VaultBroker | null = null

export function getBroker(): VaultBroker {
  if (!current) throw new Error('Vault broker not available (stub)')
  return current
}

/** Test seam: replace the broker this process uses. */
export function setBroker(b: VaultBroker | null): void {
  current = b
}
