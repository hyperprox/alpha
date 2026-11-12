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

/**
 * Where each provider's stored secret is sent, and which secret that is. Moving the address must not carry the
 * secret along to the new place: the same rule as a plug-in's settings (lib/plugin-host.ts settingsChangeProblem).
 */
const SECRET_DESTINATIONS: Record<string, { address: string[]; secrets: string[]; name: string }> = {
  'proxmox/proxmox': { address: ['host', 'port'],   secrets: ['token_secret'], name: 'Proxmox' },
  'proxy/npm':       { address: ['url'],            secrets: ['password'],     name: 'Nginx Proxy Manager' },
  'ai/openai':       { address: ['base_url'],       secrets: ['api_key'],      name: 'OpenAI' },
  'remote/netbird':  { address: ['management_url'], secrets: ['api_token'],    name: 'NetBird' },
}

/** Compare addresses the way a request sees them: a URL by its origin, anything else as typed (trimmed, any case). */
function sameAddress(a: string, b: string): boolean {
  const norm = (v: string) => {
    const t = v.trim()
    try { if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return new URL(t).origin.toLowerCase() } catch { /* as typed */ }
    return t.toLowerCase()
  }
  return norm(a) === norm(b)
}

/**
 * Null when the save may go ahead; otherwise why not. An address that changes from a stored one needs the secret
 * it is paired with in the same save, so a changed address never inherits the old secret. A first address (none
 * stored) needs nothing: there is no secret yet to send anywhere.
 */
export function settingsSaveProblem(category: string, provider: string, stored: Record<string, string>, updates: Record<string, unknown>): string | null {
  const d = SECRET_DESTINATIONS[`${category}/${provider}`]
  if (!d) return null
  const moved = d.address.some(k => {
    const next = updates[k]
    const prev = stored[k]
    return typeof next === 'string' && !!prev && !sameAddress(next, prev)
  })
  if (!moved) return null
  const missing = d.secrets.filter(k => typeof updates[k] !== 'string' || !(updates[k] as string).trim())
  if (!missing.length) return null
  const labels = missing.map(k => CREDENTIAL_DEFS.find(x => x.category === category && x.provider === provider && x.key === k)?.label ?? k)
  return `${d.name}'s address now points somewhere else, so enter the ${labels.join(' and ')} again in the same save.`
}

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
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return r.status(400).send({ success: false, error: 'Send the settings as an object of field: value' })
    }
    if (Object.values(updates).some(v => typeof v !== 'string')) {
      return r.status(400).send({ success: false, error: 'Every setting must be text' })
    }
    // What is stored now, the .env copy included for a value not moved into the vault yet.
    const stored = await getProviderCredentials(category, provider)
    for (const d of CREDENTIAL_DEFS) {
      if (d.category === category && d.provider === provider && d.envKey && !stored[d.key] && process.env[d.envKey]) stored[d.key] = process.env[d.envKey]!
    }
    const problem = settingsSaveProblem(category, provider, stored, updates)
    if (problem) return r.status(400).send({ success: false, code: 'secret_required', error: problem })

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

        if (category === 'dns' && provider === 'cloudflare') {
          const { cloudflareFrom } = await import('../lib/dns-providers')
          const { testCloudflare } = await import('../lib/cloudflare-client')
          const client = cloudflareFrom(creds)
          if (!client) return r.status(400).send({ success: false, error: 'No Cloudflare API token is saved yet. Paste one and press Save first.' })
          const t = await testCloudflare(client)
          return { success: true, data: { message: t.message, details: t.details, domains: t.zones, permissions: t.permissions } }
        }

        if (category === 'remote') {
          const { testProvider } = await import('../lib/remote/providers')
          return { success: true, data: { message: await testProvider(provider) } }
        }

        return { success: false, error: `No test available for ${category}/${provider}` }
      } catch (e: any) {
        return r.status(400).send({ success: false, error: e.message })
      }
    }
  )
}
