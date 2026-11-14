// =============================================================================
//  HyperProx — where the wizard puts a container, and what it gives it
//
//  The decisions that used to be inline in the executor: which node, which
//  template, whether an ID or an address is free, which gateway. Pure functions
//  over data the Proxmox API already returned, so each rule can be tested
//  without a cluster — and so a rule that matters (never trust a model's
//  gateway) lives in one place.
// =============================================================================

import * as hardware from '@hyperprox/hardware'
import { isUnicastV4 } from '@hyperprox/hardware/service-probes'

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
export function pickTemplate(volids: string[], arch = 'amd64'): string {
  // A template built for another CPU extracts cleanly and then cannot start, so
  // only an image for this architecture (or one that names none) is a candidate.
  const forArch = (v: string): boolean => {
    const m = /_([a-z0-9]+)\.tar\./.exec(v)
    return !m || m[1] === arch
  }
  const score = (v: string): number => {
    const d = /debian-(\d+)-standard/.exec(v)
    if (d) return 1000 + Number(d[1])
    const u = /ubuntu-(\d+)\.\d+-standard/.exec(v)
    if (u) return Number(u[1])
    return -1
  }
  const ranked = volids.filter(v => forArch(v) && score(v) >= 0)
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

export interface BridgeFact { iface: string; gateway: string; prefix: number }

/**
 * A bridge as `/nodes/{node}/network` has it: its address prefix from `cidr` and its gateway ('' when it
 * has none). null when there is no such bridge or it has no address to take a prefix from.
 */
export function bridgeInfo(networks: unknown[] | null | undefined, bridge = 'vmbr0'): BridgeFact | null {
  const b = (Array.isArray(networks) ? networks : []).find((n: any) => n?.iface === bridge) as any
  if (!b) return null
  const c = typeof b.cidr === 'string' ? parseCidr(b.cidr) : null
  if (!c) return null
  const gateway = typeof b.gateway === 'string' && parseCidr(`${b.gateway}/32`) ? b.gateway : ''
  return { iface: bridge, gateway, prefix: c.prefix }
}

/** True when `ip` is a usable host on the gateway's /prefix network: not the network, broadcast or gateway address. */
export function isHostAddress(ip: string, gateway: string, prefix: number): boolean {
  if (!sameSubnet(ip, gateway, prefix)) return false
  const size = 2 ** (32 - prefix)
  const n = toInt(ip)
  const base = Math.floor(n / size) * size
  if (n === base || n === base + size - 1) return false
  return n !== toInt(gateway)
}

// =============================================================================
//  Placement scoring, shared by the Catalogue wizard and the AI deploy path
//
//  One function decides "where should this go", so the two places that create
//  containers cannot disagree. It scores each node on what is left after the
//  install, not on what is free now, and says in words why a node was passed
//  over: a greyed-out row with no reason is a puzzle.
// =============================================================================

/** A node as placement sees it. Fields that could not be read are left undefined and score as neutral. */
export interface PlacementNode {
  node:           string
  online:         boolean
  cores:          number
  /** Proxmox's CPU fraction, 0..1. */
  cpuLoad?:       number
  memTotalMb:     number
  memUsedMb:      number
  /** RAM promised to its running guests (the sum of their maxmem). */
  memCommittedMb?: number
  runningGuests?: number
  /** Holds a discrete GPU (NVIDIA or AMD card, seen on the PCI bus or passed through to a guest). */
  hasGpu?:        boolean
  /** Has integrated graphics (Intel, AMD APU, or /dev/dri given to a guest). No penalty; transcoders like it. */
  hasIgpu?:       boolean
  /** false when no node login is stored; installs run with pct exec from the node. */
  hasLogin?:      boolean
}

/** A storage on one node. */
export interface PlacementStorage {
  storage: string; node: string; type: string; content: string[]
  active: boolean; shared: boolean; freeGb: number; totalGb?: number
}

export interface PlacementNeed {
  cores: number; memoryMb: number; diskGb: number
  needsGpu?: boolean
  /** Prefers a node with any GPU, integrated included (hardware transcoding). */
  wantsGpu?: boolean
  /** A storage the person chose; otherwise the best one on each node. */
  storage?: string
}

export interface NodeVerdict {
  node:           string
  eligible:       boolean
  /** Why it cannot take this install, in words. Empty when eligible. */
  why:            string[]
  /** What counted against it although it is eligible. */
  notes:          string[]
  score:          number
  storage:        PlacementStorage | null
  /** RAM free after the install, by the worse of in-use and promised. What the score uses. */
  freeMemAfterMb: number
  /** RAM free after the install by live use alone. What decides whether it fits at all. */
  freeMemAfterLiveMb: number
}

export const PLACEMENT = Object.freeze({
  /** Keep this share of a node's RAM free after the install. */
  memHeadroom:      0.2,
  /** A rootfs needs this multiple of its size free on the storage. */
  diskHeadroom:     1.2,
  headroomPenalty:  30,
  gpuPenalty:       25,
  gpuPreferBonus:   15,
  guestPenaltyEach: 0.5,
  guestPenaltyMax:  10,
})

// Higher is a better home for a container rootfs: block storage before file shares.
export const ROOT_STORAGE_RANK: Record<string, number> = {
  rbd: 5, zfspool: 4, lvmthin: 3, lvm: 3, btrfs: 3, dir: 2, nfs: 1,
}
/** Storage types never offered for a container rootfs, with the reason shown to the person. */
export const ROOTFS_EXCLUDED: Record<string, string> = {
  cifs: "CIFS/SMB shares cannot hold a container's root disk reliably: SMB does not keep Linux ownership, " +
        'special files or locks the way a root filesystem needs.',
}
/** Shared storage lets HA start the guest on another node, so it is preferred. */
const SHARED_BONUS = 2.5

function storageRank(s: PlacementStorage): number {
  return (ROOT_STORAGE_RANK[s.type] ?? 1) + (s.shared ? SHARED_BONUS : 0)
}

/** Storages on `node` that say they hold containers but are never offered for one, and why. */
export function excludedRootStorages(storages: PlacementStorage[], node: string): Array<PlacementStorage & { reason: string }> {
  return storages.filter(s => s.node === node && s.content.includes('rootdir') && ROOTFS_EXCLUDED[s.type])
    .map(s => ({ ...s, reason: ROOTFS_EXCLUDED[s.type] }))
}

/** Storages on `node` that can hold a container rootfs, best first: shared block, NFS, local, then room. CIFS never. */
export function rootStorages(storages: PlacementStorage[], node: string): PlacementStorage[] {
  return storages.filter(s => s.node === node && s.active && s.content.includes('rootdir') && !ROOTFS_EXCLUDED[s.type])
    .sort((a, b) => storageRank(b) - storageRank(a) || b.freeGb - a.freeGb)
}

/** The storage this install would use on `node`, or why there is none. */
export function storageFor(
  storages: PlacementStorage[], node: string, diskGb: number, wanted?: string,
): { storage: PlacementStorage | null; why?: string } {
  const need = Math.ceil(diskGb * PLACEMENT.diskHeadroom)
  const roots = rootStorages(storages, node)
  if (wanted) {
    const banned = storages.find(x => x.node === node && x.storage === wanted && ROOTFS_EXCLUDED[x.type])
    if (banned) return { storage: null, why: ROOTFS_EXCLUDED[banned.type] }
    const s = roots.find(x => x.storage === wanted)
    if (!s) return { storage: null, why: `${wanted} is not a container storage on this node` }
    if (s.freeGb < need) return { storage: null, why: `${wanted} has ${s.freeGb} GB free, this needs ${need} GB` }
    return { storage: s }
  }
  if (!roots.length) return { storage: null, why: 'no storage here can hold containers' }
  const s = roots.find(x => x.freeGb >= need)
  if (!s) return { storage: null, why: `no container storage has the ${need} GB free this needs` }
  return { storage: s }
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))

/** Every node, scored for this install. Eligible nodes first, best first. */
export function scoreNodes(nodes: PlacementNode[], storages: PlacementStorage[], need: PlacementNeed): NodeVerdict[] {
  const out = nodes.map((n): NodeVerdict => {
    const why: string[] = []
    const notes: string[] = []
    // Live use decides whether it fits; the worse of live use and what is promised to running guests
    // decides how good a home it is, so an overcommitted node is not recommended on a quiet moment.
    const freeAfterLive = n.memTotalMb - n.memUsedMb - need.memoryMb
    const promised = Math.max(n.memUsedMb, n.memCommittedMb ?? 0)
    const freeAfter = n.memTotalMb - promised - need.memoryMb
    const v: NodeVerdict = {
      node: n.node, eligible: false, why, notes, score: 0, storage: null, freeMemAfterMb: freeAfter, freeMemAfterLiveMb: freeAfterLive,
    }

    if (!n.online) { why.push('offline'); return v }
    if (n.hasLogin === false) why.push('no node login stored, so nothing can be installed here')
    if (freeAfterLive < 0) {
      why.push(`not enough RAM: ${Math.max(0, n.memTotalMb - n.memUsedMb)} MB free, this needs ${need.memoryMb} MB`)
    }
    if (n.cores > 0 && need.cores > n.cores) why.push(`has ${n.cores} cores, this asks for ${need.cores}`)
    if (need.needsGpu && !n.hasGpu && !n.hasIgpu) why.push('no GPU, and this app needs one')
    const st = storageFor(storages, n.node, need.diskGb, need.storage)
    v.storage = st.storage
    if (!st.storage) why.push(`not enough disk: ${st.why}`)
    if (why.length) return v

    let score = 0
    // RAM left after the install: as a share of the node, and in absolute terms (32 GB counts as plenty).
    score += 25 * clamp01(freeAfter / n.memTotalMb) + 15 * clamp01(freeAfter / 32768)
    if (freeAfter < n.memTotalMb * PLACEMENT.memHeadroom) {
      score -= PLACEMENT.headroomPenalty
      notes.push((n.memCommittedMb ?? 0) > n.memUsedMb
        ? `less than ${Math.round(PLACEMENT.memHeadroom * 100)}% of its RAM is left once what is promised to its guests is counted`
        : `would leave less than ${Math.round(PLACEMENT.memHeadroom * 100)}% of its RAM free`)
    }
    // CPU headroom; unknown load scores as half busy.
    score += 20 * (n.cpuLoad === undefined ? 0.5 : 1 - clamp01(n.cpuLoad))
    // Room on the storage beyond this install (250 GB counts as plenty), and shared storage for HA.
    const s = st.storage!
    score += 15 * clamp01((s.freeGb - need.diskGb) / 250)
    if (s.shared) score += 10
    else notes.push('local storage only, so HA cannot move it to another node')
    const wantsGpu = need.needsGpu || need.wantsGpu
    if (wantsGpu && (n.hasGpu || n.hasIgpu)) {
      score += PLACEMENT.gpuPreferBonus
      notes.push(`has a ${n.hasGpu ? 'GPU' : 'integrated GPU'} for transcoding`)
    } else if (n.hasGpu && !wantsGpu) {
      score -= PLACEMENT.gpuPenalty
      notes.push('holds a GPU this app does not need')
    }
    const guests = n.runningGuests ?? 0
    const busy = Math.min(PLACEMENT.guestPenaltyMax, guests * PLACEMENT.guestPenaltyEach)
    if (busy >= 2) notes.push(`already runs ${guests} guests`)
    score -= busy

    v.score = Math.round(score * 10) / 10
    v.eligible = true
    return v
  })
  return out.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score || a.node.localeCompare(b.node))
}

const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`

/** The top pick and one line saying why, or null when no node can take it. */
export function recommend(
  verdicts: NodeVerdict[], nodes: PlacementNode[],
): { node: string; reason: string; storage: string } | null {
  const ok = verdicts.filter(v => v.eligible)
  const top = ok[0]
  if (!top) return null
  const byName = new Map(nodes.map(n => [n.node, n]))
  const parts: string[] = []
  const mostRam = ok.every(v => v.freeMemAfterMb <= top.freeMemAfterMb)
  parts.push(`${mostRam && ok.length > 1 ? 'most free RAM after install' : 'RAM free after install'} (${gb(top.freeMemAfterMb)})`)
  const s = top.storage!
  parts.push(s.shared ? `shared storage (${s.storage})` : `local storage (${s.storage})`)
  const load = byName.get(top.node)?.cpuLoad
  if (ok.length > 1 && load !== undefined && ok.every(v => (byName.get(v.node)?.cpuLoad ?? 1) >= load)) {
    parts.push(`lightest CPU load (${Math.round(load * 100)}%)`)
  }
  if (!byName.get(top.node)?.hasGpu && nodes.some(n => n.hasGpu && n.online)) parts.push('keeps the GPU node free')
  return { node: top.node, reason: `${top.node}: ${parts.join(', ')}`, storage: s.storage }
}

// ── GPU detection ──────────────────────────────────────────────────────────

/**
 * True when a guest config passes a GPU through: a VM's hostpciN, or a container given NVIDIA device
 * nodes (devN or a cgroup allow for major 195). /dev/dri alone is not counted: integrated graphics are
 * common and nothing to keep free.
 */
export function configUsesGpu(config: Record<string, unknown> | null | undefined): boolean {
  if (!config) return false
  for (const [k, v] of Object.entries(config)) {
    if (/^hostpci\d+$/.test(k)) return true
    const text = typeof v === 'string' ? v : Array.isArray(v) ? JSON.stringify(v) : ''
    if (/^dev\d+$/.test(k) && /\/dev\/nvidia/.test(text)) return true
    if (k === 'lxc' && /devices\.allow[^\]]*c\s+195:|\/dev\/nvidia/.test(text)) return true
  }
  return false
}

/**
 * What `/nodes/{node}/hardware/pci` shows in display controllers (class 0x03xxxx): a discrete card and
 * integrated graphics. Classified by @hyperprox/hardware's probe script, the one place that decides it
 * (AMD APU graphics and Intel's built-in "Arc Graphics" are integrated; NVIDIA, AMD cards and Arc cards
 * are discrete).
 */
export function pciGpus(pci: unknown): { discrete: boolean; integrated: boolean } {
  const gpus = hardware.classifyPci(pci)
  return { discrete: gpus.some(g => g.kind === 'dedicated'), integrated: gpus.some(g => g.kind === 'integrated') }
}

/** True when the PCI bus shows a discrete GPU (NVIDIA, or an AMD card). */
export function pciHasDiscreteGpu(pci: unknown): boolean {
  return pciGpus(pci).discrete
}

/** The kind of GPU a guest config is given: a passthrough or NVIDIA nodes are discrete, /dev/dri alone integrated. */
export function configGpuKind(config: Record<string, unknown> | null | undefined): 'discrete' | 'integrated' | null {
  if (configUsesGpu(config)) return 'discrete'
  for (const [k, v] of Object.entries(config ?? {})) {
    const text = typeof v === 'string' ? v : Array.isArray(v) ? JSON.stringify(v) : ''
    if ((/^dev\d+$/.test(k) || k === 'lxc') && /\/dev\/dri/.test(text)) return 'integrated'
  }
  return null
}

// =============================================================================
//  Container IDs
// =============================================================================

/** The lowest legal ID at or above `from` that no guest (CT or VM) has. */
export function nextFreeVmid(used: Iterable<number>, from = VMID_MIN): number {
  const taken = new Set(Array.from(used, Number))
  let n = Math.max(VMID_MIN, Math.floor(from))
  while (taken.has(n)) n++
  return n
}

export type VmidRule = { kind: 'next-free' } | { kind: 'pattern'; pattern: string }

const TOKEN = /\{(node_digit|ip_last2|ip_last3)\}/g

/** Why a pattern is not usable, or null when it is. Tokens: {node_digit}, {ip_last2}, {ip_last3}; digits otherwise. */
export function patternProblem(pattern: string): string | null {
  const p = String(pattern ?? '').trim()
  if (!p) return 'The pattern is empty.'
  if (p.length > 40) return 'The pattern is too long.'
  if (!/\{(node_digit|ip_last2|ip_last3)\}/.test(p)) return 'The pattern needs at least one of {node_digit}, {ip_last2} or {ip_last3}.'
  const rest = p.replace(TOKEN, '')
  if (!/^\d*$/.test(rest)) return 'Outside the {tokens}, a pattern may contain only digits.'
  if (/\{ip_last2\}.*\{ip_last3\}|\{ip_last3\}.*\{ip_last2\}/.test(p)) return 'Use {ip_last2} or {ip_last3}, not both.'
  for (const t of ['node_digit', 'ip_last2', 'ip_last3']) {
    if (p.split(`{${t}}`).length > 2) return `Use {${t}} once.`
  }
  return null
}

/** The trailing number in a node name ("node-3" → "3"), or null when it ends in none. */
export function nodeDigit(node: string): string | null {
  return /(\d+)$/.exec(String(node ?? ''))?.[1] ?? null
}

/** The last `n` digits of an IPv4 address's final octet, zero-padded (".5" → "05"), or null when not an address. */
export function ipLastDigits(ip: string, n: 2 | 3): string | null {
  const c = parseCidr(ip.includes('/') ? ip : `${ip}/32`)
  if (!c) return null
  return c.ip.split('.')[3].padStart(3, '0').slice(-n)
}

/** The ID a pattern gives for this node and address, or why it gives none. */
export function deriveVmid(pattern: string, at: { node: string; ip?: string }): { vmid: number } | { error: string } {
  const bad = patternProblem(pattern)
  if (bad) return { error: bad }
  let missing = ''
  const s = pattern.trim().replace(TOKEN, (_m, t: string) => {
    if (t === 'node_digit') {
      const d = nodeDigit(at.node)
      if (d === null) missing ||= `${at.node} has no trailing number to use as {node_digit}.`
      return d ?? ''
    }
    if (!at.ip) { missing ||= 'Pick a static address first: this pattern uses the IP.'; return '' }
    const d = ipLastDigits(at.ip, t === 'ip_last2' ? 2 : 3)
    if (d === null) missing ||= `${at.ip} is not an IPv4 address.`
    return d ?? ''
  })
  if (missing) return { error: missing }
  const vmid = Number(s)
  if (!Number.isSafeInteger(vmid) || vmid < VMID_MIN || vmid > VMID_MAX) {
    return { error: `The pattern gives ${s}, which is not a legal ID (${VMID_MIN} to ${VMID_MAX}).` }
  }
  return { vmid }
}

/**
 * The other direction: which node and which final-octet digits an ID stands for. `nodes` are the names to
 * match {node_digit} against; the first that fits wins. `octetDigits` is undefined when the pattern has no IP.
 */
export function reverseVmid(
  pattern: string, vmid: number, nodes: string[],
): { node?: string; nodes?: string[]; octetDigits?: string; width?: 2 | 3 } | { error: string } {
  const bad = patternProblem(pattern)
  if (bad) return { error: bad }
  const id = String(vmid)
  const candidates = /\{node_digit\}/.test(pattern) ? nodes.filter(n => nodeDigit(n) !== null) : [undefined]
  const hits: Array<{ node?: string; octetDigits?: string; width?: 2 | 3 }> = []
  for (const node of candidates) {
    let width: 2 | 3 | undefined
    const re = pattern.trim().replace(TOKEN, (_m, t: string) => {
      if (t === 'node_digit') return `(?<nd>${nodeDigit(node!)})`
      width = t === 'ip_last2' ? 2 : 3
      return `(?<ip>\\d{${width}})`
    })
    const m = new RegExp(`^${re}$`).exec(id)
    if (m) hits.push({ node, octetDigits: m.groups?.ip, width })
  }
  if (hits.length) {
    // Two nodes whose names end in the same number both fit; the person picks, nothing is guessed.
    const named = hits.map(h => h.node).filter((n): n is string => !!n)
    const digits = hits[0].octetDigits, width = hits[0].width
    if (!named.length) return { octetDigits: digits, width }
    return { ...(named.length === 1 ? { node: named[0] } : {}), nodes: named, octetDigits: digits, width }
  }
  return { error: `${vmid} does not fit the pattern ${pattern} for any node.` }
}

/** Like withOctetDigits, with the reason when there is no address. */
export function octetFromDigits(base: string, digits: string, width: 2 | 3): { ip: string } | { error: string } {
  const c = parseCidr(base.includes('/') ? base : `${base}/32`)
  if (!c) return { error: `${base} is not an address to build on.` }
  if (!/^\d+$/.test(digits) || digits.length !== width) return { error: `"${digits}" are not ${width} address digits.` }
  const o = c.ip.split('.')
  const last = Number(o[3].padStart(3, '0').slice(0, 3 - width) + digits)
  if (last > 255) return { error: `That gives .${last} as the last number of the address, which is over 255.` }
  o[3] = String(last)
  return { ip: o.join('.') }
}

/**
 * `base` with its final octet's last digits replaced (".205" with "42" → ".242"). The digits above them come
 * from `base`. null when the result is not an address.
 */
export function withOctetDigits(base: string, digits: string, width: 2 | 3): string | null {
  const c = parseCidr(base.includes('/') ? base : `${base}/32`)
  if (!c || !/^\d+$/.test(digits) || digits.length !== width) return null
  const o = c.ip.split('.')
  const last = Number(o[3].padStart(3, '0').slice(0, 3 - width) + digits)
  if (last > 255) return null
  o[3] = String(last)
  return o.join('.')
}

// =============================================================================
//  Address collisions
// =============================================================================

export interface IpSighting {
  ip: string
  /** Who has it: a guest ID, or a node name. */
  vmid?: number
  node?: string
  name?: string
  source: 'config' | 'live' | 'node' | 'ping'
}

/** Usable unicast IPv4 addresses from an LXC `/interfaces` answer or a QEMU agent `network-get-interfaces` answer. */
export function liveAddresses(answer: unknown): string[] {
  const list: any[] = Array.isArray(answer) ? answer : Array.isArray((answer as any)?.result) ? (answer as any).result : []
  const out: string[] = []
  for (const f of list) {
    if (typeof f?.inet === 'string') out.push(f.inet.split('/')[0])
    for (const a of Array.isArray(f?.['ip-addresses']) ? f['ip-addresses'] : []) {
      if (a?.['ip-address-type'] === 'ipv4' && typeof a['ip-address'] === 'string') out.push(a['ip-address'])
    }
  }
  // Never loopback, 0.0.0.0/8, link-local, multicast or broadcast: those are no one's address.
  return out.filter(ip => parseCidr(`${ip}/32`) && isUnicastV4(ip))
}

/** Everyone already using `ip`: guest configs, addresses guests report while running, and the nodes themselves. */
export function ipConflicts(ip: string, known: {
  configs: Array<{ vmid: number; name?: string; config: Record<string, unknown> | null }>
  live?:   Array<{ vmid: number; name?: string; addresses: string[] }>
  nodes?:  Array<{ node: string; ip?: string }>
}): IpSighting[] {
  const out: IpSighting[] = []
  for (const g of known.configs) {
    if (configAddresses(g.config).includes(ip)) out.push({ ip, vmid: g.vmid, name: g.name, source: 'config' })
  }
  for (const g of known.live ?? []) {
    if (g.addresses.includes(ip) && !out.some(o => o.vmid === g.vmid)) out.push({ ip, vmid: g.vmid, name: g.name, source: 'live' })
  }
  for (const n of known.nodes ?? []) if (n.ip === ip) out.push({ ip, node: n.node, source: 'node' })
  return out
}

/** One sentence for a sighting. */
export function describeSighting(s: IpSighting): string {
  if (s.source === 'node') return `${s.ip} is the address of node ${s.node}.`
  if (s.source === 'ping') return `Something on the network already answers on ${s.ip}.`
  const who = `guest ${s.vmid}${s.name ? ` (${s.name})` : ''}`
  return s.source === 'config' ? `${s.ip} is set in the config of ${who}.` : `${s.ip} is in use right now by ${who}.`
}
