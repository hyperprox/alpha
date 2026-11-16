// =============================================================================
//  HyperProx — the web proxies' read-only look inside a container
//
//  One script per kind, run in the guest through the remote executor (so a
//  guest HyperProx must leave alone is never entered). Each prints sections as
//  "===HPX:<name>===" and one line of base64, so nothing a config or a log
//  holds can break the framing. Every admin and status interface is read on
//  the container's loopback: nothing is opened to the network.
//
//  The parsers here turn that output into a Reading; they are pure, and the
//  tests run them on output recorded from real installs.
// =============================================================================

import { parseNginxDump, type NginxServer, type NginxUpstream } from './nginx-conf'
import { NGINX_HOSTS_FILE } from '../proxy/providers/nginx'

export type WebProxyKind = 'nginx' | 'caddy' | 'envoy'
export const WEB_PROXY_KINDS: WebProxyKind[] = ['nginx', 'caddy', 'envoy']
export const KIND_NAME: Record<WebProxyKind, string> = { nginx: 'NGINX', caddy: 'Caddy', envoy: 'Envoy' }

// Plain strings (not templates): the shell's ${...} must reach bash as written.
const SECTION = [
  's() { echo "===HPX:$1==="; base64 -w0; echo; }',
  '# Can the container open a TCP connection to each host:port on stdin? Values are passed as arguments, never as code.',
  'reach() { while read -r d; do h=${d%:*}; p=${d##*:}; h=${h#[}; h=${h%]}; case "$p" in \'\'|*[!0-9]*) continue ;; esac',
  '  if timeout 2 bash -c \'</dev/tcp/$0/$1\' "$h" "$p" 2>/dev/null; then echo "$d up"; else echo "$d down"; fi; done; }',
].join('\n')

export const NGINX_PROBE = String.raw`set +e
` + SECTION + String.raw`
if ! command -v nginx >/dev/null 2>&1; then echo "===HPX:missing==="; exit 0; fi
nginx -v 2>&1 | s version
{ nginx -t 2>&1; echo "HPX_RC=$?"; } | s test
{ systemctl is-active nginx 2>/dev/null || true; } | s active
dump=$(nginx -T 2>/dev/null | head -c 3000000)
printf %s "$dump" | s dump
{ printf %s "$dump" | grep -oE '^\s*server\s+[^[:space:]{;]+:[0-9]+' | awk '{print $2}'; printf %s "$dump" | grep -oE 'proxy_pass\s+https?://[^/;$[:space:]]+:[0-9]+' | sed -E 's#.*://##'; } | sort -u | head -n 50 | reach | s reach
curl -fsS --max-time 3 http://127.0.0.1:8081/nginx_status 2>/dev/null | s status
printf %s "$dump" | awk '$1=="ssl_certificate"{gsub(/;$/,"",$2); print $2}' | grep -v '\$' | sort -u | head -n 50 | while read -r c; do
  [ -r "$c" ] && printf '%s\t%s\n' "$c" "$(openssl x509 -noout -startdate -enddate -subject -in "$c" 2>/dev/null | tr '\n' '|')"
done | s certs
logs=$(printf %s "$dump" | awk '$1=="access_log" && $2!="off" && $2 !~ /^syslog:/ {gsub(/;$/,"",$2); print $2}' | grep -v '\$' | sort -u)
[ -n "$logs" ] || logs=/var/log/nginx/access.log
pat=$(for m in 0 1 2 3 4; do LC_ALL=C date -d "-$m min" '+%d/%b/%Y:%H:%M'; done | paste -sd'|')
for l in $logs; do [ -r "$l" ] && tail -n 20000 "$l"; done | LC_ALL=C awk -v p="$pat" 'BEGIN{n=split(p,a,"|"); for(i=1;i<=n;i++) want["[" a[i]]=1} { if (substr($4,1,18) in want && $9 ~ /^[1-5][0-9][0-9]$/) c[substr($9,1,1)]++ } END { for (k in c) print k, c[k] }' | s traffic
{ command -v certbot >/dev/null 2>&1 && echo yes || echo no; } | s certbot
{ command -v openssl >/dev/null 2>&1 && echo yes || echo no; } | s openssl
`

export const CADDY_PROBE = String.raw`set +e
` + SECTION + String.raw`
if ! command -v caddy >/dev/null 2>&1; then echo "===HPX:missing==="; exit 0; fi
caddy version 2>&1 | head -n 1 | s version
for u in caddy-api caddy; do printf '%s %s\n' "$u" "$(systemctl is-active $u 2>/dev/null || true)"; done | s active
cfg=$(curl -fsS --max-time 5 http://127.0.0.1:2019/config/ 2>/dev/null)
printf %s "$cfg" | s config
printf %s "$cfg" | grep -oE '"dial":"[^"]+"' | cut -d'"' -f4 | sort -u | head -n 50 | reach | s reach
curl -fsS --max-time 5 http://127.0.0.1:2019/reverse_proxy/upstreams 2>/dev/null | s upstreams
for d in /var/lib/caddy/.local/share/caddy/certificates /root/.local/share/caddy/certificates /data/caddy/certificates; do
  [ -d "$d" ] && find "$d" -name '*.crt' 2>/dev/null | head -n 200
done | while read -r c; do printf '%s\t%s\n' "$c" "$(openssl x509 -noout -startdate -enddate -subject -issuer -in "$c" 2>/dev/null | tr '\n' '|')"; done | s certs
{ command -v openssl >/dev/null 2>&1 && echo yes || echo no; } | s openssl
`

export const ENVOY_PROBE = String.raw`set +e
` + SECTION + String.raw`
e=$(command -v envoy || ls /usr/local/bin/envoy 2>/dev/null)
if [ -z "$e" ]; then echo "===HPX:missing==="; exit 0; fi
"$e" --version 2>&1 | s version
{ systemctl is-active envoy 2>/dev/null || true; } | s active
a=127.0.0.1:9901
if ! curl -fsS --max-time 3 -o /dev/null "http://$a/ready" 2>/dev/null && ! curl -sS --max-time 3 -o /dev/null "http://$a/server_info" 2>/dev/null; then
  for p in $(ss -ltnpH 2>/dev/null | grep '"envoy"' | awk '{print $4}' | grep -E '^(127\.0\.0\.1|\[::1\]):'); do
    curl -fsS --max-time 3 -o /dev/null "http://$p/server_info" 2>/dev/null && { a=$p; break; }
  done
fi
echo "$a" | s admin
# server_info is large (every command-line option); its first lines hold the version, state and uptime.
curl -sS --max-time 5 "http://$a/server_info" 2>/dev/null | head -c 4000 | s info
curl -sS --max-time 5 "http://$a/clusters?format=json" 2>/dev/null | s clusters
curl -sS --max-time 5 "http://$a/listeners?format=json" 2>/dev/null | s listeners
curl -sS --max-time 5 -G --data-urlencode format=json --data-urlencode 'filter=^(http\.[^.]+\.downstream_rq_(total|[1-5]xx)|server\.(live|state|uptime))$' "http://$a/stats" 2>/dev/null | s stats
ls /etc/envoy/dynamic/*.yaml 2>/dev/null | s dynamic
{ systemctl cat envoy >/dev/null 2>&1 && echo yes || echo no; } | s unit
`

export const PROBES: Record<WebProxyKind, string> = { nginx: NGINX_PROBE, caddy: CADDY_PROBE, envoy: ENVOY_PROBE }

/** The sections of a probe's output, decoded. */
export function sections(out: string): Record<string, string> {
  const r: Record<string, string> = {}
  const lines = out.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^===HPX:([a-z]+)===\s*$/.exec(lines[i])
    if (!m) continue
    const next = lines[i + 1] ?? ''
    r[m[1]] = /^[A-Za-z0-9+/=]*$/.test(next.trim()) ? Buffer.from(next.trim(), 'base64').toString('utf8') : ''
  }
  return r
}

const json = (s: string | undefined): any => { try { return s && s.trim() ? JSON.parse(s) : null } catch { return null } }
const DAY = 86_400_000

export interface Cert {
  name: string; path: string; notAfter: string | null; daysLeft: number | null; issuer?: string
  /** Past the point a renewal should have happened: the last quarter of its life, or under 21 days, whichever is shorter. */
  ending: boolean
  expired: boolean
}

/** "path\tnotBefore=...|notAfter=...|subject=...|issuer=..." lines (openssl x509 -startdate -enddate -subject [-issuer]). */
export function parseCerts(text: string | undefined, now: number): Cert[] {
  const out: Cert[] = []
  for (const line of (text ?? '').split('\n')) {
    const [path, info = ''] = line.split('\t')
    if (!path?.trim()) continue
    const fields = Object.fromEntries(info.split('|').filter(Boolean).map(f => { const i = f.indexOf('='); return [f.slice(0, i).trim(), f.slice(i + 1).trim()] }))
    const t = fields.notAfter ? Date.parse(fields.notAfter) : NaN
    const from = fields.notBefore ? Date.parse(fields.notBefore) : NaN
    const life = Number.isFinite(from) && Number.isFinite(t) ? t - from : 90 * DAY
    const left = t - now
    const cn = /CN\s*=\s*([^,/]+)/.exec(fields.subject ?? '')?.[1]?.trim()
    const issuer = /(?:O|CN)\s*=\s*([^,/]+)/.exec(fields.issuer ?? '')?.[1]?.trim()
    out.push({
      name: cn ?? path.split('/').slice(-1)[0].replace(/\.(crt|pem)$/, ''), path,
      notAfter: Number.isFinite(t) ? new Date(t).toISOString() : null,
      daysLeft: Number.isFinite(t) ? Math.floor(left / DAY) : null,
      ending: Number.isFinite(t) && left >= 0 && left < Math.min(life / 4, 21 * DAY),
      expired: Number.isFinite(t) && left < 0,
      ...(issuer ? { issuer } : {}),
    })
  }
  return out.sort((a, b) => (a.daysLeft ?? 1e9) - (b.daysLeft ?? 1e9))
}

// ── NGINX ─────────────────────────────────────────────────────────────────

/** "host:port up|down" lines: whether the container could open a connection to each upstream. */
export function parseReach(text: string | undefined): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const line of (text ?? '').split('\n')) { const m = /^(\S+) (up|down)$/.exec(line.trim()); if (m) out[m[1]] = m[2] === 'up' }
  return out
}

export interface NginxReading {
  kind: 'nginx'
  version: string | null
  running: boolean | null
  configOk: boolean
  /** The last lines of nginx -t, as it said them. */
  configMessage: string
  status: { active: number; accepts: number; handled: number; requests: number; reading: number; writing: number; waiting: number } | null
  sites: Array<NginxServer & { owned: boolean }>
  upstreams: NginxUpstream[]
  certs: Cert[]
  /** Requests in the last five minutes by status class, from the access logs. */
  traffic: { total: number; byClass: Record<'1' | '2' | '3' | '4' | '5', number>; errorRate: number | null }
  certbot: boolean
  openssl: boolean
  /** Each upstream server and proxy_pass address, and whether the container reaches it. */
  reach: Record<string, boolean>
}

export function parseNginx(out: string, now: number): NginxReading | null {
  const s = sections(out)
  if ('missing' in s) return null
  const st = /Active connections:\s*(\d+)[\s\S]*?\n\s*(\d+)\s+(\d+)\s+(\d+)[\s\S]*?Reading:\s*(\d+)\s+Writing:\s*(\d+)\s+Waiting:\s*(\d+)/.exec(s.status ?? '')
  const conf = parseNginxDump(s.dump ?? '')
  const byClass = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 } as NginxReading['traffic']['byClass']
  for (const line of (s.traffic ?? '').split('\n')) {
    const m = /^([1-5]) (\d+)$/.exec(line.trim())
    if (m) byClass[m[1] as keyof typeof byClass] = Number(m[2])
  }
  const total = Object.values(byClass).reduce((a, b) => a + b, 0)
  const active = (s.active ?? '').trim()
  const test = (s.test ?? '').trim()
  return {
    kind: 'nginx',
    version: /nginx\/([\d.]+)/.exec(s.version ?? '')?.[1] ?? null,
    running: active === 'active' ? true : active === 'inactive' || active === 'failed' ? false : null,
    configOk: /HPX_RC=0\s*$/.test(test),
    configMessage: test.replace(/\n?HPX_RC=\d+\s*$/, '').split('\n').slice(-3).join('\n'),
    status: st ? { active: +st[1], accepts: +st[2], handled: +st[3], requests: +st[4], reading: +st[5], writing: +st[6], waiting: +st[7] } : null,
    sites: conf.servers.map(x => ({ ...x, owned: x.file === NGINX_HOSTS_FILE })),
    upstreams: conf.upstreams,
    certs: parseCerts(s.certs, now),
    traffic: { total, byClass, errorRate: total ? byClass['5'] / total : null },
    certbot: (s.certbot ?? '').trim() === 'yes',
    openssl: (s.openssl ?? '').trim() === 'yes',
    reach: parseReach(s.reach),
  }
}

// ── Caddy ─────────────────────────────────────────────────────────────────

export interface CaddyRoute { id: string | null; server: string; hosts: string[]; upstreams: string[]; handler: string }
export interface CaddyReading {
  kind: 'caddy'
  version: string | null
  /** The systemd unit that runs it (caddy-api for HyperProx's install), and whether it is running. */
  unit: string | null
  running: boolean | null
  adminOk: boolean
  servers: Array<{ name: string; listen: string[] }>
  routes: CaddyRoute[]
  /** Caddy's own counts per upstream, and whether the container reaches it now. */
  upstreams: Array<{ address: string; requests: number; fails: number; reachable: boolean | null }>
  certs: Cert[]
  /** Names on routes of a server that listens on :443, with no certificate on disk yet. */
  missingCerts: string[]
  persist: boolean
  openssl: boolean
}

function handlerOf(handles: any[] | undefined, acc: { upstreams: string[]; kinds: string[] }): void {
  for (const h of handles ?? []) {
    if (!h || typeof h !== 'object') continue
    if (h.handler === 'reverse_proxy') { acc.kinds.push('proxy'); for (const u of h.upstreams ?? []) if (u?.dial) acc.upstreams.push(String(u.dial)) }
    else if (h.handler === 'subroute') for (const r of h.routes ?? []) handlerOf(r.handle, acc)
    else if (h.handler === 'static_response') acc.kinds.push('static')
    else if (h.handler === 'file_server') acc.kinds.push('files')
    else if (h.handler !== 'vars') acc.kinds.push(String(h.handler))
  }
}

export function parseCaddy(out: string, now: number): CaddyReading | null {
  const s = sections(out)
  if ('missing' in s) return null
  const units = Object.fromEntries((s.active ?? '').split('\n').map(l => l.trim().split(/\s+/)).filter(p => p[0]).map(p => [p[0], p[1] ?? '']))
  const unit = units['caddy-api'] === 'active' ? 'caddy-api' : units.caddy === 'active' ? 'caddy' : units['caddy-api'] ? 'caddy-api' : null
  const cfg = json(s.config)
  const servers: CaddyReading['servers'] = []
  const routes: CaddyRoute[] = []
  const tlsHosts = new Set<string>()
  for (const [name, srv] of Object.entries<any>(cfg?.apps?.http?.servers ?? {})) {
    const listen = (srv?.listen ?? []).map(String)
    servers.push({ name, listen })
    for (const r of srv?.routes ?? []) {
      const hosts = (r.match ?? []).flatMap((m: any) => m?.host ?? []).map((h: string) => String(h).toLowerCase())
      const acc = { upstreams: [] as string[], kinds: [] as string[] }
      handlerOf(r.handle, acc)
      routes.push({ id: r['@id'] ?? null, server: name, hosts, upstreams: acc.upstreams, handler: acc.kinds[0] ?? 'none' })
      if (listen.some((l: string) => /:443$/.test(l)) && !srv?.automatic_https?.disable) for (const h of hosts) if (!h.includes('*') && /\./.test(h)) tlsHosts.add(h)
    }
  }
  const reach = parseReach(s.reach)
  const counted = (json(s.upstreams) ?? []).map((u: any) => ({ address: String(u.address ?? ''), requests: Number(u.num_requests ?? 0), fails: Number(u.fails ?? 0), reachable: reach[String(u.address ?? '')] ?? null }))
  // An upstream in the configuration that Caddy has not counted yet is still listed, with its reach.
  const upstreams = [...counted, ...Object.keys(reach).filter(a => !counted.some((u: { address: string }) => u.address === a)).map(a => ({ address: a, requests: 0, fails: 0, reachable: reach[a] }))]
    .sort((a, b) => a.address.localeCompare(b.address))
  const certs = parseCerts(s.certs, now)
  const have = new Set(certs.map(c => c.name.toLowerCase()))
  return {
    kind: 'caddy',
    version: /v(\d+\.\d+\.\d+)/.exec(s.version ?? '')?.[1] ?? null,
    unit, running: unit ? units[unit] === 'active' : null,
    adminOk: !!cfg, servers, routes, upstreams, certs,
    missingCerts: [...tlsHosts].filter(h => !have.has(h)).sort(),
    persist: cfg?.admin?.config?.persist !== false,
    openssl: (s.openssl ?? '').trim() === 'yes',
  }
}

// ── Envoy ─────────────────────────────────────────────────────────────────

export interface EnvoyHost { address: string; healthy: boolean; flags: string[]; requests: number; errors: number }
export interface EnvoyReading {
  kind: 'envoy'
  version: string | null
  running: boolean | null
  admin: string
  adminOk: boolean
  /** LIVE, DRAINING, PRE_INITIALIZING, INITIALIZING. */
  state: string | null
  uptimeSeconds: number | null
  /** Envoy's own health check answers "failed": a load balancer in front takes it out of rotation. */
  draining: boolean
  listeners: Array<{ name: string; address: string }>
  clusters: Array<{ name: string; hosts: EnvoyHost[] }>
  /** Since Envoy started, across its HTTP listeners. */
  requests: { total: number; byClass: Record<'1' | '2' | '3' | '4' | '5', number>; errorRate: number | null }
  /** Listeners and clusters come from watched files (HyperProx's install); otherwise from the bootstrap file. */
  dynamicFiles: string[]
  unit: boolean
}

const addr = (a: any): string => {
  const sa = a?.socket_address
  return sa ? `${sa.address}:${sa.port_value}` : a?.pipe?.path ?? ''
}

export function parseEnvoy(out: string): EnvoyReading | null {
  const s = sections(out)
  if ('missing' in s) return null
  // server_info arrives cut short (see the probe): its fields are read by name, not parsed as a whole.
  const field = (k: string) => new RegExp(`"${k}"\\s*:\\s*"([^"]*)"`).exec(s.info ?? '')?.[1] ?? null
  const info = (s.info ?? '').includes('"state"') ? { version: field('version'), state: field('state'), uptime_current_epoch: field('uptime_current_epoch') } : null
  const clustersJ = json(s.clusters)
  const listenersJ = json(s.listeners)
  const stats: Array<{ name: string; value: number }> = json(s.stats)?.stats ?? []
  const byClass = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 } as EnvoyReading['requests']['byClass']
  let total = 0
  for (const st of stats) {
    const m = /^http\.([^.]+)\.downstream_rq_(total|[1-5]xx)$/.exec(st.name ?? '')
    if (!m || m[1] === 'admin') continue
    if (m[2] === 'total') total += Number(st.value ?? 0)
    else byClass[m[2][0] as keyof typeof byClass] += Number(st.value ?? 0)
  }
  const live = stats.find(x => x.name === 'server.live')
  const clusters = (clustersJ?.cluster_statuses ?? []).map((c: any) => ({
    name: String(c.name ?? ''),
    hosts: (c.host_statuses ?? []).map((h: any): EnvoyHost => {
      const hs = h.health_status ?? {}
      const flags = Object.entries(hs).filter(([k, v]) => k !== 'eds_health_status' && v === true).map(([k]) => k.replace(/^failed_/, '').replace(/_/g, ' '))
      const eds = String(hs.eds_health_status ?? 'HEALTHY')
      if (eds !== 'HEALTHY' && eds !== 'UNKNOWN') flags.push(eds.toLowerCase())
      const val = (n: string) => Number((h.stats ?? []).find((x: any) => x.name === n)?.value ?? 0)
      return { address: addr(h.address), healthy: flags.length === 0, flags, requests: val('rq_total'), errors: val('rq_error') }
    }),
  }))
  const active = (s.active ?? '').trim()
  return {
    kind: 'envoy',
    version: /\/(\d+\.\d+\.\d+)\//.exec(s.version ?? '')?.[1] ?? /\/(\d+\.\d+\.\d+)\//.exec(info?.version ?? '')?.[1] ?? null,
    running: active === 'active' ? true : active === 'inactive' || active === 'failed' ? false : null,
    admin: (s.admin ?? '').trim(), adminOk: !!info,
    state: info?.state ?? null,
    uptimeSeconds: info?.uptime_current_epoch ? Number(String(info.uptime_current_epoch).replace(/s$/, '')) : null,
    draining: info?.state === 'DRAINING' || (!!live && Number(live.value) === 0),
    listeners: (listenersJ?.listener_statuses ?? []).map((l: any) => ({ name: String(l.name ?? ''), address: addr(l.local_address) })),
    clusters,
    requests: { total, byClass, errorRate: total ? byClass['5'] / total : null },
    dynamicFiles: (s.dynamic ?? '').split('\n').map(x => x.trim()).filter(Boolean),
    unit: (s.unit ?? '').trim() === 'yes',
  }
}
