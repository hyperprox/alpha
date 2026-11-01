// =============================================================================
//  HyperProx — certificate alerts
//
//  A message when a verdict changes, either way, and one daily reminder while
//  anything stays critical. Silence otherwise: an alert that repeats every
//  check is an alert nobody reads. This file only decides WHAT changed; the
//  message goes out through the notification bus (lib/notify), as one event.
// =============================================================================

import type { CertsVerdict } from './types'
import type { NotifyEventInput, Severity } from '../notify/types'

export interface AlertState { key: string; verdict: CertsVerdict; reason: string | null }

const RANK: Record<CertsVerdict, number> = { ok: 0, unknown: 1, warn: 2, error: 3, critical: 4 }
const LABEL: Record<CertsVerdict, string> = { ok: 'OK', unknown: 'UNKNOWN', warn: 'WARN', error: 'ERROR', critical: 'CRITICAL' }

// "Daily" with slack: a check that runs a few minutes earlier than yesterday's must not skip a day.
const REMINDER_INTERVAL_MS = 20 * 3_600_000

const isProblem = (v: CertsVerdict) => v === 'warn' || v === 'error' || v === 'critical'

/** critical and error are critical; warn and unknown are warnings; ok is info. A change is as bad as its worse side. */
const SEV: Record<CertsVerdict, Severity> = { ok: 'info', unknown: 'warning', warn: 'warning', error: 'critical', critical: 'critical' }
const SEV_RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 }
const worse = (a: Severity, b: Severity): Severity => (SEV_RANK[a] >= SEV_RANK[b] ? a : b)

function line(s: AlertState): string {
  return `${s.key}: ${LABEL[s.verdict]}${s.reason ? ` - ${s.reason}` : ''}`
}

/**
 * Compare the previous verdicts with this check's. A key seen for the first time is announced only when it is
 * a problem; a key that disappears is mentioned only when it left as one, so nobody thinks it was fixed.
 */
export function alertChanges(
  prev: Map<string, AlertState>, next: AlertState[], now: Date, lastReminder: Date | null,
): { messages: string[]; state: Map<string, AlertState>; reminderSent: boolean; severity: Severity; reminderOnly: boolean } {
  const messages: string[] = []
  let severity: Severity = 'info'
  const state = new Map<string, AlertState>()
  const announced = new Set<string>()

  for (const s of next) {
    state.set(s.key, s)
    const before = prev.get(s.key)
    if (!before) {
      if (isProblem(s.verdict)) { messages.push(`New: ${line(s)}`); announced.add(s.key); severity = worse(severity, SEV[s.verdict]) }
      continue
    }
    if (before.verdict === s.verdict) continue
    const way = RANK[s.verdict] > RANK[before.verdict] ? 'Worse' : 'Better'
    messages.push(`${way}: ${s.key}: ${LABEL[before.verdict]} -> ${LABEL[s.verdict]}${s.reason ? ` - ${s.reason}` : ''}`)
    announced.add(s.key)
    severity = worse(severity, worse(SEV[before.verdict], SEV[s.verdict]))
  }
  for (const [key, before] of prev) {
    if (!state.has(key) && isProblem(before.verdict)) {
      messages.push(`No longer checked: ${key} (was ${LABEL[before.verdict]})`)
      severity = worse(severity, SEV[before.verdict])
    }
  }

  const changes = messages.length
  let reminderSent = false
  const due = !lastReminder || now.getTime() - lastReminder.getTime() >= REMINDER_INTERVAL_MS
  if (due) {
    // What was just announced needs no reminder in the same breath.
    const still = next.filter(s => s.verdict === 'critical' && !announced.has(s.key))
    if (still.length) {
      messages.push(`Still critical (${still.length}):`, ...still.map(s => `- ${line(s)}`))
      reminderSent = true
      severity = 'critical'
    }
  }
  return { messages, state, reminderSent, severity, reminderOnly: reminderSent && changes === 0 }
}

function headline(m: string): string {
  const key = (rest: string) => rest.split(/: (OK|UNKNOWN|WARN|ERROR|CRITICAL)\b/)[0]
  if (m.startsWith('New: ')) return `Certificate problem: ${key(m.slice(5))}`
  if (m.startsWith('Worse: ')) return `Certificate worse: ${key(m.slice(7))}`
  if (m.startsWith('Better: ')) return `Certificate better: ${key(m.slice(8))}`
  if (m.startsWith('No longer checked: ')) return `Certificate no longer checked: ${m.slice(19).replace(/ \(was .*\)$/, '')}`
  return 'Certificate change'
}

/**
 * One check's messages as one notification event: certs.verdict.changed, or certs.still.critical when the
 * daily reminder is all there is. The lines are the messages; the bus keeps the first few and says how
 * many more there are.
 */
export function certsEvent(messages: string[], severity: Severity, reminderOnly: boolean): NotifyEventInput {
  const changes = messages.filter(m => !m.startsWith('- ') && !m.startsWith('Still critical'))
  const stillCritical = messages.filter(m => m.startsWith('- ')).length
  const title = reminderOnly ? `${stillCritical === 1 ? 'A certificate is' : `${stillCritical} certificates are`} still critical`
    : changes.length === 1 ? headline(changes[0]) : `${changes.length} certificate changes`
  return {
    type: reminderOnly ? 'certs.still.critical' : 'certs.verdict.changed',
    severity, title, lines: messages, link: '/certificates', where: 'Certificates page',
  }
}
