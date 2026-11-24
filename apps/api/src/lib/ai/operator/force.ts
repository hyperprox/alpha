import { isTier, type Tier } from './types'

/**
 * "ask Sonnet: why is backup slow" -> { tier: 'sonnet', text: 'why is backup slow' }.
 * Only at the start of the message, so a sentence that merely mentions a model is left alone.
 */
export function parseForce(text: string): { tier: Tier | null; text: string } {
  const m = /^\s*(?:please\s+)?(?:ask|use|try|send(?:\s+this)?\s+to|escalate\s+to)\s+(local|haiku|sonnet|opus)\b\s*[:,\-–—]?\s*([\s\S]*)$/i.exec(text ?? '')
  if (!m) return { tier: null, text: String(text ?? '') }
  const tier = m[1].toLowerCase()
  const rest = m[2].trim()
  return isTier(tier) && rest ? { tier, text: rest } : { tier: null, text: String(text ?? '') }
}
