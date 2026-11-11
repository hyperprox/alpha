// A ';' in the path once let the router serve a route the role and re-confirm checks did not recognise.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { unsafeRequestPath, needsReconfirm } from '../src/lib/roles'

test('a semicolon anywhere in the path is refused', () => {
  for (const u of ['/api/secrets/reveal;x', '/api/auth/tokens;', '/health;x', '/api/infra/guest-config/apply;a=b?x=1', '/api/secrets/reveal%3Bx', '/api/plugins/qnap/instances%3b'])
    assert.equal(unsafeRequestPath(u), true, u)
})

test('ordinary paths and queries are unaffected', () => {
  for (const u of ['/api/secrets/reveal', '/api/dns/domains/example.com/records?type=A', '/health'])
    assert.equal(unsafeRequestPath(u), false, u)
})

test('the re-confirm check still recognises the clean route', () => {
  assert.equal(needsReconfirm('POST', '/api/secrets/reveal'), true)
})
