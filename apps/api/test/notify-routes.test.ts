// /api/settings/notifications over HTTP behind the real vault gate: admin only, owner for
// "usable while locked", masks only in responses, audited without secrets.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { buildNotifyRoutes } from '../src/routes/notify'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { requiredRole } from '../src/lib/roles'
import { NotifyService } from '../src/lib/notify/service'
import { MemoryNotifyStore } from '../src/lib/notify/store'
import { ChannelSecrets, LockedChannelsFile, vaultSecretBackend } from '../src/lib/notify/secrets'
import type { OutboundRequest } from '../src/lib/notify/types'
import { FakeBroker } from './fakes/fake-broker'
import { signIn } from './fakes/app'

const broker = new FakeBroker()
broker.addUser('owner@example.com', 'owner master password', 'owner')
broker.addUser('admin@example.com', 'admin master password', 'admin')
broker.addUser('op@example.com', 'operator master password', 'operator')
broker.addUser('viewer@example.com', 'viewer master password', 'viewer')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-routes-'))
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }))

const SECRET_URL = 'https://discord.com/api/webhooks/42/very-secret-path-9f3a'
let app: FastifyInstance
const store = new MemoryNotifyStore()
const sent: OutboundRequest[] = []
let answer = { ok: true, status: 204 } as { ok: boolean; status?: number; code?: string }
let svc: NotifyService

before(async () => {
  setBroker(broker)
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  svc = new NotifyService({
    store, secrets: new ChannelSecrets(vaultSecretBackend(), new LockedChannelsFile(path.join(dir, 'locked.json'))),
    legacy: { updatesUrl: () => undefined, certsUrl: () => undefined }, env: {},
    transport: async req => { sent.push(req); return answer }, isPrivate: async () => false, autoKick: false, tickMs: 0,
  })
  app = Fastify({ logger: false })
  await registerGate(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(buildNotifyRoutes({ service: svc }), { prefix: '/api/settings/notifications' })
  await app.ready()
})
beforeEach(async () => { if (isUnlocked()) await lock('manual') })
after(async () => { if (isUnlocked()) await lock('manual'); await app.close() })

const BASE = '/api/settings/notifications'
const ROUTES: Array<[string, string]> = [
  ['GET', `${BASE}/channels`], ['POST', `${BASE}/channels`], ['PUT', `${BASE}/channels/x`], ['DELETE', `${BASE}/channels/x`],
  ['POST', `${BASE}/channels/x/test`], ['GET', `${BASE}/deliveries`],
]

test('the role matrix makes every notifications route admin, reads included', () => {
  for (const [m, u] of ROUTES) assert.equal(requiredRole(m, u), 'admin', `${m} ${u}`)
})

test('locked: 423; viewer and operator: 403 on every route', async () => {
  assert.equal((await app.inject({ method: 'GET', url: `${BASE}/channels` })).statusCode, 423)
  for (const [email, pw] of [['viewer@example.com', 'viewer master password'], ['op@example.com', 'operator master password']]) {
    const { cookie } = await signIn(app, email, pw)
    for (const [method, url] of ROUTES) {
      const r = await app.inject({ method: method as any, url, headers: { cookie }, payload: method === 'GET' || method === 'DELETE' ? undefined : {} })
      assert.equal(r.statusCode, 403, `${email} ${method} ${url}`)
    }
  }
  assert.equal(sent.length, 0)
})

test('admin: create, list with a mask only, test, edit, delete; audited without secrets', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const bad = await app.inject({ method: 'POST', url: `${BASE}/channels`, headers: { cookie }, payload: { name: 'X', kind: 'discord', url: 'https://evil.example.com/api/webhooks/1/a' } })
  assert.equal(bad.statusCode, 400)
  assert.match(bad.json().error, /discord\.com/)

  const c = await app.inject({ method: 'POST', url: `${BASE}/channels`, headers: { cookie }, payload: { name: 'Team', kind: 'discord', url: SECRET_URL, minSeverity: 'info' } })
  assert.equal(c.statusCode, 201, c.body)
  const id = c.json().channel.id
  assert.equal(c.json().channel.mask, 'discord.com/…/••••9f3a')

  const list = await app.inject({ method: 'GET', url: `${BASE}/channels`, headers: { cookie } })
  assert.equal(list.statusCode, 200)
  assert.equal(list.json().meta.canSetUsableWhileLocked, false)
  assert.equal(list.body.includes('very-secret-path'), false)

  const t = await app.inject({ method: 'POST', url: `${BASE}/channels/${id}/test`, headers: { cookie } })
  assert.equal(t.statusCode, 200)
  assert.deepEqual(t.json().result, { ok: true, status: 204, text: 'Delivered (HTTP 204)' })
  const body = JSON.parse(sent.at(-1)!.body)
  assert.equal(body.embeds[0].title, 'HyperProx test')
  assert.equal(body.embeds[0].description.startsWith('If you can read this, alerts to Team work.'), true)

  answer = { ok: false, status: 401 }
  const t2 = await app.inject({ method: 'POST', url: `${BASE}/channels/${id}/test`, headers: { cookie } })
  assert.equal(t2.json().result.text, 'Refused: HTTP 401')
  answer = { ok: true, status: 204 }
  const after = (await app.inject({ method: 'GET', url: `${BASE}/channels`, headers: { cookie } })).json().channels[0]
  assert.equal(after.lastResult.text, 'Refused: HTTP 401')

  // Edit without the secret keeps it; a non-owner cannot make it usable while locked.
  const e = await app.inject({ method: 'PUT', url: `${BASE}/channels/${id}`, headers: { cookie }, payload: { name: 'Team chat', minSeverity: 'warning' } })
  assert.equal(e.statusCode, 200, e.body)
  assert.equal(e.json().channel.mask, 'discord.com/…/••••9f3a')
  const locked = await app.inject({ method: 'PUT', url: `${BASE}/channels/${id}`, headers: { cookie }, payload: { usableWhileLocked: true } })
  assert.equal(locked.statusCode, 403)
  const lockedNew = await app.inject({ method: 'POST', url: `${BASE}/channels`, headers: { cookie }, payload: { name: 'L', kind: 'ntfy', url: 'https://ntfy.example.com/t', usableWhileLocked: true } })
  assert.equal(lockedNew.statusCode, 403)
  const lan = await app.inject({ method: 'PUT', url: `${BASE}/channels/${id}`, headers: { cookie }, payload: { lanOverride: true } })
  assert.equal(lan.statusCode, 400, 'no self-hosted switch for Discord')

  const del = await app.inject({ method: 'DELETE', url: `${BASE}/channels/${id}`, headers: { cookie } })
  assert.equal(del.statusCode, 200)
  assert.equal((await app.inject({ method: 'GET', url: `${BASE}/channels`, headers: { cookie } })).json().channels.length, 0)
  assert.deepEqual(store.audits.map(a => a.action), ['notify.channel.create', 'notify.channel.test', 'notify.channel.test', 'notify.channel.update', 'notify.channel.delete'])
  assert.equal(JSON.stringify(store.audits).includes('very-secret-path'), false)
  assert.equal(JSON.stringify(store.outbox).includes('very-secret-path'), false)
})

test('owner: may make a channel usable while locked; its secret then lives in the file, not the vault', async () => {
  const { cookie } = await signIn(app, 'owner@example.com', 'owner master password')
  const c = await app.inject({ method: 'POST', url: `${BASE}/channels`, headers: { cookie },
    payload: { name: 'Phone', kind: 'ntfy', url: 'https://ntfy.example.com/my-topic', token: 'tk_secret_1', usableWhileLocked: true } })
  assert.equal(c.statusCode, 201, c.body)
  assert.equal(c.json().channel.usableWhileLocked, true)
  assert.equal(c.json().channel.hasToken, true)
  const f = JSON.parse(fs.readFileSync(path.join(dir, 'locked.json'), 'utf8'))
  assert.equal(f.channels[c.json().channel.id].secret.token, 'tk_secret_1')
  assert.equal(c.body.includes('tk_secret_1'), false)
  assert.equal((await app.inject({ method: 'GET', url: `${BASE}/channels`, headers: { cookie } })).json().meta.canSetUsableWhileLocked, true)
  const ssrf = await app.inject({ method: 'POST', url: `${BASE}/channels`, headers: { cookie }, payload: { name: 'Lan', kind: 'ntfy', url: 'http://ntfy.lan/t' } })
  assert.equal(ssrf.statusCode, 400, 'http needs the self-hosted switch')
  const lanOk = await app.inject({ method: 'POST', url: `${BASE}/channels`, headers: { cookie }, payload: { name: 'Lan', kind: 'ntfy', url: 'http://ntfy.lan/t', lanOverride: true } })
  assert.equal(lanOk.statusCode, 201)
})

test('marking a channel private needs the master password again; other edits do not', async () => {
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const url = 'https://discord.com/api/webhooks/43/private-path-0001'
  const refused = await app.inject({ method: 'POST', url: `${BASE}/channels`, headers: { cookie }, payload: { name: 'Mine', kind: 'discord', url, private: true } })
  assert.equal(refused.statusCode, 403); assert.equal(refused.json().code, 'reconfirm_required')
  const plain = await app.inject({ method: 'POST', url: `${BASE}/channels`, headers: { cookie }, payload: { name: 'Mine', kind: 'discord', url } })
  assert.equal(plain.statusCode, 201, plain.body)
  const id = plain.json().channel.id
  assert.equal((await app.inject({ method: 'PUT', url: `${BASE}/channels/${id}`, headers: { cookie }, payload: { name: 'Mine too' } })).statusCode, 200)
  const mark = await app.inject({ method: 'PUT', url: `${BASE}/channels/${id}`, headers: { cookie }, payload: { private: true } })
  assert.equal(mark.statusCode, 403); assert.equal(mark.json().code, 'reconfirm_required')
  assert.equal((await svc.listChannels()).find(c => c.id === id)?.private, false, 'nothing changed')
  await app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie }, payload: { password: 'admin master password' } })
  const ok = await app.inject({ method: 'PUT', url: `${BASE}/channels/${id}`, headers: { cookie }, payload: { private: true } })
  assert.equal(ok.statusCode, 200, ok.body)
  assert.equal((await svc.listChannels()).find(c => c.id === id)?.private, true)
  await app.inject({ method: 'DELETE', url: `${BASE}/channels/${id}`, headers: { cookie } })
})
