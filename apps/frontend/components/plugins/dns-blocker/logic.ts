// =============================================================================
//  HyperProx — DNS blockers (Pi-hole, AdGuard Home): the page's pure logic
//
//  The shapes the API sends (lib/dns-blocker/types.ts) and the words the page says about them, kept apart from the
//  components so they are tested without a browser.
// =============================================================================

export type DnsKind = 'pihole' | 'adguard'
export const KIND_NAME: Record<DnsKind, string> = { pihole: 'Pi-hole', adguard: 'AdGuard Home' }

export type UpstreamState = 'ok' | 'slow' | 'failing' | 'unknown'

export interface Upstream { address: string; name: string | null; queries: number | null; avgMs: number | null; state: UpstreamState; detail: string | null; probeMs: number | null }

export type ActionName = 'pause' | 'resume' | 'update_lists' | 'restart_service' | 'allow_domain' | 'switch_upstream' | 'use_for_guests' | 'stop_using_for_guests'

export interface Problem {
  id: string; severity: 'warn' | 'bad' | 'info'; text: string
  fix: null | { action: ActionName; label: string; params?: Record<string, unknown>; secure: boolean }
}

export interface Reading {
  kind: DnsKind; fetchedAt: string; version: string | null; newerVersion: string | null
  protection: { on: boolean; secondsLeft: number | null }
  totals: { queries: number; blocked: number; percentBlocked: number; cached: number | null; clients: number | null; avgMs: number | null }
  topBlocked: Array<{ domain: string; count: number }>
  topDomains: Array<{ domain: string; count: number }>
  clients: Array<{ name: string | null; ip: string; count: number }> | null
  clientsHidden: boolean
  upstreams: Upstream[]
  blocklists: { domains: number | null; lists: number | null; updatedAt: string | null; ageHours: number | null; stale: boolean }
  history: Array<{ at: number; total: number; blocked: number }>
  answering: { ok: boolean | null; ms: number | null; detail: string | null }
  problems: Problem[]
  missing: string[]
}

export interface Instance {
  id: string; kind: DnsKind; name: string; hideClients: boolean; addedAt: string; hasPassword: boolean
  guest?: { kind: 'lxc' | 'qemu'; vmid: number } | null
  url?: string | null; insecureTLS?: boolean; held?: string | null
  autoConnected?: { at: string; evidence: string[]; vaultItem: string | null } | null
  guestDns?: { address: string; previous: string[] } | null
}

export const PAUSE_MINUTES = [5, 30, 60] as const

export const PRESET_CHOICES: Array<{ id: string; label: string; servers: string }> = [
  { id: 'cloudflare', label: 'Cloudflare', servers: '1.1.1.1, 1.0.0.1' },
  { id: 'quad9', label: 'Quad9', servers: '9.9.9.9, 149.112.112.112' },
  { id: 'google', label: 'Google', servers: '8.8.8.8, 8.8.4.4' },
]

export const allowPhrase = (domain: string) => `Allow ${domain.trim().toLowerCase()}`

export const num = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString('en'))

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`
}

/** "3 hours", "2 days": how old the block lists are, in words. */
export function ageWords(hours: number | null): string {
  if (hours === null) return 'not reported'
  if (hours < 1) return 'just now'
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  return `${Math.round(hours / 24)} days ago`
}

/** How long a pause has left, in words. */
export function pauseLeft(seconds: number | null): string {
  if (seconds === null) return 'until you turn it back on'
  if (seconds < 90) return `${seconds} seconds`
  return `${Math.round(seconds / 60)} minutes`
}

export type Tone = 'good' | 'warn' | 'crit' | 'dim'

/** The shield: green when blocking and nothing is wrong, amber when something needs a look, red when it is off or down. */
export function shieldTone(r: Reading): Tone {
  if (!r.protection.on || r.answering.ok === false || r.problems.some(p => p.severity === 'bad')) return 'crit'
  return r.problems.some(p => p.severity === 'warn') ? 'warn' : 'good'
}
export const SHIELD_WORD: Record<Tone, string> = { good: 'protected', warn: 'needs a look', crit: 'not protecting', dim: 'unknown' }

export function hudChips(r: Reading): Array<{ label: string; value: string; tone: 'accent' | 'good' | 'warn' | 'crit' | 'violet' | 'dim' }> {
  const t = shieldTone(r)
  return [
    { label: 'status', value: SHIELD_WORD[t], tone: t === 'dim' ? 'dim' : t },
    { label: 'blocking', value: r.protection.on ? 'on' : 'off', tone: r.protection.on ? 'good' : 'crit' },
    { label: 'queries', value: num(r.totals.queries), tone: 'accent' },
    { label: 'blocked', value: `${r.totals.percentBlocked}%`, tone: t === 'good' ? 'violet' : t === 'warn' ? 'warn' : 'crit' },
    { label: 'answer time', value: r.answering.ms !== null ? `${r.answering.ms} ms` : r.answering.ok === false ? 'none' : '—', tone: r.answering.ok === false ? 'crit' : 'dim' },
  ]
}

export const STATE_WORD: Record<UpstreamState, string> = { ok: 'answering', slow: 'slow', failing: 'not answering', unknown: 'not checked' }

/** Bars for the 24-hour chart: each bar's total and blocked height as a share of the busiest hour, and its words. */
export function queryBars(history: Reading['history'], now = Date.now()): Array<{ at: number; total: number; blocked: number; totalPct: number; blockedPct: number; label: string }> {
  const top = Math.max(1, ...history.map(h => h.total))
  return history.map(h => {
    const hoursAgo = Math.round((now - h.at) / 3_600_000)
    return {
      ...h, totalPct: Math.round((h.total / top) * 100), blockedPct: Math.round((h.blocked / top) * 100),
      label: `${hoursAgo <= 0 ? 'This hour' : `${hoursAgo} hour${hoursAgo === 1 ? '' : 's'} ago`}: ${h.total.toLocaleString('en')} queries, ${h.blocked.toLocaleString('en')} blocked`,
    }
  })
}

/** What to tell a person who has not pointed anything at the blocker yet: the router's DHCP DNS setting. */
export function pointNetworkSteps(address: string | null, name: string): string[] {
  const where = address ?? `the ${name} address`
  return [
    `Nothing on your network uses ${name} until you point it at ${where}. HyperProx never changes another machine's DNS by itself.`,
    `On your router, find the DHCP or LAN settings and set the DNS server it hands out to ${where}. Devices pick that up when they renew their lease (or restart).`,
    `To try it on one device first, set that device's DNS server to ${where} in its network settings.`,
    'Keep a second DNS server out of the list, or devices will use it and skip the blocking.',
  ]
}

/** Why an action's button is not offered to this role, in words ("" when it is). */
export function whyNot(secure: boolean, role: string): string {
  const rank = (r: string) => ({ viewer: 0, operator: 1, admin: 2, owner: 3 } as Record<string, number>)[r] ?? 0
  if (secure) return rank(role) >= 2 ? '' : 'Only an admin can do this.'
  return rank(role) >= 1 ? '' : 'Only an operator or admin can do this.'
}

/** A domain as a person typed it, cleaned for the allow-list confirm: lower case, no trailing dot. */
export const cleanDomainInput = (v: string) => v.trim().toLowerCase().replace(/\.$/, '')
export const looksLikeDomain = (v: string) => /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z][a-z0-9-]{1,62}$/.test(cleanDomainInput(v))
