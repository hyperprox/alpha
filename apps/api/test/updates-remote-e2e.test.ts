// The production remote executor end to end, against a pretend Proxmox API (loopback TLS, pinned certificate)
// and a pretend node (loopback SSH): the preview is read from the remote's own API with its own token, over the
// node login saved for that server, at the address saved for that node — and only once an admin has confirmed
// the node's host key. Every command the node receives passes the script guard. Nothing is installed.
import { runInCluster } from '../src/lib/clusters/context'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeBroker } from './fakes/fake-broker'
import { buildTestApp, resetLock, signIn } from './fakes/app'
import { requestContext } from '../src/lib/auth'
import { setClusterStore, loadClusters, saveRemoteNodeLogin, replaceRemoteToken } from '../src/lib/clusters/registry'
import { MemoryClusterStore } from '../src/lib/clusters/store'
import { probeCertificate } from '../src/lib/clusters/tls-pin'
import { probeHostKey } from '../src/lib/node-exec'
import { recordPin } from '../src/lib/hostkey-pins'
import { assertSafeScript } from '../src/lib/clusters/script-guard'
import { UpdatesServices } from '../src/lib/updates/service'
import { MemoryStore } from '../src/lib/updates/store'
import { parsePolicy } from '../src/lib/updates/policy'
import { NODE_FACTS_COMMAND } from '../src/lib/updates/commands'

const haveOpenssl = spawnSync('openssl', ['version']).status === 0
const REMOTE = 'c0123456789'
const SECRET = '12345678-aaaa-bbbb-cccc-1234567890ab'
const PW = 'node-password'
const broker = new FakeBroker()
broker.addUser('owner@example.com', 'owner master password', 'owner')
const appP = buildTestApp(broker)
let api: https.Server
let ssh: any
let apiPort = 0
let sshPort = 0
let authTried = 0
const apiSeen: string[] = []
const nodeSeen: string[] = []
let sid = ''
const asOwner = <T>(fn: () => Promise<T>) => requestContext.run({ sid, email: 'owner@example.com', role: 'owner' }, fn)

function nodeAnswer(cmd: string, stdin: string): string {
  if (cmd === NODE_FACTS_COMMAND) {
    return ['HP_FREE 9000', 'HP_KERNEL 7.0.1-1-pve', 'HP_HOLDS_BEGIN', 'pve-firmware', 'HP_HOLDS_END', 'HP_PIN_BEGIN', 'HP_PIN_END',
      'HP_KPKG_BEGIN', 'proxmox-kernel-7.0.1-1-pve-signed install ok installed', 'HP_KPKG_END'].join('\n')
  }
  if (/apt-get -s .* (dist-)?upgrade 2>&1; echo "HP_SIM_END \$\?"$/.test(cmd)) {
    return ['Inst proxmox-kernel-7.0.2-1-pve-signed (7.0.2-1 Proxmox:9/trixie [amd64])', 'Inst pve-manager [9.2.1] (9.2.2 Proxmox:9/trixie [amd64])', 'HP_SIM_END 0'].join('\n')
  }
  if (/apt list --upgradable/.test(stdin)) return 'openssl/stable-security 3.5.4-1 amd64 [upgradable from: 3.5.1-1]'
  return 'ok'
}

before(async () => {
  if (!haveOpenssl) return
  const app = await appP
  await signIn(app, 'owner@example.com', 'owner master password')
  sid = [...broker.sessions.values()].at(-1)!.sid
  const dir = mkdtempSync(join(tmpdir(), 'hpx-updre-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '30', '-subj', '/CN=pve-test', '-keyout', join(dir, 'k'), '-out', join(dir, 'c')], { stdio: 'ignore' })
  api = https.createServer({ key: readFileSync(join(dir, 'k')), cert: readFileSync(join(dir, 'c')) }, (req, res) => {
    apiSeen.push(`${req.method} ${req.url} ${req.headers.authorization === `PVEAPIToken=hyperprox@pve!main=${SECRET}` ? 'remote-token' : 'OTHER'}`)
    res.setHeader('content-type', 'application/json')
    const send = (data: unknown) => res.end(JSON.stringify({ data }))
    const u = (req.url ?? '').replace(/^\/api2\/json/, '')
    if (u === '/cluster/status') return send([{ type: 'node', name: 'pve1', online: 1, ip: '10.0.0.50', local: 1 }])
    if (u.startsWith('/cluster/resources')) return send([{ type: 'lxc', vmid: 101, node: 'pve1', name: 'media', status: 'running' }])
    if (u === '/cluster/ha/resources') return send([])
    if (u === '/nodes/pve1/lxc/101/config') return send({ hostname: 'media', onboot: 1, mp0: '/srv/media,mp=/media' })
    if (u.startsWith('/nodes/pve1/tasks')) return send([{ starttime: 1_794_200_000, status: 'OK', id: '101', type: 'vzdump' }])
    res.statusCode = 404; send(null)
  })
  await new Promise<void>(r => api.listen(0, '127.0.0.1', r))
  apiPort = (api.address() as any).port

  const mod: any = await import('ssh2')
  const { Server, utils } = mod.default ?? mod
  const kp = utils.generateKeyPairSync('ed25519')
  ssh = new Server({ hostKeys: [kp.private] }, (client: any) => {
    client.on('authentication', (ctx: any) => { authTried++; ctx.method === 'password' && ctx.password === PW ? ctx.accept() : ctx.reject() })
    client.on('ready', () => client.on('session', (accept: any) => accept().on('exec', (acc: any, _rej: any, info: any) => {
      const s = acc()
      const cmd = String(info.command)
      const container = /pct push \d+/.test(cmd)
      let stdin = ''
      const answer = () => { nodeSeen.push(cmd + (stdin ? `\n--stdin--\n${stdin}` : '')); s.write(nodeAnswer(cmd, stdin) + '\n'); s.exit(0); s.end() }
      if (!container) return answer()
      s.on('data', (d: Buffer) => { stdin += d.toString() })
      s.on('end', answer)
    })))
    client.on('error', () => undefined)
  })
  await new Promise<void>(r => ssh.listen(0, '127.0.0.1', r))
  sshPort = ssh.address().port

  const fp = (await probeCertificate('127.0.0.1', apiPort)).fingerprint
  const cs = new MemoryClusterStore()
  await cs.upsert({ id: REMOTE, name: 'Remote server', kind: 'remote', address: '127.0.0.1', port: apiPort, note: '', certFingerprint: fp, certConfirmedAt: new Date(), certConfirmedBy: 'owner@example.com', nodeAddresses: { pve1: '127.0.0.1' }, allowedRoots: [], monitoring: {}, plexUrl: null, createdBy: 'x' })
  setClusterStore(cs); await loadClusters()
  await asOwner(async () => {
    await replaceRemoteToken(REMOTE, 'hyperprox@pve!main', SECRET)
    await saveRemoteNodeLogin(REMOTE, 'pve1', JSON.stringify({ username: 'root', port: sshPort, password: PW }))
  })
})
after(async () => { api?.close(); ssh?.close(); await resetLock(); await (await appP).close() })

const services = () => new UpdatesServices({
  store: new MemoryStore(),
  loadPolicy: () => ({ loaded: false, missing: true, path: '/t', error: 'No policy file', policy: parsePolicy('') }),
  exec: undefined as any,
})

test('an unconfirmed host key: the node is never logged in to, and the preview says why', { skip: !haveOpenssl && 'openssl not installed' }, async () => {
  const inv = await services().get(REMOTE).inventory(true)
  const n = inv.nodes[0]
  assert.equal(n.node, 'pve1')
  assert.match(n.error ?? '', /confirm/i)
  assert.equal(authTried, 0, 'no login was offered to a host whose key nobody confirmed')
  assert.ok(apiSeen.length > 0 && apiSeen.every(s => s.endsWith('remote-token')), 'the remote API was read with the remote\'s own token')
})

test('a confirmed host key: the preview is the remote\'s own simulation, over its saved login and address', { skip: !haveOpenssl && 'openssl not installed' }, async () => {
  const fp = await probeHostKey('127.0.0.1', sshPort)
  // Confirmed for the remote itself: a home pin on the same address is never lent to a remote.
  await asOwner(() => runInCluster(REMOTE, () => recordPin('127.0.0.1', sshPort, fp, 'confirmed')))
  apiSeen.length = 0
  const inv = await services().get(REMOTE).inventory(true)
  assert.deepEqual(inv.cluster, { id: REMOTE, name: 'Remote server', kind: 'remote' })
  const n = inv.nodes[0]
  assert.equal(n.error, undefined, n.error)
  assert.equal(n.standalone, true)
  // The node is seen to hold a package, so it gets `upgrade` although the remote default is dist-upgrade.
  assert.equal(n.preview?.verb, 'upgrade')
  assert.match(n.upgradeNote ?? '', /pve1 has held packages \(pve-firmware\), so it gets apt-get upgrade, not dist-upgrade/)
  assert.ok(nodeSeen.some(c => /apt-get -s .* upgrade 2>&1/.test(c)) && !nodeSeen.some(c => /apt-get -s .* dist-upgrade/.test(c)))
  assert.equal(n.preview?.kernel, true)
  assert.equal(n.preview?.proxmoxVe, true)
  assert.deepEqual(n.held, ['pve-firmware'])
  assert.deepEqual(n.pending.map(p => p.name), ['proxmox-kernel-7.0.2-1-pve-signed', 'pve-manager'])
  const g = inv.guests[0]
  assert.equal(g.managed, true)
  assert.equal(g.snapshotCapable, false)
  assert.equal(g.noSnapshotAckId, 'nosnap:101')
  assert.equal(g.pending[0].security, true)
  assert.equal(g.lastBackup?.thisGuest, true)
  assert.ok(authTried > 0)
  assert.ok(nodeSeen.length >= 3)
  for (const c of nodeSeen) assert.doesNotThrow(() => assertSafeScript(c), c.slice(0, 80))
  assert.ok(!nodeSeen.some(c => /apt-get -y|apt-mark (un)?hold\b|kernel (un)?pin|systemctl reboot/.test(c)), 'reading a preview changes nothing')
  assert.ok(apiSeen.every(s => s.endsWith('remote-token')))
  assert.ok(!apiSeen.some(s => / POST /.test(s) || s.startsWith('POST')), 'no write to the remote API')
})
