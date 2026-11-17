// In-page confirmation (lib/confirm.ts) through the real gate, auth, secrets and token routes, with the fake broker:
// what needs a confirmation, what still needs the master password, and how a confirmation token behaves.
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { FakeBroker } from './fakes/fake-broker'
import { resetLock, signIn } from './fakes/app'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { secretsRoutes } from '../src/routes/secrets'
import { apiTokenRoutes } from '../src/routes/api-tokens'
import { setBroker } from '../src/lib/vault/broker'
import { setCredentialTable } from '../src/lib/credentials'
import { setAuditSink, auditOrThrow } from '../src/lib/audit'
import { MemoryApiTokenStore, setApiTokenStore, createApiToken } from '../src/lib/api-tokens'
import { needsConfirm, needsPassword, needsReconfirm } from '../src/lib/roles'
import { mintConfirm, takeConfirm, clearConfirms, pendingConfirms, CONFIRM_TTL_MS, canonicalJson } from '../src/lib/confirm'
import { describeAction } from '../src/lib/confirm-text'

const OWNER = 'owner@example.com', OWNER_PW = 'correct horse battery staple'
const ADMIN = 'admin@example.com', ADMIN_PW = 'admin master password'

const broker = new FakeBroker()
broker.addUser(OWNER, OWNER_PW, 'owner')
broker.addUser(ADMIN, ADMIN_PW, 'admin')
broker.items.set('hyperprox:dns/godaddy', { id: 'g1', name: 'hyperprox:dns/godaddy', fields: { api_key: 'key-1' } })

// What the stand-in handlers did, in order, next to the audit rows written.
const events: string[] = []
const audits: Array<{ action: string; resource: string; details?: Record<string, unknown> }> = []
let auditFails = false

async function build(): Promise<FastifyInstance> {
  setBroker(broker)
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  const app = Fastify({ logger: false })
  await registerGate(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(secretsRoutes, { prefix: '/api/secrets' })
  await app.register(apiTokenRoutes, { prefix: '/api/auth/tokens' })
  await app.register(async f => {
    f.delete('/nodes/:node/:type/:vmid', async (req: any) => {
      events.push(`destroy ${req.params.vmid}`)
      await auditOrThrow('guest.destroy', req.params.vmid, { by: 'handler' })
      return { success: true }
    })
  }, { prefix: '/api/proxmox' })
  await app.register(async f => {
    f.post('/guests/repair', async () => { events.push('repair'); return { success: true } })
    f.post('/guests/remove', async () => { events.push('remove'); return { success: true } })
    f.put('/use', async (req: any) => { events.push(`use ${req.body?.mode}`); return { success: true } })
  }, { prefix: '/api/plugins/apt-cacher-ng' })
  await app.register(async f => {
    f.post('/', async () => ({ success: true }))
    f.post('/:id/role', async () => ({ success: true }))
  }, { prefix: '/api/users' })
  await app.ready()
  return app
}
const appP = build()

let tokens: MemoryApiTokenStore
beforeEach(async () => {
  await resetLock()
  clearConfirms()
  events.length = 0
  audits.length = 0
  auditFails = false
  tokens = new MemoryApiTokenStore()
  setApiTokenStore(tokens)
  setAuditSink({ async write(r) { if (auditFails) throw new Error('database down'); audits.push(r); events.push(`audit ${r.action}`) } })
})
after(async () => { await resetLock(); setApiTokenStore(null); setAuditSink(null); await (await appP).close() })

async function cookieFor(email: string, pw: string): Promise<string> {
  const r = await signIn(await appP, email, pw)
  assert.equal(r.res.statusCode, 200, r.res.body)
  return r.cookie
}

const DESTROY = '/api/proxmox/nodes/n1/lxc/101'
const REPAIR = '/api/plugins/apt-cacher-ng/guests/repair'

// ── The rules ───────────────────────────────────────────────────────────────────────────────

test('rules: the master password only to reveal a secret or change who can sign in; the rest is confirmed on the page', () => {
  for (const [m, p] of [
    ['POST', '/api/secrets/reveal'], ['POST', '/api/secrets/send'], ['POST', '/api/secrets/delete'],
    ['POST', '/api/infra/guest-config/guests/n1/lxc/101/reveal'], ['POST', '/api/vpn/wg/peers/p1/reveal'],
    ['POST', '/api/users/invite'], ['PUT', '/api/users/u1/role'], ['DELETE', '/api/users/u1'], ['POST', '/api/users/u1/confirm'],
    ['POST', '/api/auth/tokens'], ['DELETE', '/api/auth/tokens/t1'], ['PUT', '/api/auth/tokens/t1/plugin-settings'],
    ['POST', '/api/roles'],
    ['POST', '/api/remote/machines/m1/tailscale/manual-key'], ['POST', '/api/remote/machines/m1/netbird/login-url'],
    ['POST', '/api/remote/devices/tailscale/d1/approve'], ['POST', '/api/vpn/wg/servers/s1/devices'], ['POST', '/api/vpn/wg/router/devices'],
    ['POST', '/api/sites/s1/admin-login'], ['POST', '/api/setup-checklist/host-keys/anchor'], ['POST', '/api/setup-checklist/host-keys/confirm'],
    ['POST', '/api/ha/nodes/n1/hostkey/pin'], ['POST', '/api/clusters/c0123456789/verify-keys'],
  ] as const) {
    assert.equal(needsPassword(m, p), true, `${m} ${p} keeps the master password`)
    assert.equal(needsConfirm(m, p), false, `${m} ${p} is not also a confirmation`)
  }
  for (const [m, p] of [
    ['DELETE', DESTROY],
    ['POST', '/api/plugins/home-assistant/instances/h1/secure-actions'], ['POST', '/api/plugins/qnap/instances/q1/secure-actions'],
    ['POST', '/api/plugins/asus/instances/a1/actions'], ['POST', '/api/plugins/pbs/instances/p1/actions/verify'],
    ['POST', '/api/plugins/pbs/instances/p1/manage/apply'], ['POST', '/api/plugins/nextcloud/instances/n1/secure-actions/update'],
    ['POST', '/api/plugins/k3s/clusters/k1/actions/drain'], ['POST', '/api/plugins/plex/clearout/remove'],
    ['POST', '/api/infra/guest-config/apply'], ['POST', '/api/ha/plans/x/apply'], ['POST', '/api/placement/guests/lxc/101/move'],
    ['POST', '/api/catalogue/wizard/apply'], ['PUT', '/api/settings/dns/godaddy'], ['PUT', '/api/plugins/plex/settings'],
    ['POST', '/api/self-update/install'], ['POST', '/api/clusters/c0123456789/guests/n1/lxc/101/delete'],
    ['POST', REPAIR], ['POST', '/api/plugins/apt-cacher-ng/guests/remove'], ['PUT', '/api/plugins/apt-cacher-ng/use'],
    ['POST', '/api/vpn/wg/peers/p1/rotate'], ['POST', '/api/remote/jobs'], ['POST', '/api/setup-checklist/node-login/run'],
  ] as const) {
    assert.equal(needsConfirm(m, p), true, `${m} ${p} is confirmed on the page`)
    assert.equal(needsPassword(m, p), false, `${m} ${p} no longer asks for the master password`)
    assert.equal(needsReconfirm(m, p), true, 'the old question still says "a deliberate step"')
  }
  assert.equal(needsConfirm('GET', REPAIR), false, 'reads never')
  assert.equal(needsConfirm('POST', '/api/plugins/qnap/instances/probe-certificate'), false, 'reading a certificate is not an action')
})

test('wording: plain sentences from the request itself', () => {
  assert.equal(describeAction('POST', '/api/updates/nodes/:node/reboot', '/api/updates/nodes/n2/reboot', {}, {}),
    'Reboot n2? Its HA guests move to other nodes first, then it restarts. This usually takes about 5 minutes.')
  assert.equal(describeAction('POST', REPAIR, REPAIR, {}, {}),
    'Write the package cache setting on every guest Updates looks after, and check each can reach it?')
  assert.match(describeAction('DELETE', DESTROY, DESTROY, {}, undefined), /^Delete container 101 on n1\? .*cannot be undone/)
  assert.match(describeAction('POST', '/api/plugins/qnap/instances/:iid/secure-actions', '/api/plugins/qnap/instances/q1/secure-actions', {}, { action: 'shutdown' }), /^Shut down this NAS\?/)
  assert.match(describeAction('POST', '/api/something/new', '/api/something/new', {}, {}), /^Run this change to something new\?$/)
})

// ── The token itself ────────────────────────────────────────────────────────────────────────

test('a confirmation is single use, expires, and is bound to its session and request', () => {
  const now = Date.now()
  const a = mintConfirm('sid-a', 'binding-1', now)
  assert.equal(takeConfirm('sid-b', 'binding-1', a.token, now), false, 'another session cannot use it')
  assert.equal(takeConfirm('sid-a', 'binding-1', a.token, now), false, 'and that attempt used it up')
  const b = mintConfirm('sid-a', 'binding-1', now)
  assert.equal(takeConfirm('sid-a', 'binding-2', b.token, now), false, 'another request cannot use it')
  const c = mintConfirm('sid-a', 'binding-1', now)
  assert.equal(takeConfirm('sid-a', 'binding-1', c.token, now + CONFIRM_TTL_MS + 1), false, 'expired')
  const d = mintConfirm('sid-a', 'binding-1', now)
  assert.equal(takeConfirm('sid-a', 'binding-1', d.token, now + 1000), true)
  assert.equal(takeConfirm('sid-a', 'binding-1', d.token, now + 1000), false, 'single use')
  for (let i = 0; i < 50; i++) mintConfirm('sid-flood', 'b', now)
  assert.ok(pendingConfirms() <= 20 + 1, 'a session cannot pile them up')
  assert.equal(canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }] }), canonicalJson({ a: [1, { c: 3, d: 2 }], b: 1 }))
})

// ── Through the gate ────────────────────────────────────────────────────────────────────────

test('an action without a confirmation is refused with one, and nothing runs; with it, it runs once', async () => {
  const app = await appP
  const cookie = await cookieFor(ADMIN, ADMIN_PW)
  const first = await app.inject({ method: 'DELETE', url: DESTROY, headers: { cookie } })
  assert.equal(first.statusCode, 403)
  const j = first.json()
  assert.equal(j.code, 'confirm_required')
  assert.match(j.confirm.summary, /Delete container 101 on n1\?/)
  assert.equal(j.error, j.confirm.summary)
  assert.match(j.confirm.token, /^[A-Za-z0-9_-]{43}$/)
  assert.deepEqual(events, [], 'nothing ran')

  const bad = await app.inject({ method: 'DELETE', url: DESTROY, headers: { cookie, 'x-hyperprox-confirm': 'made-up' } })
  assert.equal(bad.statusCode, 403)
  assert.equal(bad.json().code, 'confirm_required')
  assert.deepEqual(events, [])

  const ok = await app.inject({ method: 'DELETE', url: DESTROY, headers: { cookie, 'x-hyperprox-confirm': j.confirm.token } })
  assert.equal(ok.statusCode, 200, ok.body)
  assert.deepEqual(events, ['audit action.confirmed', 'destroy 101', 'audit guest.destroy'], 'the confirmation is audited before the action runs')
  assert.equal(audits[0].details?.confirmed, 'in page')
  assert.equal(audits[0].details?.by, ADMIN)
  assert.equal(audits[0].resource, 'DELETE /api/proxmox/nodes/:node/:type/:vmid')
  assert.equal(audits[1].details?.confirmed, 'in page', 'rows the action writes say so too')

  const again = await app.inject({ method: 'DELETE', url: DESTROY, headers: { cookie, 'x-hyperprox-confirm': j.confirm.token } })
  assert.equal(again.statusCode, 403, 'a confirmation cannot be replayed')
  assert.equal(again.json().code, 'confirm_required')
  assert.equal(events.filter(e => e.startsWith('destroy')).length, 1)
})

test('a confirmation is bound to the user, the action and its parameters', async () => {
  const app = await appP
  const admin = await cookieFor(ADMIN, ADMIN_PW)
  const owner = await cookieFor(OWNER, OWNER_PW)
  const ask = async (cookie: string, url = REPAIR, payload: unknown = { only: ['a'] }, extra: Record<string, string> = {}) =>
    (await app.inject({ method: 'POST', url, headers: { cookie, ...extra }, payload: payload as any })).json().confirm.token as string
  const send = (cookie: string, token: string, url = REPAIR, payload: unknown = { only: ['a'] }, extra: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, headers: { cookie, 'x-hyperprox-confirm': token, ...extra }, payload: payload as any })

  assert.equal((await send(owner, await ask(admin))).statusCode, 403, 'another person')
  assert.equal((await send(admin, await ask(admin), '/api/plugins/apt-cacher-ng/guests/remove')).statusCode, 403, 'another action')
  assert.equal((await send(admin, await ask(admin), REPAIR, { only: ['b'] })).statusCode, 403, 'another body')
  assert.equal((await send(admin, await ask(admin), `${REPAIR}?cluster=x`)).statusCode, 403, 'another query')
  assert.equal((await send(admin, await ask(admin), REPAIR, { only: ['a'] }, { 'x-hyperprox-cluster': 'c0123456789' })).statusCode, 403, 'another cluster')
  assert.deepEqual(events.filter(e => e === 'repair'), [], 'none of those ran')
  // Key order in the body does not matter: the same request, confirmed.
  const t = await ask(admin, REPAIR, { b: 1, a: 2 })
  assert.equal((await send(admin, t, REPAIR, { a: 2, b: 1 })).statusCode, 200)
  assert.deepEqual(events.filter(e => e === 'repair'), ['repair'])
})

test('package cache fleet actions: repair is confirmed on the page with its own sentence, never with the master password', async () => {
  const app = await appP
  const cookie = await cookieFor(ADMIN, ADMIN_PW)
  const r = await app.inject({ method: 'POST', url: REPAIR, headers: { cookie }, payload: {} })
  assert.equal(r.statusCode, 403)
  assert.equal(r.json().code, 'confirm_required', 'a confirmation, not reconfirm_required')
  assert.equal(r.json().confirm.summary, 'Write the package cache setting on every guest Updates looks after, and check each can reach it?')
  assert.deepEqual(events, [])
  const ok = await app.inject({ method: 'POST', url: REPAIR, headers: { cookie, 'x-hyperprox-confirm': r.json().confirm.token }, payload: {} })
  assert.equal(ok.statusCode, 200, ok.body)
  assert.deepEqual(events, ['audit action.confirmed', 'repair'])
  for (const [method, url, payload] of [['POST', '/api/plugins/apt-cacher-ng/guests/remove', {}], ['PUT', '/api/plugins/apt-cacher-ng/use', { mode: 'on' }]] as const) {
    const a = await app.inject({ method, url, headers: { cookie }, payload })
    assert.equal(a.json().code, 'confirm_required', url)
    const b = await app.inject({ method, url, headers: { cookie, 'x-hyperprox-confirm': a.json().confirm.token }, payload })
    assert.equal(b.statusCode, 200, `${url} ${b.body}`)
  }
})

test('when the audit row cannot be written, the confirmed action does not run', async () => {
  const app = await appP
  const cookie = await cookieFor(ADMIN, ADMIN_PW)
  const t = (await app.inject({ method: 'DELETE', url: DESTROY, headers: { cookie } })).json().confirm.token
  auditFails = true
  const r = await app.inject({ method: 'DELETE', url: DESTROY, headers: { cookie, 'x-hyperprox-confirm': t } })
  assert.equal(r.statusCode, 503)
  assert.equal(r.json().code, 'audit_unavailable')
  assert.deepEqual(events, [], 'nothing ran')
})

test('API tokens can never confirm: refused on every confirmed action, and given no confirmation', async () => {
  const app = await appP
  await cookieFor(ADMIN, ADMIN_PW)   // unlocked
  const { token } = await createApiToken({ name: 'auto', role: 'admin' }, 'test', tokens)
  for (const [method, url] of [['DELETE', DESTROY], ['POST', REPAIR]] as const) {
    const r = await app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload: method === 'POST' ? {} : undefined })
    assert.equal(r.statusCode, 403, url)
    assert.equal(r.json().code, 'token_forbidden', url)
    assert.equal(r.json().confirm, undefined, 'no confirmation handed to a token')
  }
  // A confirmation a person was given does not help a token either.
  const cookie = await cookieFor(ADMIN, ADMIN_PW)
  const t = (await app.inject({ method: 'DELETE', url: DESTROY, headers: { cookie } })).json().confirm.token
  const r = await app.inject({ method: 'DELETE', url: DESTROY, headers: { authorization: `Bearer ${token}`, 'x-hyperprox-confirm': t } })
  assert.equal(r.json().code, 'token_forbidden')
  assert.deepEqual(events.filter(e => !e.startsWith('audit security.')), [], 'nothing ran (the refusals are logged as security events)')
})

test('another site cannot use a confirmation', async () => {
  const app = await appP
  const cookie = await cookieFor(ADMIN, ADMIN_PW)
  const t = (await app.inject({ method: 'DELETE', url: DESTROY, headers: { cookie, host: 'hpx.example' } })).json().confirm.token
  const r = await app.inject({ method: 'DELETE', url: DESTROY, headers: { cookie, host: 'hpx.example', origin: 'https://evil.example', 'x-hyperprox-confirm': t } })
  assert.equal(r.statusCode, 403)
  assert.equal(r.json().code, 'cross_origin')
  const asked = await app.inject({ method: 'DELETE', url: DESTROY, headers: { cookie, host: 'hpx.example', 'sec-fetch-site': 'cross-site' } })
  assert.equal(asked.json().code, 'cross_origin', 'nor be handed one')
  assert.deepEqual(events, [])
})

test('revealing a secret and changing who can sign in still need the master password; a confirmation is no substitute', async () => {
  const app = await appP
  const cookie = await cookieFor(OWNER, OWNER_PW)
  for (const [method, url, payload] of [
    ['POST', '/api/secrets/reveal', { name: 'hyperprox:dns/godaddy' }],
    ['POST', '/api/auth/tokens', { name: 'ci', role: 'admin' }],
    ['POST', '/api/users', { email: 'x@example.com' }],
    ['PUT', '/api/auth/tokens/t1/plugin-settings', { enabled: true }],
  ] as const) {
    const r = await app.inject({ method, url, headers: { cookie }, payload })
    assert.equal(r.statusCode, 403, url)
    assert.equal(r.json().code, 'reconfirm_required', url)
    assert.equal(r.json().confirm, undefined, `${url}: no confirmation offered instead`)
    const forged = await app.inject({ method, url, headers: { cookie, 'x-hyperprox-confirm': 'anything' }, payload })
    assert.equal(forged.json().code, 'reconfirm_required', url)
  }
  const rc = await app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie }, payload: { password: OWNER_PW } })
  assert.equal(rc.statusCode, 200, rc.body)
  const reveal = await app.inject({ method: 'POST', url: '/api/secrets/reveal', headers: { cookie }, payload: { name: 'hyperprox:dns/godaddy' } })
  assert.equal(reveal.statusCode, 200, reveal.body)
  // And the master password does not stand in for a confirmation either.
  const d = await app.inject({ method: 'DELETE', url: DESTROY, headers: { cookie } })
  assert.equal(d.json().code, 'confirm_required')
})

test('a lock forgets every waiting confirmation', async () => {
  const app = await appP
  const cookie = await cookieFor(ADMIN, ADMIN_PW)
  await app.inject({ method: 'DELETE', url: DESTROY, headers: { cookie } })
  assert.ok(pendingConfirms() > 0)
  await resetLock()
  assert.equal(pendingConfirms(), 0)
})
