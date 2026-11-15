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

/** At least admin (owner included). */
export function isAdmin(req: FastifyRequest): boolean {
  return hasRole((req.session?.role ?? 'viewer') as Role, 'admin')
}

/** The audit fields for an actor: `by`, and `token` only when a token was used. */
export function auditBy(a: { email: string; token?: string | null }): { by: string; token?: string } {
  return a.token ? { by: a.email, token: a.token } : { by: a.email }
}

/** "admin@example.com" or "admin@example.com (API token nightly)": for messages and older single-field audit rows. */
export function actorWords(a: { email: string; token?: string | null }): string {
  return a.token ? `${a.email} (API token ${a.token})` : a.email
}
