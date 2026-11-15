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
  /** Report a failure of `phase`; logged only when its message differs from the last one for that phase. */
  (phase: string, err: unknown): void
  /** The phase worked: forget its last message, so the next failure is logged again. */
  ok(phase: string): void
}

export function createLogOnce(log: LogLike | undefined, level: 'warn' | 'error' = 'warn'): LogOnce {
  const last = new Map<string, string>()
  const fn = ((phase: string, err: unknown) => {
    const msg = String((err as any)?.message ?? err)
    if (last.get(phase) === msg) return
    last.set(phase, msg)
    try { (log ?? silentLog)[level]({ err, phase }, `${phase} failed`) } catch { /* a broken logger must not break the job */ }
  }) as LogOnce
  fn.ok = (phase: string) => { last.delete(phase) }
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

/**
 * For job loggers that take one plain string: lines that describe a failure go to warn, the rest to info, so
 * problems stand out in the log and can be filtered by level.
 */
const FAILURE_WORDS = /\b(fail(?:ed|s|ure)?|could not|cannot|unavailable|error|refus(?:ed|ing)|did not answer|unreadable|crash(?:ed)?)\b/i
export function leveled(log: Pick<LogLike, 'info' | 'warn'>): (m: string) => void {
  return m => { if (FAILURE_WORDS.test(m)) log.warn(m); else log.info(m) }
}
