// Spend: an estimate from a price table in code. Estimates, not invoices: the provider's own bill is the truth.
import { DEFAULT_MODELS, type OperatorSettings, type Price, type Tier } from './types'

/** Dollars per million tokens. Replace any of them under priceOverrides in the operator settings. */
export const DEFAULT_PRICES: Record<Tier, Price> = {
  local:  { inPerMTok: 0, outPerMTok: 0 },
  haiku:  { inPerMTok: 1, outPerMTok: 5 },
  sonnet: { inPerMTok: 3, outPerMTok: 15 },
  opus:   { inPerMTok: 5, outPerMTok: 25 },
}
void DEFAULT_MODELS

export function priceFor(tier: Tier, s: Pick<OperatorSettings, 'priceOverrides'>): Price {
  if (tier === 'local') return DEFAULT_PRICES.local   // a local model costs nothing, whatever an override says
  return s.priceOverrides[tier] ?? DEFAULT_PRICES[tier]
}

export function estimateCostUsd(tier: Tier, s: Pick<OperatorSettings, 'priceOverrides'>, inputTokens: number, outputTokens: number): number {
  const p = priceFor(tier, s)
  return Math.round(((inputTokens * p.inPerMTok + outputTokens * p.outPerMTok) / 1_000_000) * 1e6) / 1e6
}

/** Rough size of a prompt before it is sent (4 characters a token), for the cap check. */
export const roughTokens = (text: string): number => Math.ceil(text.length / 4)

/** The first moment of this UTC calendar month. */
export function monthStart(now: Date): Date { return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) }

/** Would a call that costs about `estimate` push this month past the cap? A cap of 0 never refuses. */
export function wouldExceedCap(spentUsd: number, estimate: number, capUsd: number): boolean {
  return capUsd > 0 && spentUsd + estimate > capUsd
}
