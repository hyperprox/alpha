// Certificates on a fresh install: the policy file is created with safe defaults (from the example), node
// certificates are named by their node and never by 127.0.0.1, and housekeeping with no proxy is a state.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { ensureCertsPolicy, loadCertsPolicy, starterCertsPolicy } from '../src/lib/certs/policy'
import { nodeCertNames } from '../src/lib/certs/inventory'
import { buildCertsRoutes } from '../src/routes/certs'
import { ProxyNotConfigured } from '../src/lib/certs/modules'

const EXAMPLE = path.resolve(__dirname, '../../../config/certs.example.yaml')

test('a missing policy is created from the example with safe defaults, and loads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-certs-'))
  fs.copyFileSync(EXAMPLE, path.join(dir, 'certs.example.yaml'))
  const file = path.join(dir, 'certs.yaml')
  assert.equal(loadCertsPolicy(file).loaded, false)
  assert.deepEqual(ensureCertsPolicy(file), { created: true })
  const load = loadCertsPolicy(file)
  assert.equal(load.loaded, true, load.error)
  // Safe: staging, nothing issued, probed or deployed beyond what is discovered.
  assert.equal(load.policy.acme.staging, true)
  assert.equal(load.policy.acme.email, null)
  assert.deepEqual(load.policy.certificates, {})
  assert.deepEqual(load.policy.probes, [])
  assert.deepEqual(load.policy.targets, {})
  // The example is there, commented, for reference.
  const text = fs.readFileSync(file, 'utf8')
  assert.match(text, /^# certificates:/m)
  assert.equal((fs.statSync(file).mode & 0o777), 0o640)
  // Never overwritten.
  fs.writeFileSync(file, 'acme:\n  directory: production\n')
  assert.deepEqual(ensureCertsPolicy(file), { created: false })
  assert.equal(fs.readFileSync(file, 'utf8'), 'acme:\n  directory: production\n')
})

test('without the example, the starter stands on its own; an unwritable place is reported, not thrown', () => {
  assert.equal(loadCertsPolicy(writeTmp(starterCertsPolicy(null))).loaded, true)
  const r = ensureCertsPolicy('/proc/hyperprox-test/certs.yaml', '/nonexistent/example.yaml')
  assert.equal(r.created, false)
  assert.match(r.error ?? '', /Could not create/)
})

function writeTmp(text: string): string {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-certs-')), 'certs.yaml')
  fs.writeFileSync(f, text)
  return f
}

test('node certificates: named by the node, loopback names dropped', () => {
  const san = ['IP Address:127.0.0.1', 'IP Address:0:0:0:0:0:0:0:1', 'DNS:localhost', 'DNS:node-a', 'IP Address:192.0.2.11', 'DNS:node-a.example.lan']
  assert.deepEqual(nodeCertNames('node-a', san), ['node-a', '192.0.2.11', 'node-a.example.lan'])
  assert.deepEqual(nodeCertNames('node-b', ['IP Address:127.0.0.1', 'DNS:localhost']), ['node-b'])
  assert.deepEqual(nodeCertNames('node-c', undefined), ['node-c'])
})

test('housekeeping with no proxy connected is an empty, not-configured answer, not a 503', async () => {
  const app = Fastify()
  app.addHook('onRequest', async req => { (req as any).session = { sid: 's', role: 'admin', email: 'a@example.com' } })
  const service = { housekeeping: async () => { throw new ProxyNotConfigured() } } as any
  await app.register(buildCertsRoutes({ service, scheduler: false, recover: false }), { prefix: '/api/certs' })
  const r = await app.inject({ method: 'GET', url: '/api/certs/housekeeping' })
  assert.equal(r.statusCode, 200)
  assert.deepEqual(r.json().items, [])
  assert.equal(r.json().configured, false)
  const broken = Fastify()
  broken.addHook('onRequest', async req => { (req as any).session = { sid: 's', role: 'admin', email: 'a@example.com' } })
  await broken.register(buildCertsRoutes({ service: { housekeeping: async () => { throw new Error('proxy answered 500') } } as any, scheduler: false, recover: false }), { prefix: '/api/certs' })
  assert.equal((await broken.inject({ method: 'GET', url: '/api/certs/housekeeping' })).statusCode, 503)
  await app.close(); await broken.close()
})
