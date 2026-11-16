// =============================================================================
//  HyperProx — the package cache (apt-cacher-ng): what HyperProx keeps and reads
//
//  One cache is one container the Catalogue installed apt-cacher-ng in (or any
//  container carrying its helper, hpx-aptcache). Its plug-in reads the helper's
//  `stats`; the Updates feature points guests at it through an apt drop-in that
//  falls back to going direct whenever the cache does not answer properly.
// =============================================================================

export const PLUGIN_ID = 'apt-cacher-ng'
export const RECIPE_ID = 'apt-cacher-ng'
export const NAME = 'Package cache'
/** The port apt-cacher-ng answers on. */
export const PORT = 3142
/** The Debian 13 package version the recipe installs. */
export const ACNG_VERSION = '3.7.5-1'
/** The in-guest helper the install leaves behind. */
export const HELPER = '/usr/local/sbin/hpx-aptcache'

/** One cache HyperProx looks after. */
export interface CacheInstance {
  /** The guest's machine id (lxc-101). */
  id: string
  vmid: number
  node: string
  name: string
  /** The address it listens on, read from the guest (never typed in). */
  listen: string | null
  /** The vault item holding the admin page's password (category apps, provider apt-cacher-ng-<vmid>). */
  vault: { category: string; provider: string }
  addedAt: number
  addedBy: string
  autoConnected?: { at: number; evidence: string[] } | null
}

export interface Bytes { requests: number; bytes: number }

/** One hour of traffic: what clients got, what came from the cache and what was fetched from the internet. */
export interface HourBucket { at: number; requests: number; hits: number; bytes: number; hitBytes: number; fetchedBytes: number }

export interface CacheReading {
  at: number
  active: boolean
  version: string | null
  listen: string | null
  /** Whether its socket is listening on that address right now (null: not reported). */
  listening: boolean | null
  /** The networks allowed to use it. */
  allow: string[]
  /** Whether the admin page is reachable on the network (its actions always need the password). */
  report: boolean
  hours: number
  /** The cache disk: its size and what is used and free on it (KB). */
  disk: { sizeKb: number; usedKb: number; freeKb: number } | null
  /** The disk size chosen at install (GB). */
  cacheGb: number | null
  totals: { requests: number; hits: number; bytes: number; hitBytes: number; fetchedBytes: number }
  /** Requests answered from the cache, 0..1 (null with nothing served). */
  hitRatio: number | null
  /** Bytes answered from the cache, 0..1 (null with nothing served). */
  byteHitRatio: number | null
  /** One bucket per hour of the window, oldest first, zeros included. */
  perHour: HourBucket[]
  /** The busiest packages (names only, never the path or who asked). */
  packages: Array<{ name: string } & Bytes & { hits: number }>
  /** Traffic per repository (the cache's own short names, or a host name). */
  repos: Array<{ name: string } & Bytes & { hits: number }>
  /** Traffic per client address. The API turns these into guest names and never sends the addresses on. */
  clients: Array<{ address: string } & Bytes>
  /** The last expiry (clean-up) run, from apt-cacher-ng's own maintenance log. */
  expiry: { at: number; outcome: 'done' | 'skipped' | 'errors' } | null
  /** Requests refused today because the client is not on an allowed network (apt-cacher-ng's error log, rotated daily). */
  refused: number
  /** Other error lines in apt-cacher-ng's error log (rotated daily). */
  errors: number
}

export interface SelfCheck { id: string; state: 'ok' | 'fail' | 'info'; detail: string }

/** Whether the Updates feature points guests at the cache. */
export type CacheUseMode = 'auto' | 'on' | 'off'

export interface CacheUseSetting {
  /** auto: on while a cache is connected and healthy; on: always while one is connected; off: never (and removed). */
  mode: CacheUseMode
  /** Proxmox nodes too (off unless turned on, separately). */
  nodes: boolean
  /** Which cache, when there is more than one (default: the first healthy one). */
  cacheId?: string | null
  updatedAt?: number
  updatedBy?: string
}

export const DEFAULT_USE: CacheUseSetting = { mode: 'auto', nodes: false }
