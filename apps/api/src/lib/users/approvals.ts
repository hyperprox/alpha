// =============================================================================
//  HyperProx — is a past approval still backed by an admin?
//
//  Work approved now and done later (a scheduled move, a balancing plan) needs
//  its approver to still be an admin when it runs. That is read from what
//  HyperProx holds, never by borrowing anyone's session: the approver's own live
//  session (its role is current: a role change signs them out), the role record
//  (lib/users/roles.ts), and the audit log (a removal names the email; a role
//  change names only a member id, so any lowering since the approval counts).
//
//  "Admin" means at least admin: an owner is an admin too (lib/roles.ts hasRole).
// =============================================================================

import { allSessions } from '../auth'
import { memberRoles } from './roles'
import { hasRole, type Role } from '../roles'

const KNOWN: ReadonlySet<string> = new Set(['viewer', 'operator', 'admin', 'owner'])
/** A role written somewhere (a session, the record, an audit row) that is at least admin. Unknown text is not. */
const atLeastAdmin = (r: unknown): boolean => typeof r === 'string' && KNOWN.has(r) && hasRole(r as Role, 'admin')

/** Why the approver no longer stands behind an approval made at `sinceMs`, in words, or null. */
export async function approverChanged(prisma: any, email: string, sinceMs: number, sessions: () => Array<{ email: string; role: unknown }> = allSessions,
  recorded: (email: string) => string | null | undefined = e => memberRoles().get(e)): Promise<string | null> {
  const e = email.toLowerCase()
  const own = sessions().find(x => String(x.email).toLowerCase() === e)
  if (own && !atLeastAdmin(own.role)) return `is now ${own.role}, not admin`
  let rec: string | null | undefined = null
  try { rec = recorded(e) } catch { rec = null }
  if (rec && !atLeastAdmin(rec)) return `is now ${rec}, not admin`
  if (!prisma?.auditLog) return null
  const since = new Date(sinceMs)
  // Every removal and role change since the approval, oldest first, page by page: none is missed however many there
  // are. More than the pages allow is "could not check", never "nothing changed".
  const PAGE = 200, PAGES = 25
  for (let page = 0; page < PAGES; page++) {
    const rows: any[] = await prisma.auditLog.findMany({
      where: { action: { in: ['users.remove', 'users.role'] }, createdAt: { gte: since } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: page * PAGE, take: PAGE,
    })
    for (const r of rows) {
      const d = (r.details ?? {}) as Record<string, unknown>
      if (r.action === 'users.remove' && String(d.email ?? '').toLowerCase() === e) return 'was removed after approving it'
      // A change to admin or owner lowers nobody; their own admin (or owner) session settles any other.
      if (r.action === 'users.role' && !atLeastAdmin(d.role) && !(own && atLeastAdmin(own.role))) {
        return 'may have been demoted: a role was lowered after the approval, and HyperProx cannot tell whose'
      }
    }
    if (rows.length < PAGE) return null
  }
  return 'could not be checked: too many role changes since the approval'
}
