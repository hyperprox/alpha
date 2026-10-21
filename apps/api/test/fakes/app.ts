// Test app: the real gate, auth and secrets routes, plus stand-ins for a few data
// routes whose paths match the real ones (the role matrix keys on paths).

import Fastify, { type FastifyInstance } from 'fastify'
import { registerGate } from '../../src/lib/gate'
import { authRoutes } from '../../src/routes/auth'
import { secretsRoutes } from '../../src/routes/secrets'
import { healthRoute } from '../../src/routes/health'
import { setBroker } from '../../src/lib/vault/broker'
import { lock, isUnlocked } from '../../src/lib/vault/state'
import { getCredential, setCredential } from '../../src/lib/credentials'
import { setCredentialTable } from '../../src/lib/credentials'
import { FakeBroker, GOOD_CODE } from './fake-broker'

export { GOOD_CODE }

export async function buildTestApp(broker: FakeBroker): Promise<FastifyInstance> {
  setBroker(broker)
  // No Postgres in these tests: the migration sees an empty old store.
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'

  const app = Fastify({ logger: false })
  await registerGate(app)
  await app.register(authRoutes,    { prefix: '/api/auth' })
  await app.register(secretsRoutes, { prefix: '/api/secrets' })
  await app.register(healthRoute,   { prefix: '/health' })

  await app.register(async (f) => {
    f.get('/resources', async () => ({ success: true, data: [] }))
    f.post('/vms/:node/:vmid/:type/:action', async (req: any) => ({ success: true, data: req.params }))
    f.delete('/nodes/:node/:type/:vmid', async (req: any) => ({ success: true, destroyed: req.params.vmid }))
  }, { prefix: '/api/proxmox' })

  await app.register(async (f) => {
    // Reads and writes through the credential store, as the real settings routes do.
    f.get('/probe', async () => ({ value: await getCredential('dns', 'godaddy', 'api_key') }))
    f.put('/probe', async (req: any) => { await setCredential('dns', 'godaddy', 'api_key', req.body.value, false); return { ok: true } })
  }, { prefix: '/api/test' })

  await app.ready()
  return app
}

export async function resetLock(): Promise<void> {
  if (isUnlocked()) await lock('manual')
}

export async function signIn(app: FastifyInstance, email: string, password: string, code = GOOD_CODE) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/sign-in', payload: { email, password, code } })
  const raw = res.headers['set-cookie']
  const header = Array.isArray(raw) ? raw[0] : raw
  const cookie = header ? header.split(';')[0] : ''
  return { res, cookie }
}
