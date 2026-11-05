// =============================================================================
//  HyperProx — HA management: the shapes everything else in lib/ha works on
//
//  PVE answers HA questions across five endpoints with three spellings of the
//  same thing (a node list is "a:5,b:1" in a rule, a map in manager_status and
//  a row per node in /nodes). Everything is read once into an HaSnapshot, and
//  every function in lib/ha is a pure function of a snapshot. The routes and
//  the planner are the only places that talk to Proxmox.
// =============================================================================

export type GuestType = 'lxc' | 'qemu'
/** HA's own spelling: ct:<id> or vm:<id>. */
export type Sid = string

export type HaRequestState = 'started' | 'stopped' | 'disabled' | 'ignored' | 'enabled'

export interface HaResource {
  sid:          Sid
  type:         'ct' | 'vm'
  vmid:         number
  state:        HaRequestState
  maxRestart:   number
  maxRelocate:  number
  failback:     boolean
  autoRebalance: boolean
  comment?:     string
  /** Legacy HA group (PVE 8). Shown read-only; PVE 9 migrated groups to rules. */
  group?:       string
}

export interface NodePriority { node: string; priority: number }

export interface NodeAffinityRule {
  id:        string
  type:      'node-affinity'
  /** positive = run on these nodes; negative = run anywhere except these nodes. */
  affinity:  'positive' | 'negative'
  strict:    boolean
  nodes:     NodePriority[]
  resources: Sid[]
  disabled:  boolean
  comment?:  string
  order?:    number
}

export interface ResourceAffinityRule {
  id:        string
  type:      'resource-affinity'
  /** positive = keep together on one node; negative = keep apart on different nodes. */
  affinity:  'positive' | 'negative'
  resources: Sid[]
  disabled:  boolean
  comment?:  string
  order?:    number
}

export type HaRule = NodeAffinityRule | ResourceAffinityRule

export interface NodeHealth {
  node:        string
  online:      boolean
  /** The node's HA agent (LRM) is in maintenance mode: HA moves guests off and starts none there. */
  maintenance: boolean
  /** Memory, bytes: for the preflight's "enough memory" and the prediction's tie-break. */
  mem:         number
  maxmem:      number
  cpu:         number
  maxcpu:      number
}

export interface GuestHardware {
  /** Plain bind mounts (a host path, not a storage volume) without shared=1: the guest cannot migrate. */
  bindMounts:    Array<{ key: string; path: string; target?: string }>
  /** Bind mounts marked shared=1: allowed to move (the path is promised on every node). */
  sharedMounts:  Array<{ key: string; path: string }>
  /** Passed-through host devices: GPUs, USB, /dev entries. */
  devices:       Array<{ key: string; what: string }>
  /** Volumes on storage that exists on one node only. */
  localVolumes:  Array<{ key: string; storage: string }>
}

export interface HaGuest {
  vmid:    number
  type:    GuestType
  sid:     Sid
  name:    string
  node:    string
  status:  string           // running | stopped | ...
  maxmem:  number
  template: boolean
  /** Filled in for HA guests, and for any guest whose config was read. */
  hardware?: GuestHardware
}

/** One HA service as /cluster/ha/status/current reports it. */
export interface HaServiceStatus {
  sid:          Sid
  node:         string
  state:        string        // started | stopped | error | fence | recovery | migrate | relocate | freeze ...
  requestState: string
  crmState?:    string
}

export interface HaSnapshot {
  resources: HaResource[]
  rules:     HaRule[]
  nodes:     NodeHealth[]
  guests:    HaGuest[]
  services:  HaServiceStatus[]
  quorate:   boolean
  /** "armed" | "disarmed" | "unknown"; PVE 9.2 reports it as its own status row. */
  fencing:   'armed' | 'disarmed' | 'unknown'
  /** The HA master, when one is active. */
  master:    string | null
  crs:       { mode: 'basic' | 'static' | 'dynamic'; rebalanceOnStart: boolean; autoRebalance: boolean }
  /** PVE's own digests: a preview's fingerprint and the digest sent with a set. */
  digests:   { resources: string | null; rules: string | null }
  /** Storage ids that are shared (reachable from every node that lists them). */
  sharedStorage: string[]
}

/** The guest's home, in the words the panel uses. */
export type HomeMode = 'none' | 'prefer' | 'only'

export interface HomeChoice {
  mode:   HomeMode
  /**
   * Choices in order: tiers[0] is the first choice, tiers[1] the second, and so on. Nodes in one tier are
   * equal. One tier means "no first and second choice", which is the only form PVE accepts for a guest that
   * is also kept together with or apart from another guest. Empty for mode "none".
   */
  tiers:  string[][]
}

export class HaRefusal extends Error {
  constructor(message: string, public status = 409, public problems: RuleProblem[] = []) { super(message) }
}

export type ProblemCode =
  | 'unknown-guest' | 'not-ha' | 'unknown-node' | 'no-nodes' | 'no-resources' | 'duplicate-id' | 'bad-id'
  | 'two-homes' | 'too-few-guests' | 'more-than-nodes' | 'together-and-apart'
  | 'weighted-with-affinity' | 'together-split-homes' | 'apart-too-few-nodes'
  | 'negative-all-nodes' | 'negative-priorities'

export interface RuleProblem {
  code:     ProblemCode
  /** Rule ids involved (the draft's id included). */
  rules:    string[]
  message:  string
  /** A fix HyperProx can preview for you. */
  fix?:     { kind: 'flatten'; rule: string; words: string }
}

export interface Actor { email: string; role: string }
