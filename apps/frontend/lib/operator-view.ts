// The AI operator page's words and numbers, kept apart from the markup so they can be tested.

import type { FixProposal } from '@/lib/ai-panel'

export type Tier = 'local' | 'haiku' | 'sonnet' | 'opus'
export const TIERS: Tier[] = ['local', 'haiku', 'sonnet', 'opus']

export interface TierStatus { tier: Tier; enabled: boolean; model: string; cloud: boolean; configured: boolean; missing: string; ready: boolean }
export interface ChainStep { tier: Tier; model: string; outcome: 'answered' | 'error' | 'skipped'; confidence?: string; note?: string; costUsd?: number }
export interface Spend { month: string; monthUsd: number; capUsd: number }

/** What the handbook and live readings gave an answer: the playbooks it used, the areas read live, how many house rules. */
export interface Used { playbooks: Array<{ id: string; title: string }>; live: string[]; rules: number }

/** One plain line for under an answer: what it was built from. Empty when it was the question alone. */
export function usedSentence(u: Used | undefined): string {
  if (!u) return ''
  const parts: string[] = []
  if (u.playbooks.length) parts.push(`${u.playbooks.length === 1 ? 'the playbook' : 'the playbooks'} ${u.playbooks.map(p => `"${p.title}"`).join(' and ')}`)
  if (u.live.length) parts.push(`live readings of ${u.live.join(' and ')}`)
  if (u.rules) parts.push(`${u.rules} house ${u.rules === 1 ? 'rule' : 'rules'}`)
  return parts.length ? `Built from ${parts.join(', ')}.` : ''
}

export type OperatorResult =
  | { status: 'answered'; answer: string; tier: Tier; model: string; confidence: string; chain: ChainStep[]; notes: string[]; costUsd: number; redacted: boolean; localOnly: boolean; used?: Used; drafted?: { id: string; title: string }; proposals?: FixProposal[]; spend?: Spend }
  | { status: 'needs_approval'; tier: 'opus'; model: string; reason: string; promptPreview: string; approvalToken: string; chain: ChainStep[]; notes: string[]; partial?: { answer: string; tier: Tier; confidence: string } }
  | { status: 'refused'; code: string; message: string; chain: ChainStep[]; notes: string[]; retryWith?: Tier }

export const tierWord = (t: Tier): string => (t === 'local' ? 'Local model' : t[0].toUpperCase() + t.slice(1))

export const TIER_BLURB: Record<Tier, string> = {
  local: 'Free. Runs on a server you own. First stop for most questions.',
  haiku: 'Fast and cheap. Used when the local model is not sure.',
  sonnet: 'Stronger. The first stop for building things.',
  opus: 'The most capable and the most expensive. Asks you first.',
}

export type LadderState = 'ready' | 'needs-setup' | 'off'
export const ladderState = (t: TierStatus): LadderState => (!t.enabled ? 'off' : t.configured ? 'ready' : 'needs-setup')
export const ladderWord = (t: TierStatus): string =>
  ladderState(t) === 'ready' ? 'Ready' : ladderState(t) === 'off' ? 'Turned off' : `Needs ${t.missing || 'setup'}`

export const usd = (n: number): string => `$${(Number.isFinite(n) ? n : 0).toFixed(n > 0 && n < 0.1 ? 4 : 2)}`

/** 0 to 100, or null when there is no cap (0 means no cap). */
export function spendPercent(s: Pick<Spend, 'monthUsd' | 'capUsd'>): number | null {
  if (!(s.capUsd > 0)) return null
  return Math.max(0, Math.min(100, Math.round((s.monthUsd / s.capUsd) * 100)))
}

export function spendTone(p: number | null): 'ok' | 'warn' | 'full' {
  return p === null || p < 80 ? 'ok' : p < 100 ? 'warn' : 'full'
}

export const spendSentence = (s: Spend): string =>
  s.capUsd > 0
    ? `${usd(s.monthUsd)} of ${usd(s.capUsd)} used this month. At the cap, only the local model is used.`
    : `${usd(s.monthUsd)} estimated this month. No cap is set.`

export const chainText = (c: ChainStep[]): string =>
  c.map(x => `${tierWord(x.tier)}${x.outcome === 'error' ? ' (failed)' : x.outcome === 'skipped' ? ' (skipped)' : ''}`).join(' then ') || 'none'

/** The topics box is one per line or comma separated. */
export const parseTopics = (text: string): string[] => [...new Set(text.split(/[\n,]+/).map(t => t.trim()).filter(Boolean))]
