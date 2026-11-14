// The invite page (/join#<token>) must work with no session: AppShell wraps it in SessionProvider, which used to
// send every page but /login to sign in, and the bounce threw the #token away.
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/*.test.tsx
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPublicPath, signInRedirect } from '../lib/session'

const signedOut = { locked: false, bootstrapped: true, reachable: true }
const locked = { locked: true, bootstrapped: true, reachable: true }

test('/join with no session stays on the page, so its #token is kept', () => {
  assert.equal(signInRedirect(signedOut, '/join'), null)
  assert.equal(signInRedirect(locked, '/join'), null)
  assert.ok(isPublicPath('/join'))
  assert.ok(isPublicPath('/login'))
})

test('a private page with no session still goes to sign in, with where it was', () => {
  assert.equal(signInRedirect(signedOut, '/dashboard'), '/login?next=%2Fdashboard')
  assert.equal(signInRedirect(locked, '/'), '/login?locked=1')
  assert.equal(isPublicPath('/joined'), false)
})

test('signed in, or status not read yet: nobody moves', () => {
  assert.equal(signInRedirect(null, '/dashboard'), null)
  assert.equal(signInRedirect({ ...signedOut, user: { email: 'a@example.com', role: 'viewer' } }, '/dashboard'), null)
})
