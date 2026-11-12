// Local plug-ins: the loader, the fixed rules every one of them gets (admin only, every change re-confirmed,
// no API tokens, audited), and the git-ignore entries that keep them out of git status, the updater and deploy.sh.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { setAuditSink } from '../src/lib/audit'
import { MemoryApiTokenStore, setApiTokenStore, createApiToken, tokenForbidden } from '../src/lib/api-tokens'
import { requiredRole, needsReconfirm } from '../src/lib/roles'
import { loadLocalPlugins, registerLocalPlugins } from '../src/lib/local-plugins'
import { FakeBroker } from './fakes/fake-broker'
import { signIn } from './fakes/app'

const FIXTURES = path.join(__dirname, 'fixtures', 'local-plugins')
const broker = new FakeBroker()
broker.addUser('admin@example.com', 'admin master password', 'admin')
broker.addUser('op@example.com', 'operator master password', 'operator')
broker.addUser('viewer@example.com', 'viewer master password', 'viewer')
const tokens = new MemoryApiTokenStore()
const audits: Array<{ action: string; resource: string; details?: Record<string, unknown> }> = []
let app: FastifyInstance

before(async () => {
  setBroker(broker)
  setApiTokenStore(tokens)
  setAuditSink({ async write(r) { audits.push(r) } })
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  app = Fastify({ logger: false })
  await registerGate(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await registerLocalPlugins(app, loadLocalPlugins(FIXTURES, ['plex']))
  await app.ready()
})
after(async () => { setApiTokenStore(null); setAuditSink(null); if (isUnlocked()) await lock('manual'); await app.close() })

test('the loader: one plug-in per valid folder, bad ids and mismatches reported, a missing folder is none', () => {
  const r = loadLocalPlugins(FIXTURES)
  assert.deepEqual(r.plugins.map(p => p.plugin.id), ['demo'])
  assert.deepEqual(r.errors.map(e => e.id).sort(), ['Bad_Name', 'mismatch'])
  assert.match(r.errors.find(e => e.id === 'mismatch')!.error, /does not match its folder/)
  assert.deepEqual(loadLocalPlugins(path.join(FIXTURES, 'nope')), { plugins: [], errors: [] })
  const reserved = loadLocalPlugins(FIXTURES, ['demo'])
  assert.equal(reserved.plugins.length, 0)
  assert.match(reserved.errors.find(e => e.id === 'demo')!.error, /bundled/)
})

test('the role matrix: every /api/local route is admin, every change re-confirmed, tokens refused', () => {
  for (const m of ['GET', 'POST', 'PUT', 'DELETE']) assert.equal(requiredRole(m, '/api/local/demo/anything'), 'admin', m)
  assert.equal(requiredRole('GET', '/api/local'), 'admin')
  assert.equal(needsReconfirm('GET', '/api/local/demo/hello'), false)
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(needsReconfirm(m, '/api/local/demo/echo'), true, m)
  assert.equal(tokenForbidden('GET', '/api/local/demo/hello'), true)
  assert.equal(tokenForbidden('GET', '/api/local'), true)
  assert.equal(tokenForbidden('GET', '/api/localish'), false, 'only the /api/local tree')
})

test('a viewer and an operator are refused, even for reads', async () => {
  for (const [email, pw] of [['viewer@example.com', 'viewer master password'], ['op@example.com', 'operator master password']]) {
    const { cookie } = await signIn(app, email, pw)
    const r = await app.inject({ method: 'GET', url: '/api/local/demo/hello', headers: { cookie } })
    assert.equal(r.statusCode, 403, email)
    assert.equal(r.json().code, 'forbidden')
  }
})

test('an admin API token is refused, reads included', async () => {
  const t = (await createApiToken({ name: 'auto', role: 'admin' }, 'test', tokens)).token
  for (const [method, url] of [['GET', '/api/local/demo/hello'], ['POST', '/api/local/demo/echo'], ['GET', '/api/local']] as const) {
    const r = await app.inject({ method, url, headers: { authorization: `Bearer ${t}` }, payload: method === 'POST' ? { n: 1 } : undefined })
    assert.equal(r.statusCode, 403, url)
    assert.equal(r.json().code, 'token_forbidden', url)
  }
})

test('an admin reads freely, changes only after the master password, and every change is audited', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const list = await app.inject({ method: 'GET', url: '/api/local', headers: { cookie } })
  assert.deepEqual(list.json().data, [{ id: 'demo', name: 'Demo' }])
  const hello = await app.inject({ method: 'GET', url: '/api/local/demo/hello', headers: { cookie } })
  assert.equal(hello.statusCode, 200, hello.body)
  assert.deepEqual(hello.json().data, { hello: 'demo' })

  const before = audits.length
  const refused = await app.inject({ method: 'POST', url: '/api/local/demo/echo', headers: { cookie }, payload: { n: 7 } })
  assert.equal(refused.statusCode, 403)
  assert.equal(refused.json().code, 'reconfirm_required')
  const since = audits.slice(before)
  assert.equal(since.some(a => a.action === 'local.demo.echo'), false, 'refused at the gate: the handler never ran')
  assert.equal(since.find(a => a.action === 'local.demo.request')?.details?.status, 403, 'and the refusal is audited')

  const rc = await app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie }, payload: { password: 'admin master password' } })
  assert.equal(rc.statusCode, 200)
  const ok = await app.inject({ method: 'POST', url: '/api/local/demo/echo', headers: { cookie }, payload: { n: 7 } })
  assert.equal(ok.statusCode, 200, ok.body)
  assert.deepEqual(ok.json().data, { n: 7 })
  const own = audits.find(a => a.action === 'local.demo.echo')
  assert.ok(own, 'the plug-in\'s own row')
  assert.equal(own!.resource, 'local:demo')
  const generic = audits.filter(a => a.action === 'local.demo.request').pop()
  assert.ok(generic, 'the loader\'s row for every change')
  assert.equal(generic!.details?.status, 200)
  assert.equal(generic!.details?.by, 'admin@example.com')
})

test('git ignores the local plug-in folders, so git status and the updater never count them as local changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-localplug-'))
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: dir, encoding: 'utf8' })
  try {
    git('init', '-q')
    fs.copyFileSync(path.join(__dirname, '..', '..', '..', '.gitignore'), path.join(dir, '.gitignore'))
    git('add', '.gitignore'); git('commit', '-qm', 'base')
    for (const f of ['apps/api/src/local-plugins/x/index.ts', 'apps/api/test/local-plugins/x/a.test.ts',
                     'apps/frontend/local-plugins/x/plugin.tsx', 'apps/frontend/local-plugins/index.ts', 'data/local-plugins/x/cache.bin']) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
      fs.writeFileSync(path.join(dir, f), 'x')
    }
    // The two checks the updater makes (lib/self-update/service.ts and runner.ts).
    assert.equal(git('status', '--porcelain', '--untracked-files=normal').trim(), '')
    assert.equal(git('status', '--porcelain', '--untracked-files=no').trim(), '')
    // And a checkout of another commit (what an update does) leaves them in place.
    fs.writeFileSync(path.join(dir, 'README'), 'r'); git('add', 'README'); git('commit', '-qm', 'next')
    git('checkout', '-q', 'HEAD~1')
    assert.ok(fs.existsSync(path.join(dir, 'apps/api/src/local-plugins/x/index.ts')))
    assert.ok(fs.existsSync(path.join(dir, 'apps/frontend/local-plugins/x/plugin.tsx')))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
