// =============================================================================
//  HyperProx — Arr Stack live queue (/api/plugins/arrstack)
//
//  Roles (lib/roles.ts): a GET, so viewer, like the Arr Stack page itself.
//    GET /queue    the Sonarr and Radarr download queues, every page, collapsed server-side: one entry per
//                  download (a season pack is 23 queue rows but one download), grouped Show → Season, with
//                  progress, ETA, quality, client and any warning, problems first. Movies are a flat list.
//
//  Read-only, and the same light "live" route shape as Plex's /live: the page asks every few seconds, and one
//  upstream reading is shared by every open page for a few seconds, so several tabs cost Sonarr and Radarr one
//  read of the queue. The keys stay with the vault-backed plug-in settings; none is ever in a response.
//  Sonarr and Radarr are separate: one being down greys its own half and the other still shows.
// =============================================================================

import type { FastifyPluginAsync } from 'fastify'
import { findPlugin } from '../plugins'
import { pluginEndpointClient, type CoreEndpointClient } from '../lib/plugin-host'
import { buildQueueData, readAllQueue, type QueueData } from '../lib/arr-queue/logic'

const arrClient = async (endpoint: 'default' | 'radarr'): Promise<CoreEndpointClient | null> => {
  const p = findPlugin('arrstack')
  return p ? pluginEndpointClient(p, endpoint).catch(() => null) : null
}

const msg = (e: any) => String(e?.message ?? e).slice(0, 160)

export async function readQueue(deps: { sonarr: CoreEndpointClient | null; radarr: CoreEndpointClient | null; now: number }): Promise<QueueData> {
  const one = async (c: CoreEndpointClient | null, kind: 'sonarr' | 'radarr') => {
    if (!c) return { rows: null, configured: false, error: undefined as string | undefined }
    try { return { rows: await readAllQueue((p, t) => c.get(p, t), kind), configured: true, error: undefined as string | undefined } }
    catch (e) { return { rows: null, configured: true, error: msg(e) } }
  }
  const [sonarr, radarr] = await Promise.all([one(deps.sonarr, 'sonarr'), one(deps.radarr, 'radarr')])
  return buildQueueData({ sonarr, radarr, now: deps.now })
}

export function buildArrQueueRoutes(deps: {
  sonarr?: () => Promise<CoreEndpointClient | null>; radarr?: () => Promise<CoreEndpointClient | null>
  now?: () => number; ttlMs?: number
} = {}): FastifyPluginAsync {
  const sonarr = deps.sonarr ?? (() => arrClient('default'))
  const radarr = deps.radarr ?? (() => arrClient('radarr'))
  const now = deps.now ?? Date.now
  const ttl = deps.ttlMs ?? 3000
  // One reading shared by everyone. A failed one is dropped at once so the next ask retries.
  let memo: { at: number; p: Promise<QueueData> } | null = null

  return async (fastify) => {
    fastify.get('/queue', async (_req, reply) => {
      const t = now()
      if (!memo || t - memo.at > ttl) {
        const p = (async () => readQueue({ sonarr: await sonarr().catch(() => null), radarr: await radarr().catch(() => null), now: t }))()
        const mine = { at: t, p }
        memo = mine
        p.catch(() => { if (memo === mine) memo = null })
      }
      try { return { success: true, data: await memo.p } } catch (e) {
        return reply.status(502).send({ success: false, code: 'queue_failed', error: msg(e) })
      }
    })
  }
}

export const arrQueueRoutes: FastifyPluginAsync = buildArrQueueRoutes()
