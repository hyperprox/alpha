// Regression tests for the adversarial review of the multi-cluster branch. Each block names its finding.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { proxmoxRoutes } from '../src/routes/proxmox'
import { infrastructureRoutes } from '../src/routes/infrastructure'
import { clusterRoutes } from '../src/routes/clusters'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { setAuditSink } from '../src/lib/audit'
import { setClusterStore, loadClusters } from '../src/lib/clusters/registry'
import { MemoryClusterStore } from '../src/lib/clusters/store'
import { installClusterContext, remoteRouteAllowed } from '../src/lib/clusters/context'
import { ProxmoxClient } from '../src/lib/proxmox-client'
import { unsafeRequestPath } from '../src/lib/roles'
import { FakeBroker } from './fakes/fake-broker'
import { signIn } from './fakes/app'
import { liveNodeShell } from '../src/lib/guest-config/pve-adapter'
import { runInCluster } from '../src/lib/clusters/context'
import { saveRemoteNodeLogin, remoteNodeLogins, clusterRow } from '../src/lib/clusters/registry'
import { requestContext } from '../src/lib/auth'
import { needsReconfirm } from '../src/lib/roles'
import { recordPin, pinnedKey } from '../src/lib/hostkey-pins'
import { getCredential } from '../src/lib/credentials'
import { checkPlexUrl } from '../src/lib/clusters/files'

const haveOpenssl = spawnSync('openssl', ['version']).status === 0
export const seen: string[] = []
let server: https.Server
export let pvePort = 0
let app: FastifyInstance
let cookie = ''
const broker = new FakeBroker()
broker.addUser('owner@example.com', 'owner master password', 'owner')
broker.addUser('viewer@example.com', 'viewer master password', 'viewer')

before(async () => {
  if (!haveOpenssl) return
  const dir = mkdtempSync(join(tmpdir(), 'hpx-rev-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '30', '-subj', '/CN=pve-test', '-keyout', join(dir, 'k'), '-out', join(dir, 'c')], { stdio: 'ignore' })
  server = https.createServer({ key: readFileSync(join(dir, 'k')), cert: readFileSync(join(dir, 'c')) }, (req, res) => {
    seen.push(`${req.method} ${req.url}`)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: 'UPID:pve:x:' }))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  pvePort = (server.address() as any).port
  process.env.PROXMOX_HOST = '127.0.0.1'; process.env.PROXMOX_PORT = String(pvePort)
  process.env.PROXMOX_USER = 'root@pam'; process.env.PROXMOX_TOKEN_ID = 't'; process.env.PROXMOX_TOKEN_SECRET = 's'
  setBroker(broker)
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  setAuditSink({ write: async () => {} })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  setClusterStore(new MemoryClusterStore()); await loadClusters()
  app = Fastify({ logger: false })
  await registerGate(app)
  installClusterContext(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(proxmoxRoutes, { prefix: '/api/proxmox' })
  await app.register(infrastructureRoutes, { prefix: '/api/infra' })
  await app.register(clusterRoutes, { prefix: '/api/clusters' })
  await app.ready()
  cookie = (await signIn(app, 'owner@example.com', 'owner master password')).cookie
})
after(async () => { server?.close(); if (isUnlocked()) await lock('manual'); await app?.close() })

const call = (method: string, url: string, payload?: unknown, c = cookie) => app.inject({ method: method as any, url, headers: { cookie: c }, payload: payload as any })
export const appCall = call

// ── 1: path traversal into the Proxmox token ───────────────────────────────

test('1: the exact exploit strings are refused before anything reaches Proxmox', { skip: !haveOpenssl && 'openssl not installed' }, async () => {
  seen.length = 0
  const stop = await call('POST', '/api/infra/vms/pve%2Fstatus%3Fcommand%3Dshutdown%26x%3D/100/lxc/stop')
  assert.equal(stop.statusCode, 400)
  const del = await call('DELETE', '/api/infra/vms/pve/100/lxc/snapshots/..%2F..%2F..%2Flxc%2F200%3Fpurge%3D1')
  assert.equal(del.statusCode, 400)
  assert.ok([400, 404].includes((await call('POST', '/api/infra/vms/../100/lxc/stop')).statusCode))
  assert.deepEqual(seen, [], 'Proxmox received nothing')
  // A plain request still works and arrives as one path.
  const ok = await call('POST', '/api/infra/vms/pve/100/lxc/stop')
  assert.equal(ok.statusCode, 200, ok.body)
  assert.deepEqual(seen, ['POST /api2/json/nodes/pve/lxc/100/status/stop'])
})

test('1: the gate rule, and remote allowlist segments', () => {
  assert.ok(unsafeRequestPath('/api/infra/vms/pve%2Fx/100/lxc/stop'))
  assert.ok(unsafeRequestPath('/api/proxmox/nodes/pve%3Fa'))
  assert.ok(unsafeRequestPath('/api/clusters/c0123456789/tasks/pve/%2e%2e'))
  assert.ok(unsafeRequestPath('/api/infra/vms/pve%5c/1/lxc/stop'))
  assert.ok(!unsafeRequestPath('/api/infra/ha/ct%3A100'), 'an encoded ":" in an HA id is fine')
  assert.ok(!unsafeRequestPath('/api/ai/models/library%2Fmodel'), 'routes that never build Proxmox paths keep encoded names')
  assert.ok(!remoteRouteAllowed('POST', '/api/infra/vms/pve?x/100/lxc/stop'))
  assert.ok(!remoteRouteAllowed('POST', '/api/infra/vms/../100/lxc/stop'))
  assert.ok(remoteRouteAllowed('POST', '/api/infra/vms/pve-1.example/100/lxc/stop'))
})

test('1: the client encodes each value as one segment and refuses "." and ".."', { skip: !haveOpenssl && 'openssl not installed' }, async () => {
  seen.length = 0
  const c = new ProxmoxClient('127.0.0.1', pvePort, 'u@pve!t', 's')
  await c.vmAction('pve/status?command=shutdown&x=', 100, 'lxc', 'stop')
  await c.deleteSnapshot('pve', 100, 'lxc', '../../../lxc/200?purge=1')
  assert.deepEqual(seen, [
    'POST /api2/json/nodes/pve%2Fstatus%3Fcommand%3Dshutdown%26x%3D/lxc/100/status/stop',
    'DELETE /api2/json/nodes/pve/lxc/100/snapshot/..%2F..%2F..%2Flxc%2F200%3Fpurge%3D1',
  ])
  await assert.rejects(c.vmAction('..', 100, 'lxc', 'stop'), /not a valid Proxmox path part/)
})

// ── 4: HA is home-only ──────────────────────────────────────────────────────

test('4: HA reads and HA state changes are refused for a remote cluster', () => {
  assert.ok(!remoteRouteAllowed('PUT', '/api/infra/ha/ct:100'))
  assert.ok(!remoteRouteAllowed('GET', '/api/proxmox/ha'))
  assert.ok(!remoteRouteAllowed('GET', '/api/proxmox/ha/resources'))
  assert.ok(!remoteRouteAllowed('GET', '/api/ha/overview'))
})

// ── 2: a remote node's login only to a confirmed host key; address changes re-confirmed ─────

const REMOTE = 'c0123456789'
async function addRemote(nodeAddresses: Record<string, string> = { pve: '10.0.0.9' }) {
  const store = new MemoryClusterStore()
  await store.upsert({ id: REMOTE, name: 'Remote server', kind: 'remote', address: '127.0.0.1', port: pvePort, note: '', certFingerprint: 'AA', certConfirmedAt: null, certConfirmedBy: null, nodeAddresses, allowedRoots: [], monitoring: {}, plexUrl: null, createdBy: 'x' })
  setClusterStore(store); await loadClusters()
  return store
}
const sidOf = () => [...broker.sessions.values()].find(s => (s as any).email === 'owner@example.com')?.sid ?? [...broker.sessions.values()].at(-1)!.sid
const asOwner = <T>(fn: () => Promise<T>) => requestContext.run({ sid: sidOf(), email: 'owner@example.com', role: 'owner' }, fn)

test('2: the guest-config node shell requires a confirmed pin on a remote, not at home', { skip: !haveOpenssl && 'openssl not installed' }, async () => {
  await addRemote()
  await asOwner(() => saveRemoteNodeLogin(REMOTE, 'pve', JSON.stringify({ username: 'root', port: 22, password: 'pw' })))
  const opts: any[] = []
  const shell = liveNodeShell(undefined, (async (o: any) => { opts.push(o); return { code: 0, output: '', timedOut: false } }) as any)
  await asOwner(() => runInCluster(REMOTE, () => shell.run('pve', 'true')))
  assert.equal(opts[0]?.requirePin, true)
  assert.equal(opts[0]?.host, '10.0.0.9')
})

test('2: PATCH takes only name and note; address and node addresses go through the re-confirmed route and clear the login', { skip: !haveOpenssl && 'openssl not installed' }, async () => {
  await addRemote()
  await asOwner(async () => {
    await saveRemoteNodeLogin(REMOTE, 'pve', JSON.stringify({ username: 'root', port: 22, password: 'pw' }))
    await runInCluster(REMOTE, () => recordPin('10.0.0.9', 22, 'SHA256:' + 'A'.repeat(43), 'confirmed'))
    await recordPin('10.0.0.9', 22, 'SHA256:' + 'B'.repeat(43), 'confirmed')   // a home machine on the same address
  })
  assert.equal((await call('PATCH', `/api/clusters/${REMOTE}`, { nodeAddresses: { pve: '203.0.113.5' } })).statusCode, 422)
  assert.equal((await call('PATCH', `/api/clusters/${REMOTE}`, { name: 'Renamed' })).statusCode, 200, 'a rename stays free')
  assert.ok(needsReconfirm('POST', `/api/clusters/${REMOTE}/connection`))
  assert.equal((await call('POST', `/api/clusters/${REMOTE}/connection`, { nodeAddresses: { pve: '203.0.113.5' } })).json().code, 'reconfirm_required')
  await call('POST', '/api/auth/reconfirm', { password: 'owner master password' })
  const r = await call('POST', `/api/clusters/${REMOTE}/connection`, { nodeAddresses: { pve: '203.0.113.5' } })
  assert.equal(r.statusCode, 200, r.body)
  assert.deepEqual(r.json().loginsCleared, ['pve'])
  assert.deepEqual(await asOwner(() => remoteNodeLogins(REMOTE)), [], 'the login is gone, so it cannot be offered to the new address')
  assert.equal(await asOwner(() => runInCluster(REMOTE, () => pinnedKey('10.0.0.9', 22))), null, 'and the old pin with it')
  assert.equal(await asOwner(() => pinnedKey('10.0.0.9', 22)), 'SHA256:' + 'B'.repeat(43), 'a home pin on the same address is not touched')
  assert.equal(clusterRow(REMOTE)!.nodeAddresses.pve, '203.0.113.5')
})

// ── 3: the Plex token goes only to the Plex it was saved for ────────────────

test('3: Plex address only through the re-confirmed route; a new host drops the token; public http refused', { skip: !haveOpenssl && 'openssl not installed' }, async () => {
  await addRemote()
  assert.equal((await call('PATCH', `/api/clusters/${REMOTE}`, { plexUrl: 'http://203.0.113.7:32400' })).statusCode, 422)
  await call('POST', '/api/auth/reconfirm', { password: 'owner master password' })
  assert.equal((await call('POST', `/api/clusters/${REMOTE}/plex`, { url: 'http://10.0.0.5:32400', token: 'abcdefgh12345678' })).statusCode, 200)
  assert.equal(await asOwner(() => getCredential('cluster-plex', REMOTE, 'token')), 'abcdefgh12345678')
  const moved = await call('POST', `/api/clusters/${REMOTE}/plex`, { url: 'http://10.0.0.6:32400' })
  assert.equal(moved.json().data.tokenDropped, true)
  assert.equal(await asOwner(() => getCredential('cluster-plex', REMOTE, 'token')), null)
  assert.equal((await call('POST', `/api/clusters/${REMOTE}/plex`, { url: 'http://203.0.113.7:32400' })).statusCode, 422)
  assert.doesNotThrow(() => checkPlexUrl('https://plex.example:32400'))
  assert.doesNotThrow(() => checkPlexUrl(`http://${[100, 64, 1, 2].join('.')}:32400`))
  assert.throws(() => checkPlexUrl('http://plex.example:32400'))
})

// ── 5: per-cluster caches ───────────────────────────────────────────────────

test('5: the CEPH monitor answer is kept per cluster', async () => {
  const { resolveCephMonNode, invalidateCephMonNode } = await import('../src/lib/ceph')
  await addRemote()
  invalidateCephMonNode(true)
  const fake = (node: string) => ({
    getNodes: async () => [{ node, status: 'online' }],
    getCephMons: async () => [{ name: node, host: node, rank: 0, quorum: 1, state: 'running' }],
  }) as any
  delete process.env.CEPH_MON_NODE
  assert.equal(await resolveCephMonNode(fake('home-node')), 'home-node')
  assert.equal(await runInCluster(REMOTE, () => resolveCephMonNode(fake('remote-node'))), 'remote-node', 'not the home answer from the cache')
  assert.equal(await resolveCephMonNode(fake('ignored')), 'home-node', 'home kept its own')
  process.env.CEPH_MON_NODE = 'home-override'
  assert.equal(await runInCluster(REMOTE, () => resolveCephMonNode(fake('remote-node'))), 'remote-node', 'CEPH_MON_NODE is a home node name')
  delete process.env.CEPH_MON_NODE
})

// ── 6: monitoring install and remove put node_exporter back exactly as it was ───────────────

import { installScript as monInstall, removeScript as monRemove, nodeExporterArgs } from '../src/lib/clusters/monitoring'
import { mkdirSync as mkd, writeFileSync as wf, existsSync as ex, readFileSync as rf, chmodSync } from 'node:fs'

/** A pretend node in a folder: stub systemctl, dpkg-query, apt-get, curl, ss and ip that keep their state in files. */
function fakeNode(o: { installed: boolean; enabled: boolean; active: boolean; wide?: boolean; defaults?: string }) {
  const root = mkdtempSync(join(tmpdir(), 'hpx-node-'))
  const st = join(root, 'stub-state'), bin = join(root, 'bin')
  mkd(st); mkd(bin); mkd(join(root, 'etc', 'default'), { recursive: true })
  const flag = (n: string, v: boolean) => { if (v) wf(join(st, n), '') }
  flag('installed', o.installed); flag('enabled', o.enabled); flag('active', o.active)
  if (o.defaults !== undefined) wf(join(root, 'etc/default/prometheus-node-exporter'), o.defaults)
  wf(join(st, 'ss'), o.wide ? 'LISTEN 0 4096 0.0.0.0:9100 0.0.0.0:*\n' : '')
  const S = st
  const stub = (n: string, body: string) => { wf(join(bin, n), `#!/bin/bash\n${body}\n`); chmodSync(join(bin, n), 0o755) }
  stub('systemctl', `q=""; [ "$2" = --quiet ] && q=1
case "$1" in
  is-enabled) [ -f ${S}/enabled ];; is-active) [ -f ${S}/active ];;
  enable) touch ${S}/enabled;; disable) rm -f ${S}/enabled; [ "$2" = --now ] && rm -f ${S}/active; true;;
  restart|start) touch ${S}/active;; stop) rm -f ${S}/active;; *) true;; esac`)
  stub('dpkg-query', `[ -f ${S}/installed ] && echo 'install ok installed'`)
  stub('apt-get', `case " $* " in *" -s "*) echo "Inst prometheus-node-exporter (1.0 Debian)";; *" install "*) touch ${S}/installed;; *" remove "*) rm -f ${S}/installed ${S}/enabled ${S}/active;; esac; true`)
  stub('curl', `[ -f ${S}/active ] && printf 'node_exporter_build_info 1\\nnode_drm_gpu_busy_percent 3\\n'`)
  stub('ss', `cat ${S}/ss; [ -f ${S}/active ] && echo 'LISTEN 0 4096 10.0.0.7:9100 0.0.0.0:*'; true`)
  stub('ip', `echo '3: tailscale0    inet 10.0.0.7/32 scope global tailscale0'`)
  stub('sleep', 'true')
  const run = (script: string) => execFileSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HPX_SYSROOT: root, SSH_CONNECTION: '10.0.0.1 5555 10.0.0.7 22' } })
  const state = () => ({ installed: ex(join(st, 'installed')), enabled: ex(join(st, 'enabled')), active: ex(join(st, 'active')) })
  const defaults = () => (ex(join(root, 'etc/default/prometheus-node-exporter')) ? rf(join(root, 'etc/default/prometheus-node-exporter'), 'utf8') : null)
  return { run, state, defaults, setWide: (w: boolean) => wf(join(st, 'ss'), w ? 'LISTEN 0 4096 0.0.0.0:9100 0.0.0.0:*\n' : '') }
}
const resultOf = (out: string) => out.trim().split('\n').filter(l => l.startsWith('HPX-RESULT')).pop() ?? ''

test('6: a package that was installed but disabled and stopped is put back disabled and stopped', () => {
  const n = fakeNode({ installed: true, enabled: false, active: false, defaults: 'ARGS=""\n' })
  assert.match(resultOf(n.run(monInstall({ amdGpu: false }))), /\tdone\tlistening on 10\.0\.0\.7:9100 only/)
  assert.deepEqual(n.state(), { installed: true, enabled: true, active: true })
  assert.match(n.defaults()!, /listen-address=10\.0\.0\.7:9100/)
  assert.match(resultOf(n.run(monRemove())), /\tdone\t/)
  assert.deepEqual(n.state(), { installed: true, enabled: false, active: false }, 'not left starting at boot on every interface')
  assert.equal(n.defaults(), 'ARGS=""\n', 'its own defaults file is back')
})

test('6: the node_exporter ARGS keep /mnt and /media visible, keep the other args, and applying twice changes nothing', () => {
  const flag = '--collector.filesystem.mount-points-exclude=^/(dev|proc|run|sys|var/lib/docker/.+|var/lib/containers/storage/.+)($|/)'
  const n = fakeNode({ installed: true, enabled: true, active: true, defaults: 'ARGS="--collector.disable-defaults"\n' })
  assert.match(resultOf(n.run(monInstall({ amdGpu: true, intelGpu: true }))), /\tdone\t/)
  const first = n.defaults()!
  const line = first.split('\n').find(l => l.startsWith('ARGS='))!
  assert.ok(line.includes(flag), 'the exclude list without /mnt and /media is in ARGS')
  assert.equal(line.split('mount-points-exclude').length, 2, 'exactly once')
  assert.ok(!/\|mnt\||\|media\|/.test(line), 'neither /mnt nor /media is excluded')
  assert.match(line, /--web\.listen-address=10\.0\.0\.7:9100 --collector\.drm --collector\.textfile\.directory=\/var\/lib\/prometheus\/node-exporter /)
  assert.match(resultOf(n.run(monInstall({ amdGpu: true, intelGpu: true }))), /\talready\t/, 'the second run finds nothing to change')
  assert.equal(n.defaults(), first)
  assert.equal(nodeExporterArgs({ amdGpu: false }), '--web.listen-address=${LISTEN_HP} ' + flag)
})

test('6: a failure after the package step rolls back at once', () => {
  const n = fakeNode({ installed: false, enabled: false, active: false, wide: true })
  const r = resultOf(n.run(monInstall({ amdGpu: false })))
  assert.match(r, /\tfailed\tsomething also listens on 0\.0\.0\.0:9100.*rolled back/)
  assert.equal(n.state().enabled, false)
  assert.equal(n.state().active, false)
  assert.equal(n.defaults(), null, 'the HyperProx defaults file is gone')
})

test('6: a normal remove takes away a package HyperProx added, and leaves a running one running', () => {
  const added = fakeNode({ installed: false, enabled: false, active: false })
  assert.match(resultOf(added.run(monInstall({ amdGpu: true }))), /\tdone\t.*AMD GPU figures/)
  assert.match(resultOf(added.run(monRemove())), /removed node_exporter/)
  assert.deepEqual(added.state(), { installed: false, enabled: false, active: false })
  const running = fakeNode({ installed: true, enabled: true, active: true })
  running.setWide(false)
  assert.match(resultOf(running.run(monInstall({ amdGpu: false }))), /\tdone\t/)
  assert.match(resultOf(running.run(monRemove())), /back to how it was/)
  assert.deepEqual(running.state(), { installed: true, enabled: true, active: true })
})

// ── 7: the forced command keeps a folder with spaces as one argument, and nothing in it runs ────

import { authorizedLine } from '../src/lib/clusters/files'
import { utils as sshUtils } from 'ssh2'

test('7: a root with spaces reaches rrsync as one argument; quotes, $ and backticks are refused', () => {
  const kp = sshUtils.generateKeyPairSync('ed25519', { comment: 'x' })
  const dir = mkdtempSync(join(tmpdir(), 'hpx-rr-'))
  const rr = join(dir, 'rrsync')
  wf(rr, '#!/bin/bash\nfor a in "$@"; do printf "[%s]\\n" "$a"; done\n'); chmodSync(rr, 0o755)
  const line = authorizedLine(rr, '/mnt/media/TV Shows', kp.public, 'home:abc')
  // What sshd does with a forced command: hand it to the user's shell as one string.
  const command = /command="([^"]*)"/.exec(line)![1]
  assert.equal(execFileSync('bash', ['-c', command], { encoding: 'utf8' }), '[-wo]\n[-no-del]\n[/mnt/media/TV Shows]\n')
  for (const bad of ["/mnt/a'b", '/mnt/$(id)', '/mnt/`id`', '/mnt/a"b', '/mnt/a\\b', '/mnt/a\nb'])
    assert.throws(() => authorizedLine(rr, bad, kp.public, 't'), /cannot carry safely/, bad)
  // A ; inside the quotes is only a character.
  const semi = /command="([^"]*)"/.exec(authorizedLine(rr, '/mnt/a;touch x', kp.public, 't'))![1]
  assert.equal(execFileSync('bash', ['-c', semi], { encoding: 'utf8', cwd: dir }), '[-wo]\n[-no-del]\n[/mnt/a;touch x]\n')
  assert.ok(!ex(join(dir, 'x')))
})

// ── 9: removing a cluster removes its standing access ───────────────────────

import { setCredential as setCred } from '../src/lib/credentials'
import { cachedSecret } from '../src/lib/vault/state'

test('9: remove deletes sending keys both ways, says what to run where it could not reach, and drops its targets', { skip: !haveOpenssl && 'openssl not installed' }, async () => {
  await addRemote()
  const targets = mkdtempSync(join(tmpdir(), 'hpx-tg-'))
  process.env.HYPERPROX_TARGETS_DIR = targets
  process.env.PROMETHEUS_URL = 'http://127.0.0.1:1'
  wf(join(targets, 'nodes.json'), JSON.stringify([{ targets: ['10.0.0.1:9100'], labels: { node: 'node1' } }, { targets: ['10.0.0.9:9100'], labels: { node: `pve@${REMOTE}`, hpx_cluster: REMOTE, hpx_node: 'pve' } }]))
  await asOwner(async () => {
    await setCred('xfer-key', `home-${REMOTE}`, 'pve~0123456789ab', '{}', true)
    await setCred('xfer-key', `${REMOTE}-home`, 'node1~ba9876543210', '{}', true)
  })
  await call('POST', '/api/auth/reconfirm', { password: 'owner master password' })
  const r = await call('DELETE', `/api/clusters/${REMOTE}`, { confirmName: 'Remote server' })
  assert.equal(r.statusCode, 200, r.body)
  const manual = r.json().data.sendingKeysManual as Array<{ where: string; command: string }>
  assert.equal(manual.length, 2, 'neither destination is reachable from the test, so both are listed by hand')
  assert.ok(manual.some(m => m.command === `sed -i '/hyperprox-xfer:home:0123456789ab/d' /root/.ssh/authorized_keys`))
  assert.ok(manual.some(m => m.command === `sed -i '/hyperprox-xfer:${REMOTE}:ba9876543210/d' /root/.ssh/authorized_keys`))
  assert.equal(cachedSecret(`hyperprox:xfer-key/home-${REMOTE}`), undefined)
  assert.equal(cachedSecret(`hyperprox:xfer-key/${REMOTE}-home`), undefined)
  assert.deepEqual(JSON.parse(rf(join(targets, 'nodes.json'), 'utf8')), [{ targets: ['10.0.0.1:9100'], labels: { node: 'node1' } }])
  delete process.env.HYPERPROX_TARGETS_DIR; delete process.env.PROMETHEUS_URL
})

// ── 11: one script guard for every remote node script; no system folder as a copy root ───────

import { assertSafeScript as guard } from '../src/lib/clusters/script-guard'
import { readScript as cfgRead } from '../src/lib/guest-config/rawfile'
import { execOnNode as execNode } from '../src/lib/node-exec'
import { cleanRoot as root } from '../src/lib/clusters/registry'
import { hardware as hw } from '../src/lib/hardware'

test('11: the guard allows the documented /etc/pve uses and refuses everything else there', async () => {
  assert.doesNotThrow(() => guard(cfgRead('pve', 100)))
  assert.doesNotThrow(() => guard(hw.probeScript()))
  for (const bad of ['cat /etc/pve/storage.cfg', 'echo x > /etc/pve/user.cfg', 'ls /etc/pve', 'systemctl restart corosync', 'systemctl stop pve-cluster', 'pmxcfs -l', 'rm /etc/pve/nodes/pve/qemu-server/100.conf'])
    assert.throws(() => guard(bad), /Refused/, bad)
  await addRemote()
  await assert.rejects(runInCluster(REMOTE, () => execNode({ host: '127.0.0.1', cred: { username: 'root', port: 22, password: 'x' } as any, command: 'bash -s', input: 'cat /etc/pve/priv/authkey.key' })), /Refused/)
})

test('11: a system folder, or anything inside one, is never a copy root', () => {
  for (const bad of ['/var', '/var/lib/vz', '/var/spool/x', '/etc/ssh', '/tmp/x', '/usr/share', '/root/media'])
    assert.throws(() => root(bad), /system folder/, bad)
  assert.equal(root('/mnt/media'), '/mnt/media')
  assert.equal(root('/srv/media/TV Shows'), '/srv/media/TV Shows')
})

// ── 12: below admin, the cluster list says which clusters exist, nothing about reaching them ──────

test('12: a viewer gets id, name and kind only', { skip: !haveOpenssl && 'openssl not installed' }, async () => {
  await addRemote()
  const viewer = (await signIn(app, 'viewer@example.com', 'viewer master password')).cookie
  const r = await call('GET', '/api/clusters', undefined, viewer)
  assert.equal(r.statusCode, 200)
  for (const c of r.json().data) assert.deepEqual(Object.keys(c).sort(), ['id', 'kind', 'name'])
  assert.equal(r.json().commands, undefined)
  const admin = await call('GET', '/api/clusters')
  assert.equal(admin.json().data[1].address, '127.0.0.1')
  const ov = await call('GET', '/api/clusters/overview', undefined, viewer)
  assert.ok(!ov.body.includes('127.0.0.1'), 'no address in a viewer\'s Command center')
})

// ── 13: probe and test cannot be used to scan ports or tell refused from timed out ────────────

import { overLimit } from '../src/routes/clusters'
import { GENERIC_CONNECT_ERROR, allowedApiPort } from '../src/lib/clusters/tls-pin'

test('13: low ports other than the Proxmox ones are refused; failures read the same; calls are limited', { skip: !haveOpenssl && 'openssl not installed' }, async () => {
  assert.ok(!allowedApiPort(22)); assert.ok(!allowedApiPort(25)); assert.ok(allowedApiPort(8006)); assert.ok(allowedApiPort(443)); assert.ok(allowedApiPort(18006))
  assert.equal((await call('POST', '/api/clusters/probe-certificate', { address: '127.0.0.1', port: 22 })).statusCode, 422)
  const closed = await call('POST', '/api/clusters/probe-certificate', { address: '127.0.0.1', port: 1 + pvePort === 65536 ? 2000 : 65000 })
  assert.equal(closed.json().error, GENERIC_CONNECT_ERROR)
  for (let i = 0; i < 10; i++) assert.equal(overLimit('t:x', 10, 60_000, 1000 + i), false)
  assert.equal(overLimit('t:x', 10, 60_000, 2000), true)
  assert.equal(overLimit('t:x', 10, 60_000, 70_000), false, 'and frees up after a minute')
})

// ── 14: a failing job table is logged once, not every ten seconds ───────────

import { CopyRunner as Runner, setJobStore as setJobs, MemoryJobStore as MemJobs } from '../src/lib/clusters/files'

test('14: the copy runner logs the same failure once', async () => {
  const logs: string[] = []
  setJobs({ list: async () => { throw new Error('The table `FileCopyJob` does not exist') } } as any)
  await asOwner(async () => {
    const r = new Runner(undefined, undefined, m => logs.push(m))
    for (let i = 0; i < 5; i++) await r.tick()
  })
  assert.equal(logs.length, 1)
  setJobs(new MemJobs())
})
