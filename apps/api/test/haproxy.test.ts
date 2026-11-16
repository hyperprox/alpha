// The HAProxy recipe and plug-in: the pinned install script, the Runtime API command builder and readers (fed answers
// recorded from a real HAProxy 3.4 install, names and addresses invented), the reading and its problems, the actions
// (audited first, runtime vs saved, refusals), the Data Plane changes, auto-connect, the install's setup steps, the
// Prometheus target list and the role rules.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CATALOGUE, findRecipe, healthProblem } from '../src/lib/catalogue'
import { installScript } from '../src/lib/install-script'
import { DETECT } from '../src/lib/catalogue-detect'
import { PROBES } from '@hyperprox/hardware/service-probes'
import { HAPROXY_SCRIPT, HAPROXY_DEB, DATAPLANE_VERSION, DATAPLANE_SHA256, HAPROXY_KEY_SHA256, scraperList, ownScrapers } from '../src/lib/haproxy/recipe'
import { RT, runtimeScript, splitAnswers, answerProblem, parseStat, parseServersState, checkFlags, parseConfigRouting, checkWords } from '../src/lib/haproxy/runtime'
import { buildReading, cleanCheck, tileNumbers, type RawReading } from '../src/lib/haproxy/model'
import { HaproxyService, HaproxyRefusal, plainError, scrapersScript, readScript, parseReadOutput, parseDetect, serverNameFor, type GuestRow, type ServiceDeps } from '../src/lib/haproxy/service'
import { HaproxyInstanceStore } from '../src/lib/haproxy/instances'
import { createLoadBalance, persistBalance, persistWeight, checkNewServer, checkHostname, CHECK_PATH_RE, type ConfigWriter } from '../src/lib/haproxy/dataplane'
import { tokenForbidden } from '../src/lib/api-tokens'
import { allTiles, keepScrapersCurrent, resetAppliedScrapers, resetTileCache, prunePublishJobs, TILE_CACHE_MS, type PublishJob } from '../src/lib/haproxy'
import { execFileSync } from 'node:child_process'
import type { DataPlaneTx } from '../src/lib/proxy/providers/haproxy'
import { runHaproxySetup, HAPROXY_SETUP_STEPS } from '../src/lib/haproxy/setup'
import { writeHaproxyTargets } from '../src/lib/haproxy/targets'
import { requiredRole, needsReconfirm } from '../src/lib/roles'
import { ProxyHttpError } from '../src/lib/proxy/http'
import { tileOf } from '../src/plugins/haproxy'
import type { AdapterContext } from '../src/lib/auto-connect/core'

const FX = path.join(__dirname, 'fixtures', 'haproxy')
const fx = (f: string) => fs.readFileSync(path.join(FX, f), 'utf8')
const raw = (stat = 'stat.csv', check = 'check-ok.txt', code = 0): RawReading => ({
  info: fx('info.txt'), stat: fx(stat), state: fx('state.txt'), config: fx('haproxy.cfg'), configCheck: { code, output: fx(check) },
})

// ── the recipe ───────────────────────────────────────────────────────────────

test('recipe: in the Catalogue as a proxy, script-installed without Docker, with HAProxy\'s own setup', () => {
  const r = findRecipe('haproxy')!
  assert.ok(CATALOGUE.includes(r))
  assert.equal(r.category, 'proxy'); assert.equal(r.needsDocker, false); assert.equal(r.setup, 'haproxy'); assert.equal(r.wizard, false)
  assert.equal(r.install.kind, 'script')
  // A fresh HAProxy proves it serves with its own "no server" page; anything else on port 80 does not count.
  assert.equal(healthProblem(r, 503, '<html><body><h1>503 Service Unavailable</h1>\nNo server is available to handle this request.\n</body></html>'), null)
  assert.match(String(healthProblem(r, 503, 'maintenance')), /does not contain/)
  assert.match(String(healthProblem(r, 200, 'hello')), /expected 503/)
})

test('recipe: exact pinned versions, every download checked against a pinned hash, nothing "latest"', () => {
  assert.match(HAPROXY_DEB, /^3\.4\.\d+-1~bpo13\+1$/)
  assert.match(HAPROXY_SCRIPT, new RegExp(`apt-get install -y -qq "haproxy=${HAPROXY_DEB.replace(/[.+~]/g, '\\$&')}"`))
  assert.match(HAPROXY_SCRIPT, /trixie-backports-3\.4 main/)
  assert.match(HAPROXY_SCRIPT, /Pin: version 3\.4\.\*/)
  assert.ok(HAPROXY_SCRIPT.includes(`${HAPROXY_KEY_SHA256}  /etc/apt/keyrings/haproxy-archive-keyring.gpg`))
  assert.ok(HAPROXY_SCRIPT.includes(DATAPLANE_SHA256.amd64) && HAPROXY_SCRIPT.includes(DATAPLANE_SHA256.arm64))
  assert.ok(HAPROXY_SCRIPT.includes(`releases/download/v${DATAPLANE_VERSION}/dataplaneapi_${DATAPLANE_VERSION}_linux_$ARCH.deb`))
  assert.equal((HAPROXY_SCRIPT.match(/sha256sum -c/g) ?? []).length, 2)
  assert.doesNotMatch(HAPROXY_SCRIPT, /latest|__[A-Z_]+__/)
})

test('recipe: nothing the network reaches can change HAProxy; the password never on a command line', () => {
  const s = HAPROXY_SCRIPT
  assert.match(s, /stats socket \/run\/haproxy\/admin\.sock mode 660 level admin/)
  assert.doesNotMatch(s, /stats socket (ipv4@|:|\d)/, 'the Runtime API is never a TCP port')
  assert.match(s, /bind 127\.0\.0\.1:8404\n\s+stats enable/, 'the stats page is loopback only')
  assert.match(s, /dataplaneapi:\n\s+host: 127\.0\.0\.1\n\s+port: 5555/)
  assert.match(s, /insecure: false/, 'the Data Plane keeps a hash, not the password')
  assert.match(s, /openssl passwd -6 -stdin/)
  assert.match(s, /http-request deny deny_status 403 unless hpx_scraper\n\s+http-request use-service prometheus-exporter if \{ path \/metrics \}/)
  assert.match(s, /dpkg -i --force-confold/, 'the package never replaces the loopback-only configuration')
  assert.doesNotMatch(s, /-u "hyperprox:\$DP_PW"|curl[^\n]*\$DP_PW/, 'the password reaches curl on stdin only')
  assert.match(s, /export -n HPX_DP_PASSWORD/)
  assert.match(s, /haproxy -c -q -f "\$CFG"/, 'the configuration is checked before the first reload')
  const full = installScript(findRecipe('haproxy')!, 'debian', { HPX_DP_PASSWORD: 'x'.repeat(32), HPX_SCRAPERS: '10.0.0.5' })
  assert.equal(full.split('\n')[0], 'set -e')
  assert.match(full, /export HPX_SCRAPERS='10\.0\.0\.5'/)
})

test('scrapers: HyperProx\'s own IPv4 addresses only, never loopback or Docker bridges', () => {
  assert.deepEqual(scraperList(['10.0.0.5', '127.0.0.1', '169.254.1.1', 'fe80::1', '10.0.0.5', '999.1.1.1', '198.51.100.7']), ['10.0.0.5', '198.51.100.7'])
  const ifaces: any = {
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }], eth0: [{ family: 'IPv4', address: '10.0.0.5', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }],
    docker0: [{ family: 'IPv4', address: '10.17.0.1', internal: false }], 'br-0123abcd': [{ family: 'IPv4', address: '10.18.0.1', internal: false }],
    tailscale0: [{ family: 'IPv4', address: '10.64.0.9', internal: false }],
  }
  assert.deepEqual(ownScrapers(ifaces), ['10.0.0.5', '10.64.0.9'])
})

test('detection: the Catalogue fingerprint and the scan probe know HAProxy', () => {
  const page = '<html><body><h1>503 Service Unavailable</h1>\nNo server is available to handle this request.\n</body></html>\n'
  assert.deepEqual(DETECT.haproxy[0].match({ status: 503, headers: {}, body: page }), { version: null })
  assert.equal(DETECT.haproxy[0].match({ status: 503, headers: {}, body: 'Service Unavailable' }), null)
  const p = PROBES.find((x: any) => x.key === 'haproxy')!
  assert.equal(p.port, 8405); assert.equal(p.pluginId, 'haproxy')
  assert.ok(p.match(200, '# HELP haproxy_process_nbthread Number of started threads\nhaproxy_process_nbthread 1\n'))
  assert.ok(!p.match(403, '<html>403 Forbidden</html>'))
})

// ── the Runtime API ─────────────────────────────────────────────────────────

test('runtime commands: built only from HAProxy names and numbers in range', () => {
  assert.equal(RT.setState('hpx_lb_web', 'web1', 'drain'), 'set server hpx_lb_web/web1 state drain')
  assert.equal(RT.setWeight('be', 's', 256), 'set weight be/s 256')
  assert.throws(() => RT.setWeight('be', 's', 300), /0 to 256/, 'HAProxy refuses weights above 256')
  assert.throws(() => RT.setState('be; shutdown', 's', 'ready'), /letters, digits/)
  assert.throws(() => RT.setState('be', 's', 'up' as any), /ready, drain or maint/)
  assert.equal(RT.addServer('be', 'app-101', '10.0.0.21', 8080, 100, true), 'add server be/app-101 10.0.0.21:8080 weight 100 check')
  assert.throws(() => RT.addServer('be', 's', '10.0.0.1 check', 80, 1, false), /IPv4 address or a host name/)
  assert.throws(() => RT.addServer('be', 's', '10.0.0.1', 70000, 1, false), /1 to 65535/)
  assert.throws(() => runtimeScript('/run/../etc/passwd.sock', []), /not a socket path/)
  assert.throws(() => runtimeScript('/run/haproxy/admin.sock', ['show stat; rm -rf /']), /not a command/)
  const sc = runtimeScript('/run/haproxy/admin.sock', ['show info'])
  assert.match(sc, /<<'HPX_COMMANDS'\nshow info\nHPX_COMMANDS$/, 'commands travel in a quoted heredoc, not on a command line')
})

test('runtime answers: split by command; HAProxy\'s refusals are problems, its acknowledgements are not', () => {
  const a = splitAnswers('### set weight be/s 300\nAbsolute weight can only be between 0 and 256 inclusive.\n### set server be/s state drain\n\n')
  assert.equal(a.size, 2)
  assert.match(String(answerProblem(a.get('set weight be/s 300')!)), /can only be between 0 and 256/)
  assert.equal(answerProblem(a.get('set server be/s state drain')!), null)
  assert.equal(answerProblem('New server registered.'), null)
  assert.equal(answerProblem('100 (initial 100)'), null)
  assert.match(String(answerProblem('No such server.')), /No such server/)
  assert.match(String(answerProblem('HPX_NO_CLIENT')), /socat nor python3/)
})

test('readers: show stat by field name, show servers state, check flags, routing from the configuration', () => {
  const rows = parseStat(fx('stat.csv'))
  const web1 = rows.find(r => r.pxname === 'hpx_lb_web' && r.svname === 'web1')!
  assert.equal(web1.status, 'UP'); assert.equal(web1.check_status, 'L7OK'); assert.equal(web1.addr, '198.51.100.11:8080'); assert.equal(web1.weight, '100')
  assert.equal(rows.find(r => r.svname === 'BACKEND')!.algo, 'roundrobin')
  const st = parseServersState(fx('state.txt'))
  assert.equal(st.length, 2); assert.equal(st[0].srv_name, 'web1')
  assert.deepEqual(checkFlags(st[0].srv_check_state), { configured: true, enabled: true })
  assert.deepEqual(checkFlags('2'), { configured: true, enabled: false })
  const map = parseConfigRouting(fx('haproxy.cfg'))
  assert.deepEqual(map.frontends.http.backends, ['hpx_lb_web'])
  assert.deepEqual(map.frontends.http.binds, [':80'])
  assert.equal(map.backends.hpx_lb_web.balance, 'roundrobin')
  assert.equal(checkWords('L4CON', 'Layer4 connection problem'), 'the connection was refused or could not be made')
  assert.equal(checkWords('L7STS', '', '500'), 'the check page answered with an error status (500)')
})

// ── the reading ─────────────────────────────────────────────────────────────

test('reading (all up): frontend http → backend → two servers up, monitoring frontends marked internal, no problems', () => {
  const r = buildReading(raw(), new Date('2026-11-16T03:20:00Z'))
  assert.equal(r.version, '3.4.7-1~bpo13+1')
  const http = r.frontends.find(f => f.name === 'http')!
  assert.deepEqual(http.backends, ['hpx_lb_web']); assert.equal(http.internal, false)
  assert.ok(r.frontends.find(f => f.name === 'hpx_metrics')!.internal)
  const be = r.backends.find(b => b.name === 'hpx_lb_web')!
  assert.equal(be.algorithm, 'roundrobin'); assert.equal(be.healthy, 2)
  assert.deepEqual(be.servers.map(s => [s.name, s.state, s.weight, s.check.code, s.dynamic]), [['web1', 'up', 100, 'L7OK', false], ['web2', 'up', 100, 'L7OK', false]])
  assert.equal(be.servers[0].total, 26)
  assert.equal(r.config.ok, true)
  assert.deepEqual(r.problems, [])
  assert.deepEqual(tileNumbers(r), { backends: 1, servers: 2, up: 2, down: 0, critical: 0, problems: 0 })
})

test('reading (one draining, one down): a loud alert for the backend, the check reason and both fixes for the server', () => {
  const r = buildReading(raw('stat-mixed.csv'))
  const be = r.backends.find(b => b.name === 'hpx_lb_web')!
  assert.deepEqual(be.servers.map(s => s.state), ['drain', 'down'])
  assert.equal(be.healthy, 0)
  const [first, second] = r.problems
  assert.equal(first.severity, 'critical'); assert.match(first.title, /no healthy server: visitors get errors/)
  assert.match(first.detail, /web1 is in drain/)
  assert.deepEqual(first.fixes.map(f => f.id), ['ready', 'retry'])
  assert.equal(second.server, 'web2'); assert.match(second.detail, /the connection was refused or could not be made/)
  assert.deepEqual(second.fixes.map(f => f.id), ['drain', 'retry'])
  assert.match(String(second.fixes[0].confirm), /drain/, 'a drain is confirmed first')
})

test('reading (maintenance + down) and a configuration that fails haproxy -c', () => {
  const r = buildReading(raw('stat-down.csv', 'check-fail.txt', 1))
  assert.deepEqual(r.backends.find(b => b.name === 'hpx_lb_web')!.servers.map(s => s.state), ['maint', 'down'])
  assert.equal(r.config.ok, false)
  assert.equal(r.config.error, "line 75: balance only supports 'roundrobin', 'static-rr', 'leastconn', 'source', 'uri', 'url_param', 'hash', 'hdr(name)', 'rdp-cookie(name)', 'log-hash' and 'sticky' options.")
  const cfg = r.problems.find(p => p.id === 'config')!
  assert.deepEqual(cfg.fixes.map(f => f.id), ['check-config'])
  assert.doesNotMatch(cleanCheck(fx('check-fail.txt')), /\/tmp|NOTICE|WARNING/)
})

test('read script and its output: no socket and no client are plain refusals; the exit code of haproxy -c is kept', () => {
  assert.match(readScript('/run/haproxy/admin.sock'), /haproxy -c -f "\$CFG"/)
  assert.throws(() => parseReadOutput('HPX_NO_SOCKET\n'), /socket is not there/)
  const out = ['### show info', fx('info.txt'), '### show stat', fx('stat.csv'), '### show servers state', fx('state.txt'), '### config', fx('haproxy.cfg'), '### check', fx('check-fail.txt')].join('\n')
  const r = parseReadOutput(out)
  assert.equal(r.config.ok, false)
  assert.equal(r.backends.length, 1 + 0)
})

// ── the service ─────────────────────────────────────────────────────────────

const ROWS: GuestRow[] = [
  { kind: 'lxc', vmid: 150, name: 'lb', node: 'node1', running: true, excludedBy: null, addresses: ['10.0.0.50'] },
  { kind: 'lxc', vmid: 151, name: 'app-a', node: 'node1', running: true, excludedBy: null, addresses: ['10.0.0.51'] },
  { kind: 'lxc', vmid: 152, name: 'app-b', node: 'node2', running: true, excludedBy: null, addresses: ['10.0.0.52'] },
  { kind: 'lxc', vmid: 153, name: 'secret', node: 'node2', running: true, excludedBy: 'the hyperprox-ignore tag', addresses: ['10.0.0.53'] },
]

function memIO() {
  const m = new Map<string, string>()
  return { get: async (c: string, p: string, k: string) => m.get(`${c}/${p}/${k}`) ?? null, set: async (c: string, p: string, k: string, v: string) => { m.set(`${c}/${p}/${k}`, v) } }
}

function fakeWriter() {
  const calls: string[] = []
  const cfg: Record<string, any> = {
    '/backends': [{ name: 'hpx_lb_web' }], '/backends/hpx_lb_web': { name: 'hpx_lb_web', mode: 'http', balance: { algorithm: 'roundrobin' } },
    '/backends/hpx_lb_web/servers': [{ name: 'web1', address: '198.51.100.11', port: 8080, weight: 100, check: 'enabled' }],
    '/frontends/http': { name: 'http', mode: 'http' }, '/frontends/http/backend_switching_rules': [],
  }
  const w: ConfigWriter = {
    async configRead<T>(p: string) { return cfg[p] as T },
    async configChange(what, fn) {
      calls.push(`begin ${what}`)
      const tx: DataPlaneTx = { get: async <T>(p: string) => structuredClone(cfg[p]) as T, send: async (m, p, body) => { calls.push(`${m} ${p} ${JSON.stringify(body ?? null)}`); return null as any } }
      await fn(tx)
      calls.push('commit')
    },
  }
  return { w, calls, cfg }
}

async function rig(o: { scripts?: Array<[RegExp, string]>; writer?: ConfigWriter | null; auditFails?: boolean; instance?: Partial<{ proxyInstanceId: string | null; vmid: number }> } = {}) {
  const store = new HaproxyInstanceStore(memIO())
  const inst = await store.add({ name: 'lb', guest: { kind: 'lxc', vmid: o.instance?.vmid ?? 150 }, socket: '/run/haproxy/admin.sock', proxyInstanceId: o.instance?.proxyInstanceId === undefined ? 'px-abcdefghij' : o.instance.proxyInstanceId, via: 'catalogue' })
  const log: string[] = []
  const scripts: string[] = []
  const deps: ServiceDeps = {
    store,
    exec: async (_g, script) => {
      scripts.push(script); log.push('exec')
      for (const [re, out] of o.scripts ?? []) if (re.test(script)) return { code: 0, output: out }
      const cmds = [...script.matchAll(/^(set |enable |disable |add |del |shutdown )[^\n]*$/gm)].map(m => m[0])
      return { code: 0, output: cmds.map(c => `### ${c}\n`).join('') }
    },
    writer: async () => (o.writer === undefined ? fakeWriter().w : o.writer),
    audit: async (a, _r, d) => { if (o.auditFails) throw new Error('audit down'); log.push(`audit ${a} ${JSON.stringify(d)}`) },
    guests: async () => ROWS,
    sightings: async () => [],
    proxyInstances: async () => [],
    dismissed: async (k) => { log.push(`dismissed ${k}`) },
    now: () => 1_800_000_000_000,
  }
  return { svc: new HaproxyService(deps), inst, log, scripts, store }
}

const admin = { email: 'admin@example.com', role: 'admin' }

test('actions: audited before anything runs; a failed audit stops the action', async () => {
  const { svc, inst, log, scripts } = await rig()
  const r = await svc.act(inst.id, 'state', { backend: 'hpx_lb_web', server: 'web1', state: 'drain' }, admin)
  assert.equal(r.scope, 'runtime'); assert.match(r.message, /draining[\s\S]*Runtime only/)
  assert.ok(log[0].startsWith('audit haproxy.state'), 'the audit row is written first')
  assert.match(scripts[0], /\nset server hpx_lb_web\/web1 state drain\n/)
  const b = await rig({ auditFails: true })
  await assert.rejects(b.svc.act(b.inst.id, 'state', { backend: 'hpx_lb_web', server: 'web1', state: 'maint' }, admin), /audit down/)
  assert.equal(b.scripts.length, 0, 'nothing ran')
})

test('actions: weight, health, retry, add and remove at runtime send exactly the checked commands', async () => {
  const { svc, inst, scripts } = await rig({ scripts: [[/show servers state/, ['### show info', fx('info.txt'), '### show stat', fx('stat-mixed.csv'), '### show servers state', fx('state.txt'), '### config', fx('haproxy.cfg'), '### check', 'HPX_EXIT=0'].join('\n')]] })
  assert.match((await svc.act(inst.id, 'weight', { backend: 'hpx_lb_web', server: 'web2', weight: 0 }, admin)).message, /no new traffic/)
  await assert.rejects(svc.act(inst.id, 'weight', { backend: 'hpx_lb_web', server: 'web2', weight: 300 }, admin), (e: any) => e instanceof HaproxyRefusal && /0 to 256/.test(e.message))
  await svc.act(inst.id, 'health', { backend: 'hpx_lb_web', server: 'web1', on: false }, admin)
  const retry = await svc.act(inst.id, 'retry', { backend: 'hpx_lb_web', server: 'web2' }, admin)
  assert.match(retry.message, /new health check started for web2/)
  await svc.act(inst.id, 'add-server', { backend: 'hpx_lb_web', guest: { kind: 'lxc', vmid: 151 }, port: 8080 }, admin)
  await svc.act(inst.id, 'remove-server', { backend: 'hpx_lb_web', server: 'web2' }, admin)
  const sent = scripts.flatMap(s => [...s.matchAll(/^(set |enable |disable |add |del |shutdown )[^\n]*$/gm)].map(m => m[0]))
  assert.deepEqual(sent, [
    'set weight hpx_lb_web/web2 0',
    'disable health hpx_lb_web/web1',
    'disable health hpx_lb_web/web2', 'enable health hpx_lb_web/web2',
    'add server hpx_lb_web/app-a-151 10.0.0.51:8080 weight 100 check', 'enable health hpx_lb_web/app-a-151', 'enable server hpx_lb_web/app-a-151',
    'set server hpx_lb_web/web2 state maint', 'shutdown sessions server hpx_lb_web/web2', 'del server hpx_lb_web/web2',
  ])
})

test('actions: a refused Runtime API command is an error in HAProxy\'s words, never "done"', async () => {
  const { svc, inst } = await rig({ scripts: [[/set weight/, '### set weight hpx_lb_web/nope 10\nNo such server.\n']] })
  await assert.rejects(svc.act(inst.id, 'weight', { backend: 'hpx_lb_web', server: 'nope', weight: 10 }, admin), /HAProxy refused "set weight hpx_lb_web\/nope 10": No such server/)
})

test('actions: saved changes go through the Data Plane; drain has no saved form; no Data Plane means runtime only', async () => {
  const fw = fakeWriter()
  const { svc, inst, scripts } = await rig({ writer: fw.w })
  const r = await svc.act(inst.id, 'weight', { backend: 'hpx_lb_web', server: 'web1', weight: 50, persist: true }, admin)
  assert.equal(r.scope, 'saved'); assert.match(r.message, /checked with haproxy -c/)
  assert.equal(scripts.length, 0, 'a saved change sends nothing to the socket')
  assert.deepEqual(fw.calls, ['begin setting web1\'s weight to 50', 'PUT /backends/hpx_lb_web/servers/web1 {"name":"web1","address":"198.51.100.11","port":8080,"weight":50,"check":"enabled"}', 'commit'])
  await assert.rejects(svc.act(inst.id, 'state', { backend: 'hpx_lb_web', server: 'web1', state: 'drain', persist: true }, admin), /Drain is runtime only/)
  const { svc: s2, inst: i2 } = await rig({ writer: null, instance: { proxyInstanceId: null } })
  await assert.rejects(s2.act(i2.id, 'balance', { backend: 'hpx_lb_web', algorithm: 'leastconn' }, admin), (e: any) => e.code === 'runtime_only' && /no Data Plane API connected/.test(e.message))
  await assert.rejects(svc.act(inst.id, 'balance', { backend: 'hpx_lb_web', algorithm: 'fastest' }, admin), /one of roundrobin, leastconn/)
})

test('actions: a guest HyperProx leaves alone is refused before any script, naming the rule', async () => {
  const { svc, inst, scripts } = await rig({ instance: { vmid: 153 } })
  await assert.rejects(svc.reading(inst.id), (e: any) => e.code === 'excluded' && /hyperprox-ignore tag/.test(e.message))
  await assert.rejects(svc.act(inst.id, 'ready', { backend: 'b', server: 's' }, admin), /hyperprox-ignore/)
  const ok = await rig()
  await assert.rejects(ok.svc.act(ok.inst.id, 'add-server', { backend: 'hpx_lb_web', guest: { kind: 'lxc', vmid: 153 }, port: 80 }, admin), /leaves it alone/)
  assert.equal(scripts.length, 0)
  assert.deepEqual((await ok.svc.pickable()).map(g => g.vmid), [150, 151, 152], 'the picker never offers it')
})

test('load-balance this app: two guests → one backend with HTTP checks and a host rule, audited', async () => {
  const fw = fakeWriter()
  const { svc, inst, log } = await rig({ writer: fw.w })
  const r = await svc.loadBalance(inst.id, { name: 'Shop', guests: [{ kind: 'lxc', vmid: 151 }, { kind: 'lxc', vmid: 152 }], port: 3000, hostname: 'shop.example.com', algorithm: 'leastconn', checkPath: '/health' }, admin)
  assert.equal(r.backend, 'hpx_lb_shop'); assert.match(r.message, /visitors to shop\.example\.com across 2 servers by leastconn/)
  assert.ok(log.some(l => l.startsWith('audit haproxy.load-balance')))
  assert.deepEqual(fw.calls.slice(1, -1), [
    'POST /backends {"name":"hpx_lb_shop","mode":"http","balance":{"algorithm":"leastconn"},"adv_check":"httpchk","httpchk_params":{"method":"GET","uri":"/health"}}',
    'POST /backends/hpx_lb_shop/servers {"name":"app-a-151","address":"10.0.0.51","port":3000,"weight":100,"check":"enabled"}',
    'POST /backends/hpx_lb_shop/servers {"name":"app-b-152","address":"10.0.0.52","port":3000,"weight":100,"check":"enabled"}',
    'POST /frontends/http/backend_switching_rules/0 {"name":"hpx_lb_shop","cond":"if","cond_test":"{ req.hdr(host),field(1,:) -i shop.example.com }"}',
  ])
  await assert.rejects(svc.loadBalance(inst.id, { name: 'x', guests: [{ kind: 'lxc', vmid: 151 }], port: 80 }, admin), /at least two guests/)
  await assert.rejects(svc.loadBalance(inst.id, { name: 'x', guests: [{ kind: 'lxc', vmid: 151 }, { kind: 'lxc', vmid: 151 }], port: 80 }, admin), /picked twice/)
  await assert.rejects(svc.loadBalance(inst.id, { name: 'x', guests: [{ kind: 'lxc', vmid: 151 }, { kind: 'lxc', vmid: 153 }], port: 80 }, admin), /leaves it alone/)
})

test('Data Plane: an existing backend name or a taken default is refused inside the transaction (nothing committed)', async () => {
  const fw = fakeWriter()
  const lb = (o: any) => createLoadBalance(fw.w, { backend: 'hpx_lb_web', algorithm: 'roundrobin', frontend: 'http', hostname: null, checkPath: '/',
    servers: [{ name: 'a', address: '10.0.0.1', port: 80, weight: 1, check: true }, { name: 'b', address: '10.0.0.2', port: 80, weight: 1, check: true }], ...o })
  await assert.rejects(lb({}), /already exists/)
  fw.cfg['/frontends/http'].default_backend = 'other'
  await assert.rejects(lb({ backend: 'hpx_lb_new' }), /already sends everything else to other/)
  assert.ok(!fw.calls.includes('commit'))
  await persistBalance(fw.w, 'hpx_lb_web', 'source')
  assert.match(fw.calls.join('\n'), /PUT \/backends\/hpx_lb_web \{"name":"hpx_lb_web","mode":"http","balance":\{"algorithm":"source"\}\}/)
  await assert.rejects(persistWeight(fw.w, 'hpx_lb_web', 'ghost', 5), /not in hpx_lb_web's saved configuration/)
})

// ── auto-connect ────────────────────────────────────────────────────────────

const acx = (o: Partial<AdapterContext> = {}, audits: string[] = []): AdapterContext => ({
  dismissed: () => false, autoConnectedBefore: () => false, excludedMachines: new Set(), excludedSubnets: [], vaultItems: () => [],
  audit: async (a, r) => { audits.push(`${a} ${r}`) }, now: () => 0, ...o,
})

test('auto-connect: the Proxy page\'s HAProxy and a scan sighting connect by themselves, linked to the Data Plane', async () => {
  const store = new HaproxyInstanceStore(memIO())
  const scripts: string[] = []
  const svc = new HaproxyService({
    store, exec: async (g, s) => { scripts.push(`${g.vmid}`); return { code: 0, output: g.vmid === 152 ? 'SOCKET=/run/haproxy/admin.sock\nSOCKET=/run/haproxy/other.sock\nCLIENT=socat\n' : 'SOCKET=/run/haproxy/admin.sock\nCLIENT=socat\n' } },
    writer: async () => null, audit: async () => {}, guests: async () => ROWS,
    sightings: async () => [{ guest: { kind: 'lxc', vmid: 151 }, via: 'scan' }, { guest: { kind: 'lxc', vmid: 152 }, via: 'scan' }, { guest: { kind: 'lxc', vmid: 153 }, via: 'scan' }],
    proxyInstances: async () => [{ id: 'px-0123456789', name: 'HAProxy 150', vmid: 150 }],
    dismissed: async () => {},
  })
  const audits: string[] = []
  const out = await svc.autoConnect(acx({ dismissed: k => k === 'lxc-151' }, audits))
  const by = Object.fromEntries(out.map(o => [o.key, o.did]))
  assert.deepEqual(by, { 'lxc-150': 'connected', 'lxc-151': 'dismissed', 'lxc-152': 'ambiguous', 'lxc-153': 'excluded' })
  assert.deepEqual(scripts.sort(), ['150', '152'], 'nothing runs in a dismissed or excluded guest')
  const [i] = await store.list()
  assert.equal(i.proxyInstanceId, 'px-0123456789'); assert.equal(i.socket, '/run/haproxy/admin.sock')
  assert.equal(i.via, 'proxy')
  assert.deepEqual(audits, ['haproxy.autoconnect haproxy:lxc-150'])
  assert.equal((await svc.autoConnect(acx()))[0].did, 'present', 'a second pass changes nothing')
  assert.deepEqual(parseDetect('SOCKET=/a.sock\nSOCKET=/a.sock\n'), { sockets: ['/a.sock'], client: false })
})

test('auto-connect: an instance connected before its Proxy page entry existed is linked later (filled)', async () => {
  const store = new HaproxyInstanceStore(memIO())
  await store.add({ name: 'lb', guest: { kind: 'lxc', vmid: 150 }, socket: '/run/haproxy/admin.sock', proxyInstanceId: null, via: 'scan' })
  const svc = new HaproxyService({ store, exec: async () => ({ code: 0, output: '' }), writer: async () => null, audit: async () => {}, guests: async () => ROWS,
    sightings: async () => [], proxyInstances: async () => [{ id: 'px-0123456789', name: 'x', vmid: 150 }], dismissed: async () => {} })
  const out = await svc.autoConnect(acx())
  assert.equal(out[0].did, 'filled')
  assert.equal((await store.list())[0].proxyInstanceId, 'px-0123456789')
})

test('disconnect: remembered as dismissed, so auto-connect never adds it back by itself', async () => {
  const { svc, inst, log, store } = await rig()
  await svc.remove(inst.id, admin)
  assert.ok(log.includes('dismissed lxc-150'))
  assert.deepEqual(await store.list(), [])
})

// ── the install's setup ─────────────────────────────────────────────────────

test('setup: Proxy page instance (Managed, through the container), plug-in linked, metrics listed, install vault copy dropped', async () => {
  const store = new HaproxyInstanceStore(memIO())
  const made: any[] = [], deleted: string[] = []
  let synced = 0
  const steps = new Map<string, { status: string; detail?: string }>()
  const r = await runHaproxySetup({ name: 'HAProxy 150', ip: '10.0.0.50', node: 'node1', vmid: 150, secret: 'S'.repeat(32), owner: 'admin@example.com', vault: { category: 'apps', provider: 'haproxy-150' } },
    id => { const s = { status: 'pending' }; steps.set(id, s); return s },
    { createProxyInstance: async (input, owner) => { made.push({ input, owner }); return 'px-0123456789' }, store, audit: async () => {}, syncTargets: async () => { synced++; return true },
      deleteSecrets: async (c, p) => { deleted.push(`${c}/${p}`) } })
  assert.deepEqual([...steps.keys()], HAPROXY_SETUP_STEPS.map(s => s.id))
  assert.ok([...steps.values()].every(s => s.status === 'done'))
  assert.equal(made[0].input.kind, 'haproxy'); assert.equal(made[0].input.mode, 'managed'); assert.equal(made[0].input.url, 'http://127.0.0.1:5555')
  assert.deepEqual(made[0].input.settings, { api_via: 'guest', user: 'hyperprox', frontend: 'http' })
  assert.deepEqual(made[0].input.managed, { node: 'node1', vmid: 150, recipe: 'haproxy' })
  assert.deepEqual(deleted, ['apps/haproxy-150'])
  assert.equal(synced, 1)
  const [i] = await store.list()
  assert.equal(i.id, r.pluginInstanceId); assert.equal(i.proxyInstanceId, 'px-0123456789'); assert.equal(i.via, 'catalogue')
})

test('Prometheus list: written whole, readable by Prometheus, unchanged content not rewritten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-haproxy-targets-'))
  const old = process.umask(0o077)
  try {
    assert.equal(writeHaproxyTargets([{ id: 'h00000001', name: 'lb', target: '10.0.0.50:8405' }], dir), true)
    const p = path.join(dir, 'haproxy.json')
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), [{ targets: ['10.0.0.50:8405'], labels: { hpx_haproxy: 'h00000001', haproxy_name: 'lb' } }])
    assert.equal(fs.statSync(p).mode & 0o777, 0o644, 'never root-only, whatever the umask')
    assert.equal(writeHaproxyTargets([{ id: 'h00000001', name: 'lb', target: '10.0.0.50:8405' }], dir), false)
  } finally { process.umask(old); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('roles: every HAProxy route is admin, reads included; the gallery card stays a viewer read; nothing re-confirmed', () => {
  for (const [m, p] of [['GET', '/api/plugins/haproxy/instances'], ['GET', '/api/plugins/haproxy/instances/h00000001/reading'], ['GET', '/api/plugins/haproxy/guests'],
    ['POST', '/api/plugins/haproxy/instances/h00000001/actions/drain'], ['POST', '/api/plugins/haproxy/instances/h00000001/load-balance'],
    ['DELETE', '/api/plugins/haproxy/instances/h00000001'], ['GET', '/api/plugins/haproxy/publish-jobs/x']]) {
    assert.equal(requiredRole(m, p), 'admin', `${m} ${p}`)
  }
  assert.equal(requiredRole('GET', '/api/plugins/haproxy/data'), 'viewer')
  assert.equal(needsReconfirm('POST', '/api/plugins/haproxy/instances/h00000001/actions/weight'), false)
})

test('gallery card: healthy, a backend with no healthy server, unreachable; and server names from guests', () => {
  assert.throws(() => tileOf([]), /connects a HAProxy it finds by itself/)
  const ok = tileOf([{ id: 'h1', name: 'lb', numbers: { backends: 2, servers: 4, up: 4, down: 0, critical: 0, problems: 0 }, configOk: true, error: null }])
  assert.equal(ok.tone, 'good'); assert.equal(ok.headline, '4/4 servers up · 2 backends')
  const bad = tileOf([{ id: 'h1', name: 'lb', numbers: { backends: 2, servers: 4, up: 2, down: 2, critical: 1, problems: 3 }, configOk: true, error: null },
    { id: 'h2', name: 'edge', numbers: null, configOk: null, error: 'HAProxy\'s Runtime API socket is not there.' }])
  assert.equal(bad.tone, 'bad'); assert.match(bad.headline, /lb: 1 backend with no healthy server \(\+1\)/)
  assert.equal(serverNameFor('My App!', 151), 'my-app-151')
})

test('a change the Data Plane refuses is said plainly: nothing applied, no request path or transaction id', () => {
  // Recorded from the real install: a schema refusal inside a transaction.
  const e = plainError(new ProxyHttpError('HAProxy Data Plane: POST /v3/services/haproxy/configuration/backends?transaction_id=0f0e answered 422: default_server.inter in body should be greater than or equal to 0', 422, '')) as HaproxyRefusal
  assert.ok(e instanceof HaproxyRefusal)
  assert.equal(e.message, "HAProxy's Data Plane API refused the change, so nothing was applied: default_server.inter in body should be greater than or equal to 0")
  assert.doesNotMatch(e.message, /transaction_id|\/v3\//)
  assert.equal((plainError(new ProxyHttpError('x answered 503: busy', 503, '')) as HaproxyRefusal).code, 'unreachable')
})

// ── review follow-ups ───────────────────────────────────────────────────────

test('API tokens can never act on HAProxy: actions, load-balance and disconnect are a signed-in admin\'s', () => {
  assert.equal(tokenForbidden('POST', '/api/plugins/haproxy/instances/h00000001/actions/drain'), true)
  assert.equal(tokenForbidden('POST', '/api/plugins/haproxy/instances/h00000001/actions/balance'), true)
  assert.equal(tokenForbidden('POST', '/api/plugins/haproxy/instances/h00000001/load-balance'), true)
  assert.equal(tokenForbidden('DELETE', '/api/plugins/haproxy/instances/h00000001'), true)
  assert.equal(tokenForbidden('GET', '/api/plugins/haproxy/instances/h00000001/reading'), false, 'reads stay open to an admin token')
  assert.equal(tokenForbidden('GET', '/api/plugins/haproxy/instances'), false)
})

test('servers: HAProxy\'s own loopback control ports are refused; newlines never reach a name, address, host or path', () => {
  for (const port of [5555, 8404, 8405]) {
    for (const address of ['127.0.0.1', '127.0.0.9', 'localhost']) assert.throws(() => checkNewServer({ name: 's', address, port }), /HAProxy's own control port/)
  }
  assert.equal(checkNewServer({ name: 's', address: '127.0.0.1', port: 8080 }).port, 8080)
  assert.equal(checkNewServer({ name: 's', address: '10.0.0.5', port: 8405 }).port, 8405, 'another guest\'s 8405 is its own business')
  assert.throws(() => checkNewServer({ name: 's', address: '10.0.0.5\nset server x/y state maint', port: 80 }), /IPv4 address or a host name/)
  assert.throws(() => checkNewServer({ name: 'a\nb', address: '10.0.0.5', port: 80 }), /letters, digits/)
  assert.throws(() => checkHostname('shop.example.com\nevil.example.com'), /full host name/)
  assert.throws(() => checkHostname('shop.example.com }\nuse_backend x'), /full host name/)
  assert.equal(CHECK_PATH_RE.test('/health\nhttp-request deny'), false)
  assert.equal(CHECK_PATH_RE.test('/health'), true)
})

test('load-balance refuses a newline in the host name or check path before anything is saved', async () => {
  const fw = fakeWriter()
  const { svc, inst } = await rig({ writer: fw.w })
  const base = { name: 'shop', guests: [{ kind: 'lxc', vmid: 151 }, { kind: 'lxc', vmid: 152 }], port: 3000 }
  await assert.rejects(svc.loadBalance(inst.id, { ...base, hostname: 'shop.example.com\nother' }, admin), /full host name/)
  await assert.rejects(svc.loadBalance(inst.id, { ...base, checkPath: '/ok\nbad' }, admin), /health check path/)
  assert.deepEqual(fw.calls, [], 'nothing reached the Data Plane')
})

test('a publish that cannot start is said beside the saved change, never instead of it', async () => {
  const fw = fakeWriter()
  const { svc, inst } = await rig({ writer: fw.w })
  const r = await svc.loadBalance(inst.id, { name: 'shop', guests: [{ kind: 'lxc', vmid: 151 }, { kind: 'lxc', vmid: 152 }], port: 3000, hostname: 'shop.example.com' }, admin,
    async () => { throw new Error('The DNS provider is no longer set up.') })
  assert.equal(r.scope, 'saved')
  assert.ok(fw.calls.includes('commit'))
  assert.match(r.message, /^HAProxy now spreads visitors to shop\.example\.com[\s\S]*Publishing shop\.example\.com did not start[\s\S]*DNS provider is no longer set up/)
  assert.equal(r.publishProblem, 'The DNS provider is no longer set up.')
})

test('metrics allow-list: rewritten only when it differs, checked with haproxy -c, put back if the check fails (real shell)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-haproxy-scrapers-'))
  try {
    const bin = path.join(dir, 'bin'); fs.mkdirSync(bin)
    // Stand-ins for haproxy and systemctl: the check passes unless FAIL exists; the reload is recorded.
    fs.writeFileSync(path.join(bin, 'haproxy'), `#!/bin/sh\n[ -e ${dir}/FAIL ] && { echo "[ALERT] (1) : config : parsing [/etc/haproxy/haproxy.cfg:5] : bad acl"; exit 1; }\nexit 0\n`, { mode: 0o755 })
    fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\necho "$@" >> ${dir}/reloads\n`, { mode: 0o755 })
    const list = path.join(dir, 'hyperprox-scrapers.lst')
    const run = (addrs: string[]) => execFileSync('bash', ['-c', scrapersScript(addrs).split('/etc/haproxy/hyperprox-scrapers.lst').join(list)], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' }).trim()
    assert.equal(run(['10.0.0.5']), 'HPX_NO_LIST', 'a HAProxy without the list is left alone')
    fs.writeFileSync(list, '10.0.0.5\n')
    assert.equal(run(['10.0.0.5']), 'HPX_SAME')
    assert.equal(run(['10.0.0.5', '10.0.0.6']), 'HPX_RELOADED')
    assert.equal(fs.readFileSync(list, 'utf8'), '10.0.0.5\n10.0.0.6\n')
    assert.equal(fs.statSync(list).mode & 0o777, 0o644)
    assert.equal(fs.readFileSync(path.join(dir, 'reloads'), 'utf8').trim(), 'reload haproxy')
    fs.writeFileSync(path.join(dir, 'FAIL'), '')
    assert.throws(() => run(['10.0.0.7']))
    assert.equal(fs.readFileSync(list, 'utf8'), '10.0.0.5\n10.0.0.6\n', 'the previous list is put back')
    assert.throws(() => scrapersScript(['10.0.0.5\nevil']), /Only IPv4/)
    assert.throws(() => scrapersScript([]), /Only IPv4/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('metrics allow-list follows HyperProx\'s addresses: once per change, every Catalogue instance, audited', async () => {
  resetAppliedScrapers()
  const { svc, inst, scripts, log } = await rig({ scripts: [[/hyperprox-scrapers\.lst/, 'HPX_RELOADED\n']] })
  assert.deepEqual(await keepScrapersCurrent(svc, { addresses: ['10.0.0.9'] }), { [inst.id]: 'reloaded' })
  assert.match(scripts[0], /<<'HPX_LIST'\n10\.0\.0\.9\nHPX_LIST/)
  assert.ok(log.some(l => l.startsWith('audit haproxy.metrics-allow-list')))
  assert.deepEqual(await keepScrapersCurrent(svc, { addresses: ['10.0.0.9'] }), {}, 'unchanged addresses: nothing runs')
  assert.equal(scripts.length, 1)
  assert.deepEqual(Object.values(await keepScrapersCurrent(svc, { addresses: ['10.0.0.9'], force: true })), ['reloaded'], 'a targets sync always checks')
  resetAppliedScrapers()
})

test('gallery card: one guest read per HAProxy per 20 seconds, however many ask', async () => {
  resetTileCache()
  const out = ['### show info', fx('info.txt'), '### show stat', fx('stat.csv'), '### show servers state', fx('state.txt'), '### config', fx('haproxy.cfg'), '### check', 'HPX_EXIT=0'].join('\n')
  const { svc, scripts } = await rig({ scripts: [[/show servers state/, out]] })
  let t = 1_000_000
  const [a, b] = await Promise.all([allTiles(svc, () => t), allTiles(svc, () => t)])
  assert.deepEqual(a, b); assert.equal(a[0].numbers?.up, 2)
  t += TILE_CACHE_MS - 1; await allTiles(svc, () => t)
  assert.equal(scripts.length, 1)
  t += 2; await allTiles(svc, () => t)
  assert.equal(scripts.length, 2)
  resetTileCache()
})

test('publish jobs: finished ones go after an hour or past 50; a running one is never dropped', () => {
  const jobs = new Map<string, PublishJob>()
  const j = (id: string, startedAt: number, finishedAt?: number): PublishJob => ({ id, domain: 'a.example.com', status: finishedAt ? 'done' : 'running', steps: [], owner: 'a@example.com', startedAt, finishedAt, ledger: {} })
  jobs.set('old', j('old', 0, 1000)); jobs.set('run', j('run', 0)); jobs.set('new', j('new', 3_000_000, 3_500_000))
  prunePublishJobs(1000 + 60 * 60_000 + 1, jobs)
  assert.deepEqual([...jobs.keys()].sort(), ['new', 'run'])
  for (let i = 0; i < 60; i++) jobs.set(`f${i}`, j(`f${i}`, 4_000_000 + i, 4_000_100 + i))
  prunePublishJobs(4_100_000, jobs)
  assert.equal(jobs.size, 50); assert.ok(jobs.has('run'))
})

test('setup: a vault copy that cannot be deleted is said in the step, and reported back so the install keeps it on record', async () => {
  const store = new HaproxyInstanceStore(memIO())
  const steps = new Map<string, { status: string; detail?: string }>()
  const r = await runHaproxySetup({ name: 'HAProxy 150', ip: '10.0.0.50', node: 'node1', vmid: 150, secret: 'S'.repeat(32), owner: 'admin@example.com', vault: { category: 'apps', provider: 'haproxy-150' } },
    id => { const s = { status: 'pending' }; steps.set(id, s); return s },
    { createProxyInstance: async () => 'px-0123456789', store, audit: async () => {}, syncTargets: async () => true, deleteSecrets: async () => { throw new Error('vault locked') } })
  assert.equal(r.vaultCopyRemoved, false)
  assert.match(String(steps.get('haproxy-proxy')!.detail), /apps\/haproxy-150\) could not be removed from the vault \(vault locked\)/)
})

test('re-running the install never overwrites a configuration the Data Plane API has edited', () => {
  // The fixture is haproxy.cfg read back after real Data Plane commits: its first lines are the Data Plane's own.
  const cfg = fx('haproxy.cfg')
  assert.match(cfg.split('\n')[0], /^# _md5hash=/)
  assert.match(cfg, /^# Managed with HyperProx/m, 'the comment survives the rewrite, just not as the first line')
  assert.match(HAPROXY_SCRIPT, /if \[ ! -e "\$MARK" \] && ! grep -q '\^# Managed with HyperProx' "\$CFG"/)
  assert.match(HAPROXY_SCRIPT, /\nfi\n: > "\$MARK"\n/, 'the marker is written whether the file was written now or before')
})
