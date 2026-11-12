// =============================================================================
//  HyperProx — Arr Stack live queue (/api/plugins/arrstack)
//
//  Roles (lib/roles.ts): a GET, so viewer, like the Arr Stack page itself.
//    GET /queue    the Sonarr and Radarr download queues, every page, collapsed server-side: one entry per
//                  download (a season pack is 23 queue rows but one download), grouped Show → Season, with
//                  progress, ETA, quality, client, any warning, and a "why this download" line (what it fills, upgrades or
//                  skips, read from the episodes and files on disk, batched into the same shared reading), problems first. Movies are a flat list.
//
//  POST /queue/actions  admin only (a signed-in person: an API token is refused by name, here and in the gate), no
//                  master password, rate-limited per person. What to do about a problem in the queue: find another,
//                  remove, retry an import, move a torrent to the top, swap singles for a season pack, fix all
//                  stalled, clear all done (lib/arr-queue/actions.ts). The browser sends an instance and download ids; the server
//                  re-reads the whole queue fresh (never this cache) and resolves the rows itself. `preview: true`
//                  answers with exactly what would be removed and searched and changes nothing. Queue downloads only,
//                  never library files. Every run is audited before it starts.
//
//  The reading is read-only, and the same light "live" route shape as Plex's /live: the page asks every few seconds, and one
//  upstream reading is shared by every open page for a few seconds, so several tabs cost Sonarr and Radarr one
//  read of the queue. The keys stay with the vault-backed plug-in settings; none is ever in a response.
//  Sonarr and Radarr are separate: one being down greys its own half and the other still shows.
// =============================================================================

import type { FastifyPluginAsync } from 'fastify'
import { findPlugin } from '../plugins'
import { pluginEndpointClient, type CoreEndpointClient } from '../lib/plugin-host'
import { buildQueueData, readAllQueue, type QueueData } from '../lib/arr-queue/logic'
import { ACTIONS, ActionRefusal, DESTRUCTIVE, runAction, type ActionName, type ActionRequest } from '../lib/arr-queue/actions'
import { readEpisodeInfo, readMovieInfo } from '../lib/arr-queue/lookup'
import { auditOrThrow } from '../lib/audit'
import { hasRole } from '../lib/roles'
import { MissLimiter } from '../lib/plex-art'

const arrClient = async (endpoint: 'default' | 'radarr'): Promise<CoreEndpointClient | null> => {
  const p = findPlugin('arrstack')
  return p ? pluginEndpointClient(p, endpoint).catch(() => null) : null
}

const qbitClient = async (): Promise<CoreEndpointClient | null> => {
  const p = findPlugin('arrstack')
  return p ? pluginEndpointClient(p, 'qbit').catch(() => null) : null
}

const READ_DEADLINE_MS = 45_000
const STALE_MS = 60_000
/** The episode and file lookups for "Why this download" get this long, on top of the queue read. */
const LOOKUP_BUDGET_MS = 10_000

const msg = (e: any) => {
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError' || /abort/i.test(String(e?.message ?? ''))) return 'timed out'
  return String(e?.message ?? e).slice(0, 160)
}

export async function readQueue(deps: { sonarr: CoreEndpointClient | null; radarr: CoreEndpointClient | null; now: number; lookupMs?: number }): Promise<QueueData> {
  const one = async (c: CoreEndpointClient | null, kind: 'sonarr' | 'radarr') => {
    if (!c) return { rows: null, info: undefined, configured: false, error: undefined as string | undefined }
    try {
      const get = (p: string, t?: number) => c.get(p, t)
      const rows = await readAllQueue(get, kind)
      // What is on disk for what was queued, for "Why this download": batched, inside this one shared reading.
      // Its own budget: if the lookups run long they are dropped and the queue is still returned, without the lines.
      let timer: ReturnType<typeof setTimeout> | undefined
      const budget = new Promise<undefined>(res => { timer = setTimeout(() => res(undefined), deps.lookupMs ?? LOOKUP_BUDGET_MS) })
      const info = await Promise.race([kind === 'sonarr' ? readEpisodeInfo(get, rows, deps.now) : readMovieInfo(get, rows, deps.now), budget]).finally(() => clearTimeout(timer))
      return { rows, info, configured: true, error: undefined as string | undefined }
    }
    catch (e) { return { rows: null, info: undefined, configured: true, error: msg(e) } }
  }
  const [sonarr, radarr] = await Promise.all([one(deps.sonarr, 'sonarr'), one(deps.radarr, 'radarr')])
  return buildQueueData({ sonarr, radarr, now: deps.now })
}

export function buildArrQueueRoutes(deps: {
  sonarr?: () => Promise<CoreEndpointClient | null>; radarr?: () => Promise<CoreEndpointClient | null>
  qbit?: () => Promise<CoreEndpointClient | null>
  audit?: (action: string, details: Record<string, unknown>) => Promise<void>
  limiter?: MissLimiter
  now?: () => number; ttlMs?: number
} = {}): FastifyPluginAsync {
  const qbit = deps.qbit ?? qbitClient
  const audit = deps.audit ?? ((a: string, d: Record<string, unknown>) => auditOrThrow(a, 'plugin:arrstack', d))
  // Thirty requests a minute per person: a preview and its confirmation are two.
  const limiter = deps.limiter ?? new MissLimiter(30)
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
        const work = (async () => {
          const data = await readQueue({ sonarr: await sonarr().catch(() => null), radarr: await radarr().catch(() => null), now: t })
          // Moving a torrent up needs qBittorrent in the plug-in's settings: the page hides the button otherwise.
          return { ...data, capabilities: { prioritise: !!(await qbit().catch(() => null)) } }
        })()
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

    fastify.post('/queue/actions', async (req, reply) => {
      const refuse = (status: number, code: string, error: string) => reply.status(status).send({ success: false, code, error })
      // The gate already refuses a token and anyone below admin; checked again here so this route is safe on its own.
      if (req.apiToken) return refuse(403, 'token_forbidden', 'API tokens cannot use this route')
      const session = req.session
      if (!session || !hasRole(session.role, 'admin')) return refuse(403, 'forbidden', 'This needs the admin role')
      const parsed = parseBody(req.body)
      if (typeof parsed === 'string') return refuse(400, 'bad_request', parsed)
      const body = req.body as Record<string, unknown>
      const preview = body.preview === true
      if (!limiter.allow(session.email)) return refuse(429, 'rate_limited', 'Too many queue actions in a minute. Wait a moment and try again.')
      if (!preview && DESTRUCTIVE.includes(parsed.action) && body.confirmed !== true) return refuse(400, 'confirm_required', 'This removes downloads: confirm it first.')
      try {
        const out = await runAction({ sonarr, radarr, qbit, audit }, parsed, session.email, { preview })
        // The next reading of the queue must not be the cached one from before the change.
        memo = null
        if (preview) return { success: true, data: { preview: true, plan: publicPlan(out.plan) } }
        return { success: true, data: out.result }
      } catch (e) {
        memo = null
        if (e instanceof ActionRefusal) return refuse(e.status, e.code, e.message)
        return refuse(502, 'action_failed', msg(e))
      }
    })
  }
}

const str = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max
const strList = (v: unknown, n: number) => Array.isArray(v) && v.length <= n && v.every(x => str(x, 220))

/** The request body, checked field by field. A string is the reason it was refused. */
function parseBody(b: unknown): ActionRequest | string {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'Send a JSON body.'
  const o = b as Record<string, unknown>
  if (!ACTIONS.includes(o.action as ActionName)) return 'Unknown action.'
  if (o.instance !== 'sonarr' && o.instance !== 'radarr') return 'Name sonarr or radarr.'
  if (o.downloadId !== undefined && !str(o.downloadId, 220)) return 'Bad download id.'
  if (o.downloadIds !== undefined && !strList(o.downloadIds, 50)) return 'Bad download ids.'
  if (o.known !== undefined && !strList(o.known, 200)) return 'Bad list.'
  if (o.showKey !== undefined && !str(o.showKey, 40)) return 'Bad show.'
  if (o.seasonKey !== undefined && !str(o.seasonKey, 40)) return 'Bad season.'
  if (o.blocklist !== undefined && typeof o.blocklist !== 'boolean') return 'Bad blocklist value.'
  const needsOne = ['find-another', 'remove', 'retry-import', 'prioritise'].includes(o.action as string)
  if (needsOne && o.downloadId === undefined) return 'Name the download.'
  return {
    action: o.action as ActionName, instance: o.instance, downloadId: o.downloadId as string | undefined,
    downloadIds: o.downloadIds as string[] | undefined, blocklist: o.blocklist as boolean | undefined,
    showKey: o.showKey as string | undefined, seasonKey: o.seasonKey as string | undefined, known: o.known as string[] | undefined,
  }
}

/** A plan as the browser sees it: names and counts, never a row id. */
function publicPlan(p: import('../lib/arr-queue/actions').Plan) {
  return {
    action: p.action, instance: p.instance, blocklist: p.blocklist, items: p.items,
    search: p.commands.map(c => c.label), skipped: p.skipped, seasonLabel: p.seasonLabel, prioritise: !!p.qbitHash,
  }
}

export const arrQueueRoutes: FastifyPluginAsync = buildArrQueueRoutes()
