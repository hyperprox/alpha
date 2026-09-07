// =============================================================================
//  HyperProx — Plug-in routes
// =============================================================================

import { FastifyPluginAsync } from 'fastify'
import { PLUGINS, findPlugin } from '../plugins'
import { describeSettings, getSettings, missingSettings, runPlugin, saveSettings } from '../lib/plugin-host'

export const pluginRoutes: FastifyPluginAsync = async (fastify) => {

  // Gallery listing. Never returns a secret — only whether one is stored.
  fastify.get('/', async (_req, reply) => {
    try {
      const rows = await Promise.all(PLUGINS.map(async p => {
        const stored  = await getSettings(p.manifest.id)
        const missing = missingSettings(p.manifest, stored)
        return {
          ...p.manifest,
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
