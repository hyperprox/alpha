// GPU detection, the guided GPU editor, the GPU access toggle, PCI passthrough, and the device inventory.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeService, smallCt, OWNER, FIX } from './fakes/guest-pve'
import { detectGpu, driverMatch, containerNvidiaVersion, buildHostpciPlan } from '../src/lib/guest-config/gpu'
import { parseProbe, attachUsage, redactForViewer, purposeOf, pciProductName, gpuMajors } from '../src/lib/guest-config/devices'
import { GuestConfigRefusal } from '../src/lib/guest-config/service'

const nvInv = () => parseProbe('node-a', FIX('probe-nvidia.txt'))
const igpuInv = () => parseProbe('node-b', FIX('probe-igpu.txt'))
const homeInv = () => parseProbe('node-c', FIX('probe-homelab.txt'))

// ── detection ─────────────────────────────────────────────────────────────────

test('an NVIDIA container passed by raw lines: every line is found, majors come from the node’s /proc/devices', () => {
  const g = detectGpu('lxc', JSON.parse(FIX('ct-nvidia.json')), nvInv())
  assert.deepEqual(g.vendors, ['nvidia'])
  assert.equal(g.entries.filter(e => e.via === 'lxc cgroup').length, 5)
  assert.equal(g.entries.filter(e => e.via === 'lxc mount').length, 7)
  assert.ok(g.entries.find(e => e.value === 'c 508:* rwm')!.device.includes('nvidia-uvm'))
  assert.ok(g.entries.every(e => !e.assumed))
  assert.equal(g.rawCount, 12)
})

test('majors are read, not hard-coded: a node without the NVIDIA module does not call 508 a GPU', () => {
  const cfg = { lxc: [['lxc.cgroup2.devices.allow', 'c 508:* rwm'], ['lxc.cgroup2.devices.allow', 'c 226:* rwm']] }
  const g = detectGpu('lxc', cfg as any, igpuInv())
  assert.deepEqual(g.entries.map(e => e.value), ['c 226:* rwm'])
  assert.ok(gpuMajors(null).get(195)?.assumed, 'unread: the usual majors, marked as assumed')
})

test('an Intel devN container is tagged Intel through the node inventory; a VM hostpci resolves to its card', () => {
  const ct = detectGpu('lxc', smallCt({ dev0: '/dev/dri/renderD128,gid=993' }), igpuInv())
  assert.deepEqual(ct.vendors, ['intel'])
  assert.equal(ct.entries[0].via, 'devN')
  const vm = detectGpu('qemu', JSON.parse(FIX('vm-hostpci.json')), nvInv())
  assert.equal(vm.entries[0].via, 'hostpci')
  assert.deepEqual(vm.vendors, ['nvidia'])
})

test('driver check: a userland that differs from the host driver is a mismatch, in words', () => {
  assert.equal(containerNvidiaVersion('/usr/lib/x86_64-linux-gnu/libnvidia-ml.so.1\n/usr/lib/x86_64-linux-gnu/libnvidia-ml.so.580.173.02\n'), '580.173.02')
  assert.equal(driverMatch('580.173.02', '580.173.02').state, 'match')
  const bad = driverMatch('580.173.02', '575.64.05')
  assert.equal(bad.state, 'mismatch')
  assert.match(bad.words, /NVML/)
  assert.equal(driverMatch(null, '1').state, 'unknown')
})

// ── device inventory ──────────────────────────────────────────────────────────

test('inventory: the NVIDIA node lists its card by name, driver, VRAM, nodes, display role and reset risk', () => {
  const inv = nvInv()
  const gpu = inv.devices.find(d => d.kind === 'gpu')!
  assert.equal(gpu.name, 'NVIDIA GeForce GTX 1070 Ti — graphics card')
  assert.equal(gpu.vendorProduct, '10de:1b82')
  assert.equal(gpu.driverVersion, '580.173.02')
  assert.equal(gpu.vram, '8192 MiB')
  assert.ok(gpu.paths.includes('/dev/nvidia0') && gpu.paths.includes('/dev/nvidia-caps/nvidia-cap1') && gpu.paths.includes('/dev/dri/renderD128'))
  assert.equal(gpu.bootDisplay, true)
  assert.match(gpu.resetRisk!, /before Turing/)
  assert.equal(gpu.iommuGroup, 11)
  assert.equal(gpu.iommuClean, true)
  assert.equal(inv.nvidiaDriver, '580.173.02')
  assert.equal(inv.majors['nvidia-uvm'], 508)
  const cam = inv.devices.find(d => d.kind === 'video')!
  assert.match(cam.name, /C922 Pro Stream Webcam — camera/)
  assert.match(cam.stableRef!, /^\/dev\/v4l\/by-id\//)
})

test('inventory: the iGPU node names its built-in graphics, in a clean IOMMU group', () => {
  const gpu = igpuInv().devices.find(d => d.kind === 'gpu')!
  assert.equal(gpu.name, 'Intel HD Graphics 630 — built-in graphics')
  assert.deepEqual(gpu.paths, ['/dev/dri/card0', '/dev/dri/renderD128'])
  assert.equal(gpu.iommuClean, true)
  assert.equal(gpu.bootDisplay, true)
  assert.ok(igpuInv().devices.some(d => d.kind === 'tun'))
})

test('names: Zigbee, Z-Wave, SDR, UPS and Coral are named with their purpose; an unknown device says so with its ID', () => {
  const inv = homeInv()
  const name = (pred: (d: any) => boolean) => inv.devices.find(pred)?.name
  assert.equal(name(d => d.vendorProduct === '10c4:ea60'), 'ITead Sonoff Zigbee 3.0 USB Dongle Plus — Zigbee radio (smart home)')
  assert.match(name(d => d.vendorProduct === '0658:0200')!, /Z-Wave radio/)
  assert.match(name(d => d.vendorProduct === '0bda:2838')!, /SDR radio receiver/)
  assert.match(name(d => d.vendorProduct === '051d:0002')!, /UPS data link/)
  assert.match(name(d => d.kind === 'tpu')!, /Coral TPU/)
  const unknown = inv.devices.find(d => d.vendorProduct === '1234:abcd')!
  assert.equal(unknown.name, 'Unknown USB device (1234:abcd)')
  assert.equal(unknown.needsExtraConfirm, true)
  assert.equal(purposeOf('Hauppauge WinTV-dualHD'), 'TV tuner')
  assert.equal(pciProductName({ name: 'Intel Corporation UHD Graphics 630', vendorId: '8086' }), 'Intel UHD Graphics 630')
})

test('stable identity: a serial stick by its by-id link, never ttyUSB0; identical sticks without serials are told apart by port', () => {
  const inv = homeInv()
  const zig = inv.devices.find(d => d.vendorProduct === '10c4:ea60')!
  assert.equal(zig.kind, 'serial')
  assert.match(zig.stableRef!, /^\/dev\/serial\/by-id\/usb-ITead_Sonoff/)
  assert.equal(zig.serial, 'a4c138d0e2f1ed11')
  assert.equal(zig.port, '1-2')
  const sdr = inv.devices.filter(d => d.vendorProduct === '0bda:2838')
  assert.equal(sdr.length, 2)
  for (const d of sdr) {
    assert.ok(d.notes.some(n => /look identical; they’re told apart only by the USB port/.test(n)))
    assert.match(d.stableRef!, /^port 1-[45]$/)
  }
})

test('usage and sharing in words: who has it, whether they run, and what sharing means', () => {
  const inv = homeInv()
  attachUsage(inv, [
    { vmid: 931, type: 'lxc', name: 'zigbee2mqtt', node: 'node-c', running: true, config: { dev0: '/dev/serial/by-id/usb-ITead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_a4c138d0e2f1ed11-if00-port0' } },
    { vmid: 932, type: 'lxc', name: 'media', node: 'node-c', running: false, config: { dev0: '/dev/dri/renderD128,gid=104' } },
    { vmid: 933, type: 'qemu', name: 'ha', node: 'node-c', running: true, config: { usb0: 'host=0658:0200' } },
  ])
  const zig = inv.devices.find(d => d.vendorProduct === '10c4:ea60')!
  assert.ok(zig.notes.includes("Used by: CT 931 'zigbee2mqtt' (running)"))
  assert.ok(zig.notes.some(n => n.startsWith("Only one guest can use this at a time; currently used by CT 931 'zigbee2mqtt' (running)")))
  const gpu = inv.devices.find(d => d.kind === 'gpu')!
  assert.ok(gpu.notes.includes("Shared with: CT 932 'media' (stopped)"))
  assert.ok(gpu.notes.includes('Sharing this gives the container full access to the device.'))
  assert.ok(gpu.notes.includes('Passing this to a VM removes it from the host and every other guest.'))
  assert.equal(gpu.needsExtraConfirm, true, 'the only display GPU to a VM needs an extra confirm')
  assert.equal(inv.devices.find(d => d.vendorProduct === '0658:0200')!.usedBy[0].via, 'usbN')
})

test('viewers see names and usage; paths, IDs, serials and addresses are admin-only', () => {
  const r = redactForViewer(homeInv())
  const s = JSON.stringify(r)
  assert.ok(!s.includes('a4c138d0e2f1ed11') && !s.includes('/dev/serial') && !s.includes('0000:00:02.0') && !s.includes('1234:abcd'))
  assert.ok(s.includes('Zigbee radio'))
})

// ── the guided editor (service) ───────────────────────────────────────────────

function igpuSetup(running = false) {
  const s = makeService()
  s.shell.probes['node-b'] = FIX('probe-igpu.txt')
  s.pve.add({ node: 'node-b', type: 'lxc', vmid: 941, status: running ? 'running' : 'stopped', config: smallCt({ hostname: 'tv' }) })
  return { ...s, G: { node: 'node-b', type: 'lxc' as const, vmid: 941 } }
}

test('give a container the Intel GPU: devN for renderD128 with the render gid, confirmed by name, raw line kept', async () => {
  const { service, pve, G } = igpuSetup()
  const inv = await service.inventory('node-b')
  const gpu = inv.devices.find(d => d.kind === 'gpu')!
  const p = await service.preview(OWNER, G, { kind: 'gpu-grant', grant: { deviceId: gpu.id, renderGid: 993 } })
  assert.deepEqual(p.plan.errors, [])
  assert.equal((p.plan.ops[0] as any).set.dev0, '/dev/dri/renderD128,gid=993')
  assert.match(p.plan.changes[0].words, /Intel HD Graphics 630/)
  await assert.rejects(service.apply(OWNER, p.id), (e: any) => e instanceof GuestConfigRefusal && e.code === 'confirm')
  const q = await service.preview(OWNER, G, { kind: 'gpu-grant', grant: { deviceId: gpu.id, renderGid: 993, includeCard: true, videoGid: 44 } })
  assert.equal((q.plan.ops[0] as any).set.dev1, '/dev/dri/card0,gid=44')
  const r = await service.apply(OWNER, q.id, { name: 'tv' })
  assert.equal(r.ok, true, JSON.stringify(r.outcome?.problems))
  assert.deepEqual(pve.g('lxc', 941).config.lxc, [['lxc.cgroup2.devices.allow', 'c 10:200 rwm']])
})

test('a stopped container needs its render gid given; NVIDIA gets a devN per host node', async () => {
  const { service, G } = igpuSetup()
  const gpu = (await service.inventory('node-b')).devices.find(d => d.kind === 'gpu')!
  const p = await service.preview(OWNER, G, { kind: 'gpu-grant', grant: { deviceId: gpu.id } })
  assert.ok(p.plan.errors.some(e => /render group id/.test(e)))

  const s = makeService()
  s.shell.probes['node-a'] = FIX('probe-nvidia.txt')
  s.pve.add({ node: 'node-a', type: 'lxc', vmid: 951, status: 'stopped', config: smallCt({ hostname: 'enc' }) })
  const nv = (await s.service.inventory('node-a')).devices.find(d => d.kind === 'gpu')!
  const q = await s.service.preview(OWNER, { node: 'node-a', type: 'lxc', vmid: 951 }, { kind: 'gpu-grant', grant: { deviceId: nv.id } })
  assert.deepEqual(q.plan.errors, [])
  assert.deepEqual(Object.values((q.plan.ops[0] as any).set).sort(), ['/dev/nvidia-caps/nvidia-cap1', '/dev/nvidia-caps/nvidia-cap2', '/dev/nvidia-uvm', '/dev/nvidia-uvm-tools', '/dev/nvidia0', '/dev/nvidiactl'])
  assert.ok(q.plan.warnings.some(w => /580\.173\.02/.test(w)))
})

test('a device on another node cannot be picked: the guest would need to live there', async () => {
  const { service, shell, G } = igpuSetup()
  shell.probes['node-a'] = FIX('probe-nvidia.txt')
  const nv = (await service.inventory('node-a')).devices.find(d => d.kind === 'gpu')!
  const p = await service.preview(OWNER, G, { kind: 'gpu-grant', grant: { deviceId: nv.id } })
  assert.ok(p.plan.errors.some(e => /not on node-b/.test(e)), p.plan.errors.join())
})

test('remove GPU access removes only what HyperProx added', async () => {
  const { service, pve, G } = igpuSetup()
  pve.g('lxc', 941).config.dev0 = '/dev/dri/card0'      // added by hand
  const gpu = (await service.inventory('node-b')).devices.find(d => d.kind === 'gpu')!
  const p = await service.preview(OWNER, G, { kind: 'gpu-grant', grant: { deviceId: gpu.id, renderGid: 993 } })
  await service.apply(OWNER, p.id, { name: 'tv' })
  const rv = await service.preview(OWNER, G, { kind: 'gpu-revoke' })
  assert.deepEqual((rv.plan.ops[0] as any).delete, ['dev1'])
  assert.ok(rv.plan.checks.some(c => /Kept \(not added by HyperProx\): dev0/.test(c)))
  assert.equal((await service.apply(OWNER, rv.id, { name: 'tv' })).ok, true)
  assert.equal(pve.g('lxc', 941).config.dev0, '/dev/dri/card0')
})

test('GPU access off, then on: the exact entries come back byte-for-byte, through a restart that checks the device', async () => {
  const { service, pve, G } = igpuSetup(true)
  pve.g('lxc', 941).config.dev0 = '/dev/dri/renderD128,gid=993,mode=0660'
  pve.g('lxc', 941).config.dev1 = '/dev/net/tun'
  const off = await service.preview(OWNER, G, { kind: 'gpu-off' })
  assert.deepEqual((off.plan.ops[0] as any).delete, ['dev0'], 'tun is not a GPU and stays')
  assert.ok(off.plan.warnings.some(w => /when the container restarts/.test(w)))
  const r = await service.apply(OWNER, off.id)
  assert.equal(r.ok, true, JSON.stringify(r.outcome?.problems))
  assert.deepEqual(r.pendingKeys, ['dev0'], 'later: shown as pending')
  const v = await service.view(G)
  assert.deepEqual(v.pending.keys, ['dev0'])
  const rs = await service.preview(OWNER, G, { kind: 'restart', after: off.id })
  const rr = await service.apply(OWNER, rs.id)
  assert.equal(rr.ok, true, JSON.stringify(rr.restart))
  assert.deepEqual(rr.restart!.devices, [{ path: '/dev/dri/renderD128', expected: false, seen: false }])
  assert.equal((await service.view(G)).gpu.toggle, 'off')
  const h = await service.historyOf(G)
  assert.ok(h.some(x => x.tag === 'GPU off' && (x.meta as any).gpuOff.removed.dev0 === '/dev/dri/renderD128,gid=993,mode=0660'))

  // Edited in between (memory, and a new dev slot elsewhere): turning back on still works.
  const e = await service.preview(OWNER, G, { kind: 'edit', edit: { memory: 1024 } })
  await service.apply(OWNER, e.id)
  const on = await service.preview(OWNER, G, { kind: 'gpu-on' })
  assert.deepEqual(on.plan.errors, [])
  assert.deepEqual((on.plan.ops[0] as any).set, { dev0: '/dev/dri/renderD128,gid=993,mode=0660' })
  assert.equal((await service.apply(OWNER, on.id)).ok, true)
  const rs2 = await service.preview(OWNER, G, { kind: 'restart', after: on.id })
  const rr2 = await service.apply(OWNER, rs2.id)
  assert.equal(rr2.ok, true, JSON.stringify(rr2.restart))
  assert.deepEqual(rr2.restart!.devices, [{ path: '/dev/dri/renderD128', expected: true, seen: true }])
  assert.equal(rr2.restart!.rawSurvived, true)
  assert.equal(pve.g('lxc', 941).config.dev0, '/dev/dri/renderD128,gid=993,mode=0660')
})

test('turning back on refuses a conflicting key, naming it', async () => {
  const { service, pve, G } = igpuSetup()
  pve.g('lxc', 941).config.dev0 = '/dev/dri/renderD128,gid=993'
  const off = await service.preview(OWNER, G, { kind: 'gpu-off' })
  await service.apply(OWNER, off.id)
  pve.g('lxc', 941).config.dev0 = '/dev/net/tun'
  const on = await service.preview(OWNER, G, { kind: 'gpu-on' })
  assert.ok(on.plan.errors.some(e => /dev0 is now used for \/dev\/net\/tun/.test(e)))
})

test('raw-only GPU access: off says up front the API cannot remove raw lines, and conversion offers devN', async () => {
  const s = makeService()
  s.shell.probes['node-a'] = FIX('probe-nvidia.txt')
  s.pve.add({ node: 'node-a', type: 'lxc', vmid: 911, status: 'stopped', config: JSON.parse(FIX('ct-nvidia.json')) })
  const G = { node: 'node-a', type: 'lxc' as const, vmid: 911 }
  const off = await s.service.preview(OWNER, G, { kind: 'gpu-off' })
  assert.ok(off.plan.warnings.some(w => /cannot be removed: Proxmox’s API does not accept lxc/.test(w)))
  assert.ok(off.plan.errors.some(e => /Convert to devN/.test(e)))
  const cv = await s.service.preview(OWNER, G, { kind: 'gpu-convert' })
  assert.deepEqual(cv.plan.errors, [])
  const set = Object.values((cv.plan.ops[0] as any).set)
  assert.ok(set.includes('/dev/nvidia0') && set.includes('/dev/nvidia-caps/nvidia-cap2'))
  assert.ok(cv.plan.warnings.some(w => /remove these by hand on the node/.test(w)))
  const r = await s.service.apply(OWNER, cv.id, { name: 'coder' })
  assert.equal(r.ok, true, JSON.stringify(r.outcome?.problems))
  assert.equal(r.outcome!.rawAfter, 12)
})

test('hostpci: the reset warning always shows, a Pascal card needs the extra confirm, and a device in use is refused', async () => {
  const s = makeService()
  s.shell.probes['node-a'] = FIX('probe-nvidia.txt')
  s.pve.add({ node: 'node-a', type: 'qemu', vmid: 921, status: 'stopped', config: { ...JSON.parse(FIX('vm-hostpci.json')), hostpci0: undefined } })
  delete s.pve.g('qemu', 921).config.hostpci0
  s.pve.add({ node: 'node-a', type: 'lxc', vmid: 911, status: 'running', config: JSON.parse(FIX('ct-nvidia.json')) })
  const G = { node: 'node-a', type: 'qemu' as const, vmid: 921 }
  const nv = (await s.service.inventory('node-a')).devices.find(d => d.kind === 'gpu')!
  const busy = await s.service.preview(OWNER, G, { kind: 'hostpci', hostpci: { add: { deviceId: nv.id, pcie: true } } })
  assert.ok(busy.plan.errors.some(e => /in use by running CT 911 'coder'/.test(e)), busy.plan.errors.join())
  s.pve.g('lxc', 911).status = 'stopped'
  const p = await s.service.preview(OWNER, G, { kind: 'hostpci', hostpci: { add: { deviceId: nv.id, pcie: true } } })
  assert.deepEqual(p.plan.errors, [])
  assert.ok(p.plan.warnings.some(w => /cannot be reset or handed back/.test(w)))
  assert.deepEqual(p.plan.extraConfirm.sort(), ['display-gpu', 'reset-risk'])
  assert.equal((p.plan.ops[0] as any).set.hostpci0, '0000:42:00.0,pcie=1')
  await assert.rejects(s.service.apply(OWNER, p.id, { name: 'gamer' }), (e: any) => e.code === 'confirm')
  const q = await s.service.preview(OWNER, G, { kind: 'hostpci', hostpci: { add: { deviceId: nv.id, pcie: true } } })
  const r = await s.service.apply(OWNER, q.id, { name: 'gamer', acks: ['display-gpu', 'reset-risk'] })
  assert.equal(r.ok, true, JSON.stringify(r.outcome?.problems))
  assert.equal(s.pve.g('qemu', 921).config.args, '-cpu host,kvm=off', 'args untouched')
  void buildHostpciPlan
})

test('serial stick to a container by its by-id path; exclusive while another running guest has it', async () => {
  const s = makeService()
  s.shell.probes['node-c'] = FIX('probe-homelab.txt')
  s.pve.add({ node: 'node-c', type: 'lxc', vmid: 931, status: 'running', config: smallCt({ hostname: 'z2m', dev0: '/dev/serial/by-id/usb-ITead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_a4c138d0e2f1ed11-if00-port0' }) })
  s.pve.add({ node: 'node-c', type: 'lxc', vmid: 934, status: 'stopped', config: smallCt({ hostname: 'other' }) })
  const inv = await s.service.inventory('node-c')
  const zig = inv.devices.find(d => d.vendorProduct === '10c4:ea60')!
  const p = await s.service.preview(OWNER, { node: 'node-c', type: 'lxc', vmid: 934 }, { kind: 'device', device: { deviceId: zig.id } })
  assert.ok(p.plan.errors.some(e => /Only one guest can use/.test(e)))
  s.pve.g('lxc', 931).config = smallCt({ hostname: 'z2m' })
  const q = await s.service.preview(OWNER, { node: 'node-c', type: 'lxc', vmid: 934 }, { kind: 'device', device: { deviceId: zig.id } })
  assert.deepEqual(q.plan.errors, [])
  assert.match((q.plan.ops[0] as any).set.dev0, /^\/dev\/serial\/by-id\/usb-ITead/)
  assert.match(q.plan.changes[0].words, /^ITead Sonoff Zigbee .* — writes dev0: \/dev\/serial\/by-id/)
  const sdr = inv.devices.find(d => d.vendorProduct === '0bda:2838')!
  s.pve.add({ node: 'node-c', type: 'qemu', vmid: 935, status: 'stopped', config: { name: 'sdr', memory: 1024 } })
  const u = await s.service.preview(OWNER, { node: 'node-c', type: 'qemu', vmid: 935 }, { kind: 'device', device: { deviceId: sdr.id } })
  assert.match((u.plan.ops[0] as any).set.usb0, /^host=1-[45]$/, 'identical twins go by port')
  const unk = inv.devices.find(d => d.unknown)!
  const x = await s.service.preview(OWNER, { node: 'node-c', type: 'qemu', vmid: 935 }, { kind: 'device', device: { deviceId: unk.id } })
  assert.deepEqual(x.plan.extraConfirm, ['unknown-device'])
})

test('PCI names drop the vendor’s legal suffixes and keep the product', () => {
  assert.equal(pciProductName({ name: 'Advanced Micro Devices, Inc. [AMD/ATI] Picasso/Raven 2 [Radeon Vega Series / Radeon Vega Mobile Series]', vendorId: '1002', cls: '0300' } as any), 'AMD Radeon Vega Series / Radeon Vega Mobile Series')
  assert.equal(pciProductName({ name: 'Advanced Micro Devices, Inc. [AMD] Raven USB 3.1', vendorId: '1022', cls: '0c03' } as any), 'AMD Raven USB 3.1')
  assert.equal(pciProductName({ name: 'Realtek Semiconductor Co., Ltd. RTL8111/8168/8211/8411 PCI Express Gigabit Ethernet Controller', vendorId: '10ec', cls: '0200' } as any), 'Realtek RTL8111/8168/8211/8411 PCI Express Gigabit Ethernet Controller')
  assert.equal(pciProductName({ name: 'NVIDIA Corporation GP104 [GeForce GTX 1070 Ti]', vendorId: '10de', cls: '0300' } as any), 'NVIDIA GeForce GTX 1070 Ti')
})
