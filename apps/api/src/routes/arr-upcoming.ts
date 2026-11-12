// =============================================================================
//  HyperProx — Arr Stack "Upcoming" routes (/api/plugins/arrstack)
//
//  Roles (lib/roles.ts): both are GETs, so viewer, like the Arr Stack page itself.
//    GET /upcoming?days=7|14|30|60&tz=<IANA zone>
//                  what Sonarr, Radarr and (when set up) Lidarr expect to grab soon, grouped by day in the caller's zone, plus the
//                  "Missing, searching" strip. Read-only. One shared reading per range for 45 s.
//    GET /art/:app/:id
//                  one poster, fetched server-side with the stored key (lib/arr-upcoming/art.ts): two checked
//                  parts in, a fixed upstream path out; at most 4 MB, cached, 120 cache misses a minute per person.
//
//  Sonarr and Radarr are separate: one being down greys its own half and the other still shows.
// =============================================================================

import type { FastifyPluginAsync } from 'fastify'
import { findPlugin } from '../plugins'
import { pluginEndpointClient, type CoreEndpointClient } from '../lib/plugin-host'
import { ArtCache, MissLimiter } from '../lib/plex-art'
import { arrArtKey, arrArtUpstream } from '../lib/arr-upcoming/art'
import {
  addDays, dayKey, filmItems, groupItems, lidarrMissing, musicItems, queueIndex, radarrMissing, sonarrMissing, tonightCount, tvItems, validZone,
  type MissingStrip, type UpcomingGroup, type UpcomingItem,
} from '../lib/arr-upcoming/logic'

export const RANGES = [7, 14, 30, 60] as const
export const rangeDays = (v: unknown): number => { const n = Number(v); return (RANGES as readonly number[]).includes(n) ? n : 14 }

const arrClient = async (endpoint: 'default' | 'radarr' | 'lidarr'): Promise<CoreEndpointClient | null> => {
  const p = findPlugin('arrstack')
  return p ? pluginEndpointClient(p, endpoint).catch(() => null) : null
}

export interface ServiceState { ok: boolean; error?: string }
export interface UpcomingData {
  at: number; tz: string; days: number
  /** `lidarr` is present only when Lidarr is set up: without it nothing here mentions music. */
  services: { sonarr: ServiceState; radarr: ServiceState; lidarr?: ServiceState }
  groups: UpcomingGroup[]
  counts: { tv: number; film: number; tonight: number; downloading: number; music?: number }
  missing: { sonarr: MissingStrip | null; radarr: MissingStrip | null; lidarr?: MissingStrip | null }
}

const msg = (e: any) => String(e?.message ?? e).slice(0, 160)

export async function readUpcoming(deps: { sonarr: CoreEndpointClient | null; radarr: CoreEndpointClient | null; lidarr?: CoreEndpointClient | null; now: number; tz: string; days: number }): Promise<UpcomingData> {
  const { now, tz, days } = deps
  const today = dayKey(now, tz)
  const end = addDays(today, days)
  const services = { sonarr: { ok: false } as ServiceState, radarr: { ok: false } as ServiceState }
  const missing: UpcomingData['missing'] = { sonarr: null, radarr: null }
  const items: UpcomingItem[] = []
  const lidarrState: ServiceState | null = deps.lidarr ? { ok: false } : null

  await Promise.all([
    (async () => {
      if (!deps.sonarr) { services.sonarr.error = 'Sonarr is not set up.'; return }
      try {
        const [cal, queue, wanted] = await Promise.all([
          deps.sonarr.get(`/api/v3/calendar?start=${today}&end=${end}&includeSeries=true&unmonitored=false`, 15_000),
          deps.sonarr.get('/api/v3/queue?pageSize=200&includeUnknownSeriesItems=true', 15_000).catch(() => null),
          deps.sonarr.get('/api/v3/wanted/missing?page=1&pageSize=10&sortKey=airDateUtc&sortDirection=descending&monitored=true&includeSeries=true', 15_000).catch(() => null),
        ])
        items.push(...tvItems(cal, queueIndex(queue?.records, 'episodeId'), now, tz))
        missing.sonarr = wanted ? sonarrMissing(wanted, now, tz) : null
        services.sonarr.ok = true
      } catch (e) { services.sonarr.error = msg(e) }
    })(),
    (async () => {
      if (!deps.radarr) { services.radarr.error = 'Radarr is not set up.'; return }
      try {
        const [cal, queue, wanted] = await Promise.all([
          deps.radarr.get(`/api/v3/calendar?start=${today}&end=${end}&unmonitored=false`, 15_000),
          deps.radarr.get('/api/v3/queue?pageSize=200&includeUnknownMovieItems=true', 15_000).catch(() => null),
          deps.radarr.get('/api/v3/wanted/missing?page=1&pageSize=250&monitored=true&sortKey=movieMetadata.digitalRelease&sortDirection=descending', 15_000).catch(() => null),
        ])
        items.push(...filmItems(cal, queueIndex(queue?.records, 'movieId'), now, tz, end))
        missing.radarr = wanted ? radarrMissing(wanted) : null
        services.radarr.ok = true
      } catch (e) { services.radarr.error = msg(e) }
    })(),
    (async () => {
      if (!deps.lidarr || !lidarrState) return
      try {
        const [cal, queue, wanted] = await Promise.all([
          deps.lidarr.get(`/api/v1/calendar?start=${today}&end=${end}&unmonitored=false&includeArtist=true`, 15_000),
          deps.lidarr.get('/api/v1/queue?pageSize=200&includeUnknownArtistItems=true', 15_000).catch(() => null),
          deps.lidarr.get('/api/v1/wanted/missing?page=1&pageSize=50&sortKey=releaseDate&sortDirection=descending&monitored=true&includeArtist=true', 15_000).catch(() => null),
        ])
        items.push(...musicItems(cal, queueIndex(queue?.records, 'albumId'), now, tz, end))
        missing.lidarr = wanted ? lidarrMissing(wanted, now, tz) : null
        lidarrState.ok = true
      } catch (e) { lidarrState.error = msg(e) }
    })(),
  ])

  return {
    at: now, tz, days, services: lidarrState ? { ...services, lidarr: lidarrState } : services, missing,
    groups: groupItems(items, now, tz),
    counts: {
      tv: items.filter(i => i.kind === 'tv').length, film: items.filter(i => i.kind === 'film').length,
      tonight: tonightCount(items, now, tz), downloading: items.filter(i => i.status === 'downloading').length,
      ...(lidarrState ? { music: items.filter(i => i.kind === 'music').length } : {}),
    },
  }
}

export function buildArrUpcomingRoutes(deps: {
  sonarr?: () => Promise<CoreEndpointClient | null>; radarr?: () => Promise<CoreEndpointClient | null>; lidarr?: () => Promise<CoreEndpointClient | null>
  cache?: ArtCache; limiter?: MissLimiter; now?: () => number; ttlMs?: number
} = {}): FastifyPluginAsync {
  const sonarr = deps.sonarr ?? (() => arrClient('default'))
  const radarr = deps.radarr ?? (() => arrClient('radarr'))
  const lidarr = deps.lidarr ?? (() => arrClient('lidarr'))
  const now = deps.now ?? Date.now
  const cache = deps.cache ?? new ArtCache()
  const limiter = deps.limiter ?? new MissLimiter()
  const ttl = deps.ttlMs ?? 45_000
  // One reading per (zone, range), shared by everyone, so a few open pages cost Sonarr and Radarr one read a minute.
  const memo = new Map<string, { at: number; p: Promise<UpcomingData> }>()

  return async (fastify) => {
    fastify.get<{ Querystring: { days?: string; tz?: string } }>('/upcoming', async (req, reply) => {
      const tz = validZone(req.query.tz), days = rangeDays(req.query.days)
      const key = `${tz}|${days}`, t = now()
      let m = memo.get(key)
      if (!m || t - m.at > ttl) {
        const p = (async () => readUpcoming({ sonarr: await sonarr().catch(() => null), radarr: await radarr().catch(() => null), lidarr: await lidarr().catch(() => null), now: t, tz, days }))()
        m = { at: t, p }
        memo.set(key, m)
        if (memo.size > 40) memo.delete(memo.keys().next().value as string)
        p.catch(() => memo.delete(key))
      }
      try { return { success: true, data: await m.p } } catch (e) {
        return reply.status(502).send({ success: false, code: 'upcoming_failed', error: msg(e) })
      }
    })

    // A failure is a bare 404: the page falls back to its title card.
    fastify.get<{ Params: { app: string; id: string } }>('/art/:app/:id', async (req, reply) => {
      const k = arrArtKey(req.params.app, req.params.id)
      if (!k) return reply.status(400).send({ success: false, code: 'bad_art', error: 'That is not a poster.' })
      const key = `${k.app}/${k.id}`
      let hit = cache.get(key)
      if (!hit) {
        if (!limiter.allow(req.session?.sid ?? 'anonymous')) return reply.status(429).send({ success: false, code: 'slow_down', error: 'Too many new images at once. Try again in a minute.' })
        const c = await (k.app === 'sonarr' ? sonarr() : k.app === 'lidarr' ? lidarr() : radarr()).catch(() => null)
        if (!c) return reply.status(404).send({ success: false, code: 'arr_not_set', error: `${k.app === 'sonarr' ? 'Sonarr' : k.app === 'lidarr' ? 'Lidarr' : 'Radarr'} is not set up.` })
        for (const path of arrArtUpstream(k)) {
          try { const img = await c.image(path, 10_000); cache.set(key, img.contentType, img.body); hit = cache.get(key); break } catch { /* next */ }
        }
        if (!hit) return reply.status(404).send({ success: false, code: 'no_art', error: 'No poster for that.' })
      }
      return reply
        .header('Content-Type', hit.contentType)
        .header('Cache-Control', 'private, max-age=86400')
        .header('X-Content-Type-Options', 'nosniff')
        .send(hit.body)
    })
  }
}

export const arrUpcomingRoutes: FastifyPluginAsync = buildArrUpcomingRoutes()
