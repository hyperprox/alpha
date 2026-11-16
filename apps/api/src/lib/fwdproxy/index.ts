// =============================================================================
//  HyperProx — 3proxy: the live wiring
//
//  Records in the Catalogue's small table (one row per proxy), the guests from
//  the home cluster, scripts through the remote executor (which refuses a guest
//  HyperProx must leave alone, whatever the caller checked), passwords in the
//  vault, and the plug-in card's read-only transport. Home cluster only: the
//  plug-in is not in the remote allowlist.
// =============================================================================

import { wizardStore } from '../catalogue-store'
import { productionRemoteExecutor } from '../remote/executor'
import { homePve } from '../pve-env'
import { auditOrThrow } from '../audit'
import { getProviderCredentials, setCredential, deleteCredential } from '../credentials'
import { setPluginTransport } from '../plugin-host'
import { excludedMachineIds } from '../guest-guard'
import { listGuests } from '../pve/guests'
import { machineId } from '../guest-id'
import type { Machine } from '../remote/types'
import type { ProxmoxClient } from '../proxmox-client'
import { FwdProxyService, type FwdDeps, type RecordStore } from './service'
import { PROXY_ID, type ProxyInstance } from './types'

export { FwdProxyService, FwdProxyRefusal } from './service'
export type { Problem, Actor } from './service'
export * from './types'

const ROW = 'fwdproxy:'

export const wizardRecordStore = (): RecordStore => ({
  async get(id) { const r = await wizardStore().get(ROW + id); return r && r.kind === 'setting' ? r.data as ProxyInstance : null },
  async put(i) { await wizardStore().put({ id: ROW + i.id, kind: 'setting', owner: i.addedBy, data: i, expiresAt: null }) },
  async list() { return (await wizardStore().list('setting')).filter(r => r.id.startsWith(ROW)).map(r => r.data as ProxyInstance) },
  async delete(id) { await wizardStore().delete(ROW + id) },
})

/** Auto-connect's dismissal record, given by lib/services/bootstrap.ts (importing lib/auto-connect here would close a cycle). */
export type FwdDismissedPort = (key: string, label: string, by: string) => Promise<void>
let dismissedPort: FwdDismissedPort | null = null
export function setFwdProxyDismissedPort(fn: FwdDismissedPort | null): void { dismissedPort = fn }

/** The home cluster's API, resolved at each call (homePve throws while locked, so never at construction). */
const homeFetch: Pick<ProxmoxClient, 'fetchStrict'> = {
  fetchStrict: <T>(path: string, method?: string, body?: string, timeoutMs?: number) => homePve().fetchStrict<T>(path, method, body, timeoutMs),
}

export function productionFwdProxy(): FwdProxyService {
  const executor = productionRemoteExecutor(homeFetch)
  const deps: FwdDeps = {
    store: wizardRecordStore(),
    guests: async () => (await listGuests(homePve())).filter(g => !g.template).map(g => ({ type: g.type, vmid: g.vmid, node: g.node, name: g.name, running: g.running, tags: g.tags })),
    exclusions: () => excludedMachineIds(),
    exec: async (g, script, timeoutMs) => {
      const m: Machine = { id: machineId({ type: 'lxc', vmid: g.vmid }), kind: 'lxc', name: g.name, node: g.node, vmid: g.vmid, running: true }
      return executor.run(m, script, { timeoutMs, maxOutputBytes: 2_000_000 })
    },
    installs: async () => (await wizardStore().list('job').catch(() => [])).map(r => r.data as any).filter(j => j && typeof j.recipeId === 'string').map(j => ({
      recipeId: j.recipeId, vmid: Number(j.vmid), status: String(j.status ?? ''),
      ...(typeof j.hostname === 'string' ? { hostname: j.hostname } : {}),
      ...(typeof j.ip === 'string' ? { ip: j.ip } : {}),
      ...(j.vaultItem && typeof j.vaultItem.provider === 'string' ? { vaultItem: { category: String(j.vaultItem.category), provider: String(j.vaultItem.provider) } } : {}),
    })),
    vault: {
      read: (c, p) => getProviderCredentials(c, p),
      set: (c, p, k, v) => setCredential(c, p, k, v, true),
      delete: (c, p, k) => deleteCredential(c, p, k),
    },
    audit: (a, r, d) => auditOrThrow(a, r, d),
    // Fails loudly when unset: the dismissal is what keeps auto-connect from adding it back.
    dismissed: async (key, label, by) => {
      if (!dismissedPort) throw new Error('Auto-connect is not running, so the disconnect could not be remembered.')
      await dismissedPort(key, label, by)
    },
    now: () => Date.now(),
  }
  return new FwdProxyService(deps)
}

let svc: FwdProxyService | null = null
export function fwdProxyService(): FwdProxyService { return svc ?? (svc = productionFwdProxy()) }
export function setFwdProxyService(s: FwdProxyService | null): void { svc = s }

export function installFwdProxyPluginTransport(): void {
  setPluginTransport(PROXY_ID, async (method, path) => {
    if (method !== 'GET') throw new Error('The 3proxy plug-in card only reads.')
    if (path === '/readings') return fwdProxyService().readings()
    throw new Error('That is not something the 3proxy plug-in may read.')
  })
}

installFwdProxyPluginTransport()
