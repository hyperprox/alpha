// =============================================================================
//  HyperProx — invitation links (Settings → Users)
//
//  The vault sends no mail here, so an invitation is a link the admin copies and sends however they like.
//  The link carries a random 32-byte token in its #fragment (never sent to a server log or a Referer); only its
//  SHA-256 is stored, with the email and role it was made for, who made it and when it expires (72 hours).
//  The email is fixed by the invitation: whoever opens the link cannot choose another.
//
//  data/users/invitations.json, mode 0600. One use: the record is removed once the person has finished joining.
// =============================================================================

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { GrantableRole } from '../vault/members'

export const INVITE_TTL_MS = 72 * 3_600_000

export interface Invitation {
  /** sha256(token), hex. Also the record's id in lists. */
  hash: string
  email: string
  role: GrantableRole
  by: string
  createdAt: string
  expiresAt: string
  /** Step 1 of joining is done (the account exists); two-step login is next. */
  registeredAt?: string
}

const sha = (t: string) => crypto.createHash('sha256').update(t).digest('hex')
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

export function defaultInvitationsFile(): string {
  const root = process.env.HYPERPROX_DATA_DIR || path.resolve(__dirname, '..', '..', '..', '..', '..', 'data')
  return path.join(root, 'users', 'invitations.json')
}

export class InvitationStore {
  constructor(private file: string = defaultInvitationsFile(), private now: () => number = Date.now) {}

  private read(): Invitation[] {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      return Array.isArray(j) ? j : []
    } catch { return [] }
  }

  private write(list: Invitation[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }

  /** Pending invitations, expired ones dropped. Never the token (it is not kept). */
  list(): Invitation[] {
    const t = this.now()
    const all = this.read()
    const live = all.filter(i => Date.parse(i.expiresAt) > t)
    if (live.length !== all.length) this.write(live)
    return live
  }

  /** A new invitation. The token is returned once, for the link, and never stored. Replaces one for the same email. */
  create(email: string, role: GrantableRole, by: string): { token: string; invitation: Invitation } {
    const token = crypto.randomBytes(32).toString('base64url')
    const t = this.now()
    const invitation: Invitation = { hash: sha(token), email, role, by, createdAt: new Date(t).toISOString(), expiresAt: new Date(t + INVITE_TTL_MS).toISOString() }
    this.write([...this.list().filter(i => i.email !== email), invitation])
    return { token, invitation }
  }

  /** The invitation a token belongs to, if it is well formed, known and not expired. */
  find(token: unknown): Invitation | null {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null
    const h = sha(token)
    return this.list().find(i => crypto.timingSafeEqual(Buffer.from(i.hash, 'hex'), Buffer.from(h, 'hex'))) ?? null
  }

  markRegistered(hash: string): void {
    this.write(this.list().map(i => (i.hash === hash ? { ...i, registeredAt: new Date(this.now()).toISOString() } : i)))
  }

  remove(hash: string): boolean {
    const all = this.list()
    const left = all.filter(i => i.hash !== hash)
    if (left.length === all.length) return false
    this.write(left)
    return true
  }
}
