// Load balancing's shapes as the API sends them (apps/api/src/lib/placement/types.ts).

export type ReasonLevel = 'block' | 'unknown' | 'warn' | 'info'
export interface Reason { code: string; level: ReasonLevel; words: string }
export interface TargetCheck { node: string; verdict: 'ok' | 'no' | 'unknown'; reasons: Reason[] }

export interface PlacementNode {
  node: string; online: boolean; maintenance: boolean; threads: number; cpuModel: string | null; cpuVendor: string | null
  cpu: number; mem: number; maxmem: number; cpusAssigned: number; memAssigned: number; guests: string[]
}

export interface GuestPlacement {
  sid: string; vmid: number; type: 'lxc' | 'qemu'; name: string; node: string; status: string; template: boolean; ha: boolean
  cpus: number; maxmem: number; usage: { cores: number; mem: number }
  why: string[]; movable: 'yes' | 'no' | 'unknown'; summary: string; everywhere: Reason[]; targets: TargetCheck[]
  copyBytes: number; downtimeSec: number | null
}

export interface NetworkCost {
  shared: boolean | null; migrationNetwork: string | null; corosyncAddresses: string[]; redundantRing: boolean
  datacenterBwlimit: number | null; suggestedBwlimit: number; words: string[]
}

export interface QuietStatus {
  quietNow: boolean; nowWhy: string[]; nextQuiet: { start: number; end: number } | null
  upcoming: Array<{ start: number; end: number; reason: string }>; unread: string[]; tz: string
}

export interface BusyHours { days: number[]; start: string; end: string; label?: string }
export interface PlacementSettings {
  avoidBackups: boolean; backupHours: number; backupMarginMin: number; busyHours: BusyHours[]; bwlimitKiB: number; linkMbps: number
  cpuAbove: number; memAbove: number; minHours: number; windowHours: number
  balanceGoal: BalanceGoal; unevenAbove: number; minGain: number; maxPlanMoves: number
}

export interface MapView {
  map: { nodes: PlacementNode[]; guests: GuestPlacement[]; network: NetworkCost; crs: { mode: string; autoRebalance: boolean }; unread: string[]; at: number }
  quiet: QuietStatus
  settings: PlacementSettings
  jobs: Array<{ id: string; schedule: string; enabled: boolean; durationSec?: number | null }>
}

export interface Suggestion {
  kind: 'move' | 'edit-rule'; sid: string; name: string; from: string; to: string; why: string[]; rule?: string
  effect: { from: { before: number; after: number }; to: { before: number; after: number }; metric: 'cpu' | 'mem' }
}
export interface Pressure { node: string; cpuHours: number; memHours: number; covered: number; busy: boolean; cpuP95: number; memP95: number; words: string }
export interface Advice {
  balanced: boolean; headline: string; pressure: Pressure[]; suggestions: Suggestion[]; stuck: string[]; evidence: string[]; unread: string[]
  window: { hours: number; stepSec: number; cpuAbove: number; memAbove: number; minHours: number; backupHoursSkipped: number }
}

export interface CorosyncCount { checked: string[]; retransmits: number; linkDown: number; tokenLost: number; membership: number; unavailable?: string }
export interface MoveRecord {
  id: string; sid: string; name: string; fromNode: string; toNode: string; source: 'hyperprox' | 'proxmox'; method: 'ha' | 'migrate' | null
  status: 'scheduled' | 'running' | 'stuck' | 'done' | 'failed' | 'skipped' | 'cancelled'; upid: string | null; by: string | null
  scheduledFor: number | null; startedAt: number | null; endedAt: number | null; error: string | null; bwlimitKiB: number | null
  corosync: CorosyncCount | null
}

export interface MovePlan {
  sid: string; name: string; type: 'lxc' | 'qemu'; from: string; to: string; method: 'ha' | 'migrate'; allowed: boolean
  refusals: string[]; warnings: string[]; running: boolean; downtimeSec: number | null; copyBytes: number; copySec: number
  localDisks: boolean; bwlimitKiB: number | null; network: NetworkCost; quiet: QuietStatus; needsAnyway: boolean; call: string
  lastMove: { at: number; from: string; to: string; words: string } | null
}

// --- load balancing (apps/api/src/lib/placement/types.ts, service.ts BalanceView) ---

export type BalanceGoal = 'mem' | 'cpu' | 'both'
export type Sample = [number, number]
export interface NodeLoad {
  node: string; online: boolean; maintenance: boolean; counted: boolean; threads: number; maxmem: number
  cpu: { now: number; p95: number; mean: number }; mem: { now: number; p95: number; mean: number }
  cpuShare: number; memShare: number; history: { cpu: Sample[]; mem: Sample[] }
}
export interface BalanceScore { score: number; spread: number; cpuSpread: number; memSpread: number; busiest: string | null; idlest: string | null }
export interface PlanStep {
  n: number; sid: string; name: string; type: 'lxc' | 'qemu'; ha: boolean; from: string; to: string; method: 'ha' | 'migrate'
  load: { cores: number; mem: number }
  before: { from: { cpu: number; mem: number }; to: { cpu: number; mem: number } }
  after: { from: { cpu: number; mem: number }; to: { cpu: number; mem: number } }
  gain: number; scoreAfter: number; downtimeSec: number | null; copyBytes: number; copySec: number; bwlimitKiB: number | null; why: string[]
}
export interface BalanceSuggestion { kind: 'edit-rule' | 'ha-move'; sid: string; name: string; from: string; to: string; rule?: string; gain: number; words: string }
export interface BalancePlan {
  goal: BalanceGoal; score: BalanceScore; target: BalanceScore; steps: PlanStep[]; suggestions: BalanceSuggestion[]
  nodesAfter: Array<{ node: string; cpu: number; mem: number }>; needSec: number; left: string[]; words: string[]
}
export type PlanStatus = 'scheduled' | 'running' | 'done' | 'stopped' | 'failed' | 'cancelled' | 'skipped'
export interface PlanStepRecord {
  sid: string; name: string; from: string; to: string; method: 'ha' | 'migrate'
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'; moveId: string | null; error: string | null; startedAt: number | null; endedAt: number | null
}
export interface PlanRecord {
  id: string; source: 'manual' | 'auto'; status: PlanStatus; by: string | null; goal: BalanceGoal; scoreBefore: number; scoreTarget: number
  steps: PlanStepRecord[]; scheduledFor: number | null; startedAt: number | null; endedAt: number | null; error: string | null; stopRequested: boolean
}
export interface AutoSettings { enabled: boolean; apply: boolean; sustainHours: number; checkEveryMin: number; maxMovesPerDay: number; minHoursBetween: number }
export interface AutoState {
  approver: { email: string; role: string; at: number } | null; cephBaseline: string[] | null
  lastCheckAt: number | null; lastWhy: string | null; lastNotifiedAt: number | null; lastNotifiedSig: string | null; lastMoveAt: number | null
}
export interface BalanceView {
  goal: BalanceGoal; uneven: boolean; headline: string; nodes: NodeLoad[]; score: BalanceScore; plan: BalancePlan
  recent: { hours: number; covered: number }; unread: string[]
  quiet: QuietStatus; crs: { mode: string; autoRebalance: boolean }; network: NetworkCost; window: { hours: number; stepSec: number }
  settings: { balanceGoal: BalanceGoal; unevenAbove: number; minGain: number; maxPlanMoves: number; cpuAbove: number; memAbove: number }
  auto: { settings: AutoSettings; state: AutoState }
  running: PlanRecord | null; plans: PlanRecord[]
}
