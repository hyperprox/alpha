// =============================================================================
//  HyperProx — website routes
//
//  The address step of the New website wizard (domains, proxies, and what a name
//  would make), and the Sites view: health, pull now, and the one-time
//  WordPress admin sign-in. The install itself is the catalogue wizard's
//  preview and apply. Every route here is admin; the sign-in also needs the
//  master password re-entered (roles.ts), and is audited without its token.
//
//  Deleting a site (lib/site-delete.ts): POST /:id/delete/preview lists exactly
//  what would go, with HyperProx's ownership defaults, and changes nothing;
//  POST /:id/delete removes what was ticked from that preview. The preview is
//  single use, the asker's own, for this site only, and lasts ten minutes. The
//  delete needs the master password re-entered; API tokens are refused on both.
// =============================================================================

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { ownHeaders } from '../lib/own-user-agent'
import { currentContext } from '../lib/auth'
import { ownerOf } from './ai'
import { itemName } from '../lib/credentials'
import { auditCredentialUse } from '../lib/audit'
import { execInGuest, nodeCredential } from '../lib/node-exec'
import { ProxmoxClient } from '../lib/proxmox-client'
import {
  listSites, getSite, planPublish, makeAdminLogin, siteHealth, realPublishDeps,
  type PublishDeps, type SiteRecord,
} from '../lib/sites'
import { hasRole, type Role } from '../lib/roles'
import { homePve } from '../lib/pve-env'
import {
  buildDeletePreview, checkChoice, runDelete, isAdoptedSite, DeletePreviewStore, SiteDeleteRefusal, type SiteDeleteDeps,
} from '../lib/site-delete'

export interface SiteRouteDeps {
  whoami(): string
  publish: PublishDeps
  /** Run a script inside a site's container, from its node. */
  run(site: SiteRecord, script: string): Promise<{ code: number | null; output: string }>
  probe(url: string): Promise<{ status: number; body: string } | null>
  audit(action: string, resource: string, details?: Record<string, unknown>): Promise<void>
  now(): number
  /** The home cluster's guest IDs, or null when Proxmox cannot be read (a site's container is then "unknown"). */
  guestIds(): Promise<Set<number> | null>
  /** Deleting a site: everything it reaches. Made on first use. */
  deletion(): SiteDeleteDeps
}

async function realGuestIds(): Promise<Set<number> | null> {
  // The home cluster: that is where the catalogue installs sites.
  let rows: any[] | null
  try { rows = await homePve().fetchStrict<any[]>('/cluster/resources?type=vm') } catch { rows = null }
  return Array.isArray(rows) ? new Set(rows.map(r => Number(r?.vmid))) : null
}

let deletionDeps: SiteDeleteDeps | null = null
async function loadDeletion(): Promise<SiteDeleteDeps> {
  // Loaded when first used: the real connections pull in the install wizard and the proxy layer.
  return (deletionDeps ??= (await import('../lib/site-delete-deps')).realSiteDeleteDeps())
}

export async function realRun(site: SiteRecord, script: string) {
  const cred = await nodeCredential(site.node).catch(() => null)
  if (!cred) throw new Error(`No node login is stored for ${site.node}.`)
  const pve = new ProxmoxClient(process.env.PROXMOX_HOST!, Number(process.env.PROXMOX_PORT ?? 8006),
    `${process.env.PROXMOX_USER}!${process.env.PROXMOX_TOKEN_ID}`, process.env.PROXMOX_TOKEN_SECRET!)
  const row = ((await pve.fetchNode<any[]>('/cluster/status').catch(() => [])) ?? []).find((r: any) => r.type === 'node' && r.name === site.node)
  if (!row?.ip) throw new Error(`Could not find an address for node ${site.node}.`)
  const r = await execInGuest({ host: row.ip, cred, vmid: site.vmid, script, timeoutMs: 5 * 60_000 })
  return { code: r.code, output: r.output }
}

/**
 * A health read of one of the site's addresses. A redirect is reported as its status, never followed: a site (or
 * whatever answers on its name) must not be able to point HyperProx's request at another address.
 */
export function siteProbe(url: string): Promise<{ status: number; body: string } | null> {
  return fetch(url, { headers: ownHeaders('site-probe'), signal: AbortSignal.timeout(6000), redirect: 'manual' })
    .then(async r => ({ status: r.status, body: r.status >= 300 && r.status < 400 ? '' : (await r.text().catch(() => '')).slice(0, 200_000) }))
    .catch(() => null)
}

/** What the page shows for a site. Never a secret: the vault item is named, and revealed through the vault. */
function view(s: SiteRecord, ids: Set<number> | null = null) {
  return {
    adopted: isAdoptedSite(s),
    /** Whether its container is still on the cluster: 'gone' marks the card "Container gone". */
    container: ids === null ? 'unknown' : ids.has(s.vmid) ? 'present' : 'gone',
    id: s.id, recipeId: s.recipeId, name: s.name, vmid: s.vmid, node: s.node, ip: s.ip ?? null,
    domain: s.domain ?? null, url: s.url ?? null, localUrl: s.localUrl ?? null, adminUser: s.adminUser ?? null,
    vaultItem: s.vault ? itemName(s.vault.category, s.vault.provider) : null,
    adminUrl: s.recipeId === 'wordpress' ? `${s.url ?? s.localUrl}/wp-admin/` : null,
    createdAt: s.createdAt,
  }
}

export function buildSiteRoutes(over: Partial<SiteRouteDeps> = {}): FastifyPluginAsync {
  const d: SiteRouteDeps = {
    whoami: () => ownerOf(currentContext()),
    publish: realPublishDeps(),
    run: realRun,
    probe: siteProbe,
    audit: auditCredentialUse,
    now: Date.now,
    guestIds: realGuestIds,
    deletion: () => { throw new Error('not loaded') },
    ...over,
  }
  const deletion = async () => (over.deletion ? over.deletion() : loadDeletion())
  const previews = new DeletePreviewStore(() => d.now())
  const roleOf = (q: FastifyRequest): Role => (q.session?.role ?? 'viewer') as Role
  /** Deleting is a person's decision: an API token is refused by name, and the role is checked here too. */
  const deleteGuard = (q: FastifyRequest, reply: FastifyReply): boolean => {
    if (q.apiToken) { void reply.status(403).send({ success: false, code: 'token_forbidden', error: 'An API token cannot delete a website.' }); return false }
    if (!q.session || !hasRole(roleOf(q), 'admin')) { void reply.status(403).send({ success: false, code: 'forbidden', error: 'This needs the admin role' }); return false }
    return true
  }
  const refused = (reply: FastifyReply, e: any) => e instanceof SiteDeleteRefusal
    ? reply.status(e.status).send({ success: false, code: e.code, error: e.message })
    : reply.status(502).send({ success: false, error: String(e?.message ?? e).slice(0, 300) })

  return async (fastify) => {
    // GET / — the websites HyperProx made or adopted, each with whether its container is still there
    fastify.get('/', async (_q, reply) => {
      const [sites, ids] = await Promise.all([listSites(), d.guestIds().catch(() => null)])
      return reply.send({ success: true, data: { sites: sites.map(s => view(s, ids)) } })
    })

    // POST /:id/delete/preview — exactly what deleting the site would remove. Changes nothing.
    fastify.post<{ Params: { id: string } }>('/:id/delete/preview', async (q, reply) => {
      if (!deleteGuard(q, reply)) return
      const site = await getSite(q.params.id)
      if (!site) return reply.status(404).send({ success: false, error: 'No such site' })
      try {
        const built = await buildDeletePreview(site, await deletion())
        reply.header('Cache-Control', 'no-store')
        return reply.send({ success: true, data: previews.put(q.session!.sid, site, built) })
      } catch (e) { return refused(reply, e) }
    })

    // POST /:id/delete — remove what was ticked from that preview (master password re-entered, roles.ts)
    fastify.post<{ Params: { id: string }; Body: { previewId?: unknown; items?: unknown; confirm?: unknown } }>('/:id/delete', async (q, reply) => {
      if (!deleteGuard(q, reply)) return
      const site = await getSite(q.params.id)
      if (!site) return reply.status(404).send({ success: false, error: 'No such site' })
      const by = d.whoami() || q.session!.email
      try {
        const held = previews.take(q.body?.previewId, q.session!.sid, site.id)
        const keys = checkChoice(held.preview, q.body ?? {})
        const out = await runDelete(site, held, keys, by, await deletion())
        const ok = out.results.every(r => r.outcome !== 'failed')
        await d.audit('site.delete', `site:${site.id}`, { by, ok, items: out.results.map(r => `${r.key}: ${r.outcome}`), recordRemoved: out.recordRemoved })
        return reply.status(ok ? 200 : 207).send({ success: ok, data: out, ...(ok ? {} : { error: 'Not everything was removed. Each item says what happened; preview again to retry what is left.' }) })
      } catch (e) { return refused(reply, e) }
    })

    // GET /address/options — the domains the DNS provider lists, and the proxies that can serve a site
    fastify.get('/address/options', async (_q, reply) => {
      const dns = await d.publish.dns().catch(() => null)
      const domains = dns ? ((await dns.getDomains().catch(() => [])) ?? []).filter(x => !x.status || /active/i.test(x.status)).map(x => x.domain) : []
      const proxies = (await d.publish.proxy.instances().catch(() => [])).map(p => ({ id: p.id, name: p.name, kind: p.kind, status: p.status ?? null, certificates: p.certificates }))
      return reply.send({ success: true, data: { dnsConfigured: Boolean(dns), domains, proxies } })
    })

    // POST /address — what this name would make, or why it cannot be used. Writes nothing.
    fastify.post<{ Body: { zone?: string; name?: string; instanceId?: string } }>('/address', async (q, reply) => {
      const r = await planPublish(q.body ?? {}, d.publish)
      return reply.send({ success: true, data: r })
    })

    // GET /:id/health — the container's own address and, when published, the public one
    fastify.get<{ Params: { id: string } }>('/:id/health', async (q, reply) => {
      const site = await getSite(q.params.id)
      if (!site) return reply.status(404).send({ success: false, error: 'No such site' })
      return reply.send({ success: true, data: { checks: await siteHealth(site, d.probe) } })
    })

    // POST /:id/pull — pull a static site from its git repository now
    fastify.post<{ Params: { id: string } }>('/:id/pull', async (q, reply) => {
      const site = await getSite(q.params.id)
      if (!site) return reply.status(404).send({ success: false, error: 'No such site' })
      if (site.recipeId !== 'static-site') return reply.status(400).send({ success: false, error: 'Only a static site is pulled from git.' })
      try {
        const r = await d.run(site, 'set -e\n/usr/local/bin/site-pull')
        const tail = r.output.trim().split('\n').slice(-6).join('\n')
        return reply.status(r.code === 0 ? 200 : 502).send({ success: r.code === 0, data: { output: tail }, ...(r.code === 0 ? {} : { error: `site-pull exited ${r.code}` }) })
      } catch (e: any) { return reply.status(502).send({ success: false, error: e.message }) }
    })

    // POST /:id/admin-login — a one-time WordPress sign-in: 60 seconds, once, POSTed by the browser
    fastify.post<{ Params: { id: string } }>('/:id/admin-login', async (q, reply) => {
      const site = await getSite(q.params.id)
      if (!site) return reply.status(404).send({ success: false, error: 'No such site' })
      let made: ReturnType<typeof makeAdminLogin>
      try { made = makeAdminLogin(site, d.now()) } catch (e: any) { return reply.status(400).send({ success: false, error: e.message }) }
      try {
        const r = await d.run(site, made.script)
        if (r.code !== 0) throw new Error(`storing the sign-in in WordPress exited ${r.code}`)
      } catch (e: any) {
        await d.audit('site.admin-login', `site:${site.id}`, { by: d.whoami(), ok: false, error: e.message })
        return reply.status(502).send({ success: false, error: e.message })
      }
      // The token is in this answer only: not in the audit, the log or any store.
      await d.audit('site.admin-login', `site:${site.id}`, { by: d.whoami(), ok: true, user: site.adminUser, expires: made.expiresAt })
      reply.header('Cache-Control', 'no-store')
      return reply.send({ success: true, data: { postUrl: made.postUrl, token: made.token, expiresAt: made.expiresAt } })
    })
  }
}

export const siteRoutes: FastifyPluginAsync = buildSiteRoutes()
