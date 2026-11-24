// =============================================================================
//  Finding the playbooks (and house rules) that fit a question.
//
//  Plain keyword scoring, no embedding model: the question's words are stemmed and weighed by how rare they are across
//  the handbook, then matched against each playbook's tags and title (strongest), symptoms, area, and last its written
//  body. A symptom that the question mostly repeats earns a bonus. Deterministic, fast, and easy to explain: the page
//  can say why a playbook was picked. Pure.
// =============================================================================

import type { Playbook } from './playbook'

const STOP = new Set(('a an the and or but if then of to in on at by for with from into onto as is are was were be been being do does did done has have had it its this that these those ' +
  'what whats why how when where which who whom i me my we our you your they them their there here can could should would will shall may might must not no yes ' +
  'any some all than too very just also about over under again please tell show give get got need want like what should').split(/\s+/))

const SYNONYM: Record<string, string> = { zero: '0', none: '0', nothing: '0', nobody: '0' }

/** One word to its stem: "seeders", "seeds" and "seeding" all become "seed"; "queued" and "queue" both "queu". */
export function stem(word: string): string {
  let w = word.toLowerCase()
  if (SYNONYM[w]) return SYNONYM[w]
  if (w.length > 4) w = w.replace(/ies$/, 'y').replace(/(ing|ers|er|ed|es|s)$/, '')
  if (w.length > 3) w = w.replace(/e$/, '')
  return w
}

export function tokens(s: string): string[] {
  const out: string[] = []
  for (const raw of String(s ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw) continue
    if (STOP.has(raw)) continue
    if (raw.length < 3 && !/^\d+$/.test(raw)) continue
    out.push(stem(raw))
  }
  return out
}

interface Indexed { p: Playbook; title: Set<string>; tags: Set<string>; symptoms: Set<string>; symptomRows: string[][]; area: Set<string>; body: Set<string> }

function index(p: Playbook): Indexed {
  const set = (xs: string[]) => new Set(xs)
  const symptomRows = p.symptoms.map(tokens)
  return {
    p, title: set(tokens(p.title)), tags: set(p.tags.flatMap(tokens)), symptoms: set(symptomRows.flat()), symptomRows,
    area: set(tokens(p.area)), body: set(tokens([p.cause, p.fix, p.checks, p.safety, p.testScenario].join(' '))),
  }
}

export const WEIGHTS = { tags: 3, title: 3, symptoms: 2.2, area: 1, body: 0.45 } as const
/** A playbook must reach this to be offered at all, and a fraction of the best one's score to stay. */
export const MIN_SCORE = 2.5
export const KEEP_FRACTION = 0.4

export interface Ranked { playbook: Playbook; score: number; why: string[] }

/** Playbooks best first. Only ones that clear MIN_SCORE; callers pick how many to use. */
export function rankPlaybooks(question: string, playbooks: Playbook[]): Ranked[] {
  const q = [...new Set(tokens(question))]
  if (!q.length || !playbooks.length) return []
  const docs = playbooks.map(index)
  const N = docs.length
  const idf = (t: string) => {
    const df = docs.filter(d => d.title.has(t) || d.tags.has(t) || d.symptoms.has(t) || d.body.has(t)).length
    return Math.log(1 + N / (1 + df))
  }
  const out: Ranked[] = []
  for (const d of docs) {
    let score = 0
    const why: string[] = []
    for (const t of q) {
      const hits: number[] = []
      if (d.tags.has(t)) hits.push(WEIGHTS.tags)
      if (d.title.has(t)) hits.push(WEIGHTS.title)
      if (d.symptoms.has(t)) hits.push(WEIGHTS.symptoms)
      if (d.area.has(t)) hits.push(WEIGHTS.area)
      if (d.body.has(t)) hits.push(WEIGHTS.body)
      if (!hits.length) continue
      hits.sort((a, b) => b - a)
      score += idf(t) * (hits[0] + 0.15 * hits.slice(1).reduce((n, x) => n + x, 0))
      if (hits[0] >= WEIGHTS.symptoms && why.length < 4) why.push(t)
    }
    // A symptom the question mostly repeats (two words or more, 60% of them present).
    const qset = new Set(q)
    for (const row of d.symptomRows) {
      if (row.length < 2) continue
      const got = row.filter(t => qset.has(t)).length
      if (got >= 2 && got / row.length >= 0.6) score += 2.5 * (got / row.length)
    }
    if (score >= MIN_SCORE) out.push({ playbook: d.p, score: Math.round(score * 100) / 100, why })
  }
  return out.sort((a, b) => b.score - a.score || a.playbook.title.localeCompare(b.playbook.title))
}

/** The best few that are close enough to the best one. Only approved playbooks are ever offered. */
export function pickPlaybooks(question: string, playbooks: Playbook[], max = 3): Ranked[] {
  const ranked = rankPlaybooks(question, playbooks.filter(p => p.approved))
  if (!ranked.length) return []
  const top = ranked[0].score
  return ranked.filter(r => r.score >= top * KEEP_FRACTION).slice(0, max)
}

/** Rules that touch the question first, then the rest in their written order, until the budget (characters) is used. */
export function pickRules(question: string, rules: string[], budget: number): string[] {
  const q = new Set(tokens(question))
  const toks = rules.map(r => new Set(tokens(r)))
  const df = (t: string) => toks.filter(s => s.has(t)).length
  const scored = rules.map((r, i) => {
    let s = 0
    for (const t of q) if (toks[i].has(t)) s += Math.log(1 + rules.length / (1 + df(t)))
    return { r, i, s }
  })
  const order = [...scored.filter(x => x.s > 0).sort((a, b) => b.s - a.s || a.i - b.i), ...scored.filter(x => x.s === 0)]
  const chosen: typeof scored = []
  let used = 0
  for (const x of order) {
    if (used + x.r.length + 3 > budget) continue
    chosen.push(x); used += x.r.length + 3
  }
  return chosen.sort((a, b) => a.i - b.i).map(x => x.r)
}
