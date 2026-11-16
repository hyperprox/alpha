// =============================================================================
//  HyperProx — the package cache: the live wiring
//
//  Records in the Catalogue's small table, the guests from the home cluster,
//  the cache's own commands through the remote executor and every guest's
//  through the Updates executor (both refuse a guest HyperProx must leave
//  alone, whatever the caller checked), the audit log (fail closed), and the
//  plug-in card's read-only transport. Home cluster only.
// =============================================================================

import { wizardStore } from '../catalogue-store'
import { productionRemoteExecutor } from '../remote/executor'
import { homePve } from '../pve-env'
import { auditOrThrow } from '../audit'
import { setPluginTransport } from '../plugin-host'
import { excludedMachineIds } from '../guest-guard'
import { listGuests } from '../pve/guests'
import { machineId } from '../guest-id'
import { clusterRow } from '../clusters/registry'
import type { Machine } from '../remote/types'
import type { ProxmoxClient } from '../proxmox-client'
import { AptCacheService, type AptCacheDeps, type ClientRegistry, type FleetTarget, type Store } from './service'
import { PLUGIN_ID, type CacheInstance, type CacheUseSetting } from './types'

export { AptCacheService, AptCacheRefusal } from './service'
export type { Problem, Actor, CacheDecision, ClientView, CacheView } from './service'
export * from './types'

const ROW = 'aptcache:'
const USE = 'aptcache-use:'
const CLIENTS = 'aptcache-clients'

const setting = async <T>(id: string): Promise<T | null> => { const r = await wizardStore().get(id); return r && r.kind === 'setting' ? r.data as T : null }
const putSetting = (id: string, owner: string, data: unknown) => wizardStore().put({ id, kind: 'setting', owner, data, expiresAt: null })

export const wizardAptCacheStore = (): Store => ({
  get: id => setting<CacheInstance>(ROW + id),
  async put(i) { await putSetting(ROW + i.id, i.addedBy, i) },
  async list() { return (await wizardStore().list('setting')).filter(r => r.id.startsWith(ROW)).map(r => r.data as CacheInstance) },
  async delete(id) { await wizardStore().delete(ROW + id) },
  getUse: id => setting<CacheUseSetting>(USE + id),
  async putUse(id, s) { await putSetting(USE + id, s.updatedBy ?? 'system', s) },
  async getClients() { return (await setting<ClientRegistry>(CLIENTS)) ?? {} },
  async putClients(r) { await putSetting(CLIENTS, 'system', r) },
})

/** The home cluster's API, resolved at each call (homePve throws while locked, so never at construction). */
const homeFetch: Pick<ProxmoxClient, 'fetchStrict'> = {
  fetchStrict: <T>(path: string, method?: string, body?: string, timeoutMs?: number) => homePve().fetchStrict<T>(path, method, body, timeoutMs),
}

export function productionAptCache(): AptCacheService {
  const executor = productionRemoteExecutor(homeFetch)
  // Late-bound: Updates' runtime reads this module (its runner asks decide()).
  const updates = async () => (await import('../updates/runtime')).updatesRuntime()
  const deps: AptCacheDeps = {
    store: wizardAptCacheStore(),
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
    audit: (a, r, d) => auditOrThrow(a, r, d),
    // Fails loudly when auto-connect is not running: the dismissal is what keeps it from adding the cache back.
    dismissed: async (key, label, by) => (await import('../auto-connect')).rememberDismissed(PLUGIN_ID, key, label, by),
    // The guests Updates puts apt on at home (running, apt on in its policy, not excluded there), and on request its
    // online nodes. Every command goes through Updates' own executor, which refuses a guest that must be left alone.
    fleet: async ({ nodes }) => {
      const s = (await updates()).get('home')
      const { guestPolicy } = await import('../updates/policy')
      const policy = s.loadPolicy().policy
      const out: FleetTarget[] = []
      for (const g of await s.exec.listGuests()) {
        if (!g.running || g.template) continue
        const p = guestPolicy(policy, g.vmid)
        if (p.excluded || !p.apt) continue
        out.push({ key: machineId({ type: g.type, vmid: g.vmid }), kind: 'guest', name: g.name || String(g.vmid), run: script => s.exec.guestExec(g, script, undefined, 60_000) })
      }
      if (nodes) {
        for (const n of (await s.exec.clusterStatus()).nodes.filter(x => x.online)) {
          out.push({ key: `node:${n.name}`, kind: 'node', name: n.name, run: script => s.exec.nodeExec(n.name, script, undefined, 60_000) })
        }
      }
      return out
    },
    updatesBusy: async () => !!(await (await updates()).store.activeJob()),
    isRemote: id => clusterRow(id)?.kind === 'remote',
    configAddress: async g => {
      const cfg = await homePve().fetchStrict<any>(`/nodes/${encodeURIComponent(g.node)}/lxc/${g.vmid}/config`)
      return staticAddress(cfg?.net0)
    },
    now: () => Date.now(),
  }
  return new AptCacheService(deps)
}

/** The static IPv4 address in a container's net0 line (ip=a.b.c.d/nn), or null for DHCP, none or anything else. */
export function staticAddress(net0: unknown): string | null {
  const m = /(?:^|,)ip=((?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3})\/\d{1,2}(?:,|$)/.exec(String(net0 ?? ''))
  return m && m[1].split('.').every(o => Number(o) <= 255) ? m[1] : null
}

let svc: AptCacheService | null = null
export function aptCacheService(): AptCacheService { return svc ?? (svc = productionAptCache()) }
export function setAptCacheService(s: AptCacheService | null): void { svc = s }

export function installAptCachePluginTransport(): void {
  setPluginTransport(PLUGIN_ID, async (method, path) => {
    if (method !== 'GET') throw new Error('The package cache plug-in card only reads.')
    if (path === '/readings') return aptCacheService().readings()
    throw new Error('That is not something the package cache plug-in may read.')
  })
}

installAptCachePluginTransport()
