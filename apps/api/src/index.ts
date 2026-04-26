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
import { prismaPlugin }         from './plugins/prisma'
import { redisPlugin }          from './plugins/redis'
import { seedFromEnv }          from './lib/credentials'

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
  await server.register(wsRoutes,             { prefix: '/ws' })

  await seedFromEnv()

  const port = Number(process.env.PORT ?? 3002)
  await server.listen({ port, host: '0.0.0.0' })
  server.log.info(`HyperProx API running on port ${port}`)
}

main().catch((err) => { console.error(err); process.exit(1) })
