// The router matches on the decoded path; the gate's checks must see the same path.
// Before normalisePath decoded, /api/secrets/%72eveal reached reveal with no
// re-confirmation, and DELETE /api/proxmox/nodes/n1/%6cxc/100 destroyed a guest without one.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { FakeBroker } from './fakes/fake-broker'
import { buildTestApp, resetLock, signIn } from './fakes/app'
import { normalisePath, requiredRole } from '../src/lib/roles'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { confirmAfterReconfirm } from './fakes/confirm'

const broker = new FakeBroker()
broker.addUser('admin@example.com', 'admin master password', 'admin')
broker.items.set('x', { id: 'i', name: 'x', fields: { password: 'pw' } })
const appP = buildTestApp(broker).then(confirmAfterReconfirm)
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
  // A reveal still needs the master password; a destroy needs a confirmation on the page.
  for (const [method, url, code] of [
    ['POST', '/api/secrets/%72eveal', 'reconfirm_required'],
    ['POST', '/api/%73ecrets/reveal', 'reconfirm_required'],
    ['DELETE', '/api/proxmox/nodes/n1/%6cxc/100', 'confirm_required'],
    ['DELETE', '/api/proxmox/nodes/n1/lxc/1%30%30', 'confirm_required'],
  ] as const) {
    const res = await app.inject({ method, url, headers: { cookie }, payload: method === 'POST' ? { name: 'x' } : undefined })
    assert.equal(res.statusCode, 403, `${method} ${url}: ${res.body}`)
    assert.equal(res.json().code, code, url)
  }
  // An encoded slash is not a segment break for the router either: whatever it reaches, it is not a destroy.
  const slash = await app.inject({ method: 'DELETE', url: '/api/proxmox/nodes/n1/lxc/1%2F0', headers: { cookie } })
  assert.notEqual(slash.statusCode, 200, slash.body)
})

// ── Absolute-form request targets and other spellings of an admin route ─────────────────────────────────────────
// `GET http://host/api/secrets HTTP/1.1` keeps the scheme and host in req.url while the router serves /api/secrets,
// so the role checks would have read a path they do not know (a GET defaults to viewer). Sent over a real socket:
// inject() rewrites the target before the server sees it.
broker.addUser('viewer@example.com', 'viewer master password', 'viewer')
let portP: Promise<number> | null = null
const port = () => (portP ??= appP.then(async app => { await app.listen({ port: 0, host: '127.0.0.1' }); return (app.server.address() as AddressInfo).port }))

function rawGet(p: number, target: string, cookie?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const s = net.connect(p, '127.0.0.1', () => {
      s.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\n${cookie ? `Cookie: ${cookie}\r\n` : ''}Connection: close\r\n\r\n`)
    })
    let buf = ''
    s.setEncoding('utf8')
    s.on('data', d => { buf += d })
    s.on('end', () => {
      const m = /^HTTP\/1\.1 (\d{3})/.exec(buf)
      resolve({ status: m ? Number(m[1]) : 0, body: buf.slice(buf.indexOf('\r\n\r\n') + 4) })
    })
    s.on('error', reject)
  })
}

test('an absolute-form request target is refused before any check (400 bad_path)', async () => {
  const p = await port()
  const app = await appP
  const { cookie } = await signIn(app, 'viewer@example.com', 'viewer master password')
  for (const target of ['http://h/api/secrets', 'HTTP://h/api/secrets', 'http://127.0.0.1/api/secrets', 'https://h/api/secrets/', 'http://h/health']) {
    for (const c of [cookie, undefined]) {
      const res = await rawGet(p, target, c)
      assert.equal(res.status, 400, `${target}: ${res.status} ${res.body}`)
      assert.match(res.body, /"code":"bad_path"/, target)
    }
  }
})

test('a viewer cannot reach an admin GET route by any spelling of its path', async () => {
  const p = await port()
  const app = await appP
  const admin = await signIn(app, 'admin@example.com', 'admin master password')
  const viewer = await signIn(app, 'viewer@example.com', 'viewer master password')
  // The route exists and serves an admin; a viewer gets 403 on the plain path.
  assert.equal((await rawGet(p, '/api/secrets', admin.cookie)).status, 200)
  assert.equal((await rawGet(p, '/api/secrets', viewer.cookie)).status, 403)
  for (const target of [
    '/api/secrets', '/api/secrets/', '/api/secrets?refresh=1', '/api/%73ecrets', '/api/secret%73', '/%61pi/secrets',
    '//api/secrets', '///api/secrets', '/api//secrets', '/api/./secrets', '/api/x/../secrets', '/API/secrets', '/api/SECRETS',
    '/api/secrets;x', '/api;x/secrets', '/api/secrets%3bx', '/api/secrets%2f', '/api/secrets#x',
    'http://h/api/secrets', 'HTTP://h/api/secrets', 'http://h//api/secrets', 'http://h/api/%73ecrets',
  ]) {
    const res = await rawGet(p, target, viewer.cookie)
    assert.notEqual(res.status, 200, `${target}: ${res.body}`)
    assert.doesNotMatch(res.body, /"(success|ok)":true/, target)
  }
})
