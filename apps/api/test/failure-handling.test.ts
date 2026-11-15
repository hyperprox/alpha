// One way to answer a failed request (lib/failure.ts): a plain sentence, a code and the request id for the person;
// the error with its stack, the route and the request id in the log. Never the error's own text for a 5xx.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'
import { classifyFailure, describeFailure, sendFailure, MESSAGES } from '../src/lib/failure'
import { registerGate } from '../src/lib/gate'
import { serverOptions, safeErr } from '../src/lib/server-options'
import { genReqId } from '../src/lib/request-id'
import { checkDatabase, healthRoute } from '../src/routes/health'
import { settingsValueProblem, SETTING_MAX_LENGTH } from '../src/routes/settings'
import { ProxmoxAuthError, ProxmoxUnreachableError } from '../src/lib/proxmox-client'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Errors shaped like the libraries' own, by class name (that is all the classifier looks at).
class PrismaClientKnownRequestError extends Error { constructor(m: string, public code: string) { super(m) } }
class PrismaClientInitializationError extends Error { errorCode?: string }
class SiteDeleteRefusal extends Error { constructor(m: string, public status = 409, public code = 'site_busy') { super(m) } }
class SomeInputError extends Error {}

test('classify: the database not answering is 503 in words, never Prisma text', () => {
  for (const e of [
    new PrismaClientKnownRequestError("Can't reach database server at `db:5432`", 'P1001'),
    new PrismaClientKnownRequestError('Server has closed the connection.', 'P1017'),
    new PrismaClientKnownRequestError('Timed out fetching a new connection from the connection pool.', 'P2024'),
    new PrismaClientInitializationError("Can't reach database server"),
  ]) {
    const c = classifyFailure(e)
    assert.equal(c.status, 503, e.message)
    assert.equal(c.body.code, 'db_unavailable')
    assert.equal(c.body.error, MESSAGES.database)
  }
  const other = classifyFailure(new PrismaClientKnownRequestError('Unique constraint failed on the fields: (`name`)', 'P2002'), 'Could not save.')
  assert.equal(other.status, 500)
  assert.equal(other.body.error, 'Could not save.')
})

test('classify: request shape errors from Fastify', () => {
  const fst = (code: string, statusCode: number) => Object.assign(new Error(`raw ${code}`), { code, statusCode })
  assert.deepEqual([classifyFailure(fst('FST_ERR_CTP_INVALID_JSON', 400)).status, classifyFailure(fst('FST_ERR_CTP_INVALID_JSON', 400)).body.error], [400, MESSAGES.invalid])
  assert.equal(classifyFailure(fst('FST_ERR_CTP_EMPTY_JSON_BODY', 400)).status, 400)
  assert.deepEqual([classifyFailure(fst('FST_ERR_CTP_BODY_TOO_LARGE', 413)).status, classifyFailure(fst('FST_ERR_CTP_BODY_TOO_LARGE', 413)).body.error], [413, MESSAGES.tooLarge])
  assert.equal(classifyFailure(fst('FST_ERR_CTP_INVALID_MEDIA_TYPE', 415)).status, 415)
  assert.equal(classifyFailure(Object.assign(new Error('Rate limit exceeded, retry in 1 minute'), { statusCode: 429 })).status, 429)
})

test('classify: zod errors are 400 with the fields in plain text', () => {
  const r = z.object({ name: z.string(), port: z.number() }).safeParse({ port: 'x' })
  assert.equal(r.success, false)
  const c = classifyFailure((r as any).error)
  assert.equal(c.status, 400)
  assert.deepEqual(c.body.fields!.map(f => f.field), ['name', 'port'])
  assert.match(c.body.error, /^That request was not valid\. name: .+; port: .+\.$/)
})

test("classify: HyperProx's own refusals keep their words and status", () => {
  const c = classifyFailure(new SiteDeleteRefusal('The site is being changed; try again when that finishes.'))
  assert.deepEqual([c.status, c.body.code, c.body.error], [409, 'site_busy', 'The site is being changed; try again when that finishes.'])
  const i = classifyFailure(new SomeInputError('The port must be a number.'))
  assert.deepEqual([i.status, i.body.error], [400, 'The port must be a number.'])
  const a = classifyFailure(new ProxmoxAuthError(401, 'authentication failure'))
  assert.deepEqual([a.status, a.body.code], [502, 'proxmox_auth'])
  assert.match(a.body.error, /Proxmox refused HyperProx's access key/)
  assert.equal(classifyFailure(new ProxmoxUnreachableError(new Error('connect ETIMEDOUT'))).body.code, 'proxmox_unreachable')
})

test('classify: anything else never shows its own text', () => {
  const secret = 'NPM POST /nginx/proxy-hosts failed 500: {"error":{"message":"internal","stack":"at /app/x.js:1:1"}}'
  const c = classifyFailure(new Error(secret))
  assert.equal(c.status, 500)
  assert.equal(c.body.error, MESSAGES.internal)
  assert.ok(!JSON.stringify(c.body).includes('nginx'))
  const conn = classifyFailure(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:81'), { code: 'ECONNREFUSED' }) }), 'The proxy did not answer.')
  assert.deepEqual([conn.status, conn.body.code, conn.body.error], [502, 'upstream_unreachable', 'The proxy did not answer.'])
})

test('describeFailure: an admin may get the detail where the route allows it; nobody else', () => {
  const logs: unknown[] = []
  const log = { info: () => undefined, error: (o: unknown) => logs.push(o) }
  const req = (role?: string) => ({ id: 'r-1', method: 'GET', url: '/api/x', routeOptions: { url: '/api/x' }, log, session: role ? { email: 'a@example.com', role } : undefined }) as any
  const e = new Error('upstream said: 500 bad gateway')
  assert.equal(describeFailure(req('admin'), e, undefined, { adminDetail: true }).body.detail, 'upstream said: 500 bad gateway')
  assert.equal(describeFailure(req('viewer'), e, undefined, { adminDetail: true }).body.detail, undefined)
  assert.equal(describeFailure(req('admin'), e).body.detail, undefined)
  assert.equal(describeFailure(req('admin'), e).body.requestId, 'r-1')
  assert.equal((logs[0] as any).route, 'GET /api/x')
  assert.equal((logs[0] as any).user, 'a@example.com')
})

// ---- through a real server: the error handler, sendFailure, request ids, the log ------------------------------

const lines: any[] = []
const sink = new Writable({ write(chunk, _enc, cb) { for (const l of String(chunk).split('\n')) if (l) lines.push(JSON.parse(l)); cb() } })
let app: FastifyInstance
async function build() {
  app = Fastify(serverOptions({ level: 'info', stream: sink }) as any)
  await registerGate(app)
  // /health/* needs no session and passes the lock: a place for routes that fail on purpose.
  await app.register(async (f) => {
    f.get('/boom', async () => { throw new Error('password=hunter2 leaked by an upstream body') })
    f.get('/db', async () => { throw new PrismaClientKnownRequestError("Can't reach database server", 'P1001') })
    f.post('/echo', { bodyLimit: 64 }, async (req) => ({ ok: true, got: req.body }))
    f.get('/route-catch', async (req, reply) => {
      try { throw new Error('GoDaddy said 422 {"code":"INVALID_BODY"}') } catch (e) { return sendFailure(req, reply, e, 'The DNS provider did not accept that.') }
    })
  }, { prefix: '/health/t' })
  await app.register(healthRoute, { prefix: '/health', dbQuery: async () => 1 })
  await app.ready()
}
const ready = build()
after(async () => { await app?.close() })

test('server: an unknown error is 500 in words with a reference; the log has the stack, never the reply', async () => {
  await ready
  const r = await app.inject({ method: 'GET', url: '/health/t/boom' })
  assert.equal(r.statusCode, 500)
  const body = r.json()
  assert.equal(body.error, MESSAGES.internal)
  assert.equal(body.ok, false)
  assert.match(body.requestId, UUID)
  assert.equal(r.headers['x-request-id'], body.requestId)
  assert.ok(!r.body.includes('hunter2'))
  const line = lines.find(l => l.reqId === body.requestId && l.msg === 'request failed: internal')
  assert.ok(line, 'the failure is logged under the request id')
  assert.equal(line.level, 50)
  assert.match(line.err.stack, /Error: password=hunter2/)
  assert.equal(line.route, 'GET /health/t/boom')
})

test('server: the database down, a bad body, a too-large body, an unknown media type', async () => {
  await ready
  const db = await app.inject({ method: 'GET', url: '/health/t/db' })
  assert.deepEqual([db.statusCode, db.json().code, db.json().error], [503, 'db_unavailable', MESSAGES.database])
  const bad = await app.inject({ method: 'POST', url: '/health/t/echo', headers: { 'content-type': 'application/json' }, payload: '{"a":' })
  assert.deepEqual([bad.statusCode, bad.json().error], [400, MESSAGES.invalid])
  assert.match(bad.json().requestId, UUID)
  const big = await app.inject({ method: 'POST', url: '/health/t/echo', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ a: 'x'.repeat(200) }) })
  assert.deepEqual([big.statusCode, big.json().error], [413, MESSAGES.tooLarge])
  const media = await app.inject({ method: 'POST', url: '/health/t/echo', headers: { 'content-type': 'application/x-strange' }, payload: 'x' })
  assert.equal(media.statusCode, 415)
  assert.equal(media.json().code, 'unsupported_media_type')
})

test('server: a route catch answers with its own sentence; the upstream text stays in the log', async () => {
  await ready
  const r = await app.inject({ method: 'GET', url: '/health/t/route-catch' })
  assert.equal(r.statusCode, 500)
  assert.equal(r.json().error, 'The DNS provider did not accept that.')
  assert.ok(!r.body.includes('INVALID_BODY'))
  assert.ok(lines.some(l => l.reqId === r.json().requestId && /INVALID_BODY/.test(l.err?.message ?? '')))
})

test('request ids: random per request; nginx id trusted only from loopback; a client header ignored', async () => {
  await ready
  const a = await app.inject({ method: 'GET', url: '/health' })
  const b = await app.inject({ method: 'GET', url: '/health' })
  assert.match(String(a.headers['x-request-id']), UUID)
  assert.notEqual(a.headers['x-request-id'], b.headers['x-request-id'])
  const nginxId = 'a'.repeat(32)
  const viaNginx = await app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': nginxId } })
  assert.equal(viaNginx.headers['x-request-id'], nginxId)
  const forged = await app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'evil-id' } })
  assert.match(String(forged.headers['x-request-id']), UUID)
  const remote = genReqId({ headers: { 'x-request-id': nginxId }, socket: { remoteAddress: '192.0.2.7' } } as any)
  assert.match(remote, UUID)
})

test('health: db ok or down, no reason in the answer', async () => {
  await ready
  const r = await app.inject({ method: 'GET', url: '/health' })
  assert.equal(r.json().db, 'ok')
  assert.equal(r.json().status, 'ok')
  let reason = ''
  assert.equal(await checkDatabase(async () => { throw new Error('connection refused') }, 50, e => { reason = (e as Error).message }), 'down')
  assert.equal(reason, 'connection refused')
  const t0 = Date.now()
  assert.equal(await checkDatabase(() => new Promise(() => undefined), 60), 'down')
  assert.ok(Date.now() - t0 < 1000)
  assert.equal(await checkDatabase(null), 'down')
  const down = Fastify()
  await down.register(healthRoute, { prefix: '/health', dbQuery: async () => { throw new Error('ECONNREFUSED db:5432') } })
  const d = await down.inject({ method: 'GET', url: '/health' })
  assert.equal(d.json().db, 'down')
  assert.ok(!d.body.includes('ECONNREFUSED'))
  await down.close()
})

test('settings: a credential value is text, at most 4096 characters, no control characters', () => {
  assert.equal(settingsValueProblem({ host: '192.0.2.10', token_secret: 'abc-123' }), null)
  assert.match(settingsValueProblem({ token_secret: 'x'.repeat(SETTING_MAX_LENGTH + 1) })!, /too long/)
  assert.match(settingsValueProblem({ token_secret: 'abc\ndef' })!, /line break/)
  assert.match(settingsValueProblem({ token_secret: 'abc\u0000' })!, /control character/)
  assert.equal(settingsValueProblem({ port: 8006 as any }), 'Every setting must be text')
})

test('safeErr keeps an AggregateError\'s first errors (message and code only)', () => {
  const inner = Array.from({ length: 7 }, (_, i) => Object.assign(new Error(`connect ECONNREFUSED 192.0.2.${i}:8006`), { code: 'ECONNREFUSED', config: { headers: { authorization: 'secret' } } }))
  const out = safeErr(new AggregateError(inner, 'all addresses failed')) as any
  assert.equal(out.errors.length, 5)
  assert.deepEqual(out.errors[0], { message: 'connect ECONNREFUSED 192.0.2.0:8006', code: 'ECONNREFUSED' })
  assert.equal(out.moreErrors, 2)
  assert.ok(!JSON.stringify(out).includes('secret'))
})

test('setup wizard: a 403 from Proxmox while making the monitoring account is explained, not quoted', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const setup = require('../../setup/setup.js')
  const t = setup.exporterErrorText(Object.assign(new Error('PVE 403: {"data":null,"errors":{"userid":"Permission check failed"}}'), { status: 403 }))
  assert.equal(t, "This token can't create the monitoring account it needs. Give it the PVEAdmin role, or paste a token that has it.")
  assert.equal(setup.exporterErrorText(new Error('PVE 403: {"data":null}')), t)
  assert.ok(!setup.exporterErrorText(new Error('PVE 500: {"data":null,"message":"boom"}')).includes('{'))
})
