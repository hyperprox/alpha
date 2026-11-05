// HA insight on fixtures: "where would it go", homeless and hardware-bound guests, keep-apart headroom,
// the guest status line, and the migration preflight grid.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readSnapshot } from '../src/lib/ha/read'
import { predictFailover, moveNow } from '../src/lib/ha/predict'
import { overview, guestView, headroom, badges, clusterWords } from '../src/lib/ha/insight'
import { preflightGrid } from '../src/lib/ha/preflight'
import { hardwareOf, parseCrs } from '../src/lib/ha/parse'
import { setGpuPortability } from '../src/lib/ha/gpu'
import { threeNodes, lxcGpuConfig, lxcBindConfig } from './ha-fake'

test('no home: fails over to the node with the fewest HA guests (basic CRS), and says it stays there', async () => {
  const f = threeNodes()
  f.addResource('ct:901'); f.addResource('ct:902')
  const snap = await readSnapshot(f)
  const p = predictFailover(snap, 'ct:901')
  assert.equal(p.from, 'node-a')
  assert.equal(p.to, 'node-c', 'node-b already holds an HA guest')
  assert.match(p.words, /If node-a fails it will move to node-c, and stay there: it has no home/)
})

test('preferred home with a second choice: the second choice wins when the first is the one failing', async () => {
  const f = threeNodes()
  f.addResource('ct:901')
  f.addRule({ rule: 'h', type: 'node-affinity', resources: 'ct:901', nodes: 'node-a:2,node-c:1' })
  const p = predictFailover(await readSnapshot(f), 'ct:901')
  assert.equal(p.to, 'node-c')
  assert.doesNotMatch(p.words, /no home/)
})

test('strict home on one node: stays off when that node fails', async () => {
  const f = threeNodes()
  f.addResource('ct:901')
  f.addRule({ rule: 'h', type: 'node-affinity', resources: 'ct:901', nodes: 'node-a', strict: 1 })
  const p = predictFailover(await readSnapshot(f), 'ct:901')
  assert.equal(p.to, null)
  assert.match(p.words, /stays off until node-a is back/)
})

test('non-strict home whose nodes are all down: falls back to any other node', async () => {
  const f = threeNodes()
  f.nodes.find(n => n.node === 'node-b')!.status = 'offline'
  f.addResource('ct:901')
  f.addRule({ rule: 'h', type: 'node-affinity', resources: 'ct:901', nodes: 'node-a:2,node-b:1' })
  assert.equal(predictFailover(await readSnapshot(f), 'ct:901').to, 'node-c')
})

test('kept apart: never onto a node a partner runs on; kept together: onto the partner\'s node', async () => {
  const f = threeNodes()
  f.addResource('ct:901'); f.addResource('ct:902')
  f.addRule({ rule: 'apart', type: 'resource-affinity', affinity: 'negative', resources: 'ct:901,ct:902' })
  f.crs = 'ha=basic'
  let p = predictFailover(await readSnapshot(f), 'ct:901')
  assert.equal(p.to, 'node-c', 'node-b has its partner')
  f.rules = []
  f.addRule({ rule: 'tog', type: 'resource-affinity', affinity: 'positive', resources: 'ct:901,ct:902' })
  p = predictFailover(await readSnapshot(f), 'ct:901')
  assert.equal(p.to, 'node-b')
})

test('maintenance: a node in maintenance is never a target', async () => {
  const f = threeNodes()
  f.nodes.find(n => n.node === 'node-c')!.maintenance = true
  f.addResource('ct:901'); f.addResource('ct:902')
  assert.equal(predictFailover(await readSnapshot(f), 'ct:901').to, 'node-b')
})

test('moveNow: a new first choice elsewhere means it migrates now (failback); failback off means it stays', async () => {
  const f = threeNodes()
  f.addResource('ct:901')
  const snap = await readSnapshot(f)
  const rules = [{ id: 'h', type: 'node-affinity', affinity: 'positive', strict: false, nodes: [{ node: 'node-b', priority: 0 }], resources: ['ct:901'], disabled: false } as const]
  assert.equal(moveNow(snap, 'ct:901', rules as any)?.to, 'node-b')
  snap.resources[0].failback = false
  assert.equal(moveNow(snap, 'ct:901', rules as any), null)
})

test('hardware: NVIDIA lxc lines, bind mounts, node-local volumes and VM PCI devices are found', () => {
  const gpu = hardwareOf('lxc', lxcGpuConfig, ['shared-rbd'])
  assert.ok(gpu.devices.some(d => d.what === 'an NVIDIA GPU'))
  const bind = hardwareOf('lxc', lxcBindConfig, ['shared-rbd'])
  assert.deepEqual(bind.bindMounts.map(b => b.path), ['/mnt/media'])
  const shared = hardwareOf('lxc', { rootfs: 'shared-rbd:x', mp0: '/mnt/media,mp=/m,shared=1' }, ['shared-rbd'])
  assert.equal(shared.bindMounts.length, 0); assert.equal(shared.sharedMounts.length, 1)
  assert.equal(hardwareOf('lxc', { rootfs: 'local-lvm:vm-1' }, ['shared-rbd']).localVolumes.length, 1)
  assert.ok(hardwareOf('qemu', { hostpci0: '0000:01:00,pcie=1', scsi0: 'shared-rbd:x' }, ['shared-rbd']).devices.length === 1)
})

test('overview: protected, not protected, homeless, and GPU guests without a home on their GPU node', async () => {
  const f = threeNodes()
  f.addResource('ct:901'); f.addResource('ct:903')
  f.addRule({ rule: 'h901', type: 'node-affinity', resources: 'ct:901', nodes: 'node-a' })
  const ov = overview(await readSnapshot(f))
  assert.equal(ov.counts.protected, 2)
  assert.equal(ov.counts.unprotected, 3)
  assert.deepEqual(ov.homeless.map(h => h.sid), ['ct:903'])
  assert.deepEqual(ov.hardware.map(h => h.sid), ['ct:903'])
  assert.match(ov.hardware[0].words, /needs node-c's hardware \(an NVIDIA GPU\) but has no home/)
  assert.match(ov.unprotected.find(u => u.sid === 'ct:902')!.words, /Stays down after a failure of node-b/)
  // A home that puts another node first is still a hardware warning.
  f.addRule({ rule: 'h903', type: 'node-affinity', resources: 'ct:903', nodes: 'node-a:2,node-c:1' })
  const ov2 = overview(await readSnapshot(f))
  assert.equal(ov2.homeless.length, 0)
  assert.match(ov2.hardware[0].words, /its home puts node-a first/)
  // Home on its GPU node: no warning.
  f.rules = f.rules.filter(r => r.rule !== 'h903')
  f.addRule({ rule: 'h903', type: 'node-affinity', resources: 'ct:903', nodes: 'node-c', strict: 1 })
  assert.equal(overview(await readSnapshot(f)).hardware.length, 0)
})

test('headroom: N guests kept apart across N eligible nodes is zero slack', async () => {
  const f = threeNodes()
  for (const s of ['ct:901', 'ct:902', 'ct:903']) f.addResource(s)
  f.addRule({ rule: 'apart', type: 'resource-affinity', affinity: 'negative', resources: 'ct:901,ct:902,ct:903' })
  const h = headroom(await readSnapshot(f))[0]
  assert.equal(h.slack, 0); assert.equal(h.level, 'none')
  assert.match(h.words, /Lose one node and one guest has nowhere legal to start/)
  f.rules[0].resources = 'ct:901,ct:902'
  assert.equal(headroom(await readSnapshot(f))[0].level, 'tight')
  // Strict homes shrink the eligible set.
  f.addRule({ rule: 'h1', type: 'node-affinity', resources: 'ct:901', nodes: 'node-a', strict: 1 })
  f.addRule({ rule: 'h2', type: 'node-affinity', resources: 'ct:902', nodes: 'node-b', strict: 1 })
  assert.equal(headroom(await readSnapshot(f))[0].level, 'none')
  f.nodes.find(n => n.node === 'node-b')!.status = 'offline'
  assert.equal(headroom(await readSnapshot(f))[0].level, 'broken')
})

test('status line and switch-off words', async () => {
  const f = threeNodes()
  let v = guestView(await readSnapshot(f), 'ct:901')!
  assert.match(v.statusLine, /Not protected: if node-a fails, this stays off until you start it/)
  f.addResource('ct:901')
  f.addRule({ rule: 'h', type: 'node-affinity', resources: 'ct:901', nodes: 'node-a:2,node-b:1' })
  v = guestView(await readSnapshot(f), 'ct:901')!
  assert.match(v.statusLine, /^Running on node-a — its home\. If node-a fails it will move to node-b\.$/)
})

test('cluster words: armed, disarmed, no quorum', async () => {
  const f = threeNodes()
  assert.match(clusterWords(await readSnapshot(f)).headline, /HA is armed: a node that loses contact .*\(fenced\) after about 2 minutes/)
  f.quorate = false
  assert.match(clusterWords(await readSnapshot(f)).headline, /lost quorum/)
})

test('badges: one record per guest', async () => {
  const f = threeNodes()
  f.addResource('ct:903')
  const b = badges(await readSnapshot(f))
  assert.equal(b['ct:903'].protected, true)
  assert.equal(b['ct:903'].home, 'none')
  assert.ok(b['ct:903'].warn)
  assert.equal(b['ct:901'].protected, false)
})

test('preflight grid: PVE blockers plus bind mounts, devices, storage and memory, in words', async () => {
  const f = threeNodes()
  f.addResource('ct:905')
  f.addRule({ rule: 'h', type: 'node-affinity', resources: 'ct:905', nodes: 'node-b:2,node-a:1' })
  f.nodes.find(n => n.node === 'node-c')!.mem = 31.5 * 1024 ** 3
  const snap = await readSnapshot(f)
  const g = snap.guests.find(x => x.sid === 'ct:905')!
  const pve = { 'allowed-nodes': [], 'not-allowed-nodes': { 'node-a': { 'blocking-ha-resources': [{ sid: 'ct:905', cause: 'node-affinity' }] }, 'node-c': { 'unavailable-storages': ['fast'] } }, running: 1 }
  const grid = preflightGrid(snap, g, pve, lxcBindConfig)
  const row = (n: string) => grid.rows.find(r => r.node === n)!
  assert.equal(row('node-b').current, true)
  assert.match(row('node-a').reasons.join(' '), /ranks node-a below its first choice/)
  assert.match(row('node-a').reasons.join(' '), /local bind mount \(\/mnt\/media\)/)
  assert.match(row('node-c').reasons.join(' '), /Missing storage: "fast"/)
  assert.match(row('node-c').reasons.join(' '), /Not enough memory/)
  assert.equal(grid.summary, 'It cannot move to any other node right now.')
  // A VM with a GPU: PVE's local_resources reported as a device.
  const vm = snap.guests.find(x => x.sid === 'vm:904')!
  const vgrid = preflightGrid(snap, vm, { allowed_nodes: ['node-b', 'node-c'], not_allowed_nodes: {}, local_resources: ['hostpci0'], running: 1 }, { hostpci0: '0000:01:00', scsi0: 'shared-rbd:x' })
  assert.match(vgrid.rows.find(r => r.node === 'node-b')!.reasons.join(' '), /local devices: a PCI device/)
})

test('CRS settings read in both spellings (/cluster/options returns an object)', () => {
  assert.deepEqual(parseCrs({ ha: 'dynamic', 'ha-auto-rebalance': 1, 'ha-rebalance-on-start': 1 }), { mode: 'dynamic', rebalanceOnStart: true, autoRebalance: true })
  assert.deepEqual(parseCrs('ha=static'), { mode: 'static', rebalanceOnStart: false, autoRebalance: false })
  assert.equal(parseCrs(undefined).mode, 'basic')
})

test('vCPUs: a VM is tried on its best node first; too few CPUs there means it moves on to the next', async () => {
  const f = threeNodes()
  f.nodes.find(n => n.node === 'node-b')!.maxcpu = 4
  f.nodes.find(n => n.node === 'node-c')!.maxcpu = 16
  f.guests.find(g => g.vmid === 904)!.maxcpu = 12
  f.addResource('vm:904'); f.addResource('ct:903')
  const p = predictFailover(await readSnapshot(f), 'vm:904')
  assert.equal(p.to, 'node-c')
  assert.deepEqual(p.tries, ['node-b', 'node-c'])
})

test('vCPUs: the migration grid says when a node has too few CPUs', async () => {
  const f = threeNodes()
  f.nodes.find(n => n.node === 'node-b')!.maxcpu = 4
  f.guests.find(g => g.vmid === 904)!.maxcpu = 12
  const snap = await readSnapshot(f)
  const vm = snap.guests.find(x => x.sid === 'vm:904')!
  const grid = preflightGrid(snap, vm, { allowed_nodes: ['node-b', 'node-c'], not_allowed_nodes: {}, running: 1 }, { scsi0: 'shared-rbd:x' })
  assert.match(grid.rows.find(r => r.node === 'node-b')!.reasons.join(' '), /Not enough CPUs: it has 12 vCPUs, node-b has 4/)
  assert.equal(grid.rows.find(r => r.node === 'node-c')!.allowed, false, 'node-c has 8')
})

test('hardware-bound guest with only a preferred home: an informational note, not a warning', async () => {
  const f = threeNodes()
  f.addResource('ct:903')
  f.addRule({ rule: 'h903', type: 'node-affinity', resources: 'ct:903', nodes: 'node-c' })
  const snap = await readSnapshot(f)
  const v = guestView(snap, 'ct:903')!
  assert.equal(v.warnings.length, 0)
  assert.match(v.notes.join(' '), /If node-c fails this will run on node-a without its GPU \(GPU work such as transcoding falls back to the CPU\)/)
  const ov = overview(snap)
  assert.equal(ov.counts.hardware, 0)
  assert.equal(ov.hardwareNotes.length, 1)
  assert.equal(ov.hardwareNotes[0].sid, 'ct:903')
  // Strict: it stays off instead, so no note.
  f.rules[0].strict = 1
  assert.equal(overview(await readSnapshot(f)).hardwareNotes.length, 0)
})

test('Portable GPU: the note reads the guest\'s GPU setup through gpuPortability()', async () => {
  const f = threeNodes()
  f.addResource('ct:903')
  f.addRule({ rule: 'h903', type: 'node-affinity', resources: 'ct:903', nodes: 'node-c' })
  try {
    // Stub (not portable): the CPU wording, plus the way out.
    let v = guestView(await readSnapshot(f), 'ct:903')!
    assert.match(v.notes[0], /without its GPU \(GPU work such as transcoding falls back to the CPU\)\. Turn on Portable GPU to use node-a's GPU there\.$/)
    // Portable, and the target has a GPU.
    setGpuPortability(() => ({ portable: true, perNode: { 'node-a': 'Intel UHD 630', 'node-b': null, 'node-c': 'NVIDIA GTX' } }))
    v = guestView(await readSnapshot(f), 'ct:903')!
    assert.equal(v.notes[0], 'If node-c fails this runs on node-a using its Intel UHD 630.')
    // Portable, and the target has none.
    setGpuPortability(() => ({ portable: true, perNode: { 'node-a': null } }))
    v = guestView(await readSnapshot(f), 'ct:903')!
    assert.equal(v.notes[0], 'If node-c fails this runs on node-a without a GPU.')
    // A throwing implementation falls back to the stub's answer.
    setGpuPortability(() => { throw new Error('boom') })
    assert.match(guestView(await readSnapshot(f), 'ct:903')!.notes[0], /Turn on Portable GPU/)
  } finally { setGpuPortability(null) }
})
