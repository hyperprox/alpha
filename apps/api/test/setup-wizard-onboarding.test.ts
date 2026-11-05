// The setup wizard's question step, run for real: setup.js against a fake Proxmox (HTTPS, self-signed),
// fake nodes behind a stand-in SSH, a stand-in for docker/systemctl, and a fake API that receives the
// hand-over. A planted marker in the node login and the GoDaddy secret must reach the API's hand-over and
// nowhere else: not .env, not any file, not the wizard's logs, not any answer.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import https from 'node:https'
import http from 'node:http'
import vm from 'node:vm'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const setup = require('../../setup/setup.js')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const hw = require('../../../packages/hardware')

const MARK = `PLANTED-${Math.random().toString(36).slice(2)}-MARKER`
const PASSWORD = `pw-${MARK}`
const GD_SECRET = `gd-${MARK}`
const KEY = 'e'.repeat(64)
const dir = mkdtempSync(join(tmpdir(), 'hpx-wiz-'))
const envFile = join(dir, '.env')
const log = join(dir, 'runner.log')
const runLog = join(dir, 'run.log')
const hostKeys = join(dir, 'hostkeys.json')
const FP_A = 'SHA256:' + 'A'.repeat(43), FP_B = 'SHA256:' + 'B'.repeat(43)
writeFileSync(hostKeys, JSON.stringify({ '127.0.0.21': FP_A, '127.0.0.22': FP_B }))

// Fake Proxmox
execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
  '-subj', '/CN=pve', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore' })
const NODES = { 'node-a': '127.0.0.21', 'node-b': '127.0.0.22' }
const PCI: Record<string, unknown[]> = {
  'node-a': [{ class: '0x030000', vendor: '0x10de', device: '0x1b82', device_name: 'GP104 [GeForce GTX 1070 Ti]' }],
  'node-b': [{ class: '0x030000', vendor: '0x8086', device: '0x5912', device_name: 'HD Graphics 630' }],
}
const pve = https.createServer({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) }, (req, res) => {
  const p = (req.url ?? '').replace('/api2/json', '').split('?')[0]
  const data: any =
    p === '/version' ? { version: '9.1.0', release: '1' } :
    p === '/nodes' ? Object.keys(NODES).map(n => ({ node: n, status: 'online', maxcpu: 4, maxmem: 8e9 })) :
    p === '/cluster/status' ? [{ type: 'cluster', name: 'lab', quorate: 1 }, ...Object.entries(NODES).map(([n, ip]) => ({ type: 'node', name: n, ip }))] :
    p.endsWith('/hardware/pci') ? PCI[p.split('/')[2]] :
    p === '/cluster/resources' ? [] : null
  res.writeHead(data === null ? 404 : 200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ data }))
})
// Fake API: /health and the hand-over
let handoff: any = null, handoffKey = ''
const api = http.createServer((req, res) => {
  if (req.url === '/health') { res.end('{"status":"ok"}'); return }
  let b = ''; req.on('data', d => { b += d }); req.on('end', () => {
    handoff = JSON.parse(b); handoffKey = String(req.headers['x-setup-key'])
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, held: { nodeLogin: { nodes: handoff.nodeLogin?.nodes ?? [] }, godaddy: Boolean(handoff.godaddy) } }))
  })
})
const procs: ChildProcess[] = []
after(() => { procs.forEach(p => p.kill()); pve.close(); api.close() })
const listen = (s: any) => new Promise<number>(r => s.listen(0, '127.0.0.1', () => r(s.address().port)))

let PORT = 0, out = ''
const ready = (async () => {
  const pvePort = await listen(pve), apiPort = await listen(api)
  writeFileSync(envFile, `SETUP_SECRET=${KEY}\nPROXMOX_HOST=127.0.0.1\nPROXMOX_PORT=${pvePort}\nPROXMOX_USER=root@pam\nPROXMOX_TOKEN_ID=hyperprox\nPROXMOX_TOKEN_SECRET=tok\nINSTALL_PROMETHEUS=false\nINSTALL_GRAFANA=false\nCOMPOSE_PROFILES=\nSETUP_COMPLETE=false\n`)
  writeFileSync(join(dir, 'run-stub.sh'), `#!/bin/bash\necho "$*" >> ${runLog}\nexit 0\n`, { mode: 0o755 })
  PORT = 41000 + Math.floor(Math.random() * 1000)
  const p = spawn(process.execPath, [join(__dirname, '..', '..', 'setup', 'setup.js')], {
    env: { ...process.env, SETUP_PORT: String(PORT), SETUP_BIND: '127.0.0.1', ENV_FILE_PATH: envFile, SETUP_COMPLETE: 'false',
      HYPERPROX_DIR: dir, API_PORT: String(apiPort), HPX_SETUP_RUN: join(dir, 'run-stub.sh'), HPX_SETUP_FAKE_GODADDY: '1',
      HPX_SETUP_NODE_RUNNER: join(__dirname, 'fakes', 'setup-node-runner.js'), HPX_TEST_LOG: log, HPX_TEST_PASSWORD: PASSWORD,
      HPX_TEST_NODES: JSON.stringify({ '127.0.0.21': 'nvidia-dedicated', '127.0.0.22': 'fresh-intel-node' }),
      HPX_TEST_NAMES: JSON.stringify({ '127.0.0.21': 'node-a', '127.0.0.22': 'node-b' }),
      HPX_SETUP_VERIFY_MS: '0', HPX_SETUP_EXIT_MS: '400', NODE_ENV: 'test', HPX_TEST_HOSTKEYS: hostKeys },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  p.stdout!.on('data', d => { out += d }); p.stderr!.on('data', d => { out += d })
  procs.push(p)
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break } catch {} ; await new Promise(r => setTimeout(r, 100)) }
})()
const answers: string[] = []
async function call(method: string, route: string, body?: unknown) {
  await ready
  const r = await fetch(`http://127.0.0.1:${PORT}/api/setup/${route}`, { method, headers: { 'x-setup-key': KEY, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  const t = await r.text(); answers.push(t)
  return { status: r.status, body: JSON.parse(t) }
}
const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []

test('the page asks for the node login once, in plain words, and still compiles', () => {
  const html: string = setup.WIZARD_HTML
  for (const src of [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])) assert.doesNotThrow(() => new vm.Script(src))
  assert.match(html, /Sign in to your nodes, once/)
  assert.match(html, /never written to a file/)
  assert.match(html, /Do you want charts and dashboards \(Prometheus and Grafana\)\?/)
})

test('hardware: what was found, from Proxmox alone, and only the questions that apply', async () => {
  const r = await call('GET', 'hardware')
  assert.equal(r.status, 200)
  assert.equal(r.body.summary, 'Found 2 nodes. node-a: NVIDIA GeForce GTX 1070 Ti (dedicated). node-b: Intel HD Graphics 630 (built in).')
  assert.deepEqual(r.body.questions.map((q: any) => q.id), ['node-health', 'power', 'gpu', 'igpu-access', 'charts', 'dns', 'ai'], 'charts off: no Proxmox-metrics question (charts itself is asked on the Services step)')
  assert.equal(calls().length, 0, 'no SSH before a login is given')
})

test('the node login: tested on every node, refused when wrong, held only in memory', async () => {
  const bad = await call('POST', 'node-login', { username: 'root', password: 'wrong' })
  assert.equal(bad.body.ok, false)
  assert.deepEqual(bad.body.nodes.map((n: any) => n.reason), ['that login was not accepted', 'that login was not accepted'])
  const good = await call('POST', 'node-login', { username: 'root', password: PASSWORD })
  assert.equal(good.body.ok, true)
  assert.deepEqual(good.body.nodes.map((n: any) => n.ok), [true, true])
  assert.deepEqual(good.body.nodes.map((n: any) => n.fingerprint), [FP_A, FP_B], 'host keys pinned on first connection and shown')
  assert.ok(!readFileSync(envFile, 'utf8').includes(MARK))
})

test('apply: probes over the login, then one step at a time, only where needed, and checks from here', async () => {
  await call('POST', 'apply', { answers: { 'node-health': true, power: true, gpu: true, ai: false, bogus: true } })
  let job: any
  for (let i = 0; i < 100; i++) { job = (await call('GET', 'apply-status')).body.job; if (job.status !== 'running') break; await new Promise(r => setTimeout(r, 100)) }
  assert.equal(job.status, 'done', JSON.stringify(job))
  assert.equal(job.summary, 'Found 2 nodes. node-a: NVIDIA GeForce GTX 1070 Ti (dedicated); health monitoring already running. node-b: Intel HD Graphics 630 (built in). Ceph storage found.')
  const steps = calls().filter(c => c.kind === 'step').map(c => `${c.node}:${c.step}`)
  assert.deepEqual(steps, ['node-b:node_exporter', 'node-b:Power', 'node-b:Intel GPU'])
  assert.deepEqual(job.results.map((r: any) => r.status), ['done', 'done', 'done'])
  assert.ok(job.checks.length > 0 && job.checks.every((c: any) => typeof c.reason === 'string' && c.reason.length))
})

test('a node whose host key changes during setup is refused, before anything is sent to it', async () => {
  writeFileSync(hostKeys, JSON.stringify({ '127.0.0.21': FP_A, '127.0.0.22': 'SHA256:' + 'C'.repeat(43) }))
  try {
    const before = calls().filter(c => c.kind === 'step').length
    await call('POST', 'apply', { answers: { 'node-health': true, power: true, gpu: true } })
    let job: any
    for (let i = 0; i < 100; i++) { job = (await call('GET', 'apply-status')).body.job; if (job.status !== 'running') break; await new Promise(r => setTimeout(r, 100)) }
    const b = job.results.filter((r: any) => r.node === 'node-b')
    assert.ok(b.length && b.every((r: any) => r.status === 'failed' && /host key of 127\.0\.0\.22 changed during setup/.test(r.reason)), JSON.stringify(job.results))
    assert.equal(calls().filter(c => c.kind === 'step').length, before, 'no step ran on either node: node-a needs nothing, node-b was refused')
  } finally { writeFileSync(hostKeys, JSON.stringify({ '127.0.0.21': FP_A, '127.0.0.22': FP_B })) }
})

test('the test hooks are honoured only under NODE_ENV=test', () => {
  const src = readFileSync(join(__dirname, '..', '..', 'setup', 'setup.js'), 'utf8')
  for (const v of ['HPX_SETUP_NODE_RUNNER', 'HPX_SETUP_FAKE_GODADDY', 'HPX_SETUP_RUN']) {
    const uses = src.split('\n').filter(l => l.includes(`process.env.${v}`))
    assert.ok(uses.length > 0, v)
    for (const l of uses) assert.match(l, /TESTING &&/, `${v}: ${l.trim()}`)
  }
  assert.match(src, /const TESTING = process\.env\.NODE_ENV === 'test'/)
})

test('a GoDaddy key: checked, held in memory, never written to .env', async () => {
  assert.equal((await call('POST', 'save-providers', { providers: { godaddy: { enabled: true, key: 'bad', secret: 'x' } } })).status, 400)
  const ok = await call('POST', 'save-providers', { providers: { godaddy: { enabled: true, key: 'gd-key', secret: GD_SECRET } } })
  assert.equal(ok.body.ok, true)
  const env = readFileSync(envFile, 'utf8')
  assert.doesNotMatch(env, /GODADDY_API/)
  assert.ok(!env.includes(MARK))
  assert.deepEqual((await call('GET', 'state')).body.providers, { godaddy: { enabled: true } })
})

test('finish: targets from what was found, the API gets the held secrets, the setup key leaves .env, and nothing leaked', async () => {
  const r = await call('POST', 'complete', { answers: { 'node-health': true, power: true, gpu: true, ai: true } })
  assert.equal(r.body.ok, true)
  let finish: any
  for (let i = 0; i < 100; i++) {
    try { finish = (await call('GET', 'finish-status')).body.finish } catch { break }
    if (finish && finish.status !== 'running') break
    await new Promise(res => setTimeout(res, 100))
  }
  assert.match(finish.status, /^done/)
  const labels = finish.checklist.map((c: any) => `${c.label}:${c.status}`)
  assert.ok(labels.includes('Metrics list:done') && labels.includes('Services:done') && labels.includes('Local AI:done') && labels.includes('Your keys:done'), labels.join(' '))
  const t = (f: string) => JSON.parse(readFileSync(join(dir, 'config/prometheus/targets', f), 'utf8'))
  assert.deepEqual(t('nvidia.json'), [{ targets: ['127.0.0.21:9835'], labels: { node: 'node-a' } }])
  assert.deepEqual(t('intel-gpu.json'), [{ targets: ['127.0.0.22:8081'], labels: { node: 'node-b' } }])
  // The hand-over: what was held, to the API, with the setup key.
  assert.equal(handoffKey, KEY)
  assert.equal(handoff.nodeLogin.password, PASSWORD)
  assert.deepEqual(handoff.nodeLogin.hostKeys, { 'node-a': { address: '127.0.0.21', fingerprint: FP_A }, 'node-b': { address: '127.0.0.22', fingerprint: FP_B } })
  assert.deepEqual(handoff.nodeLogin.nodes, ['node-a', 'node-b'])
  assert.deepEqual(handoff.godaddy, { key: 'gd-key', secret: GD_SECRET })
  const env = readFileSync(envFile, 'utf8')
  assert.doesNotMatch(env, /^SETUP_SECRET=/m, 'the setup key is gone once setup is done')
  assert.match(env, /^SETUP_COMPLETE=true$/m)
  assert.match(env, /^COMPOSE_PROFILES=ai$/m)
  assert.match(readFileSync(runLog, 'utf8'), /docker compose up -d --remove-orphans[\s\S]*systemctl restart hyperprox-api hyperprox-frontend/)
  // Planted markers: only the hand-over carried them.
  const hits: string[] = []
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : (readFileSync(p, 'utf8').includes(MARK) && hits.push(p)) } }
  walk(dir)
  if (out.includes(MARK)) hits.push('wizard logs')
  answers.forEach((a, i) => { if (a.includes(MARK)) hits.push(`answer ${i}`) })
  assert.deepEqual(hits, [])
  assert.ok(hw.QUESTIONS.length)
})
