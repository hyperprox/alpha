// =============================================================================
//  HyperProx — who made a request, as routes record it
//
//  One answer for every route that audits or attributes an action: the person's
//  email and role, their session id, and — whenever the request came with an
//  API token — that token's name. An audit row written from this always says
//  when an action was taken with a token, so "admin@… did it" is never written
//  for something a script did in their name.
// =============================================================================

import type { FastifyRequest } from 'fastify'
import { hasRole, type Role } from '../roles'
import { currentContext, isTokenContext, type RequestContext } from '../auth'

export interface RequestActor {
  email: string
  role:  Role
  sid:   string
  /** The API token's name when the request used one, else null. */
  token: string | null
}

/** The request's actor. Without a session (a public route): "unknown", viewer. */
export function actorOf(req: FastifyRequest): RequestActor {
  const s = req.session
  return {
    email: s?.email ?? 'unknown',
    role:  (s?.role ?? 'viewer') as Role,
    sid:   s?.sid ?? '',
    token: req.apiToken?.name ?? null,
  }
}

/**
 * The actor of the request this code runs in (the gate's request context), for code that has no request object at
 * hand. Outside any request: "unknown", viewer.
 */
export function contextActor(ctx: RequestContext | undefined = currentContext()): RequestActor {
  return {
    email: ctx?.email ?? 'unknown',
    role:  (ctx?.role ?? 'viewer') as Role,
    sid:   ctx?.sid ?? '',
    token: ctx && isTokenContext(ctx) ? tokenNameOf(ctx.email) : null,
  }
}

/** At least admin (owner included). */
export function isAdmin(req: FastifyRequest): boolean {
  return hasRole((req.session?.role ?? 'viewer') as Role, 'admin')
}

/** The same, for the request this code runs in. */
export function contextIsAdmin(ctx: RequestContext | undefined = currentContext()): boolean {
  return !!ctx && hasRole(ctx.role, 'admin')
}

/**
 * A token request's session is named "token:<name>" (lib/gate.ts tokenSession), and actorWords writes it as
 * "token:<name> (API token <name>)": the name, else null. Token names are letters, digits, dot, dash, underscore.
 */
export function tokenNameOf(email: string | null | undefined): string | null {
  const m = typeof email === 'string' ? /^token:([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?: \(API token \1\))?$/.exec(email) : null
  return m ? m[1] : null
}

/** Who did something, as the audit fields take it: an actor, or the `by` text a caller was handed. */
export type AuditActor = string | { email: string; token?: string | null }

/**
 * The audit fields for an actor: `by`, and `tokenName` whenever the action was taken with an API token (the token's
 * name, never its value). The one way every audit row says who acted; `by` is what it has always been.
 */
export function auditBy(a: AuditActor): { by: string; tokenName?: string }
/** Where no one may be known (a background run): `by` stays what it was given, null or absent. */
export function auditBy(a: AuditActor | null | undefined): { by: string | null | undefined; tokenName?: string }
export function auditBy(a: AuditActor | null | undefined): { by: string | null | undefined; tokenName?: string } {
  if (a === null || a === undefined) return { by: a }
  const by = typeof a === 'string' ? a : a.email
  const token = (typeof a === 'string' ? null : a.token) || tokenNameOf(by)
  return token ? { by, tokenName: token } : { by }
}

/** "admin@example.com" or "admin@example.com (API token nightly)": for messages and older single-field audit rows. */
export function actorWords(a: { email: string; token?: string | null }): string {
  return a.token ? `${a.email} (API token ${a.token})` : a.email
}
