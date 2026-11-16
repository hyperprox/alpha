// =============================================================================
//  HyperProx — Nextcloud: production wiring and the plug-in's transport
//
//  The plug-in (plugins/nextcloud.ts) declares coreTransport, so its login
//  never passes through the generic plug-in broker: this module is its only
//  transport, GET only, one fixed path.
//
//  Scripts reach the guest the way the VPN page's do (lib/remote/executor.ts):
//  the node's own login, then pct exec (a container) or the guest agent (a
//  VM), the script on stdin. A guest HyperProx must leave alone (the
//  hyperprox-ignore tag, or Remote access's "never look inside" list:
//  lib/guest-guard.ts) is never entered; the executor refuses it as well.
// =============================================================================

import { setPluginTransport } from '../plugin-host'
import { getCredential, setCredential, deleteProviderCredentials } from '../credentials'
import { auditOrThrow } from '../audit'
import { livePve } from '../pve-env'
import { productionRemoteExecutor, type RemoteExecutor } from '../remote/executor'
import { GuestExcludedRefusal, IGNORE_TAG, excludedMachineIds, guestExcluded } from '../guest-guard'
import type { Machine } from '../remote/types'
import { prismaPlacementStore } from '../placement/store'
import { NcInstanceStore } from './instances'
import { NextcloudService, type GuestRow, type ServiceDeps } from './service'
import { ocsClient } from './ocs'
import { prismaJobStore } from './jobs'
import { publish } from '../notify'
import type { GuestRef, NcMeta } from './types'
import { registerComposeOwner } from '../compose-owners'
import { machineId } from '../guest-id'
import { listGuests } from '../pve/guests'
import { runningBackups } from '../pve/tasks'
import { sightingsOf } from '../catalogue/sightings'

/**
 * The guests, each marked `ignored` when HyperProx must leave it alone. `excluded`: Remote access's list, or null when
 * it could not be read (then only the tag marks a row; nothing is entered anyway, see exec below).
 */
async function guestRows(excluded?: string[] | null): Promise<GuestRow[]> {
  const rows = await listGuests(livePve())
  const ids = excluded === undefined ? await excludedMachineIds().catch(() => null) : excluded
  return rows.filter(r => !r.template).map(r => {
    const why = guestExcluded({ kind: r.type, vmid: r.vmid, tags: r.tags }, { excludedMachines: ids ?? [] })
    return { kind: r.type, vmid: r.vmid, name: r.name, node: r.node, running: r.running, ignored: !!why, excludedBy: why }
  })
}

/** A running vzdump of this guest (or a node-wide one that has not named its guest yet). Null when unreadable. */
export async function backupRunning(g: GuestRef): Promise<boolean | null> {
  const { read, rows } = await runningBackups(livePve())
  if (!read) return null
  return rows.some(b => b.id === String(g.vmid) || !b.id)
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

/**
 * Where Nextcloud was seen without looking inside a guest: the shared scan's Nextcloud probe (status.php) on a guest's
 * address, and the Catalogue's finished Nextcloud installs. Auto-connect detects in each (read-only) before adding it.
 */
export async function sightings(): Promise<Array<{ guest: GuestRef; url: string | null; via: string; admin?: string | null; ip?: string | null }>> {
  const { scan, catalogue } = await sightingsOf('nextcloud', 'nextcloud', {
    guests: async () => (await guestRows().catch(() => [] as GuestRow[])).filter(g => g.kind === 'lxc'),
    minVmid: 100,
  })
  return [
    ...scan.map(s => ({ guest: { kind: s.guest.type, vmid: s.guest.vmid }, url: s.url, via: 'scan', ip: s.ip })),
    ...catalogue.map(s => ({ guest: { kind: 'lxc' as const, vmid: s.guest.vmid }, url: s.url, via: 'catalogue', ip: s.ip, admin: s.admin })),
  ]
}

/**
 * How the plug-in runs a script in a guest: the guest list and Remote access's list read every time, failing closed,
 * so a person's detect, add or action never enters a guest HyperProx must leave alone (the executor refuses it too).
 */
export function nextcloudExec(d: {
  guests: (excluded: string[] | null) => Promise<GuestRow[]>
  exclusions: () => Promise<string[]>
  executor: Pick<RemoteExecutor, 'run'>
}): ServiceDeps['exec'] {
  return async (g, script, o = {}) => {
    const row = (await d.guests(await d.exclusions())).find(r => r.kind === g.kind && r.vmid === g.vmid)
    if (!row) throw new Error(`${g.kind === 'lxc' ? 'Container' : 'VM'} ${g.vmid} was not found.`)
    if (row.ignored) throw new GuestExcludedRefusal(row.name, row.excludedBy ?? `the ${IGNORE_TAG} tag`)
    if (!row.running) throw new Error(`${row.name} is not running.`)
    const m: Machine = { id: machineId({ type: g.kind, vmid: g.vmid }), kind: g.kind, name: row.name, node: row.node, vmid: g.vmid, running: true }
    return d.executor.run(m, script, { timeoutMs: o.timeoutMs, onData: o.onData, maxOutputBytes: 8_000_000 })
  }
}

export function productionNextcloud(prisma?: unknown): NextcloudService {
  const executor = productionRemoteExecutor()
  return new NextcloudService({
    store: new NcInstanceStore({ get: getCredential, set: setCredential, remove: deleteProviderCredentials }),
    audit: (action, resource, details) => auditOrThrow(action, resource, details),
    guests: () => guestRows(),
    exec: nextcloudExec({ guests: guestRows, exclusions: excludedMachineIds, executor }),
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
    sightings,
    dismissed: async (key, label, by) => (await import('../auto-connect')).rememberDismissed('nextcloud', key, label, by),
    alert: async (title, lines) => publish({ type: 'vault.nextcloud.app_password_left', severity: 'warning', title, lines, link: '/plugins/nextcloud', linkLabel: 'Open Nextcloud', where: 'Nextcloud page' }),
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

/**
 * The compose projects the Nextcloud page manages (lib/compose-owners.ts): Updates leaves them to its guarded update
 * (dump, maintenance mode, one major version at a time). An instance not detected yet covers its whole guest.
 */
export function nextcloudComposeProjects(list: () => Promise<NcMeta[]>) {
  return async () => (await list()).flatMap(m => {
    const d = m.deployment
    if (!d) return [{ vmid: m.guest.vmid, project: null, dir: null }]
    if (d.kind !== 'compose') return []
    const out = [{ vmid: m.guest.vmid, project: d.app?.project ?? null, dir: d.app?.workdir ?? null }]
    if (d.signaling?.project || d.signaling?.workdir) out.push({ vmid: m.guest.vmid, project: d.signaling.project ?? null, dir: d.signaling.workdir ?? null })
    // A compose deployment whose project could not be read: the whole guest, never nothing.
    return out.map(e => (e.project || e.dir ? e : { vmid: m.guest.vmid, project: null, dir: null }))
  })
}

/** Tell Updates which compose projects are the Nextcloud page's (the routes call it; returns the undo). */
export function registerNextcloudComposeOwner(): () => void {
  return registerComposeOwner('nextcloud', 'the Nextcloud page',
    nextcloudComposeProjects(() => new NcInstanceStore({ get: getCredential, set: setCredential, remove: deleteProviderCredentials }).list()))
}
