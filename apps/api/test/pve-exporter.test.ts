// The PVE exporter's read-only Proxmox token: the shared rules (apps/setup/pve-exporter.js), the API's
// adapter over HyperProx's admin token, the routes behind the gate, and `hyperprox pve-exporter`.
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { FakeBroker } from './fakes/fake-broker'
import { resetLock, signIn } from './fakes/app'
import { registerGate } from '../src/lib/gate'
import { setBroker } from '../src/lib/vault/broker'
import { setCredentialTable } from '../src/lib/credentials'
import { authRoutes } from '../src/routes/auth'
import { monitoringRoutes } from '../src/routes/monitoring'
import { requiredRole, needsReconfirm } from '../src/lib/roles'
import { MemoryApiTokenStore, setApiTokenStore, createApiToken, tokenState } from '../src/lib/api-tokens'
import {
  shared, tokenPve, provisionPveExporter, exporterStatus, pveAccessFromEnv, pveExporterConfigPath, type ExporterPve,
} from '../src/lib/pve-exporter'
import { runPveExporterCli } from '../src/cli/pve-exporter'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-pve-exporter-'))
const ACCESS = { host: '192.0.2.5', port: 8006, user: 'root@pam', tokenName: 'hyperprox-node-a-0a1b2c3d', secret: 'admin-secret' }
const EXP = 'hyperprox-node-a-0a1b2c3d-exporter'
const MARK = `[exporter for root@pam!hyperprox-node-a-0a1b2c3d]`

type Tok = { tokenid: string; secret: string; comment?: string; privsep?: number }
function fakePve(tokens: Tok[]): ExporterPve & { calls: string[]; tokens: Tok[] } {
  const calls: string[] = []
  let n = 0
  return {
    calls, tokens,
    async listTokens() { calls.push('list'); return tokens.map(t => ({ tokenid: t.tokenid, comment: t.comment ?? '' })) },
    async deleteToken(name) { calls.push(`delete ${name}`); tokens.splice(tokens.findIndex(t => t.tokenid === name), 1) },
    async createToken(name, o) {
      calls.push(`create ${name} privsep=${o.privsep}`)
      const secret = `exp-${++n}`
      tokens.push({ tokenid: name, secret, comment: o.comment, privsep: o.privsep })
      return { value: secret }
    },
    async setAcl(a) { calls.push(`acl ${a.path} ${a.role} ${a.token}`) },
    async tokenWorks(id, secret) { const [, name] = id.split('!'); return tokens.some(t => t.tokenid === name && t.secret === secret) },
  }
}

// ── The shared rules ─────────────────────────────────────────────────────────

test('a new exporter token: named after HyperProx\'s, privilege-separated, PVEAuditor on / only', async () => {
  const pve = fakePve([{ tokenid: ACCESS.tokenName, secret: 'admin-secret' }])
  const r = await shared.ensureExporterToken(pve, { userid: 'root@pam', adminTokenName: ACCESS.tokenName, held: null })
  assert.equal(r.action, 'create')
  assert.equal(r.fullTokenId, `root@pam!${EXP}`)
  assert.deepEqual(pve.calls, ['list', `create ${EXP} privsep=1`, `acl / PVEAuditor root@pam!${EXP}`])
  assert.ok(pve.tokens.find(t => t.tokenid === EXP)!.comment!.includes(MARK))
})

test('a held secret that still works is reused; only the ACL is re-applied', async () => {
  const pve = fakePve([{ tokenid: EXP, secret: 'kept', comment: MARK }])
  const r = await shared.ensureExporterToken(pve, { userid: 'root@pam', adminTokenName: ACCESS.tokenName,
    held: { user: 'root@pam', tokenName: EXP, secret: 'kept' } })
  assert.equal(r.action, 'reuse')
  assert.equal(r.secret, 'kept')
  assert.deepEqual(pve.calls, [`acl / PVEAuditor root@pam!${EXP}`])
})

test('our token with its secret lost is made again; nothing else is touched', async () => {
  const pve = fakePve([{ tokenid: EXP, secret: 'gone', comment: MARK }, { tokenid: 'other', secret: 'x' }])
  const r = await shared.ensureExporterToken(pve, { userid: 'root@pam', adminTokenName: ACCESS.tokenName,
    held: { user: 'root@pam', tokenName: EXP, secret: 'wrong' } })
  assert.equal(r.action, 'recreate')
  assert.deepEqual(pve.calls, ['list', `delete ${EXP}`, `create ${EXP} privsep=1`, `acl / PVEAuditor root@pam!${EXP}`])
  assert.ok(pve.tokens.some(t => t.tokenid === 'other'))
})

test('a token of that name HyperProx did not make is refused and kept', async () => {
  const pve = fakePve([{ tokenid: EXP, secret: 'theirs', comment: 'made by hand' }])
  await assert.rejects(shared.ensureExporterToken(pve, { userid: 'root@pam', adminTokenName: ACCESS.tokenName, held: null }),
    /already exists and was not made by HyperProx/)
  assert.deepEqual(pve.calls, ['list'])
})

test('an exporter running on HyperProx\'s own full token is moved to a read-only one', async () => {
  // What a hand-filled pve.yml from the old README looks like: the admin token itself.
  const pve = fakePve([{ tokenid: ACCESS.tokenName, secret: 'admin-secret' }])
  const r = await shared.ensureExporterToken(pve, { userid: 'root@pam', adminTokenName: ACCESS.tokenName,
    held: { user: 'root@pam', tokenName: ACCESS.tokenName, secret: 'admin-secret' } })
  assert.equal(r.action, 'create')
  assert.equal(r.tokenName, EXP)
  assert.ok(pve.tokens.some(t => t.tokenid === ACCESS.tokenName), 'the admin token is left alone')
})

test('no HyperProx token yet: refused with a reason', async () => {
  await assert.rejects(shared.ensureExporterToken(fakePve([]), { userid: 'root@pam', adminTokenName: '', held: null }),
    /no Proxmox token yet/)
})

test('pve.yml: what is written reads back; the placeholder reads as no token', () => {
  const t = { user: 'root@pam', tokenName: EXP, secret: 'a"b\\c: d' }
  assert.deepEqual(shared.parsePveYml(shared.renderPveYml(t)), t)
  assert.equal(shared.parsePveYml('default:\n  user: hyperprox@pve\n  token_name: hyperprox\n  token_value: ""\n  verify_ssl: false\n'), null)
  assert.deepEqual(shared.parsePveYml('default:\n  user: root@pam\n  token_name: hyperprox\n  token_value: abc-123\n'),
    { user: 'root@pam', tokenName: 'hyperprox', secret: 'abc-123' })
  assert.match(shared.renderPveYml(t), /verify_ssl: false/)
})

test('pve.yml is written 0600, replacing a directory Docker made, and reports whether it changed', () => {
  const file = path.join(tmp(), 'config', 'pve-exporter', 'pve.yml')
  fs.mkdirSync(file, { recursive: true })
  assert.equal(shared.writePveYml(file, 'one\n'), true)
  assert.equal(fs.statSync(file).isFile(), true)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(shared.writePveYml(file, 'one\n'), false)
  assert.equal(shared.writePveYml(file, 'two\n'), true)
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['pve.yml'], 'no temp file left behind')
})

// ── The API side ─────────────────────────────────────────────────────────────

test('provisioning writes pve.yml, restarts the exporter only on a change, and never returns the secret', async () => {
  const file = path.join(tmp(), 'pve.yml')
  const pve = fakePve([])
  let restarts = 0
  const r1 = await provisionPveExporter({ access: ACCESS, pve, file, restart: async () => { restarts++; return true } })
  assert.deepEqual(r1, { action: 'create', tokenId: `root@pam!${EXP}`, changed: true, restarted: true })
  assert.ok(!JSON.stringify(r1).includes('exp-1'))
  assert.deepEqual(shared.readPveYml(file), { user: 'root@pam', tokenName: EXP, secret: 'exp-1' })
  const r2 = await provisionPveExporter({ access: ACCESS, pve, file, restart: async () => { restarts++; return true } })
  assert.deepEqual(r2, { action: 'reuse', tokenId: `root@pam!${EXP}`, changed: false, restarted: false })
  assert.equal(restarts, 1)
  assert.deepEqual(exporterStatus(file), { configured: true, tokenId: `root@pam!${EXP}`, readOnly: true })
})

test('status: no token, or the full admin token, is reported as not read-only', () => {
  const dir = tmp()
  assert.deepEqual(exporterStatus(path.join(dir, 'missing.yml')), { configured: false, readOnly: false })
  const f = path.join(dir, 'pve.yml')
  fs.writeFileSync(f, shared.renderPveYml({ user: 'root@pam', tokenName: 'hyperprox', secret: 's' }))
  assert.deepEqual(exporterStatus(f), { configured: true, tokenId: 'root@pam!hyperprox', readOnly: false })
})

test('the adapter: the Proxmox calls it makes with HyperProx\'s admin token', async () => {
  const calls: string[] = []
  const pve = tokenPve(ACCESS, (id, secret) => ({
    async fetchStrict(p: string, method = 'GET', body?: string) {
      calls.push(`${id} ${method} ${p}${body ? ` ${body}` : ''}`)
      if (p === '/version' && secret === 'bad') throw new Error('Proxmox GET /version: HTTP 401 — invalid token value')
      if (p === '/version' && secret === 'boom') throw new Error('Proxmox GET /version: no answer within 20s')
      if (method === 'POST') return { value: 'v' }
      return [] as any
    },
  }) as any)
  await pve.listTokens()
  await pve.createToken('n-exporter', { privsep: 1, comment: 'c [x]' })
  await pve.deleteToken('n-exporter')
  await pve.setAcl({ path: '/', role: 'PVEAuditor', token: 'root@pam!n-exporter' })
  assert.deepEqual(calls, [
    'root@pam!hyperprox-node-a-0a1b2c3d GET /access/users/root%40pam/token',
    'root@pam!hyperprox-node-a-0a1b2c3d POST /access/users/root%40pam/token/n-exporter privsep=1&comment=c+%5Bx%5D',
    'root@pam!hyperprox-node-a-0a1b2c3d DELETE /access/users/root%40pam/token/n-exporter',
    'root@pam!hyperprox-node-a-0a1b2c3d PUT /access/acl path=%2F&roles=PVEAuditor&tokens=root%40pam%21n-exporter&propagate=1',
  ])
  assert.equal(await pve.tokenWorks('root@pam!n-exporter', 'good'), true)
  assert.equal(await pve.tokenWorks('root@pam!n-exporter', 'bad'), false)
  await assert.rejects(pve.tokenWorks('root@pam!n-exporter', 'boom'), /no answer/, 'a network failure is not "the token is bad"')
})

test('access comes from the environment the vault fills in at unlock; locked, there is none', () => {
  assert.throws(() => pveAccessFromEnv({}), /locked/)
  assert.deepEqual(pveAccessFromEnv({ PROXMOX_HOST: '192.0.2.5', PROXMOX_USER: 'root@pam', PROXMOX_TOKEN_ID: 't', PROXMOX_TOKEN_SECRET: 's' }),
    { host: '192.0.2.5', port: 8006, user: 'root@pam', tokenName: 't', secret: 's' })
  assert.equal(pveExporterConfigPath({ HYPERPROX_DIR: '/srv/hpx' }), '/srv/hpx/config/pve-exporter/pve.yml')
})

// ── The routes, behind the real gate ─────────────────────────────────────────

test('the role matrix: status is a read (viewer), provisioning a write (admin), no re-confirmation', () => {
  assert.equal(requiredRole('GET', '/api/monitoring/pve-exporter'), 'viewer')
  assert.equal(requiredRole('POST', '/api/monitoring/pve-exporter'), 'admin')
  assert.equal(needsReconfirm('POST', '/api/monitoring/pve-exporter'), false)
})

const broker = new FakeBroker()
broker.addUser('owner@example.com', 'correct horse battery staple', 'owner')
broker.addUser('viewer@example.com', 'viewer master password', 'viewer')
const store = new MemoryApiTokenStore()
let provisions = 0
let failNext = false
async function routesApp() {
  setBroker(broker)
  setApiTokenStore(store)
  // As fakes/app.ts does: no Postgres here, so the unlock's migration sees an empty old store.
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } } as any)
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  const app = Fastify({ logger: false })
  await registerGate(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(monitoringRoutes, {
    prefix: '/api/monitoring',
    status: () => ({ configured: true, tokenId: `root@pam!${EXP}`, readOnly: true }),
    provision: async () => {
      if (failNext) { failNext = false; throw new Error('Proxmox POST /access/acl: HTTP 403 — Permission check failed') }
      provisions++
      return { action: 'create' as const, tokenId: `root@pam!${EXP}`, changed: true, restarted: true }
    },
  })
  await app.ready()
  return app
}
const appP = routesApp()
beforeEach(resetLock)
after(async () => { await resetLock(); setApiTokenStore(null); await (await appP).close() })

test('routes: locked is 423 for both', async () => {
  const app = await appP
  for (const method of ['GET', 'POST'] as const) {
    assert.equal((await app.inject({ method, url: '/api/monitoring/pve-exporter' })).statusCode, 423, method)
  }
})

test('routes: a viewer can read the status but not provision', async () => {
  const app = await appP
  const { cookie } = await signIn(app, 'viewer@example.com', 'viewer master password')
  const g = await app.inject({ method: 'GET', url: '/api/monitoring/pve-exporter', headers: { cookie } })
  assert.equal(g.statusCode, 200)
  assert.equal(g.json().data.readOnly, true)
  const before = provisions
  const p = await app.inject({ method: 'POST', url: '/api/monitoring/pve-exporter', headers: { cookie } })
  assert.equal(p.statusCode, 403)
  assert.equal(p.json().code, 'forbidden')
  assert.equal(provisions, before)
})

test('routes: an owner provisions without re-confirming; a Proxmox refusal comes back as 502 with its reason', async () => {
  const app = await appP
  const { cookie } = await signIn(app, 'owner@example.com', 'correct horse battery staple')
  const p = await app.inject({ method: 'POST', url: '/api/monitoring/pve-exporter', headers: { cookie } })
  assert.equal(p.statusCode, 200)
  assert.deepEqual(p.json().data, { action: 'create', tokenId: `root@pam!${EXP}`, changed: true, restarted: true })
  failNext = true
  const f = await app.inject({ method: 'POST', url: '/api/monitoring/pve-exporter', headers: { cookie } })
  assert.equal(f.statusCode, 502)
  assert.match(f.json().error, /Permission check failed/)
})

test('routes: an admin API token may provision (the host CLI uses one); a viewer token may not', async () => {
  const app = await appP
  await signIn(app, 'owner@example.com', 'correct horse battery staple')
  const admin = (await createApiToken({ name: 'route-admin', role: 'admin' }, 'test', store)).token
  const viewer = (await createApiToken({ name: 'route-viewer', role: 'viewer' }, 'test', store)).token
  assert.equal((await app.inject({ method: 'POST', url: '/api/monitoring/pve-exporter', headers: { authorization: `Bearer ${admin}` } })).statusCode, 200)
  assert.equal((await app.inject({ method: 'POST', url: '/api/monitoring/pve-exporter', headers: { authorization: `Bearer ${viewer}` } })).statusCode, 403)
})

// ── `hyperprox pve-exporter` against the real gate over HTTP ─────────────────

let urlP: Promise<string> | null = null
const apiUrl = () => (urlP ??= appP.then(app => app.listen({ port: 0, host: '127.0.0.1' })))
const io = () => { const out: string[] = [], err: string[] = []; return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } } }

test('cli: provisions through the API with a one-off admin token, then revokes it', async () => {
  const url = await apiUrl()
  await signIn(await appP, 'owner@example.com', 'correct horse battery staple')
  const o = io()
  const code = await runPveExporterCli([], { store, apiUrl: url, now: () => 1000 }, o.io)
  assert.equal(code, 0, o.err.join('\n'))
  assert.match(o.out.join('\n'), /read-only token root@pam!hyperprox-node-a-0a1b2c3d-exporter created \(PVEAuditor on \/\)/)
  assert.match(o.out.join('\n'), /exporter restarted/)
  const row = await store.findByName('host-cli-pve-exporter-1000')
  assert.ok(row, 'the one-off token was made in the database')
  assert.equal(row!.role, 'admin')
  assert.equal(tokenState(row!), 'revoked')
})

test('cli: locked, it says to sign in first, changes nothing, and still revokes its token', async () => {
  const url = await apiUrl()
  const before = provisions
  const o = io()
  const code = await runPveExporterCli([], { store, apiUrl: url, now: () => 2000 }, o.io)
  assert.equal(code, 1)
  assert.match(o.err.join('\n'), /HyperProx is locked\. Sign in at \/login first/)
  assert.equal(provisions, before)
  assert.equal(tokenState((await store.findByName('host-cli-pve-exporter-2000'))!), 'revoked')
})

test('cli: status reads with a viewer token; an unreachable API is reported as such', async () => {
  const app = await appP
  const url = await apiUrl()
  await signIn(app, 'viewer@example.com', 'viewer master password')
  const o = io()
  assert.equal(await runPveExporterCli(['status'], { store, apiUrl: url, now: () => 3000 }, o.io), 0, o.err.join('\n'))
  assert.match(o.out.join('\n'), /uses root@pam!hyperprox-node-a-0a1b2c3d-exporter \(read-only, PVEAuditor\)/)
  assert.equal((await store.findByName('host-cli-pve-exporter-3000'))!.role, 'viewer')
  const d = io()
  assert.equal(await runPveExporterCli([], { store, apiUrl: 'http://127.0.0.1:1', now: () => 4000 }, d.io), 1)
  assert.match(d.err.join('\n'), /could not reach the API/)
  assert.equal(tokenState((await store.findByName('host-cli-pve-exporter-4000'))!), 'revoked')
  assert.equal(await runPveExporterCli(['bogus'], { store, apiUrl: url }, io().io), 2)
})
