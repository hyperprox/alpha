// =============================================================================
//  HyperProx — In-page confirmation
//
//  Actions that change something important (a reboot, an update run, a plug-in's security action, a delete...) are
//  confirmed on the page, not with the master password. The confirmation is enforced here, not only drawn by the page:
//
//    1. The page sends the action as usual. With no confirmation, the answer is
//         403 { code: 'confirm_required', error: <what will happen>, confirm: { token, summary, expiresAt } }
//       and nothing has run. The token is bound to this signed-in session and to this exact request: method, path
//       and query, the cluster it is for, and the body.
//    2. The page shows the summary with Confirm and Cancel. On Confirm it sends the identical request again with the
//       token in the X-HyperProx-Confirm header.
//    3. The token is taken (single use), checked against the request, and the confirmation is written to the audit
//       log before anything runs. When the audit row cannot be written, nothing runs (503 audit_unavailable).
//
//  A token lasts five minutes and is never handed to an API token: a token request on one of these routes is refused
//  (403 token_forbidden). Another site cannot fetch one or use one either: the gate refuses cross-site state-changing
//  requests before they get here, and the session cookie is SameSite=Lax with no CORS allowance (index.ts).
//
//  The master password is asked for only to reveal a stored secret and to change who can sign in (lib/roles.ts
//  needsPassword); everything else that used to ask for it is confirmed here instead (lib/roles.ts needsConfirm).
// =============================================================================

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { auditOrThrow } from './audit'
import { currentContext } from './auth'
import { describeAction, CONFIRM_HEADER } from './confirm-text'

export { CONFIRM_HEADER }
export const CONFIRM_TTL_MS = 5 * 60_000
/** At most this many waiting confirmations per session; the oldest is dropped first. */
const MAX_PER_SESSION = 20
const CLUSTER_HEADER = 'x-hyperprox-cluster'

declare module 'fastify' {
  interface FastifyRequest {
    /** Set once this request's in-page confirmation was checked, taken and audited (lib/confirm.ts). */
    confirmedInPage?: boolean
  }
}

interface Pending { sid: string; binding: string; expires: number }
const pending = new Map<string, Pending>()

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')

/** JSON with object keys sorted at every level, so the same body always binds the same way. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined'
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o).sort().filter(k => o[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`
}

/** What a confirmation is bound to: the method, the raw path with its query, the cluster header and the body. */
export function bindingOf(req: Pick<FastifyRequest, 'method' | 'url' | 'headers' | 'body'>): string {
  const h = req.headers as Record<string, unknown>
  const cluster = typeof h[CLUSTER_HEADER] === 'string' ? (h[CLUSTER_HEADER] as string).trim() : ''
  const b = req.body
  const body = b === undefined || b === null ? '' : Buffer.isBuffer(b) ? `b:${sha256(b)}` : typeof b === 'string' ? `s:${sha256(b)}` : `j:${sha256(canonicalJson(b))}`
  return sha256(JSON.stringify([req.method.toUpperCase(), req.url, cluster, body]))
}

function sweep(now: number): void {
  for (const [t, p] of pending) if (p.expires <= now) pending.delete(t)
}

/** Issue a single-use confirmation for one session and one exact request. */
export function mintConfirm(sid: string, binding: string, now = Date.now()): { token: string; expiresAt: string } {
  sweep(now)
  const mine = [...pending.entries()].filter(([, p]) => p.sid === sid).sort((a, b) => a[1].expires - b[1].expires)
  while (mine.length >= MAX_PER_SESSION) pending.delete(mine.shift()![0])
  const token = randomBytes(32).toString('base64url')
  const expires = now + CONFIRM_TTL_MS
  pending.set(token, { sid, binding, expires })
  return { token, expiresAt: new Date(expires).toISOString() }
}

/**
 * Take a confirmation: true only when it exists, has not expired, belongs to this session and was issued for exactly
 * this request. It is used up whatever the answer, so a token can never be tried twice.
 */
export function takeConfirm(sid: string, binding: string, token: string, now = Date.now()): boolean {
  const p = pending.get(token)
  if (!p) return false
  pending.delete(token)
  if (p.expires <= now || p.sid !== sid) return false
  const a = Buffer.from(p.binding), b = Buffer.from(binding)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Forget waiting confirmations: one session's (sign-out), or all of them (a lock, tests). */
export function clearConfirms(sid?: string): void {
  if (sid === undefined) { pending.clear(); return }
  for (const [t, p] of pending) if (p.sid === sid) pending.delete(t)
}

/** Tests: how many confirmations are waiting. */
export function pendingConfirms(): number { return pending.size }

/** The route Fastify matched, as registered, or the plain path. */
function routeOf(req: FastifyRequest): string {
  const url = (req as any).routeOptions?.url
  return typeof url === 'string' && url ? url : req.url.split('?')[0]
}

export const TOKEN_CANNOT_CONFIRM = 'An API token cannot confirm this action. Sign in and do it on its page.'

/**
 * Require an in-page confirmation for this request. True when it carries a valid one (taken and audited here, or
 * already by the gate); otherwise the reply is sent (403 confirm_required with a fresh token, 403 token_forbidden for
 * an API token, 503 when the audit log cannot be written) and the caller must stop.
 * `summary` is the plain-English sentence of what will happen; without one it is worked out from the route.
 */
export async function requireConfirm(req: FastifyRequest, reply: FastifyReply, summary?: string): Promise<boolean> {
  if (req.confirmedInPage) return true
  const s = req.session
  if (req.apiToken || !s || s.sid.startsWith('token:')) {
    reply.status(403).send({ ok: false, code: 'token_forbidden', error: TOKEN_CANNOT_CONFIRM })
    return false
  }
  const binding = bindingOf(req)
  const given = (req.headers as Record<string, unknown>)[CONFIRM_HEADER]
  if (typeof given === 'string' && given && takeConfirm(s.sid, binding, given)) {
    try {
      await auditOrThrow('action.confirmed', `${req.method.toUpperCase()} ${routeOf(req)}`, {
        by: s.email, confirmed: 'in page', path: req.url.split('?')[0].slice(0, 200),
      })
    } catch (e: any) {
      req.log.warn({ err: e?.message }, '[confirm] audit write failed, action refused')
      reply.status(503).send({ ok: false, success: false, code: 'audit_unavailable', error: 'The audit log could not be written, so this was not done. Try again in a minute.' })
      return false
    }
    req.confirmedInPage = true
    const ctx = currentContext()
    if (ctx) ctx.confirmedInPage = true
    return true
  }
  const text = summary ?? describeAction(req.method, routeOf(req), req.url, (req.params ?? {}) as Record<string, unknown>, req.body)
  const { token, expiresAt } = mintConfirm(s.sid, binding)
  reply.status(403).send({ ok: false, code: 'confirm_required', error: text, confirm: { token, summary: text, expiresAt } })
  return false
}
