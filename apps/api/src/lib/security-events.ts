// =============================================================================
//  HyperProx — security events
//
//  A refused sign-in, a wrong master password at re-confirmation, a refused setup key, a bad or out-of-scope API
//  token, a role denial, a failed unlock: each one is a log line (warn) and an audit row, with who (the email or
//  token name given), the client's address, a reason code and the path. Never a password, code or token value:
//  the audit writer drops any field named like a secret as well (lib/audit.ts scrubDetails).
// =============================================================================

import type { FastifyRequest } from 'fastify'
import { auditCredentialUse } from './audit'

export type SecurityAction =
  | 'sign_in_failed' | 'reconfirm_failed' | 'setup_key_refused' | 'api_token_invalid' | 'api_token_forbidden'
  | 'role_denied' | 'unlock_failed'

/**
 * The same event (action, who, address, reason) is written at most once a minute: a script hammering a bad token or
 * a sign-in form cannot fill the log and the audit table. The next one after the minute carries how many were
 * held back (`repeated`).
 */
export const SECURITY_EVENT_WINDOW_MS = 60_000
const MAX_KEYS = 5000
const recent = new Map<string, { at: number; held: number }>()

/** For tests. */
export function resetSecurityEventThrottle(): void { recent.clear() }

export function securityEvent(
  req: FastifyRequest, action: SecurityAction, reason: string, who?: string, extra: Record<string, string | number | boolean> = {},
  now: () => number = Date.now,
): void {
  const subject = (who ?? (req.apiToken ? `token:${req.apiToken.name}` : req.session?.email) ?? 'anonymous').slice(0, 254)
  const key = `${action}\n${subject}\n${req.ip}\n${reason}`
  const t = now()
  const seen = recent.get(key)
  if (seen && t - seen.at < SECURITY_EVENT_WINDOW_MS) { seen.held++; return }
  if (recent.size >= MAX_KEYS) {
    for (const [k, v] of recent) if (t - v.at >= SECURITY_EVENT_WINDOW_MS) recent.delete(k)
    if (recent.size >= MAX_KEYS) recent.delete(recent.keys().next().value as string)
  }
  recent.set(key, { at: t, held: 0 })
  const repeated = seen?.held ?? 0

  const path = req.url.split('?')[0].slice(0, 200)
  const details = { who: subject, ip: req.ip, reason, path, method: req.method, requestId: String(req.id), ...(repeated ? { repeated } : {}), ...extra }
  const { requestId: _r, ...logged } = details   // the log line has reqId already
  req.log.warn({ security: action, ...logged }, `[security] ${action}: ${reason}${repeated ? ` (and ${repeated} more in the last minute)` : ''}`)
  // Fire and forget: auditCredentialUse never throws, and a slow database must not hold up the reply.
  void auditCredentialUse(`security.${action}`, subject, details)
}
