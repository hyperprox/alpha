// Every audit row says when an action was taken with an API token, by the token's name and never its value
// (lib/http/request-actor.ts auditBy). Walks a sample of routes behind the real gate: one that hands the request's
// actor to its service (load balancing), one whose service reads the request context (proxy), and one that writes
// its own row from the request context (DNS). A person's own action carries no token field. The shared audit writer's
// secret scrub keeps the name (test/request-actor.test.ts).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { buildPlacementRoutes } from '../src/routes/placement'
import { buildProxyRoutes } from '../src/routes/proxy'
import { makeDnsRoutes } from '../src/routes/dns'
import { DnsRouter, godaddyBackend } from '../src/lib/dns-providers'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { setAuditSink } from '../src/lib/audit'
import { MemoryApiTokenStore, setApiTokenStore, createApiToken } from '../src/lib/api-tokens'
import { PlacementService } from '../src/lib/placement/service'
import { MemoryPlacementStore } from '../src/lib/placement/store'
import { ProxyService } from '../src/lib/proxy/service'
import { MemoryInstanceSecrets, MemoryProxyStore } from '../src/lib/proxy/store'
import { FakeBroker } from './fakes/fake-broker'
import { signIn } from './fakes/app'
import { placementFixture, fakePve } from './fakes/placement-cluster'

const broker = new FakeBroker()
broker.addUser('admin@example.com', 'admin master password', 'admin')
const tokens = new MemoryApiTokenStore()
type Row = { action: string; resource: string; details?: Record<string, unknown> }
const placementRows: Row[] = []
const dnsRows: Row[] = []
const proxyStore = new MemoryProxyStore()
let app: FastifyInstance

before(async () => {
  setBroker(broker)
  setApiTokenStore(tokens)
  setAuditSink({ async write() {} })
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  const fixture = placementFixture()
  const placement = new PlacementService({
    pve: () => fakePve(fixture, () => { throw new Error('no writes in this test') }), prom: async () => [], store: new MemoryPlacementStore(),
    audit: async (action, resource, details) => { placementRows.push({ action, resource, details }) },
    isUnlocked: () => true, nodeExec: async () => null, now: () => Date.UTC(2026, 5, 15, 12, 0), sleep: async () => {}, pollMs: 1, cacheMs: 0, taskTimeoutMs: 50,
    approverChanged: async () => null, alert: async () => {},
  })
  const proxy = new ProxyService({ store: proxyStore, secrets: new MemoryInstanceSecrets(), legacyNpm: async () => null })
  app = Fastify({ logger: false })
  await registerGate(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(buildPlacementRoutes({ service: () => placement }), { prefix: '/api/placement' })
  await app.register(buildProxyRoutes({ service: () => proxy }), { prefix: '/api/proxy' })
  const gd = {
    getDomains: async () => [{ domain: 'example.org', status: 'ACTIVE' }], getDomain: async (d: string) => ({ domain: d, status: 'ACTIVE' }),
    getRecords: async () => [], getRecordsByName: async () => [], createRecord: async () => {}, updateRecord: async () => {},
    replaceRecords: async () => {}, deleteRecord: async () => {},
  }
  await app.register(makeDnsRoutes({
    router: async () => new DnsRouter([godaddyBackend(gd as any)]), wanIp: async () => ({ ip: '198.51.100.7', source: 'test' }),
    audit: async (action, resource, details) => { dnsRows.push({ action, resource, details }) },
  }), { prefix: '/api/dns' })
  await app.ready()
})
after(async () => { setApiTokenStore(null); setAuditSink(null); if (isUnlocked()) await lock('manual'); await app.close() })

/** The row the request wrote. A refusal is recorded in an onResponse hook, which runs just after the reply is sent. */
async function rowOf(rows: () => Row[], from: number, action: string): Promise<Row | undefined> {
  for (let i = 0; i < 50; i++) {
    const r = rows().slice(from).find(x => x.action === action)
    if (r) return r
    await new Promise(res => setImmediate(res))
  }
  return undefined
}

async function seedProxy(id: string) {
  await proxyStore.create({ id, kind: 'caddy', name: `caddy ${id}`, url: 'http://10.0.0.5:2019', mode: 'byo', managed: null, settings: {}, createdBy: 'admin@example.com' } as any)
}

test('a sample of audited routes: a token\'s action names the token; a person\'s does not; no token value anywhere', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const made = await createApiToken({ name: 'nightly-walk', role: 'admin' }, 'test', tokens)
  const bearer = { authorization: `Bearer ${made.token}` }
  await seedProxy('px-walkone001'); await seedProxy('px-walktwo002')

  // Each route: the request, then the audit row it must have written.
  const walk: Array<{ name: string; send: (h: Record<string, string>, n: number) => Promise<any>; rows: () => Row[]; action: string }> = [
    { name: 'load balancing: stop automatic balancing', action: 'placement.auto.stop', rows: () => placementRows,
      send: h => app.inject({ method: 'POST', url: '/api/placement/auto/stop', headers: h }) },
    { name: 'proxy: forget an instance', action: 'proxy.instance.delete', rows: () => proxyStore.audits,
      send: (h, n) => app.inject({ method: 'DELETE', url: `/api/proxy/instances/${n === 1 ? 'px-walkone001' : 'px-walktwo002'}`, headers: h }) },
    { name: 'DNS: add a record', action: 'dns.record.create', rows: () => dnsRows,
      send: (h, n) => app.inject({ method: 'POST', url: '/api/dns/domains/example.org/records', headers: h, payload: { type: 'A', name: `walk${n}`, data: '192.0.2.10', ttl: 600 } }) },
  ]

  for (const w of walk) {
    const before = w.rows().length
    const r = await w.send(bearer, 1)
    assert.equal(r.statusCode, 200, `${w.name}: ${r.body}`)
    const row = await rowOf(w.rows, before, w.action)
    assert.ok(row, `${w.name}: audited`)
    assert.equal(row!.details!.tokenName, 'nightly-walk', `${w.name}: the token by name`)
    assert.equal(row!.details!.by, 'token:nightly-walk', `${w.name}: \`by\` is what it always was`)
    assert.ok(!JSON.stringify(row).includes(made.token), `${w.name}: never the token's value`)
  }

  for (const w of walk) {
    const before = w.rows().length
    const r = await w.send({ cookie }, 2)
    assert.equal(r.statusCode, 200, `${w.name} (person): ${r.body}`)
    const row = await rowOf(w.rows, before, w.action)
    assert.ok(row, `${w.name} (person): audited`)
    assert.equal(row!.details!.by, 'admin@example.com')
    assert.equal('tokenName' in row!.details!, false, `${w.name} (person): no token field`)
  }
})
