import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { registerGate } from '../src/lib/gate'
import { publicHealthRoute } from '../src/routes/health'
import { requiredRole, bypassesLock } from '../src/lib/roles'

async function app() {
  const a = Fastify({ logger: false })
  await registerGate(a)
  await a.register(publicHealthRoute, { prefix: '/api/health' })
  a.get('/api/health/detail', async () => ({ secret: true }))
  await a.ready()
  return a
}

test('GET /api/health with no session, vault locked: 200 and only { status }', async () => {
  const a = await app()
  const r = await a.inject({ method: 'GET', url: '/api/health' })
  assert.equal(r.statusCode, 200)
  assert.deepEqual(r.json(), { status: 'ok' })
  await a.close()
})

test('only the exact path is public', async () => {
  const a = await app()
  const r = await a.inject({ method: 'GET', url: '/api/health/detail' })
  assert.notEqual(r.statusCode, 200)
  assert.equal(requiredRole('POST', '/api/health'), 'admin')
  assert.equal(requiredRole('GET', '/api/health'), null)
  assert.equal(bypassesLock('/api/healthz'), false)
  await a.close()
})
