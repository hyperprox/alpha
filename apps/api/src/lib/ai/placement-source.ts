// =============================================================================
//  HyperProx — the assistant's read-only view of load balancing
//
//  "Where should X run?", "Why is X on node2?", "Can X move?", "Is the cluster
//  balanced?" are answered by the load balancing engine itself, with no model
//  call: the same verdicts, score and plan the Load balancing page shows. It
//  never moves anything and offers no way to; moving and running a balancing
//  plan are done on the Load balancing page.
// =============================================================================

import type { AskSource, SourceSummary } from './ask'
import type { Advice, BalancePlan, BalanceResult, GuestPlacement, PlacementMap } from '../placement/types'

export interface PlacementSourceDeps {
  unlocked(): boolean
  map(): Promise<PlacementMap>
  advice(): Promise<Advice>
  /** The balance and its plan; when given, "is it balanced?" is answered from it. */
  balance?(): Promise<BalanceResult & { auto?: { settings: { enabled: boolean; apply: boolean } } }>
}

const MOVE_NOTE = 'Moving a guest, or running a balancing plan, is done on the Load balancing page, after a check and your master password. I cannot move anything.'

/** The guest a question is about: by id, or by the longest name it mentions as a whole word. */
export function guestIn(prompt: string, guests: GuestPlacement[]): GuestPlacement | null {
  const p = prompt.toLowerCase()
  const byId = /\b(?:ct|vm|container|guest|vmid|id)?\s*#?(\d{2,9})\b/.exec(p)
  if (byId) { const g = guests.find(x => String(x.vmid) === byId[1]); if (g) return g }
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const hits = guests.filter(g => g.name && new RegExp(`(^|[^a-z0-9-])${esc(g.name.toLowerCase())}($|[^a-z0-9-])`).test(p))
  return hits.sort((a, b) => b.name.length - a.name.length)[0] ?? null
}

export function guestAnswer(prompt: string, map: PlacementMap): string | null {
  const g = guestIn(prompt, map.guests)
  if (!g) return null
  const label = `${g.name || g.sid} (${g.sid})`
  const p = prompt.toLowerCase()
  const why = g.why.length ? g.why.join(' ') : 'Nothing ties it there: no passed-through device, bind mount, local disk or HA rule.'
  const ok = g.targets.filter(t => t.verdict === 'ok').map(t => t.node)
  const no = g.targets.filter(t => t.verdict === 'no').map(t => `${t.node} (${t.reasons.find(r => r.level === 'block')?.words ?? 'not allowed'})`)
  const unknown = g.targets.filter(t => t.verdict === 'unknown').map(t => t.node)
  if (/\bwhy\b/.test(p)) return `${label} is on ${g.node}. ${why} ${g.summary}`
  const lines = [`${label} runs on ${g.node}. ${g.summary}`]
  if (ok.length) lines.push(`It could run on ${ok.join(', ')}.`)
  if (no.length) lines.push(`Not on: ${no.slice(0, 4).join('; ')}.`)
  if (unknown.length) lines.push(`Not checked: ${unknown.join(', ')}.`)
  if (g.why.length) lines.push(`Why it is where it is: ${why}`)
  if (g.downtimeSec) lines.push(`Moving it restarts it: about ${g.downtimeSec} s offline.`)
  lines.push(MOVE_NOTE)
  return lines.join(' ')
}

export function mapLines(map: PlacementMap): string[] {
  const out = map.nodes.map(n => `${n.node}: ${n.online ? 'online' : 'offline'}, ${n.threads} threads, ${n.guests.length} guests, CPU ${Math.round(n.cpu * 100)}%, memory ${n.maxmem ? Math.round((n.mem / n.maxmem) * 100) : 0}%.`)
  const fixed = map.guests.filter(g => g.movable === 'no' && !g.template)
  out.push(`${map.guests.length - fixed.length} of ${map.guests.length} guests could move somewhere; ${fixed.length} cannot: ${fixed.slice(0, 12).map(g => `${g.name || g.sid} (${g.why[0] ?? g.summary})`).join('; ')}.`)
  return out
}

export function placementSource(d: PlacementSourceDeps): AskSource {
  return {
    id: 'placement', title: 'Load balancing: guests', blurb: 'which node each guest is on, why, and where it could move',
    aliases: /\b(where should|where (does|do|is|can) .{1,40} (run|live|go)|why is .{1,40} on|placement|load balancing|which node|run (it )?on|move (it|.{1,40}) to|can .{1,40} move|could .{1,40} (move|run))\b/i,
    load: async (): Promise<SourceSummary> => {
      if (!d.unlocked()) return { headline: 'Load balancing: locked.', lines: [], locked: true }
      const map = await d.map()
      const fixed = map.guests.filter(g => g.movable === 'no' && !g.template).length
      return { headline: `Load balancing: ${map.guests.length} guests on ${map.nodes.length} nodes, ${fixed} tied to their node.`, lines: mapLines(map), data: map, unread: map.unread.length ? map.unread : undefined }
    },
    answer: (prompt, s) => (s.data ? guestAnswer(prompt, s.data as PlacementMap) : null),
  }
}

export function adviceAnswer(a: Advice): string {
  const parts = [a.headline]
  for (const s of a.suggestions.slice(0, 3)) parts.push(s.kind === 'move'
    ? `Move ${s.name || s.sid} from ${s.from} to ${s.to}: ${s.from} would spend ${s.effect.from.after.toFixed(1)} h busy instead of ${s.effect.from.before.toFixed(1)} h.`
    : `Change the HA rule${s.rule ? ` "${s.rule}"` : ''} of ${s.name || s.sid} to prefer ${s.to} instead of ${s.from}.`)
  for (const x of a.stuck.slice(0, 2)) parts.push(x)
  if (a.balanced) parts.push(a.evidence.slice(0, 2).join(' '))
  if (a.unread.length) parts.push(`(Could not read: ${a.unread.slice(0, 3).join(', ')}.)`)
  if (a.suggestions.length) parts.push(MOVE_NOTE)
  return parts.join(' ')
}

/** The balancing plan in a few sentences: the score now and after, and each move. */
export function planAnswer(p: BalancePlan): string[] {
  const out: string[] = []
  if (p.steps.length) {
    out.push(`A balancing plan of ${p.steps.length} move${p.steps.length === 1 ? '' : 's'} would take the score from ${Math.round(p.score.score)} to ${Math.round(p.target.score)}:`)
    for (const x of p.steps) out.push(`move ${x.name || x.sid} from ${x.from} to ${x.to}${x.downtimeSec ? ` (about ${x.downtimeSec} s offline)` : ''}.`)
  } else out.push(`No balancing plan: ${p.left[0] ?? 'no move would even the load out.'}`)
  for (const x of p.suggestions.slice(0, 2)) out.push(x.words)
  for (const w of p.words.slice(0, 1)) out.push(w)
  return out
}

export function balanceAnswer(b: BalanceResult & { auto?: { settings: { enabled: boolean; apply: boolean } } }): string {
  const parts = [`${b.headline} Balance score: ${Math.round(b.score.score)} of 100.`]
  if (b.uneven) parts.push(...planAnswer(b.plan))
  if (b.auto) parts.push(!b.auto.settings.enabled ? 'Automatic balancing is off.' : b.auto.settings.apply ? 'Automatic balancing is on and applies moves for guests HA does not manage.' : 'Automatic balancing is on, notifying only.')
  if (b.unread.length) parts.push(`(Could not read: ${b.unread.slice(0, 3).join(', ')}.)`)
  if (b.plan.steps.length) parts.push(MOVE_NOTE)
  return parts.join(' ')
}

export function balanceSource(d: PlacementSourceDeps): AskSource {
  return {
    id: 'placement-balance', title: 'Load balancing', blurb: 'how evenly the load is spread across the nodes, and the plan that would even it out',
    aliases: /\b(balanced?|balancing|imbalance\w*|unbalanced|uneven|overloaded|over ?loaded|busiest node|which node is busy|rebalanc\w*|spread (the )?load)\b/i,
    load: async (): Promise<SourceSummary> => {
      if (!d.unlocked()) return { headline: 'Load balancing: locked.', lines: [], locked: true }
      if (d.balance) {
        const b = await d.balance()
        return { headline: `Load balancing: ${b.headline}`, lines: [b.headline, ...planAnswer(b.plan), ...b.plan.left], data: { kind: 'balance', b }, unread: b.unread.length ? b.unread : undefined }
      }
      const a = await d.advice()
      return { headline: `Load balancing: ${a.headline}`, lines: [a.headline, ...a.evidence, ...a.stuck], data: { kind: 'advice', a } }
    },
    answer: (_p, s) => {
      const x = s.data as { kind: 'balance'; b: any } | { kind: 'advice'; a: Advice } | undefined
      if (!x) return null
      return x.kind === 'balance' ? balanceAnswer(x.b) : adviceAnswer(x.a)
    },
  }
}
