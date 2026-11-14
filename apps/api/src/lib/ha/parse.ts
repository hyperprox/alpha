// =============================================================================
//  HyperProx — HA management: PVE's answers into an HaSnapshot, and back
//
//  Pure. The reader (read.ts) fetches; this turns rows into types and types
//  into the exact form parameters the PVE API takes.
// =============================================================================

import type {
  DeviceKind, GuestHardware, GuestType, HaGuest, HaResource, HaRule, HaServiceStatus, HaSnapshot, NodeHealth, NodePriority, Sid,
} from './types'

const num = (v: unknown, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }
const bool = (v: unknown, d = false) => v === undefined || v === null || v === '' ? d : (v === true || v === 1 || v === '1' || v === 'true')

export function sidOf(type: GuestType, vmid: number | string): Sid { return `${type === 'lxc' ? 'ct' : 'vm'}:${vmid}` }
export function parseSid(sid: string): { type: GuestType; vmid: number } | null {
  const m = /^(ct|vm):(\d+)$/.exec(String(sid).trim())
  return m ? { type: m[1] === 'ct' ? 'lxc' : 'qemu', vmid: Number(m[2]) } : null
}

/** "a:5,b:1,c" → [{a,5},{b,1},{c,0}]. A node without a priority is priority 0, as PVE reads it. */
export function parseNodes(s: unknown): NodePriority[] {
  return String(s ?? '').split(',').map(x => x.trim()).filter(Boolean).map(x => {
    const [node, pri] = x.split(':')
    return { node: node.trim(), priority: pri === undefined ? 0 : num(pri) }
  })
}

/** The inverse: nodes sharing one priority are written without it when every node does (PVE's own spelling). */
export function formatNodes(nodes: NodePriority[]): string {
  const flat = new Set(nodes.map(n => n.priority)).size <= 1 && (nodes[0]?.priority ?? 0) === 0
  return nodes.map(n => flat ? n.node : `${n.node}:${n.priority}`).join(',')
}

export const parseList = (s: unknown): string[] => String(s ?? '').split(',').map(x => x.trim()).filter(Boolean)

export function parseResource(r: any): HaResource {
  const sid = String(r.sid)
  const p = parseSid(sid)
  return {
    sid, type: sid.startsWith('vm:') ? 'vm' : 'ct', vmid: p?.vmid ?? num(r.sid),
    state: (r.state ?? 'started') as HaResource['state'],
    maxRestart: num(r.max_restart, 1), maxRelocate: num(r.max_relocate, 1),
    failback: bool(r.failback, true), autoRebalance: bool(r['auto-rebalance'], true),
    ...(r.comment ? { comment: String(r.comment) } : {}),
    ...(r.group ? { group: String(r.group) } : {}),
  }
}

export function parseRule(r: any): HaRule | null {
  const base = {
    id: String(r.rule), resources: parseList(r.resources), disabled: bool(r.disable, false),
    ...(r.comment ? { comment: String(r.comment) } : {}), ...(r.order !== undefined ? { order: num(r.order) } : {}),
  }
  if (r.type === 'node-affinity') {
    return { ...base, type: 'node-affinity', affinity: r.affinity === 'negative' ? 'negative' : 'positive', strict: bool(r.strict, false), nodes: parseNodes(r.nodes) }
  }
  if (r.type === 'resource-affinity') {
    return { ...base, type: 'resource-affinity', affinity: r.affinity === 'negative' ? 'negative' : 'positive' }
  }
  return null
}

/** Form parameters for POST /cluster/ha/rules (create) or PUT /cluster/ha/rules/{id} (set, with `id` dropped). */
export function ruleParams(rule: HaRule, forUpdate = false): Record<string, string> {
  const p: Record<string, string> = { type: rule.type, resources: rule.resources.join(','), affinity: rule.affinity }
  if (!forUpdate) p.rule = rule.id
  if (rule.type === 'node-affinity') { p.nodes = formatNodes(rule.nodes); p.strict = rule.strict ? '1' : '0' }
  if (rule.disabled) p.disable = '1'
  if (rule.comment) p.comment = rule.comment
  return p
}

export function formBody(p: Record<string, string | number | boolean | undefined>): string {
  const u = new URLSearchParams()
  for (const [k, v] of Object.entries(p)) if (v !== undefined) u.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v))
  return u.toString()
}

/** crs: "ha=dynamic,ha-rebalance-on-start=1,ha-auto-rebalance=1", or as /cluster/options returns it, an object. */
export function parseCrs(s: unknown): HaSnapshot['crs'] {
  const kv: Record<string, string> = {}
  if (s && typeof s === 'object') for (const [k, v] of Object.entries(s as Record<string, unknown>)) kv[k] = String(v)
  else for (const part of String(s ?? '').split(',')) { const [k, v] = part.split('='); if (k) kv[k.trim()] = (v ?? '').trim() }
  const mode = kv.ha === 'static' || kv.ha === 'dynamic' ? kv.ha : 'basic'
  return { mode, rebalanceOnStart: kv['ha-rebalance-on-start'] === '1', autoRebalance: kv['ha-auto-rebalance'] === '1' }
}

// --- guest config: what ties a guest to one node ------------------------------------------------------

const VOLUME_KEY = /^(rootfs|mp\d+|scsi\d+|virtio\d+|sata\d+|ide\d+|efidisk\d+|tpmstate\d+|unused\d+)$/

/** "01:00" → "0000:01:00", "01:00.1" → "0000:01:00.1": the domain added, the function kept when given. */
export function pciAddress(a: string): string {
  const x = String(a).trim().toLowerCase()
  return /^[0-9a-f]{4}:/.test(x) ? x : `0000:${x}`
}

/** The class of a passed-through address: a whole device ("01:00") is classed by its function .0. */
function pciClass(pci: Record<string, string>, addr: string): string | undefined {
  return pci[addr] ?? (/\.[0-7]$/.test(addr) ? undefined : pci[`${addr}.0`])
}

/** A PCI class code (0x030000) in words, and whether it is a GPU. */
export function pciKind(cls: string | undefined): { kind: DeviceKind; words: string } {
  const c = String(cls ?? '').toLowerCase().replace(/^0x/, '')
  if (c.startsWith('03')) return { kind: 'gpu', words: 'a GPU' }
  if (c.startsWith('02')) return { kind: 'nic', words: 'a network card' }
  if (c.startsWith('01')) return { kind: 'hba', words: 'a storage controller (HBA)' }
  if (c.startsWith('0c03')) return { kind: 'usb', words: 'a USB controller' }
  return { kind: 'pci', words: 'a PCI device' }
}

/**
 * Reads a guest config for the things that pin it to a node. `shared` lists storage ids reachable from every
 * node; `pci` maps the guest's node's PCI addresses to their class (from /nodes/{node}/hardware/pci);
 * `mappings` maps a resource-mapping id to the nodes it exists on.
 */
export function hardwareOf(type: GuestType, config: Record<string, unknown> | null | undefined, shared: string[],
  pci: Record<string, string> = {}, mappings: Record<string, string[]> = {}, node?: string): GuestHardware {
  const hw: GuestHardware = { bindMounts: [], sharedMounts: [], devices: [], localVolumes: [] }
  if (!config) return hw
  const sharedSet = new Set(shared)
  const here = node ? [node] : undefined
  const push = (d: GuestHardware['devices'][number]) => { if (!hw.devices.some(x => x.what === d.what && x.required === d.required)) hw.devices.push(d) }
  for (const [key, raw] of Object.entries(config)) {
    const v = String(raw ?? '')
    if (type === 'lxc' && /^(rootfs|mp\d+)$/.test(key)) {
      const parts = v.split(',')
      const first = parts[0]
      const opts = Object.fromEntries(parts.slice(1).map(p => { const [k, ...r] = p.split('='); return [k, r.join('=')] }))
      if (first.startsWith('/')) {
        const target = opts.mp
        if (opts.shared === '1') hw.sharedMounts.push({ key, path: first })
        else hw.bindMounts.push({ key, path: first, ...(target ? { target } : {}) })
        continue
      }
      const storage = first.includes(':') ? first.split(':')[0] : ''
      if (storage && !sharedSet.has(storage) && opts.shared !== '1') hw.localVolumes.push({ key, storage })
      continue
    }
    if (type === 'qemu' && VOLUME_KEY.test(key) && !key.startsWith('unused')) {
      if (/media=cdrom/.test(v) && (/^none/.test(v) || /^cdrom/.test(v))) continue
      const first = v.split(',')[0]
      if (first.startsWith('/')) { push({ key, what: `a host disk (${first})`, kind: 'disk', required: true, nodes: here }); continue }
      const storage = first.includes(':') ? first.split(':')[0] : ''
      if (storage && storage !== 'none' && !sharedSet.has(storage) && !/media=cdrom/.test(v)) hw.localVolumes.push({ key, storage })
      continue
    }
    if (type === 'qemu' && /^hostpci\d+$/.test(key)) {
      const mapped = /mapping=([^,]+)/.exec(v)
      if (mapped) { push({ key, what: `a mapped PCI device (${mapped[1]})`, kind: 'pci', required: true, nodes: mappings[mapped[1]] ?? here }); continue }
      const addrs = v.split(',')[0].split(';').map(pciAddress)
      const k = pciKind(pciClass(pci, addrs[0]))
      push({ key, what: `${k.words} (${addrs.join(', ')})`, kind: k.kind, required: true, nodes: here })
      continue
    }
    if (type === 'qemu' && /^usb\d+$/.test(key)) {
      if (/host=/.test(v) || /mapping=/.test(v)) push({ key, what: `a USB device (${v.split(',')[0]})`, kind: 'usb', required: false, nodes: here })
      continue
    }
    if (type === 'lxc' && /^dev\d+$/.test(key)) {
      if (standardDevice(v.split(',')[0])) continue
      push({ key, what: `a host device (${v.split(',')[0]})`, kind: 'dev', required: true, nodes: here }); continue
    }
  }
  // Raw lxc.* lines, as /config returns them: { lxc: [["lxc.cgroup2.devices.allow", "c 195:* rwm"], ...] }
  const rawLxc = (config as any).lxc
  const lines: Array<[string, string]> = []
  if (type === 'lxc' && Array.isArray(rawLxc)) for (const pair of rawLxc) if (Array.isArray(pair)) lines.push([String(pair[0]), String(pair[1])])
  if (type === 'lxc') for (const [k, v] of Object.entries(config)) if (/^lxc\./.test(k)) lines.push([k, String(v)])
  for (const [k, v] of lines) {
    if (!/^lxc\.(cgroup2?\.devices\.allow|mount\.entry)/.test(k)) continue
    if (standardDevice(v.trim().split(/\s+/)[0])) continue
    const d = lxcDevice(v)
    if (!d) continue
    // A cgroup permission alone never blocks a start; a mount entry does unless it is marked optional.
    const required = /mount\.entry/.test(k) && !/\boptional\b/.test(v)
    push({ key: k, what: d.what, kind: d.kind, required, nodes: here })
  }
  // A device that is also mounted optionally is optional overall.
  hw.devices = hw.devices.filter(d => d.required || !hw.devices.some(x => x !== d && x.what === d.what && x.required))
  return hw
}

/**
 * Character devices every Proxmox node has (the kernel makes them; no hardware behind them): a guest that uses
 * one can start on any node, so it is no reason to stay put. /dev/net/tun (VPNs), /dev/fuse, /dev/kvm and the
 * usual /dev/null family.
 */
const STANDARD_DEVICES = new Set(['/dev/net/tun', '/dev/fuse', '/dev/kvm', '/dev/null', '/dev/zero', '/dev/full',
  '/dev/random', '/dev/urandom', '/dev/tty', '/dev/ptmx', '/dev/loop-control', '/dev/vhost-net', '/dev/vhost-vsock'])
export function standardDevice(path: string): boolean {
  const p = path.startsWith('/') ? path : `/${path}`
  return STANDARD_DEVICES.has(p.replace(/\/+$/, ''))
}

function lxcDevice(v: string): { what: string; kind: DeviceKind } | null {
  if (/\bc 195:|nvidia/i.test(v)) return { what: 'an NVIDIA GPU', kind: 'gpu' }
  if (/\bc 226:|\/dev\/dri/.test(v)) return { what: 'a GPU (/dev/dri)', kind: 'gpu' }
  if (/\bc 189:|\/dev\/bus\/usb/.test(v)) return { what: 'USB devices', kind: 'usb' }
  if (/\/dev\/(tty(USB|ACM)\w*|serial)/.test(v)) return { what: 'a serial/USB adapter', kind: 'dev' }
  if (/^\/dev\//.test(v)) return { what: `a host device (${v.split(' ')[0]})`, kind: 'dev' }
  return null
}

export const tiedToNode = (hw?: GuestHardware) => !!hw && (hw.bindMounts.length + hw.devices.length + hw.localVolumes.length) > 0

/** The reasons, in words, that a guest's hardware keeps it on its node. */
export function hardwareWords(hw?: GuestHardware): string[] {
  if (!hw) return []
  const out: string[] = []
  for (const b of hw.bindMounts) out.push(`a local bind mount (${b.path})`)
  for (const d of hw.devices) out.push(d.what)
  for (const l of hw.localVolumes) out.push(`a disk on node-local storage "${l.storage}"`)
  return out
}

// --- the snapshot ---------------------------------------------------------------------------------

export interface RawHa {
  resources:  any[]
  rules:      any[]
  status:     any[]
  manager?:   any
  nodes:      any[]
  vms:        any[]
  storage:    any[]
  options?:   any
  configs?:   Record<string, Record<string, unknown> | null>
  /** node → PCI address → class, for nodes whose HA VMs pass PCI devices through. */
  pci?:       Record<string, Record<string, string>>
  /** PCI resource mappings: id → nodes it exists on. */
  mappings?:  Record<string, string[]>
}

export function buildSnapshot(raw: RawHa): HaSnapshot {
  const resources = (raw.resources ?? []).map(parseResource)
  const rules = (raw.rules ?? []).map(parseRule).filter((r): r is HaRule => !!r)
  const statusRows = raw.status ?? []
  const quorumRow = statusRows.find((r: any) => r.type === 'quorum')
  const fencingRow = statusRows.find((r: any) => r.type === 'fencing')
  const masterRow = statusRows.find((r: any) => r.type === 'master')
  const lrmMode = (node: string): string => {
    const m = raw.manager?.lrm_status?.[node]?.mode
    if (m) return String(m)
    const row = statusRows.find((r: any) => r.type === 'lrm' && r.node === node)
    return /maintenance/.test(String(row?.status ?? '')) ? 'maintenance' : 'active'
  }
  const nodeStatus = raw.manager?.node_status ?? {}
  const nodes: NodeHealth[] = (raw.nodes ?? []).map((n: any) => ({
    node: String(n.node), online: n.status === 'online' && (nodeStatus[n.node] ?? 'online') !== 'fence' && nodeStatus[n.node] !== 'unknown',
    maintenance: lrmMode(String(n.node)) === 'maintenance' || nodeStatus[n.node] === 'maintenance',
    mem: num(n.mem), maxmem: num(n.maxmem), cpu: num(n.cpu), maxcpu: num(n.maxcpu, 1),
  })).sort((a: NodeHealth, b: NodeHealth) => a.node.localeCompare(b.node))
  const sharedStorage = Array.from(new Set((raw.storage ?? []).filter((s: any) => num(s.shared) === 1).map((s: any) => String(s.storage)))) as string[]
  const guests: HaGuest[] = (raw.vms ?? []).filter((v: any) => v.type === 'lxc' || v.type === 'qemu').map((v: any) => {
    const type = v.type as GuestType
    const sid = sidOf(type, v.vmid)
    const cfg = raw.configs?.[sid]
    // A container with no `cores` is not limited, and PVE then reports its host's thread count: not a need.
    const cpus = type === 'lxc' && cfg && cfg.cores === undefined ? 0 : num(v.maxcpu)
    return {
      vmid: num(v.vmid), type, sid, name: String(v.name ?? ''), node: String(v.node), status: String(v.status ?? 'unknown'),
      maxmem: num(v.maxmem), cpus, template: num(v.template) === 1,
      ...(cfg !== undefined ? { hardware: hardwareOf(type, cfg, sharedStorage, raw.pci?.[String(v.node)] ?? {}, raw.mappings ?? {}, String(v.node)) } : {}),
    }
  }).sort((a: HaGuest, b: HaGuest) => a.vmid - b.vmid)
  const services: HaServiceStatus[] = statusRows.filter((r: any) => r.type === 'service').map((r: any) => ({
    sid: String(r.sid), node: String(r.node), state: String(r.state ?? ''), requestState: String(r.request_state ?? r.state ?? ''),
    ...(r.crm_state ? { crmState: String(r.crm_state) } : {}),
  }))
  const armed = String(fencingRow?.['armed-state'] ?? '')
  const rmode = String(fencingRow?.['resource-mode'] ?? (/resource mode: (\w+)/.exec(String(fencingRow?.status ?? ''))?.[1] ?? ''))
  return {
    resources, rules, nodes, guests, services,
    quorate: quorumRow ? num(quorumRow.quorate) === 1 : false,
    fencing: (['armed', 'standby', 'disarming', 'disarmed'].includes(armed) ? armed : 'unknown') as HaSnapshot['fencing'],
    disarmMode: armed === 'disarmed' || armed === 'disarming' ? (rmode === 'ignore' ? 'ignore' : rmode === 'freeze' ? 'freeze' : null) : null,
    master: masterRow?.node ? String(masterRow.node) : null,
    crs: parseCrs(raw.options?.crs),
    digests: { resources: raw.resources?.[0]?.digest ?? null, rules: raw.rules?.[0]?.digest ?? null },
    sharedStorage,
  }
}
