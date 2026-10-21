// Integration tests: broker + unlock state against a real, throwaway Vaultwarden.
//
// Starts `vgtest-broker-vw` (stock image, pinned by digest, TLS with a throwaway
// self-signed certificate, volatile storage, bound to 127.0.0.1) and removes it
// afterwards. Set VG_TEST_KEEP=1 to leave it running for debugging.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const IMAGE = 'vaultwarden/server:1.37.4@sha256:efb3cde962015fcc036b2ea625242248611943b27212ebf4392841fb30fad055'
const NAME = 'vgtest-broker-vw'
const PORT = 18443
const URL_ = `https://127.0.0.1:${PORT}`
const ADMIN_TOKEN = crypto.randomBytes(24).toString('hex')
const tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgtest-broker-tls-'))
const shmRoot = `/dev/shm/vgtest-broker-${process.pid}`

process.env.VAULT_URL = URL_
process.env.VAULT_CA_CERT = path.join(tlsDir, 'cert.pem')
process.env.VAULT_ADMIN_TOKEN = ADMIN_TOKEN
process.env.VAULT_SESSION_ROOT = shmRoot
delete process.env.VAULT_PUBLIC_URL

// Imported after the env is set (config is read lazily anyway).
import * as c from '../src/lib/vault/bw-crypto'
import { VaultAuthError, VaultSessionError, getBroker, type VaultSession } from '../src/lib/vault/broker'
import * as state from '../src/lib/vault/state'
import { vaultRequest } from '../src/lib/vault/http'

const OWNER = 'owner@example.com'
const PW = 'correct horse battery staple 42'
let totpSecret = ''
let lastStep = 0

/** Next TOTP code Vaultwarden will accept: a step later than the last one used, within ±1 of now. */
async function nextCode(): Promise<string> {
  for (;;) {
    const now = c.totpStep()
    const step = Math.max(lastStep + 1, now)
    if (step <= now + 1) { lastStep = step; return c.totpCode(totpSecret, step) }
    await new Promise(r => setTimeout(r, 2000))
  }
}

async function expectAuth(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: any) => {
    assert.ok(e instanceof VaultAuthError, `expected VaultAuthError, got ${e?.name}: ${e?.message}`)
    assert.equal(e.code, code, `message: ${e.message}`)
    return true
  })
}

const dirCount = () => (fs.existsSync(shmRoot) ? fs.readdirSync(shmRoot).length : 0)

before(async () => {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2',
    '-subj', '/CN=hyperprox-vault', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
    '-keyout', path.join(tlsDir, 'key.pem'), '-out', path.join(tlsDir, 'cert.pem')], { stdio: 'ignore' })
  fs.chmodSync(path.join(tlsDir, 'key.pem'), 0o644) // container user must read it; throwaway key
  fs.chmodSync(tlsDir, 0o755)
  try { execFileSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' }) } catch { /* not running */ }
  execFileSync('docker', ['run', '-d', '--name', NAME, '-p', `127.0.0.1:${PORT}:80`,
    '-v', `${tlsDir}:/ssl:ro`,
    '-e', 'ROCKET_TLS={certs="/ssl/cert.pem",key="/ssl/key.pem"}',
    '-e', `ADMIN_TOKEN=${ADMIN_TOKEN}`,
    '-e', 'SIGNUPS_ALLOWED=false', '-e', 'INVITATIONS_ALLOWED=true', '-e', 'ORG_GROUPS_ENABLED=true',
    '-e', 'I_REALLY_WANT_VOLATILE_STORAGE=true', '-e', `DOMAIN=${URL_}`,
    '-e', 'LOGIN_RATELIMIT_MAX_BURST=1000', '-e', 'LOGIN_RATELIMIT_SECONDS=1',
    '-e', 'ADMIN_RATELIMIT_MAX_BURST=1000', '-e', 'ADMIN_RATELIMIT_SECONDS=1',
    IMAGE], { stdio: 'ignore' })
  const ca = fs.readFileSync(path.join(tlsDir, 'cert.pem'))
  for (let i = 0; i < 60; i++) {
    try { if ((await vaultRequest(`${URL_}/alive`, { ca, timeoutMs: 2000 })).status === 200) return } catch { /* starting */ }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error('vault did not become ready')
})

after(async () => {
  await state.lock('manual').catch(() => undefined)
  if (!process.env.VG_TEST_KEEP) {
    try { execFileSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' }) } catch { /* gone */ }
  }
  fs.rmSync(tlsDir, { recursive: true, force: true })
  fs.rmSync(shmRoot, { recursive: true, force: true })
})

describe('vault broker (real Vaultwarden)', { timeout: 600_000 }, () => {
  const broker = getBroker()
  let owner: VaultSession

  it('status: reachable, not bootstrapped', async () => {
    assert.deepEqual(await broker.status(), { reachable: true, bootstrapped: false })
  })

  it('bootstrapOwner registers the owner, creates org + collection, returns a TOTP secret', async () => {
    const r = await broker.bootstrapOwner(OWNER, PW)
    assert.match(r.totpSecret, /^[A-Z2-7]{32}$/)
    assert.ok(r.otpauthUri.startsWith('otpauth://totp/HyperProx%3Aowner%40example.com?secret=' + r.totpSecret))
    totpSecret = r.totpSecret
    // Not bootstrapped until TOTP is confirmed.
    assert.equal((await broker.status()).bootstrapped, false)
  })

  it('bootstrap can be resumed (same email, same password) and refuses a wrong password', async () => {
    await expectAuth(broker.bootstrapOwner(OWNER, 'not the password at all'), 'bad_credentials')
    const r = await broker.bootstrapOwner(OWNER, PW)
    totpSecret = r.totpSecret
  })

  it('bootstrap creates read/write (operators) and read-only (viewers) groups on the collection', async () => {
    const ca = fs.readFileSync(process.env.VAULT_CA_CERT!)
    const api = new c.VaultwardenApi(URL_, ca)
    const mk = await c.makeMasterKey(PW, OWNER)
    const tok = await api.passwordLogin(OWNER, await c.masterPasswordHash(mk, PW)) // no 2FA yet
    const admin = new c.VaultwardenAdmin(URL_, ADMIN_TOKEN, ca)
    const orgId = (await admin.userByEmail(OWNER)).organizations.find((o: any) => o.name === 'HyperProx').id
    const groups = (await api.api('GET', `/api/organizations/${orgId}/groups/details`, tok.accessToken)).data as any[]
    const byName = Object.fromEntries(groups.map(g => [g.name, g]))
    assert.deepEqual(Object.keys(byName).sort(), [c.GROUP_OPERATORS, c.GROUP_VIEWERS])
    assert.equal(byName[c.GROUP_OPERATORS].collections.length, 1)
    assert.equal(byName[c.GROUP_OPERATORS].collections[0].readOnly, false)
    assert.equal(byName[c.GROUP_VIEWERS].collections[0].readOnly, true)
  })

  it('confirmOwnerTotp rejects a wrong code, then enables TOTP and returns an owner session', async () => {
    const good = c.totpCode(totpSecret, c.totpStep())
    const wrong = good === '123456' ? '654321' : '123456'
    await expectAuth(broker.confirmOwnerTotp(OWNER, PW, wrong), 'totp_invalid')
    const code = await nextCode()
    const s = await broker.confirmOwnerTotp(OWNER, PW, code)
    lastStep = c.totpStep() + 1 // the broker spent up to the next step on its own CLI login
    assert.equal(s.role, 'owner')
    assert.equal(s.email, OWNER)
    assert.match(s.sid, /^[a-f0-9]{32}$/)
    assert.equal((await broker.status()).bootstrapped, true)
    await broker.signOut(s.sid)
  })

  it('bootstrapOwner refuses once bootstrapped', async () => {
    await assert.rejects(broker.bootstrapOwner('other@example.com', 'another long password'), /already has a HyperProx owner/)
  })

  it('signIn: wrong password → bad_credentials', async () => {
    await expectAuth(broker.signIn(OWNER, 'wrong password 123456', c.totpCode(totpSecret)), 'bad_credentials')
  })

  it('signIn: missing TOTP → totp_required', async () => {
    await expectAuth(broker.signIn(OWNER, PW, ''), 'totp_required')
  })

  it('signIn: wrong TOTP → totp_invalid', async () => {
    const now = c.totpStep()
    const valid = new Set([now - 1, now, now + 1].map(s => c.totpCode(totpSecret, s)))
    let wrong = '000000'
    while (valid.has(wrong)) wrong = String(Number(wrong) + 1).padStart(6, '0')
    await expectAuth(broker.signIn(OWNER, PW, wrong), 'totp_invalid')
  })

  it('signIn with a computed TOTP code → role owner, no session dirs leaked by failures', async () => {
    owner = await broker.signIn(OWNER, PW, await nextCode())
    assert.equal(owner.role, 'owner')
    assert.ok(owner.userId)
    assert.equal(dirCount(), 1)
    assert.equal((fs.statSync(path.join(shmRoot, owner.sid)).mode & 0o777), 0o700)
  })

  it('signIn: a vault user outside the HyperProx organization → not_member', async () => {
    const api = new c.VaultwardenApi(URL_, fs.readFileSync(process.env.VAULT_CA_CERT!))
    const admin = new c.VaultwardenAdmin(URL_, ADMIN_TOKEN, fs.readFileSync(process.env.VAULT_CA_CERT!))
    await admin.invite('outsider@example.com')
    await c.registerAccount(api, 'outsider@example.com', 'outsider password 123')
    await expectAuth(broker.signIn('outsider@example.com', 'outsider password 123', ''), 'not_member')
    assert.equal(dirCount(), 1)
  })

  it('verifyPassword: true for the master password, false otherwise', async () => {
    assert.equal(await broker.verifyPassword(owner.sid, PW), true)
    assert.equal(await broker.verifyPassword(owner.sid, 'nope nope nope'), false)
    // Session still usable after re-confirmation.
    assert.ok(Array.isArray(await broker.listSecrets(owner.sid)))
  })

  it('upsert / list / update / delete round-trip in the HyperProx collection', async () => {
    const created = await broker.upsertSecret(owner.sid, 'hyperprox:dns/example', { api_key: 'k-1', api_secret: 's-1' }, 'test item')
    assert.equal(created.name, 'hyperprox:dns/example')
    assert.deepEqual(created.fields, { api_key: 'k-1', api_secret: 's-1' })
    let list = await broker.listSecrets(owner.sid)
    assert.equal(list.filter(i => i.name === 'hyperprox:dns/example').length, 1)

    const updated = await broker.upsertSecret(owner.sid, 'hyperprox:dns/example', { api_key: 'k-2', api_secret: 's-2' })
    assert.equal(updated.id, created.id)
    list = await broker.listSecrets(owner.sid)
    const got = list.find(i => i.name === 'hyperprox:dns/example')!
    assert.deepEqual(got.fields, { api_key: 'k-2', api_secret: 's-2' })
    assert.equal(got.notes, 'test item')
    assert.ok(got.revisionDate && !Number.isNaN(Date.parse(got.revisionDate)))

    await broker.upsertSecret(owner.sid, 'hyperprox:proxy/npm', { password: 'p-1' })
    await broker.deleteSecret(owner.sid, 'hyperprox:dns/example')
    list = await broker.listSecrets(owner.sid)
    assert.equal(list.find(i => i.name === 'hyperprox:dns/example'), undefined)
    assert.ok(list.find(i => i.name === 'hyperprox:proxy/npm'))
  })

  it('createSend returns a Send URL (optionally on the public origin)', async () => {
    const r = await broker.createSend(owner.sid, 'one-time secret', { hours: 2, maxViews: 1, password: 'send pw' })
    assert.match(r.url, new RegExp(`^${URL_.replace(/\./g, '\\.')}/#/send/[^/]+/[^/]+$`))
    const exp = Date.parse(r.expiresAt)
    assert.ok(exp > Date.now() + 3600_000 && exp < Date.now() + 3 * 3600_000)
    process.env.VAULT_PUBLIC_URL = 'https://vault.example.com'
    try {
      const r2 = await broker.createSend(owner.sid, 'another')
      assert.match(r2.url, /^https:\/\/vault\.example\.com\/#\/send\/[^/]+\/[^/]+$/)
    } finally { delete process.env.VAULT_PUBLIC_URL }
  })

  it('unlock loads the cache and a signing key; lock wipes cache, key and session dirs', async () => {
    const reasons: string[] = []
    state.onLock(r => reasons.push(r))
    assert.equal(state.isUnlocked(), false)
    assert.equal(state.signingKey(), null)
    await state.unlock(owner.sid)
    assert.equal(state.isUnlocked(), true)
    const k1 = Buffer.from(state.signingKey()!)
    assert.equal(k1.length, 32)
    assert.deepEqual(state.cachedSecret('hyperprox:proxy/npm')?.fields, { password: 'p-1' })
    state.putCachedSecret({ id: 'x', name: 'local/only', fields: { a: 'b' } })
    assert.equal(state.cachedSecret('local/only')?.fields.a, 'b')
    await state.unlock(owner.sid) // idempotent: no key rotation while unlocked
    assert.deepEqual(state.signingKey(), k1)

    const keyRef = state.signingKey()!
    await state.lock('manual')
    assert.equal(state.isUnlocked(), false)
    assert.equal(state.signingKey(), null)
    assert.ok(keyRef.every(b => b === 0), 'old key buffer is zeroed')
    assert.equal(state.cachedSecret('hyperprox:proxy/npm'), undefined)
    assert.equal(dirCount(), 0)
    await assert.rejects(broker.listSecrets(owner.sid), VaultSessionError)
    assert.deepEqual(reasons, ['manual'])

    // A fresh unlock gets a different key.
    const s2 = await broker.signIn(OWNER, PW, await nextCode())
    await state.unlock(s2.sid)
    assert.notDeepEqual(state.signingKey(), k1)
    await state.lock('manual')
  })

  it('idle timer locks after VAULT_IDLE_LOCK_MINUTES without touch()', async () => {
    const s3 = await broker.signIn(OWNER, PW, await nextCode())
    process.env.VAULT_IDLE_LOCK_MINUTES = String(4 / 60) // 4 s
    const reasons: string[] = []
    state.onLock(r => reasons.push(r))
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
    try {
      await state.unlock(s3.sid)
      const t0 = Date.now()
      await sleep(2500)
      assert.equal(state.isUnlocked(), true, `still unlocked before the timeout (${Date.now() - t0} ms)`)
      state.touch() // resets the timer
      await sleep(2500)
      assert.equal(state.isUnlocked(), true, `touch() kept it unlocked (${Date.now() - t0} ms)`)
      await sleep(3000)
      assert.equal(state.isUnlocked(), false)
      assert.equal(state.signingKey(), null)
      assert.ok(reasons.includes('idle'))
      // lock runs async after the timer; give signOutAll a moment
      for (let i = 0; i < 80 && dirCount() > 0; i++) await new Promise(r => setTimeout(r, 250))
      assert.equal(dirCount(), 0)
    } finally { delete process.env.VAULT_IDLE_LOCK_MINUTES }
  })
})
