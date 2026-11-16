// =============================================================================
//  HyperProx — when a reading was taken, in words: "14:05" today, "2026-11-15 14:05" before
// =============================================================================

const two = (n: number) => String(n).padStart(2, '0')
const day = (d: Date) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`

/** The time of `at`, with its date when it was not today (local time). */
export function clockAt(at: number, now = Date.now()): string {
  const d = new Date(at)
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`
  return day(d) === day(new Date(now)) ? hm : `${day(d)} ${hm}`
}

/** " (as of 14:05)" for a reading older than `minMs`; nothing for a fresh one. */
export function asOfText(at: number | undefined | null, now = Date.now(), minMs = 3 * 60_000): string {
  return at && now - at > minMs ? ` (as of ${clockAt(at, now)})` : ''
}

/** How long a kept reading may still be shown. */
export const KEPT_MAX_AGE_MS = 6 * 3600_000
