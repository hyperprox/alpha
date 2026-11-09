// Every GPU on every node gets its own row in the Command center, with its own figures, and the row reads on a
// phone: node first, a short name, one short line, and a reason (never "no data") when nothing is measured.
// In-process fakes only: a pretend Proxmox and a pretend Prometheus.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readPanel, gpusWithSlots, shortGpuName, gpuNote, remoteNodeLabel } from '../src/lib/clusters/overview'
import { gpuCapability, hevcLine } from '../src/lib/hardware'
import { scanNote } from '../src/lib/clusters/scan'
import { gpuRowLabel, gpuRowTitle, gpuRowRight, gpuRowPct, gpuRowDetail, gpuRowAction, gpuShortName, capabilityShortFrom } from '../../frontend/lib/gpu-rows'

const PCI = {
  hd630: { class: '0x030000', vendor: '0x8086', device: '0x5912', device_name: 'HD Graphics 630', id: '0000:00:02.0' },
  gtxA: { class: '0x030000', vendor: '0x10de', device: '0x1b82', device_name: 'GP104 [GeForce GTX 1070 Ti]', id: '0000:0a:00.0' },
  gtxB: { class: '0x030000', vendor: '0x10de', device: '0x1b82', device_name: 'GP104 [GeForce GTX 1070 Ti]', id: '0000:0b:00.0' },
  vega: { class: '0x030000', vendor: '0x1002', device: '0x15d8', device_name: 'Picasso/Raven 2 [Radeon Vega Series / Radeon Vega Mobile Series]', id: '0000:05:00.0' },
  bmc: { class: '0x030000', vendor: '0x1a03', device: '0x2000', device_name: 'ASPEED Graphics Family', id: '0000:03:00.0' },
  audio: { class: '0x040300', vendor: '0x8086', device: '0xa2f0', device_name: 'Audio', id: '0000:00:1f.3' },
}

function fakePve(pci: Record<string, any[]>) {
  const nodes = Object.keys(pci)
  return {
    async fetchStrict(path: string) {
      if (path === '/version') return { version: '9.2' }
      if (path === '/nodes') return nodes.map(node => ({ node, status: 'online', cpu: 0.1, maxcpu: 4, mem: 1, maxmem: 16 }))
      if (path === '/cluster/status') return [{ type: 'cluster', quorate: 1 }]
      return []
    },
    async fetchNode(path: string) {
      const m = /\/nodes\/([^/]+)\/hardware\/pci/.exec(path)
      return m ? pci[decodeURIComponent(m[1])] ?? [] : []
    },
  } as any
}

type Row = { metric: Record<string, string>; value: number }
function fakeProm(table: Array<[string, Row[]]>) {
  return async (expr: string) => table.find(([prefix]) => expr.startsWith(prefix))?.[1] ?? []
}

test('home: every GPU gets a row with its own figures; Intel from the port-8081 exporter; NVIDIA by index; AMD by card', async () => {
  const c: any = { id: 'home', name: 'Home', kind: 'home', monitoring: {} }
  const pve = fakePve({ node1: [PCI.hd630, PCI.audio], node2: [PCI.hd630], node3: [PCI.bmc, PCI.gtxA, PCI.gtxB], node4: [PCI.vega], node5: [PCI.hd630] })
  const prom = fakeProm([
    ['max by (node, pci) ({__name__=~"igpu_engines_.+_busy"', [{ metric: { node: 'node1' }, value: 37.4 }]],
    ['max by (node, pci) (igpu_frequency_actual', [{ metric: { node: 'node1' }, value: 650 }]],
    ['up{job=~"intel-gpu|nvidia"', [{ metric: { node: 'node2', job: 'intel-gpu' }, value: 0 }, { metric: { node: 'node3', job: 'nvidia' }, value: 1 }]],
    ['nvidia_smi_utilization_gpu_ratio', [{ metric: { node: 'node3', uuid: 'aaa' }, value: 0.5 }, { metric: { node: 'node3', uuid: 'bbb' }, value: 0.1 }]],
    ['nvidia_smi_index', [{ metric: { node: 'node3', uuid: 'aaa' }, value: 1 }, { metric: { node: 'node3', uuid: 'bbb' }, value: 0 }]],
    ['nvidia_smi_memory_total_bytes', [{ metric: { node: 'node3', uuid: 'aaa' }, value: 8e9 }, { metric: { node: 'node3', uuid: 'bbb' }, value: 8e9 }]],
    ['nvidia_smi_memory_used_bytes', [{ metric: { node: 'node3', uuid: 'aaa' }, value: 4e9 }, { metric: { node: 'node3', uuid: 'bbb' }, value: 1e9 }]],
    ['nvidia_smi_temperature_gpu', [{ metric: { node: 'node3', uuid: 'aaa' }, value: 61 }, { metric: { node: 'node3', uuid: 'bbb' }, value: 40 }]],
    ['node_drm_gpu_busy_percent', [{ metric: { node: 'node4', card: 'card1' }, value: 22 }]],
    ['node_drm_memory_vram_size_bytes', [{ metric: { node: 'node4', card: 'card1' }, value: 2 ** 31 }]],
    ['node_drm_memory_vram_used_bytes', [{ metric: { node: 'node4', card: 'card1' }, value: 2 ** 29 }]],
  ])
  const p = await readPanel(c, { pve: () => pve, prom, now: Date.now })
  const rows = p.gpus.map(g => [g.node, g.shortName, g.pci, g.state, g.load])
  assert.deepEqual(rows, [
    ['node1', 'HD Graphics 630', '0000:00:02.0', 'measured', 37],
    ['node2', 'HD Graphics 630', '0000:00:02.0', 'waiting', null],
    ['node3', 'GTX 1070 Ti', '0000:0a:00.0', 'measured', 10],
    ['node3', 'GTX 1070 Ti', '0000:0b:00.0', 'measured', 50],
    ['node4', 'Vega Series', '0000:05:00.0', 'measured', 22],
    ['node5', 'HD Graphics 630', '0000:00:02.0', 'not-monitored', null],
  ])
  const [n1, n2, n3a, n3b, n4, n5] = p.gpus
  assert.equal(n1.memory, 'shared')
  assert.equal(n1.freqMHz, 650)
  assert.equal(n3a.memory, 'dedicated')
  assert.equal(n3a.tempC, 40, 'the first card is nvidia-smi index 0')
  assert.equal(n3b.vramUsed, 4e9)
  assert.equal(n4.vramTotal, 2 ** 31)
  assert.equal(n2.stateNote, 'exporter not answering')
  assert.equal(n5.stateNote, 'not monitored')
  assert.equal(n5.setupHref, '/settings/setup-checklist')
  assert.equal(n1.capabilityShort, 'HEVC decode: likely yes (estimate)')
  assert.equal(n1.capabilitySource, 'estimate')
  assert.match(p.gpuNote!, /^Load: measured on 4 of 6 GPUs \(set up monitoring in the setup checklist for the rest\)\. HEVC lines are estimates from the model name/)
})

test('remote: Intel figures by PCI address from the textfile collector; not supported, stopped and not installed each say so', async () => {
  const id = 'c0123456789'
  const c: any = { id, name: 'Remote', kind: 'remote', monitoring: { pve: { nodeExporter: { listen: '10.0.0.7' }, intelGpu: { status: 'measured' } }, pve2: { nodeExporter: { listen: '10.0.0.8' }, intelGpu: { status: 'unsupported' } } } }
  const L = (n: string) => remoteNodeLabel(id, n)
  const now = 2_000_000_000
  const pve = fakePve({ pve: [PCI.hd630], pve2: [PCI.hd630], pve3: [PCI.hd630], pve4: [PCI.hd630] })
  const lab = (n: string, extra: Record<string, string> = {}) => ({ node: L(n), hpx_cluster: id, pci: '0000:00:02.0', card: 'card0', ...extra })
  let seen = ''
  const table = fakeProm([
    ['max by (node, pci) ({__name__=~"igpu_engines_.+_busy"', [{ metric: lab('pve'), value: 12.2 }, { metric: lab('pve3'), value: 90 }]],
    ['max by (node, pci) (igpu_power_gpu', [{ metric: lab('pve'), value: 2.5 }]],
    ['hyperprox_intel_gpu_info', [
      { metric: lab('pve', { status: 'ok', reason: '', driver: 'i915' }), value: 1 },
      { metric: lab('pve3', { status: 'ok', reason: '', driver: 'i915' }), value: 1 },
      { metric: lab('pve4', { status: 'unsupported', reason: 'intel_gpu_top does not support this GPU or its driver', driver: 'xe' }), value: 1 },
    ]],
    ['hyperprox_intel_gpu_sample_timestamp_seconds', [{ metric: lab('pve'), value: now - 5 }, { metric: lab('pve3'), value: now - 600 }]],
  ])
  const prom = async (e: string) => { seen += `${e}\n`; return table(e) }
  const p = await readPanel(c, { pve: () => pve, prom, now: () => now * 1000 })
  assert.deepEqual(p.gpus.map(g => [g.node, g.state, g.load, g.stateNote]), [
    ['pve', 'measured', 12, null],
    ['pve2', 'unsupported', null, 'not supported on this GPU'],
    ['pve3', 'stale', null, 'figures stopped arriving'],
    ['pve4', 'unsupported', null, 'not supported on this GPU'],
  ])
  assert.equal(p.gpus[0].powerW, 2.5)
  assert.ok(seen.split('\n').filter(Boolean).every(e => e.includes(`hpx_cluster="${id}"`)), 'every query is limited to this cluster')
  assert.match(p.gpuNote!, /Load: measured on 1 of 4 GPUs\./)
  assert.ok(!/set up monitoring/.test(p.gpuNote!), 'nothing here is simply not set up')
})

test('PCI addresses line up with the GPUs; a BMC, audio device or bad id never shifts them', () => {
  const g = gpusWithSlots([PCI.bmc, PCI.audio, PCI.gtxA, PCI.hd630, { ...PCI.vega, id: 'junk' }])
  assert.deepEqual(g.map(x => [x.vendor, x.pci]), [['nvidia', '0000:0a:00.0'], ['intel', '0000:00:02.0'], ['amd', null]])
  assert.deepEqual(gpusWithSlots(null as any), [])
})

test('short names', () => {
  assert.equal(shortGpuName('NVIDIA GeForce GTX 1070 Ti'), 'GTX 1070 Ti')
  assert.equal(shortGpuName('Intel HD Graphics 630'), 'HD Graphics 630')
  assert.equal(shortGpuName('AMD Radeon Vega Series / Radeon Vega Mobile Series'), 'Vega Series')
  assert.equal(shortGpuName('AMD Radeon RX 580'), 'RX 580')
  assert.ok(shortGpuName('Intel Some Extremely Long Graphics Controller Name Gen 12').length <= 28)
})

test('HEVC in one line: checked or estimated, said so', () => {
  const est = (vendor: string, name: string) => gpuCapability({ vendor, kind: 'integrated', id: 'x', name } as any).short
  assert.equal(est('intel', 'Intel HD Graphics 630'), 'HEVC decode: likely yes (estimate)')
  assert.equal(est('intel', 'Intel UHD Graphics 630'), 'HEVC decode: likely yes (estimate)')
  assert.equal(est('intel', 'Intel HD Graphics 530'), 'HEVC decode: likely yes (estimate)')
  assert.equal(est('intel', 'Intel HD Graphics 4600'), 'HEVC decode: likely no (estimate)')
  assert.equal(est('intel', 'Intel Iris Xe Graphics'), 'HEVC decode: likely yes (estimate)')
  assert.equal(est('intel', 'Intel Mystery Graphics'), 'HEVC decode: unknown (estimate)')
  assert.equal(est('nvidia', 'NVIDIA GeForce GTX 1070 Ti'), 'HEVC decode: likely yes (estimate)')
  assert.equal(est('amd', 'AMD Radeon R9 380'), 'HEVC decode: likely no (estimate)')
  assert.equal(hevcLine('vainfo', ['H.264', 'HEVC']), 'HEVC decode: yes (checked)')
  assert.equal(hevcLine('vainfo', ['H.264']), 'HEVC decode: no (checked)')
  // The long sentence is still there for the expanded view.
  assert.match(gpuCapability({ vendor: 'intel', kind: 'integrated', id: 'x', name: 'Intel HD Graphics 630' } as any).summary, /7th generation or later.*an estimate from the model/)
})

test('the panel note and the scan note are short, and say measured or estimated and what improves it', () => {
  const g = (state: any, capabilitySource: any = 'estimate') => ({ state, capabilitySource } as any)
  assert.equal(gpuNote([], 'home'), null)
  assert.equal(gpuNote([g('measured', 'vainfo')], 'home'), 'Load: measured on every GPU. HEVC lines were checked with vainfo.')
  assert.match(gpuNote([g('measured'), g('not-monitored')], 'remote')!, /measured on 1 of 2 GPUs \(set up monitoring in Edit server, step 5 for the rest\)/)
  const n = (node: string, vainfo: string, checkedWith: string) => ({ node, vainfo, gpus: [{ checkedWith }] } as any)
  assert.equal(scanNote([n('node1', 'no-login', 'estimate')], false), 'Video support: estimated from the model name for 1 GPU. To check it: press Full scan (it uses the saved node login and runs vainfo, read-only). GPU load is measured by monitoring, not by a scan.')
  assert.match(scanNote([n('node1', 'checked', 'vainfo'), n('node2', 'not-installed', 'estimate')], true)!, /checked with vainfo on 1 GPU, estimated from the model name on 1\. To check the rest: install the vainfo package on node2/)
  assert.equal(scanNote([{ node: 'x', gpus: [] } as any], true), null)
  for (const s of [gpuNote([g('measured'), g('not-monitored')], 'home')!, scanNote([n('node1', 'not-installed', 'estimate')], true)!]) assert.ok(s.length < 260, s)
})

// ── The row as the browser draws it (apps/frontend/lib/gpu-rows.ts) ──────────────────────────────────────────

const row = (o: Partial<Parameters<typeof gpuRowLabel>[0]> = {}) => ({
  node: 'node2', name: 'Intel HD Graphics 630', shortName: 'HD Graphics 630', vendor: 'intel', pci: '0000:00:02.0',
  load: null, vramUsed: null, vramTotal: null, memory: 'shared' as const, tempC: null, fanPct: null, freqMHz: null, powerW: null,
  state: 'not-monitored' as const, stateNote: 'not monitored', setupHref: '/settings/setup-checklist',
  capability: 'Intel 7th generation or later (Quick Sync): ... (an estimate from the model; ...).', capabilityShort: 'HEVC decode: likely yes (estimate)', ...o,
})

test('row: node first, short name, one line; not monitored links to setup; never "no data"', () => {
  const r = row()
  assert.equal(gpuRowLabel(r), 'node2 · HD Graphics 630')
  assert.equal(gpuRowTitle(r), 'node2: Intel HD Graphics 630 (0000:00:02.0)')
  assert.equal(gpuRowRight(r), '—')
  assert.equal(gpuRowPct(r), null)
  assert.equal(gpuRowDetail(r), 'shared memory · HEVC decode: likely yes (estimate)')
  assert.deepEqual(gpuRowAction(r), { words: 'not monitored · set up monitoring', href: '/settings/setup-checklist' })
  for (const s of [gpuRowLabel(r), gpuRowRight(r), gpuRowDetail(r), gpuRowAction(r)!.words]) assert.ok(!/no data/i.test(s))
})

test('row: measured, dedicated memory, temperature, clock and power; unsupported and stale say why without a link', () => {
  const m = row({ node: 'node5', name: 'NVIDIA GeForce GTX 1070 Ti', shortName: 'GTX 1070 Ti', vendor: 'nvidia', memory: 'dedicated', state: 'measured', load: 41.6, vramUsed: 2 ** 30, vramTotal: 8 * 2 ** 30, tempC: 55.4, fanPct: 30, stateNote: null, setupHref: null })
  assert.equal(gpuRowRight(m), '42%')
  assert.equal(gpuRowDetail(m), '1.0 GB / 8.0 GB VRAM · 55 °C · fan 30% · HEVC decode: likely yes (estimate)')
  assert.equal(gpuRowAction(m), null)
  const i = row({ state: 'measured', load: 12, freqMHz: 650.4, powerW: 2.54, stateNote: null, setupHref: null })
  assert.equal(gpuRowDetail(i), 'shared memory · 650 MHz · 2.5 W · HEVC decode: likely yes (estimate)')
  assert.deepEqual(gpuRowAction(row({ state: 'unsupported', stateNote: 'not supported on this GPU', setupHref: null })), { words: 'not supported on this GPU', href: null })
  assert.deepEqual(gpuRowAction(row({ state: 'stale', stateNote: null, setupHref: null })), { words: 'figures stopped arriving', href: null })
  assert.equal(gpuRowDetail(row({ memory: 'dedicated', vendor: 'amd' })), 'VRAM not reported · HEVC decode: likely yes (estimate)')
})

test('row: an older API without the new fields still reads sensibly', () => {
  const old = { node: 'node1', name: 'AMD Picasso/Raven 2 [Radeon Vega Series / Radeon Vega Mobile Series]', vendor: 'amd', load: 7, vramUsed: null, vramTotal: null, tempC: null, fanPct: null, capability: 'AMD, newer generation: H.264 and HEVC, decode and encode (an estimate from the model; ...).' }
  assert.equal(gpuShortName(old), 'Radeon Vega Series')
  assert.equal(gpuRowRight(old), '7%')
  assert.equal(capabilityShortFrom(old.capability), 'HEVC decode: likely yes (estimate)')
  assert.equal(capabilityShortFrom('AMD: decodes MPEG-2, H.264; encodes H.264 (checked with vainfo on that server).'), 'HEVC decode: no (checked)')
  assert.deepEqual(gpuRowAction({ ...old, load: null }), { words: 'not monitored · set up monitoring', href: null })
})
