// =============================================================================
//  HyperProx — one way to answer a request that failed
//
//  A person sees one plain sentence and a reference number; the technical detail (the error, its stack, the
//  route, who asked) goes to the log under that same reference. Never a stack trace, a database message or an
//  upstream service's answer in a reply. Used by every route's catch (sendFailure) and by the global error handler
//  (lib/gate.ts) for anything a route did not catch.
//
//  HyperProx's own refusals (the *Refusal / *Refused / *InputError classes) are already written for people, so
//  their message is passed on as it is, with a 4xx. Everything else is described by what kind of failure it is.
// =============================================================================

import type { FastifyReply, FastifyRequest } from 'fastify'
import { hasRole, type Role } from './roles'
import { appLog, createLogOnce } from './log-once'

export interface FailureBody {
  ok: false
  /** Older pages read `success`; both are sent so no page mistakes a failure for an answer. */
  success: false
  error: string
  code: string
  requestId?: string
  /** Field-level problems with a request body, in plain words. */
  fields?: Array<{ field: string; problem: string }>
  /** Upstream detail, only for an admin and only where the caller allowed it. */
  detail?: string
  locked?: true
}

export interface Classified {
  status: number
  body: Omit<FailureBody, 'requestId'>
  /** True when the failure is HyperProx's own, expected answer (a refusal, bad input): logged without alarm. */
  expected: boolean
  /** The message is HyperProx's own words for people (a refusal), whatever the status. */
  ownWords?: boolean
}

/** A pinned Proxmox certificate that changed: possibly someone in the middle, so HyperProx stopped talking to it. */
export const CERT_CHANGED_MESSAGE = "Proxmox's security certificate has changed since HyperProx last connected. HyperProx stopped talking to it until you check — see Settings → Proxmox."
/** The error classes for a certificate that is not the pinned one (home: lib/home-tls.ts; remote: lib/clusters/tls-pin.ts). */
export const CERT_CHANGED_NAMES = new Set(['HomeCertificateChangedError', 'CertificateChangedError'])

export const MESSAGES = {
  internal: 'Something went wrong inside HyperProx. The details are in its log.',
  database: "HyperProx's database is not answering. Try again in a minute.",
  invalid: 'That request was not valid.',
  tooLarge: 'That was too large.',
  mediaType: 'HyperProx cannot read that kind of request.',
  tooMany: 'Too many requests. Wait a minute and try again.',
  upstream: 'A service HyperProx relies on did not answer. Try again in a minute.',
  locked: 'HyperProx is locked. Sign in to unlock it.',
} as const

const DB_DOWN_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024'])
const CONNECTION_RE = /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ECONNRESET|socket hang up|fetch failed/i
/** HyperProx's own refusal classes: their messages are written for people. */
const FRIENDLY_NAME = /(Refusal|Refused|InputError)$/
/**
 * HyperProx's own trust checks (a host key or certificate that is not pinned, not confirmed or changed): written for
 * people, naming what to do, and kept at the status their routes have always answered with.
 */
const TRUST_NAMES = new Set([
  'HostKeyNotPinnedError', 'HostKeyNotConfirmedError', 'HostKeyChangedError', 'HostKeyMismatch',
  'HomeCertificateChangedError', 'CertificateNotConfirmedError', 'CertificateChangedError', 'HostKeyRefusedError',
])

function errName(e: any): string {
  return String(e?.constructor?.name && e.constructor.name !== 'Error' ? e.constructor.name : e?.name ?? '')
}

function prismaCode(e: any): string | null {
  const name = errName(e)
  if (!/^PrismaClient/.test(name)) return null
  const code = typeof e.code === 'string' ? e.code : typeof e.errorCode === 'string' ? e.errorCode : ''
  // An initialisation error without a code is the database not being there at all.
  return code || (name === 'PrismaClientInitializationError' ? 'P1001' : name === 'PrismaClientRustPanicError' ? 'panic' : 'unknown')
}

function zodFields(e: any): Array<{ field: string; problem: string }> | null {
  if (errName(e) !== 'ZodError' || !Array.isArray(e.issues)) return null
  return e.issues.slice(0, 20).map((i: any) => ({
    field: Array.isArray(i?.path) && i.path.length ? i.path.join('.') : 'request',
    problem: typeof i?.message === 'string' ? i.message.slice(0, 200) : 'not valid',
  }))
}

/** True when an error (or its cause) is a connection that failed: refused, timed out, no route, dropped. */
export function connectionFailure(e: any, depth = 0): boolean {
  if (!e || typeof e !== 'object' || depth > 4) return false
  if (typeof e.code === 'string' && CONNECTION_RE.test(e.code)) return true
  if (typeof e.message === 'string' && CONNECTION_RE.test(e.message)) return true
  return connectionFailure(e.cause, depth + 1)
}

/** The class name of an error, as the classifier sees it. */
export function failureName(e: unknown): string { return errName(e) }

const fail = (status: number, code: string, error: string, expected: boolean, extra: Partial<FailureBody> = {}): Classified =>
  ({ status, expected, body: { ok: false, success: false, error, code, ...extra } })

/**
 * What to tell a person about an error. `friendly` replaces the generic sentence for a 5xx (the route knows what
 * it was trying to do: "Could not read the storage list."). It never replaces a refusal's own message.
 */
export function classifyFailure(err: unknown, friendly?: string): Classified {
  const e = err as any
  const name = errName(e)
  const code: string = typeof e?.code === 'string' ? e.code : ''

  // -- HyperProx's own typed answers --------------------------------------------------------------------------
  if (name === 'ProxmoxAuthError') return fail(502, 'proxmox_auth', String(e.message), true)
  if (name === 'ProxmoxUnreachableError') return fail(504, 'proxmox_unreachable', String(e.message), true)
  if (name === 'HomeConnectTimeoutError') return fail(504, 'proxmox_unreachable', String(e.message), true)
  if (name === 'VaultLockedError' || name === 'GateLockedError') return fail(423, 'locked', MESSAGES.locked, true, { locked: true })
  if (name === 'KeyholderLockError') return fail(503, 'keyholder_lock_unconfirmed', String(e.message), true)
  if (name === 'KeyholderUnavailableError') return fail(503, 'keyholder_unavailable', String(e.message), true, { locked: true })
  if (name === 'VaultSessionError') return fail(401, 'session_expired', 'Your vault session has ended — sign in again', true)
  if (name === 'VaultAuthError' && e.code === 'vault_unreachable') {
    return fail(503, 'vault_unreachable', "The vault is not running, so HyperProx can't check your sign-in. It usually comes back by itself in a minute.", false)
  }
  if (name === 'VaultOwnerOnlyError') return fail(403, 'vault_owner_only', String(e.message), true)
  if (name === 'TokenVaultWriteError') return fail(403, 'token_forbidden', String(e.message), true)
  // Never the fingerprints or the pin file in the answer: admins see those under Settings → Proxmox.
  if (CERT_CHANGED_NAMES.has(name)) return fail(502, 'proxmox_cert_changed', CERT_CHANGED_MESSAGE, false)
  if (TRUST_NAMES.has(name)) {
    const st = Number(e.status ?? e.statusCode)
    return fail(Number.isInteger(st) && st >= 400 && st < 600 ? st : 500, typeof e.code === 'string' && /^[a-z_]+$/.test(e.code) ? e.code : 'trust_check', String(e.message), true)
  }
  // Cloudflare's own refusals are made into one plain sentence by the client (lib/cloudflare-client.ts cfErrorMessage).
  if (name === 'CloudflareError' && Number(e.statusCode) >= 400 && Number(e.statusCode) < 500) return fail(Number(e.statusCode), 'refused', String(e.message), true)
  // A plug-in with nothing to talk to yet, or a credential it still needs: a state to show, in its own words.
  if (name === 'PluginNotConfigured') return fail(409, 'not_configured', String(e.message), true)
  if (name === 'PluginSettingsError') return fail(400, 'credential_required', String(e.message), true)
  if (FRIENDLY_NAME.test(name) || name === 'DNSInputError') {
    // Its own status, 4xx or 5xx (a refusal can be "the NAS did not answer", 502); 400 when it has none. A 5xx one is
    // still worth a warning in the log.
    const s = Number(e.status ?? e.statusCode)
    const status = Number.isInteger(s) && s >= 400 && s < 600 ? s : 400
    return { ...fail(status, typeof e.code === 'string' && /^[a-z_]+$/.test(e.code) ? e.code : 'refused', String(e.message || MESSAGES.invalid), status < 500), ownWords: true }
  }

  // -- Database ---------------------------------------------------------------------------------------------
  const pc = prismaCode(e)
  if (pc && DB_DOWN_CODES.has(pc)) return fail(503, 'db_unavailable', MESSAGES.database, false)
  if (pc) return fail(500, 'db_error', friendly ?? MESSAGES.internal, false)

  // -- Request shape (Fastify's own errors) -----------------------------------------------------------------
  if (code === 'FST_ERR_CTP_INVALID_JSON' || code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || code === 'FST_ERR_CTP_INVALID_CONTENT_LENGTH') {
    return fail(400, 'invalid_request', MESSAGES.invalid, true)
  }
  if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') return fail(413, 'too_large', MESSAGES.tooLarge, true)
  if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return fail(415, 'unsupported_media_type', MESSAGES.mediaType, true)
  const fields = zodFields(e)
  if (fields) return fail(400, 'invalid_request', `${MESSAGES.invalid} ${fields.map(f => `${f.field}: ${f.problem}`).join('; ')}.`, true, { fields })
  if (code === 'FST_ERR_VALIDATION' || Array.isArray(e?.validation)) {
    const v = Array.isArray(e?.validation) ? e.validation.slice(0, 20) : []
    const vf = v.map((x: any) => ({
      field: String(x?.instancePath || x?.params?.missingProperty || 'request').replace(/^\//, '').replace(/\//g, '.') || 'request',
      problem: String(x?.message ?? 'not valid').slice(0, 200),
    }))
    return fail(400, 'invalid_request', MESSAGES.invalid, true, vf.length ? { fields: vf } : {})
  }
  const status = Number(e?.statusCode)
  if (status === 429) return fail(429, 'too_many_requests', MESSAGES.tooMany, true)
  if (/^FST_/.test(code) && status >= 400 && status < 500) return fail(status, 'invalid_request', MESSAGES.invalid, true)

  // -- Everything else: never its own text --------------------------------------------------------------------
  if (connectionFailure(e)) return fail(502, 'upstream_unreachable', friendly ?? MESSAGES.upstream, false)
  return fail(500, 'internal', friendly ?? MESSAGES.internal, false)
}

export interface FailureOptions {
  /** Let an admin see the error's own text under `detail` (an upstream answer they may need to act on). */
  adminDetail?: boolean
  /** Use this status instead of the classified one for a 5xx (a route that has always answered 502, say). */
  status?: number
}

function who(req: FastifyRequest): string | undefined {
  return req.apiToken ? `token:${req.apiToken.name}` : req.session?.email
}

function routeOf(req: FastifyRequest): string {
  const url = (req as any).routeOptions?.url
  return `${req.method} ${typeof url === 'string' && url ? url : req.url.split('?')[0]}`
}

/** Build the reply body and log the failure: what both sendFailure and the global error handler do. */
export function describeFailure(req: FastifyRequest, err: unknown, friendly?: string, opts: FailureOptions = {}): { status: number; body: FailureBody } {
  const c = classifyFailure(err, friendly)
  let status = c.status
  if (opts.status && status >= 500 && opts.status >= 500) status = opts.status
  const ownWords = c.ownWords === true
  const body: FailureBody = { ...c.body, requestId: String(req.id) }
  // reqId is on every line of req.log already (Fastify's child logger).
  const ctx = { route: routeOf(req), user: who(req), code: body.code, status }
  if (c.expected && status < 500) req.log.info({ ...ctx, reason: (err as any)?.message }, `request refused: ${body.code}`)
  else if (ownWords) req.log.warn({ ...ctx, err }, `request refused: ${body.code}`)
  else req.log.error({ ...ctx, err }, `request failed: ${body.code}`)
  if (opts.adminDetail && status >= 500 && req.session && hasRole(req.session.role as Role, 'admin')) {
    const m = (err as any)?.message
    if (typeof m === 'string' && m) body.detail = m.slice(0, 500)
  }
  return { status, body }
}

/**
 * Answer a failed request: a plain sentence, a code, and the request's reference number; the error itself goes to
 * the log. `friendly` is what to say when the failure is not one HyperProx has its own words for.
 */
export function sendFailure(req: FastifyRequest, reply: FastifyReply, err: unknown, friendly?: string, opts: FailureOptions = {}) {
  const { status, body } = describeFailure(req, err, friendly, opts)
  return reply.status(status).send(body)
}

// Logged once per subject while the same problem repeats (plug-in panels are read every few seconds).
const reasonLog = createLogOnce(appLog)

/**
 * A short reason for a reading that failed, for a page that shows "ok: false" in place of a panel (a plug-in, a NAS,
 * a house): HyperProx's own refusals keep their words; anything else is "did not answer" or "could not be read",
 * never the upstream's text. The error itself goes to the log under `what`.
 */
export function plainReason(e: unknown, what: string): string {
  return plainFailure(e, what).error
}

/**
 * plainReason with the code a page can act on: `not_configured` (a plug-in with nothing to talk to yet, shown as
 * "Not set up") or `credential_required`. Spread into a panel's `{ ok: false }` answer.
 */
export function plainFailure(e: unknown, what: string): { error: string; code?: string } {
  const c = classifyFailure(e)
  if (c.body.code === 'not_configured' || c.body.code === 'credential_required') return { error: c.body.error, code: c.body.code }
  return { error: plainReasonText(e, what, c) }
}

function plainReasonText(e: unknown, what: string, c: Classified): string {
  reasonLog(`reading ${what}`, e)
  if (c.expected || c.ownWords || c.body.code === 'proxmox_cert_changed' || c.body.code === 'db_unavailable') return c.body.error
  if (connectionFailure(e)) return `${what} did not answer.`
  return `${what} could not be read. The details are in HyperProx's log.`
}
