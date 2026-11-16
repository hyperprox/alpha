// =============================================================================
//  HyperProx — K3s: production wiring and the plug-in's transport
//
//  The plug-in (plugins/k3s.ts) declares coreTransport: its credentials never
//  pass through the generic plug-in broker. This module is its only transport,
//  GET only, one fixed path.
//
//  A script in a guest (reading K3s's admin login, for auto-connect) goes the
//  way the Nextcloud page's do: through the remote executor (the node's login,
//  then pct exec or the guest agent), with the guest list and Remote access's
//  "never look inside" list read every time and failing closed, so a guest
//  HyperProx must leave alone (lib/guest-guard.ts) is never entered.
//
//  Home cluster only, for the same reason as Nextcloud: the plug-in is not in
//  the remote allowlist, and its background work runs outside any request.
// =============================================================================

import { setPluginTransport } from '../plugin-host'
import { getCredential, setCredential, setCredentials, deleteProviderCredentials } from '../credentials'
import { auditOrThrow } from '../audit'
import { homePve } from '../pve-env'
import { productionRemoteExecutor } from '../remote/executor'
import type { ProxmoxClient } from '../proxmox-client'
import { GuestExcludedRefusal, IGNORE_TAG, excludedMachineIds, guestExcluded } from '../guest-guard'
import type { Machine } from '../remote/types'
import { machineId } from '../guest-id'
import { listGuests } from '../pve/guests'
import { sightingsOf } from '../catalogue/sightings'
import { K3sInstanceStore } from './instances'
import { K3sService, type GuestRow, type Sighting } from './service'
import { READ_LOGIN_SCRIPT } from './accounts'
import { K3S_RECIPE_ID } from './recipe'
import type { GuestRef } from './instances'

async function guestRows(): Promise<GuestRow[]> {
  const rows = await listGuests(homePve())
  const ids = await excludedMachineIds().catch(() => null)
  return rows.filter(r => !r.template).map(r => {
    const why = guestExcluded({ kind: r.type, vmid: r.vmid, tags: r.tags }, { excludedMachines: ids ?? [] })
    return { kind: r.type, vmid: r.vmid, name: r.name, node: r.node, running: r.running, ignored: !!why || ids === null, excludedBy: why ?? (ids === null ? 'Remote access\'s list could not be read' : null) }
  })
}

/** Where a Kubernetes API answered (the shared scan's k3s probe) and the Catalogue's finished K3s servers. */
export async function sightings(): Promise<Sighting[]> {
  const { scan, catalogue } = await sightingsOf(K3S_RECIPE_ID, 'k3s', { guests: async () => guestRows().catch(() => []), minVmid: 100, ignoreScanFailure: true })
  return [
    ...scan.map(s => ({ guest: { kind: s.guest.type, vmid: s.guest.vmid }, url: s.url, ip: s.ip, via: 'the service scan' })),
    ...catalogue.map(s => ({ guest: { kind: 'lxc' as const, vmid: s.guest.vmid }, url: s.url, ip: s.ip, via: 'a Catalogue install' })),
  ]
}

/** Run the read-only login script in a guest: the guest list and the exclusion list read now, failing closed. */
export function readLoginVia(d: { guests: () => Promise<GuestRow[]>; run: (m: Machine, script: string) => Promise<{ code: number; output: string }> }) {
  return async (g: GuestRef): Promise<string> => {
    const row = (await d.guests()).find(r => r.kind === g.kind && r.vmid === g.vmid)
    if (!row) throw new Error(`${g.kind === 'lxc' ? 'Container' : 'VM'} ${g.vmid} was not found.`)
    if (row.ignored) throw new GuestExcludedRefusal(row.name, row.excludedBy ?? `the ${IGNORE_TAG} tag`)
    if (!row.running) throw new Error(`${row.name} is not running.`)
    const m: Machine = { id: machineId({ type: g.kind, vmid: g.vmid }), kind: g.kind, name: row.name, node: row.node, vmid: g.vmid, running: true }
    const r = await d.run(m, READ_LOGIN_SCRIPT)
    if (r.code !== 0) throw new Error(`Reading K3s's login in ${row.name} exited ${r.code}.`)
    return r.output
  }
}

/** The newest stable K3s: where update.k3s.io's stable channel redirects to. */
export async function latestStableK3s(): Promise<string | null> {
  const r = await fetch('https://update.k3s.io/v1-release/channels/stable', { redirect: 'manual', headers: { 'user-agent': 'HyperProx-update-check/1' }, signal: AbortSignal.timeout(8000) })
  const loc = r.headers.get('location') ?? ''
  const m = /\/tag\/(v\d+\.\d+\.\d+(?:%2B|\+)k3s\d+)$/.exec(loc)
  return m ? decodeURIComponent(m[1]) : null
}

export type K3sDismissedPort = (key: string, label: string, by: string) => Promise<void>
let dismissedPort: K3sDismissedPort | null = null
/** Set once by lib/services/bootstrap.ts (importing lib/auto-connect here would close an import cycle). */
export function setK3sDismissedPort(fn: K3sDismissedPort | null): void { dismissedPort = fn }

const homeFetch: Pick<ProxmoxClient, 'fetchStrict'> = {
  fetchStrict: <T>(path: string, method?: string, body?: string, timeoutMs?: number) => homePve().fetchStrict<T>(path, method, body, timeoutMs),
}

export function productionK3s(): K3sService {
  const executor = productionRemoteExecutor(homeFetch)
  return new K3sService({
    store: new K3sInstanceStore({ get: getCredential, set: setCredential, setMany: setCredentials, remove: deleteProviderCredentials }),
    audit: (action, resource, details) => auditOrThrow(action, resource, details),
    latestStable: latestStableK3s,
    guests: guestRows,
    sightings,
    readLogin: readLoginVia({ guests: guestRows, run: (m, script) => executor.run(m, script, { timeoutMs: 60_000, maxOutputBytes: 256 * 1024 }) }),
    dismissed: async (key, label, by) => {
      if (!dismissedPort) throw new Error('Auto-connect is not running, so the removal could not be remembered.')
      await dismissedPort(key, label, by)
    },
  })
}

let service: K3sService | null = null
export function k3sService(): K3sService {
  if (!service) service = productionK3s()
  return service
}
/** For tests. */
export function setK3sService(s: K3sService | null): void { service = s }

export function installK3sPluginTransport(): void {
  setPluginTransport('k3s', async (method, path) => {
    if (method !== 'GET') throw new Error('The K3s plug-in only reads.')
    if (path === '/readings') return k3sService().allTiles()
    throw new Error('That is not something the K3s plug-in may read.')
  })
}

installK3sPluginTransport()
