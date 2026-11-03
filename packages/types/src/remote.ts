// Remote access (Tailscale, NetBird): the shapes /api/remote returns. Kept in step with
// apps/api/src/lib/remote/service.ts.

export type RemoteProviderId = 'tailscale' | 'netbird'
export type RemoteMachineKind = 'node' | 'lxc' | 'qemu' | 'host'
export type RemoteCellState = 'connected' | 'offline' | 'missing' | 'not-installed' | 'manual' | 'unconfigured' | 'unknown'

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
}

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
}

export interface RemoteOverview {
  providers: Array<{ id: RemoteProviderId; label: string; configured: boolean; error: string | null; devices: number }>
  machines: RemoteMachineRow[]
  activeJobId: string | null
  /** Node changes not yet through their guard. `interrupted`: cut off by a restart, waiting to be re-checked. */
  attention: Array<{ machineId: string; provider: RemoteProviderId; action: string; since: string; interrupted: boolean }>
  /** Keys whose revocation is overdue and not yet confirmed by the provider. */
  pendingRevokes: number
}

export type RemoteJobAction = 'install' | 'check' | 'update' | 'routing' | 'uninstall' | 'recovery'
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

export interface RemoteManualKey { secret: string; expiresAt: string; downloadUrl: string; note: string }
