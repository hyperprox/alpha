// =============================================================================
//  HyperProx — self-update routes (/api/self-update)
//
//    GET  /summary   any signed-in role: the version and whether an update is on offer (the header chip)
//    GET  /status    admin: installed version, settings, the last check, the run in progress
//    POST /check     admin: check now (at most once a minute)
//    GET  /preview   admin: what an install would do, and anything that refuses it
//    POST /install   admin + master password re-entered (roles.ts); never an API token
//    GET  /job       admin: the run's steps and log tail, read from the updater's state file
//    PUT  /settings  admin + master password re-entered; never an API token
//
//  The update itself runs outside the API (lib/self-update/updater-main.ts).
// =============================================================================

import path from 'path'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { hasRole } from '../lib/roles'
import { isReconfirmed } from '../lib/auth'
import { isUnlocked } from '../lib/vault/state'
import { publish } from '../lib/notify'
import { auditOrThrow } from '../lib/audit'
import { APP_VERSION } from '../lib/version'
import { RealShell, type Shell } from '../lib/self-update/shell'
import { SelfUpdateService, RefusedError, launchUpdater, type SelfUpdateConfig } from '../lib/self-update/service'
import { SettingsError } from '../lib/self-update/settings'
import { upstreamAllowed } from '../lib/self-update/runner'
import { GitHubUpstream, GitLabUpstream, GitUpstream, HttpCache, githubRepo, gitlabProject, type Fetcher, type Upstream } from '../lib/self-update/upstream'

export interface SelfUpdateRouteDeps {
  service?: SelfUpdateService
  /** Start the check timer (default on). */
  timer?:   boolean
}

/** The install's root: four directories up from src/routes and dist/routes alike. */
export const INSTALL_DIR = process.env.HYPERPROX_DIR || path.resolve(__dirname, '..', '..', '..', '..')
export const DEFAULT_REPO = 'https://github.com/hyperprox/alpha.git'

export function selfUpdateConfig(env: NodeJS.ProcessEnv = process.env, dir = INSTALL_DIR): SelfUpdateConfig {
  const keys = env.HYPERPROX_UPDATE_TRUSTED_KEYS || ''
  return {
    repoUrl: (env.HYPERPROX_UPDATE_REPO || DEFAULT_REPO).trim(),
    mirrorUrl: (env.HYPERPROX_UPDATE_MIRROR || '').trim() || null,
    trustedKeys: keys ? path.resolve(dir, keys) : null,
    allowInsecure: env.HYPERPROX_UPDATE_INSECURE_UPSTREAM === '1',
  }
}

/** GitHub's API for a GitHub upstream, a GitLab mirror's API, and plain git for anything else (and as a last resort). */
export function upstreamsFor(cfg: SelfUpdateConfig, dir: string, sh: Shell, cache: HttpCache, fetcher?: Fetcher): () => Upstream[] {
  return () => {
    const out: Upstream[] = []
    const gh = githubRepo(cfg.repoUrl)
    if (gh) out.push(new GitHubUpstream(gh, { cache, fetch: fetcher }))
    if (cfg.mirrorUrl) {
      const gl = gitlabProject(cfg.mirrorUrl)
      if (gl && !githubRepo(cfg.mirrorUrl)) out.push(new GitLabUpstream(gl, { cache, fetch: fetcher }))
    }
    // Plain git only for an upstream the updater would fetch from too (https; http or a path for a test upstream).
    if (upstreamAllowed(cfg.repoUrl, cfg.allowInsecure)) out.push(new GitUpstream(cfg.repoUrl, dir, sh, cfg.allowInsecure))
    if (cfg.mirrorUrl && upstreamAllowed(cfg.mirrorUrl, cfg.allowInsecure)) out.push(new GitUpstream(cfg.mirrorUrl, dir, sh, cfg.allowInsecure, true))
    return out
  }
}

export function productionService(log?: (m: string) => void): SelfUpdateService {
  const sh = new RealShell()
  const dir = INSTALL_DIR
  const dataDir = path.join(dir, 'data', 'self-update')
  const cfg = selfUpdateConfig()
  const lockFile = process.env.HYPERPROX_DEPLOY_LOCK || '/run/lock/hyperprox-deploy.lock'
  return new SelfUpdateService({
    dir, dataDir, sh, config: cfg,
    upstreams: upstreamsFor(cfg, dir, sh, new HttpCache(path.join(dataDir, 'http-cache.json'))),
    isUnlocked,
    publish: e => publish(e as any),
    audit: (action, details) => auditOrThrow(action, 'hyperprox', details),
    launch: launchUpdater(sh, { distDir: path.join(__dirname, '..', 'lib', 'self-update'), dataDir, lockFile, nodeBin: process.execPath, allowInsecure: cfg.allowInsecure }),
    // A directory of its own (0700), so pruning old backups never looks anywhere else.
    lockFile, backupDir: process.env.HYPERPROX_UPDATE_BACKUP_DIR || '/root/hyperprox-backups',
    runningSha: APP_VERSION.sha, log,
  })
}

/** An API token acts as a session whose id starts with "token:" (lib/gate.ts tokenSession). */
const isToken = (req: FastifyRequest) => !!req.apiToken || String(req.session?.sid ?? '').startsWith('token:')

async function admin(req: FastifyRequest, reply: FastifyReply) {
  const s = req.session
  if (!s) return reply.status(401).send({ ok: false, code: 'unauthenticated', error: 'Authentication required' })
  if (!hasRole(s.role, 'admin')) return reply.status(403).send({ ok: false, code: 'forbidden', error: 'Updating HyperProx needs the admin role', required: 'admin', role: s.role })
}

/** A change: a person, not a token, who re-entered the master password within the last five minutes. */
function personReconfirmed(req: FastifyRequest, reply: FastifyReply): boolean {
  if (isToken(req)) { reply.status(403).send({ ok: false, code: 'token_refused', error: 'An API token cannot update HyperProx or change how it updates. Sign in to do this.' }); return false }
  if (!req.session?.sid || !isReconfirmed(req.session.sid)) { reply.status(403).send({ ok: false, code: 'reconfirm_required', error: 'Re-enter your master password to continue' }); return false }
  return true
}

export function buildSelfUpdateRoutes(deps: SelfUpdateRouteDeps = {}): FastifyPluginAsync {
  return async (fastify) => {
    const svc = deps.service ?? productionService(m => fastify.log.info(m))
    if (deps.timer !== false) {
      fastify.addHook('onReady', async () => { await svc.reportFinished().catch(() => false); svc.start() })
      fastify.addHook('onClose', async () => svc.stop())
    }

    fastify.get('/summary', async (req, reply) => {
      if (!req.session) return reply.status(401).send({ ok: false, code: 'unauthenticated', error: 'Authentication required' })
      const c = svc.lastCheck()
      const job = await svc.job()
      const inst = await svc.installed().catch(() => null)
      return {
        version: APP_VERSION.version, commit: APP_VERSION.sha,
        // What this install calls itself: its tag, or "0.2.0-alpha+main.1a2b3c4" when it is not a release.
        label: inst?.label ?? null, display: inst?.display ?? null, tagged: inst?.tagged ?? null,
        channel: svc.channelInfo().channel,
        available: c?.available ? { label: c.available.label, version: c.available.version, channel: c.available.channel } : null,
        updating: job?.status === 'running',
      }
    })

    fastify.get('/status', { preHandler: admin }, async () => {
      const [installed, job] = await Promise.all([svc.installed(), svc.job()])
      const cfg = svc.config()
      return {
        installed, running: { version: APP_VERSION.version, commit: APP_VERSION.sha },
        // The channel in effect, whether someone chose it or it follows the install's kind, and why.
        channel: svc.channelInfo(),
        settings: svc.settings(), locks: svc.locks(), autoInstallBlocked: svc.autoInstallBlocked(), check: svc.lastCheck(), job,
        upstream: { repoUrl: cfg.repoUrl, mirrorUrl: cfg.mirrorUrl, trustedKeys: !!cfg.trustedKeys },
      }
    })

    let lastManual = 0
    fastify.post('/check', { preHandler: admin }, async (req, reply) => {
      if (Date.now() - lastManual < 60_000) return reply.status(429).send({ ok: false, error: 'Checked less than a minute ago.', check: svc.lastCheck() })
      lastManual = Date.now()
      return { check: await svc.check() }
    })

    fastify.get('/preview', { preHandler: admin }, async () => svc.preview())

    fastify.post<{ Body: { sha?: unknown; confirmUnrelated?: unknown } }>('/install', { preHandler: admin }, async (req, reply) => {
      if (!personReconfirmed(req, reply)) return
      const sha = req.body?.sha
      if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) return reply.status(400).send({ ok: false, error: 'sha must be the full commit id of the update on offer' })
      try {
        const confirm = typeof req.body?.confirmUnrelated === 'string' ? req.body.confirmUnrelated.slice(0, 100) : undefined
        const job = await svc.install(req.session!.email, sha, 'manual', { confirmUnrelated: confirm })
        return reply.status(202).send({ job })
      } catch (e: any) {
        if (e instanceof RefusedError) return reply.status(409).send({ ok: false, code: 'refused', error: e.message, refusals: e.refusals })
        return reply.status(503).send({ ok: false, error: `The update could not be started: ${e?.message ?? e}` })
      }
    })

    fastify.get('/job', { preHandler: admin }, async () => ({ job: await svc.job() }))

    fastify.put<{ Body: unknown }>('/settings', { preHandler: admin }, async (req, reply) => {
      if (!personReconfirmed(req, reply)) return
      try { return { settings: await svc.saveSettings(req.body, req.session!.email) } }
      catch (e: any) {
        if (e instanceof SettingsError) return reply.status(400).send({ ok: false, error: e.message })
        return reply.status(503).send({ ok: false, error: e?.message ?? String(e) })
      }
    })
  }
}

export const selfUpdateRoutes: FastifyPluginAsync = buildSelfUpdateRoutes()
