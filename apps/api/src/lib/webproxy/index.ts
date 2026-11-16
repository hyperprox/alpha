// =============================================================================
//  HyperProx — the web proxies: the live wiring
//
//  Where the records live (the Catalogue's small table, one row per proxy),
//  how a guest is reached (the remote executor), where a proxy was seen (the
//  Catalogue's installs and detection, the install marker in a container's
//  notes), and the read-only transports of the three plug-in cards.
// =============================================================================

import { wizardStore } from '../catalogue-store'
import { productionRemoteExecutor } from '../remote/executor'
import { homePve } from '../pve-env'
import { auditOrThrow } from '../audit'
import { setPluginTransport } from '../plugin-host'
import { listGuests } from '../pve/guests'
import { sightingsOf } from '../catalogue/sightings'
import { WebProxyService, tileRow, type RecordStore, type Sighting, type WebProxyInstance } from './service'
import { KIND_NAME, WEB_PROXY_KINDS, type WebProxyKind } from './probes'

export { WebProxyService, WebProxyRefusal, assess, tileRow } from './service'
export type { WebProxyInstance, Reading, Problem, Action, Actor } from './service'
export { WEB_PROXY_KINDS, KIND_NAME, type WebProxyKind } from './probes'

const ROW = 'webproxy:'

export const wizardRecordStore = (): RecordStore => ({
  async get(id) { const r = await wizardStore().get(ROW + id); return r && r.kind === 'setting' ? r.data as WebProxyInstance : null },
  async put(i) { await wizardStore().put({ id: ROW + i.id, kind: 'setting', owner: i.addedBy, data: i, expiresAt: null }) },
  async list() { return (await wizardStore().list('setting')).filter(r => r.id.startsWith(ROW)).map(r => r.data as WebProxyInstance) },
  async delete(id) { await wizardStore().delete(ROW + id) },
})

let exclusionSource: (() => Promise<string[]>) | null = null
/** Remote access's "never look inside" list; lib/services/bootstrap.ts sets it (it lives in Postgres). */
export function setWebProxyExclusionSource(fn: (() => Promise<string[]>) | null): void { exclusionSource = fn }

export type DismissedPort = (plugin: WebProxyKind, machineId: string, label: string, by: string) => Promise<void>
let dismissedPort: DismissedPort | null = null
/** Set once by lib/services/bootstrap.ts (importing lib/auto-connect here would close an import cycle). */
export function setWebProxyDismissedPort(fn: DismissedPort | null): void { dismissedPort = fn }

const lazy = { detected: async () => (await import('../../routes/catalogue')).catalogueDetected(false) }

/** Where each kind was seen: Catalogue installs, the Catalogue's detection, and the install marker in a container's notes. */
async function sightings(): Promise<Sighting[]> {
  const out: Sighting[] = []
  const all = await listGuests(homePve(), { strict: false }).catch(() => [])
  for (const kind of WEB_PROXY_KINDS) {
    // The shared scan has no probe for these; the Catalogue's installs are what counts here.
    const seen = await sightingsOf(kind, `webproxy-${kind}`, { guests: async () => all.map(g => g.raw), minVmid: 1, ignoreScanFailure: true }).catch(() => ({ catalogue: [] as any[] }))
    for (const s of seen.catalogue) out.push({ kind, vmid: s.guest.vmid, via: 'catalogue' })
  }
  const det = await lazy.detected().catch(() => null)
  for (const kind of WEB_PROXY_KINDS) for (const r of det?.apps?.[kind] ?? []) if (r.guest) out.push({ kind, vmid: Number(r.guest.vmid), via: 'detect' })
  // A container the Catalogue made says so in its notes, even after its install record has been pruned.
  await Promise.all(all.filter(g => g.type === 'lxc' && g.running && !g.template).map(async g => {
    const cfg = await homePve().getVMConfig(g.node, g.vmid, 'lxc').catch(() => null)
    const desc = decodeURIComponent(String(cfg?.description ?? ''))
    if (!/hyperprox-install:/.test(desc)) return
    for (const kind of WEB_PROXY_KINDS) if (new RegExp(`^${KIND_NAME[kind]}, installed by HyperProx`, 'm').test(desc)) out.push({ kind, vmid: g.vmid, via: 'marker' })
  }))
  return out
}

let svc: WebProxyService | null = null

export function productionWebProxy(): WebProxyService {
  return new WebProxyService({
    store: wizardRecordStore(),
    exec: productionRemoteExecutor(),
    sightings,
    excluded: async () => {
      if (!exclusionSource) throw new Error('Remote access\'s exclusion list is not available.')
      return exclusionSource()
    },
    audit: (a, r, d) => auditOrThrow(a, r, d),
    // Fails loudly when unset: the dismissal is what keeps auto-connect from adding it back.
    dismissed: async (kind, machineId, label, by) => {
      if (!dismissedPort) throw new Error('Auto-connect is not running, so the disconnect could not be remembered.')
      await dismissedPort(kind, machineId, label, by)
    },
    now: () => Date.now(),
  })
}

export function webProxyService(): WebProxyService { return svc ?? (svc = productionWebProxy()) }
export function setWebProxyService(s: WebProxyService | null): void { svc = s }

/** The three gallery cards: read-only, one row per proxy of that kind. */
export function installWebProxyPluginTransports(): void {
  for (const kind of WEB_PROXY_KINDS) {
    setPluginTransport(kind, async (method, path) => {
      if (method !== 'GET') throw new Error(`The ${KIND_NAME[kind]} plug-in card only reads.`)
      if (path === '/readings') return (await webProxyService().readings(kind)).map(r => ({ ...tileRow(r), problems: r.problems.length, ok: r.ok }))
      throw new Error(`That is not something the ${KIND_NAME[kind]} plug-in may read.`)
    })
  }
}

installWebProxyPluginTransports()
