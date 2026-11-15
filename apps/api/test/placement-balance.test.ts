// Load balancing: the balance score and the plan, against fixture clusters. The score compares nodes by their own
// capacity (a small node at 80% is busier than a big one at 40%, whatever the bytes), the plan takes the fewest moves
// for the most gain, never pushes a target over the busy line or leaves it worse off than the source was, respects HA
// (rule changes for guests held by their own rule; HA guests left to Proxmox's auto-rebalance), stops below the
// minimum gain and at the move cap, and replays finished moves onto the history.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { balance, checkStep, scoreOf, recentUneven, planSignature, type BalanceInput } from '../src/lib/placement/balance'
import { DEFAULT_SETTINGS } from '../src/lib/placement/store'
import type { GuestPlacement, PlacementMap, PlacementNode, Reason, Sample } from '../src/lib/placement/types'

const G = 1024 ** 3
const STEP = 300
const END = 1_790_000_000
const N = (72 * 3600) / STEP
const times = Array.from({ length: N }, (_, i) => END - (N - 1 - i) * STEP)
const flat = (v: number): Sample[] => times.map(t => [t, v])

function node(name: string, threads = 8, maxmem = 32 * G): PlacementNode {
  return { node: name, online: true, maintenance: false, threads, cpuModel: null, cpuVendor: null, cpu: 0.3, mem: 0, maxmem, cpusAssigned: 0, memAssigned: 0, guests: [] }
}
function guest(sid: string, at: string, all: string[], over: Partial<GuestPlacement> = {}, targetReasons: Record<string, Reason[]> = {}): GuestPlacement {
  return {
    sid, vmid: Number(sid.split(':')[1]), type: sid.startsWith('ct:') ? 'lxc' : 'qemu', name: `g${sid.split(':')[1]}`, node: at, status: 'running', template: false, ha: false,
    cpus: 2, maxmem: 8 * G, usage: { cores: 0.2, mem: G }, why: [], movable: 'yes', summary: '', everywhere: [], copyBytes: 0, downtimeSec: 20,
    targets: all.filter(n => n !== at).map(n => {
      const r = targetReasons[n] ?? []
      return { node: n, reasons: r, verdict: r.some(x => x.level === 'block') ? 'no' as const : r.some(x => x.level === 'unknown') ? 'unknown' as const : 'ok' as const }
    }),
    ...over,
  }
}
function mapOf(nodes: PlacementNode[], guests: GuestPlacement[], crs: PlacementMap['crs'] = { mode: 'static', rebalanceOnStart: false, autoRebalance: false }): PlacementMap {
  return {
    nodes, guests, at: 0, unread: [], crs,
    network: { shared: true, migrationNetwork: null, corosyncAddresses: [], redundantRing: false, datacenterBwlimit: null, suggestedBwlimit: 51200, words: [] },
  }
}
const S = { ...DEFAULT_SETTINGS }
function input(map: PlacementMap, mem: Record<string, number>, guests: Record<string, { cores?: number; mem?: number }>, o: Partial<BalanceInput> = {}, cpu: Record<string, number> = {}): BalanceInput {
  return {
    map, stepSec: STEP, masked: () => false, settings: { ...S, ...(o.settings ?? {}) }, endSec: END,
    nodes: map.nodes.map(n => ({ node: n.node, cpu: flat(cpu[n.node] ?? 0.3), mem: flat(mem[n.node]) })),
    guests: Object.entries(guests).map(([sid, g]) => ({ sid, cores: flat(g.cores ?? 0.2), mem: flat(g.mem ?? G) })),
    ...o,
  }
}
const ABC = ['A', 'B', 'C']
const near = (a: number, b: number, eps = 0.6) => Math.abs(a - b) <= eps

test('uneven RAM on equal nodes: the biggest move first, then the next, fewest moves for the most gain', () => {
  const map = mapOf(ABC.map(n => node(n)), [guest('ct:1', 'A', ABC), guest('ct:2', 'A', ABC), guest('ct:3', 'A', ABC)])
  const r = balance(input(map, { A: 0.85, B: 0.3, C: 0.4 }, { 'ct:1': { mem: 8 * G }, 'ct:2': { mem: 4 * G }, 'ct:3': { mem: 1 * G } }, { goal: 'mem' }))
  assert.equal(r.uneven, true)
  assert.ok(near(r.score.score, 45), String(r.score.score))
  assert.match(r.headline, /^Uneven: A carries \d+% of the memory in use and runs at 85% of its own; B at 30%\./)
  assert.deepEqual(r.plan.steps.map(s => [s.sid, s.from, s.to]), [['ct:1', 'A', 'B'], ['ct:2', 'A', 'C']])
  assert.ok(near(r.plan.steps[0].gain, 35), String(r.plan.steps[0].gain))
  assert.ok(near(r.plan.target.score, 92.5), String(r.plan.target.score))
  assert.ok(r.plan.steps[0].downtimeSec === 20 && r.plan.steps[0].method === 'migrate' && r.plan.steps[0].bwlimitKiB === 51200, 'a container restart, under the bandwidth limit on a shared network')
  assert.ok(r.plan.needSec >= 2 * (20 + 120))
  assert.ok(r.plan.left.some(l => /no further move gains at least 3 points/.test(l)))
  assert.equal(planSignature(r.plan.steps), 'ct:1>B,ct:2>C')
})

test('big plus small nodes: load is compared as a share of each node, so the small busy nodes are relieved onto the big one', () => {
  const all = ['node1', 'node2', 'node3']
  const map = mapOf([node('node1', 24, 96 * G), node('node2', 4, 16 * G), node('node3', 4, 16 * G)], [
    guest('ct:11', 'node2', all), guest('ct:12', 'node3', all), guest('ct:13', 'node1', all),
  ])
  const r = balance(input(map, { node1: 0.3, node2: 0.85, node3: 0.8 }, { 'ct:11': { mem: 4 * G }, 'ct:12': { mem: 4 * G }, 'ct:13': { mem: 20 * G } }, { goal: 'mem' }))
  assert.equal(r.uneven, true)
  assert.match(r.headline, /node2 carries \d+% of the memory in use and runs at 85% of its own; node1 at 30%/)
  assert.ok(r.nodes.find(n => n.node === 'node1')!.memShare > 0.5, 'the big node holds most of the bytes and is still the least busy')
  assert.deepEqual(r.plan.steps.map(s => [s.sid, s.to]), [['ct:11', 'node1'], ['ct:12', 'node1']])
  assert.ok(!r.plan.steps.some(s => s.sid === 'ct:13'), 'the big node\'s 20 GiB guest would swamp a 16 GiB node')
  assert.ok(r.plan.target.score > r.plan.score.score + 20)
})

test('never over the line: a guest whose CPU would push a small target above 80% is not moved there', () => {
  const all = ['big', 'small']
  const map = mapOf([node('big', 24, 64 * G), node('small', 4, 64 * G)], [guest('ct:21', 'big', all)])
  // Memory: big 0.7, small 0.2. The guest is light on memory but busy: 3 cores, 75% of the small node.
  const r = balance(input(map, { big: 0.7, small: 0.2 }, { 'ct:21': { mem: 8 * G, cores: 3 } }, { goal: 'mem' }, { big: 0.3, small: 0.3 }))
  assert.equal(r.plan.steps.length, 0)
  assert.ok(r.plan.left.some(l => /No move would raise the score/.test(l)), r.plan.left.join(' | '))
})

test('never worse: a move that would leave the target busier than the source was is not proposed', () => {
  const all = ['A', 'B']
  const map = mapOf([node('A'), node('B')], [guest('ct:31', 'A', all)])
  // A 0.6, B 0.3; the guest is 0.4 of a node: B would reach 0.7, worse than A's 0.6.
  const r = balance(input(map, { A: 0.6, B: 0.3 }, { 'ct:31': { mem: 0.4 * 32 * G } }, { goal: 'mem', settings: { ...S, unevenAbove: 0.2 } }))
  assert.equal(r.uneven, true)
  assert.deepEqual(r.plan.steps, [])
})

test('the minimum gain: a move that improves the score by less than the threshold is not worth a restart', () => {
  const map = mapOf(ABC.map(n => node(n)), [guest('ct:41', 'A', ABC)])
  const base = { A: 0.7, B: 0.35, C: 0.4 }
  // 0.2 GiB of 32 GiB off A and onto B narrows the gap by 1.25 points.
  const small = balance(input(map, base, { 'ct:41': { mem: 0.2 * G } }, { goal: 'mem' }))
  assert.equal(small.plan.steps.length, 0)
  const lower = balance(input(map, base, { 'ct:41': { mem: 0.2 * G } }, { goal: 'mem', settings: { ...S, minGain: 1 } }))
  assert.equal(lower.plan.steps.length, 1, 'with a lower threshold the same move is kept')
})

test('the cap: at most maxPlanMoves moves, and the plan says it stopped there', () => {
  const gs = [1, 2, 3, 4, 5, 6].map(i => guest(`ct:5${i}`, 'A', ABC))
  const map = mapOf(ABC.map(n => node(n)), gs)
  const r = balance(input(map, { A: 0.9, B: 0.1, C: 0.1 }, Object.fromEntries(gs.map(g => [g.sid, { mem: 2 * G }])), { goal: 'mem', settings: { ...S, maxPlanMoves: 2 } }))
  assert.equal(r.plan.steps.length, 2)
  assert.ok(r.plan.left.some(l => /stops at 2 moves/.test(l)))
})

test('nothing movable: GPU, bind mount, template and stopped guests stay, the plan is empty and says why', () => {
  const gpu: Reason = { code: 'gpu', level: 'block', words: 'It uses a GPU on A.' }
  const map = mapOf(ABC.map(n => node(n)), [
    guest('ct:61', 'A', ABC, { name: 'media', movable: 'no' }, { B: [gpu], C: [gpu] }),
    guest('ct:62', 'A', ABC, { name: 'files', movable: 'no', everywhere: [{ code: 'bind-mount', level: 'block', words: 'A bind mount (/mnt/x).' }] }),
    guest('vm:63', 'A', ABC, { template: true, status: 'stopped' }),
    guest('ct:64', 'A', ABC, { status: 'stopped' }),
  ])
  const r = balance(input(map, { A: 0.9, B: 0.2, C: 0.2 }, { 'ct:61': { mem: 8 * G }, 'ct:62': { mem: 8 * G } }, { goal: 'mem' }))
  assert.equal(r.uneven, true)
  assert.deepEqual(r.plan.steps, [])
  assert.ok(near(r.plan.target.score, r.plan.score.score, 0.001))
  assert.ok(r.plan.left.some(l => /On A, staying put: .*media.*files/.test(l)), r.plan.left.join(' | '))
})

test('HA held by its own preferred-node rule: a rule change is suggested, never a move; the plan moves the others', () => {
  const rule: Reason = { code: 'prefer-rule', level: 'block', words: 'Its HA rule "home-a" prefers A: change the rule.' }
  const map = mapOf(ABC.map(n => node(n)), [
    guest('ct:71', 'A', ABC, { name: 'held', ha: true, movable: 'no' }, { B: [rule], C: [rule] }),
    guest('ct:72', 'A', ABC, { name: 'free' }),
  ])
  const r = balance(input(map, { A: 0.9, B: 0.2, C: 0.3 }, { 'ct:71': { mem: 8 * G }, 'ct:72': { mem: 4 * G } }, { goal: 'mem' }))
  assert.deepEqual(r.plan.steps.map(s => s.sid), ['ct:72'])
  assert.equal(r.plan.suggestions.length, 1)
  assert.deepEqual([r.plan.suggestions[0].kind, r.plan.suggestions[0].sid, r.plan.suggestions[0].rule], ['edit-rule', 'ct:71', 'home-a'])
  assert.match(r.plan.suggestions[0].words, /does not change HA rules on its own/)
  assert.ok(r.plan.words.some(w => /not set to auto-rebalance, so HA guests can be part of a plan/.test(w)))
})

test("CRS auto-rebalance on: HA guests are left to Proxmox, and the plan says so", () => {
  const crs: Reason = { code: 'crs', level: 'info', words: 'CRS' }
  const map = mapOf(ABC.map(n => node(n)), [guest('ct:81', 'A', ABC, { ha: true, everywhere: [crs] })], { mode: 'dynamic', rebalanceOnStart: true, autoRebalance: true })
  const r = balance(input(map, { A: 0.9, B: 0.2, C: 0.3 }, { 'ct:81': { mem: 8 * G } }, { goal: 'mem' }))
  assert.deepEqual(r.plan.steps, [])
  assert.deepEqual(r.plan.suggestions, [])
  assert.ok(r.plan.words.some(w => /auto-rebalance on: it already moves the 1 HA guest/.test(w)))
  assert.ok(r.plan.left.some(l => /left to Proxmox's own auto-rebalance/.test(l)))
})

test('HA guests without a holding rule move through HA in a manual plan; automatic mode only suggests them', () => {
  const map = mapOf(ABC.map(n => node(n)), [guest('ct:91', 'A', ABC, { ha: true })])
  const manual = balance(input(map, { A: 0.9, B: 0.2, C: 0.3 }, { 'ct:91': { mem: 8 * G } }, { goal: 'mem' }))
  assert.equal(manual.plan.steps[0]?.method, 'ha')
  assert.equal(manual.plan.steps[0]?.bwlimitKiB, null, 'HA moves take only the datacenter limit')
  const auto = balance(input(map, { A: 0.9, B: 0.2, C: 0.3 }, { 'ct:91': { mem: 8 * G } }, { goal: 'mem', auto: true }))
  assert.deepEqual(auto.plan.steps, [])
  assert.equal(auto.plan.suggestions[0]?.kind, 'ha-move')
  assert.ok(auto.plan.words.some(w => /moves only guests HA does not manage/.test(w)))
})

test('automatic mode never copies disks: a guest with a local disk is left alone', () => {
  const local: Reason = { code: 'local-disk', level: 'warn', words: 'Its disk is on node-local storage.' }
  const map = mapOf(ABC.map(n => node(n)), [guest('vm:95', 'A', ABC, { copyBytes: 32 * G }, { B: [local], C: [local] })])
  const auto = balance(input(map, { A: 0.9, B: 0.2, C: 0.3 }, { 'vm:95': { mem: 8 * G } }, { goal: 'mem', auto: true }))
  assert.deepEqual(auto.plan.steps, [])
  const manual = balance(input(map, { A: 0.9, B: 0.2, C: 0.3 }, { 'vm:95': { mem: 8 * G } }, { goal: 'mem' }))
  assert.equal(manual.plan.steps.length, 1)
  assert.ok(manual.plan.steps[0].copySec > 0, 'a manual plan shows the copy and its time')
})

test('the goal: by CPU the CPU-heavy guest moves; by memory the memory-heavy one', () => {
  const map = mapOf(ABC.map(n => node(n)), [guest('ct:101', 'A', ABC), guest('ct:102', 'A', ABC)])
  const loads = { 'ct:101': { cores: 3, mem: 0.5 * G }, 'ct:102': { cores: 0.1, mem: 8 * G } }
  const mem = { A: 0.8, B: 0.2, C: 0.25 }, cpu = { A: 0.7, B: 0.1, C: 0.15 }
  const byCpu = balance(input(map, mem, loads, { goal: 'cpu' }, cpu))
  assert.equal(byCpu.plan.steps[0].sid, 'ct:101')
  const byMem = balance(input(map, mem, loads, { goal: 'mem' }, cpu))
  assert.equal(byMem.plan.steps[0].sid, 'ct:102')
  const both = balance(input(map, mem, loads, { goal: 'both' }, cpu))
  assert.equal(both.plan.steps.length, 2, 'both evens out both')
})

test('balanced: a small spread is "Balanced" and no plan is needed', () => {
  const map = mapOf(ABC.map(n => node(n)), [guest('ct:111', 'A', ABC)])
  const r = balance(input(map, { A: 0.45, B: 0.4, C: 0.38 }, { 'ct:111': { mem: G } }))
  assert.equal(r.uneven, false)
  assert.match(r.headline, /^Balanced: CPU and memory within \d+ points across 3 nodes/)
})

test('an offline node or one without history is not counted, and says so', () => {
  const off = { ...node('C'), online: false }
  const map = mapOf([node('A'), node('B'), off], [guest('ct:121', 'A', ABC, {}, { C: [{ code: 'offline', level: 'block', words: 'C is offline.' }] })])
  const r = balance(input(map, { A: 0.9, B: 0.2, C: 0 }, { 'ct:121': { mem: 8 * G } }, { goal: 'mem' }))
  assert.equal(r.nodes.find(n => n.node === 'C')!.counted, false)
  assert.ok(r.plan.steps.every(s => s.to !== 'C'))
  const nohist = balance({ ...input(map, { A: 0.9, B: 0.2, C: 0 }, {}), nodes: [] })
  assert.match(nohist.headline, /^No history/)
  assert.deepEqual(nohist.plan.steps, [])
})

test('finished moves are replayed: a guest already moved counts on its new node, not its old one', () => {
  const map = mapOf(['A', 'B'].map(n => node(n)), [guest('ct:131', 'B', ['A', 'B'])])
  // The history shows A busy because the guest (0.4 of a node) ran there until an hour ago.
  const at = END - 3600
  const memA = times.map(t => [t, t < at ? 0.8 : 0.4] as Sample), memB = times.map(t => [t, t < at ? 0.2 : 0.6] as Sample)
  const base = input(map, { A: 0, B: 0 }, { 'ct:131': { mem: 0.4 * 32 * G } }, { goal: 'mem' })
  base.nodes = [{ node: 'A', cpu: flat(0.3), mem: memA }, { node: 'B', cpu: flat(0.3), mem: memB }]
  const raw = balance(base)
  assert.ok(raw.nodes.find(n => n.node === 'A')!.mem.p95 > 0.7, 'unreplayed, the old load still shows')
  const replayed = balance({ ...base, past: [{ sid: 'ct:131', from: 'A', to: 'B', at }] })
  assert.ok(near(replayed.nodes.find(n => n.node === 'A')!.mem.p95, 0.4, 0.01))
  assert.ok(near(replayed.nodes.find(n => n.node === 'B')!.mem.p95, 0.6, 0.01))
})

test('the check before a planned move runs: still helps, or the reason it no longer does', () => {
  const map = mapOf(ABC.map(n => node(n)), [guest('ct:141', 'A', ABC)])
  const ok = checkStep(input(map, { A: 0.85, B: 0.3, C: 0.4 }, { 'ct:141': { mem: 8 * G } }, { goal: 'mem' }), 'ct:141', 'B')
  assert.equal(ok.ok, true)
  const now = checkStep(input(map, { A: 0.4, B: 0.75, C: 0.4 }, { 'ct:141': { mem: 8 * G } }, { goal: 'mem' }), 'ct:141', 'B')
  assert.equal(now.ok, false)
  assert.match(now.why, /busier on memory|above the|no longer even out/)
  const gone = checkStep(input(map, { A: 0.85, B: 0.3, C: 0.4 }, {}, { goal: 'mem' }), 'ct:999', 'B')
  assert.match(gone.why, /no longer in the cluster/)
})

test('score and the sustained check', () => {
  const s = scoreOf([{ node: 'a', cpu: 0.5, mem: 0.9 }, { node: 'b', cpu: 0.3, mem: 0.3 }], 'both')
  assert.ok(near(s.score, 100 - (20 + 60) / 2, 0.001))
  assert.equal(s.busiest, 'a')
  const a = { cpu: new Map(times.map(t => [t, 0.3])), mem: new Map(times.map(t => [t, t > END - 4 * 3600 ? 0.9 : 0.4])) }
  const b = { cpu: new Map(times.map(t => [t, 0.3])), mem: new Map(times.map(t => [t, 0.3])) }
  const r = recentUneven([a, b], 'mem', 0.25, 6, END, STEP)
  assert.ok(near(r.covered, 6, 0.1) && near(r.hours, 4, 0.1), JSON.stringify(r))
})
