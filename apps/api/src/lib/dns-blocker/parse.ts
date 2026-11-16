// =============================================================================
//  HyperProx — DNS blockers: turning each product's answers into one reading
//
//  Pure functions over recorded answers: nothing here makes a request. Every reader is defensive (an older version, a
//  missing permission or a changed field gives null and a note in `missing`, never a thrown error), and no reader keeps
//  anything it does not show: no session id, no password, no query log line.
// =============================================================================

import type { DnsHistoryPoint, DnsKind, DnsReading, Problem, UpstreamRow } from './types'

/** A reading before the probes and the problem list are added. */
export type BaseReading = Omit<DnsReading, 'problems' | 'answering'>

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {})
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : [])
const round1 = (n: number) => Math.round(n * 10) / 10

/** A lookup slower than this is called slow. */
export const SLOW_MS = 400
/** The block lists refresh weekly; older than this is stale. */
export const STALE_HOURS = 8 * 24
export const HOUR_MS = 3_600_000

/** An upstream address without the default DNS port, so "1.1.1.1", "1.1.1.1#53" and "1.1.1.1:53" are one. */
export const bare = (a: string) => a.replace(/:53$/, '').replace(/#53$/, '')

/** Count, name and the like for a list row: only a plain host name or address, cut short. */
const domainOf = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9._:-]{1,253}$/.test(v) ? v : null)

export function emptyBlocklists(): DnsReading['blocklists'] {
  return { domains: null, lists: null, updatedAt: null, ageHours: null, stale: false }
}

/** Age in hours of an instant, and whether that is stale. */
export function listAge(updatedMs: number | null, now: number): Pick<DnsReading['blocklists'], 'updatedAt' | 'ageHours' | 'stale'> {
  if (updatedMs === null || !Number.isFinite(updatedMs) || updatedMs <= 0) return { updatedAt: null, ageHours: null, stale: false }
  const ageHours = Math.max(0, Math.round((now - updatedMs) / HOUR_MS))
  return { updatedAt: new Date(updatedMs).toISOString(), ageHours, stale: ageHours > STALE_HOURS }
}

/** Ten-minute (Pi-hole) or hourly buckets folded into the last 24 hourly points, oldest first. */
export function hourly(points: DnsHistoryPoint[], now: number): DnsHistoryPoint[] {
  const slot = (t: number) => Math.floor(t / HOUR_MS)
  const last = slot(now)
  const out = new Map<number, DnsHistoryPoint>()
  for (let i = 23; i >= 0; i--) out.set(last - i, { at: (last - i) * HOUR_MS, total: 0, blocked: 0 })
  for (const p of points) {
    const b = out.get(slot(p.at))
    if (b) { b.total += p.total; b.blocked += p.blocked }
  }
  return [...out.values()]
}

// ── Pi-hole v6 ──────────────────────────────────────────────────────────────

export interface PiholeAnswers {
  summary: unknown
  blocking: unknown
  version: unknown
  topBlocked: unknown
  topDomains: unknown
  /** Null when per-client numbers are hidden: they are not even asked for. */
  topClients: unknown | null
  /** Pi-hole's statistics per upstream: only servers that have been asked something, and old ones it still remembers. */
  upstreams: unknown
  /** The servers as configured (config.dns.upstreams): the truth about which servers are in use. */
  upstreamConfig: unknown
  history: unknown
  lists: unknown
  /** What could not be read, by name. */
  failed: string[]
}

/** Pi-hole's "version" answer: the one running, and a newer one when it knows of one. */
function piholeVersion(v: unknown): { version: string | null; newer: string | null } {
  const ver = obj(obj(v).version)
  const core = obj(obj(ver.core).local).version
  const ftl = obj(obj(ver.ftl).local).version
  const web = obj(obj(ver.web).local).version
  const docker = obj(ver.docker).local
  const running = str(docker, 40) ? `${str(docker, 40)} (core ${str(core, 20) ?? '?'}, FTL ${str(ftl, 20) ?? '?'}, web ${str(web, 20) ?? '?'})` : str(core, 40)
  const remote = str(obj(ver.docker).remote, 40) ?? str(obj(obj(ver.core).remote).version, 40)
  const localVer = str(obj(ver.docker).local, 40) ?? str(core, 40)
  return { version: running, newer: remote && localVer && remote !== localVer ? remote : null }
}

export function parsePihole(a: PiholeAnswers, now: number, hideClients: boolean): BaseReading {
  const missing = [...a.failed]
  const s = obj(a.summary)
  const q = obj(s.queries)
  const g = obj(s.gravity)
  const total = num(q.total) ?? 0
  const blocked = num(q.blocked) ?? 0
  const blocking = obj(a.blocking)
  const on = blocking.blocking === 'enabled' || (blocking.blocking !== 'disabled' && blocking.blocking !== 'failed')
  const timer = num(blocking.timer)

  const rows = (v: unknown) => arr(obj(v).domains).map(d => ({ domain: domainOf(obj(d).domain), count: num(obj(d).count) ?? 0 }))
    .filter((d): d is { domain: string; count: number } => !!d.domain)
  // The statistics hold only servers that have answered something, and keep old ones; the configuration says which are in use.
  const stats = new Map<string, UpstreamRow>()
  for (const u of arr(obj(a.upstreams).upstreams)) {
    const o = obj(u)
    const port = num(o.port)
    // Pi-hole counts its own block list and cache as "upstreams"; they have no port (-1) and are not servers.
    if (port === null || port <= 0 || !str(o.ip)) continue
    const ms = num(obj(o.statistics).response)
    const address = port === 53 ? String(o.ip) : `${o.ip}#${port}`
    stats.set(bare(address), {
      address, name: str(o.name, 120) && o.name !== o.ip ? str(o.name, 120) : null, queries: num(o.count),
      avgMs: ms === null ? null : Math.round(ms * 1000), state: 'unknown' as const, detail: null, probeMs: null,
    })
  }
  const configured = arr(obj(obj(obj(a.upstreamConfig).config).dns).upstreams).map(x => str(x, 200)).filter((x): x is string => !!x)
  const upstreams: UpstreamRow[] = configured.length
    ? configured.map(addr => stats.get(bare(addr)) ?? { address: addr, name: null, queries: null, avgMs: null, state: 'unknown' as const, detail: null, probeMs: null })
        .map((row, i) => ({ ...row, address: bare(configured[i]) === bare(row.address) ? configured[i] : row.address }))
    : [...stats.values()]

  const gravityMs = num(g.last_update) !== null ? (num(g.last_update) as number) * 1000 : null
  const lists = arr(obj(a.lists).lists).filter(l => obj(l).enabled !== false)
  const hist = arr(obj(a.history).history).map(p => ({ at: (num(obj(p).timestamp) ?? 0) * 1000, total: num(obj(p).total) ?? 0, blocked: num(obj(p).blocked) ?? 0 }))
  const { version, newer } = piholeVersion(a.version)

  const clients = hideClients || a.topClients === null ? null
    : arr(obj(a.topClients).clients).map(c => ({ name: str(obj(c).name, 120), ip: str(obj(c).ip, 64) ?? '', count: num(obj(c).count) ?? 0 })).filter(c => c.ip)

  const base: BaseReading = {
    kind: 'pihole', fetchedAt: new Date(now).toISOString(), version, newerVersion: newer,
    protection: { on, secondsLeft: !on && timer !== null ? Math.max(0, Math.round(timer)) : null },
    totals: {
      queries: total, blocked, percentBlocked: round1(num(q.percent_blocked) ?? (total ? (blocked / total) * 100 : 0)),
      cached: num(q.cached), clients: num(obj(s.clients).active), avgMs: null,
    },
    topBlocked: rows(a.topBlocked), topDomains: rows(a.topDomains),
    clients, clientsHidden: clients === null,
    upstreams,
    blocklists: { domains: num(g.domains_being_blocked), lists: lists.length || null, ...listAge(gravityMs, now) },
    history: hourly(hist, now),
    missing,
  }
  // The average answer time over the real queries that went upstream.
  const timed = upstreams.filter(u => u.avgMs !== null && (u.queries ?? 0) > 0)
  const n = timed.reduce((t, u) => t + (u.queries ?? 0), 0)
  base.totals.avgMs = n ? Math.round(timed.reduce((t, u) => t + (u.avgMs as number) * (u.queries ?? 0), 0) / n) : null
  return base
}

// ── AdGuard Home ────────────────────────────────────────────────────────────

export interface AdguardAnswers {
  status: unknown
  stats: unknown
  filtering: unknown
  dnsInfo: unknown
  /** Null when no per-client numbers are wanted. */
  clients: unknown | null
  failed: string[]
}

/** AdGuard's top lists are arrays of single-key objects: [{ "example.com": 12 }, ...]. */
function topList(v: unknown): Array<{ domain: string; count: number }> {
  return arr(v).flatMap(item => Object.entries(obj(item)).map(([k, c]) => ({ domain: domainOf(k), count: num(c) ?? 0 })))
    .filter((d): d is { domain: string; count: number } => !!d.domain)
}

/** AdGuard shows protection_disabled_duration in milliseconds when a pause is running. */
export function parseAdguard(a: AdguardAnswers, now: number, hideClients: boolean): BaseReading {
  const missing = [...a.failed]
  const st = obj(a.status)
  const s = obj(a.stats)
  const total = num(s.num_dns_queries) ?? 0
  const blocked = (num(s.num_blocked_filtering) ?? 0) + (num(s.num_replaced_safebrowsing) ?? 0) + (num(s.num_replaced_parental) ?? 0) + (num(s.num_replaced_safesearch) ?? 0)
  const on = st.protection_enabled !== false
  const until = num(st.protection_disabled_duration)
  const filters = arr(obj(a.filtering).filters).filter(f => obj(f).enabled !== false)
  const updated = filters.map(f => Date.parse(String(obj(f).last_updated ?? ''))).filter(t => Number.isFinite(t) && t > 0)
  const newest = updated.length ? Math.max(...updated) : null
  const rules = filters.reduce((t, f) => t + (num(obj(f).rules_count) ?? 0), 0)
  const avg = num(s.avg_processing_time)

  const info = obj(a.dnsInfo)
  const upstreamAddrs: string[] = arr(info.upstream_dns).map(x => str(x, 200)).filter((x): x is string => !!x)
  // AdGuard lists both as arrays of single-key objects, keyed "1.1.1.1:53" even when the setting says "1.1.1.1".
  const flat = (v: unknown) => new Map<string, unknown>(arr(v).flatMap(o => Object.entries(obj(o)).map(([k, x]) => [bare(k), x] as [string, unknown])))
  const perUpstream = flat(s.top_upstreams_avg_time)
  const perUpstreamCount = flat(s.top_upstreams_responses)
  const upstreams: UpstreamRow[] = upstreamAddrs.map(addr => {
    const ms = num(perUpstream.get(bare(addr)))
    return { address: addr, name: null, queries: num(perUpstreamCount.get(bare(addr))), avgMs: ms === null ? null : Math.round(ms * 1000), state: 'unknown' as const, detail: null, probeMs: null }
  })

  const clients = hideClients || a.clients === null ? null
    : topList(s.top_clients).map(c => ({ name: null, ip: c.domain, count: c.count }))

  // Hourly counts of the last 24 hours (AdGuard's default window), oldest first; the newest bucket is now.
  const dns = arr(s.dns_queries), bl = arr(s.blocked_filtering)
  const history: DnsHistoryPoint[] = dns.length ? dns.map((v, i) => ({
    at: (Math.floor(now / HOUR_MS) - (dns.length - 1 - i)) * HOUR_MS, total: num(v) ?? 0, blocked: num(bl[i]) ?? 0,
  })).slice(-24) : []

  const version = str(st.version, 40)
  return {
    kind: 'adguard', fetchedAt: new Date(now).toISOString(), version, newerVersion: null,
    protection: { on, secondsLeft: !on && until && until > 0 ? Math.round(until / 1000) : null },
    totals: {
      queries: total, blocked, percentBlocked: total ? round1((blocked / total) * 100) : 0,
      cached: null, clients: clients ? clients.length : null, avgMs: avg === null ? null : Math.round(avg * 1000),
    },
    topBlocked: topList(s.top_blocked_domains), topDomains: topList(s.top_queried_domains),
    clients, clientsHidden: clients === null,
    upstreams,
    blocklists: { domains: rules || null, lists: filters.length || null, ...listAge(newest, now) },
    history: history.length ? hourly(history, now) : hourly([], now),
    missing,
  }
}

// ── states and problems ─────────────────────────────────────────────────────

/** One lookup made from HyperProx to an upstream: its time, or null when it did not answer. */
export interface Probe { ok: boolean; ms: number | null }

/** Marks each upstream ok, slow or failing from the test lookup, else from the time the blocker measured. */
export function judgeUpstreams(rows: UpstreamRow[], probes: Map<string, Probe | null>): UpstreamRow[] {
  return rows.map(r => {
    const p = probes.get(r.address) ?? null
    if (p) {
      if (!p.ok) return { ...r, state: 'failing' as const, probeMs: null, detail: 'did not answer a test lookup' }
      // The blocker's own test says only yes or no; the time it measured for real queries then says fast or slow.
      const ms = p.ms ?? r.avgMs
      const slow = (ms ?? 0) > SLOW_MS
      return { ...r, probeMs: p.ms, state: slow ? 'slow' as const : 'ok' as const, detail: p.ms !== null ? `answered a test lookup in ${p.ms} ms` : r.avgMs !== null ? `answered a test lookup; ${r.avgMs} ms on average` : 'answered a test lookup' }
    }
    if (r.avgMs !== null) {
      const slow = r.avgMs > SLOW_MS
      return { ...r, state: slow ? 'slow' as const : 'ok' as const, detail: `answers in ${r.avgMs} ms on average` }
    }
    return { ...r, state: 'unknown' as const, detail: r.queries ? 'no timing reported' : 'no queries yet' }
  })
}

/** The list of things wrong with a reading, each with the button that fixes it. */
export function problemsOf(r: Omit<DnsReading, 'problems'>, name: string): Problem[] {
  const out: Problem[] = []
  if (!r.protection.on) {
    const left = r.protection.secondsLeft
    out.push({
      id: 'protection_off', severity: 'warn',
      text: left ? `Blocking is paused; it turns itself back on in ${left >= 120 ? `${Math.round(left / 60)} minutes` : `${left} seconds`}.` : 'Blocking is turned off, so nothing is being blocked.',
      fix: { action: 'resume', label: 'Turn blocking back on', secure: false },
    })
  }
  const upstreamDown = r.upstreams.some(u => u.state === 'failing')
  // A blocker that cannot reach its upstream servers is slow to answer new names: the upstream problem below says why.
  if (r.answering.ok === false && !upstreamDown) {
    out.push({
      id: 'not_answering', severity: 'bad',
      text: `${name} did not answer a test lookup, so devices using it get no DNS.`,
      fix: { action: 'restart_service', label: `Restart ${name}`, secure: true },
    })
  }
  const failing = r.upstreams.filter(u => u.state === 'failing')
  const working = r.upstreams.filter(u => u.state === 'ok' || u.state === 'slow')
  if (failing.length && !working.length && r.upstreams.length) {
    out.push({
      id: 'all_upstreams_failing', severity: 'bad',
      text: `None of its upstream DNS servers answered (${failing.map(u => u.address).join(', ')}), so anything it has not seen before fails.`,
      fix: { action: 'switch_upstream', label: 'Switch to Cloudflare', params: { to: 'cloudflare' }, secure: true },
    })
  } else if (failing.length) {
    out.push({
      id: 'upstream_failing', severity: 'warn',
      text: `${failing.map(u => u.address).join(', ')} did not answer a test lookup; ${working.length === 1 ? 'one other server is' : 'the others are'} still answering.`,
      fix: { action: 'switch_upstream', label: 'Use only the ones that answer', params: { to: 'healthy' }, secure: true },
    })
  }
  if (r.blocklists.stale) {
    out.push({
      id: 'lists_stale', severity: 'warn',
      text: `The block lists were last updated ${Math.round((r.blocklists.ageHours ?? 0) / 24)} days ago; they should refresh weekly.`,
      fix: { action: 'update_lists', label: 'Update the block lists now', secure: false },
    })
  }
  if (r.protection.on && r.totals.queries === 0 && r.answering.ok !== false) {
    out.push({
      id: 'no_queries', severity: 'info',
      text: 'No device has asked it anything yet. Point your router\'s DHCP DNS setting at its address (or a single device\'s DNS setting) to use it.',
      fix: null,
    })
  }
  return out
}

export const kindOfReading = (r: { kind: DnsKind }) => r.kind
