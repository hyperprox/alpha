// =============================================================================
//  HyperProx — Arr Stack VPN (Gluetun) panel: what is read, and what it means (pure)
//
//  The Catalogue's Arr Stack, with its VPN option, runs a container named `gluetun` and puts qBittorrent in its network
//  (lib/arr/compose.ts). Everything here is read INSIDE the stack's guest, through the same pct exec path the other
//  plug-ins use (lib/remote/executor.ts):
//
//   - Docker's own view of the two containers: running, Gluetun's health check, when each started, and whether
//     qBittorrent really shares Gluetun's network;
//   - Gluetun's settings, filtered IN THE GUEST to a short list that holds no secret (provider, VPN type, port
//     forwarding on/off, the chosen countries, regions or cities): a password or key never leaves the guest;
//   - the forwarded port from Gluetun's own status file (/gluetun/forwarded_port), which works whatever the control
//     server's authentication says;
//   - Gluetun's control server on 127.0.0.1:8000 inside the container (GET /v1/vpn/status, /v1/publicip/ip,
//     /v1/portforward). Gluetun v3.41 still answers these GETs without a key (it logs that they will need one later);
//     if one is ever refused, the panel falls back to the status file and Docker's health check;
//   - qBittorrent's listening port and transfer figures from inside Gluetun's network (127.0.0.1:8080: the Catalogue
//     turns on "bypass authentication for localhost" when port forwarding is on). The plug-in's own qBittorrent
//     connection is used first when it has one.
//
//  Tested with recorded answers (test/arr-vpn.test.ts).
// =============================================================================

/** The reading script. Each value is base64 so nothing in it is read as a marker; secrets are filtered out here. */
export const READ_SCRIPT = String.raw`set -u
b64() { base64 -w0 2>/dev/null || base64 | tr -d '\n'; }
mark() { printf '@@%s %s\n' "$1" "$(printf '%s' "$2" | b64)"; }
command -v docker >/dev/null 2>&1 || { echo '@@nodocker'; exit 0; }
st=$(docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.State.StartedAt}}|{{.RestartCount}}|{{.Id}}' gluetun 2>/dev/null) || { echo '@@nogluetun'; exit 0; }
mark state "$st"
# Only these settings, never a password or key.
mark env "$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' gluetun 2>/dev/null | grep -E '^(VPN_SERVICE_PROVIDER|VPN_TYPE|VPN_PORT_FORWARDING|SERVER_COUNTRIES|SERVER_REGIONS|SERVER_CITIES)=' | head -n 6 | cut -c1-200)"
mark qbit "$(docker inspect --format '{{.State.Status}}|{{.State.StartedAt}}|{{.HostConfig.NetworkMode}}' qbittorrent 2>/dev/null)"
if [ "$(printf '%s' "$st" | cut -d'|' -f1)" = running ]; then
  mark port "$(docker exec gluetun cat /gluetun/forwarded_port 2>/dev/null | head -c 64)"
  mark ipfile "$(docker exec gluetun cat /tmp/gluetun/ip 2>/dev/null | head -c 64)"
  ctl() { docker exec gluetun wget -qO- -T 5 "http://127.0.0.1:8000$1" 2>/dev/null | head -c 2048; }
  mark vpnstatus "$(ctl /v1/vpn/status)"
  mark publicip "$(ctl /v1/publicip/ip)"
  mark pf "$(ctl /v1/portforward)"
  mark listen "$(docker exec gluetun wget -qO- -T 5 http://127.0.0.1:8080/api/v2/app/preferences 2>/dev/null | grep -oE '"listen_port":[0-9]+' | head -n 1)"
  mark transfer "$(docker exec gluetun wget -qO- -T 5 http://127.0.0.1:8080/api/v2/transfer/info 2>/dev/null | head -c 2048)"
fi
echo '@@end'
`

/** What the script printed, decoded. */
export interface VpnReading {
  /** Docker is missing in the guest, or there is no container called gluetun. */
  docker: boolean
  present: boolean
  complete: boolean
  state?: string; health?: string; startedAt?: string; restarts?: number; id?: string
  env: Record<string, string>
  qbit?: { state: string; startedAt: string; networkMode: string }
  portFile?: string; ipFile?: string
  vpnStatus?: any; publicIp?: any; portForward?: any
  listenPort?: number | null
  transfer?: any
}

const json = (s: string | undefined): any => { if (!s) return undefined; try { return JSON.parse(s) } catch { return undefined } }

export function parseReading(output: string): VpnReading {
  const out = String(output ?? '')
  const lines = out.split('\n')
  const r: VpnReading = { docker: !lines.includes('@@nodocker'), present: false, complete: lines.includes('@@end'), env: {} }
  if (!r.docker || lines.includes('@@nogluetun')) return r
  const v: Record<string, string> = {}
  for (const l of lines) {
    const m = /^@@([a-z]+) ?([A-Za-z0-9+/=]*)$/.exec(l.trim())
    if (m && m[1] !== 'end') v[m[1]] = Buffer.from(m[2] ?? '', 'base64').toString('utf8').trim()
  }
  if (v.state === undefined) return r
  r.present = true
  const [state, health, startedAt, restarts, id] = v.state.split('|')
  Object.assign(r, { state, health: health || undefined, startedAt, restarts: Number(restarts) || 0, id })
  for (const l of (v.env ?? '').split('\n')) {
    const i = l.indexOf('=')
    const k = l.slice(0, i)
    if (i > 0 && /^(VPN_SERVICE_PROVIDER|VPN_TYPE|VPN_PORT_FORWARDING|SERVER_COUNTRIES|SERVER_REGIONS|SERVER_CITIES)$/.test(k)) r.env[k] = l.slice(i + 1).slice(0, 200)
  }
  if (v.qbit) { const [qs, qa, nm] = v.qbit.split('|'); r.qbit = { state: qs, startedAt: qa, networkMode: nm ?? '' } }
  r.portFile = v.port || undefined
  r.ipFile = v.ipfile || undefined
  r.vpnStatus = json(v.vpnstatus)
  r.publicIp = json(v.publicip)
  r.portForward = json(v.pf)
  const lp = /"listen_port":(\d+)/.exec(v.listen ?? '')
  r.listenPort = lp ? Number(lp[1]) : null
  r.transfer = json(v.transfer)
  return r
}

export type FixName = 'set-port' | 'reconnect' | 'restart-qbit'
export interface VpnProblem { code: 'down' | 'no-port' | 'mismatch' | 'firewalled' | 'qbit-stale' | 'not-behind' | 'qbit-down'; text: string; fix?: FixName }

export interface VpnStatus {
  /** False: this stack has no Gluetun (the panel says so and offers nothing). */
  present: boolean
  /** Why it could not be read, in plain words (no guest found, not running, ...). */
  unavailable?: string
  guest?: string
  tunnel: 'up' | 'down' | 'unknown'
  health: string | null
  provider: string | null
  vpnType: string | null
  /** Where the tunnel comes out, as Gluetun's public-IP lookup reports it. */
  location: string | null
  /** The region, country or city chosen in the stack's settings. */
  chosen: string | null
  publicIp: string | null
  /** True when the address is withheld (not an admin). */
  publicIpHidden?: boolean
  portForwarding: boolean
  forwardedPort: number | null
  listenPort: number | null
  portMatch: 'ok' | 'mismatch' | 'no-port' | 'off' | 'unknown'
  downBps: number | null
  upBps: number | null
  connection: 'connected' | 'firewalled' | 'disconnected' | null
  startedAt: string | null
  uptimeSec: number | null
  problems: VpnProblem[]
  readAt: string
}

const port = (v: unknown): number | null => { const n = Number(String(v ?? '').trim()); return Number.isInteger(n) && n > 0 && n < 65536 ? n : null }
const num = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null }
const ip = (v: unknown): string | null => { const s = String(v ?? '').trim(); return /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-fA-F:]{2,39})$/.test(s) ? s : null }
const words = (v: unknown, max = 60) => String(v ?? '').replace(/[^\p{L}\p{N} ,.'()-]/gu, '').trim().slice(0, max)

/** An empty status: no Gluetun here, or nothing could be read. */
export function absent(now: number, unavailable?: string, present = false): VpnStatus {
  return {
    present, ...(unavailable ? { unavailable } : {}), tunnel: 'unknown', health: null, provider: null, vpnType: null, location: null, chosen: null, publicIp: null,
    portForwarding: false, forwardedPort: null, listenPort: null, portMatch: 'unknown', downBps: null, upBps: null, connection: null,
    startedAt: null, uptimeSec: null, problems: [], readAt: new Date(now).toISOString(),
  }
}

/** The reading (plus qBittorrent's own answers through the plug-in, when it has them), as the panel shows it. */
export function vpnStatus(r: VpnReading, now: number, o: { guest?: string; prefs?: any; transfer?: any } = {}): VpnStatus {
  if (!r.docker) return absent(now, 'Docker is not installed in the Arr Stack\'s container.')
  if (!r.present) return absent(now)
  const s = absent(now, undefined, true)
  if (o.guest) s.guest = o.guest
  s.health = r.health ?? null
  s.provider = r.env.VPN_SERVICE_PROVIDER ? words(r.env.VPN_SERVICE_PROVIDER, 40) : null
  s.vpnType = r.env.VPN_TYPE === 'wireguard' ? 'WireGuard' : r.env.VPN_TYPE === 'openvpn' ? 'OpenVPN' : null
  s.chosen = words(r.env.SERVER_CITIES || r.env.SERVER_REGIONS || r.env.SERVER_COUNTRIES || '', 80) || null
  s.portForwarding = /^(on|yes|true)$/i.test(r.env.VPN_PORT_FORWARDING ?? '')
  const running = r.state === 'running'
  const vs = typeof r.vpnStatus?.status === 'string' ? r.vpnStatus.status : null
  s.tunnel = !running || r.health === 'unhealthy' || (vs !== null && vs !== 'running') ? 'down'
    : vs === 'running' || r.health === 'healthy' ? 'up' : 'unknown'
  if (running && r.startedAt && Number.isFinite(Date.parse(r.startedAt))) {
    s.startedAt = new Date(Date.parse(r.startedAt)).toISOString()
    s.uptimeSec = Math.max(0, Math.round((now - Date.parse(r.startedAt)) / 1000))
  }
  const pi = r.publicIp ?? {}
  s.publicIp = s.tunnel === 'down' ? null : ip(pi.public_ip) ?? ip(r.ipFile)
  const where = [words(pi.city, 40), words(pi.region, 40), words(pi.country, 40)].filter(Boolean)
  s.location = s.tunnel === 'down' || !where.length ? null : [...new Set(where)].join(', ')
  s.forwardedPort = port(r.portFile) ?? port(r.portForward?.port)
  s.listenPort = port(o.prefs?.listen_port) ?? port(r.listenPort)
  const t = o.transfer ?? r.transfer
  s.downBps = num(t?.dl_info_speed); s.upBps = num(t?.up_info_speed)
  s.connection = t?.connection_status === 'connected' || t?.connection_status === 'firewalled' || t?.connection_status === 'disconnected' ? t.connection_status : null
  s.portMatch = !s.portForwarding ? 'off' : s.forwardedPort === null ? 'no-port' : s.listenPort === null ? 'unknown' : s.forwardedPort === s.listenPort ? 'ok' : 'mismatch'

  const p: VpnProblem[] = []
  if (s.tunnel === 'down') {
    p.push({ code: 'down', fix: 'reconnect', text: !running ? `The VPN container is ${words(r.state, 20) || 'stopped'}, so qBittorrent has no network: nothing downloads.`
      : 'The tunnel is down, so qBittorrent has no network (the kill switch is holding): nothing downloads.' })
  }
  const q = r.qbit
  if (q && q.state !== 'running') p.push({ code: 'qbit-down', fix: 'restart-qbit', text: `qBittorrent is ${words(q.state, 20) || 'stopped'}.` })
  if (q && q.state === 'running' && r.id && !q.networkMode.startsWith(`container:${r.id}`) && !/^service:gluetun$/.test(q.networkMode)) {
    p.push({ code: 'not-behind', text: 'qBittorrent is not using the VPN\'s network, so its traffic may not go through the tunnel. Its compose settings need network_mode: "service:gluetun".' })
  } else if (q && q.state === 'running' && running && Date.parse(q.startedAt) + 5000 < Date.parse(r.startedAt ?? '')) {
    // Gluetun restarted after qBittorrent: qBittorrent still holds the old network, which no longer exists.
    p.push({ code: 'qbit-stale', fix: 'restart-qbit', text: 'The VPN restarted after qBittorrent did, so qBittorrent is left on a network that no longer exists. It needs a restart.' })
  }
  if (s.tunnel !== 'down' && s.portMatch === 'no-port') p.push({ code: 'no-port', fix: 'reconnect', text: 'Port forwarding is on, but the VPN has not handed out a port, so other people cannot connect to you and many torrents crawl.' })
  if (s.tunnel !== 'down' && s.portMatch === 'mismatch') p.push({ code: 'mismatch', fix: 'set-port', text: `The VPN forwards port ${s.forwardedPort}, but qBittorrent listens on ${s.listenPort}, so nobody can connect to you and many torrents crawl.` })
  if (s.tunnel === 'up' && s.portMatch === 'ok' && s.connection === 'firewalled') p.push({ code: 'firewalled', fix: 'reconnect', text: 'qBittorrent says it is firewalled even though the ports match: the forwarded port may have gone stale.' })
  s.problems = p
  return s
}

/** What a viewer sees: everything but the tunnel's public address. */
export function forViewer(s: VpnStatus): VpnStatus {
  return { ...s, publicIp: null, ...(s.publicIp ? { publicIpHidden: true } : {}) }
}

// ── the alert: a problem that lasts more than ten minutes, said once, and its all-clear ─────────────────────────

/** The problems that raise an alert, and the hold before one does. */
export const ALERT_CODES = ['down', 'no-port', 'mismatch'] as const
export const ALERT_AFTER_MS = 10 * 60_000

export interface AlertState { since: Record<string, number>; announced: Record<string, boolean> }
export const emptyAlertState = (): AlertState => ({ since: {}, announced: {} })

/** One look: which alerts start now, and which announced ones have cleared. Pure. */
export function alertStep(prev: AlertState, problems: VpnProblem[], now: number, holdMs = ALERT_AFTER_MS): { state: AlertState; fire: VpnProblem[]; clear: string[] } {
  const state: AlertState = { since: { ...prev.since }, announced: { ...prev.announced } }
  const fire: VpnProblem[] = [], clear: string[] = []
  for (const code of ALERT_CODES) {
    const p = problems.find(x => x.code === code)
    if (p) {
      state.since[code] ??= now
      if (!state.announced[code] && now - state.since[code] >= holdMs) { state.announced[code] = true; fire.push(p) }
    } else {
      delete state.since[code]
      if (state.announced[code]) { delete state.announced[code]; clear.push(code) }
    }
  }
  return { state, fire, clear }
}
