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

// ---- review fixes: the broker's people calls and one-item delete -------------------------------------------

import { CliVaultBroker } from '../src/lib/vault/broker'
import { VaultHttpError, encString2, symKeyFromBytes } from '../src/lib/vault/bw-crypto'
import { VaultOwnerOnlyError } from '../src/lib/vault/members'
import { INVITE_TTL_MS } from '../src/lib/users/invitations'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RoleStore, resolveRole, setMemberRoles } from '../src/lib/users/roles'
import { roleFromMemberType } from '../src/lib/vault/broker'

// The role record goes to a temporary file, never the repo's data/.
const rolesFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-roles-')), 'roles.json')
setMemberRoles(new RoleStore(rolesFile))
const resetRoles = () => { try { fs.unlinkSync(rolesFile) } catch { /* none yet */ } }

const SID = 'a'.repeat(32)
const INVITED = '66666666-6666-4666-8666-666666666666'

/** A broker holding one fast session whose vault is a recording fake of the organization calls. */
function brokerWith(members: any[], opts: { refuse?: string } = {}) {
  const calls: Array<[string, ...unknown[]]> = []
  const refuse = (_: string) => { if (opts.refuse) throw new VaultHttpError(400, opts.refuse) }
  const vault: any = {
    orgMembers: async () => members,
    orgGroups: async () => [{ id: 'g-op', name: 'HyperProx operators' }, { id: 'g-view', name: 'HyperProx viewers' }],
    orgInvite: async (email: string, type: number, groups: string[]) => { refuse('x'); calls.push(['invite', email, type, groups]) },
    orgEdit: async (id: string, type: number, groups: string[]) => { refuse('x'); calls.push(['edit', id, type, groups]) },
    orgRemove: async (id: string) => { refuse('x'); calls.push(['remove', id]) },
    orgConfirm: async (id: string) => { refuse('x'); calls.push(['confirm', id]) },
    close() {},
  }
  const b = new CliVaultBroker() as any
  b.sessions.set(SID, { kind: 'fast', sid: SID, email: 'owner@example.com', role: 'owner', userId: 'owner-id', vault, queue: Promise.resolve() })
  return { b: b as CliVaultBroker, calls: () => calls }
}

test('re-invite: an invitation the vault still holds is reused (with the new role), not refused or doubled', async () => {
  const { b, calls } = brokerWith([{ id: INVITED, email: 'Friend@Example.com', status: 0, type: 2 }])
  assert.deepEqual(await b.inviteMember(SID, 'friend@example.com', 'viewer'), { reused: true })
  assert.deepEqual(calls(), [], 'same role: nothing to change')
  assert.deepEqual(await b.inviteMember(SID, 'friend@example.com', 'operator'), { reused: true })
  assert.deepEqual(calls(), [['edit', INVITED, 3, ['g-op']]])
  const joined = brokerWith([{ id: INVITED, email: 'friend@example.com', status: 1, type: 2 }])
  await assert.rejects(joined.b.inviteMember(SID, 'friend@example.com', 'viewer'), /already a member/)
  const fresh = brokerWith([])
  assert.deepEqual(await fresh.b.inviteMember(SID, 'new@example.com', 'viewer'), { reused: false })
  assert.deepEqual(fresh.calls(), [['invite', 'new@example.com', 2, ['g-view']]])
})

test('withdraw/expiry: an invited or joined-but-unconfirmed membership is removed; a confirmed one or the owner never', async () => {
  const { b, calls } = brokerWith([
    { id: INVITED, email: 'inv@example.com', status: 0, type: 2 },
    { id: MEMBER, email: 'acc@example.com', status: 1, type: 3 },
    { id: USER, email: 'conf@example.com', status: 2, type: 2 },
    { id: ORG, email: 'owner@example.com', status: 2, type: 0 },
  ])
  assert.equal(await b.removePendingMember(SID, 'INV@example.com'), true)
  assert.equal(await b.removePendingMember(SID, 'acc@example.com'), true)
  assert.equal(await b.removePendingMember(SID, 'conf@example.com'), false)
  assert.equal(await b.removePendingMember(SID, 'owner@example.com'), false)
  assert.equal(await b.removePendingMember(SID, 'nobody@example.com'), false)
  assert.deepEqual(calls(), [['remove', INVITED], ['remove', MEMBER]])
})

test('the vault\'s "only Owners can ..." refusal becomes VaultOwnerOnlyError; other errors pass through', async () => {
  const msg = 'Only Owners can invite Managers, Admins or Owners'
  await assert.rejects(brokerWith([], { refuse: msg }).b.inviteMember(SID, 'x@example.com', 'operator'), VaultOwnerOnlyError)
  await assert.rejects(brokerWith([{ id: INVITED, email: 'x@example.com', status: 0, type: 3 }], { refuse: 'Only Owners can delete Admins or Owners' }).b.removePendingMember(SID, 'x@example.com'), VaultOwnerOnlyError)
  const acc = [{ id: MEMBER, userId: USER, email: 'x@example.com', status: 1, type: 3, twoFactorEnabled: true }]
  await assert.rejects(brokerWith(acc, { refuse: 'Only Owners can confirm Managers, Admins or Owners' }).b.confirmMember(SID, MEMBER, 'f'), VaultOwnerOnlyError)
  await assert.rejects(brokerWith([], { refuse: 'Something else' }).b.inviteMember(SID, 'x@example.com', 'viewer'), (e: any) => e instanceof VaultHttpError)
})

test('join step 1: "already exists" counts as registered; onRegistered runs before the sign-in; pending entries expire', async () => {
  const rsa = generateRsaKeyPair()
  const seen: string[] = []
  let exists = false
  const api: any = {
    async api(method: string, p: string) {
      seen.push(`${method} ${p}`)
      if (p.endsWith('/send-verification-email')) return 'reg-token'
      if (p.endsWith('/register/finish')) { if (exists) throw new VaultHttpError(400, 'Registration not allowed or user already exists'); exists = true; return {} }
      if (p === '/api/accounts/keys') return { publicKey: rsa.publicDer.toString('base64') }
      return {}
    },
    async passwordLogin() { seen.push('login'); return { accessToken: 'at' } },
  }
  const b = new CliVaultBroker() as any
  b.api = () => api
  let marked = 0
  const r1 = await b.registerInvitee('j@example.com', 'a long master password', { onRegistered: () => { marked++; seen.push('marked') } })
  assert.equal(r1.fingerprint, keyFingerprint(rsa.publicDer))
  assert.ok(seen.indexOf('marked') < seen.indexOf('login'), 'marked before the sign-in that could fail')
  // A retry that registers again (the record was not marked): the vault's "already exists" is not a failure.
  const r2 = await b.registerInvitee('j@example.com', 'a long master password', { onRegistered: () => { marked++ } })
  assert.equal(marked, 2)
  assert.ok(r2.otpauthUri.startsWith('otpauth://'))
  // Other refusals still fail.
  api.api = async (_m: string, p: string) => { if (p.endsWith('/send-verification-email')) return 'reg-token'; throw new VaultHttpError(400, 'Email domain not allowed') }
  await assert.rejects(b.registerInvitee('k@example.com', 'a long master password', {}), /domain not allowed/)
  // The secret between steps 1 and 2 does not outlive the invitation.
  b.pendingInvitee.set('old@example.com', { secret: 'S', at: Date.now() - INVITE_TTL_MS - 1 })
  b.pendingInvitee.set('new@example.com', { secret: 'S', at: Date.now() })
  assert.equal(b.pendingInviteeSecret('old@example.com'), undefined)
  assert.equal(b.pendingInvitee.has('old@example.com'), false)
  assert.equal(b.pendingInviteeSecret('new@example.com'), 'S')
})

test('remove a member: DELETE on the organization\'s users path, never a crafted id', async () => {
  const { s, calls } = session(generateRsaKeyPair().publicDer)
  await s.orgRemove(MEMBER)
  assert.deepEqual(calls.at(-1), { method: 'DELETE', path: `/api/organizations/${ORG}/users/${MEMBER}`, body: undefined })
  await assert.rejects(s.orgRemove('../x'), /not a vault member id/)
})

test('delete one item: only the chosen id is trashed, never a same-named twin, never an item outside the collection', async () => {
  const COL = '77777777-7777-4777-8777-777777777777'
  const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const OUT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const orgRaw = crypto.randomBytes(64)
  const orgKey = symKeyFromBytes(orgRaw)
  const enc = (v: string) => encString2(Buffer.from(v), orgKey)
  const ciphers = [
    { id: A, organizationId: ORG, collectionIds: [COL], name: enc('router-admin'), fields: [] },
    { id: B, organizationId: ORG, collectionIds: [COL], name: enc('router-admin'), fields: [] },
    { id: OUT, organizationId: ORG, collectionIds: ['elsewhere'], name: enc('router-admin'), fields: [] },
  ]
  const calls: string[] = []
  const api: any = { async api(method: string, p: string) { calls.push(`${method} ${p}`); return p.startsWith('/api/sync') ? { ciphers } : {} } }
  const k = (x: Buffer) => ({ enc: x.subarray(0, 32).toString('base64'), mac: x.subarray(32).toString('base64') })
  const s = NativeVaultSession.fromSnapshot(api, {
    email: 'owner@example.com', userId: 'owner-id', orgId: ORG, memberType: 0, collectionId: COL, kdf: { kdf: 0, iterations: 600000 },
    localHash: crypto.randomBytes(32).toString('base64'), userKey: k(crypto.randomBytes(64)), orgKey: k(orgRaw),
    accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000,
  } as any)
  assert.deepEqual(await s.deleteItem(B), { id: B, name: 'router-admin' })
  assert.deepEqual(calls.filter(c => c.startsWith('PUT')), [`PUT /api/ciphers/${B}/delete`])
  await assert.rejects(s.deleteItem(OUT), /no such item/)
  await assert.rejects(s.deleteItem('../../x'), /not a vault item id/)
  assert.equal(calls.filter(c => c.startsWith('PUT')).length, 1)
})

// ---- roles: Vaultwarden reports a Manager as 4 (Custom); HyperProx's own record wins -------------------------

test('a Manager reads back as operator whether the vault says 3 or 4 (Custom); Owner, Admin, User as before', () => {
  assert.equal(roleFromMemberType(0), 'owner')
  assert.equal(roleFromMemberType(1), 'admin')
  assert.equal(roleFromMemberType(2), 'viewer')
  assert.equal(roleFromMemberType(3), 'operator')
  assert.equal(roleFromMemberType(4), 'operator')
  assert.equal(roleFromMemberType(99), 'viewer')
})

test('HyperProx\'s record is the role; the vault type is the fallback; nobody records their way to owner', () => {
  assert.equal(resolveRole(2, 'operator'), 'operator')
  assert.equal(resolveRole(4, null), 'operator')
  assert.equal(resolveRole(2, null), 'viewer')
  assert.equal(resolveRole(0, 'viewer'), 'owner')
})

test('a role change sticks: the list reads the new role back even though the vault reports 4', async () => {
  resetRoles()
  // The vault took the change to Manager but lists the member as type 4, as Vaultwarden 1.3x does.
  const members = [{ id: MEMBER, userId: USER, email: 'op@example.com', status: 2, type: 2 }]
  const { b, calls } = brokerWith(members)
  await b.setMemberRole(SID, MEMBER, 'operator')
  assert.deepEqual(calls(), [['edit', MEMBER, 3, ['g-op']]])
  members[0].type = 4
  assert.equal((await b.members!(SID))[0].role, 'operator')
  // Back to viewer: the record follows, even though the vault would still have said 4 had it lagged.
  await b.setMemberRole(SID, MEMBER, 'viewer')
  assert.equal((await b.members!(SID))[0].role, 'viewer')
})

test('an invitation records the role it was made with; withdrawing it removes the record', async () => {
  resetRoles()
  const { b } = brokerWith([])
  await b.inviteMember(SID, 'New@Example.com', 'operator')
  assert.equal(new RoleStore(rolesFile).get('new@example.com'), 'operator')
  const pending = brokerWith([{ id: INVITED, email: 'new@example.com', status: 0, type: 4 }])
  assert.equal(await pending.b.removePendingMember(SID, 'new@example.com'), true)
  assert.equal(new RoleStore(rolesFile).get('new@example.com'), null)
})

test('broker removeMember: takes a joined member out of the org and its role record; never the owner or yourself', async () => {
  resetRoles()
  new RoleStore(rolesFile).set('acc@example.com', 'viewer')
  const { b, calls } = brokerWith([
    { id: MEMBER, userId: USER, email: 'acc@example.com', status: 2, type: 2 },
    { id: ORG, userId: 'owner-id', email: 'owner@example.com', status: 2, type: 0 },
    { id: INVITED, userId: 'someone', email: 'x@example.com', status: 2, type: 0 },
  ])
  assert.deepEqual(await b.removeMember!(SID, MEMBER), { email: 'acc@example.com' })
  assert.deepEqual(calls(), [['remove', MEMBER]])
  assert.equal(new RoleStore(rolesFile).get('acc@example.com'), null)
  await assert.rejects(b.removeMember!(SID, INVITED), /owner cannot be removed/)
  await assert.rejects(b.removeMember!(SID, ORG), /owner cannot be removed|cannot remove yourself/)
})
