// =============================================================================
//  HyperProx — local plug-ins
//
//  A local plug-in is code that lives on one install and nowhere else: something made for one install's
//  own server, never meant for the public repository. It sits in a git-ignored folder:
//
//    apps/api/src/local-plugins/<id>/index.ts     the API half (this loader)
//    apps/frontend/local-plugins/<id>/plugin.tsx  the page (apps/frontend/scripts/local-plugins.js)
//
//  Both folders are ignored by git, so `git status`, the in-app updater's local-changes check and
//  deploy.sh never see them, and an update (a git checkout) leaves them where they are. When neither
//  folder exists HyperProx behaves exactly as it does without this file.
//
//  The rules are fixed here, not chosen by the plug-in:
//    - every route is under /api/local/<id>, and every route there needs the admin role, reads included
//      (lib/roles.ts);
//    - every request that is not a read needs the master password re-entered within the last few
//      minutes, which also keeps API tokens off them (lib/roles.ts);
//    - API tokens are refused on every /api/local route, reads included (lib/api-tokens.ts);
//    - every request that is not a read is written to the audit log with who made it and the status it
//      got (the plug-in adds its own, more detailed rows through host.audit);
//    - the plug-in's secrets go in one vault item of its own, hyperprox:local/<id>; host.credentials
//      cannot reach any other item.
//  A plug-in that fails to load is logged and skipped; it never stops the API starting.
// =============================================================================

import fs from 'fs'
import path from 'path'
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify'
import { auditCredentialUse, auditOrThrow } from './audit'
import { deleteCredential, getCredential, setCredential } from './credentials'

/** What a plug-in is given. It holds no other handle on HyperProx. */
export interface LocalPluginHost {
  id: string
  /** This plug-in's own source folder (apps/api/src/local-plugins/<id>), for static files it ships. */
  sourceDir: string
  /** A folder for its caches, created on first use: data/local-plugins/<id> in the install. */
  dataDir(): string
  log: { info(msg: string): void; warn(msg: string): void }
  /** An audit row (scrubbed of anything named like a secret). auditStrict throws when it cannot be written. */
  audit(action: string, details?: Record<string, unknown>): Promise<void>
  auditStrict(action: string, details?: Record<string, unknown>): Promise<void>
  /** The plug-in's own vault item, hyperprox:local/<id>. Writes need a signed-in person (never a token). */
  credentials: {
    get(key: string): Promise<string | null>
    set(key: string, value: string): Promise<void>
    delete(key: string): Promise<void>
  }
  /** The person making the request: their e-mail and role. */
  actor(req: FastifyRequest): { email: string; role: string }
}

export interface LocalApiPlugin {
  /** Lower-case letters, digits and dashes; becomes /api/local/<id>. */
  id: string
  name: string
  /** The plug-in's routes, registered under /api/local/<id>. */
  routes(host: LocalPluginHost): FastifyPluginAsync
}

export const LOCAL_ID = /^[a-z][a-z0-9-]{1,39}$/
const KEY = /^[A-Za-z0-9_.:-]{1,80}$/
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Where the API half is looked for: src/local-plugins next to this file's lib/ (dist/local-plugins once built). */
export function defaultLocalPluginDir(): string {
  return path.join(__dirname, '..', 'local-plugins')
}

/** dist/local-plugins/<id> → src/local-plugins/<id>, where the plug-in's non-code files are. */
function sourceDirOf(dir: string, id: string): string {
  const own = path.join(dir, id)
  const src = own.replace(`${path.sep}dist${path.sep}`, `${path.sep}src${path.sep}`)
  return fs.existsSync(src) ? src : own
}

export interface LoadedLocalPlugins { plugins: Array<{ plugin: LocalApiPlugin; dir: string }>; errors: Array<{ id: string; error: string }> }

/**
 * Find and load every plug-in in `dir` (one folder each, with an index module). Missing `dir`: none.
 * `reserved` are ids that may not be used (the bundled plug-ins).
 */
export function loadLocalPlugins(dir = defaultLocalPluginDir(), reserved: string[] = []): LoadedLocalPlugins {
  const out: LoadedLocalPlugins = { plugins: [], errors: [] }
  let names: string[] = []
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort() }
  catch { return out }
  const seen = new Set<string>()
  for (const name of names) {
    if (!LOCAL_ID.test(name)) { out.errors.push({ id: name, error: 'folder name is not a valid plug-in id' }); continue }
    const hasIndex = ['index.js', 'index.ts'].some(f => fs.existsSync(path.join(dir, name, f)))
    if (!hasIndex) continue
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(path.join(dir, name))
      const plugin: LocalApiPlugin | undefined = mod?.default ?? mod?.plugin
      if (!plugin || typeof plugin.routes !== 'function') throw new Error('it exports no plug-in (default export with routes())')
      if (plugin.id !== name) throw new Error(`its id "${plugin.id}" does not match its folder`)
      if (reserved.includes(plugin.id)) throw new Error('that id belongs to a bundled plug-in')
      if (seen.has(plugin.id)) throw new Error('duplicate id')
      seen.add(plugin.id)
      out.plugins.push({ plugin, dir })
    } catch (e: any) {
      out.errors.push({ id: name, error: e?.message ?? String(e) })
    }
  }
  return out
}

function hostFor(id: string, dir: string, log: LocalPluginHost['log']): LocalPluginHost {
  const checkKey = (k: string) => { if (!KEY.test(k)) throw new Error('bad credential key') }
  const resource = `local:${id}`
  return {
    id,
    sourceDir: sourceDirOf(dir, id),
    dataDir() {
      const root = process.env.HYPERPROX_DATA_DIR || path.resolve(__dirname, '..', '..', '..', '..', 'data')
      const d = path.join(root, 'local-plugins', id)
      fs.mkdirSync(d, { recursive: true, mode: 0o700 })
      return d
    },
    log,
    audit: (action, details) => auditCredentialUse(`local.${id}.${action}`, resource, details),
    auditStrict: (action, details) => auditOrThrow(`local.${id}.${action}`, resource, details),
    credentials: {
      get: async (k) => { checkKey(k); return getCredential('local', id, k) },
      set: async (k, v) => { checkKey(k); await setCredential('local', id, k, v) },
      delete: async (k) => { checkKey(k); await deleteCredential('local', id, k) },
    },
    actor: (req) => ({ email: req.session?.email ?? 'unknown', role: req.session?.role ?? 'unknown' }),
  }
}

/** Register every loaded plug-in under /api/local/<id>, plus GET /api/local (the list the pages use). */
export async function registerLocalPlugins(server: FastifyInstance, loaded: LoadedLocalPlugins): Promise<void> {
  const log = (id: string) => ({ info: (m: string) => server.log.info(`[local:${id}] ${m}`), warn: (m: string) => server.log.warn(`[local:${id}] ${m}`) })
  for (const e of loaded.errors) server.log.warn(`[local-plugins] ${e.id} not loaded: ${e.error}`)
  const ready: Array<{ id: string; name: string }> = []
  for (const { plugin, dir } of loaded.plugins) {
    try {
      const host = hostFor(plugin.id, dir, log(plugin.id))
      await server.register(async (f) => {
        // Every change through a local plug-in leaves a row, whatever the plug-in itself records.
        f.addHook('onResponse', async (req, reply) => {
          if (SAFE_METHODS.has(req.method) || !req.session) return
          const route = (req as any).routeOptions?.url ?? req.url.split('?')[0]
          await host.audit('request', { by: req.session.email, method: req.method, route: String(route), status: reply.statusCode })
        })
        await f.register(plugin.routes(host))
      }, { prefix: `/api/local/${plugin.id}` })
      ready.push({ id: plugin.id, name: plugin.name })
      server.log.info(`[local-plugins] loaded ${plugin.id}`)
    } catch (e: any) {
      server.log.warn(`[local-plugins] ${plugin.id} not registered: ${e?.message ?? e}`)
    }
  }
  server.get('/api/local', async () => ({ success: true, data: ready }))
}
