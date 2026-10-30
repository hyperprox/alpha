// =============================================================================
//  HyperProx — server-held prepared payloads
//
//  Something the server worked out and checked (a deployment plan) is kept
//  here under an unguessable id, so a later request can name it instead of
//  sending it back. What the browser holds is only the id: the payload that
//  runs is always the server's own copy.
//
//  An entry belongs to the user it was made for, lives for a fixed time, and
//  can be taken exactly once.
// =============================================================================

import { randomUUID } from 'crypto'

export interface Prepared<T> { id: string; owner: string; createdAt: number; payload: T }

export class PreparedStore<T> {
  // A Map, not an object: an id such as "__proto__" must never find anything.
  private readonly entries = new Map<string, Prepared<T>>()

  constructor(
    private readonly ttlMs: number = 30 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Keeps `payload` for `owner` and returns the id that names it. */
  put(owner: string, payload: T): string {
    if (!owner) throw new Error('A prepared entry needs an owner')
    this.sweep()
    const id = randomUUID()
    this.entries.set(id, { id, owner, createdAt: this.now(), payload })
    return id
  }

  /**
   * Hands the entry over and forgets it. Null when the id is unknown, expired
   * or belongs to someone else; a wrong owner leaves the entry where it is, so
   * guessing at another user's id cannot use it up.
   */
  take(id: string, owner: string): Prepared<T> | null {
    if (typeof id !== 'string' || !owner) return null
    const entry = this.entries.get(id)
    if (!entry) return null
    if (this.expired(entry)) {
      this.entries.delete(id)
      return null
    }
    if (entry.owner !== owner) return null
    this.entries.delete(id)
    return entry
  }

  private expired(entry: Prepared<T>): boolean {
    return this.now() - entry.createdAt > this.ttlMs
  }

  private sweep(): void {
    for (const [id, entry] of this.entries) if (this.expired(entry)) this.entries.delete(id)
  }
}
