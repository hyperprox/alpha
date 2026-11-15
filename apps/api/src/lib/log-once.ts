/**
 * Background jobs run on a timer, so a problem repeats every tick. Logging each time floods the log; swallowing it
 * hides it. This logs a problem the first time, then stays quiet until the message changes (or the job succeeds
 * once and `ok` is called, so a later failure is reported again).
 */
export interface LogLike {
  info(obj: any, msg?: string): void
  warn(obj: any, msg?: string): void
  error(obj: any, msg?: string): void
}

export const silentLog: LogLike = { info: () => undefined, warn: () => undefined, error: () => undefined }

export interface LogOnce {
  /**
   * Report a failure of `phase`. Logged the first time; the same message again is counted and stays quiet, and is
   * logged once more (with how many were held back) after an hour. A different message is logged at once, but never
   * more than one line per phase per minute, so a flapping job cannot flood the log. `text` is the log line
   * (default "<phase> failed").
   */
  (phase: string, err: unknown, text?: string, level?: 'warn' | 'error'): void
  /** The phase worked: forget its last message, so the next failure is logged again (still at most once a minute). */
  ok(phase: string): void
  /** Every phase worked. */
  reset(): void
}

export const LOG_ONCE_REPEAT_MS = 60 * 60_000
export const LOG_ONCE_MIN_GAP_MS = 60_000

export function createLogOnce(log: LogLike | undefined, level: 'warn' | 'error' = 'warn', now: () => number = Date.now): LogOnce {
  const state = new Map<string, { msg: string | null; at: number; suppressed: number }>()
  const fn = ((phase: string, err: unknown, text?: string, lvl?: 'warn' | 'error') => {
    const msg = String((err as any)?.message ?? err)
    const t = now()
    const st = state.get(phase) ?? { msg: null, at: -Infinity, suppressed: 0 }
    state.set(phase, st)
    const same = st.msg === msg
    if (same && t - st.at < LOG_ONCE_REPEAT_MS) { st.suppressed++; return }
    if (!same && t - st.at < LOG_ONCE_MIN_GAP_MS) { st.suppressed++; return }
    const suppressed = st.suppressed
    st.msg = msg; st.at = t; st.suppressed = 0
    try { (log ?? silentLog)[lvl ?? level]({ err, phase, ...(suppressed ? { suppressed } : {}) }, text ?? `${phase} failed`) } catch { /* a broken logger must not break the job */ }
  }) as LogOnce
  fn.ok = (phase: string) => { const st = state.get(phase); if (st) st.msg = null }
  fn.reset = () => { for (const st of state.values()) st.msg = null }
  return fn
}

/** The bare rule: true when `msg` differs from the one before it. */
export function changedMessage(): (msg: string) => boolean {
  let last: string | null = null
  return (msg: string) => { if (msg === last) return false; last = msg; return true }
}

/**
 * The process-wide logger for code that has no logger of its own. index.ts points it at the server's logger at
 * start-up; until then (and in tests) it falls back to the console, so nothing is lost.
 */
let current: LogLike | null = null
export function setAppLog(l: LogLike | null): void { current = l }
const fallback = (level: 'info' | 'warn' | 'error') => (obj: any, msg?: string) => {
  const text = msg ?? (typeof obj === 'string' ? obj : '')
  const err = obj && typeof obj === 'object' && obj.err ? ` ${(obj.err as any)?.message ?? obj.err}` : ''
  console[level](`${text}${err}`)
}
export const appLog: LogLike = {
  info: (o, m) => (current ? current.info(o, m) : fallback('info')(o, m)),
  warn: (o, m) => (current ? current.warn(o, m) : fallback('warn')(o, m)),
  error: (o, m) => (current ? current.error(o, m) : fallback('error')(o, m)),
}

/** Adapts a logger to the one-string job loggers: the level the caller names (info when none) picks the method. */
export function jobLog(l: Pick<LogLike, 'info' | 'warn' | 'error'>): (m: string, level?: 'warn' | 'error') => void {
  return (m, level) => { if (level) l[level](m); else l.info(m) }
}
