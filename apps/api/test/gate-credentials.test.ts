import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { FakeBroker } from './fakes/fake-broker'
import { buildTestApp, resetLock, signIn } from './fakes/app'
import {
  getCredential, getProviderCredentials, setCredential, deleteCredential, listCredentialKeys,
  getCategoryForUI, VaultLockedError, itemName,
} from '../src/lib/credentials'
import { requestContext } from '../src/lib/auth'

const broker = new FakeBroker()
broker.addUser('owner@example.com', 'owner master password', 'owner')
broker.addUser('admin@example.com', 'admin master password', 'admin')
broker.items.set('hyperprox:dns/godaddy', { id: 'g1', name: 'hyperprox:dns/godaddy', fields: { api_key: 'key-1', api_secret: 'secret-1' } })
const appP = buildTestApp(broker)
beforeEach(resetLock)
after(async () => { await resetLock(); await (await appP).close() })

test('item naming', () => {
  assert.equal(itemName('dns', 'godaddy'), 'hyperprox:dns/godaddy')
})

test('locked: every read and write throws VaultLockedError', async () => {
  await assert.rejects(getCredential('dns', 'godaddy', 'api_key'), VaultLockedError)
  await assert.rejects(getProviderCredentials('dns', 'godaddy'), VaultLockedError)
  await assert.rejects(listCredentialKeys('dns', 'godaddy'), VaultLockedError)
  await assert.rejects(getCategoryForUI('dns'), VaultLockedError)
  await assert.rejects(setCredential('dns', 'godaddy', 'api_key', 'x'), VaultLockedError)
  await assert.rejects(deleteCredential('dns', 'godaddy', 'api_key'), VaultLockedError)
})

test('unlocked: reads come from the vault cache', async () => {
  const app = await appP
  await signIn(app, 'admin@example.com', 'admin master password')
  assert.equal(await getCredential('dns', 'godaddy', 'api_key'), 'key-1')
  assert.equal(await getCredential('dns', 'godaddy', 'nope'), null)
  assert.equal(await getCredential('dns', 'nobody', 'x'), null)
  assert.deepEqual(await getProviderCredentials('dns', 'godaddy'), { api_key: 'key-1', api_secret: 'secret-1' })
  assert.deepEqual((await listCredentialKeys('dns', 'godaddy')).map(k => k.key), ['api_key', 'api_secret'])
  const ui = await getCategoryForUI('dns')
  const sec = ui.find(r => r.provider === 'godaddy' && r.key === 'api_secret')!
  assert.equal(sec.isSet, true)
  assert.notEqual(sec.value, 'secret-1')
})

test('a write in a request goes through to the vault as that request\'s user', async () => {
  const app = await appP
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const res = await app.inject({ method: 'PUT', url: '/api/test/probe', headers: { cookie }, payload: { value: 'key-2' } })
  assert.equal(res.statusCode, 200, res.body)
  const up = broker.callsTo('upsertSecret').at(-1)!
  const adminSid = [...broker.sessions.values()].filter(s => s.email === 'admin@example.com').at(-1)!.sid
  assert.equal(up.args[0], adminSid)
  assert.equal(up.args[1], 'hyperprox:dns/godaddy')
  assert.deepEqual(up.args[2], { api_key: 'key-2', api_secret: 'secret-1' })
  assert.equal(broker.items.get('hyperprox:dns/godaddy')!.fields.api_key, 'key-2')
  const read = await app.inject({ method: 'GET', url: '/api/test/probe', headers: { cookie } })
  assert.equal(read.json().value, 'key-2')
})

test('concurrent writes to one provider keep every key', async () => {
  const app = await appP
  const { res } = await signIn(app, 'owner@example.com', 'owner master password')
  assert.equal(res.statusCode, 200)
  const sid = [...broker.sessions.values()].at(-1)!.sid
  const before = broker.callsTo('upsertSecret').length
  await requestContext.run({ sid, email: 'owner@example.com', role: 'owner' }, () => Promise.all([
    setCredential('proxy', 'npm', 'url', 'http://192.168.1.10:81', false),
    setCredential('proxy', 'npm', 'email', 'admin@example.com', false),
    setCredential('proxy', 'npm', 'password', 'npm-pass', true),
  ]))
  assert.deepEqual(broker.items.get('hyperprox:proxy/npm')!.fields,
    { url: 'http://192.168.1.10:81', email: 'admin@example.com', password: 'npm-pass' })
  assert.equal(process.env.NPM_PASSWORD, 'npm-pass')
  // A vault write takes seconds: writes arriving during one are coalesced into one follow-up.
  assert.equal(broker.callsTo('upsertSecret').length - before, 2)

  await requestContext.run({ sid, email: 'owner@example.com', role: 'owner' }, async () => {
    await deleteCredential('proxy', 'npm', 'password')
  })
  assert.deepEqual(Object.keys(broker.items.get('hyperprox:proxy/npm')!.fields).sort(), ['email', 'url'])
})

test('a failed vault write leaves the cache as it was', async () => {
  const app = await appP
  await signIn(app, 'owner@example.com', 'owner master password')
  broker.failUpsert = true
  try {
    await assert.rejects(setCredential('dns', 'godaddy', 'api_secret', 'never-saved'))
  } finally { broker.failUpsert = false }
  assert.notEqual(await getCredential('dns', 'godaddy', 'api_secret'), 'never-saved')
})

test('lock takes vault values back out of process.env', async () => {
  const app = await appP
  broker.items.set('hyperprox:proxmox/proxmox', { id: 'p1', name: 'hyperprox:proxmox/proxmox', fields: { token_secret: 'pve-secret' } })
  await signIn(app, 'owner@example.com', 'owner master password')
  assert.equal(process.env.PROXMOX_TOKEN_SECRET, 'pve-secret')
  await resetLock()
  assert.equal(process.env.PROXMOX_TOKEN_SECRET, undefined)
})
