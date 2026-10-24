// Unit tests for the Bitwarden client crypto and helpers (no vault needed).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import * as c from '../src/lib/vault/bw-crypto'
import { authCodeFromMessage, roleFromMemberType } from '../src/lib/vault/broker'

test('EncString type 2 round-trips and rejects a tampered MAC', () => {
  const key = c.symKeyFromBytes(crypto.randomBytes(64))
  const enc = c.encString2(Buffer.from('hello vault'), key)
  assert.match(enc, /^2\.[^|]+\|[^|]+\|[^|]+$/)
  assert.equal(c.decString2(enc, key).toString(), 'hello vault')
  const parts = enc.split('|')
  const bad = `${parts[0]}|${parts[1]}|${Buffer.alloc(32).toString('base64')}`
  assert.throws(() => c.decString2(bad, key), /MAC/)
})

test('EncString type 4 (RSA-OAEP-SHA1) round-trips a 64-byte org key', () => {
  const kp = c.generateRsaKeyPair()
  const orgKey = crypto.randomBytes(64)
  const enc = c.encString4(orgKey, kp.publicDer)
  assert.match(enc, /^4\./)
  assert.deepEqual(c.decString4(enc, kp.privateDer), orgKey)
})

test('master key / hash derivation is deterministic and salted by the lowercased email', async () => {
  const a = await c.makeMasterKey('pw-123456789012', 'User@Example.com ')
  const b = await c.makeMasterKey('pw-123456789012', 'user@example.com')
  assert.deepEqual(a, b)
  const h = await c.masterPasswordHash(a, 'pw-123456789012')
  assert.equal(Buffer.from(h, 'base64').length, 32)
  const s = c.stretchMasterKey(a)
  assert.equal(s.enc.length, 32); assert.equal(s.mac.length, 32)
  assert.notDeepEqual(s.enc, s.mac)
  // HKDF-Expand single block = HMAC(prk, info || 0x01)
  assert.deepEqual(s.enc, crypto.createHmac('sha256', a).update(Buffer.concat([Buffer.from('enc'), Buffer.from([1])])).digest())
})

test('TOTP matches the RFC 6238 SHA-1 vector', () => {
  const secret = c.base32Encode(Buffer.from('12345678901234567890'))
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
  assert.equal(c.totpCode(secret, Math.floor(59 / 30)), '287082')
  assert.equal(c.totpCode(secret, Math.floor(1111111109 / 30)), '081804')
  assert.equal(c.newTotpSecret().length, 32)
  assert.equal(c.base32Decode(c.newTotpSecret()).length, 20)
  const now = Date.now()
  assert.ok(c.totpMatches(secret, c.totpCode(secret, c.totpStep(now)), now))
  assert.ok(!c.totpMatches(secret, c.totpCode(secret, c.totpStep(now) + 5), now))
  assert.match(c.otpauthUri(secret, 'Owner@Example.com'), /^otpauth:\/\/totp\/HyperProx%3Aowner%40example\.com\?secret=/)
})

test('role mapping follows the contract', () => {
  assert.equal(roleFromMemberType(0), 'owner')
  assert.equal(roleFromMemberType(1), 'admin')
  assert.equal(roleFromMemberType(3), 'operator')
  assert.equal(roleFromMemberType(2), 'viewer')
  assert.equal(roleFromMemberType(4), 'viewer')
})

test('CLI messages map to contract error codes', () => {
  assert.equal(authCodeFromMessage('Username or password is incorrect. Try again'), 'bad_credentials')
  assert.equal(authCodeFromMessage('Too many requests, try again later.'), 'locked_out')
  assert.equal(authCodeFromMessage('Invalid TOTP code! Server time: ...'), 'totp_invalid')
})

// ---------------------------------------------------------------------------
//  Known-answer vectors. Computed outside Node (Python hashlib/hmac and the
//  openssl CLI), so these check the fast path against an independent
//  implementation, not against itself.
// ---------------------------------------------------------------------------

const KAT = {
  password: 'correct horse battery staple',
  email: 'Owner@Example.com',
  masterKey: '06f870e0df19a862e757a946ceb55c15e6c2dda7b7ad8f41cddae39791ebb9e0',
  serverHash: 'AiT0FIIh89FvUBSjlzAdcFgliyRqIhjzzT75H+ofszk=',
  localHash: 'XWHpNHDT+nQpSdOHgoQGkDtugHZkrvOmUYKHCJ5DN1k=',
  stretchedEnc: '5338fcce18f5c44f87f3c658d0c8ec4463402f3bb9302644b4ca0fb3a880ca95',
  stretchedMac: 'c5b3f66e8c0db37623cb19a4ef9d8a695803d979a3ced37411795eae21c2e3fe',
  // key = bytes 0..63, iv = bytes 100..115, plaintext "hyperprox known answer"
  encString2: '2.ZGVmZ2hpamtsbW5vcHFycw==|eJGANcAADCgiO6ZhnecDrnOGkUEA1okXnSWaBaLb+Ug=|038IMGbBmfqX/ZtV5pCI4UDKcqRlqibqhN7gL1cnSAc=',
  // Send seed = bytes 200..215
  sendKey: '466cbc5070ddf4fbbe942788e58bc6a2b885f21805a4ef7908b8467f4566cfbf76066eaa4569a0e66507aadf655147822d0e93b8d1c0cd6e19db12908de5262e',
  sendPasswordHash: '63lcltx7/iL153McEbQe/RuzCL6Vg7x2tS2JPQQBYu4=',
  sendFragment: 'yMnKy8zNzs_Q0dLT1NXW1w',
}
const range = (from: number, n: number) => Buffer.from(Array.from({ length: n }, (_, i) => from + i))

test('KAT: PBKDF2 master key, server hash, local hash and stretched key', async () => {
  const mk = await c.makeMasterKeyFor(KAT.password, KAT.email, { kdf: c.KDF_PBKDF2, iterations: 600_000 })
  assert.equal(mk.toString('hex'), KAT.masterKey)
  assert.deepEqual(await c.makeMasterKey(KAT.password, KAT.email), mk) // the bootstrap helper agrees
  assert.equal(await c.masterPasswordHash(mk, KAT.password), KAT.serverHash)
  assert.equal((await c.localPasswordHash(mk, KAT.password)).toString('base64'), KAT.localHash)
  const s = c.stretchMasterKey(mk)
  assert.equal(s.enc.toString('hex'), KAT.stretchedEnc)
  assert.equal(s.mac.toString('hex'), KAT.stretchedMac)
})

test('KAT: decrypt an EncString type 2 made by openssl', () => {
  const key = c.symKeyFromBytes(range(0, 64))
  assert.equal(c.decString2(KAT.encString2, key).toString('utf8'), 'hyperprox known answer')
  assert.throws(() => c.decString2(KAT.encString2, c.symKeyFromBytes(range(1, 64))), /MAC/)
})

test('KAT: Send key (full HKDF), Send password hash, URL fragment', async () => {
  const seed = range(200, 16)
  const k = c.sendKeyFromSeed(seed)
  assert.equal(Buffer.concat([k.enc, k.mac]).toString('hex'), KAT.sendKey)
  assert.equal(await c.sendPasswordHash('send pw', seed), KAT.sendPasswordHash)
  assert.equal(c.base64Url(seed), KAT.sendFragment)
})

test('makeMasterKeyFor refuses Argon2id and implausible PBKDF2 settings', async () => {
  await assert.rejects(c.makeMasterKeyFor('x', 'a@b.c', { kdf: c.KDF_ARGON2ID, iterations: 3, memory: 64, parallelism: 4 }), /not supported/)
  await assert.rejects(c.makeMasterKeyFor('x', 'a@b.c', { kdf: c.KDF_PBKDF2, iterations: 1 }), /implausible/)
})

test('EncString type 3 (RSA-OAEP-SHA256) and type 4 both unwrap an org key', () => {
  const kp = c.generateRsaKeyPair()
  const orgKey = crypto.randomBytes(64)
  assert.deepEqual(c.decRsaEncString(c.encString4(orgKey, kp.publicDer), kp.privateDer), orgKey)
  const pub = crypto.createPublicKey({ key: kp.publicDer, format: 'der', type: 'spki' })
  const t3 = `3.${crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, orgKey).toString('base64')}`
  assert.deepEqual(c.decRsaEncString(t3, kp.privateDer), orgKey)
  assert.throws(() => c.decRsaEncString('6.abc', kp.privateDer), /unsupported/)
})
