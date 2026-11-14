// The DNS routes over GoDaddy + Cloudflare stand-ins: the provider list (a Cloudflare account with no zones
// shows as a provider, not as nothing), domains with their provider, writes at the right provider with an
// audit row and no credential in it, the roles the gate gives these paths, and the Settings Test button.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { makeDnsRoutes } from '../src/routes/dns'
import { CloudflareClient } from '../src/lib/cloudflare-client'
import { DnsRouter, cloudflareBackend, godaddyBackend } from '../src/lib/dns-providers'
import { requiredRole } from '../src/lib/roles'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { settingsRoutes } from '../src/routes/settings'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { FakeBroker } from './fakes/fake-broker'
import { signIn } from './fakes/app'
import { FakeCloudflare } from './fakes/cloudflare'

function world(zones: string[] = []) {
  const cf = new FakeCloudflare()
  for (const z of zones) cf.addZone(z)
  const gdCalls: string[] = []
  const gd = {
    getDomains: async () => [{ domain: 'example.org', status: 'ACTIVE', authCode: 'SECRET-TRANSFER' }],
    getDomain: async (d: string) => ({ domain: d, status: 'ACTIVE' }),
    getRecords: async () => [{ type: 'A', name: '@', data: '192.0.2.5', ttl: 600 }],
    getRecordsByName: async () => [],
    createRecord: async (d: string, r: any) => { gdCalls.push(`create ${d} ${r.type} ${r.name}`) },
    updateRecord: async () => {}, replaceRecords: async () => {},
    deleteRecord: async (d: string, t: string, n: string) => { gdCalls.push(`delete ${d} ${t} ${n}`) },
  }
  const audits: Array<{ action: string; resource: string; details?: any }> = []
  const client = new CloudflareClient({ token: cf.validToken }, { fetch: cf.fetch, sleep: async () => {} })
  const app = Fastify({ logger: false })
  app.register(makeDnsRoutes({
    router: async () => new DnsRouter([godaddyBackend(gd as any), cloudflareBackend(client)]),
    wanIp: async () => ({ ip: '198.51.100.7', source: 'test' }),
    audit: async (action, resource, details) => { audits.push({ action, resource, details }) },
  }), { prefix: '/api/dns' })
  return { cf, gdCalls, audits, app }
}

test('providers: a Cloudflare account with no zones is listed with 0 zones, beside GoDaddy', async () => {
  const { app } = world()
  const r = await app.inject({ method: 'GET', url: '/api/dns/providers' })
  assert.equal(r.statusCode, 200)
  assert.deepEqual(r.json().data, [
    { id: 'godaddy', label: 'GoDaddy', ok: true, zones: 1, active: 1, configured: true },
    { id: 'cloudflare', label: 'Cloudflare', ok: true, zones: 0, active: 0, configured: true },
  ])
})

test('providers: nothing set up lists both as not configured', async () => {
  const app = Fastify({ logger: false })
  app.register(makeDnsRoutes({ router: async () => null, wanIp: async () => ({ ip: '', source: '' }), audit: async () => {} }), { prefix: '/api/dns' })
  const r = await app.inject({ method: 'GET', url: '/api/dns/providers' })
  assert.deepEqual(r.json().data.map((p: any) => [p.id, p.configured]), [['godaddy', false], ['cloudflare', false]])
  const d = await app.inject({ method: 'GET', url: '/api/dns/domains' })
  // Not a failure: an empty list that says no provider is connected yet (the page shows "Connect a DNS provider").
  assert.equal(d.statusCode, 200)
  assert.equal(d.json().configured, false)
  assert.deepEqual(d.json().data, [])
  assert.match(d.json().message, /No DNS provider is connected yet/)
})

test('domains carry their provider; registrar secrets never reach the browser', async () => {
  const { app } = world(['example.com'])
  const r = await app.inject({ method: 'GET', url: '/api/dns/domains' })
  const data = r.json().data
  assert.deepEqual(data.map((d: any) => [d.domain, d.provider]), [['example.com', 'cloudflare'], ['example.org', 'godaddy']])
  assert.ok(!JSON.stringify(data).includes('SECRET-TRANSFER'))
})

test('a record is created at the provider holding the zone, DNS only by default, with an audit row', async () => {
  const { app, cf, gdCalls, audits } = world(['example.com'])
  const c = await app.inject({ method: 'POST', url: '/api/dns/domains/example.com/records', payload: { type: 'A', name: 'app', data: '192.0.2.10', ttl: 600 } })
  assert.equal(c.statusCode, 200, c.body)
  assert.equal(cf.records[0].proxied, false)
  assert.equal(gdCalls.length, 0)
  await app.inject({ method: 'POST', url: '/api/dns/domains/example.org/records', payload: { type: 'A', name: 'app', data: '192.0.2.10', ttl: 600 } })
  assert.deepEqual(gdCalls, ['create example.org A app'])
  assert.deepEqual(audits.map(a => [a.action, a.resource, a.details.zone, a.details.type, a.details.name]), [
    ['dns.record.create', 'dns:cloudflare', 'example.com', 'A', 'app'], ['dns.record.create', 'dns:godaddy', 'example.org', 'A', 'app']])
  assert.ok(!JSON.stringify(audits).includes(cf.validToken))
  const list = await app.inject({ method: 'GET', url: '/api/dns/domains/example.com/records' })
  const rec = list.json().data[0]
  assert.deepEqual(Object.keys(rec).sort(), ['data', 'id', 'name', 'proxiable', 'proxied', 'ttl', 'type'])
})

test('edit and delete by id at Cloudflare; a bad id or name is a 400 with a sentence', async () => {
  const { app, cf, audits } = world(['example.com'])
  const z = cf.zones[0]
  const rec = cf.addRecord(z, { type: 'A', name: 'app.example.com', content: '192.0.2.10', ttl: 1, proxied: true })
  const u = await app.inject({ method: 'PUT', url: `/api/dns/domains/example.com/records/A/app?id=${rec.id}`, payload: { data: '192.0.2.11' } })
  assert.equal(u.statusCode, 200, u.body)
  assert.equal(rec.proxied, true, 'kept proxied')
  const bad = await app.inject({ method: 'DELETE', url: '/api/dns/domains/example.com/records/A/app?id=..%2F..%2Fuser' })
  assert.equal(bad.statusCode, 400)
  assert.match(bad.json().error, /not a record id/)
  const badName = await app.inject({ method: 'DELETE', url: '/api/dns/domains/example.com/records/A/..%2F..%2Fzones' })
  assert.equal(badName.statusCode, 400)
  const d = await app.inject({ method: 'DELETE', url: `/api/dns/domains/example.com/records/A/app?id=${rec.id}` })
  assert.equal(d.statusCode, 200)
  assert.equal(cf.records.length, 0)
  assert.deepEqual(audits.map(a => a.action), ['dns.record.update', 'dns.record.delete'])
})

test('Cloudflare refusing a write comes back as its own sentence', async () => {
  const { app, cf } = world(['example.com'])
  cf.validToken = 'rotated'
  const r = await app.inject({ method: 'GET', url: '/api/dns/domains/example.com/records' })
  assert.equal(r.statusCode, 400)
  assert.equal(r.json().error, 'example.com is not a domain any configured DNS provider holds (not answering: Cloudflare: Invalid API Token (code 1000)).')
  const p = await app.inject({ method: 'GET', url: '/api/dns/providers' })
  assert.equal(p.json().data[1].error, 'Invalid API Token (code 1000)')
})

test('roles: DNS reads are viewer, every DNS write is admin, whatever the provider', () => {
  assert.equal(requiredRole('GET', '/api/dns/providers'), 'viewer')
  assert.equal(requiredRole('GET', '/api/dns/domains/example.com/records'), 'viewer')
  for (const [m, p] of [['POST', '/api/dns/domains/example.com/records'], ['PUT', '/api/dns/domains/example.com/records/A/www'],
    ['DELETE', '/api/dns/domains/example.com/records/A/www'], ['POST', '/api/dns/domains/example.com/ddns'],
    ['PUT', '/api/settings/dns/cloudflare'], ['POST', '/api/settings/test/dns/cloudflare']])
    assert.equal(requiredRole(m, p), 'admin', `${m} ${p}`)
})

// --- The Settings Test button, through the real gate, settings routes and a fake vault ----------------

const broker = new FakeBroker()
broker.addUser('admin@example.com', 'admin master password', 'admin')
let sapp: FastifyInstance
const realFetch = globalThis.fetch
const cf = new FakeCloudflare()

before(async () => {
  setBroker(broker)
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  // Only Cloudflare's address is answered by the fake; anything else goes where it went before.
  globalThis.fetch = (async (input: any, init?: any) => String(input).startsWith('https://api.cloudflare.com/') ? cf.fetch(input, init) : realFetch(input, init)) as typeof fetch
  sapp = Fastify({ logger: false })
  await registerGate(sapp)
  await sapp.register(authRoutes, { prefix: '/api/auth' })
  await sapp.register(settingsRoutes, { prefix: '/api/settings' })
  await sapp.ready()
})
after(async () => { globalThis.fetch = realFetch; if (isUnlocked()) await lock('manual'); await sapp.close() })

async function testButton() {
  // The vault cache is filled at unlock: lock first so the item as the test set it is what gets read.
  if (isUnlocked()) await lock('manual')
  const { cookie } = await signIn(sapp, 'admin@example.com', 'admin master password')
  await sapp.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie }, payload: { password: 'admin master password' } })
  return sapp.inject({ method: 'POST', url: '/api/settings/test/dns/cloudflare', headers: { cookie } })
}

test('Settings → DNS → Cloudflare → Test: no more "No test available"; zero zones is a success', async () => {
  broker.items.set('hyperprox:dns/cloudflare', { id: 'c1', name: 'hyperprox:dns/cloudflare', fields: { api_token: cf.validToken } })
  const r = await testButton()
  assert.equal(r.statusCode, 200, r.body)
  const body = r.json()
  assert.equal(body.success, true)
  assert.equal(body.data.message, 'Token works, but this account has no domains yet.')
  assert.ok(body.data.details.some((d: string) => /Zone: Read works/.test(d)))
  assert.doesNotMatch(r.body, /No test available/)
  assert.ok(!r.body.includes(cf.validToken), 'the token never goes back to the browser')
})

test('Settings Test: zones are counted, and a bad token is a plain error', async () => {
  cf.addZone('example.com'); cf.addZone('example.net')
  let r = await testButton()
  assert.equal(r.json().data.message, 'Token works: 2 zones (example.com, example.net).')
  broker.items.set('hyperprox:dns/cloudflare', { id: 'c1', name: 'hyperprox:dns/cloudflare', fields: { api_token: 'revoked-token' } })
  r = await testButton()
  assert.equal(r.statusCode, 400)
  assert.deepEqual(r.json(), { success: false, error: 'Invalid API Token (code 1000)' })
  broker.items.set('hyperprox:dns/cloudflare', { id: 'c1', name: 'hyperprox:dns/cloudflare', fields: {} })
  r = await testButton()
  assert.match(r.json().error, /No Cloudflare API token is saved yet/)
})
