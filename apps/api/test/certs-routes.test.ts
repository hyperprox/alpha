// /api/certs over HTTP behind the real vault gate: admin only (reads included), the contract's status
// codes, and every action audited with the signed-in user. The service runs on fakes.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { requiredRole } from '../src/lib/roles'
import { buildCertsRoutes } from '../src/routes/certs'
import { CertsService, bundleFromPems, type CertsSecrets, type StoredBundle } from '../src/lib/certs/service'
import { MemoryCertsStore } from '../src/lib/certs/store'
import { defaultModules, type CertsPolicy, type IssuedBundle } from '../src/lib/certs/modules'
import { FakeBroker } from './fakes/fake-broker'
import { signIn } from './fakes/app'

const broker = new FakeBroker()
broker.addUser('admin@example.com', 'admin master password', 'admin')
broker.addUser('op@example.com', 'operator master password', 'operator')
broker.addUser('viewer@example.com', 'viewer master password', 'viewer')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'certs-routes-test-'))
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }))
function makeBundle(cn: string): IssuedBundle {
  const k = path.join(tmp, 'k.pem'), c = path.join(tmp, 'c.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '90',
    '-subj', `/CN=${cn}`, '-keyout', k, '-out', c], { stdio: 'ignore' })
  return bundleFromPems(fs.readFileSync(k, 'utf8'), fs.readFileSync(c, 'utf8'))
}

const POLICY: CertsPolicy = {
  acme: { directoryUrl: 'https://acme.test/directory', staging: true, email: null, keyType: 'ec256' },
  schedule: { check: '15 6 * * *' },
  alerts: { warnFraction: 0.33, criticalDays: 7, webhookUrl: null },
  certificates: { self: { names: ['hp.example.com'], deploy: [{ target: 'self' }] } },
  probes: [{ host: 'mail.example.com', port: 993, starttls: 'none', internal: false }],
  targets: { self: { kind: 'hyperprox' } },
  proxy: { guestVmid: null },
}

let app: FastifyInstance
let svc: CertsService
const store = new MemoryCertsStore()
const vault = new Map<string, StoredBundle>()
const policy = { loaded: true }
let hold: Promise<void> = Promise.resolve()

before(async () => {
  setBroker(broker)
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  const secrets: CertsSecrets = {
    getAccountKey: async () => null, saveAccountKey: async () => undefined,
    getBundle: async l => vault.get(l) ?? null, saveBundle: async (l, b) => { vault.set(l, b) },
  }
  svc = new CertsService({
    store, secrets,
    modules: {
      ...defaultModules,
      loadCertsPolicy: () => ({ loaded: policy.loaded, path: '/test/certs.yaml', policy: POLICY }),
      issueCertificate: async (_d, names) => { await hold; return makeBundle(names[0]) },
      // The real module would ask the directory URL for ARI; tests stay off the network.
      fetchAri: async () => null,
      probeEndpoint: async () => ({ ok: false, error: 'refused', trusted: null, namesMatch: null }),
    },
    dnsProviders: async () => [],
    deploy: {
      guestPush: async () => ({ code: 0, output: '' }), guestExec: async () => ({ code: 0, output: '' }),
      hyperproxInstall: async () => ({ ok: true, detail: 'installed' }), probeAttempts: 1, sleep: async () => undefined,
    },
    sources: { npmCertificates: async () => [], npmHosts: async () => [], nodeCertificates: async () => [], npmCertificateUsers: async () => [], deleteNpmCertificate: async () => undefined },
    log: () => undefined,
  })
  app = Fastify({ logger: false })
  await registerGate(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(buildCertsRoutes({ service: svc, scheduler: false, recover: false }), { prefix: '/api/certs' })
  await app.ready()
})
beforeEach(async () => { if (isUnlocked()) await lock('manual') })
after(async () => { if (isUnlocked()) await lock('manual'); await app.close() })

const READS = ['/api/certs/overview', '/api/certs/events', '/api/certs/housekeeping']
const WRITES = ['/api/certs/probe', '/api/certs/managed/self/issue', '/api/certs/managed/self/deploy', '/api/certs/housekeeping/x/apply']

test('the role matrix makes every /api/certs route admin, reads included', () => {
  for (const url of READS) assert.equal(requiredRole('GET', url), 'admin', url)
  for (const url of WRITES) assert.equal(requiredRole('POST', url), 'admin', url)
  assert.equal(requiredRole('GET', '/api/certificates-elsewhere'), 'viewer', 'only /api/certs itself')
})

test('locked: 423; no session: 401', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/certs/overview' })).statusCode, 423)
  await signIn(app, 'viewer@example.com', 'viewer master password')
  assert.equal((await app.inject({ method: 'GET', url: '/api/certs/overview' })).statusCode, 401)
})

test('viewer and operator: 403 on every route', async () => {
  for (const [email, pw] of [['viewer@example.com', 'viewer master password'], ['op@example.com', 'operator master password']]) {
    const { cookie } = await signIn(app, email, pw)
    for (const url of READS) assert.equal((await app.inject({ method: 'GET', url, headers: { cookie } })).statusCode, 403, `${email} GET ${url}`)
    for (const url of WRITES) assert.equal((await app.inject({ method: 'POST', url, headers: { cookie }, payload: {} })).statusCode, 403, `${email} POST ${url}`)
  }
  assert.equal(store.audits.length, 0, 'nothing ran')
})

test('admin: overview, issue 202 then 409 while renewing, deploy, events; audited with the user', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const o = await app.inject({ method: 'GET', url: '/api/certs/overview', headers: { cookie } })
  assert.equal(o.statusCode, 200)
  assert.deepEqual(o.json().managed.map((m: any) => [m.label, m.status]), [['self', 'pending']])
  assert.equal(o.json().policy.acme.staging, true)

  assert.equal((await app.inject({ method: 'POST', url: '/api/certs/managed/self/deploy', headers: { cookie } })).statusCode, 400, 'not issued yet')

  let release!: () => void
  hold = new Promise(r => { release = r })
  const first = await app.inject({ method: 'POST', url: '/api/certs/managed/self/issue', headers: { cookie } })
  assert.equal(first.statusCode, 202)
  assert.equal(first.json().managed.status, 'renewing')
  const second = await app.inject({ method: 'POST', url: '/api/certs/managed/self/issue', headers: { cookie } })
  assert.equal(second.statusCode, 409)
  assert.match(second.json().error, /already being issued/)
  release()
  await svc.idle()
  hold = Promise.resolve()

  const after = await app.inject({ method: 'GET', url: '/api/certs/overview', headers: { cookie } })
  assert.equal(after.json().managed[0].status, 'valid')
  const dep = await app.inject({ method: 'POST', url: '/api/certs/managed/self/deploy', headers: { cookie } })
  assert.equal(dep.statusCode, 202)
  await svc.idle()
  const ev = await app.inject({ method: 'GET', url: '/api/certs/events?label=self&limit=50', headers: { cookie } })
  assert.equal(ev.statusCode, 200)
  assert.ok(ev.json().events.some((e: any) => e.kind === 'issue' && e.ok))
  assert.ok(ev.json().events.some((e: any) => e.kind === 'deploy'))
  assert.ok(store.audits.some(a => a.action === 'certs.issue' && a.details?.by === 'admin@example.com'))
  assert.ok(store.audits.some(a => a.action === 'certs.deploy' && a.details?.by === 'admin@example.com'))
})

test('admin: unknown label 404, bad label 404, no policy 400', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  assert.equal((await app.inject({ method: 'POST', url: '/api/certs/managed/nope/issue', headers: { cookie } })).statusCode, 404)
  assert.equal((await app.inject({ method: 'POST', url: '/api/certs/managed/..%2Fx/issue', headers: { cookie } })).statusCode, 404)
  policy.loaded = false
  try {
    const r = await app.inject({ method: 'POST', url: '/api/certs/managed/self/issue', headers: { cookie } })
    assert.equal(r.statusCode, 400)
    assert.match(r.json().error, /no certificate policy/)
  } finally { policy.loaded = true }
})

test('admin: probe validates input, 404s an endpoint it does not know, probes all; audited', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const post = (payload: any) => app.inject({ method: 'POST', url: '/api/certs/probe', headers: { cookie }, payload })
  assert.equal((await post({ host: 'bad host!' })).statusCode, 400)
  assert.equal((await post({ host: 'mail.example.com', port: 70000 })).statusCode, 400)
  assert.equal((await post({ port: 993 })).statusCode, 400)
  assert.equal((await post({ host: 'unknown.example.com' })).statusCode, 404)
  const one = await post({ host: 'mail.example.com', port: 993 })
  assert.equal(one.statusCode, 200)
  assert.equal(one.json().probes[0].verdict, 'error')
  const all = await post({})
  assert.equal(all.statusCode, 200)
  assert.ok(Array.isArray(all.json().probes))
  assert.ok(store.audits.some(a => a.action === 'certs.probe' && a.resource === 'all' && a.details?.by === 'admin@example.com'))
})

test('admin: housekeeping list, and apply of an item that does not exist is 404', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const list = await app.inject({ method: 'GET', url: '/api/certs/housekeeping', headers: { cookie } })
  assert.deepEqual(list.json(), { items: [] })
  assert.equal((await app.inject({ method: 'POST', url: '/api/certs/housekeeping/npm:1/apply', headers: { cookie } })).statusCode, 404)
})
