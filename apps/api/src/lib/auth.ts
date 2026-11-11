// =============================================================================
//  HyperProx — Sessions
//  HyperProx has no password of its own: a session is a vault sign-in. This
//  module keeps the signed-in sessions (in memory only — a restart or a lock
//  ends them all), the per-request context that tells the credential store whose
//  vault session to write with, and the cookie helpers.
// =============================================================================

import { AsyncLocalStorage } from 'async_hooks'
import type { Role } from './vault/broker'
import { registerSnapshotPart, snapshotChanged } from './vault/snapshot'

export const SESSION_SECONDS   = 12 * 60 * 60
export const RECONFIRM_SECONDS = 5 * 60

export interface ActiveSession {
  sid:    string
  email:  string
  role:   Role
  userId: string
  /** epoch ms until which a re-confirmation is valid */
  reconfirmedUntil: number
  lastSeen: number
}

const sessions = new Map<string, ActiveSession>()

// Told when a session ends (its sid), or when every session does (null): lib/session-sockets.ts closes their sockets.
const endListeners: Array<(sid: string | null) => void> = []
export function onSessionEnd(fn: (sid: string | null) => void): void { endListeners.push(fn) }
function ended(sid: string | null): void {
  for (const fn of endListeners) { try { fn(sid) } catch { /* a listener must not stop the others */ } }
}

export function addSession(s: { sid: string; email: string; role: Role; userId: string }): ActiveSession {
  const session: ActiveSession = { ...s, reconfirmedUntil: 0, lastSeen: Date.now() }
  sessions.set(s.sid, session)
  snapshotChanged()
  return session
}

export function getSession(sid: string): ActiveSession | undefined {
  return sessions.get(sid)
}

export function removeSession(sid: string): void {
  if (sessions.delete(sid)) snapshotChanged()
  ended(sid)
}

export function clearSessions(): void {
  sessions.clear()
  ended(null)
}

export function allSessions(): ActiveSession[] {
  return [...sessions.values()]
}

export function markReconfirmed(sid: string, now = Date.now()): number {
  const s = sessions.get(sid)
  if (!s) return 0
  s.reconfirmedUntil = now + RECONFIRM_SECONDS * 1000
  snapshotChanged()
  return s.reconfirmedUntil
}

/** Whether the session re-entered the master password within the last `ms` (a second, fresh re-confirmation). */
export function reconfirmedWithin(sid: string, ms: number, now = Date.now()): boolean {
  const s = sessions.get(sid)
  return !!s && s.reconfirmedUntil > now && s.reconfirmedUntil - RECONFIRM_SECONDS * 1000 > now - ms
}

/** End the session's re-confirmation, so the next re-confirmed request asks for the master password again. */
export function dropReconfirm(sid: string): void {
  const s = sessions.get(sid)
  if (s) { s.reconfirmedUntil = 0; snapshotChanged() }
}

export function isReconfirmed(sid: string, now = Date.now()): boolean {
  const s = sessions.get(sid)
  return !!s && s.reconfirmedUntil > now
}

// Kept in the keyholder's snapshot (vault/state.ts), so an API restart keeps everyone signed in.
registerSnapshotPart('sessions', {
  save: () => [...sessions.values()],
  load: (data) => {
    if (!Array.isArray(data)) throw new Error('sessions part is not a list')
    sessions.clear()
    for (const s of data as ActiveSession[]) {
      if (typeof s?.sid !== 'string' || typeof s?.email !== 'string' || typeof s?.role !== 'string') continue
      sessions.set(s.sid, {
        sid: s.sid, email: s.email, role: s.role, userId: String(s.userId ?? ''),
        reconfirmedUntil: Number(s.reconfirmedUntil) || 0, lastSeen: Number(s.lastSeen) || Date.now(),
      })
    }
  },
})

// ── Request context ──────────────────────────────────────────────────────────
// The credential store writes through to the vault as the user who made the
// request, without every caller having to pass a session id down.

export interface RequestContext { sid: string; email: string; role: Role }

export const requestContext = new AsyncLocalStorage<RequestContext>()

export function currentContext(): RequestContext | undefined {
  return requestContext.getStore()
}

/** The request context of an API token (gate.ts tokenSession): its sid is never a signed-in session. */
export function isTokenContext(ctx: RequestContext | undefined = requestContext.getStore()): boolean {
  return !!ctx && ctx.sid.startsWith('token:')
}

/**
 * The vault session to act as: the request's own, else the most recently active
 * signed-in session (for work that outlives its request, e.g. a background job).
 *
 * Never for an API token, nor for work a token's request started: a token must not borrow a person's vault
 * session to write with (and so put a credential, a setting or a pin in the vault under their name). Its vault
 * writes fail as TokenVaultWriteError; its reads, from the unlock cache, are unaffected.
 */
export function actingSid(): string | null {
  const ctx = requestContext.getStore()
  if (isTokenContext(ctx)) return null
  if (ctx && sessions.has(ctx.sid)) return ctx.sid
  let best: ActiveSession | null = null
  for (const s of sessions.values()) if (!best || s.lastSeen > best.lastSeen) best = s
  return best?.sid ?? null
}

// ── Local CLI lock ───────────────────────────────────────────────────────────
// `hyperprox lock` runs on the host and has no vault session. It may lock (and
// only lock) when it is truly local: the socket peer is loopback, it carries no
// session token, and there are no X-Forwarded-* headers. nginx shares the
// host network and reaches the API on loopback too, but every nginx location
// that proxies to the API sets X-Forwarded-For, so proxied requests never count.

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

export function isLocalCliRequest(remoteAddress: string | undefined, headers: Record<string, any>): boolean {
  if (!remoteAddress || !LOOPBACK.has(remoteAddress)) return false
  if (Object.keys(headers).some(h => h.toLowerCase().startsWith('x-forwarded-') || h.toLowerCase() === 'forwarded')) return false
  return extractToken(headers) === null
}

// ── Token extraction ─────────────────────────────────────────────────────────

export const COOKIE_NAME = 'hyperprox_token'

/**
 * Pull the JWT from the auth cookie, falling back to a Bearer header so curl and
 * scripts still work. The cookie is what the browser uses: the frontend proxies
 * /api/* through Next rewrites, so a same-host cookie rides along automatically
 * and no fetch call site needs to change.
 */
export function extractToken(headers: Record<string, any>): string | null {
  const auth = headers['authorization']
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim()

  const raw = headers['cookie']
  if (typeof raw !== 'string') return null

  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === COOKIE_NAME) return part.slice(eq + 1).trim()
  }
  return null
}

/**
 * True when the browser reached HyperProx over https. nginx always sets X-Forwarded-Proto itself (it
 * replaces whatever the client sent, and believes an upstream proxy's value only from a trusted address),
 * so this is the scheme the browser used. Plain http on :3000 or :3002 directly carries no such header.
 */
export function requestIsHttps(headers: Record<string, any> | undefined): boolean {
  const proto = headers?.['x-forwarded-proto']
  return typeof proto === 'string' && proto.split(',')[0].trim().toLowerCase() === 'https'
}

/**
 * Serialise the auth cookie. Max-Age 0 clears it. Pass the request headers so a session made over https
 * gets `Secure` and is never sent back over plain http; without them the cookie is built as before.
 */
export function buildAuthCookie(token: string, maxAgeSeconds: number, headers?: Record<string, any>): string {
  return [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    ...(requestIsHttps(headers) ? ['Secure'] : []),
  ].join('; ')
}
