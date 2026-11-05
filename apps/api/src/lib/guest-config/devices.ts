// =============================================================================
//  HyperProx — what each node can share with its guests, named so people know
//  exactly what they are handing over
//
//  One read-only probe per node (PROBE_SCRIPT, run over the node login), parsed
//  here into devices: GPUs and render nodes, USB devices, serial sticks, video
//  capture, TPUs, /dev/net/tun, and PCI devices for VM passthrough. Each device
//  carries a plain-language name first, its identity underneath, who uses it now,
//  what it can be shared as, and the warnings that apply.
//
//  Identity is the whole point. A guest is always given the most stable reference
//  there is: the by-id link for a serial stick, vendor:product (or the physical
//  port when two identical sticks have no serial) for USB, the PCI address for PCI.
//  Never ttyUSB0, which can swap on the next boot.
// =============================================================================

import { parseProps, rawLines, str, type GuestType, type PveConfig } from './keys'

/** Read-only. Every section is printed even when empty, so a missing tool reads as "none", not as a failure. */
export const PROBE_SCRIPT = String.raw`
echo '##lspci'; lspci -nnkD 2>/dev/null
echo '##lsusb'; lsusb 2>/dev/null
echo '##usbsys'; for d in /sys/bus/usb/devices/*; do [ -f "$d/idVendor" ] && echo "$(basename $d)|$(cat $d/idVendor)|$(cat $d/idProduct)|$(cat $d/busnum)|$(cat $d/devnum)|$(cat $d/bDeviceClass 2>/dev/null)|$(cat $d/manufacturer 2>/dev/null)|$(cat $d/product 2>/dev/null)|$(cat $d/serial 2>/dev/null)"; done
echo '##serial'; for l in /dev/serial/by-id/*; do [ -e "$l" ] && echo "$l|$(readlink -f $l)"; done
echo '##tty'; for t in /dev/ttyUSB* /dev/ttyACM*; do [ -e "$t" ] && echo "$t|$(readlink -f /sys/class/tty/$(basename $t)/device)"; done
echo '##dri'; for d in /dev/dri/card* /dev/dri/renderD*; do [ -e "$d" ] && echo "$d|$(basename $(readlink -f /sys/class/drm/$(basename $d)/device))|$(stat -c '%t:%T' $d)"; done
echo '##bootvga'; for f in /sys/bus/pci/devices/*/boot_vga; do echo "$(basename $(dirname $f))|$(cat $f)"; done
echo '##nvidia'; nvidia-smi --query-gpu=pci.bus_id,name,driver_version,memory.total --format=csv,noheader 2>/dev/null
echo '##nvdev'; ls -1d /dev/nvidia* /dev/nvidia-caps/* 2>/dev/null
echo '##kfd'; ls -1 /dev/kfd 2>/dev/null
echo '##video'; for v in /sys/class/video4linux/*; do [ -e "$v" ] && echo "/dev/$(basename $v)|$(cat $v/name)|$(readlink -f $v/device)"; done
echo '##v4l'; for l in /dev/v4l/by-id/*; do [ -e "$l" ] && echo "$l|$(readlink -f $l)"; done
echo '##apex'; for a in /dev/apex_*; do [ -e "$a" ] && echo "$a|$(readlink -f /sys/class/apex/$(basename $a)/device 2>/dev/null)"; done
echo '##tun'; ls -1 /dev/net/tun 2>/dev/null
echo '##iommu'; find /sys/kernel/iommu_groups/ -mindepth 3 -maxdepth 3 2>/dev/null
echo '##procdevices'; cat /proc/devices
echo '##nvmodule'; cat /sys/module/nvidia/version 2>/dev/null
echo '##end'
`

export type DeviceKind = 'gpu' | 'render' | 'usb' | 'serial' | 'video' | 'tpu' | 'tun' | 'pci'
/** How a device can be given to a guest. */
export type ShareMode = 'lxc-dev-shared' | 'lxc-dev-exclusive' | 'vm-usb' | 'vm-serial' | 'vm-hostpci'
export type Vendor = 'nvidia' | 'intel' | 'amd' | 'other'

export interface DeviceUse {
  vmid: number; type: GuestType; name: string; running: boolean
  via: 'devN' | 'lxc raw' | 'usbN' | 'serialN' | 'hostpciN'
  key: string
}

export interface Device {
  /** Stable across reboots: what a guest config refers to. */
  id: string
  node: string
  kind: DeviceKind
  /** Plain language first: "NVIDIA GeForce GTX 1070 Ti — graphics card". */
  name: string
  /** The product as the ID database names it, without the purpose. */
  product: string
  /** What it is for, from the built-in table: "Zigbee radio (smart home)". */
  purpose: string
  vendor?: Vendor
  vendorProduct?: string
  serial?: string
  /** The reference written into a guest config. */
  stableRef?: string
  /** USB bus-port path, e.g. 1-2: the physical socket. */
  port?: string
  pciAddress?: string
  /** /dev nodes this device provides. */
  paths: string[]
  /** The node boots its console on this GPU. */
  bootDisplay?: boolean
  driver?: string
  vfio?: boolean
  iommuGroup?: number
  /** Only this device's functions and bridges in its IOMMU group. */
  iommuClean?: boolean
  driverVersion?: string
  vram?: string
  /** Why handing this card to a VM and back may hang the host. */
  resetRisk?: string
  unknown?: boolean
  shareAs: ShareMode[]
  usedBy: DeviceUse[]
  /** Plain-language sharing consequences and warnings. */
  notes: string[]
  /** Sharing this needs an extra confirmation (unknown device, the host's only display GPU to a VM). */
  needsExtraConfirm: boolean
}

export interface NodeInventory {
  node: string
  devices: Device[]
  /** Char-device majors from /proc/devices, by name. */
  majors: Record<string, number>
  nvidiaDriver?: string
  /** Host NVIDIA device nodes (/dev/nvidia*, /dev/nvidia-caps/*), files only. */
  nvidiaNodes: string[]
  collectedAt: number
  problem?: string
}

// ── built-in table of common homelab devices ──────────────────────────────────

const PURPOSE_RULES: Array<{ re?: RegExp; ids?: string[]; purpose: string }> = [
  { re: /zigbee|conbee|zbdongle|skyconnect|zbt-?1|sonoff.*dongle|cc2652|cc2531|efr32/i, ids: ['1cf1:0030', '10c4:8a2a', '1a86:55d4'], purpose: 'Zigbee radio (smart home)' },
  { re: /z-?wave|zooz|aeotec|z-?stick|zst10|uzb/i, ids: ['0658:0200'], purpose: 'Z-Wave radio (smart home)' },
  { re: /\bthread\b|openthread|nrf52840/i, purpose: 'Thread radio (smart home)' },
  { re: /coral|edge ?tpu|apex/i, ids: ['1a6e:089a', '18d1:9302', '1ac1:089a'], purpose: 'Coral TPU (AI accelerator)' },
  { re: /rtl28\d\d|rtl2838|\bsdr\b|hackrf|airspy|nooelec|rtl-sdr/i, ids: ['0bda:2838', '0bda:2832', '1d50:6089'], purpose: 'SDR radio receiver' },
  { re: /wintv|hauppauge|dvb|tuner|hdhomerun|tbs\d/i, purpose: 'TV tuner' },
  { re: /\bups\b|back-?ups|cyberpower|eaton|smart-ups/i, ids: ['051d:0002', '0764:0501', '0463:ffff'], purpose: 'UPS data link' },
  { re: /capture|cam ?link|elgato|magewell|avermedia/i, purpose: 'video capture' },
  { re: /webcam|camera/i, purpose: 'camera' },
  { re: /bluetooth/i, purpose: 'Bluetooth adapter' },
  { re: /ft232|cp210|ch340|ch341|pl2303|uart|usb.?serial|ttl/i, ids: ['0403:6001', '0403:6015', '10c4:ea60', '1a86:7523', '067b:2303'], purpose: 'USB serial adapter (serial console)' },
]

export function purposeOf(name: string, vendorProduct?: string): string | null {
  for (const r of PURPOSE_RULES) if (r.re?.test(name)) return r.purpose
  for (const r of PURPOSE_RULES) if (vendorProduct && r.ids?.includes(vendorProduct.toLowerCase())) return r.purpose
  return null
}

const VENDOR_IDS: Record<string, Vendor> = { '10de': 'nvidia', '8086': 'intel', '1002': 'amd', '1022': 'amd' }
export function vendorOf(id?: string): Vendor { return (id && VENDOR_IDS[id.toLowerCase().replace(/^0x/, '')]) || 'other' }

/**
 * NVIDIA consumer cards from before Turing (device IDs below 0x1e00: Pascal, Maxwell, Kepler) are known not to
 * reset cleanly: giving one to a VM and getting it back can hang the host.
 */
export function resetRiskOf(vendorId?: string, deviceId?: string): string | undefined {
  if (vendorOf(vendorId) !== 'nvidia' || !deviceId) return undefined
  const d = parseInt(deviceId.replace(/^0x/, ''), 16)
  if (!Number.isFinite(d) || d >= 0x1e00) return undefined
  return 'NVIDIA cards from before Turing (Pascal and older) often cannot be reset: handing this card to a VM and back can hang the whole host.'
}

// ── probe output parsing ──────────────────────────────────────────────────────

export function sections(out: string): Record<string, string[]> {
  const s: Record<string, string[]> = {}
  let cur = ''
  for (const line of out.split('\n')) {
    const m = /^##(\w+)\s*$/.exec(line)
    if (m) { cur = m[1]; s[cur] = []; continue }
    if (cur && line.trim()) s[cur].push(line)
  }
  return s
}

interface PciRow { address: string; cls: string; clsName: string; name: string; vendorId: string; deviceId: string; driver?: string; label?: string }

export function parseLspci(lines: string[]): PciRow[] {
  const rows: PciRow[] = []
  for (const l of lines) {
    const m = /^([0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]) (.+?) \[([0-9a-f]{4})\]: (.+) \[([0-9a-f]{4}):([0-9a-f]{4})\]/i.exec(l)
    if (m) {
      // Drop the vendor's legal suffixes and the bracketed codename, keep the marketing name if there is one.
      rows.push({ address: m[1], clsName: m[2], cls: m[3], name: m[4].replace(/ \(rev [0-9a-f]+\)$/i, ''), vendorId: m[5], deviceId: m[6] })
      continue
    }
    const last = rows[rows.length - 1]
    if (!last) continue
    const d = /^\s+Kernel driver in use: (\S+)/.exec(l); if (d) last.driver = d[1]
    const n = /^\s+DeviceName: (.+)$/.exec(l); if (n) last.label = n[1].trim()
  }
  return rows
}

/** "NVIDIA Corporation GP104 [GeForce GTX 1070 Ti]" → "NVIDIA GeForce GTX 1070 Ti". */
export function pciProductName(row: Pick<PciRow, 'name' | 'vendorId'> & { cls?: string }): string {
  const vendorWord = ({ nvidia: 'NVIDIA', intel: 'Intel', amd: 'AMD' } as Record<string, string>)[vendorOf(row.vendorId)]
  // Vendor legal names first ("Advanced Micro Devices, Inc. [AMD/ATI]", "Realtek Semiconductor Co., Ltd.").
  let base = row.name
    .replace(/^Advanced Micro Devices, Inc\.\s*(\[(AMD\/ATI|AMD)\]\s*)?/, 'AMD ')
    .replace(/^(NVIDIA|Intel) Corporation\s*/, '$1 ')
    .replace(/,?\s*\b(Corporation|Corp\.|Inc\.|Co\., Ltd\.|Ltd\.|Technology Inc\.|Semiconductor)(?=\s|$)/g, '')
    .replace(/\s+/g, ' ').trim()
  // A GPU's marketing name is the bracketed part: "GP104 [GeForce GTX 1070 Ti]" → "GeForce GTX 1070 Ti".
  const bracket = /\[([^\]]+)\]\s*$/.exec(base)?.[1]
  if (bracket && vendorWord && (!row.cls || /^03/.test(row.cls))) return `${vendorWord} ${bracket.replace(/^(AMD|ATI)\s*\/?\s*(ATI\s*)?/, '')}`.trim()
  if (vendorWord && !base.toUpperCase().startsWith(vendorWord.toUpperCase())) base = `${vendorWord} ${base}`
  return base
}

interface UsbRow { port: string; vid: string; pid: string; bus: number; dev: number; cls: string; manufacturer: string; product: string; serial: string; dbName?: string }

function parseUsb(sys: string[], lsusb: string[]): UsbRow[] {
  const names = new Map<string, string>()
  for (const l of lsusb) {
    const m = /^Bus (\d+) Device (\d+): ID ([0-9a-f]{4}):([0-9a-f]{4}) ?(.*)$/i.exec(l)
    if (m) names.set(`${Number(m[1])}/${Number(m[2])}`, m[5].trim())
  }
  return sys.map(l => {
    const [port, vid, pid, bus, dev, cls, manufacturer, product, serial] = l.split('|').map(x => (x ?? '').trim())
    return { port, vid, pid, bus: Number(bus), dev: Number(dev), cls, manufacturer, product, serial, dbName: names.get(`${Number(bus)}/${Number(dev)}`) }
  }).filter(u => u.vid && !/^usb\d+$/.test(u.port) && u.cls !== '09')   // root hubs and hubs are not shareable
}

const ANY_GPU_CLASS = /^03/

/** Which USB port a sysfs device path sits on: ".../usb1/1-2/1-2:1.0/ttyUSB0" → "1-2". */
function usbPortOf(sysPath: string): string | undefined {
  const m = /\/(\d+-[\d.]+):\d+\.\d+(\/|$)/.exec(sysPath)
  return m?.[1]
}

export function parseProbe(node: string, out: string, now = Date.now()): NodeInventory {
  const s = sections(out)
  const get = (k: string) => s[k] ?? []
  const majors: Record<string, number> = {}
  let inChar = false
  for (const l of get('procdevices')) {
    if (/^Character devices/.test(l)) { inChar = true; continue }
    if (/^Block devices/.test(l)) { inChar = false; continue }
    const m = /^\s*(\d+)\s+(\S+)/.exec(l)
    if (inChar && m) majors[m[2]] = Number(m[1])
  }

  const pci = parseLspci(get('lspci'))
  const bootVga = new Set(get('bootvga').filter(l => l.endsWith('|1')).map(l => l.split('|')[0]))
  const groups = new Map<string, number>()
  const members = new Map<number, string[]>()
  for (const l of get('iommu')) {
    const m = /iommu_groups\/(\d+)\/devices\/(\S+)$/.exec(l)
    if (!m) continue
    groups.set(m[2], Number(m[1]))
    members.set(Number(m[1]), [...(members.get(Number(m[1])) ?? []), m[2]])
  }
  const nvsmi = get('nvidia').map(l => l.split(',').map(x => x.trim())).map(([bus, name, driver, mem]) => ({
    bus: bus.replace(/^0000(?=[0-9a-f]{4}:)/i, '').toLowerCase(), name, driver, mem,
  }))
  const nvidiaDriver = get('nvmodule')[0]?.trim() || nvsmi[0]?.driver
  const nvidiaNodes = get('nvdev').map(l => l.trim()).filter(p => p !== '/dev/nvidia-caps')
  const devices: Device[] = []

  const base = (d: Partial<Device> & Pick<Device, 'id' | 'kind' | 'product' | 'purpose'>): Device => ({
    node, paths: [], shareAs: [], usedBy: [], notes: [], needsExtraConfirm: false,
    name: `${d.product} — ${d.purpose}`, ...d,
  })

  // GPUs: one entry per display controller, carrying its render/card nodes (and the NVIDIA nodes).
  const dri = get('dri').map(l => l.split('|')).map(([path, pciAddr, mm]) => ({ path, pci: pciAddr, mm }))
  const gpuRows = pci.filter(r => ANY_GPU_CLASS.test(r.cls))
  const displayGpus = gpuRows.filter(r => bootVga.has(r.address))
  for (const r of gpuRows) {
    const vendor = vendorOf(r.vendorId)
    const integrated = vendor === 'intel' || /^0000:00:/.test(r.address) && vendor !== 'nvidia'
    const nv = vendor === 'nvidia' ? nvsmi.find(x => x.bus.endsWith(r.address.slice(5)) || r.address.endsWith(x.bus.slice(-7))) : undefined
    const product = nv?.name ? nv.name.replace(/^NVIDIA\s+/, 'NVIDIA ') : pciProductName(r)
    const paths = [
      ...dri.filter(d => d.pci === r.address).map(d => d.path),
      ...(vendor === 'nvidia' ? nvidiaNodes : []),
      ...(vendor === 'amd' && get('kfd').length ? ['/dev/kfd'] : []),
    ]
    const resetRisk = resetRiskOf(r.vendorId, r.deviceId)
    const group = groups.get(r.address)
    const sameSlot = (a: string) => a.slice(0, -2) === r.address.slice(0, -2)
    const clean = group === undefined ? undefined
      : (members.get(group) ?? []).every(a => sameSlot(a) || pci.find(p => p.address === a)?.cls.startsWith('06'))
    const d = base({
      id: `pci:${r.address}`, kind: 'gpu', product, purpose: integrated ? 'built-in graphics' : 'graphics card',
      vendor, vendorProduct: `${r.vendorId}:${r.deviceId}`, pciAddress: r.address, stableRef: r.address, paths,
      bootDisplay: bootVga.has(r.address), driver: r.driver, vfio: r.driver === 'vfio-pci',
      iommuGroup: group, iommuClean: clean, resetRisk,
      driverVersion: vendor === 'nvidia' ? nvidiaDriver : undefined, vram: nv?.mem,
      shareAs: [...(paths.length && r.driver !== 'vfio-pci' ? ['lxc-dev-shared' as const] : []), 'vm-hostpci'],
    })
    if (d.bootDisplay) d.notes.push(displayGpus.length <= 1 ? 'This is the node’s display and console GPU.' : 'The node boots its console on this GPU.')
    devices.push(d)
  }

  // USB devices (serial sticks are matched to their USB device below).
  const usb = parseUsb(get('usbsys'), get('lsusb'))
  const ttyPort = new Map<string, string>()
  for (const l of get('tty')) { const [t, sys] = l.split('|'); const p = usbPortOf(sys ?? ''); if (p) ttyPort.set(t, p) }
  const byId = get('serial').map(l => l.split('|')).map(([link, target]) => ({ link, target }))
  const v4l = get('v4l').map(l => l.split('|')).map(([link, target]) => ({ link, target }))
  const videos = get('video').map(l => l.split('|')).map(([path, name, sys]) => ({ path, name, port: usbPortOf((sys ?? '') + '/') }))

  for (const u of usb) {
    const vp = `${u.vid}:${u.pid}`.toLowerCase()
    const product = (u.product && !/^USB\d\.\d Hub$/.test(u.product) ? [u.manufacturer && !u.product.toLowerCase().startsWith(u.manufacturer.toLowerCase()) ? u.manufacturer.replace(/,?\s*(Inc\.|Ltd\.?|Corp\.?)$/, '') : '', u.product].filter(Boolean).join(' ') : '')
      || u.dbName?.replace(/^(.+?), Inc\.\s*/, '$1 ') || ''
    const purpose = purposeOf(`${product} ${u.dbName ?? ''}`, vp)
    const ttys = [...ttyPort.entries()].filter(([, p]) => p === u.port).map(([t]) => t)
    const links = byId.filter(b => ttys.includes(b.target))
    const vids = videos.filter(v => v.port === u.port)
    const isSerial = ttys.length > 0
    const isVideo = vids.length > 0
    const unknown = !product
    const kind: DeviceKind = isSerial ? 'serial' : isVideo ? 'video' : /tpu/i.test(purpose ?? '') ? 'tpu' : 'usb'
    const paths = isSerial ? links.map(l => l.link).concat(links.length ? [] : ttys)
      : isVideo ? vids.map(v => v.path) : []
    const stableRef = isSerial ? (links[0]?.link ?? ttys[0])
      : isVideo ? (v4l.find(l => vids.some(v => v.path === l.target))?.link ?? vids[0]?.path) : vp
    const d = base({
      id: `usb:${vp}:${u.serial || `port-${u.port}`}`, kind,
      product: unknown ? 'Unknown USB device' : product,
      purpose: purpose ?? (isSerial ? 'serial device' : isVideo ? 'video device' : 'USB device'),
      vendorProduct: vp, serial: u.serial || undefined, port: u.port, paths, stableRef, unknown,
      shareAs: isSerial ? ['lxc-dev-exclusive', 'vm-usb'] : isVideo ? ['lxc-dev-shared', 'vm-usb'] : ['vm-usb'],
    })
    if (unknown) { d.name = `Unknown USB device (${vp})`; d.needsExtraConfirm = true }
    if (isSerial && !links.length) d.notes.push('No /dev/serial/by-id link: the ttyUSB name can change on reboot.')
    devices.push(d)
  }

  // Identical twins: same vendor:product, no serial — only the port tells them apart.
  const byVp = new Map<string, Device[]>()
  for (const d of devices.filter(x => x.vendorProduct && x.port)) byVp.set(d.vendorProduct!, [...(byVp.get(d.vendorProduct!) ?? []), d])
  for (const group of byVp.values()) {
    if (group.length < 2) continue
    // Same vendor:product twice on one node: vendor:product is ambiguous, and Proxmox cannot select a USB device
    // by serial, so each one is referenced by its physical port.
    for (const d of group) {
      d.notes.push(group.every(x => x.serial)
        ? 'Another device here has the same vendor:product. They have different serial numbers, but a VM can only be given one by the USB port it is plugged into, so keep it in that port.'
        : 'These look identical; they’re told apart only by the USB port they’re plugged into, so keep them in the same ports.')
      if (d.kind === 'usb' || d.kind === 'tpu') d.stableRef = `port ${d.port}`
    }
  }

  // Coral PCIe/M.2 (gasket/apex driver).
  for (const l of get('apex')) {
    const [path, sys] = l.split('|')
    const addr = /([0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7])$/i.exec(sys ?? '')?.[1]
    devices.push(base({ id: `apex:${addr ?? path}`, kind: 'tpu', product: 'Coral Edge TPU', purpose: 'Coral TPU (AI accelerator)',
      pciAddress: addr, stableRef: path, paths: [path], shareAs: ['lxc-dev-exclusive', 'vm-hostpci'] }))
  }

  if (get('tun').length) devices.push(base({ id: 'tun', kind: 'tun', product: 'TUN/TAP network device', purpose: 'VPN tunnels (/dev/net/tun)',
    stableRef: '/dev/net/tun', paths: ['/dev/net/tun'], shareAs: ['lxc-dev-shared'] }))

  // Other PCI devices a VM could take: NICs, USB controllers, multimedia/capture, accelerators.
  for (const r of pci) {
    if (ANY_GPU_CLASS.test(r.cls) || devices.some(d => d.pciAddress === r.address)) continue
    const purpose = /^02/.test(r.cls) ? 'network card' : r.cls === '0c03' ? 'USB controller' : /^04/.test(r.cls) && !/audio/i.test(r.clsName) ? 'capture or tuner card'
      : /^04/.test(r.cls) ? 'audio device' : /^12|^0880/.test(r.cls) ? 'accelerator' : null
    if (!purpose) continue
    const group = groups.get(r.address)
    const sameSlot = (a: string) => a.slice(0, -2) === r.address.slice(0, -2)
    const product = pciProductName(r)
    devices.push(base({
      id: `pci:${r.address}`, kind: 'pci', product, purpose: purposeOf(product, `${r.vendorId}:${r.deviceId}`) ?? purpose,
      vendor: vendorOf(r.vendorId), vendorProduct: `${r.vendorId}:${r.deviceId}`, pciAddress: r.address, stableRef: r.address,
      driver: r.driver, vfio: r.driver === 'vfio-pci', iommuGroup: group,
      iommuClean: group === undefined ? undefined : (members.get(group) ?? []).every(a => sameSlot(a) || pci.find(p => p.address === a)?.cls.startsWith('06')),
      shareAs: ['vm-hostpci'],
    }))
  }

  for (const d of devices) {
    if (d.shareAs.includes('vm-hostpci')) {
      if (d.iommuGroup === undefined) d.notes.push('IOMMU is off on this node, so it cannot be passed to a VM.')
      else if (d.iommuClean === false) d.notes.push(`IOMMU group ${d.iommuGroup} holds other devices: passing this passes them too.`)
      if (d.resetRisk) d.notes.push(d.resetRisk)
    }
  }
  return { node, devices, majors, nvidiaDriver, nvidiaNodes, collectedAt: now }
}

// ── who uses what ─────────────────────────────────────────────────────────────

export interface GuestRef { vmid: number; type: GuestType; name: string; node: string; running: boolean; config: PveConfig }

const GPU_MAJOR_NAMES = /^(nvidia|nvidiactl|nvidia-frontend|nvidia-uvm|nvidia-caps|nvidia-nvlink|nvidia-nvswitch|nvidia-modeset|drm|kfd)$/

/** Majors that belong to GPU devices on a node, from its /proc/devices. Falls back to the usual two when unread. */
export function gpuMajors(majors: Record<string, number> | null | undefined): Map<number, { name: string; assumed: boolean }> {
  const out = new Map<number, { name: string; assumed: boolean }>()
  if (majors && Object.keys(majors).length) {
    for (const [name, n] of Object.entries(majors)) if (GPU_MAJOR_NAMES.test(name) && !out.has(n)) out.set(n, { name, assumed: false })
    return out
  }
  out.set(195, { name: 'nvidia', assumed: true })
  out.set(226, { name: 'drm', assumed: true })
  return out
}

/** Attach usage to each device from every guest config on that node (and say so in words). */
export function attachUsage(inv: NodeInventory, guests: GuestRef[]): NodeInventory {
  for (const d of inv.devices) {
    d.usedBy = []
    for (const g of guests) {
      if (g.node !== inv.node) continue
      for (const [k, v] of Object.entries(g.config)) {
        const val = str(v)
        if (/^dev\d+$/.test(k)) {
          const path = parseProps(val).head ?? ''
          if (d.paths.includes(path) || d.stableRef === path) d.usedBy.push({ vmid: g.vmid, type: g.type, name: g.name, running: g.running, via: 'devN', key: k })
        } else if (/^hostpci\d+$/.test(k) && d.pciAddress) {
          const head = (parseProps(val).head ?? '').split(';')
          if (head.some(h => h && (d.pciAddress === h || d.pciAddress!.startsWith(h.length === 7 ? `0000:${h}` : h) || d.pciAddress!.endsWith(h))))
            d.usedBy.push({ vmid: g.vmid, type: g.type, name: g.name, running: g.running, via: 'hostpciN', key: k })
        } else if (/^usb\d+$/.test(k)) {
          const host = /host=([^,]+)/.exec(val)?.[1]
          if (host && (host.toLowerCase() === d.vendorProduct || (d.port && host === d.port)))
            d.usedBy.push({ vmid: g.vmid, type: g.type, name: g.name, running: g.running, via: 'usbN', key: k })
        } else if (/^serial\d+$/.test(k)) {
          if (d.paths.includes(val) || d.stableRef === val) d.usedBy.push({ vmid: g.vmid, type: g.type, name: g.name, running: g.running, via: 'serialN', key: k })
        }
      }
      for (const [rk, rv] of rawLines(g.config)) {
        if (rk !== 'lxc.mount.entry') continue
        const src = rv.split(/\s+/)[0]
        if (d.paths.includes(src)) { d.usedBy.push({ vmid: g.vmid, type: g.type, name: g.name, running: g.running, via: 'lxc raw', key: rk }); break }
      }
    }
    describeSharing(d)
  }
  return inv
}

function who(u: DeviceUse): string { return `${u.type === 'lxc' ? 'CT' : 'VM'} ${u.vmid} '${u.name}' (${u.running ? 'running' : 'stopped'})` }

function describeSharing(d: Device): void {
  const shared = d.shareAs.includes('lxc-dev-shared')
  const exclusive = d.shareAs.includes('lxc-dev-exclusive') || (!shared && !d.shareAs.includes('vm-usb'))
  d.notes = d.notes.filter(n => !/^(Shared with|Only one guest|Passing this|Sharing this|Used by)/.test(n))
  const users = [...new Map(d.usedBy.map(u => [u.vmid, u])).values()]
  if (users.length) d.notes.unshift(`${shared ? 'Shared with' : 'Used by'}: ${users.map(who).join(', ')}`)
  if (shared) d.notes.push('Sharing this gives the container full access to the device.')
  if (exclusive || d.kind === 'serial') {
    d.notes.push(`Only one guest can use this at a time${users.length ? `; currently used by ${users.map(who).join(', ')}` : ''}.`)
    if (users.length > 1) d.notes.push(`Unsafe: ${users.length} guests are set to use it at once.`)
  }
  if (d.shareAs.includes('vm-hostpci')) {
    d.notes.push('Passing this to a VM removes it from the host and every other guest.')
    if (d.bootDisplay) d.needsExtraConfirm = true
  }
  if (d.unknown) d.needsExtraConfirm = true
}

/** What a viewer may see: names, purpose and usage. Paths, IDs, serials and addresses are admin-only. */
export function redactForViewer(inv: NodeInventory): NodeInventory {
  return {
    ...inv, majors: {}, nvidiaNodes: [],
    devices: inv.devices.map(d => ({
      ...d, id: d.id.replace(/:.*/, ':*'), vendorProduct: undefined, serial: undefined, stableRef: undefined, port: undefined,
      pciAddress: undefined, paths: [], name: d.unknown ? 'Unknown USB device' : d.name,
      usedBy: d.usedBy.map(u => ({ ...u, key: '' })),
      notes: d.notes,
    })),
  }
}
