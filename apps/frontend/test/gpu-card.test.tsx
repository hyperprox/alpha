// The dashboard's GPU card: every GPU says which node it is in, the guests that use it, and built-in GPUs show
// live figures (Intel engines, clock and power; AMD busy, VRAM, GTT, temperature) or a dash with a reason.
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/*.test.tsx
import './css-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { GPUPanel, GpuRow, type GPUInfoFull } from '../components/dashboard/GpuCard'
import { guestsLine, primaryNvidia, sizeShort, hasFigures, whereLine, type NodeGPUStatus, type GpuLiveFigures } from '../lib/gpu-card'

const blank: GpuLiveFigures = { kind: 'intel', busy: null, engines: null, freqMHz: null, powerW: null, vramUsed: null, vramTotal: null, gttUsed: null, gttTotal: null, tempC: null, note: null }
const intel: GpuLiveFigures = { ...blank, busy: 62, engines: { render: 37, video: 62, enhance: 5 }, freqMHz: 950, powerW: 3.8 }
const amd: GpuLiveFigures = { ...blank, kind: 'amd', busy: 21, vramUsed: 19742720, vramTotal: 3221225472, gttUsed: 12832768, gttTotal: 6768021504, tempC: 79 }

const NV: GPUInfoFull = {
  name: 'NVIDIA GeForce GTX 1070 Ti', vram_total: 8192, vram_used: 2048, vram_free: 6144, gpu_util: 18, temp: 47, power_draw: 40, power_limit: 180, vram_pct: 25, power_pct: 22,
  consumers: [{ pid: 7, vram_mb: 1024, process: 'Plex', ct_id: '101', ct_name: 'media', vram_pct: 12 }],
}
const status = (over: Partial<Record<string, any>> = {}): NodeGPUStatus[] => [
  { node: 'node-c', reachable: true, port: 9835, install: null, gpus: [{ type: 'nvidia', vendorName: 'NVIDIA', deviceName: 'NVIDIA GeForce GTX 1070 Ti', dedicated: true, live: { ...blank, kind: 'nvidia', busy: 18 },
    guests: [{ vmid: 101, name: 'media', type: 'lxc', status: 'running' }, { vmid: 301, name: 'cuda-vm', type: 'qemu', status: 'stopped' }] }] },
  { node: 'node-a', reachable: true, port: 8081, install: null, gpus: [{ type: 'intel-igpu', vendorName: 'Intel', deviceName: 'Intel HD Graphics 630', dedicated: false, live: intel, guests: [{ vmid: 102, name: 'encoder', type: 'lxc', status: 'running' }], ...over.a }] },
  { node: 'node-b', reachable: true, port: 9100, install: null, gpus: [{ type: 'amd', vendorName: 'AMD', deviceName: 'AMD Radeon Vega Mobile Series', dedicated: false, live: amd, guests: [], ...over.b }] },
]

test('the discrete card says which node it is in, and which guests use it', () => {
  const html = renderToStaticMarkup(<GPUPanel gpu={NV} gpuStatus={status()}/>)
  assert.match(html, /GeForce GTX 1070 Ti/)
  assert.match(html, /data-gpu-node="node-c"/)
  assert.match(html, /in node-c/)
  assert.match(html, /Used by: media \(CT 101\), cuda-vm \(VM 301\) - stopped/)
  // The dials and per-process VRAM are unchanged
  assert.match(html, /Load/); assert.match(html, /limit 180W/); assert.match(html, /media/)
  // and the card is not repeated as a row below it
  assert.equal((html.match(/data-gpu-row="node-c"/g) ?? []).length, 0)
})

test('an Intel built-in GPU shows its node, busy, the three engines, clock and power', () => {
  const html = renderToStaticMarkup(<GPUPanel gpu={NV} gpuStatus={status()}/>)
  assert.match(html, /data-gpu-row="node-a"/)
  assert.match(html, /HD Graphics 630/)
  assert.match(html, /data-metrics="intel"/)
  assert.match(html, />62%</)
  assert.match(html, />37%</); assert.match(html, />5%</)
  assert.match(html, />950 MHz</); assert.match(html, />3\.8 W</)
  assert.match(html, /Used by: encoder \(CT 102\)/)
  assert.doesNotMatch(html.split('data-gpu-row="node-a"')[1].split('data-gpu-row="node-b"')[0], /monitored/)
})

test('an AMD built-in GPU shows busy, VRAM, GTT and temperature; missing power is a dash with a reason', () => {
  const html = renderToStaticMarkup(<GPUPanel gpu={NV} gpuStatus={status()}/>)
  const row = html.split('data-gpu-row="node-b"')[1]
  assert.match(row, /data-metrics="amd"/)
  assert.match(row, />21%</)
  assert.match(row, /19 MB \/ 3\.0 GB/)
  assert.match(row, /12 MB \/ 6\.3 GB/)
  assert.match(row, />79°C</)
  assert.match(row, /data-missing="true"[^>]*>|title="[^"]*not being reported[^"]*"/)
  assert.match(row, />—</)
})

test('a missing Intel clock is a dash with a plain tooltip, not a dial', () => {
  const html = renderToStaticMarkup(<GpuRow node="node-a" reachable g={{ type: 'intel-igpu', vendorName: 'Intel', deviceName: 'Intel HD Graphics 630', dedicated: false, live: { ...intel, freqMHz: null } }}/>)
  assert.match(html, /title="The clock speed is not being reported for this GPU\./)
  assert.doesNotMatch(html, /<svg[^>]*role="meter"/)
})

test('no figures at all: a dash, the reason, and "monitored" only as a small status', () => {
  const html = renderToStaticMarkup(<GpuRow node="node-a" reachable g={{ type: 'intel-igpu', vendorName: 'Intel', deviceName: 'Intel HD Graphics 630', dedicated: false, live: { ...blank, note: 'intel_gpu_top could not open the device' } }}/>)
  assert.match(html, /monitored/)
  assert.match(html, /intel_gpu_top could not open the device/)
  assert.doesNotMatch(html, /data-metrics/)
  const old = renderToStaticMarkup(<GpuRow node="node-a" reachable g={{ type: 'intel-igpu', vendorName: 'Intel', deviceName: 'Intel HD Graphics 630', dedicated: false }}/>)
  assert.match(old, /monitored/)
})

test('an unmonitored GPU still says where it is and links to setup', () => {
  const html = renderToStaticMarkup(<GpuRow node="node-d" reachable={false} g={{ type: 'amd', vendorName: 'AMD', deviceName: 'AMD Radeon Vega', dedicated: false }}/>)
  assert.match(html, /node-d/)
  assert.match(html, /not monitored · set up/)
})

test('without NVIDIA telemetry the built-in GPUs still show their figures, node first', () => {
  const html = renderToStaticMarkup(<GPUPanel gpu={null} gpuStatus={status().slice(1)}/>)
  assert.match(html, /ACTIVE/)
  assert.ok(html.indexOf('node-a') < html.indexOf('HD Graphics 630'))
  assert.match(html, /data-metrics="intel"/); assert.match(html, /data-metrics="amd"/)
})

test('no GPU at all', () => {
  assert.match(renderToStaticMarkup(<GPUPanel gpu={null} gpuStatus={[]}/>), /No GPU detected/)
})

test('helpers', () => {
  assert.equal(whereLine('node-b'), 'in node-b')
  assert.equal(guestsLine([]), null)
  assert.equal(guestsLine(undefined), null)
  assert.match(guestsLine(Array.from({ length: 8 }, (_, i) => ({ vmid: 100 + i, name: `g${i}`, type: 'lxc' as const, status: 'running' })))!, /and 2 more$/)
  assert.deepEqual(primaryNvidia(status(), 'NVIDIA GeForce GTX 1070 Ti'), { node: 'node-c', index: 0 })
  assert.equal(primaryNvidia(status().slice(1), 'x'), null)
  assert.equal(sizeShort(null), '—'); assert.equal(sizeShort(5 * 1024 ** 2), '5 MB')
  assert.equal(hasFigures(blank), false); assert.equal(hasFigures(intel), true)
})
