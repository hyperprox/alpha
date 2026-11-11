// QNAP: the parsers on both firmware generations, the client's session (login, reads, logout), reaching a NAS
// through a remote cluster's node, the instance store and its address rules, the tiers and confirm step on
// actions, the held login, and the alert transitions. Nothing real is contacted.
//
// Fixtures: test/fixtures/qnap/legacy are real answers from a QTS 4.3 (ARM, storage_v2 = 0) NAS with every
// identifying value (serials, MAC, addresses, host name, session ids, time zone) replaced. test/fixtures/qnap/qts5
// are built by hand in the shape QTS 5 answers (storage_v2 = 1, pools, fans, CPU sensor), not captured.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { buildReading, parseLogin, parseSmart, parseDiskUsage, sessionValid, sizeBytes, type RawAnswers, type QnapReading } from '../src/lib/qnap/parse'
import { parseXml, textOf } from '../src/lib/qnap/xml'
import { QnapClient, QnapLoginError, READS, ezEncode } from '../src/lib/qnap/client'
import { ClusterTransport, clusterScript, parseClusterOutput, type QnapRequest, type QnapResponse, type QnapTransport } from '../src/lib/qnap/transport'
import { QnapInstanceStore, effectiveReach, type CredentialIO, type ClusterFacts } from '../src/lib/qnap/instances'
import { checkQnapAddresses, remoteTargetProblem, isPrivateLanIp } from '../src/lib/qnap/target'
import { QnapService, confirmPhrase, type Actor } from '../src/lib/qnap/service'
import { QnapAlertPoller, MemoryAlertState, conditionsOf } from '../src/lib/qnap/alerts'
import { viewerReading, detailOf } from '../src/lib/qnap'
import { assertSafeScript } from '../src/lib/clusters/script-guard'
import { requiredRole, needsReconfirm } from '../src/lib/roles'
import { familyOf } from '../src/lib/notify/types'

const FIX = path.join(__dirname, 'fixtures', 'qnap')
const fx = (gen: 'legacy' | 'qts5', name: string) => fs.readFileSync(path.join(FIX, gen, name), 'utf8')

function answers(gen: 'legacy' | 'qts5'): RawAnswers {
  return {
    sysinfo: fx(gen, 'sysinfo.xml'), health: fx(gen, 'health.xml'), usage: fx(gen, 'usage.xml'), smart: fx(gen, 'smart.xml'),
    firmware: fx(gen, 'firmware.xml'), bandwidth: fx(gen, 'bandwidth.xml'), shares: fx(gen, 'shares.json'),
    pools: gen === 'legacy' ? fx('legacy', 'pools.html') : fx('qts5', 'pools.xml'),
  }
}

// ── parsers ──────────────────────────────────────────────────────────────────

test('parsers: legacy firmware (QTS 4.3 on ARM), from real answers', () => {
  const r = buildReading(answers('legacy'), new Date('2026-11-11T00:00:00Z'))
  assert.equal(r.generation, 'legacy')
  assert.equal(r.model, 'TS-119P II')
  assert.deepEqual(r.firmware, { version: '4.3.3', build: '20240619', number: '2784' })
  assert.deepEqual(r.update, { available: false, version: null, checkedAt: '2026/11/10 16:17:07' })
  assert.equal(r.uptimeSec, 48 * 86400 + 4 * 3600 + 49 * 60 + 32)
  assert.equal(r.health, 'good')
  assert.equal(r.cpuPct, 3.4)
  assert.equal(r.memTotalMB, 503.3)
  assert.equal(r.sysTempC, 38)
  assert.equal(r.cpuTempC, null)
  assert.deepEqual(r.fans, [])
  assert.equal(r.hostname, 'NAS-HOST')
  // Storage Manager's own thresholds (all_hd_data) win over sysinfo's.
  assert.equal(r.thresholds.diskWarnC, 65)
  assert.equal(r.disks.length, 1)
  assert.deepEqual({ ...r.disks[0], lastTest: undefined }, {
    bay: 1, model: 'WDC WD30EFRX-68N32N0', capacity: '2.73 TB', sizeBytes: sizeBytes('2.73 TB'), tempC: 34, smart: 'good', smartText: 'OK',
    lastTest: undefined, serial: 'WD-WCC0000000000', firmware: '82.00A82',
  })
  assert.equal(r.volumes.length, 1)
  assert.equal(r.volumes[0].name, 'Volume 1')
  assert.equal(r.volumes[0].health, 'good')
  assert.equal(r.volumes[0].totalBytes, 2951926665216)
  assert.equal(r.volumes[0].usedBytes, 2951926665216 - 1471603503104)
  assert.deepEqual(r.volumes[0].disks, [1])
  assert.deepEqual(r.pools, [], 'no pools on legacy firmware; the HTML answer is ignored')
  assert.ok(r.shares.some(s => s.name === 'Movies' && s.usedBytes === 724224774144 && s.volume === '1'))
  assert.ok(r.shares.some(s => s.name === 'home' && s.usedBytes === null), 'a share the tree lists but QTS did not size')
  assert.ok(!r.shares.some(s => s.name === 'System Reserved'), 'system folders are not shares')
  assert.equal(r.interfaces.length, 1)
  assert.deepEqual(r.interfaces[0], { name: 'LAN 1', up: true, speedMbps: 1000, ip: '10.20.30.40', mask: '255.255.255.0', mac: '00:00:5E:00:53:01', mode: 'STATIC',
    rxPackets: r.interfaces[0].rxPackets, txPackets: r.interfaces[0].txPackets, errors: 0, rxBps: 7416, txBps: 7678 })
  assert.deepEqual(r.missing, [])
})

test('parsers: QTS 5 (storage-v2) shape: pools, fans, CPU sensor, a warning disk and a degraded volume', () => {
  const r = buildReading(answers('qts5'))
  assert.equal(r.generation, 'storage-v2')
  assert.equal(r.model, 'TS-431P')
  assert.equal(r.firmware.version, '5.2.1')
  assert.deepEqual(r.update, { available: true, version: '5.2.4.3079 Build 20250321', checkedAt: '2026/11/11 04:00:00' })
  assert.equal(r.health, 'warning')
  assert.equal(r.cpuTempC, 61)
  assert.deepEqual(r.fans, [{ index: 1, rpm: 1120, ok: true }])
  assert.deepEqual(r.disks.map(d => [d.bay, d.smart, d.tempC]), [[1, 'good', 36], [2, 'good', 38], [3, 'warning', 41], [4, 'good', 57]])
  assert.equal(r.disks[0].lastTest.status, 'Completed without error')
  assert.deepEqual(r.volumes.map(v => [v.name, v.health, v.degraded, v.pool]), [['DataVol1', 'good', false, '1'], ['DataVol2', 'warning', true, '2']])
  assert.deepEqual(r.pools.map(p => [p.name, p.health]), [['Storage Pool 1', 'good'], ['Storage Pool 2', 'warning']])
  assert.deepEqual(r.interfaces.map(n => [n.name, n.up, n.speedMbps, n.rxBps]), [['Adapter 1', true, 1000, 125000], ['Adapter 2', false, 10000, 0]])
  assert.equal(r.interfaces[1].ip, null)
  assert.deepEqual(r.shares.map(s => s.name), ['Backups', 'Media', 'Photos', 'Public'])
})

test('parsers: anything missing or malformed becomes null, never a throw', () => {
  const r = buildReading({})
  assert.equal(r.model, null); assert.equal(r.firmware.version, null); assert.equal(r.update.available, null)
  assert.equal(r.uptimeSec, null); assert.equal(r.sysTempC, null); assert.deepEqual(r.disks, []); assert.deepEqual(r.volumes, [])
  assert.deepEqual(r.missing.sort(), ['firmware', 'health', 'shares', 'smart', 'sysinfo', 'usage'])
  const junk = buildReading({ sysinfo: '<QDocRoot><root><cpu_usage>lots</cpu_usage><uptime_day>x', smart: '<<<>>>', usage: 'null', shares: '{"not":"a list"}', firmware: '<QDocRoot><newVersion>' })
  assert.equal(junk.cpuPct, null); assert.deepEqual(junk.disks, []); assert.deepEqual(junk.shares, [])
  // A session the NAS has ended: authPassed 0 means none of it counts.
  const expired = '<QDocRoot><authPassed><![CDATA[0]]></authPassed></QDocRoot>'
  assert.equal(sessionValid(expired), false)
  assert.ok(buildReading({ sysinfo: expired }).missing.includes('sysinfo'))
  assert.deepEqual(parseSmart('<QDocRoot><Disk_Info><entry><HDNo>0</HDNo></entry><entry><HDNo>2</HDNo><Health>--</Health></entry></Disk_Info></QDocRoot>').disks.map(d => [d.bay, d.smart]), [[2, null]])
  assert.deepEqual(parseDiskUsage('<volumeList><volume><volumeValue>../x</volumeValue></volume></volumeList>').volumes, [])
  assert.equal(textOf(parseXml('<a><b>&lt;ok&gt; &#65;&#x42;</b></a>'), 'b'), '<ok> AB')
})

test('login answers: passed, refused, two-step', () => {
  assert.deepEqual(parseLogin(fx('legacy', 'login.xml')), { passed: true, sid: 'abcd1234', needs2sv: false, isAdmin: true })
  assert.equal(parseLogin(fx('qts5', 'login.xml')).isAdmin, false)
  assert.equal(parseLogin(fx('qts5', 'login-refused.xml')).passed, false)
  assert.equal(parseLogin(fx('qts5', 'login-2sv.xml')).needs2sv, true)
  assert.equal(parseLogin('<html>not a NAS</html>').passed, false)
})

// ── the client's session ─────────────────────────────────────────────────────

const PASSWORD = 'pa ss&wörd=1'

/** A pretend NAS behind the transport interface. Records every request. */
class FakeNas implements QnapTransport {
  readonly via = 'direct'
  sent: QnapRequest[] = []
  loginAnswer = fx('qts5', 'login.xml')
  up = true
  constructor(public gen: 'legacy' | 'qts5' = 'qts5', public extra: Record<string, string> = {}) {}
  async batch(reqs: QnapRequest[]): Promise<QnapResponse[]> {
    if (!this.up) throw new Error('down')
    return reqs.map(r => {
      this.sent.push(r)
      if (r.path.startsWith('/cgi-bin/authLogin.cgi')) return { status: 200, text: this.loginAnswer }
      for (const [k, v] of Object.entries(this.extra)) if (r.path.includes(k)) return { status: 200, text: v }
      const name = READS.find(([, p]) => r.path.startsWith(p))?.[0]
      if (name) return { status: 200, text: (answers(this.gen) as any)[name] ?? '' }
      if (r.path.startsWith('/cgi-bin/authLogout.cgi')) return { status: 200, text: '<QDocRoot><authPassed>1</authPassed></QDocRoot>' }
      return { status: 404, text: '' }
    })
  }
}

test('client: login by POST with the encoded password, every read carries the sid, logout last', async () => {
  const nas = new FakeNas()
  const r = await new QnapClient(nas, { username: 'hyperprox', password: PASSWORD }).read()
  assert.equal(r.model, 'TS-431P')
  const [login, ...rest] = nas.sent
  assert.equal(login.method, 'POST')
  assert.equal(login.path, '/cgi-bin/authLogin.cgi')
  assert.equal(new URLSearchParams(login.form).get('pwd'), ezEncode(PASSWORD))
  assert.equal(Buffer.from(new URLSearchParams(login.form).get('pwd')!, 'base64').toString('utf8'), PASSWORD)
  assert.equal(rest.length, READS.length + 1)
  for (const q of rest) { assert.equal(q.method, 'GET'); assert.match(q.path, /[?&]sid=qts5sid99$/) }
  assert.match(rest[rest.length - 1].path, /^\/cgi-bin\/authLogout\.cgi/)
  // The password is in the login body only: never in a path.
  for (const q of nas.sent) { assert.ok(!q.path.includes(ezEncode(PASSWORD))); assert.ok(!q.path.includes('pa ss')) }
})

test('client: refused and two-step logins are QnapLoginError and send nothing else', async () => {
  for (const [file, kind] of [['login-refused.xml', 'refused'], ['login-2sv.xml', 'two-step']] as const) {
    const nas = new FakeNas(); nas.loginAnswer = fx('qts5', file)
    await assert.rejects(new QnapClient(nas, { username: 'u', password: 'p' }).read(), (e: any) => e instanceof QnapLoginError && e.kind === kind && !String(e.message).includes('p@'))
    assert.equal(nas.sent.length, 1)
  }
})

// ── through a remote cluster's node ──────────────────────────────────────────

test('cluster transport: the script keeps the password and sid off command lines and passes the remote guard', () => {
  const base = new URL('http://10.20.30.40:8080/')
  const reqs: QnapRequest[] = [
    { method: 'POST', path: '/cgi-bin/authLogin.cgi', form: `user=u&pwd=${ezEncode('se"cr\\et')}` },
    { method: 'GET', path: '/cgi-bin/management/manaRequest.cgi?subfunc=sysinfo&sid=abcd1234' },
  ]
  const tag = '0123456789abcdef'
  const s = clusterScript(base, reqs, { insecureTLS: false, timeoutSec: 15, tag })
  assertSafeScript(s)
  // Everything secret is inside a here-document; the lines bash runs as commands carry none of it.
  const commands: string[] = []
  let inDoc = false
  for (const l of s.split('\n')) {
    if (inDoc) { if (l === `HPXQ_${tag}`) inDoc = false; continue }
    commands.push(l)
    if (l.endsWith(`<<'HPXQ_${tag}'`)) inDoc = true
  }
  for (const c of commands) { assert.ok(!c.includes('abcd1234')); assert.ok(!c.includes(ezEncode('se"cr\\et'))); assert.ok(!c.includes('10.20.30.40')) }
  assert.ok(commands.every(c => !c || /^(set -u|command -v curl|echo "@@hpx-qnap|curl -K - <<)/.test(c)), 'only curl and markers')
  // A path cannot carry a line break (the URL parser drops them); a form body that tries is refused.
  assert.ok(!clusterScript(base, [{ method: 'GET', path: '/x\nrm -rf /' }], { insecureTLS: false, timeoutSec: 5, tag }).includes('\nrm -rf'))
  assert.throws(() => clusterScript(base, [{ method: 'POST', path: '/x', form: 'a=1\nrm -rf /' }], { insecureTLS: false, timeoutSec: 5, tag }))
  assert.throws(() => clusterScript(base, reqs, { insecureTLS: false, timeoutSec: 5, tag: 'EOF' }))
  const out = '@@hpx-qnap begin 0\n<QDocRoot/>\n@@hpx-qnap status 0 200\n@@hpx-qnap end 0 0\n@@hpx-qnap begin 1\n\n@@hpx-qnap status 1 000\n@@hpx-qnap end 1 7\n'
  assert.deepEqual(parseClusterOutput(out, 3), [{ status: 200, text: '<QDocRoot/>' }, { status: 0, text: '' }, { status: 0, text: '' }])
})

const hasCurl = spawnSync('sh', ['-c', 'command -v curl']).status === 0

test('cluster transport end to end: the script really runs (bash + curl) against a pretend NAS', { skip: !hasCurl && 'no curl here' }, async () => {
  const seen: Array<{ method: string; url: string; body: string }> = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, body })
      if (req.url!.startsWith('/cgi-bin/authLogin.cgi')) return res.end(fx('qts5', 'login.xml'))
      const name = READS.find(([, p]) => req.url!.startsWith(p))?.[0]
      res.end(name ? (answers('qts5') as any)[name] : '<QDocRoot><authPassed>1</authPassed></QDocRoot>')
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as any).port
  // The runner a remote node would be: bash reading the script on stdin.
  const scripts: string[] = []
  const run = (script: string) => new Promise<{ code: number; output: string }>((resolve) => {
    scripts.push(script)
    const p = spawn('bash', ['-s'])
    let out = ''
    p.stdout.on('data', d => { out += d })
    p.on('close', code => resolve({ code: code ?? 0, output: out }))
    p.stdin.end(script)
  })
  try {
    const t = new ClusterTransport({ url: `http://127.0.0.1:${port}`, insecureTLS: false, clusterName: 'Remote', run })
    const r = await new QnapClient(t, { username: 'hyperprox', password: PASSWORD }).read()
    assert.equal(r.model, 'TS-431P')
    assert.equal(r.disks.length, 4)
    assert.equal(scripts.length, 2, 'one SSH session for the login, one for the reads and the logout')
    assert.equal(seen[0].method, 'POST')
    assert.equal(new URLSearchParams(seen[0].body).get('pwd'), ezEncode(PASSWORD))
    assert.ok(seen.slice(1).every(s => s.url.includes('sid=qts5sid99')))
    assert.ok(seen[seen.length - 1].url.startsWith('/cgi-bin/authLogout.cgi'))
  } finally { server.close() }
})

// ── instances and address rules ──────────────────────────────────────────────

function memIO(seed: Record<string, string> = {}): CredentialIO & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed))
  return {
    data,
    async get(c, p, k) { return data.get(`${c}/${p}/${k}`) ?? null },
    async set(c, p, k, v) { data.set(`${c}/${p}/${k}`, v) },
    async remove(c, p) { for (const k of [...data.keys()]) if (k.startsWith(`${c}/${p}/`)) data.delete(k) },
  }
}

const REMOTE: ClusterFacts = { kind: 'remote', name: 'Family server', nodes: { pve: '100.80.0.9' } }
const facts = (id: string) => (id === 'c0123456789' ? REMOTE : id === 'home' ? { kind: 'home' as const, name: 'Home', nodes: {} } : null)
const openResolver = async (u: URL) => u.hostname

test('address rules: the same as Home Assistant, worded for a NAS; remote targets are literal private IPs', () => {
  const env = { own: new Set<string>(), ports: new Set<number>(), bridges: new (require('node:net').BlockList)() }
  assert.equal(checkQnapAddresses('http:', 8080, ['10.0.0.5'], env).ok, true)
  const lo = checkQnapAddresses('http:', 8080, ['127.0.0.1'], env)
  assert.ok(!lo.ok && /loopback/.test(lo.reason) && !/Home Assistant/.test(lo.reason))
  assert.equal(checkQnapAddresses('http:', 80, ['169.254.169.254'], env).ok, false)
  assert.equal(checkQnapAddresses('http:', 80, ['8.8.4.4'], env).ok, false, 'plain http only to a private address')
  assert.equal(checkQnapAddresses('https:', 443, ['8.8.4.4'], env).ok, true)

  assert.equal(remoteTargetProblem(new URL('http://10.20.30.40:8080'), '100.80.0.9'), null)
  assert.match(remoteTargetProblem(new URL('http://nas.lan:8080'), null)!, /IP address/)
  assert.match(remoteTargetProblem(new URL('http://127.0.0.1:8080'), null)!, /loopback/)
  assert.match(remoteTargetProblem(new URL('http://169.254.1.1'), null)!, /link-local/)
  assert.match(remoteTargetProblem(new URL('http://100.100.100.200'), null)!, /metadata/)
  assert.match(remoteTargetProblem(new URL('http://8.8.4.4'), null)!, /private/)
  assert.match(remoteTargetProblem(new URL('http://10.0.0.9:22'), null)!, /SSH/)
  assert.match(remoteTargetProblem(new URL('http://10.0.0.9'), '10.0.0.9')!, /own address/)
  assert.equal(isPrivateLanIp('10.1.2.3'), true)
  assert.equal(isPrivateLanIp('100.80.0.9'), false, 'a tailnet address is reached directly')
})

test('instances: create, views without the password, reach, and the login following the address', async () => {
  const io = memIO()
  const store = new QnapInstanceStore(io, facts, openResolver)
  const a = await store.create({ name: 'Office', url: 'http://10.0.0.5:8080/', username: 'hyperprox', password: 'pw1' })
  assert.match(a.id, /^q[0-9a-f]{8}$/)
  assert.equal(io.data.get(`plugin/qnap.${a.id}/password`), 'pw1')
  assert.ok(!(io.data.get('plugin/qnap/instances') ?? '').includes('pw1'), 'the list holds no login')
  const [v] = await store.views()
  assert.equal(v.url, 'http://10.0.0.5:8080'); assert.equal(v.hasPassword, true); assert.equal((v as any).password, undefined)
  await assert.rejects(store.create({ name: 'office', url: 'http://10.0.0.6', username: 'u', password: 'p' }), /already has that name/)
  await assert.rejects(store.create({ name: 'X', url: 'http://10.0.0.6/cgi-bin', username: 'u', password: 'p' }), /no path/)
  await assert.rejects(store.create({ name: 'X', url: 'http://u:p@10.0.0.6', username: 'u', password: 'p' }), /login out/)
  await assert.rejects(store.create({ name: 'X', url: 'http://10.0.0.6', username: 'bad user', password: 'p' }), /user name/)
  // The real resolver refuses loopback.
  await assert.rejects(new QnapInstanceStore(memIO(), facts).create({ name: 'L', url: 'http://127.0.0.1:8080', username: 'u', password: 'p' }), /loopback/)

  // Moving the address or changing the user needs the password again; the pin is dropped when the host moves.
  await store.update(a.id, { fingerprint: 'AA'.repeat(32) })
  await assert.rejects(store.update(a.id, { url: 'http://10.0.0.7:8080' }), /password again/)
  await assert.rejects(store.update(a.id, { username: 'other' }), /password again/)
  const moved = await store.update(a.id, { url: 'http://10.0.0.7:8080', password: 'pw2' })
  assert.equal(moved.meta.fingerprint, null)
  assert.equal(moved.loginChanged, true)
  assert.equal((await store.update(a.id, { name: 'Office NAS' })).loginChanged, false)
  assert.equal((await store.connection(a.id))!.password, 'pw2')
  await store.remove(a.id)
  assert.equal([...io.data.keys()].filter(k => k.includes(a.id)).length, 0)
})

test('instances: beside a remote cluster, a LAN address is reached through its node; pins and names refused there', async () => {
  const store = new QnapInstanceStore(memIO(), facts, openResolver)
  const fam = await store.create({ name: 'Family NAS', url: 'http://10.20.30.40:8080', username: 'hyperprox', password: 'p', clusterId: 'c0123456789' })
  assert.equal(effectiveReach(fam, 'http://10.20.30.40:8080', REMOTE), 'cluster')
  assert.equal(effectiveReach({ ...fam, reach: 'direct' }, 'http://10.20.30.40:8080', REMOTE), 'direct')
  assert.equal(effectiveReach(fam, 'http://100.80.0.20:8080', REMOTE), 'direct', 'a tailnet address is reached directly')
  assert.equal(effectiveReach(fam, 'http://10.20.30.40:8080', null), 'direct')
  await assert.rejects(store.update(fam.id, { fingerprint: 'BB'.repeat(32) }), /pinned certificate/)
  await assert.rejects(store.create({ name: 'N', url: 'http://nas.lan:8080', username: 'u', password: 'p', clusterId: 'c0123456789', reach: 'cluster' }), /IP address/)
  await assert.rejects(store.create({ name: 'N', url: 'http://10.0.0.9', username: 'u', password: 'p', clusterId: 'c0123456789', node: 'nope' }), /node/)
  await assert.rejects(store.create({ name: 'N', url: 'http://10.0.0.9', username: 'u', password: 'p', clusterId: 'cffffffffff' }), /not one HyperProx manages/)
  await assert.rejects(store.create({ name: 'N', url: 'http://10.0.0.9', username: 'u', password: 'p', reach: 'cluster' }), /remote cluster/)
})

// ── roles ────────────────────────────────────────────────────────────────────

test('roles: reads viewer, SMART test operator, power and every instance change admin and re-confirmed', () => {
  const I = '/api/plugins/qnap/instances'
  assert.equal(requiredRole('GET', I), 'viewer')
  assert.equal(requiredRole('GET', `${I}/q12345678/reading`), 'viewer')
  assert.equal(requiredRole('POST', `${I}/q12345678/actions`), 'operator')
  assert.equal(needsReconfirm('POST', `${I}/q12345678/actions`), false)
  for (const [m, p] of [['POST', `${I}/q12345678/secure-actions`], ['POST', I], ['PUT', `${I}/q12345678`], ['DELETE', `${I}/q12345678`]]) {
    assert.equal(requiredRole(m, p), 'admin', `${m} ${p}`)
    assert.equal(needsReconfirm(m, p), true, `${m} ${p}`)
  }
  assert.equal(requiredRole('POST', `${I}/probe-certificate`), 'admin')
  assert.equal(needsReconfirm('POST', `${I}/probe-certificate`), false)
  assert.equal(needsReconfirm('GET', `${I}/q12345678/reading`), false)
  assert.equal(familyOf('alert.qnap.disk'), 'resources')
  assert.equal(familyOf('alert.qnap.power'), 'resources')
})

// ── the service: tiers, confirm step, audit, held login ──────────────────────

const owner: Actor = { sid: 's-own', email: 'owner@example.com', role: 'owner', token: null }
const admin: Actor = { sid: 's-adm', email: 'admin@example.com', role: 'admin', token: null }
const operator: Actor = { sid: 's-op', email: 'op@example.com', role: 'operator', token: null }
const viewer: Actor = { sid: 's-v', email: 'v@example.com', role: 'viewer', token: null }
const robot: Actor = { sid: 'token:1', email: 'token:robot', role: 'admin', token: 'robot' }

async function rig(nas = new FakeNas('qts5', { 'func=start_test': '<QDocRoot><authPassed>1</authPassed><result>0</result></QDocRoot>', 'power_mgmt': '<QDocRoot><authPassed>1</authPassed></QDocRoot>' })) {
  const store = new QnapInstanceStore(memIO(), facts, openResolver)
  const m = await store.create({ name: 'Office', url: 'http://10.0.0.5:8080', username: 'hyperprox', password: 'pw' })
  const audits: Array<{ action: string; details: any }> = []
  const published: any[] = []
  let clock = 1_000_000
  const svc = new QnapService({ store, transportFor: () => nas, audit: async (action, _r, details) => { audits.push({ action, details }) }, publish: async e => { published.push(e) }, now: () => clock })
  return { svc, m, nas, audits, published, tick: (ms: number) => { clock += ms } }
}

test('actions: a quick SMART test is operator, on the normal route, for a bay the NAS has', async () => {
  const { svc, m, nas, audits } = await rig()
  const ok = await svc.act(m.id, { action: 'smart_test', bay: 2 }, operator, false)
  assert.match(ok.message, /Quick SMART test started on disk 2/)
  assert.ok(nas.sent.some(r => r.path.includes('func=start_test&disk_select=2&test_type=0')))
  assert.equal(audits.at(-1)!.details.result, 'done')
  await assert.rejects(svc.act(m.id, { action: 'smart_test', bay: 2 }, viewer, false), (e: any) => e.code === 'forbidden')
  await assert.rejects(svc.act(m.id, { action: 'smart_test', bay: 9 }, operator, false), (e: any) => e.code === 'bad_input')
  await assert.rejects(svc.act(m.id, { action: 'smart_test', bay: '1; reboot' }, operator, false), (e: any) => e.code === 'bad_input')
  await assert.rejects(svc.act(m.id, { action: 'smart_test', bay: 1 }, owner, true), (e: any) => e.code === 'not_security')
  await assert.rejects(svc.act(m.id, { action: 'format_disk', bay: 1 }, owner, false), (e: any) => e.code === 'action_not_allowed')
  assert.ok(audits.filter(a => String(a.details.result).startsWith('refused')).length >= 5, 'every refusal is audited')
})

test('actions: restart and shut down need the secure route, admin, a person, the phrase and the typed name', async () => {
  const { svc, m, nas, audits, published } = await rig()
  const phrase = confirmPhrase('restart', m.name)
  assert.equal(phrase, 'Restart Office')
  await assert.rejects(svc.act(m.id, { action: 'restart', confirm: phrase, typed: 'Office' }, owner, false), (e: any) => e.code === 'security_action')
  await assert.rejects(svc.act(m.id, { action: 'restart', confirm: phrase, typed: 'Office' }, robot, true), (e: any) => e.code === 'token_forbidden')
  await assert.rejects(svc.act(m.id, { action: 'restart', confirm: phrase, typed: 'Office' }, operator, true), (e: any) => e.code === 'forbidden')
  await assert.rejects(svc.act(m.id, { action: 'restart', confirm: 'Restart', typed: 'Office' }, admin, true), (e: any) => e.code === 'confirm_required')
  await assert.rejects(svc.act(m.id, { action: 'restart', confirm: phrase, typed: 'Offic' }, admin, true), (e: any) => e.code === 'confirm_required')
  assert.ok(!nas.sent.some(r => r.path.includes('power_mgmt')), 'nothing reached the NAS')
  const done = await svc.act(m.id, { action: 'shutdown', confirm: confirmPhrase('shutdown', m.name), typed: ' office ' }, admin, true)
  assert.match(done.message, /shutting down/)
  assert.ok(nas.sent.some(r => r.path.startsWith('/cgi-bin/sys/sysRequest.cgi?subfunc=power_mgmt&apply=shutdown')))
  assert.equal(published.length, 1)
  assert.equal(published[0].type, 'alert.qnap.power')
  assert.match(published[0].title, /Shut down: Office/)
  const rows = audits.map(a => a.details.result)
  assert.deepEqual(rows.slice(-6), ['refused:security_action', 'refused:token_forbidden', 'refused:forbidden', 'refused:confirm_required', 'refused:confirm_required', 'done'])
  for (const a of audits) assert.ok(!JSON.stringify(a).includes('pw') || !JSON.stringify(a).includes('"pw"'))
})

test('a refused login is never retried until the login is saved again', async () => {
  const nas = new FakeNas(); nas.loginAnswer = fx('qts5', 'login-refused.xml')
  const { svc, m } = await rig(nas)
  await assert.rejects(svc.reading(m.id), (e: any) => e instanceof QnapLoginError)
  await assert.rejects(svc.reading(m.id), (e: any) => e.code === 'login_held')
  await assert.rejects(svc.act(m.id, { action: 'smart_test', bay: 1 }, operator, false))
  assert.equal(nas.sent.length, 1, 'one login attempt, ever')
  nas.loginAnswer = fx('qts5', 'login.xml')
  svc.forget(m.id)
  assert.equal((await svc.reading(m.id)).model, 'TS-431P')
})

test('readings are cached 20 s and shared; a viewer sees no serials, addresses or MACs', async () => {
  const { svc, m, nas, tick } = await rig()
  await Promise.all([svc.reading(m.id), svc.reading(m.id)])
  const logins = () => nas.sent.filter(r => r.path.includes('authLogin')).length
  assert.equal(logins(), 1)
  tick(10_000); await svc.reading(m.id); assert.equal(logins(), 1)
  await svc.reading(m.id, { fresh: true }); assert.equal(logins(), 2)
  const v = viewerReading(await svc.reading(m.id))
  assert.equal(v.serial, null); assert.equal(v.hostname, null)
  assert.ok(v.disks.every(d => d.serial === null)); assert.ok(v.interfaces.every(n => n.ip === null && n.mac === null))
  const d = detailOf('Office', v)
  assert.ok(d.tables!.some(t => t.title === 'Disks' && t.rows.length === 4))
})

// ── alerts ───────────────────────────────────────────────────────────────────

test('alert conditions: SMART, degraded and full volumes, pools, temperatures with hysteresis, fans', () => {
  const r = buildReading(answers('qts5'))
  const keys = conditionsOf({ name: 'Office', diskTempWarnC: null }, r).map(c => c.key).sort()
  assert.deepEqual(keys, ['disk:3:smart', 'disk:4:temp', 'pool:2:state', 'vol:1:full', 'vol:2:state'])
  assert.deepEqual(conditionsOf({ name: 'Old', diskTempWarnC: null }, buildReading(answers('legacy'))), [], 'the healthy NAS raises nothing')
  const hot = (t: number): QnapReading => ({ ...r, disks: [{ ...r.disks[3], tempC: t }], volumes: [], pools: [] })
  const firing = new Set(['disk:4:temp'])
  assert.equal(conditionsOf({ name: 'O', diskTempWarnC: null }, hot(53), firing).length, 1, 'stays announced just under the threshold')
  assert.equal(conditionsOf({ name: 'O', diskTempWarnC: null }, hot(51), firing).length, 0, 'clears 3 °C under it')
  assert.equal(conditionsOf({ name: 'O', diskTempWarnC: null }, hot(53)).length, 0, 'does not fire under it')
  assert.equal(conditionsOf({ name: 'O', diskTempWarnC: 50 }, hot(51)).length, 1, 'the instance\'s own threshold')
  assert.equal(conditionsOf({ name: 'O', diskTempWarnC: null }, { ...hot(20), fans: [{ index: 1, rpm: 0, ok: false }] })[0].key, 'fan:1')
})

test('alert poller: fires once, resolves once, keeps conditions when the NAS cannot be read', async () => {
  const store = new MemoryAlertState()
  const published: any[] = []
  let reading: QnapReading | null = buildReading(answers('qts5'))
  const meta = { id: 'q00000001', name: 'Office', clusterId: null, node: null, reach: 'auto' as const, insecureTLS: false, fingerprint: null, alerts: true, diskTempWarnC: null }
  let ready = true
  const p = new QnapAlertPoller({
    instances: async () => [meta], read: async () => { if (!reading) throw new Error('down'); return reading },
    publish: async e => { published.push(e) }, store, ready: () => ready,
  })
  assert.equal((await p.tick()).fired, 5)
  assert.ok(published.every(e => e.type.startsWith('alert.qnap.') && familyOf(e.type) === 'resources' && e.fingerprint.startsWith('qnap:q00000001:')))
  assert.equal((await p.tick()).fired, 0, 'already announced')
  reading = null
  assert.deepEqual(await p.tick(), { fired: 0, resolved: 0, skipped: 1 }, 'not reading a disk is not the disk getting better')
  ready = false
  reading = buildReading(answers('legacy'))
  assert.deepEqual(await p.tick(), { fired: 0, resolved: 0, skipped: 0 }, 'nothing while locked')
  ready = true
  const r = await p.tick()
  assert.equal(r.resolved, 5)
  const resolves = published.slice(5)
  assert.ok(resolves.every(e => e.resolved === true))
  assert.deepEqual(resolves.map(e => e.fingerprint).sort(), published.slice(0, 5).map(e => e.fingerprint).sort())
  assert.deepEqual(store.state.firing, {})
  // Alerts turned off while something is announced: forgotten quietly, no "resolved".
  reading = buildReading(answers('qts5'))
  await p.tick()
  const before = published.length
  meta.alerts = false
  await p.tick()
  assert.equal(published.length, before)
  assert.deepEqual(store.state.firing, {})
})

test('service: a LAN address beside a remote cluster is read through that cluster\'s node, and re-checked on use', async () => {
  let current: ClusterFacts = REMOTE
  const store = new QnapInstanceStore(memIO(), id => (id === 'c0123456789' ? current : null), openResolver)
  const m = await store.create({ name: 'Family NAS', url: 'http://10.20.30.40:8080', username: 'hyperprox', password: 'p', clusterId: 'c0123456789' })
  const calls: Array<[string, string, string]> = []
  const scripts: string[] = []
  const svc = new QnapService({
    store, audit: async () => {},
    nodeRunner: (cid, node, purpose) => { calls.push([cid, node, purpose]); return async s => { scripts.push(s); throw new Error('ssh down') } },
  })
  await assert.rejects(svc.reading(m.id), /could not reach Family server/)
  assert.deepEqual(calls, [['c0123456789', 'pve', 'read']])
  assert.match(scripts[0], /curl -K - <</)
  assert.ok(!scripts[0].split('\n').some(l => l.startsWith('curl') && l.includes('10.20.30.40')))
  // The node's address became the NAS's own: refused before anything is sent.
  current = { ...REMOTE, nodes: { pve: '10.20.30.40' } }
  await assert.rejects(svc.reading(m.id), (e: any) => e.code === 'bad_target')
  assert.equal(scripts.length, 1)
})
