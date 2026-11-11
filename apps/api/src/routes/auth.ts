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
import { getNotifyService } from '../lib/notify'
import { ensureGrafanaAdmin } from '../lib/grafana-admin'
import { migrationSettled } from '../lib/credentials'
import { requestContext } from '../lib/auth'
import { verifyHomeHostKeys } from '../lib/setup-checklist'
import { validateHandoff, holdValidated, flushHeldSecrets, acceptHandoff, HandoffRefused, markSetupDone } from '../lib/setup-handoff'
import { readFileSync } from 'fs'
import { createHash, timingSafeEqual } from 'crypto'

/** The setup key as .env holds it right now (it is removed once setup completes). */
function currentSetupKey(): string {
  try {
    const m = /^SETUP_SECRET=['"]?([^'"\n]*)/m.exec(readFileSync(process.env.ENV_FILE_PATH || '/opt/hyperprox/.env', 'utf8'))
    return m?.[1] ?? ''
  } catch { return '' }
}
function setupKeyMatches(given: unknown): boolean {
  const want = currentSetupKey()
  if (!want || typeof given !== 'string' || !given) return false
  return timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(want).digest())
}

/**
 * Creating the owner is a claim on the whole install, and the routes that do it are public (there is nobody to
 * sign in as yet). So until an owner exists they answer only to the setup key: the one the installer printed in
 * the setup link, still in .env until the owner's first sign-in removes it (markSetupDone). Null when the key
 * matches; otherwise the reply to send. Anyone who can read .env is root on this machine already.
 */
function setupKeyRefusal(reply: FastifyReply, given: unknown) {
  if (!currentSetupKey()) {
    return reply.status(403).send({
      ok: false, code: 'setup_key_missing',
      error: 'This install has no setup key, so the owner account cannot be created from the browser. On the HyperProx host run: ' +
        'echo "SETUP_SECRET=$(openssl rand -hex 32)" >> /opt/hyperprox/.env  then enter that value as the setup key.',
    })
  }
  if (!setupKeyMatches(given)) {
    return reply.status(401).send({
      ok: false, code: 'setup_key_required',
      error: 'Enter the setup key. It is in the setup link the installer printed (after k=), or on the host: grep SETUP_SECRET /opt/hyperprox/.env',
    })
  }
  return null
}

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
    try {
      await unlock(vs.sid)
    } catch (e) {
      // e.g. the keyholder is not running: stay locked, and leave no vault session behind.
      await getBroker().signOut(vs.sid).catch(() => undefined)
      throw e
    }
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
      // The old Updates/Certificates webhooks become notification channels (once), after the migration.
      void getNotifyService()?.seedOnOwnerUnlock()
      // An owner exists, so setup is done: record it and drop the setup key from .env.
      try { if (markSetupDone()) req.log.info('[setup] owner exists: setup recorded as done, setup key removed') } catch { /* .env not writable */ }
      // What the setup wizard held in memory for want of a vault (a node login, a DNS key) goes in now.
      // Then the home nodes' host keys are verified with evidence (no fingerprints to compare), as this owner, whose
      // sign-in unlocked the vault. Nothing happens when every node is already verified or confirmed.
      const owner = { sid: vs.sid, email: vs.email, role: vs.role }
      void flushHeldSecrets(owner).then(
        r => { if (r.stored.length || r.failed.length) req.log.info({ stored: r.stored, failed: r.failed }, '[setup] held secrets stored in the vault') },
        e => req.log.error({ err: e?.message }, '[setup] could not store the held secrets'))
        .then(() => requestContext.run(owner, async () => { await migrationSettled(); return verifyHomeHostKeys(`system: owner sign-in (vault session of ${vs.email})`, { onlyIfNeeded: true }) }))
        .then(v => { if (v?.length) req.log.info({ verified: v.filter(x => x.state === 'verified').length, other: v.filter(x => x.state !== 'verified' && x.state !== 'already').length }, '[hostkeys] home nodes checked after sign-in') },
          e => req.log.warn({ err: e?.message }, '[hostkeys] could not verify the home nodes after sign-in'))
    }
    if (wasLocked) hydrateEnvFromVault()

    // Grafana's admin password is the vault's, never a default left by a fresh database. After the
    // migration, which may be moving the old one out of .env.
    if (vs.role === 'owner' || vs.role === 'admin') {
      void requestContext.run({ sid: vs.sid, email: vs.email, role: vs.role }, async () => {
        await migrationSettled()
        return ensureGrafanaAdmin(undefined, vs.email)
      }).catch((e: any) => req.log.warn({ err: e?.message }, '[grafana] could not set the admin password from the vault'))
    }

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

  // GET /api/auth/check — nginx's auth_request for /grafana/ (config/nginx/conf.d/hyperprox-routes.inc).
  // 204 for a signed-in person while HyperProx is unlocked; 401 for anything else, locked included (nginx
  // passes only 2xx, 401 and 403 through, so locked cannot be the gate's usual 423). An API token gets 403
  // from the gate. Not rate limited: every Grafana asset and query asks, all of them from nginx's address.
  fastify.get('/check', { config: { rateLimit: false } }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    if (!isUnlocked() || !req.session || req.apiToken) return reply.status(401).send()
    return reply.status(204).send()
  })

  // POST /api/auth/setup-handoff — the setup wizard's node login and DNS key, held in memory until the
  // owner's first sign-in puts them in the vault. Loopback only, never through nginx, and only with the
  // setup key that is still in .env while setup is finishing.
  fastify.post('/setup-handoff', LIMIT, async (req, reply) => {
    if (!isLocalCliRequest(req.socket?.remoteAddress, req.headers as Record<string, any>)) {
      return reply.status(403).send({ ok: false, error: 'Only the setup wizard on this machine can hand over secrets' })
    }
    if (!setupKeyMatches(req.headers['x-setup-key'])) return reply.status(401).send({ ok: false, error: 'setup key required' })
    // Validated first: a body with nothing usable in it does not use up the one hand-over.
    const v = validateHandoff(req.body)
    if (!v) return reply.status(400).send({ ok: false, error: 'Nothing usable to hand over: a node login or a GoDaddy key is required.' })
    try { acceptHandoff(await vaultStatus()) }
    catch (e) { if (e instanceof HandoffRefused) return reply.status(e.status).send({ ok: false, error: e.message }); throw e }
    return { ok: true, held: holdValidated(v) }
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
    const refused = setupKeyRefusal(reply, req.headers['x-setup-key'])
    if (refused) return refused

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
    // The same setup key as the first step. While the key is still in .env the owner has never signed in, so it is
    // always asked for; with no key, only an install whose vault has no owner yet is refused (an owner that exists
    // goes on to the usual "sign in instead" answer below).
    if (currentSetupKey() || !(await vaultStatus()).bootstrapped) {
      const refused = setupKeyRefusal(reply, req.headers['x-setup-key'])
      if (refused) return refused
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

  // POST /api/auth/lock — wipe the unlock state (here and in the keyholder) and end every session.
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
