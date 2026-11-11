// The owner's two-step login is checked through the vault's admin API, and that check fails closed: an admin API
// that cannot answer, or does not know the account, refuses the owner rather than waving them through.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getBroker, setBroker } from '../src/lib/vault/broker'

test('ownerHasTwoFactor: on only when the admin API says so', async () => {
  setBroker(null as any)
  const b: any = getBroker()
  const check = (admin: any) => { b.admin = () => admin; return b.ownerHasTwoFactor('owner@example.com') }
  assert.equal(await check({ userByEmail: async () => ({ twoFactorEnabled: true }) }), true)
  assert.equal(await check({ userByEmail: async () => ({ twoFactorEnabled: false }) }), false)
  assert.equal(await check({ userByEmail: async () => null }), false, 'an account the admin API does not know')
  assert.equal(await check({ userByEmail: async () => { throw new Error('admin API down') } }), false, 'the admin API failing')
  assert.equal(await check(null), true, 'no admin token at all: cannot check (older install), as before')
})
