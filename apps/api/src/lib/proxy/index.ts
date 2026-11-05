// =============================================================================
//  HyperProx — Proxy providers: production wiring and the hooks other parts use
// =============================================================================

import type { PrismaClient } from '@prisma/client'
import { getProviderCredentials } from '../credentials'
import { execInGuest, nodeCredential } from '../node-exec'
import { livePve } from '../pve-env'
import { ProxyService, LEGACY_NPM_ID } from './service'
import { ProxyPlanner } from './plans'
import { PrismaProxyStore, vaultInstanceSecrets, type ProxyStore } from './store'
import type { GuestExec } from './transport'
import { ProxyRefusal, type HostPatch, type HostSpec, type ManagedRef, type ProxyHostView } from './types'

export * from './types'
export { ProxyService, LEGACY_NPM_ID } from './service'
export { ProxyPlanner } from './plans'

async function nodeAddress(node: string): Promise<string> {
  const status = await livePve().fetchNode<any[]>('/cluster/status').catch(() => [])
  const row = (status ?? []).find((r: any) => r.type === 'node' && r.name === node)
  if (!row?.ip) throw new Error(`Could not find an address for node ${node}.`)
  return row.ip
}

/** The Managed transport: a script in the instance's container, through its node's vault-held login. */
export function productionGuestExec(node: string, vmid: number): GuestExec {
  return async script => {
    const cred = await nodeCredential(node)
    if (!cred) throw new Error(`HyperProx has no login for node ${node}; add one in Terminal → hosts.`)
    const r = await execInGuest({ host: await nodeAddress(node), cred, vmid, script, timeoutMs: 60_000 })
    return { code: r.code, output: r.output }
  }
}

/**
 * The Catalogue's rule for a container HyperProx may manage (catalogue-installer preflight, "install into"):
 * a container (not a VM) that exists on that node, is running, and whose node has a login stored, so HyperProx
 * can reach it the way the Catalogue does. A container the Catalogue created meets it by construction.
 */
export async function productionManagedTarget(ref: ManagedRef): Promise<void> {
  const all = await livePve().getClusterResources('vm')
  const g = (all as any[]).find(r => Number(r.vmid) === ref.vmid)
  if (!g) throw new ProxyRefusal(`CT ${ref.vmid} was not found.`, 400)
  if (g.type !== 'lxc') throw new ProxyRefusal(`${ref.vmid} is a VM; a Managed proxy runs in a container.`, 400)
  if (g.node !== ref.node) throw new ProxyRefusal(`CT ${ref.vmid} is on ${g.node}, not ${ref.node}.`, 400)
  if (g.status !== 'running') throw new ProxyRefusal(`CT ${ref.vmid} is not running.`, 400)
  if (!await nodeCredential(ref.node).catch(() => null)) throw new ProxyRefusal(`${ref.node} has no SSH login stored, so HyperProx cannot reach CT ${ref.vmid}.`, 400)
}

export function productionProxyService(store: ProxyStore): ProxyService {
  return new ProxyService({
    store, secrets: vaultInstanceSecrets, guestExec: productionGuestExec, checkManagedTarget: productionManagedTarget,
    legacyNpm: async () => {
      const c = await getProviderCredentials('proxy', 'npm')
      return c?.url && c?.email && c?.password ? { url: c.url, email: c.email, password: c.password } : null
    },
  })
}

let service: ProxyService | null = null
let planner: ProxyPlanner | null = null

/** Set once at start-up (index.ts) or by a test. */
export function setProxyService(s: ProxyService | null): void { service = s; planner = s ? new ProxyPlanner(s) : null }

export function proxyService(db?: PrismaClient): ProxyService {
  if (!service) {
    if (!db) throw new Error('The proxy service is not set up')
    setProxyService(productionProxyService(new PrismaProxyStore(db)))
  }
  return service!
}

export function proxyPlanner(): ProxyPlanner {
  if (!planner) throw new Error('The proxy service is not set up')
  return planner
}

// --- Hooks for other packages (the integrator wires the call sites) -----------------------------------

/**
 * For the certificate inventory (certs/modules.ts productionSources): every instance's hosts in the
 * shape the inventory's npmHosts source has. Certificate ids are only meaningful for the NPM instance
 * whose certificates the inventory lists, so the others carry null and their endpoints are probed.
 */
export async function inventoryHosts(certInstance = LEGACY_NPM_ID): Promise<{ domain_names: string[]; certificate_id: number | null; enabled: boolean }[]> {
  const { hosts, errors } = await proxyService().allHosts()
  // The instance whose certificates the inventory lists must answer, as the NPM source always had to.
  const down = errors.find(e => e.instanceId === certInstance)
  if (down) throw new Error(down.error)
  return hosts.map((h: ProxyHostView) => ({
    domain_names: h.domains,
    certificate_id: h.instanceId === certInstance && h.tls.kind === 'certificate' && h.tls.certificateId ? Number(h.tls.certificateId) : null,
    enabled: h.enabled,
  }))
}

/**
 * The AI wizard (wizard-executor.ts). Its own confirm step is the preview a person saw, so these run preview and
 * apply back to back: the same checks (read-only hosts, name clashes, nothing-changes), the same read-back
 * against every planned field, the same audit entries. A read-back that does not match is an error.
 */
export async function wizardCreateHost(spec: HostSpec, actor: { email: string }, instanceId = LEGACY_NPM_ID): Promise<{ hostId: string; message: string }> {
  const p = proxyPlanner()
  const plan = await p.preview(instanceId, { action: 'create', host: spec }, actor)
  const r = await p.apply(plan.id, actor)
  if (!r.ok || !r.hostId) throw new Error(r.message)
  return { hostId: r.hostId, message: r.message }
}

/** A patch to a host the wizard made: only the fields given change (merge semantics). */
export async function wizardUpdateHost(hostId: string, patch: HostPatch, actor: { email: string }, instanceId = LEGACY_NPM_ID): Promise<string> {
  const p = proxyPlanner()
  const plan = await p.preview(instanceId, { action: 'update', hostId, host: patch }, actor)
  const r = await p.apply(plan.id, actor)
  if (!r.ok) throw new Error(r.message)
  return r.message
}

/** A Let's Encrypt certificate through the instance (NPM), with the address Let's Encrypt is told. */
export async function wizardRequestCertificate(domains: string[], email: string, actor: { email: string }, instanceId = LEGACY_NPM_ID): Promise<{ id: string }> {
  const c = await proxyService().requestCertificate(instanceId, domains, email, actor)
  return { id: c.id }
}
