// =============================================================================
//  HyperProx — DNS blockers: production wiring and the plug-ins' transport
//
//  The Pi-hole and AdGuard Home plug-ins (plugins/dns-blocker.ts) declare coreTransport, so a login never passes through
//  the generic plug-in broker: this module is their only transport, GET only, one fixed path.
//
//  Scripts reach the guest the way the Nextcloud page's do (lib/remote/executor.ts): the node's own login, then pct exec,
//  the script on stdin. A guest HyperProx must leave alone (the hyperprox-ignore tag, or Remote access's "never look inside"
//  list: lib/guest-guard.ts) is never entered; the executor refuses it as well.
//
//  Home cluster only. The plug-ins are not in the remote allowlist (lib/clusters/context.ts), so a request naming another
//  cluster is answered before it reaches the routes; guest lookups read the home cluster by name (homePve).
//
//  Import note: lib/catalogue-installer imports the plug-in list, which imports this module, so the guest-DNS settings
//  (the Catalogue's naming settings) are loaded only when an action needs them.
// =============================================================================

import { setPluginTransport } from '../plugin-host'
import { getCredential, setCredential, deleteProviderCredentials } from '../credentials'
import { auditOrThrow } from '../audit'
import { homePve } from '../pve-env'
import { productionRemoteExecutor } from '../remote/executor'
import type { ProxmoxClient } from '../proxmox-client'
import { GuestExcludedRefusal, IGNORE_TAG, excludedMachineIds, guestExcluded } from '../guest-guard'
import type { Machine } from '../remote/types'
import { machineId } from '../guest-id'
import { listGuests } from '../pve/guests'
import { sightingsOf } from '../catalogue/sightings'
import { DnsInstanceStore } from './instances'
import { DnsBlockerService, type GuestRow, type NamingPort, type ServiceDeps, type Sighting } from './service'
import { productionProbe } from './client'
import { ADGUARD_RECIPE_ID, PIHOLE_RECIPE_ID } from './recipes'
import { DNS_KINDS, type DnsKind, type DnsReading, type GuestRef, type TileRow } from './types'

export const RECIPE_OF: Record<DnsKind, string> = { pihole: PIHOLE_RECIPE_ID, adguard: ADGUARD_RECIPE_ID }
/** The service scan's key for each (packages/hardware/service-probes.js). */
export const SCAN_KEY: Record<DnsKind, string> = { pihole: 'pihole', adguard: 'adguard' }

async function guestRows(excluded?: string[] | null): Promise<GuestRow[]> {
  const rows = await listGuests(homePve())
  const ids = excluded === undefined ? await excludedMachineIds().catch(() => null) : excluded
  return rows.filter(r => !r.template).map(r => {
    const why = guestExcluded({ kind: r.type, vmid: r.vmid, tags: r.tags }, { excludedMachines: ids ?? [] })
    return { kind: r.type, vmid: r.vmid, name: r.name, node: r.node, running: r.running, ignored: !!why, excludedBy: why }
  })
}

/** Where this blocker was seen without looking inside a guest: the shared scan, and the Catalogue's finished installs. */
async function sightings(kind: DnsKind): Promise<Sighting[]> {
  const { scan, catalogue } = await sightingsOf(RECIPE_OF[kind], SCAN_KEY[kind], {
    guests: async () => (await guestRows().catch(() => [] as GuestRow[])).filter(g => g.kind === 'lxc'),
    minVmid: 100,
    ignoreScanFailure: true,
  })
  return [
    ...scan.map(s => ({ guest: { kind: s.guest.type, vmid: s.guest.vmid }, url: s.url, via: 'scan', ip: s.ip })),
    ...catalogue.map(s => ({ guest: { kind: 'lxc' as const, vmid: s.guest.vmid }, url: s.url, via: 'catalogue', ip: s.ip, admin: s.admin })),
  ]
}

/** The same guard as the Nextcloud page: the guest list and Remote access's list read every time, failing closed. */
export function dnsExec(d: {
  guests: (excluded: string[] | null) => Promise<GuestRow[]>
  exclusions: () => Promise<string[]>
  executor: Pick<ReturnType<typeof productionRemoteExecutor>, 'run'>
}): NonNullable<ServiceDeps['exec']> {
  return async (g: GuestRef, script, o = {}) => {
    const row = (await d.guests(await d.exclusions())).find(r => r.kind === g.kind && r.vmid === g.vmid)
    if (!row) throw new Error(`${g.kind === 'lxc' ? 'Container' : 'VM'} ${g.vmid} was not found.`)
    if (row.ignored) throw new GuestExcludedRefusal(row.name, row.excludedBy ?? `the ${IGNORE_TAG} tag`)
    if (!row.running) throw new Error(`${row.name} is not running.`)
    const m: Machine = { id: machineId({ type: g.kind, vmid: g.vmid }), kind: g.kind, name: row.name, node: row.node, vmid: g.vmid, running: true }
    return d.executor.run(m, script, { timeoutMs: o.timeoutMs, maxOutputBytes: 200_000 })
  }
}

/** The naming settings (the DNS servers HyperProx gives guests it creates), loaded when first needed. */
const namingPort: NamingPort = {
  async read() {
    const { readNamingSettings } = await import('../catalogue-installer')
    return ((await readNamingSettings()) as any) ?? null
  },
  async save(settings, who) {
    const { saveNamingSettings } = await import('../catalogue-installer')
    const r = await saveNamingSettings(settings, who)
    return { errors: r.errors }
  },
}

/** Auto-connect's record of what a person disconnected, given by the composition root (lib/services/bootstrap.ts). */
export type DnsDismissedPort = (kind: DnsKind, key: string, label: string, by: string) => Promise<void>
let dismissedPort: DnsDismissedPort | null = null
export function setDnsBlockerDismissedPort(fn: DnsDismissedPort | null): void { dismissedPort = fn }

const homeFetch: Pick<ProxmoxClient, 'fetchStrict'> = {
  fetchStrict: <T>(path: string, method?: string, body?: string, timeoutMs?: number) => homePve().fetchStrict<T>(path, method, body, timeoutMs),
}

export function productionDnsBlocker(kind: DnsKind): DnsBlockerService {
  const executor = productionRemoteExecutor(homeFetch)
  return new DnsBlockerService({
    kind,
    store: new DnsInstanceStore(kind, { get: getCredential, set: setCredential, remove: deleteProviderCredentials }),
    audit: (action, resource, details) => auditOrThrow(action, resource, details),
    probe: productionProbe,
    guests: () => guestRows(),
    exec: dnsExec({ guests: guestRows, exclusions: excludedMachineIds, executor }),
    tags: async () => new Map((await listGuests(homePve(), { strict: false })).map(r => [machineId(r), r.tags])),
    sightings: () => sightings(kind),
    catalogueLogin: async vmid => {
      const provider = `${RECIPE_OF[kind]}-${vmid}`
      const password = await getCredential('apps', provider, 'admin_password').catch(() => null)
      if (!password) return null
      return { username: (await getCredential('apps', provider, 'admin_user').catch(() => null)) ?? null, password }
    },
    naming: namingPort,
    guestAddress: async g => {
      if (g.kind !== 'lxc') return null
      const row = (await guestRows()).find(r => r.kind === g.kind && r.vmid === g.vmid)
      if (!row) return null
      const cfg = await homePve().fetchStrict<Record<string, unknown>>(`/nodes/${encodeURIComponent(row.node)}/lxc/${g.vmid}/config`)
      const m = /(?:^|,)ip=(\d{1,3}(?:\.\d{1,3}){3})\//.exec(String(cfg?.net0 ?? ''))
      return m ? m[1] : null
    },
    dismissed: async (key, label, by) => {
      if (!dismissedPort) throw new Error('Auto-connect is not running, so the removal could not be remembered.')
      await dismissedPort(kind, key, label, by)
    },
  })
}

const services = new Map<DnsKind, DnsBlockerService>()
export function dnsBlockerService(kind: DnsKind): DnsBlockerService {
  let s = services.get(kind)
  if (!s) { s = productionDnsBlocker(kind); services.set(kind, s) }
  return s
}
/** For tests. */
export function setDnsBlockerService(kind: DnsKind, s: DnsBlockerService | null): void { if (s) services.set(kind, s); else services.delete(kind) }

/** What a viewer may see of a reading: no per-client numbers (names and addresses of the people on the network). */
export function viewerReading(r: DnsReading): DnsReading {
  return { ...r, clients: null, clientsHidden: true }
}

export async function allTiles(kind: DnsKind): Promise<TileRow[]> {
  const svc = dnsBlockerService(kind)
  const list = await svc.instances.list()
  return Promise.all(list.map(async (m): Promise<TileRow> => {
    try {
      const r = await svc.reading(m.id)
      return { id: m.id, name: m.name, kind, reading: { protection: r.protection, totals: r.totals, problems: r.problems, answering: r.answering }, error: null }
    } catch (e: any) { return { id: m.id, name: m.name, kind, reading: null, error: String(e?.message ?? 'Could not be read.').slice(0, 300) } }
  }))
}

export function installDnsPluginTransports(): void {
  for (const kind of DNS_KINDS) {
    setPluginTransport(kind, async (method, path) => {
      if (method !== 'GET') throw new Error('The DNS blocker plug-in only reads.')
      if (path === '/readings') return allTiles(kind)
      throw new Error('That is not something the DNS blocker plug-in may read.')
    })
  }
}

installDnsPluginTransports()
