// =============================================================================
//  HyperProx — DNS Routes (every configured provider: GoDaddy, Cloudflare)
//
//  Each domain is served by the provider that holds its zone (lib/dns-providers.ts). The paths, roles and
//  checks are the same for every provider: reads are viewer, writes are admin (roles.ts default), and
//  every write leaves an audit row naming the provider, zone, type and name. Credentials never leave the
//  vault; nothing here returns one.
// =============================================================================

import { FastifyPluginAsync } from 'fastify'
import { GoDaddyClient } from '../lib/godaddy-client'
import { dnsRouter, PROVIDER_LABEL, type DnsProviderId, type DnsRouter } from '../lib/dns-providers'
import { auditCredentialUse } from '../lib/audit'
import { currentContext } from '../lib/auth'

export interface DnsRouteDeps {
  router(): Promise<DnsRouter | null>
  wanIp(): Promise<{ ip: string; source: string }>
  audit(action: string, resource: string, details?: Record<string, unknown>): Promise<void>
}

const defaultDeps: DnsRouteDeps = {
  router: dnsRouter,
  wanIp: () => GoDaddyClient.getWanIP(),
  audit: auditCredentialUse,
}

const wrap = async (reply: any, fn: () => Promise<any>) => {
  try   { return { success: true, data: await fn() } }
  catch (e: any) { return reply.status(e?.statusCode === 400 ? 400 : 500).send({ success: false, error: e.message }) }
}

/**
 * The fields of a registrar domain HyperProx may send to a browser. GoDaddy's domain answer also holds the
 * transfer authorization code (anyone with it can move the domain away) and the registrant's name, address,
 * email and phone. Those never leave the API: only the listed fields are copied.
 */
export const DOMAIN_FIELDS = ['domain', 'domainId', 'status', 'createdAt', 'expires', 'renewAuto', 'renewable',
  'renewDeadline', 'locked', 'privacy', 'nameServers', 'expirationProtected', 'transferProtected', 'holdRegistrar',
  'provider', 'active', 'paused'] as const
/** The fields of a DNS record a browser gets; anything else a provider sends is dropped. */
export function publicRecord(r: any): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!r || typeof r !== 'object') return out
  for (const k of ['type', 'name', 'data', 'ttl', 'priority', 'port', 'weight', 'service', 'protocol', 'proxied', 'proxiable', 'id']) if (k in r) out[k] = r[k]
  return out
}

export function publicDomain(d: any): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!d || typeof d !== 'object') return out
  for (const k of DOMAIN_FIELDS) if (k in d) out[k] = d[k]
  return out
}

export function makeDnsRoutes(deps: DnsRouteDeps = defaultDeps): FastifyPluginAsync {
  const router = async (): Promise<DnsRouter> => {
    const r = await deps.router()
    if (!r) throw new Error('No DNS provider is configured. Add GoDaddy or Cloudflare under Settings → DNS.')
    return r
  }
  /** One audit row per write: who, which provider, which zone, type and name. Never a value or a credential. */
  const audited = async (action: string, r: DnsRouter, zone: string, details: Record<string, unknown>) => {
    const provider = await r.providerOf(zone).catch(() => 'unknown')
    await deps.audit(action, `dns:${provider}`, { by: currentContext()?.email ?? 'unknown', zone: String(zone).toLowerCase(), ...details })
  }
  const idOf = (q: any) => (typeof q?.id === 'string' && q.id ? q.id : undefined)

  return async (fastify) => {
    // GET /api/dns/providers — each known provider: set up or not, reachable or not, how many zones.
    fastify.get('/providers', async (_, r) => wrap(r, async () => {
      const rt = await deps.router()
      const seen = rt ? await rt.providers() : []
      return (Object.keys(PROVIDER_LABEL) as DnsProviderId[]).map(id => {
        const s = seen.find(x => x.id === id)
        return s ? { ...s, configured: true } : { id, label: PROVIDER_LABEL[id], configured: false, ok: false, zones: 0, active: 0 }
      })
    }))

    // GET /api/dns/domains — every zone from every provider, each with its provider
    fastify.get('/domains', async (_, r) =>
      wrap(r, async () => ((await (await router()).getDomains()) ?? []).map(publicDomain)))

    // GET /api/dns/domains/:domain
    fastify.get<{ Params: { domain: string } }>('/domains/:domain', async (req, r) =>
      wrap(r, async () => publicDomain(await (await router()).getDomain(req.params.domain))))

    // GET /api/dns/domains/:domain/records
    fastify.get<{ Params: { domain: string }; Querystring: { type?: string } }>(
      '/domains/:domain/records', async (req, r) =>
        wrap(r, async () => ((await (await router()).getRecords(req.params.domain, req.query.type ? req.query.type : undefined)) ?? []).map(publicRecord)))

    // POST /api/dns/domains/:domain/records — at Cloudflare, DNS only unless `proxied: true`
    fastify.post<{ Params: { domain: string }; Body: any }>(
      '/domains/:domain/records', async (req, r) =>
        wrap(r, async () => {
          const rt = await router()
          await rt.createRecord(req.params.domain, req.body)
          const b: any = req.body ?? {}
          await audited('dns.record.create', rt, req.params.domain, { type: String(b.type ?? '').toUpperCase(), name: String(b.name ?? ''), proxied: b.proxied === true })
        }))

    // PUT /api/dns/domains/:domain/records/:type/:name[?id=] — a proxied record stays proxied unless the body says otherwise
    fastify.put<{ Params: { domain: string; type: string; name: string }; Querystring: { id?: string }; Body: any }>(
      '/domains/:domain/records/:type/:name', async (req, r) =>
        wrap(r, async () => {
          const rt = await router()
          await rt.updateRecord(req.params.domain, req.params.type, req.params.name, req.body, { id: idOf(req.query) })
          const b: any = req.body ?? {}
          await audited('dns.record.update', rt, req.params.domain, { type: req.params.type.toUpperCase(), name: req.params.name,
            ...(typeof b.proxied === 'boolean' ? { proxied: b.proxied } : {}) })
        }))

    // DELETE /api/dns/domains/:domain/records/:type/:name[?id=] — with an id, only that one value (Cloudflare)
    fastify.delete<{ Params: { domain: string; type: string; name: string }; Querystring: { id?: string } }>(
      '/domains/:domain/records/:type/:name', async (req, r) =>
        wrap(r, async () => {
          const rt = await router()
          await rt.deleteRecord(req.params.domain, req.params.type, req.params.name, { id: idOf(req.query) })
          await audited('dns.record.delete', rt, req.params.domain, { type: req.params.type.toUpperCase(), name: req.params.name, one: Boolean(idOf(req.query)) })
        }))

    // GET /api/dns/wan
    fastify.get('/wan', async (_, r) => wrap(r, () => deps.wanIp()))

    // POST /api/dns/domains/:domain/ddns
    fastify.post<{ Params: { domain: string }; Body: { exclude?: string[] } }>(
      '/domains/:domain/ddns', async (req, r) =>
        wrap(r, async () => {
          const rt = await router()
          const { ip } = await deps.wanIp()
          const exclude = Array.isArray(req.body?.exclude) ? req.body!.exclude.map(String) : []
          const out = await rt.updateDDNS(req.params.domain, ip, exclude)
          if (out.updated.length) await audited('dns.ddns', rt, req.params.domain, { updated: out.updated })
          return out
        }))

    // GET /api/dns/domains/:domain/stats
    fastify.get<{ Params: { domain: string } }>('/domains/:domain/stats', async (req, r) =>
      wrap(r, async () => (await router()).getStats(req.params.domain)))
  }
}

export const dnsRoutes: FastifyPluginAsync = makeDnsRoutes()
