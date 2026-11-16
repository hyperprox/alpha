// =============================================================================
//  HyperProx — removed guests: the real reads and writes
//
//  The home cluster's Proxmox (one /cluster/resources read per look), the
//  records each feature keeps, and each feature's own way of forgetting one.
//  Nothing here invents a rule: a plug-in forgets through its own service, a
//  backup job changes through the Proxmox API, a published name goes through
//  the same clean-up a failed install uses.
// =============================================================================

import { homePve } from '../pve-env'
import { wizardStore } from '../catalogue-store'
import { auditOrThrow } from '../audit'
import { isUnlocked } from '../vault/state'
import { deleteCredential, deleteProviderCredentials, getCredential, listCredentialKeys } from '../credentials'
import { addressSettings, getSettings } from '../plugin-host'
import { sharedServiceScan } from '../service-scan'
import { listSites, forgetSite, cleanupPublish, realPublishDeps, type PublishLedger } from '../sites'
import { metricsStore } from '../site-metrics/store'
import { configAddresses } from '../wizard-placement'
import { PrismaRemoteStore, type RemoteStore } from '../remote/store'
import { providerFromVault } from '../remote/providers'
import { isProviderId } from '../remote/types'
import { prismaPlacementStore } from '../placement/store'
import { publish } from '../notify'
import { SETTING_SPECS } from '../auto-connect/settings-adapter'
import { hostOf, type HoldingDeps, type InstallRow, type LiveAddresses, type SiteRow } from './holdings'
import { EMPTY_SERVICE_STATE, RemovedGuestsService, probeGuestConfig, type RemovedGuestsDeps, type ServiceState, type TaskRow } from './service'
import type { Candidate, ClusterRead } from './detector'
import type { LogLike } from '../log-once'

const ROW = 'removed-guests:state'
const enc = encodeURIComponent
const form = (p: Record<string, string>) => new URLSearchParams(p).toString()

const lazy = {
  homepage: async () => (await import('../homepage')).homepageService(),
  homepageRecords: async () => (await import('../homepage')).wizardRecordStore(),
  nextcloud: async () => (await import('../nextcloud')).nextcloudService(),
  autoConnect: async () => (await import('../auto-connect')).autoConnect(),
  installer: async () => import('../catalogue-installer'),
  plugins: async () => (await import('../../plugins')).PLUGINS,
  placement: async (prisma: unknown) => (await import('../placement/production')).placementService(prisma),
  wireguard: async (prisma: unknown) => (await import('../../routes/vpn')).productionWireguard(prisma),
}

/** Each completed install's record as the clean-up reads it (a running one is never a removed guest's). */
async function installRows(): Promise<InstallRow[]> {
  const rows = await wizardStore().list('job')
  return rows.map(r => r.data).filter((j: any) => j && Number.isInteger(j.vmid) && j.status !== 'running').map((j: any): InstallRow => ({
    jobId: String(j.jobId), recipeId: String(j.recipeId ?? 'app'), vmid: Number(j.vmid), hostname: j.hostname ?? null, ip: typeof j.ip === 'string' ? j.ip : null,
    startedAt: Number(j.startedAt) || 0, owner: String(j.owner ?? ''), vaultItem: j.vaultItem ?? null,
    ledgers: [j.ledger, ...Object.values(j.arrLedgers ?? {})].filter((l: any): l is PublishLedger => !!l && (l.proxyHost || l.dnsRecord)),
  }))
}

async function siteRows(): Promise<SiteRow[]> {
  return (await listSites()).filter(s => s.jobId !== 'adopted').map(s => ({
    id: s.id, name: s.name, vmid: s.vmid, ip: s.ip ?? null, createdAt: s.createdAt, owner: s.owner, vault: s.vault ?? null, published: s.published ?? null,
  }))
}

async function backupJobs(): Promise<Array<{ id: string; vmid: string; schedule: string | null; comment: string | null }>> {
  const jobs = await homePve().fetchStrict<any[]>('/cluster/backup')
  if (!Array.isArray(jobs)) throw new Error('Proxmox did not return the backup jobs.')
  return jobs.filter(j => typeof j?.id === 'string').map(j => ({ id: j.id, vmid: String(j.vmid ?? ''), schedule: j.schedule ? String(j.schedule) : null, comment: j.comment ? String(j.comment) : null }))
}

async function haSids(): Promise<string[]> {
  const ha = await homePve().fetchStrict<any[]>('/cluster/ha/resources')
  if (!Array.isArray(ha)) throw new Error('Proxmox did not return the HA list.')
  return ha.map(r => String(r?.sid ?? '')).filter(Boolean)
}

const CREATE_TYPES = new Set(['vzcreate', 'qmcreate', 'vzrestore', 'qmrestore', 'qmclone', 'vzclone'])
let liveCache: { at: number; v: LiveAddresses } | null = null

/**
 * What guests use now: the hosts the last service scan saw on a guest, plus every current guest's configured address
 * (net0 ip=, ipconfig0 ip=), with when that scan was taken and when the newest guest was created or restored.
 * Kept a minute (the page reads it per removed guest). Throws when the guest list or a config cannot be read.
 */
async function liveAddresses(): Promise<LiveAddresses> {
  if (liveCache && Date.now() - liveCache.at < 60_000) return liveCache.v
  const scan = sharedServiceScan().peek()
  if (!scan) throw new Error('No service scan yet.')
  const hosts = new Set(scan.findings.filter(f => f.guest).map(f => hostOf(f.address)))
  const pve = homePve()
  const rows = await pve.fetchStrict<any[]>('/cluster/resources?type=vm')
  if (!Array.isArray(rows)) throw new Error('Proxmox returned no guest list.')
  for (const r of rows.filter(x => x && (x.type === 'lxc' || x.type === 'qemu'))) {
    const cfg = await pve.fetchStrict<Record<string, unknown>>(`/nodes/${enc(String(r.node))}/${r.type}/${Number(r.vmid)}/config`)
    for (const ip of configAddresses(cfg)) hosts.add(ip)
  }
  const tasks = await pve.fetchStrict<any[]>('/cluster/tasks').catch(() => null)
  const created = (Array.isArray(tasks) ? tasks : []).filter(t => CREATE_TYPES.has(String(t?.type))).map(t => Number(t.starttime) * 1000).filter(Number.isFinite)
  // Without the task log, "now" stands in: no scan is newer, so no address is matched.
  const newestGuestAt = Array.isArray(tasks) ? (created.length ? Math.max(...created) : null) : Date.now()
  const v = { hosts, scanAt: scan.builtAt, newestGuestAt }
  liveCache = { at: Date.now(), v }
  return v
}

export function productionHoldingDeps(prisma: unknown): HoldingDeps {
  const remoteStore = (): RemoteStore => new PrismaRemoteStore(prisma as any)
  return {
    homepage: {
      list: async () => (await (await lazy.homepageRecords()).list()).map(i => ({ id: i.id, kind: i.kind, vmid: i.vmid, name: i.name, addedAt: i.addedAt, token: i.proxmoxToken?.tokenId ?? null })),
      forget: async (id, by) => (await lazy.homepage()).forgetRemoved(id, by),
    },
    nextcloud: {
      list: async () => (await (await lazy.nextcloud()).instances.list()).map(m => ({ id: m.id, name: m.name, kind: m.guest.kind, vmid: m.guest.vmid, addedAt: Date.parse(m.addedAt) || 0 })),
      forget: async (id, by) => (await lazy.nextcloud()).forgetRemoved(id, by),
    },
    installs: {
      list: installRows,
      forget: async (jobId, by) => {
        await auditOrThrow('catalogue.install.forget_removed', `install:${jobId}`, { by })
        return (await lazy.installer()).forgetInstallRecord(jobId)
      },
    },
    sites: {
      list: siteRows,
      forget: async (id, by) => {
        const s = (await listSites()).find(x => x.id === id)
        if (!s) return 'The site record is already gone.'
        await auditOrThrow('site.forget_removed', `site:${id}`, { by, name: s.name })
        if (s.vault) await deleteProviderCredentials(s.vault.category, s.vault.provider)
        await forgetSite(id)
        await metricsStore().deleteSite(id)
        return `Removed ${s.name} from Sites with its metrics${s.vault ? ' and its vault item' : ''}.`
      },
    },
    autoConnect: {
      keys: async () => {
        const s = await (await lazy.autoConnect()).state()
        const out: Array<{ plugin: string; key: string; label: string; state: 'connected' | 'pending' | 'dismissed' }> = []
        const add = (rec: Record<string, { label: string }>, state: 'connected' | 'pending' | 'dismissed') => {
          for (const [k, v] of Object.entries(rec)) { const i = k.indexOf('/'); if (i > 0) out.push({ plugin: k.slice(0, i), key: k.slice(i + 1), label: v.label, state }) }
        }
        add(s.connected, 'connected'); add(s.pending, 'pending'); add(s.dismissed, 'dismissed')
        return out
      },
      forget: async entries => (await lazy.autoConnect()).forget(entries),
    },
    plugins: {
      addresses: async () => {
        const out: Array<{ plugin: string; pluginName: string; setting: string; value: string; also: string[] }> = []
        for (const p of await lazy.plugins()) {
          const stored = await getSettings(p.manifest.id)
          for (const a of addressSettings(p.manifest)) {
            const value = (stored[a.key] ?? '').trim()
            if (!value) continue
            // The name beside an Unmanic worker's address goes with it.
            const spec = Object.values(SETTING_SPECS).find(s => s.pluginId === p.manifest.id && s.urlSettings.includes(a.key))
            const label = spec?.labelSettings?.[spec.urlSettings.indexOf(a.key)]
            out.push({ plugin: p.manifest.id, pluginName: p.manifest.name, setting: a.key, value, also: [...a.secrets, ...(label ? [label] : [])].filter(k => stored[k]) })
          }
        }
        return out
      },
      clear: async (plugin, settings, by) => {
        await auditOrThrow('plugin.address.forget_removed', `plugin:${plugin}`, { by, settings })
        for (const k of settings) await deleteCredential('plugin', plugin, k)
      },
    },
    deck: {
      addresses: async () => {
        const out: Record<string, string> = {}
        for (const { key } of await listCredentialKeys('deck', 'address')) { const v = await getCredential('deck', 'address', key); if (v) out[key] = v }
        return out
      },
      forget: async hostId => deleteCredential('deck', 'address', hostId),
    },
    remote: {
      list: async () => (await remoteStore().list()).map(r => ({ machineId: r.machineId, provider: r.provider, deviceId: r.deviceId, adopted: r.adopted })),
      forget: async (machineId, provider, by) => {
        if (!isProviderId(provider)) throw new Error('Not a VPN provider.')
        const store = remoteStore()
        const r = await store.get(machineId, provider)
        if (!r) return 'Its Remote access record is already gone.'
        await store.audit('remote.forget_removed', machineId, { by, provider, deviceId: r.deviceId })
        let device = ''
        if (r.deviceId && !r.adopted) {
          const p = await providerFromVault(provider).catch(() => null)
          if (!p) device = ` Its device at ${provider} was kept: ${provider} is not set up now.`
          else {
            try { await p.deleteDevice(r.deviceId); device = ` Its device was removed from ${provider}.` }
            catch (e: any) { device = ` Its device at ${provider} could not be removed (${String(e?.message ?? e).slice(0, 120)}).` }
          }
        }
        await store.remove(machineId, provider)
        return `Remote access forgot its ${provider} client.${device}`
      },
    },
    wireguard: {
      list: async () => {
        const wg: any = await lazy.wireguard(prisma)
        const [servers, peers] = await Promise.all([wg.d.store.listServers(), wg.d.store.listPeers()])
        return { servers: servers.map((s: any) => ({ id: s.id, machineId: s.machineId, iface: s.iface })), peers: peers.map((p: any) => ({ id: p.id, machineId: p.machineId, name: p.name, serverId: p.serverId })) }
      },
      forgetMachine: async (machineId, by) => (await lazy.wireguard(prisma)).forgetMachine(machineId, by),
    },
    moves: {
      scheduled: async () => (await prismaPlacementStore(prisma).list({ status: ['scheduled'], limit: 200 })).map(m => ({ id: m.id, sid: m.sid, name: m.name })),
      cancel: async (id, by) => { await (await lazy.placement(prisma)).cancel(id, { email: by }) },
    },
    pve: {
      ha: haSids,
      removeHa: async sid => { await homePve().fetchStrict(`/cluster/ha/resources/${enc(sid)}?purge=1`, 'DELETE') },
      backupJobs,
      setJobVmids: async (id, vmids) => { await homePve().fetchStrict(`/cluster/backup/${enc(id)}`, 'PUT', form({ vmid: vmids.join(',') })) },
      deleteJob: async id => { await homePve().fetchStrict(`/cluster/backup/${enc(id)}`, 'DELETE') },
    },
    publish: { cleanup: (ledger, owner) => cleanupPublish(ledger, owner, realPublishDeps()) },
    liveAddresses,
    refreshScan: async () => { await sharedServiceScan().result(true); liveCache = null },
    audit: (a, r, d) => auditOrThrow(a, r, d),
  }
}

/** Every guest a HyperProx record or a backup job names. A source that cannot be read adds nothing this time. */
async function candidates(h: HoldingDeps): Promise<Candidate[]> {
  const out: Candidate[] = []
  const safe = async <T>(fn: () => Promise<T[]>): Promise<T[]> => fn().catch(() => [])
  for (const i of await safe(() => h.homepage.list())) out.push({ vmid: i.vmid, type: i.kind, name: i.name })
  for (const n of await safe(() => h.nextcloud.list())) out.push({ vmid: n.vmid, type: n.kind })
  for (const j of await safe(installRows)) out.push({ vmid: j.vmid, type: 'lxc', name: j.hostname, addresses: j.ip ? [j.ip.split('/')[0]] : [] })
  for (const s of await safe(siteRows)) out.push({ vmid: s.vmid, type: 'lxc', addresses: s.ip ? [s.ip.split('/')[0]] : [] })
  for (const j of await safe(backupJobs)) for (const v of String(j.vmid).split(',').map(x => Number(x.trim())).filter(n => Number.isInteger(n) && n > 0)) out.push({ vmid: v })
  for (const sid of await safe(haSids)) { const m = /^(ct|vm):(\d+)$/.exec(sid); if (m) out.push({ vmid: Number(m[2]), type: m[1] === 'ct' ? 'lxc' : 'qemu' }) }
  return out
}

export function productionRemovedGuests(prisma: unknown, log?: LogLike): RemovedGuestsService {
  const holdings = productionHoldingDeps(prisma)
  const deps: RemovedGuestsDeps = {
    store: {
      async get() {
        const r = await wizardStore().get(ROW)
        return { ...structuredClone(EMPTY_SERVICE_STATE), ...(r && r.kind === 'setting' ? (r.data as Partial<ServiceState>) : {}) } as ServiceState
      },
      async put(s) { await wizardStore().put({ id: ROW, kind: 'setting', owner: 'system', data: s, expiresAt: null }) },
    },
    async readCluster(): Promise<ClusterRead> {
      const at = Date.now()
      try {
        const rows = await homePve().fetchStrict<any[]>('/cluster/resources')
        if (!Array.isArray(rows)) return { ok: false, at, why: 'Proxmox returned no resource list.' }
        return {
          ok: true, at,
          nodes: rows.filter(r => r?.type === 'node').map(r => ({ name: String(r.node), online: r.status === 'online' })),
          guests: rows.filter(r => r && (r.type === 'lxc' || r.type === 'qemu') && Number.isInteger(Number(r.vmid))).map(r => ({ vmid: Number(r.vmid), type: r.type, name: String(r.name ?? r.vmid), node: String(r.node) })),
        }
      } catch (e: any) { return { ok: false, at, why: String(e?.message ?? e) } }
    },
    async tasks(): Promise<TaskRow[]> {
      const rows = await homePve().fetchStrict<any[]>('/cluster/tasks')
      if (!Array.isArray(rows)) throw new Error('Proxmox returned no task list.')
      return rows.map(t => ({ type: String(t?.type ?? ''), id: String(t?.id ?? ''), status: t?.status ? String(t.status) : undefined, starttime: Number(t?.starttime) || 0, endtime: t?.endtime ? Number(t.endtime) : undefined }))
    },
    probeConfig: (vmid, type, nodes) => probeGuestConfig(path => homePve().fetchStrict(path), vmid, type, nodes),
    candidates: () => candidates(holdings),
    scanAddresses: () => {
      const m = new Map<number, string[]>()
      for (const f of sharedServiceScan().peek()?.findings ?? []) if (f.guest) m.set(Number(f.guest.vmid), [...(m.get(Number(f.guest.vmid)) ?? []), hostOf(f.address)])
      return m
    },
    holdings,
    unlocked: () => isUnlocked(),
    publish: e => publish(e),
    log: m => log?.warn(m),
  }
  return new RemovedGuestsService(deps)
}
