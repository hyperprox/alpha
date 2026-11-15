// Placement advisor: imbalance over hours, not a snapshot. Sustained load gets a suggestion with its effect worked out
// from the guest's own usage; a spike does not; backup windows are left out; HA guests the CRS balances are left to it;
// an HA guest held by its own preferred-node rule gets "change the rule", never a move.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { advise } from '../src/lib/placement/advice'
import type { GuestPlacement, PlacementMap, PlacementNode, Reason, Sample } from '../src/lib/placement/types'

const STEP = 300
const END = 1_790_000_000
const N = (72 * 3600) / STEP
const times = Array.from({ length: N }, (_, i) => END - (N - 1 - i) * STEP)
const S = { cpuAbove: 0.8, memAbove: 0.9, minHours: 6, windowHours: 72 }
/** A series at `base`, and `high` for the given number of hours (spread over three nights, as a sustained load is). */
function series(base: number, high: number, hours: number): Sample[] {
  const per = Math.round((hours * 3600) / STEP / 3)
  return times.map((t, i) => [t, [0, 1, 2].some(d => i >= d * 288 && i < d * 288 + per) ? high : base] as Sample)
}
const busyIdx = (hours: number) => { const per = Math.round((hours * 3600) / STEP / 3); return (i: number) => [0, 1, 2].some(d => i >= d * 288 && i < d * 288 + per) }

function node(name: string, threads = 8): PlacementNode {
  return { node: name, online: true, maintenance: false, threads, cpuModel: null, cpuVendor: null, cpu: 0.3, mem: 4e9, maxmem: 32e9, cpusAssigned: 0, memAssigned: 0, guests: [] }
}
function guest(sid: string, at: string, over: Partial<GuestPlacement> = {}, targetReasons: Record<string, Reason[]> = {}): GuestPlacement {
  const others = ['A', 'B', 'C'].filter(n => n !== at)
  return {
    sid, vmid: Number(sid.split(':')[1]), type: 'lxc', name: sid, node: at, status: 'running', template: false, ha: false, cpus: 2, maxmem: 2e9,
    usage: { cores: 1, mem: 1e9 }, why: [], movable: 'yes', summary: '', everywhere: [], copyBytes: 0, downtimeSec: 20,
    targets: others.map(n => { const r = targetReasons[n] ?? []; return { node: n, reasons: r, verdict: r.some(x => x.level === 'block') ? 'no' : 'ok' } }),
    ...over,
  }
}
const mapOf = (guests: GuestPlacement[]): PlacementMap => ({
  nodes: [node('A'), node('B'), node('C')], guests, at: 0, unread: [],
  crs: { mode: 'dynamic', rebalanceOnStart: true, autoRebalance: true },
  network: { shared: true, migrationNetwork: null, corosyncAddresses: [], redundantRing: false, datacenterBwlimit: null, suggestedBwlimit: 51200, words: [] },
})
const flat = (v: number): Sample[] => times.map(t => [t, v])
const nodes = (a: Sample[], b = flat(0.2), c = flat(0.5)) => [
  { node: 'A', cpu: a, mem: flat(0.4) }, { node: 'B', cpu: b, mem: flat(0.4) }, { node: 'C', cpu: c, mem: flat(0.4) },
]
const coresWhenBusy = (cores: number, hours: number): Sample[] => { const b = busyIdx(hours); return times.map((t, i) => [t, b(i) ? cores : 0.2]) }

test('sustained: a node above 80% for 10 of 72 hours gets one move, with the effect on both nodes from the guest\'s own usage', () => {
  const map = mapOf([guest('ct:1', 'A'), guest('ct:2', 'A')])
  const a = advise({
    map, nodes: nodes(series(0.4, 0.9, 10)), stepSec: STEP, settings: S, masked: () => false,
    guests: [{ sid: 'ct:1', cores: coresWhenBusy(2, 10), mem: flat(1e9) }, { sid: 'ct:2', cores: flat(0.1), mem: flat(1e9) }],
  })
  assert.equal(a.balanced, false)
  assert.equal(a.suggestions.length, 1)
  const s = a.suggestions[0]
  assert.deepEqual([s.kind, s.sid, s.from, s.to], ['move', 'ct:1', 'A', 'B'], 'the biggest user, to the node with the most room')
  assert.ok(Math.abs(s.effect.from.before - 10) < 0.2)
  assert.equal(s.effect.from.after, 0, '0.9 less 2 of 8 threads is 0.65: below the line')
  assert.equal(s.effect.to.after, 0, 'B goes from 0.2 to at most 0.45')
  assert.match(s.why[0], /A was above 80% CPU for 10 of the last 72 hours/)
  assert.match(s.why[0], /used 2\.0 cores/)
  assert.match(s.why[1], /B has room/)
})

test('spiky: an hour at 99% is not sustained, so nothing is suggested and the evidence says what was measured', () => {
  const a = advise({
    map: mapOf([guest('ct:1', 'A')]), nodes: nodes(series(0.3, 0.99, 1)), stepSec: STEP, settings: S, masked: () => false,
    guests: [{ sid: 'ct:1', cores: coresWhenBusy(4, 1), mem: flat(1e9) }],
  })
  assert.equal(a.balanced, true)
  assert.equal(a.headline, 'Balanced: nothing to do.')
  assert.deepEqual(a.suggestions, [])
  assert.ok(a.evidence.some(e => /^A: CPU above 80% for 1 h/.test(e)), a.evidence.join('\n'))
  assert.ok(a.evidence.some(e => /busy after 6 h/.test(e)))
})

test('the backup window is left out: eight busy hours that are all backups are not imbalance', () => {
  const b = busyIdx(8)
  const backupTimes = new Set(times.filter((_, i) => b(i)))
  const a = advise({
    map: mapOf([guest('ct:1', 'A')]), nodes: nodes(series(0.3, 0.95, 8)), stepSec: STEP, settings: S, masked: t => backupTimes.has(t),
    guests: [{ sid: 'ct:1', cores: coresWhenBusy(2, 8), mem: flat(1e9) }],
  })
  assert.equal(a.balanced, true)
  assert.ok(Math.abs(a.window.backupHoursSkipped - 8) < 0.2)
  const unmasked = advise({ map: mapOf([guest('ct:1', 'A')]), nodes: nodes(series(0.3, 0.95, 8)), stepSec: STEP, settings: S, masked: () => false, guests: [{ sid: 'ct:1', cores: coresWhenBusy(2, 8), mem: flat(1e9) }] })
  assert.equal(unmasked.balanced, false, 'the same load outside a backup window is busy')
})

test('never fights Proxmox: a CRS-balanced HA guest is left to it, and the stuck note says so', () => {
  const ha = guest('ct:1', 'A', { ha: true, everywhere: [{ code: 'crs', level: 'info', words: 'CRS' }] })
  const a = advise({ map: mapOf([ha]), nodes: nodes(series(0.4, 0.9, 10)), stepSec: STEP, settings: S, masked: () => false, guests: [{ sid: 'ct:1', cores: coresWhenBusy(2, 10), mem: flat(1e9) }] })
  assert.deepEqual(a.suggestions, [])
  assert.match(a.stuck[0], /left to Proxmox's own HA scheduler/)
})

test('an HA guest held by its own preferred-node rule gets "change the rule", not a migrate', () => {
  const rule: Reason = { code: 'prefer-rule', level: 'block', words: 'Its HA rule "home-a" prefers A: change the rule.' }
  const ha = guest('ct:1', 'A', { ha: true, movable: 'no' }, { B: [rule], C: [rule] })
  const a = advise({ map: mapOf([ha]), nodes: nodes(series(0.4, 0.9, 10)), stepSec: STEP, settings: S, masked: () => false, guests: [{ sid: 'ct:1', cores: coresWhenBusy(2, 10), mem: flat(1e9) }] })
  assert.equal(a.suggestions.length, 1)
  assert.equal(a.suggestions[0].kind, 'edit-rule')
  assert.equal(a.suggestions[0].rule, 'home-a')
  assert.ok(a.suggestions[0].why.some(w => /change the rule to prefer B/.test(w)))
})

test('a move that would make the target busy instead is never suggested', () => {
  const a = advise({
    map: mapOf([guest('ct:1', 'A')]), nodes: nodes(series(0.4, 0.9, 10), flat(0.7), flat(0.75)), stepSec: STEP, settings: S, masked: () => false,
    guests: [{ sid: 'ct:1', cores: flat(2), mem: flat(1e9) }],
  })
  assert.deepEqual(a.suggestions, [])
  assert.match(a.stuck[0], /no move would help/)
})

test('a guest that cannot move (a GPU, a bind mount) is never suggested, whatever its load', () => {
  const block: Reason = { code: 'gpu', level: 'block', words: 'GPU' }
  const g = guest('ct:1', 'A', { movable: 'no' }, { B: [block], C: [block] })
  const a = advise({ map: mapOf([g]), nodes: nodes(series(0.4, 0.9, 10)), stepSec: STEP, settings: S, masked: () => false, guests: [{ sid: 'ct:1', cores: coresWhenBusy(2, 10), mem: flat(1e9) }] })
  assert.deepEqual(a.suggestions, [])
  assert.equal(a.stuck.length, 1)
})

test('too little history is reported, not treated as balanced evidence', () => {
  const short = times.slice(-24).map(t => [t, 0.95] as Sample)
  const a = advise({ map: mapOf([guest('ct:1', 'A')]), nodes: [{ node: 'A', cpu: short, mem: short }], stepSec: STEP, settings: S, masked: () => false, guests: [] })
  assert.ok(a.unread.some(u => /enough history for A/.test(u)))
  assert.ok(a.unread.some(u => /history for B/.test(u)))
  assert.deepEqual(a.suggestions, [])
})
