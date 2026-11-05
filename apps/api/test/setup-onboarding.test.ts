// The installer's questions after install (Settings → Setup checklist), the shared hardware detection on
// the API side, the setup wizard's hand-over of secrets it held before the vault existed, and the proof
// that no secret value lands in Postgres, files or logs on the way.
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { Writable } from 'node:stream'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { FakeBroker, GOOD_CODE } from './fakes/fake-broker'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable, getProviderCredentials, setCredentials } from '../src/lib/credentials'
import { saveCredential } from '../src/lib/ssh-broker'
import { checkHostKey } from '../src/lib/node-exec'
import { requestContext } from '../src/lib/auth'
import { ensureGrafanaAdmin, resetGrafanaAdmin } from '../src/lib/grafana-admin'
import { setAuditSink } from '../src/lib/audit'
import { buildSetupChecklistRoutes } from '../src/routes/setup-checklist'
import { monitoringRoutes } from '../src/routes/monitoring'
import { detectNode, detectCluster, type HardwareDeps } from '../src/lib/hardware'
import { syncTargets, readTargets } from '../src/lib/targets'
import { clearHeldSecrets, heldSummary, handoffFlagPath, acceptHandoff } from '../src/lib/setup-handoff'
import { pciGpus } from '../src/lib/wizard-placement'
import type { ChecklistDeps } from '../src/lib/setup-checklist'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fakeNode, loadFixtures } = require('../../../packages/hardware/test/harness')
const FX: Record<string, any> = Object.fromEntries(loadFixtures().map((f: any) => [f.file.replace(/\.json$/, ''), f]))

// ── Planted markers: if any of these turns up outside the vault, a secret leaked ─────────────────────
const MARK = `PLANTED-${Math.random().toString(36).slice(2)}-MARKER`
const NODE_PW = `node-pw-${MARK}`
const GD_KEY = `gd-key-${MARK}`
const GD_SECRET = `gd-secret-${MARK}`

const dir = mkdtempSync(join(tmpdir(), 'hpx-onboard-'))
const ENV = join(dir, '.env')
const SETUP_KEY = 'k'.repeat(64)
writeFileSync(ENV, `SETUP_SECRET=${SETUP_KEY}\nCOMPOSE_PROFILES=\n`, { mode: 0o600 })
process.env.ENV_FILE_PATH = ENV

const logs: string[] = []
const logStream = new Writable({ write(c, _e, cb) { logs.push(String(c)); cb() } })
for (const k of ['log', 'warn', 'error', 'info'] as const) {
  const orig = console[k].bind(console)
  console[k] = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); orig(...a) }
}
const audits: Array<{ action: string; resource: string; details?: Record<string, unknown> }> = []
setAuditSink({ async write(r) { audits.push(r) } })
const dbWrites: unknown[] = []
setCredentialTable({ credential: { findMany: async () => [], deleteMany: async (a: unknown) => { dbWrites.push(a); return { count: 0 } } } } as any)

const broker = new FakeBroker()
broker.addUser('owner@example.com', 'owner master password', 'owner')
broker.addUser('viewer@example.com', 'viewer master password', 'viewer')
setBroker(broker)

// ── A fake cluster: three nodes from the detection fixtures, reached through a fake SSH ───────────────
const fakes = { 'node-a': fakeNode(FX['nvidia-dedicated']), 'node-b': fakeNode(FX['fresh-intel-node']), 'node-c': fakeNode(FX['server-no-gpu']) } as Record<string, any>
const ADDR: Record<string, string> = { 'node-a': '10.0.0.1', 'node-b': '10.0.0.2', 'node-c': '10.0.0.3' }
const BY_ADDR = Object.fromEntries(Object.entries(ADDR).map(([n, a]) => [a, n]))
const execCalls: Array<{ node: string; script: string; cred: any }> = []
const logins = new Map<string, any>()
const PCI: Record<string, unknown[]> = {
  'node-a': [{ class: '0x030000', vendor: '0x10de', device: '0x1b82', device_name: 'GP104 [GeForce GTX 1070 Ti]', id: '0000:42:00.0' }],
  'node-b': [{ class: '0x030000', vendor: '0x8086', device: '0x5912', device_name: 'HD Graphics 630', id: '0000:00:02.0' }],
  'node-c': [{ class: '0x030000', vendor: '0x1a03', device: '0x2000', device_name: 'ASPEED Graphics Family', id: '0000:03:00.0' }],
}
const hwDeps: HardwareDeps = {
  nodes: async () => Object.keys(fakes),
  addresses: async () => ({ ...ADDR }),
  pci: async n => PCI[n] ?? [],
  login: async n => logins.get(n) ?? null,
  async exec(host, cred, script) {
    const node = BY_ADDR[host]
    execCalls.push({ node, script, cred })
    if (cred.password !== NODE_PW) throw new Error('All configured authentication methods failed')
    if (/^pveversion/.test(script)) return { code: 0, output: 'pve-manager/9.1.0/abc (running kernel: 7.0.0-1-pve)\n' }
    // The built-in graphics steps run for real against the fake node's sysroot (udev does not run there).
    if (/^# (Let containers|Undo "let containers)/m.test(script)) { const r = fakes[node].run(script); return { code: r.status ?? 1, output: r.stdout } }
    if (/^# HyperProx hardware probe/m.test(script)) { const r = fakes[node].run(script); return { code: r.status ?? 1, output: r.stdout } }
    // Any other node step: reported, not run (the Docker tests run them for real).
    return { code: 0, output: `HPX-RESULT\tdone\tset up on ${node}\n` }
  },
  metrics: async (addr, port) => (BY_ADDR[addr] === 'node-a' && port === 9100) ? 'node_exporter_build_info 1\nnode_rapl_package_joules_total 5\n' : null,
}
let profilesStarted: string[][] = []
const checklistDeps = (): ChecklistDeps => ({
  hardware: hwDeps, envFile: ENV, hyperproxDir: dir,
  promQuery: async expr => expr.startsWith('up{job="node"}') ? Object.keys(fakes).map(node => ({ node, value: 1 })) : [],
  compose: async args => { profilesStarted.push(args) },
  ollamaModels: async () => null, pullModel: async () => {},
  pveExporter: async () => ({ configured: false, readOnly: false }), provisionPveExporter: async () => ({}),
  dnsKey: async () => { const c = await getProviderCredentials('dns', 'godaddy').catch(() => ({} as any)); return { key: c.api_key, secret: c.api_secret } },
  saveDnsKey: async (k, s) => { await setCredentials('dns', 'godaddy', { api_key: k, api_secret: s }) },
  testDnsKey: async (k, s) => { if (k !== GD_KEY || s !== GD_SECRET) throw Object.assign(new Error('401'), { response: { status: 401 } }); return 3 },
  setOllamaUrl: async () => {}, syncTargets: async () => ({ added: {} }),
  saveNodeLogin: async (node, cred) => { await saveCredential(`node-${node}`, cred); logins.set(node, cred) },
  pins: async () => [], presentedKey: async () => 'SHA256:' + 'P'.repeat(43),
})
process.env.HPX_CHECKLIST_SETTLE_MS = '0'

let app: FastifyInstance
async function build() {
  app = Fastify({ logger: { level: 'info', stream: logStream } as any })
  await registerGate(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(buildSetupChecklistRoutes(checklistDeps), { prefix: '/api/setup-checklist' })
  await app.register(monitoringRoutes, { prefix: '/api/monitoring', grafanaReset: async (pw: string) => { grafanaSet.push(pw) } } as any)
  await app.ready()
}
const grafanaSet: string[] = []
const appReady = build()
beforeEach(async () => { await appReady; if (isUnlocked()) await lock('manual') })
after(async () => { if (isUnlocked()) await lock('manual'); await app.close(); Object.values(fakes).forEach(f => f.cleanup()) })

async function signIn(email: string, password: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/sign-in', payload: { email, password, code: GOOD_CODE } })
  const raw = res.headers['set-cookie']
  return String(Array.isArray(raw) ? raw[0] : raw).split(';')[0]
}
async function ownerCookie() {
  const cookie = await signIn('owner@example.com', 'owner master password')
  await app.inject({ method: 'POST', url: '/api/auth/reconfirm', payload: { password: 'owner master password' }, headers: { cookie }, remoteAddress: '127.0.0.1' })
  return cookie
}
const responses: string[] = []
async function call(method: string, url: string, cookie?: string, payload?: unknown, extra: Record<string, string> = {}) {
  const r = await app.inject({ method: method as any, url, payload: payload as any, headers: { ...(cookie ? { cookie } : {}), ...extra }, remoteAddress: extra['x-remote'] ?? '127.0.0.1' })
  responses.push(r.body)
  return r
}
async function waitJob(cookie: string, id: string) {
  for (let i = 0; i < 100; i++) {
    const j = (await call('GET', `/api/setup-checklist/jobs/${id}`, cookie)).json().data
    if (j.status !== 'running') return j
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error('job did not finish')
}

// ── Detection on the API side ────────────────────────────────────────────────────────────────────────

test('without a node login: GPUs from Proxmox through the shared classifier, the rest unknown, no SSH', async () => {
  const before = execCalls.length
  const hw = await detectNode('node-a', ADDR['node-a'], hwDeps)
  assert.equal(execCalls.length, before)
  assert.equal(hw.source, 'proxmox-api')
  assert.deepEqual(hw.gpus.map(g => `${g.vendor}/${g.kind}/${g.name}`), ['nvidia/dedicated/NVIDIA GeForce GTX 1070 Ti'])
  assert.equal(hw.nodeExporter, 'running')
  assert.equal(hw.rapl, 'readable', 'node_exporter publishing RAPL means the counters are readable')
  const c = await detectNode('node-c', ADDR['node-c'], hwDeps)
  assert.deepEqual(c.gpus, [], 'a BMC display is not a GPU')
  assert.equal(c.rapl, null, 'unknown, not guessed')
})

test('the placement wizard uses the same classifier: APU graphics and Arc Graphics are built in', () => {
  assert.deepEqual(pciGpus([{ class: '0x030000', vendor: '0x1002', device: '0x15d8', device_name: 'Picasso/Raven 2 [Radeon Vega Series / Radeon Vega Mobile Series]' }]), { discrete: false, integrated: true })
  assert.deepEqual(pciGpus([{ class: '0x030000', vendor: '0x8086', device: '0x7d55', device_name: 'Meteor Lake-P [Intel Arc Graphics]' }]), { discrete: false, integrated: true })
  assert.deepEqual(pciGpus([{ class: '0x030000', vendor: '0x8086', device: '0x56a5', device_name: 'DG2 [Arc A380]' }]), { discrete: true, integrated: false })
})

test('target sync writes GPU targets from what was detected, keeps existing entries, and only adds', async () => {
  const tdir = mkdtempSync(join(tmpdir(), 'hpx-targets-'))
  writeFileSync(join(tdir, 'nodes.json'), JSON.stringify([{ targets: ['old-a:9100'], labels: { node: 'node-a' } }]))
  let reloads = 0
  const r = await syncTargets({
    nodes: async () => Object.keys(fakes), address: async n => ADDR[n], pci: async n => PCI[n],
    cephMgrs: async () => new Set(['node-a']), reload: async () => { reloads++ }, dir: tdir,
  })
  assert.deepEqual(readTargets('nvidia.json', tdir), [{ targets: ['10.0.0.1:9835'], labels: { node: 'node-a' } }])
  assert.deepEqual(readTargets('intel-gpu.json', tdir), [{ targets: ['10.0.0.2:8081'], labels: { node: 'node-b' } }])
  assert.equal(readTargets('nodes.json', tdir)[0].targets[0], 'old-a:9100')
  assert.deepEqual(r.added['nodes.json'], ['node-b', 'node-c'])
  assert.equal(reloads, 1)
})

// ── The gate: admin only, and nothing while locked ───────────────────────────────────────────────────

test('locked: the checklist says so and does nothing', async () => {
  const r = await call('GET', '/api/setup-checklist')
  assert.equal(r.statusCode, 423)
  const before = execCalls.length
  assert.equal((await call('POST', '/api/setup-checklist/node-health/run')).statusCode, 423)
  assert.equal(execCalls.length, before)
})

test('a viewer cannot read or run it', async () => {
  const cookie = await signIn('viewer@example.com', 'viewer master password')
  assert.equal((await call('GET', '/api/setup-checklist', cookie)).statusCode, 403)
  assert.equal((await call('PUT', '/api/setup-checklist/node-login', cookie, { username: 'root', password: NODE_PW })).statusCode, 403)
})

// ── The setup wizard's hand-over ─────────────────────────────────────────────────────────────────────

test('hand-over: refused through nginx, from another address, or without the setup key', async () => {
  clearHeldSecrets()
  const body = { nodeLogin: { username: 'root', password: NODE_PW, nodes: ['node-a', 'node-b', 'node-c'] }, godaddy: { key: GD_KEY, secret: GD_SECRET } }
  assert.equal((await call('POST', '/api/auth/setup-handoff', undefined, body, { 'x-setup-key': SETUP_KEY, 'x-forwarded-for': '203.0.113.9' })).statusCode, 403)
  assert.equal((await call('POST', '/api/auth/setup-handoff', undefined, body, { 'x-setup-key': SETUP_KEY, 'x-remote': '192.0.2.5' })).statusCode, 403)
  assert.equal((await call('POST', '/api/auth/setup-handoff', undefined, body, { 'x-setup-key': 'wrong' })).statusCode, 401)
  const owned = await call('POST', '/api/auth/setup-handoff', undefined, body, { 'x-setup-key': SETUP_KEY })
  assert.equal(owned.statusCode, 409, 'an owner already exists: refused')
  assert.match(owned.json().error, /owner account already exists/)
  assert.deepEqual(heldSummary(), { nodeLogin: null, godaddy: false })
})

test('hand-over: held in memory, then stored in the vault at the owner\'s sign-in, then forgotten', async () => {
  clearHeldSecrets()
  broker.bootstrapped = false   // setup finishing: no owner yet
  const hostKeys = Object.fromEntries(Object.entries(ADDR).map(([n, a], i) => [n, { address: a, fingerprint: 'SHA256:' + 'ABC'[i].repeat(43) }]))
  const body = { nodeLogin: { username: 'root', password: NODE_PW, nodes: ['node-a', 'node-b', 'node-c'], hostKeys }, godaddy: { key: GD_KEY, secret: GD_SECRET }, extra: 'dropped' }
  // Nothing usable: refused, and the one hand-over is not used up by it.
  assert.equal((await call('POST', '/api/auth/setup-handoff', undefined, { nodeLogin: { username: 'root' } }, { 'x-setup-key': SETUP_KEY })).statusCode, 400)
  // The vault not answering is "cannot tell", never "no owner".
  broker.reachable = false
  assert.equal((await call('POST', '/api/auth/setup-handoff', undefined, body, { 'x-setup-key': SETUP_KEY })).statusCode, 503)
  broker.reachable = true
  assert.ok(!existsSync(handoffFlagPath()), 'neither refusal used up the hand-over')
  const r = await call('POST', '/api/auth/setup-handoff', undefined, body, { 'x-setup-key': SETUP_KEY })
  assert.equal(r.statusCode, 200, r.body)
  assert.ok(existsSync(handoffFlagPath()), 'recorded on disk, so a restart does not open it again')
  assert.throws(() => acceptHandoff({ reachable: true, bootstrapped: false }), /already handed over/, 'the file alone refuses it, as after a restart')
  const again = await call('POST', '/api/auth/setup-handoff', undefined, body, { 'x-setup-key': SETUP_KEY })
  assert.equal(again.statusCode, 409, 'accepted exactly once')
  broker.bootstrapped = true
  assert.deepEqual(r.json().held, { nodeLogin: { nodes: ['node-a', 'node-b', 'node-c'] }, godaddy: true })
  assert.ok(!r.body.includes(MARK), 'the answer names what is held, never a value')
  assert.ok(![...broker.items.values()].some(i => JSON.stringify(i).includes(MARK)), 'nothing in the vault yet: there is no owner session')

  await signIn('owner@example.com', 'owner master password')
  for (let i = 0; i < 50 && heldSummary().godaddy; i++) await new Promise(res => setTimeout(res, 20))
  assert.deepEqual(heldSummary(), { nodeLogin: null, godaddy: false }, 'dropped from memory once stored')
  const gd = broker.items.get('hyperprox:dns/godaddy')!
  assert.deepEqual(gd.fields, { ...gd.fields, api_key: GD_KEY, api_secret: GD_SECRET })
  const deck = [...broker.items.values()].find(i => i.name === 'hyperprox:deck/ssh')!
  assert.ok(deck && Object.keys(deck.fields).filter(k => k.startsWith('node-')).length === 3, JSON.stringify(Object.keys(deck?.fields ?? {})))
  for (const n of Object.keys(fakes)) {
    const raw = Object.entries(deck.fields).find(([k]) => k.includes(n))![1]
    assert.equal(JSON.parse(raw).password, NODE_PW)
    logins.set(n, JSON.parse(raw))
  }
  assert.ok(audits.some(a => a.action === 'node_login.save' && a.resource === 'node:node-a'))
  assert.ok(audits.some(a => a.action === 'dns_key.save'))
  // The host keys the wizard saw are pinned with the login.
  const pinsItem = broker.items.get('hyperprox:deck/hostkey')!
  assert.deepEqual(Object.values(pinsItem.fields).sort(), ['SHA256:' + 'A'.repeat(43), 'SHA256:' + 'B'.repeat(43), 'SHA256:' + 'C'.repeat(43)])
  // An owner exists: setup is done, and the setup key leaves .env.
  const env = readFileSync(ENV, 'utf8')
  assert.match(env, /^SETUP_COMPLETE=true$/m)
  assert.doesNotMatch(env, /^SETUP_SECRET=/m)
})

test('the node runner pins a host key on first use and refuses a changed one', async () => {
  const cookie = await ownerCookie(); void cookie
  const sid = [...broker.sessions.values()].filter(x => x.email === 'owner@example.com').at(-1)!.sid
  await requestContext.run({ sid, email: 'owner@example.com', role: 'owner' }, async () => {
    const fp1 = 'SHA256:' + 'D'.repeat(43), fp2 = 'SHA256:' + 'E'.repeat(43)
    assert.equal(await checkHostKey('10.9.9.9', fp1), true, 'first use: learned')
    assert.equal(await checkHostKey('10.9.9.9', fp1), true, 'same key again: accepted')
    assert.equal(await checkHostKey('10.9.9.9', fp2), false, 'a changed key: always refused')
    assert.equal(await checkHostKey('10.0.0.1', 'SHA256:' + 'Z'.repeat(43)), false, 'the wizard\'s pin holds too')
  })
})

// ── The checklist ────────────────────────────────────────────────────────────────────────────────────

test('the checklist: every question, done or not checked live, per node where it applies', async () => {
  const cookie = await signIn('owner@example.com', 'owner master password')
  const r = await call('GET', '/api/setup-checklist', cookie)
  assert.equal(r.statusCode, 200, r.body)
  const d = r.json().data
  assert.match(d.summary, /^Found 3 nodes\. node-a: NVIDIA GeForce GTX 1070 Ti \(dedicated\); health monitoring already running\. node-b: Intel HD Graphics 630 \(built in\)\. node-c: no GPU; no power counters\./)
  const item = (id: string) => d.items.find((x: any) => x.id === id)
  assert.equal(item('node-health').state, 'partly')
  assert.deepEqual(item('power').rows.map((x: any) => `${x.node}:${x.state}`), ['node-a:done', 'node-b:not-done', 'node-c:not-applicable'])
  assert.deepEqual(item('gpu').rows.map((x: any) => `${x.node}:${x.state}`), ['node-a:done', 'node-b:not-done', 'node-c:not-applicable'])
  assert.equal(item('charts').state, 'not-done')
  assert.equal(item('dns').state, 'done')
  assert.equal(item('targets').automatic, true)
  assert.match(item('power').what, /any local user on that node can then read energy use/)
})

test('changes on the checklist ask for the master password again', async () => {
  const cookie = await signIn('owner@example.com', 'owner master password')
  for (const [m, u] of [['POST', '/api/setup-checklist/node-health/run'], ['PUT', '/api/setup-checklist/node-login'], ['POST', '/api/setup-checklist/igpu-access/node-b/apply']]) {
    const r = await call(m, u, cookie, {})
    assert.equal(r.statusCode, 403, `${m} ${u}`)
    assert.equal(r.json().code, 'reconfirm_required')
  }
  assert.equal((await call('GET', '/api/setup-checklist', cookie)).statusCode, 200, 'reading does not')
})

test('running one item: one node at a time, only where needed, audited without values, then checked', async () => {
  const cookie = await ownerCookie()
  const before = execCalls.length
  const r = await call('POST', '/api/setup-checklist/node-health/run', cookie)
  assert.equal(r.statusCode, 200, r.body)
  const job = await waitJob(cookie, r.json().data.id)
  const steps = execCalls.slice(before).filter(c => /^# HyperProx node-side helpers/.test(c.script))
  assert.deepEqual(steps.map(c => c.node), ['node-b', 'node-c'], 'node-a already answers')
  assert.deepEqual(job.results.map((x: any) => `${x.node}:${x.status}`), ['node-b:done', 'node-c:done'])
  assert.deepEqual(job.checks.map((x: any) => `${x.node}:${x.status}`), ['node-a:ok', 'node-b:ok', 'node-c:ok'])
  assert.ok(audits.some(a => a.action === 'node_login.use' && a.resource === 'node:node-b'))
})

test('a second item while one runs is refused, not queued behind it', async () => {
  const cookie = await ownerCookie()
  process.env.HPX_CHECKLIST_SETTLE_MS = '300'
  try {
    const a = await call('POST', '/api/setup-checklist/power/run', cookie)
    const b = await call('POST', '/api/setup-checklist/gpu/run', cookie)
    assert.equal(b.statusCode, 409)
    await waitJob(cookie, a.json().data.id)
  } finally { process.env.HPX_CHECKLIST_SETTLE_MS = '0' }
})

test('one node login for every node: tested on each, stored only where it worked', async () => {
  const cookie = await ownerCookie()
  const bad = await call('PUT', '/api/setup-checklist/node-login', cookie, { username: 'root', password: 'wrong' })
  assert.deepEqual(bad.json().data.nodes.map((x: any) => x.ok), [false, false, false])
  assert.match(bad.json().data.nodes[0].reason, /was not accepted/)
  const good = await call('PUT', '/api/setup-checklist/node-login', cookie, { username: 'root', password: NODE_PW })
  assert.deepEqual(good.json().data.nodes.map((x: any) => x.ok), [true, true, true])
  assert.ok(!good.body.includes(MARK))
  assert.equal((await call('PUT', '/api/setup-checklist/node-login', cookie, { username: 'root' })).statusCode, 400)
})

test('a GoDaddy key is tested first, and a wrong one is an answer, not a stored secret', async () => {
  const cookie = await ownerCookie()
  const before = JSON.stringify(broker.items.get('hyperprox:dns/godaddy'))
  const bad = await call('POST', '/api/setup-checklist/dns/run', cookie, { key: 'nope', secret: 'nope' })
  assert.equal(bad.statusCode, 400)
  assert.match(bad.json().error, /did not accept that key/)
  assert.equal(JSON.stringify(broker.items.get('hyperprox:dns/godaddy')), before)
  const ok = await call('POST', '/api/setup-checklist/dns/run', cookie, { key: GD_KEY, secret: GD_SECRET })
  assert.equal(ok.statusCode, 200, ok.body)
  assert.match(ok.json().data.results[0].reason, /kept in the vault; 3 domain\(s\) found/)
})

test('charts: the compose profile is recorded in .env and the services are started', async () => {
  const cookie = await ownerCookie()
  profilesStarted = []
  const r = await call('POST', '/api/setup-checklist/charts/run', cookie)
  await waitJob(cookie, r.json().data.id)
  assert.match(readFileSync(ENV, 'utf8'), /^COMPOSE_PROFILES=monitoring$/m)
  assert.deepEqual(profilesStarted, [['up', '-d', 'prometheus', 'grafana', 'pve-exporter']])
})

test('Grafana admin reset: set in Grafana, kept in the vault, never in the answer or in .env', async () => {
  const cookie = await signIn('owner@example.com', 'owner master password')
  // Re-confirmation first (the gate asks for it on this route). A fresh sign-in has not re-confirmed.
  assert.equal((await call('POST', '/api/monitoring/grafana-admin/reset', cookie)).statusCode, 403)
  await call('POST', '/api/auth/reconfirm', cookie, { password: 'owner master password' })
  const r = await call('POST', '/api/monitoring/grafana-admin/reset', cookie)
  assert.equal(r.statusCode, 200, r.body)
  const pw = grafanaSet.at(-1)!
  assert.equal(grafanaSet.length, 1)
  assert.ok(pw.length >= 20)
  assert.equal(broker.items.get('hyperprox:system/grafana')!.fields.admin_password, pw)
  assert.ok(!r.body.includes(pw))
  assert.ok(!readFileSync(ENV, 'utf8').includes(pw))
})

// ── Built-in graphics for containers ──────────────────────────────────────────────────────────────────

test('igpuAccess: state per node, apply writes the rule, undo removes it; NVIDIA-only is none', async () => {
  const cookie = await ownerCookie()
  const st = (n: string) => call('GET', `/api/setup-checklist/igpu-access/${n}`, cookie).then(r => r.json())
  assert.deepEqual((await st('node-b')).data, { node: 'node-b', state: 'closed', ruleInstalled: false })
  assert.equal((await st('node-a')).data.state, 'none')
  const ap = (await call('POST', '/api/setup-checklist/igpu-access/node-b/apply', cookie)).json()
  assert.equal(ap.data.status, 'done', JSON.stringify(ap))
  assert.ok(existsSync(join(fakes['node-b'].sys, 'etc/udev/rules.d/99-hyperprox-igpu.rules')))
  assert.equal((await st('node-b')).data.ruleInstalled, true)
  const none = (await call('POST', '/api/setup-checklist/igpu-access/node-a/apply', cookie)).json()
  assert.equal(none.data.status, 'skipped')
  const un = (await call('POST', '/api/setup-checklist/igpu-access/node-b/undo', cookie)).json()
  assert.equal(un.data.status, 'done')
  assert.ok(!existsSync(join(fakes['node-b'].sys, 'etc/udev/rules.d/99-hyperprox-igpu.rules')))
  assert.ok(audits.some(a => a.action === 'node_login.use' && /built-in graphics/.test(String(a.details?.purpose))))
  const items = (await call('GET', '/api/setup-checklist', cookie)).json().data.items
  const ig = items.find((x: any) => x.id === 'igpu-access')
  assert.match(ig.what, /any container on that node can then use its built-in graphics/)
  assert.deepEqual(ig.rows.map((r: any) => `${r.node}:${r.state}`), ['node-a:not-applicable', 'node-b:not-done', 'node-c:not-applicable'])
  const none2 = await call('GET', '/api/setup-checklist/igpu-access/nobody', cookie)
  assert.equal(none2.statusCode, 409, 'no login saved for that node')
})

// ── Old plaintext backups ─────────────────────────────────────────────────────────────────────────────

test('leftover .env.pre-vault files are shown and shredded (with the master password)', async () => {
  writeFileSync(join(dir, '.env.pre-vault'), 'PROXMOX_TOKEN_SECRET=old-plaintext\n')
  writeFileSync(join(dir, '.env.pre-vault.1700000000000'), 'X=1\n')
  // A symlink named like a backup is never followed, listed or shredded.
  const outside = join(mkdtempSync(join(tmpdir(), 'hpx-outside-')), 'keep.txt')
  writeFileSync(outside, 'not ours\n')
  require('node:fs').symlinkSync(outside, join(dir, '.env.pre-vault.1'))
  const cookie = await ownerCookie()
  const item = (await call('GET', '/api/setup-checklist', cookie)).json().data.items.find((x: any) => x.id === 'old-backups')
  assert.deepEqual(item.rows.map((r: any) => r.node), ['.env.pre-vault', '.env.pre-vault.1700000000000'])
  const r = await call('POST', '/api/setup-checklist/old-backups/run', cookie)
  await waitJob(cookie, r.json().data.id)
  assert.ok(!existsSync(join(dir, '.env.pre-vault')) && !existsSync(join(dir, '.env.pre-vault.1700000000000')))
  assert.equal(readFileSync(outside, 'utf8'), 'not ours\n', 'the symlink target is untouched')
  assert.ok(require('node:fs').lstatSync(join(dir, '.env.pre-vault.1')).isSymbolicLink(), 'the symlink itself is left alone')
  const job = (await call('GET', `/api/setup-checklist/jobs/${r.json().data.id}`, cookie)).json().data
  assert.ok(job.results.every((x: any) => /copies may remain in snapshots or backups/.test(x.reason)))
  require('node:fs').unlinkSync(join(dir, '.env.pre-vault.1'))
  assert.ok(!(await call('GET', '/api/setup-checklist', cookie)).json().data.items.some((x: any) => x.id === 'old-backups'))
})

// ── Grafana's admin password ──────────────────────────────────────────────────────────────────────────

test('Grafana: none in the vault is generated, stored, read back and applied; reset is vault first', async () => {
  let vault: string | null = null
  const applied: string[] = []
  let failApply = false, failWrite = false
  const d = {
    running: async () => true,
    apply: async (pw: string) => { if (failApply) throw new Error('grafana refused'); applied.push(pw) },
    read: async () => vault,
    write: async (pw: string) => { if (failWrite) throw new Error('vault down'); vault = pw || null },
    generate: () => `gen-${applied.length}-${Math.random()}`,
  }
  assert.equal(await ensureGrafanaAdmin(null), 'off', 'off unless the API turned it on')
  assert.equal(await ensureGrafanaAdmin(d), 'generated')
  assert.equal(applied.at(-1), vault, 'what Grafana has is what the vault has')
  assert.equal(await ensureGrafanaAdmin(d), 'applied', 'a fresh Grafana database gets the vault password again, never admin/admin')
  const before = vault
  failWrite = true
  await assert.rejects(resetGrafanaAdmin(d))
  assert.equal(vault, before); assert.equal(applied.at(-1), before, 'vault write failed: nothing changed')
  failWrite = false; failApply = true
  await assert.rejects(resetGrafanaAdmin(d))
  assert.equal(vault, before, 'Grafana refused: the vault is put back')
  failApply = false
  await resetGrafanaAdmin(d)
  assert.notEqual(vault, before); assert.equal(applied.at(-1), vault)
})

// ── The planted-marker proof (runs last) ─────────────────────────────────────────────────────────────

test('planted markers: no secret value in Postgres, files, logs, audit rows or answers', async () => {
  assert.ok(logs.length > 0, 'logs were captured')
  const hits: string[] = []
  const scan = (where: string, text: string) => { if (text.includes(MARK)) hits.push(where) }
  logs.forEach((l, i) => scan(`log line ${i}`, l))
  scan('audit rows', JSON.stringify(audits))
  scan('Postgres writes', JSON.stringify(dbWrites))
  responses.forEach((b, i) => scan(`response ${i}`, b))
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : scan(p, readFileSync(p, 'utf8')) } }
  walk(dir)
  // Process environment: a held secret must not have been copied into process.env either.
  scan('process.env', JSON.stringify(process.env))
  assert.deepEqual(hits, [])
  // ...and the vault does hold them, so the scan was looking for something real.
  assert.ok([...broker.items.values()].some(i => JSON.stringify(i).includes(MARK)))
})
