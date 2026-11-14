// =============================================================================
//  HyperProx — each member's role, as HyperProx gave it (Settings → Users)
//
//  The vault's membership type is a poor record of a HyperProx role: Vaultwarden reports a Manager (operator here)
//  as type 4, "Custom", in its member lists and profile, while its database holds 3. So HyperProx keeps the role
//  it gave each person itself, written when an invitation is made and when the owner changes a role, after the
//  vault accepted the change. The vault decides every role; the record only settles whether a type 4 (Custom)
//  is an operator (resolveRole). It never raises anyone above what the vault holds.
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
 * Vaultwarden 1.37.x (the image docker-compose.yml and install.sh pin) has no Custom role: it stores a Manager as
 * 3 and reports it to clients as 4 (Membership::type_manager_as_custom). Upstream main can enable real Custom
 * roles (EXPERIMENTAL_CUSTOM_ROLES), where 4 is something else. Bumping the vault image means checking this again;
 * test/vault-members.test.ts fails when the pinned tag moves off 1.37.
 */
export const VAULT_REPORTS_MANAGER_AS_CUSTOM = true

/** Custom (4) permissions that are a Manager's: managing or editing any collection. */
export function managerPermissions(p: unknown): boolean {
  if (!p || typeof p !== 'object') return false
  const o = p as Record<string, unknown>
  return o.editAnyCollection === true || o.manageGroups === true || o.manageUsers === true || o.deleteAnyCollection === true
}

/** A vault membership type as a role, from the vault alone. 4 (Custom) is never more than viewer here. */
export function roleFromMemberType(type: number): MemberRole {
  switch (type) {
    case MEMBER_TYPE.Owner: return 'owner'
    case MEMBER_TYPE.Admin: return 'admin'
    case MEMBER_TYPE.Manager: return 'operator'
    default: return 'viewer' // User, Custom (unless resolveRole settles it), anything unknown
  }
}

/**
 * A member's role. The vault decides: owner, admin, operator (3) and viewer (2) are what it holds, whatever
 * HyperProx recorded, so a demotion or removal made in the vault itself counts at once. HyperProx's record only
 * settles the one ambiguity: a type 4 (Custom) is an operator when HyperProx made them one (record "operator")
 * and either the pinned Vaultwarden reports Managers as 4 or the vault's own permissions are a Manager's. An
 * unrecorded type 4 is a viewer. The record can never raise anyone above what the vault holds.
 */
export function resolveRole(vaultType: number, recorded: GrantableRole | null | undefined,
  opts: { permissions?: unknown; managerAsCustom?: boolean } = {}): MemberRole {
  if (vaultType !== MEMBER_TYPE.Custom) return roleFromMemberType(vaultType)
  const asCustom = opts.managerAsCustom ?? VAULT_REPORTS_MANAGER_AS_CUSTOM
  return recorded === 'operator' && (asCustom || managerPermissions(opts.permissions)) ? 'operator' : 'viewer'
}

/** Whether a record still means something for this vault type (only "operator", on a 3 or 4). */
export function recordAgrees(vaultType: number, recorded: GrantableRole | null | undefined): boolean {
  return recorded === 'operator' && (vaultType === MEMBER_TYPE.Manager || vaultType === MEMBER_TYPE.Custom)
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
    // A leftover from a crash goes first; then the file is made new (never written through a link someone put
    // there), owner-only, and renamed over the record.
    try { fs.unlinkSync(tmp) } catch { /* none */ }
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600, flag: 'wx' })
    fs.renameSync(tmp, this.file)
  }

  /** Every record, for dropping the stale ones. */
  entries(): Array<[string, GrantableRole]> { return Object.entries(this.read()) }

  /** Keep only these emails' records (a listing of the vault's members drops anyone no longer there). */
  retain(keep: (email: string, role: GrantableRole) => boolean): void {
    const all = this.read()
    let changed = false
    for (const [e, r] of Object.entries(all)) if (!keep(e, r)) { delete all[e]; changed = true }
    if (changed) this.write(all)
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
