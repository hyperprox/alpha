// =============================================================================
//  HyperProx — NGINX, Caddy and Envoy plug-in pages: the pure part
//
//  The reading as the API sends it (lib/webproxy), and what the page draws
//  from it: the health verdict, the HUD chips, the route map's rows, each
//  certificate's remaining life. No React here, so it is tested on its own.
// =============================================================================

export type Kind = 'nginx' | 'caddy' | 'envoy'
export const KIND_NAME: Record<Kind, string> = { nginx: 'NGINX', caddy: 'Caddy', envoy: 'Envoy' }
export const KIND_ICON: Record<Kind, string> = { nginx: 'router', caddy: 'lock', envoy: 'mesh' }

export interface Action { id: string; label: string; confirm: string; danger?: boolean }
export interface Problem { id: string; severity: 'error' | 'warning'; title: string; detail: string; fix?: Action }
export interface Cert { name: string; path: string; notAfter: string | null; daysLeft: number | null; issuer?: string; ending: boolean; expired: boolean }
type Classes = Record<'1' | '2' | '3' | '4' | '5', number>

export interface NginxDetail {
  kind: 'nginx'; version: string | null; running: boolean | null; configOk: boolean; configMessage: string
  status: { active: number; accepts: number; handled: number; requests: number; reading: number; writing: number; waiting: number } | null
  sites: Array<{ file: string; names: string[]; listens: string[]; ssl: boolean; proxyPass: string | null; certificate: string | null; kind: string; defaultServer: boolean; owned: boolean }>
  upstreams: Array<{ file: string; name: string; servers: string[] }>
  certs: Cert[]; traffic: { total: number; byClass: Classes; errorRate: number | null }; certbot: boolean; openssl: boolean
  reach?: Record<string, boolean>
}
export interface CaddyDetail {
  kind: 'caddy'; version: string | null; unit: string | null; running: boolean | null; adminOk: boolean
  servers: Array<{ name: string; listen: string[] }>
  routes: Array<{ id: string | null; server: string; hosts: string[]; upstreams: string[]; handler: string }>
  upstreams: Array<{ address: string; requests: number; fails: number; reachable: boolean | null }>
  certs: Cert[]; missingCerts: string[]; persist: boolean; openssl: boolean
}
export interface EnvoyDetail {
  kind: 'envoy'; version: string | null; running: boolean | null; admin: string; adminOk: boolean; state: string | null; uptimeSeconds: number | null; draining: boolean
  listeners: Array<{ name: string; address: string }>
  clusters: Array<{ name: string; hosts: Array<{ address: string; healthy: boolean; flags: string[]; requests: number; errors: number }> }>
  requests: { total: number; byClass: Classes; errorRate: number | null }; dynamicFiles: string[]; unit: boolean
}
export type Detail = NginxDetail | CaddyDetail | EnvoyDetail

export interface Reading {
  id: string; kind: Kind; name: string; vmid: number; node: string; at: number; ok: boolean; error?: string
  detail: Detail | null; problems: Problem[]; actions: Action[]
}
export interface Found { machineId: string; vmid: number; node: string; name: string; running: boolean; via: string[] }

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
export const pct = (x: number | null) => (x === null ? '—' : x === 0 ? '0%' : x < 0.001 ? '<0.1%' : `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`)

/** The verdict the HUD shows: one word, its tone, and a 0..1 health for the ring. */
export function verdictOf(r: Reading): { text: string; tone: 'good' | 'warn' | 'bad'; score: number } {
  if (!r.detail) return { text: 'unreachable', tone: 'bad', score: 0 }
  const err = r.problems.filter(p => p.severity === 'error').length, warn = r.problems.length - err
  if (err) return { text: 'needs a fix', tone: 'bad', score: Math.max(0.15, 0.5 - 0.15 * (err - 1)) }
  if (warn) return { text: 'needs a look', tone: 'warn', score: Math.max(0.55, 0.85 - 0.1 * (warn - 1)) }
  return { text: 'healthy', tone: 'good', score: 1 }
}

/** 5xx share for the inner ring, and what it covers in words. */
export function errorShare(d: Detail | null): { rate: number | null; over: string } {
  if (!d) return { rate: null, over: '' }
  if (d.kind === 'nginx') return { rate: d.traffic.errorRate, over: 'last 5 minutes' }
  if (d.kind === 'envoy') return { rate: d.requests.errorRate, over: 'since Envoy started' }
  return { rate: null, over: '' }
}

/** The HUD's chips for one proxy. */
export function chipsOf(r: Reading): Array<{ label: string; value: string | number; tone?: 'accent' | 'good' | 'warn' | 'crit' | 'dim' }> {
  const d = r.detail
  if (!d) return [{ label: 'state', value: 'unreachable', tone: 'crit' }]
  const out: Array<{ label: string; value: string | number; tone?: 'accent' | 'good' | 'warn' | 'crit' | 'dim' }> = [{ label: 'version', value: d.version ?? '—', tone: 'accent' }]
  if (d.kind === 'nginx') {
    out.push({ label: 'sites', value: d.sites.filter(s => s.names.length).length })
    out.push({ label: 'connections', value: d.status?.active ?? '—' })
    out.push({ label: '5xx · 5 min', value: pct(d.traffic.errorRate), tone: (d.traffic.errorRate ?? 0) > 0.05 ? 'crit' : 'good' })
  }
  if (d.kind === 'caddy') {
    out.push({ label: 'routes', value: d.routes.filter(x => x.hosts.length).length })
    out.push({ label: 'certificates', value: d.certs.length, tone: d.missingCerts.length ? 'warn' : 'good' })
    const down = d.upstreams.filter(u => u.reachable === false).length
    out.push({ label: 'upstreams down', value: down, tone: down ? 'crit' : 'good' })
  }
  if (d.kind === 'envoy') {
    out.push({ label: 'state', value: d.draining ? 'drained' : (d.state ?? '—').toLowerCase(), tone: d.draining ? 'warn' : d.state === 'LIVE' ? 'good' : 'dim' })
    out.push({ label: 'clusters', value: d.clusters.length })
    const sick = d.clusters.reduce((n, c) => n + c.hosts.filter(h => !h.healthy).length, 0)
    out.push({ label: 'hosts unhealthy', value: sick, tone: sick ? 'crit' : 'good' })
  }
  return out
}

export type Dot = 'ok' | 'warn' | 'bad' | 'off'

/** One line of the route map: names on the left, where they go on the right, each target with its dot. */
export interface RouteRow { key: string; names: string[]; tls: boolean; via: string; targets: Array<{ label: string; state: Dot }>; mine: boolean; note?: string }

const reachDot = (v: boolean | null | undefined): Dot => (v === true ? 'ok' : v === false ? 'bad' : 'off')

export function routeRows(d: Detail): RouteRow[] {
  if (d.kind === 'nginx') {
    const reach = d.reach ?? {}
    return d.sites.filter(s => s.names.length || s.defaultServer).map((s, i) => {
      const up = s.proxyPass ? d.upstreams.find(u => s.proxyPass === `http://${u.name}` || s.proxyPass === `https://${u.name}`) : undefined
      const direct = s.proxyPass && !up ? s.proxyPass.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : null
      const targets = up ? up.servers.map(x => ({ label: x, state: reachDot(reach[x]) }))
        : direct ? [{ label: direct, state: reachDot(reach[direct]) }]
          : [{ label: s.kind === 'static' ? 'files' : s.kind === 'redirect' ? 'answers itself' : '—', state: 'off' as Dot }]
      return { key: `${s.file}#${i}`, names: s.names.length ? s.names : ['(any other name)'], tls: s.ssl, via: up ? `upstream ${up.name}` : 'NGINX', targets, mine: s.owned,
        note: s.owned ? 'published from the Proxy page' : s.file.split('/').slice(-1)[0] }
    })
  }
  if (d.kind === 'caddy') {
    const by = new Map(d.upstreams.map(u => [u.address, u]))
    const tls = new Set(d.servers.filter(s => s.listen.some(l => /:443$/.test(l))).map(s => s.name))
    return d.routes.filter(x => x.hosts.length).map((x, i) => ({
      key: `${x.server}#${i}`, names: x.hosts, tls: tls.has(x.server), via: 'Caddy', mine: !!x.id?.startsWith('hpx-'),
      targets: x.upstreams.length ? x.upstreams.map(a => ({ label: a, state: (by.get(a)?.fails ? 'warn' : reachDot(by.get(a)?.reachable)) as Dot }))
        : [{ label: x.handler === 'static' ? 'answers itself' : x.handler === 'files' ? 'files' : x.handler, state: 'off' }],
      note: x.id?.startsWith('hpx-') ? 'published from the Proxy page' : undefined,
    }))
  }
  return d.clusters.map(c => ({
    key: c.name, names: [c.name], tls: false, via: 'cluster', mine: false,
    targets: c.hosts.length ? c.hosts.map(h => ({ label: h.address, state: (h.healthy ? 'ok' : 'bad') as Dot })) : [{ label: 'no hosts', state: 'off' as Dot }],
    note: c.hosts.some(h => !h.healthy) ? c.hosts.filter(h => !h.healthy).map(h => `${h.address}: ${h.flags.join(', ') || 'unhealthy'}`).join('; ') : undefined,
  }))
}

/** A certificate's remaining life as a share of 90 days (the usual ACME life), and its words. */
export function certLife(c: Cert): { value: number; words: string; tone: 'good' | 'warn' | 'bad' } {
  if (c.expired) return { value: 0, words: 'expired', tone: 'bad' }
  if (c.daysLeft === null) return { value: 0, words: 'end date unknown', tone: 'warn' }
  const words = c.daysLeft < 1 ? 'ends within a day' : `${plural(c.daysLeft, 'day')} left`
  return { value: Math.min(1, c.daysLeft / 90), words, tone: c.ending ? 'warn' : 'good' }
}

/** Requests by status class as bars. */
export function classBars(c: Classes): Array<{ key: string; label: string; value: number; text: string }> {
  return (['2', '3', '4', '5'] as const).map(k => ({ key: k, label: `${k}xx`, value: c[k], text: String(c[k]) }))
}

/** Where a found proxy was seen, in words. */
export const viaWords = (v: string[]) => v.map(x => ({ catalogue: 'Catalogue install', detect: 'Catalogue detection', marker: 'install note' } as Record<string, string>)[x] ?? x).join(', ')

/** Uptime in words. */
export function uptime(s: number | null): string {
  if (s === null) return '—'
  if (s < 90) return `${s}s`
  if (s < 5400) return `${Math.round(s / 60)} min`
  if (s < 172800) return `${Math.round(s / 3600)} h`
  return `${Math.round(s / 86400)} days`
}
