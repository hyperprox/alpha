// =============================================================================
//  Settings — times in words
//  "3 days ago", "in 2 hours": what a tile says at a glance. The exact local
//  time stays in the Details table (and in a tile's hover title).
// =============================================================================

const UNITS: Array<[number, string]> = [
  [365 * 86400, 'year'], [30 * 86400, 'month'], [7 * 86400, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute'],
]

/** A time relative to now in plain words, or null when there is no usable time. */
export function inWords(s: string | null | undefined, now = Date.now()): string | null {
  if (!s) return null
  const t = new Date(s).getTime()
  if (isNaN(t)) return null
  const diff = Math.round((t - now) / 1000)
  const abs = Math.abs(diff)
  if (abs < 60) return diff <= 0 ? 'just now' : 'in under a minute'
  for (const [sec, name] of UNITS) {
    if (abs >= sec) {
      const n = Math.floor(abs / sec)
      const w = `${n} ${name}${n === 1 ? '' : 's'}`
      return diff < 0 ? `${w} ago` : `in ${w}`
    }
  }
  return null
}

/** The exact local time, for a hover title. */
export function exact(s: string | null | undefined): string | undefined {
  if (!s) return undefined
  const d = new Date(s)
  return isNaN(d.getTime()) ? s : d.toLocaleString()
}
