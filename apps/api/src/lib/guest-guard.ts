// =============================================================================
//  HyperProx — the one "leave this guest alone" rule
//
//  A guest HyperProx must never look inside or change is one that:
//    - carries the Proxmox tag hyperprox-ignore (any case), or
//    - is on Remote access's "never look inside" list (machine ids, lxc-101), or
//    - has an address on an excluded subnet, where the caller has a subnet list.
//
//  Every feature asks guestExcluded(); none keeps its own copy of the rule. The
//  place every command into a guest passes (lib/remote/executor.ts run) asks it
//  too, so a feature that forgets still cannot enter an excluded guest.
//
//  The "never look inside" list lives in Postgres; the routes hand its reader
//  to setGuestExclusionSource(). Until they have, or when it cannot be read,
//  excludedMachineIds() throws: callers fail closed and enter no guest.
// =============================================================================

import { inCidrs } from './net/ip'

/** The Proxmox tag that keeps HyperProx out of a guest. */
export const IGNORE_TAG = 'hyperprox-ignore'

/** Proxmox tags as HyperProx compares them: split on ";", "," or white space, trimmed, lower-case. */
export function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.flatMap(t => parseTags(t))
  return String(raw ?? '').split(/[;,\s]+/).map(t => t.trim().toLowerCase()).filter(Boolean)
}

/** Does this tag list (raw Proxmox text or a list) carry hyperprox-ignore? */
export function hasIgnoreTag(tags: unknown): boolean {
  return parseTags(tags).includes(IGNORE_TAG)
}

/** A guest as the rule needs it. Every field is optional: the rule uses what the caller knows. */
export interface GuardedGuest {
  /** Remote access's machine id: `lxc-<vmid>` or `qemu-<vmid>`. Built from kind and vmid when absent. */
  id?:        string | null
  kind?:      string | null
  vmid?:      number | null
  tags?:      unknown
  addresses?: Array<string | null | undefined>
}

export interface ExclusionContext {
  /** Remote access's "never look inside" list. */
  excludedMachines?: ReadonlySet<string> | readonly string[]
  /** Networks whose guests are left alone (only where a feature has such a list). */
  excludedSubnets?:  readonly string[]
}

export type ExclusionReason = 'tag' | 'list' | 'subnet'

/** Why a guest must be left alone, as a code, or null. */
export function exclusionReason(g: GuardedGuest, ctx: ExclusionContext = {}): ExclusionReason | null {
  if (hasIgnoreTag(g.tags)) return 'tag'
  const id = g.id ?? (g.kind && g.vmid !== undefined && g.vmid !== null ? `${g.kind}-${g.vmid}` : null)
  const list = ctx.excludedMachines
  if (id && list && (list instanceof Set ? list.has(id) : (list as readonly string[]).includes(id))) return 'list'
  if (ctx.excludedSubnets?.length && (g.addresses ?? []).some(a => a && inCidrs(a, ctx.excludedSubnets!))) return 'subnet'
  return null
}

export const EXCLUSION_WORDS: Record<ExclusionReason, string> = {
  tag:    `the ${IGNORE_TAG} tag`,
  list:   "Remote access's exclusion list",
  subnet: 'an excluded subnet',
}

/** Why a guest must be left alone, in words ("the hyperprox-ignore tag"), or null. */
export function guestExcluded(g: GuardedGuest, ctx: ExclusionContext = {}): string | null {
  const r = exclusionReason(g, ctx)
  return r ? EXCLUSION_WORDS[r] : null
}

/** Refused because the guest is one HyperProx never looks inside. Its message is written for people. */
export class GuestExcludedRefusal extends Error {
  readonly status = 409
  readonly code = 'excluded'
  constructor(readonly guestName: string, readonly reason: string) {
    super(`${guestName} is left alone (${reason}), so HyperProx does not look inside it or change it.`)
    this.name = 'GuestExcludedRefusal'
  }
}

/** Refused because the "never look inside" list could not be read: no guest is entered until it can. */
export class ExclusionsUnknownRefusal extends Error {
  readonly status = 503
  readonly code = 'exclusions_unknown'
  constructor() {
    super("Remote access's exclusion list could not be read, so HyperProx enters no guest until it can.")
    this.name = 'ExclusionsUnknownRefusal'
  }
}

// ── the list's source ─────────────────────────────────────────────────────────

let source: (() => Promise<string[]>) | null = null

/** Remote access's "never look inside" list; the routes set it (it lives in Postgres). */
export function setGuestExclusionSource(fn: (() => Promise<string[]>) | null): void { source = fn }

/** The list now. Throws ExclusionsUnknownRefusal when it is not available: the caller enters no guest. */
export async function excludedMachineIds(): Promise<string[]> {
  if (!source) throw new ExclusionsUnknownRefusal()
  try {
    const ids = await source()
    if (!Array.isArray(ids)) throw new Error('not a list')
    return ids
  } catch { throw new ExclusionsUnknownRefusal() }
}
