// A WebSocket is authenticated once, at its upgrade, so each one is tied to the session that opened it: signing
// out, the session being removed, or a lock closes it. And a deploy job's progress goes only to the sockets of the
// person who started it, never to every viewer's live feed.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import { createRequire } from 'node:module'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { wsRoutes } from '../src/routes/ws'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { allSessions, removeSession } from '../src/lib/auth'
import { trackedSocketCount, SESSION_ENDED } from '../src/lib/session-sockets'
import { broadcast, stopBroadcast } from '../src/lib/ws-broadcast'
import { FakeBroker } from './fakes/fake-broker'
import { signIn } from './fakes/app'

const WebSocket: any = createRequire(require.resolve('@fastify/websocket'))('ws')
const broker = new FakeBroker()
broker.addUser('alice@example.com', 'alice master password', 'admin')
broker.addUser('bob@example.com', 'bob master password', 'viewer')
let app: FastifyInstance
let base = ''

before(async () => {
  setBroker(broker)
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  app = Fastify({ logger: false })
  await app.register(websocket)
  await registerGate(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(wsRoutes, { prefix: '/ws' })
  await app.listen({ port: 0, host: '127.0.0.1' })
  base = `ws://127.0.0.1:${(app.server.address() as any).port}`
})
after(async () => { stopBroadcast(); if (isUnlocked()) await lock('manual'); await app.close() })

function open(cookie: string): Promise<{ ws: any; frames: any[]; closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base + '/ws', { headers: { cookie } })
    const frames: any[] = []
    ws.on('message', (m: Buffer) => frames.push(JSON.parse(m.toString())))
    const closed = new Promise<number>(r => ws.once('close', (code: number) => r(code)))
    ws.once('open', () => resolve({ ws, frames, closed }))
    ws.once('error', reject)
  })
}
const tick = (ms = 50) => new Promise(r => setTimeout(r, ms))
const within = <T>(p: Promise<T>, ms = 2000) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timed out')), ms))])

test('sign-out closes that session\'s sockets and no one else\'s', async () => {
  const a = await signIn(app, 'alice@example.com', 'alice master password')
  const b = await signIn(app, 'bob@example.com', 'bob master password')
  const sa = await open(a.cookie), sb = await open(b.cookie)
  await tick()
  const out = await app.inject({ method: 'POST', url: '/api/auth/sign-out', headers: { cookie: a.cookie } })
  assert.equal(out.statusCode, 200)
  assert.equal(await within(sa.closed), SESSION_ENDED)
  await tick()
  assert.equal(sb.ws.readyState, 1, 'the other person\'s socket stays open')
  sb.ws.close()
})

test('a session the server removes (the vault ended it) closes its sockets', async () => {
  const b = await signIn(app, 'bob@example.com', 'bob master password')
  const sb = await open(b.cookie)
  await tick()
  const sid = allSessions().filter(s => s.email === 'bob@example.com').at(-1)!.sid
  removeSession(sid)
  assert.equal(await within(sb.closed), SESSION_ENDED)
})

test('a lock closes every socket', async () => {
  const a = await signIn(app, 'alice@example.com', 'alice master password')
  const b = await signIn(app, 'bob@example.com', 'bob master password')
  const sa = await open(a.cookie), sb = await open(b.cookie)
  await tick()
  await lock('manual')
  await within(Promise.all([sa.closed, sb.closed]))
  await tick()
  assert.equal(trackedSocketCount(), 0)
})

test('deploy progress reaches only the job owner\'s live sockets', async () => {
  const a = await signIn(app, 'alice@example.com', 'alice master password')
  const b = await signIn(app, 'bob@example.com', 'bob master password')
  const sa = await open(a.cookie), sb = await open(b.cookie)
  await tick()
  broadcast(null, 'wizard_progress', { jobId: 'j1', steps: [{ name: 'create', detail: '192.0.2.42' }] }, 'Alice@example.com')
  broadcast(null, 'fast', { nodes: [] })
  await tick(150)
  assert.ok(sa.frames.some(f => f.type === 'wizard_progress'), 'the owner gets it')
  assert.equal(sb.frames.some(f => f.type === 'wizard_progress'), false, 'another viewer does not')
  assert.ok(sb.frames.some(f => f.type === 'fast'), 'cluster status still goes to everyone signed in')
  sa.ws.close(); sb.ws.close()
})
