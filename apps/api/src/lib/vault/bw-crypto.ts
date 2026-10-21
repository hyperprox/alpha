// =============================================================================
//  HyperProx — Bitwarden client crypto + Vaultwarden owner bootstrap
//
//  The Bitwarden CLI cannot register an account, create an organization or
//  enrol TOTP, so those few calls are made here, directly against the
//  Vaultwarden API, with Bitwarden's client-side cryptography re-implemented on
//  Node's `crypto` module only (no third-party crypto):
//
//    master key       PBKDF2-SHA256(password, salt = lowercased email, 600000)
//    password hash    base64(PBKDF2-SHA256(masterKey, password, 1))   (sent to server)
//    stretched key    HKDF-Expand-SHA256(masterKey, "enc"|"mac", 32)
//    EncString 2      "2.<iv>|<ct>|<mac>"  AES-256-CBC + HMAC-SHA256(iv || ct)
//    EncString 4      "4.<ct>"             RSA-2048 OAEP-SHA1
//
//  API shapes verified against Vaultwarden 1.37.4 source
//  (src/api/admin.rs, src/api/identity.rs, src/api/core/accounts.rs,
//   src/api/core/organizations.rs, src/api/core/two_factor/authenticator.rs).
//
//  Nothing here logs or persists a password, a master key, a user key or an
//  access token. Key material lives in local variables for one call only.
// =============================================================================

import crypto from 'node:crypto'
import { promisify } from 'node:util'
import { vaultRequest } from './http'

const pbkdf2 = promisify(crypto.pbkdf2)

export const KDF_PBKDF2 = 0
export const KDF_ITERATIONS = 600_000
export const ORG_NAME = 'HyperProx'
export const COLLECTION_NAME = 'HyperProx'

/** Bitwarden membership types (organization user type). */
export const MEMBER_TYPE = { Owner: 0, Admin: 1, User: 2, Manager: 3, Custom: 4 } as const

// ---------------------------------------------------------------------------
//  Primitives
// ---------------------------------------------------------------------------

export interface SymKey { enc: Buffer; mac: Buffer }

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export async function makeMasterKey(password: string, email: string): Promise<Buffer> {
  return pbkdf2(Buffer.from(password, 'utf8'), Buffer.from(normalizeEmail(email), 'utf8'), KDF_ITERATIONS, 32, 'sha256')
}

/** The value the server sees instead of the password: base64(PBKDF2(masterKey, password, 1)). */
export async function masterPasswordHash(masterKey: Buffer, password: string): Promise<string> {
  const h = await pbkdf2(masterKey, Buffer.from(password, 'utf8'), 1, 32, 'sha256')
  return h.toString('base64')
}

/** HKDF-Expand only (RFC 5869 step 2) — Bitwarden uses the master key directly as the PRK. */
export function hkdfExpand(prk: Buffer, info: string, length: number): Buffer {
  const out: Buffer[] = []
  let prev = Buffer.alloc(0)
  let total = 0
  for (let i = 1; total < length; i++) {
    prev = crypto.createHmac('sha256', prk).update(Buffer.concat([prev, Buffer.from(info, 'utf8'), Buffer.from([i])])).digest()
    out.push(prev)
    total += prev.length
  }
  return Buffer.concat(out).subarray(0, length)
}

export function stretchMasterKey(masterKey: Buffer): SymKey {
  return { enc: hkdfExpand(masterKey, 'enc', 32), mac: hkdfExpand(masterKey, 'mac', 32) }
}

/** A 64-byte Bitwarden symmetric key (user key or organization key): 32 enc || 32 mac. */
export function symKeyFromBytes(raw: Buffer): SymKey {
  if (raw.length !== 64) throw new Error('symmetric key must be 64 bytes')
  return { enc: Buffer.from(raw.subarray(0, 32)), mac: Buffer.from(raw.subarray(32, 64)) }
}

export function encString2(data: Buffer, key: SymKey): string {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-cbc', key.enc, iv)
  const ct = Buffer.concat([cipher.update(data), cipher.final()])
  const mac = crypto.createHmac('sha256', key.mac).update(Buffer.concat([iv, ct])).digest()
  return `2.${iv.toString('base64')}|${ct.toString('base64')}|${mac.toString('base64')}`
}

export function decString2(enc: string, key: SymKey): Buffer {
  const m = /^2\.([^|]+)\|([^|]+)\|([^|]+)$/.exec(enc)
  if (!m) throw new Error('not an EncString type 2')
  const iv = Buffer.from(m[1], 'base64')
  const ct = Buffer.from(m[2], 'base64')
  const mac = Buffer.from(m[3], 'base64')
  const want = crypto.createHmac('sha256', key.mac).update(Buffer.concat([iv, ct])).digest()
  if (mac.length !== want.length || !crypto.timingSafeEqual(mac, want)) throw new Error('EncString MAC mismatch')
  const d = crypto.createDecipheriv('aes-256-cbc', key.enc, iv)
  return Buffer.concat([d.update(ct), d.final()])
}

export interface RsaKeyPair { publicDer: Buffer; privateDer: Buffer }

export function generateRsaKeyPair(): RsaKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicExponent: 0x10001,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  })
  return { publicDer: publicKey, privateDer: privateKey }
}

export function encString4(data: Buffer, publicDer: Buffer): string {
  const key = crypto.createPublicKey({ key: publicDer, format: 'der', type: 'spki' })
  const ct = crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, data)
  return `4.${ct.toString('base64')}`
}

export function decString4(enc: string, privateDer: Buffer): Buffer {
  const m = /^4\.(.+)$/.exec(enc)
  if (!m) throw new Error('not an EncString type 4')
  const key = crypto.createPrivateKey({ key: privateDer, format: 'der', type: 'pkcs8' })
  return crypto.privateDecrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, Buffer.from(m[1], 'base64'))
}

// ---------------------------------------------------------------------------
//  TOTP (RFC 6238, SHA-1, 6 digits, 30 s) — what Vaultwarden's authenticator uses
// ---------------------------------------------------------------------------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5 }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '')
  let bits = 0, value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = B32.indexOf(ch)
    if (idx < 0) throw new Error('invalid base32')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8 }
  }
  return Buffer.from(out)
}

/** A new 20-byte authenticator secret, base32 (32 chars, no padding) — the length Vaultwarden requires. */
export function newTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20))
}

export function totpStep(atMs = Date.now()): number {
  return Math.floor(atMs / 1000 / 30)
}

export function totpCode(secret: string, step = totpStep()): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest()
  const off = h[h.length - 1] & 0x0f
  const n = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]
  return String(n % 1_000_000).padStart(6, '0')
}

/** Checks a code against the current step ±1 (Vaultwarden's default drift window). */
export function totpMatches(secret: string, code: string, atMs = Date.now()): boolean {
  const now = totpStep(atMs)
  const c = Buffer.from(code.trim().padEnd(6, ' '))
  return [now - 1, now, now + 1].some(s => {
    const want = Buffer.from(totpCode(secret, s))
    return want.length === c.length && crypto.timingSafeEqual(want, c)
  })
}

export function otpauthUri(secret: string, email: string, issuer = 'HyperProx'): string {
  const label = encodeURIComponent(`${issuer}:${normalizeEmail(email)}`)
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
}

// ---------------------------------------------------------------------------
//  Vaultwarden HTTP
// ---------------------------------------------------------------------------

export class VaultHttpError extends Error {
  constructor(public status: number, message: string, public body?: any) { super(message) }
}

function vaultMessage(body: any, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback
  return body?.ErrorModel?.Message ?? body?.errorModel?.message ?? body?.message ?? body?.error_description ?? fallback
}

function parseBody(text: string): any {
  try { return text ? JSON.parse(text) : null } catch { return text }
}

const DEVICE_TYPE_LINUX_CLI = '25'

export interface IdentityToken {
  accessToken: string
  /** The user's symmetric key, wrapped with the stretched master key (EncString 2). */
  key: string
  /** The user's RSA private key, wrapped with the user key (EncString 2), if any. */
  privateKey?: string
}

/**
 * Admin-panel client. The admin token logs in to `/admin` (form post), which
 * sets a short-lived JWT cookie; the cookie is cached here and reused, because
 * Vaultwarden rate-limits admin logins hard (3 per 5 minutes by default).
 * The admin panel manages accounts, not vault contents: it can never read an item.
 */
export class VaultwardenAdmin {
  private cookie: string | null = null
  private cookieExpires = 0

  constructor(private baseUrl: string, private adminToken: string, private ca?: Buffer) {}

  private async login(): Promise<string> {
    if (this.cookie && Date.now() < this.cookieExpires) return this.cookie
    const res = await vaultRequest(`${this.baseUrl}/admin`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: this.adminToken }).toString(),
      ca: this.ca,
    })
    const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).join('; ')
    const m = /VW_ADMIN=([^;]+)/.exec(setCookie)
    if (!m) {
      if (res.status === 429) throw new VaultHttpError(429, 'vault admin login rate-limited')
      throw new VaultHttpError(res.status, 'vault admin login failed (check VAULT_ADMIN_TOKEN)')
    }
    this.cookie = `VW_ADMIN=${m[1]}`
    this.cookieExpires = Date.now() + 15 * 60_000 // Vaultwarden default session is 20 min
    return this.cookie
  }

  async request(method: string, path: string, body?: unknown, retry = true): Promise<any> {
    const cookie = await this.login()
    const res = await vaultRequest(`${this.baseUrl}/admin${path}`, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : (method === 'POST' ? '{}' : undefined),
      ca: this.ca,
    })
    const data = parseBody(res.text)
    if (res.status === 401 && retry) {
      this.cookie = null
      return this.request(method, path, body, false)
    }
    if (res.status >= 300) throw new VaultHttpError(res.status, vaultMessage(data, `vault admin ${path} → ${res.status}`), data)
    return data
  }

  async users(): Promise<any[]> {
    const r = await this.request('GET', '/users')
    return Array.isArray(r) ? r : []
  }

  async userByEmail(email: string): Promise<any | null> {
    const e = normalizeEmail(email)
    return (await this.users()).find(u => normalizeEmail(String(u.email ?? '')) === e) ?? null
  }

  async invite(email: string): Promise<any> {
    return this.request('POST', '/invite', { email: normalizeEmail(email) })
  }
}

export class VaultwardenApi {
  constructor(public baseUrl: string, private ca?: Buffer) {}

  async alive(): Promise<boolean> {
    try {
      const res = await vaultRequest(`${this.baseUrl}/alive`, { ca: this.ca, timeoutMs: 3000 })
      return res.status === 200
    } catch { return false }
  }

  /**
   * Password grant against /identity/connect/token. Used only during owner
   * bootstrap (before TOTP exists); everyday sign-in goes through the CLI.
   */
  async passwordLogin(email: string, hash: string, totp?: string): Promise<IdentityToken> {
    const form = new URLSearchParams({
      grant_type: 'password',
      username: normalizeEmail(email),
      password: hash,
      scope: 'api offline_access',
      client_id: 'cli',
      device_type: DEVICE_TYPE_LINUX_CLI,
      device_identifier: crypto.randomUUID(),
      device_name: 'hyperprox-bootstrap',
    })
    if (totp) { form.set('two_factor_provider', '0'); form.set('two_factor_token', totp) }
    const res = await vaultRequest(`${this.baseUrl}/identity/connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'device-type': DEVICE_TYPE_LINUX_CLI },
      body: form.toString(),
      ca: this.ca,
    })
    const data = parseBody(res.text)
    if (res.status !== 200) throw new VaultHttpError(res.status, vaultMessage(data, `identity token → ${res.status}`), data)
    return { accessToken: data.access_token, key: data.Key ?? data.key, privateKey: data.PrivateKey ?? data.privateKey ?? undefined }
  }

  async api(method: string, path: string, accessToken: string | null, body?: unknown): Promise<any> {
    const res = await vaultRequest(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        accept: 'application/json',
        'device-type': DEVICE_TYPE_LINUX_CLI,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      ca: this.ca,
    })
    const data = parseBody(res.text)
    if (res.status >= 300) throw new VaultHttpError(res.status, vaultMessage(data, `${path} → ${res.status}`), data)
    return data
  }
}

// ---------------------------------------------------------------------------
//  Owner bootstrap steps
// ---------------------------------------------------------------------------

/**
 * Register an account the admin has already invited. Vaultwarden 1.37 flow with
 * mail disabled: send-verification-email returns a signed token directly (allowed
 * because an invitation exists), then register/finish takes the client-made keys.
 */
export async function registerAccount(api: VaultwardenApi, email: string, password: string): Promise<void> {
  const e = normalizeEmail(email)
  const token = await api.api('POST', '/identity/accounts/register/send-verification-email', null, { email: e, name: e.split('@')[0] })
  if (typeof token !== 'string' || !token) throw new Error('vault did not return a registration token')

  const masterKey = await makeMasterKey(password, e)
  const hash = await masterPasswordHash(masterKey, password)
  const stretched = stretchMasterKey(masterKey)
  const userKeyRaw = crypto.randomBytes(64)
  const userKey = symKeyFromBytes(userKeyRaw)
  const rsa = generateRsaKeyPair()
  try {
    await api.api('POST', '/identity/accounts/register/finish', null, {
      email: e,
      emailVerificationToken: token,
      kdf: KDF_PBKDF2,
      kdfIterations: KDF_ITERATIONS,
      masterPasswordHash: hash,
      masterPasswordHint: null,
      key: encString2(userKeyRaw, stretched),
      keys: {
        publicKey: rsa.publicDer.toString('base64'),
        encryptedPrivateKey: encString2(rsa.privateDer, userKey),
      },
    })
  } finally {
    masterKey.fill(0); userKeyRaw.fill(0); userKey.enc.fill(0); userKey.mac.fill(0)
    stretched.enc.fill(0); stretched.mac.fill(0); rsa.privateDer.fill(0)
  }
}

/** Unwraps the user key from an identity response with the master key. */
export function unwrapUserKey(token: IdentityToken, masterKey: Buffer): SymKey {
  const stretched = stretchMasterKey(masterKey)
  try { return symKeyFromBytes(decString2(token.key, stretched)) }
  finally { stretched.enc.fill(0); stretched.mac.fill(0) }
}

/**
 * Creates organization "HyperProx" with its default collection "HyperProx".
 * The org key is RSA-wrapped (EncString 4) with the owner's public key; the org's
 * own keypair has its private key wrapped with the org key.
 */
export async function createOrganization(api: VaultwardenApi, accessToken: string, ownerEmail: string): Promise<string> {
  const keys = await api.api('GET', '/api/accounts/keys', accessToken).catch(() => null)
  const publicKey: string | undefined = keys?.publicKey ?? keys?.PublicKey
  if (!publicKey) throw new Error('owner account has no public key')

  const orgKeyRaw = crypto.randomBytes(64)
  const orgKey = symKeyFromBytes(orgKeyRaw)
  const orgRsa = generateRsaKeyPair()
  try {
    const org = await api.api('POST', '/api/organizations', accessToken, {
      name: ORG_NAME,
      billingEmail: normalizeEmail(ownerEmail),
      collectionName: encString2(Buffer.from(COLLECTION_NAME, 'utf8'), orgKey),
      key: encString4(orgKeyRaw, Buffer.from(publicKey, 'base64')),
      keys: {
        publicKey: orgRsa.publicDer.toString('base64'),
        encryptedPrivateKey: encString2(orgRsa.privateDer, orgKey),
      },
      planType: 0,
    })
    return String(org?.id ?? org?.Id ?? '')
  } finally {
    orgKeyRaw.fill(0); orgKey.enc.fill(0); orgKey.mac.fill(0); orgRsa.privateDer.fill(0)
  }
}

export async function enableAuthenticator(api: VaultwardenApi, accessToken: string, hash: string, secret: string, code: string): Promise<void> {
  await api.api('POST', '/api/two-factor/authenticator', accessToken, { key: secret, token: code, masterPasswordHash: hash })
}

export const GROUP_OPERATORS = 'HyperProx operators'
export const GROUP_VIEWERS = 'HyperProx viewers'

/**
 * Collection access for members who are not Owner/Admin (those two always have
 * full access). Vaultwarden grants collection access per member or per group, so
 * bootstrap creates two groups on the "HyperProx" collection:
 *   - "HyperProx operators" — read/write (for Manager members, HyperProx role `operator`;
 *      e.g. SSH host-key pinning writes credentials during an operator's terminal session)
 *   - "HyperProx viewers"   — read-only  (for User members, HyperProx role `viewer`)
 * Adding a person = invite them to the organization with type Manager or User and
 * put them in the matching group. Idempotent: existing groups are left alone.
 */
export async function ensureAccessGroups(api: VaultwardenApi, accessToken: string, orgId: string): Promise<void> {
  const cols = await api.api('GET', `/api/organizations/${orgId}/collections`, accessToken)
  const list: any[] = cols?.data ?? cols?.Data ?? []
  if (list.length !== 1) throw new Error(`expected exactly one collection in the new organization, found ${list.length}`)
  const collectionId = String(list[0].id)
  const groups = await api.api('GET', `/api/organizations/${orgId}/groups`, accessToken)
  const names = new Set<string>((groups?.data ?? groups?.Data ?? []).map((g: any) => String(g.name)))
  const want: Array<[string, boolean]> = [[GROUP_OPERATORS, false], [GROUP_VIEWERS, true]]
  for (const [name, readOnly] of want) {
    if (names.has(name)) continue
    await api.api('POST', `/api/organizations/${orgId}/groups`, accessToken, {
      name,
      accessAll: false,
      externalId: null,
      collections: [{ id: collectionId, readOnly, hidePasswords: false, manage: false }],
      users: [],
    })
  }
}
