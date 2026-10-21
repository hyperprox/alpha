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
