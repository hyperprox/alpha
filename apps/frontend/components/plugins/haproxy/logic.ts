// =============================================================================
//  HyperProx — HAProxy plug-in page: the shapes the API answers, and the pure
//  logic the page draws from (tested on its own in test/haproxy-plugin.test.tsx)
// =============================================================================

export type ServerState = 'up' | 'down' | 'maint' | 'drain' | 'unchecked' | 'starting'

export interface ServerView {
  name: string; address: string; state: ServerState; status: string; weight: number
  sessions: number; sessionsMax: number; rate: number; total: number; queue: number; errors: number; http5xx: number
  responseMs: number | null
  check: { configured: boolean; enabled: boolean; code: string | null; words: string; durationMs: number | null; failures: number }
  lastChangeS: number | null; downtimeS: number; dynamic: boolean
}
export interface BackendView {
  name: string; status: string; algorithm: string | null; sessions: number; rate: number; errors: number; http5xx: number
  responseMs: number | null; servers: ServerView[]; healthy: number; internal: boolean
}
export interface FrontendView {
  name: string; status: string; sessions: number; rate: number; requestRate: number; errors: number; http5xx: number
  binds: string[]; backends: string[]; internal: boolean
}
export type FixId = 'drain' | 'retry' | 'ready' | 'enable-health' | 'check-config' | 'add-server'
export interface Problem {
  id: string; severity: 'critical' | 'bad' | 'warn' | 'info'; title: string; detail: string; backend?: string; server?: string
  fixes: Array<{ id: FixId; label: string; confirm?: string }>
}
export interface Reading {
  fetchedAt: string; version: string | null; uptimeS: number | null; currentConnections: number | null
  frontends: FrontendView[]; backends: BackendView[]; config: { ok: boolean; error: string | null }; problems: Problem[]
}
export interface Instance {
  id: string; name: string; guest: { kind: 'lxc' | 'qemu'; vmid: number }; socket: string
  proxyInstanceId: string | null; via: string; addedAt: number; saves: boolean
}
export interface PickGuest { kind: 'lxc' | 'qemu'; vmid: number; name: string; node: string; address: string }

/** Each state in words and the tone it is drawn in. Colour is never the only signal: the word is always shown. */
export const STATE: Record<ServerState, { word: string; tone: 'good' | 'bad' | 'warn' | 'off' | 'accent' }> = {
  up: { word: 'Up', tone: 'good' }, down: { word: 'Down', tone: 'bad' }, maint: { word: 'Maintenance', tone: 'off' },
  drain: { word: 'Draining', tone: 'warn' }, unchecked: { word: 'Up (no check)', tone: 'accent' }, starting: { word: 'Starting', tone: 'warn' },
}

export const SEVERITY_WORD: Record<Problem['severity'], string> = { critical: 'Outage', bad: 'Problem', warn: 'Warning', info: 'Note' }

/** Seconds in a short human form: 45s, 12m, 3h, 2d. */
export function since(s: number | null): string {
  if (s === null || !Number.isFinite(s)) return '—'
  if (s < 90) return `${Math.round(s)}s`
  if (s < 5400) return `${Math.round(s / 60)}m`
  if (s < 172_800) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86_400)}d`
}

export function ms(v: number | null): string { return v === null ? '—' : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s` }

/** The frontends people's traffic arrives on, each with its backends; backends no public frontend sends to, apart. */
export function layout(r: Reading): { lanes: Array<{ frontend: FrontendView; backends: BackendView[] }>; unrouted: BackendView[] } {
  const byName = new Map(r.backends.map(b => [b.name, b]))
  const lanes = r.frontends.filter(f => !f.internal).map(f => ({ frontend: f, backends: f.backends.map(n => byName.get(n)).filter((b): b is BackendView => !!b && !b.internal) }))
  const routed = new Set(lanes.flatMap(l => l.backends.map(b => b.name)))
  return { lanes, unrouted: r.backends.filter(b => !b.internal && !routed.has(b.name)) }
}

/** A bar's fill (0..1) against the busiest server on the page, so bars compare across backends. */
export function share(v: number, max: number): number { return max > 0 ? Math.min(1, Math.max(0, v / max)) : 0 }

export function busiest(r: Reading): { sessions: number; weight: number } {
  const ss = r.backends.filter(b => !b.internal).flatMap(b => b.servers)
  return { sessions: Math.max(1, ...ss.map(s => s.sessions)), weight: Math.max(1, ...ss.map(s => s.weight)) }
}

/** The headline numbers for the HUD. */
export function summary(r: Reading): { backends: number; servers: number; up: number; down: number; parked: number; worst: Problem['severity'] | null } {
  const bs = r.backends.filter(b => !b.internal)
  const ss = bs.flatMap(b => b.servers)
  const worst = r.problems[0]?.severity ?? null
  return { backends: bs.length, servers: ss.length, up: ss.filter(s => s.state === 'up' || s.state === 'unchecked').length,
    down: ss.filter(s => s.state === 'down').length, parked: ss.filter(s => s.state === 'maint' || s.state === 'drain').length, worst }
}

/** Which actions a server's sheet offers in its current state. */
export function serverActions(s: ServerView): Array<{ id: 'ready' | 'drain' | 'maint'; label: string; destructive: boolean }> {
  const out: Array<{ id: 'ready' | 'drain' | 'maint'; label: string; destructive: boolean }> = []
  if (s.state === 'maint' || s.state === 'drain') out.push({ id: 'ready', label: 'Bring back into service', destructive: false })
  if (s.state !== 'drain' && s.state !== 'maint') out.push({ id: 'drain', label: 'Drain (finish current visitors, no new ones)', destructive: true })
  if (s.state !== 'maint') out.push({ id: 'maint', label: 'Maintenance (no traffic at all)', destructive: true })
  return out
}

/** The confirmation a destructive action asks, in words, or null when it needs none. */
export function confirmText(action: string, backend: string, server: string | null, persist: boolean): string | null {
  const keep = persist ? ' This is saved to the configuration and HAProxy reloads.' : ' It lasts until HAProxy restarts.'
  switch (action) {
    case 'drain': return `Drain ${server} in ${backend}? It finishes the visitors it has and gets no new ones.${keep}`
    case 'maint': return `Put ${server} in maintenance? It stops getting traffic straight away.${keep}`
    case 'remove-server': return `Remove ${server} from ${backend}?${persist ? ' It is deleted from the configuration.' : ' Its open connections are closed now; it comes back when HAProxy restarts, because it is still in the configuration.'}`
    case 'health-off': return `Turn off ${server}'s health check? HAProxy will keep sending it visitors even if it stops answering.${keep}`
    case 'balance': return `Change how ${backend} spreads visitors? This is saved to the configuration and HAProxy reloads.`
    default: return null
  }
}

/** Names the two kinds of balancing apart, in the modal and the install step. */
export const PROXY_LB_LINE = 'Proxy load balancing spreads one app\'s traffic across several guests. (The Load balancing page is different: it moves guests between nodes.)'

/** The "Proxy load balancing" form, checked before it is sent (the API checks it all again). */
export interface LbForm { name: string; guests: string[]; port: string; hostname: string; algorithm: string; checkPath: string; publish: boolean; zone: string; proxyInstanceId: string }

/** The request body for the form: what the plug-in's button and the install step both send. */
export function lbBody(f: LbForm) {
  return { ...f, guests: f.guests.map(k => { const [kind, vmid] = k.split('-'); return { kind, vmid: Number(vmid) } }), port: Number(f.port), hostname: f.hostname || undefined }
}

export function lbProblems(f: LbForm): string[] {
  const out: string[] = []
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(f.name.trim())) out.push('Give the app a short name: letters, digits, - and _.')
  if (f.guests.length < 2) out.push('Pick at least two guests running the same app.')
  const p = Number(f.port)
  if (!Number.isInteger(p) || p < 1 || p > 65535) out.push('The port the app answers on is a number from 1 to 65535.')
  if (f.hostname && !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(f.hostname.trim())) out.push('The name is a full host name, such as app.example.com.')
  if (!/^\/[A-Za-z0-9._~/-]{0,200}$/.test(f.checkPath)) out.push('The health check path starts with / and has no spaces.')
  if (f.publish) {
    if (!f.hostname) out.push('Publishing needs the host name visitors will use.')
    if (!f.zone) out.push('Pick the domain the name is in.')
    else if (f.hostname && !(f.hostname.toLowerCase() === f.zone.toLowerCase() || f.hostname.toLowerCase().endsWith(`.${f.zone.toLowerCase()}`))) out.push(`${f.hostname} is not in ${f.zone}.`)
    if (!f.proxyInstanceId) out.push('Pick the proxy that will serve the public name.')
  }
  return out
}
