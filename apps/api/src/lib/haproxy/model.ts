// =============================================================================
//  HyperProx — HAProxy: one reading, as the plug-in shows it
//
//  Frontends → backends → servers, each with its live state and numbers, and
//  the problems found in them, each with the fix it offers. Pure: built from
//  the text the guest returned (lib/haproxy/runtime.ts readers), so tests feed
//  it recorded answers.
// =============================================================================

import { checkFlags, checkWords, parseConfigRouting, parseInfo, parseServersState, parseStat } from './runtime'

export type ServerState = 'up' | 'down' | 'maint' | 'drain' | 'unchecked' | 'starting'

export interface ServerView {
  name: string
  address: string
  state: ServerState
  /** HAProxy's own word (UP, DOWN, MAINT, DRAIN, no check, UP 1/2...). */
  status: string
  weight: number
  sessions: number
  sessionsMax: number
  /** New sessions per second, over the last second. */
  rate: number
  total: number
  queue: number
  errors: number
  http5xx: number
  /** Average response time over the last 1024 requests, in milliseconds (null: none yet). */
  responseMs: number | null
  check: { configured: boolean; enabled: boolean; code: string | null; words: string; durationMs: number | null; failures: number }
  /** Seconds since the state last changed. */
  lastChangeS: number | null
  downtimeS: number
  /** Added at runtime ("add server"), not in the configuration file. */
  dynamic: boolean
}

export interface BackendView {
  name: string
  status: string
  algorithm: string | null
  sessions: number
  rate: number
  errors: number
  http5xx: number
  responseMs: number | null
  servers: ServerView[]
  healthy: number
  /** HAProxy's own and HyperProx's monitoring sections, folded away by the page. */
  internal: boolean
}

export interface FrontendView {
  name: string
  status: string
  sessions: number
  rate: number
  requestRate: number
  errors: number
  http5xx: number
  binds: string[]
  backends: string[]
  internal: boolean
}

export type FixId = 'drain' | 'retry' | 'ready' | 'enable-health' | 'check-config' | 'add-server'

export interface Problem {
  id: string
  severity: 'critical' | 'bad' | 'warn' | 'info'
  title: string
  detail: string
  backend?: string
  server?: string
  fixes: Array<{ id: FixId; label: string; confirm?: string }>
}

export interface Reading {
  fetchedAt: string
  version: string | null
  uptimeS: number | null
  currentConnections: number | null
  frontends: FrontendView[]
  backends: BackendView[]
  config: { ok: boolean; error: string | null }
  problems: Problem[]
}

const INTERNAL = new Set(['hpx_stats', 'hpx_metrics', 'stats'])
const num = (v: string | undefined): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const optNum = (v: string | undefined): number | null => (v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)

export function serverState(status: string): ServerState {
  const s = status.toUpperCase()
  if (s.startsWith('MAINT')) return 'maint'
  if (s.startsWith('DRAIN') || s === 'NOLB') return 'drain'
  if (s.startsWith('DOWN')) return 'down'
  if (s === 'NO CHECK') return 'unchecked'
  if (/^UP \d+\/\d+$/.test(s) || /^DOWN \d+\/\d+$/.test(s)) return s.startsWith('UP') ? 'up' : 'down'
  if (s.startsWith('UP')) return 'up'
  return 'starting'
}

export interface RawReading { info: string; stat: string; state: string; config: string; configCheck: { code: number; output: string } }

export function buildReading(raw: RawReading, now = new Date()): Reading {
  const info = parseInfo(raw.info)
  const stat = parseStat(raw.stat)
  const st = new Map(parseServersState(raw.state).map(r => [`${r.be_name}/${r.srv_name}`, r]))
  const routing = parseConfigRouting(raw.config)
  const inConfig = (b: string, s: string) => new RegExp(`^\\s*server\\s+${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`, 'm').test(sectionText(raw.config, b))

  const backends: BackendView[] = []
  const byName = new Map<string, BackendView>()
  for (const r of stat) {
    if (r.svname !== 'BACKEND') continue
    const b: BackendView = {
      name: r.pxname, status: r.status, algorithm: r.algo || routing.backends[r.pxname]?.balance || null,
      sessions: num(r.scur), rate: num(r.rate), errors: num(r.econ) + num(r.eresp), http5xx: num(r.hrsp_5xx), responseMs: optNum(r.rtime),
      servers: [], healthy: 0, internal: INTERNAL.has(r.pxname),
    }
    backends.push(b); byName.set(b.name, b)
  }
  for (const r of stat) {
    if (r.svname === 'BACKEND' || r.svname === 'FRONTEND') continue
    const b = byName.get(r.pxname)
    if (!b) continue
    const s = st.get(`${r.pxname}/${r.svname}`)
    const flags = checkFlags(s?.srv_check_state)
    const state = serverState(r.status)
    const code = r.check_status ? r.check_status.replace(/^\*\s*/, '') : null
    b.servers.push({
      name: r.svname, address: r.addr || s?.srv_addr || '', state, status: r.status, weight: num(r.weight),
      sessions: num(r.scur), sessionsMax: num(r.smax), rate: num(r.rate), total: num(r.stot), queue: num(r.qcur),
      errors: num(r.econ) + num(r.eresp), http5xx: num(r.hrsp_5xx), responseMs: optNum(r.rtime),
      check: { configured: flags.configured || !!code, enabled: flags.enabled, code, words: checkWords(code ?? '', r.check_desc, r.check_code), durationMs: optNum(r.check_duration), failures: num(r.chkfail) },
      lastChangeS: optNum(r.lastchg), downtimeS: num(r.downtime), dynamic: !inConfig(r.pxname, r.svname),
    })
  }
  for (const b of backends) b.healthy = b.servers.filter(s => s.state === 'up' || s.state === 'unchecked').length

  const frontends: FrontendView[] = stat.filter(r => r.svname === 'FRONTEND').map(r => ({
    name: r.pxname, status: r.status, sessions: num(r.scur), rate: num(r.rate), requestRate: num(r.req_rate),
    errors: num(r.ereq), http5xx: num(r.hrsp_5xx), binds: routing.frontends[r.pxname]?.binds ?? [],
    backends: (routing.frontends[r.pxname]?.backends ?? []).filter(n => byName.has(n)), internal: INTERNAL.has(r.pxname),
  }))

  const config = raw.configCheck.code === 0 ? { ok: true, error: null } : { ok: false, error: cleanCheck(raw.configCheck.output) }
  return {
    fetchedAt: now.toISOString(), version: info.Version ?? null, uptimeS: optNum(info.Uptime_sec), currentConnections: optNum(info.CurrConns),
    frontends, backends, config, problems: problemsOf(backends, config),
  }
}

/** The text of one section (backend or listen) of the configuration. */
function sectionText(cfg: string, name: string): string {
  const lines = cfg.split('\n')
  const out: string[] = []
  let on = false
  for (const l of lines) {
    const sec = /^(backend|listen|frontend|defaults|global|\S+)\b\s*(\S*)/.exec(l)
    if (sec && !/^\s/.test(l) && l.trim()) on = (sec[1] === 'backend' || sec[1] === 'listen') && sec[2] === name
    else if (on) out.push(l)
  }
  return out.join('\n')
}

/** The errors of haproxy -c, one per line, as "line N: what" (no file paths, no notices, warnings or summary lines). */
export function cleanCheck(out: string): string {
  const lines = out.split('\n').map(l => l.trim())
    .filter(l => /^\[ALERT\]/.test(l) && !/Error\(s\) found in configuration file|Fatal errors found in configuration/.test(l))
    .map(l => l.replace(/^\[ALERT\]\s*\(\d+\)\s*:\s*/, '').replace(/^config\s*:\s*/, '')
      .replace(/parsing \[[^\]]*?:(\d+)\]\s*:\s*/, 'line $1: ').replace(/\/(?:[\w.-]+\/)*[\w.-]+\.cfg/g, 'the configuration'))
  return lines.join('\n').slice(0, 1200) || out.trim().split('\n').slice(-3).join(' ').slice(0, 600) || 'haproxy -c failed without saying why.'
}

const ago = (s: number | null) => s === null ? '' : s < 120 ? `${s} seconds` : s < 7200 ? `${Math.round(s / 60)} minutes` : s < 172800 ? `${Math.round(s / 3600)} hours` : `${Math.round(s / 86400)} days`

export function problemsOf(backends: BackendView[], config: Reading['config']): Problem[] {
  const out: Problem[] = []
  if (!config.ok) out.push({
    id: 'config', severity: 'bad', title: 'The configuration does not pass haproxy -c',
    detail: `HAProxy is still running the last configuration that loaded, but it will not reload or restart until this is fixed: ${config.error}`,
    fixes: [{ id: 'check-config', label: 'Check again' }],
  })
  for (const b of backends) {
    if (b.internal) continue
    if (!b.servers.length) {
      out.push({ id: `empty:${b.name}`, severity: 'warn', backend: b.name, title: `${b.name} has no servers`,
        detail: 'Every request sent to this backend gets a 503. Add a server to it.', fixes: [{ id: 'add-server', label: 'Add a server' }] })
      continue
    }
    if (b.healthy === 0) {
      const parked = b.servers.filter(s => s.state === 'maint' || s.state === 'drain')
      out.push({ id: `nohealthy:${b.name}`, severity: 'critical', backend: b.name, title: `${b.name} has no healthy server: visitors get errors`,
        detail: parked.length
          ? `Every request to it fails with 503. ${parked.map(s => `${s.name} is in ${s.state === 'maint' ? 'maintenance' : 'drain'}`).join(', ')}; the others are down.`
          : `Every request to it fails with 503. All ${b.servers.length} server${b.servers.length === 1 ? ' is' : 's are'} down.`,
        fixes: parked.length ? [{ id: 'ready', label: `Bring ${parked[0].name} back` }, { id: 'retry', label: 'Check every server again' }] : [{ id: 'retry', label: 'Check every server again' }] })
    }
    for (const s of b.servers) {
      if (s.state === 'down' && s.check.enabled) {
        out.push({ id: `down:${b.name}/${s.name}`, severity: b.healthy === 0 ? 'bad' : 'bad', backend: b.name, server: s.name,
          title: `${s.name} in ${b.name} is down`,
          detail: `Its health check says ${s.check.words}${s.lastChangeS !== null ? `, for ${ago(s.lastChangeS)}` : ''}. HAProxy sends it no traffic while it is down.`,
          fixes: [{ id: 'drain', label: 'Drain and investigate', confirm: `Put ${s.name} in drain, so it gets no new visitors even if its check passes again, while you look at it?` },
            { id: 'retry', label: 'Check it again now' }] })
      } else if (s.state === 'down' && !s.check.enabled && s.check.configured) {
        out.push({ id: `nocheck-down:${b.name}/${s.name}`, severity: 'warn', backend: b.name, server: s.name, title: `${s.name} in ${b.name} is down with its health check off`,
          detail: 'With the check off, HAProxy cannot see when it comes back.', fixes: [{ id: 'enable-health', label: 'Turn its health check on' }] })
      } else if (s.state === 'maint' && (s.lastChangeS ?? 0) > 86_400) {
        out.push({ id: `maint:${b.name}/${s.name}`, severity: 'info', backend: b.name, server: s.name, title: `${s.name} has been in maintenance for ${ago(s.lastChangeS)}`,
          detail: 'It gets no traffic. Bring it back when the work on it is done.', fixes: [{ id: 'ready', label: 'Bring it back' }] })
      } else if (s.check.configured && !s.check.enabled && s.state !== 'maint') {
        out.push({ id: `nocheck:${b.name}/${s.name}`, severity: 'info', backend: b.name, server: s.name, title: `${s.name}'s health check is off`,
          detail: 'HAProxy keeps sending it visitors even if it stops answering.', fixes: [{ id: 'enable-health', label: 'Turn its health check on' }] })
      }
    }
  }
  const rank = { critical: 0, bad: 1, warn: 2, info: 3 }
  return out.sort((a, b) => rank[a.severity] - rank[b.severity])
}

/** The gallery card's numbers. */
export function tileNumbers(r: Reading): { backends: number; servers: number; up: number; down: number; critical: number; problems: number } {
  const bs = r.backends.filter(b => !b.internal)
  const ss = bs.flatMap(b => b.servers)
  return { backends: bs.length, servers: ss.length, up: ss.filter(s => s.state === 'up' || s.state === 'unchecked').length,
    down: ss.filter(s => s.state === 'down').length, critical: r.problems.filter(p => p.severity === 'critical').length, problems: r.problems.length }
}
