// Settings → Users: listing the vault organisation's members, inviting with a one-time link (no mail needed),
// confirming after the key fingerprint was compared, and role changes. The gate's matrix, the role checks in
// the routes, the audit-before-change rule, and the join page's three public calls. The vault is a fake.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { buildUserRoutes, buildJoinRoutes } from '../src/routes/users'
import { InvitationStore, INVITE_TTL_MS } from '../src/lib/users/invitations'
import { keyFingerprint, memberTypeFor, memberStatus, needsVaultOwner, VaultOwnerOnlyError } from '../src/lib/vault/members'
import { requiredRole, needsReconfirm } from '../src/lib/roles'
import { VaultAuthError, type Role, type VaultBroker } from '../src/lib/vault/broker'
import type { VaultMember, GrantableRole } from '../src/lib/vault/members'

const M1 = '11111111-1111-4111-8111-111111111111'
const M2 = '22222222-2222-4222-8222-222222222222'
const M3 = '33333333-3333-4333-8333-333333333333'
const FP = keyFingerprint(Buffer.from('a public key'))

/** What the fake vault does wrong on purpose. */
interface Faults { ownerOnly?: boolean; loginFailsAfterRegister?: boolean; removeFails?: boolean }

function fakeBroker(faults: Faults = {}) {
  const calls: Array<[string, ...unknown[]]> = []
  const members: VaultMember[] = [
    { id: M1, userId: 'u1', email: 'owner@example.com', name: null, role: 'owner', status: 'confirmed', twoFactor: true, fingerprint: null },
    { id: M2, userId: 'u2', email: 'new@example.com', name: null, role: 'viewer', status: 'accepted', twoFactor: true, fingerprint: FP },
    { id: M3, userId: 'u3', email: 'op@example.com', name: null, role: 'operator', status: 'accepted', twoFactor: true, fingerprint: FP },
  ]
  const b: Partial<VaultBroker> = {
    members: async sid => { calls.push(['members', sid]); return members },
    inviteMember: async (sid, email, role) => { calls.push(['invite', sid, email, role]); if (faults.ownerOnly) throw new VaultOwnerOnlyError() },
    confirmMember: async (sid, id, fp) => { calls.push(['confirm', sid, id, fp]); if (faults.ownerOnly) throw new VaultOwnerOnlyError() },
    setMemberRole: async (sid, id, role) => { calls.push(['role', sid, id, role]) },
    removePendingMember: async (sid, email) => { calls.push(['remove', sid, email]); if (faults.removeFails) throw new Error('vault down'); return true },
    removeMember: async (sid, id) => { calls.push(['remove-member', sid, id]); if (faults.ownerOnly) throw new VaultOwnerOnlyError(); return { email: members.find(m => m.id === id)!.email } },
    registerInvitee: async (email, pw, opts) => {
      calls.push(['register', email, pw.length, !!opts?.alreadyRegistered])
      if (!opts?.alreadyRegistered) opts?.onRegistered?.()
      if (faults.loginFailsAfterRegister) throw new Error('the vault did not answer the sign-in')
      return { totpSecret: 'S', otpauthUri: `otpauth://totp/HyperProx:${email}?secret=S`, fingerprint: FP }
    },
    confirmInviteeTotp: async (email, _pw, code) => { calls.push(['totp', email, code]); if (code !== '123456') throw new VaultAuthError('totp_invalid') },
  }
  return { broker: b as VaultBroker, calls }
}

function rig(role: Role, opts: { token?: boolean; auditFails?: boolean; faults?: Faults; now?: () => number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-users-'))
  const invitations = new InvitationStore(path.join(dir, 'invitations.json'), opts.now)
  const { broker, calls } = fakeBroker(opts.faults)
  const audits: Array<[string, string, Record<string, unknown> | undefined]> = []
  const audit = async (a: string, r: string, d?: Record<string, unknown>) => { if (opts.auditFails) throw new Error('db down'); audits.push([a, r, d]) }
  const app = Fastify()
  app.addHook('onRequest', async req => {
    if (req.url.startsWith('/api/users')) (req as any).session = { sid: opts.token ? 'token:t1' : 'a'.repeat(32), role, email: `${role}@example.com` }
  })
  const ended: Array<{ userId: string | null; email: string }> = []
  app.register(buildUserRoutes({ broker: () => broker, invitations, audit, endSessions: async who => { ended.push(who); return 1 } }), { prefix: '/api/users' })
  app.register(buildJoinRoutes({ broker: () => broker, invitations, audit }), { prefix: '/api/auth/join' })
  return { app, calls, audits, invitations, dir, broker, ended }
}

test('the gate: listing is admin, every change is re-confirmed, the join calls are public', () => {
  assert.equal(requiredRole('GET', '/api/users'), 'admin')
  assert.equal(requiredRole('POST', '/api/users/invite'), 'admin')
  assert.equal(needsReconfirm('POST', '/api/users/invite'), true)
  assert.equal(needsReconfirm('POST', `/api/users/${M2}/confirm`), true)
  assert.equal(needsReconfirm('PUT', `/api/users/${M2}/role`), true)
  assert.equal(needsReconfirm('GET', '/api/users'), false)
  for (const p of ['/api/auth/join/check', '/api/auth/join/register', '/api/auth/join/totp']) assert.equal(requiredRole('POST', p), null, p)
})

test('roles map to membership types and back', () => {
  assert.deepEqual((['admin', 'operator', 'viewer'] as GrantableRole[]).map(memberTypeFor), [1, 3, 2])
  assert.deepEqual([0, 1, 2, -1].map(memberStatus), ['invited', 'accepted', 'confirmed', 'revoked'])
  assert.match(FP, /^[0-9a-f]{4}(-[0-9a-f]{4}){7}$/)
})

test('list: admin sees members and pending invitations; a viewer and an API token do not', async () => {
  const a = rig('admin')
  const r = await a.app.inject({ method: 'GET', url: '/api/users' })
  assert.equal(r.statusCode, 200)
  assert.equal(r.json().data.members.length, 3)
  assert.equal(r.json().data.mail, false)
  assert.equal((await rig('viewer').app.inject({ method: 'GET', url: '/api/users' })).statusCode, 403)
  assert.equal((await rig('admin', { token: true }).app.inject({ method: 'GET', url: '/api/users' })).json().code, 'token_refused')
})

test('invite: a copyable link with the token in the fragment, only its hash kept, audited first', async () => {
  const { app, calls, audits, invitations, dir } = rig('owner')
  const r = await app.inject({ method: 'POST', url: '/api/users/invite', headers: { 'x-forwarded-host': 'hp.example.com' }, payload: { email: 'Friend@Example.com', role: 'operator' } })
  assert.equal(r.statusCode, 200, r.body)
  const { link, email, expiresAt } = r.json().data
  assert.equal(email, 'friend@example.com')
  assert.match(link, /^https:\/\/hp\.example\.com\/join#[A-Za-z0-9_-]{43}$/)
  const token = link.split('#')[1]
  assert.ok(Math.abs(Date.parse(expiresAt) - Date.now() - INVITE_TTL_MS) < 5000)
  assert.deepEqual(calls.find(c => c[0] === 'invite')!.slice(2), ['friend@example.com', 'operator'])
  assert.equal(audits[0][0], 'users.invite')
  const onDisk = fs.readFileSync(path.join(dir, 'invitations.json'), 'utf8')
  assert.ok(!onDisk.includes(token), 'the token itself is never stored')
  assert.equal(fs.statSync(path.join(dir, 'invitations.json')).mode & 0o777, 0o600)
  assert.equal(invitations.find(token)?.email, 'friend@example.com')
})

test('invite: an admin role needs the owner; bad input is refused; no audit row, no invite', async () => {
  const a = rig('admin')
  assert.equal((await a.app.inject({ method: 'POST', url: '/api/users/invite', payload: { email: 'x@example.com', role: 'admin' } })).statusCode, 403)
  assert.equal((await a.app.inject({ method: 'POST', url: '/api/users/invite', payload: { email: 'x@example.com', role: 'viewer' } })).statusCode, 200)
  assert.equal((await a.app.inject({ method: 'POST', url: '/api/users/invite', payload: { email: 'x@example.com', role: 'owner' } })).statusCode, 400)
  assert.equal((await a.app.inject({ method: 'POST', url: '/api/users/invite', payload: { email: 'not-an-email', role: 'viewer' } })).statusCode, 400)
  const o = rig('owner')
  assert.equal((await o.app.inject({ method: 'POST', url: '/api/users/invite', payload: { email: 'x@example.com', role: 'admin' } })).statusCode, 200)
  const down = rig('owner', { auditFails: true })
  assert.equal((await down.app.inject({ method: 'POST', url: '/api/users/invite', payload: { email: 'x@example.com', role: 'viewer' } })).statusCode, 503)
  assert.equal(down.calls.some(c => c[0] === 'invite'), false)
})

test('confirm: needs the compared fingerprint; role changes are the owner\'s', async () => {
  const a = rig('admin')
  assert.equal((await a.app.inject({ method: 'POST', url: `/api/users/${M2}/confirm`, payload: {} })).statusCode, 400)
  const ok = await a.app.inject({ method: 'POST', url: `/api/users/${M2}/confirm`, payload: { fingerprint: FP } })
  assert.equal(ok.statusCode, 200, ok.body)
  assert.deepEqual(a.calls.find(c => c[0] === 'confirm')!.slice(2), [M2, FP])
  assert.equal((await a.app.inject({ method: 'POST', url: '/api/users/not-an-id/confirm', payload: { fingerprint: FP } })).statusCode, 404)
  assert.equal((await a.app.inject({ method: 'PUT', url: `/api/users/${M2}/role`, payload: { role: 'operator' } })).statusCode, 403)
  const o = rig('owner')
  assert.equal((await o.app.inject({ method: 'PUT', url: `/api/users/${M2}/role`, payload: { role: 'operator' } })).statusCode, 200)
  assert.equal(o.audits.at(-1)![0], 'users.role')
})

test('join: check, register, two-step login, and the link is used up', async () => {
  const { app, calls, invitations, audits } = rig('admin')
  const inv = await app.inject({ method: 'POST', url: '/api/users/invite', payload: { email: 'friend@example.com', role: 'viewer' } })
  const token = inv.json().data.link.split('#')[1]

  const bad = await app.inject({ method: 'POST', url: '/api/auth/join/check', payload: { token: 'x'.repeat(43) } })
  assert.equal(bad.statusCode, 404)
  const check = await app.inject({ method: 'POST', url: '/api/auth/join/check', payload: { token } })
  assert.deepEqual({ ...check.json().data, expiresAt: undefined }, { email: 'friend@example.com', role: 'viewer', expiresAt: undefined, step: 'password' })

  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/join/register', payload: { token, password: 'short' } })).statusCode, 400)
  const reg = await app.inject({ method: 'POST', url: '/api/auth/join/register', payload: { token, password: 'a long master password' } })
  assert.equal(reg.statusCode, 200, reg.body)
  assert.equal(reg.json().data.fingerprint, FP)
  assert.match(reg.json().data.otpauthUri, /^otpauth:\/\/totp\//)
  assert.equal(reg.json().data.totpSecret, undefined, 'the secret travels only inside the otpauth URI')
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/join/check', payload: { token } })).json().data.step, 'totp')

  const wrong = await app.inject({ method: 'POST', url: '/api/auth/join/totp', payload: { token, password: 'a long master password', code: '000000' } })
  assert.equal(wrong.statusCode, 400)
  // Registering again with the same link (after a restart) does not make a second account.
  await app.inject({ method: 'POST', url: '/api/auth/join/register', payload: { token, password: 'a long master password' } })
  assert.equal(calls.filter(c => c[0] === 'register').at(-1)![3], true)

  const done = await app.inject({ method: 'POST', url: '/api/auth/join/totp', payload: { token, password: 'a long master password', code: '123456' } })
  assert.equal(done.statusCode, 200, done.body)
  assert.deepEqual(audits.filter(a => a[0].startsWith('users.join')).map(a => a[0]),
    ['users.join.register', 'users.join.totp', 'users.join.register', 'users.join.totp'], 'one row before each step, failed steps included')
  assert.equal(invitations.find(token), null, 'used up')
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/join/check', payload: { token } })).statusCode, 404)
})

test('invitations expire after 72 hours and can be withdrawn', async () => {
  let t = Date.now()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-users-'))
  const store = new InvitationStore(path.join(dir, 'i.json'), () => t)
  const { token, invitation } = store.create('a@example.com', 'viewer', 'admin@example.com')
  assert.ok(store.find(token))
  t += INVITE_TTL_MS + 1
  assert.equal(store.find(token), null)
  const b = store.create('b@example.com', 'viewer', 'admin@example.com')
  const a = rig('admin')
  const s2 = new InvitationStore(path.join(dir, 'i.json'), () => t)
  assert.ok(s2.remove(b.invitation.hash))
  assert.equal(s2.find(b.token), null)
  assert.ok(invitation.hash.length === 64)
  assert.equal((await a.app.inject({ method: 'DELETE', url: `/api/users/invitations/${'0'.repeat(64)}` })).statusCode, 404)
})

// ---- review fixes ------------------------------------------------------------------------------------------

test('the vault rule: only the owner invites, confirms or withdraws an operator or admin', async () => {
  assert.deepEqual((['admin', 'operator', 'viewer'] as GrantableRole[]).map(needsVaultOwner), [true, true, false])
  const a = rig('admin')
  for (const role of ['operator', 'admin']) {
    const r = await a.app.inject({ method: 'POST', url: '/api/users/invite', payload: { email: 'x@example.com', role } })
    assert.equal(r.statusCode, 403, role)
    assert.equal(r.json().required, 'owner')
    assert.match(r.json().error, /only the owner/i)
  }
  assert.equal(a.calls.some(c => c[0] === 'invite'), false, 'refused before the vault is asked')
  assert.equal(a.audits.length, 0)
  // Confirming: a viewer is the admin's to confirm, an operator is not.
  assert.equal((await a.app.inject({ method: 'POST', url: `/api/users/${M2}/confirm`, payload: { fingerprint: FP } })).statusCode, 200)
  const op = await a.app.inject({ method: 'POST', url: `/api/users/${M3}/confirm`, payload: { fingerprint: FP } })
  assert.equal(op.statusCode, 403)
  assert.equal(a.calls.filter(c => c[0] === 'confirm').length, 1)
  const o = rig('owner')
  assert.equal((await o.app.inject({ method: 'POST', url: '/api/users/invite', payload: { email: 'x@example.com', role: 'operator' } })).statusCode, 200)
  assert.equal((await o.app.inject({ method: 'POST', url: `/api/users/${M3}/confirm`, payload: { fingerprint: FP } })).statusCode, 200)
})

test('the vault refusing anyway is a plain 403, and the refusal is audited', async () => {
  const o = rig('owner', { faults: { ownerOnly: true } })
  const r = await o.app.inject({ method: 'POST', url: '/api/users/invite', payload: { email: 'x@example.com', role: 'operator' } })
  assert.equal(r.statusCode, 403)
  assert.equal(r.json().code, 'vault_owner_only')
  assert.match(r.json().error, /only the owner/i)
  assert.deepEqual(o.audits.map(a => a[0]), ['users.invite', 'users.invite.refused'])
  assert.equal(o.audits[1][2]!.refused, 'vault: owner only')
  assert.equal(o.invitations.list().length, 0, 'no link for a refused invite')
  const c = await o.app.inject({ method: 'POST', url: `/api/users/${M3}/confirm`, payload: { fingerprint: FP } })
  assert.equal(c.statusCode, 403)
  assert.equal(o.audits.at(-1)![0], 'users.confirm.refused')
})

test('the link host: X-Forwarded-Host only from this machine (the gate\'s rule), else Host', async () => {
  const { app } = rig('owner')
  const remote = await app.inject({ method: 'POST', url: '/api/users/invite', remoteAddress: '192.0.2.10',
    headers: { host: 'hp.example.com', 'x-forwarded-host': 'evil.example.net', 'x-forwarded-proto': 'http' }, payload: { email: 'a@example.com', role: 'viewer' } })
  assert.match(remote.json().data.link, /^https:\/\/hp\.example\.com\/join#/)
  const local = await app.inject({ method: 'POST', url: '/api/users/invite', remoteAddress: '127.0.0.1',
    headers: { host: '127.0.0.1:3001', 'x-forwarded-host': 'hp.example.com' }, payload: { email: 'b@example.com', role: 'viewer' } })
  assert.match(local.json().data.link, /^https:\/\/hp\.example\.com\/join#/)
  const junk = await app.inject({ method: 'POST', url: '/api/users/invite', remoteAddress: '192.0.2.10',
    headers: { host: 'bad host/x' }, payload: { email: 'c@example.com', role: 'viewer' } })
  assert.match(junk.json().data.link, /^https:\/\/localhost\/join#/)
})

test('join: no audit row, no step (register and two-step login)', async () => {
  const ok = rig('admin')
  const token = (await ok.app.inject({ method: 'POST', url: '/api/users/invite', payload: { email: 'f@example.com', role: 'viewer' } })).json().data.link.split('#')[1]
  // A join page whose audit log cannot be written, on the same invitations.
  const fb = fakeBroker()
  const app2 = Fastify()
  app2.register(buildJoinRoutes({ broker: () => fb.broker, invitations: ok.invitations, audit: async () => { throw new Error('db down') } }), { prefix: '/api/auth/join' })
  const r = await app2.inject({ method: 'POST', url: '/api/auth/join/register', payload: { token, password: 'a long master password' } })
  assert.equal(r.statusCode, 503)
  const t = await app2.inject({ method: 'POST', url: '/api/auth/join/totp', payload: { token, password: 'a long master password', code: '123456' } })
  assert.equal(t.statusCode, 503)
  assert.equal(fb.calls.length, 0, 'the vault was not asked')
  assert.ok(ok.invitations.find(token), 'the link still works')
  assert.equal(ok.invitations.find(token)!.registeredAt, undefined)
})

test('join: the account counts as made as soon as it exists, so a failed sign-in after it is retried, not stuck', async () => {
  const { app, calls, invitations } = rig('admin', { faults: { loginFailsAfterRegister: true } })
  const token = (await app.inject({ method: 'POST', url: '/api/users/invite', payload: { email: 'f@example.com', role: 'viewer' } })).json().data.link.split('#')[1]
  const r = await app.inject({ method: 'POST', url: '/api/auth/join/register', payload: { token, password: 'a long master password' } })
  assert.equal(r.statusCode, 502)
  assert.ok(invitations.find(token)!.registeredAt, 'marked registered although the step after failed')
  await app.inject({ method: 'POST', url: '/api/auth/join/register', payload: { token, password: 'a long master password' } })
  assert.equal(calls.filter(c => c[0] === 'register').at(-1)![3], true, 'the retry does not register again')
})

test('withdraw: the link and the vault\'s invited membership both go; an operator\'s is the owner\'s', async () => {
  const o = rig('owner')
  const inv = await o.app.inject({ method: 'POST', url: '/api/users/invite', payload: { email: 'op2@example.com', role: 'operator' } })
  const token = inv.json().data.link.split('#')[1]
  const hash = o.invitations.find(token)!.hash
  // An admin (sharing the same store) may not withdraw an operator's invitation.
  const a = rig('admin')
  const shared = new InvitationStore(path.join(o.dir, 'invitations.json'))
  const appA = Fastify()
  appA.addHook('onRequest', async req => { (req as any).session = { sid: 'b'.repeat(32), role: 'admin', email: 'admin@example.com' } })
  appA.register(buildUserRoutes({ broker: () => a.broker, invitations: shared, audit: async () => undefined }), { prefix: '/api/users' })
  assert.equal((await appA.inject({ method: 'DELETE', url: `/api/users/invitations/${hash}` })).statusCode, 403)
  assert.equal(a.calls.some(c => c[0] === 'remove'), false)

  const r = await o.app.inject({ method: 'DELETE', url: `/api/users/invitations/${hash}` })
  assert.equal(r.statusCode, 200, r.body)
  assert.deepEqual(o.calls.find(c => c[0] === 'remove')!.slice(2), ['op2@example.com'])
  assert.equal(o.audits.at(-1)![0], 'users.invite.withdraw')
  assert.equal(o.invitations.find(token), null)
})

test('withdraw: when the vault cannot remove the membership, the link stays to be withdrawn again', async () => {
  const o = rig('owner', { faults: { removeFails: true } })
  const token = (await o.app.inject({ method: 'POST', url: '/api/users/invite', payload: { email: 'v@example.com', role: 'viewer' } })).json().data.link.split('#')[1]
  const hash = o.invitations.find(token)!.hash
  assert.equal((await o.app.inject({ method: 'DELETE', url: `/api/users/invitations/${hash}` })).statusCode, 502)
  assert.ok(o.invitations.find(token))
})

test('expiry: the next admin listing takes expired invitations out of the vault too (an operator\'s waits for the owner)', async () => {
  let t = Date.now()
  const o = rig('owner', { now: () => t })
  await o.app.inject({ method: 'POST', url: '/api/users/invite', payload: { email: 'late@example.com', role: 'viewer' } })
  await o.app.inject({ method: 'POST', url: '/api/users/invite', payload: { email: 'lateop@example.com', role: 'operator' } })
  t += INVITE_TTL_MS + 1
  // An admin's visit removes only the viewer's.
  const a = rig('admin')
  const shared = new InvitationStore(path.join(o.dir, 'invitations.json'), () => t)
  const appA = Fastify()
  const audA: string[] = []
  appA.addHook('onRequest', async req => { (req as any).session = { sid: 'b'.repeat(32), role: 'admin', email: 'admin@example.com' } })
  appA.register(buildUserRoutes({ broker: () => a.broker, invitations: shared, audit: async act => { audA.push(act) } }), { prefix: '/api/users' })
  const r = await appA.inject({ method: 'GET', url: '/api/users' })
  assert.equal(r.statusCode, 200)
  assert.deepEqual(r.json().data.invitations, [])
  assert.deepEqual(a.calls.filter(c => c[0] === 'remove').map(c => c[2]), ['late@example.com'])
  assert.deepEqual(audA, ['users.invite.expired'])
  assert.deepEqual(shared.expired().map(i => i.email), ['lateop@example.com'])
  // The owner's visit removes the operator's.
  await o.app.inject({ method: 'GET', url: '/api/users' })
  assert.deepEqual(o.calls.filter(c => c[0] === 'remove').map(c => c[2]), ['lateop@example.com'])
  assert.deepEqual(o.invitations.expired(), [])
})

test('the store skips a malformed stored hash instead of throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-users-'))
  const file = path.join(dir, 'i.json')
  const store = new InvitationStore(file)
  const { token } = store.create('ok@example.com', 'viewer', 'admin@example.com')
  const good = JSON.parse(fs.readFileSync(file, 'utf8'))
  const exp = new Date(Date.now() + 3_600_000).toISOString()
  fs.writeFileSync(file, JSON.stringify([
    { hash: 'abc', email: 'short@example.com', role: 'viewer', by: 'x', createdAt: exp, expiresAt: exp },
    { hash: 'zz'.repeat(32), email: 'nothex@example.com', role: 'viewer', by: 'x', createdAt: exp, expiresAt: exp },
    { hash: 12, email: 'num@example.com', role: 'viewer', by: 'x', createdAt: exp, expiresAt: exp },
    null,
    ...good,
  ]))
  assert.equal(store.find(token)?.email, 'ok@example.com')
  assert.equal(store.find('B'.repeat(43)), null)
})

// ---- removing someone who joined ---------------------------------------------------------------------------

test('remove a member: owner removes anyone but the owner; admin only a viewer; never yourself; audited first', async () => {
  const owner = rig('owner')
  let r = await owner.app.inject({ method: 'DELETE', url: `/api/users/${M3}` })
  assert.equal(r.statusCode, 200, r.body)
  assert.deepEqual(owner.calls.at(-1), ['remove-member', 'a'.repeat(32), M3])
  assert.equal(owner.audits.at(-1)![0], 'users.remove')
  r = await owner.app.inject({ method: 'DELETE', url: `/api/users/${M1}` })
  assert.equal(r.statusCode, 403, 'never the owner')

  const admin = rig('admin')
  r = await admin.app.inject({ method: 'DELETE', url: `/api/users/${M3}` })
  assert.equal(r.statusCode, 403, 'an operator is the owner\'s to remove')
  assert.ok(!admin.calls.some(c => c[0] === 'remove-member'))
  r = await admin.app.inject({ method: 'DELETE', url: `/api/users/${M2}` })
  assert.equal(r.statusCode, 200, 'a viewer: an admin may')

  const viewer = rig('viewer')
  r = await viewer.app.inject({ method: 'DELETE', url: `/api/users/${M2}` })
  assert.equal(r.statusCode, 403)
})

test('remove a member: no audit row, no change; an API token cannot', async () => {
  const x = rig('owner', { auditFails: true })
  const r = await x.app.inject({ method: 'DELETE', url: `/api/users/${M2}` })
  assert.equal(r.statusCode, 503)
  assert.ok(!x.calls.some(c => c[0] === 'remove-member'))
  const t = rig('owner', { token: true })
  assert.equal((await t.app.inject({ method: 'DELETE', url: `/api/users/${M2}` })).statusCode, 403)
})

test('removing a member is admin at least, with the master password re-entered', () => {
  assert.equal(requiredRole('DELETE', `/api/users/${M2}`), 'admin')
  assert.equal(needsReconfirm('DELETE', `/api/users/${M2}`), true)
})

test('removing someone, or changing their role, ends their live sessions at once', async () => {
  const x = rig('owner') as any
  let r = await x.app.inject({ method: 'DELETE', url: `/api/users/${M3}` })
  assert.equal(r.statusCode, 200, r.body)
  assert.deepEqual(x.ended.at(-1), { userId: 'u3', email: 'op@example.com' })
  assert.equal(r.json().data.signedOut, 1)
  r = await x.app.inject({ method: 'PUT', url: `/api/users/${M2}/role`, payload: { role: 'operator' } })
  assert.equal(r.statusCode, 200, r.body)
  assert.deepEqual(x.ended.at(-1), { userId: 'u2', email: 'new@example.com' })
  const refused = rig('owner', { faults: { ownerOnly: true } }) as any
  await refused.app.inject({ method: 'DELETE', url: `/api/users/${M3}` })
  assert.equal(refused.ended.length, 0, 'nothing ended when the vault refused')
})

test('endSessionsOf ends every session of that person, by user id or email, and nobody else\'s', async () => {
  const { addSession, allSessions, endSessionsOf, clearSessions } = await import('../src/lib/auth')
  clearSessions()
  addSession({ sid: 'a'.repeat(32), email: 'Op@Example.com', role: 'operator', userId: 'u3' })
  addSession({ sid: 'b'.repeat(32), email: 'op@example.com', role: 'operator', userId: 'u3' })
  addSession({ sid: 'c'.repeat(32), email: 'other@example.com', role: 'admin', userId: 'u9' })
  assert.deepEqual(endSessionsOf({ userId: null, email: 'op@example.com' }).length, 2)
  assert.deepEqual(allSessions().map(s => s.email), ['other@example.com'])
  addSession({ sid: 'd'.repeat(32), email: 'renamed@example.com', role: 'viewer', userId: 'u4' })
  assert.equal(endSessionsOf({ userId: 'u4', email: 'nobody@example.com' }).length, 1)
  clearSessions()
})
