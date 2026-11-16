// =============================================================================
//  HyperProx — the package cache page: the pure parts (tested on their own)
// =============================================================================

export interface HourBucket { at: number; requests: number; hits: number; bytes: number; hitBytes: number; fetchedBytes: number }
export interface Counted { name: string; requests: number; hits: number; bytes: number }
export interface Client { name: string; kind: 'guest' | 'node' | 'self' | 'other'; requests: number; bytes: number }

export interface Reading {
  at: number; active: boolean; version: string | null; listen: string | null; allow: string[]; report: boolean; hours: number
  disk: { sizeKb: number; usedKb: number; freeKb: number } | null
  cacheGb: number | null
  totals: { requests: number; hits: number; bytes: number; hitBytes: number; fetchedBytes: number }
  hitRatio: number | null; byteHitRatio: number | null
  perHour: HourBucket[]
  packages: Counted[]; repos: Counted[]; clients: Client[]
  expiry: { at: number; outcome: 'done' | 'skipped' | 'errors' } | null
  refused: number; errors: number
}

export interface Instance {
  id: string; vmid: number; node: string; name: string; listen: string | null; url: string | null
  vaultItem: string; addedAt: number; addedBy: string; autoConnected: { at: number; evidence: string[] } | null
}

export interface Problem {
  id: string; severity: 'bad' | 'warn'; title: string; detail: string
  fix: { id: 'restart' | 'maint' | 'recheck' | 'repair_guests' | 'grow_disk'; label: string; confirm?: string } | null
}

export interface SelfCheck { id: string; state: 'ok' | 'fail' | 'info'; detail: string }

export type UseMode = 'auto' | 'on' | 'off'
export interface UseView {
  mode: UseMode; nodes: boolean; cacheId?: string | null; effective: boolean; why: string
  cache: { id: string; name: string } | null; clients: number
}

export const CHECK_TITLE: Record<string, string> = {
  running: 'Running', listen: 'Listens only on its LAN address', clients: 'Only allowed networks may use it',
  fetch: 'A package index comes through the cache', https: 'HTTPS repositories pass through', admin: 'Admin actions need the password',
  no_private_tunnel: 'No tunnel to a private or loopback address', managed_only: 'Only package archives are fetched',
}

/** apt-cacher-ng's own short names for the archives it knows. */
const REPO_NAME: Record<string, string> = {
  debrep: 'Debian', secdeb: 'Debian security', uburep: 'Ubuntu', klxrep: 'Kali', alxrep: 'Arch Linux', cygwin: 'Cygwin',
  sfnet: 'SourceForge', ubusec: 'Ubuntu security', fedora: 'Fedora', epel: 'EPEL', slrep: 'Scientific Linux', gentoo: 'Gentoo',
}
export const repoName = (n: string) => REPO_NAME[n] ?? n

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function size(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

export const pct = (r: number | null | undefined) => (r === null || r === undefined ? '—' : `${Math.round(r * 100)}%`)

/** How full the cache disk is, 0..1 (null without a reading). */
export const diskUse = (r: Reading) => (r.disk && r.disk.sizeKb ? r.disk.usedKb / r.disk.sizeKb : null)

/** The disk in whole GB (what a resize asks for). */
export const diskGb = (r: Reading) => (r.disk ? Math.round(r.disk.sizeKb / 1024 / 1024) : (r.cacheGb ?? 0))

/** The clean-up, in words. */
export function expiryWords(r: Reading, now: number): { text: string; tone: 'good' | 'warn' | 'bad' } {
  if (!r.expiry) return { text: 'No clean-up has run yet (it runs once a day).', tone: 'warn' }
  const h = Math.max(0, Math.round((now - r.expiry.at) / 3600_000))
  const when = h < 1 ? 'less than an hour ago' : h < 48 ? `${plural(h, 'hour')} ago` : `${plural(Math.round(h / 24), 'day')} ago`
  if (r.expiry.outcome === 'errors') return { text: `The last clean-up, ${when}, reported errors.`, tone: 'bad' }
  if (r.expiry.outcome === 'skipped') return { text: `Last looked ${when}: too little to clean out yet.`, tone: h > 72 ? 'warn' : 'good' }
  return { text: `Old packages were cleaned out ${when}.`, tone: h > 72 ? 'warn' : 'good' }
}

/** Area and line paths for a series drawn into width x height (y grows down). */
export function areaPath(values: number[], width: number, height: number, max = Math.max(1, ...values)): { line: string; area: string; max: number } {
  if (!values.length) return { line: '', area: '', max }
  const step = values.length > 1 ? width / (values.length - 1) : width
  const pts = values.map((v, i) => [Math.round(i * step * 10) / 10, Math.round((height - (Math.min(v, max) / max) * (height - 4) - 2) * 10) / 10])
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ')
  return { line, area: `${line} L${pts[pts.length - 1][0]} ${height} L0 ${height} Z`, max }
}

/** Buckets merged so a long window draws as at most `max` points (a day per point past a few days). */
export function bucketed(hours: HourBucket[], max = 96): HourBucket[] {
  if (hours.length <= max) return hours
  const per = Math.ceil(hours.length / max)
  const out: HourBucket[] = []
  for (let i = 0; i < hours.length; i += per) {
    const g = hours.slice(i, i + per)
    out.push(g.reduce((a, b) => ({ at: a.at, requests: a.requests + b.requests, hits: a.hits + b.hits, bytes: a.bytes + b.bytes, hitBytes: a.hitBytes + b.hitBytes, fetchedBytes: a.fetchedBytes + b.fetchedBytes }), { ...g[0], requests: 0, hits: 0, bytes: 0, hitBytes: 0, fetchedBytes: 0 }))
  }
  return out
}

// No leading zeros (010 is octal to tcp wrappers), as the server checks.
const CIDR = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\/(0|[1-9]\d?)$/

/** The page's own first look at the networks (the server checks again): private, masked, no wider than the block. */
export function checkNetworks(raw: string): { ok: boolean; list: string[]; problem?: string } {
  const list = [...new Set(raw.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean))]
  if (!list.length) return { ok: false, list, problem: 'Give at least one network, like 10.0.5.0/24.' }
  for (const c of list) {
    const m = CIDR.exec(c)
    if (!m) return { ok: false, list, problem: `${c} is not a network like 10.0.5.0/24${/(^|[./])0\d/.test(c) ? ' (no leading zeros)' : ''}.` }
    const o = m.slice(1, 5).map(Number), p = Number(m[5])
    if (o.some(x => x > 255) || p > 32) return { ok: false, list, problem: `${c} is not a network address.` }
    const block = o[0] === 10 ? 8 : o[0] === 172 && o[1] >= 16 && o[1] <= 31 ? 12 : o[0] === 192 && o[1] === 168 ? 16 : null
    if (block === null) return { ok: false, list, problem: `${c} is not a private network.` }
    if (p < block) return { ok: false, list, problem: `${c} is wider than its private block: use /${block} or narrower.` }
    const n = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0
    const mask = p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0
    if (((n & mask) >>> 0) !== n) return { ok: false, list, problem: `${c} has host bits set.` }
  }
  return { ok: true, list }
}

export const MODE_WORDS: Record<UseMode, { label: string; hint: string }> = {
  auto: { label: 'Automatic', hint: 'On while the cache answers.' },
  on:   { label: 'On', hint: 'Always point guests at it; each falls back to direct by itself.' },
  off:  { label: 'Off', hint: 'Guests fetch directly; HyperProx takes its setting out on the next run.' },
}
