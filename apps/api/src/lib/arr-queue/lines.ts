// =============================================================================
//  HyperProx — the Arr Stack queue, as lines for the AI operator (pure)
//
//  The same reading the Arr Stack page makes (plain.ts), said as short sentences: the one-line summary, what needs a
//  person, and every show, film or artist that is not simply downloading. A download that is waiting says so and says
//  its place in line, which is what tells "waiting for a slot" apart from "dead". Read-only, no clock, no network.
// =============================================================================

import type { PlainData } from './plain'

export const MAX_NEEDS = 8
export const MAX_WAITING = 10

export function plainLines(p: PlainData): string[] {
  const out = [p.summary.text.replace(/\.?$/, '.')]
  if (p.summary.waiting) out.push(`${p.summary.waiting} waiting for a download slot: a waiting item has not started, so it shows no seeds and no progress yet. That is normal until it gets a slot.`)
  for (const n of p.needs.slice(0, MAX_NEEDS)) out.push(`Needs you: ${n.title} (${n.instance}): ${n.what}`)
  const resting = p.items.filter(i => i.state === 'waiting' || i.state === 'stuck' || i.state === 'paused')
  for (const i of resting.slice(0, MAX_WAITING)) {
    out.push(`${i.title} (${i.kind}, ${i.instance}): ${i.text}${i.line ? `, ${i.line === 1 ? 'next' : `place ${i.line}`} in line` : ''}, ${Math.round(i.progress)}% done.`)
  }
  if (resting.length > MAX_WAITING) out.push(`${resting.length - MAX_WAITING} more are waiting or stuck.`)
  return out
}
