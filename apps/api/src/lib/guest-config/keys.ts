// =============================================================================
//  HyperProx — guest config keys: what the editor models, what it must never touch
//
//  A guest config lives on the cluster filesystem and is replicated on write with
//  no undo. The editor only ever writes keys it models. Everything else — raw
//  `lxc.*` lines, `args:`, hookscripts, passthrough, and any key a future Proxmox
//  adds — is shown read-only, round-tripped untouched, and counted before and
//  after every write.
// =============================================================================

export type GuestType = 'lxc' | 'qemu'

/** A guest config as Proxmox's API answers it. `lxc` is the raw lines as [key, value] pairs. */
export type PveConfig = Record<string, unknown> & { digest?: string; lxc?: Array<[string, string]> }

/** Keys Proxmox maintains itself. Never written, never compared as "changed". */
const VOLATILE = new Set(['digest'])

/** Keys the structured editor may write, per guest type. */
const LXC_EDITABLE = [
  /^cores$/, /^cpulimit$/, /^cpuunits$/, /^memory$/, /^swap$/, /^onboot$/, /^startup$/, /^description$/, /^tags$/,
  /^nameserver$/, /^searchdomain$/, /^hostname$/, /^net\d+$/, /^mp\d+$/, /^rootfs$/, /^dev\d+$/,
]
const QEMU_EDITABLE = [
  /^cores$/, /^sockets$/, /^memory$/, /^balloon$/, /^cpulimit$/, /^cpuunits$/, /^onboot$/, /^startup$/,
  /^description$/, /^tags$/, /^nameserver$/, /^searchdomain$/, /^boot$/, /^agent$/, /^net\d+$/, /^ipconfig\d+$/,
  /^(scsi|virtio|sata|ide)\d+$/, /^hostpci\d+$/, /^usb\d+$/, /^serial\d+$/, /^name$/,
]

/**
 * Raw keys: never written by any form, always counted. `lxc` is the array of raw lines; the rest are VM keys
 * that carry host passthrough or arbitrary arguments. hostpci/usb/serial are written only by the device editor.
 */
const RAW = [/^lxc$/, /^args$/, /^hookscript$/, /^hostpci\d+$/, /^usb\d+$/, /^serial\d+$/]

/** Keys the device editor may write (and nothing else may). */
export const DEVICE_KEYS = [/^dev\d+$/, /^hostpci\d+$/, /^usb\d+$/, /^serial\d+$/]

const any = (res: RegExp[], k: string) => res.some(r => r.test(k))

export function isVolatile(k: string): boolean { return VOLATILE.has(k) }
export function isRaw(k: string): boolean { return any(RAW, k) }
export function isDeviceKey(k: string): boolean { return any(DEVICE_KEYS, k) }
export function isEditable(type: GuestType, k: string): boolean {
  return any(type === 'lxc' ? LXC_EDITABLE : QEMU_EDITABLE, k)
}

export interface KeyInventory {
  /** Keys the structured editor shows as fields. */
  modelled: string[]
  /** Raw passthrough keys and lines: read-only, counted. `lxc` lines are counted one per line. */
  raw: Array<{ key: string; value: string }>
  /** Keys the form does not model at all (arch, features, unused0, a future option...): read-only, kept as they are. */
  unknown: Array<{ key: string; value: string }>
}

export function str(v: unknown): string {
  if (v === undefined || v === null) return ''
  return typeof v === 'string' ? v : String(v)
}

/** Raw `lxc.*` lines of a config, in file order. */
export function rawLines(cfg: PveConfig): Array<[string, string]> {
  const l = cfg.lxc
  return Array.isArray(l) ? l.filter(p => Array.isArray(p) && p.length >= 2).map(p => [String(p[0]), String(p[1])] as [string, string]) : []
}

export function inventory(type: GuestType, cfg: PveConfig): KeyInventory {
  const out: KeyInventory = { modelled: [], raw: [], unknown: [] }
  for (const [k, v] of Object.entries(cfg)) {
    if (isVolatile(k)) continue
    if (k === 'lxc') { for (const [rk, rv] of rawLines(cfg)) out.raw.push({ key: rk, value: rv }); continue }
    if (isRaw(k)) { out.raw.push({ key: k, value: str(v) }); if (isEditable(type, k)) out.modelled.push(k); continue }
    if (isEditable(type, k)) out.modelled.push(k)
    else out.unknown.push({ key: k, value: str(v) })
  }
  return out
}

/** Every key that is not volatile, in a stable form for comparison. `lxc` becomes one joined string. */
export function comparable(cfg: PveConfig): Map<string, string> {
  const m = new Map<string, string>()
  for (const [k, v] of Object.entries(cfg)) {
    if (isVolatile(k)) continue
    if (k === 'lxc') { m.set('lxc', JSON.stringify(rawLines(cfg))); continue }
    m.set(k, normalise(k, str(v)))
  }
  return m
}

/** Proxmox rewrites some values on save: a description gains a newline, tags come back sorted. */
export function normalise(k: string, v: string): string {
  if (k === 'description') return v.replace(/\n+$/, '')
  if (k === 'tags') return v.split(/[;, ]+/).filter(Boolean).map(t => t.toLowerCase()).sort().join(';')
  return v
}

// ── property strings: "name=eth0,bridge=vmbr0,ip=dhcp" ───────────────────────

/** `null` is a bare flag with no `=` (rare, but kept exactly as written). */
export interface Props { /** The positional first value (a volume), when there is one. */ head?: string; pairs: Array<[string, string | null]> }

export function parseProps(s: string, headless = false): Props {
  const parts = s.split(',').filter(p => p.length > 0)
  const out: Props = { pairs: [] }
  parts.forEach((p, i) => {
    const eq = p.indexOf('=')
    if (eq < 0) { if (i === 0 && !headless) out.head = p; else out.pairs.push([p, null]); return }
    out.pairs.push([p.slice(0, eq), p.slice(eq + 1)])
  })
  return out
}

export function getProp(p: Props, k: string): string | undefined { const v = p.pairs.find(x => x[0] === k)?.[1]; return v === null ? '' : v }

/** Set or remove (undefined) one property, keeping every other property and its order. */
export function setProp(p: Props, k: string, v: string | undefined): Props {
  const pairs = p.pairs.filter(x => x[0] !== k || v !== undefined).map(x => (x[0] === k ? [k, v!] as [string, string | null] : x))
  if (v !== undefined && !pairs.some(x => x[0] === k)) pairs.push([k, v])
  return { head: p.head, pairs }
}

export function buildProps(p: Props): string {
  return [...(p.head !== undefined ? [p.head] : []), ...p.pairs.map(([k, v]) => (v === null ? k : `${k}=${v}`))].join(',')
}

/** The lowest free index for a numbered key (dev, mp, net, hostpci...), counting pending and planned ones too. */
export function freeIndex(prefix: string, taken: Iterable<string>, max = 255): number {
  const used = new Set<number>()
  for (const k of taken) { const m = new RegExp(`^${prefix}(\\d+)$`).exec(k); if (m) used.add(Number(m[1])) }
  for (let i = 0; i <= max; i++) if (!used.has(i)) return i
  throw new Error(`No free ${prefix} slot`)
}
