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

const READ_DEADLINE_MS = 45_000
const STALE_MS = 60_000

const msg = (e: any) => {
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError' || /abort/i.test(String(e?.message ?? ''))) return 'timed out'
  return String(e?.message ?? e).slice(0, 160)
}

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
  // One reading shared by everyone. The in-flight promise is shared, and the TTL starts when the read FINISHES (so a
  // slow read never lets each new request start another one). A hung read is cut off at READ_DEADLINE_MS, and one
  // older than STALE_MS is replaced. A failed one is dropped at once (only if it is still the current one).
  let memo: { startedAt: number; doneAt: number | null; p: Promise<QueueData> } | null = null

  return async (fastify) => {
    fastify.get('/queue', async (_req, reply) => {
      const t = now()
      const fresh = memo && (memo.doneAt === null ? t - memo.startedAt <= STALE_MS : t - memo.doneAt <= ttl)
      if (!fresh) {
        const work = (async () => readQueue({ sonarr: await sonarr().catch(() => null), radarr: await radarr().catch(() => null), now: t }))()
        let timer: ReturnType<typeof setTimeout> | undefined
        const deadline = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('timed out reading the queue')), READ_DEADLINE_MS) })
        const p = Promise.race([work, deadline]).finally(() => clearTimeout(timer))
        const mine: { startedAt: number; doneAt: number | null; p: Promise<QueueData> } = { startedAt: t, doneAt: null, p }
        memo = mine
        p.then(() => { mine.doneAt = now() }, () => { if (memo === mine) memo = null })
        work.catch(() => {})
      }
      const cur = memo!
      try { return { success: true, data: await cur.p } } catch (e) {
        return reply.status(502).send({ success: false, code: 'queue_failed', error: msg(e) })
      }
    })
  }
}

export const arrQueueRoutes: FastifyPluginAsync = buildArrQueueRoutes()
