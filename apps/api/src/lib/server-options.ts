// The Fastify options the API starts with (src/index.ts), kept here so tests build the same server.

import type { FastifyRouterOptions, RawServerDefault } from 'fastify'

/**
 * nginx on this machine is the only proxy whose X-Forwarded-For is believed. It appends the browser's address,
 * so req.ip is the client (per-client rate limits work) and an address a client writes into the header itself
 * is ignored. A request straight to the API port from anywhere else keeps its own socket address.
 */
export const TRUSTED_PROXIES = ['127.0.0.1', '::1']

/**
 * Errors reach the log through this, never as raw objects: only the type, message, stack, code and status are kept
 * (and the same of a `cause`), so a field some error carries (an HTTP error's response body, a request config with
 * a header) is never written to the log.
 */
export function safeErr(e: unknown, depth = 0): unknown {
  if (!e || typeof e !== 'object') return e
  const x = e as any
  const out: Record<string, unknown> = {
    type: String(x.constructor?.name ?? x.name ?? 'Error'),
    message: typeof x.message === 'string' ? x.message : undefined,
    stack: typeof x.stack === 'string' ? x.stack : undefined,
  }
  if (typeof x.code === 'string' || typeof x.code === 'number') out.code = x.code
  const status = x.status ?? x.statusCode
  if (typeof status === 'number') out.status = status
  if (x.cause && depth < 5) out.cause = safeErr(x.cause, depth + 1)
  return out
}

/** Fields that must never appear in a log line, wherever a logged object carries them. */
export const LOG_REDACT = {
  paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', '*.password', '*.token', '*.secret'],
  censor: '[redacted]',
}

/** The logger options with the error serializer and the redaction added (a logger that is not an options object is left alone). */
export function safeLogger<L>(logger: L): L {
  if (!logger || typeof logger !== 'object') return logger
  const l = logger as any
  return { ...l, serializers: { ...l.serializers, err: safeErr }, redact: l.redact ?? LOG_REDACT } as L
}

export function serverOptions<L>(logger: L) {
  return {
    // Router options live under routerOptions since Fastify 5 (top-level ones are deprecated). Never split a
    // path at ';' (Fastify 4's default, off by default in 5; stated here so it cannot come back): the gate's
    // role checks must see the route the router serves. (find-my-way's types leave this key out; the router reads it.)
    routerOptions: { useSemicolonDelimiter: false } as FastifyRouterOptions<RawServerDefault>,
    trustProxy: TRUSTED_PROXIES,
    logger: safeLogger(logger),
  }
}
