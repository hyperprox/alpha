// Settings → Secrets delete: the button arms only on the exact name, and each API answer means one thing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deleteArmed, deleteOutcome } from '../lib/vault-delete'

test('armed only when the name is typed exactly', () => {
  assert.equal(deleteArmed('', 'router-admin'), false)
  assert.equal(deleteArmed('router', 'router-admin'), false)
  assert.equal(deleteArmed('Router-admin', 'router-admin'), false)
  assert.equal(deleteArmed(' router-admin ', 'router-admin'), true)
  assert.equal(deleteArmed('', ''), false)
})

test('answers: done, re-confirm, error', () => {
  assert.equal(deleteOutcome({ ok: true, status: 200 }, 'x').kind, 'done')
  assert.equal(deleteOutcome({ ok: false, status: 403, code: 'reconfirm_required' }, 'x').kind, 'reconfirm')
  const managed = deleteOutcome({ ok: false, status: 400, code: 'managed', error: 'This is one of HyperProx\'s own settings.' }, 'x')
  assert.deepEqual(managed, { kind: 'error', message: 'This is one of HyperProx\'s own settings.' })
  assert.equal(deleteOutcome({ ok: false, status: 403, code: 'forbidden', error: 'This needs the admin role' }, 'x').kind, 'error')
})
