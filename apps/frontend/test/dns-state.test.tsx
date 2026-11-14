// DNS page with no provider: an empty state ("Connect a DNS provider"), never "Failed to reach the DNS provider".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dnsLoadState, CONNECT_DNS_HREF } from '../lib/dns-state'

test('no provider connected is its own state, with the way to connect one', () => {
  const s = dnsLoadState(200, { success: true, configured: false, code: 'not_configured', message: 'No DNS provider is connected yet.', data: [] })
  assert.deepEqual(s, { kind: 'not-configured', message: 'No DNS provider is connected yet.' })
  // An older API answering 409 for the same reason reads the same.
  assert.equal(dnsLoadState(409, { success: false, configured: false, code: 'not_configured', error: 'x' }).kind, 'not-configured')
  assert.equal(CONNECT_DNS_HREF, '/settings?tab=dns')
})

test('domains are domains, and a real failure is still an error', () => {
  assert.deepEqual(dnsLoadState(200, { success: true, data: [{ domain: 'example.com' }] }), { kind: 'domains', domains: [{ domain: 'example.com' }] })
  assert.deepEqual(dnsLoadState(500, { success: false, error: 'GoDaddy 401' }), { kind: 'error', message: 'GoDaddy 401' })
  assert.equal(dnsLoadState(502, null).kind, 'error')
})
