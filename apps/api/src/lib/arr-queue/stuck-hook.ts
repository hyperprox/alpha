// =============================================================================
//  HyperProx — Arr Stack, how many requests need a person
//
//  The summary counts failed requests and faults in Seerr's own links together with the stuck downloads. The
//  requests service registers its counter here when the server starts (lib/arr-requests/production.ts), so the plug-in
//  and the queue route can ask without importing it (it imports the plug-in list, which imports them). With nothing
//  registered, as in a test or a build without the requests service, the answer is 0.
// =============================================================================

let counter: () => number = () => 0

export function registerRequestsStuck(fn: () => number): void { counter = fn }

export function requestsStuckCount(): number {
  try { const n = counter(); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0 } catch { return 0 }
}
