// =============================================================================
//  HyperProx — Homepage: everything HyperProx knows runs on the cluster
//
//  Read-only. Put together from what other parts of HyperProx already found, so
//  the dashboard cannot disagree with them:
//
//    guests          Proxmox's resource list, with tags and configured addresses
//    services        the shared service scan (lib/service-scan.ts), the
//                    Catalogue's "already here" (proxy-host fingerprints), the
//                    Catalogue's own install records, and the addresses saved in
//                    configured plug-ins (and their device lists)
//    proxy hosts     site discovery's candidates (each forward target matched to
//                    its guest), so a service gets its public address
//    websites        HyperProx's Websites section
//    exclusions      Remote access's "never look inside" list (the
//                    hyperprox-ignore tag is applied by the generator)
//
//  A source that cannot be read is named in `errors` and `failed`, and the rest still counts. Auto-sync never
//  writes from an inventory with a critical source missing (lib/homepage/service.ts).
// =============================================================================

import type { Candidate } from '../site-metrics/discovery'
import type { DetectResult } from '../catalogue-detect'
import { PROBES } from '@hyperprox/hardware/service-probes'
import { knownApp, appFromName } from './catalog'
import { hostPort } from './generate'
import type { GuestRef, InvGuest, InvService, Inventory, InvProxyHost, InvSite, InventorySourceId } from './types'

export interface RawGuest { vmid: number; name?: string; node: string; type: string; status: string; tags?: string; template?: number }
export interface RawFinding { key: string; address: string; guest: GuestRef | null }
export interface RawInstall { recipeId: string; status: string; url?: string; vmid?: number; node?: string; arrApps?: Array<{ id: string; name: string; url: string }> }
export interface RawPlugin {
  id: string; name: string; configured: boolean
  /** Non-secret settings only. */
  settings: Record<string, string>
  /** Settings that hold an address: the manifest's base URL, each endpoint's, and every `url` setting. */
  addressSettings: Array<{ key: string; endpoint: string | null }>
}
/** A plug-in's saved device. `remote`: it sits beside another cluster, so it is not on this one. */
export interface RawInstance { key: string; name: string; url: string; remote?: boolean }

/** What the inventory reads. The live sources are in lib/homepage/index.ts; tests pass fakes. */
export interface InventorySources {
  guests(): Promise<RawGuest[]>
  addresses(g: GuestRef): Promise<string[]>
  scan(): Promise<RawFinding[]>
  detected(): Promise<DetectResult>
  candidates(): Promise<Candidate[]>
  installs(): Promise<RawInstall[]>
  sites(): Promise<InvSite[]>
  plugins(): Promise<RawPlugin[]>
  instances(): Promise<RawInstance[]>
  exclusions(): Promise<string[]>
  /** HyperProx's own address (its front door) and the Proxmox web UI. */
  self(): Promise<{ hyperprox: string | null; proxmox: string | null }>
  now?(): number
}

const PROBE_BY_SETTING = new Map(PROBES.filter(p => p.pluginId && p.setting).map(p => [`${p.pluginId}:${p.setting}`, p.key]))

type Failed = { errors: string[]; failed: Set<InventorySourceId> }

async function attempt<T>(f: Failed, id: InventorySourceId, what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return (await fn()) ?? fallback } catch (e: any) { f.errors.push(`${what}: ${String(e?.message ?? e).slice(0, 160)}`); f.failed.add(id); return fallback }
}

function originOf(url: string): string | null {
  const hp = hostPort(url)
  return hp ? `${hp.scheme}://${hp.host.includes(':') ? `[${hp.host}]` : hp.host}:${hp.port}` : null
}

export async function buildInventory(src: InventorySources): Promise<Inventory> {
  const f: Failed = { errors: [], failed: new Set() }
  const errors = f.errors
  const raw = await attempt(f, 'guests', 'Proxmox guests', () => src.guests(), [] as RawGuest[])
  // A running guest whose addresses cannot be read could be on an excluded subnet: the guest list counts as failed.
  let addressFailures = 0
  const guests: InvGuest[] = await Promise.all(raw
    .filter(g => (g.type === 'lxc' || g.type === 'qemu') && g.template !== 1)
    .map(async g => {
      const ref: GuestRef = { vmid: Number(g.vmid), name: String(g.name ?? g.vmid), node: String(g.node), type: g.type as 'lxc' | 'qemu' }
      const addresses = g.status === 'running' ? await src.addresses(ref).catch(() => { addressFailures++; return [] as string[] }) : []
      return { ...ref, status: g.status, tags: String(g.tags ?? '').split(/[;,\s]+/).map(t => t.trim().toLowerCase()).filter(Boolean), addresses, machineId: `${ref.type}-${ref.vmid}` }
    }))
  if (addressFailures) { f.failed.add('guests'); errors.push(`Guest addresses: ${addressFailures} running guest${addressFailures === 1 ? '' : 's'} could not be read`) }
  const byVmid = new Map(guests.map(g => [g.vmid, g]))
  const byAddress = new Map<string, InvGuest>()
  for (const g of guests) for (const a of g.addresses) if (!byAddress.has(a)) byAddress.set(a, g)
  const ref = (g: InvGuest | undefined | null): GuestRef | null => g ? { vmid: g.vmid, name: g.name, node: g.node, type: g.type } : null
  const guestOf = (url: string, hint?: GuestRef | null): GuestRef | null => {
    if (hint) return ref(byVmid.get(Number(hint.vmid))) ?? hint
    const hp = hostPort(url)
    return hp ? ref(byAddress.get(hp.host)) : null
  }
  const running = (g: GuestRef | null) => !g || (byVmid.get(g.vmid)?.status ?? 'running') === 'running'

  const services: InvService[] = []
  const add = (s: InvService) => { if (running(s.guest ?? null)) services.push(s) }

  const [findings, detected, candidates, installs, sites, plugins, instances, excluded, self] = await Promise.all([
    attempt(f, 'scan', 'Service scan', () => src.scan(), [] as RawFinding[]),
    attempt(f, 'detected', 'Catalogue detection', () => src.detected(), { apps: {}, builtAt: 0, probed: 0, errors: [] } as DetectResult),
    attempt(f, 'proxies', 'Proxy hosts', () => src.candidates(), [] as Candidate[]),
    attempt(f, 'installs', 'Catalogue installs', () => src.installs(), [] as RawInstall[]),
    attempt(f, 'sites', 'Websites', () => src.sites(), [] as InvSite[]),
    attempt(f, 'plugins', 'Plug-ins', () => src.plugins(), [] as RawPlugin[]),
    attempt(f, 'instances', 'Plug-in devices', () => src.instances(), [] as RawInstance[]),
    attempt(f, 'exclusions', 'Remote access exclusions', () => src.exclusions(), [] as string[]),
    attempt(f, 'self', 'HyperProx address', () => src.self(), { hyperprox: null, proxmox: null }),
  ])

  if (self.proxmox) services.push({ key: 'proxmox', url: self.proxmox, source: 'cluster', guest: null })
  if (self.hyperprox) services.push({ key: 'hyperprox', url: self.hyperprox, source: 'self', guest: guestOf(self.hyperprox) })

  for (const j of installs) {
    if (j.status !== 'completed') continue
    const g = j.vmid ? ref(byVmid.get(Number(j.vmid))) : null
    if (j.vmid && !g) continue // the container is gone
    if (j.arrApps?.length) {
      for (const a of j.arrApps) { const o = originOf(a.url); if (o) add({ key: a.id, label: a.name.replace(/^Open\s+/i, '') || undefined, url: o, guest: g, source: 'install' }) }
      if (j.recipeId === 'arr-stack') continue
    }
    const o = j.url ? originOf(j.url) : null
    if (o && knownApp(j.recipeId)) add({ key: j.recipeId, url: o, guest: g, source: 'install' })
  }

  const pluginUrls: Record<string, string> = {}
  for (const p of plugins) {
    if (!p.configured) continue
    for (const s of p.addressSettings) { const o = p.settings[s.key] ? originOf(p.settings[s.key]) : null; if (o) pluginUrls[`${p.id}:${s.key}`] = o }
    for (const s of p.addressSettings) {
      const v = p.settings[s.key]
      const o = v ? originOf(v) : null
      if (!o) continue
      const probeKey = PROBE_BY_SETTING.get(`${p.id}:${s.key}`)
      const k = probeKey ?? (s.endpoint && knownApp(s.endpoint) ? s.endpoint : knownApp(p.id) ? p.id : null)
      if (!k) continue
      add({ key: k, url: o, guest: guestOf(o), source: 'plugin' })
    }
  }
  for (const i of instances) {
    if (i.remote) continue
    const o = originOf(i.url)
    if (o && knownApp(i.key)) add({ key: i.key, label: i.name || undefined, url: o, guest: guestOf(o), source: 'plugin' })
  }

  for (const [recipeId, list] of Object.entries(detected.apps ?? {})) {
    for (const r of list) {
      if (recipeId === 'wordpress' || recipeId === 'static-site' || recipeId === 'ghost') continue // Websites cover these
      const name = r.service ? appFromName(r.service.split(' ')[0])?.key ?? null : null
      const k = recipeId === 'arr-stack' ? name : (knownApp(recipeId)?.key ?? null)
      if (!k) continue
      const app = knownApp(k)
      const [host, port] = [r.target.replace(/:\d+$/, ''), Number(/:(\d+)$/.exec(r.target)?.[1] ?? 0)]
      const scheme = r.url ? hostPort(r.url)?.scheme ?? 'http' : (port === 443 || port === app?.port && app?.scheme === 'https' ? 'https' : 'http')
      const url = r.url ? originOf(r.url) : port ? `${scheme}://${host}:${port}` : null
      if (!url) continue
      add({ key: k, url, publicUrl: r.publicUrl ?? null, guest: guestOf(url, r.guest ? { vmid: r.guest.vmid, name: r.guest.name, node: r.guest.node, type: r.guest.type } : null), source: 'catalogue' })
    }
  }

  for (const f of findings) add({ key: f.key, url: f.address, guest: guestOf(f.address, f.guest), source: 'scan' })

  const proxyHosts: InvProxyHost[] = candidates
    .filter(c => c.source === 'proxy' && c.proxy)
    .map(c => ({ domains: c.domains, url: c.url, forward: { ...c.proxy!.forward, host: c.proxy!.forward.host.toLowerCase() }, guest: c.guest ? { vmid: c.guest.vmid, name: c.guest.name, node: c.guest.node, type: c.guest.type } : null }))
    .filter(p => !p.guest || running(p.guest))

  return { guests, services, proxyHosts, sites, excludedMachineIds: excluded, builtAt: (src.now ?? Date.now)(), errors, failed: [...f.failed], pluginUrls }
}

/** A short fingerprint of what the dashboard would be built from: auto-sync regenerates when it changes. */
export function inventoryFingerprint(inv: Inventory): string {
  const parts = [
    ...inv.guests.filter(g => g.status === 'running').map(g => `g${g.vmid}:${g.tags.join('+')}:${g.addresses.join('+')}`),
    ...inv.services.map(s => `s${s.key}@${s.url}>${s.publicUrl ?? ''}`),
    ...inv.proxyHosts.map(p => `p${p.domains.join('+')}>${p.forward.host}:${p.forward.port}`),
    ...inv.sites.map(s => `w${s.name}>${s.url ?? s.localUrl ?? ''}`),
    ...inv.excludedMachineIds.map(x => `x${x}`),
  ].sort()
  return require('node:crypto').createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 20)
}
