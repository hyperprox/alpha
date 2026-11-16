// =============================================================================
//  HyperProx — 3proxy: reading what the helper prints
//
//  `hpx-fwdproxy stats` prints one fact per line, tab-separated, so nothing
//  here parses 3proxy's own log format: the guest aggregates, this turns the
//  lines into a typed reading. Everything a guest prints is untrusted text:
//  every value is checked against what it may be, and a line that does not fit
//  is dropped, never guessed at.
// =============================================================================

import type { ProxyReading, SelfCheck, Counted } from './types'

const INT = /^\d{1,18}$/
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/
const CIDR = /^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/
const USER = /^[a-z0-9][a-z0-9._-]{0,31}$/
const VERSION = /^\d+(?:\.\d+){0,3}$/

const num = (v: string | undefined) => (v !== undefined && INT.test(v) ? Number(v) : 0)

/** Why a refusal happened, in words, by 3proxy's own code: 1 an access rule, 4 no user name, 5 no such user, 7 a wrong password. */
export function deniedLabel(code: string): string {
  if (code === '1' || code === '3') return 'Blocked by a rule'
  if (['4', '5', '6', '7'].includes(code)) return 'No or wrong password'
  return `Refused (code ${code})`
}

const top = <T extends Counted>(list: T[], n: number) => [...list].sort((a, b) => b.requests - a.requests || b.bytes - a.bytes).slice(0, n)

export function parseStats(text: string, at: number = Date.now()): ProxyReading {
  const lines = String(text ?? '').split('\n').map(l => l.replace(/\r$/, '')).filter(Boolean)
  const meta: Record<string, string> = {}, cfg: Record<string, string> = {}, now: Record<string, string> = {}
  const tot: Record<string, number> = {}
  const users: string[] = []
  const minutes = new Map<number, Counted>()
  const denied: Array<{ code: string; count: number }> = []
  const services: ProxyReading['services'] = []
  const byUser: ProxyReading['byUser'] = [], byClient: ProxyReading['byClient'] = []
  for (const line of lines) {
    const f = line.split('\t')
    switch (f[0]) {
      case 'meta': if (f.length >= 3 && /^[a-z_]{1,20}$/.test(f[1])) meta[f[1]] = f.slice(2).join('\t').slice(0, 200); break
      case 'cfg':  if (f.length >= 3 && /^[a-z_]{1,20}$/.test(f[1])) cfg[f[1]] = f.slice(2).join('\t').slice(0, 1000); break
      case 'now':  if (f.length === 3 && /^[a-z_]{1,20}$/.test(f[1]) && INT.test(f[2])) now[f[1]] = f[2]; break
      case 'tot':  if (f.length === 3 && /^[a-z_]{1,20}$/.test(f[1]) && INT.test(f[2])) tot[f[1]] = Number(f[2]); break
      case 'user': if (f.length === 2 && USER.test(f[1]) && !users.includes(f[1])) users.push(f[1]); break
      case 'min':  if (f.length === 4 && INT.test(f[1])) minutes.set(Number(f[1]), { requests: num(f[2]), bytes: num(f[3]) }); break
      case 'deny': if (f.length === 3 && /^\d{1,5}$/.test(f[1]) && INT.test(f[2])) denied.push({ code: String(Number(f[1])), count: Number(f[2]) }); break
      case 'svc':  if (f.length === 4 && (f[1] === 'PROXY' || f[1] === 'SOCKS')) services.push({ name: f[1] === 'PROXY' ? 'HTTP' : 'SOCKS', requests: num(f[2]), bytes: num(f[3]) }); break
      case 'who':
        if (f.length !== 5) break
        if (f[1] === 'user' && USER.test(f[2])) byUser.push({ name: f[2], requests: num(f[3]), bytes: num(f[4]) })
        if (f[1] === 'client' && IPV4.test(f[2])) byClient.push({ address: f[2], requests: num(f[3]), bytes: num(f[4]) })
        break
    }
  }
  const win = Math.min(1440, Math.max(1, num(meta.minutes) || 60))
  const nowSec = INT.test(meta.now ?? '') ? Number(meta.now) : Math.floor(at / 1000)
  const lastMin = Math.floor(nowSec / 60)
  const perMinute: ProxyReading['perMinute'] = []
  for (let m = lastMin - win + 1; m <= lastMin; m++) perMinute.push({ at: m * 60_000, ...(minutes.get(m) ?? { requests: 0, bytes: 0 }) })
  const perClient = cfg.perclient !== '0'
  const http = cfg.http !== '0', socks = cfg.socks !== '0'
  return {
    at: nowSec * 1000,
    active: meta.active === 'active',
    version: VERSION.test(meta.version ?? '') ? meta.version : null,
    listen: IPV4.test(meta.listen ?? '') ? meta.listen : null,
    minutes: win,
    allow: String(cfg.allow ?? '').split(/\s+/).filter(c => CIDR.test(c)),
    lanTargets: cfg.lan === '1',
    perClient,
    users,
    http, socks,
    conns: { http: http ? num(now.conns_http) : null, socks: socks ? num(now.conns_socks) : null },
    perMinute,
    totals: { requests: tot.requests ?? 0, bytes: tot.bytes ?? 0, denied: tot.denied ?? 0, errors: tot.errors ?? 0 },
    denied: denied.map(d => ({ ...d, label: deniedLabel(d.code) })).sort((a, b) => b.count - a.count),
    services,
    byUser: perClient ? top(byUser, 25) : [],
    byClient: perClient ? top(byClient, 25) : [],
  }
}

/** `hpx-fwdproxy selftest` output: one check per line. */
export function parseSelfTest(text: string): SelfCheck[] {
  const out: SelfCheck[] = []
  for (const line of String(text ?? '').split('\n')) {
    const f = line.replace(/\r$/, '').split('\t')
    if (f[0] !== 'check' || f.length < 4) continue
    if (!/^[a-z0-9_]{1,24}$/.test(f[1]) || !['ok', 'fail', 'info'].includes(f[2])) continue
    out.push({ id: f[1], state: f[2] as SelfCheck['state'], detail: f.slice(3).join(' ').slice(0, 300) })
  }
  return out
}

/** Words for each check, so the page and the install step say the same thing. */
export const CHECK_TITLE: Record<string, string> = {
  running: 'The proxy is running', source: 'Checked from the proxy',
  http_auth: 'Sign-in required (HTTP)', http_ok: 'A signed-in request works (HTTP)', connect_443: 'Tunnels only to port 443',
  self: 'Cannot reach itself (HTTP)', localhost: 'Refuses localhost by name (HTTP)', lan: 'Cannot reach your network (HTTP)',
  socks_auth: 'Sign-in required (SOCKS)', socks_ok: 'A signed-in request works (SOCKS)', socks_self: 'Cannot reach itself (SOCKS)',
  socks_localhost: 'Refuses localhost by name (SOCKS)', socks_lan: 'Cannot reach your network (SOCKS)',
}
