// Remote access (Tailscale, NetBird): the shapes /api/remote returns. Kept in step with
// apps/api/src/lib/remote/service.ts.

export type RemoteProviderId = 'tailscale' | 'netbird'
export type RemoteMachineKind = 'node' | 'lxc' | 'qemu' | 'host'
export type RemoteCellState = 'connected' | 'offline' | 'missing' | 'not-installed' | 'manual' | 'unconfigured' | 'unknown' | 'signed-out' | 'unchecked' | 'excluded'

export interface RemoteCell {
  state: RemoteCellState
  managed: boolean
  ip: string | null
  version: string | null
  lastSeen: string | null
  deviceName: string | null
  mode: 'kernel' | 'userspace' | null
  routes: string[]
  exitNode: boolean
  lastError: string | null
  /** The client was already there; HyperProx only recorded it. */
  adopted: boolean
  dnsName: string | null
  expiresAt: string | null
  expiryWarning: boolean
  keyExpiryDisabled: boolean
  pending: boolean
  tags: string[]
  prefs: VpnClientPrefs | null
  loginPending: boolean
  /** What the read-only probe found on the machine (admins), in words (everyone), and when. */
  detected?: VpnDetectedClient | null
  detectedText: string | null
  checkedAt: string | null
}

/** A client found on a machine by the read-only probe, with no provider key. */
export interface VpnDetectedClient {
  installed: boolean; running: boolean; loggedIn: boolean; connected: boolean
  tailnet: string | null; ip: string | null; dnsName: string | null; version: string | null; keyExpiry: string | null
  acceptDns: boolean | null; acceptRoutes: boolean | null; ssh: boolean | null; exitNode: string | null
  advertiseExitNode: boolean; advertisedRoutes: string[]
}

/** A client's own settings, as read back from it. */
export interface VpnClientPrefs {
  acceptDns: boolean; acceptRoutes: boolean; ssh: boolean; advertiseExitNode: boolean; exitNode: string | null
  exitNodeAllowLan: boolean; subnets: string[]; tags?: string[]; netfilterOff?: boolean
}

export type VpnPrefs = Omit<VpnClientPrefs, 'tags' | 'netfilterOff'>

export interface RemoteMachineRow {
  id: string
  kind: RemoteMachineKind
  name: string
  node?: string
  vmid?: number
  running: boolean
  ostype?: string
  address?: string
  cells: Record<RemoteProviderId, RemoteCell>
  /** HyperProx's own container: shown read-only. */
  self?: boolean
  /** Never looked inside or touched for VPN work: by the VPN page's exclusions, or the hyperprox-ignore tag. */
  excluded?: boolean
  excludedBy?: 'setting' | 'tag'
}

export interface RemoteOverview {
  providers: Array<{
    id: RemoteProviderId; label: string; configured: boolean; error: string | null; devices: number
    /** Machines already signed in (from the probe, no key needed). */
    onTailnet: number
    /** The card's line when there is no API key; null when the provider is set up. */
    summary: string | null
  }>
  /** The read-only probe: when it last finished, and whether one is running. */
  detection: { checkedAt: string | null; running: boolean }
  machines: RemoteMachineRow[]
  activeJobId: string | null
  /** Node changes not yet through their guard. `interrupted`: cut off by a restart, waiting to be re-checked. */
  attention: Array<{ machineId: string; provider: RemoteProviderId; action: string; since: string; interrupted: boolean }>
  /** Keys whose revocation is overdue and not yet confirmed by the provider. */
  pendingRevokes: number
  /** Devices waiting for approval at a provider (admins only). */
  pendingDevices: Array<{ provider: RemoteProviderId; id: string; name: string; os: string | null; user: string | null; createdAt: string | null; machineId: string | null }>
}

export type RemoteJobAction = 'install' | 'check' | 'update' | 'routing' | 'uninstall' | 'recovery' | 'configure'
export type RemoteStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface RemoteJob {
  id: string
  action: RemoteJobAction
  provider: RemoteProviderId
  by: string
  status: 'running' | 'completed' | 'failed'
  steps: Array<{ machineId: string; name: string; status: RemoteStepStatus; detail?: string }>
  log: string
  error?: string
  startedAt: string
  finishedAt?: string
}

export interface RemoteFirewallPreview { clusterEnabled: boolean; exists: boolean; rule: Record<string, string>; message: string }

export interface RemoteHostKey { host: string; port: number; fingerprint: string; pinned: string | null }

export interface RemoteManualKey { secret: string; expiresAt: string; downloadUrl: string; note: string }

export interface VpnInstallPreview {
  machineId: string; provider: RemoteProviderId; profile: 'node' | 'guest'; tags: string[]; acceptDns: boolean; flags: string[]; steps: string[]
}

export interface VpnSettingsPreview { current: VpnPrefs; desired: VpnPrefs; changes: string[]; refusal: string | null }

// ── The /api/remote/v1 API, for other pages (see docs/remote-access.md, "API for other pages") ──────────────

/** One provider's state on one machine. Fields after `expiryWarning` are present for admins only. */
export interface VpnProviderStatus {
  state: RemoteCellState
  /** HyperProx installed or adopted it. */
  installed: boolean
  ip: string | null
  dnsName: string | null
  version: string | null
  lastSeen: string | null
  expiresAt: string | null
  expiryWarning: boolean
  /** The VPN page's panel for this machine and provider. */
  panel: string
  /** The probe found this client on the machine (installed or adopted by HyperProx or not). */
  found?: boolean
  /** What the probe found, in words: "Tailscale installed, connected as …", "installed, signed out", "not installed". */
  text?: string | null
  checkedAt?: string | null
  loginPending?: boolean
  pending?: boolean
  tags?: string[]
  routes?: string[]
  exitNode?: boolean
  prefs?: VpnClientPrefs | null
}

export interface VpnMachineStatus {
  /** `node-<name>`, `lxc-<vmid>`, `qemu-<vmid>` or `host-<id>`. */
  machineId: string
  kind: RemoteMachineKind
  name: string
  node: string | null
  vmid: number | null
  running: boolean
  /** HyperProx's own container: shown read-only. */
  self?: boolean
  providers: Record<RemoteProviderId, VpnProviderStatus>
}

/**
 * What the infrastructure pages plug into their guest drill-down and list badges. The default implementation
 * is apps/frontend/lib/vpn.ts. Every method that changes something needs the admin role and a master-password
 * re-confirmation; the promise rejects with { code: 'reconfirm_required' } when one is due.
 */
export interface VpnStatusSource {
  /** Every node and guest. */
  list(): Promise<VpnMachineStatus[]>
  /** One machine by id, e.g. statusFor('lxc-101'); null when there is no such machine. */
  statusFor(machineId: string): Promise<VpnMachineStatus | null>
  /** The id the VPN API uses for a guest. */
  guestId(type: 'lxc' | 'qemu', vmid: number): string
  /** What a one-click install would do (admin). */
  installPreview(machineId: string, provider: RemoteProviderId): Promise<VpnInstallPreview>
  /** Start a one-click install with the provider defaults (admin, re-confirmed). Resolves to the job id. */
  install(machineId: string, provider: RemoteProviderId): Promise<{ jobId: string }>
  /** Remove the client and delete its device at the provider (admin, re-confirmed). */
  uninstall(machineId: string, provider: RemoteProviderId): Promise<{ jobId: string }>
  /** The client's current settings, read back from it (admin). */
  settings(machineId: string, provider: RemoteProviderId): Promise<VpnPrefs>
  /** What a settings change would do, in words (admin). */
  previewSettings(machineId: string, provider: RemoteProviderId, change: Partial<VpnPrefs>): Promise<VpnSettingsPreview>
  /** Apply a settings change (admin, re-confirmed). */
  applySettings(machineId: string, provider: RemoteProviderId, change: Partial<VpnPrefs>): Promise<{ jobId: string }>
  /** A job's progress; poll until status is no longer 'running'. */
  job(jobId: string): Promise<RemoteJob>
  /** Where the VPN page shows this machine's panel. */
  panelUrl(machineId: string, provider?: RemoteProviderId): string
}
