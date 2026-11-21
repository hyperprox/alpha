// =============================================================================
//  HyperProx — Updates: a five-field cron parser
//
//  Enough cron for one weekly schedule and nothing more: minute hour
//  day-of-month month day-of-week, each field `*`, a number, a range `a-b`, a
//  step `*/n` or `a-b/n`, or a comma list of those. No names (MON, JAN), no `?`,
//  no `L`/`W`: an expression this file does not understand is refused, never
//  guessed at, because a misread schedule upgrades hosts at the wrong hour.
//
//  Times are the API process's local time, which is what an operator writing
//  "Wednesday 08:00" means.
// =============================================================================

import { localParts } from '../placement/windows'

export interface CronSpec {
  minute: Set<number>
  hour:   Set<number>
  dom:    Set<number>
  month:  Set<number>
  dow:    Set<number>     // 0 = Sunday; 7 is folded into 0
  /** Standard cron: when both day fields are restricted, a day matching EITHER runs. */
  domRestricted: boolean
  dowRestricted: boolean
}

const FIELDS: Array<{ name: keyof Pick<CronSpec, 'minute' | 'hour' | 'dom' | 'month' | 'dow'>; min: number; max: number }> = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour',   min: 0, max: 23 },
  { name: 'dom',    min: 1, max: 31 },
  { name: 'month',  min: 1, max: 12 },
  { name: 'dow',    min: 0, max: 7 },
]

function int(s: string, field: string): number {
  if (!/^\d+$/.test(s)) throw new Error(`cron ${field}: "${s}" is not a number`)
  return Number(s)
}

function parseField(src: string, field: string, min: number, max: number): Set<number> {
  const out = new Set<number>()
  for (const part of src.split(',')) {
    if (part === '') throw new Error(`cron ${field}: empty list item`)
    const [range, stepSrc, extra] = part.split('/')
    if (extra !== undefined) throw new Error(`cron ${field}: "${part}" has more than one step`)
    const step = stepSrc === undefined ? 1 : int(stepSrc, field)
    if (step < 1) throw new Error(`cron ${field}: step must be at least 1`)

    let lo: number, hi: number
    if (range === '*') { lo = min; hi = max }
    else if (range.includes('-')) {
      const [a, b, more] = range.split('-')
      if (more !== undefined) throw new Error(`cron ${field}: "${range}" is not a range`)
      lo = int(a, field); hi = int(b, field)
      if (lo > hi) throw new Error(`cron ${field}: range ${range} runs backwards`)
    } else {
      lo = int(range, field)
      // `5/15` means "from 5, every 15" in most crons.
      hi = stepSrc === undefined ? lo : max
    }
    if (lo < min || hi > max) throw new Error(`cron ${field}: ${part} is outside ${min}-${max}`)
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error(`cron: expected 5 fields (minute hour day month weekday), got ${parts.length}`)
  const sets = FIELDS.map((f, i) => parseField(parts[i], f.name, f.min, f.max))
  const dow = sets[4]
  if (dow.has(7)) { dow.delete(7); dow.add(0) }
  return {
    minute: sets[0], hour: sets[1], dom: sets[2], month: sets[3], dow,
    domRestricted: parts[2] !== '*',
    dowRestricted: parts[4] !== '*',
  }
}

/** True when `d` (to the minute, local time) is a time the spec fires. */
export function cronMatches(spec: CronSpec, d: Date): boolean {
  if (!spec.minute.has(d.getMinutes()) || !spec.hour.has(d.getHours()) || !spec.month.has(d.getMonth() + 1)) return false
  const domOk = spec.dom.has(d.getDate())
  const dowOk = spec.dow.has(d.getDay())
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk
  return domOk && dowOk
}

/**
 * The first time strictly after `from` that the expression fires, or null when it never does
 * within roughly four years (31 February, say).
 */
/** Does `spec` fire at the minute containing `ms`, read as wall-clock time in `tz` (minute, hour and weekday fields only)? */
export function cronMatchesIn(spec: CronSpec, ms: number, tz: string): boolean {
  const p = localParts(ms, tz)
  // 2001-01-07 was a Sunday: a stand-in date carrying the zone's weekday, hour and minute.
  return cronMatches(spec, new Date(2001, 0, 7 + p.dow, p.hour, p.minute))
}

/** The next time the expression fires after `from`, read in `tz`; looks a week ahead. */
export function nextRunIn(expr: string, from: Date, tz: string): Date | null {
  const spec = parseCron(expr)
  const start = from.getTime() - (from.getTime() % 60_000) + 60_000
  for (let t = start; t <= start + 8 * 86_400_000; t += 60_000) if (cronMatchesIn(spec, t, tz)) return new Date(t)
  return null
}

export function nextRun(expr: string | CronSpec, from: Date = new Date()): Date | null {
  const spec = typeof expr === 'string' ? parseCron(expr) : expr
  const d = new Date(from.getTime())
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  const limit = from.getTime() + 4 * 366 * 86400_000
  while (d.getTime() <= limit) {
    if (!spec.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue
    }
    const domOk = spec.dom.has(d.getDate())
    const dowOk = spec.dow.has(d.getDay())
    const dayOk = spec.domRestricted && spec.dowRestricted ? domOk || dowOk : domOk && dowOk
    if (!dayOk) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue }
    if (!spec.hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue }
    if (!spec.minute.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue }
    return d
  }
  return null
}
