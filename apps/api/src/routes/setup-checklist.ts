// =============================================================================
//  HyperProx — Settings → Setup checklist (admin)
//
//  GET  /                  every installer question, whether it is done now, per node where it applies
//  PUT  /node-login        one login for every node: tested on each, then kept in the vault per node
//  POST /:item/run         do it now (one item at a time; node work one node at a time)
//  GET  /jobs/:id          progress and the checks afterwards
//  GET  /igpu-access/:node            { node, state: 'open'|'closed'|'none', ruleInstalled }
//  POST /igpu-access/:node/apply      let containers use the node's built-in graphics → { status, reason, state }
//  POST /igpu-access/:node/undo       take that back → { status, reason, state }
//  Every POST and PUT asks for the master password again (lib/roles.ts). The Infrastructure page's
//  Portable GPU links here; lib/igpu-access.ts is the same thing as a function.
// =============================================================================

import type { FastifyPluginAsync } from 'fastify'
import { confirmHostKey, saveHostKeyAnchor, checklistState, startItem, getJob, activeJob, saveNodeLoginForAll, ChecklistRefusal, productionChecklistDeps, type ChecklistDeps, type ItemId } from '../lib/setup-checklist'
import { igpuAccess, IgpuRefusal } from '../lib/igpu-access'
import { codeForStatus, sendFailure, sendRefusal } from '../lib/failure'
import { contextActor } from '../lib/http/request-actor'

export function buildSetupChecklistRoutes(deps?: () => ChecklistDeps): FastifyPluginAsync {
  const d = deps ?? productionChecklistDeps
  const fail = (reply: any, e: any) => e instanceof ChecklistRefusal
    ? sendRefusal(reply, e.status, codeForStatus(e.status), e.message)
    : sendFailure(reply.request, reply, e)

  return async (fastify) => {
    fastify.get('/', async (_req, reply) => {
      try { return reply.send({ success: true, data: { ...(await checklistState(d())), running: activeJob() } }) }
      catch (e) { return fail(reply, e) }
    })

    fastify.put<{ Body: Record<string, unknown> }>('/node-login', async (req, reply) => {
      try {
        const rows = await saveNodeLoginForAll(req.body, contextActor().email, d())
        return reply.send({ success: rows.some(r => r.ok), data: { nodes: rows } })
      } catch (e) { return fail(reply, e) }
    })

    fastify.post<{ Params: { item: string }; Body: Record<string, unknown> }>('/:item/run', async (req, reply) => {
      try {
        const job = await startItem(req.params.item as ItemId, req.body ?? {}, contextActor().email, d())
        return reply.send({ success: true, data: job })
      } catch (e) { return fail(reply, e) }
    })

    // POST /host-keys/anchor { output }: what the one-line command printed on one of the admin's nodes.
    // Replacing keys the installer read on a node itself needs `replaceInstaller: true`, and like every change here it is
    // confirmed on the page (lib/confirm.ts): that confirmation is bound to this exact body, replaceInstaller included,
    // and says plainly what replacing them means (lib/confirm-text.ts).
    fastify.post<{ Body: Record<string, unknown> }>('/host-keys/anchor', async (req, reply) => {
      const replaceInstaller = req.body?.replaceInstaller === true
      try { return reply.send({ success: true, data: await saveHostKeyAnchor(req.body, contextActor().email, { replaceInstaller }) }) }
      catch (e: any) {
        if (e?.code === 'anchor_installer') return reply.status(409).send({ success: false, code: 'anchor_installer', error: e.message })
        return fail(reply, e)
      }
    })

    // POST /host-keys/confirm { host, port, fingerprint }: the admin compared it on the machine.
    fastify.post<{ Body: Record<string, unknown> }>('/host-keys/confirm', async (req, reply) => {
      try { return reply.send({ success: true, data: await confirmHostKey(req.body, contextActor().email, d()) }) }
      catch (e) { return fail(reply, e) }
    })

    const igpu = (reply: any, e: any) => e instanceof IgpuRefusal ? sendRefusal(reply, e.status, codeForStatus(e.status), e.message) : fail(reply, e)
    fastify.get<{ Params: { node: string } }>('/igpu-access/:node', async (req, reply) => {
      try { const a = await igpuAccess(req.params.node, d().hardware, contextActor().email); return reply.send({ success: true, data: { node: a.node, state: a.state, ruleInstalled: a.ruleInstalled } }) }
      catch (e) { return igpu(reply, e) }
    })
    for (const verb of ['apply', 'undo'] as const) {
      fastify.post<{ Params: { node: string } }>(`/igpu-access/:node/${verb}`, async (req, reply) => {
        try { const a = await igpuAccess(req.params.node, d().hardware, contextActor().email); return reply.send({ success: true, data: await a[verb]() }) }
        catch (e) { return igpu(reply, e) }
      })
    }

    fastify.get<{ Params: { id: string } }>('/jobs/:id', async (req, reply) => {
      const job = getJob(req.params.id)
      if (!job) return reply.status(404).send({ success: false, error: 'No such job' })
      return reply.send({ success: true, data: job })
    })
  }
}

export const setupChecklistRoutes = buildSetupChecklistRoutes()
