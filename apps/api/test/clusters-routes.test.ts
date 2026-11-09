// Adding a server through the real routes and gate, against a pretend Proxmox on loopback TLS: the certificate
// must be the one confirmed, the token must have administrator rights, nothing is saved otherwise, the secret
// never comes back in an answer, and a remote page's requests reach only that server.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { clusterRoutes } from '../src/routes/clusters'
import { proxmoxRoutes } from '../src/routes/proxmox'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { setAuditSink } from '../src/lib/audit'
import { setClusterStore, loadClusters } from '../src/lib/clusters/registry'
import { MemoryClusterStore } from '../src/lib/clusters/store'
import { installClusterContext } from '../src/lib/clusters/context'
import { FakeBroker } from './fakes/fake-broker'
import { signIn } from './fakes/app'

const haveOpenssl = spawnSync('openssl', ['version']).status === 0
const SECRET = '12345678-aaaa-bbbb-cccc-1234567890ab'
let admin = true
const seen: string[] = []
let server: https.Server
let port = 0
let app: FastifyInstance
let cookie = ''
const broker = new FakeBroker()
broker.addUser('owner@example.com', 'owner master password', 'owner')
const audits: any[] = []

before(async () => {
  if (!haveOpenssl) return
  const dir = mkdtempSync(join(tmpdir(), 'hpx-mcr-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '30', '-subj', '/CN=pve-test', '-keyout', join(dir, 'k'), '-out', join(dir, 'c')], { stdio: 'ignore' })
  server = https.createServer({ key: readFileSync(join(dir, 'k')), cert: readFileSync(join(dir, 'c')) }, (req, res) => {
    seen.push(`${req.method} ${req.url}`)
    res.setHeader('content-type', 'application/json')
    if (req.headers.authorization !== `PVEAPIToken=hyperprox@pve!main=${SECRET}`) { res.statusCode = 401; return res.end(JSON.stringify({ data: null })) }
    const send = (data: unknown) => res.end(JSON.stringify({ data }))
    if (req.url === '/api2/json/version') return send({ version: '9.1.0' })
    if (req.url?.startsWith('/api2/json/access/permissions')) return send({ '/': admin ? Object.fromEntries(['VM.Allocate', 'VM.PowerMgmt', 'VM.Config.Disk', 'VM.Snapshot', 'VM.Backup', 'Datastore.Allocate', 'Sys.Modify', 'Sys.Audit'].map(p => [p, 1])) : { 'Sys.Audit': 1 } })
    if (req.url === '/api2/json/nodes') return send([{ node: 'pve', status: 'online', cpu: 0.1, maxcpu: 4, mem: 1, maxmem: 8 }])
    res.statusCode = 404; send(null)
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  port = (server.address() as any).port
  setBroker(broker)
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  setAuditSink({ write: async r => { audits.push(r) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  setClusterStore(new MemoryClusterStore()); await loadClusters()
  app = Fastify({ logger: false })
  await registerGate(app)
  installClusterContext(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(clusterRoutes, { prefix: '/api/clusters' })
  await app.register(proxmoxRoutes, { prefix: '/api/proxmox' })
  await app.ready()
  cookie = (await signIn(app, 'owner@example.com', 'owner master password')).cookie
})
after(async () => { server?.close(); if (isUnlocked()) await lock('manual'); await app?.close() })

const call = (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => app.inject({ method: method as any, url, headers: { cookie, ...headers }, payload: payload as any })

test('add a server: re-confirmed, pinned, admin-checked, and the secret never comes back', { skip: !haveOpenssl && 'openssl not installed' }, async () => {
  const fp = (await call('POST', '/api/clusters/probe-certificate', { address: '127.0.0.1', port })).json().data.fingerprint
  assert.match(fp, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
  const body = { name: 'Remote server', address: '127.0.0.1', port, tokenId: 'hyperprox@pve!main', tokenSecret: SECRET, fingerprint: fp }

  assert.equal((await call('POST', '/api/clusters', body)).json().code, 'reconfirm_required')
  await call('POST', '/api/auth/reconfirm', { password: 'owner master password' })

  const wrongFp = await call('POST', '/api/clusters', { ...body, fingerprint: 'AB'.repeat(32) })
  assert.equal(wrongFp.statusCode, 409)
  assert.ok(!seen.some(s => s.includes('/version')), 'a different certificate gets nothing sent to it')

  admin = false
  const weak = await call('POST', '/api/clusters', body)
  assert.equal(weak.statusCode, 422)
  assert.match(weak.json().error, /lacks administrator rights/)
  admin = true
  assert.equal((await call('GET', '/api/clusters')).json().data.length, 1, 'nothing was saved')

  const ok = await call('POST', '/api/clusters', body)
  assert.equal(ok.statusCode, 200, ok.body)
  const id = ok.json().data.cluster.id
  assert.deepEqual(ok.json().data.cluster.nodeAddresses, { pve: '127.0.0.1' }, 'a one-node server is reached on its own address')

  const list = await call('GET', '/api/clusters')
  assert.ok(!list.body.includes(SECRET), 'no answer carries the secret')
  assert.equal(list.json().data[1].token.id, 'hyperprox@pve!main')
  assert.ok(!JSON.stringify(audits).includes(SECRET), 'nor does the audit log')
  assert.ok(audits.some(a => a.action === 'cluster.add' && a.details.by === 'owner@example.com'))

  // A remote page's request reaches that server; a home-only page refuses.
  seen.length = 0
  const nodes = await call('GET', '/api/proxmox/nodes', undefined, { 'x-hyperprox-cluster': id })
  assert.equal(nodes.json().data[0].node, 'pve')
  assert.ok(seen.includes('GET /api2/json/nodes'))
  assert.equal((await call('GET', '/api/proxmox/gpu', undefined, { 'x-hyperprox-cluster': id })).statusCode, 409)

  // Removing needs the exact name.
  assert.equal((await call('DELETE', `/api/clusters/${id}`, { confirmName: 'remote server' })).statusCode, 428)
  const gone = await call('DELETE', `/api/clusters/${id}`, { confirmName: 'Remote server' })
  assert.equal(gone.statusCode, 200)
  assert.deepEqual(gone.json().data.cleanup, ['pveum user token remove hyperprox@pve main', 'pveum user delete hyperprox@pve'])
})
