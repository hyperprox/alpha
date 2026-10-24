// =============================================================================
//  HyperProx — Authentication Routes (vault gate)
//  HyperProx has no password of its own. Signing in is signing in to the
//  built-in vault (email, master password, 2FA code); the first sign-in after a
//  start or a lock unlocks HyperProx.
// =============================================================================

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { getBroker, setVaultLogger, VaultAuthError, VaultSessionError, BootstrapNotPendingError, type VaultSession } from '../lib/vault/broker'
import { isUnlocked, unlock, lock, touch } from '../lib/vault/state'
import {
  addSession, removeSession, markReconfirmed, buildAuthCookie, isLocalCliRequest,
  SESSION_SECONDS,
} from '../lib/auth'
import { hasRole } from '../lib/roles'
import { startMigration, migrationStatus, hydrateEnvFromVault } from '../lib/credentials'

const LIMIT = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }
const MIN_MASTER_PASSWORD = 12

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function authErrorReply(reply: FastifyReply, e: unknown) {
  if (e instanceof VaultAuthError) {
    const status = e.code === 'locked_out' ? 429 : e.code === 'not_member' ? 403 : 401
    const message: Record<VaultAuthError['code'], string> = {
      bad_credentials: 'Email or master password is incorrect',
      totp_required:   'Enter the 6-digit code from your authenticator app',
      totp_invalid:    'That 2FA code is not valid — wait for the next one and try again',
      not_member:      'This vault account is not a member of the HyperProx organization',
      locked_out:      'Too many attempts — the vault has locked this account for a while',
    }
    return reply.status(status).send({ ok: false, code: e.code, error: message[e.code] })
  }
  throw e
}

async function vaultStatus(): Promise<{ reachable: boolean; bootstrapped: boolean }> {
  try { return await getBroker().status() }
  catch { return { reachable: false, bootstrapped: false } }
}

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  // Which sign-in path ran (fast or CLI), how long it took, and why it fell back.
  setVaultLogger({ info: m => fastify.log.info(m), warn: m => fastify.log.warn(m) })

  /** Register the vault session, unlock if locked, migrate on an Owner's unlock, issue the cookie. */
  async function startSession(req: FastifyRequest, reply: FastifyReply, vs: VaultSession) {
    // unlock() is idempotent and shares one in-flight unlock, so concurrent sign-ins keep one key.
    const wasLocked = !isUnlocked()
    await unlock(vs.sid)
    addSession(vs)
    touch()

    // The first Owner unlock moves the old credential store into the vault. That is one vault write per
    // item and can take a minute, so it runs in the background: the sign-in waits only until the old
    // values are served from memory. Progress: GET /api/auth/status → migration.
    let migration: { ok: boolean; running?: boolean; error?: string } | undefined
    if (vs.role === 'owner') {
      const m = await startMigration(vs.sid, (msg, err) => req.log.error({ err }, msg))
      if (m.error) migration = { ok: false, error: m.error }
      else if (m.started) migration = { ok: true, running: true }
    }
    if (wasLocked) hydrateEnvFromVault()

    const token = await reply.jwtSign(
      { sid: vs.sid, email: vs.email, role: vs.role },
      { expiresIn: `${SESSION_SECONDS}s` } as any,
    )
    reply.header('Set-Cookie', buildAuthCookie(token, SESSION_SECONDS, req.headers))
    return { ok: true, user: { email: vs.email, role: vs.role }, expiresIn: SESSION_SECONDS, ...(migration ? { migration } : {}) }
  }

  // GET /api/auth/status — always answers, locked or not
  fastify.get('/status', async (req) => {
    const s = await vaultStatus()
    return {
      ok: true,
      locked:       !isUnlocked(),
      bootstrapped: s.bootstrapped,
      reachable:    s.reachable,
      ...(req.session ? { user: { email: req.session.email, role: req.session.role } } : {}),
      ...(req.session && hasRole(req.session.role, 'admin') && migrationStatus().state !== 'idle' ? { migration: migrationStatus() } : {}),
    }
  })

  // POST /api/auth/bootstrap — create the Owner account (only before the vault has a HyperProx org)
  fastify.post<{ Body: { email?: string; password?: string } }>('/bootstrap', LIMIT, async (req, reply) => {
    const email = str(req.body?.email).trim().toLowerCase()
    const password = str(req.body?.password)
    if (!email || !email.includes('@')) return reply.status(400).send({ ok: false, error: 'A valid email is required' })
    if (password.length < MIN_MASTER_PASSWORD) {
      return reply.status(400).send({ ok: false, error: `The master password must be at least ${MIN_MASTER_PASSWORD} characters` })
    }

    const s = await vaultStatus()
    if (!s.reachable) return reply.status(503).send({ ok: false, error: 'The built-in vault is not reachable' })
    if (s.bootstrapped) return reply.status(409).send({ ok: false, error: 'The owner account already exists — sign in instead' })

    try {
      const { otpauthUri } = await getBroker().bootstrapOwner(email, password)
      return { ok: true, otpauthUri }
    } catch (e) {
      return authErrorReply(reply, e)
    }
  })

  // POST /api/auth/bootstrap/confirm — verify the first TOTP code, then sign the Owner in
  fastify.post<{ Body: { email?: string; password?: string; code?: string } }>('/bootstrap/confirm', LIMIT, async (req, reply) => {
    const email = str(req.body?.email).trim().toLowerCase()
    const password = str(req.body?.password)
    const code = str(req.body?.code).replace(/\s+/g, '')
    if (!email || !password || !/^\d{6}$/.test(code)) {
      return reply.status(400).send({ ok: false, error: 'email, password and a 6-digit code are required' })
    }

    // The broker signs the Owner in itself (the vault will not accept the same TOTP step twice).
    let vs: VaultSession
    try {
      vs = await getBroker().confirmOwnerTotp(email, password, code)
    } catch (e) {
      // The pending step lives in memory: after a restart (or a second click once it finished) the owner
      // account exists, 2FA may already be on, and the right next step is an ordinary sign-in.
      if (e instanceof BootstrapNotPendingError) {
        const s = await vaultStatus()
        return reply.status(409).send(s.bootstrapped
          ? { ok: false, code: 'sign_in', error: 'The owner account already exists. Sign in with your email, master password and 2FA code.' }
          : { ok: false, code: 'restart_setup', error: 'Setup was interrupted. Start again.' })
      }
      return authErrorReply(reply, e)
    }
    return startSession(req, reply, vs)
  })

  // POST /api/auth/sign-in — vault login; unlocks HyperProx if it is locked
  fastify.post<{ Body: { email?: string; password?: string; code?: string } }>('/sign-in', LIMIT, async (req, reply) => {
    const email = str(req.body?.email).trim().toLowerCase()
    const password = str(req.body?.password)
    const code = str(req.body?.code).replace(/\s+/g, '')
    if (!email || !password) return reply.status(400).send({ ok: false, error: 'email and password are required' })

    let vs: VaultSession
    try {
      vs = await getBroker().signIn(email, password, code)
    } catch (e) {
      return authErrorReply(reply, e)
    }
    return startSession(req, reply, vs)
  })

  // POST /api/auth/sign-out — end this session (HyperProx stays unlocked for others until idle)
  fastify.post('/sign-out', async (req, reply) => {
    const s = req.session
    reply.header('Set-Cookie', buildAuthCookie('', 0, req.headers))
    if (s) {
      removeSession(s.sid)
      try { await getBroker().signOut(s.sid) } catch (e: any) { req.log.warn({ err: e?.message }, '[auth] vault sign-out failed') }
    }
    return { ok: true }
  })

  // POST /api/auth/lock — wipe the unlock state and end every session.
  // Owner/admin session, or `hyperprox lock` from the host itself (loopback, no cookie, not proxied).
  // 200 when it locked; 423 when HyperProx was already locked.
  fastify.post('/lock', async (req, reply) => {
    reply.header('Set-Cookie', buildAuthCookie('', 0, req.headers))
    if (!isUnlocked()) return reply.status(423).send({ ok: false, locked: true, error: 'HyperProx is already locked' })
    const viaCli = isLocalCliRequest(req.socket?.remoteAddress, req.headers as Record<string, any>)
    if (!viaCli) {
      if (!req.session) return reply.status(401).send({ ok: false, code: 'unauthenticated', error: 'Authentication required' })
      if (!hasRole(req.session.role, 'admin')) return reply.status(403).send({ ok: false, code: 'forbidden', error: 'This needs the admin role' })
    }
    await lock('manual')
    req.log.info({ by: viaCli ? 'local cli' : req.session?.email }, '[auth] locked')
    return { ok: true, locked: true }
  })

  // POST /api/auth/reconfirm — master password again; valid for 5 minutes for this session
  fastify.post<{ Body: { password?: string } }>('/reconfirm', LIMIT, async (req, reply) => {
    if (!isUnlocked()) return reply.status(423).send({ ok: false, locked: true })
    const s = req.session
    if (!s) return reply.status(401).send({ ok: false, error: 'Authentication required' })
    const password = str(req.body?.password)
    if (!password) return reply.status(400).send({ ok: false, error: 'password is required' })

    let ok = false
    try {
      ok = await getBroker().verifyPassword(s.sid, password)
    } catch (e) {
      if (e instanceof VaultSessionError) throw e   // → 401 session_expired (gate error handler)
      ok = false
    }
    if (!ok) return reply.status(401).send({ ok: false, error: 'Master password is incorrect' })

    const until = markReconfirmed(s.sid)
    return { ok: true, until: new Date(until).toISOString() }
  })
}
