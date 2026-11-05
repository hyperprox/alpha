// =============================================================================
//  HyperProx — HA rules: simple choices ↔ PVE rules, and the checks PVE runs
//
//  The panel speaks in homes ("prefer node A, then B") and in "keep apart" /
//  "keep together". PVE speaks in node-affinity rules with weighted priorities
//  and resource-affinity rules. This file is the translation both ways, and a
//  local copy of PVE 9.2's feasibility checks (PVE/HA/Rules.pm and the two
//  plugins), so a rule PVE would refuse is never sent, and a rule PVE would
//  silently drop at runtime is never created.
//
//  PVE semantics this mirrors:
//    - a node without a priority is priority 0; the highest priority class that
//      is online wins; non-strict rules add every other node at priority -1;
//    - one node-affinity rule per resource;
//    - a resource in a resource-affinity rule may not be in a node-affinity
//      rule with more than one priority ("weighted");
//    - connected positive resource-affinity rules are merged; a merged group
//      may meet at most one node-affinity rule, and may not share two guests
//      with a negative rule;
//    - a negative rule may not hold more guests than the cluster has nodes, or
//      than the nodes their node-affinity rules leave them;
//    - disabled rules take no part in any of it.
// =============================================================================

import type { HaRule, HomeChoice, NodeAffinityRule, NodePriority, ResourceAffinityRule, RuleProblem, Sid } from './types'

export const RULE_ID = /^[A-Za-z][A-Za-z0-9_-]{1,63}$/

// --- homes --------------------------------------------------------------------------------------------

export interface HomeView {
  rule:    NodeAffinityRule | null
  choice:  HomeChoice
  /** The rule says "avoid these nodes" (negative node affinity): shown, edited only under Advanced. */
  avoid:   string[]
  /** The rule is turned off in Proxmox: it counts for nothing until turned on. */
  disabled: boolean
  /** Other guests in the same node-affinity rule: a change to this guest's home splits it out. */
  sharedWith: Sid[]
}

/** The tiers of a positive rule: highest priority first, names sorted inside a tier. */
export function tiersOf(nodes: NodePriority[]): string[][] {
  const by = new Map<number, string[]>()
  for (const n of nodes) by.set(n.priority, [...(by.get(n.priority) ?? []), n.node])
  return Array.from(by.entries()).sort((a, b) => b[0] - a[0]).map(([, ns]) => ns.sort())
}

/** Priorities for tiers: one tier is flat (no priorities), otherwise first tier highest. */
export function prioritiesOf(tiers: string[][]): NodePriority[] {
  const clean = tiers.map(t => t.filter(Boolean)).filter(t => t.length)
  if (clean.length <= 1) return (clean[0] ?? []).map(node => ({ node, priority: 0 }))
  return clean.flatMap((t, i) => t.map(node => ({ node, priority: clean.length - i })))
}

export const isWeighted = (r: NodeAffinityRule) => new Set(r.nodes.map(n => n.priority)).size > 1

export function homeOf(rules: HaRule[], sid: Sid): HomeView {
  const all = rules.filter((r): r is NodeAffinityRule => r.type === 'node-affinity' && r.resources.includes(sid))
  const rule = all.find(r => !r.disabled) ?? all[0] ?? null
  if (!rule) return { rule: null, choice: { mode: 'none', tiers: [] }, avoid: [], disabled: false, sharedWith: [] }
  const sharedWith = rule.resources.filter(s => s !== sid)
  if (rule.affinity === 'negative') {
    return { rule, choice: { mode: 'none', tiers: [] }, avoid: rule.nodes.map(n => n.node).sort(), disabled: rule.disabled, sharedWith }
  }
  return { rule, choice: { mode: rule.strict ? 'only' : 'prefer', tiers: tiersOf(rule.nodes) }, avoid: [], disabled: rule.disabled, sharedWith }
}

/** A home choice as a node-affinity rule for exactly one guest. */
export function homeRule(sid: Sid, id: string, choice: HomeChoice, comment?: string): NodeAffinityRule {
  return {
    id, type: 'node-affinity', affinity: 'positive', strict: choice.mode === 'only',
    nodes: prioritiesOf(choice.tiers), resources: [sid], disabled: false, ...(comment ? { comment } : {}),
  }
}

/** The fix PVE's weighted-priority conflict needs: every listed node becomes an equal choice. */
export function flatten(rule: NodeAffinityRule): NodeAffinityRule {
  return { ...rule, nodes: rule.nodes.map(n => ({ node: n.node, priority: 0 })) }
}

/** A free rule id from a base: "ha-<base>", then "-2", "-3"... */
export function freeRuleId(rules: HaRule[], base: string): string {
  const stem = `ha-${base}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 56)
  const taken = new Set(rules.map(r => r.id))
  if (!taken.has(stem)) return stem
  for (let i = 2; ; i++) if (!taken.has(`${stem}-${i}`)) return `${stem}-${i}`
}

// --- words --------------------------------------------------------------------------------------------

export const list = (xs: string[], and = 'and') => xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} ${and} ${xs[xs.length - 1]}`

/** The home in one sentence, consequence first. */
export function homeWords(choice: HomeChoice, avoid: string[] = []): string {
  if (avoid.length) return `Runs anywhere except ${list(avoid, 'or')}.`
  if (choice.mode === 'none' || !choice.tiers.length) return 'No home: after a failover it stays wherever it lands.'
  const order = choice.tiers.map(t => t.length > 1 ? `any of ${list(t, 'or')}` : t[0])
  const pref = order.length > 1 ? `${order[0]}, then ${order.slice(1).join(', then ')}` : order[0]
  if (choice.mode === 'only') return `Only ever runs on ${pref}. If ${choice.tiers.flat().length > 1 ? 'all of them are' : 'it is'} down, it stays off.`
  return `Prefers ${pref}, but runs anywhere if needed.`
}

export function ruleWords(r: HaRule, label: (sid: Sid) => string = s => s): string {
  const who = list(r.resources.map(label))
  const off = r.disabled ? ' (turned off: it does nothing until turned on)' : ''
  if (r.type === 'resource-affinity') {
    return r.affinity === 'positive'
      ? `Keep ${who} together on one node. If one moves, the others go with it.${off}`
      : `Keep ${who} apart, each on a different node. Losing a node only takes one of them down.${off}`
  }
  if (r.affinity === 'negative') return `${who}: never on ${list(r.nodes.map(n => n.node), 'or')}${r.strict ? ', even if that means staying off' : ' unless nothing else is left'}.${off}`
  return `${who}: ${homeWords({ mode: r.strict ? 'only' : 'prefer', tiers: tiersOf(r.nodes) })}${off}`
}

// --- validation ---------------------------------------------------------------------------------------

export interface ValidateContext {
  /** Sids that are HA resources (PVE refuses a rule naming any other). */
  haSids:  Set<Sid>
  /** Sids of guests that exist at all. */
  guests:  Set<Sid>
  /** Every cluster node. */
  nodes:   string[]
  label?:  (sid: Sid) => string
}

const enabled = (rules: HaRule[]) => rules.filter(r => !r.disabled)
const na = (rules: HaRule[]) => enabled(rules).filter((r): r is NodeAffinityRule => r.type === 'node-affinity')
const ra = (rules: HaRule[], aff?: 'positive' | 'negative') =>
  enabled(rules).filter((r): r is ResourceAffinityRule => r.type === 'resource-affinity' && (!aff || r.affinity === aff))

/** Connected positive resource-affinity rules, merged as PVE merges them. */
export function togetherGroups(rules: HaRule[]): Array<{ ruleIds: string[]; resources: Set<Sid> }> {
  const groups: Array<{ ruleIds: string[]; resources: Set<Sid> }> = []
  for (const r of ra(rules, 'positive')) {
    const hit = groups.filter(g => r.resources.some(s => g.resources.has(s)))
    const merged = { ruleIds: [r.id, ...hit.flatMap(g => g.ruleIds)], resources: new Set<Sid>([...r.resources, ...hit.flatMap(g => [...g.resources])]) }
    for (const g of hit) groups.splice(groups.indexOf(g), 1)
    groups.push(merged)
  }
  return groups
}

/** The nodes a node-affinity rule allows (positive: the listed ones; negative: every other node). */
export function allowedBy(r: NodeAffinityRule, clusterNodes: string[]): string[] {
  const listed = new Set(r.nodes.map(n => n.node))
  return r.affinity === 'negative' ? clusterNodes.filter(n => !listed.has(n)) : [...listed]
}

/** Every problem in a rule set, as PVE would find it, in words. */
export function validateRules(rules: HaRule[], ctx: ValidateContext): RuleProblem[] {
  const label = ctx.label ?? ((s: Sid) => s)
  const nodeSet = new Set(ctx.nodes)
  const out: RuleProblem[] = []
  const seen = new Map<string, number>()
  for (const r of rules) seen.set(r.id, (seen.get(r.id) ?? 0) + 1)
  for (const [id, n] of seen) if (n > 1) out.push({ code: 'duplicate-id', rules: [id], message: `There is already a rule called "${id}".` })

  for (const r of rules) {
    if (!RULE_ID.test(r.id)) out.push({ code: 'bad-id', rules: [r.id], message: `"${r.id}" is not a valid rule name: start with a letter, then letters, digits, - or _.` })
    if (!r.resources.length) out.push({ code: 'no-resources', rules: [r.id], message: `Rule "${r.id}" names no guests.` })
    for (const s of r.resources) {
      if (!ctx.guests.has(s)) out.push({ code: 'unknown-guest', rules: [r.id], message: `Rule "${r.id}" names ${s}, which does not exist.` })
      else if (!ctx.haSids.has(s)) out.push({ code: 'not-ha', rules: [r.id], message: `${label(s)} is not protected by HA yet. Turn on automatic restart for it first; Proxmox only takes HA guests in rules.` })
    }
    if (r.type === 'node-affinity') {
      if (!r.nodes.length) out.push({ code: 'no-nodes', rules: [r.id], message: `Rule "${r.id}" names no nodes.` })
      for (const n of r.nodes) if (!nodeSet.has(n.node)) out.push({ code: 'unknown-node', rules: [r.id], message: `Rule "${r.id}" names node ${n.node}, which is not in this cluster.` })
    }
  }

  // Node-affinity rules on their own.
  const nodeRules = na(rules)
  const homesBySid = new Map<Sid, string[]>()
  for (const r of nodeRules) for (const s of r.resources) homesBySid.set(s, [...(homesBySid.get(s) ?? []), r.id])
  for (const [s, ids] of homesBySid) if (ids.length > 1) {
    out.push({ code: 'two-homes', rules: ids, message: `${label(s)} is in ${ids.length} home rules (${list(ids.map(i => `"${i}"`))}). A guest can have one home rule; Proxmox ignores all of them.` })
  }
  for (const r of nodeRules) if (r.affinity === 'negative') {
    if (ctx.nodes.length && ctx.nodes.every(n => r.nodes.some(x => x.node === n))) out.push({ code: 'negative-all-nodes', rules: [r.id], message: `Rule "${r.id}" avoids every node, which leaves nowhere to run.` })
    if (r.nodes.some(n => n.priority)) out.push({ code: 'negative-priorities', rules: [r.id], message: `Rule "${r.id}" avoids nodes; first and second choices mean nothing there. Remove the priorities.` })
  }

  // Resource-affinity rules on their own.
  for (const r of ra(rules)) {
    if (r.resources.length < 2) out.push({ code: 'too-few-guests', rules: [r.id], message: `Rule "${r.id}" needs at least two guests to keep ${r.affinity === 'positive' ? 'together' : 'apart'}.` })
    if (r.affinity === 'negative' && ctx.nodes.length && r.resources.length > ctx.nodes.length) {
      out.push({ code: 'more-than-nodes', rules: [r.id], message: `Rule "${r.id}" keeps ${r.resources.length} guests apart, but the cluster has only ${ctx.nodes.length} nodes.` })
    }
  }
  const groups = togetherGroups(rules)
  for (const g of groups) for (const neg of ra(rules, 'negative')) {
    const common = neg.resources.filter(s => g.resources.has(s))
    if (common.length >= 2) out.push({ code: 'together-and-apart', rules: [neg.id, ...g.ruleIds], message: `${list(common.map(label))} are both kept together (${list(g.ruleIds.map(i => `"${i}"`))}) and kept apart ("${neg.id}"). Both cannot be true.` })
  }

  // Between the two types.
  for (const r of ra(rules)) {
    const paired = nodeRules.filter(n => n.resources.some(s => r.resources.includes(s)))
    const weighted = paired.filter(isWeighted)
    if (weighted.length) {
      for (const w of weighted) {
        out.push({
          code: 'weighted-with-affinity', rules: [r.id, ...paired.map(p => p.id)],
          message: `${list(w.resources.filter(s => r.resources.includes(s)).map(label))} ${w.resources.length > 1 ? 'have' : 'has'} a home with a first and second choice ("${w.id}"). Proxmox does not allow a guest with first and second choices to be kept together with or apart from other guests.`,
          fix: { kind: 'flatten', rule: w.id, words: `Make every node in "${w.id}" an equal choice (${list(w.nodes.map(n => n.node))}); the guest no longer prefers one of them over the others.` },
        })
      }
    }
  }
  for (const g of groups) {
    const paired = nodeRules.filter(n => n.resources.some(s => g.resources.has(s)))
    if (paired.length > 1) out.push({ code: 'together-split-homes', rules: [...g.ruleIds, ...paired.map(p => p.id)], message: `Guests kept together (${list([...g.resources].map(label))}) have ${paired.length} different home rules (${list(paired.map(p => `"${p.id}"`))}). Guests kept together need one shared home rule, or none.` })
  }
  for (const neg of ra(rules, 'negative')) {
    const allowed = new Set<string>(); const located = new Set<Sid>(); const paired: string[] = []
    for (const n of nodeRules) {
      const common = n.resources.filter(s => neg.resources.includes(s))
      if (!common.length) continue
      common.forEach(s => located.add(s)); allowedBy(n, ctx.nodes).forEach(x => allowed.add(x)); paired.push(n.id)
    }
    if (located.size && allowed.size < located.size) {
      out.push({ code: 'apart-too-few-nodes', rules: [neg.id, ...paired], message: `${list([...located].map(label))} must be kept apart, but their home rules leave them only ${allowed.size} node${allowed.size === 1 ? '' : 's'} (${list([...allowed])}).` })
    }
  }
  return out
}

const key = (p: RuleProblem) => `${p.code}|${[...p.rules].sort().join(',')}|${p.message}`

/**
 * Problems a change introduces: anything about the changed rules (PVE refuses those), and anything new
 * elsewhere (PVE accepts the write and then silently drops the other rule at runtime, which is worse).
 * Problems that were already there are returned separately, as warnings.
 */
export function problemsOfChange(before: HaRule[], after: HaRule[], changed: string[], ctx: ValidateContext): { blocking: RuleProblem[]; existing: RuleProblem[] } {
  const was = new Set(validateRules(before, ctx).map(key))
  const now = validateRules(after, ctx)
  const blocking = now.filter(p => p.rules.some(r => changed.includes(r)) || !was.has(key(p)))
  const existing = now.filter(p => !blocking.includes(p))
  return { blocking, existing }
}
