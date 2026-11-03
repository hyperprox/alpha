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
import { livePve } from '../lib/pve-env'
import {
  RemoteAccessService, RemoteBusyError, RemoteInputError, RemoteNotFoundError, type JobRequest,
} from '../lib/remote/service'
import { PrismaRemoteStore } from '../lib/remote/store'
import { productionRemoteExecutor } from '../lib/remote/executor'
import { providerFromVault, providerSettingsFromVault } from '../lib/remote/providers'
import { ProviderError, isProviderId } from '../lib/remote/types'

export interface RemoteRouteDeps { service?: RemoteAccessService }

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
    })
    fastify.addHook('onClose', async () => service.close())

    const by = (req: FastifyRequest) => req.session?.email ?? 'unknown'

    // Viewer and up. The gate has already required a session.
    fastify.get('/overview', async (_req, reply) => {
      try { return await service.overview() } catch (e) { return sendError(reply, e) }
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
          action: 'install', provider: b.provider as any, machineIds: b.machineIds as any, tags: b.tags, mode: b.mode,
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
