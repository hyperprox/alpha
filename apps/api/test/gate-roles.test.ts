import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { FakeBroker } from './fakes/fake-broker'
import { buildTestApp, resetLock, signIn } from './fakes/app'
import { requiredRole, needsReconfirm, hasRole } from '../src/lib/roles'

// ── The matrix as a pure function ────────────────────────────────────────────

test('requiredRole: public paths', () => {
  for (const [m, p] of [['GET', '/health'], ['GET', '/health/x'], ['GET', '/api/auth/status'], ['POST', '/api/auth/sign-in'],
    ['POST', '/api/auth/bootstrap'], ['POST', '/api/auth/bootstrap/confirm'], ['POST', '/api/auth/sign-out'], ['GET', '/api/plugins/metrics']]) {
    assert.equal(requiredRole(m, p), null, `${m} ${p}`)
  }
})

test('requiredRole: viewer reads, operator power/terminal, admin the rest, owner roles', () => {
  const cases: Array<[string, string, string]> = [
    ['GET',    '/api/proxmox/resources',                  'viewer'],
    ['GET',    '/api/proxmox/summary?x=1',                'viewer'],
    ['GET',    '/ws',                                     'viewer'],
    ['GET',    '/api/secrets',                            'viewer'],
    ['GET',    '/ws/terminal/term?id=a',                  'operator'],
    ['GET',    '/api/settings/proxmox',                   'admin'],
    ['POST',   '/api/infra/vms/n1/100/lxc/start',         'operator'],
    ['POST',   '/api/infra/vms/n1/100/qemu/shutdown',     'operator'],
    ['POST',   '/api/proxmox/vms/n1/100/lxc/reboot',      'operator'],
    ['POST',   '/api/proxmox/vms/n1/100/lxc/stop',        'operator'],
    ['POST',   '/api/infra/vms/n1/100/qemu/vnc',          'operator'],
    ['POST',   '/api/terminal/hosts/abc/tmux-sessions',   'operator'],
    ['PUT',    '/api/terminal/layouts',                   'operator'],
    ['DELETE', '/api/terminal/layouts/main',              'operator'],
    ['PUT',    '/api/terminal/credentials/abc',           'admin'],
    ['POST',   '/api/terminal/hosts/abc/enable-persistence', 'admin'],
    ['POST',   '/api/infra/vms/n1/100/lxc/migrate',       'admin'],
    ['POST',   '/api/infra/vms/n1/100/lxc/snapshots',     'admin'],
    ['PUT',    '/api/infra/ha/ct:100',                    'admin'],
    ['DELETE', '/api/proxmox/nodes/n1/lxc/100',           'admin'],
    ['POST',   '/api/proxmox/lxc',                        'admin'],
    ['PUT',    '/api/settings/dns/godaddy',               'admin'],
    ['POST',   '/api/secrets/reveal',                     'admin'],
    ['POST',   '/api/auth/lock',                          'admin'],
    ['POST',   '/api/auth/reconfirm',                     'viewer'],
    ['POST',   '/api/something/new',                      'admin'],
    ['PUT',    '/api/roles/someone',                      'owner'],
    ['GET',    '/api/roles',                              'owner'],
  ]
  for (const [m, p, r] of cases) assert.equal(requiredRole(m, p), r, `${m} ${p}`)
})

test('needsReconfirm: destroy, reveal, role changes only', () => {
  assert.equal(needsReconfirm('DELETE', '/api/proxmox/nodes/n1/qemu/100'), true)
  assert.equal(needsReconfirm('POST', '/api/secrets/reveal'), true)
  assert.equal(needsReconfirm('PUT', '/api/roles/x'), true)
  assert.equal(needsReconfirm('POST', '/api/infra/vms/n1/100/lxc/stop'), false)
  assert.equal(needsReconfirm('GET', '/api/secrets'), false)
  assert.equal(needsReconfirm('POST', '/api/secrets/send'), false)
})

test('hasRole ordering', () => {
  assert.equal(hasRole('owner', 'admin'), true)
  assert.equal(hasRole('admin', 'owner'), false)
  assert.equal(hasRole('operator', 'viewer'), true)
  assert.equal(hasRole('viewer', 'operator'), false)
})

// ── Enforced over HTTP ───────────────────────────────────────────────────────

const broker = new FakeBroker()
broker.addUser('owner@example.com', 'owner master password', 'owner')
broker.addUser('admin@example.com', 'admin master password', 'admin')
broker.addUser('op@example.com', 'operator master password', 'operator')
broker.addUser('viewer@example.com', 'viewer master password', 'viewer')
const appP = buildTestApp(broker)
beforeEach(resetLock)
after(async () => { await resetLock(); await (await appP).close() })

const POWER   = '/api/proxmox/vms/n1/100/lxc/start'
const DESTROY = '/api/proxmox/nodes/n1/lxc/100'

test('viewer: GET ok, power action 403', async () => {
  const app = await appP
  const { cookie } = await signIn(app, 'viewer@example.com', 'viewer master password')
  assert.equal((await app.inject({ method: 'GET', url: '/api/proxmox/resources', headers: { cookie } })).statusCode, 200)
  const p = await app.inject({ method: 'POST', url: POWER, headers: { cookie } })
  assert.equal(p.statusCode, 403)
  assert.equal(p.json().code, 'forbidden')
})

test('operator: power action ok, destroy 403', async () => {
  const app = await appP
  const { cookie } = await signIn(app, 'op@example.com', 'operator master password')
  assert.equal((await app.inject({ method: 'POST', url: POWER, headers: { cookie } })).statusCode, 200)
  const d = await app.inject({ method: 'DELETE', url: DESTROY, headers: { cookie } })
  assert.equal(d.statusCode, 403)
  assert.equal(d.json().code, 'forbidden')
})

test('admin: destroy needs re-confirmation, then works for 5 minutes', async () => {
  const app = await appP
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const first = await app.inject({ method: 'DELETE', url: DESTROY, headers: { cookie } })
  assert.equal(first.statusCode, 403)
  assert.equal(first.json().code, 'reconfirm_required')

  const wrong = await app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie }, payload: { password: 'nope' } })
  assert.equal(wrong.statusCode, 401)

  const rc = await app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie }, payload: { password: 'admin master password' } })
  assert.equal(rc.statusCode, 200)
  const until = Date.parse(rc.json().until)
  assert.ok(until > Date.now() + 4 * 60_000 && until <= Date.now() + 5 * 60_000 + 1000)

  const ok = await app.inject({ method: 'DELETE', url: DESTROY, headers: { cookie } })
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.json().destroyed, '100')
})

test('re-confirmation is per session', async () => {
  const app = await appP
  const a = await signIn(app, 'admin@example.com', 'admin master password')
  const o = await signIn(app, 'owner@example.com', 'owner master password')
  await app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie: a.cookie }, payload: { password: 'admin master password' } })
  const d = await app.inject({ method: 'DELETE', url: DESTROY, headers: { cookie: o.cookie } })
  assert.equal(d.json().code, 'reconfirm_required')
})

test('secrets: viewer lists names, cannot reveal; admin reveals after re-confirm; send and generate', async () => {
  const app = await appP
  broker.items.set('router-admin', { id: 'r1', name: 'router-admin', fields: { password: 's3cret-value' } })
  const o = await signIn(app, 'owner@example.com', 'owner master password')

  const v = await signIn(app, 'viewer@example.com', 'viewer master password')
  const list = await app.inject({ method: 'GET', url: '/api/secrets', headers: { cookie: v.cookie } })
  assert.equal(list.statusCode, 200)
  assert.ok(!list.body.includes('s3cret-value'))
  assert.deepEqual(list.json().data.find((i: any) => i.name === 'router-admin').fields, ['password'])
  assert.equal((await app.inject({ method: 'POST', url: '/api/secrets/reveal', headers: { cookie: v.cookie }, payload: { name: 'router-admin' } })).statusCode, 403)

  const need = await app.inject({ method: 'POST', url: '/api/secrets/reveal', headers: { cookie: o.cookie }, payload: { name: 'router-admin' } })
  assert.equal(need.json().code, 'reconfirm_required')
  await app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie: o.cookie }, payload: { password: 'owner master password' } })
  const rev = await app.inject({ method: 'POST', url: '/api/secrets/reveal', headers: { cookie: o.cookie }, payload: { name: 'router-admin' } })
  assert.equal(rev.statusCode, 200)
  assert.equal(rev.json().data.fields.password, 's3cret-value')

  const send = await app.inject({ method: 'POST', url: '/api/secrets/send', headers: { cookie: o.cookie }, payload: { name: 'router-admin' } })
  assert.equal(send.statusCode, 200)
  assert.match(send.json().data.url, /^https:\/\//)
  const sc = broker.callsTo('createSend').at(-1)!
  assert.equal(sc.args[1], 's3cret-value')
  assert.deepEqual(sc.args[2], { hours: 24, maxViews: 1, password: undefined })

  const gen = await app.inject({ method: 'POST', url: '/api/secrets/generate', headers: { cookie: o.cookie }, payload: { name: 'db-app', purpose: 'App database user' } })
  assert.equal(gen.statusCode, 200)
  assert.ok(!gen.body.includes(broker.items.get('db-app')!.fields.password))
  assert.equal(broker.items.get('db-app')!.fields.password.length, 24)
  assert.match(broker.items.get('db-app')!.notes!, /App database user/)
  assert.equal((await app.inject({ method: 'POST', url: '/api/secrets/generate', headers: { cookie: o.cookie }, payload: { name: 'hyperprox:dns/x', purpose: 'p' } })).statusCode, 400)
})
