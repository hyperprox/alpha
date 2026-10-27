// The router matches on the decoded path; the gate's checks must see the same path.
// Before normalisePath decoded, /api/secrets/%72eveal reached reveal with no
// re-confirmation, and DELETE /api/proxmox/nodes/n1/%6cxc/100 destroyed a guest without one.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { FakeBroker } from './fakes/fake-broker'
import { buildTestApp, resetLock, signIn } from './fakes/app'
import { normalisePath, requiredRole } from '../src/lib/roles'

const broker = new FakeBroker()
broker.addUser('admin@example.com', 'admin master password', 'admin')
broker.items.set('x', { id: 'i', name: 'x', fields: { password: 'pw' } })
const appP = buildTestApp(broker)
after(async () => { await resetLock(); await (await appP).close() })

test('normalisePath decodes like decodeURI and keeps %2F encoded', () => {
  assert.equal(normalisePath('/api/secrets/%72eveal?x=%41'), '/api/secrets/reveal')
  assert.equal(normalisePath('/api/%73ettings/'), '/api/settings')
  assert.equal(normalisePath('/api/a%2Fb'), '/api/a%2Fb')
  assert.equal(normalisePath('/api/%E0%A4%A'), '/api/%E0%A4%A')   // malformed: left alone
  assert.equal(requiredRole('GET', '/api/%73ettings/dns'), 'admin')
  assert.equal(requiredRole('GET', '/api/c%65rts/overview'), 'admin')
})

test('encoded paths do not skip re-confirmation', async () => {
  const app = await appP
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  for (const [method, url] of [
    ['POST', '/api/secrets/%72eveal'],
    ['POST', '/api/%73ecrets/reveal'],
    ['DELETE', '/api/proxmox/nodes/n1/%6cxc/100'],
    ['DELETE', '/api/proxmox/nodes/n1/lxc/1%30%30'],
  ] as const) {
    const res = await app.inject({ method, url, headers: { cookie }, payload: method === 'POST' ? { name: 'x' } : undefined })
    assert.equal(res.statusCode, 403, `${method} ${url}: ${res.body}`)
    assert.equal(res.json().code, 'reconfirm_required', url)
  }
  // An encoded slash is not a segment break for the router either: whatever it reaches, it is not a destroy.
  const slash = await app.inject({ method: 'DELETE', url: '/api/proxmox/nodes/n1/lxc/1%2F0', headers: { cookie } })
  assert.notEqual(slash.statusCode, 200, slash.body)
})
