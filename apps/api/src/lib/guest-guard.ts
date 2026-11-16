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
import { machineId } from './guest-id'

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
  const id = g.id ?? (g.kind && g.vmid !== undefined && g.vmid !== null ? machineId({ type: g.kind, vmid: g.vmid }) : null)
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

/** How long a read of the list or of live tags is reused. Short enough that a new tag bites within seconds. */
export const GUARD_CACHE_MS = 5_000

let clock: () => number = () => Date.now()
/** Test hook: the clock the 5 s caches use. Call with no argument to restore the real one. */
export function setGuardClock(fn?: () => number): void { clock = fn ?? (() => Date.now()); invalidateGuardCache() }

let generation = 0
let idsCache: { at: number; gen: number; ids: string[] } | null = null
const rowsCache = new WeakMap<object, { at: number; gen: number; rows: any[] }>()

/** Forget every cached read. Called when the exclusion list is changed, so the change bites at once. */
export function invalidateGuardCache(): void { generation++; idsCache = null }

/** Remote access's "never look inside" list; the routes set it (it lives in Postgres). */
export function setGuestExclusionSource(fn: (() => Promise<string[]>) | null): void { source = fn; invalidateGuardCache() }

/** The list now (reused for 5 s). Throws ExclusionsUnknownRefusal when it is not available: the caller enters no guest. */
export async function excludedMachineIds(): Promise<string[]> {
  if (!source) throw new ExclusionsUnknownRefusal()
  if (idsCache && idsCache.gen === generation && clock() - idsCache.at < GUARD_CACHE_MS) return idsCache.ids
  const gen = generation
  try {
    const ids = await source()
    if (!Array.isArray(ids)) throw new Error('not a list')
    if (gen === generation) idsCache = { at: clock(), gen, ids }
    return ids
  } catch { throw new ExclusionsUnknownRefusal() }
}

// ── live tags ─────────────────────────────────────────────────────────────────

/**
 * A guest's Proxmox tags as Proxmox has them now, or null when the guest is not on the cluster. `scope` is whatever
 * object owns `read` (an executor, a client): the resource list is reused for 5 s per scope, so a pass over many
 * guests asks Proxmox once. Throws when Proxmox does not answer; the caller decides what that means (fail closed).
 */
export async function liveGuestTags(scope: object, read: () => Promise<any[] | null | undefined>, kind: string, vmid: number | string): Promise<string[] | null> {
  let hit = rowsCache.get(scope)
  if (!hit || hit.gen !== generation || clock() - hit.at >= GUARD_CACHE_MS) {
    const gen = generation
    const rows = await read()
    hit = { at: clock(), gen, rows: Array.isArray(rows) ? rows : [] }
    rowsCache.set(scope, hit)
  }
  const row = hit.rows.find(r => r?.type === kind && Number(r.vmid) === Number(vmid))
  return row ? parseTags(row.tags) : null
}

export interface LeftAloneOptions {
  /** Tags the caller already knows; added to the live ones. */
  tags?: unknown
  /** The "never look inside" list; default excludedMachineIds. */
  exclusions?: () => Promise<string[]>
  /** Live tags; default liveGuestTags over `read`. */
  guestTags?: () => Promise<string[] | null>
}

/**
 * Why this guest must be left alone, in words, or null. Fails closed: when the list or the guest's live tags cannot
 * be read the answer is ExclusionsUnknownRefusal, never "fine".
 */
export async function guestLeftAloneReason(scope: object, read: () => Promise<any[] | null | undefined>, g: { kind: string; vmid: number }, o: LeftAloneOptions = {}): Promise<string | null> {
  let tags: string[] | null
  try { tags = await (o.guestTags ?? (() => liveGuestTags(scope, read, g.kind, g.vmid)))() }
  catch { throw new ExclusionsUnknownRefusal() }
  const ids = await (o.exclusions ?? excludedMachineIds)().catch(() => { throw new ExclusionsUnknownRefusal() })
  return guestExcluded({ kind: g.kind, vmid: g.vmid, tags: [...(tags ?? []), ...parseTags(o.tags)] }, { excludedMachines: ids })
}
