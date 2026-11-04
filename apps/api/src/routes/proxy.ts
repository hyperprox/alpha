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
import { proxyService, proxyPlanner, ProxyRefusal, type ProxyService, type ProxyPlanner } from '../lib/proxy'
import { checkHostname } from '../lib/proxy/spec'

function actor(): { email: string; role: Role } {
  const c = currentContext()
  return { email: c?.email ?? 'unknown', role: (c?.role ?? 'viewer') as Role }
}

async function wrap(reply: FastifyReply, fn: () => Promise<unknown>) {
  try { return { success: true, data: await fn() } }
  catch (e: any) {
    const status = e instanceof ProxyRefusal ? e.status : e instanceof VaultLockedError ? 423 : 502
    return reply.status(status).send({ success: false, error: e?.message ?? String(e) })
  }
}

export function buildProxyRoutes(deps: { service?: () => ProxyService; planner?: () => ProxyPlanner } = {}): FastifyPluginAsync {
  return async (fastify) => {
    const svc = deps.service ?? (() => proxyService((fastify as any).prisma))
    const plans = deps.planner ?? (() => { svc(); return proxyPlanner() })

    fastify.get('/kinds', async (_q, r) => wrap(r, async () => svc().kinds()))

    // Settings (SSH host, file paths, organisation ids) only for admins; everyone signed in sees what exists.
    fastify.get('/instances', async (_q, r) => wrap(r, async () => {
      const list = await svc().viewInstances()
      if (hasRole(actor().role, 'admin')) return list
      return list.map(({ settings: _s, secretsSet: _x, ...rest }) => ({ ...rest, settings: {}, secretsSet: [] }))
    }))
    fastify.post<{ Body: any }>('/instances', async (q, r) => wrap(r, async () => svc().createInstance(q.body ?? {}, actor())))
    fastify.put<{ Params: { id: string }; Body: any }>('/instances/:id', async (q, r) => wrap(r, async () => svc().updateInstance(q.params.id, q.body ?? {}, actor())))
    fastify.delete<{ Params: { id: string } }>('/instances/:id', async (q, r) => wrap(r, async () => { await svc().deleteInstance(q.params.id, actor()); return { deleted: true } }))
    fastify.get<{ Params: { id: string } }>('/instances/:id/health', async (q, r) => wrap(r, async () => svc().health(q.params.id)))

    fastify.get('/hosts', async (_q, r) => wrap(r, async () => svc().allHosts()))
    fastify.get<{ Params: { id: string } }>('/instances/:id/hosts', async (q, r) => wrap(r, async () => svc().hosts(q.params.id)))
    fastify.get('/certificates', async (_q, r) => wrap(r, async () => svc().allCertificates()))
    fastify.get<{ Params: { id: string } }>('/instances/:id/certificates', async (q, r) => wrap(r, async () => svc().certificates(q.params.id)))

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
      wrap(r, async () => plans().preview(q.params.id, (q.body ?? {}) as any, actor())))
    fastify.post<{ Params: { planId: string } }>('/plans/:planId/apply', async (q, r) =>
      wrap(r, async () => plans().apply(q.params.planId, actor())))

    fastify.post<{ Params: { id: string }; Body: any }>('/instances/:id/certificates', async (q, r) => wrap(r, async () => {
      const b: any = q.body ?? {}
      const domains = (Array.isArray(b.domains) ? b.domains : []).map(checkHostname)
      if (!domains.length) throw new ProxyRefusal('Name at least one domain for the certificate.', 400)
      const email = String(b.email ?? process.env.LETSENCRYPT_EMAIL ?? '').trim()
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new ProxyRefusal('Let’s Encrypt needs an email address.', 400)
      return svc().requestCertificate(q.params.id, domains, email, actor())
    }))
  }
}

export const proxyRoutes: FastifyPluginAsync = buildProxyRoutes()
