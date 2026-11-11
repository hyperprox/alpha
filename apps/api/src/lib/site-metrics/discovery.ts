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
// =============================================================================

import { createHash } from 'node:crypto'
import { safeLogPath, safeWordPressPath } from './paths'
import type { SiteKind } from './store'

// ── the read-only look inside one container ─────────────────────────────────

/**
 * The one script run in each candidate container. Read-only: listening ports from /proc, which web servers are
 * installed, nginx -T and Apache's site files filtered to the lines that place logs and roots, and whether a
 * wp-config.php sits in any root. It writes nothing (the exec path stages the script itself, as for every probe).
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
set -f
for R in $(printf '%s\n' $ROOTS | sort -u | head -n 50); do
  case "$R" in /*) ;; *) continue ;; esac
  case "$R" in *[!A-Za-z0-9._/-]*) continue ;; esac
  [ -f "$R/wp-config.php" ] && echo "HPXD1 wp $R"
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
}

const B64 = /^[A-Za-z0-9+/=]*$/
const SAFE_PATH = /^\/[A-Za-z0-9._/-]{0,200}$/

/** The script's answer, parsed. Throws when it did not finish, so a cut-off answer is never read as "nothing there". */
export function parseDiscover(out: string): DiscoverOutput {
  const r: DiscoverOutput = { complete: false, ports: [], bins: [], nginx: null, nginxBroken: false, apache: null, wpRoots: [] }
  for (const raw of out.split('\n')) {
    const l = raw.replace(/\r$/, '')
    if (l === 'HPXD1 end') { r.complete = true; break }
    if (l === 'HPXD1 nginxbad') { r.nginxBroken = true; continue }
    let m = /^HPXD1 listen ([0-9A-Fa-f]{1,4})$/.exec(l)
    if (m) { const p = parseInt(m[1], 16); if (p > 0 && !r.ports.includes(p)) r.ports.push(p); continue }
    m = /^HPXD1 bin (nginx|apache2|httpd|caddy)$/.exec(l)
    if (m) { if (!r.bins.includes(m[1])) r.bins.push(m[1]); continue }
    m = /^HPXD1 nginx ?(\S*)$/.exec(l)
    if (m) { if (B64.test(m[1])) r.nginx = parseNginxConfig(Buffer.from(m[1], 'base64').toString('utf8')); continue }
    m = /^HPXD1 apache (\/etc\/(?:apache2|httpd)) ?(\S*)$/.exec(l)
    if (m) { if (B64.test(m[2])) r.apache = parseApacheConfig(Buffer.from(m[2], 'base64').toString('utf8'), m[1] === '/etc/httpd' ? 'httpd' : 'apache2'); continue }
    m = /^HPXD1 wp (\S+)$/.exec(l)
    if (m && SAFE_PATH.test(m[1]) && !r.wpRoots.includes(m[1])) r.wpRoots.push(m[1])
  }
  if (!r.complete) throw new Error('the look inside did not finish')
  r.ports.sort((a, b) => a - b)
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

// ── one container, inspected ───────────────────────────────────────────────

export interface Inspection {
  server: 'nginx' | 'apache' | 'caddy' | null
  kind: SiteKind
  logPath: string | null
  logFormat: LogChoice['format']
  wpPath: string | null
  /** The proxy's forward port is one this container listens on (null when there is no proxy). */
  forwardPortOpen: boolean | null
  notes: string[]
}

/**
 * One container's answer, for one site on it: the name the proxy sends and the port it sends to. `behindProxy`
 * says whether a missing X-Forwarded-For matters (it does only when a proxy stands in front).
 */
export function inspectFor(out: DiscoverOutput, host: string | null, port: number | null, behindProxy = port !== null): Inspection {
  const notes: string[] = []
  const r: Inspection = { server: null, kind: 'other', logPath: null, logFormat: null, wpPath: null,
    forwardPortOpen: port === null ? null : out.ports.includes(port), notes }
  const wordpressAt = (root: string | null) => {
    if (!root || !out.wpRoots.includes(root)) return false
    r.kind = 'wordpress'
    r.wpPath = safeWordPressPath(root)
    if (!r.wpPath) notes.push('WordPress is outside /var/www and /srv, so its versions cannot be read.')
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
    notes.push('No nginx, Apache or Caddy was found in this container.')
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
  logPath: string | null
  logFormat: LogChoice['format']
  wpPath: string | null
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
        server: grp.ins?.server ?? null, kind: grp.ins?.kind ?? null,
        logPath: grp.ins?.logPath ?? null, logFormat: grp.ins?.logFormat ?? null, wpPath: grp.ins?.wpPath ?? null,
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
