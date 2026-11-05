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
import { setCredentialTable, getProviderCredentials } from '../src/lib/credentials'
import { setAuditSink } from '../src/lib/audit'
import { buildSetupChecklistRoutes } from '../src/routes/setup-checklist'
import { monitoringRoutes } from '../src/routes/monitoring'
import { detectNode, detectCluster, type HardwareDeps } from '../src/lib/hardware'
import { syncTargets, readTargets } from '../src/lib/targets'
import { clearHeldSecrets, heldSummary } from '../src/lib/setup-handoff'
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
    if (/^# HyperProx hardware probe/m.test(script)) { const r = fakes[node].run(script); return { code: r.status ?? 1, output: r.stdout } }
    // A node step: reported, not run (the Docker tests run them for real).
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
  saveDnsKey: async (k, s) => { await (await import('../src/lib/credentials')).setCredentials('dns', 'godaddy', { api_key: k, api_secret: s }) },
  testDnsKey: async (k, s) => { if (k !== GD_KEY || s !== GD_SECRET) throw Object.assign(new Error('401'), { response: { status: 401 } }); return 3 },
  setOllamaUrl: async () => {}, syncTargets: async () => ({ added: {} }),
  saveNodeLogin: async (node, cred) => { await (await import('../src/lib/ssh-broker')).saveCredential(`node-${node}`, cred); logins.set(node, cred) },
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
  assert.deepEqual(heldSummary(), { nodeLogin: null, godaddy: false })
})

test('hand-over: held in memory, then stored in the vault at the owner\'s sign-in, then forgotten', async () => {
  clearHeldSecrets()
  const body = { nodeLogin: { username: 'root', password: NODE_PW, nodes: ['node-a', 'node-b', 'node-c'] }, godaddy: { key: GD_KEY, secret: GD_SECRET }, extra: 'dropped' }
  const r = await call('POST', '/api/auth/setup-handoff', undefined, body, { 'x-setup-key': SETUP_KEY })
  assert.equal(r.statusCode, 200, r.body)
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

test('running one item: one node at a time, only where needed, audited without values, then checked', async () => {
  const cookie = await signIn('owner@example.com', 'owner master password')
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
  const cookie = await signIn('owner@example.com', 'owner master password')
  process.env.HPX_CHECKLIST_SETTLE_MS = '300'
  try {
    const a = await call('POST', '/api/setup-checklist/power/run', cookie)
    const b = await call('POST', '/api/setup-checklist/gpu/run', cookie)
    assert.equal(b.statusCode, 409)
    await waitJob(cookie, a.json().data.id)
  } finally { process.env.HPX_CHECKLIST_SETTLE_MS = '0' }
})

test('one node login for every node: tested on each, stored only where it worked', async () => {
  const cookie = await signIn('owner@example.com', 'owner master password')
  const bad = await call('PUT', '/api/setup-checklist/node-login', cookie, { username: 'root', password: 'wrong' })
  assert.deepEqual(bad.json().data.nodes.map((x: any) => x.ok), [false, false, false])
  assert.match(bad.json().data.nodes[0].reason, /was not accepted/)
  const good = await call('PUT', '/api/setup-checklist/node-login', cookie, { username: 'root', password: NODE_PW })
  assert.deepEqual(good.json().data.nodes.map((x: any) => x.ok), [true, true, true])
  assert.ok(!good.body.includes(MARK))
  assert.equal((await call('PUT', '/api/setup-checklist/node-login', cookie, { username: 'root' })).statusCode, 400)
})

test('a GoDaddy key is tested first, and a wrong one is an answer, not a stored secret', async () => {
  const cookie = await signIn('owner@example.com', 'owner master password')
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
  const cookie = await signIn('owner@example.com', 'owner master password')
  profilesStarted = []
  const r = await call('POST', '/api/setup-checklist/charts/run', cookie)
  await waitJob(cookie, r.json().data.id)
  assert.match(readFileSync(ENV, 'utf8'), /^COMPOSE_PROFILES=monitoring$/m)
  assert.deepEqual(profilesStarted, [['up', '-d', 'prometheus', 'grafana', 'pve-exporter']])
})

test('Grafana admin reset: set in Grafana, kept in the vault, never in the answer or in .env', async () => {
  const cookie = await signIn('owner@example.com', 'owner master password')
  // Re-confirmation first (the gate asks for it on this route).
  assert.equal((await call('POST', '/api/monitoring/grafana-admin/reset', cookie)).statusCode, 403)
  await call('POST', '/api/auth/reconfirm', cookie, { password: 'owner master password' })
  const r = await call('POST', '/api/monitoring/grafana-admin/reset', cookie)
  assert.equal(r.statusCode, 200, r.body)
  const pw = grafanaSet.at(-1)!
  assert.ok(pw.length >= 20)
  assert.equal(broker.items.get('hyperprox:system/grafana')!.fields.admin_password, pw)
  assert.ok(!r.body.includes(pw))
  assert.ok(!readFileSync(ENV, 'utf8').includes(pw))
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
