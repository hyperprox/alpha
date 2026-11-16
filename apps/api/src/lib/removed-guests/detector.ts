// =============================================================================
//  HyperProx — removed guests: telling "gone" from "not read this time"
//
//  A guest destroyed in Proxmox leaves HyperProx's own records pointing at
//  nothing (a plug-in still connected to it, a backup job still naming it).
//  This is the rule that decides a guest is really gone, and nothing else:
//
//    - only a read that worked counts: a failed read of the cluster, or one
//      taken while a node is not online, says nothing and changes nothing;
//    - a guest counts as gone only when no node lists it on MIN_READS reads in
//      a row that span at least MIN_SPAN_MS (ten minutes): a brief absence is
//      never enough;
//    - a guest that is migrating, relocating or being restored is never gone:
//      its absence count starts again.
//
//  Which guests are watched: every guest seen since HyperProx started watching,
//  plus every guest a HyperProx record or a backup job still names (so a guest
//  destroyed before this existed is found too). Pure: the service reads, this
//  decides.
// =============================================================================

export const MIN_READS = 3
export const MIN_SPAN_MS = 10 * 60_000
/** A removed guest HyperProx holds nothing for any more is forgotten after this long. */
export const FORGET_AFTER_MS = 30 * 24 * 3600_000
/**
 * More guests than this missing from one read, or (two or more) more than MASS_SHARE of the guests seen, is not a removal: it is
 * HyperProx seeing less (a token that lost its rights, a pool it cannot read). Such a read does not count.
 */
export const MASS_COUNT = 3
export const MASS_SHARE = 0.2

export type Kind = 'lxc' | 'qemu'

export interface SeenGuest { vmid: number; type: Kind; name: string; node: string; lastSeen: number; addresses: string[] }

export interface RemovedGuest {
  vmid: number
  type: Kind | null
  name: string | null
  node: string | null
  /** When it was destroyed (Proxmox's task), else when it was last seen, else null. */
  removedAt: number | null
  /** Where removedAt came from. */
  dateFrom: 'task' | 'last-seen' | 'noticed'
  /** When HyperProx decided it was gone. */
  noticedAt: number
  /** Addresses it was seen at while it existed (the service scan, its install record). */
  addresses: string[]
  /** Another guest has its ID now: only records older than removedAt are its, and nothing on the cluster is. */
  reused?: { name: string; type: Kind; at: number } | null
  /** HyperProx destroyed it itself (read back gone), so no waiting was needed. */
  destroyedByHyperProx?: boolean
}

export interface DetectorState {
  seen: Record<string, SeenGuest>
  absent: Record<string, { since: number; reads: number }>
  removed: Record<string, RemovedGuest>
  lastRead: { at: number; ok: boolean; why: string | null } | null
  /** The last read had too many seen guests missing at once (see MASS_COUNT): how many, and since when. */
  massVanish?: { count: number; since: number; names: string[] } | null
}

export const EMPTY_STATE: DetectorState = { seen: {}, absent: {}, removed: {}, lastRead: null, massVanish: null }

/**
 * The guests seen before that are newly missing from this read (not already being counted as absent), less those
 * whose config Proxmox has proven gone on every node (`proven`), and whether that many is too many to be removals.
 */
export function vanished(s: DetectorState, read: ClusterRead, proven: Set<number> = new Set()): { count: number; mass: boolean; ids: number[] } {
  if (!read.ok) return { count: 0, mass: false, ids: [] }
  const here = new Set(read.guests.map(g => g.vmid))
  const seen = Object.values(s.seen)
  const ids = seen.filter(g => !here.has(g.vmid) && !s.absent[String(g.vmid)] && !proven.has(g.vmid)).map(g => g.vmid)
  const count = ids.length
  // One guest gone is never "mass", however small the cluster: the share rule needs at least two at once.
  return { count, mass: count > MASS_COUNT || (count >= 2 && count / seen.length > MASS_SHARE), ids }
}

/** One look at the cluster. `ok: false` is a read that failed: it is recorded and decides nothing. */
export type ClusterRead =
  | { ok: true; at: number; guests: Array<{ vmid: number; type: Kind; name: string; node: string }>; nodes: Array<{ name: string; online: boolean }> }
  | { ok: false; at: number; why: string }

/** A guest a record names, with what that record knows about it. */
export interface Candidate { vmid: number; type?: Kind | null; name?: string | null; addresses?: string[] }

export interface StepInput {
  read: ClusterRead
  /** Guests HyperProx's records or a backup job name. */
  candidates: Candidate[]
  /** Addresses each present guest is seen at now (the last service scan), by vmid. */
  addresses?: Map<number, string[]>
  /** Guests with a migration, relocation or restore running or just finished. Read only when one is absent. */
  busy?: Set<number>
  /** When Proxmox's own task log says the guest was destroyed (null when not in the log). */
  destroyedAt?: (vmid: number) => number | null
  /**
   * Guests that vanished in a mass read whose config Proxmox answered "does not exist" on every node: really gone,
   * so they leave the mass test and are counted absent the usual way (still three reads over ten minutes).
   */
  proven?: Set<number>
}

const uniq = (a: string[]) => [...new Set(a.filter(Boolean))].slice(0, 16)

/** Whether a read can be trusted to say a guest is absent: it worked, and every node answered as online. */
export function readCounts(r: ClusterRead): boolean {
  return r.ok && r.nodes.length > 0 && r.nodes.every(n => n.online)
}

/** The guests that would be absent on this read (needed before step(), to know whether to read the task log). */
export function absentCandidates(s: DetectorState, read: ClusterRead, candidates: Candidate[], proven: Set<number> = new Set()): number[] {
  if (!readCounts(read) || !read.ok) return []
  if (vanished(s, read, proven).mass) return [...proven].filter(v => !s.removed[String(v)])
  const here = new Set(read.guests.map(g => g.vmid))
  const ids = new Set<number>([...Object.values(s.seen).map(g => g.vmid), ...candidates.map(c => c.vmid)])
  return [...ids].filter(v => !here.has(v) && !s.removed[String(v)])
}

/** The next state. Never throws; a read that does not count leaves everything but lastRead as it was. */
export function step(prev: DetectorState, input: StepInput): DetectorState {
  const s: DetectorState = structuredClone(prev)
  const r = input.read
  if (!r.ok) { s.lastRead = { at: r.at, ok: false, why: r.why.slice(0, 200) }; return s }
  if (!readCounts(r)) {
    const down = r.nodes.filter(n => !n.online).map(n => n.name)
    s.lastRead = { at: r.at, ok: false, why: r.nodes.length ? `not every node is online (${down.join(', ')})` : 'no node was listed' }
    return s
  }
  const proven = input.proven ?? new Set<number>()
  const v = vanished(s, r, proven)
  if (v.mass) {
    // Nothing is learned about the guests HyperProx cannot account for: no absence of theirs advances, and nothing
    // seen is replaced by a smaller picture. Only those proven gone are counted, the usual way.
    s.lastRead = { at: r.at, ok: false, why: `${v.count} guests seen before are missing at once` }
    s.massVanish = { count: v.count, since: s.massVanish?.since ?? r.at, names: v.ids.map(id => s.seen[String(id)]?.name ?? String(id)).slice(0, 20) }
    for (const vmid of proven) if (s.seen[String(vmid)] && !s.removed[String(vmid)]) countAbsent(s, vmid, r.at, input, undefined)
    return s
  }
  s.massVanish = null
  s.lastRead = { at: r.at, ok: true, why: null }
  const here = new Map(r.guests.map(g => [g.vmid, g]))
  const byId = new Map<number, Candidate>()
  for (const c of input.candidates) {
    const was = byId.get(c.vmid)
    byId.set(c.vmid, { vmid: c.vmid, type: was?.type ?? c.type ?? null, name: was?.name ?? c.name ?? null, addresses: uniq([...(was?.addresses ?? []), ...(c.addresses ?? [])]) })
  }

  // Present guests: remembered, with the addresses they are seen at; any absence count ends.
  for (const g of r.guests) {
    const k = String(g.vmid)
    const prevSeen = s.seen[k]
    const sameGuest = prevSeen && prevSeen.type === g.type && prevSeen.name === g.name
    s.seen[k] = { vmid: g.vmid, type: g.type, name: g.name, node: g.node, lastSeen: r.at, addresses: uniq([...(input.addresses?.get(g.vmid) ?? []), ...(sameGuest ? prevSeen.addresses : [])]) }
    delete s.absent[k]
    const gone = s.removed[k]
    if (gone) {
      // The same guest back (restored from a backup) is not removed; another guest on its ID is a reuse.
      if (gone.type === g.type && (gone.name ?? '').toLowerCase() === g.name.toLowerCase()) delete s.removed[k]
      else if (!gone.reused) gone.reused = { name: g.name, type: g.type, at: r.at }
    }
  }

  const watched = new Set<number>([...Object.values(s.seen).map(g => g.vmid), ...byId.keys()])
  for (const vmid of watched) {
    if (here.has(vmid) || s.removed[String(vmid)]) continue
    countAbsent(s, vmid, r.at, input, byId.get(vmid))
  }
  // Nothing watches these any more (a record removed, a guest never seen): no count is kept for them.
  for (const k of Object.keys(s.absent)) if (!watched.has(Number(k))) delete s.absent[k]
  return s
}

/** One more read with this guest missing: its count goes up, and at MIN_READS over MIN_SPAN_MS it is removed. */
function countAbsent(s: DetectorState, vmid: number, at: number, input: StepInput, c: Candidate | undefined): void {
  const k = String(vmid)
  if (input.busy?.has(vmid)) { delete s.absent[k]; return }
  const a = s.absent[k] ?? { since: at, reads: 0 }
  a.reads += 1
  s.absent[k] = a
  if (a.reads < MIN_READS || at - a.since < MIN_SPAN_MS) return
  const seen = s.seen[k]
  const task = input.destroyedAt?.(vmid) ?? null
  s.removed[k] = {
    vmid, type: seen?.type ?? c?.type ?? null, name: seen?.name ?? c?.name ?? null, node: seen?.node ?? null,
    removedAt: task ?? seen?.lastSeen ?? null, dateFrom: task ? 'task' : seen ? 'last-seen' : 'noticed', noticedAt: at,
    addresses: uniq([...(seen?.addresses ?? []), ...(c?.addresses ?? [])]), reused: null,
  }
  delete s.absent[k]
  delete s.seen[k]
}

/** HyperProx destroyed this guest itself and read it back gone: it is removed now, with no wait. */
export function markDestroyed(prev: DetectorState, g: { vmid: number; type: Kind; name: string; node: string; addresses?: string[] }, at: number): DetectorState {
  const s: DetectorState = structuredClone(prev)
  const k = String(g.vmid)
  const seen = s.seen[k]
  s.removed[k] = {
    vmid: g.vmid, type: g.type, name: g.name, node: g.node, removedAt: at, dateFrom: 'task', noticedAt: at,
    addresses: uniq([...(seen?.addresses ?? []), ...(g.addresses ?? [])]), reused: null, destroyedByHyperProx: true,
  }
  delete s.seen[k]
  delete s.absent[k]
  return s
}

/**
 * A probe of the guest's config showed it was not proven gone (it answered, or the answer was not "does not exist"):
 * it is not removed. Its absence count starts again.
 */
export function unremove(prev: DetectorState, vmid: number): DetectorState {
  const s: DetectorState = structuredClone(prev)
  const k = String(vmid)
  const g = s.removed[k]
  delete s.removed[k]
  delete s.absent[k]
  if (g?.type && g.name) s.seen[k] = { vmid, type: g.type, name: g.name, node: g.node ?? '', lastSeen: g.noticedAt, addresses: g.addresses }
  return s
}

/** Another guest has this ID now (seen at clean-up): only what is safe under a reused ID is touched from now on. */
export function markReused(prev: DetectorState, vmid: number, by: { name: string; type: Kind }, at: number): DetectorState {
  const s: DetectorState = structuredClone(prev)
  const g = s.removed[String(vmid)]
  if (g && !g.reused) g.reused = { name: by.name, type: by.type, at }
  return s
}

/** Forget a removed guest (cleaned up, or nothing of it left for long enough). */
export function forgetRemoved(prev: DetectorState, vmid: number): DetectorState {
  const s: DetectorState = structuredClone(prev)
  delete s.removed[String(vmid)]
  return s
}
