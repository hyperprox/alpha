// =============================================================================
//  HyperProx — load balancing: the score and the plan
//
//  The score. For every counted node (online, not in maintenance, with history)
//  its load is the 95th percentile of its own CPU and memory over the history
//  window, as a share of its own capacity, so a small node and a big one are
//  compared fairly. The spread is the gap between the busiest and the least
//  busy node; the score is 100 less that gap in points. Balancing by "both"
//  takes the mean of the CPU and the memory spread.
//
//  The plan. Greedy, fewest moves for the most gain: each round tries every
//  guest the engine says can move against every node it may go to, works out
//  both nodes' series with the guest's own measured series moved across, and
//  keeps the one move that raises the score most. It stops when no move gains
//  at least `minGain` points, or at `maxPlanMoves`. A move is never kept that
//  would
//    - push the target above the busy line (cpuAbove / memAbove) at its p95,
//    - leave the target worse off than the source was before the move,
//    - move a guest HA manages while Proxmox's own auto-rebalance is on (CRS
//      already balances those; a second balancer would fight it).
//  An HA guest held by its own preferred-node rule is never moved: changing
//  the rule is suggested instead, as the advisor always did.
//
//  Recent moves: the history still shows a moved guest's load on its old node
//  for up to the whole window. Moves that finished inside the window are
//  replayed onto the history first (the guest's series taken off the old node
//  and put on the new one, for the time before the move), so the score is the
//  cluster as it is now, not as it was.
//
//  Pure: series in, a plan out.
// =============================================================================

import { copySeconds } from './network'
import { keep, p95, shifted } from './advice'
import type {
  BalanceGoal, BalancePlan, BalanceResult, BalanceScore, BalanceSuggestion, GuestPlacement, GuestSeries, NodeAfter, NodeLoad,
  NodeSeries, PlacementMap, PlacementNode, PlacementSettings, PlanStep, Sample,
} from './types'

export type BalanceSettings = Pick<PlacementSettings,
  'cpuAbove' | 'memAbove' | 'balanceGoal' | 'unevenAbove' | 'minGain' | 'maxPlanMoves' | 'linkMbps' | 'bwlimitKiB'>

/** A move that finished: replayed onto the history for the time before `at` (unix seconds). */
export interface PastMove { sid: string; from: string; to: string; at: number }

/** Where the history saw a guest: each node it was on, first and last seen (unix seconds). */
export type GuestLocations = Record<string, Array<{ node: string; first: number; last: number }>>

/** A guest series must cover this share of its node's readings to count as measured. */
export const MIN_COVERAGE = 0.8

export interface BalanceInput {
  map:      PlacementMap
  nodes:    NodeSeries[]
  guests:   GuestSeries[]
  masked:   (sec: number) => boolean
  stepSec:  number
  settings: BalanceSettings
  goal?:    BalanceGoal
  /** Finished moves inside the window, oldest first. */
  past?:    PastMove[]
  /** Where the history saw each guest; a guest seen elsewhere with no recorded move is left alone until fresh history covers it. */
  locations?: GuestLocations
  /** Automatic mode: HA guests are only suggested, and guests with disks to copy are left alone. */
  auto?:    boolean
  /** The most recent stretch looked at for "uneven for a sustained time", hours. */
  recentHours?: number
  /** The end of the window (unix seconds): the recent stretch is measured back from it. */
  endSec?:  number
}

type Series = { cpu: Map<number, number>; mem: Map<number, number> }

const pts = (v: number) => Math.round(v * 100)
const pct = (v: number) => `${Math.round(v * 100)}%`
const round1 = (v: number) => Math.round(v * 10) / 10
const mean = (vs: number[]) => (vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : 0)

export function goalWord(goal: BalanceGoal): string {
  return goal === 'mem' ? 'memory' : goal === 'cpu' ? 'CPU' : 'CPU and memory'
}

/** The score of a set of node loads (p95 shares), for a goal. */
export function scoreOf(loads: Array<{ node: string; cpu: number; mem: number }>, goal: BalanceGoal): BalanceScore {
  if (!loads.length) return { score: 100, spread: 0, cpuSpread: 0, memSpread: 0, busiest: null, idlest: null }
  const cpus = loads.map(l => l.cpu), mems = loads.map(l => l.mem)
  const cpuSpread = Math.max(...cpus) - Math.min(...cpus)
  const memSpread = Math.max(...mems) - Math.min(...mems)
  const spread = goal === 'cpu' ? cpuSpread : goal === 'mem' ? memSpread : (cpuSpread + memSpread) / 2
  const key = (l: { cpu: number; mem: number }) => (goal === 'cpu' ? l.cpu : goal === 'mem' ? l.mem : (l.cpu + l.mem) / 2)
  const sorted = [...loads].sort((a, b) => key(b) - key(a))
  return { score: 100 * (1 - spread), spread, cpuSpread, memSpread, busiest: sorted[0].node, idlest: sorted[sorted.length - 1].node }
}

/** Hourly means of a series, for a sparkline. */
function hourly(m: Map<number, number>): Sample[] {
  const buckets = new Map<number, number[]>()
  for (const [t, v] of m) { const h = Math.floor(t / 3600) * 3600; const b = buckets.get(h) ?? []; b.push(v); buckets.set(h, b) }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([t, vs]) => [t, Math.round(mean(vs) * 1000) / 1000] as Sample)
}

/** The node series with finished moves replayed: the guest's load taken off the old node and put on the new one, before the move. */
export function replay(series: Map<string, Series>, guests: Map<string, Series>, caps: Map<string, PlacementNode>, past: PastMove[]): void {
  for (const m of past) {
    const g = guests.get(m.sid), from = series.get(m.from), to = series.get(m.to), cf = caps.get(m.from), ct = caps.get(m.to)
    if (!g || !from || !to || !cf || !ct) continue
    const fill = p95s(g)
    // The guest's readings before the move, on the timeline of each node's own series (nothing after it); a gap is its p95.
    const before = (gm: Map<number, number>, base: Map<number, number>, f: number) => { const out = new Map<number, number>(); for (const t of base.keys()) out.set(t, t < m.at ? gm.get(t) ?? f : 0); return out }
    from.cpu = shifted(from.cpu, before(g.cpu, from.cpu, fill.cpu), cf.threads || 1, -1); from.mem = shifted(from.mem, before(g.mem, from.mem, fill.mem), cf.maxmem || 1, -1)
    to.cpu = shifted(to.cpu, before(g.cpu, to.cpu, fill.cpu), ct.threads || 1, 1); to.mem = shifted(to.mem, before(g.mem, to.mem, fill.mem), ct.maxmem || 1, 1)
  }
}

const p95s = (g: Series) => ({ cpu: p95([...g.cpu.values()]), mem: p95([...g.mem.values()]) })

/**
 * A guest series on a node's timeline, for a shift. A missing reading is the guest's own p95, never zero: a gap in
 * the scrape is not a guest using nothing, and zero would make a busy guest look light.
 */
function only(m: Map<number, number>, base: Map<number, number>, fill: number): Map<number, number> {
  const out = new Map<number, number>()
  for (const t of base.keys()) out.set(t, m.get(t) ?? fill)
  return out
}

/** Why a guest cannot be in a plan at all, or null when it can (for some target). */
function exclusion(g: GuestPlacement, auto: boolean): string | null {
  if (g.template) return 'a template'
  if (g.status !== 'running') return 'stopped: it adds no load'
  if (g.everywhere.some(r => r.code === 'crs')) return "HA: left to Proxmox's own auto-rebalance"
  if (g.everywhere.some(r => r.level === 'block')) return g.everywhere.find(r => r.level === 'block')!.words
  if (g.everywhere.some(r => r.level === 'unknown')) return 'not everything about it could be read'
  if (auto && g.ha) return 'automatic balancing never moves HA guests'
  if (auto && g.targets.some(t => t.reasons.some(r => r.code === 'local-disk'))) return 'automatic balancing never copies disks over the network'
  return null
}

/** How the guest could go to `to`: a move, a rule change, or not at all. */
function routeTo(g: GuestPlacement, to: string): 'move' | 'edit-rule' | null {
  const t = g.targets.find(x => x.node === to)
  if (!t) return null
  if (t.verdict === 'ok') return 'move'
  const blocks = t.reasons.filter(r => r.level === 'block' || r.level === 'unknown')
  if (g.ha && blocks.length && blocks.every(r => r.code === 'prefer-rule')) return 'edit-rule'
  return null
}

interface Trial {
  g: GuestPlacement; to: string; kind: 'move' | 'edit-rule'
  fromS: Series; toS: Series
  before: PlanStep['before']; after: PlanStep['after']
  score: BalanceScore; gain: number
}

/** The cluster's series with past moves replayed, its counted nodes, and the trial of one move against a state. */
function context(input: BalanceInput) {
  const s = input.settings
  const goal: BalanceGoal = input.goal ?? s.balanceGoal ?? 'both'
  const caps = new Map(input.map.nodes.map(n => [n.node, n]))
  const series = new Map<string, Series>()
  for (const n of input.nodes) if (caps.has(n.node)) series.set(n.node, { cpu: keep(n.cpu, input.masked), mem: keep(n.mem, input.masked) })
  const gseries = new Map<string, Series>()
  for (const g of input.guests) gseries.set(g.sid, { cpu: keep(g.cores, input.masked), mem: keep(g.mem, input.masked) })
  replay(series, gseries, caps, input.past ?? [])
  const counted = (n: PlacementNode) => n.online && !n.maintenance && !!series.get(n.node)?.cpu.size && !!series.get(n.node)?.mem.size
  const live = input.map.nodes.filter(counted)
  const state = new Map<string, Series>(live.map(n => [n.node, series.get(n.node)!]))
  const at = new Map<string, string>(input.map.guests.map(g => [g.sid, g.node]))
  const loadOf = (sr: Series) => ({ cpu: p95([...sr.cpu.values()]), mem: p95([...sr.mem.values()]) })
  const loads = () => live.map(n => ({ node: n.node, ...loadOf(state.get(n.node)!) }))
  const busy = (l: { cpu: number; mem: number }) => (goal === 'cpu' ? l.cpu : goal === 'mem' ? l.mem : (l.cpu + l.mem) / 2)

  /** One guest to one node, against the current state: the trial, or the reason it is not kept. */
  const trial = (g: GuestPlacement, to: string, cur: BalanceScore): Trial | string => {
    const from = at.get(g.sid)!
    const kind = routeTo(g, to)
    if (!kind) return `it cannot go to ${to}`
    const nf = caps.get(from), nt = caps.get(to)
    const sf = state.get(from), st = state.get(to)
    if (!nf || !nt || !sf || !st) return `${!sf ? from : to} has no history or is not online`
    const gs = gseries.get(g.sid)
    if (!gs) return 'it has no history'
    const f = p95s(gs)
    const fromS: Series = { cpu: shifted(sf.cpu, only(gs.cpu, sf.cpu, f.cpu), nf.threads || 1, -1), mem: shifted(sf.mem, only(gs.mem, sf.mem, f.mem), nf.maxmem || 1, -1) }
    const toS: Series = { cpu: shifted(st.cpu, only(gs.cpu, st.cpu, f.cpu), nt.threads || 1, 1), mem: shifted(st.mem, only(gs.mem, st.mem, f.mem), nt.maxmem || 1, 1) }
    const before = { from: loadOf(sf), to: loadOf(st) }
    const after = { from: loadOf(fromS), to: loadOf(toS) }
    if (after.to.cpu > s.cpuAbove) return `${to} would reach ${pct(after.to.cpu)} CPU, above the ${pct(s.cpuAbove)} line`
    if (after.to.mem > s.memAbove) return `${to} would reach ${pct(after.to.mem)} memory, above the ${pct(s.memAbove)} line`
    // Never worse: the target after the move no busier, by the goal's measure, than the source was before it.
    if (busy(after.to) > busy(before.from) + 1e-9) {
      return `${to} would end up busier on ${goalWord(goal)} (${pct(busy(after.to))}) than ${from} was (${pct(busy(before.from))})`
    }
    const next = loads().map(l => (l.node === from ? { node: from, ...after.from } : l.node === to ? { node: to, ...after.to } : l))
    const score = scoreOf(next, goal)
    return { g, to, kind, fromS, toS, before, after, score, gain: score.score - cur.score }
  }
  /** Why the guest's own history is not good enough to move it on, or null: both series, each covering most of its node's readings. */
  const unmeasured = (g: GuestPlacement): string | null => {
    const gs = gseries.get(g.sid)
    const base = series.get(g.node)
    if (!gs || !gs.cpu.size || !gs.mem.size) return 'it has no CPU or memory history'
    if (!base || !base.cpu.size) return `${g.node} has no history`
    const cover = (m: Map<number, number>, b: Map<number, number>) => { let n = 0; for (const t of b.keys()) if (m.has(t)) n++; return n / Math.max(1, b.size) }
    const c = Math.min(cover(gs.cpu, base.cpu), cover(gs.mem, base.mem))
    if (c < MIN_COVERAGE) return `its history covers only ${Math.round(c * 100)}% of the window`
    return null
  }
  /**
   * A guest the history saw on another node, with no recorded move to explain it (an HA recovery after a failure, a
   * move made elsewhere): where its load was is not known, so it is left alone until fresh history on its node
   * covers most of the window.
   */
  const relocated = (g: GuestPlacement): string | null => {
    const locs = input.locations?.[g.sid]
    if (!locs) return null
    const away = locs.filter(l => l.node !== g.node)
    if (!away.length) return null
    const lastAway = Math.max(...away.map(l => l.last))
    if ((input.past ?? []).some(m => m.sid === g.sid && m.to === g.node && m.at >= lastAway - 2 * input.stepSec)) return null
    const times = [...(series.get(g.node)?.cpu.keys() ?? [])]
    const fresh = times.filter(t => t > lastAway).length / Math.max(1, times.length)
    if (fresh >= MIN_COVERAGE) return null
    return `it was on ${away[away.length - 1].node} until recently and no move of it is recorded (an HA recovery?): left alone until fresh history covers the window`
  }
  return { s, goal, caps, series, gseries, counted, live, state, at, loadOf, loads, trial, unmeasured, relocated }
}

/**
 * The check right before one planned move runs, against the cluster as it is then (finished moves replayed): it must
 * still be allowed, keep the target under the line and no worse off than the source, and still help.
 */
export function checkStep(input: BalanceInput, sid: string, to: string): { ok: boolean; why: string; gain: number } {
  const c = context(input)
  const g = input.map.guests.find(x => x.sid === sid)
  if (!g) return { ok: false, why: `${sid} is no longer in the cluster`, gain: 0 }
  const ex = exclusion(g, !!input.auto) ?? c.unmeasured(g) ?? c.relocated(g)
  if (ex) return { ok: false, why: `${g.name || sid}: ${ex}`, gain: 0 }
  const t = c.trial(g, to, scoreOf(c.loads(), c.goal))
  if (typeof t === 'string') return { ok: false, why: `${g.name || sid}: ${t}`, gain: 0 }
  if (t.kind !== 'move') return { ok: false, why: `${g.name || sid}: only a change to its HA rule would let it go to ${to}`, gain: 0 }
  if (t.gain <= 0) return { ok: false, why: `${g.name || sid}: moving it to ${to} would no longer even out the load (${round1(t.gain)} points)`, gain: t.gain }
  return { ok: true, why: '', gain: t.gain }
}

export function balance(input: BalanceInput): BalanceResult {
  const c = context(input)
  const { s, goal, series, gseries, counted, live, state, at, loadOf, loads, trial, unmeasured, relocated } = c
  const unread: string[] = []
  for (const n of input.map.nodes) if (n.online && !n.maintenance && !counted(n)) unread.push(`history for ${n.node}`)
  const score = scoreOf(loads(), goal)
  // The most recent stretch, for "uneven for a sustained time" (before the plan changes the state).
  const recent = recentUneven(live.map(n => state.get(n.node)!), goal, s.unevenAbove, input.recentHours ?? 0, input.endSec ?? 0, input.stepSec)

  // The nodes, for the page. The sparklines are what was measured; the bars are the cluster as it is now.
  const now = loads()
  const cpuWork = (n: PlacementNode, v: number) => v * (n.threads || 0)
  const memUsed = (n: PlacementNode, v: number) => v * (n.maxmem || 0)
  const totalCpu = live.reduce((a, n) => a + cpuWork(n, now.find(l => l.node === n.node)!.cpu), 0)
  const totalMem = live.reduce((a, n) => a + memUsed(n, now.find(l => l.node === n.node)!.mem), 0)
  const raw = new Map(input.nodes.map(n => [n.node, { cpu: keep(n.cpu, input.masked), mem: keep(n.mem, input.masked) }]))
  const nodes: NodeLoad[] = input.map.nodes.map(n => {
    const sr = series.get(n.node), l = now.find(x => x.node === n.node), ok = counted(n)
    return {
      node: n.node, online: n.online, maintenance: n.maintenance, counted: ok, threads: n.threads, maxmem: n.maxmem,
      cpu: { now: n.cpu, p95: l?.cpu ?? 0, mean: sr ? mean([...sr.cpu.values()]) : 0 },
      mem: { now: n.maxmem ? n.mem / n.maxmem : 0, p95: l?.mem ?? 0, mean: sr ? mean([...sr.mem.values()]) : 0 },
      cpuShare: ok && totalCpu > 0 ? cpuWork(n, l!.cpu) / totalCpu : 0,
      memShare: ok && totalMem > 0 ? memUsed(n, l!.mem) / totalMem : 0,
      history: raw.has(n.node) ? { cpu: hourly(raw.get(n.node)!.cpu), mem: hourly(raw.get(n.node)!.mem) } : { cpu: [], mem: [] },
    }
  })

  // --- the plan ---------------------------------------------------------------------------------
  const auto = !!input.auto
  const words: string[] = []
  const left: string[] = []
  const crsOn = input.map.crs.mode === 'dynamic' && input.map.crs.autoRebalance
  const haGuests = input.map.guests.filter(g => g.ha && !g.template)
  if (haGuests.length) {
    if (crsOn) words.push(`Proxmox's own scheduler (CRS) has auto-rebalance on: it already moves the ${haGuests.length} HA guest${haGuests.length === 1 ? '' : 's'} when a node gets busy. HyperProx leaves them to it and balances with the guests HA does not manage; a second balancer for HA guests would fight it.`)
    else if (auto) words.push(`Automatic balancing moves only guests HA does not manage. For the ${haGuests.length} HA guest${haGuests.length === 1 ? '' : 's'} it suggests a move or a rule change, and a person decides.`)
    else words.push("Proxmox's own scheduler (CRS) is not set to auto-rebalance, so HA guests can be part of a plan: they move through HA (as ha-manager migrate does), and their HA rules still decide where they may go.")
  }
  const shared = input.map.network.shared !== false
  const notMeasured: string[] = []
  const unsure: string[] = []
  const excluded = new Map<string, string>()
  const cands: GuestPlacement[] = []
  /** In automatic mode, HA guests that could move: suggested to a person, never moved. */
  const suggestOnly: GuestPlacement[] = []
  for (const g of input.map.guests) {
    const why = exclusion(g, auto)
    const haInAuto = auto && g.ha && !exclusion(g, false)
    if (why && !haInAuto) { excluded.set(g.sid, why); continue }
    if (!g.targets.some(t => routeTo(g, t.node))) {
      const block = g.targets.flatMap(t => t.reasons).find(r => r.level === 'block' || r.level === 'unknown')
      excluded.set(g.sid, block ? block.words.replace(/\.$/, '') : 'no other node fits')
      continue
    }
    const gs = gseries.get(g.sid)
    if (!gs || (!gs.cpu.size && !gs.mem.size)) { notMeasured.push(g.name || g.sid); continue }
    if (!live.some(n => n.node === g.node)) { excluded.set(g.sid, `its node ${g.node} is not counted`); continue }
    const thin = unmeasured(g) ?? relocated(g)
    if (thin) { excluded.set(g.sid, thin); unsure.push(`${g.name || g.sid}: ${thin}`); continue }
    if (haInAuto) { excluded.set(g.sid, why!); suggestOnly.push(g); continue }
    cands.push(g)
  }
  if (unsure.length) left.push(`Left alone, history not good enough: ${unsure.slice(0, 4).join('; ')}${unsure.length > 4 ? '…' : ''}.`)
  if (notMeasured.length) left.push(`${notMeasured.length} running guest${notMeasured.length === 1 ? ' has' : 's have'} no history and ${notMeasured.length === 1 ? 'stays' : 'stay'} where ${notMeasured.length === 1 ? 'it is' : 'they are'}: ${notMeasured.slice(0, 6).join(', ')}${notMeasured.length > 6 ? '…' : ''}.`)

  const moved = new Set<string>()
  const gload = (g: GuestPlacement) => { const gs = gseries.get(g.sid)!; return { cores: p95([...gs.cpu.values()]), mem: p95([...gs.mem.values()]) } }

  const steps: PlanStep[] = []
  let cur = score
  const cap = Math.max(1, Math.min(10, Math.round(s.maxPlanMoves || 5)))
  let capped = false
  for (;;) {
    if (steps.length >= cap) { capped = true; break }
    let best: Trial | null = null
    for (const g of cands) {
      if (moved.has(g.sid)) continue
      if (auto && g.ha) continue
      for (const n of live) {
        if (n.node === at.get(g.sid)) continue
        const t = trial(g, n.node, cur)
        if (typeof t === 'string' || t.kind !== 'move' || t.gain < s.minGain) continue
        const better = !best || t.gain > best.gain + 1e-9
          || (Math.abs(t.gain - best.gain) <= 1e-9 && (t.g.copyBytes < best.g.copyBytes || (t.g.copyBytes === best.g.copyBytes && !t.g.ha && best.g.ha)))
        if (better) best = t
      }
    }
    if (!best) break
    const g = best.g, from = at.get(g.sid)!
    state.set(from, best.fromS); state.set(best.to, best.toS)
    at.set(g.sid, best.to); moved.add(g.sid)
    const method: PlanStep['method'] = g.ha ? 'ha' : 'migrate'
    const bw = method === 'ha' ? input.map.network.datacenterBwlimit : shared ? s.bwlimitKiB : null
    const copySec = copySeconds(g.copyBytes, s.linkMbps, bw)
    const l = gload(g)
    const amount = `${l.cores.toFixed(1)} cores and ${(l.mem / 1024 ** 3).toFixed(1)} GiB at its 95th percentile`
    const t = g.targets.find(x => x.node === best!.to)
    steps.push({
      n: steps.length + 1, sid: g.sid, name: g.name, type: g.type, ha: g.ha, from, to: best.to, method, load: l,
      before: best.before, after: best.after, gain: best.gain, scoreAfter: best.score.score,
      downtimeSec: g.downtimeSec, copyBytes: g.copyBytes, copySec, bwlimitKiB: method === 'ha' ? null : bw,
      why: [
        `${g.name || g.sid} uses ${amount}.`,
        `${from}: ${pct(best.before.from.cpu)} CPU and ${pct(best.before.from.mem)} memory → ${pct(best.after.from.cpu)} and ${pct(best.after.from.mem)}. ${best.to}: ${pct(best.before.to.cpu)} and ${pct(best.before.to.mem)} → ${pct(best.after.to.cpu)} and ${pct(best.after.to.mem)}.`,
        ...(t?.reasons.filter(r => r.level === 'warn').map(r => r.words) ?? []),
        ...(method === 'ha' ? ['HA manages it: it moves through HA, so HA does not move it straight back.'] : []),
      ],
    })
    cur = best.score
  }

  // Suggestions the plan does not carry out: HA guests held by their own preferred-node rule, and in automatic mode
  // HA guests at all. Worked out against the state after the plan, one per guest.
  const suggestions: BalanceSuggestion[] = []
  for (const g of [...cands, ...suggestOnly]) {
    if (moved.has(g.sid) || !g.ha) continue
    let best: Trial | null = null
    for (const n of live) {
      if (n.node === at.get(g.sid)) continue
      const t = trial(g, n.node, cur)
      if (typeof t === 'string' || t.gain < s.minGain) continue
      if (t.kind === 'move' && !auto) continue
      if (!best || t.gain > best.gain) best = t
    }
    if (!best) continue
    const rule = /"([^"]+)"/.exec(g.targets.find(x => x.node === best!.to)?.reasons.find(r => r.code === 'prefer-rule')?.words ?? '')?.[1]
    suggestions.push(best.kind === 'edit-rule'
      ? { kind: 'edit-rule', sid: g.sid, name: g.name, from: g.node, to: best.to, ...(rule ? { rule } : {}), gain: best.gain,
          words: `${g.name || g.sid} is held on ${g.node} by its HA rule${rule ? ` "${rule}"` : ''}. Changing the rule to prefer ${best.to} would add about ${round1(best.gain)} points; HA then moves it itself. HyperProx does not change HA rules on its own.` }
      : { kind: 'ha-move', sid: g.sid, name: g.name, from: g.node, to: best.to, gain: best.gain,
          words: `Moving the HA guest ${g.name || g.sid} from ${g.node} to ${best.to} would add about ${round1(best.gain)} points. Automatic balancing does not move HA guests: move it yourself, or let HA's own rules decide.` })
  }
  suggestions.sort((a, b) => b.gain - a.gain).splice(3)

  // Why the plan stops here.
  if (capped) left.push(`The plan stops at ${cap} moves (the limit in Settings).`)
  else if (score.spread * 100 > 0 && !steps.length) left.push(`No move would raise the score by at least ${s.minGain} points without making another node busy or worse off than the one it relieves.`)
  else if (steps.length) left.push(`After these, no further move gains at least ${s.minGain} points.`)
  const busiest = score.busiest
  if (busiest) {
    const stuck = input.map.guests.filter(g => g.node === busiest && excluded.has(g.sid) && g.status === 'running' && !g.template)
      .sort((a, b) => b.usage.mem - a.usage.mem).slice(0, 4)
    if (stuck.length) left.push(`On ${busiest}, staying put: ${stuck.map(g => `${g.name || g.sid} (${excluded.get(g.sid)})`).join('; ')}.`)
  }
  const nodesAfter: NodeAfter[] = live.map(n => ({ node: n.node, ...loadOf(state.get(n.node)!) }))
  const needSec = steps.reduce((a, x) => a + (x.downtimeSec ?? 0) + x.copySec + 120, 0)
  const plan: BalancePlan = { goal, score, target: cur, steps, suggestions, nodesAfter, needSec, left, words }

  // --- the headline -----------------------------------------------------------------------------
  const uneven = live.length >= 2 && score.spread > s.unevenAbove
  const headline = headlineOf(nodes, score, goal, uneven, s.unevenAbove)

  if (!live.length) unread.push('history for every node')
  return { goal, uneven, headline, nodes, score, plan, recent, unread }
}

export function headlineOf(nodes: NodeLoad[], score: BalanceScore, goal: BalanceGoal, uneven: boolean, unevenAbove: number): string {
  const live = nodes.filter(n => n.counted)
  if (!live.length) return 'No history: HyperProx cannot tell how the load is spread.'
  if (live.length < 2) return `Only ${live[0].node} has history, so there is nothing to balance against.`
  if (!uneven) return `Balanced: ${goalWord(goal)} within ${pts(score.spread)} points across ${live.length} nodes (uneven past ${pts(unevenAbove)}).`
  // Name the metric with the wider spread (or the goal's own), its busiest node, its share of the load, and the idlest.
  const m: 'cpu' | 'mem' = goal === 'both' ? (score.memSpread >= score.cpuSpread ? 'mem' : 'cpu') : goal
  const top = [...live].sort((a, b) => b[m].p95 - a[m].p95)
  const hi = top[0], lo = top[top.length - 1]
  const share = m === 'mem' ? hi.memShare : hi.cpuShare
  return `Uneven: ${hi.node} carries ${pct(share)} of the ${m === 'mem' ? 'memory in use' : 'CPU work'} and runs at ${pct(hi[m].p95)} of its own; ${lo.node} at ${pct(lo[m].p95)}.`
}

/** Hours, in the last `hours`, that the spread was above the line (and the hours of readings looked at). */
export function recentUneven(nodes: Series[], goal: BalanceGoal, above: number, hours: number, endSec: number, stepSec: number): { hours: number; covered: number } {
  if (!hours || nodes.length < 2 || !stepSec) return { hours: 0, covered: 0 }
  const from = endSec - hours * 3600
  const times = [...nodes[0].cpu.keys()].filter(t => t > from)
  let n = 0, over = 0
  for (const t of times) {
    const c = nodes.map(x => x.cpu.get(t)), mm = nodes.map(x => x.mem.get(t))
    if (c.some(v => v === undefined) || mm.some(v => v === undefined)) continue
    const cs = Math.max(...(c as number[])) - Math.min(...(c as number[]))
    const ms = Math.max(...(mm as number[])) - Math.min(...(mm as number[]))
    const sp = goal === 'cpu' ? cs : goal === 'mem' ? ms : (cs + ms) / 2
    n++
    if (sp > above) over++
  }
  return { hours: (over * stepSec) / 3600, covered: (n * stepSec) / 3600 }
}

/** The steps of two plans as a comparable list: the order and the targets. */
export const planSignature = (steps: Array<{ sid: string; to: string }>) => steps.map(x => `${x.sid}>${x.to}`).join(',')
