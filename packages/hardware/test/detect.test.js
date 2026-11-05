'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const hw = require('..')
const { fakeNode, loadFixtures } = require('./harness')

for (const fx of loadFixtures()) {
  test(`probe: ${fx.file} reads as the hardware it is`, () => {
    const n = fakeNode(fx)
    try {
      const r = n.run(hw.probeScript())
      assert.equal(r.status, 0, r.stderr)
      const facts = hw.parseProbe(r.stdout, 'node-a')
      assert.deepEqual(facts.gpus.map(g => [g.vendor, g.kind, g.id, g.name]), fx.expect.gpus)
      assert.equal(facts.rapl, fx.expect.rapl)
      assert.equal(facts.nodeExporter, fx.expect.nodeExporter)
      assert.equal(facts.docker, fx.expect.docker)
      assert.equal(facts.ceph, Boolean(fx.ceph))
      if (fx.expect.intelExporter) assert.equal(facts.intelExporter, fx.expect.intelExporter)
      if (fx.expect.nvidiaExporter) assert.equal(facts.nvidiaExporter, fx.expect.nvidiaExporter)
      assert.equal(facts.nvidiaSmi, (fx.commands ?? []).includes('nvidia-smi'))
      assert.equal(facts.igpuAccess, fx.expect.igpuAccess)
      assert.equal(facts.igpuRule, Boolean(fx.expect.igpuRule))
    } finally { n.cleanup() }
  })
}

test('the probe changes nothing on the node', () => {
  const fx = loadFixtures().find(f => f.file === 'fresh-intel-node.json')
  const n = fakeNode(fx)
  try {
    const snap = () => require('child_process').execFileSync('bash', ['-c', `cd ${n.sys} && find . -printf '%p %m %s\\n' | sort`], { encoding: 'utf8' })
    const before = snap()
    n.run(hw.probeScript())
    assert.equal(snap(), before)
  } finally { n.cleanup() }
})

test('Proxmox PCI rows are classified by the same script as lspci', () => {
  const rows = [
    { class: '0x030000', vendor: '0x10de', device: '0x1b82', device_name: 'GP104 [GeForce GTX 1070 Ti]' },
    { class: '0x030000', vendor: '0x8086', device: '0x5912', device_name: 'HD Graphics 630' },
    { class: '0x030000', vendor: '0x1002', device: '0x15d8', device_name: 'Picasso/Raven 2 [Radeon Vega Series / Radeon Vega Mobile Series]' },
    { class: '0x030000', vendor: '0x8086', device: '0x7d55', device_name: 'Meteor Lake-P [Intel Arc Graphics]' },
    { class: '0x030000', vendor: '0x8086', device: '0x56a0', device_name: 'DG2 [Arc A770]' },
    { class: '0x030000', vendor: '0x1002', device: '0x744c', device_name: 'Navi 31 [Radeon RX 7900 XT/7900 XTX]' },
    { class: '0x030000', vendor: '0x1a03', device: '0x2000', device_name: 'ASPEED Graphics Family' },
    { class: '0x040300', vendor: '0x10de', device: '0x10f0', device_name: 'GP104 High Definition Audio Controller' },
  ]
  assert.deepEqual(hw.classifyPci(rows).map(g => `${g.vendor}/${g.kind}/${g.name}`), [
    'nvidia/dedicated/NVIDIA GeForce GTX 1070 Ti',
    'intel/integrated/Intel HD Graphics 630',
    'amd/integrated/AMD Radeon Vega Series / Radeon Vega Mobile Series',
    'intel/integrated/Intel Arc Graphics',
    'intel/dedicated/Intel Arc A770',
    'amd/dedicated/AMD Radeon RX 7900 XT/7900 XTX',
  ])
  assert.deepEqual(hw.classifyPci(null), [])
})

test('the summary is short and plain', () => {
  const nodes = [
    { ...hw.parseProbe('gpu\tnvidia\tdedicated\t10de:1b82\tNVIDIA GeForce GTX 1070 Ti\nrapl\treadable\tpackage-0\nceph\tyes', 'node-a') },
    { ...hw.parseProbe('gpu\tintel\tintegrated\t8086:3e92\tIntel UHD Graphics 630\nrapl\troot-only\tpackage-0', 'node-b') },
    { ...hw.parseProbe('rapl\tnone\t', 'node-c') },
  ]
  assert.equal(hw.summarise(nodes),
    'Found 3 nodes. node-a: NVIDIA GeForce GTX 1070 Ti (dedicated). node-b: Intel UHD Graphics 630 (built in). node-c: no GPU; no power counters. Ceph storage found.')
})

test('questions: only the ones that apply, GPU only when a GPU was found', () => {
  const intel = hw.parseProbe('gpu\tintel\tintegrated\t8086:5912\tIntel HD Graphics 630\nrapl\troot-only\tpackage-0', 'a')
  const plain = hw.parseProbe('rapl\tnone\t', 'b')
  const amd = hw.parseProbe('gpu\tamd\tintegrated\t1002:15d8\tAMD Radeon Vega\nrapl\treadable\tpackage-0', 'c')
  const ids = nodes => hw.applicableQuestions(nodes).map(q => q.id)
  assert.deepEqual(ids([intel, plain]), ['node-health', 'power', 'gpu', 'igpu-access', 'charts', 'proxmox-metrics', 'dns', 'ai'])
  assert.deepEqual(ids([plain]), ['node-health', 'charts', 'proxmox-metrics', 'dns', 'ai'], 'no GPU and no power counters: neither question')
  assert.ok(!ids([amd]).includes('gpu'), 'AMD only: nothing could be monitored, so no question')
  const mixed = hw.applicableQuestions([intel, amd]).find(q => q.id === 'gpu')
  assert.match(mixed.notes.join(' '), /AMD GPUs are not covered yet/)
  const power = hw.applicableQuestions([intel, plain]).find(q => q.id === 'power')
  assert.match(power.notes.join(' '), /^b has no power counters/)
  assert.ok(ids([intel]).includes('proxmox-metrics'))
  assert.ok(!hw.applicableQuestions([intel], { charts: false }).some(q => q.id === 'proxmox-metrics'))
  for (const q of hw.QUESTIONS) { assert.ok(q.ask.endsWith('?') || q.ask.endsWith('.')); assert.ok(q.what.length < 160, q.id) }
  assert.match(hw.QUESTIONS.find(q => q.id === 'power').what, /any local user on that node can then read energy use/)
})

test('plan: per node, skipping what is already there, one node at a time in order', () => {
  const nodes = [
    hw.parseProbe('gpu\tnvidia\tdedicated\t10de:1b82\tx\nrapl\treadable\tp\nnode_exporter\trunning\nnvidia_exporter\trunning', 'a'),
    hw.parseProbe('gpu\tintel\tintegrated\t8086:5912\tx\nrapl\troot-only\tp\nnode_exporter\tabsent\nintel_exporter\tabsent', 'b'),
    hw.parseProbe('rapl\tnone\t\nnode_exporter\tinstalled', 'c'),
  ]
  const all = { 'node-health': true, power: true, gpu: true }
  assert.deepEqual(hw.planNodeWork(all, nodes), [
    { node: 'b', step: 'node-exporter' }, { node: 'b', step: 'rapl' }, { node: 'b', step: 'intel-gpu-exporter' },
    { node: 'c', step: 'node-exporter' },
  ])
  assert.deepEqual(hw.planNodeWork({ power: true }, nodes), [{ node: 'b', step: 'rapl' }])
  assert.deepEqual(hw.planNodeWork({}, nodes), [])
})

test('run: strictly serial, a failure or an unreachable node does not stop the rest', async () => {
  let running = 0, maxRunning = 0
  const seen = []
  const exec = async (node, script) => {
    running++; maxRunning = Math.max(maxRunning, running)
    await new Promise(r => setTimeout(r, 5))
    running--
    seen.push(node)
    assert.match(script, /^# HyperProx node-side helpers/)
    if (node === 'b') throw new Error('connect ETIMEDOUT')
    if (node === 'c') return { code: 0, output: 'noise\nHPX-RESULT\tfailed\tapt-get install failed\n' }
    return { code: 0, output: 'HPX-RESULT\tdone\tinstalled and answering on port 9100\n' }
  }
  const r = await hw.runNodeWork([{ node: 'a', step: 'node-exporter' }, { node: 'b', step: 'node-exporter' }, { node: 'c', step: 'rapl' }], exec)
  assert.equal(maxRunning, 1)
  assert.deepEqual(seen, ['a', 'b', 'c'])
  assert.deepEqual(r.map(x => [x.node, x.status]), [['a', 'done'], ['b', 'failed'], ['c', 'failed']])
  assert.match(r[1].reason, /could not reach b: connect ETIMEDOUT/)
  assert.equal(hw.parseResult('', 3).status, 'failed')
})

test('targets follow the GPUs found, and merging keeps what is there', () => {
  const nodes = [
    hw.parseProbe('gpu\tnvidia\tdedicated\t10de:1b82\tx', 'a'),
    hw.parseProbe('gpu\tintel\tintegrated\t8086:5912\tx', 'b'),
    hw.parseProbe('gpu\tamd\tintegrated\t1002:15d8\tx', 'c'),
  ]
  const t = hw.targetsFor(nodes, n => `10.0.0.${n.charCodeAt(0) - 96}`, { cephMgrs: new Set(['a']) })
  assert.deepEqual(t['nvidia.json'], [{ targets: ['10.0.0.1:9835'], labels: { node: 'a' } }])
  assert.deepEqual(t['intel-gpu.json'], [{ targets: ['10.0.0.2:8081'], labels: { node: 'b' } }])
  assert.equal(t['nodes.json'].length, 3)
  assert.deepEqual(t['ceph.json'], [{ targets: ['10.0.0.1:9283'], labels: { node: 'a' } }])
  const m = hw.mergeTargets([{ targets: ['old:9100'], labels: { node: 'a' } }], t['nodes.json'])
  assert.deepEqual(m.added, ['b', 'c'])
  assert.equal(m.merged[0].targets[0], 'old:9100')
})

test('verify checks the outcome in Prometheus, not the scripts\' word', async () => {
  const nodes = [hw.parseProbe('rapl\treadable\tp\ngpu\tintel\tintegrated\t8086:5912\tx', 'a'), hw.parseProbe('rapl\tnone\t', 'b')]
  const data = {
    'up{job="node"}': [{ node: 'a', value: 1 }, { node: 'b', value: 0 }],
    'rate(node_rapl_package_joules_total[2m])': [{ node: 'a', value: 7.9 }],
    'up{job="intel-gpu"}': [],
  }
  const rows = await hw.verifyOutcome({ 'node-health': true, power: true, gpu: true }, nodes, async e => data[e])
  assert.deepEqual(rows.map(r => `${r.id}/${r.node}/${r.status}`), ['node-health/a/ok', 'node-health/b/failed', 'power/a/ok', 'gpu/a/failed'])
  const down = await hw.verifyOutcome({ 'node-health': true }, nodes, async () => { throw new Error('ECONNREFUSED') })
  assert.ok(down.every(r => r.status === 'waiting'))
})

test('built-in graphics for containers: the rule present reads open, absent reads closed, NVIDIA-only none', () => {
  const read = f => { const n = fakeNode(loadFixtures().find(x => x.file === f)); try { return hw.parseProbe(n.run(hw.probeScript()).stdout, 'n') } finally { n.cleanup() } }
  const open = read('intel-igpu-open.json'), closed = read('fresh-intel-node.json'), nv = read('nvidia-dedicated.json')
  assert.deepEqual([open.igpuAccess, open.igpuRule], ['open', true])
  assert.deepEqual([closed.igpuAccess, closed.igpuRule], ['closed', false])
  assert.equal(nv.igpuAccess, 'none', 'an NVIDIA-only node has no built-in graphics to open')
  open.node = 'a'; closed.node = 'b'; nv.node = 'c'
  const q = hw.applicableQuestions([open, closed, nv]).find(x => x.id === 'igpu-access')
  assert.equal(q.ask, 'Do you want containers on these nodes to be able to use their built-in graphics (for video transcoding)?')
  assert.match(q.what, /any container on that node can then use its built-in graphics\./)
  assert.deepEqual(q.notes, ['Applies to a, b.'])
  assert.equal(q.default, false)
  assert.ok(!hw.applicableQuestions([nv]).some(x => x.id === 'igpu-access'), 'not offered without built-in graphics')
  assert.deepEqual(hw.planNodeWork({ 'igpu-access': true }, [open, closed, nv]), [{ node: 'b', step: 'igpu-access' }])
  assert.deepEqual(hw.planNodeWork({}, [closed]), [], 'only on a yes')
  assert.match(hw.stepScript('igpu-access-undo'), /rm -f "\$RULE_FILE"/)
})

test('the Intel exporter image is pinned by digest wherever it is named', () => {
  const fs = require('fs'), path = require('path')
  for (const f of [path.join(hw.NODE_DIR, 'intel-gpu-exporter.sh'), path.join(__dirname, '../../../docs/manual-setup.md')]) {
    const names = fs.readFileSync(f, 'utf8').match(/ghcr\.io\/onedr0p\/intel-gpu-exporter[^\s"]*/g)
    assert.ok(names.length > 0, f)
    for (const n of names) assert.match(n, /@sha256:[0-9a-f]{64}$/, `${f}: ${n}`)
  }
})
