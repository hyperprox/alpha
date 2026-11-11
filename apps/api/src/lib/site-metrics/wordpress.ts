// =============================================================================
//  HyperProx — site metrics: what WordPress says about itself (read-only)
//
//  One fixed script, run in the container as the web server's user through
//  WP-CLI with --skip-plugins --skip-themes (so no plug-in's code runs for a
//  read), and the answer is cached for an hour. Nothing here changes the
//  site: versions, what has an update waiting, whether PHP-FPM is running,
//  and the last few PHP errors from the logs, with addresses, e-mail addresses
//  and the site's folders taken out before they are stored or shown.
// =============================================================================

import { safeWordPressPath, safeLogPath, shq, DEFAULT_WP_PATH, DEFAULT_ERROR_LOG } from './paths'

export const WP_CACHE_MS = 60 * 60_000
export const WP_ERRORS = 10

export function wordpressScript(wpPath = DEFAULT_WP_PATH, errorLog = DEFAULT_ERROR_LOG, errors = WP_ERRORS): string {
  const wp = safeWordPressPath(wpPath)
  const el = safeLogPath(errorLog)
  if (!wp) throw new Error('Refused: the WordPress folder must be under /var/www or /srv, with no "..".')
  if (!el) throw new Error('Refused: the error log must be absolute, under /var/log, with no "..".')
  const n = Number.isSafeInteger(errors) && errors > 0 && errors <= 50 ? errors : WP_ERRORS
  return [
    'set -u',
    'export LC_ALL=C',
    `WPP=${shq(wp)}`,
    `ELOG=${shq(el)}`,
    'WPBIN=$(command -v wp || true); [ -x /usr/local/bin/wp ] && WPBIN=/usr/local/bin/wp',
    'OWNER=$(stat -c %U -- "$WPP" 2>/dev/null || echo www-data); [ "$OWNER" = root ] && OWNER=www-data',
    'w() { runuser -u "$OWNER" -- env HOME=/tmp "$WPBIN" --path="$WPP" --skip-plugins --skip-themes --no-color "$@" 2>/dev/null; }',
    'echo "HPXW1 wpcli $([ -n "$WPBIN" ] && echo yes || echo no)"',
    'if [ -n "$WPBIN" ]; then',
    '  echo "HPXW1 core"; w core version; echo',
    '  echo "HPXW1 coreupd"; w core check-update --format=json --fields=version,update_type; echo',
    '  echo "HPXW1 plugins"; w plugin list --format=json --fields=name,status,version,update_version,update; echo',
    '  echo "HPXW1 themes"; w theme list --format=json --fields=name,status,version,update_version,update; echo',
    'fi',
    'echo "HPXW1 php"; php -r \'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION;\' 2>/dev/null; echo',
    'echo "HPXW1 fpm"; for u in $(systemctl list-units --type=service --all --plain --no-legend "php*-fpm.service" 2>/dev/null | awk \'{print $1}\'); do echo "$u $(systemctl is-active "$u" 2>/dev/null)"; done',
    `echo "HPXW1 errors"; { [ -r "$WPP/wp-content/debug.log" ] && tail -n 200 -- "$WPP/wp-content/debug.log" | grep -E "PHP (Fatal|Warning|Parse|Notice|Deprecated)" ; [ -r "$ELOG" ] && tail -n 2000 -- "$ELOG" | grep -E "PHP (Fatal|Warning|Parse|Notice|Deprecated)"; } 2>/dev/null | tail -n ${n} | cut -c1-600`,
    'echo "HPXW1 end"',
  ].join('\n')
}

export interface WpUpdate { kind: 'core' | 'plugin' | 'theme'; name: string; version: string; available: string }

export interface WpInfo {
  checkedAt: number
  wpCli: boolean
  core: string | null
  php: string | null
  fpm: Array<{ unit: string; active: boolean }>
  updates: WpUpdate[]
  plugins: number
  themes: number
  errors: Array<{ level: string; text: string; at: string | null }>
  problem?: string
}

const IPV4 = /\b\d{1,3}(\.\d{1,3}){3}\b/g
const IPV6 = /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

/**
 * A PHP error line as it may be shown: no addresses, no e-mail, no host or request (nginx adds "client:",
 * "server:", "request:", "host:" and "referrer:"), and the site's own folder shortened to "…". Other folders
 * keep only their last two parts.
 */
export function sanitizeErrorLine(line: string, wpPath = DEFAULT_WP_PATH): { level: string; text: string; at: string | null } {
  let t = line
  const at = /^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})/.exec(t)?.[1] ?? /^\[(\d{2}-[A-Za-z]{3}-\d{4} \d{2}:\d{2}:\d{2})/.exec(t)?.[1] ?? null
  const level = /PHP (Fatal|Warning|Parse|Notice|Deprecated)/.exec(t)?.[1] ?? 'Error'
  const start = t.indexOf('PHP ')
  if (start >= 0) t = t.slice(start)
  t = t.replace(/,\s*(client|server|request|upstream|host|referrer):.*$/s, '')
  t = t.replace(/" while reading response header from upstream.*$/s, '')
  t = t.split(wpPath).join('…')
  t = t.replace(/(\/[A-Za-z0-9._-]+){3,}/g, m => `…/${m.split('/').slice(-2).join('/')}`)
  t = t.replace(EMAIL, '<email>').replace(IPV4, '<address>').replace(IPV6, '<address>')
  t = t.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return { level, text: t.length > 300 ? `${t.slice(0, 299)}…` : t, at }
}

function json<T>(s: string | undefined): T | null {
  if (!s) return null
  const j = s.trim()
  if (!j) return null
  try { return JSON.parse(j) as T } catch { return null }
}

const NAME = /^[A-Za-z0-9._ -]{1,80}$/
const VER = /^[0-9A-Za-z.+-]{1,30}$/

export function parseWordPressOutput(out: string, now: number, wpPath = DEFAULT_WP_PATH): WpInfo {
  const parts = new Map<string, string>()
  let key = '', wpCli = false, ended = false
  for (const raw of out.split('\n')) {
    const m = /^HPXW1 (\w+)(?: (.*))?$/.exec(raw.trim())
    if (m) {
      if (m[1] === 'wpcli') { wpCli = m[2] === 'yes'; continue }
      if (m[1] === 'end') { ended = true; break }
      key = m[1]; parts.set(key, ''); continue
    }
    if (key) parts.set(key, (parts.get(key) ?? '') + raw + '\n')
  }
  const info: WpInfo = { checkedAt: now, wpCli, core: null, php: null, fpm: [], updates: [], plugins: 0, themes: 0, errors: [] }
  if (!ended) { info.problem = 'The WordPress check did not finish.'; return info }
  const core = (parts.get('core') ?? '').trim()
  if (VER.test(core)) info.core = core
  const php = (parts.get('php') ?? '').trim()
  if (/^\d+\.\d+$/.test(php)) info.php = php
  for (const l of (parts.get('fpm') ?? '').split('\n')) {
    const m = /^(php[0-9.]*-fpm\.service) (\S+)$/.exec(l.trim())
    if (m) info.fpm.push({ unit: m[1].replace(/\.service$/, ''), active: m[2] === 'active' })
  }
  const coreUpd = json<Array<{ version: string }>>(parts.get('coreupd')) ?? []
  if (info.core && coreUpd.length && VER.test(String(coreUpd[0]?.version))) {
    info.updates.push({ kind: 'core', name: 'WordPress', version: info.core, available: String(coreUpd[0].version) })
  }
  for (const kind of ['plugin', 'theme'] as const) {
    const rows = json<Array<{ name: string; version: string; update_version?: string; update?: string }>>(parts.get(`${kind}s`)) ?? []
    if (kind === 'plugin') info.plugins = rows.length; else info.themes = rows.length
    for (const r of rows) {
      if (r?.update !== 'available' || !NAME.test(String(r.name)) || !VER.test(String(r.update_version ?? ''))) continue
      info.updates.push({ kind, name: String(r.name), version: VER.test(String(r.version)) ? String(r.version) : '?', available: String(r.update_version) })
    }
  }
  if (!wpCli) info.problem = 'WP-CLI is not installed in this container, so versions and updates cannot be read.'
  info.errors = (parts.get('errors') ?? '').split('\n').filter(l => l.trim()).map(l => sanitizeErrorLine(l, wpPath)).reverse()
  return info
}
