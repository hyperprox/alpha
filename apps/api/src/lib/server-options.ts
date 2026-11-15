// The Fastify options the API starts with (src/index.ts), kept here so tests build the same server.

import type { FastifyRouterOptions, RawServerDefault } from 'fastify'

/**
 * nginx on this machine is the only proxy whose X-Forwarded-For is believed. It appends the browser's address,
 * so req.ip is the client (per-client rate limits work) and an address a client writes into the header itself
 * is ignored. A request straight to the API port from anywhere else keeps its own socket address.
 */
export const TRUSTED_PROXIES = ['127.0.0.1', '::1']

export function serverOptions<L>(logger: L) {
  return {
    // Router options live under routerOptions since Fastify 5 (top-level ones are deprecated). Never split a
    // path at ';' (Fastify 4's default, off by default in 5; stated here so it cannot come back): the gate's
    // role checks must see the route the router serves. (find-my-way's types leave this key out; the router reads it.)
    routerOptions: { useSemicolonDelimiter: false } as FastifyRouterOptions<RawServerDefault>,
    trustProxy: TRUSTED_PROXIES,
    logger,
  }
}
