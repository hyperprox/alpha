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
import { runPveExporterCli, ONE_OFF_TTL_MS } from '../src/cli/pve-exporter'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-pve-exporter-'))
const ACCESS = { host: '192.0.2.5', port: 8006, user: 'root@pam', tokenName: 'hyperprox-node-a-0a1b2c3d', secret: 'admin-secret' }
const EXP = 'hyperprox-node-a-0a1b2c3d-exporter'
const MARK = `[exporter for root@pam!hyperprox-node-a-0a1b2c3d]`

type Tok = { tokenid: string; secret: string; comment?: string; privsep?: number }
type Acl = { path: string; roleid: string; type: string; ugid: string }
/** A pretend Proxmox for one user: tokens with privsep, and the ACL list, as PVE answers them. */
function fakePve(tokens: Tok[], acls: Acl[] = [], user = 'root@pam'): ExporterPve & { calls: string[]; tokens: Tok[]; acls: Acl[] } {
  const calls: string[] = []
  let n = 0
  return {
    calls, tokens, acls,
    async listTokens() { calls.push('list'); return tokens.map(t => ({ tokenid: t.tokenid, comment: t.comment ?? '' })) },
    async getToken(name, u = user) {
      calls.push(`get ${u}!${name}`)
      const t = u === user ? tokens.find(x => x.tokenid === name) : undefined
      if (!t) throw new Error(`Proxmox GET /access/users/${u}/token/${name}: HTTP 500 — no such token`)
      return { privsep: t.privsep ?? 1, comment: t.comment }
    },
    async listAcl() { calls.push('acls'); return acls.map(a => ({ ...a })) },
    async deleteToken(name) {
      calls.push(`delete ${name}`)
      tokens.splice(tokens.findIndex(t => t.tokenid === name), 1)
      // As PVE really does: the token's ACL lines stay behind ("ignore invalid acl token") unless removed first.
    },
    async createToken(name, o) {
      calls.push(`create ${name} privsep=${o.privsep}`)
      const secret = `exp-${++n}`
      tokens.push({ tokenid: name, secret, comment: o.comment, privsep: o.privsep })
      return { value: secret }
    },
    async setAcl(a) {
      if (a.delete) {
        calls.push(`acl-delete ${a.path} ${a.role} ${a.token}`)
        for (let i = acls.length - 1; i >= 0; i--) if (acls[i].path === a.path && acls[i].roleid === a.role && acls[i].ugid === a.token) acls.splice(i, 1)
        return
      }
      calls.push(`acl ${a.path} ${a.role} ${a.token}`)
      if (!acls.some(x => x.path === a.path && x.roleid === a.role && x.ugid === a.token)) acls.push({ path: a.path, roleid: a.role, type: 'token', ugid: a.token })
    },
    async tokenWorks(id, secret) { const [, name] = id.split('!'); return tokens.some(t => t.tokenid === name && t.secret === secret) },
  }
}
const auditor = (token: string): Acl => ({ path: '/', roleid: 'PVEAuditor', type: 'token', ugid: token })
const FULL = `root@pam!${EXP}`
const HELD = { user: 'root@pam', tokenName: EXP, secret: 'kept' }
const opts = (held: typeof HELD | null, fresh = false) => ({ userid: 'root@pam', adminTokenName: ACCESS.tokenName, held, fresh })

// ── The shared rules ─────────────────────────────────────────────────────────

test('a new exporter token: named after HyperProx\'s, privilege-separated, PVEAuditor on / only, and checked', async () => {
  const pve = fakePve([{ tokenid: ACCESS.tokenName, secret: 'admin-secret', privsep: 0 }])
  const r = await shared.ensureExporterToken(pve, opts(null))
  assert.equal(r.action, 'create')
  assert.equal(r.fullTokenId, FULL)
  assert.deepEqual(pve.calls, ['list', `create ${EXP} privsep=1`, `acl / PVEAuditor ${FULL}`, `get ${FULL}`, 'acls'])
  assert.ok(pve.tokens.find(t => t.tokenid === EXP)!.comment!.includes(MARK))
})

test('a held secret is reused only when Proxmox says the token is read-only; nothing is changed', async () => {
  const pve = fakePve([{ tokenid: EXP, secret: 'kept', comment: MARK, privsep: 1 }], [auditor(FULL)])
  const r = await shared.ensureExporterToken(pve, opts(HELD))
  assert.equal(r.action, 'reuse')
  assert.equal(r.secret, 'kept')
  assert.deepEqual(pve.calls, [`get ${FULL}`, 'acls'], 'no token or ACL is written')
})

test('reuse refuses a working token with privilege separation off, as not read-only', async () => {
  const pve = fakePve([{ tokenid: EXP, secret: 'kept', comment: MARK, privsep: 0 }], [auditor(FULL)])
  await assert.rejects(shared.ensureExporterToken(pve, opts(HELD)),
    (e: any) => e.code === 'not_read_only' && /not read-only \(privilege separation is off/.test(e.message) && /--fresh/.test(e.message))
  assert.ok(!pve.calls.some(c => /^(create|delete|acl) /.test(c)), 'nothing changed')
})

test('reuse refuses a token with any ACL besides PVEAuditor on /, or without that one', async () => {
  for (const [acls, why] of [
    [[auditor(FULL), { path: '/vms', roleid: 'PVEVMAdmin', type: 'token', ugid: FULL }], /also has PVEVMAdmin on \/vms/],
    [[{ path: '/', roleid: 'Administrator', type: 'token', ugid: FULL }], /no PVEAuditor ACL on \/.*also has Administrator on \//],
    [[], /no PVEAuditor ACL on \//],
  ] as Array<[Acl[], RegExp]>) {
    const pve = fakePve([{ tokenid: EXP, secret: 'kept', comment: MARK, privsep: 1 }], acls)
    await assert.rejects(shared.ensureExporterToken(pve, opts(HELD)), (e: any) => e.code === 'not_read_only' && why.test(e.message), String(why))
  }
})

test('an ACL for another token or a user does not count against it', async () => {
  const pve = fakePve([{ tokenid: EXP, secret: 'kept', comment: MARK, privsep: 1 }],
    [auditor(FULL), { path: '/', roleid: 'Administrator', type: 'token', ugid: 'root@pam!hyperprox' },
     { path: '/', roleid: 'Administrator', type: 'user', ugid: 'root@pam' }])
  assert.equal((await shared.ensureExporterToken(pve, opts(HELD))).action, 'reuse')
})

test('a token is deleted only after its ACL lines: Proxmox would otherwise keep them for a dead token', async () => {
  const pve = fakePve([{ tokenid: EXP, secret: 'kept', comment: MARK, privsep: 0 }],
    [{ path: '/', roleid: 'Administrator', type: 'token', ugid: FULL }, { path: '/vms', roleid: 'PVEVMAdmin', type: 'token', ugid: FULL },
     { path: '/', roleid: 'Administrator', type: 'token', ugid: 'root@pam!other' }])
  await shared.removeTokenCleanly(pve, 'root@pam', EXP)
  const del = pve.calls.indexOf(`delete ${EXP}`)
  assert.ok(pve.calls.indexOf(`acl-delete / Administrator ${FULL}`) >= 0 && pve.calls.indexOf(`acl-delete / Administrator ${FULL}`) < del)
  assert.ok(pve.calls.indexOf(`acl-delete /vms PVEVMAdmin ${FULL}`) < del)
  assert.deepEqual(pve.acls.map(a => a.ugid), ['root@pam!other'], 'another token\'s line is left alone')
})

test('the exporter token is named after HyperProx\'s token, as bootstrap.sh names it', () => {
  assert.equal(shared.exporterTokenName('hyperprox'), 'hyperprox-exporter')
  assert.equal(shared.exporterTokenName('hyperprox-2'), 'hyperprox-2-exporter')
  const boot = fs.readFileSync(path.join(__dirname, '../../../bootstrap.sh'), 'utf8')
  assert.match(boot, /EXPORTER_TOKEN="\$\{TOKEN_NAME\}-exporter"/)
  assert.doesNotMatch(boot, /EXPORTER_TOKEN="hyperprox-exporter"/)
})

test('`hyperprox pve-exporter` adopts a working read-only token pve.yml holds under an older name, not a duplicate', async () => {
  const OLD = 'root@pam!hyperprox-exporter'
  const pve = fakePve([{ tokenid: ACCESS.tokenName, secret: 'admin-secret', privsep: 0 },
    { tokenid: 'hyperprox-exporter', secret: 'old', comment: '[exporter for root@pam!hyperprox]', privsep: 1 }], [auditor(OLD)])
  const dir = tmp()
  const file = path.join(dir, 'pve.yml')
  fs.writeFileSync(file, shared.renderPveYml({ user: 'root@pam', tokenName: 'hyperprox-exporter', secret: 'old' }))
  const r = await provisionPveExporter({ access: ACCESS, pve, file, restart: async () => true })
  assert.equal(r.action, 'reuse')
  assert.equal(r.tokenId, OLD)
  assert.ok(!pve.calls.some(c => c.startsWith('create ')), 'no second exporter token')
})

test('fresh replaces our not-read-only token with a new one; its old ACLs go with it', async () => {
  const pve = fakePve([{ tokenid: EXP, secret: 'kept', comment: MARK, privsep: 0 }],
    [{ path: '/', roleid: 'Administrator', type: 'token', ugid: FULL }])
  const r = await shared.ensureExporterToken(pve, opts(HELD, true))
  assert.equal(r.action, 'recreate')
  assert.notEqual(r.secret, 'kept')
  assert.equal(pve.tokens.find(t => t.tokenid === EXP)!.privsep, 1)
  assert.deepEqual(pve.acls, [auditor(FULL)])
})

test('fresh still refuses to replace a token HyperProx did not make', async () => {
  const pve = fakePve([{ tokenid: EXP, secret: 'kept', comment: 'made by hand', privsep: 0 }])
  await assert.rejects(shared.ensureExporterToken(pve, opts(HELD, true)), /was not made by HyperProx/)
  assert.ok(!pve.calls.some(c => c.startsWith('delete')))
})

test('a new token that does not come out read-only is not handed out', async () => {
  // e.g. an ACL Proxmox kept for that token id from before: the check after creating catches it.
  const pve = fakePve([], [{ path: '/storage', roleid: 'PVEDatastoreAdmin', type: 'token', ugid: FULL }])
  await assert.rejects(shared.ensureExporterToken(pve, opts(null)), (e: any) => e.code === 'not_read_only' && /PVEDatastoreAdmin/.test(e.message))
})

test('our token with its secret lost is made again; nothing else is touched', async () => {
  const pve = fakePve([{ tokenid: EXP, secret: 'gone', comment: MARK }, { tokenid: 'other', secret: 'x' }], [auditor(FULL)])
  const r = await shared.ensureExporterToken(pve, opts({ ...HELD, secret: 'wrong' }))
  assert.equal(r.action, 'recreate')
  assert.deepEqual(pve.calls, ['list', 'acls', `acl-delete / PVEAuditor ${FULL}`, `delete ${EXP}`, `create ${EXP} privsep=1`, `acl / PVEAuditor ${FULL}`, `get ${FULL}`, 'acls'])
  assert.ok(pve.tokens.some(t => t.tokenid === 'other'))
})

test('a token of that name HyperProx did not make is refused and kept', async () => {
  const pve = fakePve([{ tokenid: EXP, secret: 'theirs', comment: 'made by hand' }])
  await assert.rejects(shared.ensureExporterToken(pve, opts(null)), /already exists and was not made by HyperProx/)
  assert.deepEqual(pve.calls, ['list'])
})

test('an exporter running on HyperProx\'s own full token is moved to a read-only one', async () => {
  // What a hand-filled pve.yml from the old README looks like: the admin token itself.
  const pve = fakePve([{ tokenid: ACCESS.tokenName, secret: 'admin-secret', privsep: 0 }])
  const r = await shared.ensureExporterToken(pve, opts({ user: 'root@pam', tokenName: ACCESS.tokenName, secret: 'admin-secret' }))
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
  assert.deepEqual(r1, { action: 'create', tokenId: FULL, changed: true, restarted: true })
  assert.ok(!JSON.stringify(r1).includes('exp-1'))
  assert.deepEqual(shared.readPveYml(file), { user: 'root@pam', tokenName: EXP, secret: 'exp-1' })
  const r2 = await provisionPveExporter({ access: ACCESS, pve, file, restart: async () => { restarts++; return true } })
  assert.deepEqual(r2, { action: 'reuse', tokenId: FULL, changed: false, restarted: false })
  assert.equal(restarts, 1)
  assert.deepEqual(await exporterStatus({ file, pve: () => pve }), { configured: true, tokenId: FULL, readOnly: true })
})

test('provisioning with fresh replaces a held token that is not read-only', async () => {
  const file = path.join(tmp(), 'pve.yml')
  fs.writeFileSync(file, shared.renderPveYml(HELD))
  const pve = fakePve([{ tokenid: EXP, secret: 'kept', comment: MARK, privsep: 0 }], [auditor(FULL)])
  await assert.rejects(provisionPveExporter({ access: ACCESS, pve, file, restart: async () => true }), (e: any) => e.code === 'not_read_only')
  assert.equal(shared.readPveYml(file)!.secret, 'kept', 'pve.yml untouched by the refusal')
  const r = await provisionPveExporter({ access: ACCESS, pve, file, restart: async () => true, fresh: true })
  assert.equal(r.action, 'recreate')
  assert.notEqual(shared.readPveYml(file)!.secret, 'kept')
})

test('status asks Proxmox, not the name: a "-exporter" token with privsep off is not read-only', async () => {
  const dir = tmp()
  assert.deepEqual(await exporterStatus({ file: path.join(dir, 'missing.yml'), pve: () => fakePve([]) }), { configured: false, readOnly: false })
  const f = path.join(dir, 'pve.yml')
  fs.writeFileSync(f, shared.renderPveYml(HELD))
  const st = await exporterStatus({ file: f, pve: () => fakePve([{ tokenid: EXP, secret: 'kept', privsep: 0 }], [auditor(FULL)]) })
  assert.equal(st.readOnly, false)
  assert.match(st.reasons!.join(), /privilege separation is off/)
  // The admin token itself, named anything: what its ACLs and privsep say decide.
  fs.writeFileSync(f, shared.renderPveYml({ user: 'root@pam', tokenName: 'hyperprox', secret: 's' }))
  const admin = await exporterStatus({ file: f, pve: () => fakePve([{ tokenid: 'hyperprox', secret: 's', privsep: 0 }],
    [{ path: '/', roleid: 'Administrator', type: 'token', ugid: 'root@pam!hyperprox' }]) })
  assert.equal(admin.readOnly, false)
  // A token under another user is looked up under that user.
  fs.writeFileSync(f, shared.renderPveYml({ user: 'metrics@pve', tokenName: 'ro', secret: 's' }))
  const other = fakePve([{ tokenid: 'ro', secret: 's', privsep: 1 }], [auditor('metrics@pve!ro')], 'metrics@pve')
  assert.deepEqual(await exporterStatus({ file: f, pve: () => other }), { configured: true, tokenId: 'metrics@pve!ro', readOnly: true })
  assert.ok(other.calls.includes('get metrics@pve!ro'))
})

test('status: when Proxmox cannot be asked, read-only is unknown, not true', async () => {
  const f = path.join(tmp(), 'pve.yml')
  fs.writeFileSync(f, shared.renderPveYml(HELD))
  const locked = await exporterStatus({ file: f, pve: () => { throw new Error('HyperProx is locked') } })
  assert.equal(locked.readOnly, null)
  assert.match(locked.checkError!, /locked/)
  const down = fakePve([])
  down.listAcl = async () => { throw new Error('Proxmox GET /access/acl: no answer within 20s') }
  ;(down as any).getToken = async () => ({ privsep: 1 })
  const st = await exporterStatus({ file: f, pve: () => down })
  assert.equal(st.readOnly, null)
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
  await pve.setAcl({ path: '/', role: 'PVEAuditor', token: 'root@pam!n-exporter', delete: true })
  await pve.getToken('n-exporter')
  await pve.getToken('ro', 'metrics@pve')
  await pve.listAcl()
  assert.deepEqual(calls, [
    'root@pam!hyperprox-node-a-0a1b2c3d GET /access/users/root%40pam/token',
    'root@pam!hyperprox-node-a-0a1b2c3d POST /access/users/root%40pam/token/n-exporter privsep=1&comment=c+%5Bx%5D',
    'root@pam!hyperprox-node-a-0a1b2c3d DELETE /access/users/root%40pam/token/n-exporter',
    'root@pam!hyperprox-node-a-0a1b2c3d PUT /access/acl path=%2F&roles=PVEAuditor&tokens=root%40pam%21n-exporter&propagate=1',
    'root@pam!hyperprox-node-a-0a1b2c3d PUT /access/acl path=%2F&roles=PVEAuditor&tokens=root%40pam%21n-exporter&delete=1',
    'root@pam!hyperprox-node-a-0a1b2c3d GET /access/users/root%40pam/token/n-exporter',
    'root@pam!hyperprox-node-a-0a1b2c3d GET /access/users/metrics%40pve/token/ro',
    'root@pam!hyperprox-node-a-0a1b2c3d GET /access/acl',
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
let failNext: 'proxmox' | 'not_read_only' | null = null
let lastFresh: boolean | null = null
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
    status: async () => ({ configured: true, tokenId: `root@pam!${EXP}`, readOnly: true }),
    provision: async ({ fresh }) => {
      lastFresh = fresh
      const f = failNext; failNext = null
      if (f === 'proxmox') throw new Error('Proxmox POST /access/acl: HTTP 403 — Permission check failed')
      if (f === 'not_read_only') throw new shared.NotReadOnlyError(`root@pam!${EXP}`, ['privilege separation is off, so it has every right its user has'])
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
  assert.equal(lastFresh, false)
  failNext = 'proxmox'
  const f = await app.inject({ method: 'POST', url: '/api/monitoring/pve-exporter', headers: { cookie } })
  assert.equal(f.statusCode, 502)
  assert.match(f.json().error, /Permission check failed/)
})

test('routes: a token that is not read-only is a 409 not_read_only; { fresh: true } asks for a new one', async () => {
  const app = await appP
  const { cookie } = await signIn(app, 'owner@example.com', 'correct horse battery staple')
  failNext = 'not_read_only'
  const r = await app.inject({ method: 'POST', url: '/api/monitoring/pve-exporter', headers: { cookie } })
  assert.equal(r.statusCode, 409)
  assert.equal(r.json().code, 'not_read_only')
  assert.match(r.json().reasons.join(), /privilege separation is off/)
  const f = await app.inject({ method: 'POST', url: '/api/monitoring/pve-exporter', headers: { cookie }, payload: { fresh: true } })
  assert.equal(f.statusCode, 200)
  assert.equal(lastFresh, true)
  await app.inject({ method: 'POST', url: '/api/monitoring/pve-exporter', headers: { cookie }, payload: { fresh: 'yes' } })
  assert.equal(lastFresh, false, 'only a real true counts')
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
const T = Date.now()
const one = (k: number) => `host-cli-pve-exporter-${T + k}`
const io = () => { const out: string[] = [], err: string[] = []; return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } } }

test('cli: provisions through the API with a one-off admin token, then revokes it', async () => {
  const url = await apiUrl()
  await signIn(await appP, 'owner@example.com', 'correct horse battery staple')
  const o = io()
  const code = await runPveExporterCli([], { store, apiUrl: url, now: () => T + 1000 }, o.io)
  assert.equal(code, 0, o.err.join('\n'))
  assert.match(o.out.join('\n'), /read-only token root@pam!hyperprox-node-a-0a1b2c3d-exporter created \(PVEAuditor on \/\)/)
  assert.match(o.out.join('\n'), /exporter restarted/)
  const row = await store.findByName(one(1000))
  assert.ok(row, 'the one-off token was made in the database')
  assert.equal(row!.role, 'admin')
  assert.equal(tokenState(row!), 'revoked')
})

test('cli: locked, it says to sign in first, changes nothing, and still revokes its token', async () => {
  const url = await apiUrl()
  const before = provisions
  const o = io()
  const code = await runPveExporterCli([], { store, apiUrl: url, now: () => T + 2000 }, o.io)
  assert.equal(code, 1)
  assert.match(o.err.join('\n'), /HyperProx is locked\. Sign in at \/login first/)
  assert.equal(provisions, before)
  assert.equal(tokenState((await store.findByName(one(2000)))!), 'revoked')
})

test('cli: status reads with a viewer token; an unreachable API is reported as such', async () => {
  const app = await appP
  const url = await apiUrl()
  await signIn(app, 'viewer@example.com', 'viewer master password')
  const o = io()
  assert.equal(await runPveExporterCli(['status'], { store, apiUrl: url, now: () => T + 3000 }, o.io), 0, o.err.join('\n'))
  assert.match(o.out.join('\n'), /uses root@pam!hyperprox-node-a-0a1b2c3d-exporter \(read-only: privilege separation on, only PVEAuditor on \/\)/)
  assert.equal((await store.findByName(one(3000)))!.role, 'viewer')
  const d = io()
  assert.equal(await runPveExporterCli([], { store, apiUrl: 'http://127.0.0.1:1', now: () => T + 4000 }, d.io), 1)
  assert.match(d.err.join('\n'), /could not reach the API/)
  assert.equal(tokenState((await store.findByName(one(4000)))!), 'revoked')
  assert.equal(await runPveExporterCli(['bogus'], { store, apiUrl: url }, io().io), 2)
})

test('cli: the one-off token lives ten minutes at most', async () => {
  const url = await apiUrl()
  await signIn(await appP, 'owner@example.com', 'correct horse battery staple')
  await runPveExporterCli([], { store, apiUrl: url, now: () => T + 5000 }, io().io)
  const row = (await store.findByName(one(5000)))!
  assert.equal(row.expiresAt!.getTime() - (T + 5000), ONE_OFF_TTL_MS)
  assert.equal(ONE_OFF_TTL_MS, 10 * 60_000)
})

test('cli: --fresh asks the API for a new token', async () => {
  const url = await apiUrl()
  await signIn(await appP, 'owner@example.com', 'correct horse battery staple')
  assert.equal(await runPveExporterCli(['--fresh'], { store, apiUrl: url, now: () => T + 6000 }, io().io), 0)
  assert.equal(lastFresh, true)
  assert.equal(await runPveExporterCli([], { store, apiUrl: url, now: () => T + 6001 }, io().io), 0)
  assert.equal(lastFresh, false)
})

test('cli: every run revokes one-off tokens an earlier run left active, and nothing else', async () => {
  const url = await apiUrl()
  await signIn(await appP, 'owner@example.com', 'correct horse battery staple')
  await createApiToken({ name: one(7000), role: 'admin', expiresDays: 1 }, 'host-cli', store)   // a SIGKILLed run
  await createApiToken({ name: 'host-cli-pve-exporterx', role: 'admin' }, 'host-cli', store)
  await createApiToken({ name: 'ci-deploy', role: 'admin' }, 'host-cli', store)
  const o = io()
  assert.equal(await runPveExporterCli(['status'], { store, apiUrl: url, now: () => T + 7001 }, o.io), 0)
  assert.equal(tokenState((await store.findByName(one(7000)))!), 'revoked')
  assert.match(o.err.join('\n'), new RegExp(`revoked a one-off API token an earlier run left active \\(${one(7000)}\\)`))
  assert.equal(tokenState((await store.findByName('host-cli-pve-exporterx'))!), 'active')
  assert.equal(tokenState((await store.findByName('ci-deploy'))!), 'active')
})

test('cli: Ctrl-C or SIGTERM mid-request revokes the one-off token and exits 130/143', async () => {
  for (const [sig, want, k] of [['SIGINT', 130, 8000], ['SIGTERM', 143, 8001]] as const) {
    let handler: ((s: string) => Promise<number>) | null = null
    let unhooked = false
    let exitCode: number | null = null
    const run = runPveExporterCli([], {
      store, apiUrl: 'http://127.0.0.1:1', now: () => T + k,
      fetch: () => new Promise(() => {}),        // the API call never finishes: the user gives up
      onSignal: (h) => { handler = h; return () => { unhooked = true } },
    }, io().io)
    void run
    while (!handler) await new Promise(r => setTimeout(r, 5))
    assert.equal(tokenState((await store.findByName(one(k)))!), 'active', 'live while the request runs')
    exitCode = await handler!(sig)
    assert.equal(exitCode, want)
    assert.equal(tokenState((await store.findByName(one(k)))!), 'revoked', `${sig} revoked it`)
    assert.equal(unhooked, false, 'the run itself never finished; the process exits on the handler\'s code')
  }
})
