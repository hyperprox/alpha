// End to end: the real gate, auth routes and credential store on top of the real
// broker, against a throwaway Vaultwarden over TLS (started the same way as
// test/vault-broker.test.ts). Container `vgtest-gate-vw` on 127.0.0.1:18453, removed
// afterwards (VG_TEST_KEEP=1 keeps it).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const IMAGE = 'vaultwarden/server:1.37.4@sha256:efb3cde962015fcc036b2ea625242248611943b27212ebf4392841fb30fad055'
const NAME = 'vgtest-gate-vw'
const PORT = 18453
const URL_ = `https://127.0.0.1:${PORT}`
const ADMIN_TOKEN = crypto.randomBytes(24).toString('hex')
const tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgtest-gate-tls-'))
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgtest-gate-env-'))
const shmRoot = `/dev/shm/vgtest-gate-${process.pid}`

process.env.VAULT_URL = URL_
process.env.VAULT_CA_CERT = path.join(tlsDir, 'cert.pem')
process.env.VAULT_ADMIN_TOKEN = ADMIN_TOKEN
process.env.VAULT_SESSION_ROOT = shmRoot
delete process.env.VAULT_PUBLIC_URL

import type { FastifyInstance } from 'fastify'
import * as c from '../src/lib/vault/bw-crypto'
import { getBroker } from '../src/lib/vault/broker'
import * as state from '../src/lib/vault/state'
import { vaultRequest } from '../src/lib/vault/http'
import { encrypt } from '../src/lib/crypto'
import { setCredentialTable } from '../src/lib/credentials'
import { allSessions } from '../src/lib/auth'
import { buildTestApp } from './fakes/app'

const OWNER = 'owner@example.com'
const PW = 'correct horse battery staple 42'
let totpSecret = ''
let lastStep = 0

async function nextCode(): Promise<string> {
  for (;;) {
    const now = c.totpStep()
    const step = Math.max(lastStep + 1, now)
    if (step <= now + 1) { lastStep = step; return c.totpCode(totpSecret, step) }
    await new Promise(r => setTimeout(r, 2000))
  }
}

const cookieOf = (res: { headers: Record<string, any> }) => {
  const raw = res.headers['set-cookie']
  return String(Array.isArray(raw) ? raw[0] : raw).split(';')[0]
}

const timings: Record<string, number> = {}
async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now()
  try { return await fn() } finally { timings[label] = Date.now() - t0 }
}

let app: FastifyInstance

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
  let ready = false
  for (let i = 0; i < 60 && !ready; i++) {
    try { ready = (await vaultRequest(`${URL_}/alive`, { ca, timeoutMs: 2000 })).status === 200 } catch { /* starting */ }
    if (!ready) await new Promise(r => setTimeout(r, 1000))
  }
  if (!ready) throw new Error('vault did not become ready')

  app = await buildTestApp()          // real broker
  await state.lock('restart')         // as index.ts does at boot
})

after(async () => {
  await state.lock('manual').catch(() => undefined)
  await app?.close()
  if (!process.env.VG_TEST_KEEP) {
    try { execFileSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' }) } catch { /* gone */ }
  }
  fs.rmSync(tlsDir, { recursive: true, force: true })
  fs.rmSync(workDir, { recursive: true, force: true })
  fs.rmSync(shmRoot, { recursive: true, force: true })
  console.log('# e2e timings (ms):', JSON.stringify(timings))
})

describe('vault gate end to end (real Vaultwarden over TLS)', { timeout: 900_000 }, () => {
  let ownerCookie = ''

  it('locked: data route 423, status answers (not bootstrapped)', async () => {
    const d = await app.inject({ method: 'GET', url: '/api/proxmox/resources' })
    assert.equal(d.statusCode, 423)
    assert.deepEqual(d.json(), { ok: false, locked: true })
    const s = await app.inject({ method: 'GET', url: '/api/auth/status' })
    assert.equal(s.statusCode, 200)
    assert.equal(s.json().locked, true)
    assert.equal(s.json().bootstrapped, false)
    assert.equal(s.json().reachable, true)
  })

  it('bootstrap + confirm with a computed TOTP code → owner session, unlocked', async () => {
    const b = await timed('bootstrap', () => app.inject({ method: 'POST', url: '/api/auth/bootstrap', payload: { email: OWNER, password: PW } }))
    assert.equal(b.statusCode, 200, b.body)
    const uri: string = b.json().otpauthUri
    totpSecret = new URL(uri).searchParams.get('secret')!
    assert.match(totpSecret, /^[A-Z2-7]{32}$/)

    const code = await nextCode()
    const cf = await timed('bootstrap/confirm', () => app.inject({ method: 'POST', url: '/api/auth/bootstrap/confirm', payload: { email: OWNER, password: PW, code } }))
    lastStep = c.totpStep() + 1   // the broker used up to the next step for its own login
    assert.equal(cf.statusCode, 200, cf.body)
    assert.deepEqual(cf.json().user, { email: OWNER, role: 'owner' })
    ownerCookie = cookieOf(cf)
    assert.match(ownerCookie, /^hyperprox_token=.+/)
    assert.equal(state.isUnlocked(), true)
  })

  it('unlocked: data route 200 with the cookie, 401 without', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/api/proxmox/resources', headers: { cookie: ownerCookie } })).statusCode, 200)
    assert.equal((await app.inject({ method: 'GET', url: '/api/proxmox/resources' })).statusCode, 401)
  })

  it('setCredential / getCredential round-trip through the vault', async () => {
    const put = await timed('setCredential', () => app.inject({ method: 'PUT', url: '/api/test/probe', headers: { cookie: ownerCookie }, payload: { value: 'gd-key-e2e' } }))
    assert.equal(put.statusCode, 200, put.body)
    const get = await app.inject({ method: 'GET', url: '/api/test/probe', headers: { cookie: ownerCookie } })
    assert.equal(get.json().value, 'gd-key-e2e')
    // It is really in the vault, as a hidden field of hyperprox:dns/godaddy.
    const listed = await getBroker().listSecrets(allSessions()[0].sid)
    assert.equal(listed.find(i => i.name === 'hyperprox:dns/godaddy')?.fields.api_key, 'gd-key-e2e')
  })

  it('POST /api/auth/lock → 423 again; after re-unlock the old cookie is refused; vault migration runs', async () => {
    const l = await timed('lock', () => app.inject({ method: 'POST', url: '/api/auth/lock', headers: { cookie: ownerCookie }, payload: {} }))
    assert.equal(l.statusCode, 200, l.body)
    assert.equal(state.isUnlocked(), false)
    assert.equal((await app.inject({ method: 'GET', url: '/api/proxmox/resources', headers: { cookie: ownerCookie } })).statusCode, 423)

    // Seed the old store for the migration that runs on this Owner unlock.
    const KEY = 'c'.repeat(64)
    process.env.ENCRYPTION_KEY = KEY
    const envPath = path.join(workDir, '.env')
    fs.writeFileSync(envPath, `PROXMOX_HOST=192.168.1.5\nPROXMOX_TOKEN_SECRET=pve-from-env\nENCRYPTION_KEY=${KEY}\nJWT_SECRET=old\n`)
    process.env.ENV_FILE_PATH = envPath
    process.env.PROXMOX_TOKEN_SECRET = 'pve-from-env'
    let rows = [{ id: 'r1', category: 'proxy', provider: 'npm', key: 'password', value: encrypt('npm-from-db'), updatedAt: new Date() }]
    const deleted: string[] = []
    setCredentialTable({ credential: {
      findMany: async () => rows.map(r => ({ ...r })),
      deleteMany: async ({ where }: any) => { deleted.push(...where.id.in); rows = rows.filter(r => !where.id.in.includes(r.id)); return { count: where.id.in.length } },
    } })

    const code = await nextCode()
    const si = await timed('sign-in (+migration)', () => app.inject({ method: 'POST', url: '/api/auth/sign-in', payload: { email: OWNER, password: PW, code } }))
    assert.equal(si.statusCode, 200, si.body)
    assert.equal(si.json().migration?.ok, true, si.body)
    const fresh = cookieOf(si)

    assert.equal((await app.inject({ method: 'GET', url: '/api/proxmox/resources', headers: { cookie: ownerCookie } })).statusCode, 401, 'old cookie refused')
    assert.equal((await app.inject({ method: 'GET', url: '/api/proxmox/resources', headers: { cookie: fresh } })).statusCode, 200)

    // The earlier write survived the lock: it came back from the vault.
    assert.equal((await app.inject({ method: 'GET', url: '/api/test/probe', headers: { cookie: fresh } })).json().value, 'gd-key-e2e')

    // Migration: row + env value now in the vault (read back from Vaultwarden), row deleted, .env blanked.
    const items = await getBroker().listSecrets(allSessions()[0].sid)
    assert.equal(items.find(i => i.name === 'hyperprox:proxy/npm')?.fields.password, 'npm-from-db')
    assert.equal(items.find(i => i.name === 'hyperprox:proxmox/proxmox')?.fields.token_secret, 'pve-from-env')
    assert.deepEqual(deleted, ['r1'])
    const env = fs.readFileSync(envPath, 'utf8')
    assert.match(env, /^PROXMOX_TOKEN_SECRET=$/m)
    assert.match(env, /^ENCRYPTION_KEY=$/m)
    assert.match(env, /^JWT_SECRET=$/m)
    assert.match(env, /^PROXMOX_HOST=192\.168\.1\.5$/m)
    assert.equal(fs.statSync(envPath + '.pre-vault').mode & 0o777, 0o600)

    const l2 = await app.inject({ method: 'POST', url: '/api/auth/lock', headers: { cookie: fresh }, payload: {} })
    assert.equal(l2.statusCode, 200)
    assert.equal(process.env.PROXMOX_TOKEN_SECRET, undefined, 'secret removed from process.env at lock')
  })
})
