// =============================================================================
//  HyperProx — DNS blockers (Pi-hole, AdGuard Home): the shapes
//
//  One reading shape for both products, so one page shows either. Everything a reading holds is a count, a name,
//  a time or a state: never a login, a session id or a query log line.
// =============================================================================

export type DnsKind = 'pihole' | 'adguard'
export const DNS_KINDS: readonly DnsKind[] = ['pihole', 'adguard']
export const isDnsKind = (v: unknown): v is DnsKind => v === 'pihole' || v === 'adguard'

/** What the page calls each one. */
export const KIND_NAME: Record<DnsKind, string> = { pihole: 'Pi-hole', adguard: 'AdGuard Home' }

export interface GuestRef { kind: 'lxc' | 'qemu'; vmid: number }

/** What auto-connect did, shown on the page. */
export interface AutoConnected { at: string; evidence: string[]; vaultItem: string | null }

/** The instance list entry: names and flags only, never an address or a login. */
export interface DnsMeta {
  id: string
  kind: DnsKind
  name: string
  /** The container or VM it runs in, when known (the restart action needs it). */
  guest: GuestRef | null
  /** Per-client numbers are never read or shown for this one. */
  hideClients: boolean
  addedAt: string
  autoConnected?: AutoConnected
  /** "Use for HyperProx-installed guests" is on: what the DNS list was before, for the undo. */
  guestDns?: { address: string; previous: string[] } | null
}

export interface DnsView extends DnsMeta {
  url: string | null
  hasPassword: boolean
  insecureTLS: boolean
}

export class DnsRefusal extends Error {
  constructor(public code: string, message: string, public status = 400, public extra: Record<string, unknown> = {}) { super(message); this.name = 'DnsRefusal' }
}

export type UpstreamState = 'ok' | 'slow' | 'failing' | 'unknown'

export interface UpstreamRow {
  address: string
  name: string | null
  queries: number | null
  /** Average answer time the blocker measured for real queries. */
  avgMs: number | null
  state: UpstreamState
  /** Said in words: "answered in 24 ms", "did not answer in 2 s". */
  detail: string | null
  /** Time to answer a test lookup made from HyperProx, when it could be made. */
  probeMs: number | null
}

export interface DnsHistoryPoint { at: number; total: number; blocked: number }

export interface DnsReading {
  kind: DnsKind
  fetchedAt: string
  version: string | null
  /** A newer release than the one running, when the blocker says so. */
  newerVersion: string | null
  protection: { on: boolean; secondsLeft: number | null }
  totals: { queries: number; blocked: number; percentBlocked: number; cached: number | null; clients: number | null; avgMs: number | null }
  topBlocked: Array<{ domain: string; count: number }>
  topDomains: Array<{ domain: string; count: number }>
  /** Per-client numbers. Null when they are hidden (the setting, or a viewer): `clientsHidden` says so. */
  clients: Array<{ name: string | null; ip: string; count: number }> | null
  clientsHidden: boolean
  upstreams: UpstreamRow[]
  blocklists: { domains: number | null; lists: number | null; updatedAt: string | null; ageHours: number | null; stale: boolean }
  /** Hourly counts for the last 24 hours, oldest first. */
  history: DnsHistoryPoint[]
  /** The blocker's own DNS port answered a test lookup from HyperProx. */
  answering: { ok: boolean | null; ms: number | null; detail: string | null }
  problems: Problem[]
  /** What was not available (an older version, a missing permission). */
  missing: string[]
}

export type ActionName = 'pause' | 'resume' | 'update_lists' | 'restart_service' | 'allow_domain' | 'switch_upstream' | 'use_for_guests' | 'stop_using_for_guests'

/** A thing the page shows as wrong, with the button that fixes it (when one does). */
export interface Problem {
  id: 'protection_off' | 'lists_stale' | 'upstream_failing' | 'all_upstreams_failing' | 'not_answering' | 'no_queries'
  severity: 'warn' | 'bad' | 'info'
  text: string
  fix: null | { action: ActionName; label: string; params?: Record<string, unknown>; secure: boolean }
}

export interface Actor { sid: string; email: string; role: import('../roles').Role; token: string | null }

/** The numbers the gallery card shows for one instance. */
export interface TileRow {
  id: string
  name: string
  kind: DnsKind
  reading: Pick<DnsReading, 'protection' | 'totals' | 'problems' | 'answering'> | null
  error: string | null
}
