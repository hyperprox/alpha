// Settings → Users and the join page: who may hand out which role, what each member row offers, the
// fingerprint check before confirming, and reading the join link's token from its fragment.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canRemove, grantableBy, managesRole, memberState, sameFingerprint, joinToken, type Member } from '../lib/users-view'

const m = (over: Partial<Member>): Member => ({ id: 'x', email: 'a@example.com', name: null, role: 'viewer', status: 'confirmed', twoFactor: true, fingerprint: null, ...over })
const FP = '0a1b-2c3d-4e5f-6a7b-8c9d-0e1f-2a3b-4c5d'

test('who may grant what: the owner adds anyone, an admin adds viewers (the vault\'s rule), others nobody', () => {
  assert.deepEqual(grantableBy('owner'), ['admin', 'operator', 'viewer'])
  assert.deepEqual(grantableBy('admin'), ['viewer'])
  assert.deepEqual(grantableBy('operator'), [])
  assert.deepEqual(grantableBy(undefined), [])
})

test('a member row: confirm only once they joined with two-step login and their key is known', () => {
  assert.equal(memberState(m({ status: 'confirmed' })).words, 'active')
  assert.equal(memberState(m({ status: 'invited' })).canConfirm, false)
  assert.equal(memberState(m({ status: 'accepted', twoFactor: false, fingerprint: FP })).canConfirm, false)
  assert.equal(memberState(m({ status: 'accepted', twoFactor: true, fingerprint: FP })).canConfirm, true)
})

test('the fingerprint must match exactly, however it is typed', () => {
  assert.equal(sameFingerprint(FP.toUpperCase().replace(/-/g, ' '), FP), true)
  assert.equal(sameFingerprint(FP.slice(0, -1) + 'e', FP), false)
  assert.equal(sameFingerprint('', FP), false)
  assert.equal(sameFingerprint(FP, null), false)
})

test('the join token comes from the fragment, and only a well-formed one', () => {
  const t = 'A'.repeat(43)
  assert.equal(joinToken(`#${t}`), t)
  assert.equal(joinToken('#short'), null)
  assert.equal(joinToken(''), null)
})

test('confirming or withdrawing an operator or admin is the owner\'s; an admin handles viewers', () => {
  assert.equal(managesRole('owner', 'admin'), true)
  assert.equal(managesRole('owner', 'operator'), true)
  assert.equal(managesRole('admin', 'viewer'), true)
  assert.equal(managesRole('admin', 'operator'), false)
  assert.equal(managesRole('admin', 'admin'), false)
  assert.equal(managesRole('operator', 'viewer'), false)
  assert.equal(managesRole(undefined, 'viewer'), false)
})

test('who can remove whom: never the owner or yourself; an admin removes viewers, the owner anyone else', () => {
  const v = { role: 'viewer', status: 'confirmed' } as const
  const op = { role: 'operator', status: 'confirmed' } as const
  assert.equal(canRemove('owner', op, false), true)
  assert.equal(canRemove('owner', { role: 'owner', status: 'confirmed' }, false), false)
  assert.equal(canRemove('admin', v, false), true)
  assert.equal(canRemove('admin', op, false), false)
  assert.equal(canRemove('admin', v, true), false, 'never yourself')
  assert.equal(canRemove('viewer', v, false), false)
  assert.equal(canRemove('owner', { role: 'viewer', status: 'invited' }, false), false, 'an invitation is withdrawn instead')
})
