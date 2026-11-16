// =============================================================================
//  HyperProx — auto-connect routes (/api/auto-connect)
//
//  The background pass (lib/auto-connect) connects what the plug-ins found by
//  itself. These routes only show what it did, and take the two things a person
//  still decides: which of two candidates to use (a pick), and "connect again"
//  for something they disconnected. Admin for every method, reads included (the
//  state names guests, addresses and vault item names; never a secret value).
//  A pick connects exactly as the pass would: read-only, the vault item used
//  only against the address it was stored for.
// =============================================================================

import { sendFailure, sendRefusal } from '../lib/failure'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { actorOf, actorWords } from '../lib/http/request-actor'
import { AutoConnectError, autoConnect } from '../lib/auto-connect'

const PLUGIN = /^[a-z][a-z0-9-]{0,40}$/
const KEY = /^[A-Za-z0-9_.:@*#/[\]-]{1,200}$/

function fail(reply: FastifyReply, e: any) {
  if (e instanceof AutoConnectError) return sendRefusal(reply, e.status, e.code, e.message)
  if (e?.name === 'VaultLockedError') throw e
  return sendFailure(reply.request, reply, e, 'That did not work. The details are in the log.', { adminDetail: true })
}

export const autoConnectRoutes: FastifyPluginAsync = async (fastify) => {
  // The pass's timer and its exclusion list are started by lib/services/bootstrap.ts; these routes only read and decide.

  fastify.get('/', async (_req, reply) => {
    try {
      const s = await autoConnect().state()
      return { success: true, data: { ...s, waitingForUnlock: autoConnect().waitingForUnlock } }
    } catch (e) { return fail(reply, e) }
  })

  // Run a pass now (the page's "look again"); the same pass the timer runs.
  fastify.post('/run', async (_req, reply) => {
    try {
      const r = await autoConnect().run('person')
      return { success: true, data: { waited: r.waited } }
    } catch (e) { return fail(reply, e) }
  })

  // A person's decision, never an API token's: a pick can send a vault item's credential to its address.
  fastify.addHook('preHandler', async (req, reply) => {
    if (req.method !== 'GET' && req.apiToken) return reply.status(403).send({ success: false, code: 'token_forbidden', error: 'API tokens cannot make auto-connect choices.' })
  })

  fastify.post<{ Body: { plugin?: unknown; key?: unknown; choice?: unknown } }>('/pick', async (req, reply) => {
    const plugin = String(req.body?.plugin ?? ''), key = String(req.body?.key ?? ''), choice = String(req.body?.choice ?? '')
    if (!PLUGIN.test(plugin) || !KEY.test(key) || !choice || choice.length > 300) return reply.status(400).send({ success: false, code: 'bad_input', error: 'Pick one of the listed options.' })
    try { return { success: true, data: await autoConnect().pick(plugin, key, choice, actorWords(actorOf(req))) } }
    catch (e) { return fail(reply, e) }
  })

  fastify.post<{ Body: { plugin?: unknown; key?: unknown } }>('/connect-again', async (req, reply) => {
    const plugin = String(req.body?.plugin ?? ''), key = String(req.body?.key ?? '')
    if (!PLUGIN.test(plugin) || !KEY.test(key)) return reply.status(400).send({ success: false, code: 'bad_input', error: 'Which one?' })
    try { const r = await autoConnect().connectAgain(plugin, key, actorWords(actorOf(req))); return { success: true, data: { waited: r.waited } } }
    catch (e) { return fail(reply, e) }
  })
}
