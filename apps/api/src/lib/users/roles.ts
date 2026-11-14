// =============================================================================
//  HyperProx — each member's role, as HyperProx gave it (Settings → Users)
//
//  The vault's membership type is a poor record of a HyperProx role: Vaultwarden reports a Manager (operator here)
//  as type 4, "Custom", in its member lists and profile, while its database holds 3. So HyperProx keeps the role
//  it gave each person itself, written when an invitation is made and when the owner changes a role, after the
//  vault accepted the change. The vault's type is the fallback for anyone with no record (members from before
//  this file existed). The owner is always the vault's owner: no record can make or unmake one.
//
//  data/users/roles.json, mode 0600: { "<email>": "admin" | "operator" | "viewer" }.
// =============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { isGrantable, type GrantableRole } from '../vault/members'
import { MEMBER_TYPE, normalizeEmail } from '../vault/bw-crypto'

export type MemberRole = 'owner' | GrantableRole

export function defaultRolesFile(): string {
  const root = process.env.HYPERPROX_DATA_DIR || path.resolve(__dirname, '..', '..', '..', '..', '..', 'data')
  return path.join(root, 'users', 'roles.json')
}

/**
 * A vault membership type as a role. Vaultwarden 1.3x reports a Manager as 4 (Custom) wherever it serializes a
 * membership for the client (Membership::type_manager_as_custom); its database keeps 3. Both are operator.
 */
export function roleFromMemberType(type: number): MemberRole {
  switch (type) {
    case MEMBER_TYPE.Owner: return 'owner'
    case MEMBER_TYPE.Admin: return 'admin'
    case MEMBER_TYPE.Manager:
    case MEMBER_TYPE.Custom: return 'operator'
    default: return 'viewer' // User, anything unknown
  }
}

/** A member's role: the vault's owner is the owner; otherwise HyperProx's record, else the vault's type. */
export function resolveRole(vaultType: number, recorded: GrantableRole | null | undefined): MemberRole {
  const fromVault = roleFromMemberType(vaultType)
  if (fromVault === 'owner') return 'owner'
  return recorded ?? fromVault
}

export class RoleStore {
  constructor(private file: string = defaultRolesFile()) {}

  private read(): Record<string, GrantableRole> {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (!j || typeof j !== 'object' || Array.isArray(j)) return {}
      const out: Record<string, GrantableRole> = {}
      for (const [k, v] of Object.entries(j)) if (isGrantable(v)) out[normalizeEmail(k)] = v
      return out
    } catch { return {} }
  }

  private write(all: Record<string, GrantableRole>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }

  get(email: string): GrantableRole | null {
    return this.read()[normalizeEmail(email)] ?? null
  }

  set(email: string, role: GrantableRole): void {
    const all = this.read()
    all[normalizeEmail(email)] = role
    this.write(all)
  }

  remove(email: string): void {
    const all = this.read()
    const e = normalizeEmail(email)
    if (!(e in all)) return
    delete all[e]
    this.write(all)
  }
}

let shared: RoleStore | null = null
/** The process's role record (tests pass their own store instead). */
export function memberRoles(): RoleStore {
  return shared ??= new RoleStore()
}
/** Tests: use this store as the process's record (null goes back to the default file). */
export function setMemberRoles(store: RoleStore | null): void { shared = store }
