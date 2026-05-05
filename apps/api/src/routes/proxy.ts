// =============================================================================
//  HyperProx — Proxy API Routes (full CRUD)
// =============================================================================
import { FastifyPluginAsync } from 'fastify'
import { NPMClient }          from '../lib/npm-client'
import { getProviderCredentials } from '../lib/credentials'

async function getNPM(): Promise<NPMClient> {
  const creds = await getProviderCredentials('proxy', 'npm')
  if (!creds?.url || !creds?.email || !creds?.password) {
    throw new Error('NPM_URL, NPM_EMAIL, NPM_PASSWORD must be set')
  }
  return new NPMClient(creds.url, creds.email, creds.password)
}

const wrap = async (reply: any, fn: () => Promise<any>) => {
  try   { return { success: true, data: await fn() } }
  catch (e: any) { return reply.status(500).send({ success: false, error: e.message }) }
}

export const proxyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/stats',        async (_, r) => wrap(r, async () => (await getNPM()).getStats()))
  fastify.get('/hosts',        async (_, r) => wrap(r, async () => (await getNPM()).getProxyHosts()))
  fastify.get('/certificates', async (_, r) => wrap(r, async () => (await getNPM()).getCertificates()))

  fastify.get<{ Params: { id: string } }>('/hosts/:id', async (req, r) =>
    wrap(r, async () => (await getNPM()).getProxyHost(Number(req.params.id))))

  fastify.post<{ Body: any }>('/hosts', async (req, r) =>
    wrap(r, async () => (await getNPM()).createProxyHost(req.body as any)))

  fastify.put<{ Params: { id: string }; Body: any }>('/hosts/:id', async (req, r) =>
    wrap(r, async () => (await getNPM()).updateProxyHost(Number(req.params.id), req.body as any)))

  fastify.delete<{ Params: { id: string } }>('/hosts/:id', async (req, r) =>
    wrap(r, async () => { await (await getNPM()).deleteProxyHost(Number(req.params.id)); return { deleted: true } }))

  fastify.post<{ Params: { id: string } }>('/hosts/:id/enable', async (req, r) =>
    wrap(r, async () => (await getNPM()).enableProxyHost(Number(req.params.id))))

  fastify.post<{ Params: { id: string } }>('/hosts/:id/disable', async (req, r) =>
    wrap(r, async () => (await getNPM()).disableProxyHost(Number(req.params.id))))

  // Certificate creation
  fastify.post<{ Body: any }>('/certificates', async (req, r) =>
    wrap(r, async () => (await getNPM()).requestCertificate(req.body as any)))
}
