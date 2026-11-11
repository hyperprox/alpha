// =============================================================================
//  HyperProx — site metrics: counting people without knowing who they are
//
//  A visitor is SHA-256(day salt, site, address, User-Agent), cut to 16 bytes.
//  The salt is 32 random bytes made for each UTC day and deleted two days
//  later, so after that nobody (HyperProx included) can work out which hash
//  belonged to which address, and the same person on two days, or on two of
//  your sites, cannot be linked. Addresses themselves are never stored.
//  A hash older than the salt is never recreated: a line that arrives after its
//  day's salt is gone still counts as a request, not as a visitor.
// =============================================================================

import { createHash, randomBytes } from 'node:crypto'

/** Days a salt is kept: today and yesterday (late lines from just after midnight still count). */
export const SALT_KEEP_DAYS = 2

export function makeSalt(): string { return randomBytes(32).toString('base64') }

export function visitorHash(salt: string, siteId: string, client: string, ua: string): string {
  return createHash('sha256').update(salt).update('\0').update(siteId).update('\0').update(client).update('\0').update(ua)
    .digest('hex').slice(0, 32)
}

/** True when `day` ("YYYY-MM-DD") is still inside the salt window that ends at `now`. */
export function saltDayAllowed(day: string, now: Date): boolean {
  const d = Date.parse(`${day}T00:00:00Z`)
  if (Number.isNaN(d)) return false
  const today = Math.floor(now.getTime() / 86_400_000) * 86_400_000
  return d <= today && d > today - SALT_KEEP_DAYS * 86_400_000
}
