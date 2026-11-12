// =============================================================================
//  HyperProx — site metrics: finding the websites that are already there
//
//  "Add an existing site" opens on a list instead of an empty form. The list
//  is built from what HyperProx can already see, and nothing is changed
//  anywhere to build it:
//
//    1. every enabled host on every proxy instance: its names, where it
//       forwards, and whether the proxy holds a certificate for it. The
//       forward address is matched to a guest through the guests' own network
//       config (and, for a guest with no fixed address, what it reports while
//       running), the way the router page names addresses;
//    2. running containers that listen on port 80 or 443 but have no proxy
//       host, within a time budget (the answer says when the budget ran out);
//    3. for each container found, one read-only script (discoverScript) that
//       says which web server it runs, which access log the matching server
//       block writes, whether that log carries the request time and
//       X-Forwarded-For, and what kind of site it is.
//
//  The script sends back only the nginx/Apache lines that place a site and its
//  log (no comment lines, and lines such as headers or passwords only when they
//  share a line with a brace). They are parsed here and dropped: a candidate
//  holds paths, names and true/false facts, never configuration text.
//
//  LiteSpeed (OpenLiteSpeed, and CyberPanel on top of it) is read the same
//  way: from /usr/local/lsws/conf/httpd_config.conf the listeners, their
//  domain → virtual host maps, each virtual host's vhRoot and the server's
//  access log; from conf/vhosts/<vhost>/vhost.conf (or vhconf.conf) its
//  docRoot, names, accesslog with its logFormat, errorlog and lsphp. Only lines
//  that start with one of those directive names, or that open or close a block
//  and hold nothing else, leave the container, so keyFile, passwords and
//  rewrite rules stay where they are. HyperProx never changes LiteSpeed.
// =============================================================================

import { createHash } from 'node:crypto'
import { safeLogPath, safeWordPressPath, safePhpBin, isSharedServerLog, SHARED_LOG_NOTE } from './paths'
import type { SiteKind } from './store'

// ── the read-only look inside one container ─────────────────────────────────

/**
 * The one script run in each candidate container. Read-only: listening ports from /proc, which web servers are
 * installed, nginx -T, Apache's site files and LiteSpeed's configuration filtered to the lines that place logs and
 * roots, and whether a wp-config.php (or any .php file) sits in any root. It writes nothing (the exec path stages
 * the script itself, as for every probe).
 */
export function discoverScript(): string {
  return String.raw`set -u
export LC_ALL=C
export PATH="$PATH:/usr/local/sbin:/usr/sbin:/sbin"
for F in /proc/net/tcp /proc/net/tcp6; do [ -r "$F" ] && awk 'NR>1 && $4=="0A" { n=split($2,a,":"); print a[n] }' "$F"; done 2>/dev/null | sort -u | head -n 200 | while read -r P; do echo "HPXD1 listen $P"; done
for B in nginx apache2 httpd caddy; do command -v "$B" >/dev/null 2>&1 && echo "HPXD1 bin $B"; done
ROOTS=""
if command -v nginx >/dev/null 2>&1; then
  if T=$(nginx -T 2>/dev/null); then
    K=$(printf '%s\n' "$T" | grep -v -E '^[[:space:]]*#' | grep -E -e '[{}]' -e '^[[:space:]]*(server_name|access_log|log_format|root|listen|fastcgi_pass|proxy_pass|uwsgi_pass|grpc_pass)[[:space:]]' -e '^[[:space:]]*"' -e "^[[:space:]]*'" | cut -c1-300 | head -n 3000)
    echo "HPXD1 nginx $(printf '%s\n' "$K" | base64 -w0)"
    ROOTS=$(printf '%s\n' "$K" | sed -n "s/^[[:space:]]*root[[:space:]][[:space:]]*[\"']\{0,1\}\([^;\"'[:space:]]*\).*/\1/p")
  else echo "HPXD1 nginxbad"; fi
fi
for D in /etc/apache2 /etc/httpd; do
  [ -d "$D" ] || continue
  A=$(cat "$D"/apache2.conf "$D"/conf/httpd.conf "$D"/sites-enabled/*.conf "$D"/conf.d/*.conf 2>/dev/null | grep -i -E '^[[:space:]]*(</?VirtualHost|ServerName|ServerAlias|CustomLog|DocumentRoot|LogFormat)([[:space:]]|>)' | cut -c1-300 | head -n 2000)
  echo "HPXD1 apache $D $(printf '%s\n' "$A" | base64 -w0)"
  ROOTS="$ROOTS $(printf '%s\n' "$A" | sed -n 's/^[[:space:]]*DocumentRoot[[:space:]][[:space:]]*"\{0,1\}\([^"[:space:]]*\).*/\1/Ip')"
done
LSW=/usr/local/lsws
if [ -x "$LSW/bin/openlitespeed" ] || [ -x "$LSW/bin/lshttpd" ] || [ -x "$LSW/bin/litespeed" ]; then
  echo "HPXD1 bin litespeed"
  LSF='^[[:space:]]*((virtualHost|listener|vhRoot|configFile|map|address|accessLog|errorLog|useServer|useIpInProxyHeader|logFormat|docRoot|vhDomain|vhAliases|path|extProcessor)([[:space:]]|[{]|$)|[A-Za-z]+([[:space:]]+[^[:space:]{}]+)*[[:space:]]*[{][[:space:]]*$|[}][[:space:]]*$)'
  if [ -r "$LSW/conf/httpd_config.conf" ]; then
    C=$(grep -i -E "$LSF" "$LSW/conf/httpd_config.conf" | cut -c1-300 | head -n 3000)
    echo "HPXD1 lsserver $(printf '%s\n' "$C" | base64 -w0)"
  else C=""; echo "HPXD1 lsbad"; fi
  for V in "$LSW"/conf/vhosts/*/vhost.conf "$LSW"/conf/vhosts/*/vhconf.conf; do
    [ -f "$V" ] && [ -r "$V" ] || continue
    N=$(basename "$(dirname "$V")")
    case "$N" in .*|*[!A-Za-z0-9._-]*) continue ;; esac
    K=$(grep -i -E "$LSF" "$V" | cut -c1-300 | head -n 1000)
    echo "HPXD1 lsvhost $N $(printf '%s\n' "$K" | base64 -w0)"
    VR=$(printf '%s\n' "$C" | awk -v n="$N" 'tolower($1)=="virtualhost" { v=$2; sub(/[{].*/, "", v); cur=v; next } cur==n && tolower($1)=="vhroot" { print $2; exit } /^[[:space:]]*[}]/ { cur="" }')
    [ -n "$VR" ] || VR="$LSW/conf/vhosts/$N"
    case "$VR" in *[!A-Za-z0-9._/\$-]*) continue ;; esac
    VR=$(printf '%s' "$VR" | sed "s|[$]VH_NAME|$N|g; s|[$]SERVER_ROOT|$LSW|g")
    case "$VR" in /*) ;; *) VR="$LSW/$VR" ;; esac
    VR=$(printf '%s' "$VR" | sed 's|//*|/|g; s|/$||')
    DR=$(printf '%s\n' "$K" | awk 'tolower($1)=="docroot" { print $2; exit }')
    [ -n "$DR" ] || continue
    DR=$(printf '%s' "$DR" | sed "s|[$]VH_ROOT|$VR|g; s|[$]VH_NAME|$N|g; s|[$]SERVER_ROOT|$LSW|g")
    case "$DR" in /*) ;; *) DR="$LSW/$DR" ;; esac
    ROOTS="$ROOTS $(printf '%s' "$DR" | sed 's|//*|/|g; s|/$||')"
  done
  for P in "$LSW"/lsphp*/bin/php; do [ -x "$P" ] && echo "HPXD1 lsphp $P"; done
fi
# Ghost: a Ghost-CLI site (its .ghost-cli file) or a running container from the ghost image. Names only.
for G in /var/www/*/.ghost-cli /var/lib/ghost/.ghost-cli /opt/*/.ghost-cli; do [ -f "$G" ] && { echo "HPXD1 ghost cli"; break; }; done 2>/dev/null
command -v docker >/dev/null 2>&1 && docker ps --format '{{.Image}}' 2>/dev/null | grep -q -E '(^|/)ghost(:|@|$)' && echo "HPXD1 ghost docker"
set -f
for R in $(printf '%s\n' $ROOTS | sort -u | head -n 50); do
  case "$R" in /*) ;; *) continue ;; esac
  case "$R" in *[!A-Za-z0-9._/-]*) continue ;; esac
  [ -f "$R/wp-config.php" ] && echo "HPXD1 wp $R"
  [ -d "$R" ] && [ -n "$(find "$R" -maxdepth 1 -type f -name '*.php' 2>/dev/null | head -n 1)" ] && echo "HPXD1 php $R"
done
set +f
echo "HPXD1 end"`
}

export interface DiscoverOutput {
  complete: boolean
  ports: number[]
  bins: string[]
  nginx: NginxConf | null
  nginxBroken: boolean
  apache: ApacheConf | null
  /** Roots that hold a wp-config.php. */
  wpRoots: string[]
  /** LiteSpeed's listeners and virtual hosts, when it is installed. */
  litespeed?: LsConf | null
  /** LiteSpeed is installed but httpd_config.conf could not be read. */
  litespeedBroken?: boolean
  /** LiteSpeed's own PHP builds that exist (/usr/local/lsws/lsphpNN/bin/php). */
  lsphp?: string[]
  /** Roots with a .php file at their top. */
  phpRoots?: string[]
  /** Ghost runs here (Ghost-CLI's marker file, or a container from the ghost image). */
  ghost?: boolean
}

const B64 = /^[A-Za-z0-9+/=]*$/
const SAFE_PATH = /^\/[A-Za-z0-9._/-]{0,200}$/

/** The script's answer, parsed. Throws when it did not finish, so a cut-off answer is never read as "nothing there". */
export function parseDiscover(out: string): DiscoverOutput {
  const r: DiscoverOutput = { complete: false, ports: [], bins: [], nginx: null, nginxBroken: false, apache: null, wpRoots: [], litespeed: null, litespeedBroken: false, lsphp: [], phpRoots: [] }
  let lsServer: string | null = null
  const lsVhosts: Array<{ name: string; text: string }> = []
  for (const raw of out.split('\n')) {
    const l = raw.replace(/\r$/, '')
    if (l === 'HPXD1 end') { r.complete = true; break }
    if (l === 'HPXD1 nginxbad') { r.nginxBroken = true; continue }
    if (l === 'HPXD1 lsbad') { r.litespeedBroken = true; continue }
    let m = /^HPXD1 listen ([0-9A-Fa-f]{1,4})$/.exec(l)
    if (m) { const p = parseInt(m[1], 16); if (p > 0 && !r.ports.includes(p)) r.ports.push(p); continue }
    m = /^HPXD1 lsserver ?(\S*)$/.exec(l)
    if (m) { if (B64.test(m[1])) lsServer = Buffer.from(m[1], 'base64').toString('utf8'); continue }
    m = /^HPXD1 lsvhost ([A-Za-z0-9][A-Za-z0-9._-]{0,120}) ?(\S*)$/.exec(l)
    if (m) { if (B64.test(m[2]) && lsVhosts.length < 500) lsVhosts.push({ name: m[1], text: Buffer.from(m[2], 'base64').toString('utf8') }); continue }
    m = /^HPXD1 lsphp (\S+)$/.exec(l)
    if (m) { const p = safePhpBin(m[1]); if (p && !r.lsphp!.includes(p)) r.lsphp!.push(p); continue }
    m = /^HPXD1 php (\S+)$/.exec(l)
    if (m) { if (SAFE_PATH.test(m[1]) && !r.phpRoots!.includes(m[1])) r.phpRoots!.push(m[1]); continue }
    m = /^HPXD1 bin (nginx|apache2|httpd|caddy|litespeed)$/.exec(l)
    if (m) { if (!r.bins.includes(m[1])) r.bins.push(m[1]); continue }
    m = /^HPXD1 nginx ?(\S*)$/.exec(l)
    if (m) { if (B64.test(m[1])) r.nginx = parseNginxConfig(Buffer.from(m[1], 'base64').toString('utf8')); continue }
    m = /^HPXD1 apache (\/etc\/(?:apache2|httpd)) ?(\S*)$/.exec(l)
    if (m) { if (B64.test(m[2])) r.apache = parseApacheConfig(Buffer.from(m[2], 'base64').toString('utf8'), m[1] === '/etc/httpd' ? 'httpd' : 'apache2'); continue }
    if (l === 'HPXD1 ghost cli' || l === 'HPXD1 ghost docker') { r.ghost = true; continue }
    m = /^HPXD1 wp (\S+)$/.exec(l)
    if (m && SAFE_PATH.test(m[1]) && !r.wpRoots.includes(m[1])) r.wpRoots.push(m[1])
  }
  if (!r.complete) throw new Error('the look inside did not finish')
  r.ports.sort((a, b) => a - b)
  if (r.bins.includes('litespeed') && lsServer !== null) r.litespeed = parseLiteSpeedConfig(lsServer, lsVhosts)
  return r
}

// ── nginx ───────────────────────────────────────────────────────────────────

export interface LogDirective { path: string; format: string | null }
export interface LogFormatFacts { requestTime: boolean; forwardedFor: boolean }

export interface NginxServer {
  names: string[]
  defaultServer: boolean
  /** Ports from its listen lines (80 when it has none, as nginx does). */
  ports: number[]
  /** The server block's own root, else the first one a location sets. */
  root: string | null
  /** Its own server-level access_log lines; "off" is kept as a path of "off". */
  logs: LogDirective[]
  php: boolean
  proxied: boolean
}

export interface NginxConf {
  /** access_log lines outside any server (the http block, or a file nginx -T prints on its own), which servers inherit. */
  httpLogs: LogDirective[]
  formats: Record<string, LogFormatFacts>
  servers: NginxServer[]
}

/** nginx's built-in format. */
export const BUILTIN_FORMATS: Record<string, LogFormatFacts> = { combined: { requestTime: false, forwardedFor: false } }

const QUOTED = '\u0000'

/** nginx configuration as tokens: words, quoted strings (marked, so a quoted "{" is never a brace), { } and ;. */
function tokenize(text: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '#') { while (i < text.length && text[i] !== '\n') i++; continue }
    if (/\s/.test(c)) { i++; continue }
    if (c === '{' || c === '}' || c === ';') { out.push(c); i++; continue }
    if (c === '"' || c === "'") {
      let s = ''; i++
      while (i < text.length && text[i] !== c) { if (text[i] === '\\' && i + 1 < text.length) { s += text[i + 1]; i += 2; continue } s += text[i++] }
      i++
      out.push(QUOTED + s)
      continue
    }
    let s = ''
    while (i < text.length && !/[\s{};#]/.test(text[i])) s += text[i++]
    out.push(s)
  }
  return out
}

const unq = (t: string) => (t.startsWith(QUOTED) ? t.slice(1) : t)
const formatFacts = (body: string): LogFormatFacts => ({ requestTime: /\$request_time\b/.test(body), forwardedFor: /\$http_x_forwarded_for\b/.test(body) })

type Frame = { name: string; server?: NginxServer & { locRoot?: string | null } }

/** Read the filtered nginx -T text into its servers, their logs and the log formats. Other directives are skipped. */
export function parseNginxConfig(text: string): NginxConf {
  const conf: NginxConf = { httpLogs: [], formats: {}, servers: [] }
  const stack: Frame[] = []
  let stmt: string[] = []
  const inStream = () => stack.some(f => f.name === 'stream' || f.name === 'mail')
  const server = () => { for (let k = stack.length - 1; k >= 0; k--) if (stack[k].server) return stack[k].server!; return null }
  const top = () => stack[stack.length - 1]?.name ?? ''
  for (const t of tokenize(text)) {
    if (t === '{') {
      const name = unq(stmt[0] ?? '')
      const frame: Frame = { name }
      if (name === 'server' && !inStream() && !server()) frame.server = { names: [], defaultServer: false, ports: [], root: null, locRoot: null, logs: [], php: false, proxied: false }
      stack.push(frame)
      stmt = []
      continue
    }
    if (t === '}') {
      const f = stack.pop()
      if (f?.server) {
        const { locRoot, ...srv } = f.server
        if (!srv.ports.length) srv.ports.push(80)
        if (!srv.root) srv.root = locRoot ?? null
        conf.servers.push(srv)
      }
      stmt = []
      continue
    }
    if (t !== ';') { stmt.push(t); continue }
    const [d0, ...rest] = stmt
    stmt = []
    if (!d0 || d0.startsWith(QUOTED) || inStream()) continue
    const args = rest.map(unq)
    const srv = server()
    const atServer = !!srv && top() === 'server'
    switch (d0) {
      case 'log_format':
        if (args[0]) conf.formats[args[0]] = formatFacts(args.slice(1).filter(a => !/^escape=/.test(a)).join(' '))
        break
      case 'access_log': {
        if (!args[0]) break
        const entry = { path: args[0], format: args[1] && !args[1].includes('=') ? args[1] : null }
        if (atServer) srv!.logs.push(entry)
        else if (!srv && (top() === 'http' || stack.length === 0)) conf.httpLogs.push(entry)
        break
      }
      case 'server_name':
        if (atServer) srv!.names.push(...args.map(a => a.toLowerCase()))
        break
      case 'listen': {
        if (!atServer) break
        const a = args[0] ?? ''
        const p = /^(\d{1,5})$/.exec(a) ?? /[:\]](\d{1,5})$/.exec(a)
        const port = p ? Number(p[1]) : 80
        if (!srv!.ports.includes(port)) srv!.ports.push(port)
        if (args.includes('default_server') || args.includes('default')) srv!.defaultServer = true
        break
      }
      case 'root':
        if (!srv || !args[0]) break
        if (atServer) srv.root = args[0]
        else if (!srv.locRoot) srv.locRoot = args[0]
        break
      case 'fastcgi_pass': if (srv) srv.php = true; break
      case 'proxy_pass': case 'uwsgi_pass': case 'grpc_pass': if (srv) srv.proxied = true; break
    }
  }
  return conf
}

/** Does a server_name (or ServerName/ServerAlias) entry match a host name? Exact, "*.example.com", ".example.com", "www.*". */
export function nameMatches(entry: string, host: string): 'exact' | 'wildcard' | null {
  const e = entry.toLowerCase(), h = host.toLowerCase()
  if (e === h) return 'exact'
  if (e.startsWith('*.') && h.endsWith(e.slice(1))) return 'wildcard'
  if (e.startsWith('.') && (h === e.slice(1) || h.endsWith(e))) return 'wildcard'
  if (e.endsWith('.*') && h.startsWith(e.slice(0, -1))) return 'wildcard'
  return null
}

/** The server that answers for `host` on `port`: by name first, then the port's default server, then its first. */
export function matchServer(conf: NginxConf, host: string | null, port: number | null): { server: NginxServer; how: 'name' | 'default' } | null {
  const onPort = conf.servers.filter(s => port === null || s.ports.includes(port))
  const pool = onPort.length ? onPort : conf.servers
  if (host) {
    const exact = pool.find(s => s.names.some(n => nameMatches(n, host) === 'exact'))
    if (exact) return { server: exact, how: 'name' }
    const wild = pool.find(s => s.names.some(n => nameMatches(n, host) === 'wildcard'))
    if (wild) return { server: wild, how: 'name' }
  }
  const def = pool.find(s => s.defaultServer) ?? pool[0]
  return def ? { server: def, how: 'default' } : null
}

export interface LogChoice {
  logPath: string | null
  /** The format's name and what it carries; null facts when the format is not one HyperProx could see. */
  format: { name: string; requestTime: boolean | null; forwardedFor: boolean | null } | null
  note?: string
}

function resolveFormat(name: string | null, formats: Record<string, LogFormatFacts>): LogChoice['format'] {
  const n = name ?? 'combined'
  const f = formats[n] ?? BUILTIN_FORMATS[n]
  return { name: n, requestTime: f ? f.requestTime : null, forwardedFor: f ? f.forwardedFor : null }
}

/** The access log a server writes: its own first readable one, else the inherited one, else nginx's default. */
export function nginxLogFor(conf: NginxConf, server: NginxServer): LogChoice {
  const own = server.logs.length ? server.logs : conf.httpLogs
  if (!own.length) return { logPath: '/var/log/nginx/access.log', format: resolveFormat(null, conf.formats) }
  if (own.every(l => l.path === 'off')) return { logPath: null, format: null, note: 'Its access log is turned off (access_log off), so there is nothing to read.' }
  const usable = own.find(l => l.path !== 'off' && safeLogPath(l.path))
  if (usable) return { logPath: usable.path, format: resolveFormat(usable.format, conf.formats) }
  const first = own.find(l => l.path !== 'off')!
  if (first.path.includes('$')) return { logPath: null, format: null, note: 'Its access log path is built from variables, so enter the file by hand.' }
  if (/^syslog:/.test(first.path)) return { logPath: null, format: null, note: 'It logs to syslog, not to a file HyperProx can read.' }
  return { logPath: null, format: null, note: 'Its access log is outside /var/log, which HyperProx does not read.' }
}

// ── Apache ──────────────────────────────────────────────────────────────────

export interface ApacheVhost { names: string[]; ports: number[]; root: string | null; logs: LogDirective[] }
export interface ApacheConf { flavour: 'apache2' | 'httpd'; globalLogs: LogDirective[]; formats: Record<string, LogFormatFacts>; vhosts: ApacheVhost[] }

const apacheWords = (s: string): string[] =>
  [...s.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map(m => (m[1] !== undefined ? m[1].replace(/\\"/g, '"') : m[2]))
const apacheFacts = (f: string): LogFormatFacts => ({ requestTime: /%(\{(ms|us|s)\})?[DT]/.test(f), forwardedFor: /%\{X-Forwarded-For\}i/i.test(f) })

/** Apache's VirtualHost blocks with their names, DocumentRoot and CustomLog, from the filtered site files. */
export function parseApacheConfig(text: string, flavour: 'apache2' | 'httpd' = 'apache2'): ApacheConf {
  const conf: ApacheConf = { flavour, globalLogs: [], formats: {}, vhosts: [] }
  const logDir = flavour === 'httpd' ? '/var/log/httpd' : '/var/log/apache2'
  const fixPath = (p: string) => p.replace(/\$\{APACHE_LOG_DIR\}/g, logDir).replace(/^logs\//, `${logDir}/`)
  let cur: ApacheVhost | null = null
  for (const raw of text.split('\n')) {
    const l = raw.trim()
    let m = /^<VirtualHost\s+([^>]*)>/i.exec(l)
    if (m) {
      cur = { names: [], ports: [], root: null, logs: [] }
      for (const a of m[1].split(/\s+/)) { const p = /:(\d{1,5})$/.exec(a); if (p) cur.ports.push(Number(p[1])) }
      continue
    }
    if (/^<\/VirtualHost>/i.test(l)) { if (cur) conf.vhosts.push(cur); cur = null; continue }
    m = /^(\S+)\s+(.*)$/.exec(l)
    if (!m) continue
    const d = m[1].toLowerCase(), args = apacheWords(m[2])
    if (d === 'servername' || d === 'serveralias') { if (cur) cur.names.push(...args.map(a => a.replace(/:\d+$/, '').toLowerCase())); continue }
    if (d === 'documentroot') { if (cur && args[0]) cur.root = args[0]; continue }
    if (d === 'logformat' && args.length >= 2) { conf.formats[args[1]] = apacheFacts(args[0]); continue }
    if (d === 'customlog' && args[0]) {
      const entry = { path: fixPath(args[0]), format: args[1] ?? null }
      if (cur) cur.logs.push(entry); else conf.globalLogs.push(entry)
    }
  }
  return conf
}

export function matchVhost(conf: ApacheConf, host: string | null, port: number | null): ApacheVhost | null {
  const onPort = conf.vhosts.filter(v => port === null || !v.ports.length || v.ports.includes(port))
  const pool = onPort.length ? onPort : conf.vhosts
  if (host) {
    const hit = pool.find(v => v.names.some(n => nameMatches(n, host) === 'exact')) ?? pool.find(v => v.names.some(n => nameMatches(n, host)))
    if (hit) return hit
  }
  return pool[0] ?? null
}

export function apacheLogFor(conf: ApacheConf, vhost: ApacheVhost | null): LogChoice {
  const logs = vhost?.logs.length ? vhost.logs : conf.globalLogs
  const usable = logs.find(l => safeLogPath(l.path))
  if (!usable) {
    return { logPath: null, format: null, note: logs.length
      ? 'Its CustomLog is outside /var/log or built from variables, so enter the file by hand.'
      : 'It has no CustomLog of its own, so Apache writes it to a shared log HyperProx does not read.' }
  }
  const name = usable.format ?? 'common'
  if (name.includes('%')) return { logPath: usable.path, format: { name: 'custom', ...apacheFacts(name) } }
  const known = conf.formats[name] ?? (name === 'combined' || name === 'common' ? { requestTime: false, forwardedFor: false } : null)
  return { logPath: usable.path, format: { name, requestTime: known ? known.requestTime : null, forwardedFor: known ? known.forwardedFor : null } }
}

// ── LiteSpeed ──────────────────────────────────────────────────────────────

export const LSWS_ROOT = '/usr/local/lsws'

export interface LsListener { name: string; ports: number[]; maps: Array<{ vhost: string; domains: string[] }> }
export interface LsVhost {
  name: string
  /** vhRoot and docRoot with $VH_NAME, $VH_ROOT and $SERVER_ROOT filled in. */
  vhRoot: string
  docRoot: string | null
  /** vhDomain and vhAliases. */
  names: string[]
  /** Its own access log; null when it has none or writes the server's (useServer 1). */
  log: LogDirective | null
  errorLog: string | null
  /** The lsphp an extprocessor runs, e.g. /usr/local/lsws/lsphp83/bin/lsphp. */
  lsphp: string | null
}
export interface LsConf {
  listeners: LsListener[]
  vhosts: LsVhost[]
  /** The server's accessLog (logs/access.log when it sets none). */
  serverLog: LogDirective
  /** useIpInProxyHeader: 0 or unset logs the proxy's address; 1, 2 and 3 log the visitor's from X-Forwarded-For. */
  useIpInProxyHeader: number | null
}

interface LsLine { blocks: Array<{ kind: string; name: string }>; key: string; value: string; opens: boolean }

/**
 * LiteSpeed's plain-text configuration as directives with the blocks they sit in. "key value" is a directive,
 * "kind name {" opens a block (and is itself listed, with `opens`, so "accessLog logs/access.log {" gives the path).
 */
function lsLines(text: string): LsLine[] {
  const out: LsLine[] = []
  const stack: Array<{ kind: string; name: string }> = []
  for (const raw of text.split('\n')) {
    const l = raw.trim()
    if (!l || l.startsWith('#')) continue
    if (/^\}/.test(l)) { stack.pop(); continue }
    const open = /^([A-Za-z]+)(?:\s+(.*?))?\s*\{\s*$/.exec(l)
    if (open) {
      const b = { kind: open[1].toLowerCase(), name: (open[2] ?? '').trim() }
      out.push({ blocks: [...stack], key: b.kind, value: b.name, opens: true })
      stack.push(b)
      continue
    }
    const d = /^(\S+)(?:\s+(.*))?$/.exec(l)
    if (d) out.push({ blocks: [...stack], key: d[1].toLowerCase(), value: (d[2] ?? '').trim(), opens: false })
  }
  return out
}

/** A path from LiteSpeed's configuration with its variables filled in; relative paths are under the server root. */
export function lsPath(p: string, vars: { VH_NAME?: string; VH_ROOT?: string }): string {
  let s = p.trim().replace(/^"(.*)"$/, '$1')
  s = s.replace(/\$VH_ROOT/g, vars.VH_ROOT ?? '$VH_ROOT').replace(/\$VH_NAME/g, vars.VH_NAME ?? '$VH_NAME').replace(/\$SERVER_ROOT/g, LSWS_ROOT)
  if (!s.startsWith('/')) s = `${LSWS_ROOT}/${s}`
  return s.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1')
}

const lsPorts = (address: string): number[] => {
  const m = /:(\d{1,5})$/.exec(address.trim()) ?? /^(\d{1,5})$/.exec(address.trim())
  return m ? [Number(m[1])] : []
}

const splitNames = (v: string) => v.split(/[\s,]+/).map(x => x.trim().toLowerCase()).filter(Boolean)

/**
 * httpd_config.conf (the filtered lines) and each vhost's own file, into listeners, virtual hosts and logs.
 * Only virtual hosts the server file declares are kept, with the vhRoot it gives them.
 */
export function parseLiteSpeedConfig(server: string, vhostFiles: Array<{ name: string; text: string }>): LsConf {
  const conf: LsConf = { listeners: [], vhosts: [], serverLog: { path: `${LSWS_ROOT}/logs/access.log`, format: null }, useIpInProxyHeader: null }
  const roots = new Map<string, string>()
  const listeners = new Map<string, LsListener>()
  for (const d of lsLines(server)) {
    const top = d.blocks[0]
    if (!top) {
      if (d.key === 'useipinproxyheader' && /^\d$/.test(d.value)) conf.useIpInProxyHeader = Number(d.value)
      if (d.key === 'accesslog' && d.value) conf.serverLog.path = lsPath(d.value, {})
      if (d.key === 'virtualhost' && d.opens && d.value && !roots.has(d.value)) roots.set(d.value, '')
      continue
    }
    if (d.blocks.length !== 1) continue
    if (top.kind === 'virtualhost' && d.key === 'vhroot') roots.set(top.name, d.value)
    if (top.kind === 'listener') {
      const li = listeners.get(top.name) ?? { name: top.name, ports: [], maps: [] }
      if (d.key === 'address') for (const p of lsPorts(d.value)) if (!li.ports.includes(p)) li.ports.push(p)
      if (d.key === 'map') {
        const [vhost, ...rest] = d.value.split(/\s+/)
        if (vhost) li.maps.push({ vhost, domains: splitNames(rest.join(' ')) })
      }
      listeners.set(top.name, li)
    }
    if (top.kind === 'accesslog' && d.key === 'logformat') conf.serverLog.format = d.value
  }
  conf.listeners = [...listeners.values()]
  for (const [name, rawRoot] of roots) {
    const vhRoot = lsPath(rawRoot || `conf/vhosts/${name}`, { VH_NAME: name })
    const vars = { VH_NAME: name, VH_ROOT: vhRoot }
    const v: LsVhost = { name, vhRoot, docRoot: null, names: [], log: null, errorLog: null, lsphp: null }
    const file = vhostFiles.find(f => f.name === name)
    if (file) {
      let ownLog: LogDirective | null = null, useServer = false
      for (const d of lsLines(file.text)) {
        const top = d.blocks[0]
        if (!top) {
          if (d.key === 'docroot' && d.value) v.docRoot = lsPath(d.value, vars)
          if (d.key === 'vhdomain' || d.key === 'vhaliases') v.names.push(...splitNames(d.value.replace(/\$VH_NAME/g, name)))
          if (d.key === 'accesslog' && d.value) ownLog = { path: lsPath(d.value, vars), format: null }
          if (d.key === 'errorlog' && d.value) v.errorLog = lsPath(d.value, vars)
          continue
        }
        if (top.kind === 'accesslog' && d.blocks.length === 1 && d.key === 'logformat' && ownLog) ownLog.format = d.value
        if (top.kind === 'accesslog' && d.blocks.length === 1 && d.key === 'useserver' && d.value === '1') useServer = true
        if (top.kind === 'extprocessor' && d.key === 'path' && /^\/usr\/local\/lsws\/lsphp[0-9]{2,3}\/bin\/lsphp$/.test(d.value) && !v.lsphp) v.lsphp = d.value
      }
      v.log = useServer ? null : ownLog
    }
    conf.vhosts.push(v)
  }
  return conf
}

/** The virtual host LiteSpeed gives `host` on `port`: a listener's map by name, then the vhosts' own names. */
export function matchLsVhost(conf: LsConf, host: string | null, port: number | null): { vhost: LsVhost; how: 'map' | 'name' } | null {
  const onPort = conf.listeners.filter(l => port === null || l.ports.includes(port))
  const pool = onPort.length ? onPort : conf.listeners
  const byName = (n: string) => conf.vhosts.find(v => v.name === n) ?? null
  if (host) {
    const maps = pool.flatMap(l => l.maps)
    for (const want of ['exact', 'wildcard'] as const) {
      for (const m of maps) if (m.domains.some(d => d !== '*' && nameMatches(d, host) === want)) { const v = byName(m.vhost); if (v) return { vhost: v, how: 'map' } }
    }
    const mapped = new Set(maps.map(m => m.vhost))
    const named = conf.vhosts.filter(v => !mapped.size || mapped.has(v.name))
    const hit = named.find(v => v.names.some(n => nameMatches(n, host) === 'exact')) ?? named.find(v => v.names.some(n => nameMatches(n, host)))
    if (hit) return { vhost: hit, how: 'name' }
    // A catch-all "map <vhost> *".
    for (const m of maps) if (m.domains.includes('*')) { const v = byName(m.vhost); if (v) return { vhost: v, how: 'map' } }
    return null
  }
  const first = pool.flatMap(l => l.maps)[0]
  const v = first ? byName(first.vhost) : conf.vhosts[0] ?? null
  return v ? { vhost: v, how: 'map' } : null
}

/** What a LiteSpeed/Apache-style format string carries. The outer pair of quotes CyberPanel writes is ignored. */
export function lsFormatFacts(format: string | null): { name: string; requestTime: boolean; forwardedFor: boolean } {
  if (!format) return { name: 'combined', requestTime: false, forwardedFor: false }
  const f = format.trim().replace(/^"([\s\S]*)"$/, '$1')
  const combined = /^%h %l %u %t "%r" %>s %b "%\{Referer\}i" "%\{User-Agent\}i"$/i.test(f)
  return { name: combined ? 'combined' : 'custom', ...apacheFacts(f) }
}

export function lsLogFor(conf: LsConf, vhost: LsVhost): LogChoice & { realClientIp: boolean } {
  const log = vhost.log ?? conf.serverLog
  const realClientIp = (conf.useIpInProxyHeader ?? 0) > 0
  const facts = lsFormatFacts(log.format)
  const format = { name: facts.name, requestTime: facts.requestTime, forwardedFor: facts.forwardedFor || realClientIp }
  if (log.path.includes('$')) return { logPath: null, format: null, realClientIp, note: 'Its access log path is built from variables HyperProx does not fill in, so enter the file by hand.' }
  if (!safeLogPath(log.path)) return { logPath: null, format: null, realClientIp, note: 'Its access log is outside /var/log, /usr/local/lsws/logs and /home/<site>/logs, which HyperProx does not read.' }
  return { logPath: log.path, format, realClientIp, ...(isSharedServerLog(log.path) ? { note: SHARED_LOG_NOTE } : {}) }
}

/** In words: why visitors are approximated when LiteSpeed logs the proxy's address, and what the owner can turn on. */
export const LITESPEED_PROXY_NOTE =
  'LiteSpeed logs the proxy\'s address, not the visitor\'s, so requests and page views are exact but unique visitors are approximated ' +
  '(people with the same browser cannot be told apart). For exact visitors, turn on "Use Client IP in Header" ' +
  '(useIpInProxyHeader) yourself in LiteSpeed WebAdmin under Server Configuration → General; HyperProx does not change LiteSpeed or CyberPanel.'

// ── one container, inspected ───────────────────────────────────────────────

export type ServerName = 'nginx' | 'apache' | 'caddy' | 'litespeed'

export interface Inspection {
  server: ServerName | null
  kind: SiteKind
  logPath: string | null
  logFormat: LogChoice['format']
  wpPath: string | null
  /** The site's own error log, when it is not the nginx default (LiteSpeed's per-site error_log). */
  errorLog: string | null
  /** The PHP that WP-CLI runs with, when the site's PHP is not on the PATH (LiteSpeed's lsphp). */
  phpBin: string | null
  /** Behind a proxy, the log holds only the proxy's address: requests are exact, unique visitors approximate. */
  visitorsApproximate: boolean
  /** The proxy's forward port is one this container listens on (null when there is no proxy). */
  forwardPortOpen: boolean | null
  /** The app behind a proxied server block, when one is known (Ghost). Its metrics kind stays 'other'. */
  app?: 'ghost'
  notes: string[]
}

/**
 * One container's answer, for one site on it: the name the proxy sends and the port it sends to. `behindProxy`
 * says whether a missing X-Forwarded-For matters (it does only when a proxy stands in front).
 */
export function inspectFor(out: DiscoverOutput, host: string | null, port: number | null, behindProxy = port !== null): Inspection {
  const notes: string[] = []
  const r: Inspection = { server: null, kind: 'other', logPath: null, logFormat: null, wpPath: null, errorLog: null, phpBin: null, visitorsApproximate: false,
    forwardPortOpen: port === null ? null : out.ports.includes(port), notes }
  const wordpressAt = (root: string | null) => {
    if (!root || !out.wpRoots.includes(root)) return false
    r.kind = 'wordpress'
    r.wpPath = safeWordPressPath(root)
    if (!r.wpPath) notes.push('WordPress is outside /var/www, /srv and /home/<site>/public_html, so its versions cannot be read.')
    return true
  }
  if (out.nginx) {
    r.server = 'nginx'
    const hit = matchServer(out.nginx, host, port)
    if (!hit) { notes.push('nginx is installed but has no server block.'); return r }
    if (host && hit.how === 'default') notes.push(`No nginx server_name matches ${host}, so this is the default server's log.`)
    const log = nginxLogFor(out.nginx, hit.server)
    r.logPath = log.logPath; r.logFormat = log.format
    if (log.note) notes.push(log.note)
    if (!wordpressAt(hit.server.root)) r.kind = hit.server.php || hit.server.proxied ? 'other' : 'static'
    if (r.kind === 'other' && hit.server.proxied && out.ghost) r.app = 'ghost'
  } else if (out.litespeed) {
    r.server = 'litespeed'
    const hit = matchLsVhost(out.litespeed, host, port)
    if (!hit) { notes.push(host ? `No LiteSpeed listener maps ${host} to a virtual host.` : 'LiteSpeed is installed but has no virtual host.'); return r }
    const vh = hit.vhost
    const log = lsLogFor(out.litespeed, vh)
    r.logPath = log.logPath; r.logFormat = log.format
    if (log.note) notes.push(log.note)
    if (vh.errorLog && safeLogPath(vh.errorLog)) r.errorLog = vh.errorLog
    if (!wordpressAt(vh.docRoot)) r.kind = !vh.docRoot ? 'other' : (out.phpRoots ?? []).includes(vh.docRoot) ? 'other' : 'static'
    if (r.kind === 'wordpress' && vh.lsphp) {
      const php = safePhpBin(vh.lsphp.replace(/\/lsphp$/, '/php'))
      if (php && (out.lsphp ?? []).includes(php)) r.phpBin = php
      else notes.push(`The PHP this site runs (${vh.lsphp}) has no php command beside it, so WP-CLI uses the one on the PATH.`)
    }
    if (behindProxy && !log.realClientIp && r.logPath) { r.visitorsApproximate = true; notes.push(LITESPEED_PROXY_NOTE) }
    if (r.logFormat?.requestTime === false) notes.push('The log has no request time, so response times stay empty. HyperProx does not offer a logging change for LiteSpeed.')
    return r
  } else if (out.litespeedBroken) {
    r.server = 'litespeed'
    notes.push('LiteSpeed is installed but its httpd_config.conf could not be read.')
  } else if (out.apache && (out.bins.includes('apache2') || out.bins.includes('httpd'))) {
    r.server = 'apache'
    const v = matchVhost(out.apache, host, port)
    const log = apacheLogFor(out.apache, v)
    r.logPath = log.logPath; r.logFormat = log.format
    if (log.note) notes.push(log.note)
    wordpressAt(v?.root ?? null)
  } else if (out.nginxBroken) {
    r.server = 'nginx'
    notes.push('nginx -T fails here, so its configuration could not be read. Fix nginx first.')
  } else if (out.bins.includes('caddy')) {
    r.server = 'caddy'
    notes.push('Caddy writes JSON logs, which HyperProx does not read yet.')
  } else {
    notes.push('No nginx, Apache, LiteSpeed or Caddy was found in this container.')
  }
  if (r.logFormat) {
    const missing: string[] = []
    if (behindProxy && r.logFormat.forwardedFor === false) missing.push('visitor address (X-Forwarded-For)')
    if (r.logFormat.requestTime === false) missing.push('request time')
    if (missing.length) notes.push(`The log has no ${missing.join(' and no ')}${r.server === 'nginx' ? '; HyperProx offers the logging change after adding the site' : ''}.`)
  }
  return r
}

// ── proxy hosts to guests ──────────────────────────────────────────────────

export interface GuestInfo {
  vmid: number; name: string; node: string; type: 'lxc' | 'qemu'; status: string
  /** IPv4 addresses from its config (and, once asked, what it reports while running). */
  addresses: string[]
  /** A VM with the QEMU guest agent turned on. */
  agent?: boolean
}

export interface ProxyHostLike {
  instanceId: string; instanceName: string; kind: string
  domains: string[]; forwardScheme: 'http' | 'https'; forwardHost: string; forwardPort: number
  enabled: boolean; tls: { kind: 'none' | 'certificate' | 'auto' }
}

export interface Target {
  key: string
  domains: string[]
  tls: boolean
  forward: { scheme: 'http' | 'https'; host: string; port: number } | null
  proxies: Array<{ instanceName: string; kind: string }>
  guest: GuestInfo | null
  /** What the forward address is when it is not a guest. */
  notGuest?: string
  matchedBy?: 'address' | 'name'
  source: 'proxy' | 'listener'
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

/** Address -> guest: running guests first, then by id, so a stopped copy never takes a live guest's address. */
export function addressIndex(guests: GuestInfo[]): Map<string, GuestInfo> {
  const out = new Map<string, GuestInfo>()
  const sorted = [...guests].sort((a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) || a.vmid - b.vmid)
  for (const g of sorted) for (const ip of g.addresses) if (!out.has(ip)) out.set(ip, g)
  return out
}

/** Forward addresses no guest's config claims: the only reason to ask running guests what they hold. */
export function unresolvedAddresses(hosts: ProxyHostLike[], guests: GuestInfo[]): string[] {
  const idx = addressIndex(guests)
  return [...new Set(hosts.filter(h => h.enabled && IPV4.test(h.forwardHost) && !idx.has(h.forwardHost)).map(h => h.forwardHost))]
}

/**
 * Every enabled proxy host, matched to a guest and merged by where it forwards: hosts (on one proxy or several)
 * that send to the same guest and port are one website with all their names.
 */
export function linkHosts(hosts: ProxyHostLike[], guests: GuestInfo[], nodes: Array<{ name: string; ip?: string }> = []): Target[] {
  const idx = addressIndex(guests)
  const byName = new Map(guests.map(g => [g.name.toLowerCase(), g] as const))
  const out = new Map<string, Target>()
  for (const h of hosts) {
    if (!h.enabled || !h.domains.length) continue
    const fh = h.forwardHost.trim().toLowerCase()
    let guest: GuestInfo | null = null, matchedBy: Target['matchedBy'], notGuest: string | undefined
    if (IPV4.test(fh)) { guest = idx.get(fh) ?? null; if (guest) matchedBy = 'address' }
    else { guest = byName.get(fh) ?? byName.get(fh.split('.')[0]) ?? null; if (guest) matchedBy = 'name' }
    if (!guest) {
      const node = nodes.find(n => n.ip === fh || n.name.toLowerCase() === fh)
      notGuest = node ? `node ${node.name}` : fh === 'localhost' || fh.startsWith('127.') ? 'the proxy itself' : 'an address that is not a guest'
    }
    const key = guest ? `g${guest.vmid}:${h.forwardPort}` : `h${fh}:${h.forwardPort}`
    const t: Target = out.get(key) ?? { key, domains: [], tls: false, forward: { scheme: h.forwardScheme, host: h.forwardHost, port: h.forwardPort },
      proxies: [], guest, notGuest, matchedBy, source: 'proxy' }
    for (const d of h.domains) if (!t.domains.includes(d.toLowerCase())) t.domains.push(d.toLowerCase())
    t.tls = t.tls || h.tls.kind !== 'none'
    if (!t.proxies.some(p => p.instanceName === h.instanceName)) t.proxies.push({ instanceName: h.instanceName, kind: h.kind })
    out.set(key, t)
  }
  return [...out.values()]
}

// ── candidates ─────────────────────────────────────────────────────────────

export interface SiteRef { id: string; vmid: number; domain?: string; recipeId: string }

export interface Candidate {
  id: string
  domains: string[]
  /** What a visitor opens: https when the proxy holds a certificate; for a container with no proxy host, its own address. */
  url: string | null
  source: 'proxy' | 'listener'
  proxy: { instances: Array<{ instanceName: string; kind: string }>; tls: boolean; forward: { scheme: string; host: string; port: number } } | null
  guest: { vmid: number; name: string; node: string; type: 'lxc' | 'qemu'; status: string } | null
  /** Set when the proxy forwards to something that is not a guest: what it is, in words. */
  notAGuest: string | null
  server: Inspection['server']
  kind: SiteKind | null
  /** The app it runs, when known: Ghost. */
  app: 'ghost' | null
  logPath: string | null
  logFormat: LogChoice['format']
  wpPath: string | null
  errorLog: string | null
  phpBin: string | null
  visitorsApproximate: boolean
  alreadyASite: boolean
  alreadyAdopted: boolean
  siteId: string | null
  /** The public address answered below 500 (null: not checked). */
  up: boolean | null
  adoptable: boolean
  whyNot: string | null
  notes: string[]
}

const candidateId = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)
/** Plain names before wildcards, and the bare name before its www. */
const primaryFirst = (domains: string[]) => {
  const plain = domains.filter(d => !d.includes('*'))
  return [...new Set([...plain.filter(d => !d.startsWith('www.')), ...plain, ...domains])]
}

export type InspectAnswer = { ok: true; out: DiscoverOutput } | { ok: false; error: string }

/**
 * Targets plus what each container said, as candidates. A target becomes one candidate per access log, so names
 * that one container writes to different logs stay separate sites.
 */
export function buildCandidates(targets: Target[], inspected: Map<number, InspectAnswer>, sites: SiteRef[], up: Map<string, boolean | null> = new Map()): Candidate[] {
  const out: Candidate[] = []
  for (const t of targets) {
    const g = t.guest
    const answer = g ? inspected.get(g.vmid) : undefined
    const groups: Array<{ domains: string[]; ins: Inspection | null }> = []
    if (answer?.ok) {
      const byLog = new Map<string, { domains: string[]; ins: Inspection }>()
      const names: Array<string | null> = t.domains.length ? primaryFirst(t.domains) : [null]
      for (const d of names) {
        const ins = inspectFor(answer.out, d, t.forward?.port ?? null)
        const k = `${ins.logPath ?? ''}|${ins.kind}`
        const e = byLog.get(k) ?? { domains: [], ins }
        if (d) e.domains.push(d)
        byLog.set(k, e)
      }
      groups.push(...byLog.values())
    } else groups.push({ domains: primaryFirst(t.domains), ins: null })
    for (const grp of groups) {
      const notes = [...(grp.ins?.notes ?? [])]
      const first = grp.domains.find(d => !d.includes('*')) ?? null
      const url = first ? `${t.tls ? 'https' : 'http'}://${first}` : (t.source === 'listener' && g?.addresses[0] ? `http://${g.addresses[0]}` : null)
      const site = (g ? sites.find(s => s.vmid === g.vmid) : undefined) ?? sites.find(s => !!s.domain && grp.domains.includes(s.domain.toLowerCase()))
      let whyNot: string | null = null
      if (site) whyNot = site.recipeId.startsWith('adopted-') ? 'Already added.' : 'Already a site HyperProx made.'
      else if (!g) whyNot = `It forwards to ${t.notGuest ?? 'an address that is not a guest'}; only a container can be added.`
      else if (g.type !== 'lxc') whyNot = 'It is a VM; only a container can be added (HyperProx reads the log through pct).'
      else if (g.status !== 'running') whyNot = `The container is ${g.status}; start it first.`
      else if (!answer) whyNot = 'HyperProx has not looked inside it yet.'
      else if (!answer.ok) whyNot = `HyperProx could not look inside: ${answer.error}`
      else if (!grp.ins?.logPath) whyNot = 'No access log HyperProx can read was found; enter it by hand.'
      if (t.matchedBy === 'name' && g) notes.push(`Matched to ${g.name} by name, not by address.`)
      if (grp.ins?.forwardPortOpen === false && t.forward) notes.push(`Nothing in the container listens on port ${t.forward.port}, where the proxy sends visitors.`)
      out.push({
        id: candidateId(`${t.key}|${grp.ins?.logPath ?? ''}|${grp.domains.join(',')}`),
        domains: grp.domains, url, source: t.source,
        proxy: t.forward ? { instances: t.proxies, tls: t.tls, forward: t.forward } : null,
        guest: g ? { vmid: g.vmid, name: g.name, node: g.node, type: g.type, status: g.status } : null,
        notAGuest: g ? null : (t.notGuest ?? 'an address that is not a guest'),
        server: grp.ins?.server ?? null, kind: grp.ins?.kind ?? null, app: grp.ins?.app ?? null,
        logPath: grp.ins?.logPath ?? null, logFormat: grp.ins?.logFormat ?? null, wpPath: grp.ins?.wpPath ?? null,
        errorLog: grp.ins?.errorLog ?? null, phpBin: grp.ins?.phpBin ?? null, visitorsApproximate: grp.ins?.visitorsApproximate ?? false,
        alreadyASite: !!site, alreadyAdopted: !!site?.recipeId.startsWith('adopted-'), siteId: site?.id ?? null,
        up: url ? (up.get(url) ?? null) : null,
        adoptable: !whyNot, whyNot, notes,
      })
    }
  }
  const label = (c: Candidate) => c.domains[0] ?? `~${String(c.guest?.vmid ?? '').padStart(9, '0')}`
  return out.sort((a, b) => Number(b.adoptable) - Number(a.adoptable) || label(a).localeCompare(label(b)))
}

// ── the whole discovery, every outside call injected ───────────────────────

export interface DiscoveryDeps {
  hosts(): Promise<{ hosts: ProxyHostLike[]; errors: Array<{ instanceName: string; error: string }> }>
  guests(): Promise<GuestInfo[]>
  /** Addresses running guests report (LXC interfaces, the QEMU agent), keyed by vmid. */
  liveAddresses(guests: GuestInfo[]): Promise<Map<number, string[]>>
  nodes(): Promise<Array<{ name: string; ip?: string }>>
  sites(): Promise<SiteRef[]>
  /** Run discoverScript() in a container and return its output. */
  inspect(g: GuestInfo, script: string): Promise<string>
  /** A quick HEAD of an address: true when it answered below 500, false when it did not answer or failed. */
  head(url: string): Promise<boolean | null>
  now(): number
}

export interface DiscoveryResult {
  candidates: Candidate[]
  errors: string[]
  /** Running containers with no proxy host, looked at for a web server on 80/443. */
  listenerScan: { state: 'done' | 'partial' | 'skipped'; looked: number; of: number; note?: string }
  builtAt: number
}

export const INSPECT_TIMEOUT_MS = 20_000
export const LISTENER_BUDGET_MS = 25_000
export const INSPECT_PARALLEL = 4
export const HEAD_TIMEOUT_MS = 6_000

export async function mapLimit<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++])
  }))
}

export function within<T>(p: Promise<T>, ms: number, what = 'it'): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<T>((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms) })
  return Promise.race([p, late]).finally(() => clearTimeout(timer))
}

export async function discover(d: DiscoveryDeps, opts: { listeners?: boolean; budgetMs?: number } = {}): Promise<DiscoveryResult> {
  const errors: string[] = []
  const [hostsR, guestsR, nodes, sites] = await Promise.all([
    d.hosts().catch((e: any) => { errors.push(`The proxy hosts could not be read: ${e?.message ?? e}`); return { hosts: [] as ProxyHostLike[], errors: [] } }),
    d.guests().catch((e: any) => { errors.push(`The cluster's guests could not be read: ${e?.message ?? e}`); return [] as GuestInfo[] }),
    d.nodes().catch(() => [] as Array<{ name: string; ip?: string }>),
    d.sites().catch(() => [] as SiteRef[]),
  ])
  for (const e of hostsR.errors) errors.push(`${e.instanceName}: ${e.error}`)
  const guests = guestsR.map(g => ({ ...g, addresses: [...g.addresses] }))
  if (unresolvedAddresses(hostsR.hosts, guests).length) {
    const live = await d.liveAddresses(guests.filter(g => g.status === 'running')).catch(() => new Map<number, string[]>())
    for (const g of guests) for (const ip of live.get(g.vmid) ?? []) if (!g.addresses.includes(ip)) g.addresses.push(ip)
  }
  const targets = linkHosts(hostsR.hosts, guests, nodes)
  const script = discoverScript()
  const inspected = new Map<number, InspectAnswer>()
  const look = async (g: GuestInfo) => {
    try { inspected.set(g.vmid, { ok: true, out: parseDiscover(await within(d.inspect(g, script), INSPECT_TIMEOUT_MS, 'the look inside')) }) }
    catch (e: any) { inspected.set(g.vmid, { ok: false, error: String(e?.message ?? e).slice(0, 200) }) }
  }
  const linked = [...new Map(targets.filter(t => t.guest?.type === 'lxc' && t.guest.status === 'running').map(t => [t.guest!.vmid, t.guest!] as const)).values()]
  await mapLimit(linked, INSPECT_PARALLEL, look)

  // Running containers with no proxy host and no site yet, looked at until the budget runs out.
  const taken = new Set([...targets.flatMap(t => (t.guest ? [t.guest.vmid] : [])), ...sites.map(s => s.vmid)])
  const rest = guests.filter(g => g.type === 'lxc' && g.status === 'running' && !taken.has(g.vmid)).sort((a, b) => a.vmid - b.vmid)
  const scan: DiscoveryResult['listenerScan'] = { state: 'skipped', looked: 0, of: rest.length }
  if (opts.listeners === false) scan.note = 'Containers without a proxy host were not looked at.'
  else {
    const stopAt = d.now() + (opts.budgetMs ?? LISTENER_BUDGET_MS)
    await mapLimit(rest, INSPECT_PARALLEL, async g => { if (d.now() < stopAt) { await look(g); scan.looked++ } })
    scan.state = scan.looked === rest.length ? 'done' : 'partial'
    if (scan.state === 'partial') scan.note = `Time ran out after ${scan.looked} of ${rest.length} containers without a proxy host; refresh to look again.`
    for (const g of rest) {
      const a = inspected.get(g.vmid)
      if (a?.ok && (a.out.ports.includes(80) || a.out.ports.includes(443))) targets.push({ key: `l${g.vmid}`, domains: [], tls: false, forward: null, proxies: [], guest: g, source: 'listener' })
    }
  }

  const draft = buildCandidates(targets, inspected, sites)
  const urls = [...new Set(draft.map(c => c.url).filter((u): u is string => !!u))]
  const up = new Map<string, boolean | null>()
  await mapLimit(urls, 6, async u => { up.set(u, await within(d.head(u), HEAD_TIMEOUT_MS, 'the check').catch(() => false)) })
  return { candidates: buildCandidates(targets, inspected, sites, up), errors, listenerScan: scan, builtAt: d.now() }
}

export const CANDIDATES_TTL_MS = 60_000
export const REFRESH_MIN_MS = 10_000

/**
 * The candidate list, kept a minute. A refresh within ten seconds of the last build gets the same list, and two
 * callers at once share one build. "Add an existing site" and the catalogue's detection read the same one.
 */
export class CandidateCache {
  private found: DiscoveryResult | null = null
  private finding: Promise<DiscoveryResult> | null = null
  constructor(private build: () => Promise<DiscoveryResult>, private now: () => number = Date.now) {}
  async get(refresh = false): Promise<DiscoveryResult> {
    const age = this.found ? this.now() - this.found.builtAt : Infinity
    if (this.found && age < (refresh ? REFRESH_MIN_MS : CANDIDATES_TTL_MS)) return this.found
    if (this.finding) return this.finding
    this.finding = this.build().then(r => (this.found = r)).finally(() => { this.finding = null })
    return this.finding
  }
}
