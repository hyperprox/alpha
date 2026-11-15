// =============================================================================
//  HyperProx demo mode — the API
//
//  A Fastify server that shares no code with the real API's routes, gate, vault,
//  credential store or database. Every GET the frontend makes is answered from the
//  invented fixtures in ./fixtures; a few previews (plans, checks) are answered the
//  same way so their dialogs can be seen; every other change, every websocket and every
//  terminal is refused here, in the API, so the refusal does not depend on the UI
//  hiding a button.
//
//  The demo has no sign-in: there is no account, and the status call always answers
//  with the invented owner. Where the real product asks for the master password first
//  (the same rules, from lib/roles.ts), the demo asks too: the prompt accepts anything
//  and the answer is kept in a short-lived cookie, never on the server. Then the change
//  is refused with a friendly "nothing changes in the demo".
//
//  In public mode (./public.ts) the same server also serves the pages, adds a per-address
//  rate limit and security headers, and limits request sizes. It keeps no per-visitor
//  state apart from the rate limiter's counters, which are capped in number.
// =============================================================================

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { FIXTURES, type FixtureRoute } from './fixtures'
import { NOT_FOUND } from './fixtures/types'
import { DEMO_OWNER } from './fixtures/data'
import { needsReconfirm } from '../lib/roles'
import { forwardToWeb, SECURITY_HEADERS } from './public'
import type { PublicConfig } from './safety'

export const INSTALL_URL = 'https://hyperprox.dev/#install'
export const DEMO_MESSAGE = 'In the demo nothing changes. Install HyperProx to do this for real.'
export const DEMO_REFUSAL = { ok: false, success: false, demo: true, code: 'demo', error: DEMO_MESSAGE, message: DEMO_MESSAGE, install: INSTALL_URL } as const
/** Set on every refusal, so the frontend can show its "install it for real" note whatever page asked. */
export const REFUSED_HEADER = 'X-HyperProx-Demo-Refused'
const SESSION_COOKIE = 'hyperprox_token'
const SESSION_VALUE = 'demo-session'
const RECONFIRM_COOKIE = 'hyperprox_demo_reconfirmed'
const RECONFIRM_SECONDS = 300

/** Request limits. Nothing the demo accepts is larger than a settings form. */
export const LIMITS = {
  bodyBytes: 64 * 1024,
  urlChars: 2048,
  /**
   * Per visitor address, per minute: every request, and the subset that are changes. The frontend's own static
   * files (scripts, styles, fonts, icons: cached by the browser after the first visit) are not counted, but page
   * prefetches and API polls are, and one visitor clicking quickly through the menu makes a few hundred a minute.
   */
  perMinute: 1200,
  writesPerMinute: 60,
  /** How many visitor addresses the rate limiter remembers at once (least recently seen are dropped). */
  trackedAddresses: 10_000,
}

interface Compiled { route: FixtureRoute; re: RegExp; keys: string[] }

function compile(route: FixtureRoute): Compiled {
  const keys: string[] = []
  const src = route.path.split('/').map(seg => {
    if (seg.startsWith(':')) { keys.push(seg.slice(1)); return '([^/]+)' }
    if (seg === '*') { keys.push('rest'); return '(.*)' }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }).join('/')
  return { route, re: new RegExp(`^${src}/?$`), keys }
}

export function matchFixture(table: Compiled[], pathname: string, method = 'GET'): { route: FixtureRoute; params: Record<string, string> } | null {
  for (const c of table) {
    if (method === 'POST' ? !c.route.post : !(c.route.get || c.route.refuse)) continue
    const m = c.re.exec(pathname)
    if (!m) continue
    const params: Record<string, string> = {}
    c.keys.forEach((k, i) => { params[k] = safeDecode(m[i + 1]) })
    return { route: c.route, params }
  }
  return null
}

const safeDecode = (s: string) => { try { return decodeURIComponent(s) } catch { return s } }

function hasCookie(cookie: string | undefined, name: string, value: string): boolean {
  return !!cookie && cookie.split(';').some(p => p.trim() === `${name}=${value}`)
}

/** The frontend's static files: content-hashed or fixed assets, never an API call or a page. */
const STATIC = /^\/(_next\/static\/|demo-fonts\/|favicon\.ico$|icon[-.\w]*\.(svg|png)$|apple-touch-icon\.png$|manifest\.webmanifest$)/

/**
 * True when the raw request path is already in the form every reader agrees on: what is routed, rate-limited and
 * passed on is then exactly what was asked for. "/api/../dashboard", "/%2e%2e/", "/a\\b" and anything a URL
 * parser would rewrite are not.
 */
export function canonical(raw: string): boolean {
  const path = raw.split('?')[0]
  if (!path.startsWith('/') || path.startsWith('//')) return false
  if (path.includes('..') || /%2e/i.test(path) || path.includes('\\') || /%5c/i.test(path) || /%2f/i.test(path)) return false
  try { return new URL(raw, 'http://demo.invalid').pathname === path } catch { return false }
}

const pathOf = (url: string) => { try { return new URL(url, 'http://demo.invalid').pathname } catch { return url } }

const isWrite = (method: string) => method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS'

export interface DemoServerOptions {
  logger?: boolean
  /** Public mode: serve the pages from the demo frontend too, rate-limit, and trust these proxies. */
  public?: PublicConfig | null
  /** Overrides for tests. */
  limits?: Partial<typeof LIMITS>
}

export async function buildDemoServer(opts: DemoServerOptions = {}): Promise<FastifyInstance> {
  const limits = { ...LIMITS, ...(opts.limits ?? {}) }
  const pub = opts.public ?? null
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: limits.bodyBytes,
    routerOptions: { maxParamLength: 200 },
    // Slow or idle visitors do not get to hold a connection open.
    connectionTimeout: 30_000,
    keepAliveTimeout: 5_000,
    requestTimeout: 15_000,
    // Only the named reverse proxies may say who the visitor is; anyone else is their own socket address.
    trustProxy: pub && pub.trustedProxies.length ? pub.trustedProxies : false,
  })
  const table = FIXTURES.map(compile)

  // Whatever a change sends is read and thrown away (never parsed), up to the size limit.
  app.removeAllContentTypeParsers()
  app.addContentTypeParser('*', (_req, payload, done) => {
    let size = 0, over = false
    payload.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limits.bodyBytes && !over) {
        over = true
        const err = Object.assign(new Error('Request body is too large for the demo.'), { statusCode: 413 })
        done(err, undefined)
        payload.destroy()
      }
    })
    payload.on('end', () => { if (!over) done(null, undefined) })
    payload.on('error', e => { if (!over) done(e, undefined) })
  })

  // Websockets (the live feed, update logs, terminal shells): refused at the HTTP upgrade, before any socket opens.
  app.server.on('upgrade', (_req, socket) => {
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nThis is a demo: ' + DEMO_MESSAGE + '\n')
  })

  // Very long addresses are refused before anything else looks at them.
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.length > limits.urlChars) return reply.status(414).send({ ok: false, demo: true, error: 'That address is too long.' })
    // One spelling per path: no dot segments, encoded dots or backslashes, nothing a server could read two ways.
    if (!canonical(req.url)) return reply.status(400).send({ ok: false, demo: true, error: 'That address is not one the demo serves.' })
    const len = Number(req.headers['content-length'] ?? 0)
    if (len > limits.bodyBytes) return reply.status(413).send({ ok: false, demo: true, error: 'Request body is too large for the demo.' })
  })

  // Static files are free only while they are files: a visitor's static-looking requests that are not answered
  // with the file (a 404, an error) are counted here, and past the change budget they are counted like the rest.
  const staticMisses = new MissCounter(limits.writesPerMinute, limits.trackedAddresses)
  if (pub) {
    app.addHook('onResponse', async (req, reply) => {
      if (STATIC.test(pathOf(req.url)) && reply.statusCode !== 200 && reply.statusCode !== 304) staticMisses.add(req.ip)
    })
    app.addHook('onClose', async () => staticMisses.stop())
    await app.register(rateLimit, {
      global: true,
      cache: limits.trackedAddresses,
      timeWindow: 60_000,
      // Changes get a bucket of their own, smaller than the one for everything else.
      keyGenerator: (req: FastifyRequest) => `${req.ip}${isWrite(req.method) ? ':w' : ''}`,
      // Judged on the path as the handler will see it, so "/_next/static/../../api/..." is counted like the API it is.
      allowList: (req: FastifyRequest) => (req.method === 'GET' || req.method === 'HEAD') && STATIC.test(pathOf(req.url)) && !staticMisses.over(req.ip),
      max: async (_req: FastifyRequest, key: string) => key.endsWith(':w') ? limits.writesPerMinute : limits.perMinute,
      errorResponseBuilder: (_req, ctx) => ({ statusCode: 429, ok: false, demo: true, code: 'rate_limited', error: `Too many requests from your address. Try again in ${Math.ceil(ctx.ttl / 1000)} s.` }),
    })
  }

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-HyperProx-Demo', '1')
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v)
    // API answers are never cached; the pages' own static files keep the frontend's caching.
    if (req.url.startsWith('/api/') || req.url === '/health') reply.header('Cache-Control', 'no-store')
    return payload
  })

  // Behind HTTPS in public mode, every cookie is Secure.
  const cookie = (v: string) => pub ? `${v}; Secure` : v
  // No error text from the code ever reaches a visitor: a status and a plain sentence for it.
  app.setErrorHandler((err, _req, reply) => {
    // The rate limiter's own answer (errorResponseBuilder below) is ours already: plain words, no detail.
    if ((err as any).code === 'rate_limited') return reply.status(429).send(err)
    const code = typeof (err as any).statusCode === 'number' && (err as any).statusCode >= 400 && (err as any).statusCode < 500 ? (err as any).statusCode : 500
    const words: Record<number, string> = { 400: 'That request is not one the demo understands.', 413: 'Request body is too large for the demo.', 414: 'That address is too long.', 429: 'Too many requests from your address.' }
    return reply.status(code).send({ ok: false, success: false, demo: true, error: words[code] ?? (code < 500 ? 'The demo cannot answer that.' : 'Something went wrong in the demo.') })
  })

  const refuse = (reply: any) => reply.status(403).header(REFUSED_HEADER, '1').send(DEMO_REFUSAL)

  // There is no account. Sign-in checks nothing and sets the cookie the frontend's middleware expects.
  app.post('/api/auth/sign-in', async (_req, reply) => {
    reply.header('Set-Cookie', cookie(`${SESSION_COOKIE}=${SESSION_VALUE}; Path=/; HttpOnly; SameSite=Lax`))
    return { ok: true, demo: true, user: { email: DEMO_OWNER.email, role: DEMO_OWNER.role } }
  })

  // Always signed in as the invented owner: the demo opens straight onto the dashboard.
  app.get('/api/auth/status', async (req, reply) => {
    if (!hasCookie(req.headers.cookie, SESSION_COOKIE, SESSION_VALUE)) reply.header('Set-Cookie', cookie(`${SESSION_COOKIE}=${SESSION_VALUE}; Path=/; HttpOnly; SameSite=Lax`))
    return { ok: true, locked: false, bootstrapped: true, reachable: true, demo: true, install: INSTALL_URL, user: { email: DEMO_OWNER.email, role: DEMO_OWNER.role } }
  })

  // The master-password prompt: any password "confirms", for five minutes, held only in the visitor's cookie.
  app.post('/api/auth/reconfirm', async (_req, reply) => {
    const until = Date.now() + RECONFIRM_SECONDS * 1000
    reply.header('Set-Cookie', cookie(`${RECONFIRM_COOKIE}=1; Path=/; Max-Age=${RECONFIRM_SECONDS}; HttpOnly; SameSite=Strict`))
    return { ok: true, demo: true, until }
  })

  app.get('/health', async () => ({ status: 'ok', demo: true, version: 'demo', uptime: process.uptime(), ts: new Date().toISOString() }))

  // Every other request: a read from the fixtures, a preview from the fixtures, a page, or a refusal.
  app.route({
    method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    url: '/*',
    handler: async (req, reply) => {
      const method = req.method.toUpperCase()
      const url = new URL(req.url, 'http://demo.invalid')
      const api = url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')

      if (!api) {
        if (!pub) return reply.status(404).send({ ok: false, success: false, demo: true, error: 'Not part of the demo.' })
        if (method !== 'GET' && method !== 'HEAD') return reply.status(405).header('Allow', 'GET, HEAD').send({ ok: false, demo: true, error: 'Pages are read-only.' })
        return forwardToWeb(req, reply, pub)
      }

      if (method === 'OPTIONS') return reply.status(204).send()
      if (url.pathname.startsWith('/ws')) return refuse(reply)

      if (isWrite(method)) {
        // Ask for the master password exactly where the real product would, then refuse kindly.
        if (needsReconfirm(method, url.pathname) && !hasCookie(req.headers.cookie, RECONFIRM_COOKIE, '1')) {
          return reply.status(403).send({ ok: false, code: 'reconfirm_required', error: 'Re-enter your master password to continue', demo: true })
        }
        const preview = method === 'POST' ? matchFixture(table, url.pathname, 'POST') : null
        if (preview) return reply.send(preview.route.post!(preview.params, Object.fromEntries(url.searchParams), { cluster: clusterOf(req) }))
        return refuse(reply)
      }

      const hit = matchFixture(table, url.pathname)
      if (!hit) return reply.status(404).send({ ok: false, success: false, demo: true, error: 'Not part of the demo.' })
      if (hit.route.refuse) return refuse(reply)
      const body = hit.route.get!(hit.params, Object.fromEntries(url.searchParams), { cluster: clusterOf(req) })
      if (body === NOT_FOUND) return reply.status(404).send({ ok: false, success: false, demo: true, error: 'Not part of the demo.' })
      return reply.send(body)
    },
  })

  await app.ready()
  return app
}

function clusterOf(req: FastifyRequest): string | null {
  const h = req.headers['x-hyperprox-cluster']
  return typeof h === 'string' && /^c[0-9a-f]{10}$/.test(h) ? h : null
}

/** Per-address counts in one-minute windows, holding at most `cap` addresses (all are dropped when it is full). */
class MissCounter {
  private counts = new Map<string, number>()
  private timer: NodeJS.Timeout
  constructor(private max: number, private cap: number) {
    this.timer = setInterval(() => this.counts.clear(), 60_000)
    this.timer.unref()
  }
  add(ip: string) {
    if (!this.counts.has(ip) && this.counts.size >= this.cap) this.counts.clear()
    this.counts.set(ip, (this.counts.get(ip) ?? 0) + 1)
  }
  over(ip: string) { return (this.counts.get(ip) ?? 0) >= this.max }
  stop() { clearInterval(this.timer) }
}
