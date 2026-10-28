// =============================================================================
//  HyperProx — App updates: versions and names
//
//  Every version and package name an app update uses comes from somewhere
//  HyperProx does not control: a registry answer, a package.json inside a
//  guest. Both end up in a shell script run as root, so both are checked here
//  against a strict shape before anything else looks at them. Quoting is the
//  second line of defence, not the first.
// =============================================================================

// Semantic versions only: what npm publishes. Build metadata is allowed, nothing else.
const SEMVER = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

// npm's own rules for a package name: lowercase, URL-safe, optionally scoped, at most 214 characters.
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/

export function isVersion(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 64 && SEMVER.test(v)
}

export function isStableVersion(v: unknown): v is string {
  return isVersion(v) && !SEMVER.exec(v)![4]
}

export function isNpmName(n: unknown): n is string {
  return typeof n === 'string' && n.length <= 214 && NPM_NAME.test(n)
}

/** Semver precedence. Both must be valid versions; anything else throws rather than guessing. */
export function compareVersions(a: string, b: string): number {
  const ma = SEMVER.exec(a), mb = SEMVER.exec(b)
  if (!ma || !mb) throw new Error(`not a version: ${!ma ? a : b}`)
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i])
    if (d) return d < 0 ? -1 : 1
  }
  const pa = ma[4], pb = mb[4]
  if (!pa && !pb) return 0
  if (!pa) return 1          // a release outranks its pre-releases
  if (!pb) return -1
  const xa = pa.split('.'), xb = pb.split('.')
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1
    if (xb[i] === undefined) return 1
    const na = /^\d+$/.test(xa[i]), nb = /^\d+$/.test(xb[i])
    if (na && nb) { const d = Number(xa[i]) - Number(xb[i]); if (d) return d < 0 ? -1 : 1; continue }
    if (na !== nb) return na ? -1 : 1
    if (xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1
  }
  return 0
}

export const versionGte = (a: string, b: string) => compareVersions(a, b) >= 0

/**
 * Whether `version` falls in a range as GitHub advisories write them: comparators joined by
 * commas or spaces (`< 1.1.60`, `>= 1.0.0, < 1.2.3`), alternatives joined by `||`. A range it
 * cannot read answers null — never a guess either way.
 */
export function inRange(version: string, range: string): boolean | null {
  if (!isVersion(version)) return null
  const alternatives = range.split('||').map(s => s.trim()).filter(Boolean)
  if (!alternatives.length) return null
  let any = false
  for (const alt of alternatives) {
    const parts = alt.replace(/,/g, ' ').match(/(<=|>=|<|>|=)?\s*v?[0-9][^\s,]*/g)
    if (!parts?.length) return null
    let all = true
    for (const part of parts) {
      const m = /^(<=|>=|<|>|=)?\s*v?(\S+)$/.exec(part.trim())
      if (!m || !isVersion(m[2])) return null
      const c = compareVersions(version, m[2])
      const op = m[1] ?? '='
      const ok = op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : op === '>=' ? c >= 0 : c === 0
      if (!ok) all = false
    }
    if (all) any = true
  }
  return any
}

/** POSIX single-quote a string for a shell. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * An absolute path taken from a guest, fit to be quoted into a script: no NUL, no newline,
 * no `..` or `.` segment, no empty segment, at most 512 characters.
 */
export function isSafeAbsPath(p: unknown): p is string {
  if (typeof p !== 'string' || !p.startsWith('/') || p.length > 512) return false
  if (/[\0\n\r]/.test(p)) return false
  if (p === '/') return true
  return p.slice(1).replace(/\/$/, '').split('/').every(seg => seg !== '' && seg !== '.' && seg !== '..')
}

/** A system user name as Debian allows it (and nothing a shell would read twice). */
export function isUserName(u: unknown): u is string {
  return typeof u === 'string' && /^[a-z_][a-z0-9_-]{0,31}\$?$/i.test(u)
}

/** A systemd service unit name. */
export function isUnitName(u: unknown): u is string {
  return typeof u === 'string' && u.length <= 200 && /^[A-Za-z0-9:_.@\\-]+\.service$/.test(u)
}
