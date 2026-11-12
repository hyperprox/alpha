// The Cloudflare client over a pretend Cloudflare: token verify (ok, invalid, expired, disabled), a fresh
// account with no zones, pagination, 429 retries, error arrays as plain sentences, and ids checked before
// they reach a URL path. Nothing here talks to the real Cloudflare.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CloudflareClient, CloudflareError, checkedId, cfErrorMessage, testCloudflare, CLOUDFLARE_API } from '../src/lib/cloudflare-client'
import { cloudflareFrom, GLOBAL_KEY_RE } from '../src/lib/dns-providers'
import { FakeCloudflare } from './fakes/cloudflare'

const client = (cf: FakeCloudflare, token = cf.validToken) => new CloudflareClient({ token }, { fetch: cf.fetch, sleep: async () => {} })

test('verify: an active token on a fresh account with no zones is a success, not an error', async () => {
  const cf = new FakeCloudflare()
  const t = await testCloudflare(client(cf))
  assert.equal(t.ok, true)
  assert.equal(t.message, 'Token works, but this account has no domains yet.')
  assert.deepEqual(t.zones, [])
  assert.ok(t.details.some(d => /Zone: Read works \(0 zones listed\)/.test(d)))
  assert.ok(t.details.some(d => /DNS: Edit/.test(d)), 'says which permissions to give')
  assert.equal(t.permissions, null, 'a DNS token cannot read its own permissions')
  assert.deepEqual(cf.calls.map(c => new URL(c.url).pathname), ['/client/v4/user/tokens/verify', '/client/v4/zones', `/client/v4/user/tokens/${cf.token.id}`])
  assert.ok(cf.calls.every(c => c.auth === `Bearer ${cf.validToken}`), 'Bearer token on every call')
})

test('verify: zones are counted across pages, and readable permissions are shown', async () => {
  const cf = new FakeCloudflare()
  for (const n of ['example.com', 'example.net', 'example.org']) cf.addZone(n)
  cf.addZone('pending.example.com', 'pending')
  cf.permissions = ['Zone Read', 'DNS Write']
  const t = await testCloudflare(client(cf))
  assert.equal(t.message, 'Token works: 4 zones (example.com, example.net, example.org, pending.example.com).')
  assert.deepEqual(t.permissions, ['Zone Read', 'DNS Write'])
  assert.ok(t.details.some(d => /Permissions: Zone Read, DNS Write/.test(d)))
  assert.ok(t.details.some(d => /pending\.example\.com \(pending\)/.test(d)), 'a zone waiting on nameservers is named')
  assert.equal(cf.calls.filter(c => new URL(c.url).pathname === '/client/v4/zones').length, 2, 'two pages of two')
})

test('verify: an invalid token is a plain error from Cloudflare\'s error array', async () => {
  const cf = new FakeCloudflare()
  await assert.rejects(testCloudflare(client(cf, 'wrong-token')), (e: any) => e instanceof CloudflareError && e.message === 'Invalid API Token (code 1000)' && e.statusCode === 400)
})

test('verify: an expired or disabled token is refused with a sentence, before any zone is listed', async () => {
  const cf = new FakeCloudflare()
  cf.token.status = 'expired'
  await assert.rejects(testCloudflare(client(cf)), /has expired/)
  cf.token.status = 'active'; cf.token.expires_on = '2020-01-01T00:00:00Z'
  await assert.rejects(testCloudflare(client(cf)), /has expired \(2020-01-01\)/)
  cf.token.expires_on = null; cf.token.status = 'disabled'
  await assert.rejects(testCloudflare(client(cf)), /is disabled, not active/)
  assert.ok(!cf.calls.some(c => new URL(c.url).pathname === '/client/v4/zones'))
})

test('a 429 is retried after Retry-After, then reported as a rate limit', async () => {
  const cf = new FakeCloudflare()
  cf.addZone('example.com')
  const waits: number[] = []
  const c = new CloudflareClient({ token: cf.validToken }, { fetch: cf.fetch, sleep: async ms => { waits.push(ms) } })
  cf.rateLimit = 2; cf.retryAfter = '3'
  assert.equal((await c.listZones()).length, 1)
  assert.deepEqual(waits, [3000, 3000])
  cf.rateLimit = 5
  await assert.rejects(c.listZones(), /rate limit reached/)
})

test('error arrays become one sentence; an empty one names the status', () => {
  assert.equal(cfErrorMessage({ errors: [{ code: 81057, message: 'Record already exists.' }, { code: 9005, message: 'Content  for A record\nis invalid.' }] }),
    'Record already exists. (code 81057); Content for A record is invalid. (code 9005)')
  assert.equal(cfErrorMessage({ errors: [{ code: 1004, message: 'DNS Validation Error', error_chain: [{ code: 9021, message: 'Invalid TTL' }] }] }), 'DNS Validation Error: Invalid TTL (code 1004)')
  assert.equal(cfErrorMessage(null, 503), 'Cloudflare answered HTTP 503')
  assert.equal(cfErrorMessage({ errors: [] }), 'Cloudflare gave no answer')
})

test('ids are 32 hex characters before they reach a path; anything else is refused without a request', async () => {
  assert.equal(checkedId('0123456789ABCDEF0123456789abcdef'), '0123456789abcdef0123456789abcdef')
  for (const bad of ['../user', '..%2f..%2fuser', '0123456789abcdef0123456789abcde', 'x'.repeat(32), '', '0123456789abcdef0123456789abcdef/../../user'])
    assert.throws(() => checkedId(bad), CloudflareError, bad)
  const cf = new FakeCloudflare()
  const c = client(cf)
  await assert.rejects(c.listRecords('../../user/tokens'), /not a Cloudflare zone id/)
  await assert.rejects(c.deleteRecord(cf.addZone('example.com').id, '../../../zones'), /not a Cloudflare record id/)
  assert.equal(cf.calls.length, 0)
})

test('filters go in the query string, encoded, never in the path', async () => {
  const cf = new FakeCloudflare()
  const z = cf.addZone('example.com')
  await client(cf).listRecords(z.id, { type: 'A', name: 'a&b=c/../x.example.com' })
  const u = new URL(cf.calls[0].url)
  assert.equal(u.origin + u.pathname, `${CLOUDFLARE_API}/zones/${z.id}/dns_records`)
  assert.equal(u.searchParams.get('name'), 'a&b=c/../x.example.com')
})

test('credentials: a token, or a Global API Key only when it has a key\'s shape and an email is set', async () => {
  assert.equal(cloudflareFrom({}), null)
  assert.equal(cloudflareFrom({ api_token: '  ' }), null)
  assert.equal(cloudflareFrom({ api_token: 'cf-token-good-0000000000000000000000000' })!.authKind, 'token')
  assert.equal(cloudflareFrom({ api_token: 'cf-token-good-0000000000000000000000000', email: 'admin@example.com' })!.authKind, 'token', 'an email beside a token is ignored')
  const key = 'a'.repeat(37)
  assert.ok(GLOBAL_KEY_RE.test(key))
  assert.equal(cloudflareFrom({ api_token: key, email: 'admin@example.com' })!.authKind, 'global-key')
  assert.equal(cloudflareFrom({ api_token: key })!.authKind, 'token', 'no email: treated as a token')
  // A Global API Key is checked with GET /user, sent as X-Auth-Email + X-Auth-Key.
  const cf = new FakeCloudflare()
  const t = await testCloudflare(cloudflareFrom({ api_token: key, email: 'admin@example.com' }, { fetch: cf.fetch })!)
  assert.equal(t.ok, true)
  assert.equal(new URL(cf.calls[0].url).pathname, '/client/v4/user')
  assert.equal(cf.calls[0].auth, `key:admin@example.com:${key}`)
  assert.throws(() => new CloudflareClient({ token: 'two words' }), /malformed/)
  assert.throws(() => new CloudflareClient({ globalKey: key, email: 'a@example.com\r\nX: y' }), /malformed/)
})
