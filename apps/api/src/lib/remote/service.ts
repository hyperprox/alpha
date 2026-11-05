// =============================================================================
//  HyperProx — Remote access: the service
//
//  Jobs run one machine at a time and stop at the first failure. One job runs
//  at a time. On a Proxmox node every change is wrapped in the guard: a full
//  snapshot before, the change, a settle period, a snapshot after, and an
//  automatic rollback when anything differs. A change that fails is cleaned up
//  the same way even when nothing differs.
//
//  Two things survive a restart, in the database:
//   - every key that has left HyperProx, until the provider confirms it is
//     revoked (the sweep retries at start, on unlock, and every minute);
//   - every node change between its before-snapshot and its guard verdict, so
//     a restart in the middle re-runs the after-check on boot and rolls back.
//
//  A key is only ever in memory and on the target's stdin. Output passes
//  through a stream redactor before it reaches the job log.
// =============================================================================

import { randomUUID } from 'node:crypto'
import type { NotifyEventInput } from '../notify/types'
import type { RemoteExecutor } from './executor'
import type { Inflight, RemoteRecord, RemoteRecordInput, RemoteStore } from './store'
import {
  DETECT_SCRIPT, SNAPSHOT_SCRIPT, backupDir, backupStateScript, busyScript, dropBackupScript, installScript, osSupport, parseBusy, parseFacts,
  withJobPid,
  parseForwardingBefore, parseNetbirdFlags, parseStatus, restoreStateScript, routingScript, statusScript,
  uninstallScript, updateScript, upScript, configureScript, loginScript, parseLoginUrl, parseTailscalePrefs, TS_PREFS_READBACK,
  NB_FLAGS_READBACK, lockScript, type ClientPrefs, type ClientStatus, type NetMode, type OsFacts, type Support,
} from './scripts'
import {
  DEFAULT_PREFS, checkPrefs, checkRouting, clientFlags, describePrefs, nodeLockProblems, planInstall, safeHostname, tailscaleLockFlags, tunFix,
  type ExistingChoice, type LockObservation, type VpnPrefs,
} from './planner'
import { clusterNetworks, compareSnapshots, onlyFirewall, parseSnapshot, snapshotReady, type CustomSubject, type GuardSubject, type NodeSnapshot } from './guard'
import { describeDetected, type ClientDetector, type DetectedClient } from './detect'
import { StreamRedactor, holdsSignInLink, redactKnownKeyShapes } from './redact'
import { TAG_RE } from './tailscale'
import {
  DOWNLOAD_URL, PROVIDER_IDS, PROVIDER_LABEL, isProviderId,
  type Machine, type ProviderDevice, type ProviderId, type RemoteProvider, type RoutingRequest,
} from './types'

export class RemoteInputError extends Error { constructor(m: string) { super(m); this.name = 'RemoteInputError' } }
export class RemoteBusyError extends Error { constructor(m: string, readonly jobId: string) { super(m); this.name = 'RemoteBusyError' } }
export class RemoteNotFoundError extends Error { constructor(m: string) { super(m); this.name = 'RemoteNotFoundError' } }

export type JobAction = 'install' | 'check' | 'update' | 'routing' | 'uninstall' | 'configure'

export interface JobRequest {
  action:      JobAction
  provider:    ProviderId
  machineIds:  string[]
  /** Tailscale tags or NetBird group names. Omitted: the provider's defaults from Settings. */
  tags?:       string[]
  mode?:       NetMode
  /** What to do with a client HyperProx did not install. Without one, such a machine is refused. */
  existing?:   ExistingChoice
  /** Install: sign in with an auth/setup key (default), or interactively with the owner's own account. */
  auth?:       'key' | 'login'
  /** Install on a guest: let the client manage DNS (MagicDNS / NetBird DNS). Never on a node. */
  acceptDns?:  boolean
  /** Configure: the settings to change; the rest stay as they are on the machine. */
  prefs?:      Partial<VpnPrefs>
  subnets?:    string[]
  exitNode?:   boolean
  acknowledge?: boolean
}

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'
export interface JobStep { machineId: string; name: string; status: StepStatus; detail?: string }

export interface RemoteJob {
  id: string; action: JobAction | 'recovery'; provider: ProviderId; by: string
  status: 'running' | 'completed' | 'failed'
  steps: JobStep[]; log: string; error?: string
  startedAt: string; finishedAt?: string
}

export type CellState = 'connected' | 'offline' | 'missing' | 'not-installed' | 'manual' | 'unconfigured' | 'unknown'
  /** Installed, its daemon running, but not signed in to a tailnet / account. */
  | 'signed-out'
  /** Not looked at yet (nothing probed, no provider key). */
  | 'unchecked'
  /** A guest HyperProx never looks inside (the VPN page's exclusions, or the `hyperprox-ignore` tag). */
  | 'excluded'

export interface RemoteCell {
  state: CellState
  /** True when HyperProx installed or adopted it (there is a record); false for a device found only by name. */
  managed: boolean
  ip: string | null; version: string | null; lastSeen: string | null; deviceName: string | null
  mode: NetMode | null; routes: string[]; exitNode: boolean; lastError: string | null; adopted: boolean
  /** MagicDNS / NetBird name. */
  dnsName: string | null
  /** When the key (Tailscale) or login (NetBird) expires; null when it does not or is unknown. */
  expiresAt: string | null
  /** Expires within 14 days. */
  expiryWarning: boolean
  keyExpiryDisabled: boolean
  /** Waiting for approval at the provider. */
  pending: boolean
  tags: string[]
  /** The client's own settings as last read back from it. */
  prefs: ClientPrefs | null
  /** A sign-in link is waiting for this machine (admins can reveal it). */
  loginPending: boolean
  /** What the read-only probe found on the machine itself, and when; null when it was not looked at. */
  detected: DetectedClient | null
  /** The same, in words: "Tailscale installed, connected as web.example.ts.net (100.64.0.5)". */
  detectedText: string | null
  checkedAt: string | null
}

export interface RemoteMachineRow extends Machine {
  cells: Record<ProviderId, RemoteCell>
  /** HyperProx's own container: shown, never changed from here. */
  self: boolean
  /** Never looked inside or touched for VPN work, and why. */
  excluded?: boolean
  excludedBy?: 'setting' | 'tag'
}

export interface RemoteOverview {
  providers: Array<{
    id: ProviderId; label: string; configured: boolean; error: string | null; devices: number
    /** Machines whose client reports it is signed in, from the probe (no API key needed). */
    onTailnet: number
    /** The card's line when there is no API key, in words; null when the provider is set up. */
    summary: string | null
  }>
  /** The read-only probe of every machine: when it last finished, and whether one is running now. */
  detection: { checkedAt: string | null; running: boolean }
  machines: RemoteMachineRow[]
  activeJobId: string | null
  /** Node changes not yet through their guard; `interrupted` ones were cut off by a restart and wait for a check. */
  attention: Array<{ machineId: string; provider: ProviderId | 'wireguard'; action: string; since: string; interrupted: boolean }>
  /** Keys whose revocation is overdue and not yet confirmed. */
  pendingRevokes: number
  /** Devices waiting for approval at a provider (admins only). */
  pendingDevices: Array<{ provider: ProviderId; id: string; name: string; os: string | null; user: string | null; createdAt: string | null; machineId: string | null }>
}

export interface ProviderSettings {
  tags: string[]
  managementUrl?: string
  /** One-click installs: whether a container / a VM lets the client manage its DNS. Default off. */
  acceptDnsCt?: boolean
  acceptDnsVm?: boolean
}

export interface RemoteDeps {
  store:    RemoteStore
  exec:     RemoteExecutor
  /** The provider built from the vault, or null when it is not configured. Throws while locked. */
  provider: (id: ProviderId) => Promise<RemoteProvider | null>
  providerSettings: (id: ProviderId) => Promise<ProviderSettings>
  log?:     (m: string) => void
  /** Between a node change and its after-check, so delayed effects show up. Default 15 s. */
  settleMs?: number
  sleep?:   (ms: number) => Promise<void>
  now?:     () => number
  /** How often the revoke-and-recover sweep runs. Default 60 s. */
  sweepEveryMs?: number
  /** After a restart, how long to wait for an interrupted job's script, apt or dpkg to finish. Default 10 min. */
  recoveryWaitMs?: number
  /** The notification bus (sign-in links, new devices). Default: none. */
  publish?: (e: NotifyEventInput, o?: { privateOnly?: boolean }) => Promise<unknown>
  /** How often to look for new devices at each provider. Default 3 minutes. */
  pollEveryMs?: number
  /** Finds clients already on each machine, read-only, with no provider key. Default: none (nothing probed). */
  detector?: ClientDetector
  /**
   * HyperProx's own guest, found by network identity at start-up. Called once, when the service is made; no job
   * runs until it has answered.
   */
  selfId?: () => Promise<string | null>
}

/** The Proxmox tag that keeps HyperProx out of a guest. */
export const IGNORE_TAG = 'hyperprox-ignore'
const GUEST_ID = /^(lxc|qemu)-\d{1,9}$/
/** The least time between two Refresh probes. */
export const REFRESH_MIN_MS = 60_000

type SupportOk = Extract<Support, { ok: true }>

/** How to put a machine back. Stored with a node change so a restart can still do it. */
export type UndoPlan =
  | { kind: 'remove'; provider: ProviderId; support: SupportOk; deviceId: string | null; nodeKey?: string | null; address?: string | null }
  | { kind: 'restore'; provider: ProviderId; support: SupportOk; deviceId: string | null; previousDeviceId: string | null; nodeKey?: string | null; address?: string | null }
  | { kind: 'restart'; provider: ProviderId }
  | { kind: 'configure'; provider: ProviderId; previous: VpnPrefs; flags: string[] }
  /** A node's client put under the locks: these flags put it back as it was. */
  | { kind: 'lock-restore'; provider: ProviderId; flags: string[] }
  /** A WireGuard interface HyperProx manages: put its previous config back, or take it down if there was none. */
  | { kind: 'wg-restore'; provider: 'wireguard'; subject: CustomSubject; iface: string; previousConf: string | null }
  | { kind: 'routing'; provider: ProviderId; previous: RoutingRequest; flags: string[]; forwarding: 'leave' | 'guest';
      restoreForwarding: string | null; deviceId: string | null; deviceName: string; routeIds: string[] }

const LOG_CAP = 40_000

function need(p: RemoteProvider | null): RemoteProvider {
  if (!p) throw new Error('This needs the provider\'s API key. Add it under Settings → Credentials → Remote access.')
  return p
}
const MAX_MACHINES = 100
const NB_GROUP_RE = /^[A-Za-z0-9 _.-]{1,64}$/
/** A marker in the known-device table: the provider has been looked at once, so what is new from now on is announced. */
const SEEDED = '__seeded__'
const MANUAL_KEY_REVOKE_MS = 30 * 60_000
const INSTALL_KEY_GRACE_MS = 15 * 60_000
const DEVICE_CACHE_MS = 30_000
const JOB_KEEP_MS = 6 * 3600_000
const JOB_KEEP_MAX = 100

class GuardError extends Error {
  constructor(m: string, readonly cleanupFailed: boolean) { super(m); this.name = 'GuardError' }
}

function emptyCell(state: CellState): RemoteCell {
  return {
    state, managed: false, ip: null, version: null, lastSeen: null, deviceName: null, mode: null, routes: [], exitNode: false, lastError: null,
    adopted: false, dnsName: null, expiresAt: null, expiryWarning: false, keyExpiryDisabled: false, pending: false, tags: [], prefs: null, loginPending: false,
    detected: null, detectedText: null, checkedAt: null,
  }
}

/** The state a probed client is in. */
function detectedState(c: DetectedClient): CellState {
  if (c.connected) return 'connected'
  if (c.running && !c.loggedIn) return 'signed-out'
  return 'offline'
}

/** A cell from what the probe found, for a client HyperProx has no record of. */
function detectedCell(p: ProviderId, c: DetectedClient, at: string): RemoteCell {
  return {
    ...emptyCell(detectedState(c)),
    ip: c.ip, version: c.version, dnsName: c.dnsName, deviceName: c.dnsName?.split('.')[0] ?? null, expiresAt: c.keyExpiry,
    routes: c.advertisedRoutes, exitNode: c.advertiseExitNode,
    detected: c, detectedText: describeDetected(p, c), checkedAt: at,
  }
}

/** The settings after a change. Choosing an exit node keeps LAN access on unless the change says otherwise. */
export function mergePrefs(current: VpnPrefs, change: Partial<VpnPrefs>): VpnPrefs {
  const out: VpnPrefs = { ...current, ...change, subnets: change.subnets ?? current.subnets }
  if (change.exitNode && change.exitNode !== current.exitNode && change.exitNodeAllowLan === undefined) out.exitNodeAllowLan = true
  return out
}

const EXPIRY_WARN_MS = 14 * 86400_000
const LOGIN_URL_TTL_MS = 10 * 60_000
const LOGIN_POLL_MS = 5_000

const msg = (e: unknown) => String((e as any)?.message ?? e)

/** What a role below admin may see: overlay status, version and connection state. No LAN or cluster addresses. */
export function overviewForRole(ov: RemoteOverview, admin: boolean): RemoteOverview {
  if (admin) return ov
  return {
    ...ov,
    attention: ov.attention.map(a => ({ ...a })),
    machines: ov.machines.map(({ address: _a, ostype: _o, ...m }) => ({
      ...m,
      cells: Object.fromEntries(Object.entries(m.cells).map(([k, c]) => [k, {
        ...emptyCell(c.state), managed: c.managed, ip: c.ip, version: c.version, lastSeen: c.lastSeen,
        dnsName: c.dnsName, expiresAt: c.expiresAt, expiryWarning: c.expiryWarning,
        // The state in words; the client's own settings are for admins.
        detectedText: c.detectedText, checkedAt: c.checkedAt,
      }])) as Record<ProviderId, RemoteCell>,
    })),
    pendingDevices: [],
  }
}

export const FIREWALL_PORTS = '22,8006'

/** The one host-firewall rule HyperProx offers: SSH and the web UI, from the overlay, on the overlay interface. */
export function firewallRule(p: ProviderId): Record<string, string> {
  return {
    type: 'in', action: 'ACCEPT', iface: p === 'tailscale' ? 'tailscale0' : 'wt0', source: '100.64.0.0/10',
    proto: 'tcp', dport: FIREWALL_PORTS, enable: '1', comment: `HyperProx remote access: SSH and web UI over ${PROVIDER_LABEL[p]}`,
  }
}

export class RemoteAccessService {
  private jobs = new Map<string, RemoteJob>()
  /** Jobs whose output held a sign-in link, and when their log is dropped. */
  private linkLogs = new Map<string, number>()
  private active: string | null = null
  private devices = new Map<ProviderId, { at: number; list: ProviderDevice[] }>()
  private revoking = new Set<Promise<unknown>>()
  private sweepTimer: NodeJS.Timeout | null = null
  private sweeping: Promise<void> | null = null
  /** This process. An in-flight row owned by anyone else was left by a process that is gone. */
  readonly instance = randomUUID()
  private readonly sleep: (ms: number) => Promise<void>
  private readonly selfP: Promise<string | null>
  private selfKnown: string | null = null
  private readonly now: () => number
  private readonly settleMs: number
  /** Keys of installs running in this process: no sweep touches them, whatever their due time. */
  private liveKeys = new Set<string>()
  private reportedBusy = new Set<string>()
  /** Sign-in links, in memory only, until they expire or the machine signs in. Never stored, never logged. */
  private logins = new Map<string, { url: string; until: number }>()
  private pollTimer: NodeJS.Timeout | null = null
  private polling: Promise<void> | null = null

  constructor(private readonly d: RemoteDeps) {
    this.sleep = d.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
    // Which guest is HyperProx itself: asked once, now; runJob waits for the answer before anything runs.
    this.selfP = (d.selfId ? d.selfId().catch(e => { d.log?.(`[remote] could not tell which guest is HyperProx: ${msg(e)}`); return null }) : Promise.resolve(null))
      .then(id => { this.selfKnown = id; return id })
    this.now = d.now ?? Date.now
    this.settleMs = d.settleMs ?? 15_000
  }

  getJob(id: string): RemoteJob | undefined { this.dropLinkLogs(); return this.jobs.get(id) }
  get activeJobId(): string | null { return this.active }

  // ── Start, sweep, close ───────────────────────────────────────────────────

  /** Sweep now, then every minute. */
  start(): void {
    // At start no install can be running, so every install key left over is revoked now, whatever its due time.
    void this.sweep({ startup: true })
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => { void this.sweep() }, this.d.sweepEveryMs ?? 60_000)
      this.sweepTimer.unref?.()
    }
    void this.pollDevices()
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => { void this.pollDevices() }, this.d.pollEveryMs ?? 3 * 60_000)
      this.pollTimer.unref?.()
    }
  }

  /** Stop sweeping and wait, at most `timeoutMs`, for revokes already on their way. */
  async close(timeoutMs = 5000): Promise<void> {
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null }
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null }
    const all = Promise.allSettled([...this.revoking, ...(this.sweeping ? [this.sweeping] : [])])
    let t: NodeJS.Timeout | undefined
    await Promise.race([all, new Promise<void>(r => { t = setTimeout(r, timeoutMs); t.unref?.() })])
    if (t) clearTimeout(t)
  }

  /** Revoke every key that is due, then re-check any node change a restart cut off. Needs the vault unlocked. */
  sweep(o: { startup?: boolean } = {}): Promise<void> {
    if (this.sweeping) return this.sweeping
    this.sweeping = (async () => {
      try {
        const due = (await this.d.store.listPendingRevokes())
          .filter(r => !this.liveKeys.has(r.keyId))
          .filter(r => new Date(r.revokeAfter).getTime() <= this.now() || (o.startup && r.reason === 'install'))
        for (const r of due) {
          let p: RemoteProvider | null
          try { p = await this.d.provider(r.provider) } catch { return }       // locked: try again after unlock
          if (!p) { await this.d.store.notePendingRevokeFailure(r.id, `${PROVIDER_LABEL[r.provider]} is not configured`); continue }
          await this.revokeDurably(p, r.id, r.keyId)
        }
        await this.recover()
      } catch (e) {
        this.d.log?.(`[remote] sweep: ${msg(e)}`)
      } finally {
        this.sweeping = null
      }
    })()
    return this.sweeping
  }

  /** Revoke, confirm with the provider, and only then forget the pending row. False when it must be retried. */
  private revokeDurably(p: RemoteProvider, pendingId: string, keyId: string, job?: RemoteJob): Promise<boolean> {
    const run = (async () => {
      try {
        await p.revokeKey(keyId)
        if (!(await p.keyRevoked(keyId))) throw new Error('the provider still lists the key as usable')
        await this.d.store.removePendingRevoke(pendingId)
        return true
      } catch (e) {
        const m = redactKnownKeyShapes(msg(e))
        await this.d.store.notePendingRevokeFailure(pendingId, m).catch(() => undefined)
        if (job) this.appendRaw(job, `\nCould not confirm the install key is revoked (${m}); HyperProx keeps trying.\n`)
        return false
      }
    })()
    this.revoking.add(run)
    void run.finally(() => this.revoking.delete(run))
    return run
  }

  /** Mint a key and record it as pending revocation before it goes anywhere. */
  private async mintRecorded(p: RemoteProvider, provider: ProviderId, name: string, tags: string[], revokeAfterMs: number, reason: string) {
    const key = await p.mintKey({ name, tags })
    let pendingId: string
    try {
      pendingId = await this.d.store.addPendingRevoke({ provider, keyId: key.id, revokeAfter: new Date(this.now() + revokeAfterMs), reason })
    } catch (e) {
      // Not recorded, so it must not leave: revoke it now.
      await p.revokeKey(key.id).catch(() => undefined)
      throw new Error(`could not record the new key for revocation, so it was revoked unused (${msg(e)})`)
    }
    return { key, pendingId }
  }

  // ── Overview ──────────────────────────────────────────────────────────────

  private async deviceList(id: ProviderId, p: RemoteProvider | null, fresh = false): Promise<ProviderDevice[]> {
    if (!p) return []   // no API key: the provider's list is not readable
    const c = this.devices.get(id)
    if (!fresh && c && this.now() - c.at < DEVICE_CACHE_MS) return c.list
    const list = await p.listDevices()
    this.devices.set(id, { at: this.now(), list })
    return list
  }

  /**
   * Everything the VPN page shows. `mayProbe` (an admin's read): when the probe cache has aged out, a new probe
   * starts in the background. A viewer's read never probes; it shows what is cached.
   */
  async overview(o: { mayProbe?: boolean } = {}): Promise<RemoteOverview> {
    const det = this.d.detector
    if (o.mayProbe && det?.stale()) void det.refresh({ ifStale: true }).catch(e => this.d.log?.(`[remote] probe: ${msg(e)}`))
    const found = det?.cached() ?? new Map()
    const [machines, records, inflight, pending] = await Promise.all([
      this.d.exec.listMachines(), this.d.store.list(), this.d.store.listInflight(), this.d.store.listPendingRevokes(),
    ])
    const providers: RemoteOverview['providers'] = []
    const lists = new Map<ProviderId, ProviderDevice[] | null>()
    for (const id of PROVIDER_IDS) {
      let p: RemoteProvider | null = null
      let error: string | null = null
      try { p = await this.d.provider(id) } catch (e) { error = redactKnownKeyShapes(msg(e)) }
      let list: ProviderDevice[] | null = null
      if (p) { try { list = await this.deviceList(id, p) } catch (e) { error = redactKnownKeyShapes(msg(e)) } }
      lists.set(id, p ? list : null)
      const onTailnet = [...found.values()].filter(e => e.result?.[id].installed && e.result[id].loggedIn).length
      const installedCount = [...found.values()].filter(e => e.result?.[id].installed).length
      const net = id === 'tailscale' ? 'a tailnet' : 'NetBird'
      const plural = (n: number) => `${n} machine${n === 1 ? '' : 's'}`
      const summary = p ? null
        : onTailnet ? `${plural(onTailnet)} already on ${net} — add an API key to manage installs and approvals`
          : installedCount ? `${PROVIDER_LABEL[id]} found on ${plural(installedCount)}, not signed in — add an API key to manage installs and approvals`
            : `No ${PROVIDER_LABEL[id]} client found yet — add an API key to install it and approve devices`
      providers.push({ id, label: PROVIDER_LABEL[id], configured: !!p, error, devices: list?.length ?? 0, onTailnet, summary })
    }

    const excludedIds = new Set(await this.d.store.listExclusions())
    const rows: RemoteMachineRow[] = machines.map(m => {
      const cells = {} as Record<ProviderId, RemoteCell>
      const byTag = !!m.tags?.includes(IGNORE_TAG)
      if (byTag || excludedIds.has(m.id)) {
        for (const id of PROVIDER_IDS) cells[id] = emptyCell('excluded')
        return { ...m, cells, self: false, excluded: true, excludedBy: byTag ? 'tag' as const : 'setting' as const }
      }
      const probed = found.get(m.id)
      const at = probed ? new Date(probed.at).toISOString() : null
      const windows = m.kind === 'qemu' && /^win/i.test(m.ostype ?? '')
      for (const id of PROVIDER_IDS) {
        const conf = providers.find(x => x.id === id)!.configured
        const rec = records.find(r => r.machineId === m.id && r.provider === id)
        const list = lists.get(id)
        const dc: DetectedClient | null = probed?.result?.[id] ?? null
        if (!conf && !rec) {
          // No API key: what the machine itself says, found, not managed by HyperProx.
          if (dc?.installed) cells[id] = detectedCell(id, dc, at!)
          else if (dc) cells[id] = { ...emptyCell('not-installed'), detected: dc, detectedText: 'not installed', checkedAt: at }
          else cells[id] = { ...emptyCell(windows ? 'manual' : m.running ? 'unchecked' : 'offline'), lastError: probed?.error ?? null, checkedAt: at }
          continue
        }
        // A record matches only by the identity recorded at install; a name match is shown, never acted on.
        const dev = rec ? this.matchRecord(rec, list ?? []) : (list ?? []).find(x => (x.hostname ?? x.name).toLowerCase() === safeHostname(m.name))
        if (!rec && !dev) {
          cells[id] = dc?.installed ? detectedCell(id, dc, at!) : { ...emptyCell(windows ? 'manual' : 'not-installed'), detected: dc, detectedText: dc ? 'not installed' : null, checkedAt: at }
          continue
        }
        // Without the provider's list (no key), the machine's own report decides.
        const state: CellState = dev ? (dev.online ? 'connected' : 'offline') : list ? 'missing' : dc?.installed ? detectedState(dc) : 'unknown'
        cells[id] = {
          state, managed: !!rec,
          ip: dev?.addresses[0] ?? rec?.address ?? dc?.ip ?? null,
          version: dev?.version ?? dc?.version ?? rec?.version ?? null,
          lastSeen: dev?.lastSeen ?? null,
          deviceName: dev?.name ?? rec?.hostname ?? null,
          mode: rec?.mode ?? null, routes: rec?.routes ?? [], exitNode: rec?.exitNode ?? false, lastError: rec?.lastError ?? null,
          adopted: rec?.adopted ?? false,
          dnsName: dev?.dnsName ?? dc?.dnsName ?? null,
          expiresAt: dev?.expiresAt ?? dc?.keyExpiry ?? null,
          expiryWarning: !!dev?.expiresAt && !dev.keyExpiryDisabled && Date.parse(dev.expiresAt) - this.now() < EXPIRY_WARN_MS,
          keyExpiryDisabled: dev?.keyExpiryDisabled ?? false,
          pending: dev?.pending ?? false,
          tags: dev?.tags ?? [],
          prefs: rec?.prefs ?? null,
          loginPending: this.loginFor(m.id, id) !== null,
          detected: dc, detectedText: dc ? describeDetected(id, dc) : null, checkedAt: at,
        }
      }
      return { ...m, cells, self: m.id === this.selfMachineId() || !!probed?.self }
    })
    return {
      providers, machines: rows, activeJobId: this.active,
      detection: { checkedAt: det?.checkedAt() ? new Date(det.checkedAt()!).toISOString() : null, running: !!det?.busy() },
      attention: inflight.map(x => ({ machineId: x.machineId, provider: x.provider, action: x.action, since: new Date(x.startedAt).toISOString(), interrupted: x.owner !== this.instance })),
      pendingRevokes: pending.filter(r => new Date(r.revokeAfter).getTime() <= this.now()).length,
      pendingDevices: PROVIDER_IDS.flatMap(id => (lists.get(id) ?? []).filter(d => d.pending).map(d => ({
        provider: id, id: d.id, name: d.name, os: d.os ?? null, user: d.user ?? null, createdAt: d.createdAt ?? null,
        machineId: records.find(r => r.provider === id && r.deviceId === d.id)?.machineId ?? null,
      }))),
    }
  }

  /** Probe every running machine now (the page's Refresh). Admins only, by the route. */
  /**
   * Probe every running machine now (the page's Refresh; admins only, by the route). At most once a minute: a
   * press sooner returns what is cached and says how old it is. `force` is for HyperProx itself, never a route.
   */
  async refreshDetection(o: { force?: boolean } = {}): Promise<{ refreshed: boolean; note: string | null }> {
    const det = this.d.detector
    if (!det) throw new RemoteInputError('Detection is not running')
    const last = det.checkedAt()
    if (!o.force && last !== null && this.now() - last < REFRESH_MIN_MS) {
      const ago = Math.max(0, Math.round((this.now() - last) / 1000))
      return { refreshed: false, note: `Refreshed ${ago} s ago; you can refresh again in ${Math.ceil((REFRESH_MIN_MS - (this.now() - last)) / 1000)} s.` }
    }
    await det.refresh()
    return { refreshed: true, note: null }
  }

  /** HyperProx's own container: found by network identity at start-up, else as the probe marked it. */
  private selfMachineId(): string | null {
    if (this.selfKnown) return this.selfKnown
    for (const e of this.d.detector?.cached().values() ?? []) if (e.self) return e.machineId
    return null
  }

  // ── Exclusions ─────────────────────────────────────────────────────────────

  /** Guests listed on the VPN page as never to be looked inside. */
  getExclusions(): Promise<string[]> { return this.d.store.listExclusions() }

  /** Replace the list (guest ids only). Audited with the ids; there is nothing secret in it. */
  async setExclusions(ids: string[], by: string): Promise<string[]> {
    if (!Array.isArray(ids) || ids.length > 500) throw new RemoteInputError('Send a list of at most 500 guest ids')
    const bad = ids.filter(i => typeof i !== 'string' || !GUEST_ID.test(i))
    if (bad.length) throw new RemoteInputError(`Not a guest machine id (lxc-<vmid> or qemu-<vmid>): ${bad.map(String).join(', ').slice(0, 200)}`)
    const before = await this.d.store.listExclusions()
    await this.d.store.setExclusions(ids, by)
    const after = await this.d.store.listExclusions()
    await this.d.store.audit('remote.exclusions', 'vpn', { by, added: after.filter(i => !before.includes(i)), removed: before.filter(i => !after.includes(i)) })
    return after
  }

  /** Is this guest one HyperProx never looks inside? By the tag, or by the list. */
  async isExcluded(m: Machine): Promise<boolean> {
    if (m.tags?.includes(IGNORE_TAG)) return true
    return (await this.d.store.listExclusions()).includes(m.id)
  }

  private async refuseExcluded(m: Machine): Promise<void> {
    if (await this.isExcluded(m)) {
      throw new Error(`${m.name} is excluded from VPN work (${m.tags?.includes(IGNORE_TAG) ? `Proxmox tag ${IGNORE_TAG}` : 'the VPN page\'s exclusions'}); HyperProx never looks inside it or changes it.`)
    }
  }

  private matchRecord(rec: RemoteRecord, list: ProviderDevice[]): ProviderDevice | undefined {
    return list.find(x => rec.deviceId && x.id === rec.deviceId)
      ?? list.find(x => rec.nodeKey && x.nodeKey === rec.nodeKey)
      ?? list.find(x => rec.address && x.addresses.includes(rec.address))
  }

  /** The device the client itself reported: Tailscale's node id, or the overlay address. Never a name. */
  private matchStatus(st: ClientStatus, list: ProviderDevice[]): ProviderDevice | undefined {
    return list.find(x => st.nodeKey && x.nodeKey === st.nodeKey)
      ?? list.find(x => st.ip && x.addresses.includes(st.ip))
  }

  // ── Jobs ──────────────────────────────────────────────────────────────────

  private prune(): void {
    this.dropLinkLogs()
    const done = [...this.jobs.values()].filter(j => j.status !== 'running')
    const cutoff = this.now() - JOB_KEEP_MS
    for (const j of done) if (j.finishedAt && Date.parse(j.finishedAt) < cutoff) this.jobs.delete(j.id)
    const left = [...this.jobs.values()].filter(j => j.status !== 'running').sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    while (left.length > JOB_KEEP_MAX) this.jobs.delete(left.shift()!.id)
  }

  startJob(req: JobRequest, by: string): RemoteJob {
    if (!isProviderId(req.provider)) throw new RemoteInputError('provider must be tailscale or netbird')
    const actions: JobAction[] = ['install', 'check', 'update', 'routing', 'uninstall', 'configure']
    if (!actions.includes(req.action)) throw new RemoteInputError(`action must be one of ${actions.join(', ')}`)
    const ids = Array.isArray(req.machineIds) ? [...new Set(req.machineIds.map(String))] : []
    if (!ids.length) throw new RemoteInputError('Choose at least one machine')
    if (ids.length > MAX_MACHINES) throw new RemoteInputError(`At most ${MAX_MACHINES} machines per job`)
    if (req.action !== 'install' && ids.length !== 1) throw new RemoteInputError(`${req.action} works on one machine at a time`)
    if (ids.some(i => !/^(node|lxc|qemu|host)-[A-Za-z0-9._-]{1,120}$/.test(i))) throw new RemoteInputError('Unknown machine id format')
    if (req.mode !== undefined && req.mode !== 'kernel' && req.mode !== 'userspace') throw new RemoteInputError('mode must be kernel or userspace')
    if (req.existing !== undefined && req.existing !== 'adopt' && req.existing !== 'adopt-lock' && req.existing !== 'replace') throw new RemoteInputError('existing must be adopt, adopt-lock or replace')
    if (req.auth !== undefined && req.auth !== 'key' && req.auth !== 'login') throw new RemoteInputError('auth must be key or login')
    if (req.acceptDns !== undefined && typeof req.acceptDns !== 'boolean') throw new RemoteInputError('acceptDns must be true or false')
    if (req.action === 'configure') {
      const pr = req.prefs
      if (!pr || typeof pr !== 'object') throw new RemoteInputError('configure needs prefs')
      for (const k of ['acceptDns', 'acceptRoutes', 'ssh', 'advertiseExitNode', 'exitNodeAllowLan'] as const) {
        if (pr[k] !== undefined && typeof pr[k] !== 'boolean') throw new RemoteInputError(`${k} must be true or false`)
      }
      if (pr.exitNode !== undefined && pr.exitNode !== null && typeof pr.exitNode !== 'string') throw new RemoteInputError('exitNode must be a string or null')
      if (pr.subnets !== undefined && (!Array.isArray(pr.subnets) || !pr.subnets.every(x => typeof x === 'string'))) throw new RemoteInputError('subnets must be a list of CIDRs')
    }
    if (req.tags !== undefined) {
      if (!Array.isArray(req.tags) || req.tags.length > 20) throw new RemoteInputError('tags must be a list of at most 20')
      const re = req.provider === 'tailscale' ? TAG_RE : NB_GROUP_RE
      const bad = req.tags.filter(t => typeof t !== 'string' || !re.test(t))
      if (bad.length) throw new RemoteInputError(req.provider === 'tailscale' ? `Not a Tailscale tag: ${bad.join(', ')} (tags look like tag:server)` : `Not a NetBird group name: ${bad.join(', ')}`)
    }
    if (req.action === 'routing') {
      if (!Array.isArray(req.subnets ?? []) || typeof (req.exitNode ?? false) !== 'boolean') throw new RemoteInputError('routing needs subnets (a list) and exitNode (true or false)')
    }
    if (this.active) throw new RemoteBusyError('A remote access job is already running', this.active)
    this.prune()

    const job: RemoteJob = {
      id: randomUUID(), action: req.action, provider: req.provider, by, status: 'running',
      steps: ids.map(machineId => ({ machineId, name: machineId, status: 'pending' as StepStatus })),
      log: '', startedAt: new Date(this.now()).toISOString(),
    }
    this.jobs.set(job.id, job)
    this.active = job.id
    void this.runJob(job, { ...req, machineIds: ids })
    return job
  }

  private appendRaw(job: RemoteJob, text: string) {
    job.log = (job.log + text).slice(-LOG_CAP)
  }

  private async runJob(job: RemoteJob, req: JobRequest): Promise<void> {
    const plain = (s: string) => redactKnownKeyShapes(s, { netbird: req.provider === 'netbird' })
    try {
      const machines = await this.d.exec.listMachines()
      const unknown = req.machineIds.filter(id => !machines.some(m => m.id === id))
      if (unknown.length) throw new Error(`No such machine: ${unknown.join(', ')}`)
      // Not before HyperProx knows which guest is its own, and never on an excluded one.
      await this.selfP
      for (const id of req.machineIds) await this.refuseExcluded(machines.find(m => m.id === id)!)
      const self = this.selfMachineId()
      if (self && req.machineIds.includes(self)) {
        throw new Error('That is this HyperProx\'s own container: its VPN client is shown read-only and never changed from here, so HyperProx cannot cut itself off.')
      }
      const provider = await this.d.provider(req.provider)
      // What the machine can do on its own works without a key: reading it, its settings, updating it, adopting it.
      const noKeyOk = req.action === 'check' || req.action === 'update' || req.action === 'configure' ||
        (req.action === 'install' && (req.existing === 'adopt' || req.existing === 'adopt-lock'))
      if (!provider && !noKeyOk) {
        throw new Error(`This needs a ${PROVIDER_LABEL[req.provider]} API key (it makes install keys and approves devices). Add it under Settings → Credentials → Remote access.`)
      }
      const settings = await this.d.providerSettings(req.provider)

      for (const step of job.steps) {
        const m = machines.find(x => x.id === step.machineId)!
        step.name = m.name
        step.status = 'running'
        this.appendRaw(job, `\n── ${m.name} (${m.id}) ──\n`)
        try {
          step.detail = plain(await this.runStep(job, req, provider, settings, m, machines))
          step.status = 'done'
        } catch (e) {
          step.status = 'failed'
          step.detail = plain(msg(e))
          throw new Error(`${m.name}: ${step.detail}`)
        }
      }
      job.status = 'completed'
    } catch (e) {
      job.status = 'failed'
      job.error = plain(msg(e))
    } finally {
      job.finishedAt = new Date(this.now()).toISOString()
      // Released in the same tick the job's status settles, so a caller that sees it finished can start the next.
      if (this.active === job.id) this.active = null
      this.devices.delete(req.provider)
      await this.d.store.audit(`remote.${req.action}`, req.machineIds.join(','), {
        by: job.by, provider: req.provider, status: job.status, error: job.error ?? null,
        ...(req.action === 'routing' ? { subnets: req.subnets ?? [], exitNode: !!req.exitNode } : {}),
        ...(req.existing ? { existing: req.existing } : {}),
      }).catch(err => this.d.log?.(`[remote] audit write failed: ${msg(err)}`))
    }
  }

  /** Run a script, its output redacted on the way into the log (across chunk boundaries). */
  private async exec(job: RemoteJob, m: Machine, script: string, o: { secrets?: string[]; netbird?: boolean; timeoutMs?: number; quiet?: string } = {}) {
    // Output that carries a sign-in link is not logged at all, not even redacted.
    if (o.quiet) {
      this.appendRaw(job, `[${o.quiet}]\n`)
      if (m.kind === 'node') script = withJobPid(job.id, script)
      const res = await this.d.exec.run(m, script, { timeoutMs: o.timeoutMs ?? 15 * 60_000 })
      if (holdsSignInLink(res.output)) this.heldLink(job)
      if (res.timedOut) throw new Error('timed out')
      return res
    }
    // On a node, the script records its pid, so a restart can tell whether it is still running.
    if (m.kind === 'node') script = withJobPid(job.id, script)
    // `netbird up` may ask for a sign-in instead of connecting. Its output is captured whole, not streamed: a
    // link in it goes only through the sign-in-link flow, and is cut out by exact value before anything is logged.
    if (/\bnetbird up\b/.test(script)) {
      const res = await this.d.exec.run(m, script, { timeoutMs: o.timeoutMs ?? 15 * 60_000 })
      const url = parseLoginUrl('netbird', res.output)
      if (url || holdsSignInLink(res.output)) this.heldLink(job)
      if (url) await this.captureLogin(m, 'netbird', url).catch(() => undefined)
      const r = new StreamRedactor([...(o.secrets ?? []), ...(url ? [url] : [])], { netbird: true })
      this.appendRaw(job, r.push(res.output) + r.flush())
      if (res.timedOut) throw new Error('timed out')
      return res
    }
    const r = new StreamRedactor(o.secrets ?? [], { netbird: o.netbird })
    try {
      const res = await this.d.exec.run(m, script, { timeoutMs: o.timeoutMs ?? 15 * 60_000, onData: c => this.appendRaw(job, r.push(c)) })
      if (holdsSignInLink(res.output)) this.heldLink(job)
      if (res.timedOut) throw new Error('timed out')
      return res
    } finally {
      this.appendRaw(job, r.flush())
    }
  }

  /** This job's output once held a sign-in link: its log is dropped 10 minutes from now, even redacted. */
  private heldLink(job: RemoteJob) {
    if (!this.linkLogs.has(job.id)) this.linkLogs.set(job.id, this.now() + LOGIN_URL_TTL_MS)
  }

  private dropLinkLogs() {
    const now = this.now()
    for (const [id, at] of this.linkLogs) {
      if (now < at) continue
      const j = this.jobs.get(id)
      if (j) j.log = '[This log was dropped: it once held a sign-in link]\n'
      this.linkLogs.delete(id)
    }
  }

  private async detect(job: RemoteJob, m: Machine): Promise<OsFacts> {
    const r = await this.exec(job, m, DETECT_SCRIPT, { timeoutMs: 60_000 })
    if (r.code !== 0) throw new Error(`could not read the operating system (exit ${r.code})`)
    return parseFacts(r.output)
  }

  private async support(job: RemoteJob, m: Machine): Promise<SupportOk> {
    const s = osSupport(await this.detect(job, m))
    if (!s.ok) throw new Error(s.reason)
    return s
  }

  /** A node snapshot. Its output is not logged: it is long and only the verdict matters. */
  private async snapshot(m: Machine): Promise<NodeSnapshot> {
    try {
      const r = await this.d.exec.run(m, SNAPSHOT_SCRIPT, { timeoutMs: 90_000 })
      return r.code === 0 && !r.timedOut ? parseSnapshot(r.output) : parseSnapshot('')
    } catch { return parseSnapshot('') }
  }

  // ── Undo ──────────────────────────────────────────────────────────────────

  /** Put the machine back according to `plan`. Returns what was done, or throws. Used live and after a restart. */
  private async runUndo(job: RemoteJob, m: Machine, plan: UndoPlan, p: RemoteProvider | null): Promise<string> {
    const nb = plan.provider === 'netbird'
    const done: string[] = []
    if (plan.kind === 'remove') {
      const r = await this.exec(job, m, uninstallScript(plan.provider, plan.support), { netbird: nb, timeoutMs: 5 * 60_000 })
      if (!/HP_REMOVED/.test(r.output)) throw new Error('the client could not be removed')
      done.push('removed the client')
    } else if (plan.kind === 'restore') {
      const r = await this.exec(job, m, restoreStateScript(plan.provider, plan.support), { netbird: nb, timeoutMs: 10 * 60_000 })
      if (!/HP_RESTORED/.test(r.output)) {
        const dir = backupDir(plan.provider)
        throw new Error(`the previous client state could not be put back. Its copy is kept, root-only, at ${dir} on ${m.name}. ` +
          `Once you have restored or no longer need it, remove it with: find ${dir} -type f -exec shred -u {} + && rm -rf ${dir}`)
      }
      done.push('put the previous client and its state back')
    } else if (plan.kind === 'wg-restore') {
      const { wgRestoreScript } = await import('../vpn/wireguard/scripts')
      const r = await this.exec(job, m, wgRestoreScript(plan.iface, plan.previousConf), { timeoutMs: 2 * 60_000 })
      if (r.code !== 0) throw new Error(`the WireGuard interface ${plan.iface} could not be put back`)
      done.push(plan.previousConf ? `put ${plan.iface}'s previous configuration back` : `took ${plan.iface} down and removed it`)
    } else if (plan.kind === 'configure') {
      const r = await this.exec(job, m, configureScript(plan.provider, plan.previous, plan.flags), { netbird: nb, timeoutMs: 2 * 60_000 })
      if (r.code !== 0) throw new Error('the previous settings could not be put back')
      done.push('put the previous settings back')
    } else if (plan.kind === 'lock-restore') {
      const r = await this.exec(job, m, lockScript(plan.provider, plan.flags), { netbird: nb, timeoutMs: 2 * 60_000 })
      if (r.code !== 0) throw new Error('the client\'s previous settings could not be put back')
      done.push('put the client\'s previous settings back')
    } else if (plan.kind === 'restart') {
      const r = await this.exec(job, m, plan.provider === 'tailscale' ? 'systemctl restart tailscaled' : 'netbird service restart', { timeoutMs: 60_000 })
      if (r.code !== 0) throw new Error('the client could not be restarted')
      done.push('restarted the client')
    } else {
      const r = await this.exec(job, m, routingScript(plan.provider, {
        ...plan.previous, flags: plan.flags, forwarding: plan.forwarding, restoreForwarding: plan.restoreForwarding,
      }), { netbird: nb, timeoutMs: 2 * 60_000 })
      if (r.code !== 0) throw new Error('the previous routing could not be put back on the machine')
      done.push('put the previous routing back on the machine')
      if (p && plan.deviceId) {
        const ids = await p.setRouting({ id: plan.deviceId, name: plan.deviceName, addresses: [], online: true, lastSeen: null, version: null }, plan.previous, plan.routeIds)
        const rec = await this.d.store.get(m.id, plan.provider)
        if (rec) { const { installedAt: _i, updatedAt: _u, ...b } = rec; await this.d.store.upsert({ ...b, routeIds: ids }) }
        done.push(`and at ${PROVIDER_LABEL[plan.provider]}`)
      }
    }
    // Devices are deleted by the id recorded when the client reported itself, never by name.
    if ((plan.kind === 'remove' || plan.kind === 'restore') && p) {
      const prev = plan.kind === 'restore' ? plan.previousDeviceId : null
      // The id, or else the identity the client itself reported from `up` (node id, overlay address).
      if (!plan.deviceId && (plan.nodeKey || plan.address)) {
        const dev = this.matchStatus({ installed: true, connected: false, ip: plan.address ?? null, version: null, nodeKey: plan.nodeKey ?? undefined },
          await this.deviceList(plan.provider, p, true).catch(() => []))
        if (dev) plan.deviceId = dev.id
      }
      if (plan.deviceId && plan.deviceId !== prev) {
        await p.deleteDevice(plan.deviceId)
        done.push(`deleted the new device from ${PROVIDER_LABEL[plan.provider]}`)
      } else if (!plan.deviceId && plan.kind === 'remove') {
        done.push(`no device was identified, so nothing was deleted at ${PROVIDER_LABEL[plan.provider]}`)
      }
    }
    return done.join(', ')
  }

  /**
   * Run `change` under the guard. On a node: snapshot, refuse if not ready, record the change as in flight,
   * change, settle, snapshot, compare. Anything different (or, with undoOnFailure, a failed change) runs the
   * undo plan, settles, and snapshots again to say whether the node is back as it was. Off a node: the change,
   * and the undo on failure.
   */
  private async guarded<T>(job: RemoteJob, m: Machine, provider: ProviderId | 'wireguard', p: RemoteProvider | null, action: string,
    undo: { plan: UndoPlan; persist?: () => Promise<void> },
    change: () => Promise<T>,
    o: { undoOnFailure: boolean; precheck?: (before: NodeSnapshot) => void; subject?: GuardSubject },
  ): Promise<T> {
    if (m.kind !== 'node') {
      try { return await change() } catch (e) {
        if (!o.undoOnFailure) throw e
        let note: string; let failed = false
        try { note = `Cleaned up: ${await this.runUndo(job, m, undo.plan, p)}.` } catch (u) { failed = true; note = `Cleaning up failed too: ${msg(u)}. Check ${m.name} by hand.` }
        await this.d.store.audit('remote.cleanup', m.id, { by: job.by, provider, action, ok: !failed, note }).catch(() => undefined)
        throw new GuardError(`${msg(e)}. ${note}`, failed)
      }
    }

    const before = await this.snapshot(m)
    const notReady = snapshotReady(before)
    if (notReady) throw new Error(`${notReady}; nothing was changed`)
    o.precheck?.(before)
    const inflightId = await this.d.store.addInflight({
      machineId: m.id, provider, action, jobId: job.id, by: job.by, owner: this.instance, before, undo: undo.plan,
    })
    undo.persist = () => this.d.store.updateInflightUndo(inflightId, undo.plan)
    try {
      let result: T | undefined
      let failure: unknown = null
      try { result = await change() } catch (e) { failure = e }
      await this.sleep(this.settleMs)
      const subject: GuardSubject = o.subject ?? (provider as ProviderId)
      const diff = await this.judge(m, before, await this.snapshot(m), subject)
      if (diff.length || (failure && o.undoOnFailure)) {
        let note: string; let failed = false
        try { note = await this.runUndo(job, m, undo.plan, p) } catch (u) { failed = true; note = `the rollback itself failed: ${msg(u)}` }
        await this.sleep(this.settleMs)
        const left = await this.judge(m, before, await this.snapshot(m), subject)
        const why = diff.length ? `Rolled back because ${diff.join('; ')}` : `${msg(failure)}. Cleaned up`
        const end = left.length
          ? `After the rollback the node still differs: ${left.join('; ')}. Check it by hand now.`
          : 'The node is back as it was.'
        await this.d.store.audit('remote.rollback', m.id, { by: job.by, provider, action, changes: diff, ok: !failed && !left.length }).catch(() => undefined)
        throw new GuardError(`${why}: ${note}. ${end}`, failed || left.length > 0)
      }
      if (failure) throw failure
      return result as T
    } finally {
      await this.d.store.removeInflight(inflightId).catch(() => undefined)
    }
  }

  /**
   * Compare, and when only the firewall text differs take one more sample: lines that change between the two
   * after-samples are churn (bans, guests starting, counters), not the change being judged.
   */
  private async judge(m: Machine, before: NodeSnapshot, after: NodeSnapshot, provider: GuardSubject): Promise<string[]> {
    const diff = compareSnapshots(before, after, provider)
    if (!diff.length || !onlyFirewall(before, after, provider)) return diff
    const again = await this.snapshot(m)
    if (!again.read) return diff
    return compareSnapshots(before, after, provider, again)
  }

  // (need(): the actions that cannot run without the provider's API; runJob has already refused them.)
  private async runStep(job: RemoteJob, req: JobRequest, p: RemoteProvider | null, settings: ProviderSettings, m: Machine, all: Machine[]): Promise<string> {
    switch (req.action) {
      case 'install':   return this.install(job, req, p, settings, m)
      case 'check':     return this.check(job, req.provider, p, m)
      case 'update':    return this.update(job, req.provider, p, m)
      case 'routing':   return this.routing(job, req, need(p), settings, m, all)
      case 'uninstall': return this.uninstall(job, req.provider, need(p), m)
      case 'configure': return this.configure(job, req, p, settings, m, all)
    }
  }

  // ── Install, adopt ────────────────────────────────────────────────────────

  private async install(job: RemoteJob, req: JobRequest, p: RemoteProvider | null, settings: ProviderSettings, m: Machine): Promise<string> {
    const facts = m.kind === 'qemu' && /^win/i.test(m.ostype ?? '') ? null : await this.detect(job, m)
    const rec = await this.d.store.get(m.id, req.provider)
    const plan = planInstall({ machine: m, provider: req.provider, facts, mode: req.mode, managed: !!rec, existing: req.existing })
    if (plan.kind === 'manual') {
      throw new Error(`${plan.os === 'windows' ? 'Windows' : 'macOS'} is not installed automatically. Download ${PROVIDER_LABEL[req.provider]} from ${DOWNLOAD_URL[req.provider]} and use “One-time key” on this machine.`)
    }
    if (plan.kind === 'refuse') throw new Error(plan.reason)
    if (plan.kind === 'needs-tun') {
      const fix = tunFix(await this.d.exec.lxcConfig(m).catch(() => ({})), m.vmid!)
      throw new Error(fix.configured
        ? 'This container is configured with /dev/net/tun but cannot open it yet: restart it, or install in userspace mode.'
        : `This container has no /dev/net/tun. Either give it the device (“Add /dev/net/tun”, the same as \`${fix.command}\` on the node, then restart the container), or install in userspace mode.`)
    }
    if (plan.kind === 'adopt') return this.adopt(job, req.provider, p, m, plan.lock, settings)
    if (!p) throw new Error(`Installing needs a ${PROVIDER_LABEL[req.provider]} API key (for the one-time install key). Add it under Settings → Credentials → Remote access.`)

    const nb = req.provider === 'netbird'
    const hostname = safeHostname(m.name)
    const prefs: VpnPrefs = { ...DEFAULT_PREFS, acceptDns: !!req.acceptDns }
    const locked = checkPrefs(m, req.provider, prefs)
    if (locked) throw new Error(locked)
    const flags = clientFlags(req.provider, { hostname, kind: m.kind, managementUrl: settings.managementUrl, prefs })
    const login = req.auth === 'login'
    const undo: { plan: UndoPlan; persist?: () => Promise<void> } = {
      plan: plan.existing
        ? { kind: 'restore', provider: req.provider, support: plan.support, deviceId: null, previousDeviceId: rec?.deviceId ?? null }
        : { kind: 'remove', provider: req.provider, support: plan.support, deviceId: null },
    }

    let out: { status: ClientStatus; dev?: ProviderDevice }
    try {
      out = await this.guarded(job, m, req.provider, p, 'install', undo, async () => {
        if (plan.existing) {
          const b = await this.exec(job, m, backupStateScript(req.provider), { netbird: nb, timeoutMs: 2 * 60_000 })
          if (!/HP_BACKUP_OK/.test(b.output)) throw new Error('could not keep a copy of the existing client\'s state, so it was not touched')
        }
        const inst = await this.exec(job, m, installScript(req.provider, plan.support, plan.mode), { netbird: nb })
        if (inst.code !== 0) throw new Error(`installing the ${PROVIDER_LABEL[req.provider]} package failed (exit ${inst.code}); see the log`)
        if (login) {
          // No key at all: the client asks for a sign-in, and the link it prints is kept in memory only.
          const up = await this.exec(job, m, loginScript(req.provider, flags), { netbird: nb, timeoutMs: 2 * 60_000, quiet: 'output withheld: it contains a sign-in link' })
          const status = parseStatus(req.provider, up.output)
          const url = parseLoginUrl(req.provider, up.output)
          if (undo.plan.kind === 'remove' || undo.plan.kind === 'restore') { undo.plan.nodeKey = status.nodeKey ?? null; undo.plan.address = status.ip; await undo.persist?.() }
          if (!url && !status.connected) throw new Error(`${PROVIDER_LABEL[req.provider]} did not print a sign-in link and is not connected`)
          if (url) await this.captureLogin(m, req.provider, url)
          if (m.kind !== 'node' || status.connected) return { status, dev: undefined as ProviderDevice | undefined }
          // A node keeps its guard open until the client has joined: the after-check below then sees the node as
          // it is once signed in, and the locks are confirmed from the client. No join before the link expires:
          // the client is taken off again.
          job.steps.forEach(st => { if (st.machineId === m.id) st.detail = 'Waiting for the sign-in (the link expires in about 10 minutes)' })
          const joined = await this.waitForJoin(job, m, req.provider)
          this.logins.delete(`${m.id}|${req.provider}`)
          const { problems } = await this.observeLocks(job, m, req.provider)
          if (problems.length) throw new Error(`${m.name} joined, but its client does not meet the node locks: ${problems.join('; ')}`)
          if (undo.plan.kind === 'remove' || undo.plan.kind === 'restore') { undo.plan.nodeKey = joined.nodeKey ?? null; undo.plan.address = joined.ip; await undo.persist?.() }
          const dev = this.matchStatus(joined, await this.deviceList(req.provider, p, true).catch(() => []))
          if (dev && (undo.plan.kind === 'remove' || undo.plan.kind === 'restore')) { undo.plan.deviceId = dev.id; await undo.persist?.() }
          return { status: joined, dev }
        }
        // Due in 15 minutes, so a sweep never revokes it mid-install; the install revokes it the moment `up` ends.
        const { key, pendingId } = await this.mintRecorded(p, req.provider, `HyperProx ${m.id}`, req.tags ?? settings.tags, INSTALL_KEY_GRACE_MS, 'install')
        this.liveKeys.add(key.id)
        let status: ClientStatus
        try {
          const up = await this.exec(job, m, upScript(req.provider, { secret: key.secret, flags }), { secrets: [key.secret], netbird: nb, timeoutMs: 5 * 60_000 })
          status = parseStatus(req.provider, up.output)
          // The identity the client reported is saved at once, so even a restart right now can find its device.
          if (undo.plan.kind === 'remove' || undo.plan.kind === 'restore') {
            undo.plan.nodeKey = status.nodeKey ?? null
            undo.plan.address = status.ip
            await undo.persist?.()
          }
          if (up.code !== 0) throw new Error(`${req.provider} up failed (exit ${up.code}); see the log`)
        } finally {
          await this.revokeDurably(p, pendingId, key.id, job)
          this.liveKeys.delete(key.id)
        }
        const dev = this.matchStatus(status, await this.deviceList(req.provider, p, true).catch(() => []))
        if (dev && (undo.plan.kind === 'remove' || undo.plan.kind === 'restore')) { undo.plan.deviceId = dev.id; await undo.persist?.() }
        return { status, dev }
      }, { undoOnFailure: true })
    } catch (e) {
      if (e instanceof GuardError && e.cleanupFailed) {
        // Leave a trace in the table: the machine may be half-changed, and the overview must not say "not installed".
        await this.d.store.upsert({
          machineId: m.id, provider: req.provider, deviceId: rec?.deviceId ?? null, nodeKey: rec?.nodeKey ?? null, hostname,
          address: rec?.address ?? null, mode: plan.mode, version: rec?.version ?? null, routes: rec?.routes ?? [], exitNode: rec?.exitNode ?? false,
          routeIds: rec?.routeIds ?? [], adopted: rec?.adopted ?? false, forwardingBefore: rec?.forwardingBefore ?? null,
          connected: null, checkedAt: new Date(this.now()), lastError: e.message.slice(0, 500),
        })
      }
      throw e
    }

    if (plan.existing) await this.exec(job, m, dropBackupScript(req.provider), { timeoutMs: 60_000 }).catch(() => undefined)
    const { status, dev } = out
    await this.d.store.upsert({
      machineId: m.id, provider: req.provider, deviceId: dev?.id ?? null, nodeKey: status.nodeKey ?? dev?.nodeKey ?? null,
      hostname: status.hostname ?? hostname, address: status.ip ?? dev?.addresses[0] ?? null, mode: plan.mode,
      version: status.version, routes: [], exitNode: false, routeIds: [], adopted: false, forwardingBefore: null,
      connected: status.connected, checkedAt: new Date(this.now()), lastError: null, prefs: { ...prefs, tags: req.tags ?? settings.tags, netfilterOff: m.kind === 'node' },
    })
    if (login && !status.connected) {
      return `Installed. Waiting for a sign-in: the link is on ${m.name}'s VPN panel (admins only) and was sent to private notification channels. It expires in about 10 minutes.`
    }
    const where = status.ip ? ` as ${status.ip}` : ''
    return `${status.connected ? 'Connected' : 'Installed, not connected yet'}${where} (${PROVIDER_LABEL[req.provider]} ${status.version ?? '?'}${plan.mode === 'userspace' ? ', userspace networking' : ''})` +
      (plan.existing ? ', replacing the client that was there' : '') +
      (dev ? '' : '. Not found in the provider\'s device list yet.')
  }

  /** Poll a client until it reports it has joined, or the sign-in link has expired. */
  private async waitForJoin(job: RemoteJob, m: Machine, provider: ProviderId): Promise<ClientStatus> {
    const until = this.now() + LOGIN_URL_TTL_MS
    while (this.now() < until) {
      await this.sleep(LOGIN_POLL_MS)
      const st = parseStatus(provider, (await this.exec(job, m, statusScript(provider), { netbird: provider === 'netbird', timeoutMs: 60_000, quiet: 'output withheld: it may contain a sign-in link' })).output)
      if (st.connected) return st
    }
    this.logins.delete(`${m.id}|${provider}`)
    throw new Error(`nobody signed in before the link expired, so ${PROVIDER_LABEL[provider]} was taken off ${m.name} again`)
  }

  /**
   * What a client on a node reports about the locks, read from the client itself: the observation, and how it
   * differs from the locks in words (empty when it meets them).
   */
  private async observeLocks(job: RemoteJob, m: Machine, provider: ProviderId): Promise<{ obs: LockObservation; problems: string[]; ts: ClientPrefs | null }> {
    if (provider === 'tailscale') {
      const ts = parseTailscalePrefs((await this.exec(job, m, TS_PREFS_READBACK, { timeoutMs: 60_000 })).output)
      if (!ts) throw new Error(`could not read Tailscale's settings back from ${m.name}`)
      const obs: LockObservation = { provider, prefs: ts }
      return { obs, problems: nodeLockProblems(obs), ts }
    }
    const f = parseNetbirdFlags((await this.exec(job, m, NB_FLAGS_READBACK, { timeoutMs: 60_000, netbird: true })).output)
    if (!f.config) throw new Error(`could not tell which config file NetBird uses on ${m.name}`)
    const obs: LockObservation = { provider, flags: f }
    return { obs, problems: nodeLockProblems(obs), ts: null }
  }

  /**
   * Record a client that is already there and signed in to the configured account. Changes nothing on the
   * machine. On a node the client must already meet the node locks; `lock` instead applies them first, as a
   * guarded change confirmed from the client, and puts the old settings back if anything goes wrong.
   */
  private async adopt(job: RemoteJob, provider: ProviderId, p: RemoteProvider | null, m: Machine, lock = false, settings?: ProviderSettings): Promise<string> {
    const r = await this.exec(job, m, statusScript(provider), { timeoutMs: 60_000 })
    const st = parseStatus(provider, r.output)
    if (!st.installed) throw new Error(`${PROVIDER_LABEL[provider]} is not installed on ${m.name}`)
    // With a key, the client must be in the configured account. Without one, it is recorded from the machine and
    // linked to its device once a key is added.
    const dev = p ? this.matchStatus(st, await this.deviceList(provider, p, true)) : undefined
    if (p && !dev) {
      throw new Error(`${m.name}'s client is not known to the configured ${PROVIDER_LABEL[provider]} account yet (it may be signed in to another ` +
        `${provider === 'tailscale' ? 'tailnet' : 'account'}, or still waiting for approval); nothing was recorded`)
    }
    let locked = false
    if (m.kind === 'node') {
      const { problems, ts, obs } = await this.observeLocks(job, m, provider)
      if (problems.length && !lock) {
        throw new Error(`${m.name} is a Proxmox node and its ${PROVIDER_LABEL[provider]} client does not meet the node locks: ${problems.join('; ')}. ` +
          'Nothing was recorded or changed. Choose “Adopt and apply the node locks” to switch those off as a guarded change (checked before and after, rolled back if anything else moves).')
      }
      if (problems.length) {
        const nb = provider === 'netbird'
        const lockFlags = nb ? clientFlags(provider, { hostname: st.hostname ?? m.name, kind: 'node', managementUrl: settings?.managementUrl }) : tailscaleLockFlags()
        const f = (obs as Extract<LockObservation, { provider: 'netbird' }>).flags
        const backFlags = nb
          ? [...(settings?.managementUrl ? [`--management-url=${settings.managementUrl}`] : []), `--disable-dns=${f.DisableDNS === true}`, `--disable-client-routes=${f.DisableClientRoutes === true}`,
             `--disable-server-routes=${f.DisableServerRoutes !== false}`, `--disable-firewall=${f.DisableFirewall === true}`, `--allow-server-ssh=${f.ServerSSHAllowed === true}`]
          : tailscaleLockFlags({ ...ts!, netfilterMode: ts!.netfilterMode ?? 2 })
        const undo: { plan: UndoPlan; persist?: () => Promise<void> } = { plan: { kind: 'lock-restore', provider, flags: backFlags } }
        await this.guarded(job, m, provider, p, 'configure', undo, async () => {
          const out = await this.exec(job, m, lockScript(provider, lockFlags), { netbird: nb, timeoutMs: 2 * 60_000 })
          if (out.code !== 0) throw new Error(`applying the node locks failed (exit ${out.code}); see the log`)
          // Confirmed from the client itself, never from the flags sent.
          const left = nb
            ? nodeLockProblems({ provider, flags: parseNetbirdFlags(out.output) })
            : (() => { const g = parseTailscalePrefs(out.output); return g ? nodeLockProblems({ provider, prefs: g }) : ['its settings could not be read back'] })()
          if (left.length) throw new Error(`the client did not take the node locks: ${left.join('; ')}`)
        }, { undoOnFailure: true })
        locked = true
      }
    }
    await this.d.store.upsert({
      machineId: m.id, provider, deviceId: dev?.id ?? null, nodeKey: st.nodeKey ?? dev?.nodeKey ?? null, hostname: st.hostname ?? dev?.hostname ?? null,
      address: st.ip ?? dev?.addresses[0] ?? null, mode: 'kernel', version: st.version, routes: [], exitNode: false, routeIds: [],
      adopted: true, forwardingBefore: null, connected: st.connected, checkedAt: new Date(this.now()), lastError: null,
      ...(m.kind === 'node' ? { prefs: { ...DEFAULT_PREFS, tags: [], netfilterOff: true } } : {}),
    })
    if (locked) await this.d.store.audit('remote.adopt.lock', m.id, { by: job.by, provider })
    return `Adopted${locked ? ' and put under the node locks' : ' as it is'}: ${st.connected ? 'connected' : 'not connected'}${st.ip ? ` as ${st.ip}` : ''}, ${dev ? `matched to “${dev.name}”` : `not known to the ${PROVIDER_LABEL[provider]} API yet (no API key): device actions wait until one is added`}. ` +
      (locked ? 'Overlay DNS, accepted routes, overlay SSH and client firewall rules are now off, confirmed from the client.' : 'Nothing on the machine was changed.')
  }

  private async record(m: Machine, provider: ProviderId): Promise<RemoteRecord> {
    const r = await this.d.store.get(m.id, provider)
    if (!r) throw new Error(`HyperProx has not installed or adopted ${PROVIDER_LABEL[provider]} on ${m.name}`)
    return r
  }

  private async saveStatus(m: Machine, provider: ProviderId, st: ClientStatus, extra: Partial<RemoteRecordInput> = {}) {
    const prev = await this.d.store.get(m.id, provider)
    if (!prev) return
    const { installedAt: _i, updatedAt: _u, ...base } = prev
    await this.d.store.upsert({ ...base, address: st.ip ?? prev.address, version: st.version ?? prev.version, connected: st.connected, checkedAt: new Date(this.now()), lastError: null, ...extra })
  }

  // ── Check, update ─────────────────────────────────────────────────────────

  private async check(job: RemoteJob, provider: ProviderId, p: RemoteProvider | null, m: Machine): Promise<string> {
    const r = await this.exec(job, m, statusScript(provider), { timeoutMs: 60_000 })
    const st = parseStatus(provider, r.output)
    if (!st.installed) return `${PROVIDER_LABEL[provider]} is not installed`
    await this.saveStatus(m, provider, st)
    if (st.connected) this.logins.delete(`${m.id}|${provider}`)
    if (st.needsLogin) {
      // The key expired, or the client was signed out: it is waiting with a sign-in link of its own.
      const url = parseLoginUrl(provider, r.output)
      if (url) await this.captureLogin(m, provider, url)
      return `${PROVIDER_LABEL[provider]} needs a sign-in on ${m.name}${url ? ': the link is on the VPN panel and was sent to private channels. It expires in about 10 minutes.' : '.'}`
    }
    const dev = this.matchStatus(st, await this.deviceList(provider, p, true).catch(() => []))
    return `${st.connected ? 'Connected' : 'Not connected'}${st.ip ? ` as ${st.ip}` : ''}, version ${st.version ?? '?'}` +
      (dev ? `, matched to “${dev.name}” (last seen ${dev.lastSeen ?? 'never'})` : ', not in the provider\'s device list')
  }

  private async update(job: RemoteJob, provider: ProviderId, p: RemoteProvider | null, m: Machine): Promise<string> {
    await this.record(m, provider)
    const s = await this.support(job, m)
    const r = await this.guarded(job, m, provider, p, 'update', { plan: { kind: 'restart', provider } },
      async () => {
        const x = await this.exec(job, m, updateScript(provider, s), { netbird: provider === 'netbird' })
        if (x.code !== 0) throw new Error(`the update failed (exit ${x.code}); see the log`)
        return x
      }, { undoOnFailure: false })
    const st = parseStatus(provider, r.output)
    await this.saveStatus(m, provider, st)
    return `Now ${PROVIDER_LABEL[provider]} ${st.version ?? '?'}, ${st.connected ? 'connected' : 'not connected'}`
  }

  // ── Routing ───────────────────────────────────────────────────────────────

  private async routing(job: RemoteJob, req: JobRequest, p: RemoteProvider, settings: ProviderSettings, m: Machine, all: Machine[]): Promise<string> {
    const provider = req.provider
    const r: RoutingRequest = { subnets: [...new Set((req.subnets ?? []).map(s => String(s).trim()).filter(Boolean))], exitNode: !!req.exitNode }
    const on = r.subnets.length > 0 || r.exitNode
    const early = checkRouting(m, r, req.acknowledge === true)
    if (early) throw new Error(early)
    const rec = await this.record(m, provider)
    if (!rec.deviceId) throw new Error('no device id was recorded for this machine, so its routes cannot be set at the provider; run Check, or uninstall and install again')

    // The cluster's networks, from the node itself (a guest's own node): every corosync link, Ceph network and
    // monitor, and the node's addresses, IPv4 and IPv6.
    if (m.kind !== 'node' && m.node && on) {
      const host = all.find(x => x.kind === 'node' && x.node === m.node)
      const snap = host ? await this.snapshot(host) : parseSnapshot('')
      if (!snap.read) throw new Error(`could not read the cluster's networks from node ${m.node}, so routing was not changed`)
      const refusal = checkRouting(m, r, true, clusterNetworks(snap))
      if (refusal) throw new Error(refusal)
    }

    const forwarding = m.kind === 'node' ? 'leave' as const : 'guest' as const
    const previous: RoutingRequest = { subnets: rec.routes, exitNode: rec.exitNode }
    const flagsFor = (rr: RoutingRequest) => clientFlags(provider, { hostname: safeHostname(m.name), kind: m.kind, managementUrl: settings.managementUrl, routing: rr })
    const undo: { plan: UndoPlan; persist?: () => Promise<void> } = {
      plan: {
        kind: 'routing', provider, previous, flags: flagsFor(previous), forwarding,
        restoreForwarding: rec.forwardingBefore, deviceId: rec.deviceId, deviceName: rec.hostname ?? safeHostname(m.name), routeIds: rec.routeIds,
      },
    }
    const dev: ProviderDevice = { id: rec.deviceId, name: rec.hostname ?? safeHostname(m.name), addresses: [], online: true, lastSeen: null, version: null }

    const res = await this.guarded(job, m, provider, p, 'routing', undo, async () => {
      const out = await this.exec(job, m, routingScript(provider, { ...r, flags: flagsFor(r), forwarding, restoreForwarding: rec.forwardingBefore }),
        { netbird: provider === 'netbird', timeoutMs: 2 * 60_000 })
      if (out.code !== 0) throw new Error(`changing routing failed (exit ${out.code}); see the log`)
      const fwdBefore = parseForwardingBefore(out.output)
      if (undo.plan.kind === 'routing' && on && !previous.subnets.length && !previous.exitNode) { undo.plan.restoreForwarding = fwdBefore; await undo.persist?.() }
      if (provider === 'netbird') {
        // Checked in the client's own config: an omitted or ignored flag must never read as success.
        const flags = parseNetbirdFlags(out.output)
        if (!flags.config) throw new Error('could not tell which config file the running NetBird daemon uses, so the change is not confirmed')
        if (flags.DisableServerRoutes === undefined) throw new Error(`could not read DisableServerRoutes from ${flags.config}, so the change is not confirmed`)
        if (flags.DisableServerRoutes !== !on) throw new Error(`NetBird did not take the change: it still has DisableServerRoutes=${flags.DisableServerRoutes}`)
      }
      const routeIds = await p.setRouting(dev, r, rec.routeIds)
      if (undo.plan.kind === 'routing') { undo.plan.routeIds = routeIds; await undo.persist?.() }
      if (provider === 'tailscale' && p.advertisedRoutes) {
        const want = [...r.subnets, ...(r.exitNode ? ['0.0.0.0/0', '::/0'] : [])].sort()
        let got: string[] = []
        for (let i = 0; i < 5; i++) {
          got = (await p.advertisedRoutes(dev)).sort()
          if (JSON.stringify(got) === JSON.stringify(want)) break
          await this.sleep(2000)
        }
        if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`Tailscale reports the machine advertising ${got.join(', ') || 'nothing'}, not ${want.join(', ') || 'nothing'}`)
      }
      return { routeIds, fwdBefore, st: parseStatus(provider, out.output) }
    }, {
      undoOnFailure: true,
      precheck: before => {
        const refusal = checkRouting(m, r, true, clusterNetworks(before))
        if (refusal) throw new Error(refusal)
        if (r.subnets.length && before.forwarding.v4 !== '1') {
          throw new Error('IP forwarding is off on this node, and HyperProx never changes a node\'s forwarding. Turn it on yourself first if you really want this node to route.')
        }
      },
    })
    await this.saveStatus(m, provider, res.st, {
      routes: r.subnets, exitNode: r.exitNode, routeIds: res.routeIds,
      forwardingBefore: forwarding === 'guest' ? (on ? (rec.forwardingBefore ?? res.fwdBefore) : null) : null,
    })
    const label = [...(r.subnets.length ? [`subnets ${r.subnets.join(', ')}`] : []), ...(r.exitNode ? ['exit node'] : [])]
    return label.length ? `Routing on: ${label.join(' and ')}` : 'Routing off'
  }

  // ── Uninstall ─────────────────────────────────────────────────────────────

  private async uninstall(job: RemoteJob, provider: ProviderId, p: RemoteProvider, m: Machine): Promise<string> {
    const rec = await this.record(m, provider)
    const s = await this.support(job, m)
    const nb = provider === 'netbird'
    const undo = { plan: { kind: 'restore', provider, support: s, deviceId: null, previousDeviceId: rec.deviceId } as UndoPlan }
    await this.guarded(job, m, provider, p, 'uninstall', undo, async () => {
      const b = await this.exec(job, m, backupStateScript(provider), { netbird: nb, timeoutMs: 2 * 60_000 })
      if (!/HP_BACKUP_OK/.test(b.output)) throw new Error('could not keep a copy of the client\'s state first, so nothing was removed')
      const r = await this.exec(job, m, uninstallScript(provider, s), { netbird: nb, timeoutMs: 5 * 60_000 })
      if (!/HP_REMOVED/.test(r.output)) throw new Error(`the client is still installed on ${m.name}`)
    }, { undoOnFailure: true })

    // The machine is clean and the guard passed: now the provider side, by the recorded id only.
    const notes: string[] = []
    if (rec.deviceId) {
      if (rec.routeIds.length) await p.setRouting({ id: rec.deviceId, name: rec.hostname ?? m.name, addresses: [], online: true, lastSeen: null, version: null }, { subnets: [], exitNode: false }, rec.routeIds).catch(() => [])
      await p.deleteDevice(rec.deviceId)
      notes.push(`deleted “${rec.hostname ?? rec.deviceId}” from ${PROVIDER_LABEL[provider]}`)
    } else {
      notes.push(`no device id was recorded, so nothing was deleted at ${PROVIDER_LABEL[provider]}; remove it there by hand if it is listed`)
    }
    await this.exec(job, m, dropBackupScript(provider), { timeoutMs: 60_000 }).catch(() => undefined)
    await this.d.store.remove(m.id, provider)
    return `Removed from ${m.name}; ${notes.join('; ')}`
  }

  // ── Recovery after a restart ──────────────────────────────────────────────

  /** Re-check every node change another (now gone) process left in flight. Roll back when the node differs. */
  async recover(): Promise<void> {
    if (this.active) return
    const rows = (await this.d.store.listInflight()).filter(x => x.owner !== this.instance)
    if (!rows.length) return
    const machines = await this.d.exec.listMachines()
    for (const row of rows) await this.recoverOne(row, machines)
  }

  private async recoverOne(row: Inflight, machines: Machine[]): Promise<void> {
    const m = machines.find(x => x.id === row.machineId)
    const job: RemoteJob = {
      id: randomUUID(), action: 'recovery', provider: row.provider === 'wireguard' ? 'tailscale' : row.provider, by: 'HyperProx (after a restart)', status: 'running',
      steps: [{ machineId: row.machineId, name: m?.name ?? row.machineId, status: 'running' }], log: '', startedAt: new Date(this.now()).toISOString(),
    }
    const step = job.steps[0]
    const what = `A restart interrupted ${row.action} of ${row.provider === 'wireguard' ? 'WireGuard' : PROVIDER_LABEL[row.provider]} on ${m?.name ?? row.machineId} (started by ${row.by})`
    const finish = async (detail: string, remove: boolean) => {
      step.status = 'failed'; step.detail = detail
      job.status = 'failed'; job.error = detail; job.finishedAt = new Date(this.now()).toISOString()
      this.jobs.set(job.id, job)
      if (remove) await this.d.store.removeInflight(row.id)
      await this.d.store.audit('remote.recovered', row.machineId, { provider: row.provider, action: row.action, by: row.by, detail, done: remove }).catch(() => undefined)
    }
    if (!m) return finish(`${what}; that machine no longer exists.`, true)

    // The dead job's own script, or apt/dpkg, may still be running on the node: wait for them, then settle.
    const deadline = this.now() + (this.d.recoveryWaitMs ?? 10 * 60_000)
    for (;;) {
      let busy: string[] | null
      try { busy = parseBusy((await this.d.exec.run(m, busyScript(row.jobId), { timeoutMs: 60_000 })).output) } catch { busy = null }
      if (busy === null) return                         // unreachable or locked: keep the row, try again later
      if (!busy.length) break
      if (this.now() >= deadline) {
        if (this.reportedBusy.has(row.id)) return
        this.reportedBusy.add(row.id)
        return finish(`${what}. ${busy.join(', ')} is still running on the node, so nothing was undone; HyperProx checks again later.`, false)
      }
      await this.sleep(10_000)
    }
    await this.sleep(this.settleMs)
    const after = await this.snapshot(m)
    if (!after.read) return
    let p: RemoteProvider | null = null
    const plan = row.undo as UndoPlan
    const subject: GuardSubject = plan.kind === 'wg-restore' ? plan.subject : (row.provider as ProviderId)
    try { p = row.provider === 'wireguard' ? null : await this.d.provider(row.provider) } catch { p = null }
    const before = row.before as NodeSnapshot
    const diff = await this.judge(m, before, after, subject)
    // An interrupted install is always undone: the client may be in place, unrecorded, with no guard verdict.
    if (diff.length || row.action === 'install') {
      let note: string
      try { note = await this.runUndo(job, m, row.undo as UndoPlan, p) } catch (u) { note = `the rollback itself failed: ${msg(u)}` }
      await this.sleep(this.settleMs)
      const left = await this.judge(m, before, await this.snapshot(m), subject)
      const why = diff.length ? `On restart the node differed (${diff.join('; ')}), so it was rolled back` : 'The install never reached its guard verdict, so it was undone'
      return finish(`${what}. ${why}: ${note}. ` + (left.length ? `It still differs: ${left.join('; ')}. Check it by hand now.` : 'The node is back as it was.'), true)
    }
    return finish(`${what}. The node is as it was before the change, so nothing was undone. Use Check to see the client's state.`, true)
  }

  // ── Containers: /dev/net/tun ──────────────────────────────────────────────

  async applyTun(machineId: string, by: string): Promise<{ applied: boolean; message: string; command?: string }> {
    const m = (await this.d.exec.listMachines()).find(x => x.id === machineId)
    if (!m) throw new RemoteNotFoundError(`No such machine: ${machineId}`)
    if (m.kind !== 'lxc') throw new RemoteInputError('Only containers need /dev/net/tun added')
    const config = await this.d.exec.lxcConfig(m)
    const fix = tunFix(config, m.vmid!)
    if (fix.configured) return { applied: false, message: 'This container already has /dev/net/tun configured. Restart it if the device is not there yet.' }
    try {
      await this.d.exec.setLxcConfig(m, { [fix.param!]: fix.value! }, typeof config.digest === 'string' ? config.digest : undefined)
    } catch (e) {
      await this.d.store.audit('remote.tun', m.id, { by, applied: false, param: fix.param })
      return {
        applied: false, command: fix.command,
        message: `Proxmox did not accept the change from HyperProx (${redactKnownKeyShapes(msg(e)).slice(0, 200)}). Run this on node ${m.node} instead, then restart the container: ${fix.command}`,
      }
    }
    await this.d.store.audit('remote.tun', m.id, { by, applied: true, param: fix.param })
    return { applied: true, message: `Added ${fix.param}: /dev/net/tun. It takes effect when the container next restarts; HyperProx does not restart it for you.` }
  }

  // ── Node host firewall: SSH and the web UI from the overlay ───────────────

  async firewallPreview(machineId: string, provider: ProviderId): Promise<{ clusterEnabled: boolean; exists: boolean; rule: Record<string, string>; message: string }> {
    if (!isProviderId(provider)) throw new RemoteInputError('provider must be tailscale or netbird')
    const m = (await this.d.exec.listMachines()).find(x => x.id === machineId)
    if (!m) throw new RemoteNotFoundError(`No such machine: ${machineId}`)
    if (m.kind !== 'node') throw new RemoteInputError('The firewall rule is for Proxmox nodes')
    const rule = firewallRule(provider)
    const st = await this.d.exec.firewallState(m.node!)
    const exists = st.rules.some(x => x.comment === rule.comment ||
      (x.action === 'ACCEPT' && x.iface === rule.iface && x.source === rule.source && String(x.dport ?? '') === rule.dport))
    const message = !st.clusterEnabled
      ? 'The Proxmox firewall is off for this cluster, so nothing blocks the overlay and no rule is needed.'
      : exists ? 'The rule is already there.'
      : `Adds one rule to ${m.name}'s host firewall: accept TCP ${rule.dport} (SSH and the web UI) on ${rule.iface} from ${rule.source}. Nothing else: corosync, Ceph and migration stay LAN-only.`
    return { clusterEnabled: st.clusterEnabled, exists, rule, message }
  }

  async addFirewallRule(machineId: string, provider: ProviderId, by: string): Promise<{ added: boolean; message: string }> {
    const pv = await this.firewallPreview(machineId, provider)
    if (!pv.clusterEnabled) throw new RemoteInputError(pv.message)
    if (pv.exists) return { added: false, message: pv.message }
    const m = (await this.d.exec.listMachines()).find(x => x.id === machineId)!
    await this.d.exec.addFirewallRule(m.node!, pv.rule)
    await this.d.store.audit('remote.firewall', m.id, { by, provider, rule: pv.rule })
    return { added: true, message: `Added to ${m.name}: accept TCP ${pv.rule.dport} on ${pv.rule.iface} from ${pv.rule.source}.` }
  }

  // ── For the WireGuard service: the same transports, logging and node guard ─

  /** Run a script on a machine for a job, logged through the same redactor (or withheld with `quiet`). */
  async run(job: RemoteJob, m: Machine, script: string, o: { secrets?: string[]; timeoutMs?: number; quiet?: string } = {}) {
    await this.refuseExcluded(m)
    return this.exec(job, m, script, o)
  }

  /** A change to a WireGuard interface on a node goes through the same guard, in-flight record and recovery. */
  guardWireguard<T>(job: RemoteJob, m: Machine, subject: CustomSubject, undo: { plan: UndoPlan; persist?: () => Promise<void> },
    change: () => Promise<T>, precheck?: (before: NodeSnapshot) => void): Promise<T> {
    return this.guarded(job, m, 'wireguard', null, 'wireguard', undo, change, { undoOnFailure: true, subject, precheck })
  }

  /** The cluster's networks as read from a node (for a guest, its own node): every corosync link, Ceph network, own address. */
  async clusterNetworksFor(m: Machine): Promise<string[]> {
    const all = await this.d.exec.listMachines()
    const host = m.kind === 'node' ? m : all.find(x => x.kind === 'node' && x.node === m.node)
    if (!host) return m.address ? [m.address] : []
    const snap = await this.snapshot(host)
    if (!snap.read) throw new Error(`could not read the cluster's networks from node ${host.name}`)
    return clusterNetworks(snap)
  }

  // ── VPN: sign-in links ────────────────────────────────────────────────────

  private loginFor(machineId: string, provider: ProviderId): { url: string; until: number } | null {
    const k = `${machineId}|${provider}`
    const v = this.logins.get(k)
    if (v && v.until <= this.now()) { this.logins.delete(k); return null }
    return v ?? null
  }

  /** Keep a sign-in link in memory and send it to private channels only, as a sensitive link. */
  private async captureLogin(m: Machine, provider: ProviderId, url: string): Promise<void> {
    const until = this.now() + LOGIN_URL_TTL_MS
    this.logins.set(`${m.id}|${provider}`, { url, until })
    await this.d.publish?.({
      type: 'vpn.login.needed', severity: 'warning',
      title: `${m.name} needs a ${PROVIDER_LABEL[provider]} sign-in`,
      lines: [`Open the link to sign ${m.name} in to ${PROVIDER_LABEL[provider]}. It expires in about 10 minutes.`],
      sensitiveLink: url, sensitiveUntil: new Date(until), linkLabel: 'Sign in', where: 'VPN page',
      subject: { kind: 'machine', name: m.name },
    }, { privateOnly: true }).catch(() => undefined)
  }

  /** The sign-in link waiting for a machine, for an admin who has re-confirmed. Audited without the link. */
  async revealLogin(machineId: string, provider: ProviderId, by: string): Promise<{ url: string; expiresAt: string } | null> {
    if (!isProviderId(provider)) throw new RemoteInputError('provider must be tailscale or netbird')
    const v = this.loginFor(machineId, provider)
    await this.d.store.audit('remote.login-url.reveal', machineId, { by, provider, found: !!v })
    return v ? { url: v.url, expiresAt: new Date(v.until).toISOString() } : null
  }

  // ── VPN: one-click install ────────────────────────────────────────────────

  /** What a one-click install would do, in words, with the provider's defaults. Changes nothing. */
  async installPreview(machineId: string, provider: ProviderId): Promise<{
    machineId: string; provider: ProviderId; profile: 'node' | 'guest'; tags: string[]; acceptDns: boolean; flags: string[]; steps: string[]
  }> {
    if (!isProviderId(provider)) throw new RemoteInputError('provider must be tailscale or netbird')
    const m = (await this.d.exec.listMachines()).find(x => x.id === machineId)
    if (!m) throw new RemoteNotFoundError(`No such machine: ${machineId}`)
    const settings = await this.d.providerSettings(provider)
    const acceptDns = m.kind === 'node' ? false : m.kind === 'lxc' ? !!settings.acceptDnsCt : !!settings.acceptDnsVm
    const flags = clientFlags(provider, { hostname: safeHostname(m.name), kind: m.kind, managementUrl: settings.managementUrl, prefs: { acceptDns } })
    const label = PROVIDER_LABEL[provider]
    const steps = [
      `Install ${label} on ${m.name} from the official repository.`,
      `Sign it in with a single-use key${settings.tags.length ? ` tagged ${settings.tags.join(', ')}` : ''}; the key is revoked straight after.`,
      ...(m.kind === 'node'
        ? ['Proxmox node profile: its own DNS and routes, no SSH over the overlay, no firewall rules of its own, never an exit node. Checked before and after, rolled back on any change.']
        : [acceptDns ? `Let ${label} manage ${m.name}'s DNS so overlay names resolve.` : `Leave ${m.name}'s DNS as it is.`, 'Accept no routes from other devices; offer none.']),
    ]
    return { machineId, provider, profile: m.kind === 'node' ? 'node' : 'guest', tags: settings.tags, acceptDns, flags, steps }
  }

  /** One click: install with the provider's defaults. Admin and re-confirmation are checked by the route. */
  async oneClickInstall(machineId: string, provider: ProviderId, by: string): Promise<RemoteJob> {
    const pv = await this.installPreview(machineId, provider)
    return this.startJob({ action: 'install', provider, machineIds: [machineId], tags: pv.tags, acceptDns: pv.acceptDns }, by)
  }

  // ── VPN: per-machine settings ─────────────────────────────────────────────

  /** The client's settings as it reports them now. */
  private async readPrefs(job: RemoteJob, m: Machine, provider: ProviderId, rec: RemoteRecord): Promise<VpnPrefs> {
    if (provider === 'tailscale') {
      const r = await this.exec(job, m, TS_PREFS_READBACK, { timeoutMs: 60_000 })
      const p = parseTailscalePrefs(r.output)
      if (!p) throw new Error('could not read Tailscale\'s settings back from the machine')
      return { acceptDns: p.acceptDns, acceptRoutes: p.acceptRoutes, ssh: p.ssh, advertiseExitNode: p.advertiseExitNode, exitNode: p.exitNode, exitNodeAllowLan: p.exitNodeAllowLan, subnets: p.subnets }
    }
    const r = await this.exec(job, m, NB_FLAGS_READBACK, { timeoutMs: 60_000, netbird: true })
    const f = parseNetbirdFlags(r.output)
    if (!f.config) throw new Error('could not tell which config file the running NetBird daemon uses')
    return {
      acceptDns: f.DisableDNS === false, acceptRoutes: f.DisableClientRoutes === false && !rec.prefs?.exitNode, ssh: f.ServerSSHAllowed === true,
      advertiseExitNode: rec.exitNode, exitNode: rec.prefs?.exitNode ?? null, exitNodeAllowLan: rec.prefs?.exitNodeAllowLan ?? true, subnets: rec.routes,
    }
  }

  /** Read the machine's settings now, and say in words what `change` would do. Changes nothing. */
  async configurePreview(machineId: string, provider: ProviderId, change: Partial<VpnPrefs>): Promise<{ current: VpnPrefs; desired: VpnPrefs; changes: string[]; refusal: string | null }> {
    if (!isProviderId(provider)) throw new RemoteInputError('provider must be tailscale or netbird')
    const m = (await this.d.exec.listMachines()).find(x => x.id === machineId)
    if (!m) throw new RemoteNotFoundError(`No such machine: ${machineId}`)
    const rec = await this.record(m, provider).catch(e => { throw new RemoteInputError(msg(e)) })
    const scratch: RemoteJob = { id: randomUUID(), action: 'configure', provider, by: 'preview', status: 'running', steps: [], log: '', startedAt: new Date(this.now()).toISOString() }
    const current = await this.readPrefs(scratch, m, provider, rec)
    const desired = mergePrefs(current, change)
    const refusal = checkPrefs(m, provider, desired) ?? (desired.subnets.length || desired.advertiseExitNode ? checkRouting(m, { subnets: desired.subnets, exitNode: desired.advertiseExitNode }, true) : null)
    return { current, desired, changes: describePrefs(m, provider, current, desired), refusal }
  }

  private async configure(job: RemoteJob, req: JobRequest, p: RemoteProvider | null, settings: ProviderSettings, m: Machine, all: Machine[]): Promise<string> {
    const provider = req.provider
    const rec = await this.record(m, provider)
    const current = await this.readPrefs(job, m, provider, rec)
    const desired = mergePrefs(current, req.prefs ?? {})
    const refusal = checkPrefs(m, provider, desired)
    if (refusal) throw new Error(refusal)
    const words = describePrefs(m, provider, current, desired)
    if (!words.length) return 'Nothing to change.'

    // Offering routes or an exit node goes through the routing action, with its overlap checks and approvals.
    const routingChanged = desired.advertiseExitNode !== current.advertiseExitNode ||
      JSON.stringify([...desired.subnets].sort()) !== JSON.stringify([...current.subnets].sort())
    if (routingChanged) {
      await this.routing(job, { ...req, action: 'routing', subnets: desired.subnets, exitNode: desired.advertiseExitNode, acknowledge: req.acknowledge }, need(p), settings, m, all)
    }
    const clientChanged = (['acceptDns', 'acceptRoutes', 'ssh', 'exitNode', 'exitNodeAllowLan'] as const).some(k => desired[k] !== current[k])
    if (clientChanged) {
      const routing = { subnets: desired.subnets, exitNode: desired.advertiseExitNode }
      const flagsFor = (pr: VpnPrefs) => clientFlags(provider, { hostname: safeHostname(m.name), kind: m.kind, managementUrl: settings.managementUrl, routing, prefs: pr })
      const undo: { plan: UndoPlan; persist?: () => Promise<void> } = { plan: { kind: 'configure', provider, previous: current, flags: flagsFor(current) } }
      await this.guarded(job, m, provider, p, 'configure', undo, async () => {
        const out = await this.exec(job, m, configureScript(provider, desired, flagsFor(desired)), { netbird: provider === 'netbird', timeoutMs: 2 * 60_000 })
        if (out.code !== 0) throw new Error(`changing ${PROVIDER_LABEL[provider]}'s settings failed (exit ${out.code}); see the log`)
        // Confirmed from the client itself, never from the flags sent.
        const wrong: string[] = []
        if (provider === 'tailscale') {
          const got = parseTailscalePrefs(out.output)
          if (!got) throw new Error('could not read Tailscale\'s settings back, so the change is not confirmed')
          for (const k of ['acceptDns', 'acceptRoutes', 'ssh', 'exitNodeAllowLan'] as const) if (got[k] !== desired[k]) wrong.push(`${k} is ${got[k]}`)
          if (!!got.exitNode !== !!desired.exitNode) wrong.push(`the exit node is ${got.exitNode ?? 'none'}`)
        } else {
          const f = parseNetbirdFlags(out.output)
          if (!f.config) throw new Error('could not tell which config file the running NetBird daemon uses, so the change is not confirmed')
          if (f.DisableDNS !== !desired.acceptDns) wrong.push(`DisableDNS is ${f.DisableDNS}`)
          if (f.DisableClientRoutes !== !(desired.acceptRoutes || !!desired.exitNode)) wrong.push(`DisableClientRoutes is ${f.DisableClientRoutes}`)
          if ((f.ServerSSHAllowed ?? false) !== desired.ssh) wrong.push(`ServerSSHAllowed is ${f.ServerSSHAllowed}`)
          if (desired.exitNode && !new RegExp(`^HP_NB_NET .*${desired.exitNode.replace(/[^A-Za-z0-9_-]/g, '')}.*(selected|✓|true)`, 'im').test(out.output)) wrong.push('the exit node is not selected')
          if (desired.ssh !== current.ssh && rec.deviceId && p?.setSsh) await p.setSsh({ id: rec.deviceId, name: rec.hostname ?? m.name, addresses: [], online: true, lastSeen: null, version: null }, desired.ssh)
        }
        if (wrong.length) throw new Error(`the client did not take the change: ${wrong.join(', ')}`)
      }, { undoOnFailure: true })
    }
    const { installedAt: _i, updatedAt: _u, ...base } = await this.record(m, provider)
    await this.d.store.upsert({ ...base, prefs: { ...desired, tags: rec.prefs?.tags ?? [], netfilterOff: m.kind === 'node' } })
    await this.d.store.audit('remote.configure', m.id, { by: job.by, provider, changes: words })
    return words.join(' ')
  }

  // ── VPN: devices at the provider ──────────────────────────────────────────

  private async machineDevice(machineId: string, provider: ProviderId): Promise<{ p: RemoteProvider; dev: ProviderDevice; rec: RemoteRecord }> {
    if (!isProviderId(provider)) throw new RemoteInputError('provider must be tailscale or netbird')
    const rec = await this.d.store.get(machineId, provider)
    if (!rec?.deviceId) throw new RemoteNotFoundError(`No ${PROVIDER_LABEL[provider]} device is recorded for ${machineId}`)
    const p = await this.d.provider(provider)
    if (!p) throw new RemoteInputError(`${PROVIDER_LABEL[provider]} is not configured`)
    return { p, rec, dev: { id: rec.deviceId, name: rec.hostname ?? machineId, addresses: [], online: true, lastSeen: null, version: null } }
  }

  /** Turn key expiry (Tailscale) or login expiration (NetBird) off for a server, or back on. */
  async setKeyExpiry(machineId: string, provider: ProviderId, disabled: boolean, by: string): Promise<string> {
    const { p, dev } = await this.machineDevice(machineId, provider)
    if (!p.setKeyExpiry) throw new RemoteInputError(`${PROVIDER_LABEL[provider]} cannot change key expiry`)
    await p.setKeyExpiry(dev, disabled)
    this.devices.delete(provider)
    await this.d.store.audit('remote.key-expiry', machineId, { by, provider, disabled })
    return disabled ? 'Key expiry is off: this machine stays signed in until you remove it.' : 'Key expiry is on again.'
  }

  /** Replace the device's Tailscale tags or NetBird groups. */
  async setTags(machineId: string, provider: ProviderId, tags: string[], by: string): Promise<string> {
    if (!Array.isArray(tags) || tags.length > 20 || !tags.every(t => typeof t === 'string' && (provider === 'tailscale' ? TAG_RE : NB_GROUP_RE).test(t))) {
      throw new RemoteInputError(provider === 'tailscale' ? 'Tags look like tag:server (at most 20)' : 'Group names are letters, numbers, spaces, dots and dashes (at most 20)')
    }
    const { p, dev } = await this.machineDevice(machineId, provider)
    if (!p.setTags) throw new RemoteInputError(`${PROVIDER_LABEL[provider]} cannot change tags`)
    await p.setTags(dev, tags)
    this.devices.delete(provider)
    await this.d.store.audit('remote.tags', machineId, { by, provider, tags })
    return tags.length ? `Now ${tags.join(', ')}.` : 'No tags or groups.'
  }

  /** Approve a device that waits for approval (any device at the provider, managed or not). */
  async approveDevice(provider: ProviderId, deviceId: string, by: string): Promise<string> {
    if (!isProviderId(provider)) throw new RemoteInputError('provider must be tailscale or netbird')
    const p = await this.d.provider(provider)
    if (!p?.approve) throw new RemoteInputError(`${PROVIDER_LABEL[provider]} is not configured or cannot approve devices`)
    const dev = (await this.deviceList(provider, p, true)).find(d => d.id === deviceId)
    if (!dev) throw new RemoteNotFoundError(`No such ${PROVIDER_LABEL[provider]} device: ${deviceId}`)
    await p.approve(dev)
    this.devices.delete(provider)
    await this.d.store.audit('remote.device.approve', `${provider}:${deviceId}`, { by, name: dev.name })
    return `Approved ${dev.name}.`
  }

  /** Remove a device from the provider by its id. The machine, if HyperProx manages it, keeps its client. */
  async removeDevice(provider: ProviderId, deviceId: string, by: string): Promise<string> {
    if (!isProviderId(provider)) throw new RemoteInputError('provider must be tailscale or netbird')
    const p = await this.d.provider(provider)
    if (!p) throw new RemoteInputError(`${PROVIDER_LABEL[provider]} is not configured`)
    const dev = (await this.deviceList(provider, p, true)).find(d => d.id === deviceId)
    if (!dev) throw new RemoteNotFoundError(`No such ${PROVIDER_LABEL[provider]} device: ${deviceId}`)
    await p.deleteDevice(deviceId)
    this.devices.delete(provider)
    await this.d.store.audit('remote.device.remove', `${provider}:${deviceId}`, { by, name: dev.name })
    return `Removed ${dev.name} from ${PROVIDER_LABEL[provider]}.`
  }

  /**
   * Look for devices that appeared at each provider since the last look, and announce each one once. Devices
   * HyperProx installed are expected and not announced. Paused while locked (the provider cannot be read).
   */
  pollDevices(): Promise<void> {
    if (this.polling) return this.polling
    this.polling = (async () => {
      try {
        for (const id of PROVIDER_IDS) {
          let p: RemoteProvider | null
          try { p = await this.d.provider(id) } catch { return }      // locked: resume after unlock
          if (!p) continue
          let list: ProviderDevice[]
          try { list = await this.deviceList(id, p, true) } catch { continue }
          const known = new Set(await this.d.store.listKnownDevices(id))
          const fresh = list.filter(d => !known.has(d.id))
          if (!fresh.length) { if (!known.size) await this.d.store.addKnownDevices(id, [SEEDED]); continue }
          if (known.size) {
            const ours = new Set((await this.d.store.list()).filter(r => r.provider === id && r.deviceId).map(r => r.deviceId!))
            for (const d of fresh.filter(d => !ours.has(d.id))) {
              await this.d.publish?.({
                type: 'vpn.device.new', severity: d.pending ? 'warning' : 'info',
                title: `New ${PROVIDER_LABEL[id]} device: ${d.name}`,
                lines: [
                  `${d.os ? `${d.os}, ` : ''}added by ${d.user ?? 'an unknown user'}.`,
                  d.pending ? 'It is waiting for approval: approve or remove it on the VPN page.' : 'Review it on the VPN page; remove it there if you do not know it.',
                ],
                link: '/vpn', linkLabel: d.pending ? 'Approve or remove' : 'Review', where: 'VPN page',
                subject: { kind: 'device', name: d.name }, fingerprint: `vpn.device.new:${id}:${d.id}`,
                // Named by whoever added the device: plain text on channels that render markdown.
                plain: [d.name, ...(d.os ? [d.os] : []), ...(d.user ? [d.user] : [])],
              }).catch(() => undefined)
            }
          }
          // The first look only learns what is there; from then on each new device is announced once.
          await this.d.store.addKnownDevices(id, [...fresh.map(d => d.id), ...(known.size ? [] : [SEEDED])])
        }
      } catch (e) {
        this.d.log?.(`[remote] device poll: ${msg(e)}`)
      } finally {
        this.polling = null
      }
    })()
    return this.polling
  }

  // ── Host keys: every script goes only to a pinned key ─────────────────────

  /** The key the machine's SSH endpoint presents now, and what is pinned for it. Changes nothing. */
  async hostKeyPreview(machineId: string): Promise<{ host: string; port: number; fingerprint: string; pinned: string | null }> {
    const m = (await this.d.exec.listMachines()).find(x => x.id === machineId)
    if (!m) throw new RemoteNotFoundError(`No such machine: ${machineId}`)
    const { host, port } = await this.d.exec.hostKeyTarget(m)
    const fingerprint = await this.d.exec.probeHostKey(host, port)
    return { host, port, fingerprint, pinned: await this.d.exec.pinnedHostKey(host, port) }
  }

  /**
   * Pin the key the admin has checked. It must be the key presented right now, and nothing different may be
   * pinned already: replacing a pin is a deliberate act in the Terminal, never a side effect here.
   */
  async pinHostKey(machineId: string, fingerprint: string, by: string): Promise<{ pinned: boolean; message: string }> {
    if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint)) throw new RemoteInputError('fingerprint must look like SHA256:<43 characters>')
    const pv = await this.hostKeyPreview(machineId)
    if (pv.fingerprint !== fingerprint) throw new RemoteInputError(`${pv.host}:${pv.port} presents ${pv.fingerprint} now, not the key you confirmed; nothing was pinned`)
    if (pv.pinned === fingerprint) {
      // Confirmed by the admin now, even if it was learned on first use before.
      await this.d.exec.pinHostKey(pv.host, pv.port, fingerprint)
      return { pinned: false, message: `${pv.host}:${pv.port} is already pinned to that key; it is now marked as confirmed.` }
    }
    if (pv.pinned) throw new RemoteInputError(`A different key is pinned for ${pv.host}:${pv.port}. If the machine was rebuilt, clear the old pin in the Terminal first.`)
    await this.d.exec.pinHostKey(pv.host, pv.port, fingerprint)
    await this.d.store.audit('remote.pin-host-key', machineId, { by, host: pv.host, port: pv.port, fingerprint })
    return { pinned: true, message: `Pinned ${pv.host}:${pv.port} to ${fingerprint}. The Terminal uses the same pin.` }
  }

  // ── Manual flow (Windows, macOS) ──────────────────────────────────────────

  async manualKey(machineId: string, provider: ProviderId, tags: string[] | undefined, by: string): Promise<{ secret: string; expiresAt: string; downloadUrl: string; note: string }> {
    if (!isProviderId(provider)) throw new RemoteInputError('provider must be tailscale or netbird')
    const m = (await this.d.exec.listMachines()).find(x => x.id === machineId)
    if (!m) throw new RemoteNotFoundError(`No such machine: ${machineId}`)
    const p = await this.d.provider(provider)
    if (!p) throw new RemoteInputError(`${PROVIDER_LABEL[provider]} is not configured`)
    const settings = await this.d.providerSettings(provider)
    // Recorded before it is shown: the sweep revokes it in 30 minutes even if HyperProx restarts meanwhile.
    const { key } = await this.mintRecorded(p, provider, `HyperProx manual ${m.id}`, tags ?? settings.tags, MANUAL_KEY_REVOKE_MS, 'manual')
    await this.d.store.audit('remote.manual-key', m.id, { by, provider, expiresAt: key.expiresAt })
    const extra = provider === 'tailscale' ? ' --accept-dns=false --accept-routes=false' : (settings.managementUrl ? ` --management-url ${settings.managementUrl}` : '')
    return {
      secret: key.secret, expiresAt: key.expiresAt, downloadUrl: DOWNLOAD_URL[provider],
      note: (provider === 'tailscale' ? 'Single use, expires in 10 minutes. ' : 'Single use. HyperProx revokes it in 30 minutes. ') +
        'In the app, sign in with the key. From a terminal (macOS), pass it on stdin, never as an argument: run ' +
        (provider === 'tailscale' ? `tailscale up --auth-key=file:/dev/stdin${extra}` : `netbird up --setup-key-file /dev/stdin${extra}`) +
        ', paste the key, then press Ctrl-D.',
    }
  }
}
