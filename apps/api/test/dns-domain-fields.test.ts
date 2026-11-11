// A registrar's domain answer carries the transfer code and the registrant's contact details; neither may reach a browser.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { publicDomain, DOMAIN_FIELDS } from '../src/routes/dns'

const raw = {
  domain: 'example.com', domainId: 1, status: 'ACTIVE', expires: '2027-01-01T00:00:00Z', renewAuto: true, locked: true,
  authCode: 'SECRET-TRANSFER-CODE',
  contactRegistrant: { nameFirst: 'Alex', email: 'alex@example.com', phone: '+1.5555550100', addressMailing: { address1: '1 Main St' } },
  contactAdmin: { email: 'a@example.com' }, contactBilling: {}, contactTech: {},
}

test('the transfer code and every contact are dropped', () => {
  const out = publicDomain(raw)
  const text = JSON.stringify(out)
  assert.ok(!('authCode' in out))
  assert.ok(!/contact/i.test(text))
  assert.ok(!text.includes('SECRET-TRANSFER-CODE') && !text.includes('alex@example.com') && !text.includes('Main St'))
})

test('the fields the DNS page uses are kept', () => {
  const out = publicDomain(raw)
  for (const k of ['domain', 'status', 'expires', 'renewAuto', 'locked']) assert.equal(out[k], (raw as any)[k])
  assert.ok(!(DOMAIN_FIELDS as readonly string[]).includes('authCode'))
})
