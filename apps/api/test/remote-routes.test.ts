// /api/remote behind the real vault gate: viewers and operators see status only; admins act; the actions that
// open a tunnel, route, remove a device or show a key need a re-confirmation, which keeps API tokens out.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { requiredRole, needsReconfirm } from '../src/lib/roles'
import { tokenForbidden } from '../src/lib/api-tokens'
import { buildRemoteRoutes } from '../src/routes/remote'
import { RemoteAccessService } from '../src/lib/remote/service'
import { MemoryRemoteStore } from '../src/lib/remote/store'
import type { RemoteExecutor } from '../src/lib/remote/executor'
import type { RemoteProvider } from '../src/lib/remote/types'
import { FakeBroker } from './fakes/fake-broker'
import { signIn } from './fakes/app'

const broker = new FakeBroker()
broker.addUser('admin@example.com', 'admin master password', 'admin')
broker.addUser('op@example.com', 'operator master password', 'operator')
broker.addUser('viewer@example.com', 'viewer master password', 'viewer')

const ran: string[] = []
let hold: Promise<void> = Promise.resolve()
const exec: RemoteExecutor = {
  listMachines: async () => [
    { id: 'node-pve-a', kind: 'node', name: 'pve-a', node: 'pve-a', running: true, address: '192.0.2.11' },
    { id: 'lxc-101', kind: 'lxc', name: 'web', node: 'pve-a', vmid: 101, running: true, address: '192.0.2.101' },
    { id: 'qemu-103', kind: 'qemu', name: 'desk', node: 'pve-a', vmid: 103, running: true, ostype: 'win11' },
  ],
  run: async (_m, script) => {
    ran.push(script)
    await hold
    if (script.includes('HP_OS_ID=')) return { code: 0, output: 'HP_OS_ID=debian\nHP_OS_CODENAME=trixie\nHP_UNAME=Linux\nHP_PM=apt\nHP_SYSTEMD=1\nHP_TUN=1\nHP_ROOT=1', timedOut: false }
    return { code: 0, output: 'HP_STATUS_BEGIN\n{"BackendState":"Running","Self":{"ID":"n1","TailscaleIPs":["100.64.0.5"]}}\nHP_STATUS_END\nHP_REMOVED', timedOut: false }
  },
  lxcConfig: async () => ({}),
  setLxcConfig: async () => undefined,
  firewallState: async () => ({ clusterEnabled: true, rules: [] }),
  addFirewallRule: async () => undefined,
}
const provider: RemoteProvider = {
  id: 'tailscale', test: async () => 'ok',
  mintKey: async () => ({ id: 'k', secret: 'tskey-auth-ROUTESECRET', expiresAt: 'soon' }),
  revokeKey: async () => undefined, keyRevoked: async () => true, listDevices: async () => [], deleteDevice: async () => undefined, setRouting: async () => [],
}
const store = new MemoryRemoteStore()
const svc = new RemoteAccessService({ store, exec, provider: async id => (id === 'tailscale' ? provider : null), providerSettings: async () => ({ tags: [] }), settleMs: 0 })

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

async function waitIdle() {
  for (let i = 0; i < 200 && svc.activeJobId; i++) await new Promise(r => setTimeout(r, 5))
}

const RECONFIRMED: Array<[string, string]> = [
  ['POST', '/api/remote/jobs'],
  ['POST', '/api/remote/machines/lxc-101/tailscale/routing'],
  ['POST', '/api/remote/machines/qemu-103/netbird/manual-key'],
  ['DELETE', '/api/remote/machines/lxc-101/tailscale'],
  ['POST', '/api/remote/machines/lxc-101/tun'],
  ['POST', '/api/remote/machines/node-pve-a/tailscale/firewall'],
  ['POST', '/api/remote/machines/node-pve-a/tailscale/check'],
  ['POST', '/api/remote/machines/node-pve-a/netbird/update'],
]
const ADMIN_PLAIN: Array<[string, string]> = [
  ['POST', '/api/remote/machines/lxc-101/tailscale/check'],
  ['POST', '/api/remote/machines/lxc-101/tailscale/update'],
]

test('the role matrix: overview is viewer, jobs and every action admin, the dangerous ones re-confirmed', () => {
  assert.equal(requiredRole('GET', '/api/remote/overview'), 'viewer')
  assert.equal(requiredRole('GET', '/api/remote/jobs/abc'), 'admin')
  assert.equal(requiredRole('GET', '/api/remote/machines/node-pve-a/tailscale/firewall'), 'admin')
  for (const [m, p] of [...RECONFIRMED, ...ADMIN_PLAIN]) assert.equal(requiredRole(m, p), 'admin', `${m} ${p}`)
  for (const [m, p] of RECONFIRMED) assert.equal(needsReconfirm(m, p), true, `${m} ${p}`)
  for (const [m, p] of ADMIN_PLAIN) assert.equal(needsReconfirm(m, p), false, `${m} ${p}`)
  assert.equal(needsReconfirm('GET', '/api/remote/overview'), false)
  // Nothing here is forbidden to tokens outright; the re-confirmation is what keeps them off the dangerous ones.
  assert.equal(tokenForbidden('POST', '/api/remote/jobs'), false)
})

test('locked: 423; no session: 401', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/remote/overview' })).statusCode, 423)
  await signIn(app, 'viewer@example.com', 'viewer master password')
  assert.equal((await app.inject({ method: 'GET', url: '/api/remote/overview' })).statusCode, 401)
})

test('viewer and operator: the overview, and nothing else', async () => {
  for (const [email, pw] of [['viewer@example.com', 'viewer master password'], ['op@example.com', 'operator master password']]) {
    const { cookie } = await signIn(app, email, pw)
    const o = await app.inject({ method: 'GET', url: '/api/remote/overview', headers: { cookie } })
    assert.equal(o.statusCode, 200, o.body)
    assert.deepEqual(o.json().machines.map((m: any) => m.id), ['node-pve-a', 'lxc-101', 'qemu-103'])
    assert.doesNotMatch(o.body, /192\.0\.2\./, 'no LAN or cluster address below admin')
    assert.equal((await app.inject({ method: 'GET', url: '/api/remote/jobs/x', headers: { cookie } })).statusCode, 403)
    assert.equal((await app.inject({ method: 'GET', url: '/api/remote/machines/node-pve-a/tailscale/firewall', headers: { cookie } })).statusCode, 403)
    for (const [method, url] of [...RECONFIRMED, ...ADMIN_PLAIN]) {
      const r = await app.inject({ method: method as any, url, headers: { cookie }, payload: {} })
      assert.equal(r.statusCode, 403, `${email} ${method} ${url}`)
      assert.equal(r.json().code, 'forbidden')
    }
  }
  assert.equal(ran.length, 0, 'nothing ran on any machine')
})

test('admin: install needs a re-confirmation, then runs as a job readable by admins, with the key nowhere in it', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const body = { provider: 'tailscale', machineIds: ['lxc-101'] }
  const first = await app.inject({ method: 'POST', url: '/api/remote/jobs', headers: { cookie }, payload: body })
  assert.equal(first.statusCode, 403)
  assert.equal(first.json().code, 'reconfirm_required')
  await app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie }, payload: { password: 'admin master password' } })
  const res = await app.inject({ method: 'POST', url: '/api/remote/jobs', headers: { cookie }, payload: body })
  assert.equal(res.statusCode, 202, res.body)
  const id = res.json().job.id
  await waitIdle()
  const j = await app.inject({ method: 'GET', url: `/api/remote/jobs/${id}`, headers: { cookie } })
  assert.equal(j.statusCode, 200)
  assert.equal(j.json().job.status, 'completed', j.json().job.error)
  assert.doesNotMatch(j.body, /ROUTESECRET/)
  assert.equal((await app.inject({ method: 'GET', url: '/api/remote/jobs/nope', headers: { cookie } })).statusCode, 404)
})

test('admin: bad input is 400, a running job makes the next one 409, check and update need no re-confirmation', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  await app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie }, payload: { password: 'admin master password' } })
  const bad = await app.inject({ method: 'POST', url: '/api/remote/jobs', headers: { cookie }, payload: { provider: 'zerotier', machineIds: ['lxc-101'] } })
  assert.equal(bad.statusCode, 400)
  const badId = await app.inject({ method: 'POST', url: '/api/remote/machines/bad%20id/tailscale/check', headers: { cookie } })
  assert.equal(badId.statusCode, 400)
  let release!: () => void
  hold = new Promise(r => { release = r })
  const a = await app.inject({ method: 'POST', url: '/api/remote/machines/lxc-101/tailscale/check', headers: { cookie } })
  assert.equal(a.statusCode, 202, a.body)
  const b = await app.inject({ method: 'POST', url: '/api/remote/machines/lxc-101/tailscale/update', headers: { cookie } })
  assert.equal(b.statusCode, 409)
  assert.equal(b.json().runningJobId, a.json().job.id)
  release()
  await waitIdle()
})

test('admin: routing, uninstall, tun and manual key go through once re-confirmed', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  await app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie }, payload: { password: 'admin master password' } })
  const r = await app.inject({ method: 'POST', url: '/api/remote/machines/lxc-101/tailscale/routing', headers: { cookie }, payload: { subnets: ['198.51.100.0/24'], exitNode: false, acknowledge: true } })
  assert.equal(r.statusCode, 202, r.body)
  await waitIdle()
  const u = await app.inject({ method: 'DELETE', url: '/api/remote/machines/lxc-101/tailscale', headers: { cookie } })
  assert.equal(u.statusCode, 202, u.body)
  await waitIdle()
  const t = await app.inject({ method: 'POST', url: '/api/remote/machines/lxc-101/tun', headers: { cookie } })
  assert.equal(t.statusCode, 200, t.body)
  assert.equal(t.json().applied, true)
  const k = await app.inject({ method: 'POST', url: '/api/remote/machines/qemu-103/tailscale/manual-key', headers: { cookie }, payload: {} })
  assert.equal(k.statusCode, 200, k.body)
  assert.equal(k.json().secret, 'tskey-auth-ROUTESECRET')
  assert.equal(k.headers['cache-control'], 'no-store')
  const nf = await app.inject({ method: 'POST', url: '/api/remote/machines/lxc-999/tun', headers: { cookie } })
  assert.equal(nf.statusCode, 404)
})

test('admin: the overview keeps addresses; the firewall rule needs a preview, then confirm, then re-confirmation', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const o = await app.inject({ method: 'GET', url: '/api/remote/overview', headers: { cookie } })
  assert.match(o.body, /192\.0\.2\.11/)
  const pv = await app.inject({ method: 'GET', url: '/api/remote/machines/node-pve-a/tailscale/firewall', headers: { cookie } })
  assert.equal(pv.statusCode, 200, pv.body)
  assert.equal(pv.json().rule.dport, '22,8006')
  const noRc = await app.inject({ method: 'POST', url: '/api/remote/machines/node-pve-a/tailscale/firewall', headers: { cookie }, payload: { confirm: true } })
  assert.equal(noRc.json().code, 'reconfirm_required')
  await app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie }, payload: { password: 'admin master password' } })
  const noConfirm = await app.inject({ method: 'POST', url: '/api/remote/machines/node-pve-a/tailscale/firewall', headers: { cookie }, payload: {} })
  assert.equal(noConfirm.statusCode, 400)
  const ok = await app.inject({ method: 'POST', url: '/api/remote/machines/node-pve-a/tailscale/firewall', headers: { cookie }, payload: { confirm: true } })
  assert.equal(ok.statusCode, 200, ok.body)
  assert.equal(ok.json().added, true)
})
