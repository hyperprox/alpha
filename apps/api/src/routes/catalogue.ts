// =============================================================================
//  HyperProx — service catalogue routes
//
//  Two halves. The catalogue itself, and the node logins without which none of
//  it can run — kept together because the first is useless without the second,
//  and separating them is how a feature ends up with a button that always
//  fails.
// =============================================================================

import { FastifyPluginAsync } from 'fastify'
import { CATALOGUE, findRecipe } from '../lib/catalogue'
import { startInstall, getInstallJob } from '../lib/catalogue-installer'
import { nodeCredential, nodeCredentialId, execOnNode } from '../lib/node-exec'
import { saveCredential, removeCredential } from '../lib/ssh-broker'
import { getProviderCredentials } from '../lib/credentials'
import { getSettings } from '../lib/plugin-host'
import { ProxmoxClient } from '../lib/proxmox-client'

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

export const catalogueRoutes: FastifyPluginAsync = async (fastify) => {

  // GET / — what can be installed, and what is already here
  fastify.get('/', async (_req, reply) => {
    const [addrs, nodes] = await Promise.all([
      nodeAddresses(),
      pve().getNodes().catch(() => [] as any[]),
    ])

    const online = (nodes as any[]).filter(n => n.status === 'online')
    const logins = await Promise.all(online.map(async (n: any) => ({
      node: n.node,
      address: addrs[n.node] ?? null,
      hasLogin: Boolean(await nodeCredential(n.node).catch(() => null)),
    })))

    const recipes = await Promise.all(CATALOGUE.map(async r => ({
      id: r.id, name: r.name, summary: r.summary, category: r.category,
      port: r.port, needsDocker: r.needsDocker, defaults: r.defaults,
      firstLogin: r.firstLogin ?? null, notes: r.notes ?? [],
      satisfies: r.satisfies ?? null,
      // A recipe whose integration already has an address is not offered as a
      // fix for a problem the user does not have.
      installedAt: await alreadySatisfied(r.id),
    })))

    return reply.send({
      success: true,
      data: {
        recipes,
        nodes: logins,
        // Everything here runs through pct exec, so this is the gate.
        canInstall: logins.some(l => l.hasLogin),
      },
    })
  })

  // POST /install — create or reuse a container, run the recipe, wire it up
  fastify.post<{
    Body: {
      recipeId: string
      intoVmid?: number
      node?: string
      resources?: { cores: number; memoryMb: number; diskGb: number }
    }
  }>('/install', async (req, reply) => {
    const { recipeId, intoVmid, node, resources } = req.body ?? {}
    if (!recipeId) return reply.status(400).send({ success: false, error: 'recipeId is required' })
    if (!findRecipe(recipeId)) return reply.status(404).send({ success: false, error: 'No such recipe' })

    try {
      const job = await startInstall({ recipeId, intoVmid, node, resources })
      return reply.send({ success: true, data: { jobId: job.jobId, steps: job.steps } })
    } catch (e: any) {
      return reply.status(500).send({ success: false, error: e.message })
    }
  })

  // GET /jobs/:jobId — progress, including the live install log
  fastify.get<{ Params: { jobId: string } }>('/jobs/:jobId', async (req, reply) => {
    const job = getInstallJob(req.params.jobId)
    if (!job) return reply.status(404).send({ success: false, error: 'No such install job' })
    return reply.send({ success: true, data: job })
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

export { nodeCredentialId }
