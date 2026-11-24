// =============================================================================
//  Classifier: which kind of problem is this, and so which tier does it start on?
//
//    known      matches a playbook or a known job (playbooks arrive later: see PlaybookMatcher)
//    new_fault  something is broken or behaving oddly and nobody has written the fix down
//    build      make something: a script, a service, a plan
//
//  Rules first: deterministic, free, and unit-tested. Only an ambiguous question is put to the local model, with a
//  timeout, and any failure there falls back to the rules' own default (new_fault: local first, then escalate).
// =============================================================================

import type { ProblemClass } from './types'

export interface PlaybookMatch { id: string; title: string; summary?: string }
export interface PlaybookContext { source: string }

/** Later phases register one of these; until then nothing ever matches. */
export interface PlaybookMatcher {
  match(text: string, ctx: PlaybookContext): Promise<PlaybookMatch | null> | PlaybookMatch | null
}

export const noPlaybooks: PlaybookMatcher = { match: () => null }
let current: PlaybookMatcher = noPlaybooks
export function setPlaybookMatcher(m: PlaybookMatcher | null): void { current = m ?? noPlaybooks }
export function playbookMatcher(): PlaybookMatcher { return current }

export type ClassifiedBy = 'playbook' | 'rules' | 'model' | 'default'
export interface Classification { problemClass: ProblemClass; by: ClassifiedBy; playbook?: PlaybookMatch }

const BUILD_START = /^\s*(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:write|build|create|generate|implement|design|draft|make\s+me|set\s+up|automate|script|develop|code)\b/i
const BUILD_ANY = /\b(write\s+a\s+(?:script|playbook|function|program|module)|build\s+(?:me\s+)?an?\b|implement\s+an?\b|generate\s+an?\s+(?:config|script|playbook)|design\s+an?\b|new\s+feature)\b/i
const FAULT = /\b(error|errors|fail(?:s|ed|ing|ure)?|crash(?:es|ed|ing)?|down|not\s+working|broken|can'?t|cannot|unreachable|time(?:s|d)?\s*out|stuck|offline|denied|refused|won'?t\s+(?:start|boot|mount|connect)|degraded|slow|hang(?:s|ing)?|unhealthy|panic|oom|out\s+of\s+memory|why\s+(?:is|does|did|are)|what'?s\s+wrong)\b/i

/** Rules only. `null` means "not clear": the caller may ask the local model. */
export function classifyByRules(text: string): ProblemClass | null {
  const t = String(text ?? '')
  if (BUILD_START.test(t)) return 'build'
  if (FAULT.test(t)) return 'new_fault'
  if (BUILD_ANY.test(t)) return 'build'
  return null
}

export interface ClassifyDeps {
  matcher?: PlaybookMatcher
  /** A cheap local-model call: the class it picked, or null. May throw or be slow; it is raced against the timeout. */
  askModel?: (text: string) => Promise<ProblemClass | null>
  timeoutMs?: number
}

export async function classify(text: string, source: string, d: ClassifyDeps = {}): Promise<Classification> {
  try {
    const hit = await (d.matcher ?? current).match(text, { source })
    if (hit) return { problemClass: 'known', by: 'playbook', playbook: hit }
  } catch { /* a broken matcher is no match */ }
  const byRules = classifyByRules(text)
  if (byRules) return { problemClass: byRules, by: 'rules' }
  if (d.askModel) {
    let timer: NodeJS.Timeout | undefined
    try {
      const got = await Promise.race([
        d.askModel(text),
        new Promise<null>(res => { timer = setTimeout(() => res(null), d.timeoutMs ?? 8000) }),
      ])
      if (got) return { problemClass: got, by: 'model' }
    } catch { /* fall back to the default */ } finally { if (timer) clearTimeout(timer) }
  }
  return { problemClass: 'new_fault', by: 'default' }
}
