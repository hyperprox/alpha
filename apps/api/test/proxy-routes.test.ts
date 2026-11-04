// /api/proxy over HTTP behind the real vault gate: every route has a rule in roles.ts, viewers read but
// never write or see instance settings, admins preview and apply, secrets never come back.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { buildProxyRoutes } from '../src/routes/proxy'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { requiredRole, needsReconfirm } from '../src/lib/roles'
import { ProxyPlanner } from '../src/lib/proxy/plans'
import { FakeBroker } from './fakes/fake-broker'
import { signIn } from './fakes/app'
import { fixtureWorld } from './fakes/proxy-world'

const broker = new FakeBroker()
broker.addUser('admin@example.com', 'admin master password', 'admin')
broker.addUser('op@example.com', 'operator master password', 'operator')
broker.addUser('viewer@example.com', 'viewer master password', 'viewer')

const w = fixtureWorld()
const planner = new ProxyPlanner(w.service)
let app: FastifyInstance

before(async () => {
  setBroker(broker)
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  app = Fastify({ logger: false })
  await registerGate(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(buildProxyRoutes({ service: () => w.service, planner: () => planner }), { prefix: '/api/proxy' })
  await app.ready()
})
beforeEach(async () => { if (isUnlocked()) await lock('manual') })
after(async () => { if (isUnlocked()) await lock('manual'); await app.close() })

const B = '/api/proxy'
const READS: string[] = [`${B}/kinds`, `${B}/instances`, `${B}/hosts`, `${B}/certificates`, `${B}/stats`,
  `${B}/instances/npm/hosts`, `${B}/instances/npm/certificates`, `${B}/instances/npm/health`]
const WRITES: Array<[string, string]> = [
  ['POST', `${B}/instances`], ['PUT', `${B}/instances/npm`], ['DELETE', `${B}/instances/npm`],
  ['POST', `${B}/instances/npm/preview`], ['POST', `${B}/plans/x/apply`], ['POST', `${B}/instances/npm/certificates`],
]

test('roles.ts: every proxy read is viewer, every write admin, an unlisted GET admin', () => {
  for (const u of READS) assert.equal(requiredRole('GET', u), 'viewer', u)
  for (const [m, u] of WRITES) assert.equal(requiredRole(m, u), 'admin', `${m} ${u}`)
  assert.equal(requiredRole('GET', `${B}/instances/npm/secret-dump`), 'admin')
  assert.equal(requiredRole('GET', `${B}/plans/x`), 'admin')
  for (const [m, u] of WRITES) assert.equal(needsReconfirm(m, u), false)
})

test('locked: 423 everywhere', async () => {
  for (const u of READS) assert.equal((await app.inject({ method: 'GET', url: u })).statusCode, 423, u)
})

test('viewer and operator: read hosts with their instance; no settings; every write 403', async () => {
  for (const [email, pw] of [['viewer@example.com', 'viewer master password'], ['op@example.com', 'operator master password']]) {
    const { cookie } = await signIn(app, email, pw)
    const hosts = await app.inject({ method: 'GET', url: `${B}/hosts`, headers: { cookie } })
    assert.equal(hosts.statusCode, 200, hosts.body)
    assert.ok(hosts.json().data.hosts.every((h: any) => h.instanceId && h.instanceName))
    const inst = await app.inject({ method: 'GET', url: `${B}/instances`, headers: { cookie } })
    assert.deepEqual(Object.keys(inst.json().data[0]).sort(), ['id', 'kind', 'kindLabel', 'legacy', 'mode', 'name', 'status'])
    for (const [method, url] of WRITES) {
      const r = await app.inject({ method: method as any, url, headers: { cookie }, payload: method === 'DELETE' ? undefined : {} })
      assert.equal(r.statusCode, 403, `${email} ${method} ${url}`)
    }
  }
})

test('admin: add an instance, preview, apply, read back; refusals are 4xx with the reason; no secret echoed', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const add = await app.inject({ method: 'POST', url: `${B}/instances`, headers: { cookie }, payload: {
    kind: 'haproxy', name: 'edge', url: 'http://192.0.2.38:5555', settings: { user: 'hpx' }, secrets: { password: 'haproxy-test-password' } } })
  assert.equal(add.statusCode, 200, add.body)
  assert.equal(add.body.includes('haproxy-test-password'), false)
  const id = add.json().data.instance.id
  const list = await app.inject({ method: 'GET', url: `${B}/instances`, headers: { cookie } })
  assert.equal(list.json().data.find((i: any) => i.id === id).settings.user, 'hpx')
  assert.equal(list.body.includes('haproxy-test-password'), false)

  const bad = await app.inject({ method: 'POST', url: `${B}/instances/${id}/preview`, headers: { cookie }, payload: { action: 'create', host: { domains: ['*.x.invalid'], forwardHost: '192.0.2.1', forwardPort: 80 } } })
  assert.equal(bad.statusCode, 400)
  assert.match(bad.json().error, /wildcard/)
  const ro = (await app.inject({ method: 'GET', url: `${B}/instances/${id}/hosts`, headers: { cookie } })).json().data.find((h: any) => h.readOnly)
  const refused = await app.inject({ method: 'POST', url: `${B}/instances/${id}/preview`, headers: { cookie }, payload: { action: 'delete', hostId: ro.id } })
  assert.equal(refused.statusCode, 409)
  assert.match(refused.json().error, /read-only/)

  const prev = await app.inject({ method: 'POST', url: `${B}/instances/${id}/preview`, headers: { cookie }, payload: { action: 'create', host: { domains: ['routes.hpx.invalid'], forwardHost: '192.0.2.50', forwardPort: 9000 } } })
  assert.equal(prev.statusCode, 200, prev.body)
  const plan = prev.json().data
  assert.ok(plan.changes.length && plan.consequences.length)
  assert.equal('fingerprint' in plan, false)
  const ap = await app.inject({ method: 'POST', url: `${B}/plans/${plan.id}/apply`, headers: { cookie } })
  assert.equal(ap.statusCode, 200, ap.body)
  assert.equal(ap.json().data.ok, true)
  const again = await app.inject({ method: 'POST', url: `${B}/plans/${plan.id}/apply`, headers: { cookie } })
  assert.equal(again.statusCode, 410)
  const missing = await app.inject({ method: 'GET', url: `${B}/instances/px-0000000000/hosts`, headers: { cookie } })
  assert.equal(missing.statusCode, 404)
  const stats = (await app.inject({ method: 'GET', url: `${B}/stats`, headers: { cookie } })).json().data
  assert.equal(stats.instances, 2)
  assert.ok(stats.readOnly >= 1)
  const cert = await app.inject({ method: 'POST', url: `${B}/instances/${id}/certificates`, headers: { cookie }, payload: { domains: ['routes.hpx.invalid'], email: 'a@example.invalid' } })
  assert.equal(cert.statusCode, 400)
  assert.match(cert.json().error, /gets its own certificates/)
})

test('6: viewers get names, targets, status and the certificate name and expiry, nothing else; admins never get certificate meta', async () => {
  w.npm1.certs.push({ id: 6, nice_name: 'dns cert', domain_names: ['secret.hpx.invalid'], expires_on: '2027-01-01 00:00:00', provider: 'letsencrypt', meta: { dns_provider_credentials: 'dns_cloudflare_api_token = TOKEN-XYZ' } })
  w.npm1.hosts.push({ id: 60, domain_names: ['secret.hpx.invalid'], forward_scheme: 'http', forward_host: '192.0.2.61', forward_port: 80, certificate_id: 6, enabled: true,
    advanced_config: 'proxy_set_header Authorization "Bearer ADV-SECRET";', meta: { nginx_online: true }, access_list_id: 0, locations: [] })
  w.service.invalidate('npm')
  const viewer = (await signIn(app, 'viewer@example.com', 'viewer master password')).cookie
  for (const url of [`${B}/hosts`, `${B}/instances/npm/hosts`, `${B}/certificates`, `${B}/instances/npm/certificates`, `${B}/instances`, `${B}/instances/npm/health`]) {
    const r = await app.inject({ method: 'GET', url, headers: { cookie: viewer } })
    assert.equal(r.statusCode, 200, url)
    for (const secret of ['TOKEN-XYZ', 'ADV-SECRET', 'advanced_config', '"meta"', '"native"', '192.0.2.37:81', 'admin@example.invalid']) assert.equal(r.body.includes(secret), false, `${url} leaks ${secret}`)
  }
  const h = (await app.inject({ method: 'GET', url: `${B}/hosts`, headers: { cookie: viewer } })).json().data.hosts.find((x: any) => x.id === '60')
  assert.deepEqual(Object.keys(h).sort(), ['domains', 'enabled', 'forwardHost', 'forwardPort', 'forwardScheme', 'id', 'instanceId', 'instanceName', 'kind', 'online', 'readOnly', 'tls'])
  assert.deepEqual(h.tls, { kind: 'certificate', certificateName: 'dns cert', expiresAt: '2027-01-01 00:00:00' })
  const admin = (await signIn(app, 'admin@example.com', 'admin master password')).cookie
  for (const url of [`${B}/hosts`, `${B}/certificates`, `${B}/instances/npm/certificates`]) {
    const r = await app.inject({ method: 'GET', url, headers: { cookie: admin } })
    assert.equal(r.body.includes('TOKEN-XYZ'), false, `${url} gives admins the certificate meta`)
  }
})

test('10: a proxy’s own error text reaches admins, never viewers', async () => {
  const inner = w.npm1.fetch
  w.npm1.fetch = (async () => new Response('upstream said: internal-detail-123', { status: 500 })) as any
  w.service.invalidate('npm')
  try {
    const viewer = (await signIn(app, 'viewer@example.com', 'viewer master password')).cookie
    const v = await app.inject({ method: 'GET', url: `${B}/hosts`, headers: { cookie: viewer } })
    assert.deepEqual(v.json().data.errors.find((e: any) => e.instanceId === 'npm').error, 'not answering')
    const v2 = await app.inject({ method: 'GET', url: `${B}/instances/npm/hosts`, headers: { cookie: viewer } })
    assert.equal(v2.statusCode, 502)
    assert.equal(v2.body.includes('500'), false)
    w.service.invalidate('npm')
    const admin = (await signIn(app, 'admin@example.com', 'admin master password')).cookie
    const a = await app.inject({ method: 'GET', url: `${B}/hosts`, headers: { cookie: admin } })
    assert.match(a.json().data.errors.find((e: any) => e.instanceId === 'npm').error, /500/)
  } finally { w.npm1.fetch = inner; w.service.invalidate('npm') }
})
