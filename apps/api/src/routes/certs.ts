// =============================================================================
//  HyperProx — Certificates routes (/api/certs)
//
//  Admin only, reads included. The role matrix (lib/roles.ts) says so too, but
//  the check is repeated here per route, as Updates does: the inventory maps
//  every endpoint and what it serves, and the actions issue and deploy keys.
//
//  The work is in lib/certs; this file translates HTTP to it. Every action is
//  written to the audit log by the service, with the signed-in user.
// =============================================================================

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { hasRole } from '../lib/roles'
import { isUnlocked } from '../lib/vault/state'
import {
  CertsBusyError, CertsInputError, CertsNotFoundError, CertsService, RenewingError, productionCertsService,
} from '../lib/certs/service'
import { CertsScheduler } from '../lib/certs/scheduler'

export interface CertsRouteDeps {
  service?:   CertsService
  /** Tests turn these off; production wants both. */
  scheduler?: boolean
  recover?:   boolean
}

async function adminOnly(req: FastifyRequest, reply: FastifyReply) {
  const s = req.session
  if (!s) return reply.status(401).send({ ok: false, code: 'unauthenticated', error: 'Authentication required' })
  if (!hasRole(s.role, 'admin')) {
    return reply.status(403).send({ ok: false, code: 'forbidden', error: 'Certificates need the admin role', required: 'admin', role: s.role })
  }
}

function sendError(reply: FastifyReply, e: any) {
  if (e instanceof CertsInputError) return reply.status(400).send({ error: e.message })
  if (e instanceof CertsNotFoundError) return reply.status(404).send({ error: e.message })
  if (e instanceof RenewingError || e instanceof CertsBusyError) return reply.status(409).send({ error: e.message })
  return reply.status(503).send({ error: e?.message ?? String(e) })
}

// A label is a YAML key from the policy; anything else in the path is refused before it reaches a lookup.
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const HOST_RE  = /^(?=.{1,253}$)[A-Za-z0-9*]([A-Za-z0-9.-]*[A-Za-z0-9])?$|^[0-9a-fA-F:.]+$/

export function buildCertsRoutes(deps: CertsRouteDeps = {}): FastifyPluginAsync {
  return async (fastify) => {
    const service = deps.service ?? productionCertsService((fastify as any).prisma, m => fastify.log.info(m))

    if (deps.recover !== false) {
      // The database needs no vault, so an issuance cut off by a restart is released before anyone can press anything.
      fastify.addHook('onReady', async () => {
        await service.recover().catch(e => fastify.log.error(`[certs] restart recovery failed: ${e.message}`))
      })
    }
    if (deps.scheduler !== false) {
      const scheduler = new CertsScheduler({
        service, isUnlocked,
        cron: () => service.policy().policy.schedule.check,
        log: m => fastify.log.info(m),
      })
      fastify.addHook('onReady', async () => scheduler.start())
      fastify.addHook('onClose', async () => scheduler.stop())
    }

    fastify.addHook('preHandler', adminOnly)

    fastify.get<{ Querystring: { refresh?: string } }>('/overview', async (req, reply) => {
      try { return await service.overview(req.query.refresh === '1' || req.query.refresh === 'true') }
      catch (e) { return sendError(reply, e) }
    })

    fastify.post<{ Body: { host?: unknown; port?: unknown } | undefined }>('/probe', async (req, reply) => {
      const body = req.body ?? {}
      let target: { host: string; port: number } | undefined
      if (body.host !== undefined && body.host !== null && body.host !== '') {
        if (typeof body.host !== 'string' || !HOST_RE.test(body.host)) return reply.status(400).send({ error: 'host must be a host name or IP address' })
        const port = body.port === undefined || body.port === null ? 443 : Number(body.port)
        if (!Number.isInteger(port) || port < 1 || port > 65535) return reply.status(400).send({ error: 'port must be 1-65535' })
        target = { host: body.host, port }
      } else if (body.port !== undefined && body.port !== null) {
        return reply.status(400).send({ error: 'port needs a host' })
      }
      try { return { probes: await service.probe(target, req.session?.email) } }
      catch (e) { return sendError(reply, e) }
    })

    for (const op of ['issue', 'deploy'] as const) {
      fastify.post<{ Params: { label: string } }>(`/managed/:label/${op}`, async (req, reply) => {
        const label = req.params.label
        if (!LABEL_RE.test(label)) return reply.status(404).send({ error: `No certificate ${label}` })
        try {
          const managed = await service[op](label, req.session?.email)
          return reply.status(202).send({ managed })
        } catch (e) { return sendError(reply, e) }
      })
    }

    fastify.get<{ Querystring: { label?: string; limit?: string } }>('/events', async (req, reply) => {
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500)
      const label = req.query.label ? String(req.query.label) : undefined
      try { return { events: await service.events(label, limit) } }
      catch (e) { return sendError(reply, e) }
    })

    fastify.get('/housekeeping', async (_req, reply) => {
      try { return { items: await service.housekeeping() } }
      catch (e) { return sendError(reply, e) }
    })

    fastify.post<{ Params: { id: string } }>('/housekeeping/:id/apply', async (req, reply) => {
      try { return { ok: true, detail: await service.applyHousekeeping(req.params.id, req.session?.email) } }
      catch (e) { return sendError(reply, e) }
    })
  }
}

export const certsRoutes: FastifyPluginAsync = buildCertsRoutes()
