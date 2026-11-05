// Follow-up: Portable GPU refresh without a node login every minute, viewer reads that never write, the old-key
// migration only on admin actions or at start-up, and marker stripping that leaves no stray space.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeService, smallCt, OWNER, FIX } from './fakes/guest-pve'
import { withoutMarker, withMarker, PORTABLE_REFRESH_MS } from '../src/lib/guest-config/service'
import { emptyGpuState } from '../src/lib/guest-config/history/store'

const ID = '11111111-2222-3333-4444-555555555555'

test('Portable GPU: a refresh from cache never logs in to a node; a full refresh does, every 15 minutes', async () => {
  assert.equal(PORTABLE_REFRESH_MS, 15 * 60_000)
  const s = makeService()
  s.shell.probes['node-a'] = FIX('probe-nvidia.txt'); s.shell.probes['node-b'] = FIX('probe-igpu.txt')
  s.pve.add({ node: 'node-b', type: 'lxc', vmid: 961, status: 'running', ha: 'started', config: smallCt({ hostname: 'media', lxc: [
    ['lxc.mount.entry', '/dev/dri/renderD128 dev/dri/renderD128 none bind,optional,create=file'],
    ['lxc.mount.entry', '/dev/nvidia0 dev/nvidia0 none bind,optional,create=file'],
  ] }) })
  await s.service.refreshPortability({ probe: true })
  const after = s.shell.commands.length
  assert.ok(after > 0, 'the full refresh read the nodes')
  assert.equal((s.service.portabilityOf('ct:961') as any).portable, true)
  s.tick(5 * 60_000)   // the inventory cache is stale now, but a cached refresh still does not log in
  await s.service.refreshPortability({ probe: false })
  assert.equal(s.shell.commands.length, after)
  assert.equal((s.service.portabilityOf('ct:961') as any).perNode['node-b'], 'Intel HD Graphics 630')
})

test('a viewer read never writes: no old-key migration from view() or the GPU detail', async () => {
  const s = makeService()
  s.pve.add({ node: 'node-b', type: 'lxc', vmid: 941, status: 'stopped', config: smallCt({ hostname: 'tv', description: withMarker('', ID) }) })
  await s.history.setGpu({ ...emptyGpuState('lxc/941/0123456789abcdef'), dev: { dev0: '/dev/dri/renderD128' } })
  let writes = 0
  const orig = { set: s.history.setGpu.bind(s.history), upd: s.history.updateGpu.bind(s.history), adopt: s.history.adoptLegacyGpu.bind(s.history) }
  s.history.setGpu = async x => { writes++; return orig.set(x) }
  s.history.updateGpu = async (k, f) => { writes++; return orig.upd(k, f) }
  s.history.adoptLegacyGpu = async (...a) => { writes++; return orig.adopt(...a) }
  const G = { node: 'node-b', type: 'lxc' as const, vmid: 941 }
  await s.service.view(G, { cachedOnly: true })
  await s.service.gpuDetail(G, { cachedOnly: true })
  await s.service.overview()
  assert.equal(writes, 0)
  // An admin action migrates it.
  await s.service.preview(OWNER, G, { kind: 'gpu-off' })
  assert.ok(writes > 0)
  assert.deepEqual((await s.service.view(G)).gpu.managed, { dev0: '/dev/dri/renderD128' })
})

test('the old-key migration also runs once at start-up, for every marked guest', async () => {
  const s = makeService()
  s.pve.add({ node: 'node-b', type: 'lxc', vmid: 941, status: 'stopped', config: smallCt({ hostname: 'tv', description: withMarker('TV', ID) }) })
  s.pve.add({ node: 'node-b', type: 'lxc', vmid: 942, status: 'stopped', config: smallCt({ hostname: 'other' }) })
  await s.history.setGpu({ ...emptyGpuState('lxc/941'), dev: { dev0: '/dev/dri/renderD128' } })
  await s.history.setGpu({ ...emptyGpuState('lxc/942'), dev: { dev0: '/dev/dri/card0' } })
  assert.equal(await s.service.migrateLegacyGpuState(), 1)
  const keys = (await s.history.listGpu()).map(x => x.guest).sort()
  assert.deepEqual(keys, [`lxc/941/${ID}`, 'lxc/942'], 'an unmarked guest keeps its old row until it is marked')
  assert.equal(await s.service.migrateLegacyGpuState(), 0, 'once')
})

test('stripping the marker leaves no trailing space, on its own line or not', () => {
  assert.equal(withoutMarker(`Media box\n<!-- hpx-id:${ID} -->`), 'Media box')
  assert.equal(withoutMarker(`Media box <!-- hpx-id:${ID} -->`), 'Media box')
  assert.equal(withoutMarker(`Media box\t<!-- hpx-id:${ID} -->\nSecond line`), 'Media box\nSecond line')
  assert.equal(withoutMarker(`<!-- hpx-id:${ID} -->`), '')
  assert.equal(withMarker(`Media box <!-- hpx-id:${ID} -->`, ID), `Media box\n<!-- hpx-id:${ID} -->`)
})

test('an edit of a description whose marker shared a line keeps the marker and leaves no stray space', async () => {
  const { markerOf } = await import('../src/lib/guest-config/service')
  const s = makeService()
  s.pve.add({ node: 'node-b', type: 'lxc', vmid: 941, status: 'stopped', config: smallCt({ hostname: 'tv', description: `TV <!-- hpx-id:${ID} -->` }) })
  const G = { node: 'node-b', type: 'lxc' as const, vmid: 941 }
  assert.equal((await s.service.view(G)).config.description, 'TV')
  await s.service.apply(OWNER, (await s.service.preview(OWNER, G, { kind: 'edit', edit: { description: 'Living-room TV' } })).id)
  assert.equal(s.pve.g('lxc', 941).config.description, `Living-room TV\n<!-- hpx-id:${ID} -->`)
  assert.equal(markerOf(s.pve.g('lxc', 941).config), ID)
})
