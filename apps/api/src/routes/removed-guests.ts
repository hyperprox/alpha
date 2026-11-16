// =============================================================================
//  HyperProx — removed guests (/api/removed-guests)
//
//  What HyperProx still holds for guests that were removed from Proxmox, and
//  the one Clean up for each. Admin for every method, reads included (it names
//  guests, addresses and backup jobs). Clean up also needs the master password
//  again (lib/roles.ts): it deletes vault items and changes the cluster's backup
//  jobs and HA list, and it is a person's decision, never an API token's.
// =============================================================================

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { sendFailure, sendRefusal } from '../lib/failure'
import { actorOf, actorWords } from '../lib/http/request-actor'
import { RemovedGuestsRefusal, removedGuests } from '../lib/removed-guests'

const JOB_ID = /^[A-Za-z0-9:_-]{1,80}$/

function fail(reply: FastifyReply, e: any) {
  if (e instanceof RemovedGuestsRefusal) return sendRefusal(reply, e.status, e.code, e.message)
  if (e?.name === 'VaultLockedError') throw e
  return sendFailure(reply.request, reply, e, 'The clean-up did not work. The details are in the log.', { adminDetail: true })
}

export const removedGuestsRoutes: FastifyPluginAsync = async (fastify) => {
  // The watch's timer is started by lib/services/bootstrap.ts; these routes only read and decide.

  fastify.get('/', async (_req, reply) => {
    try { return { success: true, data: await removedGuests().view() } } catch (e) { return fail(reply, e) }
  })

  fastify.addHook('preHandler', async (req, reply) => {
    if (req.method !== 'GET' && req.apiToken) return reply.status(403).send({ success: false, code: 'token_forbidden', error: 'API tokens cannot clean up removed guests.' })
  })

  // Look now (the notice's "Check again"): the same look the timer takes; it never decides on one read alone.
  fastify.post('/look', async (_req, reply) => {
    try { await removedGuests().tick(); return { success: true, data: await removedGuests().view() } } catch (e) { return fail(reply, e) }
  })

  fastify.post<{ Params: { vmid: string }; Body: { published?: unknown; deleteEmptyJobs?: unknown } }>('/:vmid/clean-up', async (req, reply) => {
    const vmid = Number(req.params.vmid)
    if (!/^\d{1,9}$/.test(req.params.vmid) || vmid < 1) return reply.status(400).send({ success: false, code: 'bad_input', error: 'That is not a guest ID.' })
    const jobs = Array.isArray(req.body?.deleteEmptyJobs) ? req.body!.deleteEmptyJobs.map(String) : []
    if (jobs.length > 50 || jobs.some(j => !JOB_ID.test(j))) return reply.status(400).send({ success: false, code: 'bad_input', error: 'Those are not backup job names.' })
    try {
      const r = await removedGuests().cleanUp(vmid, { published: req.body?.published === true, deleteEmptyJobs: jobs }, actorWords(actorOf(req)))
      return { success: true, data: r }
    } catch (e) { return fail(reply, e) }
  })
}
