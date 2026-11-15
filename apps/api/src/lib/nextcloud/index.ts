// =============================================================================
//  HyperProx — Nextcloud: production wiring and the plug-in's transport
//
//  The plug-in (plugins/nextcloud.ts) declares coreTransport, so its login
//  never passes through the generic plug-in broker: this module is its only
//  transport, GET only, one fixed path.
//
//  Scripts reach the guest the way the VPN page's do (lib/remote/executor.ts):
//  the node's own login, then pct exec (a container) or the guest agent (a
//  VM), the script on stdin. A guest tagged hyperprox-ignore is never entered.
// =============================================================================

import { setPluginTransport } from '../plugin-host'
import { getCredential, setCredential, deleteProviderCredentials } from '../credentials'
import { auditOrThrow } from '../audit'
import { livePve } from '../pve-env'
import { productionRemoteExecutor } from '../remote/executor'
import { IGNORE_TAG } from '../remote/service'
import type { Machine } from '../remote/types'
import { prismaPlacementStore } from '../placement/store'
import { NcInstanceStore } from './instances'
import { NextcloudService, type GuestRow } from './service'
import { ocsClient } from './ocs'
import { prismaJobStore } from './jobs'
import type { GuestRef } from './types'

async function guestRows(): Promise<GuestRow[]> {
  const rows = await livePve().fetchStrict<any[]>('/cluster/resources?type=vm')
  return (rows ?? []).filter(r => (r.type === 'lxc' || r.type === 'qemu') && r.template !== 1).map(r => ({
    kind: r.type, vmid: Number(r.vmid), name: String(r.name ?? r.vmid), node: String(r.node), running: r.status === 'running',
    ignored: String(r.tags ?? '').split(/[;,\s]+/).map(t => t.trim().toLowerCase()).includes(IGNORE_TAG),
  }))
}

/** A running vzdump of this guest (or a node-wide one that has not named its guest yet). Null when unreadable. */
export async function backupRunning(g: GuestRef): Promise<boolean | null> {
  try {
    const tasks = await livePve().fetchStrict<any[]>('/cluster/tasks')
    return (tasks ?? []).some(t => t?.type === 'vzdump' && !t.endtime && (t.status === undefined || t.status === null || t.status === '' || t.status === 'running')
      && (String(t.id ?? '') === String(g.vmid) || !t.id))
  } catch { return null }
}

/** A container with a bind mount cannot be snapshotted; the update's dump is then the only rollback. */
export async function snapshotNote(g: GuestRef): Promise<string | null> {
  if (g.kind !== 'lxc') return null
  try {
    const row = (await guestRows()).find(r => r.kind === 'lxc' && r.vmid === g.vmid)
    if (!row) return null
    const cfg = await livePve().fetchStrict<Record<string, unknown>>(`/nodes/${encodeURIComponent(row.node)}/lxc/${g.vmid}/config`)
    const binds = Object.entries(cfg ?? {}).filter(([k, v]) => /^mp\d+$/.test(k) && typeof v === 'string' && v.startsWith('/')).map(([k]) => k)
    return binds.length ? `This container has bind mounts (${binds.join(', ')}), so Proxmox cannot snapshot it. The database dump and the kept image are the rollback.` : null
  } catch { return null }
}

export function productionNextcloud(prisma?: unknown): NextcloudService {
  const executor = productionRemoteExecutor()
  return new NextcloudService({
    store: new NcInstanceStore({ get: getCredential, set: setCredential, remove: deleteProviderCredentials }),
    audit: (action, resource, details) => auditOrThrow(action, resource, details),
    guests: guestRows,
    exec: async (g, script, o = {}) => {
      const row = (await guestRows()).find(r => r.kind === g.kind && r.vmid === g.vmid)
      if (!row) throw new Error(`${g.kind === 'lxc' ? 'Container' : 'VM'} ${g.vmid} was not found.`)
      if (row.ignored) throw new Error(`${row.name} has the Proxmox tag ${IGNORE_TAG}; HyperProx never looks inside it.`)
      if (!row.running) throw new Error(`${row.name} is not running.`)
      const m: Machine = { id: `${g.kind}-${g.vmid}`, kind: g.kind, name: row.name, node: row.node, vmid: g.vmid, running: true }
      return executor.run(m, script, { timeoutMs: o.timeoutMs, onData: o.onData, maxOutputBytes: 8_000_000 })
    },
    ocs: l => ocsClient(l),
    quietHours: async () => {
      if (!prisma) return null
      const s = await prismaPlacementStore(prisma).settings()
      const nodes = await livePve().fetchStrict<any[]>('/cluster/status').catch(() => [])
      const first = (nodes ?? []).find((n: any) => n.type === 'node' && n.online === 1)?.name
      const t = first ? await livePve().fetchStrict<any>(`/nodes/${encodeURIComponent(first)}/time`).catch(() => null) : null
      return { busy: s.busyHours ?? [], tz: t?.timezone ? String(t.timezone) : null }
    },
    backupRunning,
    snapshotNote,
    ...(prisma ? { jobs: prismaJobStore(prisma) } : {}),
  })
}

let service: NextcloudService | null = null
let prismaRef: unknown
export function nextcloudService(prisma?: unknown): NextcloudService {
  if (prisma) prismaRef = prisma
  if (!service) {
    service = productionNextcloud(prismaRef)
    // A detached update that was running when the API last stopped is watched again; work that ran in the old
    // process is marked failed. Only with the database: without it there is nothing to resume.
    if (prismaRef) void service.resume().catch(() => {})
  }
  return service
}
/** For tests. */
export function setNextcloudService(s: NextcloudService | null): void { service = s }

export interface TileRow { id: string; name: string; version: string | null; update: string | null; counts: { error: number; warning: number; info: number } | null; error: string | null }

export async function allTiles(): Promise<TileRow[]> {
  const svc = nextcloudService()
  const list = await svc.instances.list()
  return Promise.all(list.map(async m => {
    try {
      const r = await svc.reading(m.id)
      return { id: m.id, name: m.name, version: r.status?.versionString ?? null, update: r.update.core, counts: r.counts, error: null }
    } catch (e: any) { return { id: m.id, name: m.name, version: null, update: null, counts: null, error: String(e?.message ?? 'Could not be read.').slice(0, 300) } }
  }))
}

export function installNextcloudPluginTransport(): void {
  setPluginTransport('nextcloud', async (method, path) => {
    if (method !== 'GET') throw new Error('The Nextcloud plug-in only reads.')
    if (path === '/readings') return allTiles()
    throw new Error('That is not something the Nextcloud plug-in may read.')
  })
}

installNextcloudPluginTransport()
