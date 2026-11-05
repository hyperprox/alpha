// =============================================================================
//  HyperProx — turning an edit into a plan: the exact keys written, the change
//  in words, what waits for a restart, and what must be true afterwards
//
//  Pure functions. The service (service.ts) reads the cluster, calls these, holds
//  the result as a server-side preview, and on apply writes exactly plan.ops and
//  then checks plan.expect against a fresh read.
// =============================================================================

import { isIP } from 'node:net'
import {
  type GuestType, type PveConfig, parseProps, getProp, setProp, buildProps, str, normalise, comparable,
  isEditable, isRaw, isDeviceKey, isVolatile, rawLines, freeIndex,
} from './keys'

export type Restart = 'live' | 'restart' | 'maybe'

export interface Change {
  key: string
  label: string
  before: string | null
  after: string | null
  /** The change in plain words. */
  words: string
  /** Whether it takes effect on a running guest now, or waits in [pve:pending] for a restart. */
  restart: Restart
}

export type WriteOp =
  | { kind: 'config'; set: Record<string, string>; delete: string[] }
  | { kind: 'resize'; disk: string; size: string }

export interface Expect {
  key: string
  /** null: the key must be gone. */
  value: string | null
  /** A new volume ("storage:8") comes back as a volume name on that storage with size=8G. */
  alloc?: { storage: string; sizeGb: number }
  /** A resize: the size must be at least this. */
  minSizeGb?: number
}

export interface Plan {
  changes: Change[]
  ops: WriteOp[]
  expect: Expect[]
  /** Every key a write touches. Anything else must read back exactly as it was. */
  touched: string[]
  /** Keys a write may add as a side effect (a removed mount point's volume becomes unusedN). */
  mayAppear: string[]
  warnings: string[]
  errors: string[]
  checks: string[]
  /** After the restart, these device paths must (or must not) exist inside the guest. */
  deviceChecks: Array<{ path: string; present: boolean }>
  /** Reasons that need an extra, explicit confirmation before apply. */
  extraConfirm: string[]
  /** The confirmation names the guest (device and raw-line changes). */
  confirmName: boolean
  /** Kept with the history row (e.g. the exact entries a "GPU off" removed). */
  meta?: Record<string, unknown>
  /**
   * Raw lxc.* lines to change in the guest's config file. The API refuses these, so they go through the whole-file
   * writer (rawfile.ts) under its guards. Applies the next time the container starts.
   */
  rawFile?: { remove: Array<[string, string]>; add: Array<[string, string]> }
  /** Entries the person may add to this change ("remove these too?"); not part of it unless chosen. */
  options?: Array<{ key: string; value: string; label: string }>
  /** When rawFile is set: the main section's raw lines the API must read back afterwards, in order. */
  expectRaw?: Array<[string, string]>
}

export interface GuestCtx {
  type: GuestType
  vmid: number
  node: string
  name: string
  running: boolean
  /** The config with pending values applied (Proxmox's default read), including its digest. */
  config: PveConfig
  /** Keys with a pending change, from /pending. */
  pendingKeys: string[]
  haManaged: boolean
}

export function emptyPlan(): Plan {
  return { changes: [], ops: [], expect: [], touched: [], mayAppear: [], warnings: [], errors: [], checks: [], deviceChecks: [], extraConfirm: [], confirmName: false }
}

// ── what applies live ────────────────────────────────────────────────────────

const LXC_LIVE = /^(cores|cpulimit|cpuunits|memory|swap|description|tags|onboot|startup|net\d+)$/
const LXC_MAYBE = /^(nameserver|searchdomain|hostname|mp\d+|rootfs)$/
const QEMU_LIVE = /^(description|tags|onboot|startup|name|net\d+|balloon|cpulimit|cpuunits|(scsi|virtio|sata|ide)\d+)$/

export function restartFor(type: GuestType, key: string, running: boolean): Restart {
  if (!running) return 'live'
  if (type === 'lxc') return LXC_LIVE.test(key) ? 'live' : LXC_MAYBE.test(key) ? 'maybe' : 'restart'
  return QEMU_LIVE.test(key) ? 'live' : 'restart'
}

// ── labels and words ─────────────────────────────────────────────────────────

const LABELS: Record<string, string> = {
  cores: 'CPU cores', sockets: 'CPU sockets', memory: 'Memory', swap: 'Swap', balloon: 'Minimum memory (balloon)',
  cpulimit: 'CPU limit', cpuunits: 'CPU weight', onboot: 'Start at boot', startup: 'Startup order',
  description: 'Description', tags: 'Tags', nameserver: 'DNS servers', searchdomain: 'DNS search domain',
  hostname: 'Hostname', name: 'Name', boot: 'Boot order', agent: 'QEMU guest agent', rootfs: 'Root disk',
}

export function labelOf(key: string): string {
  if (LABELS[key]) return LABELS[key]
  const m = /^([a-z]+)(\d+)$/.exec(key)
  if (!m) return key
  const kind: Record<string, string> = { net: 'Network', mp: 'Mount point', dev: 'Device', hostpci: 'PCI passthrough', usb: 'USB', serial: 'Serial port', ipconfig: 'IP config', unused: 'Unused disk', scsi: 'Disk', virtio: 'Disk', sata: 'Disk', ide: 'Disk' }
  return `${kind[m[1]] ?? m[1]} ${key}`
}

const MIB = (v: string) => `${v} MiB`
function show(key: string, v: string | null): string {
  if (v === null || v === '') return 'not set'
  if (key === 'memory' || key === 'swap' || key === 'balloon') return MIB(v)
  if (key === 'onboot' || key === 'agent') return /^(1|enabled=1)/.test(v) ? 'yes' : 'no'
  if (key === 'description') return v.length > 60 ? `“${v.slice(0, 57)}…”` : `“${v}”`
  return v
}

function propWords(key: string, before: string | null, after: string | null): string {
  if (before === null) return `${labelOf(key)} added: ${after}`
  if (after === null) return `${labelOf(key)} removed (was ${before})`
  const b = parseProps(before), a = parseProps(after)
  const keys = [...new Set([...b.pairs.map(p => p[0]), ...a.pairs.map(p => p[0])])]
  const parts: string[] = []
  if ((b.head ?? '') !== (a.head ?? '')) parts.push(`${b.head ?? 'none'} → ${a.head ?? 'none'}`)
  const names: Record<string, string> = { ip: 'address', gw: 'gateway', tag: 'VLAN', firewall: 'firewall', rate: 'rate limit (MB/s)', bridge: 'bridge', mp: 'path', size: 'size', shared: 'shared', ro: 'read-only', backup: 'backup', gid: 'group id', mode: 'mode' }
  for (const k of keys) {
    const bv = getProp(b, k), av = getProp(a, k)
    if (bv !== av) parts.push(`${names[k] ?? k} ${bv ?? 'none'} → ${av ?? 'none'}`)
  }
  return `${labelOf(key)}: ${parts.join('; ') || 'rewritten, same values'}`
}

export function wordsFor(key: string, before: string | null, after: string | null): string {
  if (/^(net|mp|dev|hostpci|usb|ipconfig|rootfs|scsi|virtio|sata|ide)\d*$/.test(key)) return propWords(key, before, after)
  if (key === 'tags') {
    const b = new Set((before ?? '').split(/[;, ]+/).filter(Boolean)), a = new Set((after ?? '').split(/[;, ]+/).filter(Boolean))
    const add = [...a].filter(t => !b.has(t)), rem = [...b].filter(t => !a.has(t))
    return `Tags: ${[add.length ? `add ${add.map(t => `'${t}'`).join(', ')}` : '', rem.length ? `remove ${rem.map(t => `'${t}'`).join(', ')}` : ''].filter(Boolean).join('; ')}`
  }
  if (after === null) return `${labelOf(key)}: cleared (was ${show(key, before)})`
  return `${labelOf(key)}: ${show(key, before)} → ${show(key, after)}`
}

// ── the structured edit ──────────────────────────────────────────────────────

export interface NetEdit {
  bridge?: string
  /** 'dhcp', or an address in CIDR form. LXC only (a VM's address lives in ipconfigN). */
  ip?: string
  gw?: string | null
  tag?: number | null
  firewall?: boolean
  rate?: number | null
  /** New LXC interfaces need a name inside the container (eth1...). */
  name?: string
  /** New VM interfaces need a model. */
  model?: string
}

export interface MountAdd {
  kind: 'volume' | 'bind'
  /** volume: the PVE storage ID. */
  storage?: string
  sizeGb?: number
  /** bind: the host path. */
  source?: string
  /** Where it appears inside the container. */
  mp: string
  ro?: boolean
  backup?: boolean
  shared?: boolean
}

export interface StructuredEdit {
  cores?: number; sockets?: number; memory?: number; swap?: number; balloon?: number
  cpulimit?: number | null; cpuunits?: number | null
  onboot?: boolean; startup?: string | null
  description?: string; tags?: string[]
  nameserver?: string | null; searchdomain?: string | null
  hostname?: string; name?: string
  boot?: string; agent?: boolean
  net?: Record<string, NetEdit | null>
  ipconfig?: Record<string, { ip?: string; gw?: string | null } | null>
  mounts?: {
    add?: MountAdd[]
    remove?: string[]
    resize?: Array<{ key: string; sizeGb: number }>
    shared?: Array<{ key: string; shared: boolean }>
  }
}

/** The result of checking one host path on every node, for shared=1. */
export interface PathCheck {
  path: string
  ok: boolean
  /** Nodes where it is missing or not a directory. */
  missing: string[]
  /** Nodes that could not be asked (offline, no login). */
  unverified: string[]
  detail: string[]
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/
const CIDR4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}\/([0-9]|[12]\d|3[0-2])$/
const isIp = (a: string) => isIP(a) !== 0
const BRIDGE = /^[a-zA-Z][a-zA-Z0-9_.-]{0,14}$/
const TAG = /^[a-z0-9_][a-z0-9_\-+.]*$/i
const DOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i
const STARTUP = /^(order=\d+)?(,?up=\d+)?(,?down=\d+)?$/
const BOOT = /^order=[a-z0-9]+(;[a-z0-9]+)*$/
const ABS_PATH = /^\/[^\0\n,=;]*$/
const STORAGE_ID = /^[a-zA-Z][a-zA-Z0-9_.-]*$/
const NO_NL = (s: string) => !/[\n\r\0]/.test(s)

function int(v: unknown, min: number, max: number, what: string, errors: string[]): string | undefined {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) { errors.push(`${what} must be a whole number from ${min} to ${max}.`); return undefined }
  return String(v)
}

/** Build the plan for a structured edit. `checks` holds the shared=1 path verification the service ran. */
export function buildEditPlan(g: GuestCtx, e: StructuredEdit, pathChecks: Record<string, PathCheck> = {}): Plan {
  const p = emptyPlan()
  const cfg = g.config
  const set: Record<string, string> = {}
  const del: string[] = []
  const cur = (k: string): string | null => (cfg[k] === undefined ? null : str(cfg[k]))
  const want = (k: string, v: string | null) => {
    const before = cur(k)
    if (v === null) { if (before !== null) { del.push(k) } return }
    if (before !== null && normalise(k, before) === normalise(k, v)) return
    set[k] = v
  }
  const isLxc = g.type === 'lxc'

  if (e.cores !== undefined) { const v = int(e.cores, 1, 512, 'Cores', p.errors); if (v) want('cores', v) }
  if (e.sockets !== undefined) { if (isLxc) p.errors.push('Containers have no sockets.'); else { const v = int(e.sockets, 1, 16, 'Sockets', p.errors); if (v) want('sockets', v) } }
  if (e.memory !== undefined) { const v = int(e.memory, 16, 4 * 1024 * 1024, 'Memory (MiB)', p.errors); if (v) want('memory', v) }
  if (e.swap !== undefined) { if (!isLxc) p.errors.push('A VM has no swap setting.'); else { const v = int(e.swap, 0, 4 * 1024 * 1024, 'Swap (MiB)', p.errors); if (v) want('swap', v) } }
  if (e.balloon !== undefined) {
    if (isLxc) p.errors.push('Containers have no balloon.')
    else { const v = int(e.balloon, 0, 4 * 1024 * 1024, 'Balloon (MiB)', p.errors); if (v) want('balloon', v) }
  }
  if (e.cpulimit !== undefined) {
    if (e.cpulimit === null || e.cpulimit === 0) want('cpulimit', null)
    else if (typeof e.cpulimit !== 'number' || e.cpulimit < 0 || e.cpulimit > 512) p.errors.push('CPU limit must be between 0 and 512 cores.')
    else want('cpulimit', String(e.cpulimit))
  }
  if (e.cpuunits !== undefined) { if (e.cpuunits === null) want('cpuunits', null); else { const v = int(e.cpuunits, 1, 262144, 'CPU weight', p.errors); if (v) want('cpuunits', v) } }
  if (e.onboot !== undefined) want('onboot', e.onboot ? '1' : '0')
  if (e.startup !== undefined) {
    if (e.startup === null || e.startup === '') want('startup', null)
    else if (!STARTUP.test(e.startup)) p.errors.push('Startup order looks like order=3,up=30,down=60.')
    else want('startup', e.startup)
  }
  if (e.description !== undefined) {
    if (typeof e.description !== 'string' || e.description.length > 8192) p.errors.push('The description must be text, at most 8 KB.')
    else want('description', e.description === '' ? null : e.description)
  }
  if (e.tags !== undefined) {
    const bad = (e.tags ?? []).filter(t => !TAG.test(t))
    if (!Array.isArray(e.tags) || bad.length) p.errors.push(`Tags may hold letters, digits and - _ + . only${bad.length ? ` (not ${bad.map(t => `'${t}'`).join(', ')})` : ''}.`)
    else want('tags', e.tags.length ? [...new Set(e.tags.map(t => t.toLowerCase()))].sort().join(';') : null)
  }
  if (e.nameserver !== undefined) {
    if (e.nameserver === null || e.nameserver.trim() === '') want('nameserver', null)
    else {
      const list = e.nameserver.trim().split(/[\s,]+/)
      if (list.some(a => !isIp(a))) p.errors.push('DNS servers must be IPv4 or IPv6 addresses, separated by spaces.')
      else want('nameserver', list.join(' '))
    }
  }
  if (e.searchdomain !== undefined) {
    if (e.searchdomain === null || e.searchdomain.trim() === '') want('searchdomain', null)
    else if (e.searchdomain.trim().split(/\s+/).some(d => !DOMAIN.test(d))) p.errors.push('The search domain must be a domain name.')
    else want('searchdomain', e.searchdomain.trim())
  }
  if (e.hostname !== undefined) {
    if (!isLxc) p.errors.push('A VM is renamed with name, not hostname.')
    else if (!DOMAIN.test(e.hostname) || e.hostname.length > 63) p.errors.push('The hostname must be a valid DNS name.')
    else want('hostname', e.hostname)
  }
  if (e.name !== undefined) {
    if (isLxc) p.errors.push('A container is renamed with hostname.')
    else if (!DOMAIN.test(e.name)) p.errors.push('The name must be a valid DNS name.')
    else want('name', e.name)
  }
  if (e.boot !== undefined) {
    if (isLxc) p.errors.push('Containers have no boot order; use the startup order.')
    else if (!BOOT.test(e.boot)) p.errors.push('Boot order looks like order=scsi0;net0.')
    else want('boot', e.boot)
  }
  if (e.agent !== undefined) {
    if (isLxc) p.errors.push('Containers have no guest agent.')
    else {
      const prev = parseProps(cur('agent') ?? '', true)
      const first = prev.pairs[0]
      // "1" and "enabled=1,fstrim_cloned_disks=1" are both valid; keep the other options.
      if (first && first[1] === null) prev.pairs[0] = ['enabled', first[0]]
      want('agent', buildProps(setProp(prev, 'enabled', e.agent ? '1' : '0')))
    }
  }

  for (const [key, ne] of Object.entries(e.net ?? {})) {
    if (!/^net\d+$/.test(key)) { p.errors.push(`${key} is not a network interface key.`); continue }
    if (ne === null) {
      if (cur(key) !== null) { want(key, null); p.warnings.push(`${key} is removed: anything reaching the guest through it stops.`) }
      continue
    }
    const existing = cur(key)
    let props = parseProps(existing ?? '', isLxc)
    if (existing === null) {
      if (isLxc) props = { pairs: [['name', ne.name ?? `eth${key.slice(3)}`]] }
      else props = { pairs: [[ne.model ?? 'virtio', null]] }
      if (!ne.bridge) p.errors.push(`A new interface ${key} needs a bridge.`)
    }
    if (ne.name !== undefined && isLxc) { if (!/^[a-z][a-z0-9]{0,14}$/.test(ne.name)) p.errors.push('The interface name must be like eth1.'); else props = setProp(props, 'name', ne.name) }
    if (ne.bridge !== undefined) { if (!BRIDGE.test(ne.bridge)) p.errors.push(`'${ne.bridge}' is not a bridge name.`); else props = setProp(props, 'bridge', ne.bridge) }
    if (ne.ip !== undefined) {
      if (!isLxc) p.errors.push('A VM’s address is set in its IP config (cloud-init), not on the interface.')
      else if (ne.ip !== 'dhcp' && ne.ip !== 'manual' && !CIDR4.test(ne.ip)) p.errors.push('The address must be dhcp, or like 192.0.2.10/24.')
      else props = setProp(props, 'ip', ne.ip)
      if (isLxc && ne.ip === 'dhcp') props = setProp(props, 'gw', undefined)
    }
    if (ne.gw !== undefined) {
      if (!isLxc) p.errors.push('A VM’s gateway is set in its IP config (cloud-init).')
      else if (ne.gw === null || ne.gw === '') props = setProp(props, 'gw', undefined)
      else if (!IPV4.test(ne.gw)) p.errors.push('The gateway must be an IPv4 address.')
      else props = setProp(props, 'gw', ne.gw)
    }
    if (ne.tag !== undefined) {
      if (ne.tag === null) props = setProp(props, 'tag', undefined)
      else { const v = int(ne.tag, 1, 4094, 'VLAN tag', p.errors); if (v) props = setProp(props, 'tag', v) }
    }
    if (ne.firewall !== undefined) props = setProp(props, 'firewall', ne.firewall ? '1' : '0')
    if (ne.rate !== undefined) {
      if (ne.rate === null || ne.rate === 0) props = setProp(props, 'rate', undefined)
      else if (typeof ne.rate !== 'number' || ne.rate < 0 || ne.rate > 100000) p.errors.push('Rate limit is in MB/s, up to 100000.')
      else props = setProp(props, 'rate', String(ne.rate))
    }
    want(key, buildProps(props))
    if (existing && (getProp(parseProps(existing), 'ip') !== getProp(props, 'ip') || getProp(parseProps(existing), 'bridge') !== getProp(props, 'bridge') || getProp(parseProps(existing), 'tag') !== getProp(props, 'tag')))
      if (g.running) p.warnings.push(`${key} changes address, bridge or VLAN: connections through it drop while it is re-plugged.`)
  }

  for (const [key, ic] of Object.entries(e.ipconfig ?? {})) {
    if (isLxc || !/^ipconfig\d+$/.test(key)) { p.errors.push(`${key} is a VM cloud-init key.`); continue }
    if (ic === null) { want(key, null); continue }
    let props = parseProps(cur(key) ?? '', true)
    if (ic.ip !== undefined) { if (ic.ip !== 'dhcp' && !CIDR4.test(ic.ip)) p.errors.push('The address must be dhcp, or like 192.0.2.10/24.'); else props = setProp(props, 'ip', ic.ip) }
    if (ic.gw !== undefined) { if (ic.gw === null || ic.gw === '') props = setProp(props, 'gw', undefined); else if (!IPV4.test(ic.gw)) p.errors.push('The gateway must be an IPv4 address.'); else props = setProp(props, 'gw', ic.gw) }
    want(key, buildProps(props))
    p.warnings.push(`${key} is cloud-init: the guest picks it up on its next boot, if it runs cloud-init.`)
  }

  // ── mount points ──
  const m = e.mounts ?? {}
  const taken = new Set([...Object.keys(cfg), ...Object.keys(set)])
  for (const add of m.add ?? []) {
    if (!isLxc) { p.errors.push('Mount points are a container feature; add a disk to a VM instead.'); break }
    if (!add.mp || !ABS_PATH.test(add.mp) || add.mp === '/') { p.errors.push('A mount point needs an absolute path inside the container.'); continue }
    let head: string
    if (add.kind === 'volume') {
      if (!add.storage || !STORAGE_ID.test(add.storage)) { p.errors.push('A volume mount point needs a storage ID.'); continue }
      const v = int(add.sizeGb, 1, 65536, 'Volume size (GB)', p.errors); if (!v) continue
      head = `${add.storage}:${v}`
    } else if (add.kind === 'bind') {
      if (!add.source || !ABS_PATH.test(add.source) || add.source === '/') { p.errors.push('A bind mount needs an absolute host path.'); continue }
      head = add.source
    } else { p.errors.push('A mount point is a volume or a bind mount.'); continue }
    const key = `mp${freeIndex('mp', taken)}`
    taken.add(key)
    let props: ReturnType<typeof parseProps> = { head, pairs: [['mp', add.mp]] }
    if (add.ro) props = setProp(props, 'ro', '1')
    if (add.backup !== undefined && add.kind === 'volume') props = setProp(props, 'backup', add.backup ? '1' : '0')
    if (add.shared) {
      if (add.kind !== 'bind') p.errors.push('shared=1 is for bind mounts: a volume on shared storage is shared already.')
      else if (!sharedAllowed(add.source!, pathChecks, p)) continue
      else props = setProp(props, 'shared', '1')
    }
    if (add.kind === 'bind' && !add.shared) p.warnings.push(`${key} is a plain bind mount: the container can no longer be migrated, and if its node dies HA starts it elsewhere with no way back (mark it shared only if ${add.source} exists on every node).`)
    set[key] = buildProps(props)
  }
  for (const key of m.remove ?? []) {
    if (!/^mp\d+$/.test(key) || cur(key) === null) { p.errors.push(`${key} is not a mount point on this guest.`); continue }
    del.push(key)
    const head = parseProps(cur(key)!).head ?? ''
    if (!head.startsWith('/')) { p.mayAppear.push('unused*'); p.warnings.push(`${key} is unmounted; its volume is kept as an unused disk, nothing is deleted.`) }
  }
  for (const s of m.shared ?? []) {
    const before = cur(s.key)
    if (!/^mp\d+$/.test(s.key) || before === null) { p.errors.push(`${s.key} is not a mount point on this guest.`); continue }
    const props = parseProps(before)
    if (!(props.head ?? '').startsWith('/')) { p.errors.push(`${s.key} is a volume; shared=1 is for bind mounts.`); continue }
    if (s.shared && !sharedAllowed(props.head!, pathChecks, p)) continue
    want(s.key, buildProps(setProp(props, 'shared', s.shared ? '1' : undefined)))
    if (!s.shared) p.warnings.push(`Without shared=1 the container can fail over but never migrate back.`)
  }

  // Config write first (one PUT), resizes after it.
  if (Object.keys(set).length || del.length) p.ops.push({ kind: 'config', set, delete: del })
  for (const r of m.resize ?? []) {
    const before = cur(r.key)
    if (before === null || !(/^(mp\d+|rootfs)$/.test(r.key) || /^(scsi|virtio|sata|ide)\d+$/.test(r.key))) { p.errors.push(`${r.key} is not a disk on this guest.`); continue }
    const props = parseProps(before)
    if ((props.head ?? '').startsWith('/')) { p.errors.push(`${r.key} is a bind mount; it has no size.`); continue }
    const now = sizeGb(getProp(props, 'size'))
    const v = int(r.sizeGb, 1, 65536, 'Size (GB)', p.errors); if (!v) continue
    if (now !== null && r.sizeGb <= now) { p.errors.push(`${r.key} is ${now} GB; a resize only grows (shrinking would destroy data).`); continue }
    p.ops.push({ kind: 'resize', disk: r.key, size: `${r.sizeGb}G` })
    p.changes.push({ key: r.key, label: labelOf(r.key), before: now === null ? null : `${now}G`, after: `${r.sizeGb}G`, words: `${labelOf(r.key)}: grow ${now ?? '?'} GB → ${r.sizeGb} GB (cannot be shrunk back)`, restart: 'live' })
    p.expect.push({ key: r.key, value: before, minSizeGb: r.sizeGb })
    p.touched.push(r.key)
  }

  addConfigChanges(p, g, set, del)
  return p
}

function sharedAllowed(path: string, checks: Record<string, PathCheck>, p: Plan): boolean {
  const c = checks[path]
  if (!c) { p.errors.push(`${path} has not been checked on every node, so shared=1 is refused.`); return false }
  if (c.missing.length) { p.errors.push(`shared=1 refused: ${path} is missing on ${c.missing.join(', ')}. A guest started there would see an empty directory.`); return false }
  if (c.unverified.length) { p.errors.push(`shared=1 refused: cannot verify ${path} on ${c.unverified.join(', ')}.`); return false }
  p.checks.push(`${path} exists on every node (${c.detail.join('; ')})`)
  p.warnings.push('With shared=1 Proxmox assumes the same data is at that path on every node; it does not copy anything.')
  return true
}

export function sizeGb(s: string | undefined): number | null {
  if (!s) return null
  const m = /^(\d+(?:\.\d+)?)([KMGT])?$/i.exec(s)
  if (!m) return null
  const n = Number(m[1]), u = (m[2] ?? 'G').toUpperCase()
  return u === 'T' ? n * 1024 : u === 'G' ? n : u === 'M' ? n / 1024 : n / 1024 / 1024
}

/** Record changes, expectations and touched keys for a config write. */
export function addConfigChanges(p: Plan, g: GuestCtx, set: Record<string, string>, del: string[]): void {
  const cur = (k: string): string | null => (g.config[k] === undefined ? null : str(g.config[k]))
  for (const [k, v] of Object.entries(set)) {
    p.changes.push({ key: k, label: labelOf(k), before: cur(k), after: v, words: wordsFor(k, cur(k), v), restart: restartFor(g.type, k, g.running) })
    const alloc = /^([a-zA-Z][\w.-]*):(\d+)$/.exec(parseProps(v).head ?? '')
    p.expect.push({ key: k, value: v, ...(alloc && /^(mp|rootfs|scsi|virtio|sata|ide)/.test(k) ? { alloc: { storage: alloc[1], sizeGb: Number(alloc[2]) } } : {}) })
    p.touched.push(k)
  }
  for (const k of del) {
    p.changes.push({ key: k, label: labelOf(k), before: cur(k), after: null, words: wordsFor(k, cur(k), null), restart: restartFor(g.type, k, g.running) })
    p.expect.push({ key: k, value: null })
    p.touched.push(k)
  }
}

// ── protection: a plan may only touch what its kind is allowed to ─────────────

export type PlanKind = 'edit' | 'revert' | 'device' | 'gpu-off' | 'gpu-on' | 'restart' | 'raw'

export function allowedFor(kind: PlanKind, type: GuestType, key: string): boolean {
  if (isVolatile(key) || key === 'lxc') return false
  if (kind === 'device' || kind === 'gpu-off' || kind === 'gpu-on') return isDeviceKey(key)
  if (kind === 'edit') return isEditable(type, key) && !isDeviceKey(key) && !isRaw(key)
  if (kind === 'revert') return isEditable(type, key) && !isRaw(key) && !/^(rootfs|scsi\d+|virtio\d+|sata\d+|ide\d+)$/.test(key) || /^dev\d+$/.test(key) || /^unused\d+$/.test(key)
  return false
}

/** Refuse a plan that would write a key its kind may not, naming the key. */
export function protect(p: Plan, kind: PlanKind, type: GuestType): Plan {
  for (const k of p.touched) if (!allowedFor(kind, type, k)) p.errors.push(`Refused: this change would write ${k}, which ${isRaw(k) ? 'is a raw passthrough key and' : ''} is not editable here.`)
  return p
}

// ── after the write: did exactly what was planned happen? ────────────────────

export interface Outcome {
  ok: boolean
  problems: string[]
  /** Keys waiting in [pve:pending] after the write. */
  pendingKeys: string[]
  rawBefore: number
  rawAfter: number
  unknownBefore: number
  unknownAfter: number
}

function valueLanded(e: Expect, actual: string | undefined, pending: Map<string, PendingRow>): string | null {
  const pend = pending.get(e.key)
  if (e.value === null) {
    if (actual === undefined || pend?.delete) return null
    return `${e.key} is still set (${actual})`
  }
  if (actual === undefined) return `${e.key} is not set; expected ${e.value}`
  if (e.minSizeGb !== undefined) {
    const s = sizeGb(getProp(parseProps(actual), 'size'))
    return s !== null && s >= e.minSizeGb ? null : `${e.key} is ${s ?? '?'} GB; expected at least ${e.minSizeGb} GB`
  }
  if (normalise(e.key, actual) === normalise(e.key, e.value)) return null
  const want = parseProps(e.value), got = parseProps(actual)
  if (e.alloc) {
    if (!(got.head ?? '').startsWith(`${e.alloc.storage}:`)) return `${e.key} is on ${got.head}; expected a new volume on ${e.alloc.storage}`
    if (sizeGb(getProp(got, 'size')) !== e.alloc.sizeGb) return `${e.key} is ${getProp(got, 'size')}; expected ${e.alloc.sizeGb}G`
  } else if ((want.head ?? '') !== (got.head ?? '')) {
    // A new VM NIC is written "virtio,bridge=…" and read back "virtio=<MAC>,bridge=…": the model gained its MAC.
    const modelGotMac = want.head && !got.head && got.pairs.some(x => x[0] === want.head && x[1])
    if (!modelGotMac) return `${e.key} is ${actual}; expected ${e.value}`
  }
  // Proxmox adds a MAC to a new NIC and a size to a new volume; everything we set must be there as set.
  for (const [k, v] of want.pairs) {
    const gv = got.pairs.find(x => x[0] === k || (v === null && x[0] === k))
    if (!gv && v === null && got.pairs.some(x => x[0] === k)) continue
    if (!gv) return `${e.key} lost ${k}; expected ${e.value}, read ${actual}`
    if (v !== null && gv[1] !== v) return `${e.key} has ${k}=${gv[1]}; expected ${k}=${v}`
  }
  const extras = got.pairs.filter(x => !want.pairs.some(w => w[0] === x[0]) && x[0] !== want.head && !['hwaddr', 'size', 'type'].includes(x[0]) && !/^(virtio|e1000|e1000e|rtl8139|vmxnet3)$/.test(x[0]))
  if (extras.length) return `${e.key} gained ${extras.map(x => x[0]).join(', ')}; read ${actual}`
  return null
}

export interface PendingRow { key: string; value?: unknown; pending?: unknown; delete?: number }

export function pendingKeysOf(rows: PendingRow[] | null | undefined): string[] {
  return (rows ?? []).filter(r => r.key !== 'digest' && (r.pending !== undefined || r.delete)).map(r => r.key)
}

/**
 * Compare the config after a write with the plan. Every planned key must read back as planned, every other key
 * exactly as it was, and the raw lines must be the very same lines in the same order.
 */
export function verifyOutcome(type: GuestType, before: PveConfig, after: PveConfig, pending: PendingRow[], p: Plan): Outcome {
  const problems: string[] = []
  const pmap = new Map((pending ?? []).map(r => [r.key, r]))
  for (const e of p.expect) {
    const a = after[e.key] === undefined ? undefined : str(after[e.key])
    const why = valueLanded(e, a, pmap)
    if (why) problems.push(why)
  }
  const SECRET = /(pass(word|wd)?|secret|token|sshkeys|apikey)/i
  const b = comparable(before), a = comparable(after)
  for (const m of [a, b]) for (const k of m.keys()) if (SECRET.test(k)) m.set(k, `set (${m.get(k)!.length} chars, hidden)`)
  const touched = new Set([...p.touched, ...(p.expectRaw ? ['lxc'] : [])])
  const mayAppear = (k: string) => p.mayAppear.some(x => (x.endsWith('*') ? k.startsWith(x.slice(0, -1)) : x === k))
  for (const [k, v] of b) {
    if (touched.has(k)) continue
    if (!a.has(k)) problems.push(`${k} disappeared (was ${k === 'lxc' ? 'raw lines' : v})`)
    else if (a.get(k) !== v) problems.push(`${k} changed without being asked: ${k === 'lxc' ? 'the raw lines differ' : `${v} → ${a.get(k)}`}`)
  }
  for (const k of a.keys()) if (!b.has(k) && !touched.has(k) && !mayAppear(k)) problems.push(`${k} appeared without being asked (${a.get(k)})`)
  const rb = rawLines(before), ra = rawLines(after)
  const inv = (c: PveConfig) => Object.keys(c).filter(k => !isVolatile(k) && k !== 'lxc' && !isEditable(type, k)).length
  const rawBefore = rb.length + Object.keys(before).filter(k => k !== 'lxc' && isRaw(k)).length
  const rawAfter = ra.length + Object.keys(after).filter(k => k !== 'lxc' && isRaw(k)).length
  const plannedRaw = p.touched.filter(k => isRaw(k))
  if (p.expectRaw) {
    // A whole-file write: the API must read back exactly the planned raw lines (Proxmox still parses the file).
    if (JSON.stringify(ra) !== JSON.stringify(p.expectRaw)) problems.push(`The raw lxc.* lines read back through the API are not the planned ones (${p.expectRaw.length} planned, ${ra.length} read)`)
  } else {
    if (!plannedRaw.length && rawBefore !== rawAfter) problems.push(`Raw lines: ${rawBefore} before, ${rawAfter} after`)
    if (JSON.stringify(rb) !== JSON.stringify(ra)) { if (!problems.some(x => x.startsWith('lxc'))) problems.push('The raw lxc.* lines are not the same lines after the write') }
  }
  return { ok: problems.length === 0, problems, pendingKeys: pendingKeysOf(pending), rawBefore, rawAfter, unknownBefore: inv(before), unknownAfter: inv(after) }
}

// ── revert to a stored version ────────────────────────────────────────────────

/** A plan that brings the editable keys back to `target`. Raw and size changes are listed, never written. */
export function buildRevertPlan(g: GuestCtx, target: PveConfig, pathChecks: Record<string, PathCheck> = {}): Plan {
  const p = emptyPlan()
  const set: Record<string, string> = {}
  const del: string[] = []
  const cur = g.config
  const keys = new Set([...Object.keys(cur), ...Object.keys(target)])
  const notReverted: string[] = []
  for (const k of keys) {
    if (isVolatile(k) || /(pass(word|wd)?|secret|token|sshkeys|apikey)/i.test(k)) continue   // secrets are redacted in history
    const c = cur[k] === undefined ? null : (k === 'lxc' ? JSON.stringify(rawLines(cur)) : str(cur[k]))
    const t = target[k] === undefined ? null : (k === 'lxc' ? JSON.stringify(rawLines(target)) : str(target[k]))
    if ((c === null ? null : normalise(k, c)) === (t === null ? null : normalise(k, t))) continue
    if (k === 'lxc') continue   // raw lines are reverted through the whole-file writer (service.ts)
    if (t !== null && t.includes('**redacted**')) { notReverted.push(`${k} (its value held a secret, which history does not keep)`); continue }
    if (isRaw(k)) { notReverted.push(`${k} (raw: never written by a revert)`); continue }
    if (/^unused\d+$/.test(k)) continue   // follows the mount points below
    if (/^(rootfs|scsi\d+|virtio\d+|sata\d+|ide\d+)$/.test(k)) { notReverted.push(`${k} (disk: sizes are never shrunk)`); continue }
    if (/^mp\d+$/.test(k)) {
      if (t === null) { del.push(k); if (!(parseProps(c!).head ?? '').startsWith('/')) p.mayAppear.push('unused*'); continue }
      const tHead = parseProps(t).head ?? ''
      if (tHead.startsWith('/')) {
        // Putting shared=1 back is the same claim as setting it: the path must be on every node, checked now.
        if (getProp(parseProps(t), 'shared') === '1' && getProp(parseProps(c ?? ''), 'shared') !== '1' && !sharedAllowed(tHead, pathChecks, p)) continue
        set[k] = t; continue
      }
      // A volume can come back only if it is still here as an unused disk (or already mounted, with other options).
      const unusedKey = Object.keys(cur).find(u => /^unused\d+$/.test(u) && str(cur[u]) === tHead)
      const curHead = c === null ? null : parseProps(c).head
      if (curHead === tHead) { set[k] = t.replace(/,size=[^,]*/, '') + (getProp(parseProps(c!), 'size') ? `,size=${getProp(parseProps(c!), 'size')}` : ''); continue }
      if (unusedKey && c === null) { set[k] = t; p.touched.push(unusedKey); p.expect.push({ key: unusedKey, value: null }); p.checks.push(`${tHead} is still on the guest as ${unusedKey}; it is mounted again`); continue }
      notReverted.push(`${k} (its volume ${tHead} is no longer on this guest)`)
      continue
    }
    if (!isEditable(g.type, k)) { notReverted.push(`${k} (not an editable key)`); continue }
    if (t === null) del.push(k); else set[k] = t
  }
  if (notReverted.length) p.warnings.push(`Not reverted: ${notReverted.join(', ')}.`)
  if (Object.keys(set).length || del.length) p.ops.push({ kind: 'config', set, delete: del })
  addConfigChanges(p, g, set, del)
  if (!p.changes.length && !p.errors.length) p.errors.push('Nothing to revert: the editable settings already match that version.')
  return p
}
