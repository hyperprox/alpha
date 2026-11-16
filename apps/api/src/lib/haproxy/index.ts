// =============================================================================
//  HyperProx — HAProxy: production wiring and the plug-in's transport
//
//  Scripts reach the guest through the remote executor (lib/remote/executor.ts):
//  the node's own login, then pct exec (a container) or the guest agent (a VM),
//  the script on stdin. A guest HyperProx must leave alone is never entered;
//  the executor refuses it as well.
//
//  Saved changes go through the Proxy page's instance for the same HAProxy
//  (lib/proxy): its Data Plane login stays in the vault there, and its
//  transport reaches the API on the container's loopback.
//
//  Home cluster only, like Nextcloud: the guest lookups read the home cluster.
// =============================================================================

import { randomUUID } from 'node:crypto'
import { setPluginTransport } from '../plugin-host'
import { getCredential, setCredential } from '../credentials'
import { auditOrThrow } from '../audit'
import { homePve } from '../pve-env'
import { productionRemoteExecutor } from '../remote/executor'
import type { ProxmoxClient } from '../proxmox-client'
import { excludedMachineIds, guestExcluded } from '../guest-guard'
import type { Machine } from '../remote/types'
import { machineId } from '../guest-id'
import { listGuests } from '../pve/guests'
import { configAddresses } from '../wizard-placement'
import { sightingsOf } from '../catalogue/sightings'
import { HaproxyProvider } from '../proxy/providers/haproxy'
import { HaproxyInstanceStore } from './instances'
import { HaproxyService, type GuestRow } from './service'
import { tileNumbers, type Reading } from './model'
import { HAPROXY_RECIPE_ID, METRICS_PORT } from './recipe'
import { writeHaproxyTargets } from './targets'

const homeFetch: Pick<ProxmoxClient, 'fetchStrict'> = {
  fetchStrict: <T>(path: string, method?: string, body?: string, timeoutMs?: number) => homePve().fetchStrict<T>(path, method, body, timeoutMs),
}

let guestCache: { at: number; rows: GuestRow[] } | null = null

/** The home cluster's guests with their configured addresses, each marked when HyperProx must leave it alone. Cached 20 s. */
export async function guestRows(): Promise<GuestRow[]> {
  if (guestCache && Date.now() - guestCache.at < 20_000) return guestCache.rows
  const rows = (await listGuests(homePve())).filter(r => !r.template)
  const ids = await excludedMachineIds().catch(() => null)
  const out: GuestRow[] = []
  const queue = [...rows]
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      const why = ids === null ? 'Remote access\'s exclusion list (it could not be read)' : guestExcluded({ kind: r.type, vmid: r.vmid, tags: r.tags }, { excludedMachines: ids })
      const cfg = await homePve().fetchStrict<Record<string, unknown>>(`/nodes/${encodeURIComponent(r.node)}/${r.type}/${r.vmid}/config`).catch(() => null)
      out.push({ kind: r.type, vmid: r.vmid, name: r.name, node: r.node, running: r.running, excludedBy: why, addresses: configAddresses(cfg) })
    }
  }))
  out.sort((a, b) => a.vmid - b.vmid)
  guestCache = { at: Date.now(), rows: out }
  return out
}

export { ownScrapers } from './recipe'

type DismissedPort = (key: string, label: string, by: string) => Promise<void>
let dismissedPort: DismissedPort | null = null
/** Set once by lib/services/bootstrap.ts (importing lib/auto-connect here would close an import cycle). */
export function setHaproxyDismissedPort(fn: DismissedPort | null): void { dismissedPort = fn }

export function productionHaproxy(): HaproxyService {
  const executor = productionRemoteExecutor(homeFetch)
  const store = new HaproxyInstanceStore({ get: getCredential, set: setCredential })
  return new HaproxyService({
    store,
    exec: async (g, script, o = {}) => {
      const row = (await guestRows()).find(r => r.kind === g.kind && r.vmid === g.vmid)
      if (!row) throw new Error(`${g.kind === 'lxc' ? 'Container' : 'VM'} ${g.vmid} was not found.`)
      const m: Machine = { id: machineId({ type: g.kind, vmid: g.vmid }), kind: g.kind, name: row.name, node: row.node, vmid: g.vmid, running: row.running }
      return executor.run(m, script, { timeoutMs: o.timeoutMs, maxOutputBytes: 2_000_000 })
    },
    writer: async id => {
      const { proxyService } = await import('../proxy')
      const p = await proxyService().provider(id).catch(() => null)
      return p && p.provider instanceof HaproxyProvider ? p.provider : null
    },
    audit: (a, r, d) => auditOrThrow(a, r, d),
    guests: guestRows,
    sightings: async () => {
      const { scan, catalogue } = await sightingsOf(HAPROXY_RECIPE_ID, 'haproxy', { guests: async () => guestRows(), minVmid: 100, ignoreScanFailure: true })
      return [
        ...scan.map(s => ({ guest: { kind: s.guest.type, vmid: s.guest.vmid }, via: 'scan' as const })),
        ...catalogue.map(s => ({ guest: { kind: 'lxc' as const, vmid: s.guest.vmid }, via: 'catalogue' as const })),
      ]
    },
    proxyInstances: async () => {
      const { proxyService } = await import('../proxy')
      return (await proxyService().managedInstances()).filter(i => i.kind === 'haproxy').map(i => ({ id: i.id, name: i.name, vmid: i.managed.vmid }))
    },
    dismissed: async (key, label, by) => {
      if (!dismissedPort) throw new Error('Auto-connect is not running, so the removal could not be remembered.')
      await dismissedPort(key, label, by)
    },
  })
}

let service: HaproxyService | null = null
export function haproxyService(): HaproxyService {
  if (!service) service = productionHaproxy()
  return service
}
/** For tests. */
export function setHaproxyService(s: HaproxyService | null): void { service = s }

/**
 * Prometheus's HAProxy list: the instances whose metrics HyperProx can read, at their address: a Catalogue install (its
 * metrics frontend answers HyperProx) and one the service scan found by its metrics.
 */
export async function syncHaproxyTargets(svc = haproxyService()): Promise<boolean> {
  const rows = await guestRows().catch(() => [] as GuestRow[])
  const list = (await svc.store.list()).filter(i => i.via === 'catalogue' || i.via === 'scan')
  const entries = list.flatMap(i => {
    const ip = rows.find(r => r.kind === i.guest.kind && r.vmid === i.guest.vmid)?.addresses[0]
    return ip ? [{ id: i.id, name: i.name, target: `${ip}:${METRICS_PORT}` }] : []
  })
  const changed = writeHaproxyTargets(entries)
  if (changed) {
    const { prometheusBase } = await import('../service-health')
    await fetch(`${prometheusBase()}/-/reload`, { method: 'POST', signal: AbortSignal.timeout(10_000) }).catch(() => undefined)
  }
  return changed
}

export interface TileRow { id: string; name: string; numbers: ReturnType<typeof tileNumbers> | null; configOk: boolean | null; error: string | null }

export async function allTiles(svc = haproxyService()): Promise<TileRow[]> {
  const list = await svc.store.list()
  return Promise.all(list.map(async i => {
    try {
      const r: Reading = await svc.reading(i.id)
      return { id: i.id, name: i.name, numbers: tileNumbers(r), configOk: r.config.ok, error: null }
    } catch (e: any) { return { id: i.id, name: i.name, numbers: null, configOk: null, error: String(e?.message ?? 'Could not be read.').slice(0, 300) } }
  }))
}

export function installHaproxyPluginTransport(): void {
  setPluginTransport('haproxy', async (method, path) => {
    if (method !== 'GET') throw new Error('The HAProxy plug-in card only reads.')
    if (path === '/readings') return allTiles()
    throw new Error('That is not something the HAProxy plug-in may read.')
  })
}

installHaproxyPluginTransport()

/** A background publish's progress, for the page to show (lib/sites runPublish steps). */
export interface PublishJob { id: string; domain: string; status: 'running' | 'done' | 'failed'; steps: Array<{ id: string; label: string; status: string; detail?: string }>; error?: string; url?: string; owner: string }
export const PUBLISH_JOBS = new Map<string, PublishJob>()
export const newJobId = () => randomUUID()
