// =============================================================================
//  HyperProx demo mode — what public mode adds for the open internet
//
//  The public demo listens on one address. The API answers there itself (./server.ts);
//  every page request is passed to the demo frontend, which listens on loopback only.
//  Only GET and HEAD reach the frontend, only the headers a browser needs are passed on,
//  and every answer carries the security headers below. The frontend makes no request
//  to any other site: the Content-Security-Policy holds the browser to this origin too.
// =============================================================================

import http from 'node:http'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { PublicConfig } from './safety'

/** Sent with every answer, API or page. */
export const SECURITY_HEADERS: Record<string, string> = {
  // Next's hydration scripts and the theme switch are inline; nothing is loaded from anywhere else.
  'Content-Security-Policy': [
    "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:", "font-src 'self' data:", "connect-src 'self'", "media-src 'self'",
    "worker-src 'self'", "manifest-src 'self'", "frame-src 'none'", "frame-ancestors 'none'",
    "object-src 'none'", "base-uri 'self'", "form-action 'self'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), bluetooth=(), payment=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000',
}

/** Request headers worth passing to the frontend. Anything else (hop-by-hop, proxies' own) stays here. */
const PASS_REQUEST = new Set([
  'accept', 'accept-encoding', 'accept-language', 'cache-control', 'cookie', 'if-modified-since', 'if-none-match',
  'pragma', 'range', 'user-agent', 'purpose', 'sec-purpose', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
  'rsc', 'next-router-state-tree', 'next-router-prefetch', 'next-router-segment-prefetch', 'next-url', 'x-nextjs-data',
])
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'trailer', 'x-powered-by'])
const HOST = /^[a-z0-9.-]{1,253}(:\d{1,5})?$/i

/** Passes a page request to the demo frontend on loopback and sends its answer back. */
export function forwardToWeb(req: FastifyRequest, reply: FastifyReply, pub: PublicConfig): Promise<FastifyReply> {
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (PASS_REQUEST.has(k) && typeof v === 'string') headers[k] = v
  }
  const host = typeof req.headers.host === 'string' && HOST.test(req.headers.host) ? req.headers.host : `${pub.listenHost}:${pub.listenPort}`
  headers['x-forwarded-host'] = host
  headers['x-forwarded-proto'] = req.protocol === 'https' ? 'https' : 'http'
  headers['x-forwarded-for'] = req.ip
  headers.host = `127.0.0.1:${pub.webPort}`

  return new Promise(resolve => {
    const up = http.request({ host: '127.0.0.1', port: pub.webPort, method: req.method, path: req.url, headers, timeout: 15_000 }, res => {
      reply.status(res.statusCode ?? 502)
      for (const [k, v] of Object.entries(res.headers)) {
        if (v === undefined || DROP_RESPONSE.has(k)) continue
        reply.header(k, v)
      }
      resolve(reply.send(res))
    })
    up.on('timeout', () => up.destroy(new Error('timeout')))
    up.on('error', () => { if (!reply.sent) resolve(reply.status(502).send({ ok: false, demo: true, error: 'The demo is starting up. Try again in a moment.' })) })
    up.end()
  })
}
