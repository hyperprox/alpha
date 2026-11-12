// =============================================================================
//  HyperProx — service catalogue routes
//
//  Two halves. The catalogue itself, and the node logins without which none of
//  it can run — kept together because the first is useless without the second,
//  and separating them is how a feature ends up with a button that always
//  fails.
// =============================================================================

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { CATALOGUE, CATEGORY_LABELS, findRecipe } from '../lib/catalogue'
import {
  getInstallJob, readAdminCredential, previewInstall, applyPreview, removeFailedInstall, getPreview, cleanupCandidates,
  wizardView, identityView, placementFor, nextIdOf, checkIdentity, readVmidRule, saveVmidRule, WizardRefusal,
  type InstallJob, type WizardDeps, type WizardInput,
} from '../lib/catalogue-installer'
import { parseCidr } from '../lib/wizard-placement'
import { currentContext } from '../lib/auth'
import { ownerOf } from './ai'
import { nodeCredential, nodeCredentialId, execOnNode } from '../lib/node-exec'
import { saveCredential, removeCredential } from '../lib/ssh-broker'
import { getProviderCredentials } from '../lib/credentials'
import { getSettings } from '../lib/plugin-host'
import { ProxmoxClient } from '../lib/proxmox-client'
import { DetectionCache, type DetectResult, type FingerprintList } from '../lib/catalogue-detect'
import { sharedCandidateCache } from './site-metrics'
import { hasRole, type Role } from '../lib/roles'
import { knownNas, listExports } from '../lib/pbs/nas-list'
import { pbsSetupNodeRunner } from '../lib/pbs/setup-deps'
import { pbsService } from '../lib/pbs'
import { qnapService } from '../lib/qnap'
import { RECIPE_ID as PBS_RECIPE_ID } from '../lib/pbs/catalogue'

function pve(): ProxmoxClient {
  return new ProxmoxClient(
    process.env.PROXMOX_HOST!,
    Number(process.env.PROXMOX_PORT ?? 8006),
    `${process.env.PROXMOX_USER}!${process.env.PROXMOX_TOKEN_ID}`,
    process.env.PROXMOX_TOKEN_SECRET!,
  )
}

/** Node name to address. Names are not reliably resolvable from a container. */
async function nodeAddresses(): Promise<Record<string, string>> {
  const rows = await pve().fetchNode<any[]>('/cluster/status').catch(() => [])
  const out: Record<string, string> = {}
  for (const r of rows ?? []) if (r?.type === 'node' && r.name && r.ip) out[r.name] = r.ip
  return out
}

/** Is the thing this recipe provides already configured? */
async function alreadySatisfied(recipeId: string): Promise<string | null> {
  // A backup server the PBS plug-in already reads (it keeps its servers as instances, not settings).
  if (recipeId === PBS_RECIPE_ID) return (await pbsService().instances.views().catch(() => []))[0]?.url || null
  const r = findRecipe(recipeId)
  if (!r?.satisfies) return null
  const { kind, id, setting } = r.satisfies
  if (kind === 'credential') {
    const cat = r.category === 'ai' ? 'ai' : 'proxy'
    const v = (await getProviderCredentials(cat, id).catch(() => null))?.[setting]
    return v || null
  }
  const v = (await getSettings(id).catch(() => ({} as Record<string, string>)))[setting]
  return v || null
}

/** What the install routes reach outside themselves for; tests pass fakes. */
export interface CatalogueRouteDeps {
  /** Who is asking, named exactly as the wizard names a plan's owner. */
  whoami(req: FastifyRequest): string
  job(id: string): InstallJob | undefined
  /** Stand-ins for what the wizard reaches (Proxmox, node logins, ping, the rule store). */
  wizard: Partial<WizardDeps>
  /** Where each catalogue app is already running (lib/catalogue-detect.ts), cached five minutes. */
  detected(refresh: boolean): Promise<DetectResult>
}

/**
 * The fingerprints the catalogue asks for, in an order where a generic page (Homepage's "/") comes after the
 * apps with an API of their own. Website recipes are not listed here: they live in the Websites section, whose
 * "Add an existing site" finds running WordPress and static sites by looking inside the container.
 */
export function catalogueFingerprints(): FingerprintList {
  const generic = new Set(['homepage'])
  const list = CATALOGUE.filter(r => r.category !== 'web' && r.detect?.length).map(r => [r.id, r.detect!] as [string, NonNullable<typeof r.detect>])
  return [...list.filter(([id]) => !generic.has(id)), ...list.filter(([id]) => generic.has(id))]
}

let detection: DetectionCache | null = null
const realDetected = (refresh: boolean) =>
  (detection ??= new DetectionCache(r => sharedCandidateCache().get(r), undefined, undefined, catalogueFingerprints(), {})).result(refresh)

/** The catalogue's own list: every recipe except websites, which have their own section (/sites). */
export const isCatalogueListed = (r: { category: string }) => r.category !== 'web'

export function buildCatalogueRoutes(overrides: Partial<CatalogueRouteDeps> = {}): FastifyPluginAsync {
  const deps: CatalogueRouteDeps = {
    whoami: () => ownerOf(currentContext()),
    job: getInstallJob,
    wizard: {},
    detected: realDetected,
    ...overrides,
  }
  return async (fastify) => {

  // GET / — what can be installed, and what is already here
  fastify.get('/', async (_req, reply) => {
    const [addrs, nodes] = await Promise.all([
      nodeAddresses(),
      pve().getNodes().catch(() => [] as any[]),
    ])

    const online = ((nodes as any[] | null) ?? []).filter(n => n?.status === 'online')
    const logins = await Promise.all(online.map(async (n: any) => ({
      node: n.node,
      address: addrs[n.node] ?? null,
      hasLogin: Boolean(await nodeCredential(n.node).catch(() => null)),
    })))

    const view = (r: typeof CATALOGUE[number]) => alreadySatisfied(r.id).then(installedAt => ({
      id: r.id, name: r.name, summary: r.summary, category: r.category, categoryLabel: CATEGORY_LABELS[r.category],
      port: r.port, needsDocker: r.needsDocker, defaults: r.defaults, minimum: r.minimum,
      needsGpu: Boolean(r.needsGpu), firstRunKind: r.firstRun.kind, healthPath: r.healthPath,
      firstLogin: r.firstLogin ?? null, notes: r.notes ?? [],
      satisfies: r.satisfies ?? null,
      options: r.options ?? [],
      sizes: r.sizes ?? null,
      // A recipe whose integration already has an address is not offered as a
      // fix for a problem the user does not have.
      installedAt,
      detectable: Boolean(r.detect?.length),
    }))
    const [recipes, websites] = await Promise.all([
      Promise.all(CATALOGUE.filter(isCatalogueListed).map(view)),
      // The website recipes, for the Websites section's New website wizard (not listed in the catalogue).
      Promise.all(CATALOGUE.filter(r => !isCatalogueListed(r)).map(view)),
    ])

    return reply.send({
      success: true,
      data: {
        recipes,
        websites,
        nodes: logins,
        // Everything here runs through pct exec, so this is the gate.
        canInstall: logins.some(l => l.hasLogin),
      },
    })
  })

  // GET /detected — where each catalogue app is already running (admin: it names guests and addresses)
  fastify.get<{ Querystring: { refresh?: string } }>('/detected', async (req, reply) => {
    const role = (req.session?.role ?? 'viewer') as Role
    if (!hasRole(role, 'admin')) return reply.status(403).send({ ok: false, code: 'forbidden', error: 'This needs the admin role', required: 'admin' })
    try {
      const r = await deps.detected(req.query.refresh === '1')
      return reply.send({ success: true, data: r })
    } catch (e: any) {
      return reply.status(502).send({ success: false, error: `Could not look for running apps: ${e?.message ?? e}` })
    }
  })

  // There is no one-call install route. Every install goes through the wizard: preview, then apply.

  // ── The install wizard ───────────────────────────────────────────────────

  const num = (x: unknown): number | undefined => {
    const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() ? Number(x) : NaN
    return Number.isFinite(n) ? n : undefined
  }
  const refusal = (reply: any, e: unknown) => {
    if (e instanceof WizardRefusal) {
      const status = { 'not-found': 404, expired: 410, used: 409, changed: 409 }[e.code]
      return reply.status(status).send({ success: false, code: e.code, error: e.message, problems: e.problems })
    }
    return reply.status(500).send({ success: false, error: (e as Error).message })
  }

  // GET /wizard/pbs/nas — the NAS HyperProx knows, for a backup server's datastore (admin, like every wizard route).
  // With ?node=&host=, that NAS's NFS exports as the node sees them (showmount, read-only).
  fastify.get<{ Querystring: { node?: string; host?: string } }>('/wizard/pbs/nas', async (req, reply) => {
    // Reading a NAS's exports runs a command on a node: a person only, never an API token (like the probes).
    if ((req as any).apiToken) return reply.status(403).send({ success: false, code: 'token_forbidden', error: 'API tokens cannot look at NAS exports.' })
    try {
      if (req.query.host) {
        // Asked from the node given, or the first online node with a saved login; the preview asks again from the
        // node the container goes on.
        let node = req.query.node
        if (node && !/^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/.test(node)) return reply.status(400).send({ success: false, error: 'Not a node name.' })
        if (!node) {
          for (const n of ((await pve().getNodes().catch(() => [])) as any[]).filter(x => x?.status === 'online')) {
            if (await nodeCredential(n.node).catch(() => null)) { node = n.node; break }
          }
        }
        if (!node) return reply.status(409).send({ success: false, error: 'No online node has a saved login to ask the NAS from.' })
        return reply.send({ success: true, data: { node, ...(await listExports(node, req.query.host, deps.wizard.nodeRun ?? pbsSetupNodeRunner)) } })
      }
      const list = await knownNas({
        qnap: async () => (await qnapService().instances.views()).map(v => ({ name: v.name, url: v.url })),
        storages: async () => (await pve().fetchStrict<any[]>('/storage')) ?? [],
      })
      return reply.send({ success: true, data: list })
    } catch (e: any) {
      return reply.status(400).send({ success: false, error: String(e?.message ?? 'Could not list the NAS.').slice(0, 300) })
    }
  })

  // GET /wizard/placement — every node with its room, and where this recipe would go best
  fastify.get<{ Querystring: { recipeId?: string; cores?: string; memoryMb?: string; diskGb?: string; storage?: string } }>(
    '/wizard/placement', async (req, reply) => {
      const recipe = findRecipe(String(req.query.recipeId ?? ''))
      if (!recipe) return reply.status(404).send({ success: false, error: 'No such recipe' })
      const need = {
        cores: num(req.query.cores) ?? recipe.defaults.cores,
        memoryMb: num(req.query.memoryMb) ?? recipe.defaults.memoryMb,
        diskGb: num(req.query.diskGb) ?? recipe.defaults.diskGb,
        storage: req.query.storage || undefined,
      }
      try {
        const { view, deps: d } = await wizardView(deps.wizard)
        const rule = await d.readRule()
        const placed = placementFor(recipe, need, view)
        return reply.send({ success: true, data: {
          need, ...placed, partial: view.partial, rule,
          nextVmid: nextIdOf(view),
        } })
      } catch (e) { return refusal(reply, e) }
    })

  // POST /wizard/identity — the ID to suggest, the ID rule both ways, and whether a static address is free
  // Called as the person types, so it reuses one cluster read for ~10 s per person, and pings only when
  // the person presses "Check address" (ping: true).
  fastify.post<{ Body: { node?: string; bridge?: string; vmid?: number; ip?: string; gateway?: string; ping?: boolean } }>(
    '/wizard/identity', async (req, reply) => {
      const b = req.body ?? {}
      if (!b.node) return reply.status(400).send({ success: false, error: 'node is required' })
      try {
        const staticIp = Boolean(b.ip && b.ip !== 'dhcp' && parseCidr(b.ip))
        const { view, live, deps: d } = await identityView(deps.whoami(req), staticIp, deps.wizard)
        const rule = await d.readRule()
        const vmid = num(b.vmid)
        const data = await checkIdentity({ node: b.node, bridge: b.bridge, vmid, ip: b.ip, gateway: b.gateway }, view, rule, live,
          b.ping === true ? d.ping : undefined)
        return reply.send({ success: true, data })
      } catch (e) { return refusal(reply, e) }
    })

  // GET/PUT /wizard/settings — the container ID rule
  fastify.get('/wizard/settings', async (_req, reply) => {
    try { return reply.send({ success: true, data: { vmidRule: await readVmidRule(deps.wizard) } }) }
    catch (e) { return refusal(reply, e) }
  })
  fastify.put<{ Body: { vmidRule?: unknown } }>('/wizard/settings', async (req, reply) => {
    try { return reply.send({ success: true, data: { vmidRule: await saveVmidRule(req.body?.vmidRule, deps.wizard) } }) }
    catch (e: any) { return reply.status(400).send({ success: false, error: e.message }) }
  })

  // POST /wizard/preview — check the whole plan against the cluster and hold it server-side
  fastify.post<{ Body: Partial<WizardInput> }>('/wizard/preview', async (req, reply) => {
    const owner = deps.whoami(req)
    if (!owner) return reply.status(401).send({ success: false, error: 'Sign in to install.' })
    const b: any = req.body ?? {}
    const input: WizardInput = {
      recipeId: String(b.recipeId ?? ''), node: String(b.node ?? ''), vmid: num(b.vmid) as number,
      hostname: String(b.hostname ?? '').trim().toLowerCase(),
      cores: num(b.cores) as number, memoryMb: num(b.memoryMb) as number, swapMb: num(b.swapMb) ?? 0, diskGb: num(b.diskGb) as number,
      storage: String(b.storage ?? ''), bridge: String(b.bridge ?? ''), ip: String(b.ip ?? 'dhcp').trim() || 'dhcp',
      ...(b.gateway ? { gateway: String(b.gateway).trim() } : {}), ...(b.dns ? { dns: String(b.dns).trim() } : {}),
      // The unknowns the person ticked for, as keys; anything else is dropped.
      ...(Array.isArray(b.addressAck) ? { addressAck: [...new Set((b.addressAck as unknown[])
        .filter((k): k is string => typeof k === 'string' && /^(live:\d{1,9}|cluster-status)$/.test(k)))].slice(0, 500) } : {}),
      // Checked against the recipe's own options in the preview; keys it does not have are dropped there.
      ...(b.options && typeof b.options === 'object' && !Array.isArray(b.options) ? { options: b.options } : {}),
      // A website's public name: zone, name and proxy, checked into the exact DNS record and proxy host by the preview.
      ...(b.publish && typeof b.publish === 'object' && !Array.isArray(b.publish)
        ? { publish: { zone: String(b.publish.zone ?? ''), name: String(b.publish.name ?? ''), instanceId: String(b.publish.instanceId ?? '') } } : {}),
    }
    if (!findRecipe(input.recipeId)) return reply.status(404).send({ success: false, error: 'No such recipe' })
    try {
      const r = await previewInstall(input, owner, deps.wizard)
      if (!r.preview) return reply.status(422).send({ success: false, error: 'The plan cannot be used as it is.', problems: r.errors, warnings: r.warnings, unknowns: r.unknowns ?? [] })
      const p = r.preview
      return reply.send({ success: true, data: { previewId: p.id, plan: p.plan, checks: p.checks, warnings: p.warnings, expiresAt: p.expiresAt } })
    } catch (e) { return refusal(reply, e) }
  })

  // GET /wizard/preview/:id — the held plan, for a review screen that was reloaded
  fastify.get<{ Params: { id: string } }>('/wizard/preview/:id', async (req, reply) => {
    const p = await getPreview(req.params.id, deps.whoami(req))
    if (!p) return reply.status(404).send({ success: false, error: 'No such preview' })
    return reply.send({ success: true, data: { previewId: p.id, plan: p.plan, checks: p.checks, warnings: p.warnings, expiresAt: p.expiresAt, used: p.used } })
  })

  // POST /wizard/apply — create and install exactly what a preview holds. The id is the only input.
  fastify.post<{ Body: { previewId?: string } }>('/wizard/apply', async (req, reply) => {
    const owner = deps.whoami(req)
    if (!owner) return reply.status(401).send({ success: false, error: 'Sign in to install.' })
    const id = req.body?.previewId
    if (!id || typeof id !== 'string') return reply.status(400).send({ success: false, error: 'previewId is required' })
    const extra = Object.keys(req.body ?? {}).filter(k => k !== 'previewId')
    if (extra.length) return reply.status(400).send({ success: false, error: `Apply takes only previewId, not ${extra.join(', ')}.` })
    try {
      const job = await applyPreview(id, owner, deps.wizard)
      return reply.send({ success: true, data: { jobId: job.jobId, steps: job.steps } })
    } catch (e) { return refusal(reply, e) }
  })

  // GET /wizard/jobs — the caller's failed or interrupted installs that left a container to clean up
  fastify.get('/wizard/jobs', async (req, reply) => {
    const jobs = cleanupCandidates(deps.whoami(req)).map(j => ({
      jobId: j.jobId, recipeId: j.recipeId, status: j.status, vmid: j.vmid, node: j.node, error: j.error, startedAt: j.startedAt,
    }))
    return reply.send({ success: true, data: { jobs } })
  })

  // POST /wizard/jobs/:jobId/cleanup — remove the container a failed install made, and only that
  fastify.post<{ Params: { jobId: string } }>('/wizard/jobs/:jobId/cleanup', async (req, reply) => {
    try {
      const detail = await removeFailedInstall(req.params.jobId, deps.whoami(req), deps.wizard)
      return reply.send({ success: true, data: { detail } })
    } catch (e) { return refusal(reply, e) }
  })

  // GET /jobs/:jobId — progress, including the live install log
  fastify.get<{ Params: { jobId: string } }>('/jobs/:jobId', async (req, reply) => {
    // Another user's job reads as no job at all, as the wizard's do.
    const job = deps.job(req.params.jobId)
    const who = deps.whoami(req)
    if (!job || !who || job.owner !== who) return reply.status(404).send({ success: false, error: 'No such install job' })
    // The generated admin login is read from the vault, only while the job is fresh and the vault
    // is unlocked. The job itself holds a reference, never the value.
    const { adminCredential: _ref, owner: _owner, ...rest } = job
    const admin = await readAdminCredential(job)
    return reply.send({ success: true, data: { ...rest, ...(admin ? { adminCredential: { ...admin, savedInVault: true } } : {}) } })
  })

  // ── Node logins ──────────────────────────────────────────────────────────

  /**
   * PUT /nodes/:node — store an SSH login for a node, after proving it works.
   *
   * Tested before it is saved, deliberately. A credential that is stored and
   * only discovered to be wrong twenty minutes into an install is worse than no
   * credential at all, because by then a container exists and the failure looks
   * like the recipe's fault.
   */
  fastify.put<{
    Params: { node: string }
    Body:   { username: string; password?: string; privateKey?: string; passphrase?: string }
  }>('/nodes/:node', async (req, reply) => {
    const { node } = req.params
    const { username, password, privateKey, passphrase } = req.body ?? {}
    if (!username) return reply.status(400).send({ success: false, error: 'username is required' })
    if (!password && !privateKey) {
      return reply.status(400).send({ success: false, error: 'a password or a private key is required' })
    }

    const addr = (await nodeAddresses())[node]
    if (!addr) return reply.status(404).send({ success: false, error: `No address found for node ${node}` })

    // Nodes are always reached on 22; the field exists for guests on odd ports.
    const cred = { username, password, privateKey, passphrase, port: 22 }
    try {
      // pveversion is read-only and exists on every Proxmox host, so a success
      // proves both that the login works and that this is actually a node.
      const probe = await execOnNode({ host: addr, cred, command: 'pveversion', timeoutMs: 20_000 })
      if (probe.code !== 0) {
        return reply.status(400).send({
          success: false,
          error: `Signed in, but pveversion exited ${probe.code}. Is ${node} a Proxmox host?`,
        })
      }
      await saveCredential(`node-${node}`, cred)
      return reply.send({ success: true, data: { node, version: probe.output.trim().split('\n')[0] } })
    } catch (e: any) {
      return reply.status(400).send({ success: false, error: e.message })
    }
  })

  fastify.delete<{ Params: { node: string } }>('/nodes/:node', async (req, reply) => {
    await removeCredential(`node-${req.params.node}`)
    return reply.send({ success: true })
  })

  /** POST /nodes/:node/test — re-prove a stored login without changing it. */
  fastify.post<{ Params: { node: string } }>('/nodes/:node/test', async (req, reply) => {
    const { node } = req.params
    const cred = await nodeCredential(node).catch(() => null)
    if (!cred) return reply.status(404).send({ success: false, error: `No login stored for ${node}` })
    const addr = (await nodeAddresses())[node]
    if (!addr) return reply.status(404).send({ success: false, error: `No address found for ${node}` })
    try {
      const probe = await execOnNode({ host: addr, cred, command: 'pveversion', timeoutMs: 20_000 })
      return reply.send({
        success: probe.code === 0,
        data: { node, code: probe.code, output: probe.output.trim().split('\n')[0] },
      })
    } catch (e: any) {
      return reply.status(400).send({ success: false, error: e.message })
    }
  })
  }
}

export const catalogueRoutes: FastifyPluginAsync = buildCatalogueRoutes()

export { nodeCredentialId }
