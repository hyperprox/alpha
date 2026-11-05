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
  assert.deepEqual(Object.values((q.plan.ops[0] as any).set).filter((v: any) => String(v).startsWith('/dev/')).sort(), ['/dev/nvidia-caps/nvidia-cap1', '/dev/nvidia-caps/nvidia-cap2', '/dev/nvidia-uvm', '/dev/nvidia-uvm-tools', '/dev/nvidia0', '/dev/nvidiactl'])
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

test('GPU access off, then on: only what HyperProx added goes, and comes back byte-for-byte, through restarts that check the device', async () => {
  const { service, pve, G } = igpuSetup(true)
  pve.g('lxc', 941).config.dev1 = '/dev/net/tun'
  const gpu = (await service.inventory('node-b')).devices.find(d => d.kind === 'gpu')!
  const gr = await service.preview(OWNER, G, { kind: 'gpu-grant', grant: { deviceId: gpu.id, renderGid: 993 } })
  await service.apply(OWNER, gr.id, { name: 'tv' })
  await service.apply(OWNER, (await service.preview(OWNER, G, { kind: 'restart', after: gr.id })).id)
  const off = await service.preview(OWNER, G, { kind: 'gpu-off' })
  assert.deepEqual((off.plan.ops[0] as any).delete, ['dev0'], 'tun is not a GPU and stays')
  assert.equal(off.plan.confirmName, true)
  assert.ok(off.plan.warnings.some(w => /next time the container starts/.test(w)))
  await assert.rejects(service.apply(OWNER, off.id), (e: any) => e.code === 'confirm')
  const off2 = await service.preview(OWNER, G, { kind: 'gpu-off' })
  const r = await service.apply(OWNER, off2.id, { name: 'tv' })
  assert.equal(r.ok, true, JSON.stringify(r.outcome?.problems))
  assert.deepEqual(r.pendingKeys, ['dev0'], 'later: shown as pending')
  assert.deepEqual((await service.view(G)).pending.keys, ['dev0'])
  const rr = await service.apply(OWNER, (await service.preview(OWNER, G, { kind: 'restart', after: off2.id })).id)
  assert.equal(rr.ok, true, JSON.stringify(rr.restart))
  assert.deepEqual(rr.restart!.devices, [{ path: '/dev/dri/renderD128', expected: false, seen: false }])
  assert.equal((await service.view(G)).gpu.toggle, 'off')
  const h = await service.historyOf(G)
  assert.ok(h.some(x => x.tag === 'GPU off' && (x.meta as any).gpuOff.removed.dev0 === '/dev/dri/renderD128,gid=993'))

  // Edited in between: turning back on still works.
  await service.apply(OWNER, (await service.preview(OWNER, G, { kind: 'edit', edit: { memory: 1024 } })).id)
  const on = await service.preview(OWNER, G, { kind: 'gpu-on' })
  assert.deepEqual(on.plan.errors, [])
  assert.deepEqual((on.plan.ops[0] as any).set, { dev0: '/dev/dri/renderD128,gid=993' })
  assert.equal((await service.apply(OWNER, on.id, { name: 'tv' })).ok, true)
  const rr2 = await service.apply(OWNER, (await service.preview(OWNER, G, { kind: 'restart', after: on.id })).id)
  assert.equal(rr2.ok, true, JSON.stringify(rr2.restart))
  assert.deepEqual(rr2.restart!.devices, [{ path: '/dev/dri/renderD128', expected: true, seen: true }])
  assert.equal(rr2.restart!.rawSurvived, true)
})

test('GPU off leaves hand-written entries alone unless they are ticked, and lists them', async () => {
  const { service, pve, G } = igpuSetup()
  pve.g('lxc', 941).config.dev0 = '/dev/dri/renderD128,gid=993'
  const off = await service.preview(OWNER, G, { kind: 'gpu-off' })
  assert.ok(off.plan.errors.some(e => /None of this container’s GPU entries were added by HyperProx/.test(e)))
  assert.deepEqual(off.plan.options, [{ key: 'dev0', value: '/dev/dri/renderD128,gid=993', label: 'dev0: /dev/dri/renderD128,gid=993' }])
  const also = await service.preview(OWNER, G, { kind: 'gpu-off', off: { alsoRemove: [{ key: 'dev0', value: '/dev/dri/renderD128,gid=993' }] } })
  assert.deepEqual(also.plan.errors, [])
  assert.equal((await service.apply(OWNER, also.id, { name: 'tv' })).ok, true)
  pve.g('lxc', 941).config.dev0 = '/dev/net/tun'
  const on = await service.preview(OWNER, G, { kind: 'gpu-on' })
  assert.ok(on.plan.errors.some(e => /dev0 is now used for \/dev\/net\/tun/.test(e)))
})

test('raw GPU lines: hand-written ones are listed, never removed by default; ticked ones go through the whole-file writer and come back on', async () => {
  const s = makeService()
  s.shell.probes['node-a'] = FIX('probe-nvidia.txt')
  s.pve.add({ node: 'node-a', type: 'lxc', vmid: 911, status: 'stopped', config: JSON.parse(FIX('ct-nvidia.json')) })
  const G = { node: 'node-a', type: 'lxc' as const, vmid: 911 }
  const off = await s.service.preview(OWNER, G, { kind: 'gpu-off' })
  assert.equal(off.plan.options!.length, 12)
  assert.ok(off.plan.errors.length)
  const pick = off.plan.options!.filter(o => o.value === 'c 510:* rwm').map(o => ({ key: o.key, value: o.value }))
  const p = await s.service.preview(OWNER, G, { kind: 'gpu-off', off: { alsoRemove: pick } })
  assert.deepEqual(p.plan.errors, [])
  assert.ok(p.file)
  assert.equal((await s.service.apply(OWNER, p.id, { name: 'coder' })).ok, true)
  assert.equal((s.pve.g('lxc', 911).config.lxc as any[]).length, 11)
  const on = await s.service.preview(OWNER, G, { kind: 'gpu-on' })
  assert.deepEqual(on.plan.errors, [])
  assert.equal((await s.service.apply(OWNER, on.id, { name: 'coder' })).ok, true)
  assert.equal((s.pve.g('lxc', 911).config.lxc as any[]).length, 12)
  const cv = await s.service.preview(OWNER, G, { kind: 'gpu-convert' })
  assert.deepEqual(cv.plan.errors, [])
  assert.ok(Object.values((cv.plan.ops[0] as any).set).includes('/dev/nvidia0'))
})

test('a group id is an integer from 0 to 65535 and nothing else', async () => {
  const { service, G } = igpuSetup()
  const gpu = (await service.inventory('node-b')).devices.find(d => d.kind === 'gpu')!
  for (const bad of ['0,mode=0777,uid=0', -5.5, 70000, '993'] as any[]) {
    const p = await service.preview(OWNER, G, { kind: 'gpu-grant', grant: { deviceId: gpu.id, renderGid: bad } })
    assert.ok(p.plan.errors.some(e => /whole number from 0 to 65535/.test(e)), String(bad))
    assert.ok(!p.plan.ops.length)
  }
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

// ── Portable GPU and the move check ───────────────────────────────────────────

import { portableLines, buildPortableGpuPlan, PORTABLE_WHY_RAW } from '../src/lib/guest-config/gpu'
import { GpuMoveWatcher } from '../src/lib/guest-config/gpu-watch'

test('Portable GPU: every eligible node’s devices as optional lines, majors read per node, nothing duplicated', () => {
  const { lines, perNode } = portableLines([{ node: 'node-a', inv: nvInv() }, { node: 'node-b', inv: igpuInv() }, { node: 'node-c', inv: homeInv() }])
  const mounts = lines.filter(l => l[0] === 'lxc.mount.entry').map(l => l[1])
  assert.ok(mounts.every(m => / none bind,optional,create=file$/.test(m)))
  assert.ok(mounts.includes('/dev/nvidia0 dev/nvidia0 none bind,optional,create=file'))
  assert.ok(mounts.includes('/dev/dri/renderD128 dev/dri/renderD128 none bind,optional,create=file'))
  assert.equal(mounts.filter(m => m.startsWith('/dev/dri/renderD128 ')).length, 1, 'the same path on two nodes is one line')
  const majors = lines.filter(l => l[0] === 'lxc.cgroup2.devices.allow').map(l => l[1])
  for (const m of ['c 195:* rwm', 'c 226:* rwm', 'c 508:* rwm', 'c 511:* rwm']) assert.ok(majors.includes(m), m)
  assert.ok(!majors.includes('c 240:* rwm'), 'the Coral major is not a GPU')
  assert.equal(perNode.length, 3)
})

test('Portable GPU writes optional lines through the whole-file writer, removes devN GPU entries, and says why', async () => {
  const s = makeService()
  s.shell.probes['node-a'] = FIX('probe-nvidia.txt'); s.shell.probes['node-b'] = FIX('probe-igpu.txt'); s.shell.probes['node-c'] = FIX('probe-homelab.txt')
  s.pve.add({ node: 'node-b', type: 'lxc', vmid: 961, status: 'stopped', ha: 'started', config: smallCt({ hostname: 'media', dev0: '/dev/dri/renderD128,gid=104' }) })
  const G = { node: 'node-b', type: 'lxc' as const, vmid: 961 }
  const p = await s.service.preview(OWNER, G, { kind: 'gpu-portable' })
  assert.deepEqual(p.plan.errors, [])
  assert.ok(p.plan.changes.filter(c => c.label === 'Raw line').length >= 8)
  assert.ok(p.plan.warnings.includes(PORTABLE_WHY_RAW))
  assert.ok(p.plan.warnings.some(w => /0660/.test(w) && /does not change node files/.test(w)), 'group access stated plainly')
  assert.deepEqual((p.plan.ops[0] as any).delete, ['dev0'])
  const r = await s.service.apply(OWNER, p.id, { name: 'media' })
  assert.equal(r.ok, true, JSON.stringify(r.outcome?.problems))
  const raw = s.pve.g('lxc', 961).config.lxc as Array<[string, string]>
  assert.ok(raw.some(l => l[1] === '/dev/nvidia0 dev/nvidia0 none bind,optional,create=file'))
  assert.ok(raw.some(l => l[1] === 'c 226:* rwm'))
  assert.equal(s.pve.g('lxc', 961).config.dev0, undefined)
  const vm = buildPortableGpuPlan({ type: 'qemu', vmid: 1, node: 'node-a', name: 'x', running: false, config: {}, pendingKeys: [], haManaged: true }, [], null)
  assert.ok(vm.errors.length)
})

test('after an HA move the watcher looks inside and names the GPU it now uses, or says it is on the CPU; home is announced', async () => {
  const s = makeService()
  s.shell.probes['node-a'] = FIX('probe-nvidia.txt'); s.shell.probes['node-b'] = FIX('probe-igpu.txt')
  const g = s.pve.add({ node: 'node-a', type: 'lxc', vmid: 971, status: 'running', ha: 'started', config: JSON.parse(FIX('ct-nvidia.json')) })
  const sent: any[] = []
  const w = new GpuMoveWatcher(s.service, async e => { sent.push(e) })
  assert.deepEqual(await w.tick(), [])
  g.node = 'node-b'
  s.shell.inside['971'] = ['/dev/dri/renderD128']
  const orig = s.shell.run.bind(s.shell)
  s.shell.run = async (node, cmd) => cmd.includes('HPX-LOOKED') ? (s.shell.logins.has(node) ? { code: 0, output: [...(s.shell.inside['971'] ?? []), 'HPX-LOOKED'].join('\n') } : null) : orig(node, cmd)
  let ev = await w.tick()
  assert.equal(ev[0].title, 'coder moved from node-a to node-b and is now using Intel HD Graphics 630')
  g.node = 'node-c'; s.shell.inside['971'] = []
  ev = await w.tick()
  assert.equal(ev[0].title, 'coder moved from node-b to node-c, but no GPU is visible: transcoding is on the CPU')
  assert.equal(ev[0].severity, 'warning')
  g.node = 'node-a'; s.shell.inside['971'] = ['/dev/nvidia0']
  ev = await w.tick()
  assert.equal(ev[0].type, 'guest.gpu.home')
  assert.match(ev[0].title, /back on node-a and on its home GPU \(NVIDIA GeForce GTX 1070 Ti\)/)
  assert.equal(sent.length, 3)
  assert.ok(!s.pve.writes.length, 'checks only: nothing written')
  // No login, or locked: "couldn't check", never "no GPU".
  g.node = 'node-c'; s.shell.logins.delete('node-c')
  ev = await w.tick()
  assert.equal(ev[0].type, 'guest.gpu.unchecked')
  assert.match(ev[0].title, /couldn't check its GPU \(no node login for node-c\)/)
  const locked = new GpuMoveWatcher(s.service, async () => {}, () => 0, () => true)
  assert.match((await locked.check('node-a', 971)).unknown!, /locked/)
})

test('watcher ticks never overlap', async () => {
  const s = makeService()
  let calls = 0
  ;(s.service as any).haGpuGuests = async () => { calls++; await new Promise(r => setTimeout(r, 20)); return [] }
  const w = new GpuMoveWatcher(s.service, async () => {})
  await Promise.all([w.tick(), w.tick(), w.tick()])
  assert.equal(calls, 1)
})

test('identical USB devices with different serials go by port, never by an ambiguous vendor:product', async () => {
  const twins = FIX('probe-homelab.txt').replace('1-4|0bda|2838|1|5|00|Realtek|RTL2838UHIDIR|', '1-4|0bda|2838|1|5|00|Realtek|RTL2838UHIDIR|SER-A').replace('1-5|0bda|2838|1|6|00|Realtek|RTL2838UHIDIR|', '1-5|0bda|2838|1|6|00|Realtek|RTL2838UHIDIR|SER-B')
  const s = makeService()
  s.shell.probes['node-c'] = twins
  s.pve.add({ node: 'node-c', type: 'qemu', vmid: 935, status: 'stopped', config: { name: 'sdr', memory: 1024 } })
  const inv = await s.service.inventory('node-c')
  const sdr = inv.devices.filter(d => d.vendorProduct === '0bda:2838')
  assert.ok(sdr.every(d => d.serial && d.notes.some(n => /same vendor:product/.test(n))))
  const u = await s.service.preview(OWNER, { node: 'node-c', type: 'qemu', vmid: 935 }, { kind: 'device', device: { deviceId: sdr[0].id } })
  assert.equal((u.plan.ops[0] as any).set.usb0, `host=${sdr[0].port}`)
})

test('hostpci acknowledgements cannot be given in the preview', async () => {
  const s = makeService()
  s.shell.probes['node-a'] = FIX('probe-nvidia.txt')
  s.pve.add({ node: 'node-a', type: 'qemu', vmid: 921, status: 'stopped', config: { name: 'gamer', memory: 1024, machine: 'q35' } })
  const nv = (await s.service.inventory('node-a')).devices.find(d => d.kind === 'gpu')!
  const p = await s.service.preview(OWNER, { node: 'node-a', type: 'qemu', vmid: 921 }, { kind: 'hostpci', hostpci: { add: { deviceId: nv.id }, ackResetRisk: true, ackDisplayGpu: true } as any })
  assert.deepEqual(p.plan.extraConfirm.sort(), ['display-gpu', 'reset-risk'])
})

test('a GPU counts as visible only as a character device: create=file leaves an empty placeholder where an optional one is missing', async () => {
  const { readFileSync } = await import('node:fs')
  const src = ['service.ts', 'gpu-watch.ts'].map(f => readFileSync(require('node:path').join(__dirname, '..', 'src', 'lib', 'guest-config', f), 'utf8')).join('\n')
  assert.ok(!/\[ -e "\$p" \]/.test(src) && !/ls -1 \/dev\/nvidia0/.test(src))
  assert.ok((src.match(/\[ -c "\$p" \]/g) ?? []).length >= 3)
})
