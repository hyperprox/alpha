// =============================================================================
//  HyperProx — Proxy API routes
//  Every proxy instance (NPM, Traefik, Caddy, HAProxy, Pangolin; several of each)
//  through one interface. Reads are per instance or across all of them; every
//  write is a preview, then an apply of that preview, then a re-read
//  (lib/proxy/plans.ts). Roles: lib/roles.ts (PROXY_*).
// =============================================================================

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { currentContext } from '../lib/auth'
import { hasRole, type Role } from '../lib/roles'
import { VaultLockedError } from '../lib/credentials'
import { proxyService, proxyPlanner, ProxyRefusal, type ProxyService, type ProxyPlanner, type ProxyHostView } from '../lib/proxy'
import type { HostsResult, InstanceView } from '../lib/proxy/service'
import { checkHostname } from '../lib/proxy/spec'

function actor(): { email: string; role: Role } {
  const c = currentContext()
  return { email: c?.email ?? 'unknown', role: (c?.role ?? 'viewer') as Role }
}

const isAdmin = () => hasRole(actor().role, 'admin')

async function wrap(reply: FastifyReply, fn: () => Promise<unknown>) {
  try { return { success: true, data: await fn() } }
  catch (e: any) {
    const status = e instanceof ProxyRefusal ? e.status : e instanceof VaultLockedError ? 423 : 502
    // A proxy's own error text can quote its response; below admin, only HyperProx's own refusals are shown.
    const error = e instanceof ProxyRefusal || e instanceof VaultLockedError || isAdmin() ? (e?.message ?? String(e)) : 'The proxy did not answer as expected.'
    return reply.status(status).send({ success: false, error })
  }
}

// --- what a viewer sees: names, targets, status, the certificate's name and expiry. Nothing else. ---------

function viewerHost(h: ProxyHostView) {
  return {
    id: h.id, instanceId: h.instanceId, instanceName: h.instanceName, kind: h.kind, domains: h.domains,
    forwardScheme: h.forwardScheme, forwardHost: h.forwardHost, forwardPort: h.forwardPort,
    enabled: h.enabled, readOnly: h.readOnly, online: h.online ?? null,
    tls: { kind: h.tls.kind, certificateName: h.tls.certificateName, expiresAt: h.tls.expiresAt ?? null },
  }
}
const viewerErrors = (errors: HostsResult['errors']) => errors.map(e => ({ instanceId: e.instanceId, instanceName: e.instanceName, error: 'not answering' }))
const viewerCert = (c: any) => ({ id: c.id, names: c.names, expiresAt: c.expiresAt, issuer: c.issuer, instanceId: c.instanceId, instanceName: c.instanceName })
const viewerInstance = (i: InstanceView) => ({ id: i.id, kind: i.kind, kindLabel: i.kindLabel, name: i.name, mode: i.mode, legacy: i.legacy ?? false, status: i.status ?? 'ok' })
const adminCert = ({ native: _n, ...c }: any) => c
/** Admins get the NPM options for the edit form, never the joined certificate (its meta holds DNS-challenge credentials). */
function adminHost<T extends { native?: Record<string, unknown>; state?: unknown } | null>(h: T): T {
  if (!h) return h
  const { state: _s, native, ...rest } = h as any
  if (!native) return rest
  const { certificate: _c, ...n } = native
  return { ...rest, native: n }
}
const adminPlan = (p: any) => (p ? { ...p, before: adminHost(p.before) } : p)

export function buildProxyRoutes(deps: { service?: () => ProxyService; planner?: () => ProxyPlanner } = {}): FastifyPluginAsync {
  return async (fastify) => {
    const svc = deps.service ?? (() => proxyService((fastify as any).prisma))
    const plans = deps.planner ?? (() => { svc(); return proxyPlanner() })

    fastify.get('/kinds', async (_q, r) => wrap(r, async () => svc().kinds()))

    // Settings (SSH host, file paths, organisation ids) only for admins; everyone signed in sees what exists.
    fastify.get('/instances', async (_q, r) => wrap(r, async () => {
      const list = await svc().viewInstances()
      return isAdmin() ? list : list.map(viewerInstance)
    }))
    fastify.post<{ Body: any }>('/instances', async (q, r) => wrap(r, async () => svc().createInstance(q.body ?? {}, actor())))
    fastify.put<{ Params: { id: string }; Body: any }>('/instances/:id', async (q, r) => wrap(r, async () => svc().updateInstance(q.params.id, q.body ?? {}, actor())))
    fastify.delete<{ Params: { id: string } }>('/instances/:id', async (q, r) => wrap(r, async () => { await svc().deleteInstance(q.params.id, actor()); return { deleted: true } }))
    fastify.get<{ Params: { id: string } }>('/instances/:id/health', async (q, r) => wrap(r, async () => {
      const h = await svc().health(q.params.id)
      return isAdmin() ? h : { ok: h.ok, checks: h.checks.map(c => ({ name: c.name, ok: c.ok, warn: c.warn, detail: c.ok ? 'ok' : 'not ok' })) }
    }))

    fastify.get('/hosts', async (_q, r) => wrap(r, async () => {
      const all = await svc().allHosts()
      return isAdmin() ? { ...all, hosts: all.hosts.map(adminHost) } : { hosts: all.hosts.map(viewerHost), errors: viewerErrors(all.errors) }
    }))
    fastify.get<{ Params: { id: string } }>('/instances/:id/hosts', async (q, r) => wrap(r, async () => {
      const hosts = await svc().hosts(q.params.id)
      return isAdmin() ? hosts.map(adminHost) : hosts.map(viewerHost)
    }))
    // Certificates: never the native record (NPM keeps DNS-challenge credentials in its meta), for anyone.
    fastify.get('/certificates', async (_q, r) => wrap(r, async () => {
      const all = await svc().allCertificates()
      return { certificates: all.certificates.map(isAdmin() ? adminCert : viewerCert), errors: isAdmin() ? all.errors : viewerErrors(all.errors) }
    }))
    fastify.get<{ Params: { id: string } }>('/instances/:id/certificates', async (q, r) => wrap(r, async () =>
      (await svc().certificates(q.params.id)).map(isAdmin() ? adminCert : viewerCert)))

    fastify.get('/stats', async (_q, r) => wrap(r, async () => {
      const { hosts, errors } = await svc().allHosts()
      const now = Date.now()
      let ssl = 0, expiring = 0, expired = 0
      for (const h of hosts) {
        if (h.tls.kind === 'none') continue
        ssl++
        if (h.tls.expiresAt) {
          const days = (Date.parse(h.tls.expiresAt) - now) / 86_400_000
          if (days < 0) expired++; else if (days < 30) expiring++
        }
      }
      return {
        total: hosts.length, enabled: hosts.filter(h => h.enabled).length, disabled: hosts.filter(h => !h.enabled).length,
        online: hosts.filter(h => h.online === true).length, readOnly: hosts.filter(h => h.readOnly).length,
        ssl, expiring, expired, instances: (await svc().listInstances()).length, failing: errors.length,
      }
    }))

    // Writes: preview, then apply the preview by id.
    fastify.post<{ Params: { id: string }; Body: any }>('/instances/:id/preview', async (q, r) =>
      wrap(r, async () => adminPlan(await plans().preview(q.params.id, (q.body ?? {}) as any, actor()))))
    fastify.post<{ Params: { planId: string } }>('/plans/:planId/apply', async (q, r) =>
      wrap(r, async () => {
        const res = await plans().apply(q.params.planId, actor())
        return { ...res, after: adminHost(res.after), cleanup: adminPlan(res.cleanup) }
      }))

    fastify.post<{ Params: { id: string }; Body: any }>('/instances/:id/certificates', async (q, r) => wrap(r, async () => {
      const b: any = q.body ?? {}
      const domains = (Array.isArray(b.domains) ? b.domains : []).map(checkHostname)
      if (!domains.length) throw new ProxyRefusal('Name at least one domain for the certificate.', 400)
      const email = String(b.email ?? process.env.LETSENCRYPT_EMAIL ?? '').trim()
      return adminCert(await svc().requestCertificate(q.params.id, domains, email, actor()))
    }))
  }
}

export const proxyRoutes: FastifyPluginAsync = buildProxyRoutes()
