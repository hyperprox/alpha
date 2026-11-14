// DNS with no provider connected: /api/dns/domains answers an empty list that says so (not a 500), and the
// routes that need a provider answer 409 not_configured.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { makeDnsRoutes } from '../src/routes/dns'

function app(router: () => Promise<any>) {
  const f = Fastify()
  f.register(makeDnsRoutes({ router, wanIp: async () => ({ ip: '192.0.2.1', source: 'test' }), audit: async () => {} }), { prefix: '/api/dns' })
  return f
}

test('no provider: domains is an empty, not-configured answer; record routes are 409 not_configured', async () => {
  const f = app(async () => null)
  const d = await f.inject({ method: 'GET', url: '/api/dns/domains' })
  assert.equal(d.statusCode, 200)
  const b = d.json()
  assert.equal(b.success, true)
  assert.equal(b.configured, false)
  assert.equal(b.code, 'not_configured')
  assert.deepEqual(b.data, [])
  assert.match(b.message, /Connect GoDaddy or Cloudflare/)

  const r = await f.inject({ method: 'GET', url: '/api/dns/domains/example.com/records' })
  assert.equal(r.statusCode, 409)
  assert.equal(r.json().code, 'not_configured')
  const w = await f.inject({ method: 'POST', url: '/api/dns/domains/example.com/records', payload: { type: 'A', name: 'x', data: '192.0.2.5' } })
  assert.equal(w.statusCode, 409)

  const p = await f.inject({ method: 'GET', url: '/api/dns/providers' })
  assert.equal(p.statusCode, 200)
  assert.ok(p.json().data.every((x: any) => x.configured === false))
  await f.close()
})

test('a provider that fails is still a failure, not "not configured"', async () => {
  const f = app(async () => { throw new Error('vault read failed') })
  const d = await f.inject({ method: 'GET', url: '/api/dns/domains' })
  assert.equal(d.statusCode, 500)
  assert.equal(d.json().code, undefined)
  const g = app(async () => ({ getDomains: async () => { throw new Error('GoDaddy 401') } }))
  const e = await g.inject({ method: 'GET', url: '/api/dns/domains' })
  assert.equal(e.statusCode, 500)
  assert.match(e.json().error, /GoDaddy 401/)
  await f.close(); await g.close()
})
