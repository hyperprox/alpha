// =============================================================================
//  HyperProx — load balancing: the shapes
//
//  Load balancing answers, for the cluster as a whole, how evenly its load is
//  spread, and for every guest, HA or not: why is it where it is, could it run
//  somewhere else, and should it. A balancing plan is a short list of moves
//  that evens the load out. Nothing moves unless a person runs a plan or a
//  single move (with the master password), or turns on automatic balancing,
//  which is off by default and moves only guests HA does not manage: for HA
//  guests Proxmox's own scheduler (CRS) and HA rules have the last word.
// =============================================================================

import type { GuestType, HaSnapshot, Sid } from '../ha/types'

/** How serious one reason is for one target node. */
export type ReasonLevel = 'block' | 'unknown' | 'warn' | 'info'

export type ReasonCode =
  | 'template' | 'gpu' | 'device' | 'bind-mount' | 'shared-mount' | 'local-disk' | 'strict-rule' | 'prefer-rule'
  | 'apart-rule' | 'together-rule' | 'cores' | 'cpu-type' | 'restart' | 'backup-running' | 'offline' | 'maintenance'
  | 'memory' | 'ha' | 'crs' | 'stopped' | 'migrating' | 'unread'

export interface Reason { code: ReasonCode; level: ReasonLevel; words: string }

export type TargetVerdict = 'ok' | 'no' | 'unknown'

export interface TargetCheck {
  node:    string
  verdict: TargetVerdict
  reasons: Reason[]
}

/** One node, as the map draws it. */
export interface PlacementNode {
  node:      string
  online:    boolean
  maintenance: boolean
  /** CPU threads Proxmox schedules on. */
  threads:   number
  cpuModel:  string | null
  cpuVendor: string | null
  /** Now, 0..1. */
  cpu:       number
  mem:       number
  maxmem:    number
  /** Sum of the vCPUs of the guests running here (a container without a limit counts 0). */
  cpusAssigned: number
  /** Sum of the memory limits of the guests running here. */
  memAssigned:  number
  guests:    Sid[]
}

export interface GuestPlacement {
  sid:      Sid
  vmid:     number
  type:     GuestType
  name:     string
  node:     string
  status:   string
  template: boolean
  ha:       boolean
  /** vCPUs (0 = a container without a limit). */
  cpus:     number
  maxmem:   number
  /** Now: cores busy and memory used. */
  usage:    { cores: number; mem: number }
  /** Why it is on this node, in plain words. Empty: nothing ties it here. */
  why:      string[]
  /** "yes" (somewhere), "no" (nowhere), "unknown" (only places that could not be checked). */
  movable:  'yes' | 'no' | 'unknown'
  /** One sentence. */
  summary:  string
  /** Reasons that apply wherever it goes. */
  everywhere: Reason[]
  targets:  TargetCheck[]
  /** Bytes that would cross the network on a move: local disks, and memory for a running VM. */
  copyBytes: number
  /** A running container moves by restarting: the outage, in seconds (an estimate), else null. */
  downtimeSec: number | null
}

export interface NetworkCost {
  /** Corosync and migration traffic share a network: true, false, or null when it could not be told. */
  shared:            boolean | null
  migrationNetwork:  string | null
  corosyncAddresses: string[]
  /** More than one corosync link: one busy network does not cut the heartbeat on its own. */
  redundantRing:     boolean
  /** The datacenter bandwidth limit for migrations, KiB/s, or null when none is set. */
  datacenterBwlimit: number | null
  /** What HyperProx suggests passing as bwlimit when the network is shared. */
  suggestedBwlimit:  number
  words:             string[]
}

export interface PlacementMap {
  nodes:   PlacementNode[]
  guests:  GuestPlacement[]
  network: NetworkCost
  crs:     HaSnapshot['crs']
  /** Parts that could not be read, in words. */
  unread:  string[]
  at:      number
}

// --- history over time ----------------------------------------------------------------------------

/** [unix seconds, value] as Prometheus answers a range query. */
export type Sample = [number, number]

export interface NodeSeries { node: string; cpu: Sample[]; mem: Sample[] }
/** A guest's own usage: cores busy (not a ratio) and memory bytes. */
export interface GuestSeries { sid: Sid; cores: Sample[]; mem: Sample[] }

export interface Pressure {
  node:      string
  /** Hours above the threshold in the window, backup windows left out. */
  cpuHours:  number
  memHours:  number
  /** Hours of samples looked at (backup windows left out). */
  covered:   number
  busy:      boolean
  kind:      Array<'cpu' | 'mem'>
  /** p95 of the samples looked at, 0..1. */
  cpuP95:    number
  memP95:    number
  words:     string
}

export interface Suggestion {
  kind:     'move' | 'edit-rule'
  sid:      Sid
  name:     string
  from:     string
  to:       string
  /** Why this guest and why that node. */
  why:      string[]
  /** Hours above the threshold on each node, before and after (from the guest's own measured usage). */
  effect:   { from: { before: number; after: number }; to: { before: number; after: number }; metric: 'cpu' | 'mem' }
  /** For kind edit-rule: the rule to change. */
  rule?:    string
}

export interface Advice {
  balanced:    boolean
  headline:    string
  pressure:    Pressure[]
  suggestions: Suggestion[]
  /** Busy nodes where nothing could move, and why. */
  stuck:       string[]
  /** What was measured and how, so "nothing to do" comes with its evidence. */
  evidence:    string[]
  window:      { hours: number; stepSec: number; cpuAbove: number; memAbove: number; minHours: number; backupHoursSkipped: number }
  unread:      string[]
}

// --- settings and moves ---------------------------------------------------------------------------

export interface BusyHours { days: number[]; start: string; end: string; label?: string }

export interface PlacementSettings {
  /** Keep moves out of backup job windows (read from the cluster's backup schedules). */
  avoidBackups:      boolean
  /** How long a backup job is assumed to run when no finished run is in the task log, hours. */
  backupHours:       number
  /** Minutes kept clear before a backup starts. */
  backupMarginMin:   number
  /** Hours people use the cluster (watching, working), cluster local time. */
  busyHours:         BusyHours[]
  /** Bandwidth limit for moves when corosync shares the network, KiB/s. */
  bwlimitKiB:        number
  /** The link between nodes, Mbit/s, for time estimates. */
  linkMbps:          number
  /** Imbalance: a node counts as busy above these, for at least minHours of the last windowHours. */
  cpuAbove:          number
  memAbove:          number
  minHours:          number
  windowHours:       number
  /** What a balancing plan evens out: memory, CPU, or both (their mean spread). */
  balanceGoal:       BalanceGoal
  /** The cluster is uneven when the spread between the busiest and the least busy node passes this (0..1). */
  unevenAbove:       number
  /** A move goes into a plan only when it improves the balance score by at least this many points. */
  minGain:           number
  /** At most this many moves in one plan. */
  maxPlanMoves:      number
}

/** stuck: Proxmox's task outlived HyperProx's wait, or HA has not finished; HyperProx keeps watching and holds the lock. */
export type MoveStatus = 'scheduled' | 'running' | 'stuck' | 'done' | 'failed' | 'skipped' | 'cancelled'

export interface CorosyncCount {
  checked:    string[]
  retransmits: number
  linkDown:   number
  tokenLost:  number
  membership: number
  /** The same counts for an equal stretch just before the move: what normal looks like. */
  before?:    { retransmits: number; linkDown: number; tokenLost: number; membership: number }
  unavailable?: string
}

export interface MoveRecord {
  id:          string
  sid:         Sid
  name:        string
  fromNode:    string
  toNode:      string
  source:      'hyperprox' | 'proxmox'
  method:      'ha' | 'migrate' | null
  status:      MoveStatus
  upid:        string | null
  by:          string | null
  scheduledFor: number | null
  startedAt:   number | null
  endedAt:     number | null
  error:       string | null
  bwlimitKiB:  number | null
  corosync:    CorosyncCount | null
  /** The process watching it ("pid@start"), and when it last said so: a stale heartbeat can be taken over. */
  owner:       string | null
  heartbeatAt: number | null
  /** What was approved: the settings in force then (a scheduled move runs under them), and the guest's state. */
  snapshot:    MoveSnapshot | null
}

export interface MoveSnapshot {
  settings?: Partial<PlacementSettings>
  /** The balancing plan this move belongs to, and whether automatic balancing started it. */
  planId?:   string
  auto?:     boolean
  /** Who approved a scheduled move, with the role they held when they did (re-confirmed with the master password). */
  approver?: { email: string; role: string; at: number }
  type?:     'lxc' | 'qemu'
  running?:  boolean
  localDisks?: boolean
}

// --- load balancing -------------------------------------------------------------------------------

export type BalanceGoal = 'mem' | 'cpu' | 'both'

/** One node's load over the history window, as shares of its own capacity (0..1). */
export interface NodeLoad {
  node:        string
  online:      boolean
  maintenance: boolean
  /** Counted in the score: online, not in maintenance, with history. */
  counted:     boolean
  threads:     number
  maxmem:      number
  cpu:         { now: number; p95: number; mean: number }
  mem:         { now: number; p95: number; mean: number }
  /** Its share of the CPU work and of the memory in use across the counted nodes (p95), 0..1. */
  cpuShare:    number
  memShare:    number
  /** Hourly means over the window, for the page's sparklines. */
  history:     { cpu: Sample[]; mem: Sample[] }
}

export interface BalanceScore {
  /** 100 is perfectly even; 100 less the spread in points. */
  score:     number
  /** The goal's spread between the busiest and the least busy node, 0..1 (for "both": the mean of the two). */
  spread:    number
  cpuSpread: number
  memSpread: number
  busiest:   string | null
  idlest:    string | null
}

export interface NodeAfter { node: string; cpu: number; mem: number }

export interface PlanStep {
  n:        number
  sid:      Sid
  name:     string
  type:     GuestType
  ha:       boolean
  from:     string
  to:       string
  method:   'ha' | 'migrate'
  /** The guest's own p95 over the window: cores busy and memory bytes. */
  load:     { cores: number; mem: number }
  /** p95 shares of capacity on both nodes, before and after this move. */
  before:   { from: { cpu: number; mem: number }; to: { cpu: number; mem: number } }
  after:    { from: { cpu: number; mem: number }; to: { cpu: number; mem: number } }
  /** Score points this move adds, and the score after it. */
  gain:     number
  scoreAfter: number
  downtimeSec: number | null
  copyBytes: number
  copySec:  number
  bwlimitKiB: number | null
  why:      string[]
}

/** A change that would help but that the plan does not carry out itself. */
export interface BalanceSuggestion {
  kind:  'edit-rule' | 'ha-move'
  sid:   Sid
  name:  string
  from:  string
  to:    string
  rule?: string
  gain:  number
  words: string
}

export interface BalancePlan {
  goal:        BalanceGoal
  score:       BalanceScore
  target:      BalanceScore
  steps:       PlanStep[]
  suggestions: BalanceSuggestion[]
  nodesAfter:  NodeAfter[]
  /** The whole plan's estimated length, seconds (each move's outage and copy, plus a margin). */
  needSec:     number
  /** Why the plan stops where it does. */
  left:        string[]
  /** How it relates to Proxmox's own scheduler, and other things worth knowing. */
  words:       string[]
}

export interface BalanceResult {
  goal:     BalanceGoal
  uneven:   boolean
  headline: string
  nodes:    NodeLoad[]
  score:    BalanceScore
  plan:     BalancePlan
  /** Hours the cluster was uneven in the most recent stretch, for automatic balancing. */
  recent:   { hours: number; covered: number }
  unread:   string[]
}

export type PlanStatus = 'scheduled' | 'running' | 'done' | 'stopped' | 'failed' | 'cancelled' | 'skipped'
export type PlanStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface PlanStepRecord {
  sid: Sid; name: string; from: string; to: string; method: 'ha' | 'migrate'
  status: PlanStepStatus
  moveId: string | null
  error: string | null
  startedAt: number | null
  endedAt: number | null
}

export interface PlanSnapshot {
  settings?: Partial<PlacementSettings>
  /** Who approved it (with the master password just re-entered), with the role they held then. */
  approver?: { email: string; role: string; at: number }
  /** Ceph's health checks when it was approved: a check that was not there then stops the plan. Null: no Ceph status. */
  ceph?:     { checks: string[] } | null
  /** The nodes online when it was approved: one going down stops the plan. */
  nodes?:    string[]
  /** The plan's estimated length when approved, seconds: a scheduled plan needs a quiet window this long. */
  needSec?:  number
}

export interface PlanRecord {
  id:            string
  source:        'manual' | 'auto'
  status:        PlanStatus
  by:            string | null
  goal:          BalanceGoal
  scoreBefore:   number
  scoreTarget:   number
  steps:         PlanStepRecord[]
  scheduledFor:  number | null
  startedAt:     number | null
  endedAt:       number | null
  error:         string | null
  stopRequested: boolean
  owner:         string | null
  heartbeatAt:   number | null
  snapshot:      PlanSnapshot | null
}

/** Automatic balancing: off by default; notify only unless "apply automatically" was turned on with a re-confirmation. */
export interface AutoSettings {
  enabled:         boolean
  apply:           boolean
  /** Uneven for at least this long before anything is proposed, hours. */
  sustainHours:    number
  checkEveryMin:   number
  maxMovesPerDay:  number
  minHoursBetween: number
}

export interface AutoState {
  /** Who turned on "apply automatically", re-confirmed then; cleared when it is turned off. */
  approver:     { email: string; role: string; at: number } | null
  /** Ceph's health checks when apply was turned on: a new one stops automatic moves. */
  cephBaseline: string[] | null
  lastCheckAt:  number | null
  lastWhy:      string | null
  lastNotifiedAt: number | null
  lastNotifiedSig: string | null
  lastMoveAt:   number | null
}
