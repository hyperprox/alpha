// =============================================================================
//  HyperProx — where would it go? HA's node choice, worked out in advance
//
//  A copy of PVE 9.2's select_service_node (PVE/HA/Manager.pm) over a
//  snapshot: node affinity (highest online priority class; non-strict adds
//  every other node at -1), then keep-apart removes nodes a partner runs on,
//  then keep-together narrows to where the partners are, then the CRS score.
//  The score is the one thing that is approximated: "basic" counts HA guests
//  per node exactly; "static" and "dynamic" use load PVE samples itself, so
//  this uses memory and CPU from /nodes and says "most likely" when more than
//  one node qualifies.
// =============================================================================

import { allowedBy, homeOf, list, togetherGroups } from './rules'
import type { HaRule, HaSnapshot, NodeAffinityRule, ResourceAffinityRule, Sid } from './types'

export interface Prediction {
  sid:        Sid
  from:       string
  /** Where HA would start it; null when no node is allowed. */
  to:         string | null
  /** Every node that would qualify, best first. */
  candidates: string[]
  /** Guests that would go with it (kept together). */
  comigrate:  Sid[]
  words:      string
}

/** Node → priority for one guest, as PVE compiles its node-affinity rule; null = no rule (every node equal). */
export function effectiveNodes(rules: HaRule[], sid: Sid, clusterNodes: string[]): Map<string, number> | null {
  const r = rules.find((x): x is NodeAffinityRule => x.type === 'node-affinity' && !x.disabled && x.resources.includes(sid))
  if (!r) return null
  const m = new Map<string, number>()
  if (r.affinity === 'negative') {
    for (const n of allowedBy(r, clusterNodes)) m.set(n, 0)
    if (!r.strict) for (const n of r.nodes) m.set(n.node, -1)
  } else {
    for (const n of r.nodes) m.set(n.node, n.priority)
    if (!r.strict) for (const n of clusterNodes) if (!m.has(n)) m.set(n, -1)
  }
  return m
}

/** Nodes in the highest online priority class, and every allowed online node. */
export function preferredNodes(rules: HaRule[], sid: Sid, clusterNodes: string[], online: Set<string>): { allowed: string[]; preferred: string[] } {
  const eff = effectiveNodes(rules, sid, clusterNodes)
  if (!eff) { const all = clusterNodes.filter(n => online.has(n)); return { allowed: all, preferred: all } }
  const up = [...eff.entries()].filter(([n]) => online.has(n))
  if (!up.length) return { allowed: [], preferred: [] }
  const top = Math.max(...up.map(([, p]) => p))
  return { allowed: up.map(([n]) => n).sort(), preferred: up.filter(([, p]) => p === top).map(([n]) => n).sort() }
}

function partners(rules: HaRule[], sid: Sid): { together: Set<Sid>; apart: Set<Sid> } {
  const together = new Set<Sid>(); const apart = new Set<Sid>()
  for (const g of togetherGroups(rules)) if (g.resources.has(sid)) g.resources.forEach(s => s !== sid && together.add(s))
  for (const r of rules) {
    if (r.type !== 'resource-affinity' || r.disabled || r.affinity !== 'negative' || !r.resources.includes(sid)) continue
    ;(r as ResourceAffinityRule).resources.forEach(s => s !== sid && apart.add(s))
  }
  return { together, apart }
}

const active = (state: string) => !['stopped', 'disabled', 'ignored', 'error'].includes(state)

/** Where each HA guest is (or is headed), from the HA status. Falls back to the guest list. */
export function placement(snap: HaSnapshot): Map<Sid, { node: string; active: boolean }> {
  const m = new Map<Sid, { node: string; active: boolean }>()
  for (const g of snap.guests) m.set(g.sid, { node: g.node, active: g.status === 'running' })
  for (const s of snap.services) m.set(s.sid, { node: s.node, active: active(s.requestState) && active(s.state) })
  return m
}

/** CRS score: lower is better. */
function score(snap: HaSnapshot, node: string, sid: Sid, place: Map<Sid, { node: string; active: boolean }>, exclude: Set<Sid>): number {
  const count = snap.resources.filter(r => r.sid !== sid && !exclude.has(r.sid) && place.get(r.sid)?.node === node && place.get(r.sid)?.active).length
  if (snap.crs.mode === 'basic') return count
  const n = snap.nodes.find(x => x.node === node)
  const g = snap.guests.find(x => x.sid === sid)
  if (!n || !n.maxmem) return 1e6 + count
  const mem = (n.mem + (g?.maxmem ?? 0)) / n.maxmem
  return mem + n.cpu / Math.max(1, n.maxcpu) * 0.5 + count * 1e-3
}

/**
 * Where HA starts `sid` if `failed` (default: the node it is on now) goes down. Guests kept together that sit
 * on the failed node move with it; guests kept apart that run elsewhere close their nodes to it.
 */
export function predictFailover(snap: HaSnapshot, sid: Sid, failed?: string): Prediction {
  const place = placement(snap)
  const from = failed ?? place.get(sid)?.node ?? ''
  const clusterNodes = snap.nodes.map(n => n.node)
  const online = new Set(snap.nodes.filter(n => n.online && !n.maintenance && n.node !== from).map(n => n.node))
  const { preferred } = preferredNodes(snap.rules, sid, clusterNodes, online)
  let pri = [...preferred]
  const { together, apart } = partners(snap.rules, sid)
  // Kept apart: no node where a partner runs.
  const apartNodes = new Set([...apart].map(s => place.get(s)).filter(p => p?.active && p.node !== from).map(p => p!.node))
  pri = pri.filter(n => !apartNodes.has(n))
  // Kept together: the most populated node among allowed partner nodes, if any partner runs elsewhere.
  const counts = new Map<string, number>()
  for (const s of together) { const p = place.get(s); if (p?.active && p.node !== from && pri.includes(p.node)) counts.set(p.node, (counts.get(p.node) ?? 0) + 1) }
  if (counts.size) { const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]; pri = [best] }
  // Too few CPUs: a node with fewer CPUs than the guest has vCPUs cannot start it.
  const cpus = snap.guests.find(g => g.sid === sid)?.cpus ?? 0
  const before = pri.length
  pri = pri.filter(n => { const nd = snap.nodes.find(x => x.node === n); return !cpus || !nd?.maxcpu || nd.maxcpu >= cpus })
  const cpuBlocked = before > pri.length
  const comigrate = [...together].filter(s => place.get(s)?.node === from)
  const exclude = new Set(comigrate)
  const candidates = pri.sort((a, b) => score(snap, a, sid, place, exclude) - score(snap, b, sid, place, exclude) || a.localeCompare(b))
  const to = candidates[0] ?? null
  return { sid, from, to, candidates, comigrate, words: failoverWords(snap, sid, from, to, candidates, cpuBlocked ? cpus : 0) }
}

function failoverWords(snap: HaSnapshot, sid: Sid, from: string, to: string | null, candidates: string[], cpuShort = 0): string {
  const home = homeOf(snap.rules, sid)
  if (!to) {
    if (cpuShort && home.choice.mode !== 'only') return `If ${from} fails there is no node it is allowed on with enough CPUs for its ${cpuShort} vCPUs, so it stays off.`
    if (home.choice.mode === 'only') return `If ${from} fails it stays off until ${list(home.choice.tiers.flat(), 'or')} is back: it may only run there.`
    return `If ${from} fails there is no node it is allowed on right now, so it stays off.`
  }
  const likely = candidates.length > 1 && snap.crs.mode !== 'basic'
    ? `it will most likely move to ${to} (HA picks among ${list(candidates, 'and')} by load)`
    : `it will move to ${to}`
  const tail = home.rule && !home.disabled ? '' : ', and stay there: it has no home to return to'
  return `If ${from} fails ${likely}${tail}.`
}

/** Where HA would put the guest right now under `rules`, when that differs from where it is: "it will move now". */
export function moveNow(snap: HaSnapshot, sid: Sid, rules: HaRule[]): { to: string | null; why: string } | null {
  const place = placement(snap)
  const here = place.get(sid)
  if (!here) return null
  const res = snap.resources.find(r => r.sid === sid)
  const clusterNodes = snap.nodes.map(n => n.node)
  const online = new Set(snap.nodes.filter(n => n.online && !n.maintenance).map(n => n.node))
  const { allowed, preferred } = preferredNodes(rules, sid, clusterNodes, online)
  if (!allowed.includes(here.node)) {
    const to = preferred[0] ?? null
    return { to, why: to ? `${here.node} is no longer allowed` : `${here.node} is no longer allowed and no allowed node is online` }
  }
  // Failback: HA moves a guest to its highest-priority online node whenever it is not on one.
  if ((res?.failback ?? true) && !preferred.includes(here.node)) {
    return { to: preferred[0] ?? null, why: `${list(preferred, 'or')} ${preferred.length > 1 ? 'are' : 'is'} preferred over ${here.node}` }
  }
  // Kept apart from a guest on the same node.
  const sameNode = rules.some(r => r.type === 'resource-affinity' && !r.disabled && r.affinity === 'negative' && r.resources.includes(sid)
    && r.resources.some(s => s !== sid && place.get(s)?.node === here.node && place.get(s)?.active))
  if (sameNode && here.active) return { to: null, why: `a guest it must be kept apart from runs on ${here.node} too, so one of them moves` }
  return null
}
