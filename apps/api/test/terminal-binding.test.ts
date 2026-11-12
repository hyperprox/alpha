// The Terminal sends a saved login only where HyperProx itself says that host is: the address is worked out on
// the server from the pane's id, never taken from the browser. Node logins (node-<name>) share the store but no
// Terminal route or socket will use, list or replace one, the shared login covers cluster guests only, and a
// one-off command never goes to a host whose key is not pinned. Against a real SSH server on loopback.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { terminalRoutes } from '../src/routes/terminal'
import { terminalWsRoutes } from '../src/routes/terminal-ws'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable, getCredential, setCredential } from '../src/lib/credentials'
import { requestContext } from '../src/lib/auth'
import { loadCredential, saveCredential, runCommand, CredentialIdRefused, fingerprintOf } from '../src/lib/ssh-broker'
import { resolveTerminalTarget, setTerminalTargetDeps, terminalIdProblem, type TargetDeps } from '../src/lib/terminal-targets'
import { FakeBroker } from './fakes/fake-broker'
import { signIn } from './fakes/app'
import { createRequire } from 'node:module'

// A real client on a real port: injectWS resolves after the server's first frames, which would be lost.
const WebSocket: any = createRequire(require.resolve('@fastify/websocket'))('ws')
let base = ''
function openWs(path: string, cookie: string): { ws: any; frames: any[]; closed: Promise<void> } {
  const ws = new WebSocket(base + path, { headers: { cookie } })
  const frames: any[] = []
  ws.on('message', (m: Buffer) => frames.push(JSON.parse(m.toString())))
  const closed = new Promise<void>(r => ws.once('close', () => r()))
  ws.on('error', () => undefined)
  return { ws, frames, closed }
}

const broker = new FakeBroker()
broker.addUser('owner@example.com', 'owner master password', 'owner')
broker.addUser('op@example.com', 'operator master password', 'operator')

let app: FastifyInstance
let server: any
let sshPort = 0
let authTried = 0
let hostFp = ''
const PW = 'box-password'

const deps: TargetDeps = {
  clusterResources: async () => [
    { type: 'lxc', vmid: 101, node: 'node-a', status: 'running', name: 'web' },
    { type: 'qemu', vmid: 202, node: 'node-a', status: 'running', name: 'vm' },
  ],
  guestConfig: async () => ({ net0: 'name=eth0,bridge=vmbr0,ip=192.0.2.101/24' }),
  manualHosts: async () => [{ id: 'ssh-box', name: 'box', address: '127.0.0.1', port: sshPort }],
  hostAddresses: async () => ({ 'qemu-202': '192.0.2.202', 'plugin-router': '192.0.2.1' }),
  pluginConsole: async (id) => id === 'router' ? { baseUrl: 'https://192.0.2.254:8443', defaultPort: 22, tmux: false } : null,
}

before(async () => {
  setBroker(broker)
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  setTerminalTargetDeps(deps)
  const mod: any = await import('ssh2')
  const { Server, utils } = mod.default ?? mod
  const kp = utils.generateKeyPairSync('ed25519')
  hostFp = fingerprintOf(utils.parseKey(kp.public).getPublicSSH())
  server = new Server({ hostKeys: [kp.private] }, (client: any) => {
    client.on('authentication', (ctx: any) => { authTried++; ctx.method === 'password' && ctx.password === PW ? ctx.accept() : ctx.reject() })
    client.on('ready', () => client.on('session', (accept: any) => { const sess = accept(); sess.on('pty', (a: any) => a?.()); sess.on('exec', (acc: any) => { const s = acc(); s.write('main|1|0|1|2\n'); s.exit(0); s.end() }) }))
    client.on('error', () => undefined)
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  sshPort = server.address().port

  app = Fastify({ logger: false })
  await app.register(websocket)
  await registerGate(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(terminalRoutes, { prefix: '/api/terminal' })
  await app.register(terminalWsRoutes, { prefix: '/ws/terminal' })
  await app.listen({ port: 0, host: '127.0.0.1' })
  base = `ws://127.0.0.1:${(app.server.address() as any).port}`
})
after(async () => { setTerminalTargetDeps(null); server?.close(); if (isUnlocked()) await lock('manual'); await app.close() })

async function asOwner<T>(fn: () => Promise<T>): Promise<T> {
  const sid = [...broker.sessions.values()].find(s => s.email === 'owner@example.com')!.sid
  return requestContext.run({ sid, email: 'owner@example.com', role: 'owner' }, fn)
}

const NODE_LOGIN = { username: 'root', password: 'node-root-password', port: 22 }
const BOX_LOGIN = { username: 'admin', password: PW, port: 22 }

test('resolve: every Terminal id maps to the address HyperProx knows; anything else is refused', async () => {
  assert.deepEqual(await resolveTerminalTarget('lxc-101', 22, deps), { host: '192.0.2.101', port: 22, tmux: true })
  assert.deepEqual(await resolveTerminalTarget('qemu-202', 2222, deps), { host: '192.0.2.202', port: 2222, tmux: true })
  assert.deepEqual(await resolveTerminalTarget('ssh-box', 22, deps), { host: '127.0.0.1', port: sshPort, tmux: true })
  assert.deepEqual(await resolveTerminalTarget('plugin-router', undefined, deps), { host: '192.0.2.1', port: 22, tmux: false })
  for (const id of ['node-a', 'NODE-a', 'node_a', '_shared', 'lxc-999', 'qemu-1/../x', 'plugin-none', 'anything']) {
    await assert.rejects(resolveTerminalTarget(id, 22, deps), undefined, id)
  }
  assert.match(terminalIdProblem('node-a')!, /Setup checklist/)
})

test('a node login is never read, listed, replaced or removed through the Terminal', async () => {
  const owner = await signIn(app, 'owner@example.com', 'owner master password')
  await asOwner(async () => {
    await saveCredential('node-a', NODE_LOGIN)
    await saveCredential('_shared', { username: 'guest', password: 'shared-pw', port: 22 })
    await saveCredential('ssh-box', BOX_LOGIN)
    await assert.rejects(loadCredential('node-a'), CredentialIdRefused)
    await assert.rejects(loadCredential('_shared'), CredentialIdRefused)
    // The shared login covers cluster guests only.
    assert.equal((await loadCredential('lxc-101'))?.username, 'guest')
    assert.equal(await loadCredential('ssh-other'), null)
  })
  const put = await app.inject({ method: 'PUT', url: '/api/terminal/credentials/node-a', headers: { cookie: owner.cookie },
    payload: { username: 'root', password: 'attacker-chosen', address: '192.0.2.66' } })
  assert.equal(put.statusCode, 403, put.body)
  const del = await app.inject({ method: 'DELETE', url: '/api/terminal/credentials/node-a', headers: { cookie: owner.cookie } })
  assert.equal(del.statusCode, 403, del.body)
  await asOwner(async () => {
    assert.equal(JSON.parse((await getCredential('deck', 'ssh', 'node-a'))!).password, NODE_LOGIN.password, 'the node login is unchanged')
    assert.equal(await getCredential('deck', 'address', 'node-a'), null)
  })
  const list = await app.inject({ method: 'GET', url: '/api/terminal/credentials', headers: { cookie: owner.cookie } })
  assert.equal(list.statusCode, 200)
  assert.equal(list.json().data.ids.some((i: string) => i.startsWith('node-')), false)
})

test('an operator\'s socket cannot open a node login, whatever host it names', async () => {
  const op = await signIn(app, 'op@example.com', 'operator master password')
  const { frames, closed } = openWs('/ws/terminal/term?id=node-a&host=127.0.0.1&port=' + sshPort, op.cookie)
  await closed
  assert.ok(frames.some(f => f.t === 'error' && /Setup checklist/.test(f.m)), JSON.stringify(frames))
  assert.equal(authTried, 0, 'nothing was sent to any SSH server')
})

test('the socket connects to the server-side address, not the one the browser sent', async () => {
  const op = await signIn(app, 'op@example.com', 'operator master password')
  const { ws, frames } = openWs(`/ws/terminal/term?id=ssh-box&host=192.0.2.66&port=22&tmux=0`, op.cookie)
  await new Promise(r => setTimeout(r, 1500))
  const connecting = frames.find(f => f.t === 'status' && f.state === 'connecting')
  assert.equal(connecting?.detail, `127.0.0.1:${sshPort}`, JSON.stringify(frames))
  ws.terminate()
})

test('one-off commands: refused for an unpinned key before any login is sent, and the body\'s host is ignored', async () => {
  // The previous test pinned 127.0.0.1:<port> as a Terminal pane does (terminal-auto); clear it for this one.
  await asOwner(async () => {
    const { forgetHostKey } = await import('../src/lib/ssh-broker')
    await forgetHostKey(`127.0.0.1:${sshPort}`)
  })
  const tried = authTried
  await asOwner(async () => {
    await assert.rejects(runCommand({ host: '127.0.0.1', port: sshPort, cred: BOX_LOGIN as any, command: 'true' }), /no pinned host key/)
  })
  assert.equal(authTried, tried, 'no login went to the unpinned host')

  const op = await signIn(app, 'op@example.com', 'operator master password')
  const r = await app.inject({ method: 'POST', url: '/api/terminal/hosts/ssh-box/tmux-sessions', headers: { cookie: op.cookie }, payload: { host: '192.0.2.66', port: 22 } })
  assert.equal(r.statusCode, 500, r.body)
  assert.match(r.json().error, new RegExp(`127\\.0\\.0\\.1:${sshPort} has no pinned host key`))

  await asOwner(() => setCredential('deck', 'hostkey', `127.0.0.1:${sshPort}`, hostFp, false))
  const ok = await app.inject({ method: 'POST', url: '/api/terminal/hosts/ssh-box/tmux-sessions', headers: { cookie: op.cookie }, payload: { host: '192.0.2.66', port: 22 } })
  assert.equal(ok.statusCode, 200, ok.body)
  assert.equal(ok.json().data[0].name, 'main')
  const node = await app.inject({ method: 'POST', url: '/api/terminal/hosts/node-a/tmux-sessions', headers: { cookie: op.cookie }, payload: { host: '127.0.0.1', port: sshPort } })
  assert.equal(node.statusCode, 403, node.body)
})

test('the remote-access executor still gets Terminal logins: shared for a VM, its own for a hand-added host, never a node\'s', async () => {
  const { productionRemoteExecutor } = await import('../src/lib/remote/executor')
  const sent: Array<{ host: string; user: string }> = []
  const ssh: any = async (o: any) => { sent.push({ host: o.host, user: o.cred.username }); return { code: 0, output: '', timedOut: false } }
  const pve: any = { fetchStrict: async () => { throw new Error('no agent') } }
  const ex = productionRemoteExecutor(pve, {
    ssh, loadCredential, nodeCredential: async () => null,
    listManualHosts: async () => [], listHostAddresses: async () => ({ 'qemu-202': '192.0.2.202' }),
  } as any)
  await asOwner(async () => {
    await ex.run({ id: 'qemu-202', kind: 'qemu', name: 'vm', node: 'node-a', vmid: 202, running: true } as any, 'true')
    await ex.run({ id: 'host-ssh-box', kind: 'host', name: 'box', running: true, address: '127.0.0.1' } as any, 'true')
    // A hand-added host with no login of its own no longer borrows the shared guest login.
    await assert.rejects(ex.run({ id: 'host-ssh-other', kind: 'host', name: 'other', running: true, address: '192.0.2.9' } as any, 'true'), /No login saved/)
  })
  assert.deepEqual(sent, [{ host: '192.0.2.202', user: 'guest' }, { host: '127.0.0.1', user: 'admin' }])
  assert.equal(sent.some(s => s.user === 'root'), false, 'the node login was never used')
})

test('a changed host key is refused, and the socket tells the pane both keys so it can check with Proxmox', async () => {
  const wrong = 'SHA256:' + 'A'.repeat(43)
  await asOwner(() => setCredential('deck', 'hostkey', `127.0.0.1:${sshPort}`, wrong, false))
  const tried = authTried
  const op = await signIn(app, 'op@example.com', 'operator master password')
  const { frames, closed } = openWs('/ws/terminal/term?id=ssh-box&tmux=0', op.cookie)
  await closed
  const hk = frames.find(f => f.t === 'hostkey')
  assert.deepEqual(hk, { t: 'hostkey', host: '127.0.0.1', port: sshPort, pinned: wrong, offered: hostFp, offeredType: 'ssh-ed25519' }, JSON.stringify(frames))
  assert.ok(frames.some(f => f.t === 'error' && /has changed/.test(f.m)))
  assert.equal(authTried, tried, 'no login went to the host')
  await asOwner(async () => assert.equal(await getCredential('deck', 'hostkey', `127.0.0.1:${sshPort}`), wrong, 'the pin is unchanged'))
})
