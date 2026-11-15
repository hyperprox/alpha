// =============================================================================
//  HyperProx — the assistant's read-only view of guest placement
//
//  "Where should X run?", "Why is X on node2?", "Can X move?", "Is the cluster
//  balanced?" are answered by the placement engine itself, with no model call:
//  the same verdicts and reasons the Placement page shows. It never moves
//  anything and offers no way to; moving is done on the Placement page.
// =============================================================================

import type { AskSource, SourceSummary } from './ask'
import type { Advice, GuestPlacement, PlacementMap } from '../placement/types'

export interface PlacementSourceDeps {
  unlocked(): boolean
  map(): Promise<PlacementMap>
  advice(): Promise<Advice>
}

const MOVE_NOTE = 'Moving is done on the Placement page, after a check and your master password. I cannot move anything.'

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
    id: 'placement', title: 'Guest placement', blurb: 'which node each guest is on, why, and where it could move',
    aliases: /\b(where should|where (does|do|is|can) .{1,40} (run|live|go)|why is .{1,40} on|placement|which node|run (it )?on|move (it|.{1,40}) to|can .{1,40} move|could .{1,40} (move|run))\b/i,
    load: async (): Promise<SourceSummary> => {
      if (!d.unlocked()) return { headline: 'Guest placement: locked.', lines: [], locked: true }
      const map = await d.map()
      const fixed = map.guests.filter(g => g.movable === 'no' && !g.template).length
      return { headline: `Guest placement: ${map.guests.length} guests on ${map.nodes.length} nodes, ${fixed} tied to their node.`, lines: mapLines(map), data: map, unread: map.unread.length ? map.unread : undefined }
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

export function balanceSource(d: PlacementSourceDeps): AskSource {
  return {
    id: 'placement-balance', title: 'Cluster balance', blurb: 'whether a node has been busy for hours, and which guest could move',
    aliases: /\b(balanced?|imbalance\w*|unbalanced|overloaded|over ?loaded|busiest node|which node is busy|rebalanc\w*|spread (the )?load)\b/i,
    load: async (): Promise<SourceSummary> => {
      if (!d.unlocked()) return { headline: 'Cluster balance: locked.', lines: [], locked: true }
      const a = await d.advice()
      return { headline: `Cluster balance: ${a.headline}`, lines: [a.headline, ...a.evidence, ...a.stuck], data: a }
    },
    answer: (_p, s) => (s.data ? adviceAnswer(s.data as Advice) : null),
  }
}
