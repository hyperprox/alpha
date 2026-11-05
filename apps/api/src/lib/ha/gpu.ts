// =============================================================================
//  HyperProx — HA: how a guest's GPU follows it (or does not) to another node
//
//  "Portable GPU" (Infrastructure) gives a guest the GPU of whichever node it
//  runs on. The HA note reads that through this one function, so HA does not
//  depend on how Portable GPU stores its setup. Until the integrator wires it,
//  the stub says "not portable", which is true of every guest today.
// =============================================================================

import type { HaGuest } from './types'

export type GpuPortability =
  | { portable: true; perNode: Record<string, string | null> }
  | { portable: false }

export type GpuPortabilityFn = (guest: HaGuest) => GpuPortability

const stub: GpuPortabilityFn = () => ({ portable: false })
let impl: GpuPortabilityFn = stub

export function gpuPortability(guest: HaGuest): GpuPortability {
  try { return impl(guest) } catch { return { portable: false } }
}

/** Integrator: setGpuPortability(g => ...) from the Portable GPU feature. null puts the stub back. */
export function setGpuPortability(fn: GpuPortabilityFn | null) { impl = fn ?? stub }
