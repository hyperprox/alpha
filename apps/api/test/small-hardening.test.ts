// Smaller pre-beta fixes: the metrics token comparison, admin-only plug-in probes, per-person Terminal layouts.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { metricsTokenMatches } from '../src/routes/plugins'
import { requiredRole } from '../src/lib/roles'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { terminalRoutes } from '../src/routes/terminal'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { FakeBroker } from './fakes/fake-broker'
import { signIn } from './fakes/app'

test('metrics token: constant-time match, nothing for empty', () => {
  assert.equal(metricsTokenMatches('abc', 'abc'), true)
  assert.equal(metricsTokenMatches('abd', 'abc'), false)
  assert.equal(metricsTokenMatches('abcd', 'abc'), false)
  assert.equal(metricsTokenMatches('', 'abc'), false)
})

test('plug-in network probes are admin-only reads', () => {
  assert.equal(requiredRole('GET', '/api/plugins/discover'), 'admin')
  assert.equal(requiredRole('GET', '/api/plugins/arrstack/stuck'), 'admin')
  assert.equal(requiredRole('GET', '/api/plugins/arrstack/detail'), 'viewer')
})

// A Terminal layouts table in memory, with Prisma's calls the route uses.
const rows: any[] = []
const prisma = { terminalLayout: {
  findMany: async () => [...rows].sort((a, b) => a.name.localeCompare(b.name)),
  upsert: async ({ where, update, create }: any) => {
    const r = rows.find(x => x.name === where.name)
    if (r) { Object.assign(r, update); return r }
    rows.push({ id: String(rows.length), ...create }); return rows.at(-1)
  },
  deleteMany: async ({ where }: any) => {
    const names: string[] = where.name.in ?? [where.name]
    for (const n of names) { const i = rows.findIndex(x => x.name === n); if (i >= 0) rows.splice(i, 1) }
    return { count: 0 }
  },
} }

const broker = new FakeBroker()
broker.addUser('ann@example.com', 'ann master password', 'operator')
broker.addUser('bob@example.com', 'bob master password', 'operator')
broker.addUser('adm@example.com', 'adm master password', 'admin')
let app: FastifyInstance
before(async () => {
  setBroker(broker)
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  app = Fastify({ logger: false })
  app.decorate('prisma', prisma as any)
  await registerGate(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(terminalRoutes, { prefix: '/api/terminal' })
  await app.ready()
})
after(async () => { if (isUnlocked()) await lock('manual'); await app.close() })

test('Terminal layouts are each person\'s own; old unowned ones are for admins', async () => {
  rows.push({ id: 'old', name: 'legacy', view: 'tabs', panes: [{ hostId: 'lxc-1' }] })
  const ann = await signIn(app, 'ann@example.com', 'ann master password')
  const bob = await signIn(app, 'bob@example.com', 'bob master password')
  const adm = await signIn(app, 'adm@example.com', 'adm master password')
  const put = await app.inject({ method: 'PUT', url: '/api/terminal/layouts', headers: { cookie: ann.cookie }, payload: { name: 'morning', view: 'grid', panes: [{ hostId: 'lxc-2', address: '192.0.2.2' }] } })
  assert.equal(put.statusCode, 200, put.body)
  assert.equal(put.json().data.name, 'morning')
  const list = async (c: string) => (await app.inject({ method: 'GET', url: '/api/terminal/layouts', headers: { cookie: c } })).json().data.map((r: any) => r.name)
  assert.deepEqual(await list(ann.cookie), ['morning'])
  assert.deepEqual(await list(bob.cookie), [], 'another person sees none of Ann\'s, nor the old unowned one')
  assert.deepEqual(await list(adm.cookie), ['legacy'], 'an admin sees the old unowned layout, not Ann\'s')
  // Bob saving the same name makes his own; deleting "morning" removes only his.
  await app.inject({ method: 'PUT', url: '/api/terminal/layouts', headers: { cookie: bob.cookie }, payload: { name: 'morning', view: 'tabs', panes: [{ hostId: 'lxc-3' }] } })
  await app.inject({ method: 'DELETE', url: '/api/terminal/layouts/morning', headers: { cookie: bob.cookie } })
  assert.deepEqual(await list(ann.cookie), ['morning'])
  assert.equal(rows.find(r => r.name === 'u:ann@example.com:morning').view, 'grid', 'Ann\'s layout was not replaced')
})
