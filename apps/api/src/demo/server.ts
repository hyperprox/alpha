// =============================================================================
//  HyperProx demo mode — the API
//
//  A Fastify server that shares no code with the real API's routes, gate, vault,
//  credential store or database. Every GET the frontend makes is answered from the
//  invented fixtures in ./fixtures; every other method, every websocket and every
//  terminal is refused with a "This is a demo" message, here in the API, so the
//  refusal does not depend on the UI hiding a button.
//
//  The one write-shaped request it accepts is sign-in, which checks nothing and only
//  sets a cookie the demo frontend's middleware looks for: there is no account to
//  sign in to.
// =============================================================================

import Fastify, { type FastifyInstance } from 'fastify'
import { FIXTURES, type FixtureRoute } from './fixtures'
import { DEMO_OWNER } from './fixtures/data'

export const DEMO_MESSAGE = 'This is a demo: nothing here can be changed, revealed, sent or run.'
export const DEMO_REFUSAL = { ok: false, success: false, demo: true, code: 'demo', error: DEMO_MESSAGE, message: DEMO_MESSAGE } as const
const SESSION_COOKIE = 'hyperprox_token'
const SESSION_VALUE = 'demo-session'

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

export function matchFixture(table: Compiled[], pathname: string): { route: FixtureRoute; params: Record<string, string> } | null {
  for (const c of table) {
    const m = c.re.exec(pathname)
    if (!m) continue
    const params: Record<string, string> = {}
    c.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]) })
    return { route: c.route, params }
  }
  return null
}

function signedIn(cookie: string | undefined): boolean {
  return !!cookie && cookie.split(';').some(p => p.trim() === `${SESSION_COOKIE}=${SESSION_VALUE}`)
}

export async function buildDemoServer(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false })
  const table = FIXTURES.map(compile)

  // Whatever a write sends is never read: accept any body type so the refusal, not a 415, is the answer.
  app.removeAllContentTypeParsers()
  app.addContentTypeParser('*', (_req, payload, done) => { payload.resume(); payload.on('end', () => done(null, undefined)); payload.on('error', done) })

  // Websockets (the live feed, update logs, terminal shells): refused at the HTTP upgrade, before any socket opens.
  app.server.on('upgrade', (_req, socket) => {
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n' + DEMO_MESSAGE + '\n')
  })

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-HyperProx-Demo', '1')
    reply.header('Cache-Control', 'no-store')
    return payload
  })

  // Sign-in: no account, no check. It only sets the cookie the demo frontend's middleware wants to see.
  app.post('/api/auth/sign-in', async (_req, reply) => {
    reply.header('Set-Cookie', `${SESSION_COOKIE}=${SESSION_VALUE}; Path=/; HttpOnly; SameSite=Lax`)
    return { ok: true, demo: true, user: { email: DEMO_OWNER.email, role: DEMO_OWNER.role } }
  })

  app.get('/api/auth/status', async (req) => ({
    ok: true, locked: false, bootstrapped: true, reachable: true, demo: true,
    ...(signedIn(req.headers.cookie) ? { user: { email: DEMO_OWNER.email, role: DEMO_OWNER.role } } : {}),
  }))

  app.get('/health', async () => ({ status: 'ok', demo: true, version: 'demo', uptime: process.uptime(), ts: new Date().toISOString() }))

  // Every other request: GET from the fixtures, anything else refused.
  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    url: '/*',
    handler: async (req, reply) => {
      const method = req.method.toUpperCase()
      if (method === 'OPTIONS') return reply.status(204).send()
      if (method !== 'GET' && method !== 'HEAD') return reply.status(403).send(DEMO_REFUSAL)
      const url = new URL(req.url, 'http://demo.invalid')
      if (url.pathname.startsWith('/ws')) return reply.status(403).send(DEMO_REFUSAL)
      const hit = matchFixture(table, url.pathname)
      if (!hit) return reply.status(404).send({ ok: false, success: false, demo: true, error: 'Not part of the demo.' })
      if (hit.route.refuse) return reply.status(403).send(DEMO_REFUSAL)
      const cluster = typeof req.headers['x-hyperprox-cluster'] === 'string' ? req.headers['x-hyperprox-cluster'] : null
      const body = hit.route.get!(hit.params, Object.fromEntries(url.searchParams), { cluster })
      return reply.send(body)
    },
  })

  await app.ready()
  return app
}
