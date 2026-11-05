// =============================================================================
//  HyperProx — Proxy provider: Pangolin (integration API, /v1)
//
//  A host is an HTTP resource in one organisation, with one target on one
//  site. HyperProx renames the resources it creates to an niceId of hpx-…;
//  every other resource is shown read-only. A resource has one name, made of
//  a subdomain and one of the organisation's domains, so a host here has
//  exactly one domain, and it must sit under a domain Pangolin has.
//
//  The integration API must be enabled (flags.enable_integration_api) and the
//  key needs the resource, target and site actions (docs/proxy.md).
// =============================================================================

import { ProxyHttp, type FetchLike } from '../http'
import { slugFor } from '../spec'
import { ProxyRefusal, type HostSpec, type ProxyCertificate, type ProxyHealth, type ProxyHostRecord, type ProxyProvider } from '../types'

const PREFIX = 'hpx-'

export interface PangolinConfig {
  /** The integration API base, e.g. https://pangolin.example.invalid:3003/v1 */
  url:     string
  apiKey:  string
  orgId:   string
  /** The site targets go through; empty = the organisation's first site. */
  siteId?: number
  /** Resource ids HyperProx recorded creating. A resource is HyperProx's only if it is here and its niceId has the hpx- prefix. */
  owned?:  Set<string>
}

interface Target { targetId: number; ip: string; port: number; method?: string | null; enabled?: boolean; siteId?: number }
interface Resource {
  resourceId: number; niceId: string; name: string; fullDomain: string | null; mode?: string; http?: boolean
  enabled: boolean; ssl?: boolean; domainId?: string | null; targets?: Target[]; health?: string
}
interface Domain { domainId: string; baseDomain: string }
type Envelope<T> = { data: T; success: boolean; message?: string }

export class PangolinProvider implements ProxyProvider {
  readonly kind = 'pangolin' as const
  readonly capabilities = { certificates: 'auto' as const, requestCertificate: false, multiDomain: false,
    disabledMeans: 'Pangolin keeps the resource and stops serving it.' }
  private http: ProxyHttp

  constructor(private cfg: PangolinConfig, fetchImpl?: FetchLike) {
    this.http = new ProxyHttp(cfg.url, { bearer: cfg.apiKey }, fetchImpl, 'Pangolin')
  }

  private org(path = ''): string { return `/org/${encodeURIComponent(this.cfg.orgId)}${path}` }
  private async data<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.http.json<Envelope<T>>(method, path, body)).body?.data as T
  }

  async health(): Promise<ProxyHealth> {
    const checks: ProxyHealth['checks'] = []
    try {
      await this.http.raw('GET', '/')
      checks.push({ name: 'api', ok: true, detail: 'Integration API answers' })
      const org = await this.data<{ org?: { name?: string }; name?: string }>('GET', this.org())
      checks.push({ name: 'org', ok: true, detail: `Organisation "${org?.org?.name ?? org?.name ?? this.cfg.orgId}" is readable with this key` })
      const site = await this.site()
      checks.push({ name: 'site', ok: true, detail: `Targets go through site ${site}` })
      const domains = await this.domains()
      checks.push({ name: 'domains', ok: domains.length > 0, detail: domains.length ? `Domains: ${domains.map(d => d.baseDomain).join(', ')}` : 'The organisation has no domains' })
      return { ok: domains.length > 0, checks }
    } catch (e: any) {
      return { ok: false, checks: [...checks, { name: checks.length ? 'org' : 'api', ok: false, detail: e.message }] }
    }
  }

  private async site(): Promise<number> {
    if (this.cfg.siteId) return this.cfg.siteId
    const sites = (await this.data<{ sites: { siteId: number }[] }>('GET', this.org('/sites?pageSize=1000')))?.sites ?? []
    if (!sites.length) throw new ProxyRefusal('The Pangolin organisation has no site to send traffic through.')
    return sites[0].siteId
  }

  private async domains(): Promise<Domain[]> {
    return (await this.data<{ domains: Domain[] }>('GET', this.org('/domains')))?.domains ?? []
  }

  private async resources(): Promise<Resource[]> {
    return (await this.data<{ resources: Resource[] }>('GET', this.org('/resources?pageSize=1000')))?.resources ?? []
  }

  private record(r: Resource): ProxyHostRecord {
    const t = r.targets?.[0]
    const owned = r.niceId.startsWith(PREFIX) && !!this.cfg.owned?.has(String(r.resourceId))
    return {
      id: String(r.resourceId), domains: r.fullDomain ? [r.fullDomain.toLowerCase()] : [],
      forwardScheme: t?.method === 'https' ? 'https' : 'http', forwardHost: t?.ip ?? '', forwardPort: Number(t?.port ?? 0),
      enabled: !!r.enabled, owned,
      readOnlyReason: owned ? undefined : `Made outside HyperProx (Pangolin resource "${r.name}")`,
      tls: r.ssl ? { kind: 'auto' } : { kind: 'none' },
      online: r.health === 'healthy' ? true : r.health === 'unhealthy' ? false : null,
      state: owned ? { ...r, health: undefined, targets: (r.targets ?? []).map(t => ({ ...t, healthStatus: undefined, siteOnline: undefined })) } : undefined,
      detail: `${r.niceId}${(r.targets?.length ?? 0) > 1 ? `, ${r.targets!.length} targets` : ''}`,
    }
  }

  async listHosts(): Promise<ProxyHostRecord[]> {
    return (await this.resources()).filter(r => (r.mode ?? (r.http === false ? 'tcp' : 'http')) === 'http').map(r => this.record(r))
  }

  /** The organisation domain a name sits under (longest match), and the subdomain left over. */
  private async place(name: string): Promise<{ domainId: string; subdomain: string | null }> {
    const ds = (await this.domains()).sort((a, b) => b.baseDomain.length - a.baseDomain.length)
    for (const d of ds) {
      const base = d.baseDomain.toLowerCase()
      if (name === base) return { domainId: d.domainId, subdomain: null }
      if (name.endsWith('.' + base)) return { domainId: d.domainId, subdomain: name.slice(0, -base.length - 1) }
    }
    throw new ProxyRefusal(`${name} is under none of this Pangolin organisation's domains (${ds.map(d => d.baseDomain).join(', ') || 'none'}).`, 400)
  }

  private one(spec: HostSpec): string {
    if (spec.domains.length !== 1) throw new ProxyRefusal('A Pangolin resource has exactly one name; give this host one domain.', 400)
    return spec.domains[0]
  }

  private async owned(id: string): Promise<Resource> {
    const r = (await this.resources()).find(x => String(x.resourceId) === id)
    if (!r) throw new ProxyRefusal(`Pangolin has no resource ${id}.`, 404)
    if (!r.niceId.startsWith(PREFIX) || !this.cfg.owned?.has(id)) throw new ProxyRefusal(`Pangolin resource "${r.name}" was not made by HyperProx; it is read-only.`)
    return r
  }

  private target(spec: HostSpec, siteId: number) {
    return { siteId, ip: spec.forwardHost, port: spec.forwardPort, method: spec.forwardScheme, enabled: true }
  }

  async createHost(spec: HostSpec): Promise<string> {
    const name = this.one(spec)
    const place = await this.place(name)
    const siteId = await this.site()
    const taken = new Set((await this.resources()).map(r => r.niceId))
    const niceId = slugFor(spec, taken)
    const r = await this.data<Resource>('PUT', this.org('/resource'), { name, mode: 'http', subdomain: place.subdomain, domainId: place.domainId })
    const id = r.resourceId
    try {
      await this.data('POST', `/resource/${id}`, { niceId, ...(spec.enabled ? {} : { enabled: false }) })
      await this.data('PUT', `/resource/${id}/target`, this.target(spec, siteId))
    } catch (e) {
      // Half a resource is worse than none: take it away again.
      await this.data('DELETE', `/resource/${id}`).catch(() => undefined)
      throw e
    }
    return String(id)
  }

  async updateHost(id: string, spec: HostSpec): Promise<void> {
    const cur = await this.owned(id)
    const name = this.one(spec)
    const patch: Record<string, unknown> = { enabled: spec.enabled }
    if (name !== (cur.fullDomain ?? '').toLowerCase()) Object.assign(patch, await this.place(name))
    await this.data('POST', `/resource/${id}`, patch)
    const t = cur.targets?.[0]
    const siteId = t?.siteId ?? await this.site()
    if (t) await this.data('POST', `/target/${t.targetId}`, this.target(spec, siteId))
    else await this.data('PUT', `/resource/${id}/target`, this.target(spec, siteId))
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.owned(id)
    await this.data('POST', `/resource/${id}`, { enabled })
  }

  async deleteHost(id: string): Promise<void> {
    await this.owned(id)
    await this.data('DELETE', `/resource/${id}`)
  }

  async listCertificates(): Promise<ProxyCertificate[]> { return [] }
}
