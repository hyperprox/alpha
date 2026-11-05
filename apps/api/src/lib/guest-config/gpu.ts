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
    if (gid !== undefined && !isGid(gid)) { p.errors.push('A group id is a whole number from 0 to 65535.'); return {} }
    if (!/^\/dev\/[A-Za-z0-9_./:+-]+$/.test(path)) { p.errors.push(`${path} is not a device path HyperProx writes.`); return {} }
    set[key] = gid !== undefined ? `${path},gid=${gid}` : path
    p.deviceChecks.push({ path, present: true })
  }
  return set
}

/** A group id: an integer from 0 to 65535, nothing else (it is written into a devN value). */
export function isGid(v: unknown): v is number { return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 65535 }

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
    if (!isGid(grant.renderGid) || (grant.videoGid !== undefined && !isGid(grant.videoGid))) { p.errors.push('A group id is a whole number from 0 to 65535.'); return p }
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

/** What HyperProx itself added, from the guest's history: devN key → value, and raw lines. */
export interface GpuManaged { dev: Record<string, string>; raw: Array<[string, string]> }

export interface GpuOffRecord {
  /** devN entries removed, exactly as they were. */
  removed: Record<string, string>
  /** Raw lines removed (through the whole-file writer), exactly as they were. */
  rawRemoved: Array<[string, string]>
  /** GPU entries left in place because HyperProx did not add them and nobody asked to remove them. */
  kept: Array<{ key: string; value: string }>
}

export interface GpuOffInput {
  /** Hand-written entries to remove as well ("remove these too?"); each must match one exactly. */
  alsoRemove?: Array<{ key: string; value: string }>
}

const isManaged = (e: GpuEntry, m: GpuManaged) => (e.via === 'devN' ? m.dev[e.key] === e.value : m.raw.some(r => r[0] === e.key && r[1] === e.value))

export function buildGpuOffPlan(g: GuestCtx, managed: GpuManaged, input: GpuOffInput = {}, inv: NodeInventory | null = null): Plan {
  const p = emptyPlan()
  p.confirmName = true
  if (g.type !== 'lxc') { p.errors.push('The GPU access toggle is for containers; a VM’s passthrough is edited in the PCI picker.'); return p }
  const gpu = detectGpu('lxc', g.config, inv)
  if (!gpu.entries.length) { p.errors.push('This container has no GPU access to turn off.'); return p }
  const also = input.alsoRemove ?? []
  const unmanaged = gpu.entries.filter(e => !isManaged(e, managed))
  for (const a of also) if (!unmanaged.some(e => e.key === a.key && e.value === a.value)) p.errors.push(`${a.key}: ${a.value} is not a hand-written GPU entry on this container.`)
  const chosen = gpu.entries.filter(e => isManaged(e, managed) || also.some(a => a.key === e.key && a.value === e.value))
  const kept = gpu.entries.filter(e => !chosen.includes(e))
  p.options = unmanaged.map(e => ({ key: e.key, value: e.value, label: `${e.key}: ${e.value}` }))
  if (kept.length) p.checks.push(`Left in place, because HyperProx did not add them: ${kept.map(e => `${e.key}: ${e.value}`).join('; ')}. Tick “remove these too” to include them.`)
  if (!chosen.length) { p.errors.push('None of this container’s GPU entries were added by HyperProx. Choose which hand-written ones to remove, if any.'); return p }
  const devs = chosen.filter(e => e.via === 'devN')
  const raw = chosen.filter(e => e.via !== 'devN')
  if (devs.length) {
    const del = devs.map(e => e.key)
    p.ops.push({ kind: 'config', set: {}, delete: del })
    addConfigChanges(p, g, {}, del)
  }
  if (raw.length) rawChanges(p, g, raw.map(e => [e.key, e.value] as [string, string]), [])
  // The device must be gone inside only when no kept entry still reaches it.
  const keptPaths = new Set(kept.map(e => e.device))
  for (const e of chosen) if (e.device.startsWith('/dev/') && !keptPaths.has(e.device) && !(e.device === '/dev/dri' || e.device === '/dev/nvidia-caps')) p.deviceChecks.push({ path: e.device, present: false })
  const rec: GpuOffRecord = { removed: Object.fromEntries(devs.map(e => [e.key, e.value])), rawRemoved: raw.map(e => [e.key, e.value] as [string, string]), kept: kept.map(e => ({ key: e.key, value: e.value })) }
  p.meta = { gpuOff: rec }
  if (g.running) p.warnings.push('Applies the next time the container starts: until then it still has the GPU.')
  return p
}

/** Put back exactly what the last "GPU off" removed. Refused per key when the slot or the device is taken since. */
export function buildGpuOnPlan(g: GuestCtx, rec: GpuOffRecord | null): Plan {
  const p = emptyPlan()
  p.confirmName = true
  const rawRemoved = rec?.rawRemoved ?? []
  if (!rec || (!Object.keys(rec.removed ?? {}).length && !rawRemoved.length)) { p.errors.push('There is no “GPU off” in this container’s history to turn back on.'); return p }
  const set: Record<string, string> = {}
  const present = new Set(Object.entries(g.config).filter(([k]) => /^dev\d+$/.test(k)).map(([, v]) => parseProps(str(v)).head))
  for (const [k, v] of Object.entries(rec.removed ?? {})) {
    const path = parseProps(v).head ?? ''
    const cur = g.config[k] === undefined ? null : str(g.config[k])
    if (cur === v) { p.checks.push(`${k} is already back as it was`); continue }
    if (present.has(path)) { p.errors.push(`Conflict: ${path} is already passed under another key; ${k} is not restored.`); continue }
    if (cur !== null) { p.errors.push(`Conflict: ${k} is now used for ${cur}; it was ${v}. Move that entry first.`); continue }
    set[k] = v
    p.deviceChecks.push({ path, present: true })
  }
  const have = rawLines(g.config)
  const addRaw = rawRemoved.filter(([k, v]) => !have.some(h => h[0] === k && h[1] === v))
  if (p.errors.length) return p
  if (!Object.keys(set).length && !addRaw.length) { p.errors.push('GPU access is already on.'); return p }
  if (Object.keys(set).length) { p.ops.push({ kind: 'config', set, delete: [] }); addConfigChanges(p, g, set, []) }
  if (addRaw.length) {
    rawChanges(p, g, [], addRaw)
    for (const [k, v] of addRaw) if (k === 'lxc.mount.entry') { const src = v.split(/\s+/)[0]; if (/^\/dev\/(dri\/|nvidia)/.test(src) && !/\/(dri|nvidia-caps)$/.test(src)) p.deviceChecks.push({ path: src, present: true }) }
  }
  if (g.running) p.warnings.push('Applies the next time the container starts.')
  p.meta = { gpuOn: { restored: set, rawRestored: addRaw } }
  return p
}

// ── raw lines: through the whole-file writer ──────────────────────────────────

/** Record raw-line changes on a plan: they go through rawfile.ts, never the API, and wait for the next start. */
export function rawChanges(p: Plan, g: GuestCtx, remove: Array<[string, string]>, add: Array<[string, string]>, words?: (k: string, v: string, op: 'add' | 'remove') => string): void {
  for (const [k, v] of remove) p.changes.push({ key: k, label: 'Raw line', before: v, after: null, words: words?.(k, v, 'remove') ?? `Remove ${k}: ${v} — applies the next time the container starts`, restart: 'restart' })
  for (const [k, v] of add) p.changes.push({ key: k, label: 'Raw line', before: null, after: v, words: words?.(k, v, 'add') ?? `Add ${k}: ${v} — applies the next time the container starts`, restart: 'restart' })
  p.rawFile = { remove: [...(p.rawFile?.remove ?? []), ...remove], add: [...(p.rawFile?.add ?? []), ...add] }
  p.confirmName = true
  if (!p.checks.some(c => /whole config file/.test(c)))
    p.checks.push('Proxmox’s API refuses lxc.* lines, so these are written by rewriting the whole config file over the node login: compared by hash first, temp file and rename, read back byte for byte, then read through the API.')
  if (g.running && !p.warnings.some(w => /not changed while it runs/.test(w))) p.warnings.push('The running container is not changed while it runs: raw lines apply the next time it starts.')
}

export interface RawEdit { remove?: Array<[string, string]>; add?: Array<[string, string]>; change?: Array<{ from: [string, string]; to: [string, string] }> }

/** A raw-line edit: every line added or removed, written through the whole-file writer. */
export function buildRawEditPlan(g: GuestCtx, edit: RawEdit): Plan {
  const p = emptyPlan()
  p.confirmName = true
  if (g.type !== 'lxc') { p.errors.push('Raw lxc lines are a container feature.'); return p }
  const lines = rawLines(g.config)
  const has = (l: [string, string]) => lines.some(x => x[0] === l[0] && x[1] === l[1])
  const remove: Array<[string, string]> = [], add: Array<[string, string]> = []
  const ok = (l: unknown): l is [string, string] => Array.isArray(l) && l.length === 2 && typeof l[0] === 'string' && typeof l[1] === 'string' && /^lxc\.[A-Za-z0-9_.]+$/.test(l[0]) && !/[\r\n\0]/.test(l[1])
  for (const l of [...(edit.remove ?? []), ...(edit.add ?? []), ...(edit.change ?? []).flatMap(c => [c?.from, c?.to])]) if (!ok(l)) { p.errors.push('Each raw line is an lxc.* key and a one-line value.'); return p }
  for (const l of edit.remove ?? []) { if (!has(l)) p.errors.push(`${l[0]}: ${l[1]} is not on this guest.`); else remove.push(l) }
  for (const c of edit.change ?? []) { if (!has(c.from)) p.errors.push(`${c.from[0]}: ${c.from[1]} is not on this guest.`); else { remove.push(c.from); add.push(c.to) } }
  for (const l of edit.add ?? []) { if (has(l)) p.errors.push(`${l[0]}: ${l[1]} is already there.`); else add.push(l) }
  if (p.errors.length) return p
  if (!remove.length && !add.length) { p.errors.push('Nothing to change.'); return p }
  rawChanges(p, g, remove, add)
  p.checks.push(`${lines.length} raw line(s) now; ${lines.length - remove.length + add.length} after this change`)
  const gpuAdded = add.filter(l => detectGpu('lxc', { lxc: [l] } as any).entries.length)
  if (gpuAdded.length) p.meta = { gpuManagedRaw: gpuAdded }
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

/** Risk acknowledgements are never part of the edit: they are ticked at apply (extraConfirm). */
export interface HostpciEdit { add?: { deviceId: string; pcie?: boolean; xvga?: boolean; allFunctions?: boolean }; remove?: string }

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
  if (dev.resetRisk) { p.warnings.push(dev.resetRisk); p.extraConfirm.push('reset-risk') }
  if (dev.bootDisplay) { p.warnings.push(`${dev.name} is the node’s display GPU: the host loses its console.`); p.extraConfirm.push('display-gpu') }
  if (dev.unknown) p.extraConfirm.push('unknown-device')
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

export interface DeviceGrant { deviceId: string; gid?: number; remove?: string }

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
  if (dev.unknown) p.extraConfirm.push('unknown-device')
  if (e.gid !== undefined && !isGid(e.gid)) { p.errors.push('A group id is a whole number from 0 to 65535.'); return p }
  const others = [...new Map(dev.usedBy.filter(u => u.vmid !== g.vmid).map(u => [u.vmid, u])).values()]
  const exclusive = dev.kind === 'serial' || dev.shareAs.includes('lxc-dev-exclusive')
  if (exclusive && others.length) {
    const words = others.map(u => `${u.type === 'lxc' ? 'CT' : 'VM'} ${u.vmid} '${u.name}' (${u.running ? 'running' : 'stopped'})`).join(', ')
    if (others.some(u => u.running)) { p.errors.push(`Only one guest can use ${dev.name} at a time; it is used by ${words}.`); return p }
    p.warnings.push(`Only one guest can use this at a time; it is also set on ${words}, which must not run at the same time.`)
    p.extraConfirm.push('exclusive-device')
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
      // Any other device with the same vendor:product on this node makes vendor:product ambiguous; QEMU cannot
      // pick by serial, so it goes by the physical port.
      const twin = inv.devices.some(o => o !== dev && o.vendorProduct && o.vendorProduct === dev.vendorProduct)
      const host = twin || !dev.vendorProduct ? dev.port : dev.vendorProduct
      if (!host) { p.errors.push('This USB device has no stable identity to pass.'); return p }
      set = { [`usb${freeIndex('usb', Object.keys(g.config), 13)}`]: `host=${host}` }
      if (twin) p.warnings.push(dev.serial ? 'Another device on this node has the same vendor:product. Proxmox cannot pick a USB device by serial number, so this one is passed by the USB port it is plugged into: keep it in that port.' : 'These look identical; they’re told apart only by the USB port they’re plugged into, so keep them in the same ports.')
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

// ── Portable GPU: one config that works on whichever node HA starts the guest ──

/**
 * Why Portable GPU uses raw optional lines, and why HyperProx cannot write them yet. Both facts were measured on
 * a live cluster: Proxmox answers `Device /dev/… does not exist` and refuses to start a container whose devN
 * names a device the node lacks; and the API refuses every lxc.* key, to set or to delete, for an API token and
 * for root@pam alike (`Unknown option: lxc.cgroup2.devices.allow`).
 */
export const PORTABLE_WHY_RAW = 'A devN entry whose device is missing on a node stops the container from starting there (Proxmox: “Device … does not exist”), so a portable config has to use lxc.mount.entry lines marked optional, which LXC skips when the device is absent.'
export const PORTABLE_NO_WRITER = 'Proxmox’s API does not accept lxc.* lines from any caller (an API token or root@pam), so HyperProx writes these by rewriting the whole config file over the node login, under its compare-and-swap guards.'

export interface PortableTarget { node: string; inv: NodeInventory }

/** The raw lines that give a container every eligible node's GPU, each one optional. */
export function portableLines(targets: PortableTarget[]): { lines: Array<[string, string]>; perNode: Array<{ node: string; gpu: string; paths: string[]; majors: number[] }> } {
  const lines: Array<[string, string]> = []
  const seen = new Set<string>()
  const add = (k: string, v: string) => { const id = `${k}\u0000${v}`; if (!seen.has(id)) { seen.add(id); lines.push([k, v]) } }
  const perNode: Array<{ node: string; gpu: string; paths: string[]; majors: number[] }> = []
  const mounts: Array<[string, string]> = []
  for (const t of targets) {
    const gpus = t.inv.devices.filter(d => d.kind === 'gpu' && !d.vfio)
    const paths = [...new Set(gpus.flatMap(d => d.paths.filter(p => /^\/dev\/(dri\/(renderD|card)\d+|nvidia[\w-]*|nvidia-caps\/[\w-]+|kfd)$/.test(p))))]
    const majors = new Set<number>()
    for (const [name, n] of Object.entries(t.inv.majors)) if (/^(nvidia|nvidiactl|nvidia-uvm|nvidia-caps|nvidia-modeset|drm|kfd)$/.test(name) && paths.some(p => (name === 'drm' ? p.startsWith('/dev/dri/') : name === 'kfd' ? p === '/dev/kfd' : p.startsWith('/dev/nvidia')))) majors.add(n)
    for (const m of [...majors].sort((a, b) => a - b)) add('lxc.cgroup2.devices.allow', `c ${m}:* rwm`)
    for (const p of paths) mounts.push(['lxc.mount.entry', `${p} ${p.slice(1)} none bind,optional,create=file`])
    perNode.push({ node: t.node, gpu: gpus.map(d => d.name).join(', ') || 'no GPU', paths, majors: [...majors] })
  }
  for (const [k, v] of mounts) add(k, v)
  return { lines, perNode }
}

export function buildPortableGpuPlan(g: GuestCtx, targets: PortableTarget[], groups: { render?: number; video?: number } | null): Plan {
  const p = emptyPlan()
  p.confirmName = true
  if (g.type !== 'lxc') { p.errors.push('Portable GPU is for containers.'); return p }
  if (!g.haManaged) p.warnings.push('This container is not HA-managed: it only moves when you migrate it.')
  const missing = targets.filter(t => t.inv.problem)
  for (const t of missing) p.errors.push(`${t.node}: ${t.inv.problem} Its GPU cannot be included.`)
  const { lines, perNode } = portableLines(targets.filter(t => !t.inv.problem))
  const have = rawLines(g.config)
  const toAdd = lines.filter(([k, v]) => !have.some(h => h[0] === k && h[1] === v))
  for (const n of perNode) p.checks.push(`${n.node}: ${n.gpu}${n.paths.length ? ` (${n.paths.join(', ')}; majors ${n.majors.join(', ') || 'none'})` : ''}`)
  const devs = detectGpu('lxc', g.config).entries.filter(e => e.via === 'devN')
  if (devs.length) {
    // A devN for a device a node lacks stops the start there, so the devN GPU entries go in the same change.
    const del = devs.map(e => e.key)
    p.ops.push({ kind: 'config', set: {}, delete: del })
    addConfigChanges(p, g, {}, del)
    p.warnings.push(`The devN GPU entries (${del.join(', ')}) are removed: they would stop the container starting on a node without that device.`)
  }
  if (toAdd.length) rawChanges(p, g, [], toAdd, (k, v) => `Add ${k}: ${v} (optional; applies the next time the container starts)`)
  p.warnings.push(PORTABLE_WHY_RAW)
  p.checks.push(PORTABLE_NO_WRITER)
  if (Number(g.config.unprivileged) === 1) {
    const here = targets.find(t => t.node === g.node)
    const dri = here?.inv.devices.some(d => d.kind === 'gpu' && d.vendor !== 'nvidia')
    p.warnings.push(`Group access in an unprivileged container: a bind-mounted device keeps its host owner and mode, and the host's render group shows as nogroup inside.${groups?.render !== undefined ? ` Inside, render is gid ${groups.render}${groups.video !== undefined ? ` and video is gid ${groups.video}` : ''}.` : ''} NVIDIA device nodes are mode 0666 on the host, so they work. Intel/AMD render nodes are 0660 (root:render) on the host, so inside they are visible but not usable until each iGPU node allows it (a udev rule giving renderD* mode 0666, or a render-group idmap with a matching /etc/subgid entry on every node). HyperProx does not change node files; this is not done for you.${dri ? '' : ''}`)
  }
  if (!toAdd.length && !devs.length) p.errors.push('Every portable line is already in the config.')
  const herePaths = new Set(targets.find(t => t.node === g.node)?.inv.devices.filter(d => d.kind === 'gpu').flatMap(d => d.paths) ?? [])
  const first = toAdd.map(([, v]) => v.split(/\s+/)[0]).find(x => herePaths.has(x) && /renderD|nvidia0/.test(x))
  if (first) p.deviceChecks.push({ path: first, present: true })
  p.meta = { portable: { lines: toAdd }, gpuManagedRaw: toAdd }
  return p
}
