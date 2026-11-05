// =============================================================================
//  HyperProx — Settings → Setup checklist (admin)
//
//  GET  /                  every installer question, whether it is done now, per node where it applies
//  PUT  /node-login        one login for every node: tested on each, then kept in the vault per node
//  POST /:item/run         do it now (one item at a time; node work one node at a time)
//  GET  /jobs/:id          progress and the checks afterwards
// =============================================================================

import type { FastifyPluginAsync } from 'fastify'
import { checklistState, startItem, getJob, activeJob, saveNodeLoginForAll, ChecklistRefusal, productionChecklistDeps, type ChecklistDeps, type ItemId } from '../lib/setup-checklist'
import { currentContext } from '../lib/auth'

export function buildSetupChecklistRoutes(deps?: () => ChecklistDeps): FastifyPluginAsync {
  const d = deps ?? productionChecklistDeps
  const who = () => currentContext()?.email ?? 'unknown'
  const fail = (reply: any, e: any) => e instanceof ChecklistRefusal
    ? reply.status(e.status).send({ success: false, error: e.message })
    : reply.status(500).send({ success: false, error: e?.message ?? String(e) })

  return async (fastify) => {
    fastify.get('/', async (_req, reply) => {
      try { return reply.send({ success: true, data: { ...(await checklistState(d())), running: activeJob() } }) }
      catch (e) { return fail(reply, e) }
    })

    fastify.put<{ Body: Record<string, unknown> }>('/node-login', async (req, reply) => {
      try {
        const rows = await saveNodeLoginForAll(req.body, who(), d())
        return reply.send({ success: rows.some(r => r.ok), data: { nodes: rows } })
      } catch (e) { return fail(reply, e) }
    })

    fastify.post<{ Params: { item: string }; Body: Record<string, unknown> }>('/:item/run', async (req, reply) => {
      try {
        const job = await startItem(req.params.item as ItemId, req.body ?? {}, who(), d())
        return reply.send({ success: true, data: job })
      } catch (e) { return fail(reply, e) }
    })

    fastify.get<{ Params: { id: string } }>('/jobs/:id', async (req, reply) => {
      const job = getJob(req.params.id)
      if (!job) return reply.status(404).send({ success: false, error: 'No such job' })
      return reply.send({ success: true, data: job })
    })
  }
}

export const setupChecklistRoutes = buildSetupChecklistRoutes()
