// =============================================================================
//  HyperProx — Plug-in routes
// =============================================================================

import { FastifyPluginAsync } from 'fastify'
import { PLUGINS, findPlugin } from '../plugins'
import { PLUGIN_IDEAS, repoSlug } from '../lib/plugin-wishlist'
import { ProxmoxClient }        from '../lib/proxmox-client'
import { discoverServices }     from '../lib/discovery'
import {
  describeSettings, getSettings, missingSettings, runPlugin, runPluginDetail,
  runPluginMetrics, renderExposition, saveSettings, runPluginSearch, runPluginGrab,
  type PluginMetric,
  runPluginRescueScan, runPluginRescueRun,
} from '../lib/plugin-host'

export const pluginRoutes: FastifyPluginAsync = async (fastify) => {

  // Prometheus scrape target. Sits outside the session cookie because a scraper
  // has no session — it authenticates with METRICS_TOKEN as a bearer token, set
  // in .env. With no token configured the endpoint refuses rather than exposing
  // device names and viewing habits to anything that can reach the port.
  fastify.get('/metrics', async (req, reply) => {
    const expected = process.env.METRICS_TOKEN
    if (!expected) {
      return reply.status(503).type('text/plain')
        .send('# METRICS_TOKEN is not set in .env, so this endpoint is disabled.\n')
    }
    const offered = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    if (offered !== expected) return reply.status(401).type('text/plain').send('# unauthorised\n')

    const samples: Array<{ plugin: string; metric: PluginMetric }> = []
    const up: Record<string, boolean> = {}

    // One failing plug-in must not blank the whole scrape — it reports up=0 and
    // the others still publish.
    await Promise.all(PLUGINS.map(async p => {
      if (!p.metrics) return
      try {
        const rows = await runPluginMetrics(p)
        rows.forEach(metric => samples.push({ plugin: p.manifest.id, metric }))
        up[p.manifest.id] = true
      } catch {
        up[p.manifest.id] = false
      }
    }))

    return reply.type('text/plain; version=0.0.4').send(renderExposition(samples, up))
  })


  // Gallery listing. Never returns a secret — only whether one is stored.
  fastify.get('/', async (_req, reply) => {
    try {
      const rows = await Promise.all(PLUGINS.map(async p => {
        const stored  = await getSettings(p.manifest.id)
        const missing = missingSettings(p.manifest, stored)
        return {
          ...p.manifest,
          hasDetail:  typeof p.detail === 'function',
          hasSearch:  typeof p.search === 'function',
          settings:   await describeSettings(p.manifest),
          configured: missing.length === 0,
          missing,
        }
      }))
      return { success: true, data: rows }
    } catch (e: any) {
      return reply.status(500).send({ success: false, error: e.message })
    }
  })

  // Find services already running on the cluster. Read-only: every probe is an
  // unauthenticated GET against a port a known service answers on, and nothing
  // is written until the user applies a finding.
  fastify.get('/discover', async (_req, reply) => {
    try {
      const pve = new ProxmoxClient(
        process.env.PROXMOX_HOST!,
        Number(process.env.PROXMOX_PORT ?? 8006),
        `${process.env.PROXMOX_USER}!${process.env.PROXMOX_TOKEN_ID}`,
        process.env.PROXMOX_TOKEN_SECRET!,
      )
      const findings = await discoverServices(pve)
      fastify.log.info({ found: findings.length }, '[plugin] discovery scan')
      return { success: true, data: findings }
    } catch (e: any) {
      return reply.status(500).send({ success: false, error: e.message })
    }
  })

  /**
   * GET /wishlist — plug-ins that do not exist yet, and how to ask for one.
   *
   * Served rather than hard-coded in the page so the list has one home. A
   * catalogue kept in the README is a catalogue that drifts, which is exactly
   * how two shipped plug-ins ended up missing from it.
   */
  /**
   * GET /:id/stuck — downloads that are complete and cannot be filed.
   *
   * A preview, not an action: it reports how many files could be mapped and
   * names the ones that could not, so the decision is informed before anything
   * touches the library.
   */
  fastify.get<{ Params: { id: string } }>('/:id/stuck', async (req, reply) => {
    const plugin = findPlugin(req.params.id)
    if (!plugin) return reply.status(404).send({ success: false, error: 'No such plug-in' })
    if (!plugin.rescueScan) return reply.send({ success: true, data: [] })
    try {
      return reply.send({ success: true, data: await runPluginRescueScan(plugin) })
    } catch (e: any) {
      return reply.status(502).send({ success: false, error: e.message })
    }
  })

  /** POST /:id/stuck/:downloadId — map by filename and import. */
  fastify.post<{ Params: { id: string; downloadId: string } }>(
    '/:id/stuck/:downloadId', async (req, reply) => {
      const plugin = findPlugin(req.params.id)
      if (!plugin) return reply.status(404).send({ success: false, error: 'No such plug-in' })
      try {
        const message = await runPluginRescueRun(plugin, req.params.downloadId)
        fastify.log.info({ plugin: plugin.manifest.id, downloadId: req.params.downloadId },
                         '[plugin] rescued a blocked import')
        return reply.send({ success: true, data: { message } })
      } catch (e: any) {
        return reply.status(400).send({ success: false, error: e.message })
      }
    })

  fastify.get('/wishlist', async (_req, reply) => {
    const built = new Set(PLUGINS.map(p => p.manifest.name.toLowerCase()))
    return reply.send({
      success: true,
      data: {
        repo:  repoSlug(),
        ideas: PLUGIN_IDEAS.filter(i => !built.has(i.name.toLowerCase())),
        built: PLUGINS.map(p => ({
          id: p.manifest.id, name: p.manifest.name,
          description: p.manifest.description, icon: p.manifest.icon,
        })),
      },
    })
  })

  fastify.put<{ Params: { id: string }; Body: Record<string, string> }>(
    '/:id/settings',
    async (req, reply) => {
      const plugin = findPlugin(req.params.id)
      if (!plugin) return reply.status(404).send({ success: false, error: 'No such plug-in' })
      try {
        await saveSettings(plugin.manifest, req.body ?? {})
        fastify.log.info({ plugin: plugin.manifest.id }, '[plugin] settings saved')
        return { success: true }
      } catch (e: any) {
        return reply.status(500).send({ success: false, error: e.message })
      }
    },
  )

  // Live data for a card or a tile. A plug-in that cannot reach its device is a
  // normal state, not a server fault — 200 with ok:false, so the card can show
  // the reason instead of the page showing an error.
  // Free-text search across every indexer a plug-in can reach. Read-only.
  fastify.get<{ Params: { id: string }; Querystring: { q?: string } }>(
    '/:id/search',
    async (req, reply) => {
      const plugin = findPlugin(req.params.id)
      if (!plugin) return reply.status(404).send({ success: false, error: 'No such plug-in' })
      const q = (req.query.q ?? '').trim()
      if (!q) return { success: true, data: [] }
      try {
        const results = await runPluginSearch(plugin, q)
        fastify.log.info({ plugin: plugin.manifest.id, q, results: results.length }, '[plugin] search')
        return { success: true, data: results }
      } catch (e: any) {
        return reply.status(500).send({ success: false, error: e.message })
      }
    },
  )

  // Sending a release to a download client is the one write in this file, so it
  // is a POST, it names what it grabbed in the log, and it never happens as a
  // side effect of searching.
  fastify.post<{ Params: { id: string }; Body: { guid: string; indexerId: number; title?: string } }>(
    '/:id/grab',
    async (req, reply) => {
      const plugin = findPlugin(req.params.id)
      if (!plugin) return reply.status(404).send({ success: false, error: 'No such plug-in' })
      const { guid, indexerId, title } = req.body ?? ({} as any)
      if (!guid) return reply.status(400).send({ success: false, error: 'No release given' })
      try {
        const message = await runPluginGrab(plugin, guid, Number(indexerId))
        fastify.log.info({ plugin: plugin.manifest.id, title }, '[plugin] grab')
        return { success: true, data: { message } }
      } catch (e: any) {
        return reply.status(500).send({ success: false, error: e.message })
      }
    },
  )

  fastify.get<{ Params: { id: string } }>('/:id/detail', async (req, reply) => {
    const plugin = findPlugin(req.params.id)
    if (!plugin) return reply.status(404).send({ success: false, error: 'No such plug-in' })
    try {
      return { success: true, data: { ok: true, ...(await runPluginDetail(plugin)) } }
    } catch (e: any) {
      return { success: true, data: { ok: false, error: e.message } }
    }
  })

  fastify.get<{ Params: { id: string } }>('/:id/data', async (req, reply) => {
    const plugin = findPlugin(req.params.id)
    if (!plugin) return reply.status(404).send({ success: false, error: 'No such plug-in' })
    try {
      return { success: true, data: { ok: true, ...(await runPlugin(plugin)) } }
    } catch (e: any) {
      return { success: true, data: { ok: false, error: e.message } }
    }
  })
}
