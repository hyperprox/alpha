// Proxmox refusing the token, or not answering at all, is said plainly and never crashes the API: getNodes and
// getAllVMs reject with a typed error (never resolve null for a caller to map over), the live feed tells the
// dashboard why it has no numbers, and connecting to an address that never answers gives up after the connect timeout.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { ProxmoxClient, ProxmoxAuthError, ProxmoxUnreachableError, PROXMOX_AUTH_MESSAGE } from '../src/lib/proxmox-client'
import { HomePinAgent, HomeConnectTimeoutError, recordHomeTlsPin, forgetHomeTlsPin, HomeCertificateChangedError } from '../src/lib/home-tls'
import { withCephMon, invalidateCephMonNode, CephUnavailableError } from '../src/lib/ceph'
import { CERT_CHANGED_MESSAGE } from '../src/lib/failure'
import { makeFastTick, overlapGuard, feedProblem } from '../src/lib/ws-broadcast'
import { NPMClient } from '../src/lib/npm-client'
import { proxmoxRoutes } from '../src/routes/proxmox'

const dir = mkdtempSync(join(tmpdir(), 'hpx-pve-fail-'))
process.env.HPX_HOME_TLS_PINS = join(dir, 'pins.json')
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=pve-test',
  '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore' })

let port = 0
let mode: 'refuse' | 'ok' | 'garbage' = 'refuse'
const pve = https.createServer({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) }, (req, res) => {
  if (mode === 'garbage') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>not json</html>') }
  if (mode === 'refuse') { res.writeHead(401, 'authentication failure', { 'content-type': 'application/json' }); return res.end('{"data":null}') }
  const p = (req.url ?? '').replace('/api2/json', '')
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ data: p === '/nodes' ? [{ node: 'pve', status: 'online', cpu: 0.1, maxcpu: 4, mem: 1, maxmem: 8, disk: 1, maxdisk: 10 }] : [] }))
})
before(async () => { await new Promise<void>(r => pve.listen(0, '127.0.0.1', () => { port = (pve.address() as any).port; r() })) })
after(() => { pve.close() })

const unhandled: unknown[] = []
const onUnhandled = (r: unknown) => { unhandled.push(r) }
process.on('unhandledRejection', onUnhandled)
after(() => { process.off('unhandledRejection', onUnhandled) })

const client = () => new ProxmoxClient('127.0.0.1', port, 'root@pam!hpx', 'wrong-secret')

test('a refused token: getNodes and getAllVMs reject with ProxmoxAuthError; ping says so', async () => {
  mode = 'refuse'
  await assert.rejects(client().getNodes(), (e: any) => e instanceof ProxmoxAuthError && e.httpStatus === 401 && e.message === PROXMOX_AUTH_MESSAGE)
  await assert.rejects(client().getAllVMs(), ProxmoxAuthError)
  const p = await client().ping()
  assert.equal(p.ok, false)
  assert.equal((p as any).code, 'proxmox_auth')
  assert.equal((p as any).error, PROXMOX_AUTH_MESSAGE)
})

test('the live feed with a refused token: no crash, no unhandled rejection, the dashboard is told why', async () => {
  mode = 'refuse'
  const sent: Array<[string, any]> = []
  const problems: unknown[] = []
  const problem = Object.assign((_w: string, e: unknown) => { problems.push(e) }, { ok: () => undefined })
  const tick = makeFastTick({ pve: client(), problem, send: (t, p) => sent.push([t, p]), unlocked: () => true, gpu: async () => [] as any, network: async () => ({}) })
  await overlapGuard(tick)()
  await new Promise(r => setTimeout(r, 50))
  assert.deepEqual(unhandled, [])
  assert.equal(problems.length, 1)
  assert.ok(problems[0] instanceof ProxmoxAuthError)
  assert.deepEqual(sent, [['feed-problem', { code: 'proxmox_auth', error: PROXMOX_AUTH_MESSAGE }]])

  // Numbers once the token works; then a refusal re-sends them stale, with why.
  mode = 'ok'
  await overlapGuard(tick)()
  assert.equal(sent.at(-1)![0], 'fast')
  assert.equal(sent.at(-1)![1].stale, false)
  mode = 'refuse'
  await overlapGuard(tick)()
  assert.equal(sent.at(-1)![1].stale, true)
  assert.equal(sent.at(-1)![1].problem.code, 'proxmox_auth')
})

test('the summary with a refused token: 502 proxmox_auth in words, not an empty cluster', async () => {
  mode = 'refuse'
  const saved = { ...process.env }
  Object.assign(process.env, { PROXMOX_HOST: '127.0.0.1', PROXMOX_PORT: String(port), PROXMOX_USER: 'root@pam', PROXMOX_TOKEN_ID: 'hpx', PROXMOX_TOKEN_SECRET: 'wrong-secret' })
  const app = Fastify()
  await app.register(proxmoxRoutes, { prefix: '/api/proxmox' })
  try {
    const r = await app.inject({ method: 'GET', url: '/api/proxmox/summary' })
    assert.equal(r.statusCode, 502)
    assert.equal(r.json().code, 'proxmox_auth')
    assert.equal(r.json().error, PROXMOX_AUTH_MESSAGE)
    assert.ok(r.json().requestId)
    const ping = await app.inject({ method: 'GET', url: '/api/proxmox/ping' })
    assert.equal(ping.statusCode, 502)
    assert.equal(ping.json().code, 'proxmox_auth')
  } finally {
    await app.close()
    for (const k of ['PROXMOX_HOST', 'PROXMOX_PORT', 'PROXMOX_USER', 'PROXMOX_TOKEN_ID', 'PROXMOX_TOKEN_SECRET']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]
    }
  }
})

test('a server that accepts TCP but never finishes the handshake: given up after the connect timeout', async () => {
  const held: net.Socket[] = []
  const silent = net.createServer(s => { held.push(s) })   // accepts, says nothing
  await new Promise<void>(r => silent.listen(0, '127.0.0.1', () => r()))
  const sp = (silent.address() as net.AddressInfo).port
  const c = new ProxmoxClient('127.0.0.1', sp, 'root@pam!hpx', 's', { agent: new HomePinAgent({ connectTimeoutMs: 300 }) })
  const t0 = Date.now()
  await assert.rejects(c.getNodes(), (e: any) => e instanceof ProxmoxUnreachableError && e.cause instanceof HomeConnectTimeoutError)
  const took = Date.now() - t0
  assert.ok(took >= 250 && took < 3000, `took ${took} ms`)
  await assert.rejects(c.fetchStrict('/version'), /did not answer within 0 seconds|did not answer within/)
  for (const s of held) s.destroy()
  silent.close()
})

test('the default connect timeout message says 20 seconds', () => {
  assert.equal(new HomeConnectTimeoutError('192.0.2.1', 8006, 20_000).message, 'Proxmox did not answer within 20 seconds')
  assert.equal(feedProblem(new ProxmoxUnreachableError(new HomeConnectTimeoutError('192.0.2.1', 8006, 20_000))).code, 'proxmox_unreachable')
})

test('a blackholed address: the connect timeout ends the wait', async () => {
  // A documentation-range address nothing answers: either the connect timeout fires, or the network says no route.
  const c = new ProxmoxClient('192.0.2.1', 8006, 'root@pam!hpx', 's', { agent: new HomePinAgent({ connectTimeoutMs: 500 }) })
  const t0 = Date.now()
  await assert.rejects(c.getNodes(), ProxmoxUnreachableError)
  assert.ok(Date.now() - t0 < 3000)
})

test('a tick abandoned by the watchdog does not broadcast its late numbers or clear the problem', async () => {
  let release!: () => void
  const slow = new Promise<void>(r => { release = r })
  let calls = 0
  const sent: Array<[string, any]> = []
  let oks = 0
  const pveFake = {
    getNodes: async () => { calls++; if (calls === 1) await slow; return [{ node: 'pve', cpu: 0, maxcpu: 1, mem: 0, maxmem: 1, disk: 0, maxdisk: 1 }] as any },
    getAllVMs: async () => [] as any,
  }
  const problem = Object.assign(() => undefined, { ok: () => { oks++ } })
  const tick = makeFastTick({ pve: pveFake, problem, send: (t, p) => sent.push([t, p]), unlocked: () => true, gpu: async () => [] as any, network: async () => ({}) })
  const guarded = overlapGuard(tick, undefined, { watchdogMs: 30 })
  const first = guarded()
  await new Promise(r => setTimeout(r, 50))
  await guarded()                       // released: a newer tick runs and sends fresh numbers
  assert.equal(sent.length, 1)
  assert.equal(oks, 1)
  release()
  await first                           // the abandoned tick finishes late
  assert.equal(sent.length, 1, 'the late tick sent nothing')
  assert.equal(oks, 1, 'and did not mark the problem cleared')
})

test('the live feed reads NPM with one try', async () => {
  let n = 0
  const npm = new NPMClient('http://192.0.2.5:81', 'a@example.com', 'pw', async () => { n++; throw new TypeError('fetch failed') }, { tries: 1, timeoutMs: 100 })
  await assert.rejects(npm.getStats())
  assert.equal(n, 1)
  let m = 0
  const normal = new NPMClient('http://192.0.2.5:81', 'b@example.com', 'pw', async () => { m++; throw new TypeError('fetch failed') })
  await assert.rejects(normal.getStats())
  assert.equal(m, 5)
})

test('a certificate that is not the pinned one is never reported as an outage', async () => {
  mode = 'ok'
  recordHomeTlsPin('127.0.0.1', port, 'AB'.repeat(32), 'ca-verified')
  try {
    await assert.rejects(client().getNodes(), (e: any) => e instanceof HomeCertificateChangedError)
    const p = await client().ping()
    assert.equal((p as any).code, 'proxmox_cert_changed')
    assert.equal((p as any).error, CERT_CHANGED_MESSAGE)

    const sent: Array<[string, any]> = []
    const problem = Object.assign(() => undefined, { ok: () => undefined })
    const tick = makeFastTick({ pve: client(), problem, send: (t, x) => sent.push([t, x]), unlocked: () => true, gpu: async () => [] as any, network: async () => ({}) })
    await overlapGuard(tick)()
    assert.deepEqual(sent, [['feed-problem', { code: 'proxmox_cert_changed', error: CERT_CHANGED_MESSAGE }]])

    const saved = { ...process.env }
    Object.assign(process.env, { PROXMOX_HOST: '127.0.0.1', PROXMOX_PORT: String(port), PROXMOX_USER: 'root@pam', PROXMOX_TOKEN_ID: 'hpx', PROXMOX_TOKEN_SECRET: 'any-secret' })
    const app = Fastify()
    await app.register(proxmoxRoutes, { prefix: '/api/proxmox' })
    try {
      const r = await app.inject({ method: 'GET', url: '/api/proxmox/summary' })
      assert.equal(r.statusCode, 502)
      assert.equal(r.json().code, 'proxmox_cert_changed')
      assert.equal(r.json().error, CERT_CHANGED_MESSAGE)
      assert.ok(!r.body.includes('AB:AB'), 'no fingerprint in the answer')
    } finally {
      await app.close()
      for (const k of ['PROXMOX_HOST', 'PROXMOX_PORT', 'PROXMOX_USER', 'PROXMOX_TOKEN_ID', 'PROXMOX_TOKEN_SECRET']) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]
      }
    }
  } finally {
    forgetHomeTlsPin('127.0.0.1', port)
  }
})

test('an answer that cannot be read is not "unreachable" either', async () => {
  mode = 'garbage'
  await assert.rejects(client().getNodes(), (e: any) => !(e instanceof ProxmoxUnreachableError) && /Parse error/.test(e.message))
  assert.equal((await client().ping() as any).code, 'proxmox_error')
})

test('CEPH with a refused token: the token problem, not "CEPH unavailable", and not remembered', async () => {
  mode = 'refuse'
  invalidateCephMonNode(true)
  const c = client()
  await assert.rejects(withCephMon(c, n => c.getCephOSDs(n)), (e: any) => e instanceof ProxmoxAuthError && !(e instanceof CephUnavailableError))
  // A second read asks Proxmox again (the refusal was not cached as "no CEPH").
  await assert.rejects(withCephMon(c, n => c.getCephOSDs(n)), ProxmoxAuthError)
  invalidateCephMonNode(true)
})
