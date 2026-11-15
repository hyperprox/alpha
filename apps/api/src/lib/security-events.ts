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

export function securityEvent(
  req: FastifyRequest, action: SecurityAction, reason: string, who?: string, extra: Record<string, string | number | boolean> = {},
): void {
  const subject = (who ?? (req.apiToken ? `token:${req.apiToken.name}` : req.session?.email) ?? 'anonymous').slice(0, 254)
  const path = req.url.split('?')[0].slice(0, 200)
  const details = { who: subject, ip: req.ip, reason, path, method: req.method, requestId: String(req.id), ...extra }
  const { requestId: _r, ...logged } = details   // the log line has reqId already
  req.log.warn({ security: action, ...logged }, `[security] ${action}: ${reason}`)
  // Fire and forget: auditCredentialUse never throws, and a slow database must not hold up the reply.
  void auditCredentialUse(`security.${action}`, subject, details)
}
