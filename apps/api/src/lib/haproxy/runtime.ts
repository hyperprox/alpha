// =============================================================================
//  HyperProx — HAProxy: the Runtime API commands HyperProx may send, and what it reads back
//
//  The Runtime API (the admin socket, /run/haproxy/admin.sock) can do anything
//  to a running HAProxy: shut every session, delete servers, change maps. The
//  plug-in needs a handful of its commands, so a handful are listed here, each
//  built from checked names and numbers. A backend or server name is HAProxy's
//  own identifier syntax (letters, digits, - _ . :), an address is an IPv4
//  address or a host name, a port and a weight are numbers in range. Nothing a
//  person typed reaches the socket as anything else.
//
//  The script that carries the commands runs inside the guest through the
//  remote executor (stdin to `bash -s`); the commands themselves travel in a
//  quoted heredoc, never on a command line.
//
//  Readers: `show info` (key: value lines), `show stat` (CSV with a "# " header
//  line, fields by name, never by position: the column list grows between
//  releases) and `show servers state` (space-separated, header by name too).
// =============================================================================

export class RuntimeRefusal extends Error {
  constructor(message: string) { super(message); this.name = 'RuntimeRefusal' }
}

/** HAProxy's identifier characters (proxy and server names). */
export const NAME_RE = /^[A-Za-z0-9_.:-]{1,64}$/
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/
export const SOCKET_RE = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.sock$/

export function checkName(v: unknown, what: string): string {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!NAME_RE.test(s)) throw new RuntimeRefusal(`${what} must be letters, digits and - _ . : only (up to 64).`)
  return s
}

export function checkAddress(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!IPV4_RE.test(s) && !HOST_RE.test(s)) throw new RuntimeRefusal('The address is an IPv4 address or a host name.')
  return s
}

export function checkPort(v: unknown): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new RuntimeRefusal('The port is a whole number from 1 to 65535.')
  return n
}

/** HAProxy takes weights from 0 to 256; 0 sends a server no new traffic. */
export function checkWeight(v: unknown): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0 || n > 256) throw new RuntimeRefusal('A weight is a whole number from 0 to 256 (0 sends no new traffic).')
  return n
}

export type AdminState = 'ready' | 'drain' | 'maint'

/** One Runtime API command, built only from checked parts. */
export const RT = {
  setState: (b: string, s: string, state: AdminState) => {
    if (!['ready', 'drain', 'maint'].includes(state)) throw new RuntimeRefusal('The state is ready, drain or maint.')
    return `set server ${checkName(b, 'The backend')}/${checkName(s, 'The server')} state ${state}`
  },
  setWeight: (b: string, s: string, w: unknown) => `set weight ${checkName(b, 'The backend')}/${checkName(s, 'The server')} ${checkWeight(w)}`,
  health: (b: string, s: string, on: boolean) => `${on ? 'enable' : 'disable'} health ${checkName(b, 'The backend')}/${checkName(s, 'The server')}`,
  addServer: (b: string, s: string, addr: string, port: unknown, weight: unknown, check: boolean) =>
    `add server ${checkName(b, 'The backend')}/${checkName(s, 'The server')} ${checkAddress(addr)}:${checkPort(port)} weight ${checkWeight(weight)}${check ? ' check' : ''}`,
  enableServer: (b: string, s: string) => `enable server ${checkName(b, 'The backend')}/${checkName(s, 'The server')}`,
  shutdownSessions: (b: string, s: string) => `shutdown sessions server ${checkName(b, 'The backend')}/${checkName(s, 'The server')}`,
  delServer: (b: string, s: string) => `del server ${checkName(b, 'The backend')}/${checkName(s, 'The server')}`,
} as const

/**
 * The script that sends commands, one connection each (the socket answers one command per connection unless put in
 * prompt mode), and prints each answer between markers. socat is the client; python3 stands in when it is missing.
 */
export function runtimeScript(socket: string, commands: string[]): string {
  if (!SOCKET_RE.test(socket) || socket.includes('..')) throw new RuntimeRefusal('That is not a socket path.')
  for (const c of commands) if (!/^[A-Za-z0-9_.:/ -]{1,300}$/.test(c)) throw new RuntimeRefusal('That is not a command HyperProx sends.')
  return [
    `SOCK='${socket}'`,
    'rt() {',
    '  if command -v socat >/dev/null 2>&1; then printf "%s\\n" "$1" | socat -t 5 - "unix-connect:$SOCK"',
    '  elif command -v python3 >/dev/null 2>&1; then python3 -c \'import socket,sys;s=socket.socket(socket.AF_UNIX);s.settimeout(5);s.connect(sys.argv[1]);s.sendall((sys.argv[2]+"\\n").encode());b=b""\nwhile True:\n  d=s.recv(65536)\n  if not d: break\n  b+=d\nsys.stdout.write(b.decode("utf-8","replace"))\' "$SOCK" "$1"',
    '  else echo "HPX_NO_CLIENT"; fi',
    '}',
    '[ -S "$SOCK" ] || { echo "HPX_NO_SOCKET"; exit 3; }',
    'while IFS= read -r c; do',
    '  [ -n "$c" ] || continue',
    '  echo "### $c"',
    '  rt "$c"',
    'done <<\'HPX_COMMANDS\'',
    ...commands,
    'HPX_COMMANDS',
  ].join('\n')
}

/** The answers of runtimeScript, by command. */
export function splitAnswers(output: string): Map<string, string> {
  const out = new Map<string, string>()
  let cur: string | null = null
  let buf: string[] = []
  for (const line of output.split('\n')) {
    const m = /^### (.+)$/.exec(line)
    if (m) { if (cur !== null) out.set(cur, buf.join('\n')); cur = m[1]; buf = []; continue }
    if (cur !== null) buf.push(line)
  }
  if (cur !== null) out.set(cur, buf.join('\n'))
  return out
}

/**
 * What a command's answer says went wrong, or null. HAProxy answers success with an empty line or a short note
 * ("New server registered.", "Server deleted."); failures name the problem.
 */
export function answerProblem(answer: string): string | null {
  const t = answer.trim()
  if (!t) return null
  if (t === 'HPX_NO_CLIENT') return 'Neither socat nor python3 is installed in the container, so HyperProx cannot talk to HAProxy\'s socket.'
  if (/^(New server registered\.|Server deleted\.|Done\.)$/m.test(t)) return null
  if (/^\d+ \(initial \d+\)$/.test(t)) return null
  if (/(No such|not found|Unknown|cannot|Can't|can only|Require|must be|Invalid|error|failed|denied|Permission)/i.test(t)) return t.split('\n').slice(0, 3).join(' ').slice(0, 300)
  return null
}

// ── readers ────────────────────────────────────────────────────────────────────

export function parseInfo(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

/** `show stat` rows as objects keyed by the header's field names. */
export function parseStat(csv: string): Array<Record<string, string>> {
  const lines = csv.split('\n').map(l => l.trimEnd()).filter(Boolean)
  const head = lines.find(l => l.startsWith('# '))
  if (!head) return []
  const keys = head.slice(2).split(',')
  return lines.filter(l => !l.startsWith('#')).map(l => {
    const v = l.split(',')
    const row: Record<string, string> = {}
    keys.forEach((k, i) => { if (k) row[k] = v[i] ?? '' })
    return row
  }).filter(r => r.pxname && r.svname)
}

/** `show servers state` rows (version line first, then "# field ..." header, then rows), keyed by field name. */
export function parseServersState(text: string): Array<Record<string, string>> {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const head = lines.find(l => l.startsWith('# '))
  if (!head) return []
  const keys = head.slice(2).split(/\s+/)
  return lines.filter(l => !l.startsWith('#') && /^\d+\s/.test(l)).map(l => {
    const v = l.split(/\s+/)
    const row: Record<string, string> = {}
    keys.forEach((k, i) => { row[k] = v[i] ?? '' })
    return row
  })
}

/** srv_check_state bits (HAProxy's CHK_ST_*): configured 0x2, enabled 0x4, paused 0x8. */
export function checkFlags(state: string | undefined): { configured: boolean; enabled: boolean } {
  const n = Number(state)
  if (!Number.isFinite(n)) return { configured: false, enabled: false }
  return { configured: (n & 0x2) !== 0, enabled: (n & 0x4) !== 0 && (n & 0x8) === 0 }
}

/** What a health-check code means, in words (HAProxy's check_status values). */
export const CHECK_WORDS: Record<string, string> = {
  L4OK: 'the port answers', L4TOUT: 'the port did not answer in time', L4CON: 'the connection was refused or could not be made',
  L6OK: 'TLS handshake succeeded', L6TOUT: 'the TLS handshake timed out', L6RSP: 'the TLS answer was not valid',
  L7OK: 'the check page answered correctly', L7OKC: 'the check page answered (conditionally)', L7TOUT: 'the check page did not answer in time',
  L7RSP: 'the check page answered with something that is not HTTP', L7STS: 'the check page answered with an error status',
  HANA: 'the server was marked down after too many errors', SOCKERR: 'a socket error on HAProxy\'s side', INI: 'no check has run yet',
  UNK: 'unknown', PROCERR: 'the external check could not run', PROCTOUT: 'the external check timed out', PROCOK: 'the external check passed',
}

export function checkWords(code: string | undefined, desc: string | undefined, httpCode?: string): string {
  const c = String(code ?? '').replace(/^\*\s*/, '').trim()
  if (!c) return 'no check result'
  const base = CHECK_WORDS[c] ?? c
  const extra = c === 'L7STS' && httpCode ? ` (${httpCode})` : ''
  return `${base}${extra}${desc && !CHECK_WORDS[c] ? `: ${desc}` : ''}`
}

// ── frontends → backends, from the configuration text ──────────────────────────

export interface ConfigMap {
  /** Frontend (or listen section) → the backends its rules send to, default first when there is one. */
  frontends: Record<string, { backends: string[]; defaultBackend: string | null; binds: string[] }>
  backends: Record<string, { balance: string | null }>
}

/** Reads the routing out of haproxy.cfg: default_backend, use_backend (any condition), listen sections, balance. */
export function parseConfigRouting(cfg: string): ConfigMap {
  const map: ConfigMap = { frontends: {}, backends: {} }
  let kind: string | null = null, name: string | null = null
  for (const raw of cfg.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').replace(/^#.*$/, '')
    if (!line.trim()) continue
    const sec = /^(frontend|backend|listen|defaults|global|userlist|peers|resolvers|program|cache|ring|http-errors|mailers|crt-store|traces|acme)\b\s*([^\s]*)/.exec(line)
    if (sec && !/^\s/.test(line)) {
      kind = sec[1]; name = sec[2] || null
      if ((kind === 'frontend' || kind === 'listen') && name) map.frontends[name] ??= { backends: [], defaultBackend: null, binds: [] }
      if ((kind === 'backend' || kind === 'listen') && name) map.backends[name] ??= { balance: null }
      if (kind === 'listen' && name) { map.frontends[name].backends = [name]; map.frontends[name].defaultBackend = name }
      continue
    }
    if (!name) continue
    const t = line.trim().split(/\s+/)
    if ((kind === 'frontend' || kind === 'listen') && map.frontends[name]) {
      const fe = map.frontends[name]
      if (t[0] === 'bind' && t[1]) fe.binds.push(t[1])
      if (t[0] === 'default_backend' && t[1]) { fe.defaultBackend = t[1]; if (!fe.backends.includes(t[1])) fe.backends.unshift(t[1]) }
      if (t[0] === 'use_backend' && t[1] && !fe.backends.includes(t[1])) fe.backends.push(t[1])
    }
    if ((kind === 'backend' || kind === 'listen') && map.backends[name] && t[0] === 'balance' && t[1]) map.backends[name].balance = t[1]
  }
  return map
}
