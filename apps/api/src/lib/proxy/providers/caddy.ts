// =============================================================================
//  HyperProx — Proxy provider: Caddy
//
//  Caddy's admin API (default :2019). HyperProx's hosts are routes with an
//  "@id" of hpx-…, inserted at the top of one server's route list, so Caddy
//  addresses them as /id/hpx-… and a later edit never depends on a position.
//  Every other route is shown read-only.
//
//  Each HyperProx route starts with a `vars` handler holding the upstream,
//  so a disabled host (its reverse_proxy swapped for a 503) still knows
//  where it pointed. Caddy persists API changes to autosave.json; run it with
//  `caddy run --resume` so a restart loads them. Health says when
//  persistence is off.
//
//  Caddy's admin API has no login of its own. Bind it to an address only
//  HyperProx can reach, or put it behind something that checks the basic
//  credentials HyperProx can send.
// =============================================================================

import { ProxyHttp, ProxyHttpError, type FetchLike, type HttpAuth } from '../http'
import { slugFor, hostPort, splitHostPort } from '../spec'
import { ProxyRefusal, type HostSpec, type ProxyCertificate, type ProxyHealth, type ProxyHostRecord, type ProxyProvider } from '../types'

const PREFIX = 'hpx-'

export interface CaddyConfig {
  adminUrl: string
  auth?:    HttpAuth
  /** The server in apps.http.servers to put hosts in; empty = the first that listens on :80 or :443. */
  server?:  string
  /** Route ids HyperProx recorded creating. A route is HyperProx's only if it is here and has the hpx- prefix. */
  owned?:   Set<string>
}

interface Route { '@id'?: string; match?: Array<{ host?: string[] }>; handle?: any[]; terminal?: boolean }

/** The reverse_proxy handler in a route, looking inside subroutes. */
function findProxy(handles: any[] | undefined): any | null {
  for (const h of handles ?? []) {
    if (h?.handler === 'reverse_proxy') return h
    if (h?.handler === 'subroute') for (const r of h.routes ?? []) { const p = findProxy(r.handle); if (p) return p }
  }
  return null
}

export class CaddyProvider implements ProxyProvider {
  readonly kind = 'caddy' as const
  readonly capabilities = { certificates: 'auto' as const, requestCertificate: false, multiDomain: true,
    disabledMeans: 'Caddy keeps the route and answers 503 for it.' }
  private http: ProxyHttp
  private serverName: string | null = null

  constructor(private cfg: CaddyConfig, fetchImpl?: FetchLike) {
    this.http = new ProxyHttp(cfg.adminUrl, cfg.auth, fetchImpl, 'Caddy')
  }

  private async server(): Promise<string> {
    if (this.cfg.server) return this.cfg.server
    if (this.serverName) return this.serverName
    const servers = (await this.http.get<Record<string, { listen?: string[] }> | null>('/config/apps/http/servers')) ?? {}
    const names = Object.keys(servers)
    const pick = names.find(n => (servers[n].listen ?? []).some(l => /:(80|443)$/.test(l))) ?? names[0]
    if (!pick) throw new ProxyRefusal('Caddy has no HTTP server configured; give the instance a server name or configure one in Caddy.')
    this.serverName = pick
    return pick
  }

  async health(): Promise<ProxyHealth> {
    const checks: ProxyHealth['checks'] = []
    let ok = true
    try {
      const srv = await this.server()
      const routes = (await this.http.get<Route[] | null>(`/config/apps/http/servers/${encodeURIComponent(srv)}/routes`)) ?? []
      checks.push({ name: 'api', ok: true, detail: `Admin API answers; server "${srv}" has ${routes.length} route(s)` })
    } catch (e: any) { ok = false; checks.push({ name: 'api', ok: false, detail: e.message }) }
    if (ok) {
      try {
        const persist = await this.http.get<boolean | null>('/config/admin/config/persist')
        const on = persist !== false
        checks.push({ name: 'persist', ok: on, warn: !on, detail: on
          ? 'Changes are saved to autosave.json; Caddy must run with --resume to load them after a restart'
          : 'admin.config.persist is false: a Caddy restart loses every change HyperProx makes' })
      } catch (e: any) { checks.push({ name: 'persist', ok: false, warn: true, detail: e.message }) }
    }
    return { ok, checks }
  }

  private record(r: Route, index: number, srv: string): ProxyHostRecord {
    const id = r['@id']
    const owned = !!id && id.startsWith(PREFIX) && !!this.cfg.owned?.has(id)
    const vars = (r.handle ?? []).find(h => h?.handler === 'vars')
    const proxy = findProxy(r.handle)
    let scheme: 'http' | 'https' = proxy?.transport?.tls ? 'https' : 'http'
    let dial: string = proxy?.upstreams?.[0]?.dial ?? ''
    if (owned && vars?.hpx_upstream) {
      const m = /^(https?):\/\/(.+)$/.exec(String(vars.hpx_upstream))
      if (m) { scheme = m[1] as 'http' | 'https'; dial = m[2] }
    }
    const { host, port } = splitHostPort(dial, scheme === 'https' ? 443 : 80)
    const disabled = owned && !proxy
    return {
      id: owned ? id! : `${srv}#${index}${id ? `:${id}` : ''}`,
      domains: (r.match ?? []).flatMap(m => m.host ?? []).map(h => h.toLowerCase()),
      forwardScheme: scheme, forwardHost: host, forwardPort: port, enabled: !disabled, owned,
      readOnlyReason: owned ? undefined : 'Made outside HyperProx (no record of HyperProx creating this Caddy route)',
      state: owned ? r : undefined,
      tls: { kind: 'auto' }, online: null, websockets: true,
      detail: proxy ? undefined : (owned ? 'Disabled: answers 503' : 'No reverse_proxy handler'),
    }
  }

  async listHosts(): Promise<ProxyHostRecord[]> {
    const srv = await this.server()
    const routes = (await this.http.get<Route[] | null>(`/config/apps/http/servers/${encodeURIComponent(srv)}/routes`)) ?? []
    return routes.map((r, i) => this.record(r, i, srv)).filter(h => h.owned || h.domains.length > 0)
  }

  private route(id: string, spec: HostSpec): Route {
    const upstream = `${spec.forwardScheme}://${hostPort(spec.forwardHost, spec.forwardPort)}`
    const proxy: any = { handler: 'reverse_proxy', upstreams: [{ dial: hostPort(spec.forwardHost, spec.forwardPort) }] }
    if (spec.forwardScheme === 'https') proxy.transport = { protocol: 'http', tls: {} }
    return {
      '@id': id,
      match: [{ host: spec.domains }],
      handle: [
        { handler: 'vars', hpx_upstream: upstream, hpx_managed: 'HyperProx' },
        spec.enabled ? proxy : { handler: 'static_response', status_code: 503, body: 'This host is disabled.' },
      ],
      terminal: true,
    }
  }

  private async ownedRoute(id: string): Promise<Route> {
    if (!id.startsWith(PREFIX) || !this.cfg.owned?.has(id)) throw new ProxyRefusal(`Caddy route ${id} was not made by HyperProx; it is read-only.`)
    try { return await this.http.get<Route>(`/id/${encodeURIComponent(id)}`) }
    catch (e) { if (e instanceof ProxyHttpError && e.status === 404) throw new ProxyRefusal(`Caddy has no route ${id}.`, 404); throw e }
  }

  async createHost(spec: HostSpec): Promise<string> {
    const srv = await this.server()
    const base = `/config/apps/http/servers/${encodeURIComponent(srv)}/routes`
    const routes = (await this.http.get<Route[] | null>(base)) ?? []
    const id = slugFor(spec, new Set(routes.map(r => r['@id']).filter(Boolean) as string[]))
    // At the top, so a catch-all route further down cannot shadow it. PUT on an index inserts there.
    if (routes.length) await this.http.json('PUT', `${base}/0`, this.route(id, spec))
    else await this.http.json('PUT', base, [this.route(id, spec)]).catch(async e => {
      // The list exists but is empty or null: PATCH replaces it.
      if (e instanceof ProxyHttpError && e.status === 409) await this.http.json('PATCH', base, [this.route(id, spec)])
      else throw e
    })
    return id
  }

  async updateHost(id: string, spec: HostSpec): Promise<void> {
    await this.ownedRoute(id)
    await this.http.json('PATCH', `/id/${encodeURIComponent(id)}`, this.route(id, spec))
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const cur = this.record(await this.ownedRoute(id), 0, '')
    await this.http.json('PATCH', `/id/${encodeURIComponent(id)}`, this.route(id, {
      domains: cur.domains, forwardScheme: cur.forwardScheme, forwardHost: cur.forwardHost, forwardPort: cur.forwardPort, enabled,
    }))
  }

  async deleteHost(id: string): Promise<void> {
    await this.ownedRoute(id)
    await this.http.json('DELETE', `/id/${encodeURIComponent(id)}`)
  }

  async listCertificates(): Promise<ProxyCertificate[]> { return [] }
}
