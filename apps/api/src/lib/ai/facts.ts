// =============================================================================
//  HyperProx — what the model is told about the cluster
//
//  Gathered fresh per plan request. Every source is optional: a cluster with no
//  DNS provider still gets a plan, it just gets a warning about the domain
//  rather than a fabricated one.
// =============================================================================

import { ProxmoxClient } from '../proxmox-client'
import { NPMClient } from '../npm-client'
import { GoDaddyClient } from '../godaddy-client'
import { getProviderCredentials } from '../credentials'
import { nodeCredential } from '../node-exec'
import { wizardRecipes } from '../catalogue'
import { bridgeGateway, bridgeInfo, configAddresses, type BridgeFact } from '../wizard-placement'
import { distroOf, type Distro } from '../install-script'
import type { ClusterFacts } from './plan-schema'

// Higher is a better home for a container rootfs. Shared block storage first
// (a guest on it can migrate), then node-local, then network file shares.
const STORAGE_RANK: Record<string, number> = {
  rbd: 5, zfspool: 4, lvmthin: 3, btrfs: 3, dir: 2, nfs: 1, cifs: 1,
}

function pve(): ProxmoxClient {
  return new ProxmoxClient(
    process.env.PROXMOX_HOST!,
    Number(process.env.PROXMOX_PORT ?? 8006),
    `${process.env.PROXMOX_USER}!${process.env.PROXMOX_TOKEN_ID}`,
    process.env.PROXMOX_TOKEN_SECRET!,
  )
}

/**
 * The names of the sources that could not be read. A source that failed reads
 * as empty in the facts (no used IDs, no zones), and an empty list is exactly
 * what lets an audit pass that should not — so the failure has to be carried
 * alongside, not swallowed.
 */
export function failedSources(results: Record<string, PromiseSettledResult<unknown>>): string[] {
  return Object.entries(results).filter(([, r]) => r.status === 'rejected').map(([name]) => name)
}

/**
 * `fetchNode` is lenient: it resolves null on a failed request and never rejects, so a source read through it
 * can never show up in `failedSources`. Everything that feeds `partial` is read with `fetchStrict`, which does reject.
 */
type StrictPve = Pick<ProxmoxClient, 'fetchStrict'>

/** A 2xx that carries no data is as unread as a rejection; make it one. */
function nonNull<C extends { fetchStrict: any }>(c: C): C {
  return {
    fetchStrict: async (path: string, ...rest: unknown[]) => {
      const v = await c.fetchStrict(path, ...rest)
      if (v == null) throw new Error(`Proxmox GET ${path}: no data`)
      return v
    },
    fetchNode: (...a: unknown[]) => (c as any).fetchNode?.(...a),
  } as unknown as C
}

/** Run `fn` over `items`, at most `limit` at a time, keeping the order of the results. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]) }
  }))
  return out
}

export interface LegacyFactsDeps {
  pve: StrictPve & Pick<ProxmoxClient, 'fetchNode'>
  zones(): Promise<string[]>
  proxyHosts(): Promise<string[]>
}

export async function gatherFacts(over: Partial<LegacyFactsDeps> = {}): Promise<ClusterFacts> {
  const client = nonNull(over.pve ?? pve())
  const enc = encodeURIComponent

  const nodesP = client.fetchStrict<any[]>('/nodes')
  const [nodesR, storageR, nextidR, proxyR, dnsR, resourcesR] = await Promise.allSettled([
    nodesP,
    (async () => {
      const online = ((await nodesP) ?? []).filter((n: any) => n.status === 'online')
      const per = await Promise.all(online.map(async (n: any) =>
        (await client.fetchStrict<any[]>(`/nodes/${enc(n.node)}/storage`)).map(x => ({ ...x, node: n.node }))))
      return per.flat()
    })(),
    client.fetchStrict<number | string>('/cluster/nextid'),
    over.proxyHosts ? over.proxyHosts() : (async () => {
      const npm = await getProviderCredentials('proxy', 'npm').catch(() => null)
      if (!npm?.url) return [] as string[]
      const c = new NPMClient(npm.url, npm.email, npm.password)
      const hosts = await c.getProxyHosts()
      return (hosts ?? []).flatMap((h: any) => h.domain_names ?? [])
    })(),
    over.zones ? over.zones() : (async () => {
      const gd = await getProviderCredentials('dns', 'godaddy').catch(() => null)
      if (!gd?.api_key || !gd?.api_secret) return [] as string[]
      const domains = await new GoDaddyClient(gd.api_key, gd.api_secret).getDomains()
      return (domains ?? []).map((d: any) => d.domain).filter(Boolean)
    })(),
    client.fetchStrict<any[]>('/cluster/resources?type=vm'),
  ])

  const partial = failedSources({
    nodes: nodesR, storage: storageR, nextid: nextidR, proxy: proxyR, dns: dnsR, resources: resourcesR,
  })

  const nodes = nodesR.status === 'fulfilled' ? nodesR.value ?? [] : []
  const storage = storageR.status === 'fulfilled' ? storageR.value : []

  // The gateway is the bridge's, as the node itself has it configured. It is the only gateway the model is
  // allowed to use; it invented one when it was handed the Proxmox host's address under that name.
  let gateway = ''
  for (const n of nodes.filter((x: any) => x.status === 'online')) {
    gateway = bridgeGateway(await client.fetchNode<any[]>(`/nodes/${encodeURIComponent(n.node)}/network`).catch(() => null) as any)
    if (gateway) break
  }

  return {
    nodes: nodes
      .filter((n: any) => n.status === 'online')
      .map((n: any) => ({
        node: n.node,
        cores: Number(n.maxcpu ?? 0),
        // What is free right now, not what is installed — a plan sized against
        // total memory is a plan that will not start.
        freeMemMb: Math.max(0, Math.round((Number(n.maxmem ?? 0) - Number(n.mem ?? 0)) / 1048576)),
        totalMemMb: Math.round(Number(n.maxmem ?? 0) / 1048576),
      })),

    // Only storage that can actually hold a container, deduplicated: shared
    // storage appears once per node and would otherwise look like five options.
    storages: Object.values(
      storage
        .filter((s: any) => String(s.content ?? '').includes('rootdir') && s.active)
        .reduce((acc: Record<string, any>, s: any) => {
          if (!acc[s.storage] || Number(s.avail ?? 0) > acc[s.storage].avail) {
            acc[s.storage] = {
              storage: s.storage,
              type: s.type,
              freeGb: Math.round(Number(s.avail ?? 0) / 1073741824),
              shared: Boolean(s.shared),
              avail: Number(s.avail ?? 0),
            }
          }
          return acc
        }, {}),
    )
      .map(({ storage: id, type, freeGb, shared }: any) => ({ storage: id, type, freeGb, shared }))
      // Ranked before it is handed to a model, because "most free space" is the
      // wrong first question: a CIFS or NFS share can legally hold a rootdir and
      // will usually be the emptiest thing in the list, but running a container
      // root over a file share is almost never what someone meant. Rank by what
      // the storage is, then by how much room it has.
      .sort((a, b) => (STORAGE_RANK[b.type] ?? 0) - (STORAGE_RANK[a.type] ?? 0) || b.freeGb - a.freeGb),

    domains:    dnsR.status === 'fulfilled' ? dnsR.value : [],
    proxyHosts: proxyR.status === 'fulfilled' ? proxyR.value : [],
    nextVmid:   nextidR.status === 'fulfilled' ? Number(nextidR.value) : 0,
    usedVmids:  resourcesR.status === 'fulfilled'
      ? (resourcesR.value ?? []).map((r: any) => Number(r.vmid)).filter(Boolean)
      : [],
    gateway,
    capabilities: {
      nodesWithLogin: (await Promise.all(
        nodes.filter((n: any) => n.status === 'online').map(async (n: any) =>
          (await nodeCredential(n.node).catch(() => null)) ? n.node : null),
      )).filter(Boolean) as string[],
      // A proxy host list can be empty on a perfectly working proxy, so this
      // asks whether one is configured at all, not whether it is being used.
      hasReverseProxy: Boolean(
        (await getProviderCredentials('proxy', 'npm').catch(() => null))?.url),
      installable: wizardRecipes().map(r => r.name),
    },
    partial,
  }
}

// =============================================================================
//  Facts for task templates
//
//  What a template validates and asks questions against. Unlike the facts the
//  model is shown, these are per node (a template, a storage or a bridge belongs
//  to one) and carry each node's real CPU architecture.
// =============================================================================

export interface NodeFact {
  node: string; online: boolean; cores: number; freeMemMb: number; totalMemMb: number
  arch: 'amd64' | 'arm64' | ''; hasLogin: boolean; bridges: BridgeFact[]
}
export interface StorageFact {
  storage: string; node: string; type: string; content: string[]; active: boolean; shared: boolean; freeGb: number
}
export interface TemplateFact { node: string; storage: string; volid: string; arch: string; distro: Distro | null }
export interface DownloadFact { node: string; name: string; arch: string; distro: Distro | null }
export interface GuestFact { vmid: number; node: string; type: 'lxc' | 'qemu'; name: string; addresses: string[] }
export interface TemplateFacts {
  nodes: NodeFact[]; storages: StorageFact[]; templates: TemplateFact[]; downloadable: DownloadFact[]
  guests: GuestFact[]; nextVmid: number; zones: string[]; proxyHosts: string[]; hasReverseProxy: boolean
  /** Per managed zone, the names ('@' at the apex) that already have an A, AAAA or CNAME record. */
  records: Record<string, string[]>
  /** Sources that could not be read; their facts are empty, which must not pass as "nothing there". */
  partial: string[]
}
export interface FactsDeps {
  pve: Pick<ProxmoxClient, 'fetchStrict'>
  zones(): Promise<string[]>
  proxyHosts(): Promise<string[]>
  hasReverseProxy(): Promise<boolean>
  hasLogin(node: string): Promise<boolean>
  /** Names in `zone` holding an A, AAAA or CNAME record, relative to the zone ('@' at the apex). */
  records(zone: string): Promise<string[]>
}

/** `x86_64` is amd64, `aarch64` is arm64; anything else is unknown (''). */
function archOfKernel(machine: unknown): NodeFact['arch'] {
  return machine === 'x86_64' ? 'amd64' : machine === 'aarch64' ? 'arm64' : ''
}

/** The architecture a template names (`…_arm64.tar.zst`); one that names none is amd64. */
export function archOfTemplate(name: string): string {
  const t = /_(amd64|arm64|armhf|i386|aarch64|x86_64)\.tar\./.exec(name)?.[1]
  return t === 'aarch64' ? 'arm64' : !t || t === 'x86_64' ? 'amd64' : t
}

function defaultDeps(): FactsDeps {
  return {
    pve: pve(),
    zones: async () => {
      const gd = await getProviderCredentials('dns', 'godaddy').catch(() => null)
      if (!gd?.api_key || !gd?.api_secret) return []
      const domains = await new GoDaddyClient(gd.api_key, gd.api_secret).getDomains()
      return (domains ?? []).map((d: any) => d.domain).filter(Boolean)
    },
    proxyHosts: async () => {
      const npm = await getProviderCredentials('proxy', 'npm').catch(() => null)
      if (!npm?.url) return []
      const hosts = await new NPMClient(npm.url, npm.email, npm.password).getProxyHosts()
      return (hosts ?? []).flatMap((h: any) => h.domain_names ?? [])
    },
    // A credential store that cannot be read is a failed source, not "no reverse proxy".
    hasReverseProxy: async () => Boolean((await getProviderCredentials('proxy', 'npm'))?.url),
    // A lookup that throws is a failed source (login:<node>), not "no login".
    hasLogin: async node => Boolean(await nodeCredential(node)),
    records: async zone => {
      const gd = await getProviderCredentials('dns', 'godaddy')
      if (!gd?.api_key || !gd?.api_secret) throw new Error('DNS provider is not configured')
      const all = await new GoDaddyClient(gd.api_key, gd.api_secret).getRecords(zone)
      return [...new Set((all ?? []).filter((r: any) => ['A', 'AAAA', 'CNAME'].includes(r?.type))
        .map((r: any) => String(r.name ?? '').toLowerCase()).filter(Boolean))]
    },
  }
}

export async function gatherTemplateFacts(over: Partial<FactsDeps> = {}): Promise<TemplateFacts> {
  const deps: FactsDeps = { ...defaultDeps(), ...over }
  const client = nonNull(deps.pve)
  const ok = <T>(r: PromiseSettledResult<T>, empty: T): T => (r.status === 'fulfilled' && r.value != null ? r.value : empty)
  const enc = encodeURIComponent

  const [nodesR, nextR, resR, zonesR, proxyR, rpR] = await Promise.allSettled([
    client.fetchStrict<any[]>('/nodes'),
    client.fetchStrict<number | string>('/cluster/nextid'),
    client.fetchStrict<any[]>('/cluster/resources?type=vm'),
    deps.zones(), deps.proxyHosts(), deps.hasReverseProxy(),
  ])
  const partial = failedSources({ nodes: nodesR, nextid: nextR, resources: resR, zones: zonesR, proxy: proxyR })
  if (rpR.status === 'rejected' && !partial.includes('proxy')) partial.push('proxy')
  const rawNodes: any[] = ok(nodesR, [])

  const nodes: NodeFact[] = []
  const storages: StorageFact[] = []
  const templates: TemplateFact[] = []
  const downloadable: DownloadFact[] = []

  for (const n of rawNodes) {
    const online = n.status === 'online'
    const base: NodeFact = {
      node: n.node, online, cores: Number(n.maxcpu ?? 0),
      freeMemMb: Math.max(0, Math.round((Number(n.maxmem ?? 0) - Number(n.mem ?? 0)) / 1048576)),
      totalMemMb: Math.round(Number(n.maxmem ?? 0) / 1048576),
      arch: '', hasLogin: false, bridges: [],
    }
    nodes.push(base)
    if (!online) continue

    const [statusR, netR, storR, aplR, loginR] = await Promise.allSettled([
      client.fetchStrict<any>(`/nodes/${enc(n.node)}/status`),
      client.fetchStrict<any[]>(`/nodes/${enc(n.node)}/network`),
      client.fetchStrict<any[]>(`/nodes/${enc(n.node)}/storage`),
      client.fetchStrict<any[]>(`/nodes/${enc(n.node)}/aplinfo`),
      deps.hasLogin(n.node),
    ])
    for (const [k, r] of Object.entries({ status: statusR, network: netR, storage: storR, aplinfo: aplR, login: loginR }))
      if (r.status === 'rejected' || r.value == null) partial.push(`${k}:${n.node}`)
    base.arch = archOfKernel(ok(statusR, null)?.['current-kernel']?.machine)
    base.hasLogin = ok(loginR, false)
    const nets = ok(netR, [])
    base.bridges = nets.filter((x: any) => x?.type === 'bridge')
      .map((x: any) => bridgeInfo(nets, x.iface)).filter((b): b is BridgeFact => b !== null)

    for (const s of ok(storR, []) as any[]) {
      const content = String(s.content ?? '').split(',').filter(Boolean)
      const active = Boolean(s.active) && s.enabled !== 0
      storages.push({
        storage: s.storage, node: n.node, type: s.type, content, active,
        shared: Boolean(s.shared), freeGb: Math.floor(Number(s.avail ?? 0) / 1073741824),
      })
      if (!active || !content.includes('vztmpl')) continue
      const list = await client.fetchStrict<any[]>(`/nodes/${enc(n.node)}/storage/${enc(s.storage)}/content?content=vztmpl`)
        .catch(() => null)
      if (list == null) { partial.push(`templates:${n.node}/${s.storage}`); continue }
      for (const c of list) {
        if (!c?.volid) continue
        templates.push({ node: n.node, storage: s.storage, volid: c.volid, arch: archOfTemplate(c.volid), distro: distroOf(c.volid) })
      }
    }

    for (const a of ok(aplR, []) as any[]) {
      const name = a?.template ?? a?.package
      if (name) downloadable.push({ node: n.node, name, arch: archOfTemplate(name), distro: distroOf(name) })
    }
  }

  const resources: any[] = ok(resR, [])
  const guests: GuestFact[] = await mapLimit(
    resources.filter(r => r?.vmid && (r.type === 'lxc' || r.type === 'qemu')), 8, async r => {
      const cfg = await client.fetchStrict<Record<string, unknown>>(
        `/nodes/${enc(r.node)}/${r.type}/${Number(r.vmid)}/config`).catch(() => null)
      if (cfg == null) partial.push(`config:${Number(r.vmid)}`)
      return { vmid: Number(r.vmid), node: String(r.node), type: r.type as 'lxc' | 'qemu',
               name: String(r.name ?? ''), addresses: configAddresses(cfg) }
    })

  // Publishing must never overwrite a record that is already there, so each zone's names are read;
  // a zone that cannot be listed is named, not read as empty.
  const records: Record<string, string[]> = Object.create(null)
  for (const zone of ok(zonesR, [] as string[])) {
    const r = await deps.records(zone).then(v => v, () => null)
    if (r == null) partial.push(`records:${zone}`)
    else records[zone] = r.map(n => String(n).toLowerCase())
  }

  return {
    nodes, storages, templates, downloadable, guests, records,
    nextVmid: nextR.status === 'fulfilled' ? Number(nextR.value) : 0,
    zones: ok(zonesR, []), proxyHosts: ok(proxyR, []), hasReverseProxy: ok(rpR, false),
    partial,
  }
}
