// Deleting a vault item from Settings → Secrets: admin only, re-confirmed with the master password, audited
// before anything is removed (no audit row, no delete), and never one of HyperProx's own settings.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { FakeBroker } from './fakes/fake-broker'
import { buildTestApp, resetLock, signIn } from './fakes/app'
import { needsReconfirm, requiredRole } from '../src/lib/roles'
import { setAuditSink } from '../src/lib/audit'

const broker = new FakeBroker()
// The one-item delete the route needs; the shared fake keeps items by name, so it is added here.
const trashed: string[] = []
;(broker as any).deleteSecretById = async (_sid: string, id: string) => {
  const it = [...broker.items.values()].find(i => i.id === id)
  if (!it) throw new Error('no such item')
  trashed.push(id)
  broker.items.delete(it.name)
  return { id, name: it.name }
}
broker.addUser('owner@example.com', 'owner master password', 'owner')
broker.addUser('admin@example.com', 'admin master password', 'admin')
broker.addUser('viewer@example.com', 'viewer master password', 'viewer')
const appP = buildTestApp(broker)
const audits: Array<{ action: string; resource: string; details?: Record<string, unknown> }> = []
let auditFails = false
setAuditSink({ write: async row => { if (auditFails) throw new Error('db down'); audits.push(row) } })
beforeEach(async () => { await resetLock(); audits.length = 0; auditFails = false })
after(async () => { await resetLock(); await (await appP).close(); setAuditSink(null) })

const idOf = (name: string) => broker.items.get(name)?.id ?? 'no-such-id'
const del = async (cookie: string, name: string, id = idOf(name)) => (await appP).inject({ method: 'POST', url: '/api/secrets/delete', headers: { cookie }, payload: { id, name } })
const reconfirm = async (cookie: string, password: string) => (await appP).inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie }, payload: { password } })

test('the matrix: admin, and re-confirmed', () => {
  assert.equal(requiredRole('POST', '/api/secrets/delete'), 'admin')
  assert.equal(needsReconfirm('POST', '/api/secrets/delete'), true)
})

test('a viewer cannot delete; an admin must re-confirm first; then the item goes, with an audit row', async () => {
  broker.items.set('router-admin', { id: 'r1', name: 'router-admin', fields: { password: 's3cret-value' } })
  const v = await signIn(await appP, 'viewer@example.com', 'viewer master password')
  assert.equal((await del(v.cookie, 'router-admin')).statusCode, 403)

  const a = await signIn(await appP, 'admin@example.com', 'admin master password')
  const first = await del(a.cookie, 'router-admin')
  assert.equal(first.statusCode, 403)
  assert.equal(first.json().code, 'reconfirm_required')
  assert.ok(broker.items.has('router-admin'))

  await reconfirm(a.cookie, 'admin master password')
  const ok = await del(a.cookie, 'router-admin')
  assert.equal(ok.statusCode, 200, ok.body)
  assert.deepEqual(ok.json().data, { id: 'r1', name: 'router-admin', trashed: true })
  assert.ok(!ok.body.includes('s3cret-value'))
  assert.equal(broker.items.has('router-admin'), false)
  assert.equal(audits.length, 1)
  assert.equal(audits[0].action, 'secret.delete')
  assert.equal(audits[0].resource, 'vault:router-admin')
  assert.equal(audits[0].details?.id, 'r1')
  assert.equal(audits[0].details?.name, 'router-admin')
  assert.ok(!JSON.stringify(audits).includes('s3cret-value'), 'the value is never audited')
  // Gone from the cached list too.
  const list = await (await appP).inject({ method: 'GET', url: '/api/secrets', headers: { cookie: a.cookie } })
  assert.equal(list.json().data.some((i: any) => i.name === 'router-admin'), false)
})

test('no audit row, no delete; HyperProx settings and unknown names are refused', async () => {
  broker.items.set('nas-admin', { id: 'n1', name: 'nas-admin', fields: { password: 'x' } })
  broker.items.set('hyperprox:dns/godaddy', { id: 'h1', name: 'hyperprox:dns/godaddy', fields: { api_key: 'k' } })
  const o = await signIn(await appP, 'owner@example.com', 'owner master password')
  await reconfirm(o.cookie, 'owner master password')

  auditFails = true
  const r = await del(o.cookie, 'nas-admin')
  assert.equal(r.statusCode, 503)
  assert.ok(broker.items.has('nas-admin'))
  auditFails = false

  const managed = await del(o.cookie, 'hyperprox:dns/godaddy')
  assert.equal(managed.statusCode, 400)
  assert.equal(managed.json().code, 'managed')
  assert.ok(broker.items.has('hyperprox:dns/godaddy'))

  assert.equal((await del(o.cookie, 'no-such-thing')).statusCode, 404)
  assert.equal((await del(o.cookie, '')).statusCode, 400)
})

test('only the chosen item goes: a same-named twin stays; a mismatched or missing id is refused', async () => {
  const o = await signIn(await appP, 'owner@example.com', 'owner master password')
  await reconfirm(o.cookie, 'owner master password')
  const twins = [
    { id: 't1', name: 'switch-admin', fields: { password: 'one' } },
    { id: 't2', name: 'switch-admin', fields: { password: 'two' } },
  ]
  const realList = broker.listSecrets.bind(broker)
  const realDel = (broker as any).deleteSecretById
  const asked: string[] = []
  broker.listSecrets = async () => twins.map(t => ({ ...t, fields: { ...t.fields } }))
  ;(broker as any).deleteSecretById = async (_sid: string, id: string) => { asked.push(id); return { id, name: 'switch-admin' } }
  try {
    const r = await del(o.cookie, 'switch-admin', 't2')
    assert.equal(r.statusCode, 200, r.body)
    assert.deepEqual(asked, ['t2'], 'exactly the selected id, not every item named switch-admin')
    assert.equal(audits.length, 1)
    assert.equal(audits[0].details?.id, 't2')
    assert.equal(audits[0].details?.name, 'switch-admin')
    assert.equal((await del(o.cookie, 'other-name', 't1')).statusCode, 404, 'the name must match the id')
    assert.equal((await del(o.cookie, 'switch-admin', 'gone')).statusCode, 404)
    assert.equal((await (await appP).inject({ method: 'POST', url: '/api/secrets/delete', headers: { cookie: o.cookie }, payload: { name: 'switch-admin' } })).statusCode, 400, 'the id is required')
    assert.deepEqual(asked, ['t2'])
  } finally {
    broker.listSecrets = realList
    ;(broker as any).deleteSecretById = realDel
  }
})
