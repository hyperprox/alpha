// Renewal timing. No fixed day counts: the same rule must hold for 90, 64 and 45-day certificates, and the
// CA's ARI window must win whenever it is offered.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renewAfter, dueForRenewal, JITTER_MS } from '../src/lib/certs/timing'

const DAY = 86_400_000
const T0 = new Date('2027-03-01T00:00:00Z')
const cert = (days: number) => ({ notBefore: T0, notAfter: new Date(T0.getTime() + days * DAY) })

test('without ARI: two thirds of the lifetime, for 90, 64 and 45-day certificates', () => {
  for (const days of [90, 64, 45]) {
    const at = renewAfter(cert(days), null, () => 0)
    assert.equal(at.getTime(), T0.getTime() + Math.floor(days * DAY * 2 / 3), `${days} days`)
  }
  assert.equal(renewAfter(cert(90), null, () => 0).toISOString(), '2027-04-30T00:00:00.000Z')
  assert.equal(renewAfter(cert(45), null, () => 0).toISOString(), '2027-03-31T00:00:00.000Z')
})

test('jitter delays by at most 12 hours and never past one day before expiry', () => {
  for (const days of [90, 64, 45, 7]) {
    const c = cert(days)
    const base = renewAfter(c, null, () => 0).getTime()
    const max = renewAfter(c, null, () => 0.999999).getTime()
    assert.ok(max >= base && max - base <= JITTER_MS, `${days} days: jitter ${max - base}`)
    assert.ok(max <= c.notAfter.getTime() - DAY, `${days} days: not in the last day`)
    for (let i = 0; i < 200; i++) {
      const t = renewAfter(c, null).getTime()
      assert.ok(t >= base && t <= max)
    }
  }
  // A 2-day certificate: two thirds is already inside the last day; the jitter must not make it later.
  const short = cert(2)
  assert.equal(renewAfter(short, null, () => 0.99).getTime(), renewAfter(short, null, () => 0).getTime())
})

test('with ARI: a moment inside the window, whatever the lifetime says', () => {
  const ari = { start: new Date('2027-04-10T00:00:00Z'), end: new Date('2027-04-12T00:00:00Z') }
  assert.equal(renewAfter(cert(90), ari, () => 0).toISOString(), ari.start.toISOString())
  assert.equal(renewAfter(cert(90), ari, () => 0.5).toISOString(), '2027-04-11T00:00:00.000Z')
  const late = renewAfter(cert(90), ari, () => 0.999999).getTime()
  assert.ok(late < ari.end.getTime() && late > ari.start.getTime())
  for (let i = 0; i < 200; i++) {
    const t = renewAfter(cert(90), ari).getTime()
    assert.ok(t >= ari.start.getTime() && t < ari.end.getTime())
  }
  // A CA asking for early renewal (mass revocation): the window is in the past, and that is honoured.
  const past = { start: new Date('2027-03-02T00:00:00Z'), end: new Date('2027-03-02T06:00:00Z') }
  assert.ok(renewAfter(cert(90), past, () => 0.5).getTime() < past.end.getTime())
  // A degenerate window (end not after start) means "from start".
  const flat = { start: new Date('2027-04-10T00:00:00Z'), end: new Date('2027-04-09T00:00:00Z') }
  assert.equal(renewAfter(cert(90), flat, () => 0.7).toISOString(), flat.start.toISOString())
})

test('dueForRenewal', () => {
  const na = new Date('2027-05-30T00:00:00Z'), ra = new Date('2027-04-30T00:00:00Z')
  assert.equal(dueForRenewal(new Date('2027-04-29T23:59:59Z'), ra, na), false)
  assert.equal(dueForRenewal(ra, ra, na), true)
  assert.equal(dueForRenewal(new Date('2027-05-01T00:00:00Z'), ra, na), true)
  assert.equal(dueForRenewal(new Date('2027-04-01T00:00:00Z'), null, null), true, 'never issued')
  assert.equal(dueForRenewal(new Date('2027-04-01T00:00:00Z'), null, na), true, 'no decision: renew rather than drift to expiry')
  assert.equal(dueForRenewal(new Date('2027-06-01T00:00:00Z'), new Date('2027-07-01T00:00:00Z'), na), true, 'expired beats a stale decision')
})
