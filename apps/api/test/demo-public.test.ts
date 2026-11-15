// The public demo (HYPERPROX_DEMO_PUBLIC=1): what it adds for the open internet.
//
//  1. Start-up guard: public mode needs an explicit listen address, never takes a real port, and refuses a
//     checkout that holds a real install's .env.
//  2. A per-address rate limit, with a smaller bucket for changes; the address comes from X-Forwarded-For
//     only when the request arrives from a named proxy.
//  3. Security headers on every answer, API or page.
//  4. Size limits: bodies and addresses.
//  5. Pages are passed to the demo frontend on loopback, read-only, with only the headers a browser needs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import { buildDemoServer, canonical, DEMO_MESSAGE } from '../src/demo/server'
import { checkDemoEnvironment, DemoRefused, type PublicConfig } from '../src/demo/safety'

function fakeRoot(withEnv: string | null): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-demo-root-'))
  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
  if (withEnv !== null) fs.writeFileSync(path.join(root, '.env'), withEnv)
  return root
}

test('public guard: needs a listen address, refuses real ports, a real .env and bad proxies; names no values', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-demo-pub-'))
  const root = fakeRoot(null)
  const ok = { HYPERPROX_DEMO: '1', HYPERPROX_DEMO_DATA: path.join(tmp, 'd'), HYPERPROX_DEMO_PUBLIC: '1', HYPERPROX_DEMO_LISTEN: '10.0.0.50:8080' }
  const cfg = checkDemoEnvironment(ok, root)
  assert.deepEqual(cfg.public, { listenHost: '10.0.0.50', listenPort: 8080, webPort: 3100, trustedProxies: [] })
  // Without the public flag, nothing public is configured and the API stays on loopback.
  assert.equal(checkDemoEnvironment({ ...ok, HYPERPROX_DEMO_PUBLIC: undefined }, root).public, null)
  assert.throws(() => checkDemoEnvironment({ ...ok, HYPERPROX_DEMO_PUBLIC: 'yes' }, root), DemoRefused)
  for (const listen of [undefined, '', '8080', 'example.com:8080', '10.0.0.50:3002', '10.0.0.50:3000', '10.0.0.50:80', '10.0.0.50:x']) {
    assert.throws(() => checkDemoEnvironment({ ...ok, HYPERPROX_DEMO_LISTEN: listen }, root), DemoRefused, String(listen))
  }
  assert.throws(() => checkDemoEnvironment({ ...ok, HYPERPROX_DEMO_WEB_PORT: '3002' }, root), DemoRefused)
  assert.throws(() => checkDemoEnvironment({ ...ok, HYPERPROX_DEMO_WEB_PORT: '8080' }, root), DemoRefused)
  assert.throws(() => checkDemoEnvironment({ ...ok, HYPERPROX_DEMO_TRUSTED_PROXIES: '10.0.0.1,proxy.example.com' }, root), DemoRefused)
  assert.deepEqual(checkDemoEnvironment({ ...ok, HYPERPROX_DEMO_TRUSTED_PROXIES: '10.0.0.1, 10.0.0.2' }, root).public!.trustedProxies, ['10.0.0.1', '10.0.0.2'])
  // A real install's settings in the environment still refuse, public or not.
  assert.throws(() => checkDemoEnvironment({ ...ok, DATABASE_URL: 'postgres://u:hunter2@db/x' }, root), (e: Error) => e instanceof DemoRefused && !e.message.includes('hunter2'))
  // A checkout with a real .env: the local demo may run there (from a clean environment), the public one may not.
  const real = fakeRoot('DATABASE_URL=postgres://u:hunter2@db/x\n')
  assert.ok(checkDemoEnvironment({ ...ok, HYPERPROX_DEMO_PUBLIC: undefined }, real))
  assert.throws(() => checkDemoEnvironment(ok, real), (e: Error) => e instanceof DemoRefused && /\.env/.test(e.message) && !e.message.includes('hunter2'))
  // An empty .env (a fresh clone's placeholder) is not an install.
  assert.ok(checkDemoEnvironment(ok, fakeRoot('')).public)
  for (const d of [tmp, root, real]) fs.rmSync(d, { recursive: true, force: true })
})

const PUB = (over: Partial<PublicConfig> = {}): PublicConfig => ({ listenHost: '127.0.0.1', listenPort: 8080, webPort: 1, trustedProxies: [], ...over })

test('rate limit: per address, a smaller bucket for changes, and 429 with a plain message', async () => {
  const app = await buildDemoServer({ public: PUB(), limits: { perMinute: 5, writesPerMinute: 2 } })
  try {
    const codes: number[] = []
    for (let i = 0; i < 7; i++) codes.push((await app.inject({ method: 'GET', url: '/api/proxmox/nodes', remoteAddress: '10.0.0.7' })).statusCode)
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429])
    const limited = await app.inject({ method: 'GET', url: '/api/proxmox/nodes', remoteAddress: '10.0.0.7' })
    assert.equal(limited.json().code, 'rate_limited'); assert.match(limited.json().error, /Too many requests/)
    // The frontend's static files do not count, even past the limit; pages and the API do.
    assert.equal((await app.inject({ method: 'GET', url: '/_next/static/chunks/main.js', remoteAddress: '10.0.0.7' })).statusCode, 502)
    assert.equal((await app.inject({ method: 'GET', url: '/dashboard', remoteAddress: '10.0.0.7' })).statusCode, 429)
    // Another address has its own budget.
    assert.equal((await app.inject({ method: 'GET', url: '/api/proxmox/nodes', remoteAddress: '10.0.0.8' })).statusCode, 200)
    // Changes: their own, smaller bucket.
    const w: number[] = []
    for (let i = 0; i < 3; i++) w.push((await app.inject({ method: 'POST', url: '/api/updates/jobs', payload: {}, remoteAddress: '10.0.0.9' })).statusCode)
    assert.deepEqual(w, [403, 403, 429])
    // X-Forwarded-For is ignored from anyone but a named proxy: it cannot be used to dodge the limit.
    for (let i = 0; i < 5; i++) await app.inject({ method: 'GET', url: '/health', remoteAddress: '10.0.0.10', headers: { 'x-forwarded-for': `198.51.100.${i}` } })
    assert.equal((await app.inject({ method: 'GET', url: '/health', remoteAddress: '10.0.0.10', headers: { 'x-forwarded-for': '198.51.100.99' } })).statusCode, 429)
  } finally { await app.close() }
})

const raw = (port: number, path: string) => new Promise<number>((resolve, reject) =>
  http.get({ host: '127.0.0.1', port, path }, res => { res.resume(); resolve(res.statusCode ?? 0) }).on('error', reject))

test('paths: only one spelling of a path is served; dot segments, encoded dots and backslashes are refused raw', async () => {
  const seen: string[] = []
  const web = http.createServer((req, res) => { seen.push(req.url ?? ''); res.end('page') })
  await new Promise<void>(r => web.listen(0, '127.0.0.1', r))
  const app = await buildDemoServer({ public: PUB({ webPort: (web.address() as net.AddressInfo).port }) })
  await app.listen({ port: 0, host: '127.0.0.1' })
  try {
    const port = (app.server.address() as net.AddressInfo).port
    // Sent raw: a browser or light-my-request would tidy these away first.
    for (const p of ['/api/../dashboard', '/_next/static/../../api/proxmox/nodes', '/%2e%2e/dashboard', '/api/%2E%2E/x', '/a\\b', '/a%5cb', '/api%2fproxmox', '//example.com/x', '/./dashboard']) {
      assert.equal(await raw(port, p), 400, p)
    }
    assert.deepEqual(seen, [], 'none of them reached the frontend')
    assert.equal(await raw(port, '/dashboard?tab=a%20b'), 200)
    assert.deepEqual(seen, ['/dashboard?tab=a%20b'])
  } finally { await app.close(); web.close() }
})

test('canonical(): the check itself', () => {
  for (const p of ['/', '/dashboard', '/api/proxmox/nodes?x=1', '/_next/static/chunks/a-1.js', '/plugins/home-assistant']) assert.equal(canonical(p), true, p)
  for (const p of ['', 'x', '/..', '/a/../b', '/a/./b', '/%2e/', '/a\\b', '//host/x', '/a%2Fb']) assert.equal(canonical(p), false, p)
})

test('rate limit: keyed on the address the proxy saw (rightmost X-Forwarded-For); X-Real-IP and earlier entries are ignored', async () => {
  const app = await buildDemoServer({ public: PUB({ trustedProxies: ['10.0.0.2'] }), limits: { perMinute: 2 } })
  try {
    const get = (headers: Record<string, string>) => app.inject({ method: 'GET', url: '/health', remoteAddress: '10.0.0.2', headers })
    assert.equal((await get({ 'x-forwarded-for': '198.51.100.5', 'x-real-ip': '203.0.113.1' })).statusCode, 200)
    assert.equal((await get({ 'x-forwarded-for': '203.0.113.9, 198.51.100.5', 'x-real-ip': '203.0.113.2' })).statusCode, 200)
    assert.equal((await get({ 'x-forwarded-for': '203.0.113.10, 198.51.100.5', 'x-real-ip': '203.0.113.3' })).statusCode, 429)
  } finally { await app.close() }
})

test('rate limit: static paths are free only while they are files; misses count, then everything counts', async () => {
  const web = http.createServer((req, res) => { if (req.url?.includes('missing')) { res.statusCode = 404 } res.end('x') })
  await new Promise<void>(r => web.listen(0, '127.0.0.1', r))
  const app = await buildDemoServer({ public: PUB({ webPort: (web.address() as net.AddressInfo).port }), limits: { perMinute: 3, writesPerMinute: 2 } })
  try {
    const get = (url: string) => app.inject({ method: 'GET', url, remoteAddress: '10.0.2.1' }).then(r => r.statusCode)
    // Real files: never counted.
    for (let i = 0; i < 6; i++) assert.equal(await get('/_next/static/chunks/real.js'), 200)
    // Misses: free until the change budget (2) is used, then counted like any request (3 a minute).
    const codes: number[] = []
    for (let i = 0; i < 7; i++) codes.push(await get(`/_next/static/missing-${i}.js`))
    assert.deepEqual(codes, [404, 404, 404, 404, 404, 429, 429])
    // Another address is untouched.
    assert.equal(await app.inject({ method: 'GET', url: '/_next/static/missing.js', remoteAddress: '10.0.2.2' }).then(r => r.statusCode), 404)
  } finally { await app.close(); web.close() }
})

test('errors: unknown ids are 404, and no error text from the code reaches a visitor', async () => {
  const app = await buildDemoServer({ public: PUB() })
  try {
    for (const url of ['/api/storage/nodes/no-such-node', '/api/infra/guest-config/nodes/no-such-node/devices']) {
      const res = await app.inject({ method: 'GET', url })
      assert.equal(res.statusCode, 404, url); assert.equal(res.json().error, 'Not part of the demo.')
    }
    assert.equal((await app.inject({ method: 'GET', url: '/api/storage/nodes/pve-a' })).statusCode, 200)
    const big = await app.inject({ method: 'POST', url: '/api/secrets', payload: 'x'.repeat(70 * 1024), headers: { 'content-type': 'text/plain' } })
    assert.equal(big.statusCode, 413); assert.doesNotMatch(big.body, /at |Error|stack/)
    const bad = await app.inject({ method: 'POST', url: '/api/updates/jobs', payload: '{', headers: { 'content-type': 'application/json' } })
    assert.doesNotMatch(bad.body, /Unexpected|JSON|at /)
  } finally { await app.close() }
})

test('cookies are Secure in public mode (behind HTTPS) and not in the local demo; one HSTS policy, the proxy\'s', async () => {
  const pub = await buildDemoServer({ public: PUB() })
  const local = await buildDemoServer()
  try {
    for (const [app, secure] of [[pub, true], [local, false]] as const) {
      const st = await app.inject({ method: 'GET', url: '/api/auth/status' })
      const rc = await app.inject({ method: 'POST', url: '/api/auth/reconfirm', payload: {} })
      const si = await app.inject({ method: 'POST', url: '/api/auth/sign-in', payload: {} })
      for (const r of [st, rc, si]) assert.equal(/;\s*Secure/.test(String(r.headers['set-cookie'])), secure, String(r.headers['set-cookie']))
      assert.equal(st.headers['strict-transport-security'], undefined)
    }
  } finally { await pub.close(); await local.close() }
})

test('rate limit: behind a named proxy, each visitor (X-Forwarded-For) has their own budget', async () => {
  const app = await buildDemoServer({ public: PUB({ trustedProxies: ['10.0.0.2'] }), limits: { perMinute: 2 } })
  try {
    const get = (visitor: string) => app.inject({ method: 'GET', url: '/health', remoteAddress: '10.0.0.2', headers: { 'x-forwarded-for': visitor } })
    assert.equal((await get('198.51.100.1')).statusCode, 200)
    assert.equal((await get('198.51.100.1')).statusCode, 200)
    assert.equal((await get('198.51.100.1')).statusCode, 429)
    assert.equal((await get('198.51.100.2')).statusCode, 200)
  } finally { await app.close() }
})

test('rate limit: the address table is capped, so a flood of addresses cannot grow memory without bound', async () => {
  const app = await buildDemoServer({ public: PUB(), limits: { perMinute: 1, trackedAddresses: 3 } })
  try {
    // Four addresses in a table of three: the first is forgotten, so it gets a fresh budget instead of more memory.
    for (const ip of ['10.0.1.1', '10.0.1.2', '10.0.1.3', '10.0.1.4']) assert.equal((await app.inject({ method: 'GET', url: '/health', remoteAddress: ip })).statusCode, 200)
    assert.equal((await app.inject({ method: 'GET', url: '/health', remoteAddress: '10.0.1.4' })).statusCode, 429)
    assert.equal((await app.inject({ method: 'GET', url: '/health', remoteAddress: '10.0.1.1' })).statusCode, 200)
  } finally { await app.close() }
})

test('security headers on every answer; API answers are never cached', async () => {
  const app = await buildDemoServer({ public: PUB() })
  try {
    for (const [method, url] of [['GET', '/api/proxmox/nodes'], ['POST', '/api/secrets'], ['GET', '/api/not-a-route'], ['GET', '/health']] as const) {
      const res = await app.inject({ method, url, payload: method === 'POST' ? {} : undefined })
      const csp = String(res.headers['content-security-policy'])
      assert.match(csp, /default-src 'self'/, url); assert.match(csp, /connect-src 'self'/, url); assert.match(csp, /frame-ancestors 'none'/, url)
      assert.doesNotMatch(csp, /https?:/, `${url}: the policy names no other site`)
      assert.equal(res.headers['x-content-type-options'], 'nosniff')
      assert.equal(res.headers['x-frame-options'], 'DENY')
      assert.equal(res.headers['referrer-policy'], 'no-referrer')
      assert.ok(res.headers['permissions-policy'])
      assert.equal(res.headers['cache-control'], 'no-store', url)
    }
  } finally { await app.close() }
})

test('size limits: a large body is refused with 413 and an over-long address with 414, before any handler', async () => {
  const app = await buildDemoServer({ public: PUB() })
  try {
    const big = 'x'.repeat(70 * 1024)
    const res = await app.inject({ method: 'POST', url: '/api/secrets', payload: big, headers: { 'content-type': 'text/plain' } })
    assert.equal(res.statusCode, 413)
    assert.equal((await app.inject({ method: 'GET', url: '/api/proxmox/nodes?q=' + 'a'.repeat(3000) })).statusCode, 414)
    // A body just under the limit is read, thrown away, and the change refused as usual.
    const small = await app.inject({ method: 'POST', url: '/api/updates/jobs', payload: 'x'.repeat(1024), headers: { 'content-type': 'text/plain' } })
    assert.equal(small.statusCode, 403); assert.equal(small.json().error, DEMO_MESSAGE)
  } finally { await app.close() }
})

test('a chunked body over the limit (no Content-Length) is cut off with 413', async () => {
  const app = await buildDemoServer({ public: PUB() })
  await app.listen({ port: 0, host: '127.0.0.1' })
  try {
    const port = (app.server.address() as net.AddressInfo).port
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/secrets', headers: { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' } }, res => { res.resume(); resolve(res.statusCode ?? 0) })
      req.on('error', e => (e as NodeJS.ErrnoException).code === 'ECONNRESET' || (e as NodeJS.ErrnoException).code === 'EPIPE' ? resolve(413) : reject(e))
      for (let i = 0; i < 80; i++) req.write('y'.repeat(1024))
      req.end()
    })
    assert.equal(status, 413)
  } finally { await app.close() }
})

test('pages: passed to the frontend on loopback, read-only, with only browser headers', async () => {
  const seen: http.IncomingHttpHeaders[] = []
  const web = http.createServer((req, res) => {
    seen.push(req.headers)
    res.setHeader('x-powered-by', 'Next.js'); res.setHeader('content-type', 'text/html'); res.setHeader('cache-control', 'public, max-age=31536000, immutable')
    res.end(`<html>page ${req.url}</html>`)
  })
  await new Promise<void>(r => web.listen(0, '127.0.0.1', r))
  const webPort = (web.address() as net.AddressInfo).port
  const app = await buildDemoServer({ public: PUB({ webPort }) })
  try {
    const res = await app.inject({ method: 'GET', url: '/_next/static/chunk.js', headers: { host: 'demo.example.com', authorization: 'Basic eDp5', 'x-forwarded-for': '203.0.113.9', cookie: 'a=b', 'accept-language': 'en' } })
    assert.equal(res.statusCode, 200); assert.equal(res.body, '<html>page /_next/static/chunk.js</html>')
    assert.equal(res.headers['x-powered-by'], undefined)
    assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable', 'the frontend keeps its own caching for pages')
    assert.match(String(res.headers['content-security-policy']), /default-src 'self'/)
    const h = seen[0]
    assert.equal(h.authorization, undefined, 'credentials a visitor sends are not passed on')
    assert.equal(h['x-forwarded-host'], 'demo.example.com'); assert.equal(h['x-forwarded-for'], '127.0.0.1', 'the visitor as this server saw them, not as they claimed')
    assert.equal(h.cookie, 'a=b'); assert.equal(h['accept-language'], 'en')
    // Pages are read-only, and the API is never passed to the frontend.
    assert.equal((await app.inject({ method: 'POST', url: '/dashboard', payload: {} })).statusCode, 405)
    assert.equal((await app.inject({ method: 'GET', url: '/api/not-a-route' })).statusCode, 404)
    assert.equal(seen.length, 1)
    // Without public mode, there are no pages here at all.
    const local = await buildDemoServer()
    try { assert.equal((await local.inject({ method: 'GET', url: '/dashboard' })).statusCode, 404) } finally { await local.close() }
  } finally { await app.close(); web.close() }
})

test('pages: a frontend that is down answers 502 with a plain message', async () => {
  const app = await buildDemoServer({ public: PUB({ webPort: 1 }) })
  try {
    const res = await app.inject({ method: 'GET', url: '/dashboard' })
    assert.equal(res.statusCode, 502); assert.match(res.json().error, /starting up/)
  } finally { await app.close() }
})
