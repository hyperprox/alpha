// =============================================================================
//  HyperProx — Homepage: the live wiring
//
//  Where the service's records live (the Catalogue's small table, one row per
//  dashboard), how it reaches a guest (the remote executor), where the
//  inventory comes from (the shared scan, the Catalogue, site discovery, the
//  plug-ins), where a widget's key comes from (the vault: plug-in settings, or
//  the token made for Homepage), and the plug-in card's read-only transport.
// =============================================================================

import os from 'node:os'
import { wizardStore } from '../catalogue-store'
import { productionRemoteExecutor } from '../remote/executor'
import { homePve } from '../pve-env'
import { auditOrThrow } from '../audit'
import { getCredential, setCredential, deleteCredential } from '../credentials'
import { getSettings, pluginConfigured, setPluginTransport } from '../plugin-host'
import { sharedServiceScan } from '../service-scan'
import { configAddresses, liveAddresses } from '../wizard-placement'
import { isProbeAddress } from '@hyperprox/hardware/service-probes'
import { listSites } from '../sites'
import { buildInventory, type InventorySources, type RawPlugin } from './inventory'
import { HomepageService, type HomepageDeps, type HomepageInstance, type RecordStore } from './service'
import type { Inventory } from './types'

export { HomepageService, HomepageRefusal } from './service'
export type { HomepageInstance, Actor, Plan, Problem } from './service'

const ROW = 'homepage:'
export const VAULT_CATEGORY = 'homepage'

/** One row per dashboard in the Catalogue's table (kind 'setting'). */
export const wizardRecordStore = (): RecordStore => ({
  async get(id) { const r = await wizardStore().get(ROW + id); return r && r.kind === 'setting' ? r.data as HomepageInstance : null },
  async put(i) { await wizardStore().put({ id: ROW + i.id, kind: 'setting', owner: i.addedBy, data: i, expiresAt: null }) },
  async list() { return (await wizardStore().list('setting')).filter(r => r.id.startsWith(ROW)).map(r => r.data as HomepageInstance) },
  async delete(id) { await wizardStore().delete(ROW + id) },
})

let exclusionSource: (() => Promise<string[]>) | null = null
/** Remote access's "never look inside" list; the routes set it (it lives in Postgres). */
export function setHomepageExclusionSource(fn: (() => Promise<string[]>) | null): void { exclusionSource = fn }

/** Late-bound so this module does not load the route modules it reads from at import time. */
const lazy = {
  detected: async (refresh: boolean) => (await import('../../routes/catalogue')).catalogueDetected(refresh),
  candidates: async () => (await (await import('../../routes/site-metrics')).sharedCandidateCache().get(false)).candidates,
  plugins: async () => (await import('../../plugins')).PLUGINS,
  pbs: async () => (await import('../pbs')).pbsService().instances.views(),
  qnap: async () => {
    const q = (await import('../qnap')).qnapService()
    return (await q.instances.views()).map(v => ({ ...v, remote: !!v.clusterId && q.instances.cluster(v.clusterId)?.kind === 'remote' }))
  },
}

/** This machine's first private address: HyperProx's front door is https on it. */
function selfUrl(): string | null {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (!a.internal && a.family === 'IPv4' && isProbeAddress(a.address)) return `https://${a.address}`
  }
  return null
}

export function liveSources(): InventorySources {
  const pve = () => homePve()
  const enc = encodeURIComponent
  return {
    guests: async () => ((await pve().getClusterResources('vm')) ?? []) as any[],
    addresses: async g => {
      const fromConfig = configAddresses(await pve().getVMConfig(g.node, g.vmid, g.type).catch(() => null)).filter(isProbeAddress)
      if (fromConfig.length) return fromConfig
      const live = await pve().fetchStrict<unknown>(g.type === 'lxc' ? `/nodes/${enc(g.node)}/lxc/${g.vmid}/interfaces` : `/nodes/${enc(g.node)}/qemu/${g.vmid}/agent/network-get-interfaces`, 'GET', undefined, 5000).catch(() => null)
      return [...new Set(liveAddresses(live).filter(isProbeAddress))]
    },
    scan: async () => (await sharedServiceScan().result(false)).findings.map(f => ({ key: f.key, address: f.address, guest: f.guest ? { vmid: f.guest.vmid, name: f.guest.name, node: f.guest.node, type: f.guest.type } : null })),
    detected: () => lazy.detected(false),
    candidates: () => lazy.candidates(),
    installs: async () => (await wizardStore().list('job')).map(r => r.data).filter(Boolean),
    sites: async () => (await listSites()).map(s => ({ name: s.name, recipeId: s.recipeId, url: s.url, localUrl: s.localUrl, vmid: s.vmid })),
    plugins: async () => {
      const out: RawPlugin[] = []
      for (const p of await lazy.plugins()) {
        const stored = await getSettings(p.manifest.id).catch(() => ({} as Record<string, string>))
        const secret = new Set(p.manifest.settings.filter(s => s.type === 'secret').map(s => s.key))
        const settings = Object.fromEntries(Object.entries(stored).filter(([k]) => !secret.has(k)))
        const addressSettings = [
          { key: p.manifest.baseUrlSetting, endpoint: null },
          ...(p.manifest.endpoints ?? []).map(e => ({ key: e.baseUrlSetting, endpoint: e.key })),
          ...p.manifest.settings.filter(s => s.type === 'url').map(s => ({ key: s.key, endpoint: null })),
        ].filter((x, i, a) => a.findIndex(y => y.key === x.key) === i)
        out.push({ id: p.manifest.id, name: p.manifest.name, configured: await pluginConfigured(p, stored).catch(() => false), settings, addressSettings })
      }
      return out
    },
    instances: async () => {
      const [pbs, qnap] = await Promise.all([lazy.pbs().catch(() => []), lazy.qnap().catch(() => [])])
      return [...pbs.map((v: any) => ({ key: 'pbs', name: String(v.name ?? ''), url: String(v.url ?? '') })), ...qnap.map((v: any) => ({ key: 'qnap', name: String(v.name ?? ''), url: String(v.url ?? ''), remote: !!v.remote }))].filter(x => x.url)
    },
    exclusions: async () => (exclusionSource ? exclusionSource() : []),
    self: async () => ({
      hyperprox: selfUrl(),
      proxmox: process.env.PROXMOX_HOST ? `https://${process.env.PROXMOX_HOST}:${Number(process.env.PROXMOX_PORT ?? 8006)}` : null,
    }),
  }
}

const INVENTORY_TTL_MS = 2 * 60_000
let cached: { at: number; inv: Inventory } | null = null
let building: Promise<Inventory> | null = null
async function inventory(refresh: boolean): Promise<Inventory> {
  if (cached && !refresh && Date.now() - cached.at < INVENTORY_TTL_MS) return cached.inv
  if (building) return building
  building = buildInventory(liveSources()).then(inv => { cached = { at: Date.now(), inv }; return inv }).finally(() => { building = null })
  return building
}

/** Where Homepage was seen: Catalogue installs, the shared scan, the install marker, a proxy host's fingerprint. */
async function sightings(): Promise<Array<{ vmid: number; url: string | null; via: 'catalogue' | 'scan' | 'marker' | 'proxy' }>> {
  const out: Array<{ vmid: number; url: string | null; via: 'catalogue' | 'scan' | 'marker' | 'proxy' }> = []
  const jobs = (await wizardStore().list('job').catch(() => [])).map(r => r.data).filter((j: any) => j?.recipeId === 'homepage' && j.status === 'completed' && j.vmid)
  for (const j of jobs) out.push({ vmid: Number(j.vmid), url: j.url ?? null, via: 'catalogue' })
  for (const f of (await sharedServiceScan().result(false).catch(() => ({ findings: [] as any[] }))).findings) {
    if (f.key === 'homepage' && f.guest) out.push({ vmid: Number(f.guest.vmid), url: f.address, via: 'scan' })
  }
  const det = await lazy.detected(false).catch(() => null)
  for (const r of det?.apps?.homepage ?? []) if (r.guest) out.push({ vmid: Number(r.guest.vmid), url: r.publicUrl ?? r.url ?? null, via: r.publicUrl ? 'proxy' : 'scan' })
  // A container the Catalogue made says so in its notes, even after its install record has been pruned.
  const guests = ((await homePve().getClusterResources('vm').catch(() => [])) ?? []) as any[]
  await Promise.all(guests.filter(g => g.type === 'lxc' && g.status === 'running' && g.template !== 1).map(async g => {
    const cfg = await homePve().getVMConfig(g.node, Number(g.vmid), 'lxc').catch(() => null)
    const desc = decodeURIComponent(String(cfg?.description ?? ''))
    if (/^Homepage, installed by HyperProx/m.test(desc) && /hyperprox-install:/.test(desc)) out.push({ vmid: Number(g.vmid), url: null, via: 'marker' })
  }))
  return out
}

async function pluginSecret(plugin: string, setting: string): Promise<string | null> {
  return (await getSettings(plugin))[setting] ?? null
}

let svc: HomepageService | null = null

export function productionHomepage(): HomepageService {
  const store = wizardRecordStore()
  const exec = productionRemoteExecutor()
  const deps: HomepageDeps = {
    store,
    exec,
    inventory,
    sightings,
    secret: async (src, instanceId) => {
      if (src.kind === 'plugin') return pluginSecret(src.plugin, src.setting)
      if (src.part === 'id') return (await store.get(instanceId))?.proxmoxToken?.tokenId ?? null
      return getCredential(VAULT_CATEGORY, instanceId, 'proxmox_token_secret')
    },
    proxmox: {
      async createAuditorToken(name, comment) {
        const user = process.env.PROXMOX_USER
        if (!user) throw new Error('HyperProx has no Proxmox user configured, or it is locked.')
        const made = await homePve().fetchStrict<any>(`/access/users/${encodeURIComponent(user)}/token/${encodeURIComponent(name)}`, 'POST', new URLSearchParams({ privsep: '1', comment }).toString())
        const tokenId = String(made?.['full-tokenid'] ?? `${user}!${name}`)
        const secret = String(made?.value ?? '')
        if (!secret) throw new Error('Proxmox made the token but returned no secret.')
        try {
          await homePve().fetchStrict('/access/acl', 'PUT', new URLSearchParams({ path: '/', roles: 'PVEAuditor', tokens: tokenId, propagate: '1' }).toString())
        } catch (e) {
          await homePve().fetchStrict(`/access/users/${encodeURIComponent(user)}/token/${encodeURIComponent(name)}`, 'DELETE').catch(() => {})
          throw e
        }
        return { tokenId, secret }
      },
      async revokeToken(tokenId) {
        const m = /^([^!]+)!([A-Za-z0-9_.-]+)$/.exec(tokenId)
        if (!m) throw new Error('Not a token id HyperProx made.')
        await homePve().fetchStrict(`/access/users/${encodeURIComponent(m[1])}/token/${encodeURIComponent(m[2])}`, 'DELETE')
      },
      async saveSecret(instanceId, secret) {
        if (secret === null) await deleteCredential(VAULT_CATEGORY, instanceId, 'proxmox_token_secret').catch(() => {})
        else await setCredential(VAULT_CATEGORY, instanceId, 'proxmox_token_secret', secret, true)
      },
    },
    audit: (a, r, d) => auditOrThrow(a, r, d),
    now: () => Date.now(),
    log: m => console.warn(m),
  }
  return new HomepageService(deps)
}

export function homepageService(): HomepageService { return svc ?? (svc = productionHomepage()) }
export function setHomepageService(s: HomepageService | null): void { svc = s }

/** A Catalogue install finished or a proxy host changed: auto-sync looks again soon (when it is on). */
export function homepageInventoryChanged(): void {
  cached = null
  try { svc?.inventoryChanged() } catch { /* not started */ }
}

export function installHomepagePluginTransport(): void {
  setPluginTransport('homepage', async (method, path) => {
    if (method !== 'GET') throw new Error('The Homepage plug-in card only reads.')
    if (path === '/readings') return homepageService().readings()
    throw new Error('That is not something the Homepage plug-in may read.')
  })
}

installHomepagePluginTransport()
