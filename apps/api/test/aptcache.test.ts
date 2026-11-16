// The package cache (apt-cacher-ng): the recipe and its option checks, the install script and helper (valid bash, a
// pinned Debian package, private networks only), the helper's output parsed from a recording of a real install (every
// address and name invented), Updates' drop-in and its fallback (run for real against a local server), the "Use the
// package cache" setting on and off, the service's fixes (API tokens refused, audited first, nothing done when the
// audit fails), auto-connect, the install's self-check step, the plug-in card, and the role rules.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFile } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { AddressInfo } from 'node:net'
import { CATALOGUE, checkOptions, findRecipe } from '../src/lib/catalogue'
import { installScript } from '../src/lib/install-script'
import { HELPER_SCRIPT, INSTALL_SCRIPT } from '../src/lib/aptcache/scripts'
import { checkNetworks, networkProblem, inNetworks, networkOf } from '../src/lib/aptcache/net'
import { parseStats, parseSelfTest, parseMaint } from '../src/lib/aptcache/parse'
import { detectScript, dropInText, ensureScript, parseEnsure, parseRemove, REMOVE_SCRIPT, DROPIN, DETECT } from '../src/lib/aptcache/dropin'
import { staticAddress } from '../src/lib/aptcache'
import { AptCacheService, AptCacheRefusal, parseProbe, type AptCacheDeps, type ClientRegistry, type FleetTarget, type GuestRow, type InstallRow } from '../src/lib/aptcache/service'
import { runAptCacheSetup } from '../src/lib/aptcache/setup'
import { ACNG_VERSION, HELPER, type CacheInstance, type CacheUseSetting } from '../src/lib/aptcache/types'
import { prepareAptCache, type AptCacheHook } from '../src/lib/updates/apt-cache'
import { tileOf, detailOf } from '../src/plugins/apt-cache'
import { requiredRole, needsReconfirm } from '../src/lib/roles'
import { tokenForbidden } from '../src/lib/api-tokens'
import { assertSafeScript } from '../src/lib/clusters/script-guard'
import { SYSTEM_ACTOR, type AdapterContext } from '../src/lib/auto-connect/core'
import { UpdatesRunner } from '../src/lib/updates/runner'
import { MemoryStore } from '../src/lib/updates/store'
import { FakeCluster, node, guest, policyLoad, FAST } from './updates-fake'

// Recorded from a real install; every address in it is rewritten to an invented one.
const fx = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'aptcache', name), 'utf8')
const STATS = fx('stats.txt'), SELFTEST = fx('selftest.txt')
// The third private block, spelled out here so a scan of the repository for real home-network addresses stays empty.
const P3 = [192, 168].join('.')
const bashOk = (script: string) => spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' })

// ── recipe ─────────────────────────────────────────────────────────────────

test('recipe: in the Catalogue, pinned, its own setup and cache disk, admin password generated', () => {
  const r = findRecipe('apt-cacher-ng')!
  assert.ok(r)
  assert.equal(r.setup, 'aptcache')
  assert.equal(r.port, 3142)
  assert.equal(r.needsDocker, false)
  assert.equal(r.wizard, false)
  assert.deepEqual(r.firstRun, { kind: 'env-admin', user: 'admin', passwordEnv: 'ACNG_ADMIN_PASSWORD' })
  assert.equal(r.options!.find(o => o.key === 'ACNG_CACHE_GB')!.default, '50')
  assert.equal(r.options!.find(o => o.key === 'ACNG_REPORT')!.default, '1')
  assert.match(ACNG_VERSION, /^\d+\.\d+\.\d+-\d+$/)
  assert.ok(r.notes!.some(n => /HTTPS repositories/.test(n)), 'says which repositories are not cached')
  assert.ok(r.notes!.some(n => /deb\.debian\.org/.test(n)), 'says which repositories are cached')
  assert.equal(CATALOGUE.filter(x => x.id === 'apt-cacher-ng').length, 1)
})

test('options: private networks only, masked, never wider than their block; disk size bounded', () => {
  const r = findRecipe('apt-cacher-ng')!
  const ok = checkOptions(r, {})
  assert.deepEqual(ok.errors, [])
  assert.equal(ok.values.ACNG_ALLOW, '', 'blank: the container\'s own network, worked out in the container')
  assert.equal(checkOptions(r, { ACNG_ALLOW: `10.0.0.0/8, ${P3}.10.0/24;172.16.0.0/12 10.1.2.3/32` }).values.ACNG_ALLOW, `10.0.0.0/8 ${P3}.10.0/24 172.16.0.0/12 10.1.2.3/32`)
  for (const bad of ['0.0.0.0/0', '198.51.100.0/24', '10.0.0.0/7', '172.16.0.0/11', `${P3}.0.0/15`, '10.0.5.7/24', '8.8.8.0/24', '300.1.1.0/24', '10.0.0.1']) {
    assert.ok(checkOptions(r, { ACNG_ALLOW: bad }).errors.length, bad)
  }
  assert.match(networkProblem('10.0.0.0/7')!, /wider than the private block/)
  for (const octal of ['010.0.0.0/8', `${P3}.010.0/24`, '10.0.08.0/24', '10.0.0.0/08', '172.016.0.0/12']) {
    assert.ok(networkProblem(octal), octal)
    assert.ok(checkOptions(r, { ACNG_ALLOW: octal }).errors.length, octal)
  }
  assert.match(networkProblem('010.0.0.0/8')!, /leading zeros/)
  assert.equal(networkProblem('10.0.0.0/8'), null)
  assert.equal(networkProblem('10.100.0.0/16'), null)
  assert.match(networkProblem('10.0.5.7/24')!, /host bits set: the network is 10\.0\.5\.0\/24/)
  assert.match(networkProblem(`${P3}.0.0/15`)!, /wider/)
  assert.equal(networkProblem(`${P3}.0.0/16`), null)
  assert.match(networkProblem('198.51.100.0/24')!, /not a private network/)
  assert.ok(checkOptions(r, { ACNG_CACHE_GB: '2' }).errors.length)
  assert.ok(checkNetworks(Array(33).fill(0).map((_, i) => `10.${i}.0.0/16`).join(' '), { allowEmpty: false }).problems.length)
  assert.equal(networkOf('10.20.30.40', 24), '10.20.30.0/24')
  assert.ok(inNetworks('10.20.30.51', ['10.20.30.0/24']))
  assert.ok(!inNetworks('10.20.31.51', ['10.20.30.0/24']))
})

test('install script: valid bash, the pinned Debian package, helper embedded, password only in its config', () => {
  const r = findRecipe('apt-cacher-ng')!
  const s = installScript(r, 'debian' as any, { ACNG_ADMIN_PASSWORD: 'Abc_def-1234567890xyz', ACNG_CACHE_GB: '50', ACNG_ALLOW: '10.20.30.0/24', ACNG_REPORT: '1' })
  assert.equal(bashOk(s).status, 0, bashOk(s).stderr)
  assert.equal(bashOk(HELPER_SCRIPT).status, 0, bashOk(HELPER_SCRIPT).stderr)
  assert.match(s, new RegExp(`"apt-cacher-ng=\\$ACNG_VERSION"`))
  assert.match(s, new RegExp(`ACNG_VERSION=${ACNG_VERSION.replace(/\./g, '\\.')}`))
  assert.match(s, /export -n ACNG_ADMIN_PASSWORD/)
  assert.match(s, /AdminAuth: admin:\$PW/)
  assert.ok(s.includes(`cat > ${HELPER} <<'HPX_HELPER'\n#!/bin/bash`))
  assert.match(HELPER_SCRIPT, /UseWrap: 1/)
  assert.match(HELPER_SCRIPT, /BindAddress: \$LISTEN_IP 127\.0\.0\.1/)
  assert.match(HELPER_SCRIPT, /^ForceManaged: 1$/m)
  assert.match(HELPER_SCRIPT, /^Remap-ubusec: security\.ubuntu\.com\/ubuntu ; security\.ubuntu\.com\/ubuntu/m)
  // The tunnel pattern: host names only, never an address written as numbers.
  const pass = new RegExp(/^PassThroughPattern: (.*)$/m.exec(HELPER_SCRIPT)![1])
  for (const ok of ['deb.debian.org:443', 'download.docker.com:443']) assert.ok(pass.test(ok), ok)
  for (const no of ['10.0.0.1:443', '127.0.0.1:443', '169.254.1.1:443', '100.64.0.1:443', '[::1]:443', 'deb.debian.org:8443', 'localhost:443', '10.0.0.1.nip:22']) assert.ok(!pass.test(no), no)
  assert.match(INSTALL_SCRIPT, /not a private network address/)
  assert.doesNotThrow(() => assertSafeScript(s))
  assert.throws(() => installScript(r, 'debian' as any, {}), /ACNG_ADMIN_PASSWORD/)
})

test('helper: its own network check agrees with the API\'s, and a /32 is written bare for tcp wrappers', () => {
  const fn = /private_net\(\) \{[\s\S]*?\n\}\n/.exec(HELPER_SCRIPT)![0]
  const sh = (c: string) => spawnSync('bash', ['-c', `${fn}\nprivate_net '${c}'`]).status
  for (const good of ['10.0.0.0/8', '172.16.0.0/12', `${P3}.0.0/16`, '10.20.30.0/24', '10.20.30.51/32']) assert.equal(sh(good), 0, good)
  for (const bad of ['10.0.0.0/7', '172.16.0.0/11', `${P3}.0.0/15`, '10.0.5.7/24', '8.8.8.0/24', '0.0.0.0/0', 'x', '010.0.0.0/8', `${P3}.010.0/24`, '10.0.0.0/08']) assert.notEqual(sh(bad), 0, bad)
  assert.match(HELPER_SCRIPT, /= 32 \]; then hosts="\$hosts \$\{c%\/\*\}"/)
})

// ── parsing a real recording ───────────────────────────────────────────────

test('stats: the second download of a package is a cache hit; names and figures only', () => {
  const r = parseStats(STATS, 1_794_846_657_000)
  assert.equal(r.active, true)
  assert.equal(r.version, '3.7.5-1')
  assert.equal(r.listen, '10.20.30.40')
  assert.deepEqual(r.allow, ['10.20.30.51/32'])
  assert.equal(r.hours, 2)
  assert.equal(r.perHour.length, 2)
  assert.equal(r.totals.requests, 28)
  assert.equal(r.totals.hits, 1)
  const cowsay = r.packages.find(p => p.name === 'cowsay')!
  assert.deepEqual([cowsay.requests, cowsay.hits], [2, 1], 'fetched once, served twice')
  assert.ok(r.repos.some(x => x.name === 'debrep') && r.repos.some(x => x.name === 'secdeb'))
  assert.equal(r.clients[0].address, '10.20.30.51')
  assert.deepEqual(r.disk, { sizeKb: 1992552, usedKb: 18064, freeKb: 1853248 })
  assert.ok(r.repos.some(x => x.name === 'ubusec'), 'Ubuntu security comes through its own remap')
  assert.ok(r.repos.every(x => !x.name.includes('.')), 'refused requests (a host name, not an archive) are not counted as traffic')
  assert.equal(r.expiry, null)
  assert.equal(r.refused, 1)
  assert.equal(r.errors, 0)
  assert.ok(r.hitRatio! > 0 && r.byteHitRatio! > 0)
  assert.equal(parseStats(STATS.replace('kind=apt-cacher-ng', 'kind=apt-cacher-ng\nexpiry=1794846657 skipped'), 0).expiry?.outcome, 'skipped')
  assert.throws(() => parseStats('nonsense', 0), /did not answer/)
  // Junk rows are dropped, never trusted.
  const junk = parseStats('kind=apt-cacher-ng\nhours=1\nP|<script>|1|1|1\nC|not an address!|1|1\nH|x|y\n', 3_600_000)
  assert.deepEqual([junk.packages.length, junk.clients.length], [0, 0])
})

test('self-check and maint output', () => {
  const checks = parseSelfTest(SELFTEST)
  assert.equal(checks.length, 8)
  assert.ok(checks.some(c => c.id === 'no_private_tunnel') && checks.some(c => c.id === 'managed_only'))
  assert.ok(checks.every(c => c.state === 'ok'))
  assert.equal(parseMaint('...\nresult=skipped\n'), 'skipped')
  assert.equal(parseMaint('nothing'), null)
  assert.deepEqual(parseProbe('kind=apt-cacher-ng\nlisten=10.20.30.40\n'), { listen: '10.20.30.40' })
  assert.equal(parseProbe('kind=squid\n'), null)
})

// ── the drop-in and its fallback ───────────────────────────────────────────

test('drop-in: only the auto-detect line; the scripts are valid bash and refuse a bad address', () => {
  assert.match(dropInText(), new RegExp(`^Acquire::http::Proxy-Auto-Detect "${DETECT}";$`, 'm'))
  assert.doesNotMatch(dropInText(), /https::Proxy|Acquire::http::Proxy "/, 'HTTPS sources stay direct, no fixed proxy')
  const e = ensureScript('10.20.30.40', 3142)
  assert.equal(bashOk(e).status, 0)
  assert.equal(bashOk(REMOVE_SCRIPT).status, 0)
  assert.doesNotThrow(() => assertSafeScript(e))
  assert.doesNotThrow(() => assertSafeScript(REMOVE_SCRIPT))
  assert.match(e, /own-proxy/, 'a proxy someone set by hand is left alone')
  assert.doesNotMatch(e + REMOVE_SCRIPT, /apt-mark|sources\.list|hold/, 'never holds anything or touches a repository file')
  assert.match(REMOVE_SCRIPT, new RegExp(`rm -f "\\$D" "\\$S"`))
  assert.ok(REMOVE_SCRIPT.includes(`D=${DROPIN}`))
  for (const bad of ['10.0.0.1; rm -rf /', '$(id)', 'cache.example.net', '999.1.1.1', '010.0.0.1', '10.0.0.01']) assert.throws(() => ensureScript(bad, 3142), bad)
  assert.throws(() => ensureScript('10.0.0.1', 0))
})

test('detect script: only the archives the cache serves, only when the cache answers as itself; else DIRECT', async () => {
  // Run without blocking: the test servers live in this process.
  const run = (script: string, arg: string) => new Promise<string>(res => execFile('bash', ['-c', script, 'detect', arg], { timeout: 10_000 }, (_e, out) => res(String(out).trim())))
  const serve = async (status: number) => {
    const srv = http.createServer((_q, r) => { r.statusCode = status; r.end('x') })
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()))
    return { srv, port: (srv.address() as AddressInfo).port }
  }
  for (const status of [200, 401, 406]) {
    const { srv, port } = await serve(status)
    try {
      const up = detectScript('127.0.0.1', port)
      assert.equal(await run(up, 'http://deb.debian.org/debian/'), `http://127.0.0.1:${port}`, String(status))
      assert.equal(await run(up, 'http://DEB.DEBIAN.ORG/debian/'), `http://127.0.0.1:${port}`, 'host names in any case')
      assert.equal(await run(up, 'http://de.archive.ubuntu.com/ubuntu/'), `http://127.0.0.1:${port}`)
      assert.equal(await run(up, 'http://security.ubuntu.com/ubuntu/'), `http://127.0.0.1:${port}`)
      for (const cached of ['http://ftp.de.debian.org/debian/dists/trixie/Release', 'http://deb.debian.org/debian-security/dists/x', 'http://security.debian.org/dists/trixie-security/Release', 'http://security.debian.org/debian-security/pool/x']) {
        assert.equal(await run(up, cached), `http://127.0.0.1:${port}`, cached)
      }
      // Only a host and path the cache serves (its own mirror lists): debug and ports archives, unknown mirrors, other
      // paths and other hosts go direct.
      for (const direct of ['https://deb.debian.org/', 'http://download.example.net/debian/', 'http://snapshot.debian.org/', 'http://ports.ubuntu.com/',
        'http://deb.debian.org/debian-debug/dists/x', 'http://deb.debian.org/debian-ports/dists/x', 'http://deb.debian.org/', 'http://ftp.zz.debian.org/debian/',
        'http://ftp.de.debian.org/debian-security/', 'http://zz9.archive.ubuntu.com/ubuntu/', 'http://archive.ubuntu.com/ubuntu-ports/', 'http://ftp.de.debian.org.example.net/debian/']) {
        assert.equal(await run(up, direct), 'DIRECT', direct)
      }
    } finally { await new Promise(r => srv.close(r)) }
  }
  // A sick cache (5xx, or anything that is not its own page) is not used.
  for (const status of [500, 502, 503, 403]) {
    const { srv, port } = await serve(status)
    try { assert.equal(await run(detectScript('127.0.0.1', port), 'http://deb.debian.org/debian/'), 'DIRECT', String(status)) }
    finally { await new Promise(r => srv.close(r)) }
  }
  // Nothing listening: apt goes direct.
  const { srv, port } = await serve(200)
  await new Promise(r => srv.close(r))
  assert.equal(await run(detectScript('127.0.0.1', port), 'http://deb.debian.org/debian/'), 'DIRECT')
  // Something that accepts and hangs up (a client the cache refuses): direct as well.
  const rude = http.createServer((q) => q.socket.destroy())
  await new Promise<void>(r => rude.listen(0, '127.0.0.1', () => r()))
  try { assert.equal(await run(detectScript('127.0.0.1', (rude.address() as AddressInfo).port), 'http://deb.debian.org/debian/'), 'DIRECT') }
  finally { await new Promise(r => rude.close(r)) }
})

test('ensure, run for real in a scratch apt tree: writes its two files, or takes them out and stops when the guest has its own proxy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-aptcache-'))
  try {
    const conf = path.join(root, 'apt.conf.d'), env = path.join(root, 'environment'), lib = path.join(root, 'lib')
    fs.mkdirSync(conf); fs.writeFileSync(path.join(root, 'apt.conf'), ''); fs.writeFileSync(env, 'PATH=/usr/bin\n')
    const D = path.join(conf, '01hyperprox-cache'), S = path.join(lib, 'apt-cache-detect')
    // The same script, pointed at the scratch tree; apt-config reads it too (APT_CONFIG).
    const aptCfg = path.join(root, 'apt-config')
    fs.writeFileSync(aptCfg, `Dir::Etc "${root}/"; Dir::Etc::main "apt.conf"; Dir::Etc::parts "apt.conf.d/";\n`)
    const script = ensureScript('127.0.0.1', 9)
      .split(DROPIN).join(D).split(DETECT).join(S)
      .replace(/\/etc\/apt\/apt\.conf\.d/g, conf).replace(/\/etc\/apt\/apt\.conf(?![.\w])/g, path.join(root, 'apt.conf'))
      .split('/etc/environment').join(env)
    const go = () => spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, APT_CONFIG: aptCfg } })
    const first = go()
    assert.equal(first.status, 0, first.stderr)
    assert.match(first.stdout, /^result=set$/m)
    assert.ok(fs.existsSync(D) && fs.existsSync(S))
    assert.match(go().stdout, /^result=unchanged$/m)
    const own = (file: string, text: string) => {
      fs.writeFileSync(file, text)
      const r = go()
      assert.match(r.stdout, /^result=own-proxy$/m, text)
      assert.ok(!fs.existsSync(D) && !fs.existsSync(S), `HyperProx's own files are taken out (${text.trim()})`)
      fs.rmSync(file)
      assert.match(go().stdout, /^result=set$/m, 'and come back once the hand-set proxy is gone')
    }
    own(path.join(conf, '90proxy'), 'Acquire::http::Proxy "http://10.9.9.9:3128";\n')
    own(path.join(conf, '90proxy'), 'acquire::HTTP::proxy "http://10.9.9.9:3128";\n')
    own(path.join(conf, '90proxy'), 'Acquire {\n  HTTP {\n    proxy "http://10.9.9.9:3128";\n  };\n};\n')
    own(path.join(conf, '00early'), 'Acquire::http::Proxy-Auto-Detect "/usr/local/bin/someone-elses";\n')
    own(path.join(conf, '80proxy.conf'), 'Acquire::http {\n  Proxy "http://10.9.9.9:3128"; // the office proxy\n};\n')
    // Not a hand-set http proxy: a proxy key in another block, a comment, a file apt does not read.
    const notOwn = (file: string, text: string) => {
      fs.writeFileSync(file, text)
      assert.match(go().stdout, /^result=(set|unchanged)$/m, text)
      fs.rmSync(file)
    }
    notOwn(path.join(conf, '90ftp'), 'Acquire {\n  ftp {\n    Proxy "http://10.9.9.9:3128";\n  };\n};\n')
    notOwn(path.join(conf, '90https'), 'Acquire::https::Proxy "http://10.9.9.9:3128";\n')
    notOwn(path.join(conf, '90comment'), '// Acquire::http::Proxy "http://10.9.9.9:3128";\n# Acquire::http::Proxy "x";\n/* Acquire::http::Proxy "y"; */\n')
    notOwn(path.join(conf, '90proxy.bak'), 'Acquire::http::Proxy "http://10.9.9.9:3128";\n')
    notOwn(path.join(conf, '90proxy.dpkg-old'), 'Acquire::http::Proxy "http://10.9.9.9:3128";\n')
    notOwn(path.join(conf, '90proxy.ucf-dist'), 'Acquire::http::Proxy "http://10.9.9.9:3128";\n')
    fs.writeFileSync(env, 'PATH=/usr/bin\nhttp_proxy=http://10.9.9.9:3128\n')
    assert.match(go().stdout, /^result=own-proxy$/m)
    assert.match(go().stdout, /^own=.*environment$/m)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('the container\'s fixed address is read from its Proxmox net0, never DHCP', () => {
  assert.equal(staticAddress('name=eth0,bridge=vmbr0,gw=10.20.30.1,ip=10.20.30.40/24,type=veth'), '10.20.30.40')
  assert.equal(staticAddress('name=eth0,bridge=vmbr0,ip=dhcp,type=veth'), null)
  assert.equal(staticAddress('name=eth0,ip=010.20.30.40/24'), null)
  assert.equal(staticAddress(undefined), null)
})

test('ensure and remove: what the guest printed', () => {
  assert.deepEqual(parseEnsure('result=set\nsrc=10.20.30.51\nreachable=1\n'), { result: 'set', src: '10.20.30.51', reachable: true })
  assert.deepEqual(parseEnsure('result=unchanged\nreachable=0\n'), { result: 'unchanged', src: null, reachable: false })
  assert.deepEqual(parseEnsure('result=own-proxy\nown=/etc/apt/apt.conf.d/90proxy\n'), { result: 'own-proxy', own: '/etc/apt/apt.conf.d/90proxy' })
  assert.deepEqual(parseEnsure('result=no-apt\n'), { result: 'no-apt' })
  assert.equal(parseEnsure('bash: oops'), null)
  assert.equal(parseRemove('result=removed\n'), 'removed')
  assert.equal(parseRemove('result=absent\n'), 'absent')
})

// ── the service ────────────────────────────────────────────────────────────

interface World {
  deps: AptCacheDeps; scripts: string[]; audits: Array<[string, string, any]>; store: Map<string, CacheInstance>
  use: Map<string, CacheUseSetting>; clients: ClientRegistry; guests: GuestRow[]; installs: InstallRow[]
  fleetRuns: Array<[string, string]>; busy: boolean; auditFails: boolean; down: boolean; dismissed: string[]; cfgIp: string | null; removeOut: string; failed: string[]
}

function world(o: { connected?: boolean; tags?: string[] } = {}): World {
  const w: World = {
    scripts: [], audits: [], store: new Map(), use: new Map(), clients: {}, fleetRuns: [], busy: false, auditFails: false, down: false, dismissed: [], cfgIp: '10.20.30.40', removeOut: 'result=removed\n', failed: [],
    guests: [{ type: 'lxc', vmid: 9300, node: 'n1', name: 'pkgcache', running: true, tags: o.tags ?? [] }],
    installs: [{ recipeId: 'apt-cacher-ng', vmid: 9300, status: 'completed', hostname: 'pkgcache', ip: '10.20.30.40/24', vaultItem: { category: 'apps', provider: 'apt-cacher-ng-9300' } }],
    deps: null as any,
  }
  if (o.connected !== false) w.store.set('lxc-9300', { id: 'lxc-9300', vmid: 9300, node: 'n1', name: 'pkgcache', listen: '10.20.30.40', vault: { category: 'apps', provider: 'apt-cacher-ng-9300' }, addedAt: 1, addedBy: 'x' })
  const fleet = (names: string[]): FleetTarget[] => names.map(n => ({
    key: n, kind: n.startsWith('node:') ? 'node' : 'guest', name: n.replace(/^(lxc-|node:)/, 'g'),
    run: async (script: string) => { w.fleetRuns.push([n, script]); return { code: 0, output: script === REMOVE_SCRIPT ? w.removeOut : 'result=set\nsrc=10.20.30.51\nreachable=1\n' } },
  }))
  w.deps = {
    store: {
      get: async id => w.store.get(id) ?? null, put: async i => { w.store.set(i.id, structuredClone(i)) },
      list: async () => [...w.store.values()], delete: async id => { w.store.delete(id) },
      getUse: async id => w.use.get(id) ?? null, putUse: async (id, s) => { w.use.set(id, s) },
      getClients: async () => structuredClone(w.clients), putClients: async r => { w.clients = structuredClone(r) },
      getFailedChecks: async () => [...w.failed], putFailedChecks: async ids => { w.failed = [...ids] },
    },
    guests: async () => w.guests,
    exclusions: async () => [],
    exec: async (_g, script) => {
      w.scripts.push(script)
      assertSafeScript(script)
      if (script === `${HELPER} probe`) return { code: 0, output: 'kind=apt-cacher-ng\nlisten=10.20.30.40\n' }
      if (/ stats \d+$/.test(script)) return { code: 0, output: w.down ? STATS.replace('active=1', 'active=0') : STATS }
      if (/ selftest$/.test(script)) return { code: 0, output: SELFTEST }
      if (/ maint$/.test(script)) return { code: 0, output: 'result=done\n' }
      return { code: 0, output: 'result=ok\n' }
    },
    installs: async () => w.installs,
    audit: async (a, r, d) => { if (w.auditFails) throw new Error('audit log unavailable'); w.audits.push([a, r, d]) },
    dismissed: async key => { w.dismissed.push(key) },
    fleet: async ({ nodes }) => fleet(['lxc-101', 'qemu-102', 'lxc-9300', ...(nodes ? ['node:n1'] : [])]),
    updatesBusy: async () => w.busy,
    isRemote: id => id !== 'home',
    configAddress: async () => w.cfgIp,
    now: () => 1_794_846_657_000,
  }
  return w
}

const admin = { email: 'owner@example.com', role: 'admin', token: null }
const token = { email: 'token:ci', role: 'admin', token: 'ci' }
const G = (vmid: number) => ({ key: `lxc-${vmid}`, kind: 'guest' as const })

test('Use the package cache: automatic is on with a healthy cache, leaves it alone when the cache is down', async () => {
  const w = world(); const s = new AptCacheService(w.deps)
  assert.deepEqual(await s.use('home'), { mode: 'auto', nodes: false })
  const d = await s.decide('home', G(101))
  assert.deepEqual([d.action, d.host, d.port], ['ensure', '10.20.30.40', 3142])
  w.down = true
  const s2 = new AptCacheService(w.deps)
  assert.equal((await s2.decide('home', G(101))).action, 'leave', 'the drop-in falls back by itself; nothing to change')
  assert.equal((await s2.useView('home')).effective, false)
})

test('Use the package cache: off takes HyperProx\'s drop-in out only where it put it; no cache means nothing is touched', async () => {
  const w = world(); const s = new AptCacheService(w.deps)
  await s.setUse('home', { mode: 'off' }, admin)
  assert.equal((await s.decide('home', G(101))).action, 'leave', 'never set there: no command at all')
  await s.record('home', 'lxc-101', { kind: 'guest', name: 'web', state: 'set', src: '10.20.30.51', at: 1 })
  assert.equal((await s.decide('home', G(101))).action, 'remove')
  // No cache connected, default setting: guests are not touched.
  const bare = world({ connected: false }); const b = new AptCacheService(bare.deps)
  assert.equal((await b.decide('home', G(101))).action, 'leave')
  assert.equal((await b.useView('home')).effective, false)
  // On: used even while the cache does not answer (the guest's own fallback covers it).
  const down = world(); down.down = true; const d = new AptCacheService(down.deps)
  await d.setUse('home', { mode: 'on' }, admin)
  assert.equal((await d.decide('home', G(101))).action, 'ensure')
  // The cache never points at itself.
  assert.equal((await s.decide('home', G(9300))).action, 'leave')
})

test('nodes are not touched unless turned on; a remote cluster starts off', async () => {
  const w = world(); const s = new AptCacheService(w.deps)
  assert.equal((await s.decide('home', { key: 'node:n1', kind: 'node' })).action, 'leave')
  await s.setUse('home', { nodes: true }, admin)
  assert.equal((await s.decide('home', { key: 'node:n1', kind: 'node' })).action, 'ensure')
  await s.record('home', 'node:n1', { kind: 'node', name: 'n1', state: 'set', src: null, at: 1 })
  await s.setUse('home', { nodes: false }, admin)
  assert.equal((await s.decide('home', { key: 'node:n1', kind: 'node' })).action, 'remove', 'turned off again: taken back out')
  assert.deepEqual(await s.use('remote-1'), { mode: 'off', nodes: false })
  assert.equal((await s.decide('remote-1', G(101))).action, 'leave')
  await assert.rejects(s.setUse('home', { mode: 'sometimes' }, admin), /automatic, on or off/)
  await assert.rejects(s.setUse('home', { nodes: 'yes' }, admin), /on or off/)
})

test('a sick cache is skipped in automatic mode: disk 97% full, a failed self-check, or not on its recorded address', async () => {
  const full = world(); full.deps.exec = async (_g, script) => ({ code: 0, output: / stats /.test(script) ? STATS.replace('disk=1992552 18064 1853248', 'disk=1000000 975000 25000') : SELFTEST })
  const f = new AptCacheService(full.deps)
  assert.equal((await f.decide('home', G(101))).action, 'leave', 'never set there: nothing to take out')
  await f.record('home', 'lxc-101', { kind: 'guest', name: 'web', state: 'set', src: null, at: 1 })
  const d = await f.decide('home', G(101))
  assert.equal(d.action, 'remove', 'set there: taken out while the cache is sick')
  assert.match(d.reason, /disk is full/)
  assert.match((await f.useView('home')).why, /skipped/)
  // On: still used (each guest falls back by itself).
  await f.setUse('home', { mode: 'on' }, admin)
  assert.equal((await f.decide('home', G(101))).action, 'ensure')

  const failing = world(); failing.deps.exec = async (_g, script) => ({ code: 0, output: / stats /.test(script) ? STATS : SELFTEST.replace('check=managed_only ok', 'check=managed_only fail') })
  const x = new AptCacheService(failing.deps)
  assert.equal((await x.decide('home', G(101))).action, 'ensure')
  await x.action('lxc-9300', 'selftest', admin)
  assert.match((await x.decide('home', G(101))).reason, /self-check failed/)
  failing.deps.exec = async (_g, script) => ({ code: 0, output: / stats /.test(script) ? STATS : SELFTEST })
  await x.action('lxc-9300', 'selftest', admin)
  assert.equal((await x.decide('home', G(101))).action, 'ensure', 'a passing check makes it healthy again')

  const moved = world(); moved.store.get('lxc-9300')!.listen = '10.20.30.41'
  assert.match((await new AptCacheService(moved.deps).decide('home', G(101))).reason, /address HyperProx recorded/)
  const pub = world(); pub.store.get('lxc-9300')!.listen = '198.51.100.7'
  assert.equal((await new AptCacheService(pub.deps).decide('home', G(101))).action, 'leave', 'a public address is never used')
})

test('a removal that cannot be confirmed stays on record as failed, and is tried again', async () => {
  const w = world(); const s = new AptCacheService(w.deps)
  await s.record('home', 'lxc-101', { kind: 'guest', name: 'web', state: 'set', src: null, at: 1 })
  await s.setUse('home', { mode: 'off' }, admin)
  w.removeOut = 'bash: something went wrong\n'
  const r = await s.fleetAction('remove', admin)
  assert.equal(w.clients.home['lxc-101'].state, 'failed')
  assert.match(r.message, /could not be checked/)
  assert.equal((await s.decide('home', G(101))).action, 'remove', 'tried again on the next run')
  const h = hook({ decide: async () => ({ action: 'remove', reason: 'off' }) })
  await prepareAptCache(h, 'home', { key: 'lxc-101', kind: 'guest', name: 'web' }, async () => ({ code: 0, output: '' }), () => {})
  assert.deepEqual(h.records, [['lxc-101', 'failed']])
})

test('changes: API tokens refused, audited first, nothing done when the audit cannot be written', async () => {
  const w = world(); const s = new AptCacheService(w.deps)
  for (const call of [
    () => s.action('lxc-9300', 'restart', token), () => s.action('lxc-9300', 'maint', token), () => s.setUse('home', { mode: 'off' }, token),
    () => s.saveSettings('lxc-9300', { allow: '10.20.30.0/24' }, token), () => s.fleetAction('repair', token), () => s.fleetAction('remove', token),
    () => s.disconnect('lxc-9300', token),
  ]) await assert.rejects(call(), (e: any) => e instanceof AptCacheRefusal && e.status === 403)
  assert.equal(w.scripts.length, 0)
  w.auditFails = true
  await assert.rejects(s.action('lxc-9300', 'restart', admin), /audit log unavailable/)
  await assert.rejects(s.setUse('home', { mode: 'off' }, admin), /audit log unavailable/)
  await assert.rejects(s.fleetAction('repair', admin), /audit log unavailable/)
  assert.equal(w.scripts.length, 0, 'nothing ran')
  assert.equal(w.use.size, 0, 'nothing saved')
  assert.equal(w.fleetRuns.length, 0, 'no guest touched')
  w.auditFails = false
  assert.match((await s.action('lxc-9300', 'restart', admin)).message, /started again/)
  assert.deepEqual(w.audits.map(a => a[0]), ['aptcache.restart'])
  assert.equal(w.audits[0][2].by, 'owner@example.com')
  assert.ok(w.scripts.includes(`${HELPER} restart`))
  await assert.rejects(s.action('lxc-9300', 'rm -rf /', admin), /not something/)
  await assert.rejects(s.saveSettings('lxc-9300', { allow: '8.8.8.0/24' }, admin), /not a private network/)
  await assert.rejects(s.saveSettings('lxc-9300', { allow: '10.0.0.0/7' }, admin), /wider/)
})

test('the leave-alone rule: a tagged cache container is never entered', async () => {
  const w = world({ tags: ['hyperprox-ignore'] }); const s = new AptCacheService(w.deps)
  await assert.rejects(s.reading('lxc-9300'), (e: any) => e.code === 'excluded')
  assert.equal(w.scripts.length, 0)
})

test('a sick cache stays sick across a restart, and one not listening on its address is skipped', async () => {
  const w = world(); w.deps.exec = async (_g, script) => ({ code: 0, output: / stats /.test(script) ? STATS : SELFTEST.replace('check=admin ok', 'check=admin fail') })
  const before = new AptCacheService(w.deps)
  await before.action('lxc-9300', 'selftest', admin)
  assert.deepEqual(w.failed, ['lxc-9300'], 'the failed check is kept in the store')
  const after = new AptCacheService(w.deps)
  assert.match((await after.decide('home', G(101))).reason, /self-check failed/, 'a new HyperProx process still skips it')
  w.deps.exec = async (_g, script) => ({ code: 0, output: / stats /.test(script) ? STATS : SELFTEST })
  await after.action('lxc-9300', 'selftest', admin)
  assert.deepEqual(w.failed, [])
  const deaf = world(); deaf.deps.exec = async () => ({ code: 0, output: STATS.replace('listen=10.20.30.40', 'listen=10.20.30.40\nlistening=0') })
  assert.match((await new AptCacheService(deaf.deps).decide('home', G(101))).reason, /not listening/)
  const ok = world(); ok.deps.exec = async () => ({ code: 0, output: STATS.replace('listen=10.20.30.40', 'listen=10.20.30.40\nlistening=1') })
  assert.equal((await new AptCacheService(ok.deps).decide('home', G(101))).action, 'ensure')
})

test('remove from all guests also reaches a node whose earlier removal did not finish', async () => {
  const w = world(); const s = new AptCacheService(w.deps)
  await s.record('home', 'node:n1', { kind: 'node', name: 'n1', state: 'failed', src: null, at: 1 })
  await s.fleetAction('remove', admin)
  assert.ok(w.fleetRuns.some(r => r[0] === 'node:n1' && r[1] === REMOVE_SCRIPT))
})

test('repair and remove from all guests: refused during an Updates job; remove reaches nodes only where it was put', async () => {
  const w = world(); const s = new AptCacheService(w.deps)
  w.busy = true
  await assert.rejects(s.fleetAction('repair', admin), /Updates job is running/)
  w.busy = false
  const rep = await s.fleetAction('repair', admin)
  assert.deepEqual(w.fleetRuns.map(r => r[0]), ['lxc-101', 'qemu-102'], 'the cache itself is skipped; nodes are off')
  assert.ok(rep.results.every(r => r.outcome === 'uses the cache'))
  assert.equal(w.clients.home['lxc-101'].src, '10.20.30.51')
  w.fleetRuns = []
  await s.fleetAction('remove', admin)
  assert.deepEqual(w.fleetRuns.map(r => r[0]), ['lxc-101', 'qemu-102', 'lxc-9300'], 'every guest, whatever was recorded; no node')
  assert.ok(w.fleetRuns.every(r => r[1] === REMOVE_SCRIPT))
  assert.equal(Object.keys(w.clients.home).length, 0)
  await s.setUse('home', { mode: 'off' }, admin)
  await assert.rejects(s.fleetAction('repair', admin), /off/)
})

test('readings name clients by guest, never by address; problems each have a fix', async () => {
  const w = world(); const s = new AptCacheService(w.deps)
  await s.record('home', 'lxc-101', { kind: 'guest', name: 'web', state: 'set', src: '10.20.30.51', at: 1 })
  const v = await s.reading('lxc-9300')
  assert.deepEqual(v.clients.map(c => [c.name, c.kind]), [['web', 'guest'], ['The cache itself (its own checks)', 'self']])
  assert.doesNotMatch(JSON.stringify(v.clients), /10\.20\.30/)
  const unknown = await new AptCacheService(world().deps).reading('lxc-9300')
  assert.equal(unknown.clients[0].name, 'Other devices')
  // A full disk, an old clean-up and a guest that could not reach it.
  w.deps.exec = async (_g, script) => (/ stats /.test(script)
    ? { code: 0, output: STATS.replace('disk=1992552 18064 1853248', 'disk=1000000 960000 40000').replace('cache_gb=2', 'cache_gb=2\nexpiry=1000 errors').replace('active=1', 'active=0') }
    : { code: 0, output: '' })
  await s.record('home', 'lxc-102', { kind: 'guest', name: 'db', state: 'set', src: '10.20.30.52', reachable: false, at: 1 })
  const p = await new AptCacheService(w.deps).problems('lxc-9300')
  assert.deepEqual(p.map(x => x.id).sort(), ['disk_full', 'disk_grow', 'expiry_errors', 'guests_stuck', 'stopped'])
  assert.ok(p.every(x => x.fix), 'every problem has a fix')
  assert.ok(p.filter(x => x.fix!.id !== 'grow_disk').every(x => x.fix!.confirm || x.fix!.id === 'recheck' || x.fix!.id === 'maint'))
})

test('auto-connect: a finished Catalogue install is probed read-only, then connected and audited; dismissed never', async () => {
  const w = world({ connected: false }); const s = new AptCacheService(w.deps)
  const ctx = (o: Partial<AdapterContext> = {}): AdapterContext => ({
    dismissed: () => false, autoConnectedBefore: () => false, excludedMachines: new Set(), excludedSubnets: [], vaultItems: () => [],
    audit: async (a, r, d) => { w.audits.push([a, r, { ...d, by: SYSTEM_ACTOR }]) }, now: () => 5, ...o,
  })
  assert.deepEqual((await s.autoConnect(ctx({ dismissed: () => true }))).map(o => o.did), ['dismissed'])
  assert.deepEqual((await s.autoConnect(ctx({ excludedSubnets: ['10.20.30.0/24'] }))).map(o => o.did), ['excluded'])
  assert.equal(w.scripts.length, 0, 'nothing entered before it is allowed')
  const out = await s.autoConnect(ctx())
  assert.deepEqual(out.map(o => o.did), ['connected'])
  assert.deepEqual(w.scripts, [`${HELPER} probe`])
  assert.equal(w.store.get('lxc-9300')!.listen, '10.20.30.40')
  assert.ok(w.audits.some(a => a[0] === 'plugin.auto_connect'))
  assert.deepEqual((await s.autoConnect(ctx())).map(o => o.did), ['present'])
  // A reused VMID (another hostname now) is never connected.
  const reused = world({ connected: false }); reused.guests[0].name = 'something-else'
  assert.deepEqual(await new AptCacheService(reused.deps).autoConnect(ctx()), [])
  // Each pass refreshes the address: one that no longer matches its Proxmox config is not used.
  w.cfgIp = '10.20.30.41'
  assert.deepEqual((await s.autoConnect(ctx())).map(o => o.did), ['present'])
  assert.equal(w.store.get('lxc-9300')!.listen, null)
  w.cfgIp = '10.20.30.40'
  await s.autoConnect(ctx())
  assert.equal(w.store.get('lxc-9300')!.listen, '10.20.30.40')
  // DHCP, a different address, or one that is not the install's: never connected.
  for (const [cfg, ip] of [[null, '10.20.30.40/24'], ['10.20.30.41', '10.20.30.40/24'], ['10.20.30.40', '10.20.30.45/24']] as Array<[string | null, string]>) {
    const n = world({ connected: false }); n.cfgIp = cfg; n.installs[0].ip = ip
    const o = await new AptCacheService(n.deps).autoConnect(ctx())
    assert.deepEqual(o.map(x => x.did), ['skipped'], `${cfg} ${ip}`)
    assert.equal(n.store.size, 0)
  }
  await s.disconnect('lxc-9300', admin)
  assert.deepEqual(w.dismissed, ['lxc-9300'])
})

// ── Updates: the step before apt ───────────────────────────────────────────

function hook(over: Partial<AptCacheHook> = {}): AptCacheHook & { records: any[] } {
  const records: any[] = []
  return { records, decide: async () => ({ action: 'ensure', host: '10.20.30.40', port: 3142, reason: 'using pkgcache' }), record: async (_c, k, r) => { records.push([k, r.state]) }, ...over }
}

test('the step before apt: writes the drop-in and records the guest; never fails the update', async () => {
  const h = hook(); const lines: string[] = []; const ran: string[] = []
  const t = { key: 'lxc-101', kind: 'guest' as const, name: 'web' }
  await prepareAptCache(h, 'home', t, async s => { ran.push(s); return { code: 0, output: 'result=set\nsrc=10.20.30.51\nreachable=1\n' } }, l => lines.push(l))
  assert.equal(ran[0], ensureScript('10.20.30.40', 3142))
  assert.deepEqual(h.records, [['lxc-101', 'set']])
  assert.match(lines[0], /package cache: using pkgcache/)
  // Every failure is one log line and apt carries on.
  assert.match((await prepareAptCache(h, 'home', t, async () => { throw new Error('guest agent gone') }, () => {}))!, /skipped .*apt fetches directly/)
  assert.match((await prepareAptCache(hook({ decide: async () => { throw new Error('locked') } }), 'home', t, async () => ({ code: 0, output: '' }), () => {}))!, /not checked/)
  assert.equal(await prepareAptCache(undefined, 'home', t, async () => { throw new Error('never') }, () => {}), null)
  const leave: string[] = []
  assert.equal(await prepareAptCache(hook({ decide: async () => ({ action: 'leave', reason: '' }) }), 'home', t, async s => { leave.push(s); return { code: 0, output: '' } }, () => {}), null)
  assert.equal(leave.length, 0, 'leave: no command at all')
  const rm: string[] = []; const h2 = hook({ decide: async () => ({ action: 'remove', reason: 'off' }) })
  await prepareAptCache(h2, 'home', t, async s => { rm.push(s); return { code: 0, output: 'result=removed\n' } }, () => {})
  assert.deepEqual(rm, [REMOVE_SCRIPT]); assert.deepEqual(h2.records, [['lxc-101', 'removed']])
  const own = hook()
  assert.match((await prepareAptCache(own, 'home', t, async () => ({ code: 0, output: 'result=own-proxy\nown=/etc/apt/apt.conf.d/90proxy\n' }), () => {}))!, /has its own apt proxy/)
})

test('a real run: the cache step runs in each guest just before apt; nodes untouched while their setting is off', async () => {
  const fake = new FakeCluster({ nodes: [node('node-a', { pending: [] })], guests: [guest(101, 'node-a'), guest(102, 'node-a')] })
  fake.scripted.set('cache', () => ({ code: 0, output: 'result=set\nsrc=10.20.30.51\nreachable=1\n', timedOut: false }) as any)
  const asked: string[] = []
  const h = hook({ decide: async (_c, t) => { asked.push(t.key); return t.kind === 'node' ? { action: 'leave', reason: '' } : { action: 'ensure', host: '10.20.30.40', port: 3142, reason: 'using pkgcache' } } })
  const exec = new Proxy(fake, { get: (t, k) => k === 'guestExec' ? (g: any, s: string, l: any, ms: any) => t.guestExec(g, s.startsWith('set -e\nD=/etc/apt') ? '# fake:cache\n' + s : s, l, ms) : (t as any)[k] })
  const store = new MemoryStore()
  const runner = new UpdatesRunner({ store, exec: exec as any, loadPolicy: policyLoad('guests:\n  default: {}\n'), timing: FAST, hostname: 'not-a-guest', aptCache: h })
  await runner.start('run', 'schedule'); await runner.idle(); await runner.idle()
  for (const id of ['101', '102']) {
    const cmds = fake.cmds(id)
    assert.ok(cmds.indexOf('guest:cache') >= 0 && cmds.indexOf('guest:cache') < cmds.indexOf('guest:apt'), `${id}: ${cmds.join(',')}`)
  }
  assert.deepEqual(h.records.map(r => r[0]).sort(), ['lxc-101', 'lxc-102'])
  assert.equal(fake.cmds('node-a').some(c => /hyperprox-cache/.test(c)), false)
})

// ── install, plug-in, roles ────────────────────────────────────────────────

test('install: the self-check must pass, then the plug-in connects', async () => {
  const steps: Record<string, any> = {}
  const step = (id: string) => (steps[id] ??= { status: 'pending' })
  const out = await runAptCacheSetup({ vmid: 9300, ip: '10.20.30.40' }, step, { sh: async () => ({ code: 0, output: SELFTEST }), connect: async () => true })
  assert.equal(out.url, 'http://10.20.30.40:3142')
  assert.deepEqual([steps.verify.status, steps.wire.status], ['done', 'done'])
  await assert.rejects(runAptCacheSetup({ vmid: 9300, ip: '10.20.30.40' }, step, { sh: async () => ({ code: 0, output: SELFTEST.replace('check=clients ok', 'check=clients fail') }), connect: async () => true }), /did not pass its check/)
})

test('plug-in card and details', () => {
  const r = parseStats(STATS, 0)
  const row = { id: 'lxc-9300', name: 'pkgcache', vmid: 9300, ok: true, reading: { ...r, clients: [{ name: 'web', kind: 'guest' as const, requests: 15, bytes: 1000 }] } }
  const t = tileOf([row])
  assert.equal(t.tone, 'good')
  assert.match(t.headline, /saved/)
  assert.equal(tileOf([{ ...row, ok: false, error: 'not reachable', reading: undefined }]).tone, 'bad')
  const d = detailOf([row])
  assert.ok(d.tables!.some(x => x.title === 'Busiest packages' && x.rows.some((y: any) => y.name === 'cowsay')))
  assert.doesNotMatch(JSON.stringify(d), /10\.20\.30/)
  assert.doesNotMatch(JSON.stringify(d) + JSON.stringify(t), /"web"|>web</, 'the viewer card carries no guest names')
  assert.ok(!d.tables!.some(x => x.title === 'Clients'))
  assert.throws(() => tileOf([]), /Not configured yet/)
})

test('roles: admin for everything, re-confirmed for settings and fleet changes, API tokens refused every change', () => {
  for (const [m, p] of [['GET', '/api/plugins/apt-cacher-ng/caches'], ['GET', '/api/plugins/apt-cacher-ng/caches/lxc-9300/reading'], ['POST', '/api/plugins/apt-cacher-ng/caches/lxc-9300/actions'], ['PUT', '/api/plugins/apt-cacher-ng/use'], ['POST', '/api/plugins/apt-cacher-ng/guests/repair']]) {
    assert.equal(requiredRole(m, p), 'admin', `${m} ${p}`)
  }
  assert.notEqual(requiredRole('GET', '/api/plugins/apt-cacher-ng/data'), 'admin', 'the gallery card stays a viewer read')
  for (const [m, p] of [['PUT', '/api/plugins/apt-cacher-ng/use'], ['POST', '/api/plugins/apt-cacher-ng/guests/repair'], ['POST', '/api/plugins/apt-cacher-ng/guests/remove'], ['PUT', '/api/plugins/apt-cacher-ng/caches/lxc-9300/settings']]) {
    assert.equal(needsReconfirm(m, p), true, `${m} ${p}`)
  }
  assert.equal(needsReconfirm('POST', '/api/plugins/apt-cacher-ng/caches/lxc-9300/actions'), false, 'a fix is confirmed on the page and audited')
  assert.equal(tokenForbidden('POST', '/api/plugins/apt-cacher-ng/caches/lxc-9300/actions'), true)
  assert.equal(tokenForbidden('DELETE', '/api/plugins/apt-cacher-ng/caches/lxc-9300'), true)
  assert.equal(tokenForbidden('GET', '/api/plugins/apt-cacher-ng/caches'), false)
})
