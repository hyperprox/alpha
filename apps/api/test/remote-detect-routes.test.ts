// The probe over HTTP: a viewer's (or operator's) page load never starts one, an admin's starts one only when
// the cache has aged out, and Refresh is admin only and not re-confirmed (it reads; it changes nothing).
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { requiredRole, needsReconfirm } from '../src/lib/roles'
import { buildRemoteRoutes } from '../src/routes/remote'
import { RemoteAccessService } from '../src/lib/remote/service'
import { MemoryRemoteStore } from '../src/lib/remote/store'
import { ClientDetector, DETECT_CLIENTS_SCRIPT } from '../src/lib/remote/detect'
import type { RemoteExecutor } from '../src/lib/remote/executor'
import { FakeBroker } from './fakes/fake-broker'
import { signIn } from './fakes/app'

const broker = new FakeBroker()
broker.addUser('admin@example.com', 'admin master password', 'admin')
broker.addUser('op@example.com', 'operator master password', 'operator')
broker.addUser('viewer@example.com', 'viewer master password', 'viewer')

const probes: string[] = []
const OUT = 'HP_DETECT_BEGIN\nHP_TS_BIN=/usr/bin/tailscale\nHP_TS_DAEMON=active\nHP_TS_STATUS_BEGIN\n{"BackendState":"Running","Version":"1.104.5-x","Self":{"DNSName":"pve-a.tail0000.ts.net.","TailscaleIPs":["100.64.0.11"]},"CurrentTailnet":{"Name":"example.com"}}\nHP_TS_STATUS_END\nHP_NB_BIN=\nHP_DETECT_END'
const exec: RemoteExecutor = {
  listMachines: async () => [{ id: 'node-pve-a', kind: 'node', name: 'pve-a', node: 'pve-a', running: true, address: '192.0.2.11' }],
  run: async (m, script) => { if (script === DETECT_CLIENTS_SCRIPT) probes.push(m.id); return { code: 0, output: OUT, timedOut: false } },
  lxcConfig: async () => ({}), setLxcConfig: async () => undefined, firewallState: async () => ({ clusterEnabled: false, rules: [] }), addFirewallRule: async () => undefined,
  hostKeyTarget: async () => ({ host: '192.0.2.11', port: 22 }), probeHostKey: async () => 'x', pinnedHostKey: async () => 'x', pinHostKey: async () => undefined,
}
const detector = new ClientDetector({ listMachines: exec.listMachines, run: exec.run })
const svc = new RemoteAccessService({ store: new MemoryRemoteStore(), exec, detector, provider: async () => null, providerSettings: async () => ({ tags: [] }), settleMs: 0 })

let app: FastifyInstance
before(async () => {
  setBroker(broker)
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  app = Fastify({ logger: false })
  await registerGate(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(buildRemoteRoutes({ service: svc, sweep: false }), { prefix: '/api/remote' })
  await app.ready()
})
beforeEach(async () => { if (isUnlocked()) await lock('manual') })
after(async () => { await svc.close(); if (isUnlocked()) await lock('manual'); await app.close() })

test('the role matrix: Refresh is admin, not re-confirmed', () => {
  assert.equal(requiredRole('POST', '/api/remote/detect/refresh'), 'admin')
  assert.equal(needsReconfirm('POST', '/api/remote/detect/refresh'), false)
})

test('viewer and operator page loads never probe, and cannot press Refresh', async () => {
  for (const [email, pw] of [['viewer@example.com', 'viewer master password'], ['op@example.com', 'operator master password']]) {
    const { cookie } = await signIn(app, email, pw)
    const o = await app.inject({ method: 'GET', url: '/api/remote/overview', headers: { cookie } })
    assert.equal(o.statusCode, 200, o.body)
    assert.equal(o.json().machines[0].cells.tailscale.state, 'unchecked')
    assert.equal((await app.inject({ method: 'POST', url: '/api/remote/detect/refresh', headers: { cookie } })).statusCode, 403)
  }
  await new Promise(r => setTimeout(r, 20))
  assert.equal(probes.length, 0)
})

test('an admin\'s page load probes once while stale; Refresh probes again and answers with the result', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  await app.inject({ method: 'GET', url: '/api/remote/overview', headers: { cookie } })
  await detector.refresh({ ifStale: true })
  assert.equal(probes.length, 1)
  await app.inject({ method: 'GET', url: '/api/remote/overview', headers: { cookie } })
  assert.equal(probes.length, 1, 'fresh: not again')
  const r = await app.inject({ method: 'POST', url: '/api/remote/detect/refresh', headers: { cookie } })
  assert.equal(r.statusCode, 200, r.body)
  assert.equal(probes.length, 2)
  assert.equal(r.json().machines[0].cells.tailscale.detectedText, 'Tailscale installed, connected as pve-a.tail0000.ts.net (100.64.0.11)')
  // The viewer now sees the cached state, still without probing.
  const v = await signIn(app, 'viewer@example.com', 'viewer master password')
  const o = await app.inject({ method: 'GET', url: '/api/remote/overview', headers: { cookie: v.cookie } })
  assert.equal(o.json().machines[0].cells.tailscale.state, 'connected')
  assert.equal(probes.length, 2)
})
