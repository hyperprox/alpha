// Cross-site requests: a state-changing request or a WebSocket upgrade whose Origin (or Sec-Fetch-Site) is not
// this host is refused by the gate before anything else, so another site's page cannot drive a signed-in browser.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { FakeBroker, GOOD_CODE } from './fakes/fake-broker'
import { buildTestApp, resetLock, signIn } from './fakes/app'

const broker = new FakeBroker()
broker.addUser('admin@example.com', 'admin master password', 'admin')
const appP = buildTestApp(broker)
after(async () => { await resetLock(); await (await appP).close() })

const SIGN_IN = { email: 'admin@example.com', password: 'admin master password', code: GOOD_CODE }

test('a cross-site sign-in or write is refused before it is looked at; same-origin and header-less clients pass', async () => {
  const app = await appP
  const evil = await app.inject({ method: 'POST', url: '/api/auth/sign-in', headers: { host: 'hpx.example', origin: 'https://evil.example' }, payload: SIGN_IN })
  assert.equal(evil.statusCode, 403)
  assert.equal(evil.json().code, 'cross_origin')
  assert.equal(broker.callsTo('signIn').length, 0)

  const same = await app.inject({ method: 'POST', url: '/api/auth/sign-in', headers: { host: 'hpx.example', origin: 'https://hpx.example' }, payload: SIGN_IN })
  assert.equal(same.statusCode, 200, same.body)
  const cookie = String(same.headers['set-cookie']).split(';')[0]

  for (const headers of [
    { host: 'hpx.example', origin: 'https://evil.example', cookie },
    { host: 'hpx.example', origin: 'https://hpx.example.evil.example', cookie },
    { host: 'hpx.example', origin: 'null', cookie },
    { host: 'hpx.example:8443', origin: 'https://hpx.example:9443', cookie },
    { host: 'hpx.example', 'sec-fetch-site': 'cross-site', cookie },
    { host: 'hpx.example', 'sec-fetch-site': 'same-site', cookie },
  ]) {
    const r = await app.inject({ method: 'PUT', url: '/api/test/probe', headers, payload: { value: 'x' } })
    assert.equal(r.statusCode, 403, JSON.stringify(headers))
    assert.equal(r.json().code, 'cross_origin')
  }
  // Reads are not affected; scripts with no Origin and no Sec-Fetch-Site are not either.
  assert.equal((await app.inject({ method: 'GET', url: '/api/test/probe', headers: { host: 'hpx.example', origin: 'https://evil.example', cookie } })).statusCode, 200)
  assert.equal((await app.inject({ method: 'PUT', url: '/api/test/probe', headers: { host: 'hpx.example', cookie }, payload: { value: 'x' } })).statusCode, 200)
  assert.equal((await app.inject({ method: 'PUT', url: '/api/test/probe', headers: { host: 'hpx.example', 'sec-fetch-site': 'same-origin', cookie }, payload: { value: 'x' } })).statusCode, 200)
})

test('the host behind nginx is X-Forwarded-Host, believed only from loopback', async () => {
  const app = await appP
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const viaProxy = await app.inject({ method: 'PUT', url: '/api/test/probe', remoteAddress: '127.0.0.1',
    headers: { host: '127.0.0.1:3002', 'x-forwarded-host': 'hpx.example:8443', origin: 'https://hpx.example:8443', cookie }, payload: { value: 'x' } })
  assert.equal(viaProxy.statusCode, 200, viaProxy.body)
  // nginx's $host drops the port: the same hostname on that port is accepted.
  const noPort = await app.inject({ method: 'PUT', url: '/api/test/probe', remoteAddress: '127.0.0.1',
    headers: { host: 'hpx.example', origin: 'https://hpx.example:8443', cookie }, payload: { value: 'x' } })
  assert.equal(noPort.statusCode, 200, noPort.body)
  // From anywhere else, X-Forwarded-Host is the client's own claim and is ignored.
  const direct = await app.inject({ method: 'PUT', url: '/api/test/probe', remoteAddress: '198.51.100.7',
    headers: { host: 'hpx.example', 'x-forwarded-host': 'evil.example', origin: 'https://evil.example', cookie }, payload: { value: 'x' } })
  assert.equal(direct.statusCode, 403)
})

test('a WebSocket upgrade from another site is refused; the local CLI lock still works', async () => {
  const app = await appP
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const ws = await app.inject({ method: 'GET', url: '/ws', headers: { host: 'hpx.example', origin: 'https://evil.example', upgrade: 'websocket', connection: 'Upgrade', cookie } })
  assert.equal(ws.statusCode, 403)
  assert.equal(ws.json().code, 'cross_origin')
  const lock = await app.inject({ method: 'POST', url: '/api/auth/lock', remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:3002' } })
  assert.equal(lock.statusCode, 200, lock.body)
})
