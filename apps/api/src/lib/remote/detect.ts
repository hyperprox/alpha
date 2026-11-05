// =============================================================================
//  HyperProx — VPN clients already on a machine, found without any provider key
//
//  A read-only probe sent to each running node and guest (over the same paths
//  as every other script: the node login, `pct exec`, the guest agent) asks
//  whether tailscale and netbird are there, whether their daemons run, and what
//  the clients report about themselves. Nothing is changed. A sign-in link a
//  client holds (Tailscale's AuthURL) is blanked on the machine before the
//  output leaves it, and only the parsed fields are kept, in memory.
//
//  Results are cached for a few minutes. Only an admin's request (a page load
//  when the cache is stale, or Refresh) starts a probe; a viewer never does.
// =============================================================================

import { TS_PREFS_READBACK, NB_FLAGS_READBACK, parseNetbirdFlags, parseTailscalePrefs } from './scripts'
import type { Machine, ProviderId } from './types'

export interface DetectedClient {
  installed: boolean
  /** Its daemon is running. */
  running: boolean
  /** Signed in to a tailnet / NetBird account (it may still be offline). */
  loggedIn: boolean
  connected: boolean
  /** Tailscale: the tailnet's name. NetBird: the management server. */
  tailnet: string | null
  ip: string | null
  /** MagicDNS or NetBird name, without the trailing dot. */
  dnsName: string | null
  version: string | null
  keyExpiry: string | null
  /** The client's own settings, when it could report them. */
  acceptDns: boolean | null
  acceptRoutes: boolean | null
  ssh: boolean | null
  exitNode: string | null
  advertiseExitNode: boolean
  advertisedRoutes: string[]
}

export interface Detection { tailscale: DetectedClient; netbird: DetectedClient }

const T = 'hp_t() { if command -v timeout >/dev/null 2>&1; then timeout 10 "$@"; else "$@"; fi; }'
const daemon = (unit: string, proc: string) =>
  `hp_d=$(systemctl is-active ${unit} 2>/dev/null | head -n1); [ -z "$hp_d" ] && { pgrep -x ${proc} >/dev/null 2>&1 && hp_d=active || hp_d=inactive; }; echo "$hp_d"`

/** Read-only. Prints markers only; the sign-in link a stopped client holds is blanked before it leaves. */
export const DETECT_CLIENTS_SCRIPT = [
  T,
  'echo HP_DETECT_BEGIN',
  'if command -v tailscale >/dev/null 2>&1; then',
  '  echo "HP_TS_BIN=$(command -v tailscale)"',
  `  echo "HP_TS_DAEMON=$(${daemon('tailscaled', 'tailscaled')})"`,
  '  echo HP_TS_STATUS_BEGIN',
  `  hp_t tailscale status --json --peers=false 2>/dev/null | sed -E 's/("AuthURL"[[:space:]]*:[[:space:]]*")[^"]*"/\\1"/' || true`,
  '  echo; echo HP_TS_STATUS_END',
  TS_PREFS_READBACK.split('\n').map(l => `  ${l.replace(/^tailscale debug prefs/, 'hp_t tailscale debug prefs')}`).join('\n'),
  'else echo HP_TS_BIN=; fi',
  'if command -v netbird >/dev/null 2>&1; then',
  '  echo "HP_NB_BIN=$(command -v netbird)"',
  `  echo "HP_NB_DAEMON=$(${daemon('netbird', 'netbird')})"`,
  `  echo "HP_NB_STATE=$(hp_t netbird status 2>&1 | sed -n 's/^Daemon status: *//p' | head -n1)"`,
  '  echo HP_NB_STATUS_BEGIN',
  '  hp_t netbird status --json 2>/dev/null | tr -d "\\r" || true',
  '  echo; echo HP_NB_STATUS_END',
  NB_FLAGS_READBACK.split('\n').map(l => `  ${l}`).join('\n'),
  'else echo HP_NB_BIN=; fi',
  'echo HP_DETECT_END',
].join('\n')

/** The most a probe may print; past it the read is aborted and the machine reads as an error. */
export const MAX_PROBE_OUTPUT = 512 * 1024
/** Every string field kept from a probe is cut to this, and every list to MAX_LIST entries. */
const MAX_FIELD = 255
const MAX_LIST = 64
const cap = (v: string | null): string | null => (v === null ? null : v.slice(0, MAX_FIELD))

const NONE: DetectedClient = {
  installed: false, running: false, loggedIn: false, connected: false, tailnet: null, ip: null, dnsName: null, version: null, keyExpiry: null,
  acceptDns: null, acceptRoutes: null, ssh: null, exitNode: null, advertiseExitNode: false, advertisedRoutes: [],
}

function block(out: string, name: string): string | null {
  const m = new RegExp(`${name}_BEGIN\\n([\\s\\S]*?)\\n${name}_END`).exec(out)
  return m ? m[1] : null
}
const line = (out: string, k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(out)?.[1]?.trim() ?? ''
const json = (s: string | null): any => { try { return s && s.trim() ? JSON.parse(s.trim()) : null } catch { return null } }
const str = (v: unknown) => (typeof v === 'string' && v ? v : null)

function tailscale(out: string): DetectedClient {
  if (!line(out, 'HP_TS_BIN')) return { ...NONE }
  const j = json(block(out, 'HP_TS_STATUS')) ?? {}
  const state = String(j.BackendState ?? '')
  const self = j.Self ?? {}
  const ips: string[] = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs.map(String) : Array.isArray(j.TailscaleIPs) ? j.TailscaleIPs.map(String) : []
  const prefs = parseTailscalePrefs(out)
  const loggedIn = state === 'Running' || state === 'Starting' || (state === 'Stopped' && j.HaveNodeKey === true && !!str(self.DNSName))
  const expiry = str(self.KeyExpiry)
  return {
    installed: true,
    running: line(out, 'HP_TS_DAEMON') === 'active',
    loggedIn,
    connected: state === 'Running',
    tailnet: str(j.CurrentTailnet?.Name) ?? str(j.MagicDNSSuffix),
    ip: ips.find(i => i.includes('.')) ?? ips[0] ?? null,
    dnsName: str(self.DNSName)?.replace(/\.$/, '') ?? null,
    version: str(j.Version)?.split('-')[0] ?? null,
    keyExpiry: expiry && !expiry.startsWith('0001-') ? expiry : null,
    acceptDns: prefs ? prefs.acceptDns : null,
    acceptRoutes: prefs ? prefs.acceptRoutes : null,
    ssh: prefs ? prefs.ssh : null,
    exitNode: prefs?.exitNode ?? null,
    advertiseExitNode: prefs?.advertiseExitNode ?? false,
    advertisedRoutes: prefs?.subnets ?? (Array.isArray(self.PrimaryRoutes) ? self.PrimaryRoutes.map(String) : []),
  }
}

function netbird(out: string): DetectedClient {
  if (!line(out, 'HP_NB_BIN')) return { ...NONE }
  const j = json(block(out, 'HP_NB_STATUS')) ?? {}
  const state = line(out, 'HP_NB_STATE')
  const flags = parseNetbirdFlags(out)
  const has = !!flags.config
  const connected = j.management?.connected === true
  return {
    installed: true,
    running: line(out, 'HP_NB_DAEMON') === 'active',
    loggedIn: state !== 'NeedsLogin' && state !== 'LoginFailed' && (connected || !!j.netbirdIp),
    connected,
    tailnet: str(j.management?.url),
    ip: str(j.netbirdIp)?.split('/')[0] ?? null,
    dnsName: str(j.fqdn)?.replace(/\.$/, '') ?? null,
    version: str(j.daemonVersion) ?? str(j.cliVersion),
    keyExpiry: null,
    acceptDns: has && 'DisableDNS' in flags ? flags.DisableDNS === false : null,
    acceptRoutes: has && 'DisableClientRoutes' in flags ? flags.DisableClientRoutes === false : null,
    ssh: has && 'ServerSSHAllowed' in flags ? flags.ServerSSHAllowed === true : null,
    exitNode: null, advertiseExitNode: false, advertisedRoutes: [],
  }
}

/** Whatever a machine printed, nothing longer than a sane length is kept. */
function capped(c: DetectedClient): DetectedClient {
  return {
    ...c, tailnet: cap(c.tailnet), ip: cap(c.ip), dnsName: cap(c.dnsName), version: cap(c.version), keyExpiry: cap(c.keyExpiry), exitNode: cap(c.exitNode),
    advertisedRoutes: c.advertisedRoutes.slice(0, MAX_LIST).map(r => r.slice(0, MAX_FIELD)),
  }
}

export function parseDetection(out: string): Detection {
  const body = block(out.slice(0, MAX_PROBE_OUTPUT), 'HP_DETECT') ?? ''
  return { tailscale: capped(tailscale(body)), netbird: capped(netbird(body)) }
}

const LABEL: Record<ProviderId, string> = { tailscale: 'Tailscale', netbird: 'NetBird' }

/** In words, for the page: "Tailscale installed, connected as web.example.ts.net (100.64.0.5)". */
export function describeDetected(p: ProviderId, c: DetectedClient): string {
  if (!c.installed) return 'not installed'
  if (!c.running) return `${LABEL[p]} installed, not running`
  if (!c.loggedIn) return `${LABEL[p]} installed, signed out`
  if (!c.connected) return `${LABEL[p]} installed, signed in but offline`
  const who = c.dnsName ?? c.ip ?? 'this machine'
  return `${LABEL[p]} installed, connected as ${who}${c.ip && c.dnsName ? ` (${c.ip})` : ''}`
}

// ── The cache ──────────────────────────────────────────────────────────────

export interface DetectEntry {
  machineId: string
  at: number
  result: Detection | null
  /** Why it could not be read (unreachable, no login saved, HyperProx locked). */
  error: string | null
  /** This is HyperProx's own container, read locally. */
  self: boolean
}

export interface DetectorDeps {
  listMachines(): Promise<Machine[]>
  run(m: Machine, script: string, o?: { timeoutMs?: number; maxOutputBytes?: number }): Promise<{ code: number; output: string; timedOut: boolean; truncated?: boolean }>
  /** Run the probe on the machine HyperProx itself runs on, with no login (HyperProx's own container). */
  local?: (script: string) => Promise<{ code: number; output: string; timedOut: boolean; truncated?: boolean }>
  /** Guests HyperProx must never look inside (the VPN page's setting, or the `hyperprox-ignore` tag). */
  excluded?: (m: Machine) => Promise<boolean>
  /** HyperProx's own machine id, if it is one of the listed guests. */
  selfId?: () => Promise<string | null>
  now?: () => number
  ttlMs?: number
  concurrency?: number
}

export const DETECT_TTL_MS = 5 * 60_000

export class ClientDetector {
  private entries = new Map<string, DetectEntry>()
  private last: number | null = null
  private inflight: Promise<void> | null = null
  private readonly now: () => number
  private readonly ttl: number

  constructor(private readonly d: DetectorDeps) {
    this.now = d.now ?? Date.now
    this.ttl = d.ttlMs ?? DETECT_TTL_MS
  }

  /** What is known now. Never probes. */
  cached(): Map<string, DetectEntry> { return new Map(this.entries) }

  /** When the last full probe finished, or null. */
  checkedAt(): number | null { return this.last }

  /** A probe is running now. */
  busy(): boolean { return this.inflight !== null }

  stale(): boolean { return this.last === null || this.now() - this.last >= this.ttl }

  /** Probe every running node and guest (all at once only once). `ifStale`: only if the cache has aged out. */
  refresh(o: { ifStale?: boolean } = {}): Promise<void> {
    if (this.inflight) return this.inflight
    if (o.ifStale && !this.stale()) return Promise.resolve()
    this.inflight = this.probeAll().finally(() => { this.inflight = null })
    return this.inflight
  }

  private async probeAll(): Promise<void> {
    const listed = (await this.d.listMachines()).filter(m => m.running && (m.kind === 'node' || m.kind === 'lxc' || m.kind === 'qemu') &&
      !(m.kind === 'qemu' && /^win/i.test(m.ostype ?? '')))
    // An excluded guest is never sent anything, not even this read-only probe.
    const machines: Machine[] = []
    for (const m of listed) {
      let out = m.tags?.includes('hyperprox-ignore') ?? false
      if (!out && this.d.excluded) { try { out = await this.d.excluded(m) } catch { out = true } }
      if (!out) machines.push(m)
    }
    const self = await this.d.selfId?.().catch(() => null) ?? null
    const queue = [...machines]
    const seen = new Set<string>()
    const worker = async () => {
      for (let m = queue.shift(); m; m = queue.shift()) {
        const isSelf = m.id === self
        seen.add(m.id)
        try {
          const r = isSelf && this.d.local ? await this.d.local(DETECT_CLIENTS_SCRIPT) : await this.d.run(m, DETECT_CLIENTS_SCRIPT, { timeoutMs: 45_000, maxOutputBytes: MAX_PROBE_OUTPUT })
          if (r.truncated || r.output.length > MAX_PROBE_OUTPUT) throw new Error('the probe printed more than 512 KB, so the read was stopped and nothing from it is used')
          if (r.timedOut) throw new Error('the probe timed out')
          if (!/HP_DETECT_END/.test(r.output)) throw new Error('the probe did not finish')
          this.entries.set(m.id, { machineId: m.id, at: this.now(), result: parseDetection(r.output), error: null, self: isSelf })
        } catch (e) {
          const msg = String((e as Error)?.message ?? e).replace(/https?:\/\/\S+/g, '[link]').slice(0, 300)
          this.entries.set(m.id, { machineId: m.id, at: this.now(), result: null, error: msg, self: isSelf })
        }
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(this.d.concurrency ?? 4, machines.length || 1)) }, worker))
    // Machines that are gone or stopped are forgotten.
    for (const id of [...this.entries.keys()]) if (!seen.has(id)) this.entries.delete(id)
    this.last = this.now()
  }
}
