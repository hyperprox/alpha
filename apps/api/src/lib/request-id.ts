// =============================================================================
//  HyperProx — request reference numbers
//
//  Every request gets an id. A failure's reply carries it as `requestId` (and every reply as X-Request-Id), and
//  every log line about that request has it as `reqId`, so a reference a person reads out finds the log lines.
//  nginx sends its own $request_id (config/nginx/conf.d/hyperprox-routes.inc); that one is used only when the
//  request came from nginx on loopback and looks like nginx's (32 hex). Anything a client sends itself is ignored.
// =============================================================================

import { randomUUID } from 'crypto'
import type { FastifyInstance } from 'fastify'
import type { IncomingMessage } from 'http'

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const NGINX_ID = /^[a-f0-9]{32}$/

export function genReqId(req: IncomingMessage): string {
  const h = req.headers?.['x-request-id']
  if (typeof h === 'string' && NGINX_ID.test(h) && LOOPBACK.has(req.socket?.remoteAddress ?? '')) return h
  return randomUUID()
}

let installed = new WeakSet<FastifyInstance>()

/**
 * X-Request-Id on every reply, and `requestId` in every JSON 5xx failure body a route built itself without one
 * (sendFailure and the error handler put it in every failure they answer, 4xx included; the gate's own short
 * refusals, locked or signed out, carry it in the header). Idempotent per server.
 */
export function installRequestIds(server: FastifyInstance): void {
  if (installed.has(server)) return
  installed.add(server)
  server.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Request-Id', String(req.id))
    if (reply.statusCode < 500 || typeof payload !== 'string' || payload.length > 65_536 || payload[0] !== '{') return payload
    const type = String(reply.getHeader('content-type') ?? '')
    if (!type.includes('json')) return payload
    try {
      const body = JSON.parse(payload)
      if (body && typeof body === 'object' && !Array.isArray(body) && body.requestId === undefined && (body.ok === false || body.success === false || typeof body.error === 'string')) {
        body.requestId = String(req.id)
        return JSON.stringify(body)
      }
    } catch { /* not JSON after all: leave it */ }
    return payload
  })
}

/** For tests that build several servers. */
export function resetRequestIdsForTests(): void { installed = new WeakSet() }
