// =============================================================================
//  HyperProx — Certificates: renewal timing
//
//  No fixed day counts anywhere: lifetimes are going from 90 days to 64 and
//  then 45, and a rule like "renew 30 days before expiry" breaks the moment
//  that happens. The CA's ARI window wins when it offers one (it is also how a
//  CA asks for early renewal before a mass revocation); otherwise renew at two
//  thirds of the lifetime. Jitter spreads renewals so a fleet of certificates
//  issued together does not hit the CA together.
// =============================================================================

const HOUR = 3_600_000
const DAY = 24 * HOUR
export const JITTER_MS = 12 * HOUR

/** When to renew. `rand` returns [0, 1); injectable for tests. */
export function renewAfter(
  c: { notBefore: Date; notAfter: Date },
  ari: { start: Date; end: Date } | null,
  rand: () => number = Math.random,
): Date {
  if (ari) {
    const s = ari.start.getTime(), e = ari.end.getTime()
    // RFC 9773: a window whose end is not after its start means "renew from start".
    if (!(e > s)) return new Date(s)
    return new Date(s + Math.floor(rand() * (e - s)))
  }
  const nb = c.notBefore.getTime(), na = c.notAfter.getTime()
  const base = nb + Math.floor((na - nb) * 2 / 3)
  // The jitter only ever delays, so it must not push renewal into the last day of a short certificate.
  const latest = Math.max(base, na - DAY)
  return new Date(Math.min(base + Math.floor(rand() * JITTER_MS), latest))
}

/**
 * Is it time to issue? True with no certificate at all, with no renewal time decided (an unknown state is
 * resolved by renewing, never by waiting for expiry), once the decided time has passed, and once expired.
 */
export function dueForRenewal(now: Date, renewAfterAt: Date | null, notAfter: Date | null): boolean {
  if (!notAfter) return true
  if (now.getTime() >= notAfter.getTime()) return true
  if (!renewAfterAt) return true
  return now.getTime() >= renewAfterAt.getTime()
}
