import { FastifyPluginAsync } from 'fastify'
import { APP_VERSION }        from '../lib/version'

/** How long the database gets to answer the health check's SELECT 1. */
export const HEALTH_DB_TIMEOUT_MS = 2000

/**
 * 'ok' when the database answers SELECT 1 within two seconds, 'down' otherwise (no database client at all included).
 * Never the reason: that goes to the log, so the answer stays safe to show anywhere.
 */
export async function checkDatabase(query: (() => Promise<unknown>) | null, timeoutMs = HEALTH_DB_TIMEOUT_MS, onError?: (e: unknown) => void): Promise<'ok' | 'down'> {
  if (!query) return 'down'
  let t: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      query(),
      new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`the database did not answer within ${timeoutMs} ms`)), timeoutMs) }),
    ])
    return 'ok'
  } catch (e) {
    onError?.(e)
    return 'down'
  } finally {
    if (t) clearTimeout(t)
  }
}

/**
 * GET /health: the process is up (`status: 'ok'` whenever it answers) and whether its database answers (`db`).
 * `opts.dbQuery` is for tests; by default it is SELECT 1 through the app's Prisma client.
 */
export const healthRoute: FastifyPluginAsync<{ dbQuery?: () => Promise<unknown> }> = async (fastify, opts) => {
  fastify.get('/', async (request) => {
    const prisma = (fastify as any).prisma
    const query = opts?.dbQuery ?? (prisma ? () => prisma.$queryRaw`SELECT 1` : null)
    const db = await checkDatabase(query, HEALTH_DB_TIMEOUT_MS, e => request.log.warn({ err: e }, '[health] database check failed'))
    return {
      status:  'ok',
      db,
      version: APP_VERSION.version,
      commit:  APP_VERSION.sha || undefined,
      describe: APP_VERSION.describe || undefined,
      uptime:  process.uptime(),
      ts:      new Date().toISOString(),
    }
  })
}

/**
 * GET /api/health: the unauthenticated liveness probe (answers while the vault is locked). Status only: no
 * version, no host names, no uptime. The detailed answer stays on /health, which nginx does not publish.
 */
export const publicHealthRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async () => ({ status: 'ok' }))
}
