// Demo mode (src/demo): a separate entrypoint answering reads from invented fixtures.
//
//  1. The real entrypoint ignores HYPERPROX_DEMO: nothing src/index.ts loads reads the flag or reaches
//     src/demo, and the real gate with the flag set still starts locked and answers writes as it always does.
//  2. The demo never touches Prisma, the vault or the credential store: by its import graph, and at run
//     time with those modules replaced by traps that record any use.
//  3. Every write, reveal, Send, terminal and websocket is refused by the API with the demo message.
//  4. The start-up guard refuses a real install's environment, port and data directory.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import Module from 'node:module'

const SRC = path.resolve(__dirname, '../src')

// -- Import graph -----------------------------------------------------------------------------------------
/** Every module reachable from `entry` through relative imports, and the bare packages they name. */
function importGraph(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>(), packages = new Set<string>()
  const resolve = (from: string, spec: string): string | null => {
    const base = path.resolve(path.dirname(from), spec)
    for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.json`, path.join(base, 'index.ts')]) {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
    }
    return null
  }
  const walk = (file: string) => {
    if (files.has(file)) return
    files.add(file)
    if (!/\.tsx?$/.test(file)) return
    const src = fs.readFileSync(file, 'utf8')
    const re = /(?:import|export)\s[^'"`]*?from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g
    for (const m of src.matchAll(re)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4]
      if (spec.startsWith('.')) { const r = resolve(file, spec); if (r) walk(r) }
      else packages.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])
    }
  }
  walk(entry)
  return { files, packages }
}

const rel = (f: string) => path.relative(SRC, f)
const FORBIDDEN_FILES = [/^lib\/vault\//, /^lib\/credentials/, /^plugins\/prisma/, /^lib\/auth\.ts$/, /^lib\/gate/, /^lib\/api-tokens/, /^lib\/node-exec/, /^lib\/ssh-broker/, /^lib\/proxmox-client/]
const FORBIDDEN_PACKAGES = ['@prisma/client', 'prisma', 'dotenv', '@bitwarden/cli', 'ssh2', 'ioredis', 'bullmq', 'axios', '@anthropic-ai/sdk', 'acme-client']

test('real mode: nothing src/index.ts loads reads HYPERPROX_DEMO or reaches src/demo', () => {
  const g = importGraph(path.join(SRC, 'index.ts'))
  assert.ok(g.files.size > 50, `the walk should reach the real app (${g.files.size} files)`)
  const demo = [...g.files].filter(f => rel(f).startsWith('demo/'))
  assert.deepEqual(demo, [], 'the real entrypoint must not import demo code')
  const readers = [...g.files].filter(f => /\.tsx?$/.test(f) && fs.readFileSync(f, 'utf8').includes('HYPERPROX_DEMO'))
  assert.deepEqual(readers.map(rel), [], 'no real module may read the demo flag')
})

test('demo mode: its import graph holds no database, vault, credential store, gate or remote client', () => {
  const g = importGraph(path.join(SRC, 'demo', 'main.ts'))
  const outside = [...g.files].map(rel).filter(f => !f.startsWith('demo/'))
  assert.deepEqual(outside, [], 'the demo imports nothing from the real app')
  for (const f of g.files) assert.ok(!FORBIDDEN_FILES.some(r => r.test(rel(f))), rel(f))
  const bad = [...g.packages].filter(p => FORBIDDEN_PACKAGES.includes(p))
  assert.deepEqual(bad, [])
  assert.ok(![...g.packages].some(p => p.startsWith('node:') && /child_process/.test(p)))
})

// -- Run time: traps on Prisma, the vault and the credential store ----------------------------------------
const touched: string[] = []
const loaded: string[] = []
const M = Module as unknown as { _load: (req: string, parent: any, isMain: boolean) => any; _resolveFilename: (r: string, p: any) => string }
const origLoad = M._load
const TRAPS: Array<[RegExp, string]> = [
  [/^@prisma\/client$/, 'prisma'],
  [/[\\/]lib[\\/]vault[\\/]/, 'vault'],
  [/[\\/]lib[\\/]credentials(\.ts)?$/, 'credentials'],
  [/[\\/]plugins[\\/]prisma(\.ts)?$/, 'prisma'],
  [/^dotenv/, 'dotenv'],
]
/** A module whose every property, call and construction is recorded as a use. */
function trap(name: string): any {
  const handler: ProxyHandler<any> = {
    get: (_t, k) => { if (k === '__esModule' || k === 'then' || typeof k === 'symbol') return undefined; touched.push(`${name}.${String(k)}`); return new Proxy(function () {}, handler) },
    apply: () => { touched.push(`${name}()`); return undefined },
    construct: () => { touched.push(`new ${name}`); return {} },
  }
  return new Proxy(function () {}, handler)
}
M._load = function (request: string, parent: any, isMain: boolean) {
  let resolved = request
  try { resolved = request.startsWith('.') ? M._resolveFilename(request, parent) : request } catch { /* keep the bare name */ }
  loaded.push(resolved)
  for (const [re, name] of TRAPS) if (re.test(request) || re.test(resolved)) return trap(name)
  return origLoad.call(this, request, parent, isMain)
}
after(() => { M._load = origLoad })

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildDemoServer, DEMO_MESSAGE } = require('../src/demo/server') as typeof import('../src/demo/server')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { FIXTURES } = require('../src/demo/fixtures') as typeof import('../src/demo/fixtures')

/** A concrete URL for a fixture path: each :param gets a value the fixture knows. */
function sampleUrl(p: string): string {
  return p.replace(/:([a-zA-Z]+)/g, (_m, k) => ({
    id: 'c3f1a2b4c5d', node: 'pve-a', type: 'lxc', vmid: '201', domain: 'example.com', iid: 'ha-main', upid: 'UPID:pve-a:0001',
    jobId: 'demo-job', category: 'dns', provider: 'godaddy', what: 'log',
  } as Record<string, string>)[k] ?? 'x').replace('/*', '/x')
}

test('demo mode: every fixture read answers, with Prisma, the vault and the credential store never touched', async () => {
  const app = await buildDemoServer()
  try {
    let answered = 0
    for (const f of FIXTURES) {
      const url = sampleUrl(f.path)
      const res = await app.inject({ method: 'GET', url })
      if (f.refuse) { assert.equal(res.statusCode, 403, url); continue }
      assert.equal(res.statusCode, 200, `${url}: ${res.body.slice(0, 200)}`)
      assert.doesNotThrow(() => res.json(), url)
      answered++
    }
    assert.ok(answered >= 60, `fixtures answered: ${answered}`)
    const st = (await app.inject({ method: 'GET', url: '/api/auth/status', headers: { cookie: 'hyperprox_token=demo-session' } })).json()
    assert.equal(st.locked, false); assert.equal(st.demo, true); assert.equal(st.user.role, 'owner')
  } finally { await app.close() }
  assert.deepEqual(touched, [], 'Prisma, the vault or the credential store was used')
  const forbidden = loaded.filter(l => TRAPS.some(([re]) => re.test(l)) || FORBIDDEN_PACKAGES.includes(l))
  assert.deepEqual(forbidden, [], 'the demo loaded a forbidden module')
})

const WRITES: Array<[string, string]> = [
  ['POST', '/api/infra/vms/pve-a/201/lxc/stop'], ['POST', '/api/infra/vms/pve-a/201/lxc/migrate'],
  ['DELETE', '/api/proxmox/nodes/pve-a/lxc/201'], ['PUT', '/api/settings/dns/godaddy'],
  ['POST', '/api/secrets/reveal'], ['POST', '/api/secrets/send'], ['POST', '/api/secrets/generate'], ['POST', '/api/secrets'],
  ['POST', '/api/vpn/wg/peers/p1/reveal'], ['POST', '/api/vpn/wg/peers/p1/rotate'],
  ['POST', '/api/clusters/c3f1a2b4c5d/send'], ['POST', '/api/clusters/files/jobs'],
  ['POST', '/api/terminal/hosts/h1/enable-persistence'], ['PUT', '/api/terminal/layouts/main'], ['POST', '/api/terminal/credentials'],
  ['POST', '/api/updates/jobs'], ['POST', '/api/updates/check'], ['POST', '/api/catalogue/wizard/apply'],
  ['POST', '/api/dns/domains/example.com/records'], ['DELETE', '/api/dns/domains/example.com/records/A/www'],
  ['POST', '/api/proxy/hosts'], ['POST', '/api/certs/probe'], ['POST', '/api/auth/tokens'], ['POST', '/api/auth/lock'],
  ['POST', '/api/auth/bootstrap'], ['POST', '/api/plugins/home-assistant/instances/ha-main/devices/light.kitchen/toggle'],
  ['PATCH', '/api/settings/notifications/channels/n1'], ['POST', '/api/ai/actions/apply'], ['POST', '/api/remote/v1/machines/m1/tailscale/install'],
]

test('demo mode: every write, reveal, Send and action is refused in the API with the demo message', async () => {
  const app = await buildDemoServer()
  try {
    for (const [method, url] of WRITES) {
      for (const body of [undefined, '{"value":"x"}']) {
        const res = await app.inject({ method: method as any, url, payload: body, headers: body ? { 'content-type': 'application/json' } : {} })
        assert.equal(res.statusCode, 403, `${method} ${url}`)
        const j = res.json()
        assert.equal(j.code, 'demo'); assert.equal(j.ok, false); assert.equal(j.error, DEMO_MESSAGE)
      }
    }
    // An odd content type is refused the same way, not with a 415.
    const odd = await app.inject({ method: 'POST', url: '/api/secrets', payload: 'x', headers: { 'content-type': 'application/x-weird' } })
    assert.equal(odd.statusCode, 403)
    // Reads that would reveal or open something are refused too, and websockets as plain GETs.
    for (const url of ['/ws', '/ws/terminal/term', '/ws/updates']) assert.equal((await app.inject({ method: 'GET', url })).statusCode, 403, url)
    // A read the demo does not know is a 404, never a pass-through.
    assert.equal((await app.inject({ method: 'GET', url: '/api/not-a-route' })).statusCode, 404)
  } finally { await app.close() }
})

test('demo mode: a websocket upgrade (live feed, update log, terminal shell) is refused before any socket opens', async () => {
  const app = await buildDemoServer()
  await app.listen({ port: 0, host: '127.0.0.1' })
  try {
    const port = (app.server.address() as net.AddressInfo).port
    for (const p of ['/ws', '/ws/terminal/term?host=pve-a', '/ws/updates']) {
      const reply = await new Promise<string>((resolve, reject) => {
        const s = net.connect(port, '127.0.0.1', () => s.write(`GET ${p} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`))
        let buf = ''; s.on('data', d => { buf += d }); s.on('end', () => resolve(buf)); s.on('error', reject)
      })
      assert.match(reply, /^HTTP\/1\.1 403/, p)
      assert.ok(reply.includes('This is a demo'), p)
    }
  } finally { await app.close() }
})

test('demo mode: sign-in sets only the demo cookie; the vault reads as unlocked with the demo owner', async () => {
  const app = await buildDemoServer()
  try {
    const before = (await app.inject({ method: 'GET', url: '/api/auth/status' })).json()
    assert.equal(before.user, undefined); assert.equal(before.locked, false)
    const res = await app.inject({ method: 'POST', url: '/api/auth/sign-in', payload: { email: 'a@b.c', password: 'x', code: '123456' } })
    assert.equal(res.statusCode, 200)
    assert.match(String(res.headers['set-cookie']), /^hyperprox_token=demo-session;/)
  } finally { await app.close() }
})

// -- Start-up guard -----------------------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { checkDemoEnvironment, DemoRefused } = require('../src/demo/safety') as typeof import('../src/demo/safety')

test('demo guard: refuses without the flag, with a real install\'s settings, on a real port, or in the repo', () => {
  const root = path.resolve(__dirname, '../../..')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-demo-test-'))
  const ok = { HYPERPROX_DEMO: '1', HYPERPROX_DEMO_DATA: path.join(tmp, 'd'), PATH: '/usr/bin' }
  assert.equal(checkDemoEnvironment(ok, root).port, 3102)
  assert.equal(checkDemoEnvironment(ok, root).host, '127.0.0.1')
  assert.throws(() => checkDemoEnvironment({ ...ok, HYPERPROX_DEMO: undefined }, root), DemoRefused)
  assert.throws(() => checkDemoEnvironment({ ...ok, HYPERPROX_DEMO: 'true' }, root), DemoRefused)
  for (const k of ['DATABASE_URL', 'VAULT_URL', 'VAULT_KEYHOLDER_SOCKET', 'PROXMOX_TOKEN_SECRET', 'NPM_PASSWORD', 'GODADDY_API_KEY', 'REDIS_URL', 'ENV_FILE_PATH', 'SOMETHING_SECRET', 'JWT_SECRET']) {
    assert.throws(() => checkDemoEnvironment({ ...ok, [k]: 'value' }, root), (e: Error) => e instanceof DemoRefused && e.message.includes(k) && !e.message.includes('value'), k)
  }
  for (const port of ['3000', '3002', '80', 'x']) assert.throws(() => checkDemoEnvironment({ ...ok, HYPERPROX_DEMO_API_PORT: port }, root), DemoRefused, port)
  assert.throws(() => checkDemoEnvironment({ ...ok, HYPERPROX_DEMO_DATA: path.join(root, 'data') }, root), DemoRefused)
  fs.mkdirSync(path.join(tmp, 'busy')); fs.writeFileSync(path.join(tmp, 'busy', 'db.sqlite'), '')
  assert.throws(() => checkDemoEnvironment({ ...ok, HYPERPROX_DEMO_DATA: path.join(tmp, 'busy') }, root), DemoRefused)
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('real mode: with HYPERPROX_DEMO=1 set, the real gate still starts locked and answers as it always does', async () => {
  process.env.HYPERPROX_DEMO = '1'
  try {
    // Loaded the normal way (not through the traps), as the real API would.
    M._load = origLoad
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildTestApp, resetLock } = require('./fakes/app') as typeof import('./fakes/app')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { FakeBroker } = require('./fakes/fake-broker') as typeof import('./fakes/fake-broker')
    const app = await buildTestApp(new FakeBroker())
    try {
      const st = await app.inject({ method: 'GET', url: '/api/auth/status' })
      assert.equal(st.json().locked, true)
      assert.equal(st.json().demo, undefined)
      const read = await app.inject({ method: 'GET', url: '/api/proxmox/resources' })
      assert.equal(read.statusCode, 423)
      const write = await app.inject({ method: 'POST', url: '/api/proxmox/vms/pve-a/201/lxc/stop' })
      assert.equal(write.statusCode, 423)
      assert.notEqual(write.json().code, 'demo')
      const signIn = await app.inject({ method: 'POST', url: '/api/auth/sign-in', payload: { email: 'nobody@example.com', password: 'x', code: '000000' } })
      assert.notEqual(signIn.statusCode, 200, 'the real sign-in still checks credentials')
    } finally { await resetLock(); await app.close() }
  } finally { delete process.env.HYPERPROX_DEMO }
})
