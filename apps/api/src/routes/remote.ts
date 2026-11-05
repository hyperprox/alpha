// =============================================================================
//  HyperProx — Remote access routes (/api/remote)
//
//  The overview is for every signed-in role: it shows which machines are on
//  which overlay, and nothing that grants access. Everything else is admin,
//  checked here per route as well as by the role matrix (lib/roles.ts), which
//  also requires a fresh re-confirmation for install, routing, uninstall, the
//  /dev/net/tun change and a manual key.
//
//  The work is in lib/remote; this file translates HTTP to it.
// =============================================================================

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { hasRole } from '../lib/roles'
import { onUnlock } from '../lib/vault/state'
import { livePve } from '../lib/pve-env'
import {
  RemoteAccessService, RemoteBusyError, RemoteInputError, RemoteNotFoundError, overviewForRole, type JobRequest,
} from '../lib/remote/service'
import { PrismaRemoteStore } from '../lib/remote/store'
import { productionRemoteExecutor } from '../lib/remote/executor'
import { providerFromVault, providerSettingsFromVault, setCredentialAuditor } from '../lib/remote/providers'
import { publish } from '../lib/notify'
import type { VpnPrefs } from '../lib/remote/planner'
import type { RemoteOverview, RemoteMachineRow } from '../lib/remote/service'
import { ProviderError, isProviderId } from '../lib/remote/types'

export interface RemoteRouteDeps {
  service?: RemoteAccessService
  /** Tests turn the sweep off; production wants it (revokes leftover keys, re-checks interrupted node changes). */
  sweep?: boolean
}

const MACHINE_ID = /^(node|lxc|qemu|host)-[A-Za-z0-9._-]{1,120}$/

async function adminOnly(req: FastifyRequest, reply: FastifyReply) {
  const s = req.session
  if (!s) return reply.status(401).send({ ok: false, code: 'unauthenticated', error: 'Authentication required' })
  if (!hasRole(s.role, 'admin')) {
    return reply.status(403).send({ ok: false, code: 'forbidden', error: 'Remote access changes need the admin role', required: 'admin', role: s.role })
  }
}

function sendError(reply: FastifyReply, e: any) {
  if (e instanceof RemoteInputError || e instanceof ProviderError && e.status === undefined) return reply.status(400).send({ error: e.message })
  if (e instanceof RemoteNotFoundError) return reply.status(404).send({ error: e.message })
  if (e instanceof RemoteBusyError) return reply.status(409).send({ error: e.message, runningJobId: e.jobId })
  if (e?.name === 'VaultLockedError') throw e        // the gate's error handler answers 423
  return reply.status(503).send({ error: e?.message ?? String(e) })
}

type MachineParams = { id: string; provider: string }

function params(req: FastifyRequest<{ Params: MachineParams }>): { id: string; provider: 'tailscale' | 'netbird' } {
  const { id, provider } = req.params
  if (!MACHINE_ID.test(id)) throw new RemoteInputError('Unknown machine id format')
  if (!isProviderId(provider)) throw new RemoteInputError('provider must be tailscale or netbird')
  return { id, provider }
}

export function buildRemoteRoutes(deps: RemoteRouteDeps = {}): FastifyPluginAsync {
  return async (fastify) => {
    const service = deps.service ?? new RemoteAccessService({
      store: new PrismaRemoteStore((fastify as any).prisma),
      exec: productionRemoteExecutor(livePve()),
      provider: id => providerFromVault(id),
      providerSettings: id => providerSettingsFromVault(id),
      log: m => fastify.log.info(m),
      publish: (e, o) => publish(e, o),
    })
    if (!deps.service) {
      const store = new PrismaRemoteStore((fastify as any).prisma)
      setCredentialAuditor((a, r, d) => store.audit(a, r, d))
    }
    if (deps.sweep !== false) {
      // Provider credentials and node logins are vault items, so a sweep that runs while locked does nothing and
      // the one after unlock does the work.
      fastify.addHook('onReady', async () => service.start())
      onUnlock(() => { void service.sweep({ startup: true }); void service.pollDevices() })
    }
    fastify.addHook('onClose', async () => service.close())

    const by = (req: FastifyRequest) => req.session?.email ?? 'unknown'

    // Viewer and up. The gate has already required a session.
    // Below admin: overlay status, version and connection only; no LAN or cluster addresses.
    fastify.get('/overview', async (req, reply) => {
      try { return overviewForRole(await service.overview(), !!req.session && hasRole(req.session.role, 'admin')) }
      catch (e) { return sendError(reply, e) }
    })

    fastify.get<{ Params: { id: string } }>('/jobs/:id', { preHandler: adminOnly }, async (req, reply) => {
      const job = service.getJob(req.params.id)
      if (!job) return reply.status(404).send({ error: `No job ${req.params.id}` })
      return { job }
    })

    fastify.post<{ Body: Partial<JobRequest> }>('/jobs', { preHandler: adminOnly }, async (req, reply) => {
      const b = req.body ?? {}
      try {
        const job = service.startJob({
          action: 'install', provider: b.provider as any, machineIds: b.machineIds as any, tags: b.tags, mode: b.mode, existing: b.existing,
          auth: b.auth, acceptDns: b.acceptDns,
        }, by(req))
        return reply.status(202).send({ job })
      } catch (e) { return sendError(reply, e) }
    })

    for (const action of ['check', 'update'] as const) {
      fastify.post<{ Params: MachineParams }>(`/machines/:id/:provider/${action}`, { preHandler: adminOnly }, async (req, reply) => {
        try {
          const { id, provider } = params(req)
          return reply.status(202).send({ job: service.startJob({ action, provider, machineIds: [id] }, by(req)) })
        } catch (e) { return sendError(reply, e) }
      })
    }

    fastify.post<{ Params: MachineParams; Body: { subnets?: unknown; exitNode?: unknown; acknowledge?: unknown } }>(
      '/machines/:id/:provider/routing', { preHandler: adminOnly }, async (req, reply) => {
        try {
          const { id, provider } = params(req)
          const b = req.body ?? {}
          if (b.subnets !== undefined && (!Array.isArray(b.subnets) || !b.subnets.every(s => typeof s === 'string'))) throw new RemoteInputError('subnets must be a list of CIDRs')
          const job = service.startJob({
            action: 'routing', provider, machineIds: [id],
            subnets: (b.subnets as string[] | undefined) ?? [], exitNode: b.exitNode === true, acknowledge: b.acknowledge === true,
          }, by(req))
          return reply.status(202).send({ job })
        } catch (e) { return sendError(reply, e) }
      })

    fastify.delete<{ Params: MachineParams }>('/machines/:id/:provider', { preHandler: adminOnly }, async (req, reply) => {
      try {
        const { id, provider } = params(req)
        return reply.status(202).send({ job: service.startJob({ action: 'uninstall', provider, machineIds: [id] }, by(req)) })
      } catch (e) { return sendError(reply, e) }
    })

    fastify.post<{ Params: { id: string } }>('/machines/:id/tun', { preHandler: adminOnly }, async (req, reply) => {
      try {
        if (!MACHINE_ID.test(req.params.id)) throw new RemoteInputError('Unknown machine id format')
        return await service.applyTun(req.params.id, by(req))
      } catch (e) { return sendError(reply, e) }
    })

    // The node host-firewall rule for SSH and the web UI over the overlay: a preview, then an explicit confirm.
    fastify.get<{ Params: MachineParams }>('/machines/:id/:provider/firewall', { preHandler: adminOnly }, async (req, reply) => {
      try { const { id, provider } = params(req); return await service.firewallPreview(id, provider) } catch (e) { return sendError(reply, e) }
    })
    fastify.post<{ Params: MachineParams; Body: { confirm?: unknown } }>('/machines/:id/:provider/firewall', { preHandler: adminOnly }, async (req, reply) => {
      try {
        const { id, provider } = params(req)
        if (req.body?.confirm !== true) throw new RemoteInputError('Send { confirm: true } after showing the preview')
        return await service.addFirewallRule(id, provider, by(req))
      } catch (e) { return sendError(reply, e) }
    })

    // Host keys: a preview of what the machine presents, then a pin of exactly the key the admin checked.
    fastify.get<{ Params: { id: string } }>('/machines/:id/host-key', { preHandler: adminOnly }, async (req, reply) => {
      try {
        if (!MACHINE_ID.test(req.params.id)) throw new RemoteInputError('Unknown machine id format')
        return await service.hostKeyPreview(req.params.id)
      } catch (e) { return sendError(reply, e) }
    })
    fastify.post<{ Params: { id: string }; Body: { fingerprint?: unknown } }>('/machines/:id/host-key', { preHandler: adminOnly }, async (req, reply) => {
      try {
        if (!MACHINE_ID.test(req.params.id)) throw new RemoteInputError('Unknown machine id format')
        if (typeof req.body?.fingerprint !== 'string') throw new RemoteInputError('fingerprint is required')
        return await service.pinHostKey(req.params.id, req.body.fingerprint, by(req))
      } catch (e) { return sendError(reply, e) }
    })

    // ── VPN: per-machine settings and provider device actions ───────────────

    fastify.post<{ Params: MachineParams; Body: { disabled?: unknown } }>('/machines/:id/:provider/key-expiry', { preHandler: adminOnly }, async (req, reply) => {
      try {
        const { id, provider } = params(req)
        if (typeof req.body?.disabled !== 'boolean') throw new RemoteInputError('disabled must be true or false')
        return { message: await service.setKeyExpiry(id, provider, req.body.disabled, by(req)) }
      } catch (e) { return sendError(reply, e) }
    })

    fastify.post<{ Params: MachineParams; Body: { tags?: unknown } }>('/machines/:id/:provider/tags', { preHandler: adminOnly }, async (req, reply) => {
      try {
        const { id, provider } = params(req)
        return { message: await service.setTags(id, provider, req.body?.tags as string[], by(req)) }
      } catch (e) { return sendError(reply, e) }
    })

    // A sign-in link is sensitive: admins only, re-confirmed, never cached, audited without the link.
    fastify.post<{ Params: MachineParams }>('/machines/:id/:provider/login-url', { preHandler: adminOnly }, async (req, reply) => {
      try {
        const { id, provider } = params(req)
        reply.header('cache-control', 'no-store')
        const v = await service.revealLogin(id, provider, by(req))
        if (!v) return reply.status(404).send({ error: 'No sign-in link is waiting for this machine (they expire after about ten minutes).' })
        return v
      } catch (e) { return sendError(reply, e) }
    })

    const DEVICE = /^[A-Za-z0-9_.:-]{1,120}$/
    fastify.post<{ Params: { provider: string; deviceId: string } }>('/devices/:provider/:deviceId/approve', { preHandler: adminOnly }, async (req, reply) => {
      try {
        if (!isProviderId(req.params.provider) || !DEVICE.test(req.params.deviceId)) throw new RemoteInputError('Unknown provider or device id')
        return { message: await service.approveDevice(req.params.provider, req.params.deviceId, by(req)) }
      } catch (e) { return sendError(reply, e) }
    })
    fastify.delete<{ Params: { provider: string; deviceId: string } }>('/devices/:provider/:deviceId', { preHandler: adminOnly }, async (req, reply) => {
      try {
        if (!isProviderId(req.params.provider) || !DEVICE.test(req.params.deviceId)) throw new RemoteInputError('Unknown provider or device id')
        return { message: await service.removeDevice(req.params.provider, req.params.deviceId, by(req)) }
      } catch (e) { return sendError(reply, e) }
    })

    // ── /v1: the small, stable API other pages use (VpnStatusSource) ────────
    //  Documented in docs/remote-access.md, "API for other pages". Status is for every role (role-filtered);
    //  everything that changes something is admin, and install, uninstall and settings are re-confirmed.

    const isAdmin = (req: FastifyRequest) => !!req.session && hasRole(req.session.role, 'admin')
    const statusOf = (m: RemoteMachineRow, admin: boolean) => ({
      machineId: m.id, kind: m.kind, name: m.name, node: m.node ?? null, vmid: m.vmid ?? null, running: m.running,
      providers: Object.fromEntries(Object.entries(m.cells).map(([p, c]) => [p, {
        state: c.state, installed: c.managed, ip: c.ip, dnsName: c.dnsName, version: c.version, lastSeen: c.lastSeen,
        expiresAt: c.expiresAt, expiryWarning: c.expiryWarning,
        ...(admin ? { loginPending: c.loginPending, pending: c.pending, tags: c.tags, routes: c.routes, exitNode: c.exitNode, prefs: c.prefs } : {}),
        panel: `/vpn?machine=${encodeURIComponent(m.id)}&provider=${p}`,
      }])),
    })
    const overview = async (req: FastifyRequest): Promise<RemoteOverview> => overviewForRole(await service.overview(), isAdmin(req))

    fastify.get('/v1/status', async (req, reply) => {
      try { const ov = await overview(req); return { providers: ov.providers.map(p => ({ id: p.id, label: p.label, configured: p.configured })), machines: ov.machines.map(m => statusOf(m, isAdmin(req))) } }
      catch (e) { return sendError(reply, e) }
    })
    fastify.get<{ Params: { id: string } }>('/v1/status/:id', async (req, reply) => {
      try {
        if (!MACHINE_ID.test(req.params.id)) throw new RemoteInputError('Unknown machine id format')
        const m = (await overview(req)).machines.find(x => x.id === req.params.id)
        if (!m) return reply.status(404).send({ error: `No such machine: ${req.params.id}` })
        return statusOf(m, isAdmin(req))
      } catch (e) { return sendError(reply, e) }
    })
    fastify.get<{ Params: MachineParams }>('/v1/machines/:id/:provider/install-preview', { preHandler: adminOnly }, async (req, reply) => {
      try { const { id, provider } = params(req); return await service.installPreview(id, provider) } catch (e) { return sendError(reply, e) }
    })
    fastify.post<{ Params: MachineParams; Body: { confirm?: unknown } }>('/v1/machines/:id/:provider/install', { preHandler: adminOnly }, async (req, reply) => {
      try {
        const { id, provider } = params(req)
        if (req.body?.confirm !== true) throw new RemoteInputError('Send { confirm: true } after showing the install preview')
        return reply.status(202).send({ job: await service.oneClickInstall(id, provider, by(req)) })
      } catch (e) { return sendError(reply, e) }
    })
    fastify.delete<{ Params: MachineParams }>('/v1/machines/:id/:provider', { preHandler: adminOnly }, async (req, reply) => {
      try {
        const { id, provider } = params(req)
        return reply.status(202).send({ job: service.startJob({ action: 'uninstall', provider, machineIds: [id] }, by(req)) })
      } catch (e) { return sendError(reply, e) }
    })
    fastify.get<{ Params: MachineParams }>('/v1/machines/:id/:provider/settings', { preHandler: adminOnly }, async (req, reply) => {
      try { const { id, provider } = params(req); return { current: (await service.configurePreview(id, provider, {})).current } } catch (e) { return sendError(reply, e) }
    })
    fastify.post<{ Params: MachineParams; Body: { prefs?: Partial<VpnPrefs> } }>('/v1/machines/:id/:provider/settings/preview', { preHandler: adminOnly }, async (req, reply) => {
      try { const { id, provider } = params(req); return await service.configurePreview(id, provider, req.body?.prefs ?? {}) } catch (e) { return sendError(reply, e) }
    })
    fastify.post<{ Params: MachineParams; Body: { prefs?: Partial<VpnPrefs>; acknowledge?: unknown; confirm?: unknown } }>('/v1/machines/:id/:provider/settings', { preHandler: adminOnly }, async (req, reply) => {
      try {
        const { id, provider } = params(req)
        if (req.body?.confirm !== true) throw new RemoteInputError('Send { confirm: true } after showing the settings preview')
        return reply.status(202).send({ job: service.startJob({ action: 'configure', provider, machineIds: [id], prefs: req.body?.prefs, acknowledge: req.body?.acknowledge === true }, by(req)) })
      } catch (e) { return sendError(reply, e) }
    })
    fastify.get<{ Params: { id: string } }>('/v1/jobs/:id', { preHandler: adminOnly }, async (req, reply) => {
      const job = service.getJob(req.params.id)
      if (!job) return reply.status(404).send({ error: `No job ${req.params.id}` })
      return { job }
    })

    // The one route that sends a key to the browser: re-confirmed, audited, single use, short-lived, never cached.
    fastify.post<{ Params: MachineParams; Body: { tags?: unknown } }>('/machines/:id/:provider/manual-key', { preHandler: adminOnly }, async (req, reply) => {
      try {
        const { id, provider } = params(req)
        const tags = req.body?.tags
        if (tags !== undefined && (!Array.isArray(tags) || !tags.every(t => typeof t === 'string'))) throw new RemoteInputError('tags must be a list')
        const out = await service.manualKey(id, provider, tags as string[] | undefined, by(req))
        reply.header('cache-control', 'no-store')
        return out
      } catch (e) { return sendError(reply, e) }
    })
  }
}

export const remoteRoutes: FastifyPluginAsync = buildRemoteRoutes()
