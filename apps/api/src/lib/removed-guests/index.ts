// =============================================================================
//  HyperProx — removed guests: the one service
//
//  Built once (lib/services/bootstrap.ts starts its timer); the routes and the
//  guest delete only resolve it.
// =============================================================================

import type { LogLike } from '../log-once'
import { RemovedGuestsService } from './service'
import { productionRemovedGuests } from './production'

export * from './service'
export { holdingsFor, cleanUp, noticeWords, type Holding, type HoldingDeps, type CleanChoice, type CleanResult } from './holdings'
export type { RemovedGuest } from './detector'

let svc: RemovedGuestsService | null = null
let prismaRef: unknown = null

export function removedGuests(prisma?: unknown, log?: LogLike): RemovedGuestsService {
  if (prisma) prismaRef = prisma
  return svc ?? (svc = productionRemovedGuests(prismaRef, log))
}

/** For tests (or null to build the production one again). */
export function setRemovedGuests(s: RemovedGuestsService | null): void { svc = s }
