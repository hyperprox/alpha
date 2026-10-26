// =============================================================================
//  HyperProx — certificate alerts
//
//  A message when a verdict changes, either way, and one daily reminder while
//  anything stays critical. Silence otherwise: an alert that repeats every
//  check is an alert nobody reads.
// =============================================================================

import type { CertsVerdict } from './types'

export interface AlertState { key: string; verdict: CertsVerdict; reason: string | null }

const RANK: Record<CertsVerdict, number> = { ok: 0, unknown: 1, warn: 2, error: 3, critical: 4 }
const LABEL: Record<CertsVerdict, string> = { ok: 'OK', unknown: 'UNKNOWN', warn: 'WARN', error: 'ERROR', critical: 'CRITICAL' }

// "Daily" with slack: a check that runs a few minutes earlier than yesterday's must not skip a day.
const REMINDER_INTERVAL_MS = 20 * 3_600_000

export const DISCORD_LIMIT = 2000

const isProblem = (v: CertsVerdict) => v === 'warn' || v === 'error' || v === 'critical'

function line(s: AlertState): string {
  return `${s.key}: ${LABEL[s.verdict]}${s.reason ? ` - ${s.reason}` : ''}`
}

/**
 * Compare the previous verdicts with this check's. A key seen for the first time is announced only when it is
 * a problem; a key that disappears is mentioned only when it left as one, so nobody thinks it was fixed.
 */
export function alertChanges(
  prev: Map<string, AlertState>, next: AlertState[], now: Date, lastReminder: Date | null,
): { messages: string[]; state: Map<string, AlertState>; reminderSent: boolean } {
  const messages: string[] = []
  const state = new Map<string, AlertState>()
  const announced = new Set<string>()

  for (const s of next) {
    state.set(s.key, s)
    const before = prev.get(s.key)
    if (!before) {
      if (isProblem(s.verdict)) { messages.push(`New: ${line(s)}`); announced.add(s.key) }
      continue
    }
    if (before.verdict === s.verdict) continue
    const way = RANK[s.verdict] > RANK[before.verdict] ? 'Worse' : 'Better'
    messages.push(`${way}: ${s.key}: ${LABEL[before.verdict]} -> ${LABEL[s.verdict]}${s.reason ? ` - ${s.reason}` : ''}`)
    announced.add(s.key)
  }
  for (const [key, before] of prev) {
    if (!state.has(key) && isProblem(before.verdict)) messages.push(`No longer checked: ${key} (was ${LABEL[before.verdict]})`)
  }

  let reminderSent = false
  const due = !lastReminder || now.getTime() - lastReminder.getTime() >= REMINDER_INTERVAL_MS
  if (due) {
    // What was just announced needs no reminder in the same breath.
    const still = next.filter(s => s.verdict === 'critical' && !announced.has(s.key))
    if (still.length) {
      messages.push(`Still critical (${still.length}):`, ...still.map(s => `- ${line(s)}`))
      reminderSent = true
    }
  }
  return { messages, state, reminderSent }
}

/** One Discord-compatible message: whole lines while they fit, then how many were left out. */
export function webhookBody(messages: string[], limit = DISCORD_LIMIT): { content: string; allowed_mentions: { parse: never[] } } {
  const head = 'HyperProx certificates'
  let content = head
  for (let i = 0; i < messages.length; i++) {
    const more = `\n...and ${messages.length - i} more line(s); see the Certificates page`
    const next = `${content}\n${messages[i]}`
    const room = i === messages.length - 1 ? limit : limit - more.length
    if (next.length > room) {
      content = (content + more).slice(0, limit)
      break
    }
    content = next
  }
  // A certificate name or a server's error text must never be able to ping a channel.
  return { content, allowed_mentions: { parse: [] } }
}

export async function sendWebhook(url: string, messages: string[]): Promise<void> {
  if (!messages.length) return
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(webhookBody(messages)),
    signal:  AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`certificate alert webhook answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
  }
}
