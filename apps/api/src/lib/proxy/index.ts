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
import type { HostSpec, ProxyHostView } from './types'

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

export function productionProxyService(store: ProxyStore): ProxyService {
  return new ProxyService({
    store, secrets: vaultInstanceSecrets, guestExec: productionGuestExec,
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
 * For the AI wizard's configure_proxy step (wizard-executor.ts stepConfigureProxy): create a host on an
 * instance through the same preview → apply → re-read path as the Proxy page, and return the host id.
 * The default instance is the legacy NPM, which is what the wizard drives today.
 */
export async function wizardCreateHost(spec: HostSpec, actor: { email: string }, instanceId = LEGACY_NPM_ID): Promise<{ hostId: string; message: string }> {
  const p = proxyPlanner()
  const plan = await p.preview(instanceId, { action: 'create', host: spec }, actor)
  const r = await p.apply(plan.id, actor)
  if (!r.ok || !r.hostId) throw new Error(r.message)
  return { hostId: r.hostId, message: r.message }
}
