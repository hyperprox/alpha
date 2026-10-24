import 'dotenv/config'
import Fastify from 'fastify'
import cors       from '@fastify/cors'
import helmet     from '@fastify/helmet'
import rateLimit  from '@fastify/rate-limit'
import websocket  from '@fastify/websocket'

import { healthRoute }          from './routes/health'
import { proxmoxRoutes }        from './routes/proxmox'
import { proxyRoutes }          from './routes/proxy'
import { dnsRoutes }            from './routes/dns'
import { wsRoutes }             from './routes/ws'
import { settingsRoutes }       from './routes/settings'
import { infrastructureRoutes } from './routes/infrastructure'
import { serviceRoutes }         from './routes/services'
import { networkRoutes }         from './routes/network'
import { prometheusRoutes } from './routes/prometheus'
import { storageRoutes }         from './routes/storage'
import { ollamaRoutes }          from './routes/ollama'
import { aiRoutes }              from './routes/ai'
import { gpuRoutes }             from './routes/gpu'
import { targetsRoutes }         from './routes/targets'
import { authRoutes }             from './routes/auth'
import { secretsRoutes }          from './routes/secrets'
import { terminalRoutes }             from './routes/terminal'
import { pluginRoutes }           from './routes/plugins'
import { catalogueRoutes } from './routes/catalogue'
import { terminalWsRoutes }           from './routes/terminal-ws'
import { updatesRoutes }        from './routes/updates'
import { prismaPlugin }         from './plugins/prisma'
import { redisPlugin }          from './plugins/redis'
import { registerGate }         from './lib/gate'
import { lock }                 from './lib/vault/state'

const server = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport: process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  },
})

async function main() {
  await server.register(helmet, { contentSecurityPolicy: false })
  await server.register(cors,   { origin: true })
  await server.register(rateLimit, { max: 200, timeWindow: '1 minute' })
  await server.register(websocket)
  await server.register(prismaPlugin)
  await server.register(redisPlugin)

  // -- Vault gate ---------------------------------------------------------------
  // Replaces the old password guard. Starts locked: every route except /health*
  // and /api/auth/* answers 423 until a vault user signs in. Then 401 without a
  // valid session, 403 below the route's role (lib/roles.ts). There is no
  // switch to turn it off.
  await registerGate(server)

  await server.register(authRoutes,           { prefix: '/api/auth' })
  await server.register(secretsRoutes,        { prefix: '/api/secrets' })
  await server.register(healthRoute,          { prefix: '/health' })
  await server.register(proxmoxRoutes,        { prefix: '/api/proxmox' })
  await server.register(proxyRoutes,          { prefix: '/api/proxy' })
  await server.register(dnsRoutes,            { prefix: '/api/dns' })
  await server.register(settingsRoutes,       { prefix: '/api/settings' })
  await server.register(infrastructureRoutes, { prefix: '/api/infra' })
  await server.register(serviceRoutes,         { prefix: '/api/services' })
  await server.register(networkRoutes,         { prefix: '/api/network' })
  await server.register(storageRoutes,         { prefix: '/api/storage' })
  await server.register(prometheusRoutes)
  await server.register(ollamaRoutes, { prefix: '/api/ai' })
  await server.register(aiRoutes,    { prefix: '/api/ai' })
  await server.register(gpuRoutes,   { prefix: '/api/gpu' })
  await server.register(targetsRoutes, { prefix: '/api/targets' })
  await server.register(terminalRoutes,           { prefix: '/api/terminal' })
  await server.register(pluginRoutes,          { prefix: '/api/plugins' })
  await server.register(catalogueRoutes,      { prefix: '/api/catalogue' })
  await server.register(updatesRoutes,        { prefix: '/api/updates' })
  await server.register(wsRoutes,             { prefix: '/ws' })
  // Terminal sockets live under /ws because nginx proxies upgrades only there.
  await server.register(terminalWsRoutes,         { prefix: '/ws/terminal' })

  // Always start locked, and clear CLI session dirs a previous process left in /dev/shm.
  await lock('restart')

  // Credentials move into the vault on the first Owner sign-in (lib/credentials.ts seedFromEnv),
  // not here: while locked there is no vault session to write with.

  const port = Number(process.env.PORT ?? 3002)
  await server.listen({ port, host: '0.0.0.0' })
  server.log.info(`HyperProx API running on port ${port}`)
}

main().catch((err) => { console.error(err); process.exit(1) })
