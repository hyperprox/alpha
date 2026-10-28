// The MeshCentral provider: the origin check replayed (CheckWebServerOriginName, keys case-insensitive),
// the pre-flight and the allowedOrigin fix it offers, detection from what a guest reports, and verify()
// against a pretend guest and pretend public URL. Hostnames are example.com / .lan; nothing here is real.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import type { AppContext, AppInstall } from '../src/lib/plugin-host'
import {
  ORIGIN_CHECK_SINCE, type MeshFacts, ciGet, fixFor, meshcentralProvider as P, originVerdict, proposedAllowedOrigin, withAllowedOrigin,
} from '../src/plugins/meshcentral'
import type { NpmInstall } from '../src/lib/app-updates/npm-app'

const e = (s: string) => Buffer.from(s).toString('base64')
const PUBLIC = 'mesh.example.com'

const NPM: NpmInstall = {
  dir: '/opt/meshcentral', pkg: 'meshcentral', installed: '1.1.53', spec: '1.1.53', exact: true, section: 'dependencies', owner: 'mesh',
  unit: 'meshcentral.service', unitUser: 'mesh', active: true, mainPid: 100, nodeBin: '/usr/bin/node',
  command: '/usr/bin/node /opt/meshcentral/node_modules/meshcentral', files: {},
}

function facts(config: any, over: Partial<MeshFacts> = {}): MeshFacts {
  const configText = config === null ? null : JSON.stringify(config, null, 2)
  return {
    npm: NPM, datapath: '/opt/meshcentral/meshcentral-data', dataDir: '/opt/meshcentral/meshcentral-data', configFile: '/opt/meshcentral/meshcentral-data/config.json',
    configText, config, certName: 'mesh.lan', port: 4430, errLog: { size: 0, mtime: 0 }, ...over,
  }
}
const install = (f: MeshFacts, installed = '1.1.53'): AppInstall => ({
  key: 'abcdef123456', name: 'MeshCentral', installed, location: f.npm.dir, runAs: 'mesh', service: f.npm.unit,
  running: true, how: '', facts: f as any,
})

interface Guest {
  version: string
  states: string[]            // HP_STATE answers, last repeats
  errSize: number[]           // mesherrors.txt size per read, last repeats
  errTail: string
  page: { status: number; body: string } | Error
  ws: { upgraded: boolean; status: number; firstMessage: string | null; error?: string }
  options: Record<string, string>
  proxied: string[]
}

function ctxFor(g: Guest): AppContext & { scripts: string[]; probes: any[] } {
  const next = <T>(a: T[]) => (a.length > 1 ? a.shift()! : a[0])
  const c: any = {
    scripts: [], probes: [], t: 0,
    guest: { vmid: 205, name: 'mesh', node: 'node-a', type: 'lxc' },
    async run(script: string) {
      c.scripts.push(script)
      if (script.includes('HP_STATE')) return { code: 0, output: `HP_STATE ${next(g.states)}\n`, timedOut: false }
      if (script.includes('HP_ERRLOG')) return { code: 0, output: `HP_CN ${e('mesh.lan')}\nHP_ERRLOG ${next(g.errSize)} 1\n`, timedOut: false }
      if (script.includes('tail -c +')) return { code: 0, output: g.errTail, timedOut: false }
      if (script.includes('HP_FILE')) return { code: 0, output: `HP_OWNER ${e('mesh')}\nHP_FILE package -\nHP_FILE installed ${e(JSON.stringify({ version: g.version }))}\n`, timedOut: false }
      return { code: 0, output: 'HP_RESTARTED\n', timedOut: false }
    },
    option: (k: string) => g.options[k],
    fetchJson: async () => { throw new Error('offline') },
    async http(url: string, opts: any) { c.probes.push(['http', url, opts?.headers?.Origin]); if (g.page instanceof Error) throw g.page; return { ...g.page, headers: {} } },
    async wsProbe(url: string, opts: any) { c.probes.push(['ws', url, opts?.origin]); return g.ws },
    proxiedUrls: async () => g.proxied,
    log: () => {},
    now: () => c.t,
    sleep: async (ms: number) => { c.t += ms },
  }
  return c
}

const guest = (over: Partial<Guest> = {}): Guest => ({
  version: '1.3.1', states: ['active 200 0'], errSize: [0], errTail: '',
  page: { status: 200, body: '<title>MeshCentral - Login</title>' },
  ws: { upgraded: true, status: 101, firstMessage: '{"action":"close","cause":"noauth","msg":"noauth"}' },
  options: { public_url: `https://${PUBLIC}/` }, proxied: [], ...over,
})

// --- the origin check -------------------------------------------------------------------------

test('originVerdict follows CheckWebServerOriginName: list, true, dns, certificate name, Host header', () => {
  assert.equal(originVerdict({}, 'mesh.lan', PUBLIC).ok, false)
  assert.equal(originVerdict({}, PUBLIC, PUBLIC).ok, true)
  assert.equal(originVerdict({}, 'un-configured', PUBLIC).ok, true)
  assert.equal(originVerdict({ domains: { '': { allowedOrigin: [PUBLIC] } } }, 'mesh.lan', PUBLIC).ok, true)
  // Once a list exists only the list counts: the certificate name no longer gets in on its own.
  assert.equal(originVerdict({ domains: { '': { allowedOrigin: ['other.example.com'] } } }, PUBLIC, PUBLIC).ok, false)
  assert.equal(originVerdict({ domains: { '': { allowedorigin: true } } }, 'mesh.lan', PUBLIC).ok, true)
  assert.equal(originVerdict({ domains: { '': {}, customer: { dns: PUBLIC } } }, 'mesh.lan', PUBLIC).ok, true)
  // A string is not a list: MeshCentral ignores it and falls through to the certificate name.
  assert.equal(originVerdict({ domains: { '': { allowedOrigin: PUBLIC } } }, 'mesh.lan', PUBLIC).ok, false)
})

test('config keys are case-insensitive, as MeshCentral lower-cases them; list entries are not', () => {
  assert.equal(originVerdict({ Domains: { '': { AllowedOrigin: [PUBLIC] } } }, 'mesh.lan', PUBLIC).ok, true)
  assert.equal(originVerdict({ DOMAINS: { '': { ALLOWEDORIGIN: true } } }, 'mesh.lan', PUBLIC).ok, true)
  const caps = originVerdict({ domains: { '': { allowedOrigin: ['Mesh.Example.com'] } } }, 'mesh.lan', PUBLIC)
  assert.equal(caps.ok, false)
  assert.match(caps.reason, /different capitals/)
  // Both spellings present: the mixed-case one is what MeshCentral ends up with.
  assert.deepEqual(ciGet({ allowedorigin: ['a'], allowedOrigin: ['b'] }, 'allowedorigin'), ['b'])
})

test('the proposed allowedOrigin keeps every name that works today and adds the public ones, lowercase', () => {
  assert.deepEqual(proposedAllowedOrigin({}, 'mesh.lan', ['Mesh.Example.com']), ['mesh.lan', PUBLIC])
  assert.deepEqual(proposedAllowedOrigin({ domains: { '': { allowedOrigin: ['a.example.com'] } } }, 'mesh.lan', [PUBLIC]), ['a.example.com', PUBLIC])
  assert.deepEqual(proposedAllowedOrigin({}, 'un-configured', [PUBLIC]), [PUBLIC])
  const cfg = withAllowedOrigin({ settings: { cert: 'mesh.lan' }, Domains: { '': { AllowedOrigin: ['x'], title: 'T' } } }, ['y'])
  assert.deepEqual(cfg, { settings: { cert: 'mesh.lan' }, Domains: { '': { AllowedOrigin: ['y'], title: 'T' } } })
  assert.deepEqual(withAllowedOrigin({ settings: {} }, ['y']), { settings: {}, domains: { '': { allowedOrigin: ['y'] } } })
})

// --- pre-flight ---------------------------------------------------------------------------------

test('pre-flight: blocking before an update into the origin check, with the exact change offered', async () => {
  const f = facts({ settings: { cert: 'mesh.lan', port: 4430 } })
  const issues = await P.preflight(install(f), '1.3.1', ctxFor(guest()))
  assert.equal(issues.length, 1)
  assert.equal(issues[0].blocking, true)
  assert.match(issues[0].message, /1\.3\.1 will refuse browsers on mesh\.example\.com/)
  const fix = issues[0].fix!
  assert.equal(fix.file, '/opt/meshcentral/meshcentral-data/config.json')
  assert.match(fix.change, /^domains\[""\]\.allowedOrigin = \["mesh\.lan","mesh\.example\.com"\]/)
  assert.equal(fix.id, fixFor(f, [PUBLIC])!.id, 'the id is a pure function of the file, its content and the list')
  assert.notEqual(fix.id, fixFor(facts({ settings: { cert: 'mesh.lan', port: 4431 } }), [PUBLIC])!.id, 'a changed file is a different fix')
})

test('pre-flight: a hostname served by a named domain is judged there and gets no default-domain fix', async () => {
  const f = facts({ domains: { '': {}, customer: { dns: PUBLIC, allowedOrigin: ['x.example.com'] } } })
  const [issue] = await P.preflight(install(f), '1.3.1', ctxFor(guest()))
  assert.equal(issue.blocking, true)
  assert.match(issue.message, /domain "customer"/)
  assert.equal(issue.fix, undefined)
})

test('pre-flight: a target before the check only warns; a passing config has no issue; no URL is said', async () => {
  const before = await P.preflight(install(facts({})), '1.2.0', ctxFor(guest()))
  assert.equal(before[0].blocking, false)
  assert.match(before[0].message, new RegExp(`from ${ORIGIN_CHECK_SINCE.replace(/\./g, '\\.')}`))
  assert.deepEqual(await P.preflight(install(facts({ domains: { '': { allowedOrigin: ['mesh.lan', PUBLIC] } } })), '1.3.1', ctxFor(guest())), [])
  const none = await P.preflight(install(facts({})), '1.3.1', ctxFor(guest({ options: {} })))
  assert.equal(none[0].blocking, false)
  assert.match(none[0].message, /No public URL is known/)
  // From the proxy hosts HyperProx manages, when the setting is empty.
  const proxied = await P.preflight(install(facts({})), '1.3.1', ctxFor(guest({ options: {}, proxied: [`https://${PUBLIC}/`] })))
  assert.equal(proxied[0].blocking, true)
  const broken = await P.preflight(install({ ...facts({}), configText: '{ nope', config: null } as MeshFacts), '1.3.1', ctxFor(guest()))
  assert.match(broken[0].message, /not valid JSON/)
  assert.equal(broken[0].blocking, true)
})

// --- detection ------------------------------------------------------------------------------------

test('detect: the unit, the install and its config, read through the npm helper', async () => {
  const unitShow = 'ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node /opt/meshcentral/node_modules/meshcentral ; }\nWorkingDirectory=/opt/meshcentral\nUser=mesh\nActiveState=active\nMainPID=100\n'
  const config = { settings: { Cert: 'mesh.lan', Port: 4430 }, domains: { '': { title: 'Mesh' } } }
  const scripts: string[] = []
  const ctx: any = {
    guest: { vmid: 205, name: 'mesh', node: 'node-a', type: 'lxc' },
    async run(s: string) {
      scripts.push(s)
      if (s.includes('HP_DISCOVER_DONE')) return { code: 0, output: `HP_UNIT ${e('meshcentral.service')} ${e(unitShow)}\nHP_DISCOVER_DONE\n`, timedOut: false }
      if (s.includes('HP_FILE')) return { code: 0, timedOut: false, output: [
        `HP_REAL ${e('/opt/meshcentral')}`, `HP_OWNER ${e('mesh')}`, `HP_FILE package ${e('{"dependencies":{"meshcentral":"1.1.53"}}')}`,
        `HP_FILE installed ${e('{"version":"1.1.53"}')}`, `HP_FILE config ${e(JSON.stringify(config))}`,
      ].join('\n') }
      return { code: 0, output: `HP_CN ${e('mesh.lan')}\nHP_ERRLOG 120 1700000000\n`, timedOut: false }
    },
    option: () => undefined, log: () => {},
  }
  const [i] = await P.detect(ctx)
  const f = i.facts as unknown as MeshFacts
  assert.equal(i.installed, '1.1.53')
  assert.equal(i.service, 'meshcentral.service')
  assert.equal(f.certName, 'mesh.lan')
  assert.equal(f.port, 4430, 'settings.Port read case-insensitively')
  assert.deepEqual(f.errLog, { size: 120, mtime: 1700000000 })
  assert.match(scripts[1], /f config 'meshcentral-data\/config\.json'/)
  assert.match(P.rollback(i, 'hp-upd-202610280800'), /snapshot hp-upd-202610280800.*npm install meshcentral@1\.1\.53 --save-exact/)
})

// --- verify -------------------------------------------------------------------------------------

const f13 = facts({ domains: { '': { allowedOrigin: ['mesh.lan', PUBLIC] } } })

test('verify: version on disk, steady service, page and control.ashx through the public URL with an Origin', async () => {
  const ctx = ctxFor(guest())
  const r = await P.verify(install(f13, '1.3.1'), '1.3.1', ctx, { errLog: { size: 0, mtime: 0 } })
  assert.equal(r.ok, true, r.message)
  assert.deepEqual(ctx.probes, [
    ['http', `https://${PUBLIC}/`, `https://${PUBLIC}`],
    ['ws', `wss://${PUBLIC}/control.ashx`, `https://${PUBLIC}`],
  ])
})

test('verify fails on: invalidorigin, a wrong version, a crash in mesherrors.txt, a restart during the checks, a dead page', async () => {
  const run = (g: Partial<Guest>) => P.verify(install(f13, '1.3.1'), '1.3.1', ctxFor(guest(g)), { errLog: { size: 0, mtime: 0 } })

  const origin = await run({ ws: { upgraded: true, status: 101, firstMessage: '{"action":"close","cause":"invalidorigin","msg":"invalidorigin"}' } })
  assert.equal(origin.ok, false)
  assert.match(origin.message, /refused the origin https:\/\/mesh\.example\.com/)

  assert.match((await run({ version: '1.1.53' })).message, /at 1\.1\.53, not 1\.3\.1/)

  const crash = await run({ errSize: [40], errTail: "Error: Cannot find module 'otplib'" })
  assert.equal(crash.ok, false)
  assert.match(crash.output!, /otplib/)

  // Steady on pid 200, then the sign-in check takes it down and systemd restarts it on 201.
  const restarted = await run({ states: ['active 200 0', 'active 200 0', 'active 200 0', 'active 200 0', 'active 200 0', 'active 201 0'] })
  assert.equal(restarted.ok, false)
  assert.match(restarted.message, /restarted or stopped after the sign-in checks/)

  assert.match((await run({ page: { status: 502, body: 'Bad Gateway' } })).message, /HTTP 502/)
  assert.match((await run({ states: ['failed 0 0'] })).message, /not running steadily/)
  assert.match((await run({ ws: { upgraded: false, status: 404, firstMessage: null, error: 'HTTP 404 instead of a websocket' } })).message, /did not open a websocket/)
})

test('verify without a public URL still checks the service and says the origin was not checked', async () => {
  const r = await P.verify(install(f13, '1.3.1'), '1.3.1', ctxFor(guest({ options: {} })), { errLog: { size: 0, mtime: 0 } })
  assert.equal(r.ok, true)
  assert.match(r.output!, /origin check was not made/)
})

// --- the config fix --------------------------------------------------------------------------------

test('applyFix: refuses a stale approval; writes exactly the shown list, checked against the file it read', async () => {
  const f = facts({ settings: { cert: 'mesh.lan' }, domains: { '': { title: 'Mesh' } } })
  const id = fixFor(f, [PUBLIC])!.id
  const stale = await P.applyFix!(install(f), 'aaaaaaaaaaaa', ctxFor(guest()))
  assert.equal(stale.ok, false)
  assert.match(stale.message, /changed since this fix was approved/)

  const ctx = ctxFor(guest())
  const r = await P.applyFix!(install(f), id, ctx)
  assert.equal(r.ok, true, r.message)
  const script = ctx.scripts.find(s => s.includes('HP_CONFIG_WRITTEN'))!
  assert.match(script, new RegExp(`want='${createHash('sha256').update(f.configText!).digest('hex')}'`))
  assert.ok(script.indexOf('hp-bak-XXXXXX') < script.indexOf('mv -f'), 'backed up before it is replaced')
  assert.match(script, /runuser -u "\$o" -- bash -c "\$inner"/, 'written as the file owner, not as root')
  assert.doesNotMatch(script, /cp -p/)
  const b64 = /printf %s '([A-Za-z0-9+/=]+)' \| /.exec(script)![1]
  const written = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
  assert.deepEqual(written, { settings: { cert: 'mesh.lan' }, domains: { '': { title: 'Mesh', allowedOrigin: ['mesh.lan', PUBLIC] } } })
  assert.match(script, /systemctl restart "\$unit"/)

  const nothing = await P.applyFix!(install(f13), 'whatever0000', ctxFor(guest()))
  assert.deepEqual([nothing.ok, /nothing to change/.test(nothing.message)], [true, true])
})

// The fix script itself, run by bash on a real file (root-owned here) with a stub systemctl.
const asRoot = process.getuid?.() === 0
test('applyFix script, executed: backs up, replaces the file in place of its mode, restarts; refuses a changed file', { skip: !asRoot && 'needs root' }, async () => {
  const root = fs.mkdtempSync(path.join(os.homedir(), '.hp-mesh-test-'))
  try {
    const data = path.join(root, 'meshcentral-data'), sys = path.join(root, 'sys')
    fs.mkdirSync(data, { mode: 0o755 }); fs.mkdirSync(sys)
    fs.chmodSync(data, 0o755)
    const cfgFile = path.join(data, 'config.json')
    const original = JSON.stringify({ settings: { cert: 'mesh.lan' }, domains: { '': { title: 'Mesh' } } })
    fs.writeFileSync(cfgFile, original, { mode: 0o640 })
    fs.writeFileSync(path.join(sys, 'systemctl'), `#!/bin/sh\necho "systemctl $*" >> ${root}/log\n`, { mode: 0o755 })
    const f = { ...facts(JSON.parse(original)), configText: original, configFile: cfgFile, datapath: data }
    let script = ''
    const ctx = ctxFor(guest())
    ctx.run = async (s: string) => {
      script = s
      const r = spawnSync('bash', ['-s'], { input: s, env: { PATH: `${sys}:/usr/sbin:/usr/bin:/sbin:/bin` }, encoding: 'utf8' })
      return { code: r.status ?? -1, output: r.stdout + r.stderr, timedOut: false }
    }
    const r = await P.applyFix!(install(f), fixFor(f, [PUBLIC])!.id, ctx)
    assert.equal(r.ok, true, r.message + '\n' + r.output)
    assert.deepEqual(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).domains[''].allowedOrigin, ['mesh.lan', PUBLIC])
    assert.equal(fs.statSync(cfgFile).mode & 0o777, 0o640)
    const baks = fs.readdirSync(data).filter(n => n.startsWith('config.json.hp-bak-'))
    assert.equal(baks.length, 1)
    assert.equal(fs.readFileSync(path.join(data, baks[0]), 'utf8'), original)
    assert.match(fs.readFileSync(path.join(root, 'log'), 'utf8'), /systemctl restart meshcentral\.service/)
    assert.ok(script)

    // The file changed since it was read: nothing written.
    const now = fs.readFileSync(cfgFile, 'utf8')
    const again = await P.applyFix!(install(f), fixFor(f, [PUBLIC])!.id, ctx)
    assert.equal(again.ok, false)
    assert.match(again.message, /changed since it was read/)
    assert.equal(fs.readFileSync(cfgFile, 'utf8'), now)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
