// The vault rule, proved with planted markers (opt-in, HP_E2E_DOCKER=1: needs Docker for a throwaway Postgres).
//
// Every secret is planted with a random marker: provider API tokens (Tailscale, NetBird) and the router's write
// password in the vault, install and setup keys and sign-in links (Tailscale, NetBird) from mocked control
// planes, WireGuard private keys from "the browser", from a server container's own keygen, and a server key
// read for its vault backup. Then: a Tailscale install, a check that captures a sign-in link, an uninstall; a
// NetBird install, a settings change whose `netbird up` asks for a sign-in, an uninstall; a WireGuard server
// (key backed up), a machine connected to it, a phone peer from the browser, one made on the server, a
// rotation, a router peer added and removed; and a phone peer added over HTTP through the real gate and routes
// with request logging at trace level. All against the real Postgres stores, the real credential store (on a
// fake vault), the real notification outbox and the real RouterOS write client. Afterwards no marker may
// appear in a dump of Postgres, in any file under the repository or the test's directories, or in any log or
// job log; and each secret that HyperProx keeps must be in its vault item.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { FakeBroker } from './fakes/fake-broker'
import { buildTestApp, resetLock, signIn } from './fakes/app'

const ENABLED = process.env.HP_E2E_DOCKER === '1'
const R = () => randomBytes(10).toString('hex')
const UUID = () => randomBytes(16).toString('hex').toUpperCase().replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')
const M = {
  apiToken: `tskey-api-MARK${R()}`, installKey: `tskey-auth-MARK${R()}`, login: `https://login.tailscale.com/a/MARK${R()}`,
  routerPw: `MARKPW${R()}`,
  nbToken: `nbp_MARK${R()}${R()}`, nbSetupKey: UUID(), nbLogin: `https://login.netbird.io/activate?user_code=MARK${R()}`,
}
const kp = () => { const { privateKey, publicKey } = generateKeyPairSync('x25519'); return { priv: Buffer.from((privateKey.export({ format: 'jwk' }) as any).d, 'base64url').toString('base64'), pub: Buffer.from((publicKey.export({ format: 'jwk' }) as any).x, 'base64url').toString('base64') } }
const phone1 = kp(), phone2 = kp(), routerPhone = kp(), httpPhone = kp(), serverMade = kp(), serverKey = kp()
const PG = `hp-marker-pg-${R().slice(0, 8)}`
const PW = R()
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-marker-'))
const logs: string[] = []
let dbUrl = ''
let tsBase = ''
let rosBase = ''
let tsServer: http.Server, rosServer: http.Server
const ros = { peers: [] as any[], auth: [] as string[] }

function pgExec(args: string[], input?: string): string { return execFileSync('docker', ['exec', '-i', PG, ...args], { input }).toString() }

before(async () => {
  if (!ENABLED) return
  execFileSync('docker', ['run', '-d', '--rm', '--name', PG, '--label', 'hyperprox-test=marker', '-e', `POSTGRES_PASSWORD=${PW}`, '-e', 'POSTGRES_DB=t', '-p', '127.0.0.1::5432', 'postgres:16-alpine'], { stdio: 'ignore' })
  for (let i = 0; i < 60; i++) { try { pgExec(['pg_isready', '-U', 'postgres', '-d', 't']); break } catch { await new Promise(r => setTimeout(r, 1000)) } }
  await new Promise(r => setTimeout(r, 1500))
  const port = execFileSync('docker', ['port', PG, '5432']).toString().trim().split(':').pop()
  dbUrl = `postgresql://postgres:${PW}@127.0.0.1:${port}/t`
  execFileSync('npx', ['prisma', 'migrate', 'deploy', '--schema', './prisma/schema.prisma'], { env: { ...process.env, DATABASE_URL: dbUrl }, stdio: 'ignore' })

  // Tailscale's API: a key to mint, a device that appears.
  tsServer = http.createServer((req, res) => {
    let body = ''; req.on('data', d => { body += d }); req.on('end', () => {
      const send = (j: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)) }
      if (req.url!.includes('/keys') && req.method === 'POST') return send({ id: 'k1', key: M.installKey, expires: new Date(Date.now() + 600_000).toISOString() })
      if (req.url!.includes('/keys/') && req.method === 'GET') return (res.writeHead(404), res.end('{}'))
      if (req.url!.includes('/devices')) return send({ devices: [{ id: 'd1', nodeId: 'n-1', name: 'web.tail0.ts.net', hostname: 'web', addresses: ['100.64.0.5'], connectedToControl: true }] })
      send({})
    })
  })
  await new Promise<void>(r => tsServer.listen(0, '127.0.0.1', r))
  tsBase = `http://127.0.0.1:${(tsServer.address() as AddressInfo).port}`

  // RouterOS REST: checks the write login, keeps peers.
  rosServer = http.createServer((req, res) => {
    let body = ''; req.on('data', d => { body += d }); req.on('end', () => {
      ros.auth.push(String(req.headers.authorization ?? ''))
      if (req.method === 'PUT') { const row = { '.id': `*B${ros.peers.length + 1}`, ...JSON.parse(body) }; ros.peers.push(row); res.writeHead(200); return res.end(JSON.stringify(row)) }
      if (req.method === 'DELETE') { ros.peers = ros.peers.filter(p => !req.url!.endsWith(encodeURIComponent(p['.id']))); res.writeHead(204); return res.end() }
      res.writeHead(404); res.end('{}')
    })
  })
  await new Promise<void>(r => rosServer.listen(0, '127.0.0.1', r))
  rosBase = `http://127.0.0.1:${(rosServer.address() as AddressInfo).port}`
})

after(async () => {
  if (!ENABLED) return
  try { execFileSync('docker', ['rm', '-f', PG], { stdio: 'ignore' }) } catch { /* gone */ }
  tsServer?.close(); rosServer?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
  await resetLock()
})

test('vault rule: after install, sign-in, uninstall, WireGuard and router flows, no secret is anywhere but its vault item', { skip: !ENABLED, timeout: 10 * 60_000 }, async () => {
  process.env.DATABASE_URL = dbUrl
  const { PrismaClient } = await import('@prisma/client')
  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })
  const { setCredentials, getProviderCredentials } = await import('../src/lib/credentials')
  const { RemoteAccessService } = await import('../src/lib/remote/service')
  const { PrismaRemoteStore } = await import('../src/lib/remote/store')
  const { TailscaleClient } = await import('../src/lib/remote/tailscale')
  const { NetbirdClient } = await import('../src/lib/remote/netbird')
  const { WireguardService } = await import('../src/lib/vpn/wireguard/service')
  const { PrismaWgStore } = await import('../src/lib/vpn/wireguard/store')
  const { restWriter, mapPeers } = await import('../src/lib/vpn/wireguard/routeros')
  const { vaultWg } = await import('../src/routes/vpn')
  const { NotifyCore } = await import('../src/lib/notify/dispatcher')
  const { PrismaNotifyStore } = await import('../src/lib/notify/store')
  const { ChannelSecrets, LockedChannelsFile } = await import('../src/lib/notify/secrets')

  // Sign in (unlocks the fake vault) and plant the stored secrets.
  const broker = new FakeBroker()
  broker.addUser('owner@example.com', 'owner master password', 'owner')
  const app = await buildTestApp(broker)
  await signIn(app, 'owner@example.com', 'owner master password')
  await setCredentials('remote', 'tailscale', { api_token: M.apiToken })
  await setCredentials('remote', 'routeros-write', { username: 'hyperprox-wg', password: M.routerPw })
  await setCredentials('remote', 'netbird', { api_token: M.nbToken })

  // NetBird's API: a setup key to mint, a peer that appears.
  const nbCalls: string[] = []
  const nbFetch = (async (input: any, init: any = {}) => {
    const u = new URL(String(input)); const method = init.method ?? 'GET'
    nbCalls.push(`${method} ${u.pathname} ${String(init.headers?.authorization ?? '').length}`)
    const send = (j: unknown, status = 200) => new Response(j === undefined ? null : JSON.stringify(j), { status, headers: { 'content-type': 'application/json' } })
    if (u.pathname === '/api/setup-keys' && method === 'POST') return send({ id: 'sk1', key: M.nbSetupKey, expires: new Date(Date.now() + 600_000).toISOString() })
    if (u.pathname.startsWith('/api/setup-keys/')) return method === 'DELETE' ? send({}) : send({}, 404)
    if (u.pathname === '/api/peers') return send([{ id: 'nbp1', name: 'web', hostname: 'web', ip: '100.92.0.4', connected: true }])
    if (u.pathname.startsWith('/api/peers/')) return send({ id: 'nbp1', name: 'web' })
    if (u.pathname === '/api/groups') return send([{ id: 'g-all', name: 'All', peers: [] }])
    return send({})
  }) as typeof fetch

  // A private notification channel, with the outbox in Postgres.
  const nStore = new PrismaNotifyStore(prisma)
  const items = new Map<string, any>()
  const secrets = new ChannelSecrets({ readable: () => true, read: id => items.get(id) ?? null, write: async (id, s) => { items.set(id, s) }, remove: async id => { items.delete(id) } }, new LockedChannelsFile(path.join(tmp, 'locked.json')))
  const ch = await nStore.createChannel({ id: 'mine', name: 'mine', kind: 'webhook', enabled: true, minSeverity: 'info', eventFilter: 'all', quietHours: null, lanOverride: false, usableWhileLocked: false, private: true, nonSecret: {}, seededFrom: null, createdBy: 't' } as any)
  await secrets.put(ch, { url: 'https://hooks.example.com/x' })
  const delivered: string[] = []
  const notify = new NotifyCore({ store: nStore, secrets, publicUrl: () => undefined, autoKick: false, log: m => logs.push(m), transport: async req => { delivered.push(req.body); return { ok: true, status: 204 } } })

  // A fleet that echoes whatever it is given, as a careless client might.
  const machines = [{ id: 'lxc-101', kind: 'lxc', name: 'web', node: 'pve-a', vmid: 101, running: true }, { id: 'lxc-120', kind: 'lxc', name: 'wg', node: 'pve-a', vmid: 120, running: true }] as any[]
  const nbStatus = (on: boolean) => `HP_STATUS_BEGIN\n${JSON.stringify(on ? { management: { connected: true }, netbirdIp: '100.92.0.4/16', daemonVersion: '0.60.0', fqdn: 'web.netbird.cloud' } : { management: { connected: false } })}\nHP_STATUS_END`
  const nbFlags = 'HP_NB_CONFIG=/etc/netbird/config.json\nHP_NB_FLAG DisableDNS:true\nHP_NB_FLAG DisableClientRoutes:true\nHP_NB_FLAG ServerSSHAllowed:false'
  const exec: any = {
    listMachines: async () => machines,
    run: async (_m: any, script: string, o: any) => {
      let out = 'ok'
      // A careless client echoes everything it is given, keys included.
      if (script.includes('HP_OS_ID=')) out = 'HP_OS_ID=debian\nHP_OS_VERSION=13\nHP_OS_CODENAME=trixie\nHP_UNAME=Linux\nHP_PM=apt\nHP_SYSTEMD=1\nHP_TUN=1\nHP_ROOT=1'
      else if (script.includes('netbird up')) out = `echo: ${script}\nPlease do the SSO login in your browser.\nIf your browser didn't open automatically, use this URL to log in:\n\n${M.nbLogin}\n\n${nbFlags}\n${nbStatus(true)}`
      else if (script.includes('hp_k=$(wg genkey)')) out = `HP_WG_PRIV=${serverMade.priv}\nHP_WG_PUB=${serverMade.pub}`
      else if (script.includes('HP_WG_PRIV=$(cat')) out = `HP_WG_PRIV=${serverKey.priv}`
      else if (script.includes('HP_NB_CONFIG')) out = nbFlags
      else if (script.includes('netbird status')) out = script.includes('HP_REMOVED') ? 'HP_REMOVED' : nbStatus(true)
      else if (script.includes('HP_OS_ID=')) out = 'HP_OS_ID=debian\nHP_OS_VERSION=13\nHP_OS_CODENAME=trixie\nHP_UNAME=Linux\nHP_PM=apt\nHP_SYSTEMD=1\nHP_TUN=1\nHP_ROOT=1'
      else if (script.includes('HP_KEY=')) out = `echo: ${/HP_KEY='([^']+)'/.exec(script)?.[1]}\nHP_STATUS_BEGIN\n{"BackendState":"Running","Self":{"ID":"n-1","TailscaleIPs":["100.64.0.5"]}}\nHP_STATUS_END`
      else if (script.includes('HP_REMOVED')) out = 'HP_REMOVED'
      else if (script.includes('HP_BACKUP_OK')) out = 'HP_BACKUP_OK'
      else if (script.includes('wg genkey >') || script.includes('HP_WG\n') || script.includes('wg show')) out = `HP_WG_PUB=${serverKey.pub}\nHP_WG_PORT=51820\nHP_WG_DUMP_BEGIN\nHP_WG_DUMP_END`
      else if (script.includes('HP_STATUS_BEGIN')) out = `HP_STATUS_BEGIN\n{"BackendState":"NeedsLogin","AuthURL":"${M.login}"}\nHP_STATUS_END`
      o?.onData?.(out)
      return { code: 0, output: out, timedOut: false }
    },
    lxcConfig: async () => ({}), setLxcConfig: async () => undefined, firewallState: async () => ({ clusterEnabled: false, rules: [] }),
    addFirewallRule: async () => undefined, hostKeyTarget: async () => ({ host: 'x', port: 22 }), probeHostKey: async () => 'x', pinnedHostKey: async () => 'x', pinHostKey: async () => undefined,
  }
  const store = new PrismaRemoteStore(prisma)
  const remote = new RemoteAccessService({
    store, exec, settleMs: 0, log: m => logs.push(m),
    provider: async id => (id === 'tailscale' ? new TailscaleClient({ apiToken: (await getProviderCredentials('remote', 'tailscale')).api_token }, { base: tsBase })
      : new NetbirdClient({ managementUrl: '', apiToken: (await getProviderCredentials('remote', 'netbird')).api_token }, { fetch: nbFetch })),
    providerSettings: async () => ({ tags: [] }),
    publish: (e, o) => notify.publish(e, o),
  })
  const settle = async (j: any) => { for (let i = 0; i < 400 && remote.getJob(j.id)!.status === 'running'; i++) await new Promise(r => setTimeout(r, 10)); return remote.getJob(j.id)! }

  // Mesh: install with a key, a check that finds a sign-in link, an uninstall.
  const jobs: any[] = []
  jobs.push(await settle(remote.startJob({ action: 'install', provider: 'tailscale', machineIds: ['lxc-101'] }, 'owner@example.com')))
  jobs.push(await settle(remote.startJob({ action: 'check', provider: 'tailscale', machineIds: ['lxc-101'] }, 'owner@example.com')))
  await notify.tick()
  jobs.push(await settle(remote.startJob({ action: 'uninstall', provider: 'tailscale', machineIds: ['lxc-101'] }, 'owner@example.com')))
  assert.equal(jobs[0].status, 'completed', jobs[0].error)
  assert.ok(delivered.some(b => b.includes(M.login)), 'the sign-in link reached the private channel')

  // NetBird: install with a setup key, a settings change whose `netbird up` asks for a sign-in, an uninstall.
  jobs.push(await settle(remote.startJob({ action: 'install', provider: 'netbird', machineIds: ['lxc-101'] }, 'owner@example.com')))
  assert.equal(jobs.at(-1).status, 'completed', jobs.at(-1).error)
  jobs.push(await settle(remote.startJob({ action: 'configure', provider: 'netbird', machineIds: ['lxc-101'], prefs: { acceptRoutes: true } }, 'owner@example.com')))
  await notify.tick()
  assert.ok(delivered.some(b => b.includes(M.nbLogin)), 'the NetBird sign-in link reached the private channel')
  jobs.push(await settle(remote.startJob({ action: 'uninstall', provider: 'netbird', machineIds: ['lxc-101'] }, 'owner@example.com')))

  // WireGuard: a server, a phone, a rotation, a router peer added and removed.
  const cred = await getProviderCredentials('remote', 'routeros-write')
  const routerKey = kp().pub
  const routeros = {
    read: async (p: string) => (p.endsWith('/interface/wireguard') ? [{ '.id': '*1', name: 'wg-home', 'listen-port': '13231', 'public-key': routerKey, running: 'true' }] : p.endsWith('/peers') ? ros.peers : []),
    write: restWriter({ url: rosBase, insecureTLS: false }, { username: cred.username, password: cred.password }),
  }
  const wgStore = new PrismaWgStore(prisma)
  const wg = new WireguardService({ remote, exec, store: wgStore, vault: vaultWg, router: async () => routeros })
  const wgLogs: string[] = []
  // The server's own key is backed up into the vault (the opt-in path): read once from the machine.
  const s = await wg.createServer({ machineId: 'lxc-120', address: '100.64.10.1/24', endpoint: 'vpn.example.com:51820' }, 'owner@example.com')
  wgLogs.push(s.log)
  assert.equal(s.publicKey, serverKey.pub)
  await wg.backupServerKey(s.id, 'owner@example.com')
  const conn = await wg.connectMachine({ machineId: 'lxc-101', serverId: s.id, allowedIps: ['100.64.10.0/24'] }, 'owner@example.com')
  wgLogs.push(conn.log)
  const made = await wg.addDevice(s.id, { name: 'laptop', keygen: 'server' }, 'owner@example.com')
  assert.ok(made.config.includes(serverMade.priv), 'the server-made key is in the config shown once')
  const dev = await wg.addDevice(s.id, { name: 'phone', publicKey: phone1.pub, privateKey: phone1.priv }, 'owner@example.com')
  await wg.rotateDevice(dev.peer.id, { publicKey: phone2.pub, privateKey: phone2.priv }, 'owner@example.com')
  const rdev = await wg.addRouterDevice({ iface: 'wg-home', endpoint: 'home.example.com:13231', address: '100.64.20.10/32', allowedIps: ['100.64.20.0/24'], name: 'tablet', publicKey: routerPhone.pub, privateKey: routerPhone.priv }, 'owner@example.com')
  assert.equal(mapPeers(ros.peers).length, 1)
  await wg.removePeer(rdev.peer.id, 'owner@example.com')
  assert.equal(ros.peers.length, 0)
  assert.ok(ros.auth.some(a => Buffer.from(a.replace('Basic ', ''), 'base64').toString().endsWith(`:${M.routerPw}`)), 'the router got the write login')

  // The HTTP layer: a phone added through the real gate and routes, every request logged at trace level.
  const Fastify = (await import('fastify')).default
  const { registerGate } = await import('../src/lib/gate')
  const { authRoutes } = await import('../src/routes/auth')
  const { buildVpnRoutes } = await import('../src/routes/vpn')
  const { Writable } = await import('node:stream')
  const httpLog = new Writable({ write(c, _e, cb) { logs.push(String(c)); cb() } })
  const web = Fastify({ logger: { level: 'trace', stream: httpLog } as any })
  await registerGate(web)
  await web.register(authRoutes, { prefix: '/api/auth' })
  await web.register(buildVpnRoutes({ service: wg, sweep: false }), { prefix: '/api/vpn' })
  await web.ready()
  const { cookie } = await signIn(web, 'owner@example.com', 'owner master password')
  await web.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie }, payload: { password: 'owner master password' } })
  const added = await web.inject({ method: 'POST', url: `/api/vpn/wg/servers/${s.id}/devices`, headers: { cookie }, payload: { name: 'http phone', publicKey: httpPhone.pub, privateKey: httpPhone.priv } })
  assert.equal(added.statusCode, 201, added.body)
  assert.match(String(added.headers['cache-control']), /no-store/)
  const bad = await web.inject({ method: 'POST', url: `/api/vpn/wg/servers/${s.id}/devices`, headers: { cookie }, payload: { name: 'bad', publicKey: phone1.pub, privateKey: httpPhone.priv } })
  assert.equal(bad.statusCode, 400, 'a mismatched pair is refused')
  assert.ok(!bad.body.includes(httpPhone.priv), 'and the refusal does not echo the key')
  await web.close()

  // Positive control: what HyperProx keeps is in the vault.
  const vault = JSON.stringify([...broker.items.values()])
  for (const v of [M.apiToken, M.routerPw, M.nbToken, phone2.priv, phone1.priv, httpPhone.priv, serverMade.priv, serverKey.priv]) assert.ok(vault.includes(v), 'kept in the vault item')

  // Nowhere else: Postgres, files, logs.
  const dump = pgExec(['pg_dump', '-U', 'postgres', '-d', 't', '--data-only'])
  const repo = path.resolve(__dirname, '..', '..', '..')
  // grep: 0 found, 1 not found, anything else is an error and fails the test (a search that did not run proves nothing).
  const grepFiles = (needle: string) => {
    const r = spawnSync('grep', ['-rIl', '-D', 'skip', '--exclude-dir=node_modules', '--exclude-dir=.git', '--exclude-dir=.next', '-F', needle, repo, tmp, os.tmpdir()], { encoding: 'utf8' })
    if (r.status === 1) return ''
    if (r.status === 0) return r.stdout.trim()
    throw new Error(`grep failed (exit ${r.status}): ${r.stderr.slice(0, 300)}`)
  }
  assert.throws(() => { const r = spawnSync('grep', ['-rIl', '-F', 'x', path.join(tmp, 'does-not-exist')]); if (r.status !== 0 && r.status !== 1) throw new Error('grep error') }, /grep error/, 'a grep error is seen')
  for (const [what, v] of Object.entries({ ...M, phone1: phone1.priv, phone2: phone2.priv, routerPhone: routerPhone.priv, httpPhone: httpPhone.priv, serverMade: serverMade.priv, serverKey: serverKey.priv })) {
    assert.ok(!dump.includes(v), `${what} is not in Postgres`)
    assert.ok(!logs.join('\n').includes(v) && !jobs.some(j => JSON.stringify(remote.getJob(j.id) ?? j).includes(v)), `${what} is not in any log`)
    assert.ok(!wgLogs.some(l => l.includes(v)), `${what} is not in a WireGuard job log`)
    assert.equal(grepFiles(v), '', `${what} is not in any file`)
  }
  await prisma.$disconnect()
  await app.close()
})
