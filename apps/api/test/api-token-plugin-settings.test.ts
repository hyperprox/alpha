// The opt-in API token permission "can save plug-in settings without the master password": off by default, owner
// granted (re-confirmed) or root on the host, covering PUT /api/plugins/:id/settings and nothing else.
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { FakeBroker } from './fakes/fake-broker'
import { signIn } from './fakes/app'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { secretsRoutes } from '../src/routes/secrets'
import { apiTokenRoutes } from '../src/routes/api-tokens'
import { pluginRoutes } from '../src/routes/plugins'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable, setCredential } from '../src/lib/credentials'
import { allSessions, removeSession, requestContext } from '../src/lib/auth'
import { needsReconfirm, pluginSettingsSave, requiredRole } from '../src/lib/roles'
import {
  MemoryApiTokenStore, setApiTokenStore, createApiToken, revokeApiToken, setTokenPluginSettings, verifyApiToken,
} from '../src/lib/api-tokens'
import { runTokenCli, CLI_ACTOR, CLI_PLUGIN_SETTINGS_AUDIT } from '../src/cli/api-token'

const OWNER = 'owner@example.com', OWNER_PW = 'owner master password'
const ADMIN = 'admin@example.com', ADMIN_PW = 'admin master password'

const broker = new FakeBroker()
broker.addUser(OWNER, OWNER_PW, 'owner')
broker.addUser(ADMIN, ADMIN_PW, 'admin')

async function build(): Promise<FastifyInstance> {
  setBroker(broker)
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  const app = Fastify({ logger: false })
  await registerGate(app)
  await app.register(authRoutes,     { prefix: '/api/auth' })
  await app.register(secretsRoutes,  { prefix: '/api/secrets' })
  await app.register(apiTokenRoutes, { prefix: '/api/auth/tokens' })
  await app.register(pluginRoutes,   { prefix: '/api/plugins' })
  // Stand-ins at the real paths of the excluded categories (the gate keys on paths).
  const ok = async () => ({ ok: true })
  await app.register(async f => {
    f.delete('/nodes/:node/:type/:vmid', ok)
  }, { prefix: '/api/proxmox' })
  await app.register(async f => {
    f.post('/clearout/remove', ok)
    f.post('/library/remove', ok)
  }, { prefix: '/api/plugins/plex' })
  await app.register(async f => { f.put('/instances/:id', ok) }, { prefix: '/api/plugins/home-assistant' })
  await app.register(async f => { f.put('/instances/:id', ok) }, { prefix: '/api/plugins/qnap' })
  await app.register(async f => {
    f.post('/:id/token', ok)
    f.post('/:id/plex', ok)
    f.post('/:id/guests/:node/:type/:vmid/delete', ok)
  }, { prefix: '/api/clusters' })
  await app.register(async f => {
    f.put('/:category/:provider', ok)
    f.post('/test/:category/:provider', ok)
  }, { prefix: '/api/settings' })
  await app.register(async f => { f.post('/', ok); f.put('/:id', ok) }, { prefix: '/api/roles' })
  await app.register(async f => { f.post('/:step', ok) }, { prefix: '/api/setup-checklist' })
  await app.register(async f => {
    // A vault write outside plug-in settings, as the real settings routes make one.
    f.put('/probe', async (req: any) => { await setCredential('dns', 'godaddy', 'api_key', req.body.value, false); return { ok: true } })
  }, { prefix: '/api/test' })
  await app.ready()
  return app
}
const appP = build()

let store: MemoryApiTokenStore
beforeEach(async () => {
  if (isUnlocked()) await lock('manual')
  store = new MemoryApiTokenStore()
  setApiTokenStore(store)
  broker.items.set('hyperprox:plugin/plex', { id: 'p1', name: 'hyperprox:plugin/plex', fields: { plex_url: 'http://plex.lan:32400', plex_token: 'old-plex-token' } } as any)
  broker.items.delete('hyperprox:plugin/mikrotik')
  broker.items.set('hyperprox:dns/godaddy', { id: 'g1', name: 'hyperprox:dns/godaddy', fields: { api_key: 'key-1' } } as any)
})
after(async () => { if (isUnlocked()) await lock('manual'); setApiTokenStore(null); await (await appP).close() })

const bearer = (t: string) => ({ authorization: `Bearer ${t}` })
async function signedIn(email = OWNER, pw = OWNER_PW) {
  const app = await appP
  const r = await signIn(app, email, pw)
  assert.equal(r.res.statusCode, 200, r.res.body)
  return r.cookie
}
async function reconfirm(cookie: string, pw = OWNER_PW) {
  const app = await appP
  const r = await app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie }, payload: { password: pw } })
  assert.equal(r.statusCode, 200, r.body)
}
async function adminToken(name = 'automation', role: 'viewer' | 'operator' | 'admin' = 'admin') {
  return (await createApiToken({ name, role }, OWNER, store)).token
}
const row = (name: string) => store.rows.find(r => r.name === name)!
const plexItem = () => (broker.items.get('hyperprox:plugin/plex') as any).fields as Record<string, string>
const NEW_PLEX = { plex_url: 'http://plex.lan:32400', plex_token: 'new-plex-token-from-token' }

async function savePlex(t: string, payload: Record<string, string> = NEW_PLEX) {
  return (await appP).inject({ method: 'PUT', url: '/api/plugins/plex/settings', headers: bearer(t), payload })
}

// --- Pure rules ------------------------------------------------------------------------------

test('roles: only PUT /api/plugins/:id/settings is the plug-in settings save, and only its rule can be skipped', () => {
  assert.equal(pluginSettingsSave('PUT', '/api/plugins/plex/settings'), 'plex')
  assert.equal(pluginSettingsSave('PUT', '/api/plugins/plex/settings/'), 'plex')
  for (const [m, p] of [['POST', '/api/plugins/plex/settings'], ['PUT', '/api/plugins/plex/settings/x'], ['PUT', '/api/plugins/home-assistant/instances/1'],
    ['PUT', '/api/settings/dns/godaddy'], ['PUT', '/api/plugins/a/b/settings']]) assert.equal(pluginSettingsSave(m, p), null, `${m} ${p}`)
  assert.equal(needsReconfirm('PUT', '/api/plugins/plex/settings'), true, 'still re-confirmed for everyone by default')
  assert.equal(needsReconfirm('PUT', '/api/plugins/plex/settings', { exceptPluginSettings: true }), false)
  for (const [m, p] of [
    ['DELETE', '/api/proxmox/nodes/n1/lxc/100'], ['POST', '/api/secrets/reveal'], ['POST', '/api/secrets/send'],
    ['POST', '/api/plugins/plex/clearout/remove'], ['POST', '/api/plugins/plex/library/remove'], ['PUT', '/api/plugins/home-assistant/instances/1'],
    ['PUT', '/api/plugins/qnap/instances/1'], ['PUT', '/api/settings/dns/godaddy'], ['POST', '/api/settings/test/dns/godaddy'],
    ['POST', '/api/clusters/c1/token'], ['POST', '/api/clusters/c1/plex'], ['POST', '/api/clusters/c1/guests/n1/lxc/100/delete'],
    ['POST', '/api/auth/tokens'], ['DELETE', '/api/auth/tokens/x'], ['PUT', '/api/auth/tokens/x/plugin-settings'],
    ['POST', '/api/roles'], ['POST', '/api/setup-checklist/x'],
  ]) assert.equal(needsReconfirm(m, p, { exceptPluginSettings: true }), true, `${m} ${p}`)
  assert.equal(requiredRole('PUT', '/api/auth/tokens/x/plugin-settings'), 'owner')
  assert.equal(requiredRole('PUT', '/api/plugins/plex/settings'), 'admin')
})

// --- Default off -------------------------------------------------------------------------------

test('default off: a new token does not have it, and its plug-in settings save is refused (reconfirm_required)', async () => {
  await signedIn()
  const t = await adminToken()
  assert.equal(row('automation').pluginSettingsWithoutReconfirm, false)
  const before = broker.callsTo('upsertSecret').length
  const res = await savePlex(t)
  assert.equal(res.statusCode, 403, res.body)
  assert.equal(res.json().code, 'reconfirm_required')
  assert.equal(broker.callsTo('upsertSecret').length, before)
  assert.equal(plexItem().plex_token, 'old-plex-token')
})

// --- Granting -------------------------------------------------------------------------------------

test('only an owner, re-confirmed, can grant it; an admin cannot; a token cannot (its own or another)', async () => {
  const app = await appP
  const t = await adminToken('automation')
  const other = await adminToken('other')
  const id = row('automation').id
  const put = (headers: Record<string, string>, enabled = true, tid = id) =>
    app.inject({ method: 'PUT', url: `/api/auth/tokens/${tid}/plugin-settings`, headers, payload: { enabled } })

  const adminCookie = await signedIn(ADMIN, ADMIN_PW)
  await reconfirm(adminCookie, ADMIN_PW)
  const byAdmin = await put({ cookie: adminCookie })
  assert.equal(byAdmin.statusCode, 403)
  assert.equal(byAdmin.json().code, 'forbidden')

  const ownerCookie = await signedIn()
  const noConfirm = await put({ cookie: ownerCookie })
  assert.equal(noConfirm.statusCode, 403)
  assert.equal(noConfirm.json().code, 'reconfirm_required')

  for (const [tok, tid] of [[t, id], [t, row('other').id], [other, id]] as const) {
    const res = await put(bearer(tok), true, tid)
    assert.equal(res.statusCode, 403, res.body)
    assert.equal(res.json().code, 'token_forbidden')
  }
  assert.equal(store.rows.some(r => r.pluginSettingsWithoutReconfirm), false, 'nothing was granted so far')

  await reconfirm(ownerCookie)
  const bad = await app.inject({ method: 'PUT', url: `/api/auth/tokens/${id}/plugin-settings`, headers: { cookie: ownerCookie }, payload: { enabled: 'yes' } })
  assert.equal(bad.statusCode, 400)
  const ok = await put({ cookie: ownerCookie })
  assert.equal(ok.statusCode, 200, ok.body)
  assert.equal(ok.json().data.pluginSettingsWithoutReconfirm, true)
  assert.equal(ok.json().data.pluginSettingsGrantedBy, OWNER)
  assert.equal(row('automation').pluginSettingsWithoutReconfirm, true)
  assert.equal(row('other').pluginSettingsWithoutReconfirm, false)

  // The list shows it; never a hash.
  const list = await app.inject({ method: 'GET', url: '/api/auth/tokens', headers: { cookie: ownerCookie } })
  assert.equal(list.json().data.find((r: any) => r.name === 'automation').pluginSettingsWithoutReconfirm, true)
  assert.equal(list.body.includes('tokenHash'), false)

  // Not for a token below admin, nor a revoked one.
  await adminToken('reader', 'viewer')
  const v = await put({ cookie: ownerCookie }, true, row('reader').id)
  assert.equal(v.statusCode, 400)
  await revokeApiToken('other', 'test', store)
  assert.equal((await put({ cookie: ownerCookie }, true, row('other').id)).statusCode, 400)
  assert.equal((await put({ cookie: ownerCookie }, true, 'nope')).statusCode, 404)

  assert.deepEqual(store.audits.filter(a => a.action.startsWith('api_token.plugin_settings')).map(a => [a.action, a.resource, a.details!.by]),
    [['api_token.plugin_settings.grant', 'automation', OWNER]])
})

// --- With it on ---------------------------------------------------------------------------------

async function grantedToken(name = 'automation') {
  const t = await adminToken(name)
  await setTokenPluginSettings(row(name).id, true, OWNER, store)
  return t
}

test('on: the plug-in settings save works, written with the granting owner\'s session; audited; secrets never logged', async () => {
  await signedIn(ADMIN, ADMIN_PW)   // a more recent admin session must not be the one borrowed
  await signedIn()
  await signedIn(ADMIN, ADMIN_PW)
  const ownerSids = allSessions().filter(s => s.email === OWNER).map(s => s.sid)
  const t = await grantedToken()
  store.audits.length = 0
  const before = broker.callsTo('upsertSecret').length
  const res = await savePlex(t, { ...NEW_PLEX, notify_new: 'true', bogus_key: 'x' })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(plexItem().plex_token, 'new-plex-token-from-token')
  const writes = broker.callsTo('upsertSecret').slice(before)
  assert.ok(writes.length >= 1)
  for (const w of writes) {
    assert.ok(ownerSids.includes(w.args[0] as string), 'written with the owner\'s session')
    assert.equal(w.args[1], 'hyperprox:plugin/plex', 'only the plug-in\'s own item')
  }

  const save = store.audits.filter(a => a.action === 'plugin.settings.save')
  assert.equal(save.length, 1)
  assert.equal(save[0].resource, 'plex')
  assert.equal(save[0].details!.via, 'token automation, without reconfirm')
  assert.deepEqual(save[0].details!.keys, ['plex_url', 'plex_token', 'notify_new'])
  assert.equal(save[0].details!.grantedBy, OWNER)
  // The gate's per-request audit line is there too.
  assert.ok(store.audits.some(a => a.action === 'api_token.request' && a.details!.status === 200))
  assert.equal(JSON.stringify(store.audits).includes('new-plex-token-from-token'), false, 'never a value in the audit log')
  assert.equal(res.body.includes('new-plex-token-from-token'), false)
})

test('on: secrets stay write-only; GET /api/plugins returns "" plus isSet for the token', async () => {
  await signedIn()
  const t = await grantedToken()
  assert.equal((await savePlex(t)).statusCode, 200)
  const res = await (await appP).inject({ method: 'GET', url: '/api/plugins', headers: bearer(t) })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.body.includes('new-plex-token-from-token'), false)
  const plex = res.json().data.find((p: any) => p.id === 'plex')
  const tok = plex.settings.find((s: any) => s.key === 'plex_token')
  assert.equal(tok.value, '')
  assert.equal(tok.isSet, true)
  // Secrets themselves stay closed.
  for (const [method, url] of [['GET', '/api/secrets'], ['POST', '/api/secrets/reveal']] as const) {
    const r = await (await appP).inject({ method, url, headers: bearer(t), payload: method === 'POST' ? { name: 'hyperprox:plugin/plex' } : undefined })
    assert.equal(r.statusCode, 403)
    assert.equal(r.json().code, 'token_forbidden')
  }
})

test('on: every excluded category is still refused for that token', async () => {
  const app = await appP
  await signedIn()
  const t = await grantedToken()
  const tid = row('automation').id
  const cases: Array<[string, string, string]> = [
    // Vault items outside plug-in settings, Secrets and Send.
    ['GET', '/api/secrets', 'token_forbidden'], ['POST', '/api/secrets/reveal', 'token_forbidden'],
    ['POST', '/api/secrets/send', 'token_forbidden'], ['POST', '/api/secrets/generate', 'token_forbidden'],
    ['PUT', '/api/test/probe', 'token_forbidden'],
    // Users and roles.
    ['POST', '/api/roles', 'forbidden'], ['PUT', '/api/roles/x', 'forbidden'],
    // API tokens themselves, its own permission included.
    ['GET', '/api/auth/tokens', 'token_forbidden'], ['POST', '/api/auth/tokens', 'token_forbidden'],
    ['DELETE', `/api/auth/tokens/${tid}`, 'token_forbidden'], ['PUT', `/api/auth/tokens/${tid}/plugin-settings`, 'token_forbidden'],
    // Owner and setup actions.
    ['POST', '/api/auth/bootstrap', 'token_forbidden'], ['POST', '/api/auth/reconfirm', 'token_forbidden'],
    ['POST', '/api/setup-checklist/node-login', 'reconfirm_required'],
    // Cluster credentials.
    ['POST', '/api/clusters/c1/token', 'reconfirm_required'], ['POST', '/api/clusters/c1/plex', 'reconfirm_required'],
    ['PUT', '/api/settings/proxmox/proxmox', 'reconfirm_required'], ['POST', '/api/settings/test/dns/godaddy', 'reconfirm_required'],
    // Destroy and delete, Plex and the plug-in instances that keep their own rules.
    ['DELETE', '/api/proxmox/nodes/n1/lxc/100', 'reconfirm_required'],
    ['POST', '/api/clusters/c1/guests/n1/lxc/100/delete', 'reconfirm_required'],
    ['POST', '/api/plugins/plex/clearout/remove', 'reconfirm_required'], ['POST', '/api/plugins/plex/library/remove', 'reconfirm_required'],
    ['PUT', '/api/plugins/home-assistant/instances/1', 'reconfirm_required'], ['PUT', '/api/plugins/qnap/instances/1', 'reconfirm_required'],
  ]
  for (const [method, url, code] of cases) {
    const res = await app.inject({ method: method as any, url, headers: bearer(t), payload: method === 'GET' ? undefined : { value: 'from-token', name: 'x', enabled: true } })
    assert.equal(res.statusCode, 403, `${method} ${url}: ${res.body}`)
    assert.equal(res.json().code, code, `${method} ${url}`)
  }
  assert.equal((broker.items.get('hyperprox:dns/godaddy') as any).fields.api_key, 'key-1')
  assert.equal(row('automation').revokedAt, null)
})

test('on: a vault write to another plug-in\'s item, or any other item, from the granted request is refused', async () => {
  await signedIn()
  const ctx = { sid: 'token:tok1', email: 'token:automation', role: 'admin' as const, pluginSettings: { pluginId: 'plex', grantedBy: OWNER } }
  await requestContext.run(ctx, async () => {
    await assert.rejects(setCredential('plugin', 'mikrotik', 'password', 'x'), { name: 'TokenVaultWriteError' })
    await assert.rejects(setCredential('dns', 'godaddy', 'api_key', 'x'), { name: 'TokenVaultWriteError' })
    await assert.rejects(setCredential('proxmox', 'plex', 'token', 'x'), { name: 'TokenVaultWriteError' })
  })
  assert.equal(broker.items.has('hyperprox:plugin/mikrotik'), false)
  // A token below admin is still stopped by its role, permission or not.
  const t = await adminToken('reader', 'viewer')
  row('reader').pluginSettingsWithoutReconfirm = true
  row('reader').pluginSettingsGrantedBy = OWNER
  const res = await savePlex(t)
  assert.equal(res.statusCode, 403)
  assert.equal(res.json().code, 'forbidden')
})

test('on, but the granting owner is not signed in: refused, nothing written', async () => {
  await signedIn()
  const t = await grantedToken()
  await signedIn(ADMIN, ADMIN_PW)
  for (const s of allSessions()) if (s.email === OWNER) removeSession(s.sid)
  const before = broker.callsTo('upsertSecret').length
  const res = await savePlex(t)
  assert.equal(res.statusCode, 403, res.body)
  assert.equal(res.json().code, 'token_forbidden')
  assert.match(res.json().error, /owner who allowed it is not signed in/)
  assert.equal(broker.callsTo('upsertSecret').length, before)
  assert.equal(plexItem().plex_token, 'old-plex-token')
})

test('on, but the audit log cannot be written: the save is refused', async () => {
  await signedIn()
  const t = await grantedToken()
  const real = store.audit.bind(store)
  store.audit = async (action, resource, details) => { if (action === 'plugin.settings.save') throw new Error('db down'); return real(action, resource, details) }
  const res = await savePlex(t)
  assert.equal(res.statusCode, 503, res.body)
  assert.equal(plexItem().plex_token, 'old-plex-token')
})

test('turning it off (or revoking) is seen on the very next request', async () => {
  const app = await appP
  const cookie = await signedIn()
  const t = await grantedToken()
  assert.ok(await verifyApiToken(t), 'cached as granted')
  assert.equal((await savePlex(t)).statusCode, 200)
  await reconfirm(cookie)
  const off = await app.inject({ method: 'PUT', url: `/api/auth/tokens/${row('automation').id}/plugin-settings`, headers: { cookie }, payload: { enabled: false } })
  assert.equal(off.statusCode, 200, off.body)
  assert.equal(off.json().data.pluginSettingsWithoutReconfirm, false)
  const res = await savePlex(t, { plex_url: 'http://plex.lan:32400', plex_token: 'after-off' })
  assert.equal(res.statusCode, 403)
  assert.equal(res.json().code, 'reconfirm_required')
  assert.notEqual(plexItem().plex_token, 'after-off')

  const t2 = await grantedToken('second')
  assert.equal((await savePlex(t2)).statusCode, 200)
  await revokeApiToken('second', 'test', store)
  assert.equal((await savePlex(t2)).statusCode, 401)
})

// --- Host CLI (root) ----------------------------------------------------------------------------

function io() {
  const out: string[] = [], err: string[] = []
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } }
}

test('cli: plugin-settings on|off as root; refused for anyone else; audited; prints the state', async () => {
  await createApiToken({ name: 'ci', role: 'admin' }, CLI_ACTOR, store)
  await createApiToken({ name: 'reader', role: 'viewer' }, CLI_ACTOR, store)

  const notRoot = io()
  assert.equal(await runTokenCli(['plugin-settings', 'ci', 'on'], store, notRoot.io, { uid: 1000 }), 1)
  assert.match(notRoot.err.join('\n'), /as root/)
  assert.equal(row('ci').pluginSettingsWithoutReconfirm, false)

  for (const args of [['plugin-settings', 'ci'], ['plugin-settings', 'ci', 'yes'], ['plugin-settings']]) {
    assert.equal(await runTokenCli(args, store, io().io, { uid: 0 }), 2, args.join(' '))
  }
  assert.equal(await runTokenCli(['plugin-settings', 'nobody', 'on'], store, io().io, { uid: 0 }), 1)
  assert.equal(await runTokenCli(['plugin-settings', 'reader', 'on'], store, io().io, { uid: 0 }), 1, 'needs an admin token')

  const on = io()
  assert.equal(await runTokenCli(['plugin-settings', 'ci', 'on'], store, on.io, { uid: 0 }), 0)
  assert.match(on.out[0], /"ci".*ON/)
  assert.equal(row('ci').pluginSettingsWithoutReconfirm, true)
  assert.equal(row('ci').pluginSettingsGrantedBy, CLI_ACTOR)
  const off = io()
  assert.equal(await runTokenCli(['plugin-settings', row('ci').id, 'off'], store, off.io, { uid: 0 }), 0)
  assert.match(off.out[0], /"ci".*OFF/)
  assert.equal(row('ci').pluginSettingsWithoutReconfirm, false)

  assert.deepEqual(store.audits.filter(a => a.action === CLI_PLUGIN_SETTINGS_AUDIT).map(a => [a.resource, a.details!.state, a.details!.via]), [
    ['ci', 'on', 'server shell (root)'],
    ['ci', 'off', 'server shell (root)'],
  ])
})

test('cli grant: the save is written with a signed-in owner\'s session', async () => {
  await signedIn()
  const { token: t } = await createApiToken({ name: 'ci', role: 'admin' }, CLI_ACTOR, store)
  assert.equal(await runTokenCli(['plugin-settings', 'ci', 'on'], store, io().io, { uid: 0 }), 0)
  const ownerSids = allSessions().filter(s => s.email === OWNER).map(s => s.sid)
  const before = broker.callsTo('upsertSecret').length
  const res = await savePlex(t)
  assert.equal(res.statusCode, 200, res.body)
  assert.ok(broker.callsTo('upsertSecret').slice(before).every(w => ownerSids.includes(w.args[0] as string)))
  assert.equal(store.audits.filter(a => a.action === 'plugin.settings.save')[0].details!.via, 'token ci, without reconfirm')
})
