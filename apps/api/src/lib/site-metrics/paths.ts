// =============================================================================
//  HyperProx — site metrics: which paths a fixed script may be handed
//
//  Every path that reaches a script in a guest passes one of these first. A
//  path is absolute, made of plain characters only, has no "." or ".." segment
//  and no doubled slash, and lives under the one folder its kind belongs in.
//  The scripts then put it in single quotes, which these characters can never
//  close.
//
//  LiteSpeed (OpenLiteSpeed, and CyberPanel on top of it) keeps its logs
//  outside /var/log, so two more shapes are read, and only for reading:
//    /usr/local/lsws/logs/<file>                       the server's own logs
//    /home/<site>/logs/<file>.access_log|.error_log    CyberPanel's per-site logs
//  Nothing HyperProx writes ever takes one of these: the nginx log-format
//  change keeps to /var/log (safeNginxLogPath).
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

const LSWS_LOG = /^\/usr\/local\/lsws\/logs\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/
const CYBERPANEL_LOG = /^\/home\/[A-Za-z0-9][A-Za-z0-9.-]{0,120}\/logs\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(?:access_log|error_log)$/
const CYBERPANEL_ROOT = /^\/home\/[A-Za-z0-9][A-Za-z0-9.-]{0,120}\/public_html(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,120})*$/
const LSPHP = /^\/usr\/local\/lsws\/lsphp[0-9]{2,3}\/bin\/php$/

/** In words, for refusals: where a log may be. */
export const LOG_RULE = 'absolute, under /var/log (or LiteSpeed\'s /usr/local/lsws/logs and /home/<site>/logs/<name>.access_log), with no ".."'

/** A LiteSpeed or CyberPanel log location (already checked by safeLogPath). */
export function isLiteSpeedLogPath(p: string): boolean {
  return LSWS_LOG.test(p) || CYBERPANEL_LOG.test(p)
}

/** An access or error log to read: absolute, under /var/log or one of LiteSpeed's log places, no "..". Returns the path or null. */
export function safeLogPath(p: unknown): string | null {
  const s = clean(p)
  if (!s) return null
  return s.startsWith('/var/log/') || isLiteSpeedLogPath(s) ? s : null
}

/** LiteSpeed's own server-wide logs: one file for every site on the server. */
export function isSharedServerLog(p: string): boolean {
  return LSWS_LOG.test(p)
}

/** In words, for the tile, the check and the dialog. */
export const SHARED_LOG_NOTE = 'This is LiteSpeed\'s shared server log: it includes every site on this server, so its counts are not this site\'s alone.'

/** A log the nginx log-format change may name: under /var/log only, never a LiteSpeed one. */
export function safeNginxLogPath(p: unknown): string | null {
  const s = clean(p)
  return s && s.startsWith('/var/log/') ? s : null
}

/** A WordPress folder: under /var/www or /srv, or CyberPanel's /home/<site>/public_html. */
export function safeWordPressPath(p: unknown): string | null {
  const s = clean(p)
  return s && (s.startsWith('/var/www/') || s.startsWith('/srv/') || CYBERPANEL_ROOT.test(s)) ? s : null
}

/** One of LiteSpeed's own PHP builds, for WP-CLI where there is no php on the PATH. */
export function safePhpBin(p: unknown): string | null {
  const s = clean(p, 64)
  return s && LSPHP.test(s) ? s : null
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
