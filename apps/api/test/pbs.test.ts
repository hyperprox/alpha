// Proxmox Backup Server: the client's reads from fixtures, stale-group detection, the health reason, the
// instance store, the role / re-confirm / token guards on "verify now" (the only action), the read-back of the task,
// refusing a changed certificate before the token is sent, and the cluster cross-check. Nothing real is contacted.
//
// Fixtures (test/fixtures/pbs) are built by hand in the shape PBS 4 answers; every name in them is made up.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { X509Certificate } from 'node:crypto'
import { PbsClient, UPID_RE, type PbsApi } from '../src/lib/pbs/client'
import { buildReading, groupsFromSnapshots, healthOf, dedupOf, type PbsReading } from '../src/lib/pbs/parse'
import { PbsTransport, PbsHttpError, PbsUnreachableError } from '../src/lib/pbs/transport'
import { PbsInstanceStore, cleanUrl, PbsInputError, type CredentialIO } from '../src/lib/pbs/instances'
import { PbsService, PbsRefusal, refusalWords, GRANTED_ROLES, VERIFY_ROLE, type Actor } from '../src/lib/pbs/service'
import { matchingStorages, guestsWithoutGroup, coverageFor } from '../src/lib/pbs/coverage'
import { pbsSummary, pbsAnswer } from '../src/lib/pbs/ai-source'
import { tileOf } from '../src/plugins/pbs'
import { detailOf } from '../src/lib/pbs'
import { normaliseFingerprint, probeCertificate } from '../src/lib/clusters/tls-pin'
import { requiredRole, needsReconfirm } from '../src/lib/roles'

const NOW = new Date(1_800_000_000 * 1000)
const FIX = path.join(__dirname, 'fixtures', 'pbs')
const fx = (name: string) => JSON.parse(fs.readFileSync(path.join(FIX, `${name}.json`), 'utf8'))

/** A fake PBS API answering from the fixtures, recording every call. */
function fakeApi(over: Record<string, (params?: any) => any> = {}): PbsApi & { calls: string[] } {
  const calls: string[] = []
  const routes: Record<string, (params?: any) => any> = {
    'GET /version': () => fx('version'),
    'GET /status/datastore-usage': () => fx('datastore-usage'),
    'GET /admin/gc': () => fx('gc'),
    'GET /admin/prune': () => fx('prune'),
    'GET /admin/verify': () => fx('verify'),
    'GET /admin/sync': () => { throw new PbsHttpError(403, 'permission check failed') },
    'GET /admin/datastore/tank/status': () => fx('status-tank'),
    'GET /admin/datastore/offsite/status': () => fx('status-offsite'),
    'GET /admin/datastore/tank/namespace': () => fx('namespace-tank'),
    'GET /admin/datastore/offsite/namespace': () => fx('namespace-offsite'),
    'GET /admin/datastore/tank/snapshots': p => fx(`snapshots-tank-${p?.ns ?? ''}`),
    'GET /admin/datastore/offsite/snapshots': p => fx(`snapshots-offsite-${p?.ns ?? ''}`),
    'GET /nodes/localhost/tasks': p => { assert.equal(p.errors, true); assert.equal(p.since, 1_800_000_000 - 86400); return fx('tasks-errors') },
    ...over,
  }
  return {
    calls,
    async call(method, p, params) {
      calls.push(`${method} ${p}`)
      const r = routes[`${method} ${p}`]
      if (!r) throw new PbsHttpError(404, `no route ${p}`)
      return r(params)
    },
  }
}

const read = (api = fakeApi(), stale = 26) => new PbsClient(api).read(NOW, stale)

// ── client parsing ───────────────────────────────────────────────────────────

test('client: datastores, dedup, GC and counts from the fixtures', async () => {
  const r = await read()
  assert.equal(r.version, '4.2.0')
  assert.deepEqual(r.datastores.map(d => d.store), ['offsite', 'tank'])
  const tank = r.datastores.find(d => d.store === 'tank')!
  assert.equal(tank.usedFrac, 0.91)
  assert.equal(tank.dedup, 4)
  assert.equal(tank.gc.lastState, 'ok')
  assert.equal(tank.gc.schedule, 'sat 06:00')
  assert.equal(tank.groups, 3)
  assert.equal(tank.snapshots, 8)
  const off = r.datastores.find(d => d.store === 'offsite')!
  assert.equal(off.dedup, null, 'no GC has run there, so there is no factor to show')
  assert.equal(off.estimatedFull, null, '0 means never in PBS')
  // The sync list was refused (it needs Remote.Audit as well): reported, not fatal.
  assert.deepEqual(r.missing, ['sync jobs (the token may not read it)'])
  assert.equal(dedupOf({ 'index-data-bytes': 10, 'disk-bytes': 0 }), null)
})

test('client: groups per datastore and namespace, with count, newest, size and verify state', async () => {
  const r = await read()
  const g = (store: string, ns: string, id: string) => r.groups.find(x => x.store === store && x.ns === ns && `${x.type}/${x.id}` === id)!
  const ct = g('tank', '', 'ct/101')
  assert.deepEqual({ count: ct.count, age: ct.ageHours, verify: ct.verify, stale: ct.stale, size: ct.size }, { count: 3, age: 5, verify: 'ok', stale: false, size: 2 * 2 ** 30 })
  const vm = g('tank', '', 'vm/200')
  assert.deepEqual({ count: vm.count, age: vm.ageHours, verify: vm.verify, failed: vm.failedVerifies, stale: vm.stale }, { count: 3, age: 40, verify: 'failed', failed: 1, stale: true })
  assert.equal(g('tank', 'lab', 'ct/150').stale, true)
  assert.equal(g('offsite', '', 'vm/200').stale, false)
  assert.equal(r.groups.length, 4)
})

test('client: jobs with last run, next run and result; failed tasks of the last 24 h only, warnings excluded', async () => {
  const r = await read()
  const byKind = Object.fromEntries(r.jobs.map(j => [`${j.kind}:${j.id}`, j]))
  assert.equal(byKind['gc:gc-tank'].result, 'ok')
  assert.equal(byKind['prune:daily-tank'].result, 'ok')
  assert.equal(byKind['prune:daily-tank'].next, 1_800_000_000 + 3 * 3600)
  assert.equal(byKind['verify:weekly-verify'].result, 'failed')
  assert.match(byKind['verify:weekly-verify'].detail!, /verification failed/)
  assert.deepEqual(r.failedTasks.map(t => [t.type, t.target, t.status]), [['backup', 'tank:ct/101', 'backup failed: connection reset']])
})

test('client: a refused first call means the server is not readable, and throws', async () => {
  const api = fakeApi({ 'GET /version': () => { throw new PbsHttpError(401, 'authentication failed') } })
  await assert.rejects(read(api), (e: any) => e instanceof PbsHttpError && e.status === 401)
  assert.match(refusalWords(new PbsHttpError(401, '')), /Audit role on \//)
})

// ── stale groups and the health reason ───────────────────────────────────────

test('stale detection follows the threshold, and only the newest snapshot counts', () => {
  const snaps = fx('snapshots-tank-')
  const at = 1_800_000_000
  const by = (h: number) => Object.fromEntries(groupsFromSnapshots('tank', '', snaps, at, h).map(g => [`${g.type}/${g.id}`, g.stale]))
  assert.deepEqual(by(26), { 'ct/101': false, 'vm/200': true })
  assert.deepEqual(by(48), { 'ct/101': false, 'vm/200': false })
  assert.deepEqual(by(4), { 'ct/101': true, 'vm/200': true })
  // A group with snapshots exactly at the threshold is not stale yet.
  assert.equal(groupsFromSnapshots('s', '', [{ 'backup-type': 'vm', 'backup-id': '9', 'backup-time': at - 26 * 3600 }], at, 26)[0].stale, false)
})

test('health: the reason names what is wrong, in a few words', async () => {
  const r = await read()
  assert.equal(r.health.state, 'attention')
  assert.deepEqual(r.health.reasons, ['datastore tank 91% full', '2 guests not backed up in 26 h', 'verify failed', '1 failed task in 24 h'])
  assert.equal(r.health.reason, 'datastore tank 91% full, 2 guests not backed up in 26 h +2')

  // One datastore: no name needed. A host backup is a "backup group", not a guest.
  const one = healthOf({ staleHours: 26, jobs: [], failedTasks: [],
    datastores: [{ store: 'x', usedFrac: 0.912 } as any],
    groups: [{ type: 'host', stale: true, verify: 'ok' } as any] })
  assert.deepEqual(one.reasons, ['datastore 91% full', '1 backup group not backed up in 26 h'])

  const good = healthOf({ staleHours: 26, jobs: [{ kind: 'gc', result: 'ok' } as any], failedTasks: [], datastores: [{ store: 'x', usedFrac: 0.5 } as any], groups: [{ type: 'vm', stale: false, verify: 'ok' } as any] })
  assert.deepEqual(good, { state: 'active', reason: null, reasons: [] })

  const gcBad = healthOf({ staleHours: 26, jobs: [{ kind: 'gc', result: 'failed' } as any], failedTasks: [], datastores: [], groups: [] })
  assert.equal(gcBad.reason, 'GC failed')
})

test('plug-in card: Active when healthy, the reason as the headline otherwise (the dashboard chip shows it)', async () => {
  const r = await read()
  const t = tileOf([{ id: 'p00000001', name: 'backups', reading: r, error: null }])
  assert.equal(t.tone, 'bad')
  assert.equal(t.headline, r.health.reason)
  const fine = buildReading({ version: { version: '4.2' }, usage: [{ store: 'a', total: 100, used: 10 }], snapshots: {} }, NOW)
  const t2 = tileOf([{ id: 'p00000001', name: 'backups', reading: fine, error: null }])
  assert.equal(t2.tone, 'good')
  assert.equal(t2.headline, 'all backups fresh')
  assert.throws(() => tileOf([]), /Not configured yet/)
  const d = detailOf('backups', r)
  assert.deepEqual(d.tables.map(x => x.title), ['Datastores', 'Backup groups', 'Jobs', 'Failed tasks (24 h)'])
})

test('assistant: answers stale, full and job questions from the reading, with no address', async () => {
  const r = await read()
  const s = pbsSummary([{ name: 'backups', reading: r, error: null }])
  assert.match(s.headline, /1 needs attention/)
  assert.match(pbsAnswer('which backups are stale?', s)!, /vm\/200 last 40 h ago/)
  assert.match(pbsAnswer('how full is the datastore', s)!, /tank: 91% used/)
  assert.match(pbsAnswer('did the verify job run', s)!, /verify weekly-verify on tank FAILED/)
  assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(s.lines.join(' ')))
})

// ── instances ────────────────────────────────────────────────────────────────

function memIO(): CredentialIO & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    async get(c, p, k) { return data.get(`${c}/${p}/${k}`) ?? null },
    async set(c, p, k, v) { data.set(`${c}/${p}/${k}`, v) },
    async remove(c, p) { for (const k of [...data.keys()]) if (k.startsWith(`${c}/${p}/`)) data.delete(k) },
  }
}

test('instances: https only, PBS port by default, and a moved address needs the secret again', async () => {
  assert.equal(cleanUrl('backup.example.lan'), 'https://backup.example.lan:8007')
  assert.equal(cleanUrl('https://10.9.8.7:8007/'), 'https://10.9.8.7:8007')
  assert.throws(() => cleanUrl('http://10.9.8.7:8007'), PbsInputError)
  assert.throws(() => cleanUrl('https://10.9.8.7:8007/api2'), PbsInputError)
  const io = memIO()
  const store = new PbsInstanceStore(io)
  const pin = { fingerprint: normaliseFingerprint('ab'.repeat(32))!, source: 'first-use' as const, at: NOW.toISOString() }
  const m = await store.create({ name: 'Backups', url: 'https://10.9.8.7:8007', tokenId: 'hyperprox@pbs!readonly', secret: '00000000-1111-2222-3333-444444444444', staleHours: 26, pin })
  assert.equal(io.data.get(`plugin/pbs/instances`)!.includes('secret'), false, 'the index holds no token')
  await assert.rejects(store.planUpdate(m.id, { url: 'https://10.9.8.8:8007' }), /paste the token secret again/)
  const ok = await store.planUpdate(m.id, { staleHours: 30 })
  assert.deepEqual([ok.moved, ok.credentialChanged, ok.staleHours], [false, false, 30])
})

// ── the actions and their guards ─────────────────────────────────────────────

const admin: Actor = { sid: 's-admin', email: 'admin@example.com', role: 'admin', token: null }
const operator: Actor = { sid: 's-op', email: 'op@example.com', role: 'operator', token: null }
const tokenActor: Actor = { sid: 's-tok', email: 'admin@example.com', role: 'admin', token: 'ci' }
const UPID = 'UPID:backup-01:00001000:00002000:00000004:6B4A0200:verificationjob:tank:hyperprox@pbs!admin:'

async function serviceWith(api: PbsApi) {
  const audit: Array<{ action: string; details: any }> = []
  const store = new PbsInstanceStore(memIO())
  const svc = new PbsService({
    store, audit: async (action, _r, details) => { audit.push({ action, details }) },
    probe: async () => ({ fingerprint: normaliseFingerprint('cd'.repeat(32))!, caVerified: false }),
    api: () => api, now: () => NOW.getTime(), wait: async () => {},
  })
  const m = await svc.add({ name: 'backups', url: 'https://10.9.8.7:8007', tokenId: 'hyperprox@pbs!admin', secret: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', confirmFingerprint: normaliseFingerprint('cd'.repeat(32))! }, admin)
  return { svc, audit, m }
}

test('gate: verify now is admin and needs the master password re-entered; reads do not', () => {
  const p = '/api/plugins/pbs/instances/p0a1b2c3d/actions/verify'
  assert.equal(requiredRole('POST', p), 'admin')
  assert.equal(needsReconfirm('POST', p), true)
  assert.equal(needsReconfirm('POST', '/api/plugins/pbs/instances'), true, 'adding stores a token')
  assert.equal(needsReconfirm('DELETE', '/api/plugins/pbs/instances/p0a1b2c3d'), true)
  assert.equal(requiredRole('GET', '/api/plugins/pbs/instances/p0a1b2c3d/reading'), 'viewer')
  assert.equal(needsReconfirm('GET', '/api/plugins/pbs/instances/p0a1b2c3d/reading'), false)
})

test('actions: an API token and a non-admin are refused and audited; nothing reaches the server', async () => {
  const api = fakeApi({ 'POST /admin/datastore/tank/verify': () => UPID })
  const { svc, audit, m } = await serviceWith(api)
  await assert.rejects(svc.act(m.id, 'verify', { store: 'tank' }, tokenActor), (e: any) => e instanceof PbsRefusal && e.code === 'token_forbidden')
  await assert.rejects(svc.act(m.id, 'verify', { store: 'tank' }, operator), (e: any) => e instanceof PbsRefusal && e.code === 'forbidden')
  assert.ok(!api.calls.some(c => c.startsWith('POST')), 'no action was sent')
  assert.deepEqual(audit.filter(a => a.action === 'pbs.action').map(a => a.details.result), ['refused:token_forbidden', 'refused:forbidden'])
  // GC, prune, forget and delete are not actions at all, even for an admin.
  for (const a of ['gc', 'prune', 'forget', 'delete']) await assert.rejects(svc.act(m.id, a, { store: 'tank' }, admin), (e: any) => e.code === 'action_not_allowed', a)
  assert.ok(!api.calls.some(c => c.startsWith('POST')))
  await assert.rejects(svc.act(m.id, 'verify', { store: 'elsewhere' }, admin), (e: any) => e.code === 'bad_input' && e.status === 404)
})

test('actions: verify now starts the task and reads its status back; audited with the task id', async () => {
  const api = fakeApi({
    'POST /admin/datastore/tank/verify': () => UPID,
    [`GET /nodes/localhost/tasks/${encodeURIComponent(UPID)}/status`]: () => ({ status: 'running', upid: UPID }),
  })
  const { svc, audit, m } = await serviceWith(api)
  const r = await svc.act(m.id, 'verify', { store: 'tank' }, admin)
  assert.equal(r.state, 'running')
  assert.equal(r.upid, UPID)
  assert.ok(api.calls.indexOf(`GET /nodes/localhost/tasks/${encodeURIComponent(UPID)}/status`) > api.calls.indexOf('POST /admin/datastore/tank/verify'))
  const last = audit.at(-1)!
  assert.deepEqual([last.action, last.details.result, last.details.upid, last.details.store], ['pbs.action', 'done', UPID, 'tank'])
  assert.ok(UPID_RE.test(UPID))
})

test('actions: a verify refused by PBS says which privilege and role the token lacks', async () => {
  const api = fakeApi({ 'POST /admin/datastore/tank/verify': () => { throw new PbsHttpError(403, 'permission check failed') } })
  const { svc, audit, m } = await serviceWith(api)
  await assert.rejects(svc.act(m.id, 'verify', { store: 'tank' }, admin), (e: any) => e.code === 'pbs_permission' && /Datastore\.Verify on \/datastore\/tank/.test(e.message) && /DatastoreReader/.test(e.message) && !/DatastoreAdmin/.test(e.message))
  assert.equal(audit.at(-1)!.details.result, 'refused:pbs_permission')
})

// The roles as PBS 4.2 defines them (GET /access/roles), for the ones HyperProx grants.
const PBS_ROLES: Record<string, string[]> = {
  Audit: ['Sys.Audit', 'Datastore.Audit'],
  DatastoreReader: ['Datastore.Audit', 'Datastore.Read', 'Datastore.Verify'],
  DatastoreBackup: ['Datastore.Backup'],
}

test('by default no token HyperProx makes can prune, forget, delete or garbage-collect; only the opt-in manage module can', () => {
  for (const role of GRANTED_ROLES) {
    const privs = PBS_ROLES[role]
    assert.ok(privs, `${role} is a role checked here`)
    assert.ok(!privs.some(p => p === 'Datastore.Modify' || p === 'Datastore.Prune' || p === 'Datastore.Allocate' || p.startsWith('Sys.Modify') || p.startsWith('Permissions.')), role)
  }
  assert.ok(PBS_ROLES[VERIFY_ROLE].includes('Datastore.Verify'))
  // The client has only reads and verify: no GC, prune, forget or delete call exists.
  const proto = Object.getOwnPropertyNames(PbsClient.prototype)
  assert.deepEqual(proto.filter(n => n !== 'constructor').sort(), ['read', 'taskStatus', 'verify'])
  // Nothing in lib/pbs (plug-in and recipe) grants another role, or deletes anything but HyperProx's own token.
  const dir = path.join(__dirname, '..', 'src', 'lib', 'pbs')
  // manage.ts is the opt-in backup management (its own tests below): the only file allowed DatastoreAdmin and the
  // delete, prune and GC calls, all through the manage token.
  const manageSrc = fs.readFileSync(path.join(dir, 'manage.ts'), 'utf8')
  assert.match(manageSrc, /MANAGE_ROLE = 'DatastoreAdmin'/)
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.ts') && x !== 'manage.ts')) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8')
    for (const m of src.matchAll(/role:\s*'([A-Za-z]+)'/g)) assert.ok((GRANTED_ROLES as readonly string[]).includes(m[1]), `${f} grants ${m[1]}`)
    assert.ok(!/DatastoreAdmin|DatastorePowerUser|Datastore\.Modify'|\/gc`|\/prune`|'\/admin\/datastore\/[^']*\/(gc|prune)'/.test(src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), `${f} has no GC/prune call or admin role`)
    for (const m of src.matchAll(/call\('DELETE',\s*`([^`]*)`/g)) assert.match(m[1], /^\/access\/users\/\$\{enc\(U\)\}\/token\//, `${f}: the only delete is of HyperProx's own token`)
  }
})

test('add: a token that cannot read the server is never stored', async () => {
  const api = fakeApi({ 'GET /status/datastore-usage': () => { throw new PbsHttpError(403, 'no') } })
  const store = new PbsInstanceStore(memIO())
  const svc = new PbsService({ store, audit: async () => {}, probe: async () => ({ fingerprint: normaliseFingerprint('cd'.repeat(32))!, caVerified: false }), api: () => api })
  await assert.rejects(svc.add({ name: 'b', url: 'https://10.9.8.7', tokenId: 'a@pbs!b', secret: 'aaaaaaaa-bbbb', confirmFingerprint: normaliseFingerprint('cd'.repeat(32))! }, admin), (e: any) => e.code === 'connect_failed')
  assert.deepEqual(await store.list(), [])
})

// ── the certificate pin ──────────────────────────────────────────────────────

const haveOpenssl = spawnSync('openssl', ['version']).status === 0
const dir = mkdtempSync(path.join(tmpdir(), 'hpx-pbs-'))
function makeCert(name: string) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '30',
    '-subj', '/CN=pbs-test', '-keyout', path.join(dir, `${name}.key`), '-out', path.join(dir, `${name}.crt`)], { stdio: 'ignore' })
  return { key: readFileSync(path.join(dir, `${name}.key`)), cert: readFileSync(path.join(dir, `${name}.crt`)) }
}
let server: https.Server | undefined
let port = 0
let goodFp = '', otherFp = ''
const seen: Array<{ url: string; auth?: string }> = []

before(async () => {
  if (!haveOpenssl) return
  const a = makeCert('a'), b = makeCert('b')
  server = https.createServer(a, (req, res) => {
    seen.push({ url: req.url ?? '', auth: req.headers.authorization })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: { version: '4.2', release: '0' } }))
  })
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', r))
  port = (server.address() as any).port
  goodFp = (await probeCertificate('127.0.0.1', port)).fingerprint
  otherFp = normaliseFingerprint(new X509Certificate(b.cert).fingerprint256)!
})
after(() => { server?.close() })

test('transport: a changed certificate is refused before the token is sent', { skip: !haveOpenssl && 'openssl not installed' }, async () => {
  // The test server is on loopback, which the real address rules refuse; this resolver stands in for them.
  const resolve = async () => '127.0.0.1'
  const url = `https://127.0.0.1:${port}`
  seen.length = 0
  const good = new PbsTransport({ url, tokenId: 'hyperprox@pbs!readonly', secret: 'secret-good', pin: { fingerprint: goodFp, source: 'first-use', at: '' }, resolve })
  assert.deepEqual(await good.call('GET', '/version'), { version: '4.2', release: '0' })
  assert.equal(seen[0].url, '/api2/json/version')
  assert.equal(seen[0].auth, 'PBSAPIToken=hyperprox@pbs!readonly:secret-good')

  seen.length = 0
  const bad = new PbsTransport({ url, tokenId: 'hyperprox@pbs!readonly', secret: 'secret-bad', pin: { fingerprint: otherFp, source: 'first-use', at: '' }, resolve })
  await assert.rejects(bad.call('GET', '/version'), (e: any) => e instanceof PbsUnreachableError && e.code === 'cert_changed' && e.message.includes(goodFp))
  assert.equal(seen.length, 0, 'the server never received the request, so never saw the token')

  // A CA-verified pin keeps normal verification on: a self-signed certificate is then refused too.
  const ca = new PbsTransport({ url, tokenId: 'a@pbs!b', secret: 'x', pin: { fingerprint: goodFp, source: 'ca', at: '' }, resolve })
  await assert.rejects(ca.call('GET', '/version'), PbsUnreachableError)
  assert.equal(seen.length, 0)
})

test('transport: the default address rules refuse loopback, and plain http is never used', async () => {
  const t = new PbsTransport({ url: 'https://127.0.0.1:8007', tokenId: 'a@pbs!b', secret: 'x', pin: { fingerprint: normaliseFingerprint('ab'.repeat(32))!, source: 'first-use', at: '' } })
  await assert.rejects(t.call('GET', '/version'), (e: any) => e.code === 'bad_target')
  assert.throws(() => new PbsTransport({ url: 'http://10.0.0.1:8007', tokenId: 'a@pbs!b', secret: 'x', pin: null }), /https/)
})

// ── the cluster cross-check ──────────────────────────────────────────────────

test('cross-check: finds the PBS storage by fingerprint or address, and lists guests with no group', async () => {
  const fp = normaliseFingerprint('ef'.repeat(32))!
  const storages = [
    { storage: 'local', type: 'dir' },
    { storage: 'pbs-a', type: 'pbs', server: 'backup.example.lan', datastore: 'tank', fingerprint: 'ef'.repeat(32) },
    { storage: 'pbs-b', type: 'pbs', server: '10.9.8.7', datastore: 'tank', namespace: 'lab' },
    { storage: 'pbs-off', type: 'pbs', server: '10.9.8.7', datastore: 'tank', disable: 1 },
  ]
  assert.deepEqual(matchingStorages(storages, 'https://10.9.8.7:8007', fp).map(s => s.storage), ['pbs-a', 'pbs-b'])
  assert.deepEqual(matchingStorages(storages, 'https://10.9.8.7:8007', null).map(s => s.storage), ['pbs-b'])
  const r = await read()
  const guests = [{ vmid: 101, name: 'web', type: 'lxc' }, { vmid: 150, name: 'lab-ct', type: 'lxc' }, { vmid: 200, name: 'db', type: 'qemu' },
    { vmid: 300, name: 'new-vm', type: 'qemu' }, { vmid: 9000, name: 'tmpl', type: 'qemu', template: 1 }]
  assert.deepEqual(guestsWithoutGroup(guests, r.groups, [storages[1]]).map(g => g.vmid), [150, 300])
  assert.deepEqual(guestsWithoutGroup(guests, r.groups, [storages[1], storages[2]]).map(g => g.vmid), [300])

  const cov = await coverageFor('https://10.9.8.7:8007', fp, r.groups, {
    clusters: () => [{ id: 'home', name: 'Home' }, { id: 'c0000000001', name: 'Elsewhere' }],
    pve: async (id, p) => {
      if (id !== 'home') return p === '/storage' ? [] : []
      if (p === '/storage') return storages
      if (p.startsWith('/cluster/resources')) return guests
      if (p === '/cluster/backup-info/not-backed-up') return [{ vmid: 300, name: 'new-vm', type: 'qemu' }]
      throw new Error(p)
    },
  })
  assert.equal(cov.length, 1)
  assert.deepEqual(cov[0].noGroup.map(g => g.vmid), [300])
  assert.deepEqual(cov[0].notInJob!.map(g => g.vmid), [300])
})

// ── adding a server by signing in once ───────────────────────────────────────

const PASSWORD = 'correct-horse-battery-STAPLE-91'

/** A fake PBS admin API for the sign-in flow: users, tokens, ACLs and datastores, recording every call. */
function signinWorld() {
  const order: string[] = []
  const users: any[] = [{ userid: 'root@pam' }]
  const tokens: Record<string, string[]> = {}
  let acl: any[] = []
  const aclDeletes: string[] = []
  let n = 0
  const admin: PbsApi = {
    async call(method, p, params) {
      order.push(`${method} ${p}`)
      if (p === '/access/users' && method === 'GET') return users
      if (p === '/access/users' && method === 'POST') { users.push({ userid: params!.userid }); return null }
      const t = /^\/access\/users\/([^/]+)\/token(?:\/([^/]+))?$/.exec(p)
      if (t) {
        const u = decodeURIComponent(t[1])
        if (method === 'GET') return (tokens[u] ?? []).map(x => ({ tokenid: `${u}!${x}` }))
        if (method === 'DELETE') { tokens[u] = (tokens[u] ?? []).filter(x => x !== t[2]); acl = acl.filter(r => r.ugid !== `${u}!${t[2]}`); return null }
        if (method === 'POST') { (tokens[u] ??= []).push(t[2]!); return { tokenid: `${u}!${t[2]}`, value: `token-secret-${++n}` } }
      }
      if (p === '/access/acl' && method === 'PUT') {
        const id = params!['auth-id']
        if (params!.delete) { aclDeletes.push(`${params!.path} ${params!.role} ${id}`); acl = acl.filter(r => !(r.path === params!.path && r.roleid === params!.role && r.ugid === id)); return null }
        acl.push({ path: params!.path, roleid: params!.role, ugid: id, ugid_type: String(id).includes('!') ? 'token' : 'user' }); return null
      }
      if (p === '/access/acl') return acl
      if (p === '/admin/datastore') return [{ store: 'tank' }, { store: 'offsite' }]
      throw new PbsHttpError(404, p)
    },
  }
  const io = memIO()
  const audit: any[] = []
  const store = new PbsInstanceStore(io)
  const logins: Array<{ userid: string; pinned: boolean }> = []
  const cert = { fp: normaliseFingerprint('cd'.repeat(32))!, ca: false }
  const svc = new PbsService({
    store, audit: async (action, resource, details) => { audit.push({ action, resource, details }) },
    probe: async () => { order.push('probe'); return { fingerprint: cert.fp, caVerified: cert.ca } },
    login: async (_u, pin, userid, password) => {
      order.push('login')
      logins.push({ userid, pinned: !!pin?.fingerprint })
      if (password !== PASSWORD) throw new PbsHttpError(401, 'authentication failure')
      return admin
    },
    api: () => fakeApi(), now: () => NOW.getTime(), wait: async () => {},
  })
  return { svc, io, audit, order, acl: () => acl, aclDeletes, tokens, logins, store, cert }
}

const signin = (extra: Record<string, unknown> = {}) => ({ name: 'backups', url: 'https://10.9.8.7:8007', username: 'root', realm: 'pam', password: PASSWORD, confirmFingerprint: normaliseFingerprint('cd'.repeat(32))!, ...extra })

/** Everything printed while fn runs (console and stdout/stderr). */
async function captureOutput(fn: () => Promise<unknown>): Promise<string> {
  const out: string[] = []
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug, o: process.stdout.write, e: process.stderr.write }
  const grab = (...a: any[]) => { out.push(a.map(String).join(' ')) }
  Object.assign(console, { log: grab, info: grab, warn: grab, error: grab, debug: grab })
  process.stdout.write = ((c: any) => { out.push(String(c)); return true }) as any
  process.stderr.write = ((c: any) => { out.push(String(c)); return true }) as any
  try { await fn().catch(e => out.push(String(e?.message ?? e))) } finally {
    Object.assign(console, { log: saved.log, info: saved.info, warn: saved.warn, error: saved.error, debug: saved.debug })
    process.stdout.write = saved.o; process.stderr.write = saved.e
  }
  return out.join('\n')
}

test('sign-in: pins before the password is sent, makes hyperprox@pbs and its read-only token, keeps only the token', async () => {
  const w = signinWorld()
  const m = await w.svc.addWithLogin(signin(), admin)
  assert.ok(w.order.indexOf('probe') < w.order.indexOf('login'), 'the certificate is pinned before the password is sent')
  assert.deepEqual(w.logins, [{ userid: 'root@pam', pinned: true }])
  assert.deepEqual(w.acl().map(({ ugid_type: _t, ...r }) => r), [
    { path: '/', roleid: 'Audit', ugid: 'hyperprox@pbs' },
    { path: '/', roleid: 'Audit', ugid: 'hyperprox@pbs!readonly' },
  ], 'read-only: Audit on /, and no datastore role unless asked')
  const c = await w.store.connection(m.id)
  assert.deepEqual([c!.tokenId, c!.secret, c!.meta.pin?.source], ['hyperprox@pbs!readonly', 'token-secret-1', 'first-use'])
  assert.equal(m.allowVerify, false)
  assert.deepEqual(w.audit.map(a => [a.action, a.details.login, a.details.result]), [['pbs.instance.signin', 'root@pam', 'done']])
})

test('sign-in: the password never reaches the vault, the audit log or the logs, on success or failure', async () => {
  const w = signinWorld()
  const printed = await captureOutput(async () => {
    await w.svc.addWithLogin(signin(), admin)
    await w.svc.addWithLogin(signin({ password: `${PASSWORD}-wrong` }), { ...admin, sid: 's-2' }).catch(e => { assert.equal(e.code, 'signin_failed'); assert.ok(!e.message.includes(PASSWORD)); throw e })
  })
  const vault = JSON.stringify([...w.io.data.entries()])
  assert.ok(!vault.includes(PASSWORD), 'not in the vault')
  assert.ok(!JSON.stringify(w.audit).includes(PASSWORD), 'not in the audit log')
  assert.ok(!printed.includes(PASSWORD), 'not in the logs')
  assert.deepEqual(w.audit.map(a => a.details.result), ['done', 'failed:signin'])
})

test('sign-in: adding the same server again is idempotent and regenerates the token', async () => {
  const w = signinWorld()
  const a = await w.svc.addWithLogin(signin(), admin)
  const b = await w.svc.addWithLogin(signin({ name: 'other name' }), { ...admin, sid: 's-3' })
  assert.equal(b.id, a.id, 'the same instance, not a second one')
  assert.equal((await w.store.list()).length, 1)
  assert.deepEqual(w.tokens['hyperprox@pbs'], ['readonly'], 'one token, made again')
  assert.ok(w.order.includes('DELETE /access/users/hyperprox%40pbs/token/readonly'))
  assert.equal((await w.store.connection(a.id))!.secret, 'token-secret-2')
  assert.equal(w.audit.at(-1).details.result, 'done:token_replaced')
  assert.equal((await w.store.list())[0].name, 'backups', 'the existing entry keeps its name')
  // Before the old token went, its own ACL lines went, and only those: the user's line of the same role stays.
  assert.deepEqual(w.aclDeletes, ['/ Audit hyperprox@pbs!readonly'])
  assert.ok(w.acl().some(r => r.ugid === 'hyperprox@pbs' && r.ugid_type === 'user'))
})

test('sign-in: "Allow Verify now" grants DatastoreReader on the datastores only, never on /', async () => {
  const w = signinWorld()
  const m = await w.svc.addWithLogin(signin({ allowVerify: true }), admin)
  assert.equal(m.allowVerify, true)
  const roles = w.acl().filter(r => r.roleid !== 'Audit')
  assert.deepEqual(roles.map(r => `${r.path} ${r.roleid} ${r.ugid}`), [
    '/datastore/tank DatastoreReader hyperprox@pbs', '/datastore/tank DatastoreReader hyperprox@pbs!readonly',
    '/datastore/offsite DatastoreReader hyperprox@pbs', '/datastore/offsite DatastoreReader hyperprox@pbs!readonly',
  ])
  assert.ok(!w.acl().some(r => r.path === '/' && r.roleid !== 'Audit'))
  // Only when asked: a truthy string is not consent.
  const w2 = signinWorld()
  await w2.svc.addWithLogin(signin({ allowVerify: 'yes' }), admin)
  assert.ok(!w2.acl().some(r => r.roleid !== 'Audit'))
})

test('sign-in: rate-limited, admin only, never an API token; every refusal audited with no password', async () => {
  const w = signinWorld()
  await assert.rejects(w.svc.addWithLogin(signin(), tokenActor), (e: any) => e.code === 'token_forbidden')
  await assert.rejects(w.svc.addWithLogin(signin(), operator), (e: any) => e.code === 'forbidden')
  for (let i = 0; i < 3; i++) await w.svc.addWithLogin(signin({ password: 'wrong' }), admin).catch(() => {})
  await assert.rejects(w.svc.addWithLogin(signin(), admin), (e: any) => e.code === 'rate_limited')
  assert.deepEqual(w.audit.map(a => a.details.result), ['refused:token_forbidden', 'refused:forbidden', 'failed:signin', 'failed:signin', 'failed:signin', 'refused:rate_limited'])
  assert.ok(!w.order.includes('login') || w.logins.length === 3, 'the refused and rate-limited attempts never signed in')
  assert.equal(requiredRole('POST', '/api/plugins/pbs/instances/signin'), 'admin')
  assert.equal(needsReconfirm('POST', '/api/plugins/pbs/instances/signin'), true)
})

// ── backup management (opt-in) ───────────────────────────────────────────────

import { PbsManager, MANAGE_TOKEN_ID, PREVIEW_TTL_MS, runningGroups, keepFrom, createManageToken, removeManageToken } from '../src/lib/pbs/manage'

const T0 = 1_800_000_000
/** A small PBS: one datastore "tank", snapshots by group, protected flags, running tasks, ACLs and tokens; records who calls what. */
function manageWorld(o: { running?: string[]; sneaky?: boolean; failManageRead?: boolean; failTokenDelete?: boolean } = {}) {
  const calls: Array<{ token: string; method: string; path: string; params?: any }> = []
  let snaps = [
    { type: 'vm', id: '200', time: T0 - 3 * 86400, protected: false },
    { type: 'vm', id: '200', time: T0 - 2 * 86400, protected: true },
    { type: 'vm', id: '200', time: T0 - 1 * 86400, protected: false },
    { type: 'ct', id: '101', time: T0 - 86400, protected: false },
  ]
  let acl: any[] = []
  let tokens: string[] = []
  const pruneKeep = 1
  // PBS's prune per group: keep the newest `keep-last`, never a protected one.
  const prune = (g: { type: string; id: string }, keepLast: number) => {
    const list = snaps.filter(s => s.type === g.type && s.id === g.id).sort((a, b) => b.time - a.time)
    let kept = 0
    return list.map(s => { const keep = s.protected || kept++ < keepLast; return { 'backup-type': s.type, 'backup-id': s.id, 'backup-time': s.time, keep, protected: s.protected } })
  }
  const api = (token: string): PbsApi => ({
    async call(method, p, params) {
      calls.push({ token, method, path: p, params })
      if (p === '/status/datastore-usage') return [{ store: 'tank', total: 100, used: 10 }]
      if (p === '/admin/datastore') return [{ store: 'tank' }]
      if (p === '/admin/datastore/tank/status') { if (o.failManageRead && token === MANAGE_TOKEN_ID) throw new PbsHttpError(403, 'no'); return { total: 100, used: 10, avail: 90 } }
      if (p === '/admin/datastore/tank/snapshots' && method === 'GET') return snaps.filter(s => !params?.['backup-type'] || (s.type === params['backup-type'] && s.id === params['backup-id'])).map(s => ({ 'backup-type': s.type, 'backup-id': s.id, 'backup-time': s.time, protected: s.protected, size: 1024 }))
      if (p === '/admin/datastore/tank/snapshots' && method === 'DELETE') { snaps = snaps.filter(s => !(s.type === params!['backup-type'] && s.id === params!['backup-id'] && s.time === params!['backup-time'] && !s.protected)); return null }
      if (p === '/admin/datastore/tank/groups' && method === 'DELETE') { snaps = snaps.filter(s => !(s.type === params!['backup-type'] && s.id === params!['backup-id'])); return null }
      if (p === '/admin/prune') return [{ id: 'daily', store: 'tank', ns: '', 'keep-last': pruneKeep }]
      if (p === '/admin/datastore/tank/prune') {
        const res = prune({ type: params!['backup-type'], id: params!['backup-id'] }, params!['keep-last'])
        // A PBS that removes one more than its own dry-run said (a race): the newest kept, unprotected one.
        if (o.sneaky && !params!['dry-run']) { const x = res.find(r => r.keep && !r.protected); if (x) x.keep = false }
        if (!params!['dry-run']) snaps = snaps.filter(s => res.some(r => r['backup-time'] === s.time && r['backup-type'] === s.type && r.keep) || !(s.type === params!['backup-type'] && s.id === params!['backup-id']))
        return res
      }
      if (p === '/nodes/localhost/tasks') return (o.running ?? []).map(g => ({ worker_type: 'backup', worker_id: `tank:${g}`, starttime: T0 }))
      if (p === '/admin/datastore/tank/gc') return UPID
      if (p.startsWith('/nodes/localhost/tasks/')) return { status: 'running' }
      // admin session (sign-in) only:
      if (p === '/access/users' && method === 'GET') return [{ userid: 'hyperprox@pbs' }]
      if (p === '/access/users/hyperprox%40pbs/token' && method === 'GET') return tokens.map(t => ({ tokenid: `hyperprox@pbs!${t}` }))
      const tk = /^\/access\/users\/hyperprox%40pbs\/token\/([a-z]+)$/.exec(p)
      if (tk && method === 'POST') { tokens = [...tokens.filter(t => t !== tk[1]), tk[1]]; return { tokenid: `hyperprox@pbs!${tk[1]}`, value: `${tk[1]}-secret` } }
      if (tk && method === 'DELETE' && o.failTokenDelete) throw new PbsHttpError(500, 'busy')
      if (tk && method === 'DELETE') { tokens = tokens.filter(t => t !== tk[1]); acl = acl.filter(r => r.ugid !== `hyperprox@pbs!${tk[1]}`); return null }
      if (p === '/access/acl' && method === 'PUT') {
        if (params!.delete) acl = acl.filter(r => !(r.path === params!.path && r.roleid === params!.role && r.ugid === params!['auth-id']))
        else acl.push({ path: params!.path, roleid: params!.role, ugid: params!['auth-id'] })
        return null
      }
      if (p === '/access/acl') return acl
      throw new PbsHttpError(404, `${method} ${p}`)
    },
  })
  const io = memIO()
  const store = new PbsInstanceStore(io)
  const audit: any[] = []
  const now = { t: NOW.getTime() }
  const svc = new PbsService({
    store, audit: async (action, _r, details) => { audit.push({ action, details }) },
    probe: async () => ({ fingerprint: normaliseFingerprint('cd'.repeat(32))!, caVerified: false }),
    api: c => api(c.tokenId),
    login: async (_u, _p, _user, password) => { if (password !== PASSWORD) throw new PbsHttpError(401, 'no'); return api('admin-session') },
    now: () => now.t, wait: async () => {},
  })
  return { svc, io, store, audit, calls, now, acl: () => acl, tokens: () => tokens, snaps: () => snaps }
}

async function managed(o: { running?: string[] } = {}) {
  const w = manageWorld(o)
  const m = await w.svc.addWithLogin(signin({ manage: true }), admin)
  assert.equal(m.manage?.tokenId, MANAGE_TOKEN_ID, m.manageError)
  return { ...w, id: m.id }
}

test('manage: off by default; ticked, a second token with DatastoreAdmin on each datastore only, in its own vault item', async () => {
  const off = manageWorld()
  const plain = await off.svc.addWithLogin(signin(), admin)
  assert.equal(plain.manage, null)
  assert.equal(await off.store.manageConnection(plain.id), null)
  await assert.rejects(off.svc.manager.gc(plain.id, admin, 'tank'), (e: any) => e.code === 'manage_off')

  const w = await managed()
  assert.deepEqual(w.acl().filter(r => r.roleid === 'DatastoreAdmin').map(r => `${r.path} ${r.ugid}`), ['/datastore/tank hyperprox@pbs', '/datastore/tank hyperprox@pbs!manage'])
  assert.ok(!w.acl().some(r => r.path === '/' && r.roleid !== 'Audit'), 'never on /')
  assert.equal(w.io.data.get(`plugin/pbs.${w.id}.manage/token_secret`), 'manage-secret', 'a vault item of its own')
  assert.notEqual(w.io.data.get(`plugin/pbs.${w.id}/token_secret`), 'manage-secret', 'the read-only token is a different secret')
})

test('manage: the manage token is used only by the delete, prune and clean-up calls; every read uses the read-only token', async () => {
  const w = await managed()
  w.calls.length = 0
  await w.svc.reading(w.id, { fresh: true }).catch(() => {})
  await w.svc.groupSnapshots(w.id, { store: 'tank', ns: '', type: 'vm', id: '200' }, admin)
  const p = await w.svc.manager.preview(w.id, admin, { action: 'delete-snapshots', store: 'tank', items: [{ type: 'ct', id: '101', time: T0 - 86400 }] })
  await w.svc.manager.apply(w.id, admin, p.id, ['last-snapshot'])
  const pr = await w.svc.manager.preview(w.id, admin, { action: 'prune', store: 'tank' })
  await w.svc.manager.apply(w.id, admin, pr.id, [])
  await w.svc.manager.gc(w.id, admin, 'tank')
  const byManage = w.calls.filter(c => c.token === MANAGE_TOKEN_ID)
  assert.ok(byManage.length > 0)
  for (const c of byManage) {
    assert.ok((c.method === 'DELETE' && /^\/admin\/datastore\/tank\/(snapshots|groups)$/.test(c.path)) || (c.method === 'POST' && /^\/admin\/datastore\/tank\/(prune|gc)$/.test(c.path)) || (c.method === 'GET' && c.path === '/admin/datastore/tank/status'),
      `manage token used for ${c.method} ${c.path}`)
  }
  for (const c of w.calls.filter(c => c.method === 'GET' && c.path !== '/admin/datastore/tank/status')) assert.equal(c.token, 'hyperprox@pbs!readonly', `${c.path} is a read`)
})

test('manage: protected snapshots are never deleted and show as kept', async () => {
  const w = await managed()
  const g = await w.svc.manager.preview(w.id, admin, { action: 'delete-group', store: 'tank', group: { type: 'vm', id: '200' } })
  assert.deepEqual(g.remove.map(s => s.time), [T0 - 3 * 86400, T0 - 86400])
  assert.deepEqual(g.kept.map(s => [s.time, s.why]), [[T0 - 2 * 86400, 'protected']])
  assert.deepEqual(g.acks, [], 'a protected snapshot stays, so this is not the last one')
  const r = await w.svc.manager.apply(w.id, admin, g.id, [])
  assert.equal(r.removed.length, 2)
  assert.deepEqual(w.snaps().filter(s => s.type === 'vm').map(s => s.time), [T0 - 2 * 86400])
  // Picking a protected snapshot by hand: kept, never sent.
  const p = await w.svc.manager.preview(w.id, admin, { action: 'delete-snapshots', store: 'tank', items: [{ type: 'vm', id: '200', time: T0 - 2 * 86400 }] })
  assert.deepEqual([p.remove.length, p.kept[0].why], [0, 'protected'])
  assert.ok(!w.calls.some(c => c.method === 'DELETE' && c.params?.['backup-time'] === T0 - 2 * 86400))
})

test('manage: removing a guest\'s last snapshot needs the second confirmation', async () => {
  const w = await managed()
  const p = await w.svc.manager.preview(w.id, admin, { action: 'delete-snapshots', store: 'tank', items: [{ type: 'ct', id: '101', time: T0 - 86400 }] })
  assert.deepEqual([p.lastSnapshot, p.acks], [['ct/101'], ['last-snapshot']])
  assert.match(p.warnings.join(' '), /last remaining snapshot of ct\/101/)
  await assert.rejects(w.svc.manager.apply(w.id, admin, p.id, []), (e: any) => e.code === 'confirm')
  assert.equal(w.snaps().filter(s => s.type === 'ct').length, 1, 'nothing removed without it')
  const again = await w.svc.manager.preview(w.id, admin, { action: 'delete-snapshots', store: 'tank', items: [{ type: 'ct', id: '101', time: T0 - 86400 }] })
  await w.svc.manager.apply(w.id, admin, again.id, ['last-snapshot'])
  assert.equal(w.snaps().filter(s => s.type === 'ct').length, 0)
})

test('manage: the prune preview is PBS\'s dry-run, and the execution removes exactly that', async () => {
  const w = await managed()
  const p = await w.svc.manager.preview(w.id, admin, { action: 'prune', store: 'tank' })
  assert.equal(p.keep!.from, 'prune job daily')
  assert.deepEqual(p.keep!.settings, { 'keep-last': 1 })
  assert.ok(w.calls.filter(c => c.path === '/admin/datastore/tank/prune').every(c => c.params['dry-run'] === true), 'the preview only dry-runs')
  assert.deepEqual(p.remove.map(s => `${s.type}/${s.id}/${s.time}`), [`vm/200/${T0 - 3 * 86400}`])
  assert.deepEqual(p.kept.map(s => s.why).sort(), ['kept', 'kept', 'protected'])
  const before = w.snaps().map(s => `${s.type}/${s.id}/${s.time}`)
  const r = await w.svc.manager.apply(w.id, admin, p.id, [])
  assert.deepEqual(r.removed, p.remove.map(s => `${s.type}/${s.id}/${s.time}`))
  assert.deepEqual(before.filter(k => !w.snaps().some(s => `${s.type}/${s.id}/${s.time}` === k)), r.removed, 'exactly what the preview listed')
})

test('manage: a prune whose result changed since the preview removes nothing', async () => {
  const w = await managed()
  const p = await w.svc.manager.preview(w.id, admin, { action: 'prune', store: 'tank' })
  w.snaps().push({ type: 'vm', id: '200', time: T0, protected: false })
  const n = w.snaps().length
  await assert.rejects(w.svc.manager.apply(w.id, admin, p.id, []), (e: any) => e.code === 'changed')
  assert.equal(w.snaps().length, n)
})

test('manage: guards: admin only, never an API token, a running backup blocks, previews are single-use, per user, 10 minutes', async () => {
  const w = await managed()
  for (const a of [tokenActor, operator]) {
    await assert.rejects(w.svc.manager.preview(w.id, a, { action: 'prune', store: 'tank' }), (e: any) => e.code === (a.token ? 'token_forbidden' : 'forbidden'))
    await assert.rejects(w.svc.manager.gc(w.id, a, 'tank'), (e: any) => e.code === (a.token ? 'token_forbidden' : 'forbidden'))
    await assert.rejects(w.svc.manager.disable(w.id, a, {}), (e: any) => e.code === (a.token ? 'token_forbidden' : 'forbidden'))
  }
  const p = await w.svc.manager.preview(w.id, admin, { action: 'delete-group', store: 'tank', group: { type: 'vm', id: '200' } })
  await assert.rejects(w.svc.manager.apply(w.id, { ...admin, email: 'other@example.com' }, p.id, []), (e: any) => e.code === 'not_found', 'another admin cannot apply it')
  await w.svc.manager.apply(w.id, admin, p.id, [])
  await assert.rejects(w.svc.manager.apply(w.id, admin, p.id, []), (e: any) => e.code === 'used')
  const q = await w.svc.manager.preview(w.id, admin, { action: 'prune', store: 'tank' })
  w.now.t += PREVIEW_TTL_MS + 1
  await assert.rejects(w.svc.manager.apply(w.id, admin, q.id, []), (e: any) => e.code === 'expired')
  const busy = await managed({ running: ['ct/101'] })
  await assert.rejects(busy.svc.manager.preview(busy.id, admin, { action: 'delete-snapshots', store: 'tank', items: [{ type: 'ct', id: '101', time: T0 - 86400 }] }), (e: any) => e.code === 'backup_running')
  assert.deepEqual([...runningGroups([{ worker_type: 'backup', worker_id: 'tank\\x3alab\\x3avm\\x2f100' }, { worker_type: 'backup', worker_id: 'other:vm/1' }, { worker_type: 'verify', worker_id: 'tank:vm/2' }], 'tank')], ['vm/100'])
  for (const path of ['/api/plugins/pbs/instances/p0a1b2c3d/manage', '/api/plugins/pbs/instances/p0a1b2c3d/manage/preview', '/api/plugins/pbs/instances/p0a1b2c3d/manage/apply', '/api/plugins/pbs/instances/p0a1b2c3d/manage/gc']) {
    for (const m of path.endsWith('/manage') ? ['PUT'] : ['POST']) { assert.equal(requiredRole(m, path), 'admin', path); assert.equal(needsReconfirm(m, path), true, path) }
  }
  assert.deepEqual(keepFrom({ 'keep-last': 3, 'keep-daily': '7', 'keep-weekly': 0, other: 1 }), { 'keep-last': 3, 'keep-daily': 7 })
  assert.equal(audit_has(w.audit, 'removed'), 2, 'audited per item')
})

const audit_has = (a: any[], result: string) => a.filter(x => x.action === 'pbs.manage' && x.details.result === result).length

test('manage: turning it off deletes the manage token and its permissions on the server, then the vault item', async () => {
  const w = await managed()
  await assert.rejects(w.store.remove(w.id), /Turn it off first/)
  await assert.rejects(w.svc.manager.disable(w.id, admin, { username: 'root', password: 'wrong' }), (e: any) => e.code === 'signin_failed')
  assert.ok(w.tokens().includes('manage'), 'a failed sign-in changes nothing')
  const m = await w.svc.manager.disable(w.id, admin, { username: 'root', realm: 'pam', password: PASSWORD })
  assert.equal(m.manage, null)
  assert.deepEqual(w.tokens(), ['readonly'])
  assert.ok(!w.acl().some(r => r.roleid === 'DatastoreAdmin'))
  assert.ok(w.acl().some(r => r.ugid === 'hyperprox@pbs!readonly' && r.roleid === 'Audit'), 'the read-only token is untouched')
  assert.equal(w.io.data.get(`plugin/pbs.${w.id}.manage/token_secret`), undefined)
  await assert.rejects(w.svc.manager.gc(w.id, admin, 'tank'), (e: any) => e.code === 'manage_off')
  assert.ok(!JSON.stringify(w.audit).includes(PASSWORD))
  await w.store.remove(w.id)
})

// ── review fixes ─────────────────────────────────────────────────────────────

import { fstabEditScript, unmountScript as unmountScriptFor, fstabLine as fstabLineFor, cleanNfsSource as nfsSource } from '../src/lib/pbs/nfs'
import { pbsMountCleanup } from '../src/lib/pbs/setup-deps'

test('pin: a first sign-in needs the presented fingerprint confirmed before the password is sent', async () => {
  const w = signinWorld()
  await assert.rejects(w.svc.addWithLogin(signin({ confirmFingerprint: undefined }), admin), (e: any) => e.code === 'confirm_fingerprint' && e.extra.presented === w.cert.fp)
  await assert.rejects(w.svc.addWithLogin(signin({ confirmFingerprint: 'ab'.repeat(32) }), { ...admin, sid: 's-x' }), (e: any) => e.code === 'confirm_fingerprint')
  assert.deepEqual(w.logins, [], 'the password was never sent')
  // A certificate that verifies against the public CAs needs no manual confirmation.
  w.cert.ca = true
  const m = await w.svc.addWithLogin(signin({ confirmFingerprint: undefined }), { ...admin, sid: 's-y' })
  assert.equal(m.pin?.source, 'ca')
  // The token way in too.
  const t = signinWorld()
  const svc = new PbsService({ store: t.store, audit: async () => {}, probe: async () => ({ fingerprint: t.cert.fp, caVerified: false }), api: () => fakeApi() })
  await assert.rejects(svc.add({ name: 'b', url: 'https://10.9.8.9', tokenId: 'a@pbs!b', secret: 'aaaaaaaa-bbbb' }, admin), (e: any) => e.code === 'confirm_fingerprint')
})

test('pin: re-adding keeps the pin; a changed certificate is refused before the password, unless re-pinned after being shown', async () => {
  const w = signinWorld()
  const a = await w.svc.addWithLogin(signin(), admin)
  await w.svc.addWithLogin(signin({ confirmFingerprint: undefined }), { ...admin, sid: 's-2' })
  assert.equal(w.logins.length, 2, 'the same certificate: no confirmation needed again')
  // Someone in the middle presents another certificate.
  w.cert.fp = normaliseFingerprint('ee'.repeat(32))!
  await assert.rejects(w.svc.addWithLogin(signin(), { ...admin, sid: 's-3' }), (e: any) => e.code === 'cert_changed' && e.extra.presented === w.cert.fp && e.extra.pinned === normaliseFingerprint('cd'.repeat(32)))
  await assert.rejects(w.svc.addWithLogin(signin({ repin: true }), { ...admin, sid: 's-4' }), (e: any) => e.code === 'cert_changed', 'repin without confirming the new one')
  assert.equal(w.logins.length, 2, 'the password never reached the other certificate')
  assert.equal((await w.store.get(a.id))!.pin!.fingerprint, normaliseFingerprint('cd'.repeat(32)), 'the pin was not replaced')
  // The admin was shown it, compared it, and re-pins on purpose.
  const b = await w.svc.addWithLogin(signin({ repin: true, confirmFingerprint: w.cert.fp }), { ...admin, sid: 's-5' })
  assert.equal(b.pin!.fingerprint, w.cert.fp)
})

test('pin: changing a token keeps the pin and refuses a changed certificate', async () => {
  const api = fakeApi()
  let fp = normaliseFingerprint('cd'.repeat(32))!
  const store = new PbsInstanceStore(memIO())
  const svc = new PbsService({ store, audit: async () => {}, probe: async () => ({ fingerprint: fp, caVerified: false }), api: () => api })
  const m = await svc.add({ name: 'b', url: 'https://10.9.8.7', tokenId: 'a@pbs!b', secret: 'aaaaaaaa-bbbb', confirmFingerprint: fp }, admin)
  fp = normaliseFingerprint('ee'.repeat(32))!
  await assert.rejects(svc.update(m.id, { secret: 'cccccccc-dddd' }, admin), (e: any) => e.code === 'cert_changed')
  await assert.rejects(svc.update(m.id, { repin: true }, admin), (e: any) => e.code === 'cert_changed')
  const r = await svc.update(m.id, { repin: true, confirmFingerprint: fp }, admin)
  assert.equal(r.meta.pin!.fingerprint, fp)
})

test('fstab: the marker is anchored (CT 100 never matches 1000), the edit is atomic, and an unreadable fstab is fatal', { skip: spawnSync('bash', ['-c', 'true']).status !== 0 && 'no bash' }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hpx-fstab-'))
  const fstab = path.join(dir, 'fstab')
  const src = nfsSource('10.20.30.40', '/Backups')
  const l100 = fstabLineFor(src, 100), l1000 = fstabLineFor(src, 1000)
  fs.writeFileSync(fstab, `UUID=abc / ext4 defaults 0 1\n${l1000}\n${l100}\n`)
  fs.chmodSync(fstab, 0o640)
  const run = (script: string) => spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  // Remove CT 100's line: CT 1000's stays.
  assert.equal(run(fstabEditScript(100, null, fstab)).status, 0)
  assert.equal(fs.readFileSync(fstab, 'utf8'), `UUID=abc / ext4 defaults 0 1\n${l1000}\n`)
  assert.equal(fs.statSync(fstab).mode & 0o777, 0o640, 'the mode is kept')
  // Add it back, twice: one line, never doubled.
  run(fstabEditScript(100, l100, fstab)); run(fstabEditScript(100, l100, fstab))
  assert.equal(fs.readFileSync(fstab, 'utf8').split('\n').filter(x => x === l100).length, 1)
  assert.ok(fs.readFileSync(fstab, 'utf8').includes(l1000))
  // Removing 1000 leaves 100.
  run(fstabEditScript(1000, null, fstab))
  assert.ok(fs.readFileSync(fstab, 'utf8').includes(l100) && !fs.readFileSync(fstab, 'utf8').includes(l1000))
  assert.deepEqual(fs.readdirSync(dir).sort(), ['fstab'], 'no temporary file left')
  // grep exit 2 (no such fstab) stops it and creates nothing.
  const missing = path.join(dir, 'gone')
  const r = run(fstabEditScript(100, l100, missing))
  assert.equal(r.status, 4)
  assert.match(r.stdout, /@@pbs fstabfail/)
  assert.ok(!fs.existsSync(missing))
  assert.deepEqual(fs.readdirSync(dir).sort(), ['fstab'])
  assert.throws(() => fstabEditScript(100, l1000, fstab), /not this container/)
  // The scripts no longer cat over fstab or match by substring.
  const u = unmountScriptFor(100)
  assert.ok(!/grep -vF|cat .*> \/etc\/fstab/.test(u + fstabEditScript(100, l100)))
  assert.match(u, / # hyperprox-pbs 100\$/)
})

test('fstab: after a container is deleted, its mount is cleaned up without touching any container', async () => {
  const u = unmountScriptFor(909, { detach: false })
  assert.ok(!/pct set/.test(u), 'a later container with the same id is never changed')
  assert.match(u, /@@pbs nomount/)
  assert.equal(await pbsMountCleanup({ node: 'node-a', vmid: 909 }, async () => ({ code: 0, output: '@@pbs nomount\n' })), '')
  assert.match(await pbsMountCleanup({ node: 'node-a', vmid: 909 }, async (_n, script) => { assert.equal(script, u); return { code: 0, output: '@@pbs unmounted\n' } }), /NAS mount on node-a was removed/)
  assert.match(await pbsMountCleanup({ node: 'node-a', vmid: 909 }, async () => ({ code: 1, output: '' })), /# hyperprox-pbs 909/)
})

test('delete-group: the exact set of snapshots must match at apply, not only the count', async () => {
  const w = await managed()
  const p = await w.svc.manager.preview(w.id, admin, { action: 'delete-group', store: 'tank', group: { type: 'ct', id: '101' } })
  // Same count, different snapshot: one went, another arrived.
  const ct = w.snaps().find(s => s.type === 'ct')!
  ct.time = T0 - 60
  await assert.rejects(w.svc.manager.apply(w.id, admin, p.id, ['last-snapshot']), (e: any) => e.code === 'changed')
  assert.equal(w.snaps().filter(s => s.type === 'ct').length, 1, 'nothing removed')
})

test('prune: snapshots PBS removed beyond the plan are reported and audited', async () => {
  const w = await managed({ sneaky: true })
  const p = await w.svc.manager.preview(w.id, admin, { action: 'prune', store: 'tank' })
  const r = await w.svc.manager.apply(w.id, admin, p.id, [])
  assert.equal(r.unplanned.length, 1)
  assert.match(r.message, /PBS also removed 1 snapshot the preview did not list/)
  assert.equal(audit_has(w.audit, 'removed_unplanned'), 1)
})

test('enable: a manage token that cannot be deleted again after a failed check is audited and named', async () => {
  const w = manageWorld({ failManageRead: true, failTokenDelete: true })
  const m = await w.svc.addWithLogin(signin({ manage: true }), admin)
  assert.equal(m.manage, null)
  assert.match(m.manageError!, /hyperprox@pbs!manage may still exist on the server: delete it there by hand/)
  assert.equal(w.audit.filter(a => a.action === 'pbs.manage' && a.details.result === 'failed:readback_token_left').length, 1)
})

test('forget: a server with management on is forgotten locally, naming the tokens left on it', async () => {
  const w = await managed()
  await assert.rejects(w.svc.manager.forget(w.id, tokenActor), (e: any) => e.code === 'token_forbidden')
  await assert.rejects(w.svc.manager.forget(w.id, operator), (e: any) => e.code === 'forbidden')
  const r = await w.svc.manager.forget(w.id, admin)
  assert.deepEqual(r.tokensLeft, ['hyperprox@pbs!manage', 'hyperprox@pbs!readonly'])
  assert.match(r.message, /manage token hyperprox@pbs!manage \(DatastoreAdmin on tank\) may still exist/)
  assert.deepEqual(await w.store.list(), [])
  assert.equal([...w.io.data.keys()].filter(k => k.includes(`pbs.${w.id}`)).length, 0, 'both vault items gone')
  assert.equal(w.tokens().includes('manage'), true, 'nothing was sent to the server')
  assert.equal(w.audit.at(-1).details.action, 'forget')
  assert.equal(needsReconfirm('POST', '/api/plugins/pbs/instances/p0a1b2c3d/forget'), true)
  assert.equal(requiredRole('POST', '/api/plugins/pbs/instances/p0a1b2c3d/forget'), 'admin')
  assert.equal(needsReconfirm('POST', '/api/plugins/pbs/instances/probe-certificate'), false, 'reading a certificate sends nothing')
  assert.equal(requiredRole('POST', '/api/plugins/pbs/instances/probe-certificate'), 'admin')
})

test('manage: previews, applies and clean-ups are rate-limited per session', async () => {
  const w = await managed()
  for (let i = 0; i < PbsManager.LIMITS.preview; i++) await w.svc.manager.preview(w.id, admin, { action: 'prune', store: 'tank' })
  await assert.rejects(w.svc.manager.preview(w.id, admin, { action: 'prune', store: 'tank' }), (e: any) => e.code === 'rate_limited')
  for (let i = 0; i < PbsManager.LIMITS.gc; i++) await w.svc.manager.gc(w.id, admin, 'tank')
  await assert.rejects(w.svc.manager.gc(w.id, admin, 'tank'), (e: any) => e.code === 'rate_limited')
  for (let i = 0; i < PbsManager.LIMITS.apply; i++) await w.svc.manager.apply(w.id, admin, 'none', []).catch(() => {})
  await assert.rejects(w.svc.manager.apply(w.id, admin, 'none', []), (e: any) => e.code === 'rate_limited')
  // Another session has its own allowance.
  await w.svc.manager.preview(w.id, { ...admin, sid: 'other' }, { action: 'prune', store: 'tank' })
})
