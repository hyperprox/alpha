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

export async function gatherFacts(): Promise<ClusterFacts> {
  const client = pve()

  const [nodesR, storageR, nextidR, proxyR, dnsR, resourcesR] = await Promise.allSettled([
    client.getNodes(),
    client.getAllStorage(),
    client.getNextVMID(),
    (async () => {
      const npm = await getProviderCredentials('proxy', 'npm').catch(() => null)
      if (!npm?.url) return [] as string[]
      const c = new NPMClient(npm.url, npm.email, npm.password)
      const hosts = await c.getProxyHosts()
      return (hosts ?? []).flatMap((h: any) => h.domain_names ?? [])
    })(),
    (async () => {
      const gd = await getProviderCredentials('dns', 'godaddy').catch(() => null)
      if (!gd?.api_key || !gd?.api_secret) return [] as string[]
      const domains = await new GoDaddyClient(gd.api_key, gd.api_secret).getDomains()
      return (domains ?? []).map((d: any) => d.domain).filter(Boolean)
    })(),
    client.fetchNode<any[]>('/cluster/resources?type=vm'),
  ])

  const partial = failedSources({
    nodes: nodesR, storage: storageR, nextid: nextidR, proxy: proxyR, dns: dnsR, resources: resourcesR,
  })

  const nodes = nodesR.status === 'fulfilled' ? nodesR.value : []
  const storage = storageR.status === 'fulfilled' ? storageR.value : []

  // The gateway is the bridge's, as the node itself has it configured. It is the only gateway the model is
  // allowed to use; it invented one when it was handed the Proxmox host's address under that name.
  let gateway = ''
  for (const n of nodes.filter((x: any) => x.status === 'online')) {
    gateway = bridgeGateway(await client.fetchNode<any[]>(`/nodes/${encodeURIComponent(n.node)}/network`).catch(() => null))
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
  /** Sources that could not be read; their facts are empty, which must not pass as "nothing there". */
  partial: string[]
}
export interface FactsDeps {
  pve: Pick<ProxmoxClient, 'fetchNode' | 'fetchStrict' | 'getNodes'>
  zones(): Promise<string[]>
  proxyHosts(): Promise<string[]>
  hasReverseProxy(): Promise<boolean>
  hasLogin(node: string): Promise<boolean>
}

/** `x86_64` is amd64, `aarch64` is arm64; anything else is unknown (''). */
function archOfKernel(machine: unknown): NodeFact['arch'] {
  return machine === 'x86_64' ? 'amd64' : machine === 'aarch64' ? 'arm64' : ''
}

/** The architecture a template names (`…_arm64.tar.zst`); one that names none is amd64. */
function archOfTemplate(name: string): string {
  return /_([a-z0-9]+)\.tar\./.exec(name)?.[1] ?? 'amd64'
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
    hasReverseProxy: async () => Boolean((await getProviderCredentials('proxy', 'npm').catch(() => null))?.url),
    hasLogin: async node => Boolean(await nodeCredential(node).catch(() => null)),
  }
}

export async function gatherTemplateFacts(over: Partial<FactsDeps> = {}): Promise<TemplateFacts> {
  const deps: FactsDeps = { ...defaultDeps(), ...over }
  const { pve: client } = deps
  const ok = <T>(r: PromiseSettledResult<T>, empty: T): T => (r.status === 'fulfilled' && r.value != null ? r.value : empty)
  const enc = encodeURIComponent

  const [nodesR, nextR, resR, zonesR, proxyR, rpR] = await Promise.allSettled([
    client.getNodes(),
    client.fetchStrict<number | string>('/cluster/nextid'),
    client.fetchNode<any[]>('/cluster/resources?type=vm'),
    deps.zones(), deps.proxyHosts(), deps.hasReverseProxy(),
  ])
  const partial = failedSources({ nodes: nodesR, nextid: nextR, resources: resR, zones: zonesR, proxy: proxyR })
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
      client.fetchNode<any>(`/nodes/${enc(n.node)}/status`),
      client.fetchNode<any[]>(`/nodes/${enc(n.node)}/network`),
      client.fetchNode<any[]>(`/nodes/${enc(n.node)}/storage`),
      client.fetchNode<any[]>(`/nodes/${enc(n.node)}/aplinfo`),
      deps.hasLogin(n.node),
    ])
    for (const [k, r] of Object.entries({ status: statusR, network: netR, storage: storR }))
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
      const list = await client.fetchNode<any[]>(`/nodes/${enc(n.node)}/storage/${enc(s.storage)}/content?content=vztmpl`)
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
  const guests: GuestFact[] = await Promise.all(
    resources.filter(r => r?.vmid && (r.type === 'lxc' || r.type === 'qemu')).map(async r => {
      const cfg = await client.fetchNode<Record<string, unknown>>(
        `/nodes/${enc(r.node)}/${r.type}/${Number(r.vmid)}/config`).catch(() => null)
      return { vmid: Number(r.vmid), node: String(r.node), type: r.type as 'lxc' | 'qemu',
               name: String(r.name ?? ''), addresses: configAddresses(cfg) }
    }),
  )

  return {
    nodes, storages, templates, downloadable, guests,
    nextVmid: nextR.status === 'fulfilled' ? Number(nextR.value) : 0,
    zones: ok(zonesR, []), proxyHosts: ok(proxyR, []), hasReverseProxy: ok(rpR, false),
    partial,
  }
}
