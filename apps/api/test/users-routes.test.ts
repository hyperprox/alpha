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
import { keyFingerprint, memberTypeFor, memberStatus } from '../src/lib/vault/members'
import { requiredRole, needsReconfirm } from '../src/lib/roles'
import { VaultAuthError, type Role, type VaultBroker } from '../src/lib/vault/broker'
import type { VaultMember, GrantableRole } from '../src/lib/vault/members'

const M1 = '11111111-1111-4111-8111-111111111111'
const M2 = '22222222-2222-4222-8222-222222222222'
const FP = keyFingerprint(Buffer.from('a public key'))

function fakeBroker() {
  const calls: Array<[string, ...unknown[]]> = []
  const members: VaultMember[] = [
    { id: M1, userId: 'u1', email: 'owner@example.com', name: null, role: 'owner', status: 'confirmed', twoFactor: true, fingerprint: null },
    { id: M2, userId: 'u2', email: 'new@example.com', name: null, role: 'viewer', status: 'accepted', twoFactor: true, fingerprint: FP },
  ]
  const b: Partial<VaultBroker> = {
    members: async sid => { calls.push(['members', sid]); return members },
    inviteMember: async (sid, email, role) => { calls.push(['invite', sid, email, role]) },
    confirmMember: async (sid, id, fp) => { calls.push(['confirm', sid, id, fp]) },
    setMemberRole: async (sid, id, role) => { calls.push(['role', sid, id, role]) },
    registerInvitee: async (email, pw, opts) => { calls.push(['register', email, pw.length, !!opts?.alreadyRegistered]); return { totpSecret: 'S', otpauthUri: `otpauth://totp/HyperProx:${email}?secret=S`, fingerprint: FP } },
    confirmInviteeTotp: async (email, _pw, code) => { calls.push(['totp', email, code]); if (code !== '123456') throw new VaultAuthError('totp_invalid') },
  }
  return { broker: b as VaultBroker, calls }
}

function rig(role: Role, opts: { token?: boolean; auditFails?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-users-'))
  const invitations = new InvitationStore(path.join(dir, 'invitations.json'))
  const { broker, calls } = fakeBroker()
  const audits: Array<[string, string, Record<string, unknown> | undefined]> = []
  const audit = async (a: string, r: string, d?: Record<string, unknown>) => { if (opts.auditFails) throw new Error('db down'); audits.push([a, r, d]) }
  const app = Fastify()
  app.addHook('onRequest', async req => {
    if (req.url.startsWith('/api/users')) (req as any).session = { sid: opts.token ? 'token:t1' : 'a'.repeat(32), role, email: `${role}@example.com` }
  })
  app.register(buildUserRoutes({ broker: () => broker, invitations, audit }), { prefix: '/api/users' })
  app.register(buildJoinRoutes({ broker: () => broker, invitations, audit }), { prefix: '/api/auth/join' })
  return { app, calls, audits, invitations, dir }
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
  assert.equal(r.json().data.members.length, 2)
  assert.equal(r.json().data.mail, false)
  assert.equal((await rig('viewer').app.inject({ method: 'GET', url: '/api/users' })).statusCode, 403)
  assert.equal((await rig('admin', { token: true }).app.inject({ method: 'GET', url: '/api/users' })).json().code, 'token_refused')
})

test('invite: a copyable link with the token in the fragment, only its hash kept, audited first', async () => {
  const { app, calls, audits, invitations, dir } = rig('admin')
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
  const { app, calls, invitations } = rig('admin')
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
