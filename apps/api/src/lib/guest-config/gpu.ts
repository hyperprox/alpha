// =============================================================================
//  HyperProx — which guests have a GPU, how, and the guided edits for it
//
//  A container gets a GPU one of two ways. devN entries (`dev0: /dev/dri/renderD128,
//  gid=104`) are written through the Proxmox API. Raw lines (`lxc.cgroup2.devices.allow`
//  for the device majors plus `lxc.mount.entry` binds) are not: Proxmox's API refuses
//  every lxc.* key, to set and to delete, for any token. So HyperProx writes devN only,
//  shows raw GPU lines read-only, and offers to convert them to devN.
//
//  A VM gets one through hostpciN, which takes the card away from the host.
// =============================================================================

import { parseProps, getProp, rawLines, str, freeIndex, type GuestType, type PveConfig } from './keys'
import { emptyPlan, addConfigChanges, type GuestCtx, type Plan } from './plan'
import { gpuMajors, resetRiskOf, vendorOf, type Device, type NodeInventory, type Vendor, type GuestRef } from './devices'

export type GpuVia = 'devN' | 'lxc cgroup' | 'lxc mount' | 'hostpci'

export interface GpuEntry {
  key: string
  value: string
  via: GpuVia
  /** The device path or PCI address it refers to. */
  device: string
  vendor: Vendor | 'unknown'
  /** The majors came from the usual defaults, not the node's /proc/devices. */
  assumed?: boolean
}

export interface GuestGpu {
  vendors: Array<Vendor | 'unknown'>
  entries: GpuEntry[]
  /** Raw lxc.* GPU lines, which the API cannot write. */
  rawCount: number
}

const GPU_PATH = /^\/dev\/(dri\/(card|renderD)\d+|nvidia[\w-]*|nvidia-caps\/[\w-]+|kfd)$/

function pathVendor(path: string, inv?: NodeInventory | null): Vendor | 'unknown' {
  if (/^\/dev\/nvidia/.test(path)) return 'nvidia'
  if (path === '/dev/kfd') return 'amd'
  const d = inv?.devices.find(x => x.kind === 'gpu' && x.paths.includes(path))
  return d?.vendor ?? 'unknown'
}

/** Every GPU entry in a guest config, with how it is passed. */
export function detectGpu(type: GuestType, cfg: PveConfig, inv?: NodeInventory | null): GuestGpu {
  const entries: GpuEntry[] = []
  if (type === 'lxc') {
    for (const [k, v] of Object.entries(cfg)) {
      if (!/^dev\d+$/.test(k)) continue
      const path = parseProps(str(v)).head ?? ''
      if (GPU_PATH.test(path)) entries.push({ key: k, value: str(v), via: 'devN', device: path, vendor: pathVendor(path, inv) })
    }
    const majors = gpuMajors(inv?.majors)
    for (const [k, v] of rawLines(cfg)) {
      if (k === 'lxc.cgroup2.devices.allow' || k === 'lxc.cgroup.devices.allow') {
        const m = /^c\s+(\d+):/.exec(v.trim())
        const mj = m ? majors.get(Number(m[1])) : undefined
        if (mj) entries.push({ key: k, value: v, via: 'lxc cgroup', device: `char major ${m![1]} (${mj.name})`, vendor: /nvidia/.test(mj.name) ? 'nvidia' : mj.name === 'kfd' ? 'amd' : 'unknown', assumed: mj.assumed })
      } else if (k === 'lxc.mount.entry') {
        const src = v.trim().split(/\s+/)[0]
        if (GPU_PATH.test(src) || src === '/dev/dri' || src === '/dev/nvidia-caps') entries.push({ key: k, value: v, via: 'lxc mount', device: src, vendor: src === '/dev/dri' ? 'unknown' : pathVendor(src, inv) })
      }
    }
  } else {
    for (const [k, v] of Object.entries(cfg)) {
      if (!/^hostpci\d+$/.test(k)) continue
      const props = parseProps(str(v))
      const ref = props.head ?? (getProp(props, 'mapping') ? `mapping=${getProp(props, 'mapping')}` : '')
      const dev = inv?.devices.find(d => d.pciAddress && ref && (d.pciAddress.startsWith(ref.length <= 7 ? `0000:${ref}` : ref)))
      if (dev && dev.kind !== 'gpu') continue
      entries.push({ key: k, value: str(v), via: 'hostpci', device: ref, vendor: dev?.vendor ?? (getProp(props, 'x-vga') ? 'unknown' : 'unknown') })
    }
  }
  const vendors = [...new Set(entries.map(e => e.vendor))]
  // A raw cgroup line alone says "some GPU"; prefer the named vendor when another entry knows it.
  const named = vendors.filter(v => v !== 'unknown')
  return { vendors: named.length ? named : vendors, entries, rawCount: entries.filter(e => e.via !== 'devN' && e.via !== 'hostpci').length }
}

// ── driver match for NVIDIA containers ────────────────────────────────────────

/** The libnvidia-ml version in a container listing: "libnvidia-ml.so.580.173.02". */
export function containerNvidiaVersion(listing: string): string | null {
  const m = /libnvidia-ml\.so\.(\d+\.\d+(?:\.\d+)?)/.exec(listing)
  return m ? m[1] : null
}

export function driverMatch(host: string | null | undefined, guest: string | null | undefined): { state: 'match' | 'mismatch' | 'unknown'; words: string } {
  if (!host || !guest) return { state: 'unknown', words: !host ? 'The node’s NVIDIA driver version could not be read.' : 'No NVIDIA userland library found in the container (or it is stopped).' }
  if (host === guest) return { state: 'match', words: `Container userland ${guest} matches the host driver.` }
  return { state: 'mismatch', words: `Container userland ${guest} does not match the host driver ${host}: NVML and hardware transcoding fail until they match.` }
}

// ── give / take away GPU access (LXC, devN only) ─────────────────────────────

export interface GpuGrant {
  /** The inventory device to give (a GPU id from the node's Devices list). */
  deviceId: string
  /** DRI only: also pass cardN (display node), not just renderDN. */
  includeCard?: boolean
  /** The container's render (and video) group ids; read from the container when it runs. */
  renderGid?: number
  videoGid?: number
}

function taken(g: GuestCtx, extra: string[] = []): string[] { return [...Object.keys(g.config), ...extra] }

/** devN entries that pass `paths`, skipping paths already passed. */
function devEntries(g: GuestCtx, paths: Array<{ path: string; gid?: number }>, p: Plan): Record<string, string> {
  const set: Record<string, string> = {}
  const already = new Set(Object.entries(g.config).filter(([k]) => /^dev\d+$/.test(k)).map(([, v]) => parseProps(str(v)).head))
  for (const { path, gid } of paths) {
    if (already.has(path)) { p.checks.push(`${path} is already passed; left as it is`); continue }
    const key = `dev${freeIndex('dev', taken(g, Object.keys(set)))}`
    set[key] = gid !== undefined ? `${path},gid=${gid}` : path
    p.deviceChecks.push({ path, present: true })
  }
  return set
}

export function buildGpuGrantPlan(g: GuestCtx, inv: NodeInventory, grant: GpuGrant, others: GuestRef[]): Plan {
  const p = emptyPlan()
  p.confirmName = true
  if (g.type !== 'lxc') { p.errors.push('A VM is given a GPU with PCI passthrough; use the PCI picker.'); return p }
  const dev = inv.devices.find(d => d.id === grant.deviceId)
  if (!dev || dev.kind !== 'gpu') { p.errors.push(`That GPU is not on ${g.node}. A guest can only be given a device on the node it runs on.`); return p }
  if (dev.vfio) { p.errors.push(`${dev.name} is bound to vfio for VM passthrough; the host has no driver for it to share.`); return p }
  const vmUser = dev.usedBy.find(u => u.via === 'hostpciN' && u.running)
  if (vmUser) { p.errors.push(`${dev.name} is passed to running VM ${vmUser.vmid} '${vmUser.name}': the host does not have it to share.`); return p }
  const paths: Array<{ path: string; gid?: number }> = []
  if (dev.vendor === 'nvidia') {
    if (!inv.nvidiaNodes.length) { p.errors.push('No /dev/nvidia* device nodes on the host: is the NVIDIA driver loaded?'); return p }
    for (const n of inv.nvidiaNodes) paths.push({ path: n })
    p.warnings.push(`The container also needs NVIDIA userland ${inv.nvidiaDriver ?? '(host version)'} installed, exactly the host's version, or NVML fails.`)
  } else {
    const render = dev.paths.find(x => /renderD\d+$/.test(x))
    const card = dev.paths.find(x => /card\d+$/.test(x))
    if (!render) { p.errors.push(`${dev.name} has no render node on the host.`); return p }
    if (grant.renderGid === undefined) { p.errors.push('The container’s render group id is needed (it is read from the container while it runs; enter it when it is stopped).'); return p }
    paths.push({ path: render, gid: grant.renderGid })
    if (grant.includeCard && card) paths.push({ path: card, gid: grant.videoGid ?? grant.renderGid })
    if (dev.vendor === 'amd' && dev.paths.includes('/dev/kfd')) paths.push({ path: '/dev/kfd', gid: grant.renderGid })
    p.checks.push(`${render} is ${dev.name} at ${dev.pciAddress} today; with a second GPU the numbering can change`)
  }
  const set = devEntries(g, paths, p)
  if (!Object.keys(set).length) { p.errors.push('This container already has every node of that GPU.'); return p }
  p.ops.push({ kind: 'config', set, delete: [] })
  addConfigChanges(p, g, set, [])
  for (const c of p.changes) c.words = `${c.words} — ${dev.name}`
  const sharers = [...new Map(dev.usedBy.filter(u => u.vmid !== g.vmid).map(u => [u.vmid, u])).values()]
  if (sharers.length) p.checks.push(`Also shared with: ${sharers.map(u => `${u.type === 'lxc' ? 'CT' : 'VM'} ${u.vmid} '${u.name}' (${u.running ? 'running' : 'stopped'})`).join(', ')}`)
  void others
  p.warnings.push('Sharing this gives the container full access to the device.')
  if (g.running) p.warnings.push('Device entries apply when the container restarts.')
  p.meta = { gpuManaged: set, device: dev.name }
  return p
}

/** Remove only the devN entries HyperProx added (`managed`: key → the value it wrote), never anything else. */
export function buildGpuRevokePlan(g: GuestCtx, managed: Record<string, string>): Plan {
  const p = emptyPlan()
  p.confirmName = true
  const gpu = detectGpu(g.type, g.config)
  const mine = gpu.entries.filter(e => e.via === 'devN' && managed[e.key] === e.value)
  if (!mine.length) { p.errors.push('No GPU entries on this container were added by HyperProx. Use “GPU access off” to remove all of them.'); return p }
  const del = mine.map(e => e.key)
  p.ops.push({ kind: 'config', set: {}, delete: del })
  addConfigChanges(p, g, {}, del)
  for (const e of mine) p.deviceChecks.push({ path: e.device, present: false })
  const kept = gpu.entries.filter(e => !del.includes(e.key))
  if (kept.length) p.checks.push(`Kept (not added by HyperProx): ${kept.map(e => `${e.key} ${e.device}`).join(', ')}`)
  if (g.running) p.warnings.push('Removing device entries applies when the container restarts.')
  return p
}

// ── the GPU access toggle ─────────────────────────────────────────────────────

export interface GpuOffRecord {
  /** devN entries removed, exactly as they were. */
  removed: Record<string, string>
  /** Raw lines that could not be removed through the API. */
  rawKept: Array<[string, string]>
}

export function buildGpuOffPlan(g: GuestCtx): Plan {
  const p = emptyPlan()
  const gpu = detectGpu(g.type, g.config)
  if (g.type !== 'lxc') { p.errors.push('The GPU access toggle is for containers; a VM’s passthrough is edited in the PCI picker.'); return p }
  const devs = gpu.entries.filter(e => e.via === 'devN')
  const raw = gpu.entries.filter(e => e.via !== 'devN')
  if (raw.length) {
    p.warnings.push(`${raw.length} raw lxc.* GPU line${raw.length === 1 ? '' : 's'} cannot be removed: Proxmox’s API does not accept lxc.* keys, to set or to delete, from any token. They stay, so the GPU stays reachable through them. Convert them to devN entries to make the toggle complete.`)
  }
  if (!devs.length) { p.errors.push(raw.length ? 'This container’s GPU access is all raw lxc.* lines, which the API cannot remove. Use “Convert to devN” first.' : 'This container has no GPU access to turn off.'); return p }
  const del = devs.map(e => e.key)
  p.ops.push({ kind: 'config', set: {}, delete: del })
  addConfigChanges(p, g, {}, del)
  for (const e of devs) p.deviceChecks.push({ path: e.device, present: false })
  const rec: GpuOffRecord = { removed: Object.fromEntries(devs.map(e => [e.key, e.value])), rawKept: raw.map(e => [e.key, e.value] as [string, string]) }
  p.meta = { gpuOff: rec }
  if (g.running) p.warnings.push('Applies when the container restarts: until then it still has the GPU.')
  return p
}

/** Put back exactly what the last "GPU off" removed. Refused per key when the slot or the device is taken since. */
export function buildGpuOnPlan(g: GuestCtx, rec: GpuOffRecord | null): Plan {
  const p = emptyPlan()
  if (!rec || !Object.keys(rec.removed).length) { p.errors.push('There is no “GPU off” in this container’s history to turn back on.'); return p }
  const set: Record<string, string> = {}
  const present = new Set(Object.entries(g.config).filter(([k]) => /^dev\d+$/.test(k)).map(([, v]) => parseProps(str(v)).head))
  for (const [k, v] of Object.entries(rec.removed)) {
    const path = parseProps(v).head ?? ''
    const cur = g.config[k] === undefined ? null : str(g.config[k])
    if (cur === v) { p.checks.push(`${k} is already back as it was`); continue }
    if (present.has(path)) { p.errors.push(`Conflict: ${path} is already passed under another key; ${k} is not restored.`); continue }
    if (cur !== null) { p.errors.push(`Conflict: ${k} is now used for ${cur}; it was ${v}. Move that entry first.`); continue }
    set[k] = v
    p.deviceChecks.push({ path, present: true })
  }
  if (p.errors.length) return p
  if (!Object.keys(set).length) { p.errors.push('GPU access is already on.'); return p }
  p.ops.push({ kind: 'config', set, delete: [] })
  addConfigChanges(p, g, set, [])
  if (rec.rawKept.length) p.checks.push(`${rec.rawKept.length} raw line(s) were never removed and are still checked after the restart`)
  if (g.running) p.warnings.push('Applies when the container restarts.')
  p.meta = { gpuOn: { restored: set } }
  return p
}

// ── raw lines: shown, previewed, converted ────────────────────────────────────

export interface RawEdit { remove?: Array<[string, string]>; add?: Array<[string, string]>; change?: Array<{ from: [string, string]; to: [string, string] }> }

/**
 * A raw-line edit is previewed in full and then refused: the API cannot write lxc.* keys. The preview still lists
 * every line, so the person can see what the equivalent devN conversion would do instead.
 */
export function buildRawEditPlan(g: GuestCtx, edit: RawEdit): Plan {
  const p = emptyPlan()
  p.confirmName = true
  const lines = rawLines(g.config)
  const has = (l: [string, string]) => lines.some(x => x[0] === l[0] && x[1] === l[1])
  for (const l of edit.remove ?? []) { if (!has(l)) p.errors.push(`${l[0]}: ${l[1]} is not on this guest.`); else p.changes.push({ key: l[0], label: 'Raw line', before: l[1], after: null, words: `Remove ${l[0]}: ${l[1]}`, restart: g.running ? 'restart' : 'live' }) }
  for (const l of edit.add ?? []) p.changes.push({ key: l[0], label: 'Raw line', before: null, after: l[1], words: `Add ${l[0]}: ${l[1]}`, restart: g.running ? 'restart' : 'live' })
  for (const c of edit.change ?? []) { if (!has(c.from)) p.errors.push(`${c.from[0]}: ${c.from[1]} is not on this guest.`); else p.changes.push({ key: c.from[0], label: 'Raw line', before: c.from[1], after: c.to[1], words: `Change ${c.from[0]}: ${c.from[1]} → ${c.to[1]}`, restart: g.running ? 'restart' : 'live' }) }
  p.checks.push(`${lines.length} raw line(s) on the guest now; ${lines.length - (edit.remove?.length ?? 0) - 0 + (edit.add?.length ?? 0)} after this edit`)
  p.errors.push('Proxmox’s API does not accept lxc.* lines from any API token (to set or to delete), and HyperProx writes guest configs only through the API. Use “Convert to devN” for GPU lines, or edit these lines on the node by hand.')
  return p
}

/** devN equivalents for raw GPU mount lines. The raw lines stay (the API cannot remove them) and are named. */
export function buildGpuConvertPlan(g: GuestCtx, inv: NodeInventory | null): Plan {
  const p = emptyPlan()
  p.confirmName = true
  if (g.type !== 'lxc') { p.errors.push('Only containers have raw lxc lines.'); return p }
  const gpu = detectGpu('lxc', g.config, inv)
  const mounts = gpu.entries.filter(e => e.via === 'lxc mount' && /^\/dev\//.test(e.device))
  if (!mounts.length) { p.errors.push('No raw GPU mount lines to convert.'); return p }
  const paths: Array<{ path: string }> = []
  for (const m of mounts) {
    if (m.device === '/dev/dri' || m.device === '/dev/nvidia-caps') {
      const nodes = m.device === '/dev/dri' ? inv?.devices.filter(d => d.kind === 'gpu').flatMap(d => d.paths.filter(x => x.startsWith('/dev/dri/'))) ?? [] : inv?.nvidiaNodes.filter(n => n.startsWith('/dev/nvidia-caps/')) ?? []
      if (!nodes.length) { p.errors.push(`${m.device} is a directory bind; the node's inventory is needed to list its devices.`); continue }
      for (const n of nodes) paths.push({ path: n })
    } else paths.push({ path: m.device })
  }
  const set = devEntries(g, paths, p)
  if (!Object.keys(set).length) { if (!p.errors.length) p.errors.push('Every raw GPU line already has a devN equivalent.'); return p }
  p.ops.push({ kind: 'config', set, delete: [] })
  addConfigChanges(p, g, set, [])
  p.warnings.push(`The ${gpu.rawCount} raw line(s) stay as they are: the API cannot remove them. Once the devN entries work, remove these by hand on the node: ${gpu.entries.filter(e => e.via !== 'devN').map(e => `“${e.key}: ${e.value}”`).join(', ')}.`)
  p.meta = { gpuManaged: set }
  return p
}

// ── VMs: PCI passthrough ─────────────────────────────────────────────────────

export interface HostpciEdit { add?: { deviceId: string; pcie?: boolean; xvga?: boolean; allFunctions?: boolean }; remove?: string; ackResetRisk?: boolean; ackDisplayGpu?: boolean; ackUnknown?: boolean }

export function buildHostpciPlan(g: GuestCtx, inv: NodeInventory, e: HostpciEdit, guests: GuestRef[]): Plan {
  const p = emptyPlan()
  p.confirmName = true
  if (g.type !== 'qemu') { p.errors.push('PCI passthrough is for VMs; give a container a GPU with devN.'); return p }
  p.warnings.push('Some GPUs cannot be reset or handed back cleanly, and can hang the host when the VM stops or restarts.')
  if (e.remove) {
    if (!/^hostpci\d+$/.test(e.remove) || g.config[e.remove] === undefined) { p.errors.push(`${e.remove} is not on this VM.`); return p }
    p.ops.push({ kind: 'config', set: {}, delete: [e.remove] })
    addConfigChanges(p, g, {}, [e.remove])
    return p
  }
  if (!e.add) { p.errors.push('Pick a PCI device to add, or one to remove.'); return p }
  const dev = inv.devices.find(d => d.id === e.add!.deviceId && d.pciAddress)
  if (!dev) { p.errors.push(`That device is not on ${g.node}: the VM would need to live there.`); return p }
  if (!dev.shareAs.includes('vm-hostpci')) { p.errors.push(`${dev.name} cannot be passed to a VM.`); return p }
  if (dev.iommuGroup === undefined) { p.errors.push(`IOMMU is off on ${g.node}, so nothing can be passed to a VM there.`); return p }
  if (dev.iommuClean === false) p.warnings.push(`IOMMU group ${dev.iommuGroup} holds other devices: they go to the VM too.`)
  // Never while another running guest uses it — a VM by hostpci, or a container through the host driver.
  const users = dev.usedBy.filter(u => u.vmid !== g.vmid && u.running)
  const sameVendorCt = dev.kind === 'gpu' ? guests.filter(x => x.node === g.node && x.type === 'lxc' && x.running && x.vmid !== g.vmid && detectGpu('lxc', x.config, inv).entries.some(en => en.vendor === dev.vendor || en.vendor === 'unknown')) : []
  if (users.length || sameVendorCt.length) {
    const names = [...users.map(u => `${u.type === 'lxc' ? 'CT' : 'VM'} ${u.vmid} '${u.name}'`), ...sameVendorCt.filter(x => !users.some(u => u.vmid === x.vmid)).map(x => `CT ${x.vmid} '${x.name}'`)]
    p.errors.push(`Refused: ${dev.name} is in use by running ${names.join(', ')}. Passing it to a VM takes it away from them.`)
    return p
  }
  if (dev.resetRisk) { p.warnings.push(dev.resetRisk); if (!e.ackResetRisk) p.extraConfirm.push('reset-risk') }
  if (dev.bootDisplay) { p.warnings.push(`${dev.name} is the node’s display GPU: the host loses its console.`); if (!e.ackDisplayGpu) p.extraConfirm.push('display-gpu') }
  if (dev.unknown && !e.ackUnknown) p.extraConfirm.push('unknown-device')
  const addr = e.add.allFunctions ? dev.pciAddress!.slice(0, -2) : dev.pciAddress!
  const parts = [addr, ...(e.add.pcie ? ['pcie=1'] : []), ...(e.add.xvga ? ['x-vga=1'] : [])]
  if (e.add.pcie && !/q35/.test(str(g.config.machine))) p.warnings.push('pcie=1 needs the q35 machine type; this VM is not on q35.')
  const key = `hostpci${freeIndex('hostpci', Object.keys(g.config), 15)}`
  const set = { [key]: parts.join(',') }
  p.ops.push({ kind: 'config', set, delete: [] })
  addConfigChanges(p, g, set, [])
  p.changes[0].words = `${p.changes[0].words} — ${dev.name}`
  p.warnings.push('Passing this to a VM removes it from the host and every other guest.')
  void resetRiskOf; void vendorOf
  return p
}

/** Other guests that share any device this guest has, for context. */
export function sharers(g: { vmid: number; node: string }, devices: Device[]): Array<{ device: string; users: string[] }> {
  return devices.filter(d => d.usedBy.some(u => u.vmid === g.vmid)).map(d => ({
    device: d.name,
    users: [...new Map(d.usedBy.filter(u => u.vmid !== g.vmid).map(u => [u.vmid, `${u.type === 'lxc' ? 'CT' : 'VM'} ${u.vmid} '${u.name}' (${u.running ? 'running' : 'stopped'})`])).values()],
  })).filter(x => x.users.length)
}

// ── other shareable devices: serial sticks, USB, capture, TPUs, tun ───────────

export interface DeviceGrant { deviceId: string; gid?: number; ackUnknown?: boolean; ackShared?: boolean; remove?: string }

/**
 * Give a guest a non-GPU device from its node's inventory, by its most stable reference: the by-id link for a
 * serial stick (devN in a container, serialN or usbN in a VM), vendor:product or the physical port for USB.
 */
export function buildDeviceGrantPlan(g: GuestCtx, inv: NodeInventory, e: DeviceGrant): Plan {
  const p = emptyPlan()
  p.confirmName = true
  if (e.remove) {
    if (!/^(dev|usb|serial)\d+$/.test(e.remove) || g.config[e.remove] === undefined) { p.errors.push(`${e.remove} is not a device entry on this guest.`); return p }
    p.ops.push({ kind: 'config', set: {}, delete: [e.remove] })
    addConfigChanges(p, g, {}, [e.remove])
    const path = parseProps(str(g.config[e.remove])).head
    if (g.type === 'lxc' && path?.startsWith('/dev/')) p.deviceChecks.push({ path, present: false })
    if (g.running) p.warnings.push('Applies when the guest restarts.')
    return p
  }
  const dev = inv.devices.find(d => d.id === e.deviceId)
  if (!dev) {
    p.errors.push(`That device is not on ${g.node}: the guest would need to live on the node it is plugged into.`)
    return p
  }
  if (dev.kind === 'gpu' || dev.kind === 'pci') { p.errors.push('GPUs and PCI devices have their own editor.'); return p }
  if (dev.unknown && !e.ackUnknown) p.extraConfirm.push('unknown-device')
  const others = [...new Map(dev.usedBy.filter(u => u.vmid !== g.vmid).map(u => [u.vmid, u])).values()]
  const exclusive = dev.kind === 'serial' || dev.shareAs.includes('lxc-dev-exclusive')
  if (exclusive && others.length) {
    const words = others.map(u => `${u.type === 'lxc' ? 'CT' : 'VM'} ${u.vmid} '${u.name}' (${u.running ? 'running' : 'stopped'})`).join(', ')
    if (others.some(u => u.running)) { p.errors.push(`Only one guest can use ${dev.name} at a time; it is used by ${words}.`); return p }
    p.warnings.push(`Only one guest can use this at a time; it is also set on ${words}, which must not run at the same time.`)
    if (!e.ackShared) p.extraConfirm.push('exclusive-device')
  }
  let set: Record<string, string> = {}
  if (g.type === 'lxc') {
    if (!dev.shareAs.some(s => s.startsWith('lxc'))) { p.errors.push(`${dev.name} can only be given to a VM (as USB passthrough).`); return p }
    const path = dev.stableRef && dev.stableRef.startsWith('/dev/') ? dev.stableRef : dev.paths[0]
    if (!path) { p.errors.push(`${dev.name} has no device node to pass.`); return p }
    if (/\/dev\/tty(USB|ACM)\d+$/.test(path)) p.warnings.push(`${path} has no by-id link, so its name can swap with another stick on reboot.`)
    set = devEntries(g, [{ path, gid: e.gid }], p)
  } else {
    if (dev.shareAs.includes('vm-usb')) {
      const twin = dev.notes.some(n => n.startsWith('These look identical'))
      const host = twin || !dev.vendorProduct ? dev.port : dev.vendorProduct
      if (!host) { p.errors.push('This USB device has no stable identity to pass.'); return p }
      set = { [`usb${freeIndex('usb', Object.keys(g.config), 13)}`]: `host=${host}` }
      if (twin) p.warnings.push('These look identical; they’re told apart only by the USB port they’re plugged into, so keep them in the same ports.')
    } else { p.errors.push(`${dev.name} cannot be given to a VM except by PCI passthrough.`); return p }
  }
  if (!Object.keys(set).length) { p.errors.push('This guest already has that device.'); return p }
  p.ops.push({ kind: 'config', set, delete: [] })
  addConfigChanges(p, g, set, [])
  for (const c of p.changes) c.words = `${dev.name} — writes ${c.key}: ${c.after}`
  p.warnings.push(dev.kind === 'tun' || dev.shareAs.includes('lxc-dev-shared') ? 'Sharing this gives the container full access to the device.' : 'The guest gets full access to the device.')
  if (g.running) p.warnings.push('Applies when the guest restarts.')
  return p
}
