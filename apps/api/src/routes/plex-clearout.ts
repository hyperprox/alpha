// =============================================================================
//  HyperProx — Plex clear-out routes (/api/plugins/plex/clearout)
//
//  Roles (lib/roles.ts):
//    GET  /clearout          viewer: the lists, sizes and keep-rule counts (cached ten minutes); ?refresh=1 re-reads,
//                            operator only and at most once a minute
//    POST /clearout/preview  operator: exactly what a removal would delete and how big it is; changes nothing
//    POST /clearout/remove   operator, with the master password re-entered within five minutes, which keeps API
//                            tokens out; refused here by name for a token as well
//
//    GET  /live              viewer: now streaming, counts and bandwidth (Plex /status/sessions), for the
//                            page's five-second refresh; one shared reading every 2.5 s whoever asks
//    GET  /art/:id/:kind/:v  viewer: one Plex poster, fetched server-side with the vault token (lib/plex-art.ts);
//                            at most 4 MB, cached (150 MB at most), 120 cache misses a minute per person
//
//    GET  /library           viewer: every movie and show, with posters, sizes, plays and which way each would go
//    GET  /library/show/:key viewer: one show's seasons and episodes, with plays, quality and who it is next up for
//    POST /library/preview   operator: a show, season, episodes (or one version) or a movie; changes nothing
//    POST /library/remove    operator with the master password re-entered, like /clearout/remove
//
//  Who watched what: every row carries how many accounts watched it (by the history or by Plex's own watched
//  marks, lib/plex-clearout/watchers.ts). Their names (watchedBy) go to operators and up only; a viewer gets the
//  counts. The per-account tokens those marks are read with never leave the API, and are dropped on lock.
//
//  Removal (both) goes through the Arr that manages an item, matched by tvdb or tmdb id, or else through Plex
//  itself (lib/plex-remove/engine.ts). Each item is audited before and after, and read back.
//
//  It also starts the "tell me when something new is added" watcher (lib/plex-new.ts), which does nothing unless
//  the plug-in's notify_new setting is on.
//
// =============================================================================

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { auditCredentialUse, auditOrThrow } from '../lib/audit'
import { hasRole } from '../lib/roles'
import { ClearoutRefusal, ClearoutService, type ClearoutDeps } from '../lib/plex-clearout/service'
import { LibraryService } from '../lib/plex-library/service'
import { getSettings, pluginEndpointClient, pluginOptions, type CoreEndpointClient } from '../lib/plugin-host'
import { liveFromPlex, plexLiveVisual } from '../plugins/plex'
import { ArtCache, MissLimiter, artKey, artUpstream } from '../lib/plex-art'
import { findPlugin } from '../plugins'
import { FileNewStore, startNewWatcher, type NewStore, type NewWatcherDeps } from '../lib/plex-new'
import type { NotifyEventInput } from '../lib/notify/types'
import { publish } from '../lib/notify'
import { isUnlocked, onLock } from '../lib/vault/state'

/** Names of who watched what, or whose next episode it is, are for operators and up: a viewer gets the counts only. */
export function forRole<T extends { watchedBy?: unknown; nextUpFor?: unknown }>(rows: T[], role: string | undefined): T[] {
  if (hasRole((role ?? 'viewer') as any, 'operator')) return rows
  return rows.map(r => { const { watchedBy: _w, nextUpFor: _n, ...rest } = r; return rest as T })
}

let shared: ClearoutService | null = null

/** The Plex plug-in's server endpoint (address and vault token), or null when it is not set. */
const plexServer = async (): Promise<CoreEndpointClient | null> => { const p = findPlugin('plex'); return p ? pluginEndpointClient(p, 'default') : null }

/** The production service: Plex through the Plex plug-in's server endpoint, removal through the Arr Stack plug-in. */
export function clearoutService(): ClearoutService {
  if (shared) return shared
  const deps: ClearoutDeps = {
    plex: plexServer,
    // Strict: "could not read the Arr Stack settings" must never look like "no Arr", which would hand removal to Plex.
    sonarr: async () => { const p = findPlugin('arrstack'); return p ? pluginEndpointClient(p, 'default', { strict: true }) : null },
    radarr: async () => { const p = findPlugin('arrstack'); return p ? pluginEndpointClient(p, 'radarr', { strict: true }) : null },
    option: async key => {
      const p = findPlugin('plex')
      if (!p) return undefined
      return pluginOptions(p.manifest, await getSettings('plex'))[key]
    },
    now: () => Date.now(),
    audit: (action, details) => auditCredentialUse(action, 'plugin:plex', details),
  }
  shared = new ClearoutService(deps)
  // Locked: every Plex account token the watched marks were read with is forgotten.
  onLock(() => shared?.dropWatchers())
  return shared
}

let sharedLibrary: LibraryService | null = null
export const libraryService = (): LibraryService => (sharedLibrary ??= new LibraryService(clearoutService()))

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

/**
 * The new-items watcher's switches. 'wait' while HyperProx is locked or Plex is not set (its place is kept);
 * 'off' when the setting is not "yes" (its place is forgotten, so switching on later is quiet); 'on' otherwise.
 */
export function newWatcherDeps(o: {
  unlocked(): boolean
  settings(): Promise<Record<string, string>>
  plex(): Promise<CoreEndpointClient | null>
  publish(e: NotifyEventInput): Promise<void>
  store: NewStore
  log?(m: string): void
}): NewWatcherDeps {
  return {
    enabled: async () => {
      if (!o.unlocked()) return 'wait'
      if ((await o.settings().catch(() => ({} as Record<string, string>))).notify_new !== 'yes') return 'off'
      return (await o.plex().catch(() => null)) ? 'on' : 'wait'
    },
    recentlyAdded: async () => {
      const c = await o.plex()
      if (!c) throw new Error('Plex is not set.')
      return c.get('/library/recentlyAdded?X-Plex-Container-Start=0&X-Plex-Container-Size=50', 15_000)
    },
    publish: o.publish, store: o.store, log: o.log,
  }
}

export function buildPlexClearoutRoutes(deps: {
  service?: () => ClearoutService; library?: () => LibraryService; plex?: () => Promise<CoreEndpointClient | null>; cache?: ArtCache; live?: () => Promise<any>
  limiter?: MissLimiter
  showLimiter?: MissLimiter
  liveTtlMs?: number
  /** The new-items watcher. Production starts the real one; tests pass their own, or nothing (no watcher). */
  watcher?: { start(d: NewWatcherDeps): () => void; deps: NewWatcherDeps }
} = {}): FastifyPluginAsync {
  const svc = deps.service ?? clearoutService
  const lib = deps.library ?? (deps.service ? (() => { let l: LibraryService | null = null; return () => (l ??= new LibraryService(deps.service!())) })() : libraryService)
  const live = deps.live ?? readLive
  const plex = deps.plex ?? plexServer
  const cache = deps.cache ?? new ArtCache()
  const limiter = deps.limiter ?? new MissLimiter()
  // Opening a show reads Plex and Sonarr: 30 a minute per person.
  const showLimiter = deps.showLimiter ?? new MissLimiter(30)
  const watcher = deps.watcher ?? (deps.service ? null : {
    start: startNewWatcher,
    deps: newWatcherDeps({
      unlocked: isUnlocked, settings: () => getSettings('plex'), plex: plexServer,
      publish: e => publish(e), store: new FileNewStore(),
    }),
  })
  // One reading of now streaming, shared by every open page, at most every 2.5 seconds.
  let liveMemo: { at: number; p: Promise<any> } | null = null
  const liveShared = () => {
    const now = Date.now()
    if (!liveMemo || now - liveMemo.at > (deps.liveTtlMs ?? 2500)) {
      const p = live()
      liveMemo = { at: now, p }
      p.catch(() => { if (liveMemo?.p === p) liveMemo = null })
    }
    return liveMemo.p
  }
  return async (fastify) => {
    if (watcher) {
      const stop = watcher.start({ ...watcher.deps, log: watcher.deps.log ?? (m => fastify.log.info(m)) })
      fastify.addHook('onClose', async () => stop())
    }

    // The page's live part. Like /detail, a device that cannot be reached is 200 with ok:false, so the page can
    // grey its live dot and keep the last reading instead of showing an error.
    fastify.get('/live', async (_req, reply) => {
      try { return { success: true, data: { ok: true, at: Date.now(), ...(await liveShared()) } } }
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
        // Each miss is a fetch from Plex: limited per person, so a page cannot be used to hammer it.
        if (!limiter.allow(req.session?.sid ?? 'anonymous')) return reply.status(429).send({ success: false, code: 'slow_down', error: 'Too many new images at once. Try again in a minute.' })
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
        const refresh = req.query.refresh === '1'
        // A forced re-read walks the whole library and history: operator and up, and at most once a minute.
        if (refresh && !hasRole(req.session?.role ?? 'viewer', 'operator')) return reply.status(403).send({ success: false, code: 'forbidden', error: 'Reading again needs the operator role.' })
        const { report } = await svc().report(refresh)
        return { success: true, data: { ...report, rows: forRole(report.rows, req.session?.role) } }
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
        const out = await svc().remove(req.body?.previewId, req.session!.sid, req.session!.email)
        return { success: true, data: { ...out, ...(await summary('plex.clearout.remove', req.session!.email, out)) } }
      } catch (e) { return fail(reply, e) }
    })

    fastify.get('/library', async (req, reply) => {
      try { const d = await lib().list(); return { success: true, data: { ...d, rows: forRole(d.rows, req.session?.role) } } } catch (e) { return fail(reply, e) }
    })
    fastify.get<{ Params: { key: string } }>('/library/show/:key', async (req, reply) => {
      if (!showLimiter.allow(req.session?.sid ?? 'anonymous')) return reply.status(429).send({ success: false, code: 'slow_down', error: 'Too many shows opened at once. Try again in a minute.' })
      try {
        const d = await lib().show(req.params.key)
        return { success: true, data: { ...d, seasons: d.seasons.map(se => ({ ...se, episodes: forRole(se.episodes, req.session?.role) })) } }
      } catch (e) { return fail(reply, e) }
    })
    fastify.post<{ Body: Record<string, unknown> }>('/library/preview', async (req, reply) => {
      if (!hasRole(req.session?.role ?? 'viewer', 'operator')) return reply.status(403).send({ success: false, code: 'forbidden', error: 'This needs the operator role.' })
      try { return { success: true, data: await lib().preview(req.body ?? {}, req.session!.sid) } } catch (e) { return fail(reply, e) }
    })
    fastify.post<{ Body: { previewId?: unknown } }>('/library/remove', async (req, reply) => {
      if (req.apiToken) return reply.status(403).send({ success: false, code: 'token_forbidden', error: 'An API token cannot remove media.' })
      if (!hasRole(req.session?.role ?? 'viewer', 'operator')) return reply.status(403).send({ success: false, code: 'forbidden', error: 'This needs the operator role.' })
      try {
        const out = await lib().remove(req.body?.previewId, req.session!.sid, req.session!.email)
        return { success: true, data: { ...out, ...(await summary('plex.library.remove', req.session!.email, out)) } }
      } catch (e) { return fail(reply, e) }
    })
  }
}

/** One summary row per removal, besides the per-item rows the engine writes before and after each delete. */
async function summary(action: string, by: string, out: { preview: { items: unknown[] }; results: Array<{ removed: boolean; title: string; via: string; sizeBytes: number }> }): Promise<{ note?: string }> {
  const removed = out.results.filter(r => r.removed)
  // The per-item rows were already written; a failed summary must not hide the results from the person.
  try { await writeSummary(action, by, out, removed) } catch { return { note: 'The summary row could not be written to the audit log. Each item was logged on its own.' } }
  return {}
}
async function writeSummary(action: string, by: string, out: { preview: { items: unknown[] }; results: Array<{ removed: boolean; title: string; via: string; sizeBytes: number }> }, removed: typeof out.results) {
  await auditOrThrow(action, 'plugin:plex', {
    by, asked: out.preview.items.length, removed: removed.length, failed: out.results.length - removed.length,
    bytes: removed.reduce((a, r) => a + (r.sizeBytes ?? 0), 0),
    titles: out.results.map(r => `${r.removed ? 'removed' : 'kept'}: ${r.title} (${r.via})`),
  })
}

export const plexClearoutRoutes = buildPlexClearoutRoutes()
