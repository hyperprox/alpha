// A certificate request makes NPM run certbot before it answers (20 to 60 seconds), so it gets a long limit; other
// writes a medium one; reads a short one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { npmTimeoutFor, NPM_READ_TIMEOUT_MS, NPM_WRITE_TIMEOUT_MS, NPM_CERT_TIMEOUT_MS, NPMClient, clearNpmTokens } from '../src/lib/npm-client'

test('limits by kind of request', () => {
  assert.equal(npmTimeoutFor('GET', 'http://npm/api/nginx/proxy-hosts'), NPM_READ_TIMEOUT_MS)
  assert.equal(npmTimeoutFor(undefined, 'http://npm/api/tokens'), NPM_READ_TIMEOUT_MS)
  assert.equal(npmTimeoutFor('POST', 'http://npm/api/nginx/proxy-hosts'), NPM_WRITE_TIMEOUT_MS)
  assert.equal(npmTimeoutFor('DELETE', 'http://npm/api/nginx/certificates/3'), NPM_WRITE_TIMEOUT_MS)
  assert.equal(npmTimeoutFor('POST', 'http://npm/api/nginx/certificates'), NPM_CERT_TIMEOUT_MS)
  assert.ok(NPM_CERT_TIMEOUT_MS >= 180_000)
})

test('the client gives each try a signal, and a caller\'s own signal wins', async () => {
  clearNpmTokens()
  const seen: Array<AbortSignal | null | undefined> = []
  const fake = async (url: string, init?: RequestInit) => {
    seen.push(init?.signal)
    return new Response(JSON.stringify(url.endsWith('/tokens') ? { token: 't', expires: new Date(Date.now() + 3600_000).toISOString() } : []), { status: 200 })
  }
  const c = new NPMClient('http://npm.example', 'a@b.c', 'pw', fake as any)
  await (c as any).get('/nginx/proxy-hosts')
  assert.ok(seen.length >= 2 && seen.every(s => s instanceof AbortSignal))
})
