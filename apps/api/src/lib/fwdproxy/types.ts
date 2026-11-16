// =============================================================================
//  HyperProx — 3proxy forward proxy: the instance and what a reading holds
//
//  3proxy serves HTTP (port 3128) and SOCKS5 (port 1080) from one small daemon.
//  The Catalogue installs it with an in-guest helper (lib/fwdproxy/scripts.ts),
//  which the plug-in reads and changes it through.
// =============================================================================

/** The Catalogue recipe and the plug-in share this id. */
export const PROXY_ID = '3proxy'
export const PROXY_NAME = '3proxy'

/** The address apps are given, per protocol it serves. */
export const ENDPOINTS = [
  { protocol: 'http' as const, port: 3128, label: 'HTTP' as const },
  { protocol: 'socks5' as const, port: 1080, label: 'SOCKS5' as const },
]

/** One 3proxy HyperProx looks after: a container the Catalogue installed it in. */
export interface ProxyInstance {
  /** The guest's machine id (lxc-101). */
  id: string
  vmid: number
  node: string
  name: string
  /** The address it listens on (read from the guest, never typed in). */
  listen: string | null
  /** The vault item holding its users' passwords (category apps, provider 3proxy-<vmid>). */
  vault: { category: string; provider: string }
  addedAt: number
  addedBy: string
  autoConnected?: { at: number; evidence: string[] } | null
  /** Users whose password change timed out: the guest may or may not have it, so a new one is offered. */
  uncertain?: string[]
}

export interface Counted { requests: number; bytes: number }

export interface ProxyReading {
  /** When the guest read it (ms). */
  at: number
  active: boolean
  version: string | null
  listen: string | null
  minutes: number
  allow: string[]
  lanTargets: boolean
  perClient: boolean
  users: string[]
  http: boolean
  socks: boolean
  /** Open connections now per protocol (null when that protocol is off). */
  conns: { http: number | null; socks: number | null }
  /** One bucket per minute of the window, oldest first, zeros included. */
  perMinute: Array<{ at: number } & Counted>
  totals: Counted & { denied: number; errors: number }
  denied: Array<{ code: string; label: string; count: number }>
  /** Requests and bytes per protocol. */
  services: Array<{ name: 'HTTP' | 'SOCKS' } & Counted>
  /** Empty when per-user figures are off. */
  byUser: Array<{ name: string } & Counted>
  byClient: Array<{ address: string } & Counted>
}

export interface SelfCheck { id: string; state: 'ok' | 'fail' | 'info'; detail: string }
