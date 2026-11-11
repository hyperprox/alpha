// =============================================================================
//  HyperProx — site metrics: which paths a fixed script may be handed
//
//  Every path that reaches a script in a guest passes one of these first. A
//  path is absolute, made of plain characters only, has no "." or ".." segment
//  and no doubled slash, and lives under the one folder its kind belongs in.
//  The scripts then put it in single quotes, which these characters can never
//  close.
// =============================================================================

const SAFE = /^\/[A-Za-z0-9._\-/]+$/

function clean(p: unknown, max = 200): string | null {
  if (typeof p !== 'string') return null
  const s = p.trim()
  if (!s || s.length > max || !SAFE.test(s)) return null
  if (s.includes('//') || s.endsWith('/')) return null
  if (s.split('/').slice(1).some(seg => seg === '' || seg === '.' || seg === '..')) return null
  return s
}

/** An access or error log: absolute, under /var/log, no "..". Returns the path or null. */
export function safeLogPath(p: unknown): string | null {
  const s = clean(p)
  return s && s.startsWith('/var/log/') ? s : null
}

/** A WordPress folder: under /var/www or /srv. */
export function safeWordPressPath(p: unknown): string | null {
  const s = clean(p)
  return s && (s.startsWith('/var/www/') || s.startsWith('/srv/')) ? s : null
}

/** An nginx configuration file the log_format change may edit: under /etc/nginx. */
export function safeNginxConfPath(p: unknown): string | null {
  const s = clean(p)
  return s && s.startsWith('/etc/nginx/') ? s : null
}

/** Single-quote a value for bash. Only ever given a value one of the checks above returned. */
export function shq(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`
}

export const DEFAULT_ACCESS_LOG = '/var/log/nginx/access.log'
export const DEFAULT_ERROR_LOG = '/var/log/nginx/error.log'
export const DEFAULT_WP_PATH = '/var/www/wordpress'
