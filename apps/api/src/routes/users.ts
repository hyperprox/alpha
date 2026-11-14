// =============================================================================
//  HyperProx — Users (/api/users) and the join page's API (/api/auth/join)
//
//  Who can sign in is who is a member of the vault's HyperProx organization (lib/vault/members.ts). The vault
//  listens on loopback only and this install sends no mail, so people are invited from here with a one-time
//  link, join on HyperProx's own page, and are confirmed by an admin after comparing a key fingerprint.
//
//    GET  /api/users                 admin: the members, their roles and status, and pending invitations
//    POST /api/users/invite          admin + master password re-entered (roles.ts); an operator or admin needs the owner
//    POST /api/users/:id/confirm     admin + re-entered; the fingerprint the admin compared must still match;
//                                    confirming an operator or admin needs the owner
//    PUT  /api/users/:id/role        owner + re-entered: role changes are role management
//    DELETE /api/users/invitations/:hash   admin + re-entered: withdraw a link that was not used, and take the
//                                    invited membership back out of the vault (an operator's or admin's: owner)
//
//  "Needs the owner" is the vault's rule, not only ours: Vaultwarden lets only the organization's Owner invite,
//  confirm or remove a Manager or Admin (operator, admin here). Should it refuse anyway, the answer is a 403 that
//  says so, and the refusal gets its own audit row.
//
//  Expired invitations: the next time an admin opens the list, their memberships are removed from the vault too.
//
//    POST /api/auth/join/check       public: what an invitation link is for (its email and role), nothing else
//    POST /api/auth/join/register    public, with the link: the master password; the account is made in the vault
//    POST /api/auth/join/totp        public, with the link: the first two-step code; the link is used up
//
//  Every change is audited before it is made (no audit row, no change), the join page's calls included.
//  API tokens cannot manage people.
// =============================================================================

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { hasRole, type Role } from '../lib/roles'
import { getBroker, VaultAuthError, BootstrapNotPendingError, type VaultBroker } from '../lib/vault/broker'
import { isGrantable, needsVaultOwner, VaultOwnerOnlyError, VAULT_ID, type GrantableRole } from '../lib/vault/members'
import { InvitationStore } from '../lib/users/invitations'
import { auditOrThrow } from '../lib/audit'
import { requestHost } from '../lib/gate'

export interface UserRouteDeps {
  broker?(): VaultBroker
  invitations?: InvitationStore
  audit?(action: string, resource: string, details?: Record<string, unknown>): Promise<void>
}

const isToken = (req: FastifyRequest) => !!(req as any).apiToken || String(req.session?.sid ?? '').startsWith('token:')
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-f:.]+\](:\d{1,5})?$/i
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * The page's own address for the link: the host the browser asked for. The same rule as the gate's requestHost
 * (lib/gate.ts): X-Forwarded-Host counts only from nginx or Next's proxy on this machine (loopback), which set it
 * themselves; from anywhere else only Host does, so a client cannot point the link at a host of its choosing.
 */
export function inviteOrigin(req: FastifyRequest): string {
  const local = LOOPBACK.has(req.socket?.remoteAddress ?? '')
  const raw = requestHost(req)   // the gate's own rule, shared
  const host = HOST_RE.test(raw) ? raw : 'localhost'
  const proto = local && req.headers['x-forwarded-proto'] === 'http' ? 'http' : 'https'
  return `${proto}://${host}`
}

const OWNER_ONLY = 'Only the owner can add, confirm or remove an operator or admin: the vault lets only its owner manage people who manage others.'

export function buildUserRoutes(deps: UserRouteDeps = {}): FastifyPluginAsync {
  const broker = deps.broker ?? getBroker
  const store = deps.invitations ?? new InvitationStore()
  const audit = deps.audit ?? auditOrThrow

  return async (fastify) => {
    const needs = (role: Role) => async (req: FastifyRequest, reply: FastifyReply) => {
      const s = req.session
      if (!s) return reply.status(401).send({ ok: false, code: 'unauthenticated', error: 'Authentication required' })
      if (isToken(req)) return reply.status(403).send({ ok: false, code: 'token_refused', error: 'An API token cannot manage people. Sign in to do this.' })
      if (!hasRole(s.role, role)) return reply.status(403).send({ ok: false, code: 'forbidden', error: `This needs the ${role} role`, required: role })
    }
    const isOwner = (req: FastifyRequest) => hasRole(req.session!.role, 'owner')
    const ownerRequired = (reply: FastifyReply) => reply.status(403).send({ ok: false, code: 'forbidden', error: OWNER_ONLY, required: 'owner' })
    const unsupported = (reply: FastifyReply) => reply.status(501).send({ ok: false, error: 'This vault connection cannot manage people.' })
    const audited = async (reply: FastifyReply, action: string, resource: string, details: Record<string, unknown>) => {
      try { await audit(action, resource, details); return true }
      catch { reply.status(503).send({ ok: false, error: 'The audit log could not be written, so nothing was changed. Try again.' }); return false }
    }
    /** A vault error as the answer. The vault's owner-only refusal is a 403 in plain words, with its own audit row. */
    const failed = async (reply: FastifyReply, e: any, refused?: { action: string; resource: string; details: Record<string, unknown> }) => {
      if (e instanceof VaultOwnerOnlyError) {
        if (refused) await audit(`${refused.action}.refused`, refused.resource, { ...refused.details, refused: 'vault: owner only' }).catch(() => undefined)
        return reply.status(403).send({ ok: false, code: 'vault_owner_only', error: OWNER_ONLY, required: 'owner' })
      }
      return reply.status(502).send({ ok: false, error: e?.message ?? 'The vault refused it' })
    }

    fastify.get('/', { preHandler: needs('admin') }, async (req, reply) => {
      const b = broker()
      if (!b.members) return unsupported(reply)
      // Expired invitations: their memberships come out of the vault now. An operator's or admin's waits for the
      // owner (the vault would refuse anyone else); one that fails stays for the next visit.
      if (b.removePendingMember) {
        for (const i of store.expired()) {
          if (needsVaultOwner(i.role) && !isOwner(req)) continue
          try { await audit('users.invite.expired', `user:${i.email}`, { by: req.session!.email, role: i.role }) } catch { continue }
          try { await b.removePendingMember(req.session!.sid, i.email); store.remove(i.hash) } catch { /* next visit */ }
        }
      }
      try {
        const members = await b.members(req.session!.sid)
        const invitations = store.list().map(i => ({ id: i.hash, email: i.email, role: i.role, by: i.by, expiresAt: i.expiresAt, joined: !!i.registeredAt }))
        return { ok: true, data: { members, invitations, mail: false } }
      } catch (e) { return failed(reply, e) }
    })

    fastify.post<{ Body: { email?: unknown; role?: unknown } }>('/invite', { preHandler: needs('admin') }, async (req, reply) => {
      const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
      const role = req.body?.role
      if (!EMAIL.test(email) || email.length > 254) return reply.status(400).send({ ok: false, error: 'A valid email address is required.' })
      if (!isGrantable(role)) return reply.status(400).send({ ok: false, error: 'The role is admin, operator or viewer.' })
      // Anyone who is not a viewer is a Manager or Admin in the vault, which only its owner may invite.
      if (needsVaultOwner(role) && !isOwner(req)) return ownerRequired(reply)
      const b = broker()
      if (!b.inviteMember) return unsupported(reply)
      const details = { by: req.session!.email, role }
      if (!(await audited(reply, 'users.invite', `user:${email}`, details))) return
      let reused = false
      try { reused = !!(await b.inviteMember(req.session!.sid, email, role))?.reused }
      catch (e) { return failed(reply, e, { action: 'users.invite', resource: `user:${email}`, details }) }
      const { token, invitation } = store.create(email, role, req.session!.email)
      // The token rides in the fragment: browsers never send it to a server or in a Referer.
      return { ok: true, data: { email, role, link: `${inviteOrigin(req)}/join#${token}`, expiresAt: invitation.expiresAt, reused } }
    })

    fastify.post<{ Params: { id: string }; Body: { fingerprint?: unknown } }>('/:id/confirm', { preHandler: needs('admin') }, async (req, reply) => {
      const id = req.params.id
      const fp = typeof req.body?.fingerprint === 'string' ? req.body.fingerprint.trim().toLowerCase() : ''
      if (!VAULT_ID.test(id)) return reply.status(404).send({ ok: false, error: 'No such member' })
      if (!/^[0-9a-f]{4}(-[0-9a-f]{4}){7}$/.test(fp)) return reply.status(400).send({ ok: false, error: 'Compare the key fingerprint with the one the person was shown, then confirm it.' })
      const b = broker()
      if (!b.confirmMember) return unsupported(reply)
      // Confirming an operator or admin is the owner's, as inviting one is (the vault's rule).
      if (!isOwner(req) && b.members) {
        let member
        try { member = (await b.members(req.session!.sid)).find(m => m.id === id) } catch (e) { return failed(reply, e) }
        if (!member) return reply.status(404).send({ ok: false, error: 'No such member' })
        if (needsVaultOwner(member.role)) return ownerRequired(reply)
      }
      const details = { by: req.session!.email, fingerprint: fp }
      if (!(await audited(reply, 'users.confirm', `member:${id}`, details))) return
      try { await b.confirmMember(req.session!.sid, id, fp) }
      catch (e) { return failed(reply, e, { action: 'users.confirm', resource: `member:${id}`, details }) }
      return { ok: true, data: { id, confirmed: true } }
    })

    fastify.put<{ Params: { id: string }; Body: { role?: unknown } }>('/:id/role', { preHandler: needs('owner') }, async (req, reply) => {
      const id = req.params.id
      const role = req.body?.role
      if (!VAULT_ID.test(id)) return reply.status(404).send({ ok: false, error: 'No such member' })
      if (!isGrantable(role)) return reply.status(400).send({ ok: false, error: 'The role is admin, operator or viewer.' })
      const b = broker()
      if (!b.setMemberRole) return unsupported(reply)
      if (!(await audited(reply, 'users.role', `member:${id}`, { by: req.session!.email, role }))) return
      try { await b.setMemberRole(req.session!.sid, id, role as GrantableRole) } catch (e) { return failed(reply, e) }
      return { ok: true, data: { id, role } }
    })

    fastify.delete<{ Params: { hash: string } }>('/invitations/:hash', { preHandler: needs('admin') }, async (req, reply) => {
      const h = req.params.hash
      const inv = /^[0-9a-f]{64}$/.test(h) ? store.get(h) : null
      if (!inv) return reply.status(404).send({ ok: false, error: 'No such invitation (it may have been used or expired)' })
      if (needsVaultOwner(inv.role) && !isOwner(req)) return ownerRequired(reply)
      const b = broker()
      if (!b.removePendingMember) return unsupported(reply)
      const details = { by: req.session!.email, email: inv.email, role: inv.role }
      if (!(await audited(reply, 'users.invite.withdraw', `invitation:${h.slice(0, 12)}`, details))) return
      // The vault's invited membership goes too; until it has, the link stays (and can be withdrawn again).
      try { await b.removePendingMember(req.session!.sid, inv.email) }
      catch (e) { return failed(reply, e, { action: 'users.invite.withdraw', resource: `invitation:${h.slice(0, 12)}`, details }) }
      store.remove(h)
      return { ok: true }
    })
  }
}

/** The join page's three calls. Public: the invitation link is the credential, and it fixes the email. */
export function buildJoinRoutes(deps: UserRouteDeps = {}): FastifyPluginAsync {
  const broker = deps.broker ?? getBroker
  const store = deps.invitations ?? new InvitationStore()
  // auditOrThrow, not auditCredentialUse (which swallows a failure): no audit row, no step.
  const audit = deps.audit ?? auditOrThrow
  const GONE = { ok: false, code: 'invitation_invalid', error: 'This invitation link is not valid. It may have expired or been used. Ask for a new one.' }
  const audited = async (reply: FastifyReply, action: string, resource: string, details: Record<string, unknown>) => {
    try { await audit(action, resource, details); return true }
    catch { reply.status(503).send({ ok: false, error: 'HyperProx could not record this step, so nothing was done. Try again in a moment.' }); return false }
  }

  return async (fastify) => {
    fastify.post<{ Body: { token?: unknown } }>('/check', async (req, reply) => {
      const inv = store.find(req.body?.token)
      if (!inv) return reply.status(404).send(GONE)
      return { ok: true, data: { email: inv.email, role: inv.role, expiresAt: inv.expiresAt, step: inv.registeredAt ? 'totp' : 'password' } }
    })

    fastify.post<{ Body: { token?: unknown; password?: unknown } }>('/register', async (req, reply) => {
      const inv = store.find(req.body?.token)
      if (!inv) return reply.status(404).send(GONE)
      const password = typeof req.body?.password === 'string' ? req.body.password : ''
      if (password.length < 12) return reply.status(400).send({ ok: false, error: 'The master password must be at least 12 characters.' })
      const b = broker()
      if (!b.registerInvitee) return reply.status(501).send({ ok: false, error: 'This vault connection cannot add people.' })
      if (!(await audited(reply, 'users.join.register', `user:${inv.email}`, { role: inv.role, again: !!inv.registeredAt }))) return
      try {
        // Registered before (HyperProx restarted, or the sign-in after registering failed): the same password
        // starts two-step login again. The record is marked as soon as the account exists, not after the sign-in.
        const r = await b.registerInvitee(inv.email, password, {
          alreadyRegistered: !!inv.registeredAt,
          onRegistered: () => { if (!inv.registeredAt) store.markRegistered(inv.hash) },
        })
        return { ok: true, data: { email: inv.email, otpauthUri: r.otpauthUri, fingerprint: r.fingerprint } }
      } catch (e: any) {
        if (e instanceof VaultAuthError && e.code === 'bad_credentials') return reply.status(400).send({ ok: false, code: e.code, error: 'The master password did not match the one chosen for this account.' })
        if (e instanceof VaultAuthError && e.code === 'locked_out') return reply.status(429).send({ ok: false, code: e.code, error: 'Too many tries. Wait a few minutes, then try again.' })
        return reply.status(502).send({ ok: false, error: e?.message ?? 'The vault refused the new account' })
      }
    })

    fastify.post<{ Body: { token?: unknown; password?: unknown; code?: unknown } }>('/totp', async (req, reply) => {
      const inv = store.find(req.body?.token)
      if (!inv) return reply.status(404).send(GONE)
      const password = typeof req.body?.password === 'string' ? req.body.password : ''
      const code = typeof req.body?.code === 'string' ? req.body.code.trim() : ''
      const b = broker()
      if (!b.confirmInviteeTotp) return reply.status(501).send({ ok: false, error: 'This vault connection cannot add people.' })
      if (!(await audited(reply, 'users.join.totp', `user:${inv.email}`, { role: inv.role }))) return
      try {
        await b.confirmInviteeTotp(inv.email, password, code)
      } catch (e: any) {
        if (e instanceof VaultAuthError) return reply.status(400).send({ ok: false, code: e.code, error: e.code === 'totp_invalid' ? 'That code did not match. Use the newest code from the app.' : 'The master password did not match.' })
        if (e instanceof BootstrapNotPendingError) return reply.status(409).send({ ok: false, code: 'restart_join', error: 'HyperProx restarted in between. Enter your master password again to get a new code.' })
        return reply.status(502).send({ ok: false, error: e?.message ?? 'The vault refused it' })
      }
      store.remove(inv.hash)
      return { ok: true, data: { email: inv.email, done: true } }
    })
  }
}

export const userRoutes: FastifyPluginAsync = buildUserRoutes()
export const joinRoutes: FastifyPluginAsync = buildJoinRoutes()
