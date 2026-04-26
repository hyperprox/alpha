import fp      from 'fastify-plugin'
import Redis   from 'ioredis'

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis
  }
}

export const redisPlugin = fp(async (fastify: any) => {
  const redis = new Redis(process.env.REDIS_URL!)
  fastify.decorate('redis', redis)
  fastify.addHook('onClose', async () => { await redis.quit() })
})
