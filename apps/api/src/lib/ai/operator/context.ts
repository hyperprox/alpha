// =============================================================================
//  What the operator is told besides the question: house rules, the best-matching playbooks, live readings.
//
//  Sized for a 16K-token local model with room left for the answer: about 17,000 characters of context in all
//  (roughly 5,000 tokens), in this order of priority: the playbooks that match, the live readings, the house rules
//  that touch the question, then the remaining rules while the budget lasts. Pure apart from the two reads it is
//  handed (the store and the live readings).
// =============================================================================

import type { Playbook } from './playbook'
import type { PlaybookStore } from './playbook-store'
import { pickPlaybooks, pickRules, type Ranked } from './retrieve'
import { liveBlock, type LiveReading } from './live'
import type { PlaybookMatcher } from './classify'

export const BUDGET = { rules: 5000, playbookEach: 2400, text: 600 } as const
export const MAX_PLAYBOOKS = 3

export interface OperatorContext {
  /** Appended to the question. Empty when there is nothing to add. */
  block: string
  playbooks: Array<{ id: string; title: string }>
  /** The areas read live, by title. */
  live: string[]
  rulesUsed: number
  /** Said to the person when something could not be read, in words. */
  notes: string[]
}

export const EMPTY_CONTEXT: OperatorContext = { block: '', playbooks: [], live: [], rulesUsed: 0, notes: [] }

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1)).trimEnd()}…`)

/** One playbook as prompt text: what matters first (cause, fix, safety), the long list of checks last and cut first. */
export function renderPlaybook(n: number, p: Playbook, max = BUDGET.playbookEach): string {
  const head = [`[P${n}] ${p.title} (${p.severity}${p.area ? `, ${p.area}` : ''})`]
  if (p.symptoms.length) head.push(`Looks like: ${p.symptoms.slice(0, 4).join('; ')}`)
  const core = [p.cause && `Cause: ${p.cause}`, p.fix && `Fix: ${p.fix}`, p.safety && `Safety: ${p.safety}`].filter(Boolean) as string[]
  const fixed = [...head, ...core].join('\n')
  const room = max - fixed.length - 12
  const checks = p.checks && room > 120 ? `\nChecks: ${clip(p.checks, room)}` : ''
  return clip(fixed, max) + checks
}

export interface ContextDeps {
  store: PlaybookStore
  /** The live readings for this question, already read with the person's role. May be slow or throw. */
  live?: (question: string) => Promise<LiveReading[]>
}

export async function buildContext(question: string, d: ContextDeps): Promise<OperatorContext> {
  const notes: string[] = []
  let picks: Ranked[] = [], rules: string[] = [], text = ''
  try {
    const [pbs, hr] = await Promise.all([d.store.list({ approved: true }), d.store.getRules()])
    picks = pickPlaybooks(question, pbs, MAX_PLAYBOOKS)
    rules = pickRules(question, hr.rules, BUDGET.rules)
    text = clip(hr.text, BUDGET.text)
  } catch { notes.push('The handbook could not be read, so this answer does not use it.') }

  let readings: LiveReading[] = []
  if (d.live) {
    try { readings = await d.live(question) } catch { notes.push('The live readings could not be read, so this answer does not use them.') }
  }
  for (const r of readings) if (r.note && !r.lines.length) notes.push(`${r.title}: ${r.note}.`)

  const parts: string[] = []
  if (rules.length || text) {
    parts.push(`HOUSE RULES (standing rules; where a playbook disagrees, the rule wins):\n${text ? `${text}\n` : ''}${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}`.trimEnd())
  }
  if (picks.length) {
    parts.push(`PLAYBOOKS (written-down fixes that match this question; use one when it fits, and say which by its [P] number):\n${picks.map((r, i) => renderPlaybook(i + 1, r.playbook)).join('\n\n')}`)
  }
  const live = liveBlock(readings.filter(r => r.lines.length))
  if (live) parts.push(`LIVE READINGS (read-only, taken just now; the real state, so point to the actual item):\n${live}`)
  if (parts.length) parts.push('Answer from the playbooks, rules and readings above where they apply. If they do not cover it, say so and give your best general advice.')

  return {
    block: parts.join('\n\n'),
    playbooks: picks.map(r => ({ id: r.playbook.id, title: r.playbook.title })),
    live: readings.filter(r => r.lines.length).map(r => r.title),
    rulesUsed: rules.length, notes,
  }
}

/** "known" in the classifier: a playbook clearly matches. A weaker match still helps the prompt but proves nothing. */
export function playbookMatcher(store: PlaybookStore, strong = 6): PlaybookMatcher {
  return {
    async match(text) {
      const top = pickPlaybooks(text, await store.list({ approved: true }), 1)[0]
      return top && top.score >= strong ? { id: top.playbook.id, title: top.playbook.title } : null
    },
  }
}
