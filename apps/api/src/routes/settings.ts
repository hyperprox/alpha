// =============================================================================
//  HyperProx — Settings API Routes
// =============================================================================

import { FastifyPluginAsync } from 'fastify'
import {
  getCategoryForUI,
  setCredential,
  getProviderCredentials,
  CREDENTIAL_DEFS,
} from '../lib/credentials'

const wrap = async (reply: any, fn: () => Promise<any>) => {
  try   { return { success: true, data: await fn() } }
  catch (e: any) { return reply.status(500).send({ success: false, error: e.message }) }
}

export const settingsRoutes: FastifyPluginAsync = async (fastify) => {

  // GET /api/settings/:category — all credentials for a category (masked)
  fastify.get<{ Params: { category: string } }>('/:category', async (req, r) =>
    wrap(r, () => getCategoryForUI(req.params.category)))

  // GET /api/settings/providers — list all categories + providers
  fastify.get('/providers', async (_, r) => {
    const categories = [...new Set(CREDENTIAL_DEFS.map(d => d.category))]
    const result = categories.map(cat => ({
      category: cat,
      providers: [...new Set(
        CREDENTIAL_DEFS.filter(d => d.category === cat).map(d => d.provider)
      )],
    }))
    return { success: true, data: result }
  })

  // PUT /api/settings/:category/:provider — update credentials for a provider
  fastify.put<{
    Params: { category: string; provider: string }
    Body:   Record<string, string>
  }>('/:category/:provider', async (req, r) => {
    const { category, provider } = req.params
    const updates = req.body

    await Promise.all(
      Object.entries(updates).map(([key, value]) => {
        const def = CREDENTIAL_DEFS.find(d => d.category === category && d.provider === provider && d.key === key)
        if (!def) return Promise.resolve()
        return setCredential(category, provider, key, value, def.masked)
      })
    )

    return { success: true, data: { updated: Object.keys(updates).length } }
  })

  // POST /api/settings/test/:category/:provider — test a connection
  fastify.post<{ Params: { category: string; provider: string } }>(
    '/test/:category/:provider', async (req, r) => {
      const { category, provider } = req.params

      try {
        const creds = await getProviderCredentials(category, provider)

        if (category === 'proxmox') {
          const { ProxmoxClient } = await import('../lib/proxmox-client')
          const client = new ProxmoxClient(
            creds.host, Number(creds.port ?? 8006),
            `${creds.user ?? 'root@pam'}!${creds.token_id}`,
            creds.token_secret,
          )
          const result = await client.ping()
          return { success: result.ok, data: result }
        }

        if (category === 'proxy' && provider === 'npm') {
          const { NPMClient } = await import('../lib/npm-client')
          const client = new NPMClient(creds.url, creds.email, creds.password)
          const stats = await client.getStats()
          return { success: true, data: { message: `Connected — ${stats.total} proxy hosts`, stats } }
        }

        if (category === 'dns' && provider === 'godaddy') {
          const { GoDaddyClient } = await import('../lib/godaddy-client')
          const client  = new GoDaddyClient(creds.api_key, creds.api_secret)
          const domains = await client.getDomains()
          return { success: true, data: { message: `Connected — ${domains.length} active domains`, domains: domains.map(d => d.domain) } }
        }

        return { success: false, error: `No test available for ${category}/${provider}` }
      } catch (e: any) {
        return r.status(400).send({ success: false, error: e.message })
      }
    }
  )
}
