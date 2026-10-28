// --- Updates -----------------------------------------------------------------
// Shared by the Updates API (apps/api/src/routes/updates.ts) and page (apps/frontend/app/updates).

export type UpdatesPkgChange = { name: string; from: string | null; to: string }

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

export type UpdatesInventory = { refreshedAt: string; nodes: UpdatesNode[]; guests: UpdatesGuest[] }

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
}

export type UpdatesWsPayload =
  | { kind: 'job';  job: Omit<UpdatesJob, 'steps'> }
  | { kind: 'step'; jobId: string; step: UpdatesStep }
  | { kind: 'log';  jobId: string; stepId: string; line: string }
