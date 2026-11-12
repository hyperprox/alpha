// =============================================================================
//  HyperProx — naming and addresses for new guests
//
//  One setting says where new guests go on the network and how they are
//  numbered: the subnet, the range of addresses HyperProx may hand out, the
//  gateway, DNS, bridge and VLAN, the ID scheme and whether DHCP is allowed at
//  all. Every wizard that creates a guest reads it, so a guest never lands on a
//  network nobody meant (a bridge can carry more than one subnet, and DHCP
//  answers from whichever one replies first).
//
//  The "node + address" scheme is the common homelab one: the guest's ID is
//  the node's index followed by the last two digits of its address, so the
//  guest at .242 on node 7 is 742. detectConvention() reads the guests a
//  cluster already has and says whether they follow it.
//
//  Pure functions over data Proxmox already returned; the store and the ping
//  are passed in, so every rule here can be tested without a cluster.
// =============================================================================

import { configAddresses, nodeDigit, nextFreeVmid, parseCidr } from './wizard-placement'
import { wizardStore } from './catalogue-store'

/** The naming settings' row in the wizard's table. */
export const NAMING_ID = 'setting:naming'

/**
 * The saved settings, or null when none are saved. A store that cannot be read throws, and so does a saved row that
 * no longer passes the checks: either is "settings exist but cannot be applied", never "none saved", which would
 * let DHCP and any address through. Callers refuse the plan.
 */
export async function readSavedNaming(): Promise<NamingSettings | null> {
  const r = await wizardStore().get(NAMING_ID)
  if (!r) return null
  if (r.kind !== 'setting') throw new Error('The saved naming settings are not in the expected form. Save them again under Settings → Naming & addresses.')
  const v = validateNaming(r.data)
  if (!v.settings) throw new Error(`The saved naming settings no longer pass their checks (${v.errors.join(' ')}). Save them again under Settings → Naming & addresses.`)
  return { ...v.settings, updatedAt: r.data?.updatedAt, updatedBy: r.data?.updatedBy }
}

/** The address a raw container net0 asks for: 'dhcp' (also when it names none), or the static CIDR; and its bridge. */
export function net0Address(net0: unknown): { ip: string; bridge?: string } {
  const s = typeof net0 === 'string' ? net0 : ''
  const ip = /(?:^|,)ip=([^,]+)/.exec(s)?.[1]?.trim()
  const bridge = /(?:^|,)bridge=([^,]+)/.exec(s)?.[1]?.trim()
  return { ip: !ip || ip === 'dhcp' || ip === 'manual' ? 'dhcp' : ip, ...(bridge ? { bridge } : {}) }
}

/**
 * The naming policy for the raw Create container form (/api/proxmox/lxc), which takes Proxmox parameters as they
 * are: the same DHCP and range rules as the wizards, with the same typed confirmation. Throws when the settings
 * cannot be read (the caller refuses the create).
 */
export async function guardRawCreate(
  input: { node: string; vmid: number; net0?: unknown }, confirm?: string, read: () => Promise<NamingSettings | null> = readSavedNaming,
): Promise<PolicyVerdict> {
  const s = await read()
  const a = net0Address(input.net0)
  return namingPolicy(s, { node: String(input.node ?? ''), vmid: Number(input.vmid), ip: a.ip, bridge: a.bridge }, confirm)
}

export type IdScheme = 'next-free' | 'node-ip'
export type DhcpPolicy = 'never' | 'warn' | 'allowed'

export interface NamingSettings {
  /** The network guests go on, as its network address and prefix ("192.0.2.0/24"). */
  subnet:     string
  /** The first and last address HyperProx may give a guest, inclusive. */
  rangeStart: string
  rangeEnd:   string
  gateway:    string
  /** DNS servers given to a static guest. Empty uses the node's. */
  dns:        string[]
  bridge:     string
  /** 802.1Q tag for the guest's interface, when the bridge is VLAN-aware. */
  vlan?:      number
  idScheme:   IdScheme
  /** Node name to index, for the node + address scheme. */
  nodeIndex:  Record<string, number>
  dhcp:       DhcpPolicy
  updatedAt?: string
  updatedBy?: string
}

const VMID_MIN = 100
const VMID_MAX = 999_999_999
const BRIDGE = /^[A-Za-z][A-Za-z0-9_.-]{0,14}$/
const NODE_NAME = /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/

// ---------------------------------------------------------------------------
//  Addresses as numbers
// ---------------------------------------------------------------------------

const isIp = (ip: unknown): ip is string => typeof ip === 'string' && parseCidr(`${ip.trim()}/32`) !== null
export const ipToInt = (ip: string): number => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0)
export const intToIp = (n: number): string => [24, 16, 8, 0].map(s => Math.floor(n / 2 ** s) % 256).join('.')

/** The network address and size of a CIDR, or null when it is not one. */
export function network(cidr: string): { base: number; size: number; prefix: number } | null {
  const c = parseCidr(cidr)
  if (!c) return null
  const size = 2 ** (32 - c.prefix)
  return { base: Math.floor(ipToInt(c.ip) / size) * size, size, prefix: c.prefix }
}

/** True when `ip` is a usable host address in `subnet`: inside it, and not its network or broadcast address. */
export function inSubnet(ip: string, subnet: string): boolean {
  const n = network(subnet)
  if (!n || !isIp(ip)) return false
  const x = ipToInt(ip)
  return x > n.base && x < n.base + n.size - 1
}

/** True when `ip` is inside the settings' range (and so inside its subnet). */
export function inRange(ip: string, s: Pick<NamingSettings, 'subnet' | 'rangeStart' | 'rangeEnd'>): boolean {
  if (!isIp(ip) || !inSubnet(ip, s.subnet)) return false
  const x = ipToInt(ip)
  return x >= ipToInt(s.rangeStart) && x <= ipToInt(s.rangeEnd)
}

/** "192.0.2.50/24" or "192.0.2.50" → "192.0.2.50". */
export const bareIp = (ip: string): string => String(ip ?? '').trim().split('/')[0]

// ---------------------------------------------------------------------------
//  The node + address scheme
// ---------------------------------------------------------------------------

/** Each node's index from the number its name ends in ("pve3" → 3). Names without one, and repeats, are left out. */
export function defaultNodeIndex(nodes: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  const seen = new Set<number>()
  for (const n of [...nodes].sort()) {
    const d = nodeDigit(n)
    if (d === null) continue
    const i = Number(d)
    if (i < 1 || i > 999 || seen.has(i)) continue
    seen.add(i); out[n] = i
  }
  return out
}

/** The ID the node + address scheme gives: the node's index, then the last two digits of the address. */
export function schemeVmid(s: Pick<NamingSettings, 'nodeIndex'>, node: string, ip: string): { vmid: number } | { error: string } {
  const idx = s.nodeIndex[node]
  if (!Number.isInteger(idx)) return { error: `${node} has no index in your naming settings, so the node + address scheme cannot number it.` }
  if (!isIp(bareIp(ip))) return { error: `${ip} is not an IPv4 address.` }
  const last = Number(bareIp(ip).split('.')[3])
  const vmid = idx * 100 + (last % 100)
  if (vmid < VMID_MIN || vmid > VMID_MAX) return { error: `That gives ${vmid}, which is not a legal ID.` }
  return { vmid }
}

/** "CT 3xx ↔ 192.0.2.2xx" for one node, or the general form with "N" when no node is named. */
export function schemeLabel(s: Pick<NamingSettings, 'idScheme' | 'rangeStart' | 'nodeIndex' | 'subnet' | 'rangeEnd'>, node?: string): string {
  const o = s.rangeStart.split('.')
  const hundreds = Math.floor(Number(o[3]) / 100)
  const addr = `${o.slice(0, 3).join('.')}.${hundreds || ''}xx`
  if (s.idScheme !== 'node-ip') return `next free ID · ${s.rangeStart}–${s.rangeEnd.split('.')[3]}`
  const idx = node !== undefined ? s.nodeIndex[node] : undefined
  return `CT ${idx ?? 'N'}xx ↔ ${addr}`
}

// ---------------------------------------------------------------------------
//  Validation
// ---------------------------------------------------------------------------

/** Check a settings object from a person or a request. Errors are in words; nothing is fixed silently. */
export function validateNaming(raw: unknown): { settings?: NamingSettings; errors: string[] } {
  const r: any = raw ?? {}
  const errors: string[] = []
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

  const sub = parseCidr(str(r.subnet))
  let subnet = ''
  if (!sub) errors.push('The subnet must be written as an address and prefix, like 192.0.2.0/24.')
  else if (sub.prefix < 8 || sub.prefix > 30) errors.push('The subnet prefix must be between /8 and /30.')
  else {
    const n = network(str(r.subnet))!
    subnet = `${intToIp(n.base)}/${n.prefix}`
  }

  const start = str(r.rangeStart), end = str(r.rangeEnd), gateway = str(r.gateway)
  if (!isIp(start)) errors.push('The first address of the range is not an IPv4 address.')
  if (!isIp(end)) errors.push('The last address of the range is not an IPv4 address.')
  if (subnet && isIp(start) && !inSubnet(start, subnet)) errors.push(`${start} is not a usable address in ${subnet}.`)
  if (subnet && isIp(end) && !inSubnet(end, subnet)) errors.push(`${end} is not a usable address in ${subnet}.`)
  if (isIp(start) && isIp(end) && ipToInt(start) > ipToInt(end)) errors.push('The range starts after it ends.')
  if (!isIp(gateway)) errors.push('The gateway is not an IPv4 address.')
  else if (subnet && !inSubnet(gateway, subnet)) errors.push(`The gateway ${gateway} is not inside ${subnet}.`)

  const dnsIn: unknown[] = Array.isArray(r.dns) ? r.dns : typeof r.dns === 'string' ? r.dns.split(/[\s,]+/) : []
  const dns = dnsIn.map(x => str(x)).filter(Boolean)
  if (dns.some(d => !isIp(d))) errors.push('Every DNS server must be an IPv4 address.')
  if (dns.length > 3) errors.push('At most three DNS servers.')

  const bridge = str(r.bridge)
  if (!BRIDGE.test(bridge)) errors.push('The bridge must be a bridge name, like vmbr0.')

  let vlan: number | undefined
  if (r.vlan !== undefined && r.vlan !== null && r.vlan !== '') {
    vlan = Number(r.vlan)
    if (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094) errors.push('The VLAN tag must be a whole number from 1 to 4094, or blank.')
  }

  const idScheme: IdScheme = r.idScheme === 'node-ip' ? 'node-ip' : r.idScheme === 'next-free' ? 'next-free' : (errors.push('The ID scheme is "next-free" or "node-ip".'), 'next-free')
  const dhcp: DhcpPolicy = ['never', 'warn', 'allowed'].includes(r.dhcp) ? r.dhcp : (errors.push('The DHCP policy is "never", "warn" or "allowed".'), 'never')

  const nodeIndex: Record<string, number> = {}
  const used = new Map<number, string>()
  for (const [name, v] of Object.entries(r.nodeIndex && typeof r.nodeIndex === 'object' ? r.nodeIndex : {})) {
    if (!NODE_NAME.test(name)) { errors.push(`"${name}" is not a node name.`); continue }
    if (v === '' || v === null || v === undefined) continue
    const i = Number(v)
    if (!Number.isInteger(i) || i < 1 || i > 999) { errors.push(`The index for ${name} must be a whole number from 1 to 999.`); continue }
    if (used.has(i)) { errors.push(`${name} and ${used.get(i)} both have index ${i}; their guests' IDs would collide.`); continue }
    used.set(i, name); nodeIndex[name] = i
  }

  if (idScheme === 'node-ip' && isIp(start) && isIp(end)) {
    const a = start.split('.'), b = end.split('.')
    // Two addresses whose last two digits are the same (".150" and ".250") would give the same ID.
    if (a.slice(0, 3).join('.') !== b.slice(0, 3).join('.') || Math.floor(Number(a[3]) / 100) !== Math.floor(Number(b[3]) / 100)) {
      errors.push('With the node + address scheme the range must sit inside one block of a hundred (like .200–.254), or two addresses would give the same ID.')
    }
    if (!Object.keys(nodeIndex).length) errors.push('The node + address scheme needs an index for at least one node.')
  }

  if (errors.length) return { errors }
  return {
    errors: [],
    settings: { subnet, rangeStart: start, rangeEnd: end, gateway, dns, bridge, ...(vlan ? { vlan } : {}), idScheme, nodeIndex, dhcp },
  }
}

// ---------------------------------------------------------------------------
//  Convention detection
// ---------------------------------------------------------------------------

export interface DetectGuest { vmid: number; node: string; config: Record<string, unknown> | null }
export interface DetectNode { node: string; address?: string; bridges?: Array<{ iface: string; cidr?: string; gateway?: string }> }

export interface Detection {
  /** 'follows': most guests with a fixed address are numbered node + address. 'mixed': some are. 'none': none are. */
  verdict:   'follows' | 'mixed' | 'none'
  matching:  number
  /** Guests with a fixed IPv4 address: what the majority is counted over. */
  considered: number
  total:     number
  /** Settings filled from what the guests show, ready for the person to check and save. Absent with 'none'. */
  proposal?: NamingSettings
  /** Up to five guests that follow it, as evidence. */
  examples:  Array<{ vmid: number; node: string; ip: string }>
}

const NAMESERVER = /^\s*(\d{1,3}(?:\.\d{1,3}){3})/

function mostCommon<T>(xs: T[]): T | undefined {
  const m = new Map<T, number>()
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1)
  let best: T | undefined, n = 0
  for (const [k, v] of m) if (v > n) { best = k; n = v }
  return best
}

/** The static address and the bridge and gateway a guest config names on its first interface that has one. */
function staticOf(config: Record<string, unknown> | null): { ip: string; prefix: number; bridge?: string; gw?: string } | null {
  for (const [k, v] of Object.entries(config ?? {}).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))) {
    if (!/^(net|ipconfig)\d+$/.test(k) || typeof v !== 'string') continue
    const m = /(?:^|,)ip=(\d{1,3}(?:\.\d{1,3}){3})\/(\d+)(?:,|$)/.exec(v)
    if (!m) continue
    const bridge = /(?:^|,)bridge=([^,]+)/.exec(v)?.[1]
    const gw = /(?:^|,)gw=(\d{1,3}(?:\.\d{1,3}){3})/.exec(v)?.[1]
    // A VM's ipconfigN has the gateway but its bridge is on the matching netN.
    const vmBridge = k.startsWith('ipconfig') ? /(?:^|,)bridge=([^,]+)/.exec(String((config ?? {})[`net${k.slice(8)}`] ?? ''))?.[1] : undefined
    return { ip: m[1], prefix: Number(m[2]), ...(bridge ?? vmBridge ? { bridge: bridge ?? vmBridge } : {}), ...(gw ? { gw } : {}) }
  }
  return null
}

/**
 * Do the cluster's guests follow node + address numbering? A guest follows it when its ID is its node's index
 * followed by the last two digits of its fixed address. It is detected when at least two do and they are more
 * than half of the guests with a fixed address. The proposal is the network most of those guests are on.
 */
export function detectConvention(guests: DetectGuest[], nodes: DetectNode[]): Detection {
  const nodeIndex = defaultNodeIndex(nodes.map(n => n.node))
  const statics = guests.map(g => ({ g, s: staticOf(g.config) })).filter((x): x is { g: DetectGuest; s: NonNullable<ReturnType<typeof staticOf>> } => x.s !== null)
  const follows = statics.filter(({ g, s }) => {
    const v = schemeVmid({ nodeIndex }, g.node, s.ip)
    return 'vmid' in v && v.vmid === g.vmid
  })
  const out: Detection = {
    verdict: follows.length >= 2 && follows.length * 2 > statics.length ? 'follows' : follows.length ? 'mixed' : 'none',
    matching: follows.length, considered: statics.length, total: guests.length,
    examples: follows.slice(0, 5).map(({ g, s }) => ({ vmid: g.vmid, node: g.node, ip: s.ip })),
  }
  if (!follows.length) return out

  // The network: the /prefix most following guests are on, and the hundred-block of addresses they use.
  const nets = follows.map(({ s }) => { const n = network(`${s.ip}/${s.prefix}`)!; return `${intToIp(n.base)}/${n.prefix}` })
  const subnet = mostCommon(nets)!
  const onNet = follows.filter((_, i) => nets[i] === subnet)
  const block = mostCommon(onNet.map(({ s }) => Math.floor(Number(s.ip.split('.')[3]) / 100)))!
  const prefix3 = mostCommon(onNet.map(({ s }) => s.ip.split('.').slice(0, 3).join('.')))!
  const n = network(subnet)!
  const lo = Math.max(ipToInt(`${prefix3}.${Math.max(1, block * 100)}`), n.base + 1)
  const hi = Math.min(ipToInt(`${prefix3}.${Math.min(255, block * 100 + 99)}`), n.base + n.size - 2)
  const nodeOnNet = nodes.find(x => x.address && inSubnet(x.address, subnet))
  const nodeBridge = nodeOnNet?.bridges?.find(b => b.cidr && inSubnet(bareIp(b.cidr), subnet))
  const gateway = mostCommon(onNet.map(({ s }) => s.gw).filter((x): x is string => !!x && inSubnet(x, subnet)))
    ?? (nodeBridge?.gateway && inSubnet(nodeBridge.gateway, subnet) ? nodeBridge.gateway : '')
  const bridge = mostCommon(onNet.map(({ s }) => s.bridge).filter((x): x is string => !!x)) ?? nodeBridge?.iface ?? 'vmbr0'
  const ns = mostCommon(onNet.map(({ g }) => NAMESERVER.exec(String(g.config?.nameserver ?? ''))?.[1]).filter((x): x is string => !!x))
  out.proposal = {
    subnet, rangeStart: intToIp(lo), rangeEnd: intToIp(hi), gateway, dns: ns ? [ns] : [], bridge,
    idScheme: 'node-ip', nodeIndex, dhcp: 'never',
  }
  return out
}

// ---------------------------------------------------------------------------
//  Picking the next ID and address
// ---------------------------------------------------------------------------

export interface PickContext {
  node:     string
  /** Every ID a CT or VM has, cluster-wide. */
  usedIds:  Iterable<number>
  /** Where Proxmox's own next-ID range starts. */
  nextId?:  number
  /** Every address already spoken for: guest configs (stopped guests too), live addresses, node addresses. */
  taken:    Iterable<string>
  /** Asks the node whether anything answers on `ip` (ping, then ARP). true: something does; null: could not ask. */
  ping?:    (ip: string) => Promise<boolean | null>
  /** How many candidates may be pinged before giving up. */
  maxPings?: number
}

export interface AddressPick {
  vmid:   number
  /** The address with its prefix, like "192.0.2.42/24". */
  ip:     string
  gateway: string
  bridge: string
  dns:    string[]
  vlan?:  number
  /** true: nothing answered a ping or ARP from the node. null: no check could be sent. */
  quiet:  boolean | null
  /** Addresses passed over, and why, in order. */
  skipped: Array<{ ip: string; why: string }>
  label:  string
}

/** Every address `taken` holds, from configs and from what guests report. */
export function takenAddresses(known: {
  configs: Array<{ config: Record<string, unknown> | null }>
  live?:   Array<{ addresses: string[] }>
  nodes?:  Array<{ address?: string }>
}): Set<string> {
  const out = new Set<string>()
  for (const g of known.configs) for (const a of configAddresses(g.config)) out.add(a)
  for (const g of known.live ?? []) for (const a of g.addresses) out.add(a)
  for (const n of known.nodes ?? []) if (n.address) out.add(n.address)
  return out
}

/**
 * Every address in the range in order, with the ID the scheme gives it, or why it is passed over: not a host
 * address, the gateway, held by a guest config (stopped guests too), a running guest or a node, or its ID used.
 * Nothing is pinged here; pickNext() does that.
 */
export function* candidates(s: NamingSettings, ctx: Omit<PickContext, 'ping' | 'maxPings'>): Generator<{ ip: string; vmid: number } | { ip: string; why: string }> {
  const used = new Set(Array.from(ctx.usedIds, Number))
  const taken = new Set(Array.from(ctx.taken, bareIp))
  for (let x = ipToInt(s.rangeStart); x <= ipToInt(s.rangeEnd); x++) {
    const ip = intToIp(x)
    if (!inSubnet(ip, s.subnet)) { yield { ip, why: 'not a host address in the subnet' }; continue }
    if (ip === s.gateway) { yield { ip, why: 'the gateway' }; continue }
    if (taken.has(ip)) { yield { ip, why: 'in use by a guest or a node' }; continue }
    if (s.idScheme === 'node-ip') {
      const v = schemeVmid(s, ctx.node, ip)
      if ('error' in v) { yield { ip, why: v.error }; continue }
      if (used.has(v.vmid)) { yield { ip, why: `ID ${v.vmid} is already used` }; continue }
      yield { ip, vmid: v.vmid }
    } else yield { ip, vmid: nextFreeVmid(used, ctx.nextId ?? VMID_MIN) }
  }
}

/** The first candidate, without pinging: for callers that cannot wait on the network (the assistant's draft). */
export function firstCandidate(s: NamingSettings, ctx: Omit<PickContext, 'ping' | 'maxPings'>): { ip: string; vmid: number } | null {
  if (s.idScheme === 'node-ip' && !Number.isInteger(s.nodeIndex[ctx.node])) return null
  for (const c of candidates(s, ctx)) if (!('why' in c)) return { ip: `${c.ip}/${network(s.subnet)!.prefix}`, vmid: c.vmid }
  return null
}

/**
 * The next free ID and address inside the range that fit the scheme. An address is passed over when a guest
 * config (a stopped guest's included) or a running guest has it, when it is a node's or the gateway's, when
 * the scheme's ID for it is already used, and when it answers a ping or ARP from the node. Null when the
 * range has nothing left, with the reasons in `skipped`.
 */
export async function pickNext(s: NamingSettings, ctx: PickContext): Promise<{ pick?: AddressPick; skipped: Array<{ ip: string; why: string }>; problem?: string }> {
  const skipped: Array<{ ip: string; why: string }> = []
  const prefix = network(s.subnet)!.prefix
  let pings = 0
  const maxPings = ctx.maxPings ?? 12
  if (s.idScheme === 'node-ip' && !Number.isInteger(s.nodeIndex[ctx.node])) {
    return { skipped, problem: `${ctx.node} has no index in your naming settings. Add one under Settings → Naming & addresses.` }
  }
  for (const c of candidates(s, ctx)) {
    if ('why' in c) { skipped.push(c); continue }
    const { ip, vmid } = c
    let quiet: boolean | null = null
    if (ctx.ping) {
      if (pings >= maxPings) return { skipped, problem: `${maxPings} addresses in a row answered on the network; check the range.` }
      pings++
      const answered = await ctx.ping(ip).catch(() => null)
      if (answered === true) { skipped.push({ ip, why: 'something answers on it' }); continue }
      quiet = answered === false ? true : null
    }
    return {
      skipped,
      pick: {
        vmid, ip: `${ip}/${prefix}`, gateway: s.gateway, bridge: s.bridge, dns: s.dns, ...(s.vlan ? { vlan: s.vlan } : {}),
        quiet, skipped, label: schemeLabel(s, ctx.node),
      },
    }
  }
  return { skipped, problem: `No address is left in ${s.rangeStart}–${s.rangeEnd} that fits.` }
}

/**
 * With no settings and no convention: a static address on the node's own management subnet, picked from the top
 * of the subnet down (routers usually hand out DHCP leases from the bottom), when the subnet is no bigger than a
 * /24 and the node's address and its bridge's gateway are known. Null when none can be picked safely.
 */
export function managementFallback(node: DetectNode): NamingSettings | null {
  if (!node.address) return null
  const b = node.bridges?.find(x => x.cidr && bareIp(x.cidr) === node.address) ?? node.bridges?.find(x => x.cidr && inSubnet(node.address!, x.cidr))
  if (!b?.cidr || !b.gateway) return null
  const n = network(b.cidr)
  if (!n || n.prefix < 24 || n.prefix > 29) return null
  const subnet = `${intToIp(n.base)}/${n.prefix}`
  if (!inSubnet(b.gateway, subnet)) return null
  // The top quarter of the subnet, never the broadcast address.
  const hi = n.base + n.size - 2
  const lo = Math.max(n.base + 1, n.base + Math.floor(n.size * 3 / 4))
  return {
    subnet, rangeStart: intToIp(lo), rangeEnd: intToIp(hi), gateway: b.gateway, dns: [], bridge: b.iface,
    idScheme: 'next-free', nodeIndex: {}, dhcp: 'warn',
  }
}

// ---------------------------------------------------------------------------
//  The policy, at preview and apply
// ---------------------------------------------------------------------------

export const DHCP_CONFIRM = 'DHCP'

export interface PolicyVerdict {
  errors:   string[]
  warnings: string[]
  /** What the person confirmed against the settings, to be written to the audit log at apply. */
  override?: { kind: 'dhcp' | 'outside-range'; value: string }
}

/**
 * Hold an address and ID against the naming settings. With no settings saved, DHCP is allowed with a warning.
 * DHCP when the policy is "never", and an address outside the range, need the person to type the word DHCP or
 * the address itself (`confirm`); either is then an override, audited at apply. An ID that does not follow the
 * scheme is a warning only: the person chose it.
 */
export function namingPolicy(s: NamingSettings | null, plan: { node: string; vmid: number; ip: string; bridge?: string }, confirm?: string): PolicyVerdict {
  const out: PolicyVerdict = { errors: [], warnings: [] }
  const typed = String(confirm ?? '').trim()
  if (plan.ip === 'dhcp') {
    if (!s) {
      out.warnings.push('DHCP: the address comes from whichever DHCP server answers first, and a bridge can carry more than one network. A guest published by the proxy could end up on the wrong one. Set a range under Settings → Naming & addresses to stop this.')
      return out
    }
    if (s.dhcp === 'never') {
      if (typed.toUpperCase() === DHCP_CONFIRM) {
        out.warnings.push('You confirmed DHCP although your naming settings say never. This is recorded in the audit log.')
        out.override = { kind: 'dhcp', value: 'dhcp' }
      } else out.errors.push(`Your naming settings never allow DHCP: new guests get a fixed address in ${s.rangeStart}–${s.rangeEnd}. Type ${DHCP_CONFIRM} to confirm DHCP anyway.`)
    } else if (s.dhcp === 'warn') {
      out.warnings.push(`DHCP: the address may come from another network than ${s.subnet}. Your naming settings allow it with this warning.`)
    }
    return out
  }
  if (!s) return out
  const ip = bareIp(plan.ip)
  if (!inRange(ip, s)) {
    if (typed === ip) {
      out.warnings.push(`You confirmed ${ip}, outside your range ${s.rangeStart}–${s.rangeEnd}. This is recorded in the audit log.`)
      out.override = { kind: 'outside-range', value: ip }
    } else out.errors.push(`${ip} is outside your range ${s.rangeStart}–${s.rangeEnd}${inSubnet(ip, s.subnet) ? '' : ` and not on ${s.subnet}`}. Type ${ip} to confirm it anyway.`)
  }
  if (s.idScheme === 'node-ip') {
    const v = schemeVmid(s, plan.node, ip)
    if ('vmid' in v && v.vmid !== plan.vmid) out.warnings.push(`ID ${plan.vmid} does not follow your numbering: ${ip} on ${plan.node} would be ${v.vmid}.`)
  }
  if (plan.bridge && plan.bridge !== s.bridge) {
    out.warnings.push(`Your naming settings put guests on ${s.bridge}; this one is on ${plan.bridge}.`)
  }
  return out
}
