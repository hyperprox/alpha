// =============================================================================
//  HyperProx — sign-in and re-confirmation limits
//
//  Two limits, so that one client cannot lock everyone out and many clients cannot take turns at one account:
//    per client address  @fastify/rate-limit on the route (10 a minute), keyed by req.ip. The API trusts
//                        X-Forwarded-For only from nginx on loopback (lib/server-options.ts), so req.ip is the
//                        browser's address, not nginx's: before that, every client shared one bucket.
//    per account         failed attempts for one email (or one session's re-confirmation) in a window, here,
//                        whatever address they come from. A success clears it.
//  In memory: a restart clears both, as it ends every session anyway.
// =============================================================================

export class AttemptLimiter {
  private failures = new Map<string, number[]>()
  constructor(readonly max: number, readonly windowMs: number, private now: () => number = Date.now) {}

  private recent(key: string): number[] {
    const since = this.now() - this.windowMs
    const list = (this.failures.get(key) ?? []).filter(t => t > since)
    if (list.length) this.failures.set(key, list)
    else this.failures.delete(key)
    return list
  }

  /** Seconds until another attempt is allowed, or 0 when one is allowed now. */
  retryAfter(key: string): number {
    const list = this.recent(key)
    if (list.length < this.max) return 0
    return Math.max(1, Math.ceil((list[list.length - this.max] + this.windowMs - this.now()) / 1000))
  }

  fail(key: string): void {
    const list = this.recent(key)
    list.push(this.now())
    this.failures.set(key, list.slice(-this.max * 2))
  }

  clear(key: string): void { this.failures.delete(key) }
  reset(): void { this.failures.clear() }
}

/** Failed sign-ins per account: 20 in 15 minutes, from any number of addresses. */
export const signInLimiter = new AttemptLimiter(20, 15 * 60_000)
/** Wrong master passwords per signed-in person at re-confirmation: 10 in 15 minutes. */
export const reconfirmLimiter = new AttemptLimiter(10, 15 * 60_000)
