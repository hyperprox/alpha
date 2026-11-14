// Settings → Users and the join page: the words and choices, kept free of CSS so they can be tested in Node.

export type Role = 'owner' | 'admin' | 'operator' | 'viewer'
export type Grantable = 'admin' | 'operator' | 'viewer'
export type Status = 'invited' | 'accepted' | 'confirmed' | 'revoked'

export interface Member { id: string; email: string; name: string | null; role: Role; status: Status; twoFactor: boolean; fingerprint: string | null }

export const ROLE_WORDS: Record<Role, string> = {
  owner: 'Owner: everything, including who has which role',
  admin: 'Admin: everything except role changes',
  operator: 'Operator: read everything, start and stop guests, terminals',
  viewer: 'Viewer: read only',
}

/**
 * The roles this person may hand out. The vault lets only its owner add, confirm or remove anyone who manages
 * others (an operator or admin), so an admin invites viewers and the owner invites anyone.
 */
export function grantableBy(me: Role | null | undefined): Grantable[] {
  if (me === 'owner') return ['admin', 'operator', 'viewer']
  if (me === 'admin') return ['viewer']
  return []
}

/** Whether this person may confirm, or withdraw the invitation of, someone with this role (the same vault rule). */
export function managesRole(me: Role | null | undefined, role: Role): boolean {
  if (me === 'owner') return true
  return me === 'admin' && role === 'viewer'
}

/** What the row says and offers. */
export function memberState(m: Member): { words: string; tone: 'good' | 'warn' | undefined; canConfirm: boolean } {
  if (m.status === 'confirmed') return { words: 'active', tone: 'good', canConfirm: false }
  if (m.status === 'invited') return { words: 'invited, has not joined yet', tone: undefined, canConfirm: false }
  if (m.status === 'revoked') return { words: 'access removed', tone: undefined, canConfirm: false }
  if (!m.twoFactor) return { words: 'joined, setting up two-step login', tone: 'warn', canConfirm: false }
  return { words: 'joined, waiting for you to confirm', tone: 'warn', canConfirm: !!m.fingerprint }
}

/** The fingerprint as typed or pasted: lower case, any spacing; it must match exactly. */
export function sameFingerprint(typed: string, shown: string | null): boolean {
  const n = (s: string) => s.toLowerCase().replace(/[^0-9a-f]/g, '')
  return !!shown && n(typed).length === 32 && n(typed) === n(shown)
}

/** The token from a join link's fragment ("#<token>"), or null. */
export function joinToken(hash: string): string | null {
  const t = hash.replace(/^#/, '').trim()
  return /^[A-Za-z0-9_-]{43}$/.test(t) ? t : null
}

export const MIN_PASSWORD = 12
