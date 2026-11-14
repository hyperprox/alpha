// =============================================================================
//  HyperProx — people in the vault (Settings → Users)
//
//  Who can sign in to HyperProx is who is a member of the vault's "HyperProx" organization, and their role is
//  their membership type (broker.ts roleFromMemberType). Vaultwarden listens on loopback only and this install
//  sends no mail, so people are added from HyperProx itself:
//
//    1. an admin invites an email with a role (the organization invite, made with the admin's own session);
//       HyperProx gives back a one-time link instead of an email
//    2. the invitee opens the link, chooses a master password and sets up two-step login on HyperProx's
//       join page; the account is registered in the vault the same way the owner's was
//    3. an admin confirms them, after comparing the key fingerprint the join page showed the invitee. That
//       hands them the organization key, wrapped with their own public key (what Bitwarden clients do)
//
//  Pure helpers here; the vault calls are in native.ts and broker.ts.
// =============================================================================

import crypto from 'node:crypto'
import { MEMBER_TYPE } from './bw-crypto'
import type { Role } from './broker'

/** The roles a person can be given here. Owner is the one who set HyperProx up; it is never handed out. */
export type GrantableRole = 'admin' | 'operator' | 'viewer'
export const GRANTABLE: GrantableRole[] = ['admin', 'operator', 'viewer']
export const isGrantable = (r: unknown): r is GrantableRole => typeof r === 'string' && (GRANTABLE as string[]).includes(r)

/** Membership type for a role: admin is Admin; operator is Manager; viewer is User (broker.ts maps them back). */
export function memberTypeFor(role: GrantableRole): number {
  return role === 'admin' ? MEMBER_TYPE.Admin : role === 'operator' ? MEMBER_TYPE.Manager : MEMBER_TYPE.User
}

export type MemberStatus = 'invited' | 'accepted' | 'confirmed' | 'revoked'
export function memberStatus(n: number): MemberStatus {
  return n === 2 ? 'confirmed' : n === 1 ? 'accepted' : n === 0 ? 'invited' : 'revoked'
}

export interface VaultMember {
  id: string
  userId: string | null
  email: string
  name: string | null
  role: Role
  status: MemberStatus
  twoFactor: boolean
  /** Accepted, waiting for an admin: the fingerprint of their public key, to compare with what they were shown. */
  fingerprint: string | null
}

/** A short, readable fingerprint of a public key (SHA-256 of the DER, first 16 bytes, in groups of four hex). */
export function keyFingerprint(publicDer: Buffer): string {
  const h = crypto.createHash('sha256').update(publicDer).digest('hex').slice(0, 32)
  return h.match(/.{4}/g)!.join('-')
}

/** Vaultwarden's ids are UUIDs; anything else never reaches a path. */
export const VAULT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
