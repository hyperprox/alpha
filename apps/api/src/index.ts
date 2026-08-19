import 'dotenv/config'
import Fastify from 'fastify'
import cors       from '@fastify/cors'
import helmet     from '@fastify/helmet'
import jwt        from '@fastify/jwt'
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
import { prismaPlugin }         from './plugins/prisma'
import { redisPlugin }          from './plugins/redis'
import { seedFromEnv }          from './lib/credentials'
import { ensureAdminPassword, extractToken } from './lib/auth'

// Paths reachable without a session. Everything else requires one.
const PUBLIC_PATHS = new Set(['/health', '/api/auth/login'])

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
  await server.register(jwt,    { secret: process.env.JWT_SECRET! })
  await server.register(websocket)
  await server.register(prismaPlugin)
  await server.register(redisPlugin)

  // -- Auth guard -------------------------------------------------------------
  // Applies to every route. Set AUTH_REQUIRED=false to disable (development only
  // -- with it off, anyone who can reach this port controls the cluster).
  server.addHook('onRequest', async (req, reply) => {
    if (process.env.AUTH_REQUIRED === 'false') return
    if (req.method === 'OPTIONS') return

    const path = req.url.split('?')[0]
    if (PUBLIC_PATHS.has(path) || path.startsWith('/health/')) return

    const token = extractToken(req.headers as Record<string, any>)
    if (!token) return reply.status(401).send({ ok: false, error: 'Authentication required' })

    try {
      server.jwt.verify(token)
    } catch {
      return reply.status(401).send({ ok: false, error: 'Session expired or invalid' })
    }
  })

  await server.register(authRoutes,           { prefix: '/api/auth' })
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
  await server.register(wsRoutes,             { prefix: '/ws' })

  await seedFromEnv()
  await ensureAdminPassword(msg => server.log.warn(msg))

  const port = Number(process.env.PORT ?? 3002)
  await server.listen({ port, host: '0.0.0.0' })
  server.log.info(`HyperProx API running on port ${port}`)
}

main().catch((err) => { console.error(err); process.exit(1) })
