// =============================================================================
//  HyperProx — Send files, the simple way (/api/clusters/:id/send/...), registered by routes/clusters.ts
//
//  All admin (lib/roles.ts). /send/setup also needs the master password re-entered, which keeps API tokens
//  out (a token cannot re-confirm); it is refused here for a token as well. The rest only read, or start a
//  copy through the reviewed engine (a copy only adds files, so starting one is not re-confirmed, as before).
//  No answer carries a key, a token or a password.
// =============================================================================

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { currentContext } from '../lib/auth'
import { ClusterRefusal, clusterRow, validClusterId } from '../lib/clusters/registry'
import { discoverSend, browseSend, searchSend, previewSend, setupSend, sendNow, linkSpeed, type SendPlan } from '../lib/clusters/send-simple'
import { jobStore } from '../lib/clusters/files'
import { PinConfirmRefusal } from '../lib/hostkey-pins'

const who = () => currentContext()?.email ?? 'unknown'

/** At most `max` calls a minute per signed-in session for the calls that open connections to every node. */
const hits = new Map<string, number[]>()
function overLimit(key: string, max: number, now = Date.now()): boolean {
  const list = (hits.get(key) ?? []).filter(t => now - t < 60_000)
  const over = list.length >= max
  if (!over) list.push(now)
  hits.set(key, list)
  return over
}

function fail(reply: FastifyReply, e: any) {
  const msg = e?.message ?? String(e)
  if (e?.name === 'VaultLockedError' || /HyperProx is locked/i.test(msg)) return reply.status(423).send({ success: false, locked: true, error: 'HyperProx is locked. Sign in to unlock it, then try again. Nothing was done.' })
  if (e instanceof ClusterRefusal) return reply.status(e.code === 'not-found' ? 404 : e.code === 'conflict' ? 409 : e.code === 'confirm' ? 409 : 422).send({ success: false, code: e.code, error: msg })
  if (e instanceof PinConfirmRefusal) return reply.status(409).send({ success: false, code: 'hostkey', error: msg })
  return reply.status(502).send({ success: false, error: msg })
}

/** What the page needs from a plan: names, sizes, words. Paths are shown so the owner can see what is meant. */
export async function planView(p: SendPlan) {
  const { speed, measured } = linkSpeed(p.dst, await jobStore().list().catch(() => []))
  return {
    speed, speedMeasured: measured,
    ready: p.ready, steps: p.steps, problems: p.problems, hostKeys: p.hostKeys, sourceNode: p.sourceNode,
    libraries: p.libraries.map(l => ({ id: l.id, name: l.name, path: l.path, node: l.node, free: l.free, size: l.size, plex: !!l.sectionKey })),
    sources: p.sources.map(s => ({ name: s.name, path: s.path })),
  }
}

export const sendRoutes: FastifyPluginAsync = async (fastify) => {
  const remoteOr404 = (id: string, reply: FastifyReply) => {
    const row = validClusterId(id) ? clusterRow(id) : null
    if (!row || row.kind !== 'remote') { reply.status(404).send({ success: false, error: 'No such server.' }); return null }
    return row
  }
  const limited = (route: string, reply: FastifyReply) => {
    if (!overLimit(`${route}:${currentContext()?.sid ?? 'none'}`, 20)) return false
    reply.status(429).send({ success: false, error: 'That was asked too often. Wait a minute and try again.' })
    return true
  }

  // Look at both ends (read-only). `fresh` looks again instead of using what was found in the last 15 minutes.
  fastify.post<{ Params: { id: string }; Body: { fresh?: boolean } }>('/:id/send/discover', async (req, reply) => {
    const row = remoteOr404(req.params.id, reply); if (!row) return
    if (limited('send-discover', reply)) return
    try { return { success: true, data: await planView(await discoverSend(row.id, undefined, { fresh: req.body?.fresh === true })) } } catch (e) { return fail(reply, e) }
  })

  fastify.get<{ Params: { id: string }; Querystring: { path?: string } }>('/:id/send/browse', async (req, reply) => {
    const row = remoteOr404(req.params.id, reply); if (!row) return
    try { return { success: true, data: await browseSend(row.id, String(req.query.path ?? '')) } } catch (e) { return fail(reply, e) }
  })

  fastify.get<{ Params: { id: string }; Querystring: { q?: string } }>('/:id/send/search', async (req, reply) => {
    const row = remoteOr404(req.params.id, reply); if (!row) return
    if (limited('send-search', reply)) return
    try { return { success: true, data: await searchSend(row.id, String(req.query.q ?? '')) } } catch (e) { return fail(reply, e) }
  })

  fastify.post<{ Params: { id: string }; Body: { items?: unknown; library?: string } }>('/:id/send/preview', async (req, reply) => {
    const row = remoteOr404(req.params.id, reply); if (!row) return
    const items = Array.isArray(req.body?.items) ? req.body!.items.map(String) : []
    try { return { success: true, data: await previewSend(who(), row.id, items, String(req.body?.library ?? '')) } } catch (e) { return fail(reply, e) }
  })

  // First-time setup, everything in one step. Re-confirmed (lib/roles.ts); never for an API token.
  fastify.post<{ Params: { id: string }; Body: { confirmHostKeys?: unknown } }>('/:id/send/setup', async (req, reply) => {
    const row = remoteOr404(req.params.id, reply); if (!row) return
    if ((req as any).apiToken) return reply.status(403).send({ success: false, code: 'token_forbidden', error: 'Setting up sending needs a person with the master password, not an API token.' })
    const keys = Array.isArray(req.body?.confirmHostKeys) ? req.body!.confirmHostKeys.map(String).slice(0, 10) : []
    try { const r = await setupSend(row.id, who(), keys); return { success: true, data: { words: r.words, plan: await planView(r.plan) } } } catch (e) { return fail(reply, e) }
  })

  fastify.post<{ Params: { id: string }; Body: { previewId?: string } }>('/:id/send', async (req, reply) => {
    const row = remoteOr404(req.params.id, reply); if (!row) return
    try { return { success: true, data: await sendNow(who(), String(req.body?.previewId ?? '')) } } catch (e) { return fail(reply, e) }
  })
}
