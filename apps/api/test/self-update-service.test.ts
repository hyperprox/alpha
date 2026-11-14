// The API's side of the self-update: who may install (admin, master password re-entered, never an API token),
// what refuses an install (locked, a run or a deploy in progress, local changes, signed-only on alpha, a stale
// target, no room), the progress surviving an API restart (a new service reads the updater's state file), the
// closing audit and notification exactly once, a vanished updater shown as interrupted, notifications off by
// default, and automatic install only for stable releases inside the window. Nothing real is run.
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { FakeBroker } from './fakes/fake-broker'
import { signIn } from './fakes/app'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { apiTokenRoutes } from '../src/routes/api-tokens'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { MemoryApiTokenStore, setApiTokenStore, createApiToken } from '../src/lib/api-tokens'
import { requiredRole, needsReconfirm } from '../src/lib/roles'
import { buildSelfUpdateRoutes } from '../src/routes/self-update'
import { SelfUpdateService, RefusedError, type SelfUpdateDeps } from '../src/lib/self-update/service'
import { FileStateSink, readState, type UpdateJob } from '../src/lib/self-update/state'
import type { Shell } from '../src/lib/self-update/shell'
import type { Upstream } from '../src/lib/self-update/upstream'

const A = 'a'.repeat(40), B = 'b'.repeat(40)

// describe: a release tag by default (it follows stable); an untagged one ("v0.1.0-alpha-5-g…") follows main unless a channel is chosen.
interface World { dirty: string; lockBusy: boolean; unitActive: boolean; freeKiB: number; head: string; unlocked: boolean; describe: string }
function world(over: Partial<World> = {}): World { return { dirty: '', lockBusy: false, unitActive: false, freeKiB: 50_000_000, head: A, unlocked: true, describe: 'v0.2.0-alpha', ...over } }

function fakeShell(w: World): Shell & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async run(cmd, args) {
      calls.push([cmd, ...args].join(' '))
      const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
      if (cmd === 'git') {
        args = args.filter((x, i) => !(x === '-c' || args[i - 1] === '-c'))
        if (args[0] === 'rev-parse') return ok(w.head + '\n')
        if (args[0] === 'symbolic-ref') return ok('main\n')
        if (args[0] === 'describe') return ok(w.describe + '\n')
        if (args[0] === 'status') return ok(w.dirty)
      }
      if (cmd === 'df') return ok(`h\n/dev/x 1 1 ${w.freeKiB} 1% /\n`)
      if (cmd === 'flock') return { code: w.lockBusy ? 75 : 0, stdout: '', stderr: '' }
      if (cmd === 'systemctl') return { code: args.includes('hyperprox-keyholder') ? 0 : w.unitActive ? 0 : 3, stdout: '', stderr: '' }
      return { code: 1, stdout: '', stderr: 'unexpected' }
    },
  }
}

function upstreamWith(sha: string | null, channel: 'stable' | 'alpha' = 'stable'): Upstream {
  return {
    source: 'github', where: 'github.com/example/hyperprox',
    async releases() { return sha ? [{ tag: 'v0.3.0', name: 'v0.3.0', notes: 'Notes', date: null, prerelease: false, url: null }] : [] },
    async tags() { return [] },
    async tag() { return { tag: 'v0.3.0', commit: sha!, annotated: true, signed: false, verified: null } },
    async head() { return { sha: sha ?? A, subject: 'x', body: '', date: null } },
    async compare() { return { status: 'ahead' as const, commits: [{ sha: sha!, subject: 'feat: new', body: '', date: null }], files: [], total: 1 } },
  }
}

interface Rig { svc: SelfUpdateService; w: World; dir: string; audits: Array<[string, any]>; published: any[]; launched: UpdateJob[]; sh: ReturnType<typeof fakeShell>; deps: SelfUpdateDeps }
const rigs: string[] = []
function rig(over: Partial<SelfUpdateDeps> = {}, wo: Partial<World> = {}, ups: Upstream[] = [upstreamWith(B)], dirIn?: string): Rig {
  const dir = dirIn ?? fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-su-svc-'))
  if (!dirIn) rigs.push(dir)
  fs.writeFileSync(path.join(dir, 'package.json'), '{"version":"0.2.0-alpha"}')
  fs.writeFileSync(path.join(dir, '.env'), 'POSTGRES_PASSWORD=pw-not-real-123456\n')
  const lockFile = path.join(dir, 'deploy.lock'); fs.writeFileSync(lockFile, '')
  const w = world(wo)
  const sh = fakeShell(w)
  const audits: Array<[string, any]> = [], published: any[] = [], launched: UpdateJob[] = []
  const deps: SelfUpdateDeps = {
    dir, dataDir: path.join(dir, 'data', 'self-update'), sh,
    config: { repoUrl: 'https://github.com/example/hyperprox.git', mirrorUrl: null, trustedKeys: null, allowInsecure: false },
    upstreams: () => ups, isUnlocked: () => w.unlocked,
    publish: async e => { published.push(e) }, audit: async (a, d) => { audits.push([a, d]) },
    launch: async (job) => { launched.push(job) }, lockFile, backupDir: path.join(dir, 'bk'), runningSha: 'aaaaaaa',
    ...over,
  }
  return { svc: new SelfUpdateService(deps), w, dir, audits, published, launched, sh, deps }
}
after(() => { for (const d of rigs) fs.rmSync(d, { recursive: true, force: true }) })

const codes = async (r: Rig) => (await r.svc.refusals(r.svc.lastCheck()?.available ?? null)).refusals.map(x => x.code)

// --- guards -------------------------------------------------------------------------------------------------

test('refusals: locked, an update running, a deploy running, local changes (listed), alpha with signed-only, no update', async () => {
  const r = rig()
  await r.svc.check()
  assert.deepEqual(await codes(r), [])
  r.w.unlocked = false; assert.ok((await codes(r)).includes('locked')); r.w.unlocked = true
  r.w.lockBusy = true; assert.ok((await codes(r)).includes('deploy_running')); r.w.lockBusy = false
  r.w.dirty = ' M deploy.sh\n?? notes.txt\n'
  const d = await r.svc.refusals(r.svc.lastCheck()!.available)
  const dirty = d.refusals.find(x => x.code === 'dirty')!
  assert.ok(dirty, 'local changes refuse'); assert.deepEqual(dirty.detail, ['M deploy.sh'])
  assert.deepEqual(d.untracked, ['notes.txt'], 'untracked files are listed but do not refuse')
  r.w.dirty = '?? notes.txt\n'; assert.deepEqual(await codes(r), [], 'untracked only: allowed')
  await r.svc.saveSettings({ channel: 'alpha' }, 'admin@example.com')
  await r.svc.saveSettings({ requireSigned: true }, 'admin@example.com')
  assert.ok((await codes(r)).includes('unsigned_channel'))
  assert.ok((await codes(r)).includes('no_trusted_keys'))
  const none = rig({}, {}, [upstreamWith(null)])
  await none.svc.check()
  assert.ok((await codes(none)).includes('no_update'))
})

test('an update in progress refuses a second one, and a stale or wrong target is refused', async () => {
  const r = rig()
  await r.svc.check()
  await assert.rejects(r.svc.install('admin@example.com', 'f'.repeat(40)), (e: any) => e instanceof RefusedError && e.refusals.some(x => x.code === 'stale_target'))
  const st = await r.svc.install('admin@example.com', B)
  assert.equal(st.status, 'running')
  assert.equal(r.launched.length, 1)
  r.w.lockBusy = true   // the updater holds the deploy lock
  await assert.rejects(r.svc.install('admin@example.com', B), (e: any) => e.refusals.some((x: any) => x.code === 'update_running'))
  assert.equal(r.launched.length, 1)
})

test('not enough disk, and a checkout that is not what is running, refuse', async () => {
  const r = rig({}, { freeKiB: 1024 * 100 })
  await r.svc.check()
  await assert.rejects(r.svc.install('a@example.com', B), (e: any) => e.refusals.some((x: any) => x.code === 'disk'))
  const s = rig({ runningSha: 'ccccccc' })
  await s.svc.check()
  assert.ok((await codes(s)).includes('not_deployed'))
})

test('install: audited before it starts, a job file and a state file written, the updater launched with the pinned commit', async () => {
  const r = rig()
  await r.svc.check()
  await r.svc.install('admin@example.com', B)
  assert.equal(r.audits[0][0], 'self-update.start')
  assert.equal(r.audits[0][1].to, B)
  const job = r.launched[0]
  assert.equal(job.target.sha, B); assert.equal(job.from.sha, A); assert.equal(job.from.branch, 'main')
  assert.equal(job.repoUrl, 'https://github.com/example/hyperprox.git')
  assert.equal(job.lockHeld, true)
  assert.equal(fs.statSync(path.join(r.deps.dataDir, 'jobs', `${job.id}.json`)).mode & 0o777, 0o600)
  // An audit that cannot be written: nothing starts.
  const q = rig({ audit: async () => { throw new Error('db down') } })
  await q.svc.check()
  await assert.rejects(q.svc.install('admin@example.com', B), /db down/)
  assert.equal(q.launched.length, 0)
})

// --- the run, across an API restart ----------------------------------------------------------------------------

test('progress survives the API restarting: a new service reads the updater\'s state; the end is reported once', async () => {
  const r = rig()
  await r.svc.check()
  await r.svc.install('admin@example.com', B)
  const job = r.launched[0]
  // The updater, in its own process, writes progress as it goes.
  const st = readState(job.stateFile)!
  const sink = new FileStateSink(job.stateFile, st)
  sink.update(s => { s.steps[0].status = 'done'; s.steps[1].status = 'running' })
  sink.line('→ Installing dependencies...')
  sink.flush()
  r.w.lockBusy = true

  // "Restart": a brand-new service, with nothing in memory.
  const after1 = rig({}, { lockBusy: true }, [upstreamWith(B)], r.dir)
  const seen = await after1.svc.job()
  assert.equal(seen!.id, job.id)
  assert.equal(seen!.status, 'running')
  assert.equal(seen!.steps[0].status, 'done'); assert.equal(seen!.steps[1].status, 'running')
  assert.ok(seen!.log.includes('→ Installing dependencies...'))
  assert.equal(await after1.svc.reportFinished(), false, 'nothing to report while it runs')

  sink.update(s => { s.status = 'succeeded'; s.finishedAt = new Date().toISOString(); s.summary = 'HyperProx is now v0.3.0.' })
  const after2 = rig({}, {}, [upstreamWith(B)], r.dir)
  assert.equal(await after2.svc.reportFinished(), true)
  assert.equal(after2.audits[0][0], 'self-update.finish')
  assert.equal(after2.audits[0][1].status, 'succeeded')
  assert.equal(after2.published[0].type, 'updates.self.succeeded')
  const after3 = rig({}, {}, [upstreamWith(B)], r.dir)
  assert.equal(await after3.svc.reportFinished(), false, 'reported once, whichever API is running')
  assert.equal(after3.published.length, 0)
})

test('a run whose updater vanished is shown as interrupted (after a grace period), never as running forever', async () => {
  const r = rig()
  await r.svc.check()
  await r.svc.install('admin@example.com', B)
  const file = r.launched[0].stateFile
  const st = readState(file)!
  st.startedAt = new Date(Date.now() - 10 * 60_000).toISOString()
  fs.writeFileSync(file, JSON.stringify(st))
  r.w.unitActive = true
  assert.equal((await r.svc.job())!.status, 'running', 'its unit is still active')
  r.w.unitActive = false
  const j = await r.svc.job()
  assert.equal(j!.status, 'interrupted')
  assert.equal(readState(file)!.status, 'interrupted')
})

test('the job read back is redacted again, whatever the file holds', async () => {
  const r = rig()
  await r.svc.check()
  await r.svc.install('admin@example.com', B)
  const file = r.launched[0].stateFile
  const st = readState(file)!
  st.log.push('oops pw-not-real-123456 leaked', 'Authorization: Bearer abcdefghijklmnopq')
  fs.writeFileSync(file, JSON.stringify(st))
  const j = await r.svc.job()
  assert.ok(!JSON.stringify(j).includes('pw-not-real-123456'))
  assert.ok(!JSON.stringify(j).includes('abcdefghijklmnopq'))
})

// --- checks, notifications, automatic install -------------------------------------------------------------------

test('check: the next upstream answers when the first fails; a notification only when turned on, once per update', async () => {
  const broken: Upstream = { ...upstreamWith(B), where: 'broken', async releases() { throw new Error('down') } }
  const r = rig({}, {}, [broken, upstreamWith(B)])
  const c = await r.svc.check()
  assert.equal(c.available?.sha, B); assert.equal(c.source, 'github.com/example/hyperprox')
  assert.equal(r.published.length, 0, 'off by default')
  await r.svc.saveSettings({ notify: true }, 'admin@example.com')
  await r.svc.check(); await r.svc.check()
  assert.equal(r.published.filter(p => p.type === 'updates.self.available').length, 1)
  const all = rig({}, {}, [broken])
  const e = await all.svc.check()
  assert.equal(e.available, null); assert.match(e.error!, /Could not check/)
})

const SIGNED = { config: { repoUrl: 'https://github.com/example/hyperprox.git', mirrorUrl: null, trustedKeys: '/keys/allowed_signers', allowInsecure: false } }

test('automatic install: off by default; only with trusted keys; stable only, inside the window', async () => {
  const plain = rig()
  await assert.rejects(plain.svc.saveSettings({ autoInstall: true }, 'admin@example.com'), /HYPERPROX_UPDATE_TRUSTED_KEYS/)
  assert.match(plain.svc.autoInstallBlocked()!, /trusted keys/)
  let now = new Date('2026-11-12T12:00:00')
  const r = rig({ now: () => now, ...SIGNED })
  assert.equal(r.svc.autoInstallBlocked(), null)
  await r.svc.tick()
  assert.equal(r.launched.length, 0, 'off by default')
  await r.svc.saveSettings({ autoInstall: true, window: { days: [4], start: '03:00', end: '05:00' } }, 'admin@example.com')
  await r.svc.tick()
  assert.equal(r.launched.length, 0, 'outside the window')
  now = new Date('2026-11-12T03:30:00')   // Thursday
  await r.svc.tick()
  assert.equal(r.launched.length, 1)
  assert.equal(r.launched[0].by, 'automatic install'); assert.equal(r.launched[0].how, 'auto')
  assert.equal(r.launched[0].requireSigned, true); assert.equal(r.launched[0].allowUnrelated, false)
  const alpha = rig({ now: () => new Date('2026-11-12T03:30:00'), ...SIGNED }, {}, [upstreamWith(B, 'alpha')])
  await assert.rejects(alpha.svc.saveSettings({ channel: 'alpha', autoInstall: true }, 'x'), /stable/)
})

test('automatic install: a release that rolled back is never retried, also after an API restart', async () => {
  const at = () => new Date('2026-11-12T03:30:00')
  const r = rig({ now: at, ...SIGNED })
  await r.svc.saveSettings({ autoInstall: true, window: { days: [4], start: '03:00', end: '05:00' } }, 'admin@example.com')
  await r.svc.tick()
  assert.equal(r.launched.length, 1)
  // The updater ends rolled back.
  const st = readState(r.launched[0].stateFile)!
  st.status = 'rolled-back'; st.finishedAt = new Date().toISOString()
  fs.writeFileSync(r.launched[0].stateFile, JSON.stringify(st))
  await r.svc.tick()
  assert.equal(r.launched.length, 1, 'not again in the same process')
  // "Restart": a new service over the same files.
  const after = rig({ now: at, ...SIGNED }, {}, [upstreamWith(B)], r.dir)
  await after.svc.tick()
  assert.equal(after.launched.length, 0, 'not again after the restart either')
  assert.equal(after.svc.autoAttemptRefused(B), true)
  // The state file gone (or lost) is no excuse to retry.
  fs.rmSync(r.launched[0].stateFile)
  await after.svc.tick()
  assert.equal(after.launched.length, 0)
  // A person can still install it.
  await after.svc.install('admin@example.com', B)
  assert.equal(after.launched.length, 1)
})

test('automatic install never takes an update found only on the mirror', async () => {
  const fromMirror: Upstream = { ...upstreamWith(B), where: 'gitlab.example.com/root/hyperprox', mirror: true }
  const broken: Upstream = { ...upstreamWith(B), async releases() { throw new Error('down') } }
  const r = rig({ now: () => new Date('2026-11-12T03:30:00'), ...SIGNED }, {}, [broken, fromMirror])
  await r.svc.saveSettings({ autoInstall: true, window: { days: [4], start: '03:00', end: '05:00' } }, 'admin@example.com')
  await r.svc.tick()
  assert.equal(r.svc.lastCheck()!.fromMirror, true)
  assert.equal(r.launched.length, 0)
  await assert.rejects(r.svc.install('automatic install', B, 'auto'), (e: any) => e.refusals.some((x: any) => x.code === 'auto_mirror'))
})

test('trusted keys in .env lock "require signed releases" on; the page cannot turn it off', async () => {
  const r = rig(SIGNED)
  assert.equal(r.svc.settings().requireSigned, true)
  assert.match(r.svc.locks().requireSigned!, /HYPERPROX_UPDATE_TRUSTED_KEYS/)
  await assert.rejects(r.svc.saveSettings({ requireSigned: false }, 'x'), /always required/)
  assert.deepEqual(rig().svc.locks(), {})
})

test('a move to a commit that does not contain the installed one needs the label typed, and never automatically', async () => {
  const unrelated: Upstream = { ...upstreamWith(B, 'alpha'), async compare() { return { status: 'unknown' as const, commits: [], files: null, total: 0 } } }
  const r = rig({}, {}, [unrelated])
  await r.svc.saveSettings({ channel: 'alpha' }, 'x')
  const c = await r.svc.check()
  assert.equal(c.available?.flags.unknownBase, true)
  const pv = await r.svc.preview()
  assert.equal(pv.confirmUnrelated, c.available!.label)
  await assert.rejects(r.svc.install('admin@example.com', B), (e: any) => e.refusals.some((x: any) => x.code === 'confirm_unrelated'))
  await assert.rejects(r.svc.install('admin@example.com', B, 'manual', { confirmUnrelated: 'main' }), (e: any) => e.refusals.some((x: any) => x.code === 'confirm_unrelated'))
  await r.svc.install('admin@example.com', B, 'manual', { confirmUnrelated: c.available!.label })
  assert.equal(r.launched[0].allowUnrelated, true)
})

// --- the routes, behind the real gate -----------------------------------------------------------------------------

const OWNER = 'owner@example.com', OWNER_PW = 'owner master password'
const ADMIN = 'admin@example.com', ADMIN_PW = 'admin master password'
const VIEWER = 'viewer@example.com', VIEWER_PW = 'viewer master password'
const broker = new FakeBroker()
broker.addUser(OWNER, OWNER_PW, 'owner'); broker.addUser(ADMIN, ADMIN_PW, 'admin'); broker.addUser(VIEWER, VIEWER_PW, 'viewer')
const routeRig = rig()
let tokenStore: MemoryApiTokenStore
async function build(): Promise<FastifyInstance> {
  setBroker(broker)
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  const app = Fastify({ logger: false })
  await registerGate(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(apiTokenRoutes, { prefix: '/api/auth/tokens' })
  await app.register(buildSelfUpdateRoutes({ service: routeRig.svc, timer: false }), { prefix: '/api/self-update' })
  await app.ready()
  return app
}
const appP = build()
beforeEach(async () => { tokenStore = new MemoryApiTokenStore(); setApiTokenStore(tokenStore) })
after(async () => { if (isUnlocked()) await lock('manual'); setApiTokenStore(null); await (await appP).close() })

async function cookieFor(email: string, pw: string) {
  const r = await signIn(await appP, email, pw)
  assert.equal(r.res.statusCode, 200, r.res.body)
  return r.cookie
}

test('roles.ts: the summary is for any role; everything else admin; install and settings re-confirm', () => {
  assert.equal(requiredRole('GET', '/api/self-update/summary'), 'viewer')
  for (const p of ['/api/self-update/status', '/api/self-update/preview', '/api/self-update/job']) assert.equal(requiredRole('GET', p), 'admin')
  assert.equal(requiredRole('POST', '/api/self-update/install'), 'admin')
  assert.equal(needsReconfirm('POST', '/api/self-update/install'), true)
  assert.equal(needsReconfirm('PUT', '/api/self-update/settings'), true)
  assert.equal(needsReconfirm('POST', '/api/self-update/check'), false)
})

test('routes: a viewer sees the summary only; an admin must re-enter the master password; an API token never installs', async () => {
  const app = await appP
  await routeRig.svc.check()
  const viewer = await cookieFor(VIEWER, VIEWER_PW)
  assert.equal((await app.inject({ method: 'GET', url: '/api/self-update/summary', headers: { cookie: viewer } })).statusCode, 200)
  assert.equal((await app.inject({ method: 'GET', url: '/api/self-update/status', headers: { cookie: viewer } })).statusCode, 403)
  assert.equal((await app.inject({ method: 'POST', url: '/api/self-update/install', headers: { cookie: viewer }, payload: { sha: B } })).statusCode, 403)

  const admin = await cookieFor(ADMIN, ADMIN_PW)
  const status = await app.inject({ method: 'GET', url: '/api/self-update/status', headers: { cookie: admin } })
  assert.equal(status.statusCode, 200)
  assert.equal(status.json().check.available.sha, B)
  const noConfirm = await app.inject({ method: 'POST', url: '/api/self-update/install', headers: { cookie: admin }, payload: { sha: B } })
  assert.equal(noConfirm.statusCode, 403); assert.equal(noConfirm.json().code, 'reconfirm_required')
  const noConfirmSettings = await app.inject({ method: 'PUT', url: '/api/self-update/settings', headers: { cookie: admin }, payload: { notify: true } })
  assert.equal(noConfirmSettings.statusCode, 403)

  const token = (await createApiToken({ name: 'automation', role: 'admin' }, OWNER, tokenStore)).token
  const t = await app.inject({ method: 'POST', url: '/api/self-update/install', headers: { authorization: `Bearer ${token}` }, payload: { sha: B } })
  assert.equal(t.statusCode, 403); assert.equal(t.json().code, 'token_forbidden')
  const ts = await app.inject({ method: 'PUT', url: '/api/self-update/settings', headers: { authorization: `Bearer ${token}` }, payload: { notify: true } })
  assert.equal(ts.statusCode, 403)
  assert.equal(routeRig.launched.length, 0, 'nothing started yet')

  const rc = await app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie: admin }, payload: { password: ADMIN_PW } })
  assert.equal(rc.statusCode, 200, rc.body)
  const bad = await app.inject({ method: 'POST', url: '/api/self-update/install', headers: { cookie: admin }, payload: { sha: 'HEAD; rm -rf /' } })
  assert.equal(bad.statusCode, 400)
  const go = await app.inject({ method: 'POST', url: '/api/self-update/install', headers: { cookie: admin }, payload: { sha: B } })
  assert.equal(go.statusCode, 202, go.body)
  assert.equal(routeRig.launched.length, 1)
  assert.equal(routeRig.launched[0].by, ADMIN)
  const again = await app.inject({ method: 'POST', url: '/api/self-update/install', headers: { cookie: admin }, payload: { sha: B } })
  assert.equal(again.statusCode, 409)
  assert.ok(again.json().refusals.some((x: any) => x.code === 'update_running'))
  const job = await app.inject({ method: 'GET', url: '/api/self-update/job', headers: { cookie: admin } })
  assert.equal(job.json().job.status, 'running')
  const sum = await app.inject({ method: 'GET', url: '/api/self-update/summary', headers: { cookie: viewer } })
  assert.equal(sum.json().updating, true)
  const settings = await app.inject({ method: 'PUT', url: '/api/self-update/settings', headers: { cookie: admin }, payload: { repoUrl: 'https://evil.example/x.git' } })
  assert.equal(settings.statusCode, 400, 'the upstream is not a setting a page can change')
})
