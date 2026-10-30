// =============================================================================
//  HyperProx — where the wizard puts a container, and what it gives it
//
//  The decisions that used to be inline in the executor: which node, which
//  template, whether an ID or an address is free, which gateway. Pure functions
//  over data the Proxmox API already returned, so each rule can be tested
//  without a cluster — and so a rule that matters (never trust a model's
//  gateway) lives in one place.
// =============================================================================

export interface NodeInfo { node: string; status: string; maxmem: number; mem: number }

/**
 * The node to create on. A node the plan names is honoured, but still checked:
 * it must be online and have the memory free. With none named, the online node
 * with the most free memory.
 */
export function chooseNode(nodes: NodeInfo[], wanted: string, needMemMb: number): string {
  const free = (n: NodeInfo) => n.maxmem - n.mem
  const online = nodes.filter(n => n.status === 'online')
  if (!online.length) throw new Error('No online Proxmox nodes found')

  if (wanted) {
    const n = nodes.find(x => x.node === wanted)
    if (!n) throw new Error(`Node ${wanted} is not in this cluster`)
    if (n.status !== 'online') throw new Error(`Node ${wanted} is not online`)
    if (needMemMb && free(n) < needMemMb * 1048576) {
      throw new Error(
        `Node ${wanted} has ${Math.round(free(n) / 1048576)} MB free, less than the ${needMemMb} MB this needs`)
    }
    return n.node
  }
  return online.slice().sort((a, b) => free(b) - free(a))[0].node
}

/**
 * The best template among the volids on offer: the newest Debian "standard"
 * image (13, then 12, ...), then Ubuntu LTS, or '' when there is none. Within a
 * release the later patch version wins.
 */
export function pickTemplate(volids: string[]): string {
  const score = (v: string): number => {
    const d = /debian-(\d+)-standard/.exec(v)
    if (d) return 1000 + Number(d[1])
    const u = /ubuntu-(\d+)\.\d+-standard/.exec(v)
    if (u) return Number(u[1])
    return -1
  }
  const ranked = volids.filter(v => score(v) >= 0)
    .sort((a, b) => score(b) - score(a) || b.localeCompare(a, undefined, { numeric: true }))
  return ranked[0] ?? ''
}

/** The newest Debian standard template Proxmox lists for download, or ''. */
export function pickDownloadable(available: Array<{ template?: string; package?: string }>): string {
  const names = available.map(a => a.template ?? a.package ?? '').filter(Boolean)
  return pickTemplate(names.filter(n => /debian-\d+-standard/.test(n)))
}

const VMID_MIN = 100
const VMID_MAX = 999_999_999

/** Throws unless `vmid` is a legal ID that no guest in /cluster/resources already has. */
export function assertVmidFree(resources: Array<{ vmid?: number }>, vmid: number): void {
  if (!Number.isInteger(vmid) || vmid < VMID_MIN || vmid > VMID_MAX) {
    throw new Error(`Container ID ${vmid} is not valid (Proxmox allows ${VMID_MIN} to ${VMID_MAX})`)
  }
  if (resources.some(r => Number(r.vmid) === vmid)) {
    throw new Error(`Container ID ${vmid} is already used by another guest`)
  }
}

/** Parse "a.b.c.d/nn" into its parts, or null when it is not a valid IPv4 CIDR. */
export function parseCidr(cidr: string): { ip: string; prefix: number } | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr.trim())
  if (!m) return null
  const octets = m.slice(1, 5).map(Number)
  const prefix = Number(m[5])
  if (octets.some(o => o > 255) || prefix < 1 || prefix > 32) return null
  return { ip: octets.join('.'), prefix }
}

function toInt(ip: string): number {
  return ip.split('.').reduce((a, o) => a * 256 + Number(o), 0)
}

/** True when `ip` and `gateway` are IPv4 addresses on the same /prefix network. */
export function sameSubnet(ip: string, gateway: string, prefix: number): boolean {
  if (!parseCidr(`${gateway}/${prefix}`) || !parseCidr(`${ip}/${prefix}`)) return false
  const size = 2 ** (32 - prefix)
  return Math.floor(toInt(ip) / size) === Math.floor(toInt(gateway) / size)
}

/** Addresses a guest config assigns: LXC `netN` `ip=` and cloud-init `ipconfigN` `ip=`. */
export function configAddresses(config: Record<string, unknown> | null | undefined): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(config ?? {})) {
    if (!/^(net|ipconfig)\d+$/.test(k) || typeof v !== 'string') continue
    const m = /(?:^|,)ip=(\d{1,3}(?:\.\d{1,3}){3})(?:\/\d+)?(?:,|$)/.exec(v)
    if (m) out.push(m[1])
  }
  return out
}

/** The vmid of a guest whose config already uses `ip`, or undefined. */
export function findIpUser(
  guests: Array<{ vmid: number; config: Record<string, unknown> | null }>, ip: string,
): number | undefined {
  return guests.find(g => configAddresses(g.config).includes(ip))?.vmid
}

/** The gateway of a bridge, from `/nodes/{node}/network`. '' when it has none. */
export function bridgeGateway(
  networks: Array<{ iface?: string; type?: string; gateway?: string }> | null | undefined,
  bridge = 'vmbr0',
): string {
  const b = (networks ?? []).find(n => n.iface === bridge)
  return b?.gateway && parseCidr(`${b.gateway}/32`) ? b.gateway : ''
}
