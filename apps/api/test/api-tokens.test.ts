// API tokens through the real gate, auth, secrets and token routes, with the fake
// broker and an in-memory token store (no Postgres).
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { FakeBroker } from './fakes/fake-broker'
import { buildTestApp, resetLock, signIn } from './fakes/app'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { allSessions, removeSession, actingSid, requestContext } from '../src/lib/auth'
import {
  MemoryApiTokenStore, setApiTokenStore, createApiToken, revokeApiToken, verifyApiToken, hashToken, generateToken,
  tokenForbidden, bearerApiToken, CACHE_MS, TOUCH_MS,
} from '../src/lib/api-tokens'

const OWNER = 'owner@example.com', OWNER_PW = 'correct horse battery staple'
const ADMIN = 'admin@example.com', ADMIN_PW = 'admin master password'
const VIEWER = 'viewer@example.com', VIEWER_PW = 'viewer master password'

const broker = new FakeBroker()
broker.addUser(OWNER, OWNER_PW, 'owner')
broker.addUser(ADMIN, ADMIN_PW, 'admin')
broker.addUser(VIEWER, VIEWER_PW, 'viewer')
broker.items.set('hyperprox:dns/godaddy', { id: 'g1', name: 'hyperprox:dns/godaddy', fields: { api_key: 'key-1', api_secret: 'secret-1' } })
const appP = buildTestApp(broker)

let store: MemoryApiTokenStore
beforeEach(async () => {
  await resetLock()
  store = new MemoryApiTokenStore()
  setApiTokenStore(store)
})
after(async () => { await resetLock(); setApiTokenStore(null); await (await appP).close() })

const bearer = (t: string) => ({ authorization: `Bearer ${t}` })
async function token(role: 'viewer' | 'operator' | 'admin' = 'admin', name = `t-${role}`, expiresDays?: number) {
  return (await createApiToken({ name, role, expiresDays }, 'test', store)).token
}
async function unlockAs(email = OWNER, pw = OWNER_PW) {
  const app = await appP
  const r = await signIn(app, email, pw)
  assert.equal(r.res.statusCode, 200, r.res.body)
  return r.cookie
}

// --- Format and pure checks -----------------------------------------------------------------

test('format: hpx_ + 43 base64url chars; stored as sha256 hex only', async () => {
  const t = generateToken()
  assert.match(t, /^hpx_[A-Za-z0-9_-]{43}$/)
  const { token: plain, record } = await createApiToken({ name: 'fmt', role: 'admin' }, 'test', store)
  assert.equal(record.tokenHash, hashToken(plain))
  assert.match(record.tokenHash, /^[0-9a-f]{64}$/)
  assert.equal(JSON.stringify(store.rows).includes(plain), false)
  assert.equal(JSON.stringify(store.audits).includes(plain), false)
})

test('bearerApiToken: header only, Bearer only', () => {
  assert.equal(bearerApiToken({ authorization: 'Bearer hpx_abc' }), 'hpx_abc')
  assert.equal(bearerApiToken({ authorization: 'Bearer eyJ.x.y' }), null)
  assert.equal(bearerApiToken({ authorization: 'Basic hpx_abc' }), null)
  assert.equal(bearerApiToken({ cookie: 'hyperprox_token=hpx_abc' }), null)
})

test('tokenForbidden: the refused list', () => {
  for (const [m, p] of [
    ['POST', '/api/auth/sign-in'], ['POST', '/api/auth/sign-out'], ['POST', '/api/auth/lock'], ['POST', '/api/auth/reconfirm'],
    ['POST', '/api/auth/bootstrap'], ['GET', '/api/auth/tokens'], ['POST', '/api/auth/tokens'], ['DELETE', '/api/auth/tokens/x'],
    ['GET', '/api/secrets'], ['POST', '/api/secrets/reveal'], ['POST', '/api/secrets/send'], ['POST', '/api/secrets/generate'],
    ['GET', '/api/terminal/hosts'], ['PUT', '/api/terminal/credentials/a'], ['GET', '/ws'], ['GET', '/ws/terminal/term'], ['GET', '/ws/updates'],
    ['POST', '/api/infra/vms/n1/100/qemu/vnc'], ['GET', '/api/secrets/?x=1'],
  ]) assert.equal(tokenForbidden(m, p), true, `${m} ${p}`)
  for (const [m, p] of [
    ['GET', '/api/auth/status'], ['GET', '/api/proxmox/resources'], ['POST', '/api/certs/managed/x/issue'],
    ['POST', '/api/dns/domains/example.com/records'], ['POST', '/api/proxy/hosts'], ['POST', '/api/infra/vms/n1/100/lxc/start'],
  ]) assert.equal(tokenForbidden(m, p), false, `${m} ${p}`)
})

// --- Gate ----------------------------------------------------------------------------------

test('valid admin token: admin route OK, session shape, no reconfirm', async () => {
  const app = await appP
  await unlockAs()
  const t = await token('admin', 'automation')
  const res = await app.inject({ method: 'POST', url: '/api/dns/domains/example.com/records', headers: bearer(t), payload: {} })
  assert.equal(res.statusCode, 200, res.body)
  const st = await app.inject({ method: 'GET', url: '/api/auth/status', headers: bearer(t) })
  assert.equal(st.statusCode, 200)
  assert.deepEqual(st.json().user, { email: 'token:automation', role: 'admin' })
  // A token never appears as a signed-in session.
  assert.equal(allSessions().some(s => s.sid.startsWith('token:')), false)
})

test('wrong, unknown, malformed, revoked and expired tokens: 401 invalid_token', async () => {
  const app = await appP
  await unlockAs()
  const good = await token('admin', 'rev')
  const expired = await token('admin', 'exp', 1)
  store.rows.find(r => r.name === 'exp')!.expiresAt = new Date(Date.now() - 1000)
  assert.equal((await app.inject({ method: 'GET', url: '/api/proxmox/resources', headers: bearer(good) })).statusCode, 200)
  await revokeApiToken('rev', 'test', store)

  for (const t of [generateToken(), 'hpx_short', good.slice(0, -1) + (good.endsWith('A') ? 'B' : 'A'), good, expired]) {
    const res = await app.inject({ method: 'GET', url: '/api/proxmox/resources', headers: bearer(t) })
    assert.equal(res.statusCode, 401, t)
    assert.equal(res.json().code, 'invalid_token')
  }
  // A bad token is refused even on a route that needs no session.
  assert.equal((await app.inject({ method: 'GET', url: '/api/auth/status', headers: bearer('hpx_nope') })).statusCode, 401)
})

test('locked: a valid token gets 423, like everything else, and never unlocks', async () => {
  const app = await appP
  const t = await token('admin')
  assert.equal(isUnlocked(), false)
  for (const url of ['/api/proxmox/resources', '/api/dns/domains/example.com/records']) {
    const res = await app.inject({ method: url.includes('dns') ? 'POST' : 'GET', url, headers: bearer(t), payload: url.includes('dns') ? {} : undefined })
    assert.equal(res.statusCode, 423, url)
    assert.deepEqual(res.json(), { ok: false, locked: true })
  }
  // Token routes are not part of the lock bypass either.
  assert.equal((await app.inject({ method: 'GET', url: '/api/auth/tokens' })).statusCode, 423)
  // Auth routes still answer while locked, but not to a token.
  assert.equal((await app.inject({ method: 'GET', url: '/api/auth/status', headers: bearer(t) })).statusCode, 200)
  const si = await app.inject({ method: 'POST', url: '/api/auth/sign-in', headers: bearer(t), payload: { email: OWNER, password: OWNER_PW, code: '123456' } })
  assert.equal(si.statusCode, 403)
  assert.equal(si.json().code, 'token_forbidden')
  assert.equal(isUnlocked(), false)
})

test('token requests do not reset the idle-lock timer (lastSeen of people unchanged)', async () => {
  const app = await appP
  await unlockAs()
  const t = await token('admin')
  const before = allSessions().map(s => s.lastSeen)
  await new Promise(r => setTimeout(r, 5))
  assert.equal((await app.inject({ method: 'GET', url: '/api/proxmox/resources', headers: bearer(t) })).statusCode, 200)
  assert.deepEqual(allSessions().map(s => s.lastSeen), before)
})

test('reconfirm route (guest destroy): 403 reconfirm_required for an admin token', async () => {
  const app = await appP
  await unlockAs()
  const t = await token('admin')
  const res = await app.inject({ method: 'DELETE', url: '/api/proxmox/nodes/n1/lxc/100', headers: bearer(t) })
  assert.equal(res.statusCode, 403)
  assert.equal(res.json().code, 'reconfirm_required')
})

test('secrets, terminal, websockets, consoles and auth actions: 403 token_forbidden', async () => {
  const app = await appP
  await unlockAs()
  const t = await token('admin')
  for (const [method, url] of [
    ['GET', '/api/secrets'], ['GET', '/api/secrets/'], ['POST', '/api/secrets/reveal'], ['POST', '/api/secrets/send'], ['POST', '/api/secrets/generate'],
    ['GET', '/api/terminal/hosts'], ['GET', '/ws'], ['GET', '/ws/terminal/term'], ['POST', '/api/infra/vms/n1/100/qemu/vnc'],
    ['POST', '/api/auth/lock'], ['POST', '/api/auth/sign-out'], ['POST', '/api/auth/reconfirm'],
    // Fastify routes on the decoded path; the gate checks the matched route as well as the raw one.
    ['GET', '/api/%73ecrets'], ['POST', '/api/secrets/%72eveal'],
  ] as const) {
    const res = await app.inject({ method, url, headers: bearer(t), payload: method === 'POST' ? { name: 'x', password: OWNER_PW } : undefined })
    assert.equal(res.statusCode, 403, `${method} ${url}: ${res.body}`)
    assert.equal(res.json().code, 'token_forbidden', url)
  }
  assert.equal(isUnlocked(), true)
  assert.equal(broker.callsTo('createSend').length, 0)
})

test('a token cannot list, create or revoke tokens', async () => {
  const app = await appP
  await unlockAs()
  const t = await token('admin')
  const id = store.rows[0].id
  for (const [method, url] of [['GET', '/api/auth/tokens'], ['POST', '/api/auth/tokens'], ['DELETE', `/api/auth/tokens/${id}`]] as const) {
    const res = await app.inject({ method, url, headers: bearer(t), payload: method === 'POST' ? { name: 'child', role: 'admin' } : undefined })
    assert.equal(res.statusCode, 403, `${method} ${url}`)
    assert.equal(res.json().code, 'token_forbidden')
  }
  assert.equal(store.rows.length, 1)
  assert.equal(store.rows[0].revokedAt, null)
})

test('roles apply unchanged: viewer token reads, but cannot hit admin or operator routes', async () => {
  const app = await appP
  await unlockAs()
  const v = await token('viewer')
  assert.equal((await app.inject({ method: 'GET', url: '/api/proxmox/resources', headers: bearer(v) })).statusCode, 200)
  const dns = await app.inject({ method: 'POST', url: '/api/dns/domains/example.com/records', headers: bearer(v), payload: {} })
  assert.equal(dns.statusCode, 403)
  assert.equal(dns.json().code, 'forbidden')
  assert.equal((await app.inject({ method: 'POST', url: '/api/proxmox/vms/n1/100/lxc/start', headers: bearer(v) })).statusCode, 403)
  const op = await token('operator')
  assert.equal((await app.inject({ method: 'POST', url: '/api/proxmox/vms/n1/100/lxc/start', headers: bearer(op) })).statusCode, 200)
  assert.equal((await app.inject({ method: 'POST', url: '/api/dns/domains/example.com/records', headers: bearer(op), payload: {} })).statusCode, 403)
})

test('a cookie carrying an hpx_ value is not accepted', async () => {
  const app = await appP
  await unlockAs()
  const t = await token('admin')
  const res = await app.inject({ method: 'GET', url: '/api/proxmox/resources', headers: { cookie: `hyperprox_token=${t}` } })
  assert.equal(res.statusCode, 401)
  assert.equal(res.json().code, 'unauthenticated')
  assert.equal(store.lookups, 0)
})

test('vault writes during a token request use the most recent signed-in session', async () => {
  const app = await appP
  await unlockAs(VIEWER, VIEWER_PW)
  await unlockAs(ADMIN, ADMIN_PW)
  const adminSid = allSessions().find(s => s.email === ADMIN)!.sid
  const t = await token('admin')
  const res = await app.inject({ method: 'PUT', url: '/api/test/probe', headers: bearer(t), payload: { value: 'key-from-token' } })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(broker.callsTo('upsertSecret').at(-1)!.args[0], adminSid)
  assert.equal(broker.items.get('hyperprox:dns/godaddy')!.fields.api_key, 'key-from-token')
  // The token's own context sid is never a session.
  requestContext.run({ sid: 'token:x', email: 'token:t', role: 'admin' }, () => assert.equal(actingSid(), adminSid))
})

test('no signed-in session left: a vault write from a token fails as locked (423), nothing written', async () => {
  const app = await appP
  await unlockAs()
  const t = await token('admin')
  for (const s of allSessions()) removeSession(s.sid)
  assert.equal(isUnlocked(), true)
  const before = broker.callsTo('upsertSecret').length
  const res = await app.inject({ method: 'PUT', url: '/api/test/probe', headers: bearer(t), payload: { value: 'nope' } })
  assert.equal(res.statusCode, 423)
  assert.equal(broker.callsTo('upsertSecret').length, before)
})

test('audit: every mutating token request, with the token name; reads are not logged; never the token', async () => {
  const app = await appP
  await unlockAs()
  const t = await token('admin', 'ci-bot')
  store.audits.length = 0
  await app.inject({ method: 'GET', url: '/api/proxmox/resources', headers: bearer(t) })
  await app.inject({ method: 'POST', url: '/api/dns/domains/example.com/records?secret=1', headers: bearer(t), payload: {} })
  await app.inject({ method: 'DELETE', url: '/api/proxmox/nodes/n1/lxc/100', headers: bearer(t) })
  const reqs = store.audits.filter(a => a.action === 'api_token.request')
  assert.equal(reqs.length, 2)
  assert.deepEqual(reqs.map(a => [a.resource, a.details!.method, a.details!.path, a.details!.status]), [
    ['ci-bot', 'POST', '/api/dns/domains/example.com/records', 200],
    ['ci-bot', 'DELETE', '/api/proxmox/nodes/n1/lxc/100', 403],
  ])
  assert.equal(JSON.stringify(store.audits).includes(t), false)
})

test('lastUsedAt written at most once a minute; cache bounded by CACHE_MS; revoke here is immediate', async () => {
  await unlockAs()
  const t = await token('admin', 'cache')
  const row = store.rows[0]
  const t0 = Date.now()
  assert.ok(await verifyApiToken(t, t0))
  const firstUse = row.lastUsedAt
  assert.ok(firstUse)
  await new Promise(r => setImmediate(r))
  assert.ok(await verifyApiToken(t, t0 + 1000))
  assert.equal(store.lookups, 1, 'second check within CACHE_MS comes from memory')
  assert.equal(row.lastUsedAt!.getTime(), firstUse!.getTime())
  assert.ok(await verifyApiToken(t, t0 + TOUCH_MS + 1))
  assert.equal(row.lastUsedAt!.getTime(), t0 + TOUCH_MS + 1)
  assert.ok(store.lookups >= 2)

  // A revoke made elsewhere (host CLI) is seen once the cache entry ages out.
  const base = t0 + 5 * TOUCH_MS
  assert.ok(await verifyApiToken(t, base))
  row.revokedAt = new Date()
  assert.ok(await verifyApiToken(t, base + 1), 'still cached')
  assert.equal(await verifyApiToken(t, base + CACHE_MS + 1), null)

  // A revoke through the API's own path clears the cache at once.
  const t2 = await token('admin', 'cache2')
  assert.ok(await verifyApiToken(t2))
  await revokeApiToken('cache2', 'test', store)
  assert.equal(await verifyApiToken(t2), null)
})

// --- Management routes (browser session) ---------------------------------------------------

test('token routes: admin session + reconfirm creates (token once), lists without hashes, revokes', async () => {
  const app = await appP
  const cookie = await unlockAs(ADMIN, ADMIN_PW)

  const noConfirm = await app.inject({ method: 'POST', url: '/api/auth/tokens', headers: { cookie }, payload: { name: 'ci', role: 'admin' } })
  assert.equal(noConfirm.statusCode, 403)
  assert.equal(noConfirm.json().code, 'reconfirm_required')

  const rc = await app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie }, payload: { password: ADMIN_PW } })
  assert.equal(rc.statusCode, 200)

  const created = await app.inject({ method: 'POST', url: '/api/auth/tokens', headers: { cookie }, payload: { name: 'ci', role: 'operator', expiresDays: 30 } })
  assert.equal(created.statusCode, 200, created.body)
  const plain = created.json().token as string
  assert.match(plain, /^hpx_/)
  assert.equal(created.json().data.role, 'operator')
  assert.equal(created.json().data.createdBy, ADMIN)
  assert.ok(created.json().data.expiresAt)

  const dup = await app.inject({ method: 'POST', url: '/api/auth/tokens', headers: { cookie }, payload: { name: 'ci' } })
  assert.equal(dup.statusCode, 400)
  const bad = await app.inject({ method: 'POST', url: '/api/auth/tokens', headers: { cookie }, payload: { name: 'bad name!' } })
  assert.equal(bad.statusCode, 400)
  const owner = await app.inject({ method: 'POST', url: '/api/auth/tokens', headers: { cookie }, payload: { name: 'o', role: 'owner' } })
  assert.equal(owner.statusCode, 403)

  const list = await app.inject({ method: 'GET', url: '/api/auth/tokens', headers: { cookie } })
  assert.equal(list.statusCode, 200)
  assert.equal(list.json().data.length, 1)
  assert.equal(list.body.includes('tokenHash'), false)
  assert.equal(list.body.includes(plain), false)
  assert.equal(list.body.includes(hashToken(plain)), false)

  const id = list.json().data[0].id
  const del = await app.inject({ method: 'DELETE', url: `/api/auth/tokens/${id}`, headers: { cookie } })
  assert.equal(del.statusCode, 200)
  assert.equal(del.json().data.state, 'revoked')
  assert.equal((await app.inject({ method: 'GET', url: '/api/proxmox/resources', headers: bearer(plain) })).statusCode, 401)
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/auth/tokens/nope', headers: { cookie } })).statusCode, 404)

  assert.deepEqual(store.audits.filter(a => a.action !== 'api_token.request').map(a => [a.action, a.resource, a.details!.by]), [
    ['api_token.create', 'ci', ADMIN],
    ['api_token.revoke', 'ci', ADMIN],
  ])
})

test('token routes: viewer session is refused', async () => {
  const app = await appP
  const cookie = await unlockAs(VIEWER, VIEWER_PW)
  const res = await app.inject({ method: 'GET', url: '/api/auth/tokens', headers: { cookie } })
  assert.equal(res.statusCode, 403)
  assert.equal(res.json().code, 'forbidden')
})

test('lock still voids everything: a token used after a lock gets 423', async () => {
  const app = await appP
  await unlockAs()
  const t = await token('admin')
  assert.equal((await app.inject({ method: 'GET', url: '/api/proxmox/resources', headers: bearer(t) })).statusCode, 200)
  await lock('manual')
  assert.equal((await app.inject({ method: 'GET', url: '/api/proxmox/resources', headers: bearer(t) })).statusCode, 423)
})
