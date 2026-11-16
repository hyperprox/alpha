// The GPU card's figures: each GPU gets its node, its guests and live numbers from Prometheus.
// A recorded Prometheus (test/fixtures/gpu-live-prom.json) and a pretend Proxmox; no network.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readGpuLive, gpuGuests, withLiveAndGuests, withNodeFromAddress, _resetGpuGuestCache } from '../src/lib/gpu-live'
import type { PromQuery } from '../src/lib/clusters/overview'

const FIX = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'gpu-live-prom.json'), 'utf8'))
const toRows = (result: any[]) => result.map(r => ({ metric: r.metric as Record<string, string>, value: Number(r.value[1]) }))

/** Answers each query from the first recorded answer whose pattern the expression matches; anything else is empty. */
function recorded(answers: any[] = FIX.answers, calls: string[] = []): PromQuery {
  return async expr => {
    calls.push(expr)
    const hit = answers.find((a: any) => new RegExp(a.has).test(expr))
    return hit ? toRows(hit.result) : []
  }
}

beforeEach(() => _resetGpuGuestCache())

test('Intel: busiest engine overall, the three engine kinds, clock and power', async () => {
  const [g] = (await readGpuLive(recorded())).intel('node-a')
  assert.equal(g.kind, 'intel')
  assert.equal(g.busy, 62)
  assert.deepEqual(g.engines, { render: 37, video: 62, enhance: 5 })
  assert.equal(g.freqMHz, 950)
  assert.equal(g.powerW, 3.8)
  assert.equal(g.note, null)
})

test('AMD: busy, VRAM and GTT used and size, temperature; power is empty when the chip does not publish it', async () => {
  const [g] = (await readGpuLive(recorded())).amd('node-b')
  assert.equal(g.kind, 'amd')
  assert.equal(g.busy, 21)
  assert.equal(g.vramUsed, 19742720)
  assert.equal(g.vramTotal, 3221225472)
  assert.equal(g.gttUsed, 12832768)
  assert.equal(g.gttTotal, 6768021504)
  assert.equal(g.tempC, 79)
  assert.equal(g.powerW, null)
})

test('NVIDIA: load as a percentage, VRAM and temperature', async () => {
  const [g] = (await readGpuLive(recorded())).nvidia('node-c')
  assert.equal(g.busy, 18)
  assert.equal(g.vramTotal, 8589934592)
  assert.equal(g.tempC, 47)
})

test('a node with no series of its own has no figures: the answer is empty, never another node\'s', async () => {
  const live = await readGpuLive(recorded())
  assert.deepEqual(live.intel('node-b'), [])
  assert.deepEqual(live.amd('node-a'), [])
  assert.deepEqual(live.nvidia('node-a'), [])
})

test('Prometheus down: no figures and no throw', async () => {
  const live = await readGpuLive(async () => { throw new Error('connection refused') })
  assert.deepEqual(live.intel('node-a'), [])
  assert.deepEqual(live.amd('node-b'), [])
})

test('Intel exporter reachable but answering nothing: a GPU with empty figures and a plain reason', async () => {
  const onlyInfo = [{ has: 'hyperprox_intel_gpu_info', result: [{ metric: { node: 'node-a', pci: '0000:00:02.0', status: 'error', reason: 'intel_gpu_top could not open the device' }, value: [1, '1'] }] }]
  const [g] = (await readGpuLive(recorded(onlyInfo))).intel('node-a')
  assert.equal(g.busy, null)
  assert.equal(g.freqMHz, null)
  assert.equal(g.note, 'intel_gpu_top could not open the device')
})

test('a series with no node label is tied to its node by the address in instance', async () => {
  const addrs = { '192.0.2.11': 'node-a' }
  const live = await readGpuLive(withNodeFromAddress(recorded([FIX.unlabelled]), addrs))
  assert.equal(live.intel('node-a')[0]?.busy, 9)
  const none = await readGpuLive(withNodeFromAddress(recorded([FIX.unlabelled]), {}))
  assert.deepEqual(none.intel('node-a'), [])
})

// ── guests ──────────────────────────────────────────────────────────────────

function fakePve(configs: Record<string, Record<string, unknown> | null>) {
  const res = [
    { type: 'lxc', vmid: 101, name: 'transcoder', node: 'node-a', status: 'running' },
    { type: 'lxc', vmid: 102, name: 'media', node: 'node-a', status: 'stopped' },
    { type: 'lxc', vmid: 103, name: 'plain', node: 'node-a', status: 'running' },
    { type: 'qemu', vmid: 301, name: 'cuda-vm', node: 'node-c', status: 'running' },
    { type: 'lxc', vmid: 302, name: 'encoder', node: 'node-c', status: 'running' },
    { type: 'lxc', vmid: 900, name: 'elsewhere', node: 'node-z', status: 'running' },
    { type: 'storage', id: 'storage/node-a/local', node: 'node-a' },
  ]
  const asked: string[] = []
  return {
    asked,
    async fetchNode(path: string): Promise<any> {
      asked.push(path)
      if (path === '/cluster/resources') return res
      const cfg = configs[path]
      if (cfg === null) throw new Error('refused')
      return cfg ?? {}
    },
  }
}
const CONFIGS = {
  '/nodes/node-a/lxc/101/config': { dev0: '/dev/dri/renderD128,gid=44' },
  '/nodes/node-a/lxc/102/config': { lxc: ['lxc.cgroup2.devices.allow: c 226:* rwm'], dev1: '/dev/dri/card0' },
  '/nodes/node-a/lxc/103/config': { cores: 2 },
  '/nodes/node-c/qemu/301/config': { hostpci0: '0000:0a:00,pcie=1' },
  '/nodes/node-c/lxc/302/config': { dev0: '/dev/nvidia0' },
}

test('guests: /dev/dri containers belong to the built-in graphics, passthrough and NVIDIA devices to the discrete card', async () => {
  const pve = fakePve(CONFIGS)
  const g = await gpuGuests(pve, ['node-a', 'node-c'])
  assert.deepEqual(g['node-a'].integrated.map(x => x.vmid), [101, 102])
  assert.deepEqual(g['node-a'].integrated[1], { vmid: 102, name: 'media', type: 'lxc', status: 'stopped' })
  assert.deepEqual(g['node-a'].discrete, [])
  assert.deepEqual(g['node-c'].discrete.map(x => x.vmid), [301, 302])
  assert.ok(!pve.asked.some(p => p.includes('node-z')), 'only the nodes that have a GPU are asked about')
})

test('guests: a config that cannot be read leaves that guest out, not the card; answers are kept for a minute', async () => {
  const pve = fakePve({ ...CONFIGS, '/nodes/node-a/lxc/101/config': null })
  const g = await gpuGuests(pve, ['node-a'], 1000)
  assert.deepEqual(g['node-a'].integrated.map(x => x.vmid), [102])
  const n = pve.asked.length
  await gpuGuests(pve, ['node-a'], 30_000)
  assert.equal(pve.asked.length, n, 'a second look inside a minute is served from memory')
  await gpuGuests(pve, ['node-a'], 90_000)
  assert.ok(pve.asked.length > n)
})

test('guests: Proxmox not answering gives empty lists', async () => {
  const g = await gpuGuests({ fetchNode: async () => { throw new Error('down') } } as any, ['node-a'])
  assert.deepEqual(g['node-a'], { discrete: [], integrated: [] })
})

test('each GPU carries its figures and the guests of its own kind', async () => {
  const live = await readGpuLive(recorded())
  const guests = await gpuGuests(fakePve(CONFIGS), ['node-a', 'node-b', 'node-c'])
  const gpus = [
    { node: 'node-a', type: 'intel-igpu', dedicated: false },
    { node: 'node-b', type: 'amd', dedicated: false },
    { node: 'node-c', type: 'nvidia', dedicated: true },
  ]
  const [a, b, c] = withLiveAndGuests(gpus, live, guests)
  assert.equal(a.live?.busy, 62)
  assert.deepEqual(a.guests.map(x => x.vmid), [101, 102])
  assert.equal(b.live?.vramTotal, 3221225472)
  assert.deepEqual(b.guests, [])
  assert.equal(c.live?.busy, 18)
  assert.deepEqual(c.guests.map(x => x.vmid), [301, 302])
  const off = withLiveAndGuests(gpus, null, null)
  assert.equal(off[0].live, null)
  assert.deepEqual(off[0].guests, [])
})
