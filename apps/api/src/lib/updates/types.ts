// =============================================================================
//  The shared Updates types, as the API compiles them.
//
//  The source of truth is packages/types/src/updates.ts (@hyperprox/types). The
//  API cannot import it: apps/api compiles with rootDir ./src, and a .ts file
//  outside it fails the build (TS6059) — which is why no API file imported
//  @hyperprox/types before this feature. Everything below the marker is a
//  verbatim copy, and test/updates-types.test.ts fails if the two drift.
// =============================================================================
// --- verbatim copy below ---
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
  haManaged:        boolean
  snapshotCapable:  boolean
  docker:           'none' | 'auto' | 'manual'
  dockerImages?:    { image: string; current: string; latest: string | null }[]
  error?:           string
}

export type UpdatesInventory = { refreshedAt: string; nodes: UpdatesNode[]; guests: UpdatesGuest[] }

export type UpdatesStepAction =
  | 'preflight' | 'refresh' | 'snapshot' | 'apt' | 'docker' | 'check' | 'ceph'
  | 'node-upgrade' | 'node-reboot' | 'kernel-cleanup' | 'self'

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

export type UpdatesPlan = { steps: Omit<UpdatesStep, 'id' | 'status'>[]; warnings: string[]; scope?: UpdatesScope }

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
