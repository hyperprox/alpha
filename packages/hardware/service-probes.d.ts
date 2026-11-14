export interface ServiceProbe {
  key: string
  label: string
  port: number
  path: string
  scheme: 'http' | 'https'
  recipeId: string | null
  pluginId: string | null
  setting: string | null
  needs: string[]
  multiple: boolean
  match(status: number, body: string): boolean
}
export interface ProbeAnswer { status: number; body: string; location?: string | null }
export type ProbeGetter = (url: string) => Promise<ProbeAnswer | null>
export interface ScanHost<G = unknown> { address: string; source: string; guest?: G }
export interface ServiceFinding<G = unknown> {
  key: string
  label: string
  recipeId: string | null
  pluginId: string | null
  setting: string | null
  needs: string[]
  multiple: boolean
  /** scheme://host:port */
  address: string
  host: string
  port: number
  source: string
  guest: G | null
}
export const PROBES: ServiceProbe[]
export function probeHost(get: ProbeGetter, host: string, probe: ServiceProbe): Promise<boolean>
export function scanHosts<G = unknown>(hosts: ScanHost<G>[], get: ProbeGetter, opts?: { probes?: ServiceProbe[]; concurrency?: number }): Promise<ServiceFinding<G>[]>
export function verdicts(findings: Array<{ key: string; address: string }>, probes?: ServiceProbe[]): Record<string, { found: boolean; addresses: string[] }>
/** The real GET (http/https, no redirects followed, 2.5 s, 64 KiB). */
export const realGet: ProbeGetter
/** RFC1918 IPv4 or unique-local IPv6 only: the only addresses ever probed. */
export function isProbeAddress(addr: string): boolean
/** IPv4 that is not 0/8, loopback, link-local, multicast or broadcast (public allowed). */
export function isUnicastV4(addr: string): boolean
/** A guest's addresses to probe: config's when it has any, else the agent's; private only, deduplicated. */
export function guestAddresses(fromConfig: string[], fromLive: string[]): string[]
