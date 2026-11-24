// =============================================================================
//  HyperProx AI operator — tier router: shared types and defaults
//
//  Four tiers in a fixed order, cheapest first: local (an OpenAI-compatible server on the network), then the
//  Anthropic models haiku, sonnet and opus. Nothing in this file is secret: the local tier's key lives only in
//  the vault (lib/credentials.ts, ai/operator-local/api_key); everything here is stored in the database.
// =============================================================================

export const TIERS = ['local', 'haiku', 'sonnet', 'opus'] as const
export type Tier = typeof TIERS[number]
export const CLOUD_TIERS: Tier[] = ['haiku', 'sonnet', 'opus']
export const isTier = (v: unknown): v is Tier => typeof v === 'string' && (TIERS as readonly string[]).includes(v)
export const isCloud = (t: Tier): boolean => t !== 'local'

export const PROBLEM_CLASSES = ['known', 'new_fault', 'build'] as const
export type ProblemClass = typeof PROBLEM_CLASSES[number]
export const isProblemClass = (v: unknown): v is ProblemClass => typeof v === 'string' && (PROBLEM_CLASSES as readonly string[]).includes(v)

export interface TierSetting { enabled: boolean; model: string }
export interface Price { inPerMTok: number; outPerMTok: number }

export interface OperatorSettings {
  tiers: Record<Tier, TierSetting>
  /** The local tier's OpenAI-compatible address, for example http://10.0.0.5:8080/v1. Not a secret. */
  localBaseUrl: string
  opusNeedsApproval: boolean
  /** US dollars per calendar month for the cloud tiers; 0 means no cap. */
  monthlyCapUsd: number
  redactBeforeCloud: boolean
  /** A prompt that contains any of these (case-insensitive) never reaches a cloud tier. */
  localOnlyTopics: string[]
  /** Which tier each class of problem starts on. */
  classStart: Record<ProblemClass, Tier>
  /** The most tiers one question may try. */
  maxChain: number
  /** The same problem seen again within this many minutes starts one tier higher. */
  repeatWindowMin: number
  /** Dollars per million tokens, replacing the built-in estimate for a tier. */
  priceOverrides: Partial<Record<Tier, Price>>
}

export const DEFAULT_MODELS: Record<Tier, string> = {
  local: 'local-model',
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
}

export function defaultSettings(): OperatorSettings {
  return {
    tiers: {
      local:  { enabled: true, model: DEFAULT_MODELS.local },
      haiku:  { enabled: true, model: DEFAULT_MODELS.haiku },
      sonnet: { enabled: true, model: DEFAULT_MODELS.sonnet },
      opus:   { enabled: true, model: DEFAULT_MODELS.opus },
    },
    localBaseUrl: '',
    opusNeedsApproval: true,
    monthlyCapUsd: 0,
    redactBeforeCloud: true,
    localOnlyTopics: [],
    classStart: { known: 'local', new_fault: 'local', build: 'sonnet' },
    maxChain: 4,
    repeatWindowMin: 120,
    priceOverrides: {},
  }
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)
const num = (v: unknown, d: number, lo: number, hi: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d)

/** Make anything stored or submitted into a complete, valid settings object. Unknown keys are dropped. */
export function normalizeSettings(input: unknown): OperatorSettings {
  const d = defaultSettings()
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, any>
  const tiers = {} as Record<Tier, TierSetting>
  for (const t of TIERS) {
    const x = i.tiers?.[t]
    tiers[t] = { enabled: bool(x?.enabled, d.tiers[t].enabled), model: str(x?.model, 120) || d.tiers[t].model }
  }
  const classStart = {} as Record<ProblemClass, Tier>
  for (const c of PROBLEM_CLASSES) classStart[c] = isTier(i.classStart?.[c]) ? i.classStart[c] : d.classStart[c]
  const priceOverrides: Partial<Record<Tier, Price>> = {}
  for (const t of TIERS) {
    const p = i.priceOverrides?.[t]
    if (p && Number.isFinite(p.inPerMTok) && Number.isFinite(p.outPerMTok) && p.inPerMTok >= 0 && p.outPerMTok >= 0) {
      priceOverrides[t] = { inPerMTok: p.inPerMTok, outPerMTok: p.outPerMTok }
    }
  }
  const topics = Array.isArray(i.localOnlyTopics) ? i.localOnlyTopics : d.localOnlyTopics
  return {
    tiers,
    localBaseUrl: str(i.localBaseUrl, 300),
    opusNeedsApproval: bool(i.opusNeedsApproval, d.opusNeedsApproval),
    monthlyCapUsd: num(i.monthlyCapUsd, d.monthlyCapUsd, 0, 1_000_000),
    redactBeforeCloud: bool(i.redactBeforeCloud, d.redactBeforeCloud),
    localOnlyTopics: [...new Set(topics.map((t: unknown) => str(t, 80)).filter(Boolean))].slice(0, 50) as string[],
    classStart,
    maxChain: Math.round(num(i.maxChain, d.maxChain, 1, 4)),
    repeatWindowMin: Math.round(num(i.repeatWindowMin, d.repeatWindowMin, 1, 10_080)),
    priceOverrides,
  }
}

export type Confidence = 'low' | 'medium' | 'high'

/** The shape every tier is asked to answer in. `verified` is for a caller that reports a fix outcome. */
export interface AnswerPayload { answer: string; confidence: Confidence; verified: boolean | null; used?: number[]; draft?: unknown }

export interface ChainStep {
  tier: Tier
  model: string
  outcome: 'answered' | 'error' | 'skipped'
  confidence?: Confidence
  /** Why it was skipped or failed, in plain words. Never a provider body. */
  note?: string
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
}

export interface UsageRow { tier: Tier; model: string; inputTokens: number; outputTokens: number; costUsd: number; at: Date; source: string }
export interface FingerprintRow { fingerprint: string; tier: Tier; problemClass: ProblemClass; at: Date }
