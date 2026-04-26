// =============================================================================
//  HyperProx — DNS Routes (GoDaddy)
// =============================================================================

import { FastifyPluginAsync } from 'fastify'
import { GoDaddyClient, DNSRecordType } from '../lib/godaddy-client'
import { getProviderCredentials }        from '../lib/credentials'

async function getGoDaddy(): Promise<GoDaddyClient> {
  const creds = await getProviderCredentials('dns', 'godaddy')
  if (!creds.api_key || !creds.api_secret) {
    throw new Error('GoDaddy API key and secret not configured. Go to Settings → DNS.')
  }
  return new GoDaddyClient(creds.api_key, creds.api_secret)
}

const wrap = async (reply: any, fn: () => Promise<any>) => {
  try   { return { success: true, data: await fn() } }
  catch (e: any) { return reply.status(500).send({ success: false, error: e.message }) }
}

export const dnsRoutes: FastifyPluginAsync = async (fastify) => {

  // GET /api/dns/domains
  fastify.get('/domains', async (_, r) =>
    wrap(r, async () => (await getGoDaddy()).getDomains()))

  // GET /api/dns/domains/:domain
  fastify.get<{ Params: { domain: string } }>('/domains/:domain', async (req, r) =>
    wrap(r, async () => (await getGoDaddy()).getDomain(req.params.domain)))

  // GET /api/dns/domains/:domain/records
  fastify.get<{ Params: { domain: string }; Querystring: { type?: string } }>(
    '/domains/:domain/records', async (req, r) =>
      wrap(r, async () => (await getGoDaddy()).getRecords(
        req.params.domain,
        req.query.type as DNSRecordType | undefined
      ))
  )

  // POST /api/dns/domains/:domain/records
  fastify.post<{ Params: { domain: string }; Body: any }>(
    '/domains/:domain/records', async (req, r) =>
      wrap(r, async () => (await getGoDaddy()).createRecord(req.params.domain, req.body as any))
  )

  // PUT /api/dns/domains/:domain/records/:type/:name
  fastify.put<{ Params: { domain: string; type: string; name: string }; Body: any }>(
    '/domains/:domain/records/:type/:name', async (req, r) =>
      wrap(r, async () => (await getGoDaddy()).updateRecord(
        req.params.domain,
        req.params.type as DNSRecordType,
        req.params.name,
        req.body as any
      ))
  )

  // DELETE /api/dns/domains/:domain/records/:type/:name
  fastify.delete<{ Params: { domain: string; type: string; name: string } }>(
    '/domains/:domain/records/:type/:name', async (req, r) =>
      wrap(r, async () => (await getGoDaddy()).deleteRecord(
        req.params.domain,
        req.params.type as DNSRecordType,
        req.params.name
      ))
  )

  // GET /api/dns/wan
  fastify.get('/wan', async (_, r) =>
    wrap(r, () => GoDaddyClient.getWanIP()))

  // POST /api/dns/domains/:domain/ddns
  fastify.post<{ Params: { domain: string }; Body: { exclude?: string[] } }>(
    '/domains/:domain/ddns', async (req, r) =>
      wrap(r, async () => (await getGoDaddy()).updateDDNS(
        req.params.domain,
        req.body?.exclude ?? []
      ))
  )

  // GET /api/dns/domains/:domain/stats
  fastify.get<{ Params: { domain: string } }>('/domains/:domain/stats', async (req, r) =>
    wrap(r, async () => (await getGoDaddy()).getStats(req.params.domain)))
}
