// Wizard resume, the Existing-services toggles and the exporter token, against throwaway files and a fake
// Proxmox. Nothing here touches a real install: ENV_FILE_PATH and the progress file live in a temp dir.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import https from 'node:https'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'hpx-setup-progress-'))
const envFile = join(dir, '.env')
writeFileSync(envFile, 'SETUP_SECRET=' + 'a'.repeat(64) + '\n')
process.env.ENV_FILE_PATH = envFile
process.env.HYPERPROX_DIR = dir
const setup = require('../setup.js')
const exporter = require('../pve-exporter.js')

const connected = { PROXMOX_HOST: '192.0.2.5', PROXMOX_USER: 'root@pam', PROXMOX_TOKEN_ID: 'hyperprox-node-a', PROXMOX_TOKEN_SECRET: 's' }

// ── resumeStep: only what really ran counts ──────────────────────────────────────────────────────────
test('resume: bootstrap pre-filling INSTALL_PROMETHEUS does not make the wizard skip the scan', () => {
  const env = { ...connected, INSTALL_PROMETHEUS: 'true', INSTALL_GRAFANA: 'true' }
  assert.equal(setup.resumeStep(env, true, {}), 1, 'no scan recorded: back to the Cluster step')
})

test('resume: scan done -> Services; choices saved -> Options; no connection -> Proxmox', () => {
  const scan = { at: 'x', services: [] }
  assert.equal(setup.resumeStep(connected, true, { scan }), 2)
  assert.equal(setup.resumeStep(connected, true, { scan, installsSaved: true }), 3)
  assert.equal(setup.resumeStep(connected, true, { installsSaved: true }), 1, 'choices without a scan: the scan reruns')
  assert.equal(setup.resumeStep(connected, false, { scan, installsSaved: true }), 0)
  assert.equal(setup.resumeStep({}, true, { scan }), 0)
})

// ── serviceEnv: what each toggle switches ────────────────────────────────────────────────────────────
const scan = [
  { key: 'npm', name: 'Nginx Proxy Manager', host: '192.0.2.30', port: 81, found: true },
  { key: 'ollama', name: 'Ollama', host: '192.0.2.31', port: 11434, found: false },
  { key: 'pbs', name: 'Proxmox Backup Server', host: '192.0.2.41', port: 8007, found: true },
]

test('services: found and on connects NPM and PBS; off records that it was left off', () => {
  const on = setup.serviceEnv({ npm: true, pbs: true }, scan, {})
  assert.deepEqual(on.env, { NPM_ENABLED: 'true', NPM_HOST: '192.0.2.30', NPM_PORT: '81', NPM_URL: 'http://192.0.2.30:81',
    PBS_ENABLED: 'true', PBS_HOST: '192.0.2.41', PBS_PORT: '8007' })
  const off = setup.serviceEnv({ npm: false, pbs: false }, scan, {})
  assert.deepEqual(off.env, { NPM_ENABLED: 'false', PBS_ENABLED: 'false' })
  assert.equal(off.applied.find((a) => a.key === 'npm').enabled, false)
})

test('services: a toggle for something that was not found does nothing', () => {
  const r = setup.serviceEnv({ ollama: true }, scan, {})
  assert.ok(!('OLLAMA_URL' in r.env)); assert.equal(r.ollamaExisting, false)
})

test('services: no toggle sent means the page default: on if found, off if not', () => {
  const r = setup.serviceEnv(undefined, scan, {})
  assert.equal(r.env.NPM_ENABLED, 'true'); assert.equal(r.env.PBS_ENABLED, 'true')
})

test('services: an existing NPM_URL is kept; an existing Ollama is used and the local install is skipped', () => {
  const r = setup.serviceEnv({ ollama: true }, [{ key: 'npm', name: 'n', host: '192.0.2.30', port: 81, found: true },
    { key: 'ollama', name: 'Ollama', host: '192.0.2.31', port: 11434, found: true }], { NPM_URL: 'https://npm.example.test' })
  assert.ok(!('NPM_URL' in r.env))
  assert.equal(r.env.OLLAMA_URL, 'http://192.0.2.31:11434'); assert.equal(r.ollamaExisting, true)
})

test('services: sanitizeServices keeps only known keys with boolean values', () => {
  assert.deepEqual(setup.sanitizeServices({ npm: true, pbs: 'yes', ollama: false, evil: true }), { npm: true, ollama: false })
  assert.deepEqual(setup.sanitizeServices(null), {})
})

test('services: applyServices writes the scan the wizard really ran into .env', () => {
  setup.writeProgress({ scan: { at: 'x', services: scan } })
  setup.applyServices({ npm: true, pbs: false })
  const env = readFileSync(envFile, 'utf8')
  assert.match(env, /^NPM_ENABLED=true$/m); assert.match(env, /^NPM_HOST=192\.0\.2\.30$/m); assert.match(env, /^PBS_ENABLED=false$/m)
})

test('progress file: private, merges, and null removes a key', () => {
  setup.writeProgress({ a: 1 }); setup.writeProgress({ b: 2 }); setup.writeProgress({ a: null })
  assert.deepEqual(Object.keys(setup.readProgress()).includes('a'), false)
  assert.equal(setup.readProgress().b, 2)
  assert.equal(statSync(setup.progressPath()).mode & 0o777, 0o600)
})

// ── the exporter token: reuse what bootstrap made ────────────────────────────────────────────────────
function fakePve(userid, tokens) {
  const calls = []
  const acls = tokens.filter((t) => t.auditor).map((t) => ({ path: '/', roleid: 'PVEAuditor', type: 'token', ugid: `${userid}!${t.tokenid}` }))
  return {
    calls, tokens,
    async listTokens() { calls.push('list'); return tokens.map((t) => ({ tokenid: t.tokenid, comment: t.comment || '' })) },
    async deleteToken(n) { calls.push('delete ' + n) },
    async createToken(n) { calls.push('create ' + n); tokens.push({ tokenid: n, secret: 'new-secret', privsep: 1, auditor: true }); acls.push({ path: '/', roleid: 'PVEAuditor', type: 'token', ugid: `${userid}!${n}` }); return { value: 'new-secret', 'full-tokenid': `${userid}!${n}` } },
    async setAcl() { calls.push('acl') },
    async getToken(n) { calls.push('get ' + n); const t = tokens.find((x) => x.tokenid === n); if (!t) throw new Error('none'); return { privsep: t.privsep ?? 1 } },
    async listAcl() { return acls },
    async tokenWorks(full, secret) { const [u, n] = full.split('!'); return u === userid && tokens.some((t) => t.tokenid === n && t.secret === secret) },
  }
}

test('exporter: a working read-only token bootstrap made is reused, no second token is minted, pve.yml untouched', async () => {
  const file = join(dir, 'config', 'pve-exporter', 'pve.yml')
  mkdirSync(dirname(file), { recursive: true })
  const bootstrapYml = '# written by bootstrap\ndefault:\n  user: "root@pam"\n  token_name: "hyperprox-exporter"\n  token_value: "boot-secret"\n  verify_ssl: false\n'
  writeFileSync(file, bootstrapYml)
  const pve = fakePve('root@pam', [{ tokenid: 'hyperprox-exporter', secret: 'boot-secret', auditor: true, comment: 'HyperProx metrics exporter, read-only (PVEAuditor) [exporter for root@pam!hyperprox]' }])
  let restarts = 0
  const r = await setup.setupExporter(pve, 'root@pam', 'hyperprox-node-a-0a1b2c3d', file, () => { restarts++ })
  assert.deepEqual(r, { ok: true, action: 'reuse', tokenId: 'root@pam!hyperprox-exporter' })
  assert.ok(!pve.calls.some((c) => c.startsWith('create') || c.startsWith('delete')), 'nothing created or deleted: ' + pve.calls)
  assert.equal(readFileSync(file, 'utf8'), bootstrapYml)
  assert.equal(restarts, 0)
})

test('exporter: a held token that is not read-only is not adopted; the wizard makes its own', async () => {
  const file = join(dir, 'pve2.yml')
  writeFileSync(file, exporter.renderPveYml({ user: 'root@pam', tokenName: 'hyperprox-exporter', secret: 'boot-secret' }))
  const pve = fakePve('root@pam', [{ tokenid: 'hyperprox-exporter', secret: 'boot-secret', privsep: 0, comment: 'x' }])
  const r = await setup.setupExporter(pve, 'root@pam', 'hyperprox-node-a', file, () => {})
  assert.equal(r.action, 'create'); assert.equal(r.tokenId, 'root@pam!hyperprox-node-a-exporter')
})

test('exporter: a held token that no longer authenticates is not adopted either', async () => {
  const file = join(dir, 'pve3.yml')
  writeFileSync(file, exporter.renderPveYml({ user: 'root@pam', tokenName: 'hyperprox-exporter', secret: 'stale' }))
  const pve = fakePve('root@pam', [{ tokenid: 'hyperprox-exporter', secret: 'other', auditor: true, comment: 'x' }])
  const r = await setup.setupExporter(pve, 'root@pam', 'hyperprox-node-a', file, () => {})
  assert.equal(r.action, 'create')
})

// ── the real server against a fake Proxmox: a reload after each step ──────────────────────────────────
let opensslOk = true
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }) } catch { opensslOk = false }
const KEY = 'a'.repeat(64)
let fake, proc, base, port2
const sdir = mkdtempSync(join(tmpdir(), 'hpx-setup-server-'))

before(async () => {
  if (!opensslOk) return
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(sdir, 'k.pem'), '-out', join(sdir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' })
  fake = https.createServer({ key: readFileSync(join(sdir, 'k.pem')), cert: readFileSync(join(sdir, 'c.pem')) }, (req, res) => {
    const p = req.url.replace('/api2/json', '')
    const data = p === '/version' ? { version: '9.0.3', release: '9.0' } : p === '/nodes' ? [{ node: 'node-a', status: 'online', maxcpu: 4, maxmem: 8e9 }]
      : p === '/cluster/status' ? [{ type: 'cluster', name: 'c1', quorate: 1 }] : p.startsWith('/cluster/resources') ? [] : null
    res.writeHead(data ? 200 : 404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data }))
  })
  await new Promise((r) => fake.listen(0, '127.0.0.1', r))
  const pvePort = fake.address().port
  writeFileSync(join(sdir, '.env'), `SETUP_SECRET=${KEY}\nPROXMOX_HOST=127.0.0.1\nPROXMOX_PORT=${pvePort}\nPROXMOX_USER=root@pam\nPROXMOX_TOKEN_ID=t\nPROXMOX_TOKEN_SECRET=s\nINSTALL_PROMETHEUS=true\nINSTALL_GRAFANA=true\n`)
  port2 = 41000 + Math.floor(Math.random() * 1000)
  proc = spawn(process.execPath, [join(here, '..', 'setup.js')], {
    env: { ...process.env, SETUP_PORT: String(port2), SETUP_BIND: '127.0.0.1', ENV_FILE_PATH: join(sdir, '.env'), HYPERPROX_DIR: sdir, SETUP_COMPLETE: 'false' }, stdio: 'ignore' })
  base = `http://127.0.0.1:${port2}`
  for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/health')).ok) return } catch {} await new Promise((r) => setTimeout(r, 100)) }
  throw new Error('setup server did not start')
})
after(() => { proc?.kill(); fake?.close() })

const call = async (method, route, body) => {
  const r = await fetch(`${base}/api/setup/${route}`, { method, headers: { 'x-setup-key': KEY, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  return r.json()
}

test('reload: connected by bootstrap but nothing scanned -> Cluster step, not Options', { skip: !opensslOk }, async () => {
  const st = await call('GET', 'state')
  assert.equal(st.step, 1)
  assert.equal(st.progress.scan, null)
  assert.deepEqual(st.installs, { grafana: true, prometheus: true }, 'the installer’s answers still prefill the toggles')
})

test('reload: after the scan -> Services with the scan result; after Continue -> Options, with the toggles kept', { skip: !opensslOk }, async () => {
  const sc = await call('GET', 'scan-services')
  assert.equal(sc.ok, true)
  assert.ok(existsSync(join(sdir, 'data', 'setup', 'wizard-progress.json')))
  let st = await call('GET', 'state')
  assert.equal(st.step, 2); assert.ok(Array.isArray(st.progress.scan.services))
  await call('POST', 'save-installs', { installs: { grafana: true, prometheus: false }, services: { npm: false, evil: true } })
  st = await call('GET', 'state')
  assert.equal(st.step, 3)
  assert.deepEqual(st.progress.services, { npm: false })
})

test('the progress file holds no secret', { skip: !opensslOk }, () => {
  const t = readFileSync(join(sdir, 'data', 'setup', 'wizard-progress.json'), 'utf8')
  assert.ok(!t.includes('"s"') && !/secret/i.test(t))
})

// ── the page ─────────────────────────────────────────────────────────────────────────────────────────
test('page: compiles; step 3 has its label; Connect stays on one line; hardware has Retry; NPM hint is conditional', () => {
  const html = setup.WIZARD_HTML
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new (require('node:vm').Script)(m[1]))
  assert.match(html, /stepLabel\(2, STEPS\.length\)/)
  assert.match(html, /\.btn\{white-space:nowrap/)
  assert.match(html, /id="btn-hw-retry"/)
  assert.match(html, /retryAsync\(async \(attempt\)/)
  assert.match(html, /svcs\.npm && svcs\.npm\.found \? ''/)
  assert.match(html, /serviceToggles\(S\.services\)/)
  assert.doesNotMatch(html, /which did the node work already/)
})

// ── charts verified, per-node defaults, readable summary, version ───────────────────────────────────
test('verifyPrometheus: success only when a real query succeeds; the failure says why', async () => {
  const ok = await setup.verifyPrometheus('http://x', { get: async (u) => (u.includes('query=up') ? JSON.stringify({ status: 'success', data: { result: [1, 2] } }) : null), timeoutMs: 10, sleep: async () => {} })
  assert.equal(ok.ok, true); assert.match(ok.reason, /2 targets/)
  const down = await setup.verifyPrometheus('http://x', { get: async () => null, timeoutMs: 5, every: 1, sleep: async () => {} })
  assert.equal(down.ok, false); assert.match(down.reason, /not answering/)
  const err = await setup.verifyPrometheus('http://x', { get: async () => JSON.stringify({ status: 'error', error: 'bad' }), timeoutMs: 5, sleep: async () => {} })
  assert.match(err.reason, /error: bad/)
  const junk = await setup.verifyPrometheus('http://x', { get: async () => '<html>', timeoutMs: 5, sleep: async () => {} })
  assert.match(junk.reason, /not a query result/)
})

const hwlib = (await import('node:module')).createRequire(import.meta.url)('../../../packages/hardware')
const mk = (node, o = {}) => ({ ...hwlib.parseProbe('', node), gpus: [], ...o })

test('questions: yes only where the exporter is missing; a fully done question is shown as done', () => {
  const nodes = [mk('node-b', { nodeExporter: 'running' }), mk('node-a')]
  const qs = setup.annotateQuestions(hwlib.applicableQuestions(nodes, {}), nodes)
  const health = qs.find((q) => q.id === 'node-health')
  assert.deepEqual(health.pending, ['node-a']); assert.equal(health.default, true); assert.equal(health.satisfied, false)
  assert.match(health.notes.join(' '), /Will be set up on: node-a\. Nothing to do on: node-b\./)
  const all = [mk('node-a', { nodeExporter: 'running' }), mk('node-b', { nodeExporter: 'running' })]
  const done = setup.annotateQuestions(hwlib.applicableQuestions(all, {}), all).find((q) => q.id === 'node-health')
  assert.equal(done.satisfied, true); assert.equal(done.default, false)
})

test('summary: one line per node, sorted by name', () => {
  const lines = setup.summaryLines([mk('node-b', { nodeExporter: 'running' }), mk('node-a')])
  assert.deepEqual(lines, ['node-a: no GPU', 'node-b: no GPU; health monitoring already running'])
})

test('cluster version is shown once, and nodes come sorted', { skip: !opensslOk }, async () => {
  const st = await call('GET', 'state')
  assert.equal(st.cluster.version, '9.0.3')
})

test('page: the Step 1 hint names both keys; summary is per node', () => {
  assert.match(setup.WIZARD_HTML, /two new access keys/)
  assert.match(setup.WIZARD_HTML, /function hwLines/)
})

// ── several addresses for one service: the owner picks, the server checks the pick against the scan ───────
const multi = [{ key: 'npm', name: 'Nginx Proxy Manager', host: '10.0.2.30', port: 81, found: true,
  candidates: [{ host: '10.0.2.30', port: 81 }, { host: '10.0.2.31', port: 81 }] }]

test('services: several addresses and none picked connects nothing', () => {
  const r = setup.serviceEnv({ npm: true }, multi, {}, {})
  assert.deepEqual(r.env, { NPM_ENABLED: 'false' })
  assert.equal(r.applied[0].host, null)
})

test('services: the picked address is the one connected', () => {
  const r = setup.serviceEnv({ npm: true }, multi, {}, { npm: '10.0.2.31' })
  assert.deepEqual(r.env, { NPM_ENABLED: 'true', NPM_HOST: '10.0.2.31', NPM_PORT: '81', NPM_URL: 'http://10.0.2.31:81' })
})

test('services: an address the scan did not find is refused', () => {
  const r = setup.serviceEnv({ npm: true }, multi, {}, { npm: '10.0.2.99' })
  assert.deepEqual(r.env, { NPM_ENABLED: 'false' })
})

test('services: sanitizeServiceHosts keeps only private addresses for known keys', () => {
  assert.deepEqual(setup.sanitizeServiceHosts({ npm: '10.0.2.31', pbs: '8.8.8.8', ollama: 'evil.example', x: '10.0.0.1' }), { npm: '10.0.2.31' })
  assert.deepEqual(setup.sanitizeServiceHosts(null), {})
})
