// =============================================================================
//  HyperProx — Homepage routes (/api/plugins/homepage)
//
//  Roles (lib/roles.ts): everything here is admin, reads included: the preview
//  maps every service's LAN address and the diff shows the whole file. Turning
//  on widgets, writing their keys to the guest, wiring the key file into
//  Homepage's compose file, and creating or revoking the Proxmox token also need
//  the master password re-entered (and so never work for an API token); the
//  service refuses a token there again by name.
//
//  No route takes a path, a command or a file's content: a dashboard is picked
//  by its id, a fix by its name, and a write is the preview the same person
//  made, by its id.
// =============================================================================

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { PrismaRemoteStore } from '../lib/remote/store'
import { onInstallCompleted } from '../lib/catalogue-installer'
import {
  HomepageRefusal, homepageService, homepageInventoryChanged, setHomepageExclusionSource, type Actor, type HomepageInstance, type Plan,
} from '../lib/homepage'
import { YamlProblem } from '../lib/homepage/generate'
import { UnsafeValueError } from '../lib/homepage/remote'

const svc = () => homepageService()

function actor(req: FastifyRequest): Actor {
  return { email: req.session?.email ?? 'unknown', token: req.apiToken?.name ?? null }
}

function fail(reply: FastifyReply, e: any) {
  if (e instanceof HomepageRefusal) return reply.status(e.status).send({ success: false, code: e.code, error: e.message })
  if (e instanceof YamlProblem) return reply.status(409).send({ success: false, code: e.code, error: e.message })
  if (e instanceof UnsafeValueError) return reply.status(400).send({ success: false, code: 'unsafe', error: e.message })
  if (e?.name === 'TransportError') return reply.status(502).send({ success: false, code: 'unreachable', error: e.message })
  if (e?.name === 'VaultLockedError') throw e
  return reply.status(500).send({ success: false, code: 'failed', error: String(e?.message ?? 'That did not work.').slice(0, 300) })
}

/** A dashboard as the page sees it. No secret is ever part of it (the token's id is not a secret). */
export function instanceView(i: HomepageInstance) {
  return {
    id: i.id, machineId: i.machineId, kind: i.kind, vmid: i.vmid, node: i.node, name: i.name, container: i.container, configDir: i.configDir,
    composeDir: i.composeDir, url: i.url, options: i.options, autoSync: i.autoSync, managedGroups: i.state.managedGroups,
    exportedVars: Object.keys(i.exported ?? {}), releasedGroups: i.state.released ?? [], proxmoxToken: i.proxmoxToken, lastSync: i.lastSync, addedBy: i.addedBy, addedAt: i.addedAt,
    autoConnected: i.autoConnected ?? null,
  }
}

/** A preview as the page sees it: the dashboard by group, each file's diff, and what was kept. */
export function planView(p: Plan) {
  return {
    planId: p.id, expiresAt: p.expiresAt, counts: p.counts, notes: p.notes, errors: p.errors, failed: p.failed,
    entries: p.entries.map(e => ({ id: e.id, group: e.group, name: e.name, href: e.href, hrefKind: e.hrefKind, icon: e.icon, description: e.description,
      status: e.siteMonitor ? 'siteMonitor' : e.ping ? 'ping' : null, widget: e.offer ? { type: e.offer.type, enabled: e.offer.enabled, pending: e.offer.pending, vars: Object.values(e.offer.vars) } : null,
      guest: e.guest ? { vmid: e.guest.vmid, name: e.guest.name } : null, source: e.source })),
    files: p.files.map(f => ({ name: f.name, changed: f.changed, diff: f.diff })),
    changed: p.files.some(f => f.changed),
  }
}

type P = { Params: { iid: string } }

export const homepageRoutes: FastifyPluginAsync = async (fastify) => {
  const prisma = (fastify as any).prisma
  if (prisma) setHomepageExclusionSource(() => new PrismaRemoteStore(prisma).listExclusions())
  // A finished Catalogue install changes what is on the cluster: auto-sync (when on) looks again.
  const offInstall = onInstallCompleted(() => homepageInventoryChanged())
  const stopAuto = svc().start()
  fastify.addHook('onClose', async () => { offInstall(); stopAuto() })

  fastify.get('/installs', async (_req, reply) => {
    try {
      const [detected, instances] = await Promise.all([svc().detected(), svc().instances()])
      return { success: true, data: { detected, instances: instances.map(instanceView) } }
    } catch (e) { return fail(reply, e) }
  })

  fastify.post<{ Body: { machineId?: unknown; container?: unknown } }>('/instances', async (req, reply) => {
    try {
      const i = await svc().connect(String(req.body?.machineId ?? ''), actor(req), req.body?.container === undefined ? undefined : String(req.body.container))
      return reply.status(201).send({ success: true, data: instanceView(i) })
    } catch (e) { return fail(reply, e) }
  })

  // ?force=1 disconnects even when the guest cannot be reached to take its keys off (the answer names what is left).
  fastify.delete<P & { Querystring: { force?: string } }>('/instances/:iid', async (req, reply) => {
    try { return { success: true, data: await svc().disconnect(req.params.iid, actor(req), req.query.force === '1') } }
    catch (e) { return fail(reply, e) }
  })

  fastify.put<P & { Body: Record<string, unknown> }>('/instances/:iid/settings', async (req, reply) => {
    try { return { success: true, data: instanceView(await svc().saveSettings(req.params.iid, req.body ?? {}, actor(req))) } }
    catch (e) { return fail(reply, e) }
  })

  fastify.get<P & { Querystring: { fresh?: string } }>('/instances/:iid/preview', async (req, reply) => {
    try { return { success: true, data: planView(await svc().preview(req.params.iid, actor(req), req.query.fresh === '1')) } }
    catch (e) { return fail(reply, e) }
  })

  fastify.post<P & { Body: { planId?: unknown; applyAnyway?: unknown } }>('/instances/:iid/apply', async (req, reply) => {
    try { return { success: true, data: await svc().apply(req.params.iid, req.body?.planId, actor(req), { applyAnyway: req.body?.applyAnyway === true }) } }
    catch (e) { return fail(reply, e) }
  })

  fastify.get<P>('/instances/:iid/problems', async (req, reply) => {
    try { return { success: true, data: await svc().problems(req.params.iid) } }
    catch (e) { return fail(reply, e) }
  })

  fastify.post<P & { Body: { fix?: unknown; applyAnyway?: unknown } }>('/instances/:iid/fix', async (req, reply) => {
    try { return { success: true, data: await svc().fix(req.params.iid, req.body?.fix, actor(req), { applyAnyway: req.body?.applyAnyway === true }) } }
    catch (e) { return fail(reply, e) }
  })

  fastify.get<P>('/instances/:iid/widget-keys', async (req, reply) => {
    try { return { success: true, data: await svc().widgetKeys(req.params.iid) } }
    catch (e) { return fail(reply, e) }
  })

  // Re-confirmed (lib/roles.ts): turning a widget on is what later puts its key on the guest.
  fastify.put<P & { Body: { entries?: unknown; force?: unknown } }>('/instances/:iid/widgets', async (req, reply) => {
    try { return { success: true, data: instanceView(await svc().setWidgets(req.params.iid, req.body?.entries, actor(req), req.body?.force === true)) } }
    catch (e) { return fail(reply, e) }
  })

  // Re-confirmed: the keys leave the vault and are stored in plaintext on the guest.
  fastify.post<P>('/instances/:iid/secrets', async (req, reply) => {
    try { return { success: true, data: await svc().exportKeys(req.params.iid, actor(req)) } }
    catch (e) { return fail(reply, e) }
  })

  // Re-confirmed: a new Proxmox credential.
  fastify.post<P>('/instances/:iid/proxmox-token', async (req, reply) => {
    try { return reply.status(201).send({ success: true, data: await svc().createProxmoxToken(req.params.iid, actor(req)) }) }
    catch (e) { return fail(reply, e) }
  })

  fastify.delete<P>('/instances/:iid/proxmox-token', async (req, reply) => {
    try { return { success: true, data: await svc().revokeProxmoxToken(req.params.iid, actor(req)) } }
    catch (e) { return fail(reply, e) }
  })

  // Re-confirmed: deletes files on the guest (the key file's dated backups, which hold old keys).
  fastify.post<P>('/instances/:iid/purge-key-backups', async (req, reply) => {
    try { return { success: true, data: await svc().purgeKeyBackups(req.params.iid, actor(req)) } }
    catch (e) { return fail(reply, e) }
  })

  // Re-confirmed: changes Homepage's compose file and recreates its container.
  fastify.post<P>('/instances/:iid/wire-env', async (req, reply) => {
    try { return { success: true, data: await svc().wireEnv(req.params.iid, actor(req)) } }
    catch (e) { return fail(reply, e) }
  })
}
