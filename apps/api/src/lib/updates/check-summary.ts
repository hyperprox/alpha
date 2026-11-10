// =============================================================================
//  HyperProx — Updates: the daily check's stored result, for the Command center
//
//  A tiny seam with no imports beyond types, so lib/clusters/overview.ts can show "updates available" per
//  cluster without importing the Updates feature (and without touching any machine on page load).
// =============================================================================

import type { UpdatesCheckCluster } from './types'

let source: ((clusterId: string) => UpdatesCheckCluster | null) | null = null

/** Set once by the Updates routes when the checker is created. */
export function setCheckSummarySource(fn: ((clusterId: string) => UpdatesCheckCluster | null) | null): void { source = fn }

/** The last check's result for a cluster, or null when no check has run (or Updates is not loaded). */
export function checkSummary(clusterId: string): UpdatesCheckCluster | null {
  try { return source?.(clusterId) ?? null } catch { return null }
}
