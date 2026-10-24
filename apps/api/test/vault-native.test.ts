// Fast-path sign-in and item flow against a fake Vaultwarden (plain HTTP on 127.0.0.1),
// plus the broker's choice between the fast path and the CLI. No container needed.
//
// The fake keeps its data encrypted the way a real vault does (user key wrapped by
// the stretched master key, org key RSA-wrapped to the member, one item with its own
// cipher key), so the test checks the decryption chain, not just the HTTP calls.
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

import * as c from '../src/lib/vault/bw-crypto'
import { FastPathFailed, FastPathUnavailable, NativeSessionExpired, NativeVaultSession, NotMemberError } from '../src/lib/vault/native'

const EMAIL = 'member@example.com'
const PW = 'fake vault master password'
const TOTP = '123456'
const ITER = 5000 // the lowest Bitwarden allows; keeps the test fast
const USER_ID = 'u-1'
const ORG_ID = 'org-1'
const COL_ID = 'col-1'

// ---- the fake vault --------------------------------------------------------

interface Fake {
  kdf: number
  twoFactor: boolean
  memberType: number
  member: boolean
  corruptOrgKey: boolean
  expireNextAccess: boolean
  refreshFails: boolean
  requests: string[]
  ciphers: any[]
  sends: any[]
  accessToken: string
  refreshToken: string
}

let fake: Fake
let server: http.Server
let base = ''
let userKeyRaw: Buffer, userKey: c.SymKey, orgKeyRaw: Buffer, orgKey: c.SymKey, rsa: c.RsaKeyPair

const encStr = (v: string, k: c.SymKey) => c.encString2(Buffer.from(v, 'utf8'), k)

function cipher(id: string, name: string, fields: Record<string, string>, opts: { key?: Buffer; collection?: string; org?: string; deleted?: boolean; login?: boolean } = {}) {
  const k = opts.key ? c.symKeyFromBytes(opts.key) : orgKey
  return {
    id, type: opts.login ? 1 : 2, organizationId: opts.org ?? ORG_ID, folderId: null, favorite: false, reprompt: 0,
    key: opts.key ? c.encString2(opts.key, orgKey) : null,
    name: encStr(name, k), notes: encStr(`${name} notes`, k),
    login: opts.login ? { username: encStr('admin', k), password: encStr('pw', k), uris: null } : null,
    secureNote: opts.login ? null : { type: 0 },
    fields: Object.entries(fields).map(([n, v]) => ({ name: encStr(n, k), value: encStr(v, k), type: 1, linkedId: null })),
    collectionIds: [opts.collection ?? COL_ID],
    deletedDate: opts.deleted ? '2026-01-01T00:00:00Z' : null,
    revisionDate: '2026-01-01T00:00:00Z',
  }
}

function resetFake(): void {
  fake = {
    kdf: c.KDF_PBKDF2, twoFactor: true, memberType: c.MEMBER_TYPE.Admin, member: true, corruptOrgKey: false,
    expireNextAccess: false, refreshFails: false, requests: [], sends: [],
    accessToken: 'at-1', refreshToken: 'rt-1',
    ciphers: [
      cipher('c-plain', 'hyperprox:dns/example', { api_key: 'k-1' }),
      cipher('c-keyed', 'hyperprox:proxy/npm', { password: 'p-1' }, { key: crypto.randomBytes(64) }),
      cipher('c-login', 'legacy/login', {}, { login: true }),
      cipher('c-trash', 'hyperprox:old', { x: 'y' }, { deleted: true }),
      cipher('c-other-col', 'elsewhere', { x: 'y' }, { collection: 'col-2' }),
      cipher('c-other-org', 'personal', { x: 'y' }, { org: 'org-2' }),
    ],
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

async function handle(req: http.IncomingMessage, body: string, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', base)
  fake.requests.push(`${req.method} ${url.pathname}`)
  if (url.pathname === '/identity/accounts/prelogin') return send(res, 200, { kdf: fake.kdf, kdfIterations: fake.kdf === 0 ? ITER : 3, kdfMemory: 64, kdfParallelism: 4 })

  if (url.pathname === '/identity/connect/token') {
    const f = new URLSearchParams(body)
    if (f.get('grant_type') === 'refresh_token') {
      if (fake.refreshFails || f.get('refresh_token') !== fake.refreshToken) return send(res, 400, { error: 'invalid_grant' })
      fake.accessToken = `at-${fake.requests.length}`
      return send(res, 200, { access_token: fake.accessToken, expires_in: 7200, refresh_token: fake.refreshToken })
    }
    const user = String(f.get('username'))
    const mk = await c.makeMasterKeyFor(PW, user, { kdf: 0, iterations: ITER })
    if (f.get('password') !== await c.masterPasswordHash(mk, PW)) return send(res, 400, { error: 'invalid_grant', error_description: 'invalid_username_or_password', ErrorModel: { Message: 'Username or password is incorrect. Try again' } })
    if (fake.twoFactor && !f.get('two_factor_token')) return send(res, 400, { error: 'invalid_grant', error_description: 'Two factor required.', TwoFactorProviders: ['0'], TwoFactorProviders2: { 0: null } })
    if (fake.twoFactor && f.get('two_factor_token') !== TOTP) return send(res, 400, { error: 'invalid_grant', ErrorModel: { Message: 'Invalid TOTP code! Server time: now' } })
    const stretched = c.stretchMasterKey(mk)
    return send(res, 200, {
      access_token: fake.accessToken, expires_in: 7200, refresh_token: fake.refreshToken,
      Key: c.encString2(userKeyRaw, stretched), PrivateKey: c.encString2(rsa.privateDer, userKey),
    })
  }

  const auth = req.headers.authorization
  if (auth !== `Bearer ${fake.accessToken}` || fake.expireNextAccess) {
    fake.expireNextAccess = false
    return send(res, 401, { message: 'Unauthorized' })
  }

  if (url.pathname === '/api/sync') {
    const orgKeyWrapped = fake.corruptOrgKey ? '4.' + crypto.randomBytes(256).toString('base64') : c.encString4(orgKeyRaw, rsa.publicDer)
    return send(res, 200, {
      profile: {
        id: USER_ID, email: EMAIL,
        organizations: fake.member ? [{ id: ORG_ID, name: 'HyperProx', type: fake.memberType, enabled: true, key: orgKeyWrapped }] : [],
      },
      collections: [
        { id: 'col-2', organizationId: ORG_ID, name: encStr('Other', orgKey) },
        { id: COL_ID, organizationId: ORG_ID, name: encStr('HyperProx', orgKey) },
      ],
      ciphers: fake.ciphers,
    })
  }

  const j = body ? JSON.parse(body) : {}
  if (req.method === 'POST' && url.pathname === '/api/ciphers/create') {
    const ci = { ...j.cipher, id: `c-new-${fake.ciphers.length}`, collectionIds: j.collectionIds, deletedDate: null, revisionDate: new Date().toISOString() }
    fake.ciphers.push(ci)
    return send(res, 200, ci)
  }
  const put = /^\/api\/ciphers\/([^/]+)(\/delete)?$/.exec(url.pathname)
  if (req.method === 'PUT' && put) {
    const i = fake.ciphers.findIndex(x => x.id === put[1])
    if (i < 0) return send(res, 404, { message: 'not found' })
    if (put[2]) { fake.ciphers[i].deletedDate = new Date().toISOString(); return send(res, 200, {}) }
    fake.ciphers[i] = { ...fake.ciphers[i], ...j, revisionDate: new Date().toISOString() }
    return send(res, 200, fake.ciphers[i])
  }
  if (req.method === 'POST' && url.pathname === '/api/sends') {
    fake.sends.push(j)
    return send(res, 200, { ...j, id: 's-1', accessId: 'acc-1' })
  }
  return send(res, 404, { message: `no route ${req.method} ${url.pathname}` })
}

const api = () => new c.VaultwardenApi(base)

before(async () => {
  userKeyRaw = crypto.randomBytes(64); userKey = c.symKeyFromBytes(userKeyRaw)
  orgKeyRaw = crypto.randomBytes(64); orgKey = c.symKeyFromBytes(orgKeyRaw)
  rsa = c.generateRsaKeyPair()
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', d => chunks.push(d))
    req.on('end', () => { handle(req, Buffer.concat(chunks).toString('utf8'), res).catch(e => send(res, 500, { message: String(e) })) })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(() => { server.close() })
beforeEach(() => resetFake())

const byName = (items: Array<{ name: string }>) => Object.fromEntries(items.map(i => [i.name, i])) as Record<string, any>

// ---- NativeVaultSession ------------------------------------------------------

describe('fast path against a fake vault', () => {
  it('signs in with password + TOTP and lists only live items of the HyperProx collection', async () => {
    const s = await NativeVaultSession.open(api(), EMAIL, PW, TOTP)
    assert.equal(s.userId, USER_ID)
    assert.equal(s.orgId, ORG_ID)
    assert.equal(s.collectionId, COL_ID)
    assert.equal(s.memberType, c.MEMBER_TYPE.Admin)
    const items = byName(await s.listItems())
    assert.deepEqual(Object.keys(items).sort(), ['hyperprox:dns/example', 'hyperprox:proxy/npm', 'legacy/login'])
    assert.deepEqual(items['hyperprox:dns/example'].fields, [{ name: 'api_key', value: 'k-1' }])
    assert.deepEqual(items['hyperprox:proxy/npm'].fields, [{ name: 'password', value: 'p-1' }], 'item with its own cipher key')
    assert.deepEqual(items['legacy/login'].login, { username: 'admin', password: 'pw' })
    // Sign-in synced; the listing right after it reuses that sync.
    assert.deepEqual(fake.requests, ['POST /identity/accounts/prelogin', 'POST /identity/connect/token', 'GET /api/sync'])
    s.close()
  })

  it('maps the vault\'s answers: no code → 2FA required, wrong code, wrong password', async () => {
    await assert.rejects(NativeVaultSession.open(api(), EMAIL, PW, ''), (e: any) => e instanceof c.VaultHttpError && !!e.body?.TwoFactorProviders)
    await assert.rejects(NativeVaultSession.open(api(), EMAIL, PW, '000000'), (e: any) => e instanceof c.VaultHttpError && /Invalid TOTP/.test(e.message))
    await assert.rejects(NativeVaultSession.open(api(), EMAIL, 'wrong', TOTP), (e: any) => e instanceof c.VaultHttpError && /incorrect/.test(e.message))
  })

  it('an Argon2id account is FastPathUnavailable before any credential is sent', async () => {
    fake.kdf = c.KDF_ARGON2ID
    await assert.rejects(NativeVaultSession.open(api(), EMAIL, PW, TOTP), FastPathUnavailable)
    assert.deepEqual(fake.requests, ['POST /identity/accounts/prelogin'])
  })

  it('an unreachable vault is FastPathUnavailable', async () => {
    await assert.rejects(NativeVaultSession.open(new c.VaultwardenApi('http://127.0.0.1:1'), EMAIL, PW, TOTP), FastPathUnavailable)
  })

  it('not in the organization → NotMemberError; unreadable org key → FastPathFailed', async () => {
    fake.member = false
    await assert.rejects(NativeVaultSession.open(api(), EMAIL, PW, TOTP), NotMemberError)
    fake.member = true
    fake.corruptOrgKey = true
    await assert.rejects(NativeVaultSession.open(api(), EMAIL, PW, TOTP), FastPathFailed)
  })

  it('verifyPassword is local and exact', async () => {
    const s = await NativeVaultSession.open(api(), EMAIL, PW, TOTP)
    const n = fake.requests.length
    assert.equal(await s.verifyPassword(PW), true)
    assert.equal(await s.verifyPassword(PW + ' '), false)
    assert.equal(fake.requests.length, n, 'no server call')
    s.close()
    assert.equal(await s.verifyPassword(PW), false)
  })

  it('upsert: creates a new item, edits keep name/notes/key and re-encrypt fields with the item\'s own key', async () => {
    const s = await NativeVaultSession.open(api(), EMAIL, PW, TOTP)
    const keyedBefore = fake.ciphers.find(x => x.id === 'c-keyed')
    const [edited, created] = await s.upsertItems([
      { name: 'hyperprox:proxy/npm', fields: { password: 'p-2', user: 'u' } },
      { name: 'hyperprox:new', fields: { a: '1' }, notes: 'fresh' },
    ])
    assert.equal(edited.id, 'c-keyed')
    assert.deepEqual(edited.fields, [{ name: 'password', value: 'p-2' }, { name: 'user', value: 'u' }])
    assert.equal(edited.notes, 'hyperprox:proxy/npm notes', 'notes unchanged when not given')
    const keyedAfter = fake.ciphers.find(x => x.id === 'c-keyed')
    assert.equal(keyedAfter.key, keyedBefore.key)
    assert.equal(keyedAfter.name, keyedBefore.name)
    assert.equal(keyedAfter.encryptedFor, USER_ID)
    // The field is encrypted with the item key, so the org key alone cannot open it.
    assert.throws(() => c.decString2(keyedAfter.fields[0].value, orgKey), /MAC/)

    assert.equal(created.name, 'hyperprox:new')
    assert.equal(created.notes, 'fresh')
    const raw = fake.ciphers.find(x => x.id === created.id)
    assert.equal(raw.type, 2)
    assert.equal(raw.organizationId, ORG_ID)
    assert.equal(raw.encryptedFor, USER_ID)
    assert.deepEqual(raw.collectionIds, [COL_ID])
    assert.equal(raw.fields[0].type, 1)
    // After a write the next listing goes back to the server.
    const n = fake.requests.length
    assert.ok(byName(await s.listItems())['hyperprox:new'])
    assert.equal(fake.requests[n], 'GET /api/sync')
    s.close()
  })

  it('delete moves every same-named item to the trash', async () => {
    fake.ciphers.push(cipher('c-dup', 'hyperprox:dns/example', { api_key: 'dup' }))
    const s = await NativeVaultSession.open(api(), EMAIL, PW, TOTP)
    await s.deleteItems('hyperprox:dns/example')
    assert.ok(fake.requests.includes('PUT /api/ciphers/c-plain/delete'))
    assert.ok(fake.requests.includes('PUT /api/ciphers/c-dup/delete'))
    assert.equal(byName(await s.listItems())['hyperprox:dns/example'], undefined)
    s.close()
  })

  it('a text Send carries a seed wrapped by the user key, text under the derived key, and the password hash', async () => {
    const s = await NativeVaultSession.open(api(), EMAIL, PW, TOTP)
    const expires = new Date(Date.now() + 3600_000).toISOString()
    const r = await s.createTextSend('the secret', { expires, maxViews: 2, password: 'send pw' })
    assert.equal(r.accessId, 'acc-1')
    const body = fake.sends[0]
    const seed = c.decString2(body.key, userKey)
    assert.equal(seed.length, 16)
    assert.equal(r.keyFragment, c.base64Url(seed))
    const k = c.sendKeyFromSeed(seed)
    assert.equal(c.decString2(body.text.text, k).toString(), 'the secret')
    assert.equal(c.decString2(body.name, k).toString(), 'HyperProx')
    assert.equal(body.password, await c.sendPasswordHash('send pw', seed))
    assert.equal(body.maxAccessCount, 2)
    assert.equal(body.deletionDate, expires)
    s.close()
  })

  it('a 401 refreshes the token once and retries; a refused refresh is NativeSessionExpired', async () => {
    const s = await NativeVaultSession.open(api(), EMAIL, PW, TOTP)
    fake.expireNextAccess = true
    const n = fake.requests.length
    await s.deleteItems('no such item') // always re-syncs
    assert.deepEqual(fake.requests.slice(n), ['GET /api/sync', 'POST /identity/connect/token', 'GET /api/sync'])
    fake.expireNextAccess = true
    fake.refreshFails = true
    await assert.rejects(s.deleteItems('no such item'), NativeSessionExpired)
    s.close()
    await assert.rejects(s.listItems(), NativeSessionExpired)
  })
})

// ---- broker: fast path first, CLI fallback -----------------------------------

describe('broker path choice', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'abtest-vault-native-'))
  const cliLog = path.join(tmp, 'cli.log')
  const logged: string[] = []
  let broker: typeof import('../src/lib/vault/broker')

  before(async () => {
    // A stand-in `bw` that records its subcommands and answers a minimal sign-in.
    const stub = path.join(tmp, 'bw')
    fs.writeFileSync(stub, `#!/usr/bin/env node
const fs = require('fs'); const a = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(cliLog)}, a[0] + ' ' + (a[1] || '') + '\\n')
if (a[0] === 'login') { fs.writeFileSync(process.env.BITWARDENCLI_APPDATA_DIR + '/data.json', JSON.stringify({ global_account_activeAccountId: 'cli-user' })); process.stdout.write('SESSIONKEY') }
else if (a[0] === 'list' && a[1] === 'organizations') process.stdout.write(JSON.stringify([{ id: 'org-1', name: 'HyperProx', type: 1, enabled: true }]))
else if (a[0] === 'list') process.stdout.write('[]')
`, { mode: 0o755 })
    process.env.BW_CLI_PATH = stub
    process.env.VAULT_URL = base
    process.env.VAULT_SESSION_ROOT = path.join(tmp, 'sessions')
    delete process.env.VAULT_ADMIN_TOKEN
    delete process.env.VAULT_CA_CERT
    broker = await import('../src/lib/vault/broker')
    broker.setVaultLogger({ info: m => logged.push(m), warn: m => logged.push(m) })
  })
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  const cliCalls = () => (fs.existsSync(cliLog) ? fs.readFileSync(cliLog, 'utf8').trim().split('\n').filter(Boolean) : [])
  beforeEach(() => { fs.rmSync(cliLog, { force: true }); logged.length = 0 })

  it('signs in via the fast path and never starts the CLI', async () => {
    const s = await broker.getBroker().signIn(EMAIL, PW, TOTP)
    assert.equal(s.role, 'admin')
    assert.equal(s.userId, USER_ID)
    assert.deepEqual(cliCalls(), [])
    assert.ok(logged.some(m => /via fast path/.test(m)))
    assert.deepEqual((await broker.getBroker().listSecrets(s.sid)).map(i => i.name).sort(), ['hyperprox:dns/example', 'hyperprox:proxy/npm', 'legacy/login'])
    assert.equal(await broker.getBroker().verifyPassword(s.sid, PW), true)
    await broker.getBroker().signOut(s.sid)
    await assert.rejects(broker.getBroker().listSecrets(s.sid), broker.VaultSessionError)
  })

  it('auth failures come back as contract codes and do not fall back', async () => {
    const b = broker.getBroker()
    await assert.rejects(b.signIn(EMAIL, 'wrong', TOTP), (e: any) => e.code === 'bad_credentials')
    await assert.rejects(b.signIn(EMAIL, PW, ''), (e: any) => e.code === 'totp_required')
    await assert.rejects(b.signIn(EMAIL, PW, '000000'), (e: any) => e.code === 'totp_invalid')
    fake.member = false
    await assert.rejects(b.signIn(EMAIL, PW, TOTP), (e: any) => e.code === 'not_member')
    assert.deepEqual(cliCalls(), [])
  })

  it('an Argon2id account signs in through the CLI, and says so', async () => {
    fake.kdf = c.KDF_ARGON2ID
    const s = await broker.getBroker().signIn(EMAIL, PW, TOTP)
    assert.equal(s.userId, 'cli-user')
    assert.deepEqual(cliCalls().map(l => l.split(' ')[0]).slice(0, 2), ['config', 'login'])
    assert.ok(logged.some(m => /fast sign-in not possible .*KDF type 1/.test(m)))
    assert.ok(logged.some(m => /via CLI/.test(m)))
    await broker.getBroker().signOut(s.sid)
  })

  it('VAULT_FAST_SIGNIN=0 forces the CLI', async () => {
    process.env.VAULT_FAST_SIGNIN = '0'
    try {
      const s = await broker.getBroker().signIn(EMAIL, PW, TOTP)
      assert.equal(s.userId, 'cli-user')
      assert.equal(fake.requests.length, 0)
      await broker.getBroker().signOut(s.sid)
    } finally { delete process.env.VAULT_FAST_SIGNIN }
  })

  it('a failure after the vault accepted a TOTP code asks for the next code, then uses the CLI for that account', async () => {
    fake.corruptOrgKey = true
    await assert.rejects(broker.getBroker().signIn(EMAIL, PW, TOTP), (e: any) => e.code === 'totp_invalid')
    assert.deepEqual(cliCalls(), [])
    const s = await broker.getBroker().signIn(EMAIL, PW, TOTP)
    assert.equal(s.userId, 'cli-user')
    await broker.getBroker().signOut(s.sid)
  })

  it('without a TOTP code the same failure falls straight back to the CLI', async () => {
    fake.corruptOrgKey = true
    fake.twoFactor = false
    const s = await broker.getBroker().signIn('other@example.com', PW, '')
    assert.equal(s.userId, 'cli-user')
    await broker.getBroker().signOut(s.sid)
  })
})
