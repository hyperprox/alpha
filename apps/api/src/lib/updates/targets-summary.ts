// =============================================================================
//  HyperProx — Updates: the target tree as last read, for the AI assistant
//
//  A seam with no imports beyond types, like check-summary.ts: the assistant can answer "what updates does X
//  have" from what the Updates page last read, without importing the feature and without touching any machine.
// =============================================================================

import type { UpdatesTargetTree } from './types'

let source: ((clusterId: string) => UpdatesTargetTree | null) | null = null

/** Set once by the Updates routes. */
export function setTargetsSource(fn: ((clusterId: string) => UpdatesTargetTree | null) | null): void { source = fn }

/** A cluster's targets from its last inventory read, or null when none has been read (or Updates is not loaded). */
export function lastTargets(clusterId: string): UpdatesTargetTree | null {
  try { return source?.(clusterId) ?? null } catch { return null }
}
