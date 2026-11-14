// The vault side of Settings → Users: what HyperProx sends Vaultwarden to invite, edit and confirm a member.
// Confirming wraps the organization key with the member's public key (what a Bitwarden client does), and is
// refused when that key's fingerprint is not the one the admin compared. Vaultwarden is a recording fake.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { NativeVaultSession } from '../src/lib/vault/native'
import { generateRsaKeyPair, decString4 } from '../src/lib/vault/bw-crypto'
import { keyFingerprint } from '../src/lib/vault/members'

const ORG = '33333333-3333-4333-8333-333333333333'
const MEMBER = '44444444-4444-4444-8444-444444444444'
const USER = '55555555-5555-4555-8555-555555555555'

function session(pub: Buffer) {
  const calls: Array<{ method: string; path: string; body: any }> = []
  const api: any = {
    async api(method: string, path: string, _token: string, body?: unknown) {
      calls.push({ method, path, body })
      if (path === `/api/users/${USER}/public-key`) return { userId: USER, publicKey: pub.toString('base64') }
      if (path.endsWith('/groups')) return { data: [{ id: 'g-op', name: 'HyperProx operators' }, { id: 'g-view', name: 'HyperProx viewers' }] }
      return {}
    },
  }
  const orgKey = { enc: crypto.randomBytes(32), mac: crypto.randomBytes(32) }
  const k = (x: { enc: Buffer; mac: Buffer }) => ({ enc: x.enc.toString('base64'), mac: x.mac.toString('base64') })
  const s = NativeVaultSession.fromSnapshot(api, {
    email: 'owner@example.com', userId: 'owner-id', orgId: ORG, memberType: 0, kdf: { kdf: 0, iterations: 600000 },
    localHash: crypto.randomBytes(32).toString('base64'), userKey: k({ enc: crypto.randomBytes(32), mac: crypto.randomBytes(32) }), orgKey: k(orgKey),
    accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000,
  } as any)
  return { s, calls, orgKey }
}

test('confirm: the organization key, wrapped with the member\'s public key, only for the compared fingerprint', async () => {
  const rsa = generateRsaKeyPair()
  const { s, calls, orgKey } = session(rsa.publicDer)
  await assert.rejects(s.orgConfirm(MEMBER, USER, '0000-0000-0000-0000-0000-0000-0000-0000'), /fingerprint/)
  assert.equal(calls.some(c => c.path.endsWith('/confirm')), false, 'nothing confirmed on a mismatch')
  await s.orgConfirm(MEMBER, USER, keyFingerprint(rsa.publicDer))
  const c = calls.find(x => x.path === `/api/organizations/${ORG}/users/${MEMBER}/confirm`)!
  assert.equal(c.method, 'POST')
  const unwrapped = decString4(c.body.key, rsa.privateDer)
  assert.ok(unwrapped.equals(Buffer.concat([orgKey.enc, orgKey.mac])), 'the member can unwrap exactly the organization key')
})

test('invite and edit: the membership type, the group, and admin-only access to everything', async () => {
  const { s, calls } = session(generateRsaKeyPair().publicDer)
  await s.orgInvite('friend@example.com', 3, ['g-op'])
  const inv = calls.find(c => c.path === `/api/organizations/${ORG}/users/invite`)!
  assert.deepEqual(inv.body, { emails: ['friend@example.com'], type: 3, groups: ['g-op'], collections: [], accessAll: false, permissions: {} })
  await s.orgEdit(MEMBER, 1, [])
  const ed = calls.find(c => c.method === 'PUT')!
  assert.equal(ed.path, `/api/organizations/${ORG}/users/${MEMBER}`)
  assert.equal(ed.body.accessAll, true)
  await assert.rejects(s.orgEdit('../../admin', 1, []), /not a vault member id/)
  await assert.rejects(s.userPublicKey('x/../y'), /not a vault user id/)
})
