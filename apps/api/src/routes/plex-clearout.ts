// =============================================================================
//  HyperProx — Plex clear-out routes (/api/plugins/plex/clearout)
//
//  Roles (lib/roles.ts):
//    GET  /clearout          viewer: the lists, sizes and keep-rule counts (cached ten minutes; ?refresh=1 re-reads)
//    POST /clearout/preview  operator: exactly what a removal would delete and how big it is; changes nothing
//    POST /clearout/remove   operator, with the master password re-entered within five minutes, which keeps API
//                            tokens out; refused here by name for a token as well
//
//    GET  /live              viewer: now streaming, counts and bandwidth (Plex /status/sessions), for the
//                            page's five-second refresh
//    GET  /art/:id/:kind/:v  viewer: one Plex poster, fetched server-side with the vault token (lib/plex-art.ts)
//
//  Removal goes only through Sonarr or Radarr (the Arr Stack plug-in's connection), with deleteFiles and an
//  import-list exclusion. Every removal writes an audit entry: who, how many, how big, and the titles.
// =============================================================================

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { auditCredentialUse } from '../lib/audit'
import { hasRole } from '../lib/roles'
import { ClearoutRefusal, ClearoutService, type ClearoutDeps } from '../lib/plex-clearout/service'
import { getSettings, pluginEndpointClient, pluginOptions, type CoreEndpointClient } from '../lib/plugin-host'
import { liveFromPlex, plexLiveVisual } from '../plugins/plex'
import { ArtCache, artKey, artUpstream } from '../lib/plex-art'
import { findPlugin } from '../plugins'
import { FileNewStore, startNewWatcher } from '../lib/plex-new'
import { publish } from '../lib/notify'
import { isUnlocked } from '../lib/vault/state'

let shared: ClearoutService | null = null

/** The Plex plug-in's server endpoint (address and vault token), or null when it is not set. */
const plexServer = async (): Promise<CoreEndpointClient | null> => { const p = findPlugin('plex'); return p ? pluginEndpointClient(p, 'default') : null }

/** The production service: Plex through the Plex plug-in's server endpoint, removal through the Arr Stack plug-in. */
export function clearoutService(): ClearoutService {
  if (shared) return shared
  const deps: ClearoutDeps = {
    plex: plexServer,
    sonarr: async () => { const p = findPlugin('arrstack'); return p ? pluginEndpointClient(p, 'default') : null },
    radarr: async () => { const p = findPlugin('arrstack'); return p ? pluginEndpointClient(p, 'radarr') : null },
    option: async key => {
      const p = findPlugin('plex')
      if (!p) return undefined
      return pluginOptions(p.manifest, await getSettings('plex'))[key]
    },
    now: () => Date.now(),
  }
  return (shared = new ClearoutService(deps))
}

function fail(reply: FastifyReply, e: any) {
  if (e instanceof ClearoutRefusal) return reply.status(e.status).send({ success: false, code: e.code, error: e.message })
  return reply.status(502).send({ success: false, code: 'unreachable', error: String(e?.message ?? e).slice(0, 300) })
}

/**
 * Now streaming: from Plex itself (with Tautulli's quality wording when Tautulli is also set), or from Tautulli
 * alone on an install that has not added its Plex server yet.
 */
const readLive = async () => {
  const p = findPlugin('plex')
  if (!p) throw new Error('The Plex plug-in is not installed.')
  const [plex, tautulli] = await Promise.all([pluginEndpointClient(p, 'default'), pluginEndpointClient(p, 'tautulli')])
  if (plex) return liveFromPlex(plex, tautulli)
  if (tautulli) return { ...plexLiveVisual(await tautulli.get('/api/v2?cmd=get_activity', 5000)), needsPlex: true }
  throw new Error('Not configured yet: add your Plex server address and token.')
}

export function buildPlexClearoutRoutes(deps: {
  service?: () => ClearoutService; plex?: () => Promise<CoreEndpointClient | null>; cache?: ArtCache; live?: () => Promise<any>
} = {}): FastifyPluginAsync {
  const svc = deps.service ?? clearoutService
  const live = deps.live ?? readLive
  const plex = deps.plex ?? plexServer
  const cache = deps.cache ?? new ArtCache()
  return async (fastify) => {
    // The page's live part. Like /detail, a device that cannot be reached is 200 with ok:false, so the page can
    // grey its live dot and keep the last reading instead of showing an error.
    fastify.get('/live', async (_req, reply) => {
      try { return { success: true, data: { ok: true, at: Date.now(), ...(await live()) } } }
      catch (e: any) { return reply.send({ success: true, data: { ok: false, error: String(e?.message ?? e).slice(0, 200) } }) }
    })

    // Cover art. The browser names an image by three checked parts; the API rebuilds Plex's own path from them,
    // so no request can choose a host, a scheme or another path. A failure is a bare 404: the page falls back to
    // its title card.
    fastify.get<{ Params: { id: string; kind: string; v: string } }>('/art/:id/:kind/:v', async (req, reply) => {
      const k = artKey(req.params.id, req.params.kind, req.params.v)
      if (!k) return reply.status(400).send({ success: false, code: 'bad_art', error: 'That is not a Plex image.' })
      const key = `${k.id}/${k.kind}/${k.version}`
      let hit = cache.get(key)
      if (!hit) {
        const c = await plex().catch(() => null)
        if (!c) return reply.status(404).send({ success: false, code: 'plex_not_set', error: 'No Plex server is set for cover art.' })
        for (const path of artUpstream(k)) {
          try { const img = await c.image(path, 10_000); cache.set(key, img.contentType, img.body); hit = cache.get(key); break } catch { /* next */ }
        }
        if (!hit) return reply.status(404).send({ success: false, code: 'no_art', error: 'Plex has no image for that.' })
      }
      return reply
        .header('Content-Type', hit.contentType)
        .header('Cache-Control', 'private, max-age=86400')
        .header('X-Content-Type-Options', 'nosniff')
        .send(hit.body)
    })

    fastify.get<{ Querystring: { refresh?: string } }>('/clearout', async (req, reply) => {
      try {
        const { report } = await svc().report(req.query.refresh === '1')
        return { success: true, data: report }
      } catch (e) { return fail(reply, e) }
    })

    fastify.post<{ Body: { ids?: unknown } }>('/clearout/preview', async (req, reply) => {
      // The gate already asked for operator; repeated here so the route stands on its own.
      if (!hasRole(req.session?.role ?? 'viewer', 'operator')) return reply.status(403).send({ success: false, code: 'forbidden', error: 'This needs the operator role.' })
      try {
        return { success: true, data: await svc().preview(req.body?.ids, req.session!.sid) }
      } catch (e) { return fail(reply, e) }
    })

    fastify.post<{ Body: { previewId?: unknown } }>('/clearout/remove', async (req, reply) => {
      if (req.apiToken) return reply.status(403).send({ success: false, code: 'token_forbidden', error: 'An API token cannot remove media.' })
      if (!hasRole(req.session?.role ?? 'viewer', 'operator')) return reply.status(403).send({ success: false, code: 'forbidden', error: 'This needs the operator role.' })
      try {
        const out = await svc().remove(req.body?.previewId, req.session!.sid)
        const removed = out.results.filter(r => r.removed)
        await auditCredentialUse('plex.clearout.remove', 'plugin:arrstack', {
          by: req.session!.email,
          asked: out.preview.items.length,
          removed: removed.length,
          failed: out.results.length - removed.length,
          bytes: removed.reduce((a, r) => a + (r.sizeBytes ?? 0), 0),
          titles: out.results.map(r => `${r.removed ? 'removed' : 'kept'}: ${r.title} (${r.service})`),
        })
        return { success: true, data: out }
      } catch (e) { return fail(reply, e) }
    })
  }
}

export const plexClearoutRoutes = buildPlexClearoutRoutes()
