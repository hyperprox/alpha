// =============================================================================
//  HyperProx — Users (/api/users) and the join page's API (/api/auth/join)
//
//  Who can sign in is who is a member of the vault's HyperProx organization (lib/vault/members.ts). The vault
//  listens on loopback only and this install sends no mail, so people are invited from here with a one-time
//  link, join on HyperProx's own page, and are confirmed by an admin after comparing a key fingerprint.
//
//    GET  /api/users                 admin: the members, their roles and status, and pending invitations
//    POST /api/users/invite          admin + master password re-entered (roles.ts); an admin role needs the owner
//    POST /api/users/:id/confirm     admin + re-entered; the fingerprint the admin compared must still match
//    PUT  /api/users/:id/role        owner + re-entered: role changes are role management
//    DELETE /api/users/invitations/:hash   admin + re-entered: withdraw a link that was not used
//
//    POST /api/auth/join/check       public: what an invitation link is for (its email and role), nothing else
//    POST /api/auth/join/register    public, with the link: the master password; the account is made in the vault
//    POST /api/auth/join/totp        public, with the link: the first two-step code; the link is used up
//
//  Every change is audited before it is made (no audit row, no change). API tokens cannot manage people.
// =============================================================================

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { hasRole, type Role } from '../lib/roles'
import { getBroker, VaultAuthError, BootstrapNotPendingError, type VaultBroker } from '../lib/vault/broker'
import { isGrantable, VAULT_ID, type GrantableRole } from '../lib/vault/members'
import { InvitationStore } from '../lib/users/invitations'
import { auditOrThrow, auditCredentialUse } from '../lib/audit'

export interface UserRouteDeps {
  broker?(): VaultBroker
  invitations?: InvitationStore
  audit?(action: string, resource: string, details?: Record<string, unknown>): Promise<void>
}

const isToken = (req: FastifyRequest) => !!(req as any).apiToken || String(req.session?.sid ?? '').startsWith('token:')
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/** The page's own address for the link: the Host the browser used, as nginx passes it on. */
function origin(req: FastifyRequest): string {
  const fwd = String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim()
  const host = /^[a-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-f:.]+\](:\d{1,5})?$/i.test(fwd) ? fwd
    : /^[a-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-f:.]+\](:\d{1,5})?$/i.test(String(req.headers.host ?? '')) ? String(req.headers.host) : 'localhost'
  const proto = req.headers['x-forwarded-proto'] === 'http' ? 'http' : 'https'
  return `${proto}://${host}`
}

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
    const unsupported = (reply: FastifyReply) => reply.status(501).send({ ok: false, error: 'This vault connection cannot manage people.' })
    const failed = (reply: FastifyReply, e: any) => reply.status(502).send({ ok: false, error: e?.message ?? 'The vault refused it' })
    const audited = async (reply: FastifyReply, action: string, resource: string, details: Record<string, unknown>) => {
      try { await audit(action, resource, details); return true }
      catch { reply.status(503).send({ ok: false, error: 'The audit log could not be written, so nothing was changed. Try again.' }); return false }
    }

    fastify.get('/', { preHandler: needs('admin') }, async (req, reply) => {
      const b = broker()
      if (!b.members) return unsupported(reply)
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
      // Making someone an admin is handing out role management's next rung: the owner's call.
      if (role === 'admin' && !hasRole(req.session!.role, 'owner')) return reply.status(403).send({ ok: false, code: 'forbidden', error: 'Only the owner can invite an admin.', required: 'owner' })
      const b = broker()
      if (!b.inviteMember) return unsupported(reply)
      if (!(await audited(reply, 'users.invite', `user:${email}`, { by: req.session!.email, role }))) return
      try { await b.inviteMember(req.session!.sid, email, role) } catch (e) { return failed(reply, e) }
      const { token, invitation } = store.create(email, role, req.session!.email)
      // The token rides in the fragment: browsers never send it to a server or in a Referer.
      return { ok: true, data: { email, role, link: `${origin(req)}/join#${token}`, expiresAt: invitation.expiresAt } }
    })

    fastify.post<{ Params: { id: string }; Body: { fingerprint?: unknown } }>('/:id/confirm', { preHandler: needs('admin') }, async (req, reply) => {
      const id = req.params.id
      const fp = typeof req.body?.fingerprint === 'string' ? req.body.fingerprint.trim().toLowerCase() : ''
      if (!VAULT_ID.test(id)) return reply.status(404).send({ ok: false, error: 'No such member' })
      if (!/^[0-9a-f]{4}(-[0-9a-f]{4}){7}$/.test(fp)) return reply.status(400).send({ ok: false, error: 'Compare the key fingerprint with the one the person was shown, then confirm it.' })
      const b = broker()
      if (!b.confirmMember) return unsupported(reply)
      if (!(await audited(reply, 'users.confirm', `member:${id}`, { by: req.session!.email, fingerprint: fp }))) return
      try { await b.confirmMember(req.session!.sid, id, fp) } catch (e) { return failed(reply, e) }
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
      if (!/^[0-9a-f]{64}$/.test(h)) return reply.status(404).send({ ok: false, error: 'No such invitation' })
      if (!(await audited(reply, 'users.invite.withdraw', `invitation:${h.slice(0, 12)}`, { by: req.session!.email }))) return
      if (!store.remove(h)) return reply.status(404).send({ ok: false, error: 'No such invitation (it may have been used or expired)' })
      return { ok: true }
    })
  }
}

/** The join page's three calls. Public: the invitation link is the credential, and it fixes the email. */
export function buildJoinRoutes(deps: UserRouteDeps = {}): FastifyPluginAsync {
  const broker = deps.broker ?? getBroker
  const store = deps.invitations ?? new InvitationStore()
  const audit = deps.audit ?? auditCredentialUse
  const GONE = { ok: false, code: 'invitation_invalid', error: 'This invitation link is not valid. It may have expired or been used. Ask for a new one.' }

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
      try {
        // Registered before (HyperProx restarted between the steps): the same password starts two-step login again.
        const r = await b.registerInvitee(inv.email, password, { alreadyRegistered: !!inv.registeredAt })
        store.markRegistered(inv.hash)
        await audit('users.join.register', `user:${inv.email}`, { role: inv.role })
        return { ok: true, data: { email: inv.email, otpauthUri: r.otpauthUri, fingerprint: r.fingerprint } }
      } catch (e: any) {
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
      try {
        await b.confirmInviteeTotp(inv.email, password, code)
      } catch (e: any) {
        if (e instanceof VaultAuthError) return reply.status(400).send({ ok: false, code: e.code, error: e.code === 'totp_invalid' ? 'That code did not match. Use the newest code from the app.' : 'The master password did not match.' })
        if (e instanceof BootstrapNotPendingError) return reply.status(409).send({ ok: false, code: 'restart_join', error: 'HyperProx restarted in between. Enter your master password again to get a new code.' })
        return reply.status(502).send({ ok: false, error: e?.message ?? 'The vault refused it' })
      }
      store.remove(inv.hash)
      await audit('users.join.done', `user:${inv.email}`, { role: inv.role })
      return { ok: true, data: { email: inv.email, done: true } }
    })
  }
}

export const userRoutes: FastifyPluginAsync = buildUserRoutes()
export const joinRoutes: FastifyPluginAsync = buildJoinRoutes()
