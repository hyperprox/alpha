// --- Updates -----------------------------------------------------------------
// Shared by the Updates API (apps/api/src/routes/updates.ts) and page (apps/frontend/app/updates).

export type UpdatesPkgChange = {
  name: string; from: string | null; to: string
  /** From a -security suite (Debian-Security and the like). */
  security?: boolean
}

/** Which cluster an inventory, plan or check is for. Home is drawn teal, a remote amber with its name. */
export type UpdatesClusterRef = { id: string; name: string; kind: 'home' | 'remote' }

/**
 * A node's preview as apt itself simulates it (remote clusters, and the daily check): what the node upgrade
 * would install, upgrade or remove, and what that means.
 */
export type UpdatesNodePreview = {
  source:    'apt-simulation'
  verb:      'upgrade' | 'dist-upgrade'
  removals:  string[]
  kernel:    boolean            // a new kernel is installed: it runs only after a reboot
  firmware:  boolean            // firmware packages change: they load only after a reboot
  proxmoxVe: boolean            // proxmox-ve, pve-manager or another core Proxmox package changes
  rebootAfter: boolean          // a reboot will be needed after this upgrade
  error?:    string             // the simulation failed; nothing would be installed
}

export type UpdatesNodePolicyView = {
  upgrade:       'upgrade' | 'dist-upgrade'
  reboot:        'auto' | 'manual'
  order?:        'first' | 'last'
  requireHolds?: string[]
  requirePin?:   string
}

export type UpdatesNode = {
  node:           string
  online:         boolean
  pending:        UpdatesPkgChange[]
  cephPending:    boolean
  kernelPending:  boolean
  rebootRequired: boolean
  rebootPending:  boolean           // a reboot the run deferred (manual policy, streams, window ended)
  policy:         UpdatesNodePolicyView
  holdsOk:        boolean | null    // null: the policy requires none
  pinOk:          boolean | null
  isSelf:         boolean           // the node HyperProx itself runs on
  /** Packages on hold (`apt-mark showhold`): reported as held, never offered or installed. */
  held?:          string[]
  /** apt's own simulation of the node upgrade (remote clusters). */
  preview?:       UpdatesNodePreview
  /** A one-node server with no cluster: no quorum or HA to check. */
  standalone?:    boolean
  error?:         string
}

export type UpdatesUnmanagedReason = 'excluded' | 'not-running' | 'no-apt' | 'no-agent' | 'windows'

export type UpdatesGuest = {
  vmid:             number
  type:             'lxc' | 'qemu'
  name:             string
  node:             string
  running:          boolean
  managed:          boolean
  unmanagedReason?: UpdatesUnmanagedReason
  pending:          UpdatesPkgChange[]
  rebootRequired:   boolean
  keptBack?:        string[]          // held, or kept back by `apt-get upgrade`: never installed by a run
  haManaged:        boolean
  snapshotCapable:  boolean
  docker:           'none' | 'auto' | 'manual'
  dockerImages?:    { image: string; current: string; latest: string | null }[]
  /** Apps a plug-in's app-update provider found in the guest (npm installs and the like). */
  apps?:            UpdatesApp[]
  /**
   * Remote clusters: a guest that cannot be snapshotted is updated only when this id is approved for the run
   * (an explicit "update without a snapshot"). Absent when a snapshot is possible.
   */
  noSnapshotAckId?: string
  /** The newest backup task HyperProx could see on this cluster, and whether it named this guest. */
  lastBackup?:      { at: string; ok: boolean; thisGuest: boolean } | null
  error?:           string
}

// --- Apps installed outside apt and docker, found by plug-in providers -------------

/** `auto`: a run applies it. `manual` (the default): only when approved for a run. `off`: reported, never planned. */
export type UpdatesAppMode = 'auto' | 'manual' | 'off'

/** A configuration change a provider proposes. Applied only when approved by its own id, never as part of an update. */
export type UpdatesAppFix = {
  id:          string            // approval id; changes whenever the change itself would change
  description: string
  file:        string            // the file it edits, inside the guest
  change:      string            // exactly what is written, for a person to read before approving
}

export type UpdatesAppIssue = {
  message:  string
  /** A blocking issue keeps the update out of the plan until it is fixed (by hand, or by approving `fix`). */
  blocking: boolean
  fix?:     UpdatesAppFix
}

export type UpdatesAppNote = { version: string; url?: string; text: string }

export type UpdatesApp = {
  provider:       string            // provider id, e.g. "meshcentral"
  name:           string            // what people call it
  key:            string            // stable id of this install within the guest
  installed:      string
  latest:         string | null     // null: not known (see error)
  location:       string            // where it is installed, inside the guest
  runAs:          string            // the user that owns the install
  service:        string | null     // systemd unit; without one HyperProx will not update it
  running:        boolean
  how:            string            // one line: how it is installed and run
  mode:           UpdatesAppMode
  isSecurity:     boolean
  securityNote?:  string            // the line or advisory that made it a security update
  notes:          UpdatesAppNote[]  // release notes between installed and latest, newest first, trimmed
  issues:         UpdatesAppIssue[]
  rollback:       string            // how to undo an update, in words
  /** Send this id to approve the update to `latest` for one run; null when there is nothing to approve. */
  approvalId:     string | null
  error?:         string
}

export type UpdatesInventory = { refreshedAt: string; nodes: UpdatesNode[]; guests: UpdatesGuest[]; cluster?: UpdatesClusterRef }

export type UpdatesStepAction =
  | 'preflight' | 'refresh' | 'snapshot' | 'apt' | 'docker' | 'check' | 'ceph'
  | 'node-upgrade' | 'node-reboot' | 'kernel-cleanup' | 'self' | 'app' | 'app-config'

export type UpdatesStepStatus = 'pending' | 'running' | 'ok' | 'failed' | 'skipped'

export type UpdatesStep = {
  id:         string
  seq:        number
  target:     string                // node name, or a guest's vmid as a string
  action:     UpdatesStepAction
  status:     UpdatesStepStatus
  detail?:    string
  reason?:    string | null
  output?:    string | null         // tail of captured output
  startedAt?: string | null
  endedAt?:   string | null
}

/** What a run may touch: everything, or the guests alone (no node, Ceph or node-reboot steps). */
export type UpdatesScope = 'all' | 'guests'

export type UpdatesPlan = {
  steps:     Omit<UpdatesStep, 'id' | 'status'>[]
  warnings:  string[]
  scope?:    UpdatesScope
  /** App updates and config changes approved for this run, by approval id. */
  approved?: string[]
  /** The cluster this plan is for. A job is only ever confirmed, resumed or rolled back for this cluster. */
  cluster?:  UpdatesClusterRef
}

export type UpdatesReport = {
  summary:       string
  changed:       { target: string; packages: number }[]
  skipped:       { target: string; reason: string }[]
  rebootsPending: string[]
}

export type UpdatesJobStatus =
  | 'planned' | 'awaiting-confirm' | 'running' | 'paused' | 'failed' | 'done' | 'cancelled'

export type UpdatesJob = {
  id:           string
  trigger:      'manual' | 'schedule' | 'dry-run'
  status:       UpdatesJobStatus
  pauseReason?: string | null
  plan:         UpdatesPlan
  report?:      UpdatesReport | null
  startedAt:    string
  finishedAt?:  string | null
  steps:        UpdatesStep[]
}

export type UpdatesPolicyStatus = {
  loaded:   boolean
  path:     string
  error?:   string
  schedule: { enabled: boolean; cron: string; nextRun: string | null; windowHours: number }
  cluster?: UpdatesClusterRef
  /** Remote clusters: the policy section used (`clusters.<id or name>`), or null for the built-in remote defaults. */
  section?: string | null
  /** Plain-language notes about how this cluster is treated (remote defaults, no scheduled runs, ...). */
  notes?:   string[]
  /** The daily read-only check. */
  check?:   { enabled: boolean; cron: string; nextRun: string | null; reminderDays: number }
}

/** What a node reboot on a one-node server takes down, shown before the reboot is confirmed. */
export type UpdatesRebootPreview = {
  node:        string
  cluster:     UpdatesClusterRef
  standalone:  boolean
  /** Guests running now: they stop with the node. `onboot` ones are started again by Proxmox. */
  goingDown:   { vmid: number; type: 'lxc' | 'qemu'; name: string; onboot: boolean }[]
  runningKernel: string | null
  bootsKernel:   string | null
  rebootNeeded:  boolean
  warnings:    string[]
}

// --- The daily check (read-only) ------------------------------------------------

export type UpdatesCheckTarget = {
  kind:      'node' | 'lxc' | 'qemu'
  name:      string             // node name, or the guest's name
  vmid?:     number
  packages:  number
  security:  string[]           // package names from a -security suite
  kernel:    boolean
  rebootNeeded: boolean
  held:      number             // held or kept back: reported, never offered
}

export type UpdatesCheckCluster = {
  cluster:   UpdatesClusterRef
  at:        string
  /** ok: read; skipped: not read this time, with the reason (unreachable, locked, backup or job running). */
  result:    'ok' | 'skipped' | 'partial'
  reason?:   string
  /** When this cluster was last read in full; a skipped run keeps the targets from then. */
  lastOkAt?: string | null
  targets:   UpdatesCheckTarget[]
  /** Machines that could not be read, with a short reason. */
  unread:    string[]
  available: number             // targets with packages to offer
  packages:  number
  security:  number
}

export type UpdatesCheckStatus = {
  running:   boolean
  lastRun:   string | null
  nextRun:   string | null
  clusters:  UpdatesCheckCluster[]
  lastNotified: string | null
}

export type UpdatesWsPayload =
  | { kind: 'job';  job: Omit<UpdatesJob, 'steps'> }
  | { kind: 'step'; jobId: string; step: UpdatesStep }
  | { kind: 'log';  jobId: string; stepId: string; line: string }
