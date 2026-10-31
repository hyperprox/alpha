// =============================================================================
//  HyperProx — Unlock snapshot parts
//
//  With a keyholder (./keyholder.ts), everything an API restart would otherwise
//  lose is put in one snapshot held by the keyholder: the signing key and the
//  secrets cache (./state.ts), the signed-in sessions (../auth.ts) and the vault
//  sessions (./broker.ts). Each module registers its own part here, and calls
//  snapshotChanged() when its part changes, so state.ts can send a fresh copy.
//  No imports: every module can use this without an import cycle.
// =============================================================================

export interface SnapshotPart {
  /** JSON-serialisable state. Called while unlocked only. */
  save(): unknown
  /** Restores state saved by save() (after an API restart). Throw to refuse it: HyperProx then locks. */
  load(data: unknown): void | Promise<void>
}

const parts = new Map<string, SnapshotPart>()
let listener: (() => void) | null = null

export function registerSnapshotPart(name: string, part: SnapshotPart): void {
  parts.set(name, part)
}

/** A part changed; with a keyholder, state.ts sends a fresh snapshot (coalesced). */
export function snapshotChanged(): void {
  listener?.()
}

export function setSnapshotListener(fn: (() => void) | null): void {
  listener = fn
}

export function saveParts(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, p] of parts) out[name] = p.save()
  return out
}

/** Loads parts in registration order; a part missing from the snapshot is skipped. */
export async function loadParts(data: Record<string, unknown>): Promise<void> {
  for (const [name, p] of parts) if (name in data) await p.load(data[name])
}
