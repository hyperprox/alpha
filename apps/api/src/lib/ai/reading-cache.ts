// =============================================================================
//  HyperProx — the assistant's kept readings of slow areas
//
//  The last good reading of each knowledge source, keyed by who asked (their
//  role), the cluster the source is bound to, and the source; and the reads in
//  flight under the same key, so two questions at once read a slow area once.
//  Cleared when HyperProx locks, and per cluster or per area when one is
//  removed, so nothing read before can be served after. No imports: the vault,
//  the cluster registry and the plug-in routes can all clear it.
// =============================================================================

export interface Kept<T> { at: number; sum: T }

const kept = new Map<string, Kept<unknown>>()
const inflight = new Map<string, Promise<unknown>>()

export const readingKey = (who: string, scope: string, id: string) => `${who}|${scope}|${id}`

export function keptReading<T>(key: string): Kept<T> | undefined { return kept.get(key) as Kept<T> | undefined }
export function keepReading<T>(key: string, sum: T, at: number): void { kept.set(key, { at, sum }) }

export function readInFlight<T>(key: string): Promise<T> | undefined { return inflight.get(key) as Promise<T> | undefined }
export function trackRead<T>(key: string, p: Promise<T>): Promise<T> {
  inflight.set(key, p)
  const done = () => { if (inflight.get(key) === p) inflight.delete(key) }
  p.then(done, done)
  return p
}

/** Forget every kept reading (the vault locked), or only one cluster's (`scope`) or one area's (`id`). */
export function forgetReadings(match: { scope?: string; id?: string } = {}): void {
  for (const key of [...kept.keys()]) {
    const [, scope, id] = key.split('|')
    if ((match.scope === undefined || scope === match.scope) && (match.id === undefined || id === match.id)) kept.delete(key)
  }
}
