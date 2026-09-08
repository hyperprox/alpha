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
import { CATALOGUE } from '../catalogue'
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

export async function gatherFacts(): Promise<ClusterFacts> {
  const client = pve()

  const [nodesR, storageR, nextidR, proxyR, dnsR] = await Promise.allSettled([
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
  ])

  const nodes = nodesR.status === 'fulfilled' ? nodesR.value : []
  const storage = storageR.status === 'fulfilled' ? storageR.value : []

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
    gateway:    process.env.PROXMOX_HOST ?? '',
    capabilities: {
      nodesWithLogin: (await Promise.all(
        nodes.filter((n: any) => n.status === 'online').map(async (n: any) =>
          (await nodeCredential(n.node).catch(() => null)) ? n.node : null),
      )).filter(Boolean) as string[],
      // A proxy host list can be empty on a perfectly working proxy, so this
      // asks whether one is configured at all, not whether it is being used.
      hasReverseProxy: Boolean(
        (await getProviderCredentials('proxy', 'npm').catch(() => null))?.url),
      installable: CATALOGUE.map(r => r.name),
    },
  }
}
