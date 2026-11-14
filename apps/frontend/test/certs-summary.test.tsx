// Certificates on a fresh install: nothing is called healthy before it was checked live.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { certsHeadline, endpointsEmpty } from '../lib/certs-summary'

const ok = (n: number) => Array.from({ length: n }, () => ({ verdict: 'ok', daysLeft: 300 }))

test('never checked: not "healthy", and says the first check is running', () => {
  assert.equal(certsHeadline({ inventory: ok(5), probes: [], managed: [], checkedAt: null }, null), '5 certificates found, not checked yet')
  assert.equal(certsHeadline({ inventory: ok(5), probes: [], managed: [], checkedAt: null, checking: true }, null), 'Checking 5 certificates for the first time')
  assert.equal(endpointsEmpty({ checking: true, checkedAt: null }), 'Checking the endpoints HyperProx found, for the first time...')
})

test('checked: healthy only when something was checked and all is ok; failures and problems first', () => {
  const probes = [{}]
  assert.equal(certsHeadline({ inventory: ok(2), probes, managed: [], checkedAt: '2026-11-14T00:00:00Z' }, null), 'Every certificate is healthy')
  assert.equal(certsHeadline({ inventory: [{ verdict: 'warn', daysLeft: 10 }], probes, managed: [], checkedAt: 'x' }, null), '1 certificate needs a look')
  assert.equal(certsHeadline({ inventory: [{ verdict: 'critical', daysLeft: 1 }], probes: [], managed: [], checkedAt: null }, null), '1 certificate is failing')
  assert.equal(certsHeadline({ inventory: [], probes: [], managed: [], checkedAt: 'x' }, null), 'No certificates found yet')
  assert.equal(certsHeadline(null, 'down'), 'Certificates unavailable')
})
