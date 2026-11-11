// '../' in a record type or domain once walked GoDaddy requests to other endpoints (the domain object with its transfer code).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkedDomain, checkedType } from '../src/lib/godaddy-client'
import { publicRecord } from '../src/routes/dns'

test('record types are an allowlist', () => {
  assert.equal(checkedType('a'), 'A')
  for (const t of ['../../example.com', 'A/../..', '%2e%2e', '', 'ANY']) assert.throws(() => checkedType(t), t)
})

test('domains must be plain hostnames', () => {
  assert.equal(checkedDomain('Example.COM'), 'example.com')
  for (const d of ['../../example.com', 'example.com/..', 'example.com?x=1', 'example.com#a', '..', 'a b.com', 'example', '']) assert.throws(() => checkedDomain(d), d)
})

test('records keep only DNS fields', () => {
  const r = publicRecord({ type: 'A', name: '@', data: '10.0.0.1', ttl: 600, authCode: 'SECRET', contactRegistrant: { email: 'x@example.com' } })
  assert.deepEqual(Object.keys(r).sort(), ['data', 'name', 'ttl', 'type'])
})
