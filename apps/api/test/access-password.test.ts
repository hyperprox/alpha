// What hands out a way in keeps the master password, not an in-page confirmation: Tailscale and NetBird join keys and
// sign-in links, approving a device, a new WireGuard device or a rotated key (its config comes back), a site's one-time admin sign-in, and
// trusting nodes' SSH host keys. Through the real gate: the password is asked for, a confirmation token is no substitute,
// API tokens are refused, and replacing the installer's host keys needs the password again within the last minute.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { buildSetupChecklistRoutes } from '../src/routes/setup-checklist'
import { needsConfirm, needsPassword, needsReconfirm } from '../src/lib/roles'
import { signIn } from './fakes/app'
import { FakeBroker } from './fakes/fake-broker'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { setAuditSink } from '../src/lib/audit'
import { MemoryApiTokenStore, setApiTokenStore, createApiToken } from '../src/lib/api-tokens'

const broker = new FakeBroker()
broker.addUser('admin@example.com', 'admin master password', 'admin')
let tokens: MemoryApiTokenStore

before(() => {
  setBroker(broker)
  tokens = new MemoryApiTokenStore()
  setApiTokenStore(tokens)
  setAuditSink({ async write() {} })
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
})
after(async () => { setApiTokenStore(null); setAuditSink(null); if (isUnlocked()) await lock('manual') })

const MOVED: string[] = [
  '/api/remote/machines/m1/tailscale/manual-key',
  '/api/remote/machines/m1/netbird/manual-key',
  '/api/remote/machines/m1/tailscale/login-url',
  '/api/remote/machines/m1/netbird/login-url',
  '/api/remote/devices/tailscale/d1/approve',
  '/api/remote/devices/netbird/d1/approve',
  '/api/vpn/wg/servers/s1/devices',
  '/api/vpn/wg/router/devices',
  '/api/vpn/wg/peers/p1/rotate',
  '/api/sites/s1/admin-login',
  '/api/setup-checklist/host-keys/anchor',
  '/api/setup-checklist/host-keys/confirm',
  '/api/ha/nodes/n1/hostkey/pin',
  '/api/clusters/c0123456789/verify-keys',
]
/** A route that is confirmed on the page, to get a real confirmation token from. */
const CONFIRMED = '/api/remote/jobs'

test('roles: each of these needs the master password, and is not an in-page confirmation', () => {
  for (const p of MOVED) {
    assert.equal(needsPassword('POST', p), true, p)
    assert.equal(needsConfirm('POST', p), false, p)
    assert.equal(needsReconfirm('POST', p), true, p)
  }
  // Their neighbours stay as they were: confirmed on the page.
  assert.equal(needsConfirm('POST', '/api/remote/machines/m1/tailscale/routing'), true)
  assert.equal(needsConfirm('POST', '/api/sites/s1/delete'), true)
  assert.equal(needsConfirm('POST', '/api/ha/plans/x/apply'), true)
  assert.equal(needsConfirm('POST', '/api/setup-checklist/node-login/run'), true)
  assert.equal(needsPassword('POST', '/api/vpn/wg/router/peers/preview'), false, 'a preview only reads')
})

async function app(): Promise<{ a: FastifyInstance; hits: string[] }> {
  const hits: string[] = []
  const a = Fastify({ logger: false })
  await registerGate(a)
  await a.register(authRoutes, { prefix: '/api/auth' })
  for (const p of [...MOVED, CONFIRMED]) a.post(p, async () => { hits.push(p); return { ok: true } })
  await a.ready()
  return { a, hits }
}

test('through the gate: the password is asked for, a confirmation token is no substitute, API tokens are refused', async () => {
  const { a, hits } = await app()
  try {
    const adm = await signIn(a, 'admin@example.com', 'admin master password')
    assert.equal(adm.res.statusCode, 200, adm.res.body)
    const tok = (await createApiToken({ name: 'bot', role: 'admin' }, 'test', tokens)).token
    for (const p of MOVED) {
      const plain = await a.inject({ method: 'POST', url: p, headers: { cookie: adm.cookie }, payload: {} })
      assert.equal(plain.statusCode, 403, p); assert.equal(JSON.parse(plain.body).code, 'reconfirm_required', p)
      // A real, unused confirmation token, taken from a route that is confirmed on the page.
      const asked = await a.inject({ method: 'POST', url: CONFIRMED, headers: { cookie: adm.cookie }, payload: {} })
      const token = JSON.parse(asked.body).confirm?.token
      assert.equal(typeof token, 'string', 'the confirmed route hands out a token')
      const withToken = await a.inject({ method: 'POST', url: p, headers: { cookie: adm.cookie, 'x-hyperprox-confirm': token }, payload: {} })
      assert.equal(withToken.statusCode, 403, p); assert.equal(JSON.parse(withToken.body).code, 'reconfirm_required', p)
      const bot = await a.inject({ method: 'POST', url: p, headers: { authorization: `Bearer ${tok}` }, payload: {} })
      assert.equal(bot.statusCode, 403, p); assert.match(JSON.parse(bot.body).code, /^(token_forbidden|reconfirm_required)$/, p)
    }
    assert.deepEqual(hits, [], 'nothing ran')
    const r = await a.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie: adm.cookie }, payload: { password: 'admin master password' } })
    assert.equal(r.statusCode, 200, r.body)
    for (const p of MOVED) {
      const ok = await a.inject({ method: 'POST', url: p, headers: { cookie: adm.cookie }, payload: {} })
      assert.equal(ok.statusCode, 200, `${p}: ${ok.body}`)
    }
    assert.deepEqual(hits, MOVED)
    // Still refused to an API token, password or not.
    for (const p of MOVED) {
      const bot = await a.inject({ method: 'POST', url: p, headers: { authorization: `Bearer ${tok}` }, payload: {} })
      assert.equal(bot.statusCode, 403, p)
    }
  } finally { await a.close() }
})

test('replacing the host keys the installer read needs the master password again within the last minute', async () => {
  const a = Fastify({ logger: false })
  await registerGate(a)
  await a.register(authRoutes, { prefix: '/api/auth' })
  await a.register(buildSetupChecklistRoutes(() => ({}) as any), { prefix: '/api/setup-checklist' })
  await a.ready()
  const realNow = Date.now
  try {
    const adm = await signIn(a, 'admin@example.com', 'admin master password')
    const url = '/api/setup-checklist/host-keys/anchor'
    const r = await a.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie: adm.cookie }, payload: { password: 'admin master password' } })
    assert.equal(r.statusCode, 200, r.body)
    // Fresh: past the extra check (the empty output is then refused for what it is, not for the password).
    const fresh = await a.inject({ method: 'POST', url, headers: { cookie: adm.cookie }, payload: { output: '', replaceInstaller: true } })
    assert.notEqual(JSON.parse(fresh.body).code, 'reconfirm_required', fresh.body)
    // Two minutes later: still inside the gate's five minutes, but not fresh enough to replace the installer's keys.
    Date.now = () => realNow() + 2 * 60_000
    const stale = await a.inject({ method: 'POST', url, headers: { cookie: adm.cookie }, payload: { output: '', replaceInstaller: true } })
    assert.equal(stale.statusCode, 403); assert.equal(JSON.parse(stale.body).code, 'reconfirm_required')
    assert.match(JSON.parse(stale.body).error, /once more/)
    // And that refusal ended the re-confirmation: the next change asks again.
    const after = await a.inject({ method: 'POST', url, headers: { cookie: adm.cookie }, payload: { output: '' } })
    assert.equal(after.statusCode, 403); assert.equal(JSON.parse(after.body).code, 'reconfirm_required')
  } finally { Date.now = realNow; await a.close() }
})
