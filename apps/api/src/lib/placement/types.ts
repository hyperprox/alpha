// =============================================================================
//  HyperProx — placement advisor: the shapes
//
//  The advisor answers three questions for every guest on the cluster, HA or
//  not: why is it where it is, could it run somewhere else, and should it.
//  It never moves anything on its own. Proxmox's HA scheduler (CRS) already
//  balances HA guests; a second balancer would fight it. A move happens only
//  when a person asks for one, after a check, a confirmation and the master
//  password.
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
  settings?: PlacementSettings
  type?:     'lxc' | 'qemu'
  running?:  boolean
  localDisks?: boolean
}
