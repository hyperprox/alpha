// =============================================================================
//  HyperProx — Vault gate
//  Every request passes through here, in this order:
//    1. Locked?           423 { ok:false, locked:true }  (except /health*, /api/auth/*)
//    2. Session?          401 when missing, forged, expired or from before a lock
//    3. Role?             403 when the user's vault role is below the route's
//    4. Re-confirmed?     403 { reconfirm:true } for destroy / reveal / role changes
//  The JWT is signed with a key that exists only while unlocked and is replaced
//  at every unlock, so a token from a previous unlock can never verify again.
// =============================================================================

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import jwt from '@fastify/jwt'
import { isUnlocked, signingKey, touch, onLock } from './vault/state'
import { VaultSessionError, type Role } from './vault/broker'
import { requiredRole, needsReconfirm, hasRole, bypassesLock, normalisePath } from './roles'
import {
  extractToken, getSession, clearSessions, removeSession, requestContext, isReconfirmed, isLocalCliRequest,
  buildAuthCookie, type ActiveSession,
} from './auth'

export interface SessionClaims { sid: string; email: string; role: Role }

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in vault session, when the request carried a valid one. */
    session?: ActiveSession
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: SessionClaims
    user:    SessionClaims
  }
}

export class GateLockedError extends Error {
  constructor() { super('HyperProx is locked'); this.name = 'GateLockedError' }
}

let lockHookInstalled = false

/** Verify the request's token against the current signing key. Null when absent or invalid. */
async function authenticate(req: FastifyRequest): Promise<ActiveSession | null> {
  if (!extractToken(req.headers as Record<string, any>)) return null
  try {
    const claims = await req.jwtVerify<SessionClaims>({ algorithms: ['HS256'] } as any)
    const session = getSession(claims.sid)
    if (!session || session.email !== claims.email) return null
    return session
  } catch {
    return null
  }
}

/**
 * Register @fastify/jwt (keyed to the unlock state) and the gate hooks.
 * Call before registering any route.
 */
export async function registerGate(server: FastifyInstance): Promise<void> {
  await server.register(jwt, {
    // Read at every sign and verify: null while locked, a fresh key per unlock.
    secret: async () => {
      const key = signingKey()
      if (!key) throw new GateLockedError()
      return key
    },
    sign:   { algorithm: 'HS256' },
    verify: { extractToken: (req: FastifyRequest) => extractToken(req.headers as Record<string, any>) ?? undefined } as any,
  })

  if (!lockHookInstalled) {
    lockHookInstalled = true
    onLock(() => clearSessions())
  }

  server.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.method === 'OPTIONS') return

    const path   = normalisePath(req.url)
    const needed = requiredRole(req.method, path)

    if (!isUnlocked()) {
      if (bypassesLock(path)) return
      return reply.status(423).send({ ok: false, locked: true })
    }

    const session = await authenticate(req)
    if (session) {
      req.session = session
      session.lastSeen = Date.now()
      touch()
    }

    if (needed === null) return
    // `hyperprox lock` on the host has no session; a truly local request may lock and do nothing else.
    if (path === '/api/auth/lock' && req.method === 'POST' && isLocalCliRequest(req.socket?.remoteAddress, req.headers as Record<string, any>)) return

    if (!session) {
      return reply.status(401).send({ ok: false, code: 'unauthenticated', error: 'Authentication required' })
    }
    if (!hasRole(session.role, needed)) {
      return reply.status(403).send({ ok: false, code: 'forbidden', error: `This needs the ${needed} role`, required: needed, role: session.role })
    }
    if (needsReconfirm(req.method, path) && !isReconfirmed(session.sid)) {
      return reply.status(403).send({ ok: false, code: 'reconfirm_required', error: 'Re-enter your master password to continue' })
    }
  })

  // A vault session that the vault no longer knows (signed out elsewhere, expired) is a 401; a
  // credential read that raced a lock is a 423. Everything else keeps Fastify's default handling.
  server.setErrorHandler((err, req, reply) => {
    if (err instanceof VaultSessionError) {
      if (req.session) removeSession(req.session.sid)
      reply.header('Set-Cookie', buildAuthCookie('', 0))
      return reply.status(401).send({ ok: false, code: 'session_expired', error: 'Your vault session has ended — sign in again' })
    }
    if ((err as Error)?.name === 'VaultLockedError') return reply.status(423).send({ ok: false, locked: true })
    reply.send(err)
  })

  // Run the rest of the request inside the caller's context, so the credential
  // store can write to the vault as this user. Callback style on purpose: the
  // context set here must wrap the handler, which an async hook cannot do.
  server.addHook('onRequest', (req, _reply, done) => {
    const s = req.session
    if (!s) return done()
    requestContext.run({ sid: s.sid, email: s.email, role: s.role }, done)
  })
}
