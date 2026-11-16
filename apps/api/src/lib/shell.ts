// =============================================================================
//  HyperProx — quoting a value for a POSIX shell
//
//  shq():       single-quote ANY string; a quote inside it is closed, escaped and reopened.
//  shqStrict(): refuse a value that does not match an allow-list pattern, then quote it. Used where a value
//               must be one of a known shape (a container name, a path) as well as quoted.
//  shqWord():   for text a PERSON reads and copies (a rollback recipe): left bare when it is plainly safe.
// =============================================================================

/** POSIX single-quoting: the safe way to put any value into a script. */
export function shq(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/** The value, quoted, when it is a string that matches `re`; otherwise throws `bad()` (default: a plain Error). */
export function shqStrict(v: unknown, re: RegExp, bad?: () => Error): string {
  if (typeof v !== 'string' || !re.test(v)) throw (bad ? bad() : new Error('That value cannot be put in a command.'))
  return shq(v)
}

const PLAIN_WORD = /^[A-Za-z0-9_.\/:@=+,%-]+$/

/** For display: bare when nothing in it needs quoting, otherwise quoted. */
export function shqWord(s: string): string {
  return PLAIN_WORD.test(s) ? s : shq(s)
}
