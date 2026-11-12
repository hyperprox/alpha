// Proxmox Backup Server: the client's reads from fixtures, stale-group detection, the health reason, the
// instance store, the role / re-confirm / token guards on "verify now" and "GC now", the read-back of the task,
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
import { PbsService, PbsRefusal, refusalWords, type Actor } from '../src/lib/pbs/service'
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
  const m = await svc.add({ name: 'backups', url: 'https://10.9.8.7:8007', tokenId: 'hyperprox@pbs!admin', secret: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }, admin)
  return { svc, audit, m }
}

test('gate: both actions are admin and need the master password re-entered; reads do not', () => {
  for (const a of ['verify', 'gc']) {
    const p = `/api/plugins/pbs/instances/p0a1b2c3d/actions/${a}`
    assert.equal(requiredRole('POST', p), 'admin', a)
    assert.equal(needsReconfirm('POST', p), true, a)
  }
  assert.equal(needsReconfirm('POST', '/api/plugins/pbs/instances'), true, 'adding stores a token')
  assert.equal(needsReconfirm('DELETE', '/api/plugins/pbs/instances/p0a1b2c3d'), true)
  assert.equal(requiredRole('GET', '/api/plugins/pbs/instances/p0a1b2c3d/reading'), 'viewer')
  assert.equal(needsReconfirm('GET', '/api/plugins/pbs/instances/p0a1b2c3d/reading'), false)
})

test('actions: an API token and a non-admin are refused and audited; nothing reaches the server', async () => {
  const api = fakeApi({ 'POST /admin/datastore/tank/verify': () => UPID })
  const { svc, audit, m } = await serviceWith(api)
  for (const action of ['verify', 'gc']) {
    await assert.rejects(svc.act(m.id, action, { store: 'tank' }, tokenActor), (e: any) => e instanceof PbsRefusal && e.code === 'token_forbidden')
    await assert.rejects(svc.act(m.id, action, { store: 'tank' }, operator), (e: any) => e instanceof PbsRefusal && e.code === 'forbidden')
  }
  assert.ok(!api.calls.some(c => c.startsWith('POST')), 'no action was sent')
  assert.deepEqual(audit.filter(a => a.action === 'pbs.action').map(a => a.details.result), ['refused:token_forbidden', 'refused:forbidden', 'refused:token_forbidden', 'refused:forbidden'])
  await assert.rejects(svc.act(m.id, 'prune', { store: 'tank' }, admin), (e: any) => e.code === 'action_not_allowed')
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

test('actions: GC refused by PBS says which privilege the token lacks', async () => {
  const api = fakeApi({ 'POST /admin/datastore/tank/gc': () => { throw new PbsHttpError(403, 'permission check failed') } })
  const { svc, audit, m } = await serviceWith(api)
  await assert.rejects(svc.act(m.id, 'gc', { store: 'tank' }, admin), (e: any) => e.code === 'pbs_permission' && /Datastore\.Modify on \/datastore\/tank/.test(e.message))
  assert.equal(audit.at(-1)!.details.result, 'refused:pbs_permission')
  const v = refusalWords(new PbsHttpError(403, ''), 'verify', 'tank')
  assert.match(v, /Datastore\.Verify/)
})

test('add: a token that cannot read the server is never stored', async () => {
  const api = fakeApi({ 'GET /status/datastore-usage': () => { throw new PbsHttpError(403, 'no') } })
  const store = new PbsInstanceStore(memIO())
  const svc = new PbsService({ store, audit: async () => {}, probe: async () => ({ fingerprint: normaliseFingerprint('cd'.repeat(32))!, caVerified: false }), api: () => api })
  await assert.rejects(svc.add({ name: 'b', url: 'https://10.9.8.7', tokenId: 'a@pbs!b', secret: 'aaaaaaaa-bbbb' }, admin), (e: any) => e.code === 'connect_failed')
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
      if (p === '/access/acl' && method === 'PUT') { acl.push({ path: params!.path, roleid: params!.role, ugid: params!['auth-id'] }); return null }
      if (p === '/access/acl') return acl
      if (p === '/admin/datastore') return [{ store: 'tank' }, { store: 'offsite' }]
      throw new PbsHttpError(404, p)
    },
  }
  const io = memIO()
  const audit: any[] = []
  const store = new PbsInstanceStore(io)
  const logins: Array<{ userid: string; pinned: boolean }> = []
  const svc = new PbsService({
    store, audit: async (action, resource, details) => { audit.push({ action, resource, details }) },
    probe: async () => { order.push('probe'); return { fingerprint: normaliseFingerprint('cd'.repeat(32))!, caVerified: false } },
    login: async (_u, pin, userid, password) => {
      order.push('login')
      logins.push({ userid, pinned: !!pin?.fingerprint })
      if (password !== PASSWORD) throw new PbsHttpError(401, 'authentication failure')
      return admin
    },
    api: () => fakeApi(), now: () => NOW.getTime(), wait: async () => {},
  })
  return { svc, io, audit, order, acl: () => acl, tokens, logins, store }
}

const signin = (extra: Record<string, unknown> = {}) => ({ name: 'backups', url: 'https://10.9.8.7:8007', username: 'root', realm: 'pam', password: PASSWORD, ...extra })

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
  assert.deepEqual(w.acl(), [
    { path: '/', roleid: 'Audit', ugid: 'hyperprox@pbs' },
    { path: '/', roleid: 'Audit', ugid: 'hyperprox@pbs!readonly' },
  ], 'read-only: Audit on /, and no datastore role unless asked')
  const c = await w.store.connection(m.id)
  assert.deepEqual([c!.tokenId, c!.secret, c!.meta.pin?.source], ['hyperprox@pbs!readonly', 'token-secret-1', 'first-use'])
  assert.equal(m.allowActions, false)
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
})

test('sign-in: "Allow Verify now / GC now" grants on the datastores only, never on /', async () => {
  const w = signinWorld()
  const m = await w.svc.addWithLogin(signin({ allowActions: true }), admin)
  assert.equal(m.allowActions, true)
  const roles = w.acl().filter(r => r.roleid !== 'Audit')
  assert.deepEqual(roles.map(r => `${r.path} ${r.roleid} ${r.ugid}`), [
    '/datastore/tank DatastoreAdmin hyperprox@pbs', '/datastore/tank DatastoreAdmin hyperprox@pbs!readonly',
    '/datastore/offsite DatastoreAdmin hyperprox@pbs', '/datastore/offsite DatastoreAdmin hyperprox@pbs!readonly',
  ])
  assert.ok(!w.acl().some(r => r.path === '/' && r.roleid !== 'Audit'))
  // Only when asked: a truthy string is not consent.
  const w2 = signinWorld()
  await w2.svc.addWithLogin(signin({ allowActions: 'yes' }), admin)
  assert.ok(!w2.acl().some(r => r.roleid === 'DatastoreAdmin'))
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
