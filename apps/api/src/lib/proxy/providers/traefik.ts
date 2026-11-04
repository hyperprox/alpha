// =============================================================================
//  HyperProx — Proxy provider: Traefik
//
//  Reads through Traefik's API (/api/http/routers and /services), writes one
//  HyperProx-owned file for Traefik's file provider. The file carries a header
//  that says so; a file without it is never overwritten. Only routers in that
//  file are HyperProx's; every other router (labels, other files, other
//  providers) is shown read-only.
//
//  Traefik has no "disabled" switch. A disabled host keeps its router and
//  service and gains the hpx-disabled middleware, an allow-list no client
//  matches, so Traefik answers 403 for it until it is enabled again.
// =============================================================================

// js-yaml ships no types; only load() and dump() are used.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load(src: string): unknown; dump(v: unknown, o?: Record<string, unknown>): string }
import { ProxyHttp, type FetchLike, type HttpAuth } from '../http'
import { slugFor, parseUpstreamUrl } from '../spec'
import type { FileTransport } from '../transport'
import { ProxyRefusal, type HostSpec, type ProxyCertificate, type ProxyHealth, type ProxyHostRecord, type ProxyProvider } from '../types'

export const TRAEFIK_HEADER = '# Managed by HyperProx. This file is rewritten whole on every change; put hand-made routers in another file.'
const DISABLED_MW = 'hpx-disabled'
const PREFIX = 'hpx-'

export interface TraefikConfig {
  apiUrl:        string
  auth?:         HttpAuth
  file:          string
  entryPoints:   string[]
  /** Set to give HyperProx's routers TLS from this certificate resolver. */
  certResolver?: string
  transport:     FileTransport
  /** How long to wait for Traefik to pick the file up. */
  settleMs?:     number
}

interface Router { name: string; provider: string; rule: string; service: string; entryPoints?: string[]; middlewares?: string[]; status?: string; tls?: { certResolver?: string } }
interface Service { name: string; provider: string; loadBalancer?: { servers?: { url: string }[] }; serverStatus?: Record<string, string> }

interface DynFile {
  http: {
    routers:     Record<string, any>
    services:    Record<string, any>
    middlewares: Record<string, any>
  }
}

/** Every Host(`name`) in a rule. */
export function hostsInRule(rule: string): string[] {
  const out: string[] = []
  const re = /Host\(\s*((?:`[^`]*`\s*,?\s*)+)\)/g
  for (let m; (m = re.exec(rule));) for (const n of m[1].matchAll(/`([^`]*)`/g)) out.push(n[1].toLowerCase())
  return out
}

export function ruleFor(domains: string[]): string {
  return domains.map(d => `Host(\`${d}\`)`).join(' || ')
}

export class TraefikProvider implements ProxyProvider {
  readonly kind = 'traefik' as const
  readonly capabilities = { certificates: 'auto' as const, requestCertificate: false, multiDomain: true,
    disabledMeans: 'Traefik keeps the router and answers 403 for it (the hpx-disabled allow-list).' }
  private http: ProxyHttp

  constructor(private cfg: TraefikConfig, fetchImpl?: FetchLike, private wait: (ms: number) => Promise<unknown> = ms => new Promise(r => setTimeout(r, ms))) {
    this.http = new ProxyHttp(cfg.apiUrl, cfg.auth, fetchImpl, 'Traefik')
  }

  async health(): Promise<ProxyHealth> {
    const checks: ProxyHealth['checks'] = []
    let version: string | undefined
    let ok = true
    try {
      const v = await this.http.get<{ Version?: string }>('/api/version')
      version = v?.Version
      checks.push({ name: 'api', ok: true, detail: `Traefik ${version ?? '(version unknown)'} answers` })
    } catch (e: any) { ok = false; checks.push({ name: 'api', ok: false, detail: e.message }) }
    try {
      const f = await this.cfg.transport.read(this.cfg.file)
      if (f === null) checks.push({ name: 'file', ok: true, detail: `${this.cfg.file} does not exist yet; HyperProx creates it on the first host` })
      else if (!f.startsWith(TRAEFIK_HEADER)) { ok = false; checks.push({ name: 'file', ok: false, detail: `${this.cfg.file} exists but was not written by HyperProx; it will not be overwritten` }) }
      else checks.push({ name: 'file', ok: true, detail: `${this.cfg.file} is HyperProx's (${this.cfg.transport.describe()})` })
    } catch (e: any) { ok = false; checks.push({ name: 'file', ok: false, detail: e.message }) }
    return { ok, version, checks }
  }

  // --- the HyperProx file --------------------------------------------------------------------------

  private async readFile(): Promise<DynFile> {
    const text = await this.cfg.transport.read(this.cfg.file)
    const empty: DynFile = { http: { routers: {}, services: {}, middlewares: {} } }
    if (text === null || !text.trim()) return empty
    if (!text.startsWith(TRAEFIK_HEADER)) throw new ProxyRefusal(`${this.cfg.file} on the Traefik host was not written by HyperProx, so HyperProx will not change it. Point the instance at a file of its own.`)
    const doc = (yaml.load(text) ?? {}) as any
    return { http: { routers: { ...(doc.http?.routers ?? {}) }, services: { ...(doc.http?.services ?? {}) }, middlewares: { ...(doc.http?.middlewares ?? {}) } } }
  }

  private async writeFile(doc: DynFile): Promise<void> {
    const http: any = { routers: doc.http.routers, services: doc.http.services }
    const anyDisabled = Object.values(doc.http.routers).some((r: any) => (r.middlewares ?? []).includes(DISABLED_MW))
    if (anyDisabled) http.middlewares = { [DISABLED_MW]: { ipAllowList: { sourceRange: ['255.255.255.255/32'] } } }
    const body = Object.keys(doc.http.routers).length ? yaml.dump({ http }, { lineWidth: 200, noRefs: true }) : '{}\n'
    await this.cfg.transport.write(this.cfg.file, `${TRAEFIK_HEADER}\n${body}`)
  }

  private routerFor(spec: HostSpec, service: string): any {
    const r: any = { rule: ruleFor(spec.domains), entryPoints: this.cfg.entryPoints, service }
    if (!spec.enabled) r.middlewares = [DISABLED_MW]
    if (this.cfg.certResolver) r.tls = { certResolver: this.cfg.certResolver }
    return r
  }

  private serviceFor(spec: HostSpec): any {
    return { loadBalancer: { servers: [{ url: `${spec.forwardScheme}://${spec.forwardHost.includes(':') ? `[${spec.forwardHost}]` : spec.forwardHost}:${spec.forwardPort}` }] } }
  }

  // --- reads ----------------------------------------------------------------------------------------

  async listHosts(): Promise<ProxyHostRecord[]> {
    const [routers, services] = await Promise.all([
      this.http.get<Router[]>('/api/http/routers?per_page=1000'),
      this.http.get<Service[]>('/api/http/services?per_page=1000'),
    ])
    let mine: DynFile | null = null
    let fileError = ''
    try { mine = await this.readFile() } catch (e: any) { fileError = e.message }
    const svc = new Map(services.map(s => [s.name, s]))
    const out: ProxyHostRecord[] = []
    for (const r of routers ?? []) {
      // Internal routers and routers that match no Host() (an API or dashboard path) are not hosts.
      if (r.provider === 'internal' || !hostsInRule(r.rule ?? '').length) continue
      const base = r.name.replace(/@[^@]*$/, '')
      const owned = r.provider === 'file' && base.startsWith(PREFIX) && !!mine?.http.routers[base]
      const serviceName = r.service.includes('@') ? r.service : `${r.service}@${r.provider}`
      let url = svc.get(serviceName)?.loadBalancer?.servers?.[0]?.url
      if (owned) url = mine!.http.services[mine!.http.routers[base].service]?.loadBalancer?.servers?.[0]?.url ?? url
      const up = url ? parseUpstreamUrl(url) : { scheme: 'http' as const, host: r.service, port: 0 }
      const disabled = (r.middlewares ?? []).some(m => m.replace(/@.*$/, '') === DISABLED_MW)
      const status = svc.get(serviceName)?.serverStatus
      out.push({
        id: owned ? base : r.name,
        domains: hostsInRule(r.rule), forwardScheme: up.scheme, forwardHost: up.host, forwardPort: up.port,
        enabled: r.status === 'disabled' ? false : !disabled,
        owned,
        readOnlyReason: owned ? undefined : (fileError && base.startsWith(PREFIX) ? fileError : `Made outside HyperProx (Traefik provider "${r.provider}")`),
        tls: r.tls ? { kind: 'auto' } : { kind: 'none' },
        online: status ? Object.values(status).some(s => s === 'UP') : null,
        detail: r.rule,
      })
    }
    // A host in HyperProx's file that Traefik has not loaded (yet, or because it rejected it) is still shown.
    for (const [name, r] of Object.entries(mine?.http.routers ?? {})) {
      if (out.some(h => h.id === name)) continue
      const up = parseUpstreamUrl(mine!.http.services[r.service]?.loadBalancer?.servers?.[0]?.url ?? '')
      out.push({ id: name, domains: hostsInRule(r.rule ?? ''), forwardScheme: up.scheme, forwardHost: up.host, forwardPort: up.port,
        enabled: !(r.middlewares ?? []).includes(DISABLED_MW), owned: true, tls: r.tls ? { kind: 'auto' } : { kind: 'none' },
        online: false, detail: `${r.rule} (in HyperProx's file, not loaded by Traefik)` })
    }
    return out
  }

  // --- writes ---------------------------------------------------------------------------------------

  private async settle(check: (routers: Router[]) => boolean): Promise<void> {
    const deadline = Date.now() + (this.cfg.settleMs ?? 10_000)
    for (;;) {
      const routers = await this.http.get<Router[]>('/api/http/routers?per_page=1000').catch(() => [] as Router[])
      if (check(routers)) return
      if (Date.now() > deadline) return   // the plan layer's re-read reports what Traefik actually has
      await this.wait(500)
    }
  }

  private ownedOrRefuse(doc: DynFile, id: string): any {
    const r = doc.http.routers[id]
    if (!id.startsWith(PREFIX) || !r) throw new ProxyRefusal(`Traefik router ${id} is not in HyperProx's file; it is read-only.`)
    return r
  }

  async createHost(spec: HostSpec): Promise<string> {
    const doc = await this.readFile()
    const live = await this.http.get<Router[]>('/api/http/routers?per_page=1000')
    const taken = new Set([...Object.keys(doc.http.routers), ...live.map(r => r.name.replace(/@[^@]*$/, ''))])
    const id = slugFor(spec, taken)
    doc.http.services[id] = this.serviceFor(spec)
    doc.http.routers[id] = this.routerFor(spec, id)
    await this.writeFile(doc)
    await this.settle(rs => rs.some(r => r.name === `${id}@file`))
    return id
  }

  async updateHost(id: string, spec: HostSpec): Promise<void> {
    const doc = await this.readFile()
    const cur = this.ownedOrRefuse(doc, id)
    doc.http.services[cur.service] = this.serviceFor(spec)
    doc.http.routers[id] = this.routerFor(spec, cur.service)
    await this.writeFile(doc)
    const rule = ruleFor(spec.domains)
    await this.settle(rs => rs.some(r => r.name === `${id}@file` && r.rule === rule))
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const doc = await this.readFile()
    const cur = this.ownedOrRefuse(doc, id)
    const mws = (cur.middlewares ?? []).filter((m: string) => m !== DISABLED_MW)
    if (!enabled) mws.push(DISABLED_MW)
    if (mws.length) cur.middlewares = mws; else delete cur.middlewares
    await this.writeFile(doc)
    await this.settle(rs => rs.some(r => r.name === `${id}@file` && (r.middlewares ?? []).some(m => m.startsWith(DISABLED_MW)) === !enabled))
  }

  async deleteHost(id: string): Promise<void> {
    const doc = await this.readFile()
    const cur = this.ownedOrRefuse(doc, id)
    delete doc.http.routers[id]
    if (!Object.values(doc.http.routers).some((r: any) => r.service === cur.service)) delete doc.http.services[cur.service]
    await this.writeFile(doc)
    await this.settle(rs => !rs.some(r => r.name === `${id}@file`))
  }

  async listCertificates(): Promise<ProxyCertificate[]> { return [] }
}
