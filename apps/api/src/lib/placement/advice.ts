// =============================================================================
//  HyperProx — placement advisor: real imbalance, over hours, not a snapshot
//
//  A node is busy when it spent at least `minHours` of the last `windowHours`
//  above the CPU or memory threshold, with backup windows left out (a backup
//  makes every node busy for an hour every night, and that is not imbalance).
//  A spike, however tall, is not sustained and suggests nothing.
//
//  A suggestion moves one guest off a busy node to one with room. Its effect is
//  worked out from the guest's own measured usage: the busy node's series less
//  the guest's, the target's series plus it. A move that would make the target
//  busy instead is never suggested.
//
//  What it never suggests: anything that fights Proxmox. An HA guest that the
//  dynamic CRS already balances is left to it. An HA guest whose rule prefers
//  the busy node gets "change the rule" instead of a move (a hand move to a
//  lower-ranked node is refused by Proxmox, and failback undoes it).
//
//  Pure: series in, advice out.
// =============================================================================

import type { Advice, GuestPlacement, GuestSeries, NodeSeries, PlacementMap, PlacementNode, PlacementSettings, Pressure, Sample, Suggestion } from './types'

type Settings = Pick<PlacementSettings, 'cpuAbove' | 'memAbove' | 'minHours' | 'windowHours'>

const pct = (v: number) => `${Math.round(v * 100)}%`
const hrs = (h: number) => (h >= 10 ? `${Math.round(h)}` : `${Math.round(h * 10) / 10}`)

function p95(vs: number[]): number {
  if (!vs.length) return 0
  const s = [...vs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]
}

/** Samples outside the backup windows, as a time → value map. */
function keep(samples: Sample[], masked: (sec: number) => boolean): Map<number, number> {
  const m = new Map<number, number>()
  for (const [t, v] of samples) if (Number.isFinite(v) && !masked(t)) m.set(t, v)
  return m
}

function hoursAbove(series: Map<number, number>, thr: number, stepSec: number): number {
  let n = 0
  for (const v of series.values()) if (v > thr) n++
  return (n * stepSec) / 3600
}

export function pressureOf(node: string, cpu: Map<number, number>, mem: Map<number, number>, s: Settings, stepSec: number): Pressure {
  const cpuHours = hoursAbove(cpu, s.cpuAbove, stepSec)
  const memHours = hoursAbove(mem, s.memAbove, stepSec)
  const covered = (Math.max(cpu.size, mem.size) * stepSec) / 3600
  const kind: Pressure['kind'] = []
  if (cpuHours >= s.minHours) kind.push('cpu')
  if (memHours >= s.minHours) kind.push('mem')
  const cpuP95 = p95([...cpu.values()]), memP95 = p95([...mem.values()])
  const words = `${node}: CPU above ${pct(s.cpuAbove)} for ${hrs(cpuHours)} h (95th percentile ${pct(cpuP95)}); memory above ${pct(s.memAbove)} for ${hrs(memHours)} h (95th percentile ${pct(memP95)}), over ${hrs(covered)} h of readings.`
  return { node, cpuHours, memHours, covered, busy: kind.length > 0, kind, cpuP95, memP95, words }
}

/** The node's series with a guest's usage added (sign 1) or taken away (sign -1), as a share of the node. */
function shifted(base: Map<number, number>, guest: Map<number, number>, capacity: number, sign: 1 | -1): Map<number, number> {
  const out = new Map<number, number>()
  for (const [t, v] of base) {
    // The range queries share one start and step, so the times line up; the nearest reading covers a gap.
    const g = guest.get(t) ?? guestAt(guest, t)
    out.set(t, Math.max(0, v + (sign * g) / Math.max(1e-9, capacity)))
  }
  return out
}

/** The guest's reading nearest to t (series are scraped on their own clocks). */
function guestAt(m: Map<number, number>, t: number): number {
  let best = 0, gap = Infinity
  for (const [k, v] of m) { const d = Math.abs(k - t); if (d < gap) { gap = d; best = v } }
  return gap <= 600 ? best : 0
}

export interface AdviceInput {
  map:      PlacementMap
  nodes:    NodeSeries[]
  guests:   GuestSeries[]
  /** True for a sample time (unix seconds) inside a backup window: left out. */
  masked:   (sec: number) => boolean
  settings: Settings
  stepSec:  number
  unread?:  string[]
}

/** Can this guest go to this node, for a suggestion? "move", "edit-rule" or null. */
function route(g: GuestPlacement, to: string): 'move' | 'edit-rule' | null {
  if (g.template || g.status !== 'running') return null
  if (g.everywhere.some(r => r.level === 'block' || r.code === 'crs')) return null
  const t = g.targets.find(x => x.node === to)
  if (!t) return null
  if (t.verdict === 'ok') return 'move'
  // Blocked only by its own preferred-node rule: change the rule, do not fight it.
  const blocks = t.reasons.filter(r => r.level === 'block' || r.level === 'unknown')
  if (g.ha && blocks.length && blocks.every(r => r.code === 'prefer-rule')) return 'edit-rule'
  return null
}

export function advise(input: AdviceInput): Advice {
  const { map, settings: s, stepSec } = input
  const unread = [...(input.unread ?? [])]
  const nodeById = new Map<string, PlacementNode>(map.nodes.map(n => [n.node, n]))
  const series = new Map<string, { cpu: Map<number, number>; mem: Map<number, number> }>()
  for (const n of input.nodes) series.set(n.node, { cpu: keep(n.cpu, input.masked), mem: keep(n.mem, input.masked) })
  const gseries = new Map<string, { cores: Map<number, number>; mem: Map<number, number> }>()
  for (const g of input.guests) gseries.set(g.sid, { cores: keep(g.cores, input.masked), mem: keep(g.mem, input.masked) })

  let skipped = 0
  for (const n of input.nodes) skipped = Math.max(skipped, n.cpu.filter(([t]) => input.masked(t)).length)
  const backupHoursSkipped = (skipped * stepSec) / 3600

  const pressure: Pressure[] = []
  for (const n of map.nodes) {
    const sr = series.get(n.node)
    if (!sr || (!sr.cpu.size && !sr.mem.size)) { unread.push(`history for ${n.node}`); continue }
    const p = pressureOf(n.node, sr.cpu, sr.mem, s, stepSec)
    if (p.covered < Math.min(12, s.windowHours / 2)) { unread.push(`enough history for ${n.node} (only ${hrs(p.covered)} h)`); p.busy = false; p.kind = [] }
    pressure.push(p)
  }

  const suggestions: Suggestion[] = []
  const stuck: string[] = []
  const used = new Set<string>()
  for (const p of pressure.filter(x => x.busy)) {
    for (const metric of p.kind) {
      const from = nodeById.get(p.node)!
      const key = metric === 'cpu' ? 'cpu' : 'mem'
      const thr = metric === 'cpu' ? s.cpuAbove : s.memAbove
      const cap = (n: PlacementNode) => (metric === 'cpu' ? n.threads : n.maxmem)
      let fromSeries = series.get(from.node)![key]
      let before = hoursAbove(fromSeries, thr, stepSec)
      const startBefore = before
      const here = map.guests.filter(g => g.node === from.node && !used.has(g.sid))
      // Biggest users first: they make the most difference with the fewest moves.
      const usage = (g: GuestPlacement) => {
        const gs = gseries.get(g.sid)
        const m = gs ? (metric === 'cpu' ? gs.cores : gs.mem) : null
        if (!m || !m.size) return 0
        // Its usage during the node's busy samples, which is what moving it relieves.
        const busyT = [...fromSeries].filter(([, v]) => v > thr).map(([t]) => t)
        const vals = busyT.map(t => m.get(t) ?? guestAt(m, t))
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0
      }
      const ranked = here.map(g => ({ g, u: usage(g) })).filter(x => x.u > 0).sort((a, b) => b.u - a.u)
      let made = 0
      for (const { g, u } of ranked) {
        if (made >= 3 || before < s.minHours) break
        const gs = gseries.get(g.sid)!
        const gm = metric === 'cpu' ? gs.cores : gs.mem
        let best: { to: PlacementNode; kind: 'move' | 'edit-rule'; toBefore: number; toAfter: number; fromAfter: number; toP95: number } | null = null
        for (const to of map.nodes) {
          if (to.node === from.node || !to.online || to.maintenance) continue
          const kind = route(g, to.node)
          if (!kind) continue
          const ts = series.get(to.node)?.[key]
          if (!ts || !ts.size) continue
          const toAfterSeries = shifted(ts, gm, cap(to), 1)
          const toAfter = hoursAbove(toAfterSeries, thr, stepSec)
          const toP95 = p95([...toAfterSeries.values()])
          if (toAfter >= s.minHours || toP95 >= thr) continue
          const fromAfter = hoursAbove(shifted(fromSeries, gm, cap(from), -1), thr, stepSec)
          if (fromAfter >= before) continue
          // Prefer a move over a rule change, then the target left with the most room.
          if (!best || (best.kind === 'edit-rule' && kind === 'move') || (best.kind === kind && toP95 < best.toP95)) {
            best = { to, kind, toBefore: hoursAbove(ts, thr, stepSec), toAfter, fromAfter, toP95 }
          }
        }
        if (!best) continue
        const t = g.targets.find(x => x.node === best!.to.node)!
        const amount = metric === 'cpu' ? `${u.toFixed(1)} cores` : `${(u / 1024 ** 3).toFixed(1)} GiB`
        const w = [
          `${from.node} was above ${pct(thr)} ${metric === 'cpu' ? 'CPU' : 'memory'} for ${hrs(before)} of the last ${s.windowHours} hours (backup windows left out); ${g.name || g.sid} used ${amount} during those hours.`,
          `${best.to.node} has room: its 95th percentile would be ${pct(best.toP95)} with ${g.name || g.sid} added, and it would spend ${hrs(best.toAfter)} h above ${pct(thr)}.`,
          ...t.reasons.filter(r => r.level === 'warn').map(r => r.words),
        ]
        const home = g.targets.find(x => x.node === best!.to.node)?.reasons.find(r => r.code === 'prefer-rule')
        if (best.kind === 'edit-rule') w.push(`It is an HA guest whose rule keeps it on ${from.node}: change the rule to prefer ${best.to.node} and HA moves it itself. A plain move would be refused, or undone by failback.`)
        suggestions.push({
          kind: best.kind, sid: g.sid, name: g.name, from: from.node, to: best.to.node, why: w,
          effect: { from: { before, after: best.fromAfter }, to: { before: best.toBefore, after: best.toAfter }, metric },
          ...(best.kind === 'edit-rule' && home ? { rule: /"([^"]+)"/.exec(home.words)?.[1] } : {}),
        })
        used.add(g.sid)
        made++
        fromSeries = shifted(fromSeries, gm, cap(from), -1)
        before = best.fromAfter
        // The target now carries the guest too, for the next suggestion.
        const tsr = series.get(best.to.node)!
        tsr[key] = shifted(tsr[key], gm, cap(best.to), 1)
      }
      if (!made) {
        const reasons = Array.from(new Set(here.filter(g => g.status === 'running').map(g =>
          g.everywhere.some(r => r.code === 'crs') ? `${g.name || g.sid}: left to Proxmox's own HA scheduler` : `${g.name || g.sid}: ${g.summary.replace(/^Stays on [^:]+: /, '')}`)))
        stuck.push(`${from.node} has been busy (${metric === 'cpu' ? 'CPU' : 'memory'} above ${pct(thr)} for ${hrs(startBefore)} h), but no move would help without making another node busy.${reasons.length ? ' ' + reasons.slice(0, 6).join(' ') : ''}`)
      }
    }
  }
  const busy = pressure.filter(p => p.busy)
  const balanced = busy.length === 0
  const headline = balanced
    ? 'Balanced: nothing to do.'
    : suggestions.length ? `${busy.map(p => p.node).join(', ')} ${busy.length === 1 ? 'has' : 'have'} been busy: ${suggestions.length} suggestion${suggestions.length === 1 ? '' : 's'}.`
      : `${busy.map(p => p.node).join(', ')} ${busy.length === 1 ? 'has' : 'have'} been busy, but nothing can usefully move.`
  const evidence = [
    `Looked at the last ${s.windowHours} hours in ${Math.round(stepSec / 60)}-minute steps; ${hrs(backupHoursSkipped)} h of backup windows left out.`,
    `A node counts as busy after ${s.minHours} h above ${pct(s.cpuAbove)} CPU or ${pct(s.memAbove)} memory.`,
    ...pressure.map(p => p.words),
  ]
  return {
    balanced, headline, pressure, suggestions, stuck, evidence, unread,
    window: { hours: s.windowHours, stepSec, cpuAbove: s.cpuAbove, memAbove: s.memAbove, minHours: s.minHours, backupHoursSkipped },
  }
}
